import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { HarnessService } from '../service/server.mjs';

async function fixture(model) {
  const directory = mkdtempSync(join(tmpdir(), 'micro-dsh-metric-'));
  const service = new HarnessService({ database: join(directory, 'state.sqlite3'),
    authTokens: { 'metric-fixture-token': 'metric-owner' }, model });
  const address = await service.listen();
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST', key) => {
    const response = await fetch(`http://127.0.0.1:${address.port}` + path, {
      method, headers: { Authorization: 'Bearer metric-fixture-token', 'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const session = (await call('/v1/sessions', { title: 'metric fixture' })).data;
  const base = `/v1/sessions/${session.id}`;
  const run = async (body, key, expected = 'succeeded', runBase = base) => {
    const started = await call(runBase + '/runs', body, 'POST', key);
    assert.equal(started.status, 202);
    for (let i = 0; i < 150; i++) {
      const state = (await call('/v1/runs/' + started.data.run.id)).data;
      if (['succeeded', 'failed', 'partial', 'cancelled', 'timed_out'].includes(state.status)) {
        assert.equal(state.status, expected, JSON.stringify(state.result));
        return state;
      }
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error('fixture run did not finish');
  };
  return { service, call, session, base, run,
    async close() {
      await service.close();
      assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'), true);
      assert.equal(basename(directory).startsWith('micro-dsh-metric-'), true);
      rmSync(directory, { recursive: true, force: true });
    } };
}

const response = data => ({ ok: true, data, evidence: [], usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } });

test('memory metrics distinguish same-ID records by scope/version and log actual injected records', async () => {
  const prompts = [];
  const app = await fixture({ async generate(request) { prompts.push(JSON.stringify(request.messages)); return response({ text: 'done' }); } });
  try {
    await app.call(app.base + '/memory', { id: 'same-id', value: 'topic SESSION_SENTINEL' }, 'PUT');
    await app.call(app.base + '/memory?scope=account', { id: 'same-id', value: 'topic LONGTERM_SENTINEL' }, 'PUT');
    const state = await app.run({ prompt: 'topic', memoryStrategy: 'retrieval' }, 'legacy-both');
    const event = await app.service.database.latestEvent(state.id, 'run.memory_retrieved');
    assert.equal(event.requestedScope, 'both');
    assert.equal(event.scopeWasExplicit, false);
    assert.equal(event.selectedRecords.length, 2);
    assert.equal(event.injectedRecords.length, 2);
    assert.deepEqual(new Set(event.injectedRecords.map(r => r.scope)), new Set(['short_term', 'long_term']));
    assert.equal(new Set(event.injectedRecords.map(r => r.namespace)).size, 2);
    assert.ok(event.injectedRecords.every(r => r.version === 1 && /^[a-f0-9]{64}$/.test(r.contentSha256)));
    assert.ok(event.lookupMs >= 0 && event.retrievalTotalMs >= event.lookupMs);
    assert.equal(event.contextTokenCountSource, 'local_estimate_not_provider_count');
    assert.ok(prompts.at(-1).includes('SESSION_SENTINEL') && prompts.at(-1).includes('LONGTERM_SENTINEL'));
  } finally { await app.close(); }
});

test('explicit session scope excludes account lookup and rejects account memory tool calls', async () => {
  const prompts = [];
  const model = { async generate(request) {
    prompts.push(JSON.stringify(request.messages));
    return response(request.messages.at(-1).role === 'tool' ? { text: 'done' }
      : { text: '', finishReason: 'tool_call', toolCalls: [{ id: 'account-attempt', name: 'memory_search', input: { scope: 'account', query: 'topic' } }] });
  } };
  const app = await fixture(model);
  try {
    await app.call(app.base + '/memory', { id: 'session-note', value: 'topic SESSION_ONLY' }, 'PUT');
    await app.call(app.base + '/memory?scope=account', { id: 'private-long', value: 'topic LONG_MUST_NOT_APPEAR' }, 'PUT');
    const reads = [], original = app.service.database.memoryList.bind(app.service.database);
    app.service.database.memoryList = (...args) => { reads.push(args[0]); return original(...args); };
    const state = await app.run({ prompt: 'topic', memoryStrategy: 'retrieval', memoryScope: 'session' }, 'session-only');
    const event = await app.service.database.latestEvent(state.id, 'run.memory_retrieved');
    assert.equal(event.requestedScope, 'session');
    assert.ok(event.injectedRecords.every(r => r.scope === 'short_term'));
    assert.equal(reads.some(namespace => namespace.endsWith(':longterm')), false);
    assert.equal(prompts.some(prompt => prompt.includes('LONG_MUST_NOT_APPEAR')), false);
    assert.ok(prompts.some(prompt => prompt.includes('MEMORY_SCOPE_FORBIDDEN')));
  } finally { await app.close(); }
});

test('retrieved but compacted-away memory is not reported as injected', async () => {
  const prompts = [];
  const app = await fixture({ async generate(request) { prompts.push(JSON.stringify(request.messages)); return response({ text: 'done' }); } });
  try {
    await app.call(app.base + '/memory', { id: 'oversized-source-ref', value: 'topic FACT_NOT_IN_CONTEXT', sourceRefs: ['x'.repeat(9000)] }, 'PUT');
    const state = await app.run({ prompt: 'topic', memoryStrategy: 'retrieval', memoryScope: 'session' }, 'compaction');
    const event = await app.service.database.latestEvent(state.id, 'run.memory_retrieved');
    assert.equal(event.selectedRecords.length, 1);
    assert.equal(event.injectedRecords.length, 0);
    assert.deepEqual(event.injectedRecordIds, []);
    assert.equal(event.contextCharacters, 0);
    assert.equal(prompts.at(-1).includes('FACT_NOT_IN_CONTEXT'), false);
  } finally { await app.close(); }
});

test('invalid memory scope is rejected and model timing metadata survives service events', async () => {
  const timing = { streaming: true, requestStartedAtMs: 100, firstContentDeltaAtMs: 120, requestEndedAtMs: 140, ttftMs: 20 };
  const app = await fixture({ async generate() { return response({ text: 'done', timing, providerModel: 'fixture-model' }); } });
  try {
    assert.equal((await app.call(app.base + '/runs', { prompt: 'topic', memoryStrategy: 'full_history', memoryScope: 'session' }, 'POST', 'bad-scope')).status, 400);
    const state = await app.run({ prompt: 'topic', memoryStrategy: 'none' }, 'timing');
    const event = await app.service.database.latestEvent(state.id, 'model.response');
    assert.deepEqual(event.timing, timing);
    assert.equal(event.providerModel, 'fixture-model');
  } finally { await app.close(); }
});

test('account memory reaches a new session without old transcript, and deletion removes it', async () => {
  const prompts = [];
  const app = await fixture({ async generate(request) { prompts.push(JSON.stringify(request.messages)); return response({ text: 'done' }); } });
  try {
    await app.call(app.base + '/memory', { id: 'old-working-note', value: 'topic OLD_SESSION_ONLY' }, 'PUT');
    await app.call(app.base + '/memory?scope=account', { id: 'long-profile', value: 'topic PERSISTED_LONG_PROFILE' }, 'PUT');
    const next = (await app.call('/v1/sessions', { title: 'new session' })).data;
    const nextBase = `/v1/sessions/${next.id}`;
    const state = await app.run({ prompt: 'topic', memoryStrategy: 'retrieval', memoryScope: 'account' }, 'new-session', 'succeeded', nextBase);
    const event = await app.service.database.latestEvent(state.id, 'run.memory_retrieved');
    assert.equal(event.injectedRecords.length, 1);
    assert.equal(event.injectedRecords[0].scope, 'long_term');
    assert.ok(prompts.at(-1).includes('PERSISTED_LONG_PROFILE'));
    assert.equal(prompts.at(-1).includes('OLD_SESSION_ONLY'), false);
    await app.call(nextBase + '/memory?scope=account&id=long-profile', undefined, 'DELETE');
    const removed = await app.run({ prompt: 'topic', memoryStrategy: 'retrieval', memoryScope: 'account' }, 'after-delete', 'succeeded', nextBase);
    assert.equal((await app.service.database.latestEvent(removed.id, 'run.memory_retrieved')).injectedRecords.length, 0);
    assert.equal(prompts.at(-1).includes('PERSISTED_LONG_PROFILE'), false);
  } finally { await app.close(); }
});

test('other model adapters cannot inject invalid cache/reasoning usage into accounting', async () => {
  let extraUsage = {};
  const app = await fixture({ async generate() { return { ...response({ text: 'done' }),
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, ...extraUsage } }; } });
  try {
    const invalid = [
      { cacheHitInputTokens: 0.5 }, { cacheMissInputTokens: -1 },
      { cacheHitInputTokens: 15, cacheMissInputTokens: 10 }, { reasoningOutputTokens: 11 },
    ];
    for (let index = 0; index < invalid.length; index++) {
      extraUsage = invalid[index];
      const state = await app.run({ prompt: 'topic', memoryStrategy: 'none' }, `invalid-usage-${index}`, 'failed');
      assert.ok(JSON.stringify(state.result).includes('INVALID_MODEL_USAGE'));
    }
  } finally { await app.close(); }
});
