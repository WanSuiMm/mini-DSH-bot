(() => {
"use strict";

const EMPTY_STATE = {
  tabs: [],
  activeTabId: null,
  sidebarOpen: true,
  backend: { configured: false, model: "", status: "disconnected" },
  tasks: [],
  downloads: [],
};

const glyphs = {
  plus: ["M12 5v14", "M5 12h14"],
  back: ["m15 18-6-6 6-6", "M20 12H9"],
  forward: ["m9 18 6-6-6-6", "M4 12h11"],
  reload: ["M20 7v5h-5", "M19 12a7 7 0 0 0-12-4.8L5 9", "M4 17v-5h5", "M5 12a7 7 0 0 0 12 4.8L19 15"],
  stop: ["M7 7h10v10H7z"],
  close: ["m18 6-12 12", "m6 6 12 12"],
  globe: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 1 1 8 0v4", "M12 15v2"],
  sparkles: ["m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z", "m19 14 .9 2.9L23 18l-3.1.9L19 22l-.9-3.1L15 18l3.1-1.1L19 14Z"],
  settings: ["M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z", "m19.4 15 .1.1 1.1.9-1.1 1.9-1.3-.5a7.7 7.7 0 0 1-1.5.9l-.2 1.4h-2.2l-.2-1.4a7.7 7.7 0 0 1-1.5-.9l-1.3.5-1.1-1.9 1.1-.9a7.6 7.6 0 0 1 0-1.8l-1.1-.9 1.1-1.9 1.3.5a7.7 7.7 0 0 1 1.5-.9l.2-1.4h2.2l.2 1.4a7.7 7.7 0 0 1 1.5.9l1.3-.5 1.1 1.9-1.1.9a7.6 7.6 0 0 1 0 1.8Z", "M5.7 8.2a5.5 5.5 0 0 0-1.4 1.1L3 8.8 2 10.5l1 1a5.7 5.7 0 0 0 0 1.5l-1 .9L3 15.7l1.3-.5a5.5 5.5 0 0 0 1.4.8l.2 1.4h2l.2-1.4"],
  shield: ["M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z", "m9 12 2 2 4-4"],
  hand: ["M8 12V5a1.6 1.6 0 0 1 3.2 0v6", "M11.2 10V4.5a1.6 1.6 0 0 1 3.2 0V11", "M14.4 10V6a1.6 1.6 0 0 1 3.2 0v7", "M8 11.5l-1.2-1.1a1.8 1.8 0 0 0-2.6 2.5l4.2 5a5.7 5.7 0 0 0 4.4 2.1h1.5a5.3 5.3 0 0 0 5.3-5.3V12a1.6 1.6 0 0 0-3.2 0"],
  play: ["m8 5 12 7-12 7V5Z"],
  pause: ["M8 5v14", "M16 5v14"],
  check: ["m5 12 4 4L19 6"],
  alert: ["M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z", "M12 9v4", "M12 17h.01"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 6v6l4 2"],
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 11v5", "M12 7h.01"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
  "arrow-up": ["M12 19V5", "m5 12 7-7 7 7"],
  "arrow-right": ["M5 12h14", "m12 5 7 7-7 7"],
  enter: ["M7 17 17 7", "M8 7h9v9"],
  link: ["M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7", "M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"],
  layers: ["m12 2 9 5-9 5-9-5 9-5Z", "m3 12 9 5 9-5", "m3 17 9 5 9-5"],
  key: ["M21 2 11 12", "M7 8a4 4 0 1 0 4 4", "M14 9l3 3", "M17 6l3 3"],
  "chevron-down": ["m6 9 6 6 6-6"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.3-4.3"],
  page: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M8 13h8", "M8 17h8"],
};

const node = id => document.getElementById(id);
const state = { ...EMPTY_STATE };
const desktop = window.desktop;
const addressInput = node("address-input");
const settingsDialog = node("settings-dialog");
const settingsError = node("settings-error");
let unsubscribe = null;
let resizeObserver = null;
let lastBoundsKey = "";
let toastTimer = 0;
let pendingAddress = "";
let pendingAddressTimer = 0;
let rememberedBaseUrl = "";
let priorActiveTabId = null;
let lastNoticeKey = "";

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of glyphs[name] ?? glyphs.globe) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll(".icon-slot[data-icon]")) {
    if (!slot.firstChild) slot.append(icon(slot.dataset.icon));
  }
}

function safeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const result = String(value).trim();
  return result || fallback;
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function setButtonState(button, disabled, title) {
  button.disabled = Boolean(disabled);
  if (title) button.title = title;
}

function currentTab() {
  return state.tabs.find(tab => String(tab.id) === String(state.activeTabId)) ?? null;
}

function currentTasks() {
  const tab = currentTab();
  if (!tab) return state.tasks;
  return state.tasks.filter(task => task.tabId === undefined || task.tabId === null || String(task.tabId) === String(tab.id));
}

function tabLabel(tab) {
  const title = safeText(tab.title);
  if (title && title.toLowerCase() !== "about:blank") return title;
  if (tab.url && tab.url !== "about:blank") {
    try { return new URL(tab.url).hostname || tab.url; } catch { return tab.url; }
  }
  return "新标签页";
}

function setState(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const next = snapshot.state && typeof snapshot.state === "object" ? snapshot.state : snapshot;
  if (Array.isArray(next.tabs)) state.tabs = next.tabs;
  if (Object.prototype.hasOwnProperty.call(next, "activeTabId")) state.activeTabId = next.activeTabId;
  if (Object.prototype.hasOwnProperty.call(next, "sidebarOpen")) state.sidebarOpen = next.sidebarOpen;
  if (next.backend && typeof next.backend === "object") state.backend = { ...EMPTY_STATE.backend, ...next.backend };
  if (Array.isArray(next.tasks)) state.tasks = next.tasks;
  if (Array.isArray(next.downloads)) state.downloads = next.downloads;
  if (Object.prototype.hasOwnProperty.call(next, "notice")) state.notice = next.notice;
  state.activeTabId = state.activeTabId ?? state.tabs[0]?.id ?? null;
  render();
}

function toast(message, kind = "info") {
  const region = node("toast-region");
  region.replaceChildren();
  const item = make("div", `toast-message${kind === "error" ? " is-error" : ""}`);
  const glyph = make("span", "icon-slot");
  glyph.append(icon(kind === "error" ? "alert" : "info"));
  item.append(glyph, make("span", "", message));
  region.append(item);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => region.replaceChildren(), 5200);
}

