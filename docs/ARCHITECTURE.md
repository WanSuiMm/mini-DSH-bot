# micro-DSH 执行架构

真实服务层及持久化、鉴权、SSE、恢复边界见 [SERVICE.md](SERVICE.md)。生产 HTTP transport 与本地 fixture HTTP 服务共用 HarnessService 状态机；生产入口不会使用脚本模型回退。

```text
Browser → Fastify → HarnessService → SQLite test store / PostgreSQL production store
                         ↓ authenticated session/run, durable queue + SSE
                 configured real ModelAdapter
                         ↓ model planned DAG
                   Supervisor → TaskStore / events
                         ↓ per-worker prompt + budget + allowedTools
                     AgentLoop → ToolRegistry → host policy + redacted audit
                         ↓ commerce catalog / pinned Git review / approved MCP + owner-scoped Memory
                  ResultEnvelope / evidence / synthesis
```

| 模块 | 实际入口 | 职责 |
| --- | --- | --- |
| 公共契约 | src/contracts.ts | 任务、预算、结果、Memory、模型与工具端口 |
| Agent Loop | src/core/agent-loop.ts | 有界模型/工具循环与响应配对 |
| 工具 | src/tools/registry.ts | 注册、白名单、只读元数据与错误封装 |
| 上下文 | src/context/task-context.ts | 从显式授权引用建立独立任务消息 |
| Memory | src/memory/store.ts | 命名空间、CRUD、TTL、来源与文本检索 |
| 多 Agent | src/multi_agent/supervisor.ts | DAG、并发、依赖、重试边界和恢复 |
| Session | src/session/task-store.ts、event-journal.ts | 可序列化任务与事件 |
| 共享服务状态机 | service/server.mjs | 鉴权、会话/Run/Memory API、真实模型编排、工具、SSE、取消和恢复 |
| HTTP transport | service/fastify-server.mjs、scripts/serve.mjs | Fastify production entry，共用 HarnessService 路由与状态机 |
| Store adapters | service/database.mjs、service/postgres-database.mjs | SQLite test backend、PostgreSQL migrations/transactions/queue leases |
| Commerce tools | service/server.mjs::configuredModel / HarnessService.execute | SearchForge search/detail/compare/catalog API and structured evidence |
| Node host/demo | scripts/host.mjs、scripts/demo.mjs | Legacy technical-search subprocess and deterministic offline recovery demo |

任务终态包括 succeeded、failed、cancelled、timed_out；依赖失败不执行，父任务可返回 partial。生产 `multi` run 由选定模型规划 DAG，planner 必须为每个 Worker 给出 configured toolset 内的工具 allowlist；Worker 各自有提示、预算、依赖和上下文。成功子任务在恢复时复用；commerce 子任务只暴露只读目录与 Memory 查询能力。

每个 Worker 单独接收工具白名单、contextRefs、预算与 AbortSignal。框架终止等待无法撤回任意工具的既有副作用；SearchForge HTTP 请求随取消信号终止。Memory namespace 由 owner/session 路由固定，支持账户和会话作用域及 TTL；PostgreSQL 单实例生产 store 持久化版本、队列、事件与任务，SQLite 为测试后端。

离线 demo 的任务图由宿主输入，生产 multi mode 才调用配置模型规划。当前不支持并行写工具、OS 进程隔离或多实例 exactly-once。真实模型与 live catalog 的端到端业务闭环及效果对照仍待目标环境验证。
