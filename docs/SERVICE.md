# micro-DSH Runtime Service

The service exposes the project’s existing Harness state machine through Fastify. The transport delegates to `HarnessService.handle`; queueing, worker execution, persisted task DAGs, events, cancellation, idempotency, memory and model/tool policy remain in the shared runtime. Production does not select a fixture model.

## Start

Use Node.js 22.19 or newer. The project needs TypeScript 6 for the build and Fastify 5 for the production HTTP listener. `pg` and `redis` are loaded only when their backends are configured.

```powershell
node scripts/build.mjs
node scripts/serve.mjs --help
node scripts/serve.mjs
```

The production process requires:

| Variable | Purpose |
| --- | --- |
| `MICRO_DSH_AUTH_TOKENS` | JSON mapping bearer tokens to owner IDs, for example `{"local-token":"user-1"}`. Keep the real token outside the repository. |
| `MICRO_DSH_MODEL_URL` | OpenAI-compatible model service base URL. |
| `MICRO_DSH_MODEL` | Model identifier accepted by that endpoint. |
| `MICRO_DSH_TOOLSET` | Explicitly `commerce`, `technical` or `coding`; it has no default. |
| `MICRO_DSH_TOOL_CONFIG` | Required for `coding`; absolute path to trusted host tool configuration. Optional for explicitly adding MCP providers to other toolsets. |
| `MICRO_DSH_DATABASE` or `MICRO_DSH_DATABASE_URL` | Set exactly one. SQLite is the compatible local/test store; PostgreSQL is the production store. |
| `SEARCHFORGE_BASE_URL` | Required for `commerce`; an HTTP(S) origin without a path, query, or credentials. |
| `SEARCHFORGE_URL` | Required for the legacy `technical` toolset; full `/v1/search` endpoint. |

Optional variables are `MODEL_API_KEY`, `MICRO_DSH_TOKENIZER_URL` (provider-compatible `/tokenize` endpoint), `MICRO_DSH_THINKING_MODE=disabled` (opt-in DeepSeek non-thinking request field), `MICRO_DSH_STREAMING=1` (opt-in bounded Chat Completions SSE; default is off), `MICRO_DSH_STREAM_MAX_RESPONSE_BYTES` (default 4 MiB, maximum 32 MiB), `MICRO_DSH_STREAM_MAX_EVENTS` (default 8192, maximum 100000), `MICRO_DSH_STREAM_MAX_TOOL_CALLS` (default and maximum 32), `SEARCHFORGE_TOKEN`, `MICRO_DSH_REDIS_URL`, `MICRO_DSH_RATE_LIMIT` (default 60 per window), `MICRO_DSH_RATE_WINDOW_MS` (default 60000), `MICRO_DSH_MAX_ACTIVE_RUNS`, `MICRO_DSH_MAX_QUEUED_RUNS`, `MICRO_DSH_MAX_BODY_BYTES`, `MICRO_DSH_MAX_PARALLEL_TOOL_CALLS`, `MICRO_DSH_MAX_OUTPUT_TOKENS` (default 1024 per model request), `MICRO_DSH_MAX_CONTEXT_TOKENS` (default 8192 including prompt and completion), `HOST` (default `127.0.0.1`) and `PORT` (default `8788`). Streaming requests set `stream_options.include_usage=true`, so configured endpoints must support that option; a rejection is returned without a non-streaming retry. Streaming requires a supported finish reason, `[DONE]`, and clean EOF before any tool calls are returned. The versioned `harness-service-recovery-v2` identity includes host/model configuration and service concurrency, body, parallel-tool, output-token, and context limits. When exact tokenization is configured, the adapter sends the same OpenAI-wire messages and currently allowed tool schemas to the tokenizer before generation; a tokenizer error blocks that generation request. When Redis is configured, a Lua-backed per-owner fixed-window counter is shared by service instances; repeated requests with the same session/idempotency key do not consume quota twice. Missing configured production dependencies fail startup.

