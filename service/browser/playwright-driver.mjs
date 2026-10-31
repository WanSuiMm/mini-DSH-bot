import { createHash, randomUUID } from 'node:crypto';

// Browser-context policy only: this is neither an OS sandbox nor complete SSRF
// protection. Deploy OS/network egress isolation separately.

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TEXT_CHARS = 12_000;
const MAX_TEXT_CHARS = 50_000;
const DEFAULT_MAX_CONTROLS = 60;
const HARD_MAX_CONTROLS = 100;
const MAX_STORAGE_STATE_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 768 * 1024;
const PREVIEW_QUALITIES = [60, 55];
const PREVIEW_MASK_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';
const CONTROL_SELECTOR = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [contenteditable="true"]';
const SAFE_TEXT_INPUT_TYPES = new Set(['text', 'email', 'search', 'tel', 'url', 'number', 'date', 'month', 'week', 'time', 'datetime-local']);
const BLOCKED_INPUT_TYPES = new Set(['password', 'hidden', 'file', 'image']);
const SENSITIVE_FIELD_MARKERS = /(?:pass(?:word|wd)?|secret|token|auth(?:entication|orization)?|credential|api[_-]?key|cvv|cvc|ssn)/i;
const SAFE_PRESS_KEYS = new Set([
  'Enter', 'Tab', 'Shift+Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Space', 'Control+A',
]);

class DriverFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'DriverFailure';
    this.code = code;
  }
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ensureKeys(value, allowed) {
  if (!isRecord(value)) return false;
  return Object.keys(value).every(key => allowed.has(key));
}

function configError() {
  return new DriverFailure('INVALID_CONFIG');
}

function parseConfiguredOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x20\x7f]/.test(value)) throw configError();
  let parsed;
  try { parsed = new URL(value); } catch { throw configError(); }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin === 'null') {
    throw configError();
  }
  return parsed;
}

function hostnameIsLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function normalizeConfig(config) {
  if (!isRecord(config) || !Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0 || config.allowedOrigins.length > 100) throw configError();

  const allowed = new Map();
  for (const item of config.allowedOrigins) {
    const origin = parseConfiguredOrigin(item);
    allowed.set(origin.origin, origin);
  }
  if (allowed.size !== config.allowedOrigins.length) throw configError();

  const allowHttpOrigins = new Set();
  let allowHttpLoopback = false;
  const httpPolicy = config.allowHttp;
  if (httpPolicy === true) {
    for (const [origin, parsed] of allowed) if (parsed.protocol === 'http:') allowHttpOrigins.add(origin);
  } else if (Array.isArray(httpPolicy)) {
    for (const item of httpPolicy) {
      const parsed = parseConfiguredOrigin(item);
      if (parsed.protocol !== 'http:' || !allowed.has(parsed.origin)) throw configError();
      allowHttpOrigins.add(parsed.origin);
    }
  } else if (isRecord(httpPolicy)) {
    if (httpPolicy.loopback !== undefined && typeof httpPolicy.loopback !== 'boolean') throw configError();
    if (httpPolicy.loopback === true) allowHttpLoopback = true;
    if (httpPolicy.origins !== undefined) {
      if (!Array.isArray(httpPolicy.origins)) throw configError();
      for (const item of httpPolicy.origins) {
        const parsed = parseConfiguredOrigin(item);
        if (parsed.protocol !== 'http:' || !allowed.has(parsed.origin)) throw configError();
        allowHttpOrigins.add(parsed.origin);
      }
    }
    if (Object.keys(httpPolicy).some(key => !['loopback', 'origins'].includes(key))) throw configError();
  } else if (httpPolicy !== undefined && httpPolicy !== false) {
    throw configError();
  }

  for (const [origin, parsed] of allowed) {
    if (parsed.protocol === 'http:' && !allowHttpOrigins.has(origin) && !(allowHttpLoopback && hostnameIsLoopback(parsed.hostname))) throw configError();
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTextChars = config.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxControls = config.maxControls ?? DEFAULT_MAX_CONTROLS;
  const headless = config.headless ?? true;
  const readOnlyMode = config.readOnlyMode ?? false;
  if (typeof readOnlyMode !== 'boolean') throw configError();
  const readOnlyNavigationUrls = new Set();
  const readOnlyNetworkUrls = new Set();
  if (readOnlyMode) {
    if (!Array.isArray(config.readOnlyNavigationUrls) || !config.readOnlyNavigationUrls.length || config.readOnlyNavigationUrls.length > 512) throw configError();
    for (const value of config.readOnlyNavigationUrls) {
      let target;
      try { target = new URL(value); } catch { throw configError(); }
      if (!allowed.has(target.origin) || !['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.href.length > 4096) throw configError();
      readOnlyNavigationUrls.add(target.href);
      target.hash = '';
      readOnlyNetworkUrls.add(target.href);
    }
  } else if (config.readOnlyNavigationUrls !== undefined) throw configError();
  const executablePath = config.executablePath;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > MAX_TEXT_CHARS ||
      !Number.isInteger(maxControls) || maxControls < 1 || maxControls > HARD_MAX_CONTROLS || typeof headless !== 'boolean' ||
      (executablePath !== undefined && (typeof executablePath !== 'string' || !executablePath || executablePath.length > 4096 || /[\x00-\x1f]/.test(executablePath)))) {
    throw configError();
  }

  return Object.freeze({
    allowedOrigins: new Set(allowed.keys()),
    allowedHosts: new Set([...allowed.values()].map(value => value.hostname.toLowerCase().replace(/^\[|\]$/g, ''))),
    allowHttpOrigins,
    allowHttpLoopback,
    timeoutMs,
    maxTextChars,
    maxControls,
    headless,
    readOnlyMode,
    readOnlyNavigationUrls,
    readOnlyNetworkUrls,
    executablePath,
  });
}

function parseAllowedUrl(value, settings) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new DriverFailure('INVALID_URL');
  let parsed;
  try { parsed = new URL(value); } catch { throw new DriverFailure('INVALID_URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.origin === 'null') {
    throw new DriverFailure('INVALID_URL');
  }
  if (!settings.allowedOrigins.has(parsed.origin)) throw new DriverFailure('ORIGIN_DENIED');
  if (parsed.protocol === 'http:' && !settings.allowHttpOrigins.has(parsed.origin) && !(settings.allowHttpLoopback && hostnameIsLoopback(parsed.hostname))) {
    throw new DriverFailure('ORIGIN_DENIED');
  }
  return parsed;
}

function copyStorageState(input, settings) {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new DriverFailure('INVALID_STORAGE_STATE');

  let serialized;
  let state;
  try {
    serialized = JSON.stringify(input);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_STORAGE_STATE_BYTES) throw new Error('invalid');
    state = JSON.parse(serialized);
  } catch {
    throw new DriverFailure('INVALID_STORAGE_STATE');
  }
  if (!isRecord(state) || Object.keys(state).some(key => !['cookies', 'origins'].includes(key))) throw new DriverFailure('INVALID_STORAGE_STATE');
  if (state.cookies !== undefined && !Array.isArray(state.cookies)) throw new DriverFailure('INVALID_STORAGE_STATE');
  if (state.origins !== undefined && !Array.isArray(state.origins)) throw new DriverFailure('INVALID_STORAGE_STATE');

  for (const cookie of state.cookies ?? []) {
    if (!isRecord(cookie)) throw new DriverFailure('INVALID_STORAGE_STATE');
    if (typeof cookie.domain === 'string') {
      const domain = cookie.domain.toLowerCase().replace(/^\./, '');
      const matchesAllowedHost = [...settings.allowedHosts].some(host => host === domain || host.endsWith(`.${domain}`));
      if (!matchesAllowedHost) throw new DriverFailure('INVALID_STORAGE_STATE');
    } else if (typeof cookie.url === 'string') {
      try { parseAllowedUrl(cookie.url, settings); } catch { throw new DriverFailure('INVALID_STORAGE_STATE'); }
    } else {
      throw new DriverFailure('INVALID_STORAGE_STATE');
    }
  }
  for (const originState of state.origins ?? []) {
    if (!isRecord(originState) || typeof originState.origin !== 'string') throw new DriverFailure('INVALID_STORAGE_STATE');
    let parsed;
    try { parsed = parseAllowedUrl(originState.origin, settings); } catch { throw new DriverFailure('INVALID_STORAGE_STATE'); }
    if (parsed.origin !== originState.origin) throw new DriverFailure('INVALID_STORAGE_STATE');
  }
  return state;
}

function validateSignal(signal) {
  return signal === undefined || Boolean(signal && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function');
}

function makeInterruption(signal, timeoutMs, onInterrupt) {
  let interrupted = false;
  let code;
  let rejectWait;
  const wait = new Promise((_, reject) => { rejectWait = reject; });
  wait.catch(() => {});
  const interrupt = reason => {
    if (interrupted) return;
    interrupted = true;
    code = reason;
    try { Promise.resolve(onInterrupt()).catch(() => {}); } catch { /* best effort cleanup */ }
    rejectWait(new DriverFailure(reason));
  };
  const onAbort = () => interrupt('CANCELLED');
  const timer = setTimeout(() => interrupt('TIMEOUT'), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    wait,
    get interrupted() { return interrupted; },
    get code() { return code; },
    dispose() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

function boundedText(value, limit, collapse = false) {
  let text = typeof value === 'string' ? value : '';
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (collapse) text = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return { value: chars.length > limit ? chars.slice(0, limit).join('') : text, truncated: chars.length > limit };
}

function fingerprint(description) {
  return createHash('sha256').update(JSON.stringify(description)).digest('hex');
}

function describeElement(element) {
  const clip = (value, limit = 512) => String(value ?? '').slice(0, limit);
  const attrs = ['type', 'role', 'name', 'id', 'aria-label', 'aria-labelledby', 'placeholder', 'title', 'href', 'target', 'download', 'formaction', 'formmethod', 'contenteditable', 'disabled', 'aria-disabled', 'multiple', 'autocomplete'];
  const attributes = Object.fromEntries(attrs.map(name => [name, element.hasAttribute(name) ? clip(element.getAttribute(name), name === 'href' || name === 'formaction' ? 4096 : 512) : null]));
  const rawHref = element.getAttribute('href') || '';
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') || (tag === 'button' ? 'button' : '')).toLowerCase();
  const labels = Array.from(element.labels || []).slice(0, 20).map(label => clip(label.innerText || label.textContent || '', 1000)).join(' ');
  const controlText = ['input', 'textarea', 'select'].includes(tag) ? '' : clip(element.innerText || element.textContent || '', 2000);
  const form = element.form ? {
    action: clip(element.form.action || '', 4096),
    method: (element.form.method || 'get').toLowerCase(),
    target: clip(element.form.target || '', 512),
  } : null;
  const label = clip(attributes['aria-label'] || element.getAttribute('placeholder') || element.getAttribute('title') || labels || controlText, 2000);
  const optionCount = tag === 'select' ? element.options.length : 0;
  const options = tag === 'select' ? Array.from(element.options).slice(0, 200).map(option => ({
    value: clip(option.value, 256),
    label: clip(option.label || option.textContent || '', 256),
    disabled: Boolean(option.disabled || option.parentElement?.disabled),
    hidden: Boolean(option.hidden),
  })) : [];
  return {
    connected: Boolean(element.isConnected),
    tag,
    type,
    attributes,
    hrefTruncated: rawHref.length > 4096,
    form,
    label,
    text: controlText,
    disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
    options,
    optionCount,
    optionsTruncated: optionCount > options.length,
  };
}

function classifyControl(description) {
  const { tag, type, attributes } = description;
  if (!description.connected || BLOCKED_INPUT_TYPES.has(type) || attributes.download !== null) return null;
  const sensitiveMetadata = [attributes.name, attributes.id, attributes.autocomplete, attributes['aria-label']].filter(Boolean).join(' ');
  if (SENSITIVE_FIELD_MARKERS.test(sensitiveMetadata)) return null;
  if (tag === 'input' && !['button', 'submit', 'reset', ...SAFE_TEXT_INPUT_TYPES, 'checkbox', 'radio'].includes(type || 'text')) return null;
  if (tag === 'a' && (!attributes.href || description.hrefTruncated || /^(?:javascript|data|file|blob):/i.test(attributes.href.trim()))) return null;
  const role = attributes.role || ({ button: 'button', a: 'link', select: 'combobox', textarea: 'textbox' }[tag] ?? (tag === 'input' ? (type === 'checkbox' || type === 'radio' ? type : 'textbox') : attributes.contenteditable === 'true' ? 'textbox' : ''));
  if (!role) return null;
  const canSelect = tag === 'select';
  const customTextbox = role === 'textbox' && !['input', 'select', 'button', 'a', 'textarea'].includes(tag);
  const canFill = tag === 'textarea' || (tag === 'input' && SAFE_TEXT_INPUT_TYPES.has(type || 'text')) || attributes.contenteditable === 'true' || customTextbox;
  return { role, canFill, canSelect };
}

function displayUrl(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'about:blank';
    return `${parsed.origin}${Array.from(parsed.pathname).slice(0, 2048).join('')}`;
  } catch {
    return 'about:blank';
  }
}

async function readTitle(page) {
  try { return await page.evaluate(() => String(document.title || '').slice(0, 201)); }
  catch { throw new DriverFailure('BROWSER_ERROR'); }
}

function safeErrorCode(error, fallback) {
  return error instanceof DriverFailure ? error.code : fallback;
}

function errorResult(code, { sideEffectStarted, contextClosed, unknownEffects = false, retryable } = {}) {
  return {
    ok: false,
    error: { code },
    ...(sideEffectStarted === undefined ? {} : { sideEffectStarted }),
    ...(contextClosed === undefined ? {} : { contextClosed }),
    ...(unknownEffects ? { networkOutcome: 'unknown', retryable: false } : {}),
    ...(retryable === undefined || unknownEffects ? {} : { retryable }),
  };
}

function successResult(data = {}) {
  return { ok: true, ...data };
}

function validSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function parseRequest(request, settings) {
  if (!isRecord(request) || typeof request.type !== 'string') throw new DriverFailure('INVALID_REQUEST');
  if (settings.readOnlyMode && ['fill', 'select', 'press'].includes(request.type)) throw new DriverFailure('READ_ONLY_ACTION_DENIED');
  switch (request.type) {
    case 'navigate': {
      if (!ensureKeys(request, new Set(['type', 'url']))) throw new DriverFailure('INVALID_REQUEST');
      const url = parseAllowedUrl(request.url, settings);
      if (settings.readOnlyMode && !settings.readOnlyNavigationUrls.has(url.href)) throw new DriverFailure('READ_ONLY_NAVIGATION_DENIED');
      return { type: request.type, url };
    }
    case 'observe':
      if (!ensureKeys(request, new Set(['type', 'offset'])) ||
          (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 10000))) throw new DriverFailure('INVALID_REQUEST');
      return { type: request.type, offset: request.offset ?? 0 };
    case 'click':
      if (!ensureKeys(request, new Set(['type', 'ref'])) || typeof request.ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.ref)) throw new DriverFailure('INVALID_REQUEST');
      return { type: request.type, ref: request.ref };
    case 'fill':
      if (!ensureKeys(request, new Set(['type', 'ref', 'text'])) || typeof request.ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.ref) || typeof request.text !== 'string' || Array.from(request.text).length > settings.maxTextChars) throw new DriverFailure('INVALID_REQUEST');
      return { type: request.type, ref: request.ref, text: request.text };
    case 'select':
      if (!ensureKeys(request, new Set(['type', 'ref', 'values'])) || typeof request.ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.ref) || !Array.isArray(request.values) || request.values.length < 1 || request.values.length > 50 || request.values.some(value => typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) throw new DriverFailure('INVALID_REQUEST');
      return { type: request.type, ref: request.ref, values: [...request.values] };
    case 'press':
      if (!ensureKeys(request, new Set(['type', 'ref', 'key'])) || typeof request.ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.ref) || typeof request.key !== 'string' || !SAFE_PRESS_KEYS.has(request.key)) throw new DriverFailure('INVALID_REQUEST');
      return { type: request.type, ref: request.ref, key: request.key };
    default:
      throw new DriverFailure('INVALID_REQUEST');
  }
}

