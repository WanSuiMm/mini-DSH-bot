# Architecture and source map

```text
Electron main / WebContentsView ── preload IPC ── local Agent sidebar
             │                                 │
             └──── BrowserRuntime ← HarnessService / AgentLoop
                                      │
                 opt-in Jev routing ──┤── single Agent or bounded DAG
                                      │
                         ToolRegistry / MCP / execution guard
                                      │
                     model adapter · tools · owner-scoped memory

HTTP client → Go durable queue → TypeScript/Fastify worker
              SQLite/events      SQLite or PostgreSQL
```

| Responsibility | Source |
| --- | --- |
| Desktop window, tabs, page isolation, takeover | `desktop/main.mjs`, `desktop/preload.cjs`, `desktop/electron-driver.mjs` |
| Desktop Agent host and recovery journal | `desktop/backend.mjs`, `desktop/task-journal.mjs` |
| Model/tool turn pairing, budgets, telemetry | `src/core/agent-loop.ts`, `src/adapters/openai-compatible.ts` |
| Explicit tool runtime and scheduler port | `src/tools/registry.ts`, `src/adapters/deepseek-harness-tool-calls.ts` |
| Host-provided DAG execution | `src/multi_agent/supervisor.ts` (`Supervisor.run`) |
| Memory contracts and stores | `src/memory/`, `service/database.mjs`, `service/postgres-database.mjs`, `service/bot/store.mjs` |
| Authenticated session/run HTTP state machine | `service/server.mjs` (`HarnessService`), `service/fastify-server.mjs` |
| MCP and pre-execution checks | `service/tool-configuration.mjs`, `service/security/` |
| Go queue, idempotency and reconciliation | `runtime-go/internal/`, `runtime-go/cmd/` |

## Invariants

1. Only host-configured tools and narrowed task allowlists can execute. Jev decisions do not add capabilities.
2. A persisted task graph is validated for dependency cycles, linkage and aggregate budget before dispatch. Read-only classification controls concurrency; it is logical scoping, not OS isolation.
3. Caller token hashes identify owners. A Go worker uses separately configured upstream credentials; it does not forward arbitrary caller credentials.
4. Duplicate Run starts use an idempotency key and normalized request. Ambiguous starts remain `unknown` until explicit reconciliation.
5. SSE uses saved event IDs for replay. Replayed transport events are not a claim of exactly-once business effects.
6. Chromium Session persistence is application-scoped. Tabs use independent views; they do not each have an independent cookie partition.

Search/commerce integrations use configured external HTTP services. The optional legacy Python demo requires an explicit executable path; no surrounding portfolio directory is required for the desktop, Harness core or Go worker.
