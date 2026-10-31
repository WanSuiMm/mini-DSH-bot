import { app, BrowserWindow, WebContentsView, session, ipcMain, Menu } from 'electron';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopState, navigationUrl } from './browser-state.mjs';
import { createElectronDriver } from './electron-driver.mjs';
import { createDesktopBackend } from './backend.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const UI_URL = new URL('./ui/index.html', import.meta.url).href;
const sensitiveOrigin = value => { try { return new URL(value).origin; } catch { return null; } };
const privateFailure = (message = '操作未完成，请查看任务状态后再试。') => new Error(message);

/** Real Chromium views and the existing local HarnessService share this desktop host. */
export async function createDesktopApp({ stateRoot, show = true, backendFactory = createDesktopBackend } = {}) {
  if (!app.isReady()) throw new Error('Call after app.whenReady()');
  const root = stateRoot ?? app.getPath('userData');
  const persistence = new DesktopState(root);
  const restored = await persistence.read();
  const tabs = new Map();
  const harnessTabs = new Map();
  const browserTabs = new Map();
  const downloads = [];
  let activeTabId, sidebarOpen = restored.sidebarOpen, modalOpen = false;
  let pageBounds = { x: 0, y: 96, width: 900, height: 650 };
  let notice = '', backendState = { configured: false, model: '', status: 'unconfigured', tasks: [] };
  let closed = false, closing = false, closePromise, saveTimer, emitTimer;
  const browserSession = session.fromPartition('persist:mini-dsh-default');
  browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);

  const window = new BrowserWindow({ width: 1440, height: 940, minWidth: 960, minHeight: 640,
    backgroundColor: '#f5f5f2', show, title: 'mini-DSH Browser',
    webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== UI_URL) event.preventDefault(); });
  const host = {
    getTabForSession: id => tabs.get(harnessTabs.get(id)),
    bindHarnessSession(id, tabId) { if (!tabs.has(tabId)) throw privateFailure('标签页已关闭'); harnessTabs.set(id, tabId); },
    bindAgentSession(id, tabId) {
      if (!tabs.has(tabId)) throw privateFailure('标签页已关闭');
      if ([...browserTabs].some(([existing, bound]) => bound === tabId && existing !== id))
        throw Object.assign(privateFailure('此标签页已有 Agent 浏览器会话'), { code: 'DESKTOP_TAB_BUSY' });
      browserTabs.set(id, tabId);
    },
    unbindAgentSession(id) { browserTabs.delete(id); },
    getBoundTab: id => tabs.get(browserTabs.get(id)),
    getAgentAllowedOrigins: id => tabs.get(id)?.allowedOrigins ?? new Set(),
    pauseHarnessSession(id, tabId) {
      if (harnessTabs.get(id) !== tabId || !tabs.has(tabId) || tabs.get(tabId).mode === 'agent')
        throw privateFailure('页面控制权尚未交还人工');
      return true;
    },
    resumeHarnessSession(id, tabId) {
      if (harnessTabs.get(id) !== tabId || tabs.get(tabId)?.mode !== 'agent')
        throw privateFailure('请先确认恢复此页面的 Agent');
      return true;
    },
    assertAgentControl(id) {
      const tab = tabs.get(id);
      if (!tab || tab.mode !== 'agent' || tab.crashed || tab.view.webContents.isDestroyed())
        throw Object.assign(privateFailure('页面已交由人工控制'), { code: 'DESKTOP_HUMAN_CONTROL', sideEffectStarted: false });
      return true;
    },
    beginAgentInput(id) {
      const tab = tabs.get(id); host.assertAgentControl(id);
      if (!window.isVisible() || !window.isFocused())
        throw Object.assign(privateFailure('请把浏览器切到前台后重新确认操作'), { code: 'DESKTOP_FOCUS_REQUIRED', sideEffectStarted: false });
      if (tab) tab.agentInputDepth++;
    },
    endAgentInput(id) { const tab = tabs.get(id); if (tab) tab.agentInputDepth = Math.max(0, tab.agentInputDepth - 1); }
  };
  const driver = createElectronDriver({ host, allowedOrigins: [], timeoutMs: 10_000 });
  function receiveBackendState(state) {
    backendState = state;
    for (const tab of tabs.values()) {
      const task = (state.tasks ?? []).find(task => task.tabId === tab.id);
      if (tab.submitting || !task) continue;
      if (task.status === 'paused' && tab.mode === 'human') tab.mode = 'paused';
      if (['succeeded', 'failed', 'partial', 'cancelled', 'timed_out', 'interrupted', 'recovery_required'].includes(task.status) && ['agent', 'paused'].includes(tab.mode)) {
        tab.mode = 'human'; tab.revision++;
      }
    }
    emit();
  }
  const backend = await backendFactory({ stateRoot: join(root, 'harness'), driver, onState: receiveBackendState });
  await backend.ready();

  function tabSnapshot(tab) {
    const wc = tab.view.webContents;
    return { id: tab.id, title: tab.title || '新标签页', url: tab.url, loading: tab.loading,
      canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
      canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
      agentMode: tab.mode, crashed: tab.crashed, error: tab.error || null };
  }
  function snapshot() {
    return { tabs: [...tabs.values()].map(tabSnapshot), activeTabId, sidebarOpen,
      backend: { configured: backendState.configured, model: backendState.model, status: backendState.status,
        error: backendState.error ?? null }, tasks: backendState.tasks ?? [], downloads: downloads.slice(-20), notice };
  }
  function emit() {
    if (closed || emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = undefined;
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('mini-dsh:state', snapshot());
    }, 35);
  }
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void persistence.write(snapshot()).catch(() => { notice = '窗口记录保存失败；请保留当前任务。'; emit(); }); }, 180);
  }
  function layout() {
    const [width, height] = window.getContentSize();
    const rect = { x: Math.max(0, Math.floor(pageBounds.x)), y: Math.max(0, Math.floor(pageBounds.y)),
      width: Math.max(1, Math.min(Math.floor(pageBounds.width), width - Math.floor(pageBounds.x))),
      height: Math.max(1, Math.min(Math.floor(pageBounds.height), height - Math.floor(pageBounds.y))) };
    for (const tab of tabs.values()) {
      tab.view.setVisible(tab.id === activeTabId && !modalOpen);
      if (tab.id === activeTabId) tab.view.setBounds(rect);
    }
  }
  async function takeover(tab, message = '已切换人工操作；恢复 Agent 前会重新读取页面。') {
    if (!tab) return;
    const wasAgent = tab.mode === 'agent';
    tab.mode = wasAgent || tab.mode === 'paused' ? 'paused' : 'human'; tab.revision++; notice = message; emit();
    if (wasAgent) {
      try { await backend.pause(tab.id); }
      catch (cause) {
        const fresh = await backend.snapshot();
        const task = fresh.tasks.find(task => task.tabId === tab.id);
        if (!task || ['succeeded', 'failed', 'partial', 'cancelled', 'timed_out'].includes(task.status)) tab.mode = 'human';
        else throw cause;
      }
    }
  }
  function interceptInput(tab, event, input) {
    if (tab.mode !== 'agent' || tab.agentInputDepth) return;
    if (!['keyDown', 'mouseDown', 'mouseWheel'].includes(input.type)) return;
    event.preventDefault();
    void takeover(tab).catch(() => { notice = '已阻止 Agent 后续操作；请核对任务状态。'; emit(); });
  }
  async function newTab({ id = randomUUID(), url = 'about:blank', title = '' } = {}) {
    if (tabs.size >= 32) throw privateFailure('最多同时打开 32 个标签页');
    const target = navigationUrl(url);
    const view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, safeDialogs: true, navigateOnDragDrop: false } });
    const tab = { id, view, title, url: target, loading: false, mode: 'human', revision: 0,
      allowedOrigins: new Set(), agentInputDepth: 0, crashed: false, error: '' };
    tabs.set(id, tab); window.contentView.addChildView(view); activeTabId = id;
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url: requested }) => {
      if (tab.mode === 'agent') { notice = 'Agent 请求打开新窗口，请先接管并核对链接。'; emit(); return { action: 'deny' }; }
      try { const next = navigationUrl(requested); void newTab({ url: next }).catch(() => {}); } catch { /* Unsupported external protocol. */ }
      return { action: 'deny' };
    });
    const guardNavigation = (event, requested) => {
      try {
        const normalized = navigationUrl(requested);
        if (normalized !== requested && requested !== 'about:blank') { event.preventDefault(); return; }
        if (tab.mode === 'agent' && !tab.allowedOrigins.has(sensitiveOrigin(requested))) {
          event.preventDefault(); notice = 'Agent 已停在授权网站边界；可先人工打开目标网站。'; emit();
        }
      } catch { event.preventDefault(); notice = '已阻止非网页协议，请在地址栏输入网站地址。'; emit(); }
    };
    wc.on('will-navigate', guardNavigation); wc.on('will-redirect', guardNavigation);
    wc.on('will-frame-navigate', (event, details) => {
      // API versions expose either a details object or event properties.
      const url = details?.url ?? event.url;
      try {
        if (url && !['http:', 'https:', 'about:', 'blob:'].includes(new URL(url).protocol)) event.preventDefault();
        if (url && tab.mode === 'agent' && !['about:blank', 'about:srcdoc'].includes(url) && !tab.allowedOrigins.has(new URL(url).origin)) event.preventDefault();
      }
      catch { event.preventDefault(); }
    });
    wc.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) tab.revision++; });
    wc.on('did-start-loading', () => { tab.loading = true; tab.error = ''; emit(); });
    const updated = () => { if (wc.isDestroyed()) return; tab.url = wc.getURL() || tab.url; tab.title = wc.getTitle() || title || '新标签页'; emit(); persist(); };
    wc.on('did-stop-loading', () => { tab.loading = false; updated(); });
    wc.on('did-navigate', updated); wc.on('did-navigate-in-page', updated);
    wc.on('page-title-updated', (_event, value) => { tab.title = String(value).slice(0, 200); emit(); persist(); });
    wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.error = `页面加载失败（${code}），可检查地址后重新加载。`; tab.loading = false; emit();
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta) && input.key.toLowerCase() === 'l') {
        event.preventDefault();
        void takeover(tab).catch(() => {});
        window.webContents.send('mini-dsh:focus-address'); window.webContents.focus(); return;
      }
      interceptInput(tab, event, input);
    });
    wc.on('before-mouse-event', (event, mouse) => interceptInput(tab, event, mouse));
    wc.on('render-process-gone', () => {
      tab.crashed = true; tab.revision++; tab.mode = 'human'; tab.loading = false;
      tab.error = '页面进程已退出。重新加载网页后，再决定是否恢复任务。';
      void backend.pause(tab.id).catch(() => {}); emit();
    });
    wc.on('context-menu', (_event, details) => {
      Menu.buildFromTemplate([
        { role: 'copy', enabled: Boolean(details.selectionText) }, { role: 'paste', enabled: details.isEditable },
        { type: 'separator' }, { label: '返回', enabled: wc.navigationHistory.canGoBack(), click: () => { void action('tab:back', {}); } },
        { label: '重新加载', click: () => { void action('tab:reload', {}); } }
      ]).popup({ window });
    });
    layout(); emit(); persist();
    void wc.loadURL(target).catch(() => { /* did-fail-load supplies a bounded UI error. */ });
    return tabSnapshot(tab);
  }
  function currentTab() { const tab = tabs.get(activeTabId); if (!tab) throw privateFailure('请先打开一个标签页'); return tab; }
  async function closeTab(id) {
    const tab = tabs.get(id); if (!tab) return;
    await takeover(tab, '标签页已关闭；该页面的 Agent 任务不会继续操作。');
    await backend.cancel(id).catch(() => {});
    tabs.delete(id);
    for (const [key, value] of harnessTabs) if (value === id) harnessTabs.delete(key);
    for (const [key, value] of browserTabs) if (value === id) browserTabs.delete(key);
    window.contentView.removeChildView(tab.view); tab.view.webContents.close({ waitForBeforeUnload: false });
    if (activeTabId === id) activeTabId = [...tabs.keys()].at(-1);
    if (!tabs.size) await newTab();
    layout(); emit(); persist();
  }
  async function action(name, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw privateFailure('操作参数无效');
    if (name === 'state:get') return snapshot();
    if (name === 'ui:bounds') {
      const rect = input.rect;
      if (!rect || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(rect[key])) || rect.width < 0 || rect.height < 0)
        throw privateFailure('窗口尺寸无效');
      pageBounds = rect; layout(); return true;
    }
    if (name === 'ui:modal') { modalOpen = input.open === true; layout(); return true; }
    if (name === 'tab:new') return newTab({ url: input.url });
    if (name === 'tab:activate') { if (!tabs.has(input.id)) throw privateFailure('标签页已关闭'); activeTabId = input.id; layout(); emit(); persist(); return snapshot(); }
    if (name === 'tab:close') { await closeTab(input.id ?? activeTabId); return snapshot(); }
    if (name === 'sidebar:toggle') { sidebarOpen = !sidebarOpen; emit(); persist(); return snapshot(); }
    if (name === 'window:minimize') return window.minimize();
    if (name === 'window:toggleMaximize') return window.isMaximized() ? window.unmaximize() : window.maximize();
    if (name === 'window:close') return window.close();
    if (name === 'agent:configure') {
      await backend.configure({ baseUrl: input.baseUrl, apiKey: input.apiKey, model: input.model, thinkingMode: input.thinkingMode });
      backendState = await backend.snapshot(); notice = '模型已配置。密钥仅在本次运行内使用。'; emit(); return snapshot();
    }
    const tab = currentTab(), wc = tab.view.webContents;
    if (name.startsWith('tab:')) {
      await takeover(tab, '已交还人工浏览。');
      if (name === 'tab:navigate') { tab.crashed = false; const url = navigationUrl(input.url); void wc.loadURL(url).catch(() => {}); }
      else if (name === 'tab:back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (name === 'tab:forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      else if (name === 'tab:reload') { tab.crashed = false; wc.reload(); }
      else if (name === 'tab:stop') wc.stop();
      else if (!['tab:back', 'tab:forward'].includes(name)) throw privateFailure('不支持的页面操作');
      return snapshot();
    }
    if (name === 'agent:submit') {
      if (tab.submitting || tab.mode === 'agent' || tab.mode === 'paused') throw privateFailure('请先完成、取消或恢复当前任务');
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12_000) throw privateFailure('请填写任务，最多 12,000 字符');
      if (!['http:', 'https:'].includes(new URL(wc.getURL()).protocol)) throw privateFailure('请先打开需要 Agent 操作的网站');
      tab.allowedOrigins = new Set([new URL(wc.getURL()).origin]); tab.mode = 'agent'; tab.revision++; tab.submitting = true;
      try { await backend.submit({ tabId: tab.id, url: wc.getURL(), prompt: input.prompt, allowedOrigins: [...tab.allowedOrigins] }); }
      catch (cause) { tab.mode = 'human'; tab.revision++; emit(); throw cause; }
      finally { tab.submitting = false; }
    } else if (name === 'agent:takeover') await takeover(tab);
    else if (name === 'agent:resume') {
      tab.mode = 'agent'; tab.revision++;
      try { await backend.resume(tab.id); } catch (cause) { tab.mode = 'human'; emit(); throw cause; }
    } else if (name === 'agent:cancel') {
      tab.mode = 'human'; tab.revision++; await backend.cancel(tab.id); notice = '任务已取消，页面仍可正常浏览。';
    } else if (name === 'agent:decision') {
      if (!['approve', 'reject'].includes(input.decision) || typeof input.commandId !== 'string' || !/^[a-f0-9]{64}$/.test(input.requestHash ?? ''))
        throw privateFailure('请核对这次操作的确认信息');
      if (tab.mode !== 'agent') throw privateFailure('当前为人工操作，请先恢复 Agent 并重新读取页面');
      await backend[input.decision](tab.id, input.commandId, input.requestHash);
    } else if (name === 'agent:recover') {
      const task = (backendState.tasks ?? []).find(task => task.id === input.taskId && task.tabId === tab.id);
      if (!task || sensitiveOrigin(task.url) !== sensitiveOrigin(wc.getURL())) throw privateFailure('请先回到该任务原来的网站再恢复');
      tab.allowedOrigins = new Set([new URL(wc.getURL()).origin]); tab.mode = 'agent'; tab.revision++;
      try { await backend.recover(tab.id, input.taskId); } catch (cause) { tab.mode = 'human'; emit(); throw cause; }
    } else throw privateFailure('不支持的操作');
    receiveBackendState(await backend.snapshot()); return snapshot();
  }
  ipcMain.handle('mini-dsh:action', async (event, name, input) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== UI_URL)
      throw privateFailure('调用来源无效');
    try { return await action(name, input); }
    catch (cause) {
      // Only bounded host-generated errors cross the chrome IPC. No raw URLs, keys or stacks.
      const message = /^[\u3400-\u9fff]/.test(cause.message ?? '') ? cause.message.slice(0, 200) : '操作未完成，请核对页面与任务状态。';
      throw privateFailure(message);
    }
  });
  const downloadListener = async (_event, item, contents) => {
    const tab = [...tabs.values()].find(tab => tab.view.webContents === contents);
    if (!tab || tab.mode === 'agent') { item.cancel(); notice = '下载需要先人工接管并选择保存位置。'; emit(); return; }
    item.setSaveDialogOptions({ title: '保存下载文件', defaultPath: join(app.getPath('downloads'), item.getFilename().replace(/[\\/]/g, '_')) });
    const record = { id: randomUUID(), name: item.getFilename(), status: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes() };
    downloads.push(record); emit();
    item.on('updated', () => { record.receivedBytes = item.getReceivedBytes(); emit(); });
    item.once('done', (_event, state) => { record.status = state; emit(); });
  };
  browserSession.on('will-download', downloadListener);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '浏览器', submenu: [
      { label: '新建标签页', accelerator: 'CmdOrCtrl+T', click: () => { void newTab(); } },
      { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => { void closeTab(activeTabId); } },
      { label: '地址栏', accelerator: 'CmdOrCtrl+L', click: () => {
        void takeover(tabs.get(activeTabId)).catch(() => {});
        window.webContents.focus(); window.webContents.send('mini-dsh:focus-address');
      } },
      { type: 'separator' }, { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => window.close() }
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '查看', submenu: [
      { label: '重新加载网页', accelerator: 'CmdOrCtrl+R', click: () => { void action('tab:reload'); } },
      { label: 'Agent 侧栏', accelerator: 'CmdOrCtrl+Shift+A', click: () => { void action('sidebar:toggle'); } },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }
    ] }
  ]));
  window.on('resize', layout);
  window.webContents.on('did-finish-load', emit);
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      clearTimeout(saveTimer); clearTimeout(emitTimer);
      for (const tab of tabs.values()) { tab.mode = 'human'; tab.revision++; }
      await persistence.write(snapshot());
      await backend.close();
      browserSession.flushStorageData(); await browserSession.cookies.flushStore();
      browserSession.removeListener('will-download', downloadListener);
      ipcMain.removeHandler('mini-dsh:action'); closed = true;
      for (const tab of tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
      if (!window.isDestroyed()) window.destroy();
    })().catch(cause => { closing = false; closePromise = undefined; throw cause; });
    return closePromise;
  }
  window.on('close', event => {
    if (closed) return;
    event.preventDefault();
    void close().then(() => app.quit()).catch(() => {
      closing = false; notice = '任务记录未能安全保存，窗口已保留，请稍后重试退出。'; emit();
    });
  });
  await window.loadFile(join(directory, 'ui', 'index.html'));
  for (const tab of restored.tabs) await newTab(tab);
  if (!tabs.size) await newTab();
  if (tabs.has(restored.activeTabId)) activeTabId = restored.activeTabId;
  layout(); backendState = await backend.snapshot(); emit();
  if (show) window.show();
  return { window, backend, driver, host, action, snapshot, close, tabs };
}