function errorMessage(error) {
  return safeText(error?.message, "操作没有完成，请稍后重试。");
}

async function action(name, payload = {}, options = {}) {
  if (!desktop || typeof desktop.invoke !== "function") {
    const error = new Error("桌面连接尚未就绪，请稍后再试。");
    if (!options.silent) toast(error.message, "error");
    return { ok: false, error };
  }
  try {
    const result = await desktop.invoke(name, payload);
    if (result?.ok === false) throw new Error(safeText(result.error, "操作没有完成。"));
    if (result && (Array.isArray(result.tabs) || result.state)) setState(result);
    return { ok: true, result };
  } catch (error) {
    if (!options.silent) toast(errorMessage(error), "error");
    return { ok: false, error };
  }
}

function renderTabs() {
  const list = node("tab-list");
  list.replaceChildren();
  for (const tab of state.tabs) {
    const active = String(tab.id) === String(state.activeTabId);
    const tabButton = make("button", `browser-tab${active ? " is-active" : ""}${tab.loading ? " is-loading" : ""}`);
    tabButton.type = "button";
    tabButton.setAttribute("role", "tab");
    tabButton.setAttribute("aria-selected", String(active));
    tabButton.setAttribute("aria-controls", "page-host");
    tabButton.setAttribute("data-action", "tab-activate");
    tabButton.setAttribute("data-id", String(tab.id));
    tabButton.title = safeText(tab.title, safeText(tab.url, "新标签页"));

    const favicon = make("span", "tab-favicon");
    favicon.append(icon("globe"));
    const title = make("span", "tab-title", tabLabel(tab));
    const close = make("button", "tab-close");
    close.type = "button";
    close.setAttribute("data-action", "tab-close");
    close.setAttribute("data-id", String(tab.id));
    close.setAttribute("aria-label", `关闭标签页：${tabLabel(tab)}`);
    close.title = "关闭标签页";
    close.append(icon("close"));
    tabButton.append(favicon, title, close);
    list.append(tabButton);
  }
}

