# context

`task-context.ts` 负责授权引用筛选与独立消息构建；服务层另有显式 full-history、模型摘要和检索记忆策略。AgentLoop 不隐式读取外部文件或其他任务记忆；压缩后的内容仍需服从来源与权限边界。

整体执行流见 ../../docs/ARCHITECTURE.md。
