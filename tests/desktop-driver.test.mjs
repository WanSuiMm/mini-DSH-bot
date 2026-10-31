import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createElectronDriver } from '../desktop/electron-driver.mjs';

const REF = 'a'.repeat(32);

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = 'https://trusted.example/start';
    this.worldCalls = [];
    this.inputEvents = [];
    this.loaded = [];
    this.closeCalls = 0;
    this.failInputAt = -1;
  }
  isDestroyed() { return false; }
  getURL() { return this.url; }
  getTitle() { return 'Fixture'; }
  async executeJavaScriptInIsolatedWorld(worldId, scripts) {
    this.worldCalls.push({ worldId, code: scripts[0].code });
    const match = scripts[0].code.match(/const d = JSON\.parse\(("(?:\\.|[^"\\])*")\);/);
    assert.ok(match, 'driver should pass isolated-world arguments as JSON data');
    const payload = JSON.parse(JSON.parse(match[1]));
    if (payload.op === 'observe') {
      return {
        ok: true,
        type: 'observe',
        url: this.url,
        title: 'Safe page title',
        text: 'Visible page text',
        controls: [
          { ref: REF, role: 'textbox', label: 'Name', type: 'text', disabled: false, value: 'FORM_VALUE_SECRET' },
          { ref: 'b'.repeat(32), role: 'textbox', label: 'Password', type: 'password', disabled: false, value: 'PASSWORD_SECRET' },
          { ref: 'c'.repeat(32), role: 'combobox', label: 'Options', disabled: false,
            options: [{ value: 'api_token_secret', label: 'Choice', disabled: false }] },
        ],
      };
    }
    if (payload.op === 'prepare') {
      return { ok: true, type: payload.action, x: 60, y: 40, href: '', formAction: '' };
    }
    if (payload.op === 'perform') {
      return { ok: true, sideEffectStarted: true, type: payload.action, url: this.url };
    }
    return { ok: true };
  }
  sendInputEvent(event) {
    if (this.inputEvents.length === this.failInputAt) throw new Error('input fixture failure');
    this.inputEvents.push(event);
  }
  loadURL(url) {
    this.loaded.push(url);
    this.url = url;
    this.emit('did-start-navigation', {}, url, false, true);
    this.navigationTimer = setTimeout(() => this.emit('did-finish-load'), 0);
    return new Promise(resolve => setTimeout(resolve, 1));
  }
}

function fixture({ active = true } = {}) {
  const webContents = new FakeWebContents();
  const tab = { id: 'tab-a', mode: 'agent', revision: 1, view: { webContents } };
  const bindings = new Map();
  let inputGateDepth = 0;
  let agentControlActive = active;
  let agentOrigins = ['https://trusted.example'];
  const host = {
    getTabForSession: async sessionId => sessionId === 'harness-a' ? tab : undefined,
    bindAgentSession: async (browserSessionId, tabId) => { bindings.set(browserSessionId, tabId); return true; },
    unbindAgentSession: async browserSessionId => { bindings.delete(browserSessionId); },
    getBoundTab: async browserSessionId => bindings.get(browserSessionId) === tab.id ? tab : undefined,
    assertAgentControl: tabId => {
      if (tabId !== tab.id || !agentControlActive) throw Object.assign(new Error(), { code: 'CONTROL_DENIED' });
      return true;
    },
    bindHarnessSession: async (sessionId, tabId) => sessionId === 'harness-a' && tabId === tab.id,
    getAgentAllowedOrigins: async tabId => tabId === tab.id ? agentOrigins : [],
    pauseHarnessSession: async (sessionId, tabId) => {
      if (sessionId !== 'harness-a' || tabId !== tab.id) return false;
      agentControlActive = false;
      tab.mode = 'paused';
      tab.revision += 1;
      return true;
    },
    resumeHarnessSession: async (sessionId, tabId) => {
      if (sessionId !== 'harness-a' || tabId !== tab.id) return false;
      agentControlActive = true;
      tab.mode = 'agent';
      tab.revision += 1;
      return true;
    },
    beginAgentInput: tabId => {
      if (tabId !== tab.id || !agentControlActive) return false;
      inputGateDepth += 1;
      return true;
    },
    endAgentInput: () => { inputGateDepth = Math.max(0, inputGateDepth - 1); },
  };
  const driver = createElectronDriver({ host, timeoutMs: 250 });
  const open = () => driver.open({ id: 'browser-a', owner: 'alice', sessionId: 'harness-a', runId: 'run-a', taskId: 'task-a' });
  return { driver, host, tab, webContents, bindings, open, inputGateDepth: () => inputGateDepth,
    setAgentControl: value => { agentControlActive = value; },
    setAgentOrigins: value => { agentOrigins = value; } };
}

test('Electron driver binds the supplied harness tab and close only releases its agent binding', async () => {
  const f = fixture();
  const binding = await f.driver.bindHarnessSession('harness-a', 'tab-a');
  assert.deepEqual(binding, { ok: true, bound: true });
  await f.open();
  assert.equal(f.bindings.get('browser-a'), 'tab-a');
  assert.deepEqual(f.webContents.loaded, []);
  const closed = await f.driver.closeSession('browser-a');
  assert.equal(closed.ok, true);
  assert.equal(f.bindings.has('browser-a'), false);
  assert.equal(f.webContents.closeCalls, 0);
});

