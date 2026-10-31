import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../dist/adapters/openai-compatible.js';
import { ScriptedSearchModel } from '../dist/adapters/scripted-search.js';
import { AgentLoop } from '../dist/core/agent-loop.js';

const context = { sessionId: 's', agentId: 'a', taskId: 't', runId: 'r', attempt: 1, allowedTools: ['search'], contextRefs: [], budget: {} };
function sseEvent(value, { multiline = false, ending = '\r\n' } = {}) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (multiline) {
    const splitAt = json.indexOf(',"choices"');
    assert.ok(splitAt > 0, 'multiline fixture must include an SSE-safe JSON whitespace boundary');
    return `data: ${json.slice(0, splitAt + 1)}${ending}data: ${json.slice(splitAt + 1)}${ending}${ending}`;
  }
  return `data: ${json}${ending}${ending}`;
}
function sseResponse(text, { chunkSize = Number.POSITIVE_INFINITY } = {}) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
function chatChunk(delta = {}, finishReason = null, index = 0) {
  return { id: 'fixture', choices: [{ index, delta, finish_reason: finishReason }] };
}
test('OpenAI wire adapter preserves tool call pairing; no real network', async () => {
  let captured;
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost:8000/v1', model: 'fixture',
    tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: null,
        tool_calls: [{ id: 'one', function: { name: 'search', arguments: '{"query":"memory"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
    },
  });
  const response = await adapter.generate({ messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'prev', name: 'search', input: {} }] }, { role: 'tool', content: '{}', toolCallId: 'prev' }] }, context);
  assert.equal(response.ok, true);
  assert.equal(response.data.toolCalls[0].input.query, 'memory');
  assert.equal(response.usage.totalTokens, 14);
  assert.equal(captured.url, 'http://localhost:8000/v1/chat/completions');
  assert.equal(captured.body.messages[1].tool_call_id, 'prev');
  assert.equal(captured.body.tools[0].function.name, 'search');
  assert.equal(Object.hasOwn(captured.body, 'stream'), false, 'streaming remains disabled by default');
  assert.equal(Object.hasOwn(captured.body, 'stream_options'), false, 'usage options are not added to non-streaming requests');
  assert.equal(Object.hasOwn(captured.body, 'thinking'), false, 'provider-specific thinking settings stay opt-in');
});
test('OpenAI wire adapter rejects incomplete or malformed tool conversations before sending them', async () => {
  let fetchCalls = 0;
  const cyclic = {};
  cyclic.self = cyclic;
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    fetchImpl: async () => { fetchCalls += 1; return new Response('{}'); },
  });
  const invalidConversations = [
    [{ role: 'tool', content: '{}', toolCallId: 'orphan' }],
    [{ role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'search', input: {} }] }],
    [
      { role: 'assistant', content: '', toolCalls: [
        { id: 'duplicate', name: 'search', input: {} }, { id: 'duplicate', name: 'search', input: {} },
      ] },
      { role: 'tool', content: '{}', toolCallId: 'duplicate' },
    ],
    [
      { role: 'assistant', content: '', toolCalls: [{ id: 'missing-args', name: 'search' }] },
      { role: 'tool', content: '{}', toolCallId: 'missing-args' },
    ],
    [
      { role: 'assistant', content: '', toolCalls: [{ id: 'cyclic-args', name: 'search', input: cyclic }] },
      { role: 'tool', content: '{}', toolCallId: 'cyclic-args' },
    ],
    [
      { role: 'assistant', content: '', toolCalls: [{ id: 'nan-args', name: 'search', input: { value: Number.NaN } }] },
      { role: 'tool', content: '{}', toolCallId: 'nan-args' },
    ],
    [
      { role: 'assistant', content: '', toolCalls: [{ id: 'undefined-args', name: 'search', input: { value: undefined } }] },
      { role: 'tool', content: '{}', toolCallId: 'undefined-args' },
    ],
    [
      { role: 'assistant', content: '', toolCalls: [{ id: 'sparse-args', name: 'search', input: [,] }] },
      { role: 'tool', content: '{}', toolCallId: 'sparse-args' },
    ],
  ];

  for (const messages of invalidConversations) {
    const result = await adapter.generate({ messages }, context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MODEL_ADAPTER');
  }
  assert.equal(fetchCalls, 0, 'invalid protocol histories must fail before contacting the model endpoint');
});
test('OpenAI response parsing rejects malformed call identity and unsafe finish reasons', async () => {
  const malformed = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [
      { function: { name: 'search', arguments: '{}' } },
    ] } }] })),
  });
  assert.equal((await malformed.generate({ messages: [] }, context)).ok, false, 'model tool calls require an ID');

  const call = { id: 'complete-call', type: 'function', function: { name: 'search', arguments: '{"query":"ready"}' } };
  for (const finishReason of ['length', 'content_filter', 'unknown', 'stop']) {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'partial', tool_calls: [call] }, finish_reason: finishReason }] })),
    });
    assert.equal((await adapter.generate({ messages: [] }, context)).ok, false, `${finishReason} cannot authorize tool dispatch`);
  }

  const filtered = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'filtered' }, finish_reason: 'content_filter' }] })),
  });
  assert.equal((await filtered.generate({ messages: [] }, context)).ok, false);
  const truncated = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] })),
  });
  const truncatedResult = await truncated.generate({ messages: [] }, context);
  assert.equal(truncatedResult.ok, false);
  assert.equal(truncatedResult.error.code, 'MODEL_STREAM_TRUNCATED', 'length stops use the structured truncation path');
  assert.equal(Object.hasOwn(truncatedResult, 'data'), false);
  const compatible = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [call] } }] })),
  });
  assert.equal((await compatible.generate({ messages: [] }, context)).data.finishReason, 'tool_call', 'complete JSON bodies may omit finish_reason for legacy compatibility');
});
test('non-streaming truncation preserves validated usage and discards partial tool JSON', async () => {
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'partial', tool_calls: [{ id: 'partial', function: { name: 'search', arguments: '{"query":' } }] }, finish_reason: 'length' }],
      usage: { prompt_tokens: 12, completion_tokens: 32, total_tokens: 44 },
    })),
  });
  const result = await adapter.generate({ messages: [] }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MODEL_STREAM_TRUNCATED');
  assert.equal(Object.hasOwn(result, 'data'), false, 'a length finish never exposes a partial tool call');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 32, totalTokens: 44 });
});
test('AgentLoop does not dispatch a malformed provider tool call', async () => {
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [
      { function: { name: 'search', arguments: '{"query":"unsafe"}' } },
    ] } }] })),
  });
  let dispatched = 0;
  const tools = { async execute() { dispatched += 1; return { ok: true, data: {}, evidence: [] }; } };
  const task = { sessionId: 's', taskId: 't', runId: 'r', attempt: 1, title: 'protocol test', instructions: 'Search.',
    dependencies: [], contextRefs: [], allowedTools: ['search'], budget: { maxTokens: 1000 } };
  const result = await new AgentLoop(adapter, tools).run(task, { ...context, budget: { maxTokens: 1000 } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MODEL_TOOL_CALL_INCOMPLETE');
  assert.equal(dispatched, 0);
});
test('opt-in Chat Completions SSE assembles fragmented tool calls without exposing reasoning', async () => {
  let captured;
  const parts = [
    sseEvent({ id: 'fixture', meta: 'multiline event', choices: [{ index: 0, delta: {
      role: 'assistant', reasoning_content: 'private reasoning',
      tool_calls: [
        { index: 0, id: 'call_', type: 'function', function: { name: 'sea', arguments: '{"query":"' } },
        { index: 1, id: 'call_2', type: 'function', function: { name: 'memory_search', arguments: '{"query":"λ"}' } },
      ],
    }, finish_reason: null }] }, { multiline: true }),
    sseEvent(chatChunk({ content: 'Ready', reasoning_content: 'more private reasoning', tool_calls: [
      { index: 0, id: '1', function: { name: 'rch', arguments: 'web"}' } },
    ] })),
    sseEvent(chatChunk({}, 'tool_calls')),
    sseEvent('[DONE]'),
  ];
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    streaming: { maxResponseBytes: 4096, maxEvents: 8, maxToolCalls: 2 },
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return sseResponse(parts.join(''), { chunkSize: 1 });
    },
  });
  const result = await adapter.generate({ messages: [{ role: 'user', content: 'Search.' }] }, context);
  assert.equal(result.ok, true);
  assert.equal(captured.stream, true);
  assert.deepEqual(captured.stream_options, { include_usage: true });
  assert.equal(result.data.text, 'Ready');
  assert.equal(result.data.usage, undefined, 'streams without a usage chunk retain the existing local-estimate fallback');
  assert.doesNotMatch(result.data.text, /private reasoning/);
  assert.deepEqual(result.data.toolCalls, [
    { id: 'call_1', name: 'search', input: { query: 'web' } },
    { id: 'call_2', name: 'memory_search', input: { query: 'λ' } },
  ]);
  assert.equal(result.data.finishReason, 'tool_call');
});
test('stream tool-call cap stays 32 by default and accepts up to 128 when configured', async () => {
  const calls = Array.from({ length: 64 }, (_, index) => ({
    index, id: `call_${index}`, type: 'function', function: { name: 'search', arguments: '{}' },
  }));
  const response = [
    sseEvent({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 128, completion_tokens: 8, total_tokens: 136 } }),
    sseEvent('[DONE]'),
  ].join('');

  const defaultAdapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async () => sseResponse(response),
  });
  const defaultResult = await defaultAdapter.generate({ messages: [] }, context);
  assert.equal(defaultResult.ok, false, 'the existing default cap remains 32');
  assert.equal(defaultResult.error.code, 'MODEL_STREAM_TOOL_CALL_INDEX_INVALID');
  assert.deepEqual(defaultResult.usage, { inputTokens: 128, outputTokens: 8, totalTokens: 136 },
    'a policy-rejected batch drains through terminal usage and keeps provider accounting');

  const expandedAdapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: { maxToolCalls: 128 },
    fetchImpl: async () => sseResponse(response),
  });
  const expandedResult = await expandedAdapter.generate({ messages: [] }, context);
  assert.equal(expandedResult.ok, true);
  assert.equal(expandedResult.data.toolCalls.length, 64);
  assert.deepEqual(expandedResult.data.toolCalls[63], { id: 'call_63', name: 'search', input: {} });
});
test('finite oversized streamed tool indexes are rejected without collection allocation and retain usage', async () => {
  const response = [
    sseEvent({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 1e100, id: 'too-large', type: 'function', function: { name: 'search', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }),
    sseEvent('[DONE]'),
  ].join('');
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: { maxToolCalls: 128 },
    fetchImpl: async () => sseResponse(response),
  });
  const result = await adapter.generate({ messages: [] }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MODEL_STREAM_TOOL_CALL_INDEX_INVALID');
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4, totalTokens: 24 });
});
test('nullable optional tool fragments are ignored, while malformed nonnull fragments remain rejected', async () => {
  const nullableParts = [
    sseEvent(chatChunk({ role: null, tool_calls: [
      { index: 0, id: null, type: null, function: null },
    ] })),
    sseEvent(chatChunk({ tool_calls: [
      { index: 0, id: 'call_', type: 'function', function: { name: null, arguments: null } },
    ] })),
    sseEvent(chatChunk({ tool_calls: [
      { index: 0, id: '1', type: null, function: { name: 'search', arguments: '{"query":"x"}' } },
    ] })),
    sseEvent(chatChunk({}, 'tool_calls')),
    sseEvent('[DONE]'),
  ];
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async () => sseResponse(nullableParts.join(''), { chunkSize: 1 }),
  });
  const result = await adapter.generate({ messages: [] }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.toolCalls, [{ id: 'call_1', name: 'search', input: { query: 'x' } }]);

  const malformed = [
    ['role', { role: 'user' }, 'MODEL_STREAM_ROLE_INVALID'],
    ['tool call ID', { tool_calls: [{ index: 0, id: 7 }] }, 'MODEL_STREAM_TOOL_CALL_ID_INVALID'],
    ['tool call type', { tool_calls: [{ index: 0, type: 'object' }] }, 'MODEL_STREAM_TOOL_CALL_TYPE_INVALID'],
    ['tool function', { tool_calls: [{ index: 0, function: [] }] }, 'MODEL_STREAM_TOOL_FUNCTION_INVALID'],
    ['tool arguments', { tool_calls: [{ index: 0, function: { arguments: 7 } }] }, 'MODEL_STREAM_TOOL_ARGUMENTS_INVALID'],
  ];
  for (const [label, delta, code] of malformed) {
    const invalid = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
      fetchImpl: async () => sseResponse([sseEvent(chatChunk(delta)), sseEvent(chatChunk({}, 'tool_calls')),
        sseEvent('[DONE]')].join('')),
    });
    const rejected = await invalid.generate({ messages: [] }, context);
    assert.equal(rejected.ok, false, label);
    assert.equal(rejected.error.code, code, label);
  }
});
test('DeepSeek replay-shaped frames ignore null per-choice usage and parse usage on the final tool-call frame', async () => {
  const usage = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24,
    prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 };
  const frames = [
    { model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: '' },
      logprobs: null, finish_reason: null }], usage: null },
    { model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_fixture',
      type: 'function', function: { name: 'ping', arguments: '' } }] }, logprobs: null, finish_reason: null }], usage: null },
    { model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: null,
      function: { arguments: '{"value":' } }] }, logprobs: null, finish_reason: null }], usage: null },
    { model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: null,
      function: { arguments: '"fixture"}' } }] }, logprobs: null, finish_reason: null }], usage: null },
    { model: 'deepseek-flash', choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'tool_calls' }], usage },
    '[DONE]',
  ];
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    thinkingMode: 'disabled', streaming: {}, tools: [{ name: 'ping', description: 'Fixture', parameters: { type: 'object' } }],
    fetchImpl: async () => sseResponse(frames.map(frame => sseEvent(frame)).join(''), { chunkSize: 1 }),
  });
  const result = await adapter.generate({ messages: [{ role: 'user', content: 'Generic protocol fixture.' }] },
    { ...context, allowedTools: ['ping'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.toolCalls, [{ id: 'call_fixture', name: 'ping', input: { value: 'fixture' } }]);
  assert.equal(result.data.usage.outputTokens, 4);
  assert.equal(result.data.timing.tpotUnavailableReason, 'no_content_delta');
});
test('stream usage option is explicit and a provider rejection is not retried with altered accounting', async () => {
  let requests = 0;
  let captured;
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async (_url, init) => {
      requests += 1;
      captured = JSON.parse(init.body);
      return new Response('unsupported stream_options', { status: 400 });
    },
  });
  const result = await adapter.generate({ messages: [] }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MODEL_HTTP');
  assert.equal(requests, 1, 'stream option rejection must not trigger a nonstream retry');
  assert.equal(captured.stream, true);
  assert.deepEqual(captured.stream_options, { include_usage: true });
});
test('SSE terminal, truncation, malformed-fragment and size failures return no partial tool calls', async () => {
  const completeCall = { index: 0, id: 'unsafe', type: 'function', function: { name: 'search', arguments: '{"query":"x"}' } };
  const invalidStreams = [
    { name: 'length finish', parts: [sseEvent(chatChunk({ tool_calls: [completeCall] })), sseEvent(chatChunk({}, 'length')), sseEvent('[DONE]')] },
    { name: 'missing finish', parts: [sseEvent(chatChunk({ content: 'partial' })), sseEvent('[DONE]')] },
    { name: 'missing DONE', parts: [sseEvent(chatChunk({ tool_calls: [completeCall] })), sseEvent(chatChunk({}, 'tool_calls'))] },
    { name: 'negative index', parts: [sseEvent(chatChunk({ tool_calls: [{ ...completeCall, index: -1 }] })), sseEvent(chatChunk({}, 'tool_calls')), sseEvent('[DONE]')] },
    { name: 'index gap', parts: [sseEvent(chatChunk({ tool_calls: [{ ...completeCall, index: 1 }] })), sseEvent(chatChunk({}, 'tool_calls')), sseEvent('[DONE]')] },
    { name: 'malformed arguments', parts: [sseEvent(chatChunk({ tool_calls: [{ ...completeCall, function: { ...completeCall.function, arguments: '{' } }] })), sseEvent(chatChunk({}, 'tool_calls')), sseEvent('[DONE]')] },
    { name: 'missing ID', parts: [sseEvent(chatChunk({ tool_calls: [{ ...completeCall, id: '' }] })), sseEvent(chatChunk({}, 'tool_calls')), sseEvent('[DONE]')] },
    { name: 'filtered finish', parts: [sseEvent(chatChunk({ tool_calls: [completeCall] })), sseEvent(chatChunk({}, 'content_filter')), sseEvent('[DONE]')] },
    { name: 'unknown finish', parts: [sseEvent(chatChunk({ tool_calls: [completeCall] })), sseEvent(chatChunk({}, 'other')), sseEvent('[DONE]')] },
  ];
  for (const item of invalidStreams) {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
      fetchImpl: async () => sseResponse(item.parts.join('')),
    });
    const result = await adapter.generate({ messages: [] }, context);
    assert.equal(result.ok, false, item.name);
    assert.equal(Object.hasOwn(result, 'data'), false, `${item.name} must not return partial calls`);
  }

  const afterUsage = [
    sseEvent(chatChunk({}, 'stop')),
    sseEvent({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
    sseEvent(chatChunk({ content: 'too late' })),
    sseEvent('[DONE]'),
  ];
  const afterUsageAdapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async () => sseResponse(afterUsage.join('')),
  });
  assert.equal((await afterUsageAdapter.generate({ messages: [] }, context)).ok, false, 'terminal usage cannot be followed by content or calls');

  for (const [name, streaming, parts] of [
    ['response byte cap', { maxResponseBytes: 8 }, [sseEvent(chatChunk({ content: 'long response' })), sseEvent(chatChunk({}, 'stop')), sseEvent('[DONE]')]],
    ['event cap', { maxEvents: 1 }, [sseEvent(chatChunk({ content: 'x' })), sseEvent(chatChunk({}, 'stop')), sseEvent('[DONE]')]],
  ]) {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming,
      fetchImpl: async () => sseResponse(parts.join('')),
    });
    assert.equal((await adapter.generate({ messages: [] }, context)).ok, false, name);
  }
});
test('SSE parse, post-usage and tool-argument failures have safe finite classifications', async () => {
  const privateProviderText = 'PRIVATE_PROVIDER_RESPONSE_MARKER';
  const call = { index: 0, id: 'call-invalid-args', type: 'function', function: {
    name: 'search', arguments: `{"detail":"${privateProviderText}",}`,
  } };
  const validUsage = { prompt_tokens: 9_728, completion_tokens: 1_459, total_tokens: 11_187 };
  const failures = [
    {
      name: 'malformed SSE JSON',
      parts: [sseEvent(`{"error":"${privateProviderText}",`), sseEvent('[DONE]')],
      code: 'MODEL_STREAM_JSON_INVALID',
    },
    {
      name: 'truncated generation',
      parts: [sseEvent(chatChunk({}, 'length')), sseEvent('[DONE]')],
      code: 'MODEL_STREAM_TRUNCATED',
    },
    {
      name: 'invalid streamed tool arguments',
      parts: [sseEvent(chatChunk({ tool_calls: [call] })), sseEvent(chatChunk({}, 'tool_calls')), sseEvent('[DONE]')],
      code: 'MODEL_TOOL_ARGUMENTS_INVALID',
    },
    {
      name: 'invalid response after complete usage',
      parts: [
        sseEvent(chatChunk({}, 'stop')),
        sseEvent({ choices: [], usage: validUsage }),
        sseEvent({ error: { message: privateProviderText } }),
        sseEvent('[DONE]'),
      ],
      code: 'MODEL_STREAM_ORDER_INVALID',
    },
  ];

  for (const item of failures) {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
      fetchImpl: async () => sseResponse(item.parts.join('')),
    });
    const result = await adapter.generate({ messages: [] }, context);
    assert.equal(result.ok, false, item.name);
    assert.equal(result.error.code, item.code, item.name);
    assert.equal(Object.hasOwn(result, 'data'), false, `${item.name} must not return a partial response`);
    assert.equal(JSON.stringify(result.error).includes(privateProviderText), false, `${item.name} must not disclose provider text`);
  }
});
test('SSE terminal usage preserves validated provider counts and stable response identity', async () => {
  const idFields = { id: 'response-1', model: 'fixture-model', object: 'chat.completion.chunk', created: 1_800_000_000, system_fingerprint: 'node-a' };
  const valid = [
    sseEvent({ ...idFields, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }),
    sseEvent({ ...idFields, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseEvent({ ...idFields, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
    sseEvent('[DONE]'),
  ];
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async () => sseResponse(valid.join('')),
  });
  const result = await adapter.generate({ messages: [] }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  assert.deepEqual(result.usage, result.data.usage);

  for (const [name, tail] of [
    ['inconsistent usage', { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 99 } }],
    ['incomplete usage', { choices: [], usage: { prompt_tokens: 12, total_tokens: 12 } }],
  ]) {
    const malformed = [sseEvent({ ...idFields, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sseEvent({ ...idFields, ...tail }), sseEvent('[DONE]')];
    const bad = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
      fetchImpl: async () => sseResponse(malformed.join('')),
    });
    assert.equal((await bad.generate({ messages: [] }, context)).ok, false, name);
  }

  const drift = [
    sseEvent({ ...idFields, choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] }),
    sseEvent({ ...idFields, model: 'other-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseEvent('[DONE]'),
  ];
  const mismatched = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async () => sseResponse(drift.join('')),
  });
  assert.equal((await mismatched.generate({ messages: [] }, context)).ok, false, 'model identity must remain stable across chunks');
});
test('AgentLoop discards partial streamed tool calls before bounded recovery', async () => {
  const call = { index: 0, id: 'unsafe', type: 'function', function: { name: 'search', arguments: '{"query":"unsafe"}' } };
  let requests = 0;
  const requestBodies = [];
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
    fetchImpl: async (_url, init) => {
      requests += 1;
      requestBodies.push(JSON.parse(init.body));
      if (requests === 1) {
        return sseResponse([
          sseEvent(chatChunk({ tool_calls: [call] })),
          sseEvent(chatChunk({}, 'length')),
          sseEvent({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 32, total_tokens: 44 } }),
          sseEvent('[DONE]'),
        ].join(''));
      }
      return sseResponse([
        sseEvent(chatChunk({ content: 'Recovered answer' })),
        sseEvent(chatChunk({}, 'stop')),
        sseEvent({ choices: [], usage: { prompt_tokens: 13, completion_tokens: 3, total_tokens: 16 } }),
        sseEvent('[DONE]'),
      ].join(''));
    },
  });
  let dispatched = 0;
  const tools = { async execute() { dispatched += 1; return { ok: true, data: {}, evidence: [] }; } };
  const task = { sessionId: 's', taskId: 't', runId: 'r', attempt: 1, title: 'stream protocol test', instructions: 'Search.',
    dependencies: [], contextRefs: [], allowedTools: ['search'], budget: { maxTokens: 1000 } };
  const result = await new AgentLoop(adapter, tools, { recoverOutputTruncation: true }).run(task, { ...context, budget: { maxTokens: 1000 } });
  assert.equal(result.ok, true);
  assert.equal(requests, 2, 'the complete usage report allows one bounded recovery request');
  assert.equal(dispatched, 0);
  assert.equal(requestBodies[1].messages.some(message => message.tool_calls?.some(toolCall => toolCall.id === 'unsafe')), false,
    'the partial tool call is absent from the retry conversation');
  assert.equal(result.data.usage.totalTokens, 60, 'usage from the truncated and recovered responses is retained');
});
test('AgentLoop charges validated SSE usage from the terminal provider chunk', async () => {
  const parts = [
    sseEvent(chatChunk({ content: 'provider counted answer' })),
    sseEvent(chatChunk({}, 'stop')),
    sseEvent({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
    sseEvent('[DONE]'),
  ];
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async () => sseResponse(parts.join('')),
  });
  const task = { sessionId: 's', taskId: 't', runId: 'r', attempt: 1, title: 'usage fixture', instructions: 'Answer.',
    dependencies: [], contextRefs: [], allowedTools: [], budget: { maxTokens: 1000 } };
  const result = await new AgentLoop(adapter, { async execute() { throw new Error('no tools expected'); } }).run(task, { ...context, allowedTools: [], budget: { maxTokens: 1000 } });
  assert.equal(result.ok, true);
  assert.equal(result.data.usage.inputTokens, 12);
  assert.equal(result.data.usage.outputTokens, 3);
  assert.equal(result.data.usage.totalTokens, 15);
});
test('SSE length finish preserves later terminal usage without exposing partial calls', async () => {
  const parts = [
    sseEvent(chatChunk({ tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'search', arguments: '{"query":' } }] })),
    sseEvent(chatChunk({}, 'length')),
    sseEvent({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 32, total_tokens: 44 } }),
    sseEvent('[DONE]'),
  ];
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async () => sseResponse(parts.join('')),
  });
  const result = await adapter.generate({ messages: [] }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MODEL_STREAM_TRUNCATED');
  assert.equal(Object.hasOwn(result, 'data'), false);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 32, totalTokens: 44 });
});
test('stream abort cancels the response reader and returns a cancellation error', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', streaming: {},
    fetchImpl: async () => {
      const body = new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode(sseEvent(chatChunk({ content: 'partial' })))); },
        cancel() { cancelled = true; },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const pending = adapter.generate({ messages: [] }, { ...context, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(cancelled, true);
});
test('Malformed model tool JSON is an adapter error and HTTP bodies are not echoed', async () => {
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'search', arguments: 'bad' } }] } }] })) });
  assert.equal((await adapter.generate({ messages: [] }, context)).ok, false);
  const denied = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', fetchImpl: async () => new Response('private debug', { status: 403 }) });
  const result = await denied.generate({ messages: [] }, context);
  assert.equal(result.error.code, 'MODEL_HTTP');
  assert.equal(JSON.stringify(result).includes('private debug'), false);
});
test('OpenAI wire adapter advertises only tools authorized by the worker context', async () => {
  const bodies = [];
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture',
    tools: [
      { name: 'catalog_search_products', description: 'Search products', parameters: { type: 'object' } },
      { name: 'memory_search', description: 'Search memory', parameters: { type: 'object' } },
    ],
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    },
  });
  await adapter.generate({ messages: [] }, { ...context, allowedTools: ['catalog_search_products'] });
  assert.deepEqual(bodies[0].tools.map(tool => tool.function.name), ['catalog_search_products']);
  await adapter.generate({ messages: [] }, { ...context, allowedTools: [] });
  assert.equal(Object.hasOwn(bodies[1], 'tools'), false, 'an empty worker allowlist must advertise no tools');
});
test('OpenAI tokenizer preflight counts the exact allowed-tool chat wire without generation', async () => {
  let captured;
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', apiKey: 'test-only-model-key', tokenizerUrl: 'http://localhost:18080/tokenize',
    tools: [
      { name: 'catalog_search_products', description: 'Search catalog', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'memory_search', description: 'Search memory', parameters: { type: 'object' } },
    ],
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: new Headers(init.headers) };
      return new Response(JSON.stringify({ count: 2350, max_model_len: 8192, tokens: [], token_strs: [] }));
    },
  });
  const messages = [{ role: 'system', content: 'Use commerce tools.' }, { role: 'user', content: 'Compare these products.' }];
  const result = await adapter.countTokens({ messages }, { ...context, allowedTools: ['catalog_search_products'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { inputTokens: 2350, maxContextTokens: 8192 });
  assert.equal(captured.url, 'http://localhost:18080/tokenize');
  assert.equal(captured.body.model, 'fixture');
  assert.deepEqual(captured.body.messages, messages);
  assert.equal(captured.body.add_generation_prompt, true);
  assert.deepEqual(captured.body.tools.map(tool => tool.function.name), ['catalog_search_products']);
  assert.equal(captured.headers.has('authorization'), false, 'model credentials must not be forwarded to a separately configured tokenizer');
});
test('local OpenAI prompt estimate includes only the currently allowed tool schemas', () => {
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://localhost/v1', model: 'fixture', tools: [
    { name: 'catalog_search_products', description: 'Search a commerce catalog using structured price and availability filters.', parameters: {
      type: 'object', properties: { query: { type: 'string' }, filters: { type: 'object', properties: { max_price: { type: 'number' } } } },
    } },
    { name: 'memory_search', description: 'Search saved notes.', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  ] });
  const request = { messages: [{ role: 'system', content: 'Use available tools.' }, { role: 'user', content: 'Find a headset.' }] };
  const allowed = adapter.estimatePromptTokens(request, { ...context, allowedTools: ['catalog_search_products'] });
  const none = adapter.estimatePromptTokens(request, { ...context, allowedTools: [] });
  assert.ok(allowed > none, 'wire estimate must include the allowed commerce schema');
  assert.ok(none > 0);
});
test('DeepSeek non-thinking mode is an opt-in chat-completion field', async () => {
  let captured;
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', thinkingMode: 'disabled',
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    },
  });
  const result = await adapter.generate({ messages: [{ role: 'user', content: 'Call the catalog tool.' }] }, context);
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });
  assert.equal(captured.body.model, 'deepseek-flash');
});
test('Scripted model is a deterministic tool protocol fixture', async () => {
  const model = new ScriptedSearchModel();
  const result = await model.generate({ messages: [{ role: 'user', content: 'memory' }] }, context);
  assert.equal(result.data.toolCalls[0].name, 'search');
  assert.equal(result.data.toolCalls[0].input.query, 'memory');
  assert.equal(result.usage.totalTokens, 0);
});