The PostgreSQL store applies `service/migrations/001_initial.sql` on startup. It persists sessions, runs, events, worker tasks and owner-scoped memory. Idempotent run creation uses a transaction and unique session/key constraint; queue claims use `FOR UPDATE SKIP LOCKED` and a worker lease. The supported deployment target is one service instance with PostgreSQL durability and restart recovery. SQLite remains the test backend. The HTTP listener is Fastify 5 in both modes; the SQLite backend does not enable any mock-model fallback.

For the explicitly authorized official Flash workbench, the external private configuration selects `deepseek-flash`, non-thinking mode, `model_max_context_tokens: 32768` and `model_max_output_tokens: 1024`. The workbench launcher forwards these per-provider bounds; the general service default remains 8192 and the original Qwen configuration is unchanged. Run-level cumulative budgets are separate from the request context limit. Secrets remain outside the workspace; do not put the private config or model key in example files.

## HTTP API

Except `GET /healthz`, routes require `Authorization: Bearer …`. Each token maps to one owner. Run, session and memory lookups are owner-scoped; account memory is namespaced to that owner.

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Readiness and active-run count. |
| `GET /v1/sessions` | List the authenticated owner’s sessions. |
| `POST /v1/sessions` | Create a session from `{ "title": "…" }`. |
| `GET /v1/sessions/{id}?limit=50&before=…` | Restore session metadata and recent run history; `limit` is 1–100 and `before` is an ISO timestamp cursor. |
| `POST /v1/sessions/{id}/runs` | Queue `{prompt, mode?, budget?, memoryStrategy?, memoryQuery?}` with a required `Idempotency-Key`. `mode` is `single` or `multi`. `memoryStrategy` is `full_history` (bounded persisted turns and catalog evidence), `summary` (model-written session summary with source run IDs and measured or estimated token charge), `retrieval` (lexical retrieval over explicit owner-scoped session/account memory records), or `none`. The default is `full_history`; `memoryQuery` optionally narrows retrieval. The response is 202 for a new run and 200 for an identical replay; changed content with the same key is a conflict. |
| `GET /v1/runs/{id}` | Read run status, result and request. |
| `POST /v1/runs/{id}/cancel` | Cancel queued or active work. |
| `GET /v1/runs/{id}/events` | Stream durable SSE events; supports `Last-Event-ID` or `?after=` replay. |
| `GET /v1/sessions/{id}/memory?scope=session&q=…` | Search/list that session’s memory. Set `scope=account` for the authenticated owner’s long-term memory. |
| `PUT /v1/sessions/{id}/memory?scope=session` | Write `{id, value, ttlMs?, sourceRefs?}`. An omitted or zero TTL persists until deleted; positive `ttlMs` expires the value. |
| `DELETE /v1/sessions/{id}/memory?scope=session&id=…` | Delete one memory entry in the selected namespace. |
| `GET /v1/metrics` | Process counters and queue size; keep behind a trusted gateway. |

`full_history`, `summary`, `retrieval`, and `none` are explicit run-level choices. `full_history` carries a bounded structured projection of recent requests, explicit filters, stable product IDs and structured price/currency/availability/category fields, comparison values, and evidence IDs/refs. It omits prior assistant prose and raw product/source payloads; the full original responses remain in durable run and event records. Failed run status and user request remain visible without copying their raw failure output into the next model prompt. `summary` calls the configured planner model without tool schemas, records the source run IDs and model usage, and stores the resulting summary in session-scoped memory. Its prompt asks the model to preserve exact recent product IDs, titles and evidence/source IDs alongside structured constraints for later comparisons. `retrieval` reads only saved owner-scoped memory notes; account notes are included only when this strategy is selected. Ordinary runs do not silently save conversation text as account preference memory. Users explicitly create/update/delete session or account notes through the authenticated memory routes. Agents can call `memory_search` only when the run enables retrieval. Each run's worker receives its own task prompt, context IDs, finite budget and tool allowlist.

## Commerce toolset

With `MICRO_DSH_TOOLSET=commerce`, the model receives explicit read-only tools backed by SearchForge:

