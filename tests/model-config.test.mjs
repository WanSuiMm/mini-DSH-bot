import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessService, configuredModel, configuredPlannerModel } from '../service/server.mjs';

test('production planner adapter omits tools while commerce worker schema matches comparison API cap', async () => {
  const payloads = [];
  const fetchImpl = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }), { status: 200 });
  };
  const context = { sessionId: 's', agentId: 'a', taskId: 't', runId: 'r', attempt: 1, allowedTools: [], contextRefs: [], budget: {} };
  const request = { messages: [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: 'Plan this.' }], maxOutputTokens: 800 };

  const planner = configuredPlannerModel({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture', fetchImpl });
  const plannerResult = await planner.generate(request, context);
  assert.equal(plannerResult.ok, true);
  assert.equal(Object.hasOwn(payloads[0], 'tools'), false);

  const worker = configuredModel({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture', toolset: 'commerce', fetchImpl });
  const workerResult = await worker.generate(request, { ...context, allowedTools: [
    'catalog_search_products', 'catalog_get_product', 'catalog_compare_products', 'catalog_get_catalog', 'memory_search',
  ] });
  assert.equal(workerResult.ok, true);
  const compareTool = payloads[1].tools.find(tool => tool.function.name === 'catalog_compare_products');
  assert.equal(compareTool.function.parameters.properties.product_ids.maxItems, 5);
  assert.equal(compareTool.function.parameters.properties.product_ids.minItems, 2);

  const searchTool = payloads[1].tools.find(tool => tool.function.name === 'catalog_search_products');
  const filters = searchTool.function.parameters.properties.filters;
  assert.deepEqual(Object.keys(filters.properties).sort(), ['attributes', 'brand', 'category', 'currency', 'in_stock', 'max_price', 'min_price']);
  assert.equal(filters.additionalProperties, false);
  assert.equal(filters.properties.min_price.type, 'number');
  assert.equal(filters.properties.max_price.type, 'number');
  assert.equal(filters.properties.currency.type, 'string');
  assert.equal(filters.properties.in_stock.type, 'boolean');
  assert.equal(filters.properties.brand.type, 'string');
  assert.equal(filters.properties.category.type, 'string');
  assert.match(filters.properties.category.description, /exact category value returned by catalog_get_catalog/i);
  assert.equal(filters.properties.attributes.type, 'object');
  assert.equal(filters.properties.attributes.additionalProperties, true);
  assert.match(filters.description, /currency is required/i);
  assert.match(filters.properties.currency.description, /required when min_price or max_price is set/i);

  const catalogTool = payloads[1].tools.find(tool => tool.function.name === 'catalog_get_catalog');
  const catalogParameters = catalogTool.function.parameters;
  assert.deepEqual(Object.keys(catalogParameters.properties).sort(), ['limit', 'query']);
  assert.equal(catalogParameters.properties.query.type, 'string');
  assert.equal(catalogParameters.properties.query.maxLength, 200);
  assert.equal(catalogParameters.properties.limit.minimum, 1);
  assert.equal(catalogParameters.properties.limit.maximum, 50);
  assert.match(catalogTool.function.description, /short English query such as keyboard or headphone/i);
  assert.match(filters.properties.in_stock.description, /false means out of stock/i);
  assert.match(searchTool.function.description, /English-language product catalog/i);
  assert.match(searchTool.function.parameters.properties.query.description, /Translate non-English user intent into English/i);
  assert.match(searchTool.function.parameters.properties.limit.description, /smallest result count/i);

  const memoryTool = payloads[1].tools.find(tool => tool.function.name === 'memory_search');
  assert.match(memoryTool.function.description, /case-insensitive lexical matching/i);
  assert.match(memoryTool.function.description, /not semantic or vector retrieval/i);
  assert.match(memoryTool.function.parameters.properties.query.description, /empty string lists up to 8/i);
});

test('configured commerce model forwards tokenizer preflight URL and exact tool schemas', async () => {
  const captured = [];
  const worker = configuredModel({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture', toolset: 'commerce',
    tokenizerUrl: 'http://127.0.0.1:18080/tokenize', thinkingMode: 'disabled', fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      captured.push({ url, body });
      return url.endsWith('/tokenize')
        ? new Response(JSON.stringify({ count: 1720, max_model_len: 8192 }))
        : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    } });
  const request = { messages: [{ role: 'user', content: 'Search headsets.' }] };
  const context = {
    sessionId: 's', agentId: 'a', taskId: 't', runId: 'r', attempt: 1,
    allowedTools: ['catalog_search_products'], contextRefs: [], budget: {},
  };
  const counted = await worker.countTokens(request, context);
  assert.equal(counted.ok, true);
  assert.equal(counted.data.inputTokens, 1720);
  assert.equal(captured[0].url, 'http://127.0.0.1:18080/tokenize');
  assert.deepEqual(captured[0].body.tools.map(tool => tool.function.name), ['catalog_search_products']);
  assert.equal(captured[0].body.tools[0].function.parameters.properties.filters.additionalProperties, false);
  assert.equal(captured[0].body.add_generation_prompt, true);
  assert.equal(Object.hasOwn(captured[0].body, 'thinking'), false, 'tokenizer body stays a plain provider tokenization request');
  const generated = await worker.generate(request, context);
  assert.equal(generated.ok, true);
  assert.deepEqual(captured[1].body.thinking, { type: 'disabled' });
});

test('configuredModel forwards opt-in SSE and the service recovery profile includes stream mode', async () => {
  let captured;
  const eventText = [
    'data: {"choices":[{"index":0,"delta":{"content":"streamed"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const streamingModel = configuredModel({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture', streaming: { maxResponseBytes: 2048 },
    fetchImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return new Response(eventText, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
  const result = await streamingModel.generate({ messages: [{ role: 'user', content: 'Continue.' }] }, {
    sessionId: 's', agentId: 'a', taskId: 't', runId: 'r', attempt: 1, allowedTools: [], contextRefs: [], budget: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.text, 'streamed');
  assert.equal(captured.stream, true);
  assert.deepEqual(captured.stream_options, { include_usage: true });

  const createService = async (streaming, hostProfile, limits = {}) => {
    const database = { async ready() {}, async interrupted() { return []; }, async close() {} };
    const config = { baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture', ...(streaming ? { streaming: {} } : {}) };
    const service = new HarnessService({ database, authTokens: { fixture: 'owner' },
      model: configuredModel(config), planner: configuredPlannerModel(config), searchUrl: 'http://127.0.0.1:9000/v1/search',
      ...(hostProfile ? { executionProfile: hostProfile } : {}), ...limits });
    await service.readyPromise;
    const profile = service.executionProfile;
    await service.close();
    return profile;
  };
  const stableProfile = await createService(false);
  assert.equal(stableProfile, await createService(false), 'identical service configuration must keep a stable recovery identity');
  assert.notEqual(stableProfile, await createService(true), 'recovered runs must not cross nonstream/stream wire configurations');
  for (const limits of [
    { maxActiveRuns: 3 }, { maxQueuedRuns: 101 }, { maxBodyBytes: 128_001 },
    { maxParallelToolCalls: 5 }, { maxOutputTokens: 1025 }, { maxContextTokens: 8193 },
  ]) {
    assert.notEqual(stableProfile, await createService(false, undefined, limits), `${Object.keys(limits)[0]} must participate in recovery identity`);
  }
  assert.notEqual(await createService(false, 'trusted-tool-profile'), await createService(true, 'trusted-tool-profile'),
    'model wire identity must compose with an explicit trusted-tool recovery profile');
  const keyA = configuredModel({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture', apiKey: 'fixture-key-a' });
  const keyB = configuredModel({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture', apiKey: 'fixture-key-b' });
  assert.equal(keyA.executionProfile, keyB.executionProfile, 'provider credentials must not enter recovery identity');
});
