# mini-DSH Browser 桌面版

本轮在 C1 内增加 Electron 45.1.0 / Chromium 桌面客户端。旧 Web 工作台和服务器
Playwright 执行方式保留；桌面模式直接显示真实网页，不以截图或 iframe 代替浏览器。
简历与既有实验结果没有改动。

## 使用

Windows x64 portable 包解压后，打开 `mini-DSH Browser.exe`；需要保留完整目录。
普通浏览无需模型服务。右上角配置完整的 Chat Completions URL、模型名与 API Key，
再从当前网页发起 Agent 任务。官方 DeepSeek 示例为
`https://api.deepseek.com/chat/completions` / `deepseek-flash`。
模型密钥只在当前应用进程内存中保存，退出后需要重新填写。

地址栏支持网址和搜索，支持新建／关闭／切换标签、前进后退、重新加载以及手动下载。
`Ctrl+L` 进入地址栏，`Ctrl+T` 新建标签，`Ctrl+W` 关闭标签，
`Ctrl+Shift+A` 切换 Agent 侧栏。网页新窗口在新标签页打开；Agent 不自动开启未知窗口。

登录态由应用自己的 Chromium persistent partition 保存，不读取或导入 Edge / Chrome
资料。窗口记录只保存标签 ID、标题、URL、当前标签及侧栏状态；登录 Cookie 和网站
storage 留在 Chromium 的应用数据目录中。网页服务器过期或撤销的登录无法恢复。

每个任务默认最多 15 分钟、64 次工具调用、65,536 累计 Token；单次上下文 32,768，
单次输出最多 4,096 Token。等待人工确认也计入任务期限。配置模型不会自动调用 API，
用户发起新任务或显式恢复后才会调用。

## 人工接管与恢复

Agent 和用户使用同一个 `WebContentsView`，不会另开一份后台网页假装接管。
每个标签同一时间只允许一个 Agent 浏览器会话。操作默认限于任务开始时的站点，
导航、输入、点击等操作仍需按实际请求哈希确认。

点击「人工接管」、聚焦地址栏或尝试在 Agent 页中输入，会先切断后续 Agent 派发并使
旧引用／旧审批失效。第一下触发接管的页面输入被拦下，之后可正常手动操作。
在同一进程内恢复任务时，使用原 Run，必须重新观察页面；旧操作不能直接接着派发。
已经发出的网络请求不能靠接管按钮撤销。

Agent 的点击采用经审核、重新校验元素身份的固定 DOM click，回执明确标为
`clickMechanism=dom` / `trustedInput=false`；不声称它是硬件鼠标事件。这样避免
Windows 原生注入偶发未投递，却被当作完成的问题。要求可信用户手势的网站功能仍需
人工接管；点击返回本身也不代表业务提交成功，必须读回页面或业务记录。

退出应用会保存记录和浏览器 storage。重新启动后：

- 未开始执行的安全队列任务保留原任务、Run、请求幂等键，配置模型后仍保持暂停，
  只有点击恢复才进入队列。
- 取消过的任务保持取消，不重新执行。
- 已进入不确定模型／工具步骤或可能产生外部写入的任务要求人工核对，不能透明续跑。
  不恢复原 JavaScript 堆、活 DOM、未完成网络请求或第三方已过期登录。

当前实现不是断电后任意 Agent 步骤的透明 checkpoint，也不保证任意网站 exactly-once。
桌面模式可插入原服务的工具接口；本轮实际启用的是五个浏览器工具，未声称额外 MCP
服务器已经在桌面端联调。

## 架构和代码

| 位置 | 职责 |
|---|---|
| `desktop/main.mjs` | 窗口、真实网页视图、多标签、输入接管、权限、下载、关闭顺序 |
| `desktop/preload.cjs` | 仅向本地 UI 暴露窄 IPC；验证调用来源在主进程完成 |
| `desktop/ui` | 地址栏、标签、任务／审批／恢复侧栏；没有截图视口 |
| `desktop/electron-driver.mjs` | 复用 BrowserRuntime 契约；固定隔离世界程序、短期元素 ref |
| `desktop/backend.mjs` | 复用 HarnessService / AgentLoop / 模型适配器、审核及取消；不监听 HTTP |
| `desktop/task-journal.mjs` | 共享 ServiceDatabase 的 SQLite 控制面、任务键、恢复状态 |
| `desktop/browser-state.mjs` | 应用目录中的原子窗口 metadata 保存 |

网页启用 sandbox / contextIsolation，禁用 Node integration，不安装远程 preload；
第三方页面不取得桌面 IPC、模型密钥或文件工具权限。允许站点是 Agent 页面操作边界，
不是全网络出站隔离：网站子资源、fetch、WebSocket 不等价于一个完整出网防火墙。
普通浏览和网站内容安全没有通过此轮功能检查获得全面保证。

Electron 原生网页承载与会话的实现依据：
[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)、
[persistent session](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options)、
[远程内容隔离建议](https://www.electronjs.org/docs/latest/tutorial/security#isolation-for-untrusted-content)。

## 源码启动与打包

从项目根目录安装已有后端依赖并构建 `dist`，随后安装 desktop 的独立 Electron 依赖。
这些命令供具备相应执行授权的环境使用；工作区本机实验限制不因本文件而解除。

```text
npm install --ignore-scripts
node scripts/build.mjs
npm --prefix desktop install
npm --prefix desktop start
```

Windows portable 打包脚本 `scripts/package-desktop.mjs` 只复制明确的运行源码、
编译产物、生产依赖和官方 Electron 发行包；不复制评测数据、私有配置、模型 Key、
数据库或用户 profile。打包不等于 Windows 实机验收。

实际验证结果、未通过项和服务器环境限制见
`benchmarks/desktop_browser_20261029/RESULTS.md`。