- `catalog_search_products` → `POST /v1/products/search` with `{query, filters?, limit?}`.
- `catalog_get_product` → `GET /v1/products/{id}`.
- `catalog_compare_products` → `POST /v1/products/compare` with `{product_ids}`.
- `catalog_get_catalog` → `GET /v1/catalog`. The tool accepts optional English `query` and `limit` (default 20, maximum 50) arguments. SearchForge still serves its unchanged full catalog; microDSH filters category and brand names locally and gives the model a bounded metadata projection with total/matched/returned counts, truncation flags, currencies, and source provenance. The complete upstream response, including all categories and brands, remains in the durable `tool.result` audit event.
- `memory_search` → owner-scoped session or account memory retrieval.

The model tool uses any-term lexical ranking, including CJK fragments, inside only its selected namespace; `headphones budget` can match a note containing `headphones`. Empty queries list at most eight visible entries. This is not embedding or semantic retrieval. Session is the default, and worker guidance prohibits switching to account scope when the user asked for session notes. The HTTP memory-list endpoint's `q` filter retains its original literal-substring behavior.

SearchForge replies use `{ok,data,evidence,request_id,catalog_revision}`. Responses are limited to 256 KB and redirects are rejected. Product descriptions are untrusted external text: system prompts prohibit following instructions found there. The catalog is primarily English, so the commerce prompt directs the model to translate non-English shopping intent into concise English terms, verify exact categories through `catalog_get_catalog`, and omit unsupported availability filters. In particular, `in_stock:false` means out of stock, while unknown is neither in-stock nor out-of-stock. A no-results response cannot justify invented products, IDs, prices, or placeholders. Price/currency and availability claims must use structured product fields; `unknown` availability must stay unknown. Product search, detail and comparison are read-only. This A1/A2 loop ends at product discovery and comparison; checkout, payment and order creation are outside this service.

The comparison tool gets a provider-facing projection: stable product IDs, structured comparison values, and every evidence ID/ref/summary are retained, while repeated source metadata and redundant product text are omitted. This projection is applied only to the model message. The complete SearchForge result, including source metadata and evidence metadata, remains in the durable `tool.result` event and worker result. Multi-agent synthesis likewise receives worker answers and compact evidence summaries; its `allowedCitationIds` is derived from exactly those projected evidence records. Commerce synthesis with worker evidence must cite at least one allowed ID, and every citation must belong to that same set.

The catalog tool also has a provider-facing projection: an optional short English substring query filters category and brand labels, and the requested per-list limit defaults to 20 (maximum 50). Its metadata data object is capped at 2500 UTF-8 bytes, with currencies capped at 10 entries and provenance at 3. Counts and truncation flags describe the full SearchForge catalog response, which remains intact in the durable audit event. The public SearchForge `/v1/catalog` contract and browser-facing API are unchanged.

Search and detail tools likewise use compact provider-facing views. All returned product rows, exact product identifiers, structured price/currency/stock/availability fields and evidence identifiers/references are retained; descriptive text and attribute counts are bounded. The detail adapter accepts SearchForge's actual `data.products` array as well as singular/flat compatible shapes. Identifiers are never shortened, including valid values longer than 180 characters. These projections do not alter the complete durable audit response.

Product and evidence projections retain the short source name and snapshot tag. A snapshot price must not be described as current or live without an explicit structured real-time observation. Comparison values retain their original shape; source objects alone receive the small provenance projection.

The legacy `technical` toolset retains the existing `/v1/search` adapter. Production must select a toolset and provide its matching dependency; one cannot silently fall back to another. The `coding` toolset uses an explicit host-configured repository and/or MCP providers rather than a SearchForge endpoint. See [TOOL_EXECUTION.md](TOOL_EXECUTION.md) and [MCP.md](MCP.md).

All service-native and configured MCP tools pass through the same pre-execution policy and `tool.policy`/`tool.call`/`tool.result` audit path. Unknown policies fail closed; approval-required tools are not dispatched. Each request persists the host execution profile; missing or changed profiles stop recovery with `TOOL_CONFIGURATION_CHANGED`. The service's generic coding answers are distinct from the strictly validated review-report CLI in [PR_REVIEW.md](PR_REVIEW.md).

## Multi-agent execution and recovery

