# 受控工具执行、MCP 与代码审查

## 执行入口

`ToolRegistry.execute` 是本轮统一执行边界。服务原生工具、代码审查工具和 MCP 工具都经过同一顺序：

1. 检查 Worker 工具白名单与取消状态。
2. 拷贝输入，防止异步路径检查期间被调用方替换。
3. 根据宿主注册的 `options.policy` 求值；未分类工具默认拒绝。
4. 持久化 `tool.policy`；审计失败停止派发。
5. 再检查取消，记录已脱敏的 `tool.call`，调用适配器。
6. 对结果做有限的敏感内容脱敏，记录 `tool.result`，再交给模型。

服务事件与原有队列、SSE、Worker DAG、工具配额、会话和记忆兼容。模型不能改宿主配置、根目录或授予自己权限。逻辑上的 `readOnly` 只影响调度；守卫开启时，必须同时具有宿主 `effect: read` 才能并行／恢复。

## 策略

`service/security/guard.mjs` 导出 `createExecutionGuard({workspaceRoot})`。决策为：

- `allow`：宿主认可的范围内只读能力。
- `deny`：无策略、越界、敏感路径、链接路径、不支持的可执行程序或非结构化命令。
- `approval`：写入、删除、Git 状态变更、未限定网络行为或不透明能力。当前服务返回 `TOOL_APPROVAL_REQUIRED`，**不派发操作**；尚无审批后恢复的网页流程。

路径检查涵盖工作区外访问、目录穿越、符号链接／Windows junction、NTFS alternate stream／设备路径，以及 `.ssh`、`.env*`、私钥和常用凭据位置。通用命令只接受结构化的 `git status` 及少量状态选项；`diff/show/cat-file` 的内容读取交给固定提交、逐路径检查的审查适配器。未开放任意 Shell、Python、PowerShell 或仓库脚本执行。

注册元数据示例：

```js
registry.register('read_document', readDocument, {
  readOnly: true,
  policy: { effect: 'read', source: 'native', pathFields: ['path'] },
});
```

`pathFields` 使用点分字段名，值可以是路径或路径数组。处理文件的适配器应在实际读取处再检查路径；策略检查不是文件描述符级隔离，不能证明消除了并发外部进程造成的 TOCTOU。

## 宿主配置与服务

新增 `MICRO_DSH_TOOLSET=coding`，使用独立的固定 Git 工作区；`MICRO_DSH_TOOL_CONFIG` 必须是宿主提供的绝对 JSON 路径，不能来自用户提示或模型工具参数。

配置顶层包含 `workspaceRoot`、可选 `review: {base, head}` 与可选 `mcp`。`base/head` 必须是实际完整 commit SHA；一个审查实例只绑定这一对版本。MCP 配置与接入见 [MCP.md](MCP.md)，代码审查见 [PR_REVIEW.md](PR_REVIEW.md)。

免费预检：

```powershell
node scripts/build.mjs
node scripts/check-tools.mjs --config D:/code/private/micro-dsh-tools.json
```

配置成功后，在既有模型、认证与数据库环境变量基础上启动 `node scripts/serve.mjs`。配置决定工具列表，工作模型仅看到 Worker 白名单内的 schema，规划模型不获得工具。运行请求仍使用现有 `/v1/sessions/{id}/runs`，支持 `single/multi`、预算和记忆策略。

每次请求保存 `executionProfile` 摘要。重启后若宿主配置、目标提交或工具 schema 改变，旧任务以 `TOOL_CONFIGURATION_CHANGED` 停止，避免在新权限下重放。升级前没有该摘要的待执行任务也停止，需要显式提交新的 Run；已有完成记录仍保留。直接构造带自定义 provider 的 `HarnessService` 时，宿主必须提供绑定实际能力的稳定摘要；配置加载器会自动生成。配置文件与凭据不得提交到仓库。

## 边界与验收

- MCP 的服务描述和 annotations 不授予权限，权限来自宿主允许列表。
- 宿主只能控制 MCP 请求是否发出，不能约束远端服务器内部的任意行为；服务器依旧是信任边界。
- 当前策略限制应用层工具调用，不提供 OS/container 沙箱或通用网络出站隔离。
- 脱敏覆盖已知凭据字段、常见 token 和 PEM 私钥形态，不能检测所有任意秘密。审查数据发送模型前也应只使用获准处理的仓库。
- 自动审查只生成本地报告，不自动向 GitHub 发布评论，不运行待审代码／测试，不自动修复或提交。

验收区分策略行为、实际 Git/MCP 协议联调和模型审查质量。有限测试的通过率不能当作通用安全保证或真实缺陷识别准确率；性能、审查准确率及模型效果需要单独的独立标注评测。
