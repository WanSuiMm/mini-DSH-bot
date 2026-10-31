# service

核心类型与 AgentLoop 保持独立；实际服务位于 `../../service/`。`HarnessService` 实现 Session/Run HTTP API、owner Bearer 鉴权、幂等请求、SSE 重放、持久队列与取消。Fastify 入口为 `../../scripts/serve.mjs`，Go 持久队列是独立的 HTTP facade。

可选 Jev `auto` 路由只接 TypeScript 服务入口；默认关闭，配置与验证边界见 `../../docs/JEV_AUTO_ROUTING.md`。

整体执行流见 ../../docs/ARCHITECTURE.md。
