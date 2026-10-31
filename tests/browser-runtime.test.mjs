import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../service/browser/runtime.mjs';
import { serveBrowserUi } from '../service/browser/ui-assets.mjs';

// Prepared for server-side software verification; no real browser or model is used.
function fixture({ active = true, execute, request = { type: 'click', ref: 'ref-a' } } = {}) {
  let calls = 0;
  const session = { id: 'browser-a', owner: 'alice', harnessSessionId: 'session-a', runId: 'run-a', taskId: 'task-a', status: 'active', fence: 1 };
  const command = { id: 'command-a', sessionId: session.id, request, requestHash: 'a'.repeat(64), status: 'pending_approval', requiresApproval: true };
  const store = {
    getSession: async (owner, id) => owner === session.owner && id === session.id ? session : undefined,
    touchSession: async () => true,
    getCommand: async () => ({ ...command }),
    approveCommand: async ({ decision }) => { command.approvalDecision = decision; command.status = decision === 'approve' ? 'ready' : 'rejected'; return { ...command }; },
    nextReadyCommand: async () => command.status === 'ready' ? { ...command } : undefined,
    beginCommand: async () => { if (command.status !== 'ready') return undefined; command.status = 'running'; return { ...command }; },
    finishCommand: async ({ status, result }) => { command.status = status; command.result = result; return { ...command }; },
    appendEvent: async event => event,
    transitionSession: async ({ status }) => { session.status = status; return session; },
  };
  const driver = { execute: async (...args) => { calls++; return execute ? execute(...args) : { ok: true, networkOutcome: 'unknown' }; }, closeSession: async () => {} };
  const runtime = new BrowserRuntime({ store, driver });
  session.workerId = runtime.workerId;
  runtime.contexts.set(session.id, { owner: session.owner, runId: session.runId, taskId: session.taskId, fence: 1, lastUsed: Date.now(), openedAt: Date.now() });
  runtime.setRunAuthorizer(async () => active);
  const controller = new AbortController();
  const context = { sessionId: 'session-a', runId: 'run-a', taskId: 'task-a', signal: controller.signal, budget: { deadlineAt: new Date(Date.now() + 5000).toISOString() } };
  runtime.bindRunContext({ owner: 'alice', sessionId: 'session-a', runId: 'run-a' }, context);
  return { runtime, session, command, context, controller, calls: () => calls };
}

function openFixture({ maxSessions = 1, openGate } = {}) {
  const sessions = new Map(); const opened = []; const closed = []; const submissions = [];
  const store = {
    createSession: async fields => {
      const prior = sessions.get(fields.id);
      if (prior) return { session: prior, replayed: true };
      const active = [...sessions.values()].filter(item => ['creating', 'active', 'paused'].includes(item.status));
      if (active.length >= fields.maxSessions) throw Object.assign(new Error('quota full'), { status: 429, code: 'BROWSER_SESSION_CAPACITY_FULL' });
      const session = { ...fields, fence: 1, status: 'creating' }; sessions.set(fields.id, session);
      return { session, replayed: false };
    },
    getSession: async (owner, id) => { const session = sessions.get(id); return session?.owner === owner ? session : undefined; },
    touchSession: async () => true,
    transitionSession: async ({ id, status }) => { sessions.get(id).status = status; return sessions.get(id); },
    closeSession: async (owner, id) => { const session = sessions.get(id); session.status = 'closed'; return session; },
    appendEvent: async event => event,
  };
  const driver = {
    validateUrl: async () => ({ ok: true }),
    open: async ({ id }) => { opened.push(id); await openGate?.(); },
    execute: async () => ({ ok: true }),
    closeSession: async id => { closed.push(id); },
    close: async () => {},
  };
  const runtime = new BrowserRuntime({ store, driver, maxSessions, maxOwnerSessions: maxSessions });
  runtime.submit = async (owner, sessionId, request, idempotencyKey) => {
    submissions.push({ owner, sessionId, request, idempotencyKey });
    return { id: `command-${sessionId}`, sessionId, status: 'pending_approval', executed: false, replayed: submissions.length > 1 };
  };
  return { runtime, sessions, opened, closed, submissions };
}

test('human approval lets the waiting original task receive the actual command result', async () => {
  const f = fixture();
  const waiting = f.runtime.waitForCommand('alice', f.command.id, f.context);
  assert.equal(f.calls(), 0);
  await f.runtime.decide('alice', f.command.id, 'approve', f.command.requestHash);
  const result = await waiting;
  assert.equal(result.status, 'succeeded'); assert.equal(result.executed, true);
  assert.equal(result.result.networkOutcome, 'unknown'); assert.equal(f.calls(), 1);
});

