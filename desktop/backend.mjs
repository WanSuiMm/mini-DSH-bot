import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ServiceDatabase } from '../service/database.mjs';
import { HarnessService, configuredModel } from '../service/server.mjs';
import { BrowserRuntime } from '../service/browser/runtime.mjs';
import { createBrowserToolGuard, createBrowserToolProvider } from '../service/browser/provider.mjs';
import { createExecutionGuard, redactSensitive } from '../service/security/guard.mjs';
import { DesktopTaskJournal, SQLiteBrowserStore } from './task-journal.mjs';

const OWNER = 'desktop-local-agent';
const TASK_LIMIT = 100;
const DESKTOP_INTERRUPTED_RUN = 'desktop_interrupted';
const DEFAULT_BUDGET = Object.freeze({ maxTokens: 65536, maxToolCalls: 64, maxDurationMs: 900_000,
  maxActiveChildren: 1, maxDelegationDepth: 1 });
const FINAL_RUN_STATES = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'timed_out']);

function backendError(code, message = code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw backendError(`INVALID_${name.toUpperCase()}`);
  return value;
}

function safeText(value, maxLength = 500) {
  const clean = redactSensitive(typeof value === 'string' ? value : String(value ?? ''));
  return clean.length <= maxLength ? clean : clean.slice(0, maxLength);
}

function validateUrlAndOrigins(urlValue, allowedOriginsValue) {
  if (typeof urlValue !== 'string' || urlValue.length > 4096) throw backendError('INVALID_URL');
  let url;
  try { url = new URL(urlValue); } catch { throw backendError('INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw backendError('URL_NOT_ALLOWED');
  const origins = allowedOriginsValue === undefined ? [url.origin] : allowedOriginsValue;
  if (!Array.isArray(origins) || !origins.length || origins.length > 32) throw backendError('INVALID_ALLOWED_ORIGINS');
  const normalized = [];
  for (const item of origins) {
    if (typeof item !== 'string' || item.length > 512) throw backendError('INVALID_ALLOWED_ORIGINS');
    let origin;
    try { origin = new URL(item); } catch { throw backendError('INVALID_ALLOWED_ORIGINS'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash || item !== origin.origin) throw backendError('INVALID_ALLOWED_ORIGINS');
    normalized.push(origin.origin);
  }
  const unique = [...new Set(normalized)];
  if (!unique.includes(url.origin)) throw backendError('INITIAL_ORIGIN_NOT_ALLOWED', 'The starting page origin is outside the allowed origins.');
  return { url: url.href, origin: url.origin, allowedOrigins: unique };
}

function sanitizeModelEndpoint(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/u, '');
  } catch { return 'configured endpoint'; }
}

function extractOutput(run) {
  const result = run?.result;
  if (!result || typeof result !== 'object') return null;
  const summary = result.summary?.answer;
  if (typeof summary === 'string' && summary.trim()) return safeText(summary, 40_000);
  const candidates = Object.values(result.results ?? {});
  const texts = candidates.map(item => item?.ok === true ? item.data?.text : null)
    .filter(text => typeof text === 'string' && text.trim());
  return texts.length ? safeText(texts.join('\n\n'), 40_000) : null;
}

function taskError(run) {
  const result = run?.result;
  const value = result?.error ?? result?.code ?? result?.summaryError;
  return value ? safeText(value, 1000) : null;
}

function persistedTaskRecords(database, runId) {
  return database.db.prepare('SELECT record FROM tasks WHERE run_id=? ORDER BY id').all(runId)
    .map(row => {
      try { return JSON.parse(row.record); } catch { return { status: 'corrupt' }; }
    });
}

function safeToRecoverRun(database, runId) {
  return persistedTaskRecords(database, runId).every(task => task.status === 'queued');
}

function toolFailure(code, message = code) {
  return { ok: false, error: { code, message, retryable: false }, evidence: [] };
}

function toolSuccess(data) { return { ok: true, data, evidence: [] }; }

function createGatedBrowserProvider({ runtime, gates }) {
  const provider = createBrowserToolProvider({ runtime });
  return {
    definitions: () => provider.definitions(),
    register(registry, binding) {
      const gatedRegistry = {
        register(name, handler, options = {}) {
          registry.register(name, async (input, context) => {
            const gate = gates.get(context?.runId);
            await waitForGate(gate, context?.signal);
            if (gate) gate.inFlight++;
            try {
              if (gate?.freshObservationRequired && name === 'browser_action') {
                try {
                  runtime.bindRunContext(binding, context);
                  const observed = await runtime.submit(binding.owner, input.sessionId, { type: 'observe' },
                    `desktop-resume-observe-${randomUUID()}`, context.signal);
                  if (observed.status === 'succeeded') gate.freshObservationRequired = false;
                  return toolSuccess({ status: 'fresh_observation_required_action_not_dispatched', executed: false,
                    observation: observed.result ?? observed });
                } catch (cause) {
                  return toolFailure(/^[A-Z_]+$/u.test(cause?.code ?? '') ? cause.code : 'BROWSER_OBSERVE_FAILED');
                }
              }
              const result = await handler(input, context);
              if (gate?.freshObservationRequired && name === 'browser_observe' && result?.ok === true) {
                gate.freshObservationRequired = false;
              }
              return result;
            } finally {
              if (gate) {
                gate.inFlight = Math.max(0, gate.inFlight - 1);
                if (gate.inFlight === 0) for (const resolve of [...gate.drainWaiters]) resolve();
              }
            }
          }, options);
        },
      };
      provider.register(gatedRegistry, binding);
    },
    // Backend owns BrowserRuntime and closes it before HarnessService closes the shared DB.
    close() {},
  };
}

function makeGate() { return { paused: false, freshObservationRequired: false, waiters: new Set(), inFlight: 0, drainWaiters: new Set() }; }

function waitForGate(gate, signal) {
  if (!gate?.paused) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(backendError('CANCELLED', 'Task cancelled while paused.', 409));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const resume = () => { cleanup(); gate.waiters.delete(resume); resolve(); };
    const abort = () => { cleanup(); gate.waiters.delete(resume); reject(backendError('CANCELLED', 'Task cancelled while paused.', 409)); };
    gate.waiters.add(resume);
    signal?.addEventListener('abort', abort, { once: true });
    if (!gate.paused) resume();
    else if (signal?.aborted) abort();
  });
}