The actual configured planner model, without any tool definitions, plans a validated 1–3 task DAG in `multi` mode. Each worker gets its own task prompt, task/context identifiers, a divided token/tool budget, dependency list and tool allowlist. The planner may further narrow worker tools; a requested tool outside the configured toolset fails validation, and the OpenAI-compatible adapter advertises only tools in the active worker's allowlist. Each worker's single-call output cap and provider context window are bounded. If `MICRO_DSH_TOKENIZER_URL` is configured, prompt counts include the exact wire messages and authorized tool schemas, and a failed or over-window preflight stops generation. Without it, the local fallback estimate remains approximate. The shared Supervisor runs only read-only tools concurrently and persists task state before dispatch. Worker results are synthesized through the configured planner model and citations are checked against evidence IDs produced by workers. A bounded `run.synthesis_response` event records raw synthesis text (up to 4,000 characters), finish reason and usage before parsing; length-truncated and invalid-citation outcomes are explicit. Citation membership does not prove semantic entailment.

For declared dependencies, the worker callback reads only successful records from the current Run/session/parent, projects their answers, recent tool outputs and evidence, and injects them as untrusted data. Missing or mismatched dependency records fail closed. A `run.dependency_context` event records the source task IDs and retained/omitted counts; raw tool results stay in audit.

Worker and planner/summary/synthesis model requests record metrics-only `model.request`, `model.response`, and `model.request_blocked` events. Without a tokenizer, the adapter estimates the actual wire messages and current allowed tool schemas and labels this approximate source. Actual provider usage, fallback estimates and charged usage are separate fields. Prompt plus requested completion is capped against both the request context and the remaining task/reservation; actual reported usage is checked afterward. Approximate preflight is not a guarantee of exact provider billing. A worker final response ending in `length` fails with `MODEL_OUTPUT_TRUNCATED`; a truncated session summary is rejected before persistence, retaining any earlier summary. Commerce responses request concise tables and a few relevant citations rather than complete tool traces.

Interrupted planning without a durable execution reservation fails closed because model usage is unknown. Once reserved, completed read-only workers can be recovered; uncertain interrupted attempts are charged their full finite reservation. PostgreSQL claims have leases; startup recovery handles runs left `running` by a stopped single instance. Cancellation stops waiting and propagates to providers/tools, but cannot reverse an already-started external operation. This logical allowlist and context separation is not an OS sandbox or a guarantee of multi-instance exactly-once execution.

## Verification boundary

The package-wide suite had 37 passing tests before the bounded-provider-projection change; the prior service regression and local PostgreSQL/Redis smoke are recorded in the existing receipt（历史材料未随源码分发；见[结果汇总](../RESULTS.md)）. The subsequent bounded-history, exact-tokenizer, commerce-guidance, synthesis-audit and opt-in DeepSeek request changes rebuilt successfully and passed 23 targeted adapter, model-config, service and upstream-adapter tests. These tests use fixtures; they did not contact a tokenizer/model endpoint or rerun the PostgreSQL/Redis smoke. The opt-in production adapter smoke requires `MICRO_DSH_RUN_ADAPTER_SMOKE=1`, `MICRO_DSH_DATABASE_URL` and `MICRO_DSH_REDIS_URL`; it does not call SearchForge or a real model endpoint. Live catalog integration, real-model quality, latency and GPU serving remain separate validation; no broad benchmark or paid API call is part of this implementation.

Later metadata and search/detail projection checks passed 13 and 14 targeted tests, respectively. The actual detail-array shape and long-identifier regressions each passed their affected test, with a successful build. Subsequent budget, truncation, dependency-dataflow, source-projection and multiword-memory repairs passed their affected regressions. These are overlapping targeted suites, not a new package-wide total.

The owning workbench's user-authorized Flash continuation passed the specified six Agent/memory cases plus browser execution/recovery, with real PostgreSQL/Redis/OpenSearch and learned retrieval services. Accepted cases had no blocked context/budget requests or truncated responses; the three-worker case used 12,641 actual provider tokens in its 24,576 budget. See SearchForge `docs/FLASH_BUSINESS_RESULTS_20261019.md` and its immutable attempt artifacts. This bounded functional result does not establish quality gains, latency/throughput benefits, or production capacity.