test('an ended parent task cannot approve an orphaned browser action', async () => {
  const f = fixture({ active: false });
  await assert.rejects(f.runtime.decide('alice', f.command.id, 'approve', f.command.requestHash), { code: 'BROWSER_RUN_NOT_ACTIVE' });
  assert.equal(f.command.status, 'pending_approval'); assert.equal(f.calls(), 0);
});

test('cancelling one worker does not replace another worker signal in the same run', async () => {
  const f = fixture(); const other = new AbortController();
  f.runtime.bindRunContext({ owner: 'alice', sessionId: 'session-a', runId: 'run-a' }, { ...f.context, taskId: 'task-b', signal: other.signal });
  f.controller.abort();
  assert.equal(await f.runtime.runIsActive('alice', 'run-a', 'task-a'), false);
  assert.equal(await f.runtime.runIsActive('alice', 'run-a', 'task-b'), true);
});

test('open call identity is stable for replays, while a new call opens after a terminal session without using quota', async () => {
  let releaseOpen;
  let gateUsed = false;
  const openGate = () => {
    if (gateUsed) return Promise.resolve();
    gateUsed = true;
    return new Promise(resolve => { releaseOpen = resolve; });
  };
  const f = openFixture({ maxSessions: 1, openGate });
  const input = { owner: 'alice', sessionId: 'harness-a', runId: 'run-a', taskId: 'task-a', url: 'https://trusted.example/', openKey: 'tool-call-a' };
  const firstPromise = f.runtime.open(input);
  const limit = Date.now() + 1000;
  while (!releaseOpen) {
    if (Date.now() >= limit) throw new Error('initial browser context did not start');
    await new Promise(resolve => setImmediate(resolve));
  }
  const replayPromise = f.runtime.open(input);
  releaseOpen();
  const [first, concurrentReplay] = await Promise.all([firstPromise, replayPromise]);
  assert.equal(concurrentReplay.session.id, first.session.id);
  assert.equal(concurrentReplay.replayed, true);
  assert.equal(f.opened.length, 1);

  const replay = await f.runtime.open(input);
  assert.equal(replay.session.id, first.session.id);
  assert.equal(replay.replayed, true);
  assert.equal(f.opened.length, 1);

  await f.runtime.closeSession('alice', first.session.id);
  await assert.rejects(f.runtime.open(input), { code: 'BROWSER_SESSION_REQUIRES_REOPEN' });
  assert.equal(f.opened.length, 1);

  const next = await f.runtime.open({ ...input, openKey: 'tool-call-b' });
  assert.notEqual(next.session.id, first.session.id);
  assert.equal(f.opened.length, 2);
  assert.equal([...f.sessions.values()].filter(session => ['creating', 'active', 'paused'].includes(session.status)).length, 1);
});

test('legacy browser UI opens without an open key retain their replay identity', async () => {
  const f = openFixture();
  const input = { owner: 'alice', sessionId: 'harness-a', runId: 'run-a', taskId: 'task-a', url: 'https://trusted.example/' };
  const first = await f.runtime.open(input); const replay = await f.runtime.open(input);
  assert.equal(replay.session.id, first.session.id);
  assert.equal(replay.replayed, true);
  assert.equal(f.opened.length, 1);
});

test('a navigation timeout after dispatch remains unknown and preserves driver details', async () => {
  const f = fixture({ request: { type: 'navigate', url: 'https://trusted.example/' }, execute: async () => ({
    ok: false, error: { code: 'TIMEOUT' }, sideEffectStarted: true, contextClosed: true,
  }) });
  await f.runtime.decide('alice', f.command.id, 'approve', f.command.requestHash);
  await f.runtime.executing.get(f.session.id);
  assert.equal(f.command.status, 'unknown');
  assert.equal(f.command.result.code, 'BROWSER_ACTION_OUTCOME_UNKNOWN');
  assert.equal(f.command.result.outcome, 'unknown');
  assert.equal(f.command.result.requiresHumanReconciliation, true);
  assert.deepEqual(f.command.result.driverError, { code: 'TIMEOUT' });
  assert.equal(f.command.result.sideEffectStarted, true);
  assert.equal(f.command.result.contextClosed, true);
  assert.equal(f.session.status, 'lost');
  assert.equal(f.runtime.contexts.size, 0);
  assert.equal(f.calls(), 1);
});

