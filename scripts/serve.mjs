import { HarnessService, configuredModel, configuredPlannerModel } from '../service/server.mjs';
import { JevChoiceRouter } from '../dist/multi_agent/jev-choice-router.js';
import { createFastifyServer } from '../service/fastify-server.mjs';
import { resolve } from 'node:path';
import { loadToolConfiguration } from '../service/tool-configuration.mjs';

function integerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function streamingEnv() {
  const enabled = process.env.MICRO_DSH_STREAMING ?? '0';
  if (enabled !== '0' && enabled !== '1') throw new Error('MICRO_DSH_STREAMING must be 0 or 1');
  if (enabled === '0') return undefined;
  return {
    maxResponseBytes: integerEnv('MICRO_DSH_STREAM_MAX_RESPONSE_BYTES', 4 * 1024 * 1024, { min: 1, max: 32 * 1024 * 1024 }),
    maxEvents: integerEnv('MICRO_DSH_STREAM_MAX_EVENTS', 8_192, { min: 1, max: 100_000 }),
    maxToolCalls: integerEnv('MICRO_DSH_STREAM_MAX_TOOL_CALLS', 32, { min: 1, max: 32 }),
  };
}

function jevRoutingEnv() {
  const enabled = process.env.MICRO_DSH_JEV_ROUTING ?? '0';
  if (enabled !== '0' && enabled !== '1') throw new Error('MICRO_DSH_JEV_ROUTING must be 0 or 1');
  if (enabled === '0') return undefined;
  const apiKey = process.env.TYPESAFE_API_KEY;
  const model = process.env.MICRO_DSH_JEV_MODEL;
  if (!apiKey || !model) throw new Error('MICRO_DSH_JEV_ROUTING=1 requires TYPESAFE_API_KEY and MICRO_DSH_JEV_MODEL');
  const rawConfidence = process.env.MICRO_DSH_JEV_MIN_CONFIDENCE ?? '0.6';
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(rawConfidence)) throw new Error('MICRO_DSH_JEV_MIN_CONFIDENCE must be between 0 and 1');
  return new JevChoiceRouter({
    apiKey,
    model,
    baseUrl: process.env.MICRO_DSH_JEV_BASE_URL ?? 'https://api.typesafe.ai/v1',
    timeoutMs: integerEnv('MICRO_DSH_JEV_TIMEOUT_MS', 3_000, { min: 1, max: 30_000 }),
    minConfidence: Number(rawConfidence),
  });
}

