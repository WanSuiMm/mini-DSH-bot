import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopState, navigationUrl } from '../desktop/browser-state.mjs';

test('address bar permits real web URLs and ordinary user searches', () => {
  assert.equal(navigationUrl('example.com/path'), 'https://example.com/path');
  assert.equal(navigationUrl('localhost:2345/test'), 'http://localhost:2345/test');
  assert.equal(navigationUrl('127.0.0.1:2345/test'), 'http://127.0.0.1:2345/test');
  assert.equal(navigationUrl('about:blank'), 'about:blank');
  assert.match(navigationUrl('how to use agent memory'), /^https:\/\/www.bing.com\/search\?q=/);
});
test('address bar denies privileged protocols and URL-embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'https://user:pass@example.com/'])
    assert.throws(() => navigationUrl(url));
});
test('window persistence stores tabs only and returns no task authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-state-'));
  try {
    const state = new DesktopState(directory);
    await state.read();
    await state.write({ tabs: [{ id: 'tab-one', url: 'https://example.com/', title: 'One', mode: 'agent', token: 'not-to-save' }], activeTabId: 'tab-one', sidebarOpen: false, apiKey: 'not-to-save' });
    const text = await readFile(state.path, 'utf8');
    assert.doesNotMatch(text, /not-to-save|"mode"/);
    const recovered = await new DesktopState(directory).read();
    assert.equal(recovered.tabs[0].url, 'https://example.com/');
    assert.equal(recovered.sidebarOpen, false);
    assert.equal(recovered.activeTabId, 'tab-one');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('damaged state is preserved instead of silently reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-state-'));
  try {
    const state = new DesktopState(directory); const raw = '{broken';
    await writeFile(state.path, raw);
    await assert.rejects(state.read());
    assert.equal(await readFile(state.path, 'utf8'), raw);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