function requestDenial(request, settings, session) {
  let parsed;
  try {
    const rawUrl = request.url();
    if (typeof rawUrl !== 'string' || rawUrl.length > 4096) return 'ORIGIN_DENIED';
    parsed = new URL(rawUrl);
  } catch { return 'ORIGIN_DENIED'; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !settings.allowedOrigins.has(parsed.origin)) return 'ORIGIN_DENIED';
  if (parsed.protocol === 'http:' && !settings.allowHttpOrigins.has(parsed.origin) && !(settings.allowHttpLoopback && hostnameIsLoopback(parsed.hostname))) return 'ORIGIN_DENIED';
  const method = request.method().toUpperCase();
  if ((settings.readOnlyMode || session.writeApprovalDepth === 0) && method !== 'GET' && method !== 'HEAD') return 'METHOD_DENIED';
  if (settings.readOnlyMode && request.isNavigationRequest()) {
    parsed.hash = '';
    if (!settings.readOnlyNetworkUrls.has(parsed.href)) return 'READ_ONLY_NAVIGATION_DENIED';
  }
  return null;
}

async function routeRequest(session, settings, route) {
  const request = route.request();
  const denial = requestDenial(request, settings, session);
  if (denial) {
    try {
      if (request.isNavigationRequest() && session.page && request.frame() === session.page.mainFrame()) session.lastMainNavigationDenied = denial;
    } catch { /* requests without a frame remain blocked */ }
    session.lastNetworkDenial = denial;
    try { await route.abort('blockedbyclient'); } catch { /* context may be closing */ }
    return;
  }
  try { await route.continue(); } catch { /* context may be closing */ }
}