if (process.argv.includes('--help')) {
  console.log('Required: MICRO_DSH_AUTH_TOKENS, MICRO_DSH_MODEL_URL, MICRO_DSH_MODEL, MICRO_DSH_TOOLSET (commerce|technical|coding|browser), and exactly one of MICRO_DSH_DATABASE or MICRO_DSH_DATABASE_URL. Commerce also requires SEARCHFORGE_BASE_URL; technical requires SEARCHFORGE_URL; coding and browser require MICRO_DSH_TOOL_CONFIG (absolute trusted JSON path). Browser also requires its configured PostgreSQL environment and compatible Chromium; build browser-ui before opening /browser/. Optional: MODEL_API_KEY, MICRO_DSH_TOKENIZER_URL (exact provider /tokenize preflight; failures block generation), MICRO_DSH_THINKING_MODE=disabled, MICRO_DSH_STREAMING=1 (opt-in bounded Chat Completions SSE), MICRO_DSH_STREAM_MAX_RESPONSE_BYTES, MICRO_DSH_STREAM_MAX_EVENTS, MICRO_DSH_STREAM_MAX_TOOL_CALLS, MICRO_DSH_JEV_ROUTING=1 (opt-in POST /runs mode=auto), TYPESAFE_API_KEY, MICRO_DSH_JEV_MODEL, MICRO_DSH_JEV_BASE_URL, MICRO_DSH_JEV_TIMEOUT_MS, MICRO_DSH_JEV_MIN_CONFIDENCE, SEARCHFORGE_TOKEN, MICRO_DSH_REDIS_URL, MICRO_DSH_RATE_LIMIT, MICRO_DSH_RATE_WINDOW_MS, MICRO_DSH_MAX_OUTPUT_TOKENS, MICRO_DSH_MAX_CONTEXT_TOKENS, HOST, PORT, MICRO_DSH_MAX_ACTIVE_RUNS, MICRO_DSH_MAX_QUEUED_RUNS. Production HTTP uses Fastify.');
} else {
  const required = ['MICRO_DSH_AUTH_TOKENS', 'MICRO_DSH_MODEL_URL', 'MICRO_DSH_MODEL', 'MICRO_DSH_TOOLSET'];
  for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}; real-model service configuration is mandatory`);
  const toolset = process.env.MICRO_DSH_TOOLSET;
  if (!['commerce', 'technical', 'coding', 'browser'].includes(toolset)) throw new Error('MICRO_DSH_TOOLSET must be commerce, technical, coding or browser');
  if (toolset === 'commerce' && !process.env.SEARCHFORGE_BASE_URL) throw new Error('Missing SEARCHFORGE_BASE_URL for commerce toolset');
  if (toolset === 'technical' && !process.env.SEARCHFORGE_URL) throw new Error('Missing SEARCHFORGE_URL for technical toolset');

  const sqlitePath = process.env.MICRO_DSH_DATABASE;
  const postgresUrl = process.env.MICRO_DSH_DATABASE_URL;
  if (Boolean(sqlitePath) === Boolean(postgresUrl)) throw new Error('Set exactly one of MICRO_DSH_DATABASE or MICRO_DSH_DATABASE_URL');
  const autoModeRouter = jevRoutingEnv();
  const hostTools = await loadToolConfiguration(process.env.MICRO_DSH_TOOL_CONFIG, { toolset });
  let database, quotaLimiter, service, http;
  try {
  database = postgresUrl
    ? await (await import('../service/postgres-database.mjs')).PostgresServiceDatabase.connect(postgresUrl)
    : resolve(sqlitePath);
  quotaLimiter = process.env.MICRO_DSH_REDIS_URL
    ? await (await import('../service/redis-quota.mjs')).RedisRunQuota.connect(process.env.MICRO_DSH_REDIS_URL, {
      limit: integerEnv('MICRO_DSH_RATE_LIMIT', 60, { min: 1, max: 100_000 }),
      windowMs: integerEnv('MICRO_DSH_RATE_WINDOW_MS', 60_000, { min: 1000, max: 86_400_000 }),
    })
    : undefined;
  const bodyLimit = integerEnv('MICRO_DSH_MAX_BODY_BYTES', 128_000, { min: 1024, max: 2_000_000 });
  const modelConfig = { baseUrl: process.env.MICRO_DSH_MODEL_URL, model: process.env.MICRO_DSH_MODEL, apiKey: process.env.MODEL_API_KEY, tokenizerUrl: process.env.MICRO_DSH_TOKENIZER_URL, thinkingMode: process.env.MICRO_DSH_THINKING_MODE, streaming: streamingEnv(), toolset, extraTools: hostTools.extraTools };
  service = new HarnessService({ database, authTokens: JSON.parse(process.env.MICRO_DSH_AUTH_TOKENS),
    model: configuredModel(modelConfig), planner: configuredPlannerModel(modelConfig),
    autoModeRouter,
    searchUrl: process.env.SEARCHFORGE_URL, searchBaseUrl: process.env.SEARCHFORGE_BASE_URL, searchToken: process.env.SEARCHFORGE_TOKEN,
    toolset, quotaLimiter, maxBodyBytes: bodyLimit, ...hostTools,
    maxActiveRuns: integerEnv('MICRO_DSH_MAX_ACTIVE_RUNS', 2, { min: 1, max: 64 }),
    maxQueuedRuns: integerEnv('MICRO_DSH_MAX_QUEUED_RUNS', 100, { min: 1, max: 100_000 }),
    maxParallelToolCalls: integerEnv('MICRO_DSH_MAX_PARALLEL_TOOL_CALLS', 4, { min: 1, max: 32 }),
    maxOutputTokens: integerEnv('MICRO_DSH_MAX_OUTPUT_TOKENS', 1024, { min: 1, max: 4096 }),
    maxContextTokens: integerEnv('MICRO_DSH_MAX_CONTEXT_TOKENS', 8192, { min: 2, max: 1_000_000 }),
  });
  await service.readyPromise;
  http = await createFastifyServer(service, { bodyLimit });
  const address = new URL(await http.listen({ host: process.env.HOST ?? '127.0.0.1', port: integerEnv('PORT', 8788, { min: 0, max: 65535 }) }));
  service.schedule();
  console.log(JSON.stringify({ service: 'micro-DSH', host: address.hostname, port: Number(address.port), authenticated: true, backend: service.database.kind, http: 'fastify', toolset, autoRoutingEnabled: Boolean(autoModeRouter) }));
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    service.browserRuntime?.stopStreams();
    await http.close();
    await service.close();
  };
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
  } catch (cause) {
    await http?.close().catch(() => {});
    if (service) await service.close().catch(() => {});
    else {
      if (typeof database === 'object') await database.close?.().catch(() => {});
      await quotaLimiter?.close?.().catch(() => {});
      await Promise.allSettled(hostTools.toolProviders.map(provider => provider.close?.()));
    }
    throw cause;
  }
}
