import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../dist/adapters/openai-compatible.js';

const context = {
  sessionId: 'fixture-session', agentId: 'fixture-agent', taskId: 'fixture-task', runId: 'fixture-run',
  attempt: 1, allowedTools: ['search'], contextRefs: [], budget: {},
};

function scriptedClock(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, `unexpected monotonic clock read ${index + 1}`);
    return values[index++];
  };
}

function event(value) {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function chunk(delta = {}, finishReason = null, extra = {}) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra };
}

function streamResponse(parts) {
  const encoded = parts.map(part => new TextEncoder().encode(part));
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= encoded.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoded[index++]);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function streamingAdapter(parts, times, extra = {}) {
  return new OpenAICompatibleAdapter({
    baseUrl: 'http://127.0.0.1/v1', model: 'fixture-requested', streaming: {},
    now: scriptedClock(times),
    fetchImpl: async () => streamResponse(parts),
    ...extra,
  });
}

test('non-streaming response keeps provider cache counters and exposes no TTFT or TPOT', async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: 'http://127.0.0.1/v1', model: 'fixture-requested', now: scriptedClock([0, 8, 15]),
    fetchImpl: async () => new Response(JSON.stringify({
      model: 'fixture-actual',
      choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 12, completion_tokens: 5, total_tokens: 17,
        prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 4,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })),
  });
  const result = await adapter.generate({ messages: [] }, context);
  assert.equal(result.ok, true);
  assert.equal(result.data.providerModel, 'fixture-actual');
  assert.deepEqual(result.data.usage, {
    inputTokens: 12, outputTokens: 5, totalTokens: 17,
    cacheHitInputTokens: 8, cacheMissInputTokens: 4, reasoningOutputTokens: 2,
  });
  assert.deepEqual(result.data.timing, {
    streaming: false,
    requestStartedAtMs: 0, responseHeadersAtMs: 8, requestEndedAtMs: 15, elapsedMs: 15,
    contentDeltaCount: 0, contentDeltaGapsMs: [],
    contentDeltaGapSemantics: 'sse_content_event_interarrival_not_token_itl',
    ttftUnavailableReason: 'non_streaming', tpotUnavailableReason: 'non_streaming',
  });
});

test('partial cache reporting remains partial and never fabricates a miss count', async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: 'http://127.0.0.1/v1', model: 'fixture', now: scriptedClock([0, 1, 2]),
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'answer' } }],
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, prompt_tokens_details: { cached_tokens: 8 } },
    })),
  });
  const result = await adapter.generate({ messages: [] }, context);
  assert.equal(result.ok, true);
  assert.equal(result.data.usage.cacheHitInputTokens, 8);
  assert.equal(Object.hasOwn(result.data.usage, 'cacheMissInputTokens'), false);
});

test('role, empty-content, and reasoning-only SSE events do not start TTFT', async () => {
  const parts = [
    event(chunk({ role: 'assistant' })),
    event(chunk({ content: '' })),
    event(chunk({ reasoning_content: 'private analysis' })),
    event(chunk({ content: 'Hello' })),
    event(chunk({}, 'stop')),
    event({ choices: [], usage: {
      prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
      prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 4,
    } }),
    event('[DONE]'),
  ];
  const result = await streamingAdapter(parts, [0, 5, 20, 30]).generate({ messages: [] }, context);
  assert.equal(result.ok, true);
  assert.equal(result.data.text, 'Hello');
  assert.equal(result.data.timing.firstContentDeltaAtMs, 20);
  assert.equal(result.data.timing.ttftMs, 20);
  assert.equal(result.data.timing.contentDeltaCount, 1);
  assert.deepEqual(result.data.timing.contentDeltaGapsMs, []);
  assert.equal(result.data.timing.tpotUnavailableReason, 'reasoning_present');
  assert.equal(result.data.usage.cacheHitInputTokens, 6);
  assert.equal(result.data.usage.cacheMissInputTokens, 4);
});

test('multi-token content chunks retain event gaps and TPOT uses provider token count, not chunk count', async () => {
  const model = 'fixture-provider-model';
  const parts = [
    event({ ...chunk({ content: 'Several tokens here' }), model }),
    event({ ...chunk({ content: 'and more words.' }), model }),
    event({ ...chunk({}, 'stop'), model }),
    event({ model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } }),
    event('[DONE]'),
  ];
  const result = await streamingAdapter(parts, [0, 5, 15, 55, 70], { thinkingMode: 'disabled' }).generate({ messages: [] }, context);
  assert.equal(result.ok, true);
  assert.equal(result.data.providerModel, model);
  assert.equal(result.data.text, 'Several tokens hereand more words.');
  assert.equal(result.data.timing.ttftMs, 15);
  assert.equal(result.data.timing.contentDeltaCount, 2);
  assert.deepEqual(result.data.timing.contentDeltaGapsMs, [40]);
  assert.equal(result.data.timing.contentDeltaGapSemantics, 'sse_content_event_interarrival_not_token_itl');
  assert.equal(result.data.timing.meanTpotMs, 8, '40 ms over the provider-reported five post-first output tokens');
  assert.equal(result.data.timing.elapsedMs, 70);
});