function renderAddress() {
  const tab = currentTab();
  const url = safeText(tab?.url);
  if (priorActiveTabId !== null && String(priorActiveTabId) !== String(state.activeTabId)) {
    pendingAddress = "";
    clearTimeout(pendingAddressTimer);
  }
  priorActiveTabId = state.activeTabId;
  if (pendingAddress && tab && (url === pendingAddress || safeText(tab.error))) {
    pendingAddress = "";
    clearTimeout(pendingAddressTimer);
  }
  if (document.activeElement !== addressInput) {
    addressInput.value = pendingAddress || (url === "about:blank" ? "" : url);
  }
  addressInput.disabled = !tab;
  const leading = node("address-leading");
  leading.classList.remove("is-secure", "is-insecure");
  leading.replaceChildren(icon("globe"));
  if (/^https:\/\//i.test(url)) {
    leading.classList.add("is-secure");
    leading.replaceChildren(icon("lock"));
  } else if (/^http:\/\//i.test(url)) {
    leading.classList.add("is-insecure");
  }
}

function renderNavigation() {
  const tab = currentTab();
  const loading = Boolean(tab?.loading);
  setButtonState(node("back-button"), !tab || !tab.canGoBack, tab?.canGoBack ? "后退" : "没有可返回的页面");
  setButtonState(node("forward-button"), !tab || !tab.canGoForward, tab?.canGoForward ? "前进" : "没有可前进的页面");
  node("reload-button").hidden = loading;
  node("stop-button").hidden = !loading;
  setButtonState(node("reload-button"), !tab, "重新加载");
  setButtonState(node("stop-button"), !tab || !loading, "停止加载");
  node("page-progress").hidden = !loading;
}

function renderConnection() {
  const backend = state.backend ?? EMPTY_STATE.backend;
  const chip = node("connection-chip");
  const label = node("connection-chip-label");
  const status = String(backend.status ?? "").toLowerCase();
  const isConfigured = Boolean(backend.configured);
  const hasError = status.includes("error") || Boolean(backend.error);
  chip.classList.toggle("is-connected", isConfigured && !hasError);
  chip.classList.toggle("is-error", hasError);
  const model = safeText(backend.model);
  label.textContent = isConfigured ? (model ? `已连接 · ${model}` : "Agent 已连接") : hasError ? "连接异常" : "Agent 未连接";
  chip.title = isConfigured ? `已连接到 ${model || "模型"}。点击修改连接设置。` : "浏览网页无需连接。点击设置内置 Agent。";
  node("agent-toggle").setAttribute("aria-pressed", String(state.sidebarOpen !== false));
  node("app-shell").classList.toggle("sidebar-hidden", state.sidebarOpen === false);
}

