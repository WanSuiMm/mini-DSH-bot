# telemetry

Supervisor 提供 EventRecord 回调；模型适配器与 AgentLoop 记录请求、工具和 token 用量事件，流式路径支持 TTFT/TPOT 与 provider cache token 字段。服务把事件存入自己的持久数据库并通过 SSE 读取。Jev 路由回执独立保留，未知用量不填为零。

这里没有独立指标服务；事件字段存在不代表每个模型或评测批次都已采集全部指标，也不代表性能收益已验证。

整体执行流见 ../../docs/ARCHITECTURE.md。
