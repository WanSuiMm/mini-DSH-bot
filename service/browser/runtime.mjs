import { createHash, randomUUID } from 'node:crypto';
import { redactSensitive } from '../security/guard.mjs';

const failure = (status, code) => Object.assign(new Error(code), { status, code });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const transitions = new Set(['click', 'fill', 'select', 'press']);
const types = new Set(['observe', 'navigate', ...transitions]);
const publicCommand = c => ({ id: c.id, sessionId: c.sessionId, status: c.status, requestHash: c.requestHash,
  createdAt: c.createdAt, updatedAt: c.updatedAt, result: redactSensitive(c.result ?? null) });

/** One browser-owning process. PostgreSQL fences ownership; it cannot resurrect a dead DOM. */
export class BrowserRuntime {
  constructor({ store, driver, vault, maxSessions = 4, maxOwnerSessions = 2, leaseMs = 60_000,
    ttlMs = 1_800_000, idleMs = 300_000, onError = () => {} }) {
    for (const [value, min, max] of [[maxSessions, 1, 64], [maxOwnerSessions, 1, maxSessions], [leaseMs, 30_000, 300_000],
      [ttlMs, 60_000, 86_400_000], [idleMs, 30_000, ttlMs]]) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw failure(400, 'BROWSER_LIMIT_INVALID');
    }
    this.store = store; this.driver = driver; this.vault = vault;
    this.limits = { maxSessions, maxOwnerSessions, leaseMs, ttlMs, idleMs };
    this.workerId = randomUUID(); this.contexts = new Map(); this.executing = new Map(); this.operations = new Map();
    this.openings = new Map(); this.closed = false; this.onError = onError; this.maintenance = undefined;
    this.runContexts = new Map(); this.previewBusy = new Set();
  }
  setRunAuthorizer(authorize) {
    if (typeof authorize !== 'function') throw failure(400, 'BROWSER_RUN_AUTHORIZER_REQUIRED');
    this.authorizeRun = authorize;
  }
  bindRunContext(binding, context) {
    if (binding.runId !== context.runId || binding.sessionId !== context.sessionId) throw failure(403, 'BROWSER_BINDING_MISMATCH');
    const deadline = Date.parse(context.budget?.deadlineAt ?? '');
    if (!Number.isFinite(deadline)) throw failure(400, 'BROWSER_RUN_DEADLINE_REQUIRED');
    this.runContexts.set(JSON.stringify([binding.runId, context.taskId]), { owner: binding.owner, runId: binding.runId, taskId: context.taskId, signal: context.signal, deadline });
  }
  async runIsActive(owner, runId, taskId) {
    const context = this.runContexts.get(JSON.stringify([runId, taskId]));
    return Boolean(context && context.owner === owner && !context.signal?.aborted && Date.now() < context.deadline &&
      this.authorizeRun && await this.authorizeRun(owner, runId));
  }
  async ready() {
    await this.store.ready();
    await this.store.acquireRuntimeLock?.();
    await this.vault?.ready();
    await this.store.recoverPreviousWorkers?.(this.workerId);
    await this.store.recoverExpired();
    this.timer = setInterval(() => {
      if (!this.maintenance && !this.closed) this.maintenance = this.maintain().catch(() => this.onError('browser_maintenance_failed')).finally(() => { this.maintenance = undefined; });
    }, Math.floor(this.limits.leaseMs / 4));
    this.timer.unref();
  }
  async event(owner, sessionId, type, payload) {
    return this.store.appendEvent({ owner, sessionId, type, payload: redactSensitive(payload) });
  }
  async requireSession(owner, sessionId, binding) {
    const session = await this.store.getSession(owner, sessionId);
    if (!session || (binding && (session.harnessSessionId !== binding.sessionId || session.runId !== binding.runId ||
      (binding.taskId !== undefined && session.taskId !== binding.taskId)))) throw failure(404, 'BROWSER_SESSION_NOT_FOUND');
    return session;
  }
  async live(owner, sessionId) {
    const session = await this.requireSession(owner, sessionId);
    const local = this.contexts.get(sessionId);
    if (!local || local.closing || session.workerId !== this.workerId || local.fence !== session.fence || session.status !== 'active') throw failure(409, 'BROWSER_SESSION_REQUIRES_REOPEN');
    if (!await this.store.touchSession({ owner, id: sessionId, workerId: this.workerId, fence: session.fence, leaseMs: this.limits.leaseMs })) {
      await this.driver.closeSession(sessionId).catch(() => {}); this.contexts.delete(sessionId);
      throw failure(409, 'BROWSER_LEASE_LOST');
    }
    local.lastUsed = Date.now(); return session;
  }
  async open({ owner, sessionId, runId, taskId, url, profileId = null, openKey, signal }) {
    if (this.closed) throw failure(503, 'BROWSER_CLOSED');
    if (typeof url !== 'string' || url.length > 4096) throw failure(400, 'BROWSER_URL_INVALID');
    if (openKey !== undefined && (typeof openKey !== 'string' || !openKey || openKey.length > 512)) throw failure(400, 'BROWSER_OPEN_KEY_INVALID');
    const validated = await this.driver.validateUrl?.(url);
    if (validated && validated.ok !== true) throw failure(400, 'BROWSER_URL_NOT_ALLOWED');
    if (profileId && !this.vault) throw failure(400, 'BROWSER_PROFILES_DISABLED');
    // Preserve the legacy UI identity when no key is supplied. Tool calls pass
    // a host-derived key so a replay reuses its session while a new call gets
    // a fresh context after the previous one closed.
    const identity = openKey === undefined
      ? [owner, sessionId, runId, taskId, this.workerId]
      : [owner, sessionId, runId, taskId, this.workerId, openKey];
    const id = 'br_' + hash(identity).slice(0, 40);
    const priorOpen = this.openings.get(id);
    if (priorOpen) return { ...(await priorOpen), replayed: true };
    const opening = this.createOrReplayOpen({ owner, sessionId, runId, taskId, url, profileId, signal, id });
    this.openings.set(id, opening);
    try { return await opening; }
    finally { if (this.openings.get(id) === opening) this.openings.delete(id); }
  }
  async createOrReplayOpen({ owner, sessionId, runId, taskId, url, profileId, signal, id }) {
    const created = await this.store.createSession({ id, owner, harnessSessionId: sessionId, runId, taskId, profileId,
      workerId: this.workerId, ...this.limits });
    const session = created.session;
    if (created.replayed) {
      if (!this.contexts.has(id) || session.status !== 'active') throw failure(409, 'BROWSER_SESSION_REQUIRES_REOPEN');
      const command = await this.submit(owner, id, { type: 'navigate', url }, 'open-' + hash(url), signal);
      return { session, command, replayed: true };
    }
    return this.openCreated({ owner, sessionId, runId, taskId, url, profileId, signal, id, session });
  }
  async openCreated({ owner, sessionId, runId, taskId, url, profileId, signal, id, session }) {
    try {
      if (signal?.aborted) throw failure(409, 'BROWSER_CANCELLED');
      const state = profileId ? await this.vault.load(owner, profileId) : undefined;
      // An in-process desktop driver adopts the user's existing tab. The
      // trusted run binding is never supplied by model tool arguments.
      await this.driver.open({ id, owner, sessionId, runId, taskId, storageState: state, signal });
      this.contexts.set(id, { owner, runId, taskId, fence: session.fence, lastUsed: Date.now(), openedAt: Date.now() });
      const active = await this.store.transitionSession({ owner, id, workerId: this.workerId, fence: session.fence, status: 'active', reason: 'context_created' });
      await this.event(owner, id, 'browser.session.opened', { profileAttached: Boolean(profileId) });
      const command = await this.submit(owner, id, { type: 'navigate', url }, 'open-' + hash(url), signal);
      return { session: active, command, replayed: false };
    } catch (cause) {
      await this.driver.closeSession(id).catch(() => {}); this.contexts.delete(id);
      await this.store.closeSession(owner, id).catch(() => {});
      throw failure(cause.status ?? 502, /^[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'BROWSER_OPEN_FAILED');
    }
  }
  validateRequest(request) {
    if (!request || Array.isArray(request) || !types.has(request.type)) throw failure(400, 'BROWSER_COMMAND_INVALID');
    const keys = { observe: ['type', 'offset'], navigate: ['type', 'url'], click: ['type', 'ref'], fill: ['type', 'ref', 'text'], select: ['type', 'ref', 'values'], press: ['type', 'ref', 'key'] }[request.type];
    if (Object.keys(request).some(k => !keys.includes(k))) throw failure(400, 'BROWSER_COMMAND_INVALID');
    if (request.type === 'observe' && request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 10000)) throw failure(400, 'BROWSER_COMMAND_INVALID');
    if (request.type === 'navigate' && (typeof request.url !== 'string' || !request.url || request.url.length > 4096)) throw failure(400, 'BROWSER_URL_INVALID');
    if (transitions.has(request.type) && (typeof request.ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.ref))) throw failure(400, 'BROWSER_REFERENCE_INVALID');
    if (request.type === 'fill' && (typeof request.text !== 'string' || request.text.length > 8000)) throw failure(400, 'BROWSER_VALUE_INVALID');
    if (request.type === 'select' && (!Array.isArray(request.values) || !request.values.length || request.values.length > 20 || request.values.some(v => typeof v !== 'string' || v.length > 500))) throw failure(400, 'BROWSER_VALUE_INVALID');
    if (request.type === 'press' && (typeof request.key !== 'string' || !['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(request.key))) throw failure(400, 'BROWSER_KEY_INVALID');
    return structuredClone(request);
  }
  async submit(owner, sessionId, input, idempotencyKey, signal) {
    const request = this.validateRequest(input);
    if (request.type === 'navigate') {
      const validated = await this.driver.validateUrl?.(request.url);
      if (validated && validated.ok !== true) throw failure(400, 'BROWSER_URL_NOT_ALLOWED');
    }
    const session = await this.live(owner, sessionId);
    const queued = await this.store.enqueueCommand({ id: randomUUID(), owner, sessionId, idempotencyKey,
      requestHash: hash(request), request, requiresApproval: request.type !== 'observe' });
    const command = queued.command;
    if (queued.replayed || command.status === 'pending_approval') {
      if (!queued.replayed) await this.event(owner, sessionId, 'browser.approval.required', { commandId: command.id, requestHash: command.requestHash, type: request.type });
      return { ...publicCommand(command), executed: command.status === 'succeeded', replayed: queued.replayed };
    }
    // Reads are serialized with approved interactions through the same DB lock.
    return this.executeCommand(session, command, signal);
  }
  serialize(id, action) {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.operations.set(id, next);
    return next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id); });
  }
  executeCommand(session, command, signal) {
    return this.serialize(session.id, () => this.executeNow(session, command, signal));
  }
  async executeNow(session, command, signal) {
    await this.live(session.owner, session.id);
    const started = await this.store.beginCommand({ owner: session.owner, id: command.id, sessionId: session.id, workerId: this.workerId, fence: session.fence });
    if (!started) return { ...publicCommand(await this.store.getCommand(session.owner, command.id)), executed: false };
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const current = this.contexts.get(session.id);
    if (!current) throw failure(409, 'BROWSER_SESSION_REQUIRES_REOPEN');
    current.controller = controller;
    let terminal; let dispatchStarted = false; let driverOutcome;
    try {
      if (!await this.runIsActive(session.owner, session.runId, session.taskId)) {
        terminal = await this.store.finishCommand({ owner: session.owner, id: command.id, workerId: this.workerId, fence: session.fence,
          status: 'failed', result: { code: 'BROWSER_RUN_NOT_ACTIVE', executed: false } });
        return { ...publicCommand(terminal), executed: false };
      }
      if (controller.signal.aborted) {
        terminal = await this.store.finishCommand({ owner: session.owner, id: command.id, workerId: this.workerId, fence: session.fence,
          status: 'failed', result: { code: 'BROWSER_CANCELLED_BEFORE_DISPATCH', executed: false } });
        return { ...publicCommand(terminal), executed: false };
      }
      await this.event(session.owner, session.id, 'browser.command.started', { commandId: command.id, type: command.request.type });
      dispatchStarted = true;
      const data = await this.driver.execute(session.id, command.request, { signal: controller.signal, approved: command.requiresApproval === true });
      if (!data || typeof data.ok !== 'boolean') throw failure(502, 'BROWSER_DRIVER_PROTOCOL');
      if (!data.ok) {
        driverOutcome = {};
        if (Object.hasOwn(data, 'error')) driverOutcome.driverError = redactSensitive(data.error);
        if (Object.hasOwn(data, 'sideEffectStarted')) driverOutcome.sideEffectStarted = data.sideEffectStarted;
        if (Object.hasOwn(data, 'contextClosed')) driverOutcome.contextClosed = data.contextClosed;
        const cause = failure(400, /^[A-Z_]+$/.test(data.error?.code ?? '') ? data.error.code : 'BROWSER_DRIVER_ERROR');
        cause.sideEffectStarted = data.sideEffectStarted;
        cause.contextClosed = data.contextClosed === true;
        throw cause;
      }
      if (session.profileId && this.vault) await this.persistProfileState(session);
      terminal = await this.store.finishCommand({ owner: session.owner, id: command.id, workerId: this.workerId, fence: session.fence,
        status: 'succeeded', result: redactSensitive(data) });
      await this.event(session.owner, session.id, 'browser.command.succeeded', { commandId: command.id, type: command.request.type });
      return { ...publicCommand(terminal), executed: true };
    } catch (cause) {
      if (terminal) { this.onError('browser_terminal_event_failed'); return { ...publicCommand(terminal), executed: terminal.status === 'succeeded' }; }
      // A driver may have changed external state before timing out, even for
      // navigation. Only failures known to precede a side effect are terminal
      // failures; anything started remains unknown and is never retried.
      if (!dispatchStarted || cause.sideEffectStarted === false) {
        const outcome = cause.code === 'TIMEOUT' ? 'timeout' : 'failed';
        terminal = await this.store.finishCommand({ owner: session.owner, id: command.id, workerId: this.workerId, fence: session.fence,
          status: 'failed', result: { code: !dispatchStarted ? 'BROWSER_AUDIT_UNAVAILABLE' : /^[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'BROWSER_REQUEST_REJECTED', outcome, executed: false, ...driverOutcome } });
        if (cause.contextClosed) {
          await this.driver.closeSession(session.id).catch(() => {}); this.contexts.delete(session.id);
          await this.store.transitionSession({ owner: session.owner, id: session.id, workerId: this.workerId, fence: session.fence, status: 'lost', reason: 'driver_context_closed' }).catch(() => {});
        }
        return { ...publicCommand(terminal), executed: false };
      }
      // The page may have acted before the error/lease loss. Never retry it.
      const unknownResult = { code: 'BROWSER_ACTION_OUTCOME_UNKNOWN', outcome: 'unknown', requiresHumanReconciliation: true,
        executed: null, ...driverOutcome };
      await this.store.finishCommand({ owner: session.owner, id: command.id, workerId: this.workerId, fence: session.fence,
        status: 'unknown', result: unknownResult }).catch(() => {});
      await this.driver.closeSession(session.id).catch(() => {}); this.contexts.delete(session.id);
      await this.store.transitionSession({ owner: session.owner, id: session.id, workerId: this.workerId, fence: session.fence, status: 'lost', reason: 'command_outcome_unknown' }).catch(() => {});
      return { id: command.id, sessionId: session.id, status: 'unknown', requestHash: command.requestHash, executed: null,
        result: unknownResult };
    } finally {
      signal?.removeEventListener('abort', abort);
      const local = this.contexts.get(session.id); if (local) delete local.controller;
    }
  }
  async decide(owner, id, decision, requestHash) {
    const existing = await this.store.getCommand(owner, id);
    if (!existing) throw failure(404, 'BROWSER_COMMAND_NOT_FOUND');
    if (['succeeded', 'failed', 'unknown', 'rejected'].includes(existing.status) && existing.requestHash === requestHash && existing.approvalDecision === decision) return publicCommand(existing);
    const session = await this.live(owner, existing.sessionId);
    if (decision === 'approve' && !await this.runIsActive(owner, session.runId, session.taskId)) throw failure(409, 'BROWSER_RUN_NOT_ACTIVE');
    const command = await this.store.approveCommand({ owner, id, decision, requestHash });
    await this.event(owner, existing.sessionId, 'browser.approval.' + (decision === 'approve' ? 'granted' : 'rejected'), { commandId: id, requestHash });
    if (command.status === 'ready') this.schedule(owner, command.sessionId);
    return publicCommand(command);
  }
  async persistProfileState(session) {
    if (!await this.store.touchSession({ owner: session.owner, id: session.id, workerId: this.workerId, fence: session.fence, leaseMs: this.limits.leaseMs })) {
      throw failure(409, 'BROWSER_LEASE_LOST');
    }
    const state = await this.driver.storageState(session.id);
    if (!await this.store.touchSession({ owner: session.owner, id: session.id, workerId: this.workerId, fence: session.fence, leaseMs: this.limits.leaseMs })) {
      throw failure(409, 'BROWSER_LEASE_LOST');
    }
    await this.vault.save(session.owner, session.profileId, state);
  }
  schedule(owner, id) {
    if (this.closed || this.executing.has(id)) return;
    const promise = (async () => {
      while (!this.closed && this.contexts.has(id)) {
        const command = await this.store.nextReadyCommand(owner, id); if (!command) break;
        const session = await this.live(owner, id);
        const result = await this.executeCommand(session, command, this.runContexts.get(JSON.stringify([session.runId, session.taskId]))?.signal);
        if (!result.executed) break;
      }
    })().catch(() => this.onError('browser_dispatch_failed')).finally(() => { this.executing.delete(id); });
    this.executing.set(id, promise);
  }
  async waitForCommand(owner, id, context) {
    const deadline = Math.min(Date.parse(context.budget?.deadlineAt ?? ''), Date.now() + 600_000);
    if (!Number.isFinite(deadline)) throw failure(400, 'BROWSER_RUN_DEADLINE_REQUIRED');
    while (!this.closed) {
      const command = await this.store.getCommand(owner, id);
      if (!command) throw failure(404, 'BROWSER_COMMAND_NOT_FOUND');
      if (!['pending_approval', 'ready', 'running'].includes(command.status)) return { ...publicCommand(command), executed: command.status === 'succeeded' };
      if (context.signal?.aborted || Date.now() >= deadline) return { ...publicCommand(command), executed: false, waitExpired: true };
      await new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); context.signal?.removeEventListener('abort', done); resolve(); };
        timer = setTimeout(done, Math.min(750, Math.max(1, deadline - Date.now())));
        context.signal?.addEventListener('abort', done, { once: true });
        if (context.signal?.aborted) done();
      });
    }
    throw failure(503, 'BROWSER_CLOSED');
  }
  async preview(owner, id, signal) {
    const session = await this.requireSession(owner, id);
    const local = this.contexts.get(id);
    if (!local || this.previewBusy.has(id)) throw failure(409, 'BROWSER_PREVIEW_BUSY');
    if (Date.now() - (local.lastPreviewAt ?? 0) < 1000) throw failure(429, 'BROWSER_PREVIEW_RATE_LIMIT');
    this.previewBusy.add(id); local.lastPreviewAt = Date.now();
    try {
      return await this.serialize(id, async () => {
        if (signal?.aborted) throw failure(409, 'BROWSER_PREVIEW_CANCELLED');
        await this.live(owner, id);
        // Leaving the UI must not cancel the Agent's live browser context.
        // Once started, a preview finishes under the driver's own short timeout.
        const result = await this.driver.preview(id);
        if (!result?.ok) {
          if (result?.contextClosed) {
            this.contexts.delete(id);
            await this.store.transitionSession({ owner, id, workerId: this.workerId, fence: session.fence, status: 'lost', reason: 'preview_context_closed' }).catch(() => {});
          }
          throw failure(409, 'BROWSER_PREVIEW_UNAVAILABLE');
        }
        return result;
      });
    } finally { this.previewBusy.delete(id); }
  }
  async closeSession(owner, id) {
    const owned = await this.requireSession(owner, id);
    if (owned.workerId !== this.workerId && ['creating', 'active', 'paused'].includes(owned.status)) throw failure(409, 'BROWSER_OWNING_WORKER_REQUIRED');
    const local = this.contexts.get(id);
    if (local) { local.closing = true; local.controller?.abort(); }
    return this.serialize(id, async () => {
      const session = await this.requireSession(owner, id);
      let profileSaveFailed = false;
      try {
        if (this.contexts.has(id) && !local?.controller && session.profileId && this.vault && session.status === 'active') {
          await this.persistProfileState(session);
        }
      } catch { profileSaveFailed = true; }
      finally { await this.driver.closeSession(id).catch(() => {}); this.contexts.delete(id); }
      const closed = await this.store.closeSession(owner, id);
      await this.event(owner, id, 'browser.session.closed', { profileSaveFailed });
      return { ...closed, profileSaveFailed };
    });
  }
  async maintain() {
    for (const [id, local] of this.contexts) {
      if (Date.now() - local.openedAt >= this.limits.ttlMs || (!local.controller && Date.now() - local.lastUsed >= this.limits.idleMs)) {
        await this.closeSession(local.owner, id).catch(() => {}); continue;
      }
      const held = await this.store.touchSession({ owner: local.owner, id, workerId: this.workerId, fence: local.fence, leaseMs: this.limits.leaseMs });
      if (!held) { local.controller?.abort(); await this.driver.closeSession(id).catch(() => {}); this.contexts.delete(id); }
    }
    await this.store.recoverExpired();
    for (const [id, binding] of this.runContexts) {
      if (Date.now() >= binding.deadline && ![...this.contexts.values()].some(local => local.runId === binding.runId && local.taskId === binding.taskId)) this.runContexts.delete(id);
    }
  }
  async hasUnresolvedRunOutcome(runId) {
    return Boolean(await this.store.hasUnknownCommandForRun?.(runId));
  }
  async close() {
    if (this.closed) return; this.closed = true; clearInterval(this.timer);
    this.stopStreams();
    await this.maintenance;
    await Promise.allSettled([...this.contexts].map(([id, local]) => this.closeSession(local.owner, id)));
    await Promise.allSettled([...this.executing.values()]);
    await this.driver.close(); this.vault?.close(); this.runContexts.clear(); await this.store.close();
  }
  stopStreams() { for (const streams of this.streams?.values() ?? []) for (const res of streams) res.end(); }
}