function statusInfo(task) {
  const status = safeText(task.status).toLowerCase().replace(/[ -]/g, "_");
  if (status === "interrupted") return { label: "执行已中断", css: "is-waiting", card: "" };
  if (status === "recovery_required") return { label: "请先核对网页结果", css: "is-error", card: "task-card-failed" };
  if (["succeeded", "success", "completed", "complete", "done"].includes(status)) return { label: "已完成", css: "is-success", card: "task-card-completed" };
  if (["failed", "error", "cancelled", "canceled", "timed_out", "unknown"].includes(status)) return { label: status === "cancelled" || status === "canceled" ? "已取消" : "未完成", css: "is-error", card: "task-card-failed" };
  if (["waiting", "queued", "pending", "pending_approval", "awaiting_approval", "requires_approval", "paused", "recoverable"].includes(status)) return { label: status.includes("approval") ? "等待确认" : status === "queued" || status === "pending" ? "排队中" : "已暂停", css: "is-waiting", card: "" };
  return { label: "执行中", css: "is-running", card: "task-card-active" };
}

function isActiveTask(task) {
  const info = statusInfo(task);
  return info.css === "is-running" || info.css === "is-waiting";
}

function taskStatusElement(task) {
  const info = statusInfo(task);
  const status = make("span", `task-status ${info.css}`);
  status.append(make("span", "task-status-dot"), make("span", "", info.label));
  return status;
}

function renderTaskCard(task, showRecovery = false) {
  const info = statusInfo(task);
  const card = make("article", `task-card ${info.card}`.trim());
  const top = make("div", "task-card-top");
  top.append(taskStatusElement(task));
  if (state.backend?.model) top.append(make("span", "task-model", state.backend.model));
  card.append(top);

  const prompt = safeText(task.prompt, "网页任务");
  card.append(make("p", "task-prompt", prompt));
  if (safeText(task.output)) {
    const outputLabel = make("div", "task-output-label");
    outputLabel.append(icon("page"), make("span", "", "Agent 回复"));
    card.append(outputLabel, make("pre", "task-output", task.output));
  }
  if (safeText(task.error)) card.append(make("p", "task-error", task.error));
  if (showRecovery && task.recoverable) {
    const recover = make("button", "task-recover", "恢复任务");
    recover.type = "button";
    recover.dataset.action = "agent-recover";
    recover.dataset.id = String(task.id);
    recover.prepend(icon("play"));
    card.append(recover);
  }
  return card;
}

function pendingCommands(tasks) {
  const waiting = new Set(["pending", "pending_approval", "awaiting_approval", "approval_requested", "needs_approval", "requires_approval", "waiting_for_approval"]);
  return tasks.flatMap(task => (Array.isArray(task.commands) ? task.commands : [])
    .filter(command => waiting.has(String(command.status ?? "").toLowerCase()))
    .map(command => ({ ...command, taskId: task.id })));
}

function commandLabel(command) {
  const type = String(command.type ?? "").toLowerCase();
  const names = {
    navigate: "打开网页",
    browser_navigate: "打开网页",
    click: "点击页面元素",
    browser_click: "点击页面元素",
    fill: "填写内容",
    browser_fill: "填写内容",
    select: "选择页面选项",
    browser_select: "选择页面选项",
    press: "按下按键",
    browser_press: "按下按键",
    submit: "提交表单",
  };
  return names[type] ?? (type ? type.replace(/^browser_/, "").replace(/_/g, " ") : "网页操作");
}

function commandRequest(command) {
  if (command.request === undefined || command.request === null) return "未提供操作详情";
  if (typeof command.request === "string") return command.request;
  try { return JSON.stringify(command.request, null, 2); } catch { return "操作详情暂时无法显示"; }
}

