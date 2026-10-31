import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { HarnessService } from '../service/server.mjs';
import { BotStore } from '../service/bot/store.mjs';
import { BotRuntime } from '../service/bot/runtime.mjs';
import { BotServer } from '../service/bot/server.mjs';
import { HarnessClient } from '../service/bot/harness-client.mjs';

const C1_TOKENS = { 'recovery-test-alice': 'alice', 'recovery-test-bob': 'bob' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixtureResponse(data) {
  return { ok: true, data, evidence: [], usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } };
}

function presetModel() {
  return {
    executionProfile: 'cpu-bot-recovery-test-v1',
    async generate() { return fixtureResponse({ text: 'CPU recovery answer' }); },
  };
}

function makeStoreFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'micro-dsh-bot-recovery-'));
  const store = new BotStore(join(directory, 'bot.sqlite3'));
  t.after(() => {
    store.close();
    const actual = resolve(directory);
    assert.ok(actual.startsWith(resolve(tmpdir()) + sep));
    rmSync(actual, { recursive: true, force: true });
  });
  return { directory, store };
}

async function makeHarnessFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'micro-dsh-bot-recovery-peer-'));
  const harness = new HarnessService({
    database: join(directory, 'harness.sqlite3'),
    authTokens: C1_TOKENS,
    model: presetModel(),
    maxActiveRuns: 2,
    maxQueuedRuns: 20,
  });
  const { port } = await harness.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const alice = new HarnessClient({ baseUrl, token: 'recovery-test-alice' });
  const bob = new HarnessClient({ baseUrl, token: 'recovery-test-bob' });
  t.after(async () => {
    await harness.close();
    const actual = resolve(directory);
    assert.ok(actual.startsWith(resolve(tmpdir()) + sep));
    rmSync(actual, { recursive: true, force: true });
  });
  return { harness, alice, bob };
}

function createUnknownJob(store, { owner = 'alice', botId, conversationId, eventId, sessionId }) {
  const job = store.ingest({ owner, botId, channel: 'web', eventId, conversationId, text: `Request ${eventId}` }).job;
  assert.equal(store.reserveNext()?.id, job.id);
  assert.equal(store.beginSessionCreation(owner, botId, 'web', conversationId).status, 'starting');
  store.setSession(owner, botId, 'web', conversationId, sessionId);
  store.attachSession(job.id, sessionId);
  store.markJobUnknown(job.id, 'lost_start_response');
  return job;
}

test('Harness run lookup returns the keyed run, hides absent keys, and is owner scoped', async t => {
  const { alice, bob } = await makeHarnessFixture(t);
  const session = await alice.createSession('recovery lookup');
  const key = 'bot-recovery-lookup-job';
  const created = await alice.startRun(session.id, {
    prompt: 'Return the short test answer.',
    mode: 'single',
    memoryStrategy: 'none',
    budget: { maxTokens: 200, maxToolCalls: 1, maxDurationMs: 5000, maxActiveChildren: 1 },
  }, key);

  const found = await alice.lookupRun(session.id, key);
  assert.equal(found.found, true);
  assert.equal(found.run.id, created.run.id);
  assert.equal(found.run.session_id, session.id);
  assert.equal(found.run.idempotency_key, key);

  const absent = await alice.lookupRun(session.id, 'bot-no-such-job');
  assert.equal(absent.found, false);
  assert.ok(absent.run == null);
  await assert.rejects(bob.lookupRun(session.id, key), error => error.status === 404);
});

test('same-session reconciliation rejects a run with another Bot job idempotency key', async t => {
  const { store } = makeStoreFixture(t);
  const bot = store.createBot({ owner: 'alice', name: 'Recovery Bot', role: 'assistant' });
  const job = createUnknownJob(store, {
    botId: bot.botId,
    conversationId: 'reconcile-room',
    eventId: 'reconcile-event',
    sessionId: 'c1-session-reconcile',
  });
  const client = {
    async getRun(id) {
      return { id, owner: 'alice', session_id: 'c1-session-reconcile', idempotency_key: 'bot-a-different-job', status: 'running' };
    },
  };
  const runtime = new BotRuntime({ store, clientForOwner: () => client, maxActive: 1, intervalMs: 1000 });
  t.after(() => runtime.close());

  await assert.rejects(runtime.reconcile('alice', job.id, 'c1-run-wrong-key'));
  assert.equal(store.getJob('alice', job.id).status, 'unknown');
  assert.equal(store.getJob('alice', job.id).runId, undefined);
});

