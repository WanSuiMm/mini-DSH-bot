# 长期 Web Bot

当前状态：`PERSISTENT_WEB_BOT_CPU_INTEGRATED_LIVE_PENDING`（2026-10-22）。这是建立在已有 C1 Harness 上的持久 Bot 控制面。先提供浏览器工作台，飞书不需要安装，本轮也未连接飞书账号。

## 已实现的使用流程

1. 在 Web 工作台创建有名称、角色和指令的 Bot；一个账号可以保留多个 Bot。
2. 向指定 Bot、会话发送任务。消息、任务、原始 C1 Session/Run ID 和结果确认状态保存到独立 SQLite/WAL 数据库。
3. 为每个 Bot 显式保存、查看或删除记忆笔记；笔记不自动从聊天中抽取，也不跨 Bot 注入。
4. 查看排队、执行、完成或待核对状态。重启后读取原 Run，不因为超时直接重新执行工具。
5. 创建例行任务。默认暂停；启用后按间隔产生任务，漏过多个周期时只补一条，避免重启后集中派发。

Web 结果具有稳定的确认键。浏览器重载后可重新读取，确认不是向外部渠道发送消息。Bot 暂停会停止新的领取；已运行的 C1 Run 需单独取消。

## 启动条件与命令

在本项目根目录先查看不执行的计划：

```powershell
node scripts/bot.mjs
```

默认示例 `configs/bot.example.json` 的 `execution_enabled` 为 `false`。此命令不读凭据值、不创建数据库、不启动服务或模型。

实际启用时，在工作区之外准备私密配置：显式开启执行；配置已有的 C1 Harness 地址和该服务认可的 owner；为每个 owner 指定不同的 Web/C1 环境变量名，并通过私密进程环境提供至少 32 字符的不同令牌。数据库位置相对于私密配置文件解析。随后：

```powershell
node scripts/bot.mjs --config PRIVATE_CONFIG_PATH --execute
```

工作台默认只监听 `127.0.0.1:8790`。打开该地址，在页面中输入 Web 令牌。令牌只保存在页面内存；刷新或退出后重新输入。C1 Harness 必须已独立配置，Bot 不会自动安装或启动模型。真实模型联调仍按后续授权执行。

运行需要已有的支持 `node:sqlite` 的 Node 环境；本轮 CPU 验收使用当前工作区环境。它是单实例、单写者实现，不能共享数据库启动多个 Bot 进程。

## 恢复规则

| 情况 | 处理 |
|---|---|
| 已持久化 Run ID | 按原 Session/Run 做 GET 核对，不重新 POST |
| 发起 Run 的结果未知 | 停在 `unknown`，显式核对原 `bot-<jobId>` 幂等键 |
| 原键查到 Run | 验证 owner、Session、原键后关联 |
| 原键未查到 | 用户显式恢复后，用相同 job/key 重试；C1 幂等保护迟到提交 |
| 创建 Session 的结果未知 | 保持未知；须提供并核对原 Session，再绑定 |
| 同会话的其它 Run | 即使 Session 相同，键不一致也不能用于恢复 |

查询依赖新增的只读 C1 接口：`GET /v1/sessions/{sessionId}/run-lookup?key=...`。权限仍由原 C1 owner 鉴权。应用层幂等不能撤销已经产生的外部工具副作用，不宣称跨系统 exactly-once。

## 有界运行

- 默认最多 2 条活动任务；队列全局 100、每 owner 20，配置有硬上限。领取采用全局 FIFO，同 Bot/会话串行，不宣称租户公平调度。
- CLI 默认最多保留 10,000 条任务；达到保留上限时拒绝新任务，**当前不自动清理历史**。长期部署前需要另行实现审核式导出/归档方案。
- 每 owner 最多 100 个 Bot；每 Bot 最多 16 条记忆、每条 2,000 字符，注入总量另设 6,000 字符上限，超出则失败，不静默截断。
- 输入和返回文本各限 12,000 字符。当前向 C1 提交单 Agent、`full_history` 运行，预算 4,096 token、4 次工具、30 秒；不是无限时长的后台 Agent。
- 例行任务最短间隔 5 分钟，每 Bot 最多 32 条，默认暂停。进程关闭后不保证准点触发。

## 接口与源码

接口均在 `/v1/bot` 下，除静态页面外要求 Bearer owner 鉴权：

| 路径 | 用途 |
|---|---|
| `/bots`、`/bots/{botId}/enabled` | Bot 建立、列表与暂停 |
| `/bots/{botId}/memory` | 分 Bot 的显式笔记 CRUD |
| `/messages`、`/jobs` | 幂等收件、持久任务和状态 |
| `/jobs/{id}/cancel`、`/reconcile`、`/resolve` | 取消及未知结果核对 |
| `/bots/{botId}/bind-session` | 核对并绑定创建结果未知的原会话 |
| `/outbox`、`/outbox/{id}/ack` | Web 结果读回和幂等确认 |
| `/schedules`、`/schedules/{id}/enabled` | 暂停式例行任务 |

实现：`service/bot/store.mjs`（持久状态与容量），`runtime.mjs`（派发/核对），`harness-client.mjs`（有界 HTTP），`server.mjs`（本地鉴权 API），`web-bot/`（中文页面），`scripts/bot.mjs`（默认禁用 CLI）。

## 本轮验证及边界

见 CPU 结果（历史材料未随源码分发；见[结果汇总](../RESULTS.md)）。真实 C1 服务代码与 Bot 控制面使用明确的确定性测试模型完成 33/33 项检查；没有真实模型/API、外部消息、GPU、训练或大规模评测。页面静态资源、CSP 和 API 已检查，浏览器视觉与真人操作未验收。

尚未交付的范围：飞书等外部消息适配、附件/个人文件管理、浏览器或桌面操作、虚拟机隔离、自动记忆提炼、长期运行可靠性/多实例/生产容量。已有 C1 多 Agent 和 MCP 能力保留，但这层 Bot 当前提交单 Agent 运行，不把其它路径的验收结果当作本路径实测。
