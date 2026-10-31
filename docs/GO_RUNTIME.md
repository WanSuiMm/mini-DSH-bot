# Go C1 runtime

`runtime-go` is the durable bounded queue in front of the existing TypeScript C1 Harness service. The TypeScript service still performs every model request and tool call. Go persists caller sessions and run jobs in SQLite, applies owner quotas, dispatches queued requests to the configured C1 HTTP endpoint, forwards the upstream run result, and records a local event stream.

## Start

Build or run the Go service from `project_micro_DSH/runtime-go` with Go 1.24 or later. Runtime configuration is JSON loaded from the file path in `DSH_RUNTIME_CONFIG`; keep that file outside the repository and readable only by the service account. It contains these fields:

- `listen`: HTTP address; defaults to `127.0.0.1:8787`.
- `database`: SQLite file path; relative paths resolve beside the config file.
- `c1_base_url`: origin of the real TypeScript C1 HTTP service.
- `auth_tokens`: private caller bearer token to owner ID mapping.
- `worker_tokens`: trusted owner ID to C1 worker bearer token mapping.
- `workers`, `max_queued`, `max_queued_per_owner`, `max_active_per_owner`: bounded scheduler limits.
- `max_body_bytes`, `poll_interval_ms`, `upstream_timeout_ms`: request and polling limits.

The Go service never forwards the incoming caller token. It selects a separately configured worker token for the authenticated owner. Configuration errors and HTTP errors do not include token values, and the service does not log request headers or credentials. Run one Go process per SQLite database file.

## CreatorDesk-compatible API

Every endpoint except `/healthz` requires `Authorization: Bearer …` with a token configured in `auth_tokens`.

| Request | Response |
| --- | --- |
| `POST /v1/sessions` with `{ "title": "…" }` | `201 { "id", "title", "created" }`; the Go session ID maps privately to a real C1 session ID. |
| `POST /v1/sessions/{id}/runs` with `{ "prompt", "mode", "memoryStrategy", "budget" }` and `Idempotency-Key` | `202 { "run": {…}, "replayed": false }`; same key and normalized request returns `200` with the existing run. Reusing the key with a different request returns `409`. |
| `GET /v1/runs/{id}` | Run object with Go `id` and `session_id`, status, request, timestamps, and the C1 `result` once complete. |
| `GET /v1/runs/{id}/events?after=N` | A replayable SSE snapshot. Each frame has a local numeric `id`, matching `event` and JSON `type`, plus `runId`, `payload`, and `created`. `Last-Event-ID` is also supported. |
| `POST /v1/runs/{id}/cancel` | `200 { "status": … }`; queued jobs cancel before dispatch, and known C1 runs receive C1 cancellation. |
| `POST /v1/runs/{id}/reconcile` | Explicit recovery for `unknown` runs. It first calls C1 `run-lookup` with the original session and idempotency key. A found run is attached and polled. If absent, Go may submit the same original key only when the job was not cancelled. |
| `GET /v1/sessions/{id}/run-lookup?key=…` | C1-compatible `{ "found", "run" }` response scoped to the authenticated owner. |
| `GET /v1/metrics` | Request/error counters and that owner's queued, active, and unknown run counts. |

The normalized request defaults match the TypeScript service: single mode, full-history memory, and bounded token/tool/duration/child budgets. Prompts are capped at 40,000 characters, request bodies at the configured byte limit, keys at 128 printable ASCII characters, and the C1 budget ceilings are enforced before queue insertion.

## Recovery and cancellation

Run rows and events are committed to SQLite before dispatch. A worker claims a run with a fresh persisted claim token; cancellation changes the durable dispatch state, and restart clears stale claim tokens. A stale worker cannot reopen a cancelled run or launch it after recovery. The C1 call uses the caller's original idempotency key.

If a start response is ambiguous, Go records `unknown` and does not retry automatically. After restart, a user or operator must call `/reconcile`. Go first asks C1 whether the original key already created a run. It attaches a found run rather than creating a second one. If the lookup is absent, Go can reissue the request with the same key; if cancellation was requested while the run was unknown, Go marks it cancelled and does not submit it. Ambiguous outcomes stay visible as `unknown` until reconciled.

The scheduler bounds total workers, queued jobs, queued jobs per owner, and active jobs per owner. SQLite is the durable source for run state and event replay; worker-local state is only the in-flight HTTP operation. `/healthz` and `/v1/metrics` report software state, not C1 model quality, external capacity, or scientific performance.

This facade implements the execution API subset, not every Bot/Memory route of the TypeScript service. Session creation has no upstream idempotency primitive: a lost create response or a local mapping-write failure can leave an unused upstream session. It does not launch a model run by itself, but exactly-once session creation is not claimed. Run starts have the separate durable key/reconciliation protocol above. The SQLite runtime is single-instance, without a distributed worker lease or multi-host scheduling claim.

## Verification

From `runtime-go`, `go test ./...` runs six CPU-only Go tests against SQLite and an explicit `httptest` C1 worker. They cover the wire contract, owner separation, same-key conflicts, queue quotas, event replay and failed-event cursor recovery, ambiguous-start restart recovery, and cancellation with a stale dispatch token. These tests make no model or external API calls.

The persistent final test output is here（历史材料未随源码分发；见[结果汇总](../RESULTS.md)）. The separate real service-chain report（历史材料未随源码分发；见[结果汇总](../RESULTS.md)） verifies Go to the actual TypeScript/Fastify worker, Java CreatorDesk/content and Python search, including completed-run restart and event replay; its model is an explicit CPU preset. Host-local toolchain and offline cache configuration are in the stack runbook（历史材料未随源码分发；见[结果汇总](../RESULTS.md)）.
