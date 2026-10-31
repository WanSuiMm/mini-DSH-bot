import { mkdir, readFile, rename, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function navigationUrl(input) {
  const value = String(input ?? '').trim();
  if (!value || value === 'about:blank') return 'about:blank';
  let url;
  try { url = new URL(/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(value) ? `http://${value}` : value); } catch {
    // A single hostname/address is navigation; other text is an explicit web search.
    url = /^(?:localhost|\[[0-9a-f:]+\]|[^\s/]+\.[^\s/]+)(?::\d+)?(?:\/[^\s]*)?$/i.test(value)
      ? new URL(`${value.startsWith('localhost') ? 'http' : 'https'}://${value}`)
      : new URL(`https://www.bing.com/search?q=${encodeURIComponent(value)}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192)
    throw new Error('仅支持 HTTP／HTTPS 网页地址');
  return url.href;
}

/** Private desktop metadata only. Chromium owns its cookie/local-storage database. */
export class DesktopState {
  constructor(root) { this.root = resolve(root); this.path = join(this.root, 'window-state.json'); this.pending = Promise.resolve(); }
  async read() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000) throw new Error('Invalid desktop state');
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.tabs)) throw new Error('Unsupported desktop state');
      const seen = new Set();
      const tabs = data.tabs.slice(0, 32).flatMap(tab => {
        if (typeof tab.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tab.id) || seen.has(tab.id)) return [];
        try {
          seen.add(tab.id);
          return [{ id: tab.id, url: navigationUrl(tab.url), title: String(tab.title ?? '').slice(0, 200) }];
        } catch { return []; }
      });
      return { tabs, activeTabId: tabs.some(t => t.id === data.activeTabId) ? data.activeTabId : tabs[0]?.id,
        sidebarOpen: data.sidebarOpen !== false };
    } catch (cause) {
      if (cause.code === 'ENOENT') return { tabs: [], sidebarOpen: true };
      // Preserve damaged state for inspection instead of overwriting it at startup.
      throw new Error('上次窗口记录无法读取，原文件已保留；请检查应用数据目录。');
    }
  }
  write(state) {
    const record = { version: 1, tabs: state.tabs.map(({ id, url, title }) => ({ id, url, title })),
      activeTabId: state.activeTabId, sidebarOpen: state.sidebarOpen, savedAt: new Date().toISOString() };
    const save = async () => {
      const temporary = join(this.root, `window-state-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
    };
    this.pending = this.pending.catch(() => {}).then(save);
    return this.pending;
  }
}
