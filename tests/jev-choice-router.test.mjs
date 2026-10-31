import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevChoiceRouter } from '../dist/multi_agent/jev-choice-router.js';

const candidates = [
  { id: 'single', description: 'One host-configured AgentLoop.', value: { mode: 'single', internal: 'never-send-this' } },
  { id: 'multi', description: 'Existing bounded planner and Supervisor, same tools.', value: { mode: 'multi' } },
];

function choiceResponse(choice = 'single', { confidence = 0.9, model = 'jev-1.14.0', usage = { input_tokens: 120, output_tokens: 12 }, headers = {} } = {}) {
  return new Response(JSON.stringify({
    model,
    answers: { route: { type: 'choice', choice, probabilities: { single: 0.8, multi: 0.2 }, confidence } },
    usage,
  }), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

function makeRouter(fetchImpl, options = {}) {
  return new JevChoiceRouter({ apiKey: 'fixture-secret', model: 'jev-latest', minConfidence: 0.6,
    timeoutMs: 100, fetchImpl, ...options });
}

function input(overrides = {}) {
  return { enabled: true, state: { request: 'Compare two technical sources', allowedTools: ['search'] },
    candidates, fallbackId: 'single', ...overrides };
}

test('sends one official Choice request with only host-authored candidates and returns typed receipt', async () => {
  let request;
  const router = makeRouter(async (url, init) => {
    request = { url, init };
    return choiceResponse('multi', { headers: { 'X-Request-Id': 'req-123', 'X-System-One-Credits': '4' } });
  });
  const result = await router.choose(input({ idempotencyKey: 'run-123:auto-mode' }));
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer fixture-secret');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(request.init.headers['Idempotency-Key'], 'run-123:auto-mode');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, { request: 'Compare two technical sources', allowedTools: ['search'] });
  assert.equal(body.questions.route.type, 'choice');
  assert.deepEqual(body.questions.route.criteria, {
    single: 'One host-configured AgentLoop.',
    multi: 'Existing bounded planner and Supervisor, same tools.',
  });
  assert.equal(request.init.body.includes('never-send-this'), false, 'host execution values are never sent');
  assert.equal(result.candidate.value.mode, 'multi');
  assert.equal(result.receipt.status, 'selected');
  assert.equal(result.receipt.confidence, 0.9);
  assert.deepEqual(result.receipt.usage, { inputTokens: 120, outputTokens: 12 });
  assert.equal(result.receipt.credits, 4);
  assert.equal(result.receipt.requestId, 'req-123');
});

test('host rule and a narrowed one-candidate policy bypass network routing', async () => {
  let calls = 0;
  const router = makeRouter(async () => { calls++; return choiceResponse(); });
  const ruled = await router.choose(input({ hostRule: () => 'multi' }));
  assert.equal(ruled.candidate.value.mode, 'multi');
  assert.equal(ruled.receipt.source, 'host_rule');
  assert.equal(ruled.receipt.status, 'bypassed');
  const narrowed = await router.choose(input({ candidates: [candidates[0]] }));
  assert.equal(narrowed.candidate.value.mode, 'single');
  assert.equal(narrowed.receipt.reason, 'fewer_than_two_host_candidates');
  assert.equal(calls, 0);
});

test('low confidence and unknown choices deterministically return the host fallback', async () => {
  const low = await makeRouter(async () => choiceResponse('multi', { confidence: 0.59 })).choose(input());
  assert.equal(low.candidate.value.mode, 'single');
  assert.equal(low.receipt.reason, 'low_confidence');
  assert.equal(low.receipt.usage.inputTokens, 120);

  const unknown = await makeRouter(async () => choiceResponse('browser')).choose(input());
  assert.equal(unknown.candidate.value.mode, 'single');
  assert.equal(unknown.receipt.reason, 'invalid_or_unknown_choice');
});

test('synchronous transport errors fall back without exposing error details', async () => {
  const result = await makeRouter(() => { throw new Error('fixture transport detail'); }).choose(input());
  assert.equal(result.candidate.value.mode, 'single');
  assert.equal(result.receipt.reason, 'transport_error');
  assert.equal(JSON.stringify(result).includes('fixture transport detail'), false);
});

test('oversized response bodies are rejected before parsing', async () => {
  const response = new Response('x'.repeat(1024), { status: 200, headers: { 'X-Request-Id': 'oversize-1' } });
  const result = await makeRouter(async () => response, { maxResponseBytes: 128 }).choose(input());
  assert.equal(result.candidate.value.mode, 'single');
  assert.equal(result.receipt.reason, 'response_too_large');
  assert.equal(result.receipt.requestId, 'oversize-1');
});

test('oversized requests bypass transport and malformed provider metadata falls back', async () => {
  let calls = 0;
  const router = makeRouter(async () => { calls++; return choiceResponse(); });
  const large = await router.choose(input({ state: { request: 'x'.repeat(70_000) } }));
  assert.equal(large.candidate.value.mode, 'single');
  assert.equal(large.receipt.reason, 'request_too_large');
  assert.equal(calls, 0);

  const malformed = await makeRouter(async () => choiceResponse('multi', {
    model: 'm'.repeat(129), headers: { 'X-Request-Id': 'r'.repeat(129), 'X-System-One-Credits': '9'.repeat(32) },
  })).choose(input());
  assert.equal(malformed.candidate.value.mode, 'single');
  assert.equal(malformed.receipt.reason, 'invalid_or_unknown_choice');
  assert.equal(malformed.receipt.returnedModel, undefined);
  assert.equal(malformed.receipt.requestId, undefined);
  assert.equal(malformed.receipt.credits, undefined);
});

test('timeout and caller cancellation remain active while the response body is pending', async () => {
  let timeoutSignal;
  let timeoutBodyStarted;
  const timeoutBody = new Promise(resolve => { timeoutBodyStarted = resolve; });
  const timeoutRouter = makeRouter(async (_url, init) => {
    timeoutSignal = init.signal;
    return new Response(new ReadableStream({
      start(controller) {
        timeoutBodyStarted();
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted by timeout')), { once: true });
      },
    }));
  }, { timeoutMs: 15 });
  const timed = timeoutRouter.choose(input());
  await timeoutBody;
  const timedResult = await timed;
  assert.equal(timedResult.candidate.value.mode, 'single');
  assert.equal(timedResult.receipt.reason, 'timeout');
  assert.equal(timeoutSignal.aborted, true);

  let cancelBodyStarted;
  const cancelReady = new Promise(resolve => { cancelBodyStarted = resolve; });
  const controller = new AbortController();
  const cancelRouter = makeRouter(async (_url, init) => new Response(new ReadableStream({
    start(streamController) {
      cancelBodyStarted();
      init.signal.addEventListener('abort', () => streamController.error(new Error('aborted by caller')), { once: true });
    },
  })));
  const cancelled = cancelRouter.choose(input({ signal: controller.signal }));
  await cancelReady;
  controller.abort();
  const cancelResult = await cancelled;
  assert.equal(cancelResult.receipt.status, 'cancelled');
  assert.equal(cancelResult.candidate, undefined, 'cancellation does not select a fallback task');
});

test('disabled routing returns the deterministic fallback without calling the transport', async () => {
  let calls = 0;
  const result = await makeRouter(async () => { calls++; return choiceResponse(); }).choose(input({ enabled: false }));
  assert.equal(result.candidate.value.mode, 'single');
  assert.equal(result.receipt.reason, 'disabled');
  assert.equal(calls, 0);
});