test('a distinct open key can create a new context after the prior session is lost', async () => {
  const f = openFixture({ maxSessions: 1 });
  const input = { owner: 'alice', sessionId: 'harness-a', runId: 'run-a', taskId: 'task-a', url: 'https://trusted.example/' };
  const first = await f.runtime.open({ ...input, openKey: 'tool-call-a' });
  await f.runtime.store.transitionSession({ id: first.session.id, status: 'lost' });
  f.runtime.contexts.delete(first.session.id);
  await assert.rejects(f.runtime.open({ ...input, openKey: 'tool-call-a' }), { code: 'BROWSER_SESSION_REQUIRES_REOPEN' });

  const next = await f.runtime.open({ ...input, openKey: 'tool-call-b' });
  assert.notEqual(next.session.id, first.session.id);
  assert.equal(f.opened.length, 2);
  assert.equal([...f.sessions.values()].filter(session => ['creating', 'active', 'paused'].includes(session.status)).length, 1);
});

test('a rejected driver result with no started side effect stays failed and preserves its details', async () => {
  const f = fixture({ execute: async () => ({
    ok: false, error: { code: 'STALE_REF' }, sideEffectStarted: false, contextClosed: false,
  }) });
  await f.runtime.decide('alice', f.command.id, 'approve', f.command.requestHash);
  await f.runtime.executing.get(f.session.id);
  assert.equal(f.command.status, 'failed');
  assert.equal(f.command.result.code, 'STALE_REF');
  assert.equal(f.command.result.outcome, 'failed');
  assert.deepEqual(f.command.result.driverError, { code: 'STALE_REF' });
  assert.equal(f.command.result.sideEffectStarted, false);
  assert.equal(f.command.result.contextClosed, false);
  assert.equal(f.calls(), 1);
});

test('a timed-out write action remains unknown even when its context closed', async () => {
  const f = fixture({ execute: async () => ({
    ok: false, error: { code: 'TIMEOUT' }, sideEffectStarted: true, contextClosed: true,
  }) });
  await f.runtime.decide('alice', f.command.id, 'approve', f.command.requestHash);
  await f.runtime.executing.get(f.session.id);
  assert.equal(f.command.status, 'unknown');
  assert.equal(f.command.result.code, 'BROWSER_ACTION_OUTCOME_UNKNOWN');
  assert.equal(f.command.result.driverError.code, 'TIMEOUT');
  assert.equal(f.command.result.sideEffectStarted, true);
  assert.equal(f.command.result.contextClosed, true);
  assert.equal(f.calls(), 1);
});

test('an interrupted dispatched action is retained as unknown and not retried', { timeout: 5000 }, async () => {
  const f = fixture({ execute: async (_id, _request, { signal }) => new Promise(resolve => {
    const done = () => resolve({ ok: false, error: { code: 'CANCELLED' }, sideEffectStarted: true, contextClosed: true });
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  }) });
  await f.runtime.decide('alice', f.command.id, 'approve', f.command.requestHash);
  const limit = Date.now() + 4000;
  while (f.command.status !== 'running' || f.calls() === 0) {
    if (Date.now() >= limit) throw new Error('command did not start');
    await new Promise(resolve => setImmediate(resolve));
  }
  const running = f.runtime.executing.get(f.session.id); f.controller.abort(); await running;
  assert.equal(f.command.status, 'unknown'); assert.equal(f.calls(), 1);
  assert.deepEqual(f.command.result.driverError, { code: 'CANCELLED' });
  assert.equal(f.command.result.sideEffectStarted, true);
  assert.equal(f.command.result.contextClosed, true);
  assert.equal(f.command.result.outcome, 'unknown');
  assert.equal(f.session.status, 'lost'); assert.equal(f.runtime.contexts.size, 0);
  await f.runtime.decide('alice', f.command.id, 'approve', f.command.requestHash);
  assert.equal(f.calls(), 1);
});

test('public UI assets reject non-asset paths and encoded traversal', async () => {
  for (const path of ['/browser/assets/%2e%2e%2fsecret.js', '/browser/package.json', '/browser/assets/test.js/extra']) {
    let status;
    const res = { writeHead: value => { status = value; }, end() {} };
    assert.equal(await serveBrowserUi({ method: 'GET' }, res, new URL(path, 'https://workspace.invalid')), true);
    assert.equal(status, 404);
  }
});