test('reasoning and tool-call streams do not report text-only TPOT', async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
  const reasoningParts = [
    event(chunk({ content: 'First text', reasoning_content: 'private reasoning' })),
    event(chunk({ content: 'Second text' })),
    event(chunk({}, 'stop')),
    event({ choices: [], usage }), event('[DONE]'),
  ];
  const reasoning = await streamingAdapter(reasoningParts, [0, 5, 10, 20, 25]).generate({ messages: [] }, context);
  assert.equal(reasoning.ok, true);
  assert.equal(reasoning.data.timing.ttftMs, 10);
  assert.equal(reasoning.data.timing.tpotUnavailableReason, 'reasoning_present');
  assert.equal(Object.hasOwn(reasoning.data.timing, 'meanTpotMs'), false);

  const toolParts = [
    event(chunk({ content: 'First text' })),
    event(chunk({ content: 'Second text', tool_calls: [
      { index: 0, id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } },
    ] })),
    event(chunk({}, 'tool_calls')),
    event({ choices: [], usage }), event('[DONE]'),
  ];
  const tool = await streamingAdapter(toolParts, [0, 5, 10, 20, 25]).generate({ messages: [] }, context);
  assert.equal(tool.ok, true);
  assert.equal(tool.data.timing.tpotUnavailableReason, 'tool_calls_present');
  assert.equal(Object.hasOwn(tool.data.timing, 'meanTpotMs'), false);
});

test('terminal usage on final choice frame is captured; absent reasoning counts never imply zero', async () => {
  const finalChoice = { model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } };
  const parts = [event(chunk({ content: 'A' })), event(chunk({ content: 'B' })), event(finalChoice), event('[DONE]')];

  const disabled = await streamingAdapter(parts, [0, 5, 15, 55, 70], { thinkingMode: 'disabled' })
    .generate({ messages: [] }, context);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.data.usage.outputTokens, 6);
  assert.equal(Object.hasOwn(disabled.data.usage, 'reasoningOutputTokens'), false);
  assert.equal(disabled.data.timing.meanTpotMs, 8);

  const unknown = await streamingAdapter(parts, [0, 5, 15, 55, 70])
    .generate({ messages: [] }, context);
  assert.equal(unknown.ok, true);
  assert.equal(unknown.data.timing.ttftMs, 15, 'TTFT remains available for visible text');
  assert.equal(unknown.data.timing.tpotUnavailableReason, 'reasoning_unknown');
  assert.equal(Object.hasOwn(unknown.data.timing, 'meanTpotMs'), false);

  const explicitZero = { ...finalChoice, usage: { ...finalChoice.usage,
    completion_tokens_details: { reasoning_tokens: 0 } } };
  const known = await streamingAdapter([event(chunk({ content: 'A' })), event(chunk({ content: 'B' })),
    event(explicitZero), event('[DONE]')], [0, 5, 15, 55, 70]).generate({ messages: [] }, context);
  assert.equal(known.ok, true);
  assert.equal(known.data.usage.reasoningOutputTokens, 0);
  assert.equal(known.data.timing.meanTpotMs, 8);
});

test('malformed or inconsistent cache counters reject both streaming and non-streaming usage', async () => {
  const invalidNonStreaming = [
    { prompt_cache_hit_tokens: -1 },
    { prompt_cache_hit_tokens: 1.5 },
    { prompt_cache_hit_tokens: '8' },
    { prompt_cache_hit_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { prompt_tokens: 12, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 3 },
  ];
  for (const extra of invalidNonStreaming) {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://127.0.0.1/v1', model: 'fixture', now: scriptedClock([0, 1, 2]),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, ...extra },
      })),
    });
    assert.equal((await adapter.generate({ messages: [] }, context)).ok, false, JSON.stringify(extra));
  }

  const badStream = [
    event(chunk({ content: 'x' })), event(chunk({}, 'stop')),
    event({ choices: [], usage: {
      prompt_tokens: 12, completion_tokens: 1, total_tokens: 13,
      prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 3,
    } }),
    event('[DONE]'),
  ];
  assert.equal((await streamingAdapter(badStream, [0, 1, 2, 3]).generate({ messages: [] }, context)).ok, false);
});

test('an SSE stream ending inside its final event still fails closed', async () => {
  const parts = [
    event(chunk({ content: 'partial' })),
    event(chunk({}, 'stop')),
    'data: [DONE]',
  ];
  const result = await streamingAdapter(parts, [0, 1, 2, 3]).generate({ messages: [] }, context);
  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(result, 'data'), false);
});
