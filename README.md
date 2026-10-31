# mini-DSH-bot

内置 Agent 侧栏的 Chromium 桌面浏览器，以及可单独部署的 TypeScript Agent Harness 和 Go 任务服务。普通浏览、多标签、登录态保存与 Agent 使用同一个真实网页视图；执行过程保留工具回执、人工确认、取消和恢复状态。

项目参考 DeepSeek Harness 的工具调度，自己实现 Electron 宿主、MCP 接线、执行守卫、Supervisor–Worker DAG、记忆与持久任务控制面。上游移植范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Grok Bot 仅为产品交互参考，没有复用其代码。

## 项目时间线（作者提供）

主体开发时间为 2026.02—2026.05，Jev 路由扩展时间为 2026.09—2026.10；后续路由耗时自测与早期主体开发分开记录，见 [RESULTS.md](RESULTS.md)。

## 从这里开始

1. [ARCHITECTURE.md](ARCHITECTURE.md)：桌面、模型、工具、任务与存储的责任边界。
2. [GPT_CONTEXT.md](GPT_CONTEXT.md)：核心符号、审查问题及哪些功能尚未验证。
3. [RESULTS.md](RESULTS.md)：已有检查、失败记录与用户补报结果分列。
4. [docs/JEV_AUTO_ROUTING.md](docs/JEV_AUTO_ROUTING.md)：可选 Jev 任务分流、回退和调用边界。

## 能做什么

- **桌面浏览**：Electron `WebContentsView` 多标签、应用级持久 Session、地址栏和 Agent 侧栏；第三方网页与本地 IPC 隔离。
- **Agent 执行**：结构化工具调用、MCP stdio / Streamable HTTP、工具白名单、受限只读并发、超时与取消。权限检查由代码执行。
- **多 Agent 与记忆**：宿主提交的 DAG、依赖结果传递、独立上下文和预算；会话／账户记忆命名空间、TTL、显式笔记与检索。
- **持久控制面**：Fastify API、SQLite/PostgreSQL、SSE 重放、幂等 Run；Go SQLite 队列提供 owner 配额和不确定提交的显式对账。
- **可选 Jev 路由**：在明确启用的入口作一次结构化选择，保留单 Agent／多 Agent的显式模式。它不替代 DAG 调度、权限检查或人工审批。作者于 2026-10-31 补报的同配置自测显示路由决策耗时降低 46%；该结果只涉及路由决策阶段，不代表端到端延迟改善。样本数、绝对耗时、均值/P50/P95 和基线路由类别未提供，详见 [RESULTS.md](RESULTS.md)。

## 安装与桌面启动

需要 Node.js 22.19+、npm；Electron 图形环境单独安装。Windows 支持的源码入口：

```sh
npm install --ignore-scripts
npm run build
npm --prefix desktop install
npm --prefix desktop start
```

模型 URL、模型 ID 和 Key 在桌面设置中由操作者填写；普通浏览无需模型。Key 只在应用进程内存中保存，仓库不附账号、数据库或浏览器 profile。默认不自动开始任务。

服务端配置见 [docs/SERVICE.md](docs/SERVICE.md)，Go 队列配置见 [docs/GO_RUNTIME.md](docs/GO_RUNTIME.md)。生产环境须自行提供数据库、认证映射及工具配置；桌面入口不要求部署 Java 或其他工作区项目。`browser-ui/` 是独立的 React/Vite Web 工作台，与 Electron 原生桌面 UI 分开。

## 开发验证

```sh
npm run typecheck
npm test
cd runtime-go
go test ./...
```

`npm test` 的模型为 fixture，不读取 API Key，不调用外部计费模型。历史 Python SearchForge 双 Worker 集成用例为显式 opt-in：单独安装相应工具后设置 `SEARCHFORGE_TOOL_SCRIPT`；没有配置时该用例跳过，不把跳过当作验证通过。Jev 测试使用注入的 mock transport。真实模型、桌面图形和 PostgreSQL/Redis 检查分别执行，不由默认命令自动开启。

## 恢复与边界

人工接管后重新观察页面；已发出的外部请求不能撤销。重启只恢复持久状态和可安全重排的任务，不恢复 JavaScript 堆、DOM 或任意步骤。未知副作用进入核对流程，不自动重放。当前不承诺分布式 exactly-once、任意网站操作成功率或多日生产可用性。

公开包不含语料、浏览器登录态、原始任务对话、模型缓存和私有运行日志。`SOURCE_MANIFEST.json` 记录来源相对路径、源码哈希和打包适配；原始实验在本地保留。项目自有代码尚未指定统一再许可条款，第三方部分遵守各自通知。