test('approved actions require fresh refs, a live ownership gate, and a fixed isolated-world program', async () => {
  const f = fixture();
  await f.open();
  const unapproved = await f.driver.execute('browser-a', { type: 'click', ref: REF });
  assert.equal(unapproved.error.code, 'APPROVAL_REQUIRED');
  assert.equal(unapproved.sideEffectStarted, false);
  const selector = await f.driver.execute('browser-a', { type: 'click', selector: 'body' }, { approved: true });
  assert.equal(selector.error.code, 'INVALID_REQUEST');
  assert.equal(f.webContents.worldCalls.length, 0);

  const observed = await f.driver.execute('browser-a', { type: 'observe' });
  assert.equal(observed.ok, true);
  assert.equal(observed.text, 'Visible page text');
  assert.deepEqual(observed.controls.map(control => control.label), ['Name']);
  const returned = JSON.stringify(observed);
  for (const secret of ['FORM_VALUE_SECRET', 'PASSWORD_SECRET', 'api_token_secret', 'cookies']) assert.equal(returned.includes(secret), false);
  const source = f.webContents.worldCalls[0].code;
  assert.match(source, /contenteditable/);
  assert.match(source, /password/);
  assert.match(source, /new Map/);
  assert.equal(source.includes('eval('), false);

  f.setAgentControl(false);
  const takeover = await f.driver.execute('browser-a', { type: 'click', ref: observed.controls[0].ref }, { approved: true });
  assert.equal(takeover.error.code, 'CONTROL_DENIED');
  assert.equal(takeover.sideEffectStarted, false);
  assert.equal(f.webContents.inputEvents.length, 0);
});

test('navigation and manual revision changes invalidate old refs before any input event', async () => {
  const f = fixture();
  await f.open();
  const observed = await f.driver.execute('browser-a', { type: 'observe' });
  f.tab.revision += 1;
  const stale = await f.driver.execute('browser-a', { type: 'click', ref: observed.controls[0].ref }, { approved: true });
  assert.equal(stale.error.code, 'STALE_REF');
  assert.equal(stale.sideEffectStarted, false);
  assert.equal(f.webContents.inputEvents.length, 0);
});

test('pause invalidates control and refs; trusted resume adopts revision without widening the origin snapshot', async () => {
  const f = fixture();
  await f.open();
  const first = await f.driver.execute('browser-a', { type: 'observe' });
  const paused = await f.driver.pauseHarnessSession('harness-a', 'tab-a');
  assert.equal(paused.ok, true);
  assert.equal((await f.driver.execute('browser-a', { type: 'observe' })).error.code, 'SESSION_PAUSED');

  f.setAgentOrigins(['https://trusted.example', 'https://outside.example']);
  const resumed = await f.driver.resumeHarnessSession('harness-a', 'tab-a');
  assert.equal(resumed.ok, true);
  const stale = await f.driver.execute('browser-a', { type: 'click', ref: first.controls[0].ref }, { approved: true });
  assert.equal(stale.error.code, 'STALE_REF');
  const denied = await f.driver.execute('browser-a', { type: 'navigate', url: 'https://outside.example/' }, { approved: true });
  assert.equal(denied.error.code, 'ORIGIN_DENIED');
  assert.deepEqual(f.webContents.loaded, []);
});

test('an unapproved origin is rejected before Electron navigation dispatch', async () => {
  const f = fixture();
  await f.open();
  const denied = await f.driver.execute('browser-a', { type: 'navigate', url: 'https://outside.example/path' }, { approved: true });
  assert.equal(denied.error.code, 'ORIGIN_DENIED');
  assert.equal(denied.sideEffectStarted, false);
  assert.deepEqual(f.webContents.loaded, []);
});

test('a sendInputEvent failure after dispatch is reported as an unknown side effect', async () => {
  const f = fixture();
  await f.open();
  const observed = await f.driver.execute('browser-a', { type: 'observe' });
  f.webContents.failInputAt = 1;
  const result = await f.driver.execute('browser-a', { type: 'press', ref: observed.controls[0].ref, key: 'Enter' }, { approved: true });
  assert.equal(result.error.code, 'ACTION_FAILED');
  assert.equal(result.sideEffectStarted, true);
  assert.equal(result.networkOutcome, 'unknown');
  assert.equal(result.retryable, false);
  assert.equal(f.inputGateDepth(), 0);
});

test('approved DOM click uses the fixed isolated-world path without injecting native mouse input', async () => {
  const f = fixture(); await f.open();
  const observed = await f.driver.execute('browser-a', { type: 'observe' });
  const result = await f.driver.execute('browser-a', { type: 'click', ref: observed.controls[0].ref }, { approved: true });
  assert.equal(result.ok, true); assert.equal(result.clickMechanism, 'dom');
  assert.equal(result.trustedInput, false); assert.equal(f.webContents.inputEvents.length, 0);
  assert.equal(result.networkOutcome, 'unknown');
});
