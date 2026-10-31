# session

此处实现 TaskStore、SessionStore 与 EventJournal 的内存契约／实现；CLI JSON Checkpoint 位于 `scripts/host.mjs`。服务端另用 SQLite/PostgreSQL 保存 Session、Run、事件和任务状态，Go facade 有自己的 SQLite 队列。不同持久化入口不共享数据库，不承诺恢复任意浏览器步骤。

整体执行流见 ../../docs/ARCHITECTURE.md。