function waitForGateQuiescent(gate) {
  if (!gate?.inFlight) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      gate.drainWaiters.delete(done);
      if (!gate.inFlight) resolve();
    };
    gate.drainWaiters.add(done);
    if (!gate.inFlight) done();
  });
}

/**
 * Creates the in-process desktop Agent backend. It uses the regular HarnessService,
 * BrowserRuntime and browser tool provider; it never opens an HTTP listener.
 */
export async function createDesktopBackend({ stateRoot, driver, onState = () => {}, modelFactory = configuredModel } = {}) {
  if (typeof stateRoot !== 'string' || !stateRoot.trim()) throw backendError('STATE_ROOT_REQUIRED');
  if (!driver || ['validateUrl', 'open', 'execute', 'closeSession', 'preview', 'close'].some(name => typeof driver[name] !== 'function')) {
    throw backendError('DESKTOP_BROWSER_DRIVER_REQUIRED');
  }
  if (typeof onState !== 'function' || typeof modelFactory !== 'function') throw backendError('DESKTOP_BACKEND_CONFIGURATION_INVALID');

  const root = resolve(stateRoot);
  mkdirSync(root, { recursive: true });
  const serviceDatabase = new ServiceDatabase(join(root, 'desktop-agent.sqlite3'));
  const taskJournal = new DesktopTaskJournal(serviceDatabase);
  const browserStore = new SQLiteBrowserStore(serviceDatabase);
  const gates = new Map();
  const browserDriver = {
    validateUrl: (...args) => driver.validateUrl(...args),
    // ElectronDriver validates the BrowserRuntime contract strictly; the
    // Harness session id is the trusted binding already stored by bindTab().
    open: options => driver.open(options),
    execute: (...args) => driver.execute(...args),
    closeSession: (...args) => driver.closeSession(...args),
    storageState: (...args) => typeof driver.getStorageState === 'function'
      ? driver.getStorageState(...args) : driver.storageState?.(...args),
    preview: (...args) => driver.preview(...args),
    close: (...args) => driver.close(...args),
  };
  const browserRuntime = new BrowserRuntime({ store: browserStore, driver: browserDriver,
    maxSessions: 32, maxOwnerSessions: 32, leaseMs: 60_000, ttlMs: 86_400_000, idleMs: 86_000_000 });
  const browserProvider = createGatedBrowserProvider({ runtime: browserRuntime, gates });

  const backend = {
    root,
    owner: OWNER,
    serviceDatabase,
    taskJournal,
    browserStore,
    browserRuntime,
    service: undefined,
    modelConfig: undefined,
    startupTaskIds: new Set(),
    readyPromise: undefined,
    publishTimer: undefined,
    pollTimer: undefined,
    cleanedRuns: new Set(),
    closed: false,
    publishing: undefined,
    modelFactory,

    async ready() {
      if (this.closed) throw backendError('DESKTOP_BACKEND_CLOSED', 'Desktop backend is closed.', 409);
      if (!this.readyPromise) {
        this.readyPromise = (async () => {
          await taskJournal.ready();
          await browserStore.ready();
          this.startupTaskIds = new Set(taskJournal.listTasks({ limit: 1000 }).map(task => task.id));
          await browserRuntime.ready();
          for (const id of this.startupTaskIds) {
            let task = taskJournal.getTask(id);
            if (!task || taskJournal.isTerminal(task)) continue;
            if (!task.runId) {
              const found = serviceDatabase.findRunByKey(OWNER, task.harnessSessionId, task.idempotencyKey);
              if (found) task = taskJournal.updateTask(id, { runId: found.id });
            }
            if (!task.runId) {
              taskJournal.updateTask(id, { status: 'interrupted', error: 'Recover to reuse this task’s original request key.' });
              continue;
            }
            const run = serviceDatabase.getRun(OWNER, task.runId);
            if (!run || FINAL_RUN_STATES.has(run.status)) continue;
            const unknown = await browserRuntime.hasUnresolvedRunOutcome(task.runId);
            const reserved = serviceDatabase.latestEvent(task.runId, 'run.execution_reserved');
            const safe = !unknown && safeToRecoverRun(serviceDatabase, task.runId) &&
              (run.status !== 'running' || Boolean(reserved));
            if (safe) {
              // Keep desktop recovery records out of HarnessService.interrupted(),
              // whose generic startup policy can enqueue or fail them before an
              // explicit user recovery decision.
              serviceDatabase.db.prepare("UPDATE runs SET status=?,result=NULL,updated=? WHERE id=? AND status IN ('queued','running','interrupted','desktop_interrupted')")
                .run(DESKTOP_INTERRUPTED_RUN, new Date().toISOString(), task.runId);
              taskJournal.updateTask(id, { status: 'interrupted', error: null });
            } else {
              const code = unknown ? 'BROWSER_ACTION_OUTCOME_UNKNOWN' : reserved ? 'INTERRUPTED_REQUIRES_REVIEW' : 'INTERRUPTED_DURING_PLANNING';
              serviceDatabase.db.prepare("UPDATE runs SET status='failed',result=?,updated=? WHERE id=? AND status IN ('queued','running','interrupted','desktop_interrupted')")
                .run(JSON.stringify({ code, error: 'The interrupted task cannot be replayed automatically.' }), new Date().toISOString(), task.runId);
              taskJournal.updateTask(id, { status: 'recovery_required', error: unknown
                ? 'A browser action may have taken effect. Reconcile the website before starting another task.'
                : reserved ? 'The agent stopped during an active step. Review the page, then start a new task if needed.'
                  : 'The task stopped during planning; start a new task explicitly.' });
            }
          }
          return true;
        })().catch(error => { this.readyPromise = undefined; throw error; });
      }
      return this.readyPromise;
    },

    async bindTab(tabIdValue, { title = 'Browser tab', allowedOrigins = [] } = {}) {
      await this.ready();
      const tabId = validId(tabIdValue, 'tab_id');
      let tab = taskJournal.getTab(tabId);
      if (!tab) {
        const harnessSessionId = randomUUID();
        tab = taskJournal.ensureTab(tabId, harnessSessionId, safeText(title, 200) || 'Browser tab');
      }
      const session = serviceDatabase.session(OWNER, tab.harnessSessionId);
      if (!session) {
        const created = new Date().toISOString();
        serviceDatabase.db.prepare('INSERT INTO sessions(id,owner,title,created) VALUES(?,?,?,?)')
          .run(tab.harnessSessionId, OWNER, tab.title, created);
      }
      await driver.bindHarnessSession?.(tab.harnessSessionId, tabId, [...allowedOrigins]);
      this._schedulePublish();
      return tab;
    },

    async configure(config = {}) {
      await this.ready();
      if (this.closed) throw backendError('DESKTOP_BACKEND_CLOSED', 'Desktop backend is closed.', 409);
      if (!plainObject(config) || Object.keys(config).some(key => !['baseUrl', 'apiKey', 'model', 'thinkingMode'].includes(key))) {
        throw backendError('MODEL_CONFIGURATION_INVALID');
      }
      const { baseUrl, apiKey = '', model, thinkingMode } = config;
      if (typeof baseUrl !== 'string' || !baseUrl.trim() || baseUrl.length > 2048 ||
        typeof apiKey !== 'string' || apiKey.length > 4096 || typeof model !== 'string' || !model.trim() || model.length > 256 ||
        (thinkingMode !== undefined && (typeof thinkingMode !== 'string' || thinkingMode.length > 80))) {
        throw backendError('MODEL_CONFIGURATION_INVALID');
      }
      const prior = this.modelConfig;
      const same = prior && prior.baseUrl === baseUrl && prior.apiKey === apiKey && prior.model === model && prior.thinkingMode === thinkingMode;
      if (same) return await this.snapshot();
      if (this.service) {
        const active = [...this.service.active.keys()];
        const unfinished = taskJournal.listTasks({ limit: 1000 }).filter(task => !taskJournal.isTerminal(task));
        if (active.length || unfinished.length) throw backendError('DESKTOP_CONFIG_BUSY', 'Cancel or recover active tasks before changing the model connection.', 409);
        this.service.closed = true;
      }
      const modelAdapter = await this.modelFactory({ baseUrl: baseUrl.trim(), apiKey, model: model.trim(), thinkingMode,
        toolset: 'browser', extraTools: browserProvider.definitions() });
      if (!modelAdapter || typeof modelAdapter.generate !== 'function') throw backendError('MODEL_ADAPTER_INVALID');
      const gatedModel = {
        executionProfile: modelAdapter.executionProfile,
        generate: async (request, context) => {
          const gate = gates.get(context?.runId);
          await waitForGate(gate, context?.signal);
          return modelAdapter.generate(request, context);
        },
        ...(typeof modelAdapter.countTokens === 'function' ? { countTokens: (...args) => modelAdapter.countTokens(...args) } : {}),
        ...(typeof modelAdapter.estimatePromptTokens === 'function' ? { estimatePromptTokens: (...args) => modelAdapter.estimatePromptTokens(...args) } : {}),
      };
      const token = randomBytes(32).toString('base64url');
      const profile = createHash('sha256').update(JSON.stringify({
        provider: 'desktop-browser-agent-v1', model: modelAdapter.executionProfile ?? model.trim(),
        tools: browserProvider.definitions(),
      })).digest('hex');
      const service = new HarnessService({ database: serviceDatabase, authTokens: { [token]: OWNER }, model: gatedModel,
        toolset: 'browser', toolProviders: [browserProvider], browserRuntime,
        executionGuard: createBrowserToolGuard(createExecutionGuard({ workspaceRoot: root })),
        executionProfile: `desktop-browser-${profile}`, maxActiveRuns: 4, maxQueuedRuns: 100,
        maxParallelToolCalls: 1, maxOutputTokens: 4096, maxContextTokens: 32768 });
      await service.readyPromise;
      this.service = service;
      this.modelConfig = { baseUrl: baseUrl.trim(), apiKey, model: model.trim(), thinkingMode };
      const originalEmit = service.emit.bind(service);
      service.emit = async (...args) => {
        const event = await originalEmit(...args);
        this._schedulePublish();
        return event;
      };
      const originalSetRun = serviceDatabase.setRun.bind(serviceDatabase);
      serviceDatabase.setRun = (...args) => {
        const result = originalSetRun(...args);
        this._schedulePublish();
        return result;
      };
      browserRuntime.setRunAuthorizer(async (owner, runId) => {
        if (owner !== OWNER) return false;
        const run = serviceDatabase.getRun(owner, runId);
        const gate = gates.get(runId);
        return Boolean(run?.status === 'running' && !run.cancel_requested &&
          run.request?.executionProfile === service.executionProfile && !gate?.paused);
      });
      for (const id of this.startupTaskIds) {
        let task = taskJournal.getTask(id);
        if (!task || taskJournal.isTerminal(task)) continue;
        if (!task.runId) {
          const found = serviceDatabase.findRunByKey(OWNER, task.harnessSessionId, task.idempotencyKey);
          if (found) task = taskJournal.updateTask(id, { runId: found.id });
        }
        if (!task.runId) {
          taskJournal.updateTask(id, { status: 'interrupted', error: 'The task stopped before a run was recorded. Recover to reuse its original request key.' });
          continue;
        }
        const run = serviceDatabase.getRun(OWNER, task.runId);
        if (!run || FINAL_RUN_STATES.has(run.status)) continue;
        const unknown = await browserRuntime.hasUnresolvedRunOutcome(task.runId);
        if (unknown || !safeToRecoverRun(serviceDatabase, task.runId)) {
          serviceDatabase.db.prepare("UPDATE runs SET status='failed',result=?,updated=? WHERE id=? AND status IN ('queued','running','interrupted','desktop_interrupted')")
            .run(JSON.stringify(unknown
              ? { code: 'BROWSER_ACTION_OUTCOME_UNKNOWN', error: 'A browser action may have taken effect before interruption.' }
              : { code: 'INTERRUPTED_REQUIRES_REVIEW', error: 'The agent was interrupted after a worker had started; the run will not replay it.' }),
            new Date().toISOString(), task.runId);
          taskJournal.updateTask(id, { status: 'recovery_required', error: unknown
            ? 'A browser action may have taken effect before the app stopped. Reconcile the website before starting another task.'
            : 'The agent stopped during an active step. Review the page, then start a new task if needed.' });
        } else {
          if (['queued', 'running', 'interrupted', DESKTOP_INTERRUPTED_RUN].includes(run.status)) {
            serviceDatabase.db.prepare("UPDATE runs SET status=?,result=NULL,updated=? WHERE id=? AND status IN ('queued','running','interrupted','desktop_interrupted')")
              .run(DESKTOP_INTERRUPTED_RUN, new Date().toISOString(), task.runId);
          }
          taskJournal.updateTask(id, { status: 'interrupted', error: null });
        }
      }
      this._schedulePublish();
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => this._schedulePublish(), 500);
        this.pollTimer.unref?.();
      }
      return await this.snapshot();
    },

    async submit({ tabId: tabIdValue, url: urlValue, prompt, allowedOrigins } = {}) {
      await this.ready();
      if (!this.service || !this.modelConfig) throw backendError('MODEL_NOT_CONFIGURED', 'Connect a model before starting an Agent task.', 409);
      if (this.closed) throw backendError('DESKTOP_BACKEND_CLOSED', 'Desktop backend is closed.', 409);
      const tabId = validId(tabIdValue, 'tab_id');
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 40_000) throw backendError('INVALID_PROMPT');
      const target = validateUrlAndOrigins(urlValue, allowedOrigins);
      const activeTask = taskJournal.listTasks({ tabId, limit: TASK_LIMIT }).find(item => {
        const run = item.runId ? serviceDatabase.getRun(OWNER, item.runId) : undefined;
        return ['submitting', 'queued', 'running', 'paused', 'cancelling'].includes(item.status) ||
          run?.status === 'queued' || run?.status === 'running';
      });
      if (activeTask) throw backendError('TAB_AGENT_BUSY', 'This tab already has an active Agent task.', 409);
      const tab = await this.bindTab(tabId, { allowedOrigins: target.allowedOrigins });
      const taskId = randomUUID();
      const idempotencyKey = `desktop-task-${randomUUID()}`;
      const task = taskJournal.createTask({ id: taskId, tabId, harnessSessionId: tab.harnessSessionId,
        prompt: prompt.trim(), url: target.url, allowedOrigins: target.allowedOrigins, idempotencyKey,
        status: 'submitting' });
      const promptWithBrowserContext = `${task.prompt}\n\nDesktop browser task context: use browser_open with this starting URL: ${target.url}. Allowed origins for this task: ${target.allowedOrigins.join(', ')}. Observe the page before taking action. Browser actions require explicit user approval.`;
      if (promptWithBrowserContext.length > 40_000) {
        taskJournal.updateTask(task.id, { status: 'failed', error: 'PROMPT_TOO_LARGE' });
        this._schedulePublish();
        throw backendError('INVALID_PROMPT', 'Prompt is too long after adding the browser safety context.');
      }
      const request = { prompt: promptWithBrowserContext, mode: 'single', budget: { ...DEFAULT_BUDGET },
        toolset: 'browser', executionProfile: this.service.executionProfile, memoryStrategy: 'none' };
      try {
        let existing = serviceDatabase.findRunByKey(OWNER, tab.harnessSessionId, idempotencyKey);
        let created;
        if (existing) created = { run: serviceDatabase.getRun(OWNER, existing.id), replayed: true };
        else created = serviceDatabase.createRun(OWNER, tab.harnessSessionId, idempotencyKey, request);
        taskJournal.updateTask(task.id, { runId: created.run.id, status: 'queued', error: null });
        gates.set(created.run.id, makeGate());
        if (!created.replayed) await this.service.emit(created.run.id, 'run.queued', { mode: 'single', toolset: 'browser', source: 'desktop' });
        this.service.schedule();
      this._schedulePublish();
        return this._taskSnapshot(taskJournal.getTask(task.id));
      } catch (cause) {
        taskJournal.updateTask(task.id, { status: 'failed', error: safeText(cause?.code ?? cause?.message ?? 'TASK_SUBMIT_FAILED', 1000) });
      this._schedulePublish();
        throw cause;
      }
    },

    async pause(tabIdValue) {
      await this.ready();
      const tabId = validId(tabIdValue, 'tab_id');
      const task = taskJournal.listTasks({ tabId, limit: TASK_LIMIT }).find(item => !taskJournal.isTerminal(item) ||
        (item.status === 'recovery_required' && item.runId && !FINAL_RUN_STATES.has(serviceDatabase.getRun(OWNER, item.runId)?.status)));
      if (!task?.runId) throw backendError('ACTIVE_TASK_NOT_FOUND', 'There is no active Agent task for this tab.', 404);
      const gate = gates.get(task.runId) ?? makeGate();
      gates.set(task.runId, gate);
      gate.paused = true;
      gate.freshObservationRequired = true;
      const sessions = (await browserStore.listSessions(OWNER, { limit: 1000 })).filter(item => item.runId === task.runId);
      await browserStore.rejectUndispatchedForRun(OWNER, task.runId, 'BROWSER_MANUAL_TAKEOVER');
      await waitForGateQuiescent(gate);
      const running = sessions.map(item => browserRuntime.executing.get(item.id)).filter(Boolean);
      await Promise.allSettled(running);
      await browserStore.rejectUndispatchedForRun(OWNER, task.runId, 'BROWSER_MANUAL_TAKEOVER');
      for (const session of sessions) {
        await driver.invalidateSessionRefs?.(session.id);
      }
      await driver.pauseHarnessSession?.(task.harnessSessionId, task.tabId);
      const unknown = await browserRuntime.hasUnresolvedRunOutcome(task.runId);
      taskJournal.updateTask(task.id, unknown
        ? { status: 'recovery_required', error: 'A browser action may have taken effect. Reconcile the website before starting another task.' }
        : { status: 'paused', error: null });
      this._schedulePublish();
      return await this._taskSnapshot(taskJournal.getTask(task.id));
    },

    async resume(tabIdValue) {
      await this.ready();
      const tabId = validId(tabIdValue, 'tab_id');
      const task = taskJournal.listTasks({ tabId, limit: TASK_LIMIT }).find(item => item.status === 'paused');
      if (!task?.runId) throw backendError('PAUSED_TASK_NOT_FOUND', 'There is no paused Agent task for this tab.', 404);
      const run = serviceDatabase.getRun(OWNER, task.runId);
      if (!run || run.status !== 'running' || !this.service?.active.has(task.runId)) {
        throw backendError('TASK_REQUIRES_RECOVERY', 'This task was interrupted. Use Recover to continue it safely.', 409);
      }
      if (await browserRuntime.hasUnresolvedRunOutcome(task.runId)) {
        taskJournal.updateTask(task.id, { status: 'recovery_required', error: 'A browser action may have taken effect. Reconcile the website before starting another task.' });
        throw backendError('BROWSER_ACTION_OUTCOME_UNKNOWN', 'A browser action has an unknown outcome. The task will not resume automatically.', 409);
      }
      const gate = gates.get(task.runId) ?? makeGate();
      gates.set(task.runId, gate);
      gate.freshObservationRequired = true;
      await driver.bindHarnessSession?.(task.harnessSessionId, tabId, task.allowedOrigins);
      await driver.resumeHarnessSession?.(task.harnessSessionId, tabId);
      gate.paused = false;
      for (const wake of [...gate.waiters]) wake();
      taskJournal.updateTask(task.id, { status: 'running', error: null });
      this._schedulePublish();
      return await this._taskSnapshot(taskJournal.getTask(task.id));
    },

    async cancel(tabIdValue) {
      await this.ready();
      const tabId = validId(tabIdValue, 'tab_id');
      const task = taskJournal.listTasks({ tabId, limit: TASK_LIMIT }).find(item => !taskJournal.isTerminal(item) ||
        (item.status === 'recovery_required' && item.runId && !FINAL_RUN_STATES.has(serviceDatabase.getRun(OWNER, item.runId)?.status)));
      if (!task) throw backendError('ACTIVE_TASK_NOT_FOUND', 'There is no active Agent task for this tab.', 404);
      if (!task.runId) {
        taskJournal.updateTask(task.id, { status: 'cancelled', error: null });
      this._schedulePublish();
      return await this._taskSnapshot(taskJournal.getTask(task.id));
      }
      serviceDatabase.db.prepare("UPDATE runs SET status='cancelled',cancel_requested=1,cancel_requested_at=?,updated=? WHERE id=? AND status IN ('desktop_interrupted','interrupted')")
        .run(new Date().toISOString(), new Date().toISOString(), task.runId);
      await serviceDatabase.requestRunCancellation(task.runId);
      this.service?.active.get(task.runId)?.controller.abort();
      const latest = serviceDatabase.getRun(OWNER, task.runId);
      const gate = gates.get(task.runId);
      if (gate) {
        gate.paused = false;
        for (const wake of [...gate.waiters]) wake();
      }
      taskJournal.updateTask(task.id, { status: latest?.status === 'cancelled' ? 'cancelled' : 'cancelling' });
      this._schedulePublish();
      return await this._taskSnapshot(taskJournal.getTask(task.id));
    },

    async recover(tabIdValue, taskIdValue) {
      await this.ready();
      if (!this.service || !this.modelConfig) throw backendError('MODEL_NOT_CONFIGURED', 'Connect a model before recovering an Agent task.', 409);
      const tabId = validId(tabIdValue, 'tab_id');
      const taskId = validId(taskIdValue, 'task_id');
      const task = taskJournal.getTask(taskId);
      if (!task || task.tabId !== tabId) throw backendError('DESKTOP_TASK_NOT_FOUND', 'The saved task does not belong to this tab.', 404);
      if (task.status === 'cancelled') throw backendError('CANCELLED_TASK_CANNOT_RECOVER', 'Cancelled tasks stay cancelled.', 409);
      if (task.status === 'recovery_required') throw backendError('TASK_REQUIRES_REVIEW', 'Review the website state and start a new task instead of replaying this one.', 409);
      let run = task.runId ? serviceDatabase.getRun(OWNER, task.runId) : undefined;
      if (!run) {
        const existing = serviceDatabase.findRunByKey(OWNER, task.harnessSessionId, task.idempotencyKey);
        if (existing) {
          run = serviceDatabase.getRun(OWNER, existing.id);
          taskJournal.updateTask(task.id, { runId: run.id });
        } else {
          const safeUrl = validateUrlAndOrigins(task.url, task.allowedOrigins);
          const request = { prompt: `${task.prompt}\n\nDesktop browser task context: use browser_open with this starting URL: ${safeUrl.url}. Allowed origins for this task: ${safeUrl.allowedOrigins.join(', ')}. Observe the page before taking action. Browser actions require explicit user approval.`,
            mode: 'single', budget: { ...DEFAULT_BUDGET }, toolset: 'browser',
            executionProfile: this.service.executionProfile, memoryStrategy: 'none' };
          const created = serviceDatabase.createRun(OWNER, task.harnessSessionId, task.idempotencyKey, request);
          run = created.run;
          taskJournal.updateTask(task.id, { runId: run.id, status: 'interrupted' });
        }
      }
      if (!run) throw backendError('TASK_RECOVERY_UNAVAILABLE', 'Saved task metadata is incomplete.', 409);
      if (run.status === 'cancelled' || run.cancel_requested) {
        taskJournal.updateTask(task.id, { status: 'cancelled' });
        throw backendError('CANCELLED_TASK_CANNOT_RECOVER', 'Cancelled tasks stay cancelled.', 409);
      }
      if (await browserRuntime.hasUnresolvedRunOutcome(run.id)) {
        taskJournal.updateTask(task.id, { status: 'recovery_required', error: 'A browser action may have taken effect. Reconcile the website before starting a new task.' });
        throw backendError('BROWSER_ACTION_OUTCOME_UNKNOWN', 'A browser action has an unknown outcome. The task will not replay it.', 409);
      }
      if (!safeToRecoverRun(serviceDatabase, run.id)) {
        taskJournal.updateTask(task.id, { status: 'recovery_required', error: 'The agent stopped during an active step. Review the page, then start a new task if needed.' });
        throw backendError('INTERRUPTED_REQUIRES_REVIEW', 'This task already started an agent step and will not be replayed.', 409);
      }
      if (FINAL_RUN_STATES.has(run.status)) {
        const code = run.result?.code;
        if (code === 'BROWSER_ACTION_OUTCOME_UNKNOWN') {
          taskJournal.updateTask(task.id, { status: 'recovery_required', error: 'A browser action may have taken effect. Reconcile the website before starting a new task.' });
          throw backendError('BROWSER_ACTION_OUTCOME_UNKNOWN', 'A browser action has an unknown outcome. The task will not replay it.', 409);
        }
        throw backendError('TASK_NOT_RECOVERABLE', 'This task already finished. Start a new task if you want to continue.', 409);
      }
      if (run.status !== 'queued' && run.status !== 'interrupted' && run.status !== DESKTOP_INTERRUPTED_RUN) {
        if (this.service.active.has(run.id)) return await this._taskSnapshot(task);
        throw backendError('TASK_RECOVERY_UNAVAILABLE', 'The task is still owned by another execution state.', 409);
      }
      if (!this.startupTaskIds.has(task.id) && task.status !== 'interrupted') {
        throw backendError('TASK_NOT_INTERRUPTED', 'This task is already queued or running.', 409);
      }
      const tab = taskJournal.getTab(tabId);
      await driver.bindHarnessSession?.(task.harnessSessionId, tabId, task.allowedOrigins);
      gates.set(run.id, makeGate());
      serviceDatabase.db.prepare("UPDATE runs SET status='queued',result=NULL,updated=? WHERE id=? AND status IN ('interrupted','desktop_interrupted')")
        .run(new Date().toISOString(), run.id);
      taskJournal.updateTask(task.id, { status: 'queued', error: null });
      await this.service.emit(run.id, 'run.recovered', { strategy: 'explicit_user_recovery' });
      this.service.schedule();
      this._schedulePublish();
      return await this._taskSnapshot(taskJournal.getTask(task.id));
    },

    async approve(tabIdValue, commandId, requestHash) { return await this._decide(tabIdValue, commandId, requestHash, 'approve'); },
    async reject(tabIdValue, commandId, requestHash) { return await this._decide(tabIdValue, commandId, requestHash, 'reject'); },

    async _decide(tabIdValue, commandIdValue, requestHash, decision) {
      await this.ready();
      const tabId = validId(tabIdValue, 'tab_id');
      const commandId = validId(commandIdValue, 'command_id');
      if (typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(requestHash)) throw backendError('INVALID_REQUEST_HASH');
      const command = await browserStore.getCommand(OWNER, commandId);
      const session = command ? await browserStore.getSession(OWNER, command.sessionId) : undefined;
      const task = session ? taskJournal.getTaskByRunId(session.runId) : undefined;
      if (!command || !task || task.tabId !== tabId) throw backendError('BROWSER_COMMAND_NOT_FOUND', 'The approval belongs to another tab or task.', 404);
      const decided = await browserRuntime.decide(OWNER, commandId, decision, requestHash);
      this._schedulePublish();
      return decided;
    },

    async snapshot() {
      await this.ready();
      const tasks = [];
      for (const task of taskJournal.listTasks({ limit: TASK_LIMIT })) tasks.push(await this._taskSnapshot(task));
      return { configured: Boolean(this.modelConfig), model: this.modelConfig?.model ?? null,
      endpoint: this.modelConfig ? sanitizeModelEndpoint(this.modelConfig.baseUrl) : null,
      thinkingMode: this.modelConfig?.thinkingMode ?? null,
      status: this.closed ? 'closed' : this.modelConfig ? 'ready' : 'unconfigured',
      tabs: taskJournal.listTabs(), tasks };
    },

    async _taskSnapshot(task) {
      if (!task) return undefined;
      const run = task.runId ? serviceDatabase.getRun(OWNER, task.runId) : undefined;
      let status = task.status;
      if (run) {
        const gate = gates.get(run.id);
        if (task.status === 'recovery_required') status = 'recovery_required';
        else if (gate?.paused && run.status === 'running') status = 'paused';
        else if (run.status === 'running') status = 'running';
      else if ((run.status === 'queued' || run.status === DESKTOP_INTERRUPTED_RUN) && task.status === 'interrupted') status = 'interrupted';
        else if (run.status === 'queued' && task.status !== 'recovery_required') status = task.status === 'submitting' ? 'queued' : task.status;
        else if (run.status === 'succeeded' || run.status === 'partial') status = run.status;
        else if (run.status === 'failed' && ['BROWSER_ACTION_OUTCOME_UNKNOWN', 'INTERRUPTED_REQUIRES_REVIEW', 'INTERRUPTED_DURING_PLANNING'].includes(run.result?.code)) status = 'recovery_required';
        else if (run.status === 'cancelled') status = 'cancelled';
        else if (run.status === 'timed_out' || run.status === 'failed') status = 'failed';
      }
      if (run && status !== task.status && task.status !== 'recovery_required') {
        try { taskJournal.updateTask(task.id, { status, output: extractOutput(run), error: taskError(run) }); } catch { /* snapshot remains useful */ }
      }
      const sessions = task.runId
        ? (await browserStore.listSessions(OWNER, { limit: 1000 })).filter(item => item.runId === task.runId)
        : [];
      const commandSets = await Promise.all(sessions.map(session => browserStore.commands(OWNER, session.id, 100)));
      const commands = commandSets.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(command => ({
        id: command.id, commandId: command.id, sessionId: command.sessionId, type: command.request?.type ?? 'unknown',
        status: command.status, requestHash: command.requestHash,
        request: command.request,
        result: command.result, requiresApproval: command.requiresApproval,
        approvalDecision: command.approvalDecision, createdAt: command.createdAt,
      }));
      const unresolved = task.runId ? await browserRuntime.hasUnresolvedRunOutcome(task.runId) : false;
      if (run && FINAL_RUN_STATES.has(run.status) && !unresolved && !this.cleanedRuns.has(run.id)) {
        const liveSessions = sessions.filter(session => session.status !== 'closed');
        await Promise.allSettled(liveSessions.map(session => browserRuntime.closeSession(OWNER, session.id)));
        this.cleanedRuns.add(run.id);
      }
      const recoverable = Boolean(task.runId && status === 'interrupted' && ['queued', 'interrupted', DESKTOP_INTERRUPTED_RUN].includes(run?.status) &&
        !run.cancel_requested && !unresolved && safeToRecoverRun(serviceDatabase, task.runId) && this.modelConfig);
      return { id: task.id, tabId: task.tabId, harnessSessionId: task.harnessSessionId, runId: task.runId,
        prompt: task.prompt, url: task.url, status, output: task.output ?? extractOutput(run),
        error: task.error ?? taskError(run), recoverable, commands, createdAt: task.createdAt, updatedAt: task.updatedAt };
    },

    _schedulePublish() {
      if (this.closed || this.publishTimer) return;
      this.publishTimer = setTimeout(() => {
        this.publishTimer = undefined;
        if (!this.publishing) this.publishing = this.snapshot().then(state => onState(state)).catch(() => {}).finally(() => { this.publishing = undefined; });
      }, 40);
      this.publishTimer.unref?.();
    },

    async close() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.publishTimer);
      clearInterval(this.pollTimer);
      this.publishTimer = undefined;
      this.pollTimer = undefined;
      const activeAtShutdown = new Set(this.service?.active.keys() ?? []);
      if (this.service) {
        this.service.closed = true;
        for (const { controller } of this.service.active.values()) controller.abort();
        await Promise.allSettled([...this.service.active.values()].map(item => item.promise));
      }
      for (const task of taskJournal.listTasks({ limit: 1000 })) {
        if (!task.runId) {
          if (!taskJournal.isTerminal(task)) taskJournal.updateTask(task.id, { status: 'interrupted', error: 'Recover to reuse this task’s original request key.' });
          continue;
        }
        if (taskJournal.isTerminal(task)) continue;
        const run = serviceDatabase.getRun(OWNER, task.runId);
        if (!run || run.cancel_requested) continue;
        const shutdownInterrupted = activeAtShutdown.has(task.runId) && run.status === 'cancelled';
        if (FINAL_RUN_STATES.has(run.status) && !shutdownInterrupted) continue;
        const unknown = await browserRuntime.hasUnresolvedRunOutcome(task.runId);
        const reservation = serviceDatabase.latestEvent(task.runId, 'run.execution_reserved');
        const canResume = !unknown && (!activeAtShutdown.has(task.runId) || (Boolean(reservation) && safeToRecoverRun(serviceDatabase, task.runId)));
        if (!canResume) {
          serviceDatabase.db.prepare("UPDATE runs SET status='failed',result=?,updated=? WHERE id=?")
            .run(JSON.stringify(unknown
              ? { code: 'BROWSER_ACTION_OUTCOME_UNKNOWN', error: 'A browser action may have taken effect before shutdown.' }
              : reservation ? { code: 'INTERRUPTED_REQUIRES_REVIEW', error: 'An active agent step was interrupted; it will not be replayed.' }
                : { code: 'INTERRUPTED_DURING_PLANNING', error: 'The run stopped before execution reservation; submit explicitly to try again.' }),
            new Date().toISOString(), task.runId);
          taskJournal.updateTask(task.id, { status: 'recovery_required', error: unknown
            ? 'A browser action may have taken effect. Reconcile the website before starting another task.'
            : reservation ? 'The agent stopped during an active step. Review the page, then start a new task if needed.'
              : 'The task stopped during planning; start a new task explicitly.' });
        } else {
          serviceDatabase.db.prepare("UPDATE runs SET status=?,result=NULL,updated=? WHERE id=? AND status IN ('queued','running','cancelled','interrupted','desktop_interrupted')")
            .run(DESKTOP_INTERRUPTED_RUN, new Date().toISOString(), task.runId);
          taskJournal.updateTask(task.id, { status: 'interrupted', error: null });
        }
      }
      await browserRuntime.close();
      if (this.service) await this.service.close();
      else serviceDatabase.close();
      this.modelConfig = undefined;
    },
  };

  // Per-task allowlist enforcement is applied at the same BrowserRuntime entrypoints used by the model provider.
  const originalOpen = browserRuntime.open.bind(browserRuntime);
  browserRuntime.open = async input => {
    const task = taskJournal.getTaskByRunId(input.runId);
    if (task) validateUrlAndOrigins(input.url, task.allowedOrigins);
    return originalOpen(input);
  };
  const originalSubmit = browserRuntime.submit.bind(browserRuntime);
  browserRuntime.submit = async (owner, sessionId, request, idempotencyKey, signal) => {
    if (request?.type === 'navigate') {
      const session = await browserStore.getSession(owner, sessionId);
      const task = session ? taskJournal.getTaskByRunId(session.runId) : undefined;
      if (task) validateUrlAndOrigins(request.url, task.allowedOrigins);
    }
    return originalSubmit(owner, sessionId, request, idempotencyKey, signal);
  };

  return backend;
}
