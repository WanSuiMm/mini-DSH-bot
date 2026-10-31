import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeDeepSeekHarnessToolCalls } from '../dist/adapters/deepseek-harness-tool-calls.js';
import { AgentLoop } from '../dist/core/agent-loop.js';
import { ToolRegistry } from '../dist/tools/registry.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('ported upstream scheduler uses rolling parallel pools, barriers, and model-order results', async () => {
  const calls = [
    { id: 'search-slow', name: 'catalog_search_products', mode: 'parallel', delay: 30 },
    { id: 'search-fast', name: 'catalog_search_products', mode: 'parallel', delay: 2 },
    { id: 'compare', name: 'catalog_compare_products', mode: 'exclusive', delay: 1 },
    { id: 'details', name: 'catalog_get_product', mode: 'parallel', delay: 1 },
  ];
  const events = [];
  let active = 0;
  let peak = 0;
  const result = await executeDeepSeekHarnessToolCalls({
    calls, signal: new AbortController().signal, maxParallelToolCalls: 2,
    executionMode: call => call.mode,
    async execute(call) {
      events.push(`start:${call.id}`); active += 1; peak = Math.max(peak, active);
      await pause(call.delay); active -= 1; events.push(`end:${call.id}`);
      return call.id;
    },
    skippedResult: () => 'skipped',
  });
  assert.equal(peak, 2);
  assert.ok(events.indexOf('start:search-fast') < events.indexOf('end:search-slow'));
  assert.ok(events.indexOf('start:compare') > events.indexOf('end:search-slow'));
  assert.deepEqual(result.results, calls.map(call => call.id));
  assert.equal(result.started, 4);
  assert.equal(result.aborted, false);
});

test('ported upstream scheduler drains started calls and creates ordered synthetic results after abort', async () => {
  const controller = new AbortController();
  let started = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = ['first', 'second', 'third'].map(id => ({ id, mode: 'parallel' }));
  const running = executeDeepSeekHarnessToolCalls({
    calls, signal: controller.signal, maxParallelToolCalls: 2,
    executionMode: call => call.mode,
    async execute(call) { started += 1; await gate; return `done:${call.id}`; },
    skippedResult: call => `aborted:${call.id}`,
  });
  while (started < 2) await pause(0);
  controller.abort();
  let settled = false;
  running.then(() => { settled = true; });
  await pause(10);
  assert.equal(settled, false, 'already-dispatched work must drain before cancellation returns');
  release();
  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.started, 2);
  assert.deepEqual(result.results, ['done:first', 'done:second', 'aborted:third']);
});

test('ported upstream scheduler stops replenishing and drains siblings on an internal dispatch failure', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const failure = new Error('scheduler dispatch failed');
  const running = executeDeepSeekHarnessToolCalls({
    calls: ['failed', 'drain', 'must-not-start'].map(id => ({ id, mode: 'parallel' })),
    signal: new AbortController().signal, maxParallelToolCalls: 2,
    executionMode: call => call.mode,
    execute(call) {
      started.push(call.id);
      if (call.id === 'failed') return Promise.reject(failure);
      return gate.then(() => call.id);
    },
    skippedResult: call => `aborted:${call.id}`,
  });
  let settled = false;
  running.catch(() => { settled = true; });
  await pause(10);
  assert.deepEqual(started, ['failed', 'drain']);
  assert.equal(settled, false, 'the started sibling must drain before the scheduler error surfaces');
  release();
  await assert.rejects(running, error => error === failure);
});

test('production AgentLoop uses the imported scheduler and clamps output to configured provider context', async () => {
  const task = { sessionId: 's', taskId: 't', runId: 'r', attempt: 1, title: 'context test', instructions: 'Answer.',
    dependencies: [], contextRefs: [], allowedTools: [], budget: { maxTokens: 5000 } };
  const context = { sessionId: 's', agentId: 'a', taskId: 't', runId: 'r', attempt: 1,
    allowedTools: [], contextRefs: [], budget: { maxTokens: 5000 } };
  let requestedOutput;
  const model = { async generate(request) {
    requestedOutput = request.maxOutputTokens;
    return { ok: true, data: { text: 'done', finishReason: 'stop' }, evidence: [] };
  } };
  const result = await new AgentLoop(model, new ToolRegistry(), { maxOutputTokens: 1024, maxContextTokens: 8192 }).run(task, context);
  assert.equal(result.ok, true);
  assert.ok(requestedOutput <= 1024);

  const tooSmall = await new AgentLoop(model, new ToolRegistry(), { maxContextTokens: 2 }).run(task, context);
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.error.code, 'CONTEXT_WINDOW_EXCEEDED');
});

test('exact tokenizer preflight caps completion tokens and blocks generation when counting fails', async () => {
  const task = { sessionId: 's', taskId: 't', runId: 'r', attempt: 1, title: 'exact context test', instructions: 'Answer.',
    dependencies: [], contextRefs: [], allowedTools: [], budget: { maxTokens: 12_000 } };
  const context = { sessionId: 's', agentId: 'a', taskId: 't', runId: 'r', attempt: 1,
    allowedTools: [], contextRefs: [], budget: { maxTokens: 12_000 } };
  let requestedOutput;
  const measured = {
    async countTokens() { return { ok: true, data: { inputTokens: 8000, maxContextTokens: 8192 }, evidence: [] }; },
    async generate(request) { requestedOutput = request.maxOutputTokens; return { ok: true, data: { text: 'done' }, evidence: [] }; },
  };
  const completed = await new AgentLoop(measured, new ToolRegistry(), { maxOutputTokens: 1024, maxContextTokens: 8192 }).run(task, context);
  assert.equal(completed.ok, true);
  assert.equal(requestedOutput, 192, 'completion budget must use provider-measured input tokens and context length');

  let generationCalls = 0;
  const unavailable = {
    async countTokens() { return { ok: false, error: { code: 'TOKEN_COUNT_HTTP', message: 'unavailable' }, evidence: [] }; },
    async generate() { generationCalls++; return { ok: true, data: { text: 'must not run' }, evidence: [] }; },
  };
  const blocked = await new AgentLoop(unavailable, new ToolRegistry(), { maxContextTokens: 8192 }).run(task, context);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'TOKEN_COUNT_UNAVAILABLE');
  assert.equal(generationCalls, 0, 'configured exact-token preflight failures must fail closed');
});