function renderApproval(command) {
  const card = make("article", "approval-card");
  const top = make("div", "approval-card-top");
  const mark = make("span", "approval-kind-mark");
  mark.append(icon(command.type === "navigate" || command.type === "browser_navigate" ? "globe" : "page"));
  const copy = make("div", "approval-title-copy");
  copy.append(make("strong", "", commandLabel(command)), make("span", "", "Agent 已准备好这项操作"));
  top.append(mark, copy);
  card.append(top);

  const details = document.createElement("details");
  details.className = "approval-details";
  const summary = document.createElement("summary");
  summary.textContent = "查看具体内容";
  const request = make("pre", "approval-request", commandRequest(command));
  details.append(summary, request);
  card.append(details);

  const actions = make("div", "approval-actions");
  const approve = make("button", "approval-decision approve");
  approve.type = "button";
  approve.dataset.action = "agent-decision";
  approve.dataset.id = String(command.id);
  approve.dataset.decision = "approve";
  approve.dataset.hash = safeText(command.requestHash);
  approve.append(icon("check"), make("span", "", "允许一次"));
  approve.disabled = !safeText(command.requestHash);
  const reject = make("button", "approval-decision reject");
  reject.type = "button";
  reject.dataset.action = "agent-decision";
  reject.dataset.id = String(command.id);
  reject.dataset.decision = "reject";
  reject.dataset.hash = safeText(command.requestHash);
  reject.append(icon("close"), make("span", "", "拒绝"));
  reject.disabled = !safeText(command.requestHash);
  actions.append(approve, reject);
  card.append(actions);
  return card;
}

function renderTaskArea(tasks) {
  const list = node("task-list");
  list.replaceChildren();
  node("task-count").textContent = String(tasks.length);
  if (!tasks.length) {
    const empty = make("div", "task-empty");
    const mark = make("span", "task-empty-mark");
    mark.append(icon("page"));
    const copy = make("span", "task-empty-copy");
    copy.append(make("strong", "", "还没有任务"), make("span", "", state.backend?.configured ? "描述目标后，Agent 会在当前网页中协助你。" : "连接模型后，即可从当前网页发起任务。"));
    empty.append(mark, copy);
    list.append(empty);
  } else {
    for (const task of tasks.slice(0, 3)) list.append(renderTaskCard(task, true));
  }

  const commands = pendingCommands(tasks);
  node("approval-section").hidden = commands.length === 0;
  node("approval-count").textContent = String(commands.length);
  const approvalList = node("approval-list");
  approvalList.replaceChildren(...commands.slice(0, 8).map(renderApproval));

  const currentTabId = currentTab()?.id;
  const recoverable = state.tasks.filter(task => task.recoverable && (currentTabId === undefined || currentTabId === null || task.tabId === undefined || String(task.tabId) === String(currentTabId)));
  const recent = state.tasks.filter(task => !tasks.includes(task) && task.recoverable);
  node("recent-section").hidden = recoverable.length === 0 && recent.length === 0;
  const recentList = node("recent-list");
  recentList.replaceChildren();
  const remaining = [...new Set([...recoverable, ...recent])].filter(task => tasks[0]?.id !== task.id).slice(0, 3);
  for (const task of remaining) {
    const row = make("div", "recent-task");
    const copy = make("div", "recent-task-copy");
    const taskPrompt = safeText(task.prompt, "网页任务");
    copy.append(make("strong", "", taskPrompt), make("span", "", statusInfo(task).label));
    const recover = make("button", "task-recover", "恢复");
    recover.type = "button";
    recover.dataset.action = "agent-recover";
    recover.dataset.id = String(task.id);
    recover.prepend(icon("play"));
    row.append(copy, recover);
    recentList.append(row);
  }
}

