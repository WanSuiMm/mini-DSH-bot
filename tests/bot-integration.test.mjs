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

const C1_TOKENS = { 'c1-test-alice': 'alice', 'c1-test-bob': 'bob' };
const WEB_TOKENS = { 'web-test-alice': 'alice', 'web-test-bob': 'bob' };
const fixtureResponse = data => ({ ok: true, data, evidence: [], usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function presetModel({ gate } = {}) {
  const prompts = [];
  let calls = 0;
  let enterGate;
  const entered = gate ? new Promise(resolve => { enterGate = resolve; }) : undefined;
  return {
    prompts,
    entered,
    release: gate?.release,
    get calls() { return calls; },
    model: {
      executionProfile: 'cpu-integration-preset-v1',
      async generate(input) {
        calls++;
        prompts.push((input.messages ?? []).map(message => String(message.content ?? '')).join('\n'));
        if (gate) {
          enterGate();
          await gate.wait;
        }
        return fixtureResponse({ text: 'CPU integration answer' });
      },
    },
  };
}

function responseText(response) {
  return response.json();
}

async function botRequest(baseUrl, path, { token = 'web-test-alice', method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}/v1/bot${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, data: await responseText(response) };
}

async function pumpUntil(app, predicate, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await app.runtime.tick();
    if (predicate()) return;
    await pause(5);
  }
  throw new Error('integration_condition_timeout');
}

function countedClient(client, { loseFirstStartReply = false, onStart = () => {} } = {}) {
  let lose = loseFirstStartReply;
  return new Proxy(client, {
    get(target, property) {
      if (property === 'startRun') return async (...args) => {
        onStart(...args);
        const result = await target.startRun(...args);
        if (lose) {
          lose = false;
          throw Object.assign(new Error('simulated lost start response'), { code: 'harness_timeout', uncertain: true });
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function fixture(t, { model = presetModel().model, clientFactory, storeOptions = {}, releaseModel } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'micro-dsh-bot-integration-'));
  const harness = new HarnessService({
    database: join(directory, 'harness.sqlite3'),
    authTokens: C1_TOKENS,
    model,
    maxActiveRuns: 4,
    maxQueuedRuns: 20,
  });
  const harnessAddress = await harness.listen();
  const harnessUrl = `http://127.0.0.1:${harnessAddress.port}`;
  const clients = new Map(Object.entries(C1_TOKENS).map(([token, owner]) => {
    const plain = new HarnessClient({ baseUrl: harnessUrl, token });
    return [owner, clientFactory ? clientFactory(plain, owner) : plain];
  }));
  let store = new BotStore(join(directory, 'bot.sqlite3'), storeOptions);
  const storePath = join(directory, 'bot.sqlite3');
  let runtime = new BotRuntime({ store, clientForOwner: owner => clients.get(owner), maxActive: 2, intervalMs: 100 });
  let server = new BotServer({ store, runtime, authTokens: WEB_TOKENS });
  let { port } = await server.listen();
  let baseUrl = `http://127.0.0.1:${port}`;

  async function restartBotProcess() {
    await runtime.close();
    await server.close();
    store.close();
    store = new BotStore(storePath, storeOptions);
    runtime = new BotRuntime({ store, clientForOwner: owner => clients.get(owner), maxActive: 2, intervalMs: 100 });
    server = new BotServer({ store, runtime, authTokens: WEB_TOKENS });
    ({ port } = await server.listen());
    baseUrl = `http://127.0.0.1:${port}`;
  }

  t.after(async () => {
    releaseModel?.();
    await runtime.close();
    await server.close();
    store.close();
    await harness.close();
    const actual = resolve(directory);
    assert.ok(actual.startsWith(resolve(tmpdir()) + sep));
    rmSync(actual, { recursive: true, force: true });
  });
  return {
    directory, harness, harnessUrl, clients,
    get store() { return store; },
    get runtime() { return runtime; },
    get server() { return server; },
    get baseUrl() { return baseUrl; },
    restartBotProcess,
  };
}

test('real HarnessService + BotServer enforce Web auth, owner scope, duplicate inbox rules, Bot memory isolation, and Web ACK', async t => {
  const preset = presetModel();
  const app = await fixture(t, { model: preset.model });

  const page = await fetch(app.baseUrl + '/');
  const html = await page.text();
  const csp = page.headers.get('content-security-policy');
  assert.equal(page.status, 200);
  assert.match(csp, /script-src 'self'/u);
  assert.doesNotMatch(csp, /unsafe-inline/u);
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  assert.equal(scriptTags.length, 1);
  assert.match(scriptTags[0][1], /src="\/app\.mjs"/u);
  assert.equal(scriptTags[0][2].trim(), '');
  assert.equal((await fetch(app.baseUrl + '/v1/bot/bots')).status, 401);

  assert.equal((await botRequest(app.baseUrl, '/bots', { method: 'POST', body: { owner: 'bob', name: 'spoof', role: 'assistant' } })).status, 400);
  const botAResponse = await botRequest(app.baseUrl, '/bots', {
    method: 'POST', body: { name: 'Research Bot', role: 'paper-reader', instructions: 'Be precise.' },
  });
  const botBResponse = await botRequest(app.baseUrl, '/bots', {
    method: 'POST', body: { name: 'Writing Bot', role: 'editor', instructions: 'Preserve the owner’s style.' },
  });
  assert.equal(botAResponse.status, 201);
  assert.equal(botBResponse.status, 201);
  const botA = botAResponse.data, botB = botBResponse.data;
  assert.ok(botA.botId && botB.botId);
  assert.notEqual(botA.botId, botB.botId);
  assert.equal((await botRequest(app.baseUrl, `/bots/${botA.botId}`, { token: 'web-test-bob' })).status, 404);
  assert.equal((await botRequest(app.baseUrl, '/bots')).data.items.length, 2);
  assert.equal((await botRequest(app.baseUrl, '/bots', { token: 'web-test-bob' })).data.items.length, 0);

  await botRequest(app.baseUrl, `/bots/${botA.botId}/memory`, {
    method: 'PUT', body: { id: 'private-reference', value: 'ALICE_BOT_A_ONLY' },
  });
  await botRequest(app.baseUrl, `/bots/${botB.botId}/memory`, {
    method: 'PUT', body: { id: 'private-reference', value: 'ALICE_BOT_B_ONLY' },
  });
  const messageA = { botId: botA.botId, eventId: 'shared-external-event', conversationId: 'main', text: 'Question for Bot A' };
  const first = await botRequest(app.baseUrl, '/messages', { method: 'POST', body: messageA });
  const duplicate = await botRequest(app.baseUrl, '/messages', { method: 'POST', body: messageA });
  const conflict = await botRequest(app.baseUrl, '/messages', {
    method: 'POST', body: { ...messageA, text: 'Changed payload under the same event ID' },
  });
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.replayed, true);
  assert.equal(duplicate.data.job.id, first.data.job.id);
  assert.equal(conflict.status, 409);
  assert.equal((await botRequest(app.baseUrl, '/messages', {
    method: 'POST', body: { ...messageA, owner: 'bob', eventId: 'spoof-owner' },
  })).status, 400);

  const messageB = { botId: botB.botId, eventId: 'shared-external-event', conversationId: 'main', text: 'Question for Bot B' };
  const second = await botRequest(app.baseUrl, '/messages', { method: 'POST', body: messageB });
  assert.equal(second.status, 202, 'the same event ID is independent under the other Bot identity');
  assert.equal((await botRequest(app.baseUrl, `/jobs/${first.data.job.id}`, { token: 'web-test-bob' })).status, 404);

  await pumpUntil(app, () => app.store.listJobs('alice').length === 2 && app.store.listJobs('alice').every(job => job.status === 'succeeded'));
  const sessionA = app.store.getSession('alice', botA.botId, 'web', 'main');
  const sessionB = app.store.getSession('alice', botB.botId, 'web', 'main');
  assert.equal(sessionA.status, 'ready');
  assert.equal(sessionB.status, 'ready');
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);
  assert.equal(preset.prompts.length, 2);
  assert.ok(preset.prompts.some(prompt => prompt.includes('ALICE_BOT_A_ONLY') && !prompt.includes('ALICE_BOT_B_ONLY')));
  assert.ok(preset.prompts.some(prompt => prompt.includes('ALICE_BOT_B_ONLY') && !prompt.includes('ALICE_BOT_A_ONLY')));

  const outputs = (await botRequest(app.baseUrl, '/outbox')).data.items;
  assert.equal(outputs.length, 2);
  for (const output of outputs) {
    assert.equal(output.status, 'pending');
    const ack = await botRequest(app.baseUrl, `/outbox/${output.id}/ack`, {
      method: 'POST', body: { deliveryKey: output.deliveryKey },
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.data.status, 'delivered');
  }
  assert.equal(app.harness.metrics.runsStarted, 2);
});

test('restarted BotRuntime polls the saved C1 run ID without starting a second C1 run', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const preset = presetModel({ gate: { wait, release } });
  let startCalls = 0;
  const app = await fixture(t, {
    model: preset.model,
    releaseModel: preset.release,
    clientFactory: client => countedClient(client, { onStart: () => { startCalls++; } }),
  });
  const bot = (await botRequest(app.baseUrl, '/bots', {
    method: 'POST', body: { name: 'Persistent Bot', role: 'assistant' },
  })).data;
  const message = await botRequest(app.baseUrl, '/messages', {
    method: 'POST', body: { botId: bot.botId, eventId: 'restart-run', conversationId: 'main', text: 'Wait for completion.' },
  });
  await app.runtime.tick();
  await Promise.race([preset.entered, pause(3000).then(() => { throw new Error('fixture_model_not_started'); })]);
  const beforeRestart = app.store.getJob('alice', message.data.job.id);
  assert.equal(beforeRestart.status, 'running');
  assert.ok(beforeRestart.runId);
  const durableRunId = beforeRestart.runId;
  assert.equal(startCalls, 1);

  await app.restartBotProcess();
  assert.equal(app.store.getJob('alice', message.data.job.id).runId, durableRunId);
  await app.runtime.tick();
  await app.runtime.tick();
  assert.equal(startCalls, 1);

  release();
  await pumpUntil(app, () => app.store.getJob('alice', message.data.job.id).status === 'succeeded');
  assert.equal(app.store.getJob('alice', message.data.job.id).runId, durableRunId);
  assert.equal(startCalls, 1);
});

test('a lost C1 start response becomes unknown and repeated ticks never post it again', async t => {
  let startCalls = 0;
  const app = await fixture(t, {
    model: presetModel().model,
    clientFactory: client => countedClient(client, { loseFirstStartReply: true, onStart: () => { startCalls++; } }),
  });
  const bot = (await botRequest(app.baseUrl, '/bots', {
    method: 'POST', body: { name: 'Careful Bot', role: 'assistant' },
  })).data;
  const message = await botRequest(app.baseUrl, '/messages', {
    method: 'POST', body: { botId: bot.botId, eventId: 'uncertain-start', conversationId: 'main', text: 'One external start only.' },
  });
  await app.runtime.tick();
  const job = app.store.getJob('alice', message.data.job.id);
  assert.equal(job.status, 'unknown');
  assert.equal(job.runId, undefined);
  const session = app.store.getSession('alice', bot.botId, 'web', 'main');
  assert.equal(session.status, 'ready');
  for (let i = 0; i < 5; i++) await app.runtime.tick();
  assert.equal(startCalls, 1);
  assert.equal(app.store.listOutbox('alice').length, 0);
  assert.equal(app.store.listJobs('alice')[0].status, 'unknown');
  const runs = app.harness.database.sessionRuns('alice', session.sessionId);
  assert.equal(runs.length, 1, 'the uncertain request reached C1 once and was not blindly retried');
});

test('disabled schedule produces no job; enabling routes one due bucket through the actual runtime', async t => {
  const app = await fixture(t, { model: presetModel().model });
  const bot = (await botRequest(app.baseUrl, '/bots', {
    method: 'POST', body: { name: 'Routine Bot', role: 'assistant' },
  })).data;
  const originalNow = Date.now;
  let fakeNow = originalNow();
  Date.now = () => fakeNow;
  try {
    const schedule = (await botRequest(app.baseUrl, '/schedules', {
      method: 'POST', body: { botId: bot.botId, conversationId: 'routine', text: 'Summarize the day.', intervalMs: 300000 },
    })).data;
    assert.equal(schedule.enabled, false);
    fakeNow += 3600000;
    await app.runtime.tick();
    assert.equal(app.store.listJobs('alice').length, 0);

    const enabled = await botRequest(app.baseUrl, `/schedules/${schedule.scheduleId}/enabled`, {
      method: 'POST', body: { enabled: true },
    });
    assert.equal(enabled.status, 200);
    fakeNow = Date.parse(enabled.data.nextDueAt);
    await app.runtime.tick();
    assert.equal(app.store.listJobs('alice').length, 1);
    await pumpUntil(app, () => app.store.listJobs('alice')[0]?.status === 'succeeded');
    assert.match(app.store.listJobs('alice')[0].eventId, /^schedule_/u);
  } finally {
    Date.now = originalNow;
  }
});
