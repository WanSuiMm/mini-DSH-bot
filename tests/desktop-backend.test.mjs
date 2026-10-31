import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ServiceDatabase } from '../service/database.mjs';
import { createBrowserToolGuard } from '../service/browser/provider.mjs';
import { createExecutionGuard } from '../service/security/guard.mjs';
import { createDesktopBackend } from '../desktop/backend.mjs';
import { DesktopTaskJournal, SQLiteBrowserStore } from '../desktop/task-journal.mjs';

async function withDatabase(fn) {
  const root = await mkdtemp(join(tmpdir(), 'micro-dsh-desktop-test-'));
  let database;
  try {
    database = new ServiceDatabase(join(root, 'desktop-agent.sqlite3'));
    return await fn({ root, database });
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('desktop task metadata and original run key survive reopening the shared SQLite database', async () => {
  await withDatabase(async ({ root, database }) => {
    const journal = new DesktopTaskJournal(database);
    await journal.ready();
    const tabId = 'tab-a';
    const harnessSessionId = randomUUID();
    journal.ensureTab(tabId, harnessSessionId, 'Research tab');
    const task = journal.createTask({ id: randomUUID(), tabId, harnessSessionId,
      prompt: 'Read the public page', url: 'https://example.test/', allowedOrigins: ['https://example.test'],
      idempotencyKey: 'desktop-task-original-key', status: 'interrupted' });
    const reopened = new ServiceDatabase(join(root, 'desktop-agent.sqlite3'));
    try {
      const restored = new DesktopTaskJournal(reopened);
      await restored.ready();
      assert.equal(restored.getTask(task.id).idempotencyKey, 'desktop-task-original-key');
      assert.equal(restored.getTab(tabId).harnessSessionId, harnessSessionId);
      assert.equal(restored.getTask(task.id).status, 'interrupted');
    } finally { reopened.close(); }
  });
});

test('SQLite browser store rejects undispatched approvals at takeover and records uncertain running commands', async () => {
  await withDatabase(async ({ database }) => {
    const store = new SQLiteBrowserStore(database);
    await store.ready();
    const owner = 'desktop-local-agent';
    const sessionId = 'browser-session-a';
    const runId = 'run-a';
    const workerId = 'worker-a';
    await store.createSession({ id: sessionId, owner, harnessSessionId: 'harness-a', runId,
      taskId: 'run-a:main', workerId, leaseMs: 60_000, ttlMs: 60_000 });
    await store.transitionSession({ owner, id: sessionId, workerId, fence: 1, status: 'active' });

    const hash = request => createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const approvalRequest = { type: 'click', ref: 'ref-a' };
    const approval = await store.enqueueCommand({ id: 'approval-a', owner, sessionId,
      idempotencyKey: 'approval-key', requestHash: hash(approvalRequest), request: approvalRequest,
      requiresApproval: true });
    assert.equal(approval.command.status, 'pending_approval');
    assert.equal(await store.rejectUndispatchedForRun(owner, runId, 'BROWSER_MANUAL_TAKEOVER'), 1);
    const rejected = await store.getCommand(owner, 'approval-a');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.approvalDecision, 'reject');

    const readRequest = { type: 'observe' };
    await store.enqueueCommand({ id: 'running-a', owner, sessionId, idempotencyKey: 'read-key',
      requestHash: hash(readRequest), request: readRequest, requiresApproval: false });
    const started = await store.beginCommand({ owner, id: 'running-a', sessionId, workerId, fence: 1 });
    assert.equal(started.status, 'running');
    await store.markRunningUnknown(owner, sessionId);
    assert.equal(await store.hasUnknownCommandForRun(runId), true);
    assert.equal((await store.getCommand(owner, 'running-a')).status, 'unknown');
  });
});

test('desktop browser admission uses the journaled BrowserRuntime guard rule', async () => {
  const guard = createBrowserToolGuard(createExecutionGuard({ workspaceRoot: process.cwd() }));
  const policy = { effect: 'network', source: 'browser-runtime', admission: 'journaled-v1' };
  const allowed = await guard.evaluate({ name: 'browser_action', context: {}, options: { policy } });
  assert.equal(allowed.action, 'allow');
  assert.equal(allowed.ruleId, 'BROWSER_RUNTIME_ADMISSION');
  const cancelled = await guard.evaluate({ name: 'browser_action', context: { signal: AbortSignal.abort() }, options: { policy } });
  assert.equal(cancelled.action, 'deny');
});

test('desktop configuration keeps the real HarnessService in-process and admits browser tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'micro-dsh-desktop-backend-'));
  const driver = {
    validateUrl: async () => ({ ok: true }), open: async () => ({ ok: true }),
    execute: async () => ({ ok: true }), closeSession: async () => {},
    preview: async () => ({ ok: true }), close: async () => {},
  };
  const backend = await createDesktopBackend({ stateRoot: root, driver,
    modelFactory: () => ({ executionProfile: 'fixture-model', async generate() { throw new Error('not called'); } }) });
  try {
    await backend.ready();
    const state = await backend.configure({ baseUrl: 'http://localhost/v1', model: 'fixture', apiKey: 'ephemeral-fixture-key' });
    assert.equal(state.model, 'fixture');
    assert.equal(JSON.stringify(state).includes('ephemeral-fixture-key'), false);
    assert.equal(backend.service.server.listening, false);
    assert.ok(backend.service.extraToolNames.includes('browser_action'));
    const admitted = await backend.service.executionGuard.evaluate({ name: 'browser_action',
      context: { signal: new AbortController().signal },
      options: { policy: { effect: 'network', source: 'browser-runtime', admission: 'journaled-v1' } } });
    assert.equal(admitted.action, 'allow');
  } finally {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('safe desktop work stays dormant across restart until explicit recovery reuses its original key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'micro-dsh-desktop-recovery-'));
  let modelCalls = 0;
  const makeDriver = () => ({
    validateUrl: async () => ({ ok: true }), open: async () => ({ ok: true }),
    execute: async () => ({ ok: true }), closeSession: async () => {},
    preview: async () => ({ ok: true }), close: async () => {},
  });
  const modelFactory = () => ({ executionProfile: 'restart-fixture', async generate() {
    modelCalls++;
    throw new Error('fixture model stop');
  } });
  let backend = await createDesktopBackend({ stateRoot: root, driver: makeDriver(), modelFactory });
  const taskId = randomUUID();
  const tabId = 'tab-restart';
  const idempotencyKey = 'desktop-task-original-recovery-key';
  try {
    await backend.ready();
    await backend.configure({ baseUrl: 'http://localhost/v1', model: 'fixture' });
    const tab = await backend.bindTab(tabId, { title: 'Restart recovery', allowedOrigins: ['https://example.test'] });
    const request = { prompt: 'Read the public page', mode: 'single', budget: { maxTokens: 1024,
      maxToolCalls: 4, maxDurationMs: 30_000, maxActiveChildren: 1, maxDelegationDepth: 1 },
      toolset: 'browser', executionProfile: backend.service.executionProfile, memoryStrategy: 'none' };
    const created = backend.serviceDatabase.createRun(backend.owner, tab.harnessSessionId, idempotencyKey, request);
    backend.taskJournal.createTask({ id: taskId, tabId, harnessSessionId: tab.harnessSessionId, runId: created.run.id,
      prompt: 'Read the public page', url: 'https://example.test/', allowedOrigins: ['https://example.test'],
      idempotencyKey, status: 'queued' });
    await backend.close();
    assert.equal(modelCalls, 0);

    backend = await createDesktopBackend({ stateRoot: root, driver: makeDriver(), modelFactory });
    await backend.ready();
    let state = await backend.configure({ baseUrl: 'http://localhost/v1', model: 'fixture' });
    let restored = state.tasks.find(task => task.id === taskId);
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.recoverable, true);
    assert.equal(modelCalls, 0, 'configuration must not restart an interrupted model call');

    await backend.recover(tabId, taskId);
    await backend.service.schedule();
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = backend.serviceDatabase.getRun(backend.owner, restored.runId);
      if (['succeeded', 'partial', 'failed', 'cancelled', 'timed_out'].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(modelCalls, 1, 'an explicit recovery may invoke the configured fixture model once');
    assert.equal(backend.taskJournal.getTask(taskId).idempotencyKey, idempotencyKey);
  } finally {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});