function renderControls(tab, tasks) {
  const mode = tab?.agentMode === "agent" || tab?.agentMode === "paused" ? tab.agentMode : "human";
  const modeIndicator = node("mode-indicator");
  modeIndicator.classList.toggle("mode-agent", mode === "agent");
  modeIndicator.classList.toggle("mode-paused", mode === "paused");
  const labels = { human: "你正在浏览", agent: "Agent 正在操作", paused: "Agent 已暂停" };
  node("mode-label").textContent = labels[mode];
  node("browser-context").textContent = tab ? tabLabel(tab) : "暂无标签页";
  node("composer-context").textContent = tab ? tabLabel(tab) : "当前网页";

  const waiting = pendingCommands(tasks).length > 0;
  const captions = {
    human: "网页由你掌控。你可以继续浏览、登录并切换网页，或描述一个目标交给 Agent。",
    agent: waiting ? "Agent 正在等待你确认具体操作。核对网页与请求内容后，再决定是否允许。" : "Agent 正在当前标签页工作。你可以随时接管网页，自己继续浏览。",
    paused: "Agent 已暂停。你可以恢复当前任务，或取消它并继续手动浏览。",
  };
  node("control-caption").textContent = captions[mode];

  const actions = node("control-actions");
  actions.replaceChildren();
  const activeTask = tasks.find(isActiveTask);
  if (mode === "agent") {
    const takeover = make("button", "control-action control-action-primary", "人工接管");
    takeover.type = "button";
    takeover.dataset.action = "agent-takeover";
    takeover.append(icon("hand"));
    actions.append(takeover);
  } else if (mode === "paused") {
    const resume = make("button", "control-action control-action-primary", "恢复执行");
    resume.type = "button";
    resume.dataset.action = "agent-resume";
    resume.append(icon("play"));
    actions.append(resume);
  }
  if (activeTask && mode !== "human") {
    const cancel = make("button", "control-action control-action-danger", "取消任务");
    cancel.type = "button";
    cancel.dataset.action = "agent-cancel";
    cancel.append(icon("close"));
    actions.append(cancel);
  }
}

function renderComposer(tasks) {
  const configured = Boolean(state.backend?.configured);
  const mode = currentTab()?.agentMode === "agent" || currentTab()?.agentMode === "paused" ? currentTab().agentMode : "human";
  const busy = mode === "agent";
  const paused = mode === "paused";
  const prompt = node("prompt-input");
  prompt.disabled = !configured || busy || paused;
  if (!configured) prompt.placeholder = "连接模型后即可在当前网页开始任务";
  else if (busy) prompt.placeholder = "Agent 正在执行，接管后可提交新任务";
  else if (paused) prompt.placeholder = "恢复或取消当前任务后，再提交新任务";
  else prompt.placeholder = "例如：整理这个页面的要点，并附上来源链接";

  const button = node("submit-button");
  if (!configured) {
    button.disabled = false;
    node("submit-label").textContent = "连接 Agent";
  } else if (paused) {
    button.disabled = false;
    node("submit-label").textContent = "继续任务";
  } else if (busy) {
    button.disabled = true;
    node("submit-label").textContent = "执行中";
  } else {
    button.disabled = !safeText(prompt.value);
    node("submit-label").textContent = "开始任务";
  }

  const note = node("composer-note");
  note.classList.toggle("is-offline", !configured);
  const noteText = note.lastElementChild;
  if (noteText) noteText.textContent = configured ? (pendingCommands(tasks).length ? "逐项核对后再允许操作" : "重要操作会先显示给你确认") : "浏览网页不受此设置影响";
}

function renderFooter() {
  const tab = currentTab();
  const text = tab?.loading ? "正在加载网页…" : safeText(tab?.error, "网页就绪");
  node("page-status-text").textContent = text;
  const secure = /^https:\/\//i.test(safeText(tab?.url));
  node("page-status-mark").classList.toggle("is-secure", secure);

  const downloads = Array.isArray(state.downloads) ? state.downloads : [];
  const count = downloads.length;
  node("download-count").hidden = count === 0;
  node("download-count-text").textContent = count === 1 ? "1 个下载" : `${count} 个下载`;
}

function renderNotice() {
  const notice = state.notice;
  if (!notice) return;
  const message = typeof notice === "string" ? notice : safeText(notice.message ?? notice.text);
  const key = typeof notice === "string" ? notice : safeText(notice.id, message);
  if (message && key !== lastNoticeKey) {
    lastNoticeKey = key;
    toast(message, notice?.type === "error" ? "error" : "info");
  }
}

