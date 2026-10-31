# memory

`InMemoryMemoryStore` 的公共入口为 `store.ts`，支持命名空间、CRUD、TTL、sourceRefs 和文本检索。CLI 的 JSON 持久化在 `scripts/host.mjs`；服务端 SQLite/PostgreSQL 的 owner 记忆存储在 `service/`。检索记忆不等于语义向量或分布式 Memory。

整体执行流见 ../../docs/ARCHITECTURE.md。