async function closeContextQuietly(context) {
  if (!context) return;
  try { await context.close(); } catch { /* best effort cleanup */ }
}

export async function createPlaywrightDriver(config = {}) {
  const settings = normalizeConfig(config);
  const sessions = new Map();
  let browser;
  let browserPromise;
  let driverClosed = false;

  async function closeSessionInternal(session) {
    if (!session || session.closed) return;
    session.closed = true;
    session.writeApprovalDepth = 0;
    sessions.delete(session.id);
    const handles = [...session.refs.values()].map(item => item.handle);
    session.refs.clear();
    session.generation += 1;
    const context = session.context;
    session.context = null;
    // Begin closing first so a timed-out or cancelled Playwright action cannot
    // keep running while we dispose a large set of observation handles.
    const closing = context ? closeContextQuietly(context) : Promise.resolve();
    for (const handle of handles) void Promise.resolve().then(() => handle.dispose()).catch(() => {});
    await closing;
  }

  async function getBrowser() {
    if (driverClosed) throw new DriverFailure('DRIVER_CLOSED');
    if (browser?.isConnected()) return browser;
    if (!browserPromise) {
      browserPromise = (async () => {
        let chromium;
        try { ({ chromium } = await import('playwright-core')); }
        catch { throw new DriverFailure('DRIVER_UNAVAILABLE'); }
        const launchOptions = {
          headless: settings.headless,
          args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync'],
        };
        if (settings.executablePath) launchOptions.executablePath = settings.executablePath;
        let launched;
        try { launched = await chromium.launch(launchOptions); }
        catch { throw new DriverFailure('BROWSER_UNAVAILABLE'); }
        if (driverClosed) {
          await launched.close().catch(() => {});
          throw new DriverFailure('DRIVER_CLOSED');
        }
        browser = launched;
        launched.on('disconnected', () => {
          browser = undefined;
          for (const session of sessions.values()) void closeSessionInternal(session);
        });
        return launched;
      })();
      browserPromise.catch(() => {});
    }
    try { return await browserPromise; }
    finally {
      if (browserPromise && browser === undefined) browserPromise = undefined;
      else if (browserPromise && browser?.isConnected()) browserPromise = undefined;
    }
  }

  function validateUrl(url) {
    try {
      parseAllowedUrl(url, settings);
      return successResult();
    } catch (error) {
      return errorResult(safeErrorCode(error, 'INVALID_URL'));
    }
  }

  async function open(input = {}) {
    if (!ensureKeys(input, new Set(['id', 'owner', 'sessionId', 'runId', 'taskId', 'storageState', 'signal']))) throw new DriverFailure('INVALID_REQUEST');
    for (const field of ['owner', 'sessionId', 'runId', 'taskId']) {
      if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field] || input[field].length > 256)) throw new DriverFailure('INVALID_REQUEST');
    }
    const { id, storageState, signal } = input;
    if (driverClosed) throw new DriverFailure('DRIVER_CLOSED');
    if (!validSessionId(id)) throw new DriverFailure('INVALID_SESSION_ID');
    if (!validateSignal(signal)) throw new DriverFailure('INVALID_SIGNAL');
    if (signal?.aborted) throw new DriverFailure('CANCELLED');
    if (sessions.has(id)) throw new DriverFailure('SESSION_EXISTS');
    const safeStorageState = copyStorageState(storageState, settings);
    const session = {
      id,
      context: null,
      page: null,
      refs: new Map(),
      generation: 0,
      writeApprovalDepth: 0,
      lastNetworkDenial: null,
      lastMainNavigationDenied: null,
      busy: true,
      closed: false,
    };
    sessions.set(id, session);
    const interruption = makeInterruption(signal, settings.timeoutMs, () => closeSessionInternal(session));

    const setup = (async () => {
      const activeBrowser = await getBrowser();
      if (session.closed || driverClosed) throw new DriverFailure('CANCELLED');
      let context;
      try {
        context = await activeBrowser.newContext({
          ...(safeStorageState === undefined ? {} : { storageState: safeStorageState }),
          acceptDownloads: false,
          serviceWorkers: 'block',
          permissions: [],
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 1,
        });
      } catch {
        throw new DriverFailure('BROWSER_ERROR');
      }
      if (session.closed || driverClosed || interruption.interrupted) {
        await closeContextQuietly(context);
        throw new DriverFailure(interruption.code || 'CANCELLED');
      }
      session.context = context;
      try {
        await context.route('**/*', route => routeRequest(session, settings, route));
        if (typeof context.routeWebSocket !== 'function') throw new DriverFailure('DRIVER_UNAVAILABLE');
        await context.routeWebSocket('**/*', async socket => {
          try { await socket.close({ code: 1008, reason: 'Blocked by browser policy' }); } catch { /* socket may already be closed */ }
        });
      } catch (error) {
        if (error instanceof DriverFailure) throw error;
        throw new DriverFailure('BROWSER_ERROR');
      }
      if (session.closed || driverClosed || interruption.interrupted) throw new DriverFailure(interruption.code || 'CANCELLED');
      let page;
      try { page = await context.newPage(); } catch { throw new DriverFailure('BROWSER_ERROR'); }
      if (session.closed || driverClosed || interruption.interrupted) {
        await closeContextQuietly(context);
        throw new DriverFailure(interruption.code || 'CANCELLED');
      }
      session.page = page;
      context.on('page', candidate => {
        if (session.page && candidate !== session.page) void candidate.close().catch(() => {});
      });
      page.on('popup', popup => { void popup.close().catch(() => {}); });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('download', download => { void download.cancel().catch(() => {}); });
      page.on('filechooser', chooser => {
        void chooser.setFiles([]).catch(() => closeSessionInternal(session));
      });
      page.on('framenavigated', frame => {
        if (session.closed) return;
        const url = frame.url();
        if (url === 'about:blank') return;
        try { parseAllowedUrl(url, settings); }
        catch { void closeSessionInternal(session); }
      });
      page.on('close', () => {
        if (!session.closed) void closeSessionInternal(session);
      });
      session.busy = false;
      return successResult();
    })();
    setup.catch(() => {});

    try {
      const result = await Promise.race([setup, interruption.wait]);
      return result;
    } catch (error) {
      await closeSessionInternal(session);
      throw new DriverFailure(safeErrorCode(error, interruption.code || 'BROWSER_ERROR'));
    } finally {
      interruption.dispose();
      if (session.closed) session.busy = false;
    }
  }

  function invalidateRefs(session, preserve = null) {
    const handles = [];
    for (const item of session.refs.values()) if (item !== preserve) handles.push(item.handle);
    session.refs.clear();
    session.generation += 1;
    for (const handle of handles) void handle.dispose().catch(() => {});
  }

  async function observe(session, offset = 0) {
    invalidateRefs(session);
    let pageUrl;
    let title;
    let text;
    try {
      // A link may commit a new URL/title before its body has arrived.
      // The enclosing driver deadline bounds this wait and cancellation.
      await session.page.waitForLoadState('domcontentloaded', { timeout: 0 });
      pageUrl = settings.readOnlyMode ? parseAllowedUrl(session.page.url(), settings).href : displayUrl(session.page.url());
      title = boundedText(await readTitle(session.page), 200, true).value;
      const body = session.page.locator('body');
      const bodyCount = await body.count();
      text = bodyCount ? await body.evaluate((element, limit) => String(element.innerText || '').slice(0, limit + 1), settings.maxTextChars) : '';
    } catch {
      throw new DriverFailure('BROWSER_ERROR');
    }
    const bounded = boundedText(text, settings.maxTextChars);
    const controls = [];
    let locator;
    let count;
    try {
      locator = session.page.locator(CONTROL_SELECTOR);
      count = await locator.count();
    } catch {
      throw new DriverFailure('BROWSER_ERROR');
    }
    const scanLimit = Math.min(offset + 400, offset + settings.maxControls * 4, count);
    let nextIndex = offset;
    for (let index = offset; index < scanLimit && controls.length < settings.maxControls; index += 1) {
      nextIndex = index + 1;
      let handle;
      try {
        handle = await locator.nth(index).elementHandle({ timeout: 0 });
        if (!handle) continue;
        if (!(await handle.isVisible())) { await handle.dispose(); continue; }
        const description = await handle.evaluate(describeElement);
        const kind = classifyControl(description);
        if (!kind) { await handle.dispose(); continue; }
        const safeLabel = boundedText(description.label, 200, true);
        const ref = randomUUID().replaceAll('-', '');
        const item = {
          ref,
          generation: session.generation,
          page: session.page,
          handle,
          fingerprint: fingerprint(description),
          role: kind.role,
          canFill: kind.canFill,
          canSelect: kind.canSelect,
          options: description.options,
          multiple: description.attributes.multiple !== null,
          linkHref: description.attributes.href,
        };
        session.refs.set(ref, item);
        const control = {
          ref,
          role: kind.role,
          label: safeLabel.value,
          ...(description.type ? { type: boundedText(description.type, 32, true).value } : {}),
          disabled: description.disabled,
        };
        if (settings.readOnlyMode && kind.role === 'link') {
          try { control.href = parseAllowedUrl(new URL(description.attributes.href, session.page.url()).href, settings).href; }
          catch { /* Unapproved origins do not become actionable read-only links. */ }
        }
        if (kind.canSelect) {
          const safeOptions = description.options.slice(0, 25).map(option => ({
            value: boundedText(option.value, 200).value,
            label: boundedText(option.label, 160, true).value,
            disabled: Boolean(option.disabled || option.hidden),
          }));
          control.options = safeOptions;
          control.optionsTruncated = description.optionsTruncated || description.options.length > safeOptions.length;
        }
        controls.push(control);
      } catch {
        if (handle) { try { await handle.dispose(); } catch { /* element may already be detached */ } }
      }
    }
    return successResult({
      type: 'observe',
      url: pageUrl,
      title,
      text: bounded.value,
      textTruncated: bounded.truncated,
      controls,
      controlsOffset: offset,
      nextControlsOffset: nextIndex < count && nextIndex <= 10000 ? nextIndex : null,
      controlsTruncated: nextIndex < count,
    });
  }

  async function checkedTarget(session, ref, actionType) {
    const item = session.refs.get(ref);
    if (!item || item.page !== session.page || item.generation !== session.generation) throw new DriverFailure('STALE_REF');
    invalidateRefs(session, item);
    if (item.page !== session.page || item.generation + 1 !== session.generation) {
      try { await item.handle.dispose(); } catch { /* stale handle */ }
      throw new DriverFailure('STALE_REF');
    }
    let current;
    try {
      current = await item.handle.evaluate(describeElement);
      if (!current.connected || fingerprint(current) !== item.fingerprint || !(await item.handle.isVisible())) throw new DriverFailure('STALE_REF');
      if (current.disabled) throw new DriverFailure('CONTROL_DISABLED');
      if (!classifyControl(current)) throw new DriverFailure('CONTROL_DENIED');
      if (actionType === 'fill' && !item.canFill || actionType === 'select' && !item.canSelect) throw new DriverFailure('CONTROL_DENIED');
    } catch (error) {
      try { await item.handle.dispose(); } catch { /* stale handle */ }
      if (error instanceof DriverFailure) throw error;
      throw new DriverFailure('STALE_REF');
    }
    return item;
  }

  async function runInteraction(session, request, actionType, markStarted) {
    const item = await checkedTarget(session, request.ref, actionType);
    try {
      if (settings.readOnlyMode && (actionType !== 'click' || item.role !== 'link' || typeof item.linkHref !== 'string')) {
        throw new DriverFailure('READ_ONLY_ACTION_DENIED');
      }
      if (actionType === 'click' && item.role === 'link') {
        let href;
        try { href = new URL(item.linkHref, session.page.url()).href; }
        catch { throw new DriverFailure('ORIGIN_DENIED'); }
        try { parseAllowedUrl(href, settings); } catch { throw new DriverFailure('ORIGIN_DENIED'); }
        if (settings.readOnlyMode && !settings.readOnlyNavigationUrls.has(href)) throw new DriverFailure('READ_ONLY_NAVIGATION_DENIED');
      }
      if (actionType === 'select') {
        const available = new Set(item.options.filter(option => !option.disabled && !option.hidden).map(option => option.value));
        if (request.values.some(value => !available.has(value)) || request.values.length > 1 && !item.multiple) throw new DriverFailure('INVALID_VALUE');
      }
      session.lastNetworkDenial = null;
      session.lastMainNavigationDenied = null;
      session.writeApprovalDepth += 1;
      markStarted();
      if (actionType === 'click') await item.handle.click({ timeout: 0 });
      else if (actionType === 'fill') await item.handle.fill(request.text, { timeout: 0 });
      else if (actionType === 'select') await item.handle.selectOption(request.values, { timeout: 0 });
      else if (actionType === 'press') await item.handle.press(request.key, { timeout: 0 });
      if (session.lastMainNavigationDenied) throw new DriverFailure(session.lastMainNavigationDenied);
      return successResult({
        type: actionType,
        url: displayUrl(session.page.url()),
        title: boundedText(await readTitle(session.page), 200, true).value,
        sideEffectStarted: true,
        networkOutcome: 'unknown',
        retryable: false,
      });
    } catch (error) {
      if (error instanceof DriverFailure) throw error;
      if (session.lastMainNavigationDenied) throw new DriverFailure(session.lastMainNavigationDenied);
      throw new DriverFailure('ACTION_FAILED');
    } finally {
      session.writeApprovalDepth = Math.max(0, session.writeApprovalDepth - 1);
      try { await item.handle.dispose(); } catch { /* context may have closed */ }
    }
  }

  async function execute(id, request, options = {}) {
    if (!validSessionId(id)) return errorResult('INVALID_SESSION_ID', { sideEffectStarted: false });
    if (!ensureKeys(options, new Set(['signal', 'approved']))) return errorResult('INVALID_REQUEST', { sideEffectStarted: false });
    if (!validateSignal(options.signal)) return errorResult('INVALID_SIGNAL', { sideEffectStarted: false });
    let parsed;
    try { parsed = parseRequest(request, settings); }
    catch (error) { return errorResult(safeErrorCode(error, 'INVALID_REQUEST'), { sideEffectStarted: false }); }
    const interaction = ['click', 'fill', 'select', 'press'].includes(parsed.type);
    if (interaction && options.approved !== true) return errorResult('APPROVAL_REQUIRED', { sideEffectStarted: false });
    const session = sessions.get(id);
    if (!session || session.closed || !session.context || !session.page) return errorResult('SESSION_NOT_FOUND', { sideEffectStarted: false, contextClosed: true });
    if (session.busy) return errorResult('SESSION_BUSY', { sideEffectStarted: false });
    if (options.signal?.aborted) return errorResult('CANCELLED', { sideEffectStarted: false });
    session.busy = true;
    session.lastNetworkDenial = null;
    session.lastMainNavigationDenied = null;
    let sideEffectStarted = false;
    const interruption = makeInterruption(options.signal, settings.timeoutMs, () => closeSessionInternal(session));
    const operation = (async () => {
      if (parsed.type === 'navigate') {
        invalidateRefs(session);
        sideEffectStarted = true;
        const response = await session.page.goto(parsed.url.href, { waitUntil: 'domcontentloaded', timeout: 0 });
        if (session.lastMainNavigationDenied) throw new DriverFailure(session.lastMainNavigationDenied);
        return successResult({
          type: 'navigate',
          url: displayUrl(session.page.url()),
          title: boundedText(await readTitle(session.page), 200, true).value,
          status: response ? response.status() : null,
          sideEffectStarted: true,
          retryable: false,
        });
      }
      if (parsed.type === 'observe') return await observe(session, parsed.offset);
      return await runInteraction(session, parsed, parsed.type, () => { sideEffectStarted = true; });
    })();
    operation.catch(() => {});
    try {
      return await Promise.race([operation, interruption.wait]);
    } catch (error) {
      const code = interruption.interrupted ? interruption.code : safeErrorCode(error, session.lastMainNavigationDenied || 'BROWSER_ERROR');
      if (sideEffectStarted) await closeSessionInternal(session);
      return errorResult(code || 'BROWSER_ERROR', {
        sideEffectStarted,
        contextClosed: session.closed,
        unknownEffects: interaction && sideEffectStarted,
        ...(sideEffectStarted ? { retryable: false } : {}),
      });
    } finally {
      interruption.dispose();
      if (!session.closed) session.busy = false;
    }
  }

  // Owner-only authenticated UI surface. Do not register this API as an LLM tool.
  async function preview(id, options = {}) {
    if (!validSessionId(id)) return errorResult('INVALID_SESSION_ID', { contextClosed: false });
    if (!ensureKeys(options, new Set(['signal']))) return errorResult('INVALID_REQUEST', { contextClosed: false });
    if (!validateSignal(options.signal)) return errorResult('INVALID_SIGNAL', { contextClosed: false });
    const session = sessions.get(id);
    if (!session || session.closed || !session.context || !session.page) return errorResult('SESSION_NOT_FOUND', { contextClosed: true });
    if (session.busy) return errorResult('SESSION_BUSY', { contextClosed: false });
    if (options.signal?.aborted) return errorResult('CANCELLED', { contextClosed: false });
    session.busy = true;
    const interruption = makeInterruption(options.signal, settings.timeoutMs, () => closeSessionInternal(session));
    const operation = (async () => {
      const viewport = session.page.viewportSize() ?? { width: 1280, height: 800 };
      const masks = [session.page.locator(PREVIEW_MASK_SELECTOR)];
      let image;
      try {
        for (const quality of PREVIEW_QUALITIES) {
          image = await session.page.screenshot({
            type: 'jpeg',
            quality,
            fullPage: false,
            scale: 'css',
            caret: 'hide',
            mask: masks,
            maskColor: '#000000',
            timeout: 0,
          });
          if (image.length <= MAX_PREVIEW_BYTES) break;
        }
      } catch {
        throw new DriverFailure('BROWSER_ERROR');
      }
      if (session.closed) throw new DriverFailure('SESSION_NOT_FOUND');
      if (!Buffer.isBuffer(image) || image.length > MAX_PREVIEW_BYTES) throw new DriverFailure('PREVIEW_TOO_LARGE');
      return successResult({
        contentType: 'image/jpeg',
        dataBase64: image.toString('base64'),
        capturedAt: new Date().toISOString(),
        url: displayUrl(session.page.url()),
        title: boundedText(await readTitle(session.page), 200, true).value,
        width: viewport.width,
        height: viewport.height,
      });
    })();
    operation.catch(() => {});
    try {
      return await Promise.race([operation, interruption.wait]);
    } catch (error) {
      return errorResult(interruption.interrupted ? interruption.code : safeErrorCode(error, 'BROWSER_ERROR'), {
        contextClosed: session.closed,
      });
    } finally {
      interruption.dispose();
      if (!session.closed) session.busy = false;
    }
  }

  // This is a trusted backend persistence API; execute() results never include
  // cookies or browser storage values.
  async function storageState(id, options = {}) {
    if (!validSessionId(id)) throw new DriverFailure('INVALID_SESSION_ID');
    if (!ensureKeys(options, new Set(['signal']))) throw new DriverFailure('INVALID_REQUEST');
    if (!validateSignal(options.signal)) throw new DriverFailure('INVALID_SIGNAL');
    const session = sessions.get(id);
    if (!session || session.closed || !session.context) throw new DriverFailure('SESSION_NOT_FOUND');
    if (session.busy) throw new DriverFailure('SESSION_BUSY');
    if (options.signal?.aborted) throw new DriverFailure('CANCELLED');
    session.busy = true;
    const interruption = makeInterruption(options.signal, settings.timeoutMs, () => closeSessionInternal(session));
    const operation = (async () => {
      let state;
      try { state = await session.context.storageState(); } catch { throw new DriverFailure('BROWSER_ERROR'); }
      let size;
      try { size = Buffer.byteLength(JSON.stringify(state), 'utf8'); } catch { throw new DriverFailure('BROWSER_ERROR'); }
      if (size > MAX_STORAGE_STATE_BYTES) throw new DriverFailure('STORAGE_STATE_TOO_LARGE');
      return state;
    })();
    operation.catch(() => {});
    try { return await Promise.race([operation, interruption.wait]); }
    catch (error) { throw new DriverFailure(interruption.interrupted ? interruption.code : safeErrorCode(error, 'BROWSER_ERROR')); }
    finally {
      interruption.dispose();
      if (!session.closed) session.busy = false;
    }
  }

  async function closeSession(id) {
    if (!validSessionId(id)) return errorResult('INVALID_SESSION_ID');
    const session = sessions.get(id);
    if (!session) return successResult({ closed: false });
    await closeSessionInternal(session);
    return successResult({ closed: true });
  }

  async function close() {
    if (driverClosed) return successResult();
    driverClosed = true;
    await Promise.allSettled([...sessions.values()].map(session => closeSessionInternal(session)));
    const pending = browserPromise;
    if (pending) {
      try { await pending; } catch { /* launch already failed */ }
    }
    const activeBrowser = browser;
    browser = undefined;
    browserPromise = undefined;
    if (activeBrowser) {
      try { await activeBrowser.close(); } catch { /* browser may already be closed */ }
    }
    return successResult();
  }

  return Object.freeze({ open, execute, preview, storageState, closeSession, close, validateUrl });
}