test('unknown resolution reattaches a found run and never starts another run', async t => {
  const { store } = makeStoreFixture(t);
  const bot = store.createBot({ owner: 'alice', name: 'Recovery Bot', role: 'assistant' });
  const job = createUnknownJob(store, {
    botId: bot.botId,
    conversationId: 'found-room',
    eventId: 'found-event',
    sessionId: 'c1-session-found',
  });
  const lookups = [];
  let starts = 0;
  const key = `bot-${job.id}`;
  const client = {
    async lookupRun(sessionId, requestKey) {
      lookups.push({ sessionId, requestKey });
      return { found: true, run: { id: 'c1-run-existing', session_id: sessionId, idempotency_key: requestKey } };
    },
    async getRun(id) { return { id, owner: 'alice', session_id: 'c1-session-found', idempotency_key: key, status: 'running' }; },
    async startRun() { starts++; throw new Error('unexpected_model_start'); },
  };
  const runtime = new BotRuntime({ store, clientForOwner: () => client, maxActive: 1, intervalMs: 1000 });
  t.after(() => runtime.close());

  const resolved = await runtime.resolveUnknown('alice', job.id);
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0], { sessionId: 'c1-session-found', requestKey: key });
  assert.equal(resolved.status, 'running');
  assert.equal(resolved.runId, 'c1-run-existing');
  await runtime.tick();
  assert.equal(starts, 0);
});

test('unknown resolution requeues only after an absent-key lookup and retry keeps the same key', async t => {
  const { store } = makeStoreFixture(t);
  const bot = store.createBot({ owner: 'alice', name: 'Recovery Bot', role: 'assistant' });
  const job = createUnknownJob(store, {
    botId: bot.botId,
    conversationId: 'absent-room',
    eventId: 'absent-event',
    sessionId: 'c1-session-absent',
  });
  const keys = [];
  const client = {
    async lookupRun(sessionId, requestKey) {
      assert.equal(sessionId, 'c1-session-absent');
      assert.equal(requestKey, `bot-${job.id}`);
      return { found: false, run: null };
    },
    async startRun(sessionId, input, requestKey) {
      keys.push(requestKey);
      return { run: { id: 'c1-run-after-verified-absence', owner: 'alice', session_id: sessionId, idempotency_key: requestKey } };
    },
    async getRun(id) { return { id, owner: 'alice', session_id: 'c1-session-absent', idempotency_key: `bot-${job.id}`, status: 'running' }; },
  };
  const runtime = new BotRuntime({ store, clientForOwner: () => client, maxActive: 1, intervalMs: 1000 });
  t.after(() => runtime.close());
  const server = new BotServer({ store, runtime, authTokens: { 'web-recovery-alice': 'alice' } });
  const { port } = await server.listen();
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/v1/bot/jobs/${job.id}/resolve`, {
    method: 'POST',
    headers: { authorization: 'Bearer web-recovery-alice', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const queued = await response.json();
  assert.equal(queued.status, 'queued');
  assert.equal(store.getJob('alice', job.id).runId, undefined);
  await runtime.tick();
  assert.deepEqual(keys, [`bot-${job.id}`]);
  assert.equal(store.getJob('alice', job.id).runId, 'c1-run-after-verified-absence');
  await runtime.tick();
  assert.deepEqual(keys, [`bot-${job.id}`]);
});

test('round-robin polling reaches older running jobs after maxActive is lowered', async t => {
  const { store } = makeStoreFixture(t);
  const bot = store.createBot({ owner: 'alice', name: 'Polling Bot', role: 'assistant' });
  const expectedRuns = [];
  for (let index = 0; index < 3; index++) {
    const conversationId = `poll-room-${index}`;
    const job = store.ingest({ owner: 'alice', botId: bot.botId, channel: 'web',
      eventId: `poll-event-${index}`, conversationId, text: `Poll request ${index}` }).job;
    assert.equal(store.reserveNext()?.id, job.id);
    store.beginSessionCreation('alice', bot.botId, 'web', conversationId);
    const sessionId = `c1-session-poll-${index}`;
    store.setSession('alice', bot.botId, 'web', conversationId, sessionId);
    store.attachSession(job.id, sessionId);
    const runId = `c1-run-poll-${index}`;
    store.attachRun(job.id, runId);
    expectedRuns.push({ runId, sessionId, jobId: job.id });
  }

  const polled = [];
  let starts = 0;
  const client = {
    async getRun(id) {
      polled.push(id);
      const expected = expectedRuns.find(run => run.runId === id);
      return { id, owner: 'alice', session_id: expected.sessionId,
        idempotency_key: `bot-${expected.jobId}`, status: 'running' };
    },
    async startRun() { starts++; throw new Error('unexpected_new_start'); },
  };
  const runtime = new BotRuntime({ store, clientForOwner: () => client, maxActive: 1, intervalMs: 1000 });
  t.after(() => runtime.close());

  for (let tick = 0; tick < 3; tick++) await runtime.tick();
  assert.deepEqual([...new Set(polled)].sort(), expectedRuns.map(run => run.runId).sort());
  assert.equal(polled.length, 3);
  assert.equal(starts, 0);
});