function render() {
  renderTabs();
  renderAddress();
  renderNavigation();
  renderConnection();
  const tab = currentTab();
  const tasks = currentTasks();
  renderControls(tab, tasks);
  renderTaskArea(tasks);
  renderComposer(tasks);
  renderFooter();
  renderNotice();
  requestAnimationFrame(reportPageBounds);
}

async function reportPageBounds() {
  const host = node("page-host");
  if (!host || !desktop || typeof desktop.invoke !== "function") return;
  const rect = host.getBoundingClientRect();
  const next = {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
  const key = `${next.x}:${next.y}:${next.width}:${next.height}`;
  if (key === lastBoundsKey || !next.width || !next.height) return;
  lastBoundsKey = key;
  await action("ui:bounds", { rect: next }, { silent: true });
}

function normalizeAddress(input) {
  const value = input.trim();
  if (!value) return "";
  if (/^(?:javascript|file|data|vbscript):/i.test(value)) return null;
  if (/^(https?:\/\/|about:blank$)/i.test(value)) return value;
  if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:[/?#]|$)/i.test(value)) return `http://${value}`;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  const looksLikeHost = !/\s/.test(value) && /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[^./\s]+\.[^/\s]+)(?::\d+)?(?:[/?#].*)?$/i.test(value);
  if (looksLikeHost) return `https://${value}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
}

function beginSettings() {
  if (settingsDialog.open) return;
  node("base-url-input").value = rememberedBaseUrl || "https://api.deepseek.com/chat/completions";
  node("model-input").value = safeText(state.backend?.model, "deepseek-flash");
  node("api-key-input").value = "";
  node("thinking-mode-input").value = safeText(state.backend?.thinkingMode, "disabled");
  settingsError.hidden = true;
  settingsError.textContent = "";
  settingsDialog.showModal();
  void action("ui:modal", { open: true }, { silent: true });
  window.setTimeout(() => node("base-url-input").focus(), 0);
}

function closeSettings() {
  node("api-key-input").value = "";
  settingsDialog.close();
}

async function saveSettings(event) {
  event.preventDefault();
  const baseUrl = node("base-url-input").value.trim();
  const model = node("model-input").value.trim();
  const apiKey = node("api-key-input").value;
  const thinkingMode = node("thinking-mode-input").value;
  if (!baseUrl || !model) {
    settingsError.textContent = "请填写接口地址和模型名称。";
    settingsError.hidden = false;
    return;
  }
  try {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("接口地址需使用 http 或 https。");
  } catch (error) {
    settingsError.textContent = safeText(error.message, "请检查接口地址格式。");
    settingsError.hidden = false;
    return;
  }
  const payload = { baseUrl, model, thinkingMode };
  if (apiKey) payload.apiKey = apiKey;
  node("api-key-input").value = "";
  node("settings-save").disabled = true;
  settingsError.hidden = true;
  const result = await action("agent:configure", payload, { silent: true });
  node("settings-save").disabled = false;
  if (!result.ok) {
    settingsError.textContent = errorMessage(result.error);
    settingsError.hidden = false;
    return;
  }
  rememberedBaseUrl = baseUrl;
  closeSettings();
  toast("Agent 连接设置已更新。");
}

function runDataAction(actionName, target) {
  const id = target.dataset.id;
  if (actionName === "tab-new") return action("tab:new", {});
  if (actionName === "tab-activate") return action("tab:activate", { id });
  if (actionName === "tab-close") return action("tab:close", { id });
  if (actionName === "tab-back") return action("tab:back", {});
  if (actionName === "tab-forward") return action("tab:forward", {});
  if (actionName === "tab-reload") return action("tab:reload", {});
  if (actionName === "tab-stop") return action("tab:stop", {});
  if (actionName === "sidebar-toggle") return action("sidebar:toggle", {});
  if (actionName === "open-settings") return beginSettings();
  if (actionName === "close-settings") return closeSettings();
  if (actionName === "agent-takeover") return action("agent:takeover", {});
  if (actionName === "agent-resume") return action("agent:resume", {});
  if (actionName === "agent-cancel") return action("agent:cancel", {});
  if (actionName === "agent-recover") return action("agent:recover", { taskId: id });
  if (actionName === "agent-decision") {
    return action("agent:decision", { commandId: id, decision: target.dataset.decision, requestHash: target.dataset.hash });
  }
  return undefined;
}

document.addEventListener("click", event => {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!target) return;
  const actionName = target.dataset.action;
  if (actionName === "tab-close") event.stopPropagation();
  void runDataAction(actionName, target);
});

node("address-form").addEventListener("submit", event => {
  event.preventDefault();
  const url = normalizeAddress(addressInput.value);
  if (url === null) {
    toast("此类脚本网址不可打开。", "error");
    return;
  }
  if (!url) return;
  pendingAddress = url;
  addressInput.value = url;
  addressInput.blur();
  clearTimeout(pendingAddressTimer);
  pendingAddressTimer = window.setTimeout(() => {
    pendingAddress = "";
    renderAddress();
  }, 15_000);
  void action("tab:navigate", { url });
});

addressInput.addEventListener("focus", () => {
  if (currentTab()?.agentMode === "agent") void action("agent:takeover", {}, { silent: true });
  pendingAddress = "";
  clearTimeout(pendingAddressTimer);
  addressInput.select();
});
addressInput.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    addressInput.value = currentTab()?.url === "about:blank" ? "" : safeText(currentTab()?.url);
    addressInput.blur();
  }
});

node("prompt-input").addEventListener("input", () => renderComposer(currentTasks()));
node("composer-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.backend?.configured) {
    beginSettings();
    return;
  }
  const mode = currentTab()?.agentMode;
  if (mode === "paused") {
    await action("agent:resume", {});
    return;
  }
  if (mode === "agent") return;
  const prompt = node("prompt-input").value.trim();
  if (!prompt) return;
  const result = await action("agent:submit", { prompt });
  if (result.ok) node("prompt-input").value = "";
  renderComposer(currentTasks());
});

node("settings-form").addEventListener("submit", saveSettings);
settingsDialog.addEventListener("click", event => {
  if (event.target === settingsDialog) closeSettings();
});
settingsDialog.addEventListener("close", () => {
  node("api-key-input").value = "";
  void action("ui:modal", { open: false }, { silent: true });
});

function startBoundsObserver() {
  const host = node("page-host");
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => { void reportPageBounds(); });
    resizeObserver.observe(host);
    resizeObserver.observe(node("workspace"));
  }
  window.addEventListener("resize", () => { void reportPageBounds(); }, { passive: true });
  window.addEventListener("beforeunload", () => {
    resizeObserver?.disconnect();
    if (typeof unsubscribe === "function") unsubscribe();
    node("api-key-input").value = "";
  }, { once: true });
  requestAnimationFrame(reportPageBounds);
}

async function initialize() {
  hydrateIcons();
  render();
  startBoundsObserver();
  if (!desktop || typeof desktop.invoke !== "function") {
    node("page-status-text").textContent = "正在连接桌面浏览器…";
    return;
  }
  try {
    if (typeof desktop.subscribe === "function") unsubscribe = desktop.subscribe(setState);
    if (typeof desktop.onFocusAddress === "function") desktop.onFocusAddress(() => { addressInput.focus(); addressInput.select(); });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
  const initial = await action("state:get", {}, { silent: true });
  if (!initial.ok) {
    node("page-status-text").textContent = errorMessage(initial.error);
    toast(errorMessage(initial.error), "error");
    return;
  }
  if (initial.result) setState(initial.result);
  // The main process owns startup restoration and the initial blank tab.
  // Creating a second tab here races the first state snapshot.
  void reportPageBounds();
}

initialize();
})();
