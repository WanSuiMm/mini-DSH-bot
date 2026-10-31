# multi_agent

`supervisor.ts` 执行宿主提供的有界 DAG，处理只读并发、预算、依赖、失败与持久恢复，自身不生成任务图。服务层可使用配置的 planner 生成受校验的图。

`jev-choice-router.ts` 提供一次性有限候选选择；服务显式 `auto` 模式接到已有 single/multi 路径，不替代 Supervisor，也不授予工具权限。

整体执行流见 ../../docs/ARCHITECTURE.md。
