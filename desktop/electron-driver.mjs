import { randomUUID } from 'node:crypto';

const ISOLATED_WORLD_ID = 999;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OBSERVATION_TEXT = 12_000;
const MAX_CONTROLS = 60;
const REF_TTL_MS = 30_000;
const SAFE_INPUT_TYPES = new Set(['text', 'email', 'search', 'tel', 'url', 'number', 'date', 'month', 'week', 'time', 'datetime-local']);
const BLOCKED_INPUT_TYPES = new Set(['password', 'hidden', 'file', 'image']);
const SENSITIVE_MARKERS = /(?:pass(?:word|wd)?|secret|token|auth(?:entication|orization)?|credential|api[_-]?key|credit.?card|card[_-]?number|cc[_-]?num|cvv|cvc|ssn|iban|routing[_-]?number|account[_-]?number|\bpin\b|one[_-]?time[_-]?code|\botp\b)/i;
const SAFE_PRESS_KEYS = new Map([
  ['Enter', 'ENTER'], ['Tab', 'TAB'], ['Escape', 'ESC'], ['ArrowDown', 'DOWN'],
  ['ArrowUp', 'UP'], ['Space', 'SPACE'],
]);
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REF_ID = /^[0-9a-f]{32}$/i;

function looksSensitiveValue(value) {
  return SENSITIVE_MARKERS.test(value) || /^[a-f0-9]{32,}$/i.test(value) || /^[A-Za-z0-9_-]{40,}$/.test(value);
}

class DriverFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'DriverFailure';
    this.code = code;
  }
}

function isRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
  } catch {
    return false;
  }
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every(key => allowed.has(key));
}

function plainString(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function normalizeOrigins(input) {
  if (!(Array.isArray(input) || input instanceof Set) || input.size > 100 || Array.isArray(input) && input.length > 100) {
    throw new DriverFailure('INVALID_CONFIG');
  }
  const origins = new Set();
  for (const value of input) {
    if (!plainString(value, 512)) throw new DriverFailure('INVALID_CONFIG');
    let parsed;
    try { parsed = new URL(value); } catch { throw new DriverFailure('INVALID_CONFIG'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin === 'null') {
      throw new DriverFailure('INVALID_CONFIG');
    }
    if (origins.has(parsed.origin)) throw new DriverFailure('INVALID_CONFIG');
    origins.add(parsed.origin);
  }
  return origins;
}

function parseHttpUrl(value) {
  if (!plainString(value, 4096)) throw new DriverFailure('INVALID_URL');
  let parsed;
  try { parsed = new URL(value); } catch { throw new DriverFailure('INVALID_URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.origin === 'null') {
    throw new DriverFailure('INVALID_URL');
  }
  return parsed;
}

function isAllowedUrl(value, origins, allowBlank = false) {
  if (allowBlank && value === 'about:blank') return true;
  try { return origins.has(parseHttpUrl(value).origin); } catch { return false; }
}

function displayUrl(value) {
  try {
    const parsed = parseHttpUrl(value);
    const path = Array.from(parsed.pathname).slice(0, 1024).join('');
    return `${parsed.origin}${path}`;
  } catch {
    return 'about:blank';
  }
}

function boundedText(value, max, collapse = false) {
  const source = typeof value === 'string' ? value : '';
  const normalized = collapse ? source.replace(/\s+/g, ' ').trim() : source;
  const chars = Array.from(normalized);
  return { value: chars.slice(0, max).join(''), truncated: chars.length > max };
}

function failureResult(code, options = {}) {
  return {
    ok: false,
    error: { code },
    ...(options.sideEffectStarted === undefined ? {} : { sideEffectStarted: options.sideEffectStarted }),
    ...(options.contextClosed === undefined ? {} : { contextClosed: options.contextClosed }),
    ...(options.sideEffectStarted === true ? { networkOutcome: 'unknown', retryable: false } : {}),
  };
}

function successResult(data = {}) {
  return { ok: true, ...data };
}

function safeErrorCode(error, fallback = 'BROWSER_ERROR') {
  return error instanceof DriverFailure ? error.code : fallback;
}

function validateSignal(signal) {
  return signal === undefined || Boolean(signal && typeof signal === 'object' &&
    typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function');
}

function raceWithInterruption(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new DriverFailure('CANCELLED'));
    const timer = setTimeout(() => finish(reject, new DriverFailure('TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    Promise.resolve(promise).then(value => finish(resolve, value), () => finish(reject, new DriverFailure('BROWSER_ERROR')));
  });
}

function validateRequest(request) {
  if (!isRecord(request) || typeof request.type !== 'string') throw new DriverFailure('INVALID_REQUEST');
  switch (request.type) {
    case 'observe':
      if (!hasOnlyKeys(request, new Set(['type']))) throw new DriverFailure('INVALID_REQUEST');
      return { type: 'observe' };
    case 'navigate':
      if (!hasOnlyKeys(request, new Set(['type', 'url']))) throw new DriverFailure('INVALID_REQUEST');
      return { type: 'navigate', url: parseHttpUrl(request.url).href };
    case 'click':
      if (!hasOnlyKeys(request, new Set(['type', 'ref'])) || typeof request.ref !== 'string' || !REF_ID.test(request.ref)) throw new DriverFailure('INVALID_REQUEST');
      return { type: 'click', ref: request.ref };
    case 'fill':
      if (!hasOnlyKeys(request, new Set(['type', 'ref', 'text'])) || typeof request.ref !== 'string' || !REF_ID.test(request.ref) ||
          typeof request.text !== 'string' || Array.from(request.text).length > 8000) throw new DriverFailure('INVALID_REQUEST');
      return { type: 'fill', ref: request.ref, text: request.text };
    case 'select':
      if (!hasOnlyKeys(request, new Set(['type', 'ref', 'values'])) || typeof request.ref !== 'string' || !REF_ID.test(request.ref) ||
          !Array.isArray(request.values) || request.values.length < 1 || request.values.length > 20 ||
          request.values.some(value => typeof value !== 'string' || value.length > 500 || /[\x00-\x1f\x7f]/.test(value))) {
        throw new DriverFailure('INVALID_REQUEST');
      }
      return { type: 'select', ref: request.ref, values: [...request.values] };
    case 'press':
      if (!hasOnlyKeys(request, new Set(['type', 'ref', 'key'])) || typeof request.ref !== 'string' || !REF_ID.test(request.ref) ||
          !SAFE_PRESS_KEYS.has(request.key)) throw new DriverFailure('INVALID_REQUEST');
      return { type: 'press', ref: request.ref, key: request.key };
    default:
      throw new DriverFailure('INVALID_REQUEST');
  }
}

function buildIsolatedCall(payload) {
  // Arguments are JSON data only. The executable program below is fixed and has
  // no selector, script, or CSS field supplied by the model.
  const quotedPayload = JSON.stringify(JSON.stringify(payload));
  return `(() => {
    /* micro-dsh-electron-driver:fixed-world-program */
    const d = JSON.parse(${quotedPayload});
    const SENSITIVE = /(?:pass(?:word|wd)?|secret|token|auth(?:entication|orization)?|credential|api[_-]?key|credit.?card|card[_-]?number|cc[_-]?num|cvv|cvc|ssn|iban|routing[_-]?number|account[_-]?number|\\bpin\\b|one[_-]?time[_-]?code|\\botp\\b)/i;
    const looksSensitiveValue = value => SENSITIVE.test(value) || /^[a-f0-9]{32,}$/i.test(value) || /^[A-Za-z0-9_-]{40,}$/.test(value);
    const EDITOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';
    const BLOCKED = new Set(['password', 'hidden', 'file', 'image']);
    const SAFE_INPUT = new Set(['text', 'email', 'search', 'tel', 'url', 'number', 'date', 'month', 'week', 'time', 'datetime-local']);
    const CONTROL_SELECTOR = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [contenteditable="true"]';
    const clip = (value, size, collapse = true) => {
      const text = String(value ?? '');
      const normalized = collapse ? text.replace(/\\s+/g, ' ').trim() : text;
      return Array.from(normalized).slice(0, size).join('');
    };
    const state = () => {
      let value = globalThis[d.namespace];
      if (!value || !(value.refs instanceof Map)) {
        value = { refs: new Map(), epoch: -1, generation: -1, timer: null };
        Object.defineProperty(globalThis, d.namespace, { value, configurable: true, writable: true });
      }
      return value;
    };
    const isVisible = element => {
      if (!(element instanceof Element) || !element.isConnected) return false;
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
            style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    };
    const sensitiveElement = element => {
      const fields = ['name', 'id', 'autocomplete', 'aria-label', 'placeholder', 'title']
        .map(name => element.getAttribute(name) || '').join(' ');
      return SENSITIVE.test(fields);
    };
    const isBlockedText = element => {
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const tag = node.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template', 'input', 'textarea', 'select', 'option'].includes(tag) ||
            node.matches(EDITOR) || sensitiveElement(node)) return true;
      }
      return false;
    };
    const roleOf = element => {
      const role = element.getAttribute('role');
      if (role) return role;
      const tag = element.tagName.toLowerCase();
      const type = tag === 'input' ? (element.type || 'text').toLowerCase() : '';
      if (tag === 'button' || tag === 'a' || tag === 'select' || tag === 'textarea') {
        return ({ button: 'button', a: 'link', select: 'combobox', textarea: 'textbox' })[tag];
      }
      if (tag === 'input') {
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        if (type === 'checkbox' || type === 'radio') return type;
        return 'textbox';
      }
      if (element.getAttribute('contenteditable') === 'true') return 'textbox';
      return '';
    };
    const describe = element => {
      if (!isVisible(element) || sensitiveElement(element)) return null;
      const tag = element.tagName.toLowerCase();
      const type = tag === 'input' ? String(element.type || 'text').toLowerCase() : '';
      if (BLOCKED.has(type) || element.hasAttribute('download')) return null;
      if (tag === 'input' && !SAFE_INPUT.has(type) && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type)) return null;
      const role = roleOf(element);
      if (!['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox'].includes(role)) return null;
      const canFill = tag === 'textarea' || tag === 'input' && SAFE_INPUT.has(type) || element.getAttribute('contenteditable') === 'true';
      const canSelect = tag === 'select';
      let href = '';
      if (tag === 'a') {
        try {
          const target = new URL(element.href, location.href);
          if (!['http:', 'https:'].includes(target.protocol) || !d.allowedOrigins.includes(target.origin)) return null;
          href = target.href;
        } catch { return null; }
      }
      const associatedLabels = tag === 'input' || tag === 'textarea' || tag === 'select'
        ? Array.from(element.labels || []).map(label => label.innerText || label.textContent || '').join(' ')
        : '';
      const text = ['button', 'a'].includes(tag) || ['button', 'link'].includes(role) ? (element.innerText || element.textContent || '') : '';
      const label = element.getAttribute('aria-label') || associatedLabels || element.getAttribute('placeholder') ||
        element.getAttribute('title') || text;
      const options = canSelect ? Array.from(element.options).slice(0, 50).map(option => ({
        value: clip(option.value, 200), label: clip(option.label || option.textContent || '', 160),
        disabled: Boolean(option.disabled || option.parentElement?.disabled), hidden: Boolean(option.hidden),
      })) : [];
      if (options.some(option => looksSensitiveValue(option.value) || SENSITIVE.test(option.label))) return null;
      const disabled = Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true');
      const formAction = element.form
        ? String(element.hasAttribute('formaction') ? element.formAction || '' : element.form.action || '')
        : '';
      const fingerprint = JSON.stringify([tag, type, role, element.id || '', element.getAttribute('name') || '',
        element.getAttribute('aria-label') || '', clip(label, 300), href, formAction,
        element.getAttribute('contenteditable') || '', disabled]);
      return { element, tag, type, role, label: clip(label, 200), disabled, canFill, canSelect,
        href, formAction, options, optionCount: canSelect ? element.options.length : 0, fingerprint };
    };
    const visibleBodyText = limit => {
      if (!document.body) return '';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const pieces = [];
      let total = 0;
      for (let node = walker.nextNode(); node && total < limit + 1; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || isBlockedText(parent) || !isVisible(parent)) continue;
        const text = clip(node.nodeValue || '', limit + 1 - total);
        if (!text) continue;
        pieces.push(text);
        total += text.length + 1;
      }
      return pieces.join(' ').slice(0, limit + 1);
    };
    const safeUrl = () => {
      try {
        const url = new URL(location.href);
        if (!['http:', 'https:'].includes(url.protocol)) return 'about:blank';
        return url.origin + Array.from(url.pathname).slice(0, 1024).join('');
      } catch { return 'about:blank'; }
    };
    const stale = code => ({ ok: false, error: { code }, sideEffectStarted: false });
    const getItem = (ref, expectedEpoch) => {
      const current = state();
      const item = current.refs.get(ref);
      if (!item || item.epoch !== expectedEpoch || current.epoch !== expectedEpoch || item.generation !== current.generation ||
          item.expiresAt < Date.now() || item.document !== document) return null;
      const now = describe(item.element);
      if (!now || now.fingerprint !== item.fingerprint) return null;
      return { current, item, now };
    };
    const describeAction = (ref, expectedEpoch, action) => {
      const found = getItem(ref, expectedEpoch);
      if (!found) return stale('STALE_REF');
      const { item, now } = found;
      if (now.disabled) return stale('CONTROL_DISABLED');
      if (action === 'fill' && !item.canFill || action === 'select' && !item.canSelect) return stale('CONTROL_DENIED');
      if (action === 'click') {
        const rect = item.element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === item.element || item.element.contains(hit))) return stale('STALE_REF');
        const submit = item.element.tagName.toLowerCase() === 'button' && (item.element.type || 'submit') === 'submit' ||
          item.element.tagName.toLowerCase() === 'input' && item.element.type === 'submit';
        return { ok: true, type: 'click', x, y, href: now.href, formAction: submit ? now.formAction : '',
          documentUrl: safeUrl(), fingerprint: item.fingerprint };
      }
      return { ok: true, type: action, fingerprint: item.fingerprint, tag: now.tag, inputType: now.type };
    };
    const perform = (ref, expectedEpoch, action, data) => {
      const found = getItem(ref, expectedEpoch);
      if (!found) return stale('STALE_REF');
      const { current, item, now } = found;
      if (now.disabled) return stale('CONTROL_DISABLED');
      if (action === 'click') {
        const prepared = describeAction(ref, expectedEpoch, 'click');
        if (!prepared.ok) return prepared;
        try {
          current.refs.clear();
          const click = item.element.ownerDocument.defaultView.HTMLElement.prototype.click;
          click.call(item.element);
          return { ok: true, sideEffectStarted: true, type: 'click', clickMechanism: 'dom', trustedInput: false, url: safeUrl() };
        } catch { current.refs.clear(); return { ok: false, error: { code: 'ACTION_FAILED' }, sideEffectStarted: true }; }
      }
      if (action === 'focus') {
        try {
          const focus = item.element.ownerDocument.defaultView.HTMLElement.prototype.focus;
          focus.call(item.element, { preventScroll: true });
          return { ok: true, sideEffectStarted: true };
        } catch { return { ok: false, error: { code: 'ACTION_FAILED' }, sideEffectStarted: true }; }
      }
      if (action === 'fill') {
        if (!item.canFill || typeof data.text !== 'string' || Array.from(data.text).length > 8000) return stale('CONTROL_DENIED');
        try {
          if (item.element.tagName.toLowerCase() === 'input') {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!setter) return stale('CONTROL_DENIED');
            setter.call(item.element, data.text);
          } else if (item.element.tagName.toLowerCase() === 'textarea') {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (!setter) return stale('CONTROL_DENIED');
            setter.call(item.element, data.text);
          } else if (item.element.getAttribute('contenteditable') === 'true') {
            item.element.replaceChildren(document.createTextNode(data.text));
          } else return stale('CONTROL_DENIED');
          item.element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          item.element.dispatchEvent(new Event('change', { bubbles: true }));
          current.refs.clear();
          return { ok: true, sideEffectStarted: true, type: 'fill', url: safeUrl() };
        } catch { current.refs.clear(); return { ok: false, error: { code: 'ACTION_FAILED' }, sideEffectStarted: true }; }
      }
      if (action === 'select') {
        if (!item.canSelect || !Array.isArray(data.values) || data.values.length < 1) return stale('CONTROL_DENIED');
        const select = item.element;
        const available = Array.from(select.options).filter(option => !option.disabled && !option.hidden && !option.parentElement?.disabled);
        if (data.values.some(value => !available.some(option => option.value === value)) || data.values.length > 1 && !select.multiple) return stale('INVALID_VALUE');
        try {
          const chosen = new Set(data.values);
          for (const option of select.options) option.selected = chosen.has(option.value);
          select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          current.refs.clear();
          return { ok: true, sideEffectStarted: true, type: 'select', url: safeUrl() };
        } catch { current.refs.clear(); return { ok: false, error: { code: 'ACTION_FAILED' }, sideEffectStarted: true }; }
      }
      return stale('INVALID_REQUEST');
    };
    try {
      if (d.op === 'observe') {
        const current = state();
        current.refs.clear();
        current.epoch = d.epoch;
        current.generation = d.generation;
        if (current.timer) clearTimeout(current.timer);
        current.timer = setTimeout(() => { current.refs.clear(); }, d.ttlMs + 1000);
        const controls = [];
        const candidates = document.querySelectorAll(CONTROL_SELECTOR);
        const scanLimit = Math.min(candidates.length, 400, d.maxControls * 6);
        let refIndex = 0;
        for (let index = 0; index < scanLimit && controls.length < d.maxControls; index += 1) {
          const description = describe(candidates[index]);
          if (!description || refIndex >= d.refs.length) continue;
          const ref = d.refs[refIndex++];
          current.refs.set(ref, { ...description, document, epoch: d.epoch, generation: d.generation, expiresAt: Date.now() + d.ttlMs });
          const control = { ref, role: description.role, label: description.label, disabled: description.disabled };
          if (description.type) control.type = clip(description.type, 32);
          if (description.canSelect) {
            control.options = description.options.slice(0, 25).map(option => ({ value: option.value, label: option.label,
              disabled: Boolean(option.disabled || option.hidden) }));
            control.optionsTruncated = description.optionCount > control.options.length || description.options.length > control.options.length;
          }
          controls.push(control);
        }
        const rawText = visibleBodyText(d.maxTextChars);
        const text = clip(rawText, d.maxTextChars, false);
        const title = clip(document.title || '', 200);
        return { ok: true, type: 'observe', url: safeUrl(), title, text,
          textTruncated: rawText.length > d.maxTextChars, controls,
          controlsTruncated: candidates.length > scanLimit || controls.length >= d.maxControls && candidates.length > controls.length };
      }
      if (d.op === 'prepare') return describeAction(d.ref, d.epoch, d.action);
      if (d.op === 'perform') return perform(d.ref, d.epoch, d.action, d);
      if (d.op === 'invalidate') {
        const current = state(); current.refs.clear(); current.epoch = d.epoch; current.generation = d.generation;
        return { ok: true };
      }
      return stale('INVALID_REQUEST');
    } catch { return { ok: false, error: { code: 'BROWSER_ERROR' }, sideEffectStarted: false }; }
  })()`;
}

function normalizeTab(tab) {
  if (!tab || typeof tab !== 'object' || typeof tab.id !== 'string' || !tab.view?.webContents) throw new DriverFailure('TAB_NOT_FOUND');
  const webContents = tab.view.webContents;
  if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) throw new DriverFailure('TAB_CLOSED');
  if (typeof webContents.executeJavaScriptInIsolatedWorld !== 'function') throw new DriverFailure('ELECTRON_API_UNAVAILABLE');
  return tab;
}

function validateHost(host) {
  const required = ['getTabForSession', 'bindAgentSession', 'unbindAgentSession', 'getBoundTab', 'assertAgentControl',
    'bindHarnessSession', 'getAgentAllowedOrigins', 'beginAgentInput', 'endAgentInput'];
  if (!host || required.some(name => typeof host[name] !== 'function')) throw new DriverFailure('INVALID_HOST');
}

export function createElectronDriver({ host, allowedOrigins = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  validateHost(host);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new DriverFailure('INVALID_CONFIG');
  let fallbackOrigins = normalizeOrigins(allowedOrigins);
  let driverClosed = false;
  const sessions = new Map();

  function validateUrl(url) {
    try { parseHttpUrl(url); return successResult(); }
    catch (error) { return failureResult(safeErrorCode(error, 'INVALID_URL')); }
  }

  function setAllowedOrigins(origins) {
    fallbackOrigins = normalizeOrigins(origins);
    return [...fallbackOrigins];
  }

  async function resolveOrigins(tabId) {
    let configured;
    try { configured = await host.getAgentAllowedOrigins(tabId); }
    catch { throw new DriverFailure('ORIGIN_DENIED'); }
    return configured === undefined || configured === null ? new Set(fallbackOrigins) : normalizeOrigins(configured);
  }

  async function boundTab(session) {
    let tab;
    try { tab = await host.getBoundTab(session.id); } catch { throw new DriverFailure('TAB_NOT_FOUND'); }
    tab = normalizeTab(tab);
    if (tab.id !== session.tabId) throw new DriverFailure('BINDING_MISMATCH');
    if (session.webContents && tab.view.webContents !== session.webContents) throw new DriverFailure('BINDING_MISMATCH');
    return tab;
  }

  function assertControl(tab, session, { checkRevision = true } = {}) {
    if (typeof tab.view.webContents.isDestroyed === 'function' && tab.view.webContents.isDestroyed()) throw new DriverFailure('TAB_CLOSED');
    if (checkRevision && !Object.is(tab.revision, session.revision)) {
      invalidateHostRefs(session);
      throw new DriverFailure('STALE_REF');
    }
    if (session.mode !== undefined && !Object.is(tab.mode, session.mode)) throw new DriverFailure('CONTROL_DENIED');
    let result;
    try { result = host.assertAgentControl(tab.id); }
    catch { throw new DriverFailure('CONTROL_DENIED'); }
    if (result === false || result?.ok === false) throw new DriverFailure('CONTROL_DENIED');
    if (result && typeof result.then === 'function') throw new DriverFailure('INVALID_HOST');
    return tab.view.webContents;
  }

  async function checkedTab(session, options) {
    const tab = await boundTab(session);
    if (options?.checkRevision !== false && !Object.is(tab.revision, session.revision) && Date.now() < session.allowAgentRevisionUntil) {
      assertControl(tab, session, { checkRevision: false });
      session.revision = tab.revision;
      session.mode = tab.mode;
      session.allowAgentRevisionUntil = 0;
      invalidateHostRefs(session);
    }
    assertControl(tab, session, options);
    return tab;
  }

  function invalidateHostRefs(session) {
    session.refs.clear();
    session.refsExpireAt = 0;
    session.generation += 1;
    session.epoch += 1;
  }

  function attachListeners(session, tab) {
    const contents = tab.view.webContents;
    const willNavigate = (event, url) => {
      if (!isAllowedUrl(url, session.allowedOrigins, true)) {
        session.lastNavigationDenied = 'ORIGIN_DENIED';
        event?.preventDefault?.();
      }
    };
    const willRedirect = (event, url) => willNavigate(event, url);
    const mainFrame = value => value !== false;
    const didStartNavigation = (_event, _url, _isInPlace, isMainFrame) => {
      if (!mainFrame(isMainFrame)) return;
      session.navigationCount += 1;
      session.navigationPending = true;
      invalidateHostRefs(session);
    };
    const didFinishLoad = () => {
      session.navigationPending = false;
      session.navigationFinished?.();
    };
    const didFailLoad = (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
      if (!mainFrame(isMainFrame)) return;
      session.navigationPending = false;
      if (errorCode !== -3 && !session.lastNavigationDenied) session.lastNavigationDenied = 'NAVIGATION_FAILED';
      session.navigationFinished?.();
    };
    const didNavigateInPage = (_event, _url, isMainFrame) => {
      if (!mainFrame(isMainFrame)) return;
      session.navigationCount += 1;
      invalidateHostRefs(session);
      session.navigationPending = false;
      session.navigationFinished?.();
    };
    const destroyed = () => { session.closedByHost = true; invalidateHostRefs(session); };
    const listeners = [
      ['will-navigate', willNavigate], ['will-redirect', willRedirect],
      ['did-start-navigation', didStartNavigation], ['did-finish-load', didFinishLoad], ['did-fail-load', didFailLoad],
      ['did-navigate-in-page', didNavigateInPage], ['destroyed', destroyed],
    ];
    for (const [event, listener] of listeners) contents.on?.(event, listener);
    session.listeners = listeners;
    session.webContents = contents;
  }

  function detachListeners(session) {
    for (const [event, listener] of session.listeners ?? []) {
      session.webContents?.removeListener?.(event, listener);
      session.webContents?.off?.(event, listener);
    }
    session.listeners = [];
    session.webContents = null;
  }

  function isolatedCall(session, payload) {
    const data = { namespace: session.namespace, epoch: session.epoch, ...payload };
    return session.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: buildIsolatedCall(data) }]);
  }

  async function runWorld(session, payload, signal, sideEffectStarted = false) {
    let call;
    try { call = isolatedCall(session, payload); }
    catch { throw Object.assign(new DriverFailure('BROWSER_ERROR'), { sideEffectStarted: false }); }
    try { return await raceWithInterruption(call, timeoutMs, signal); }
    catch (error) { throw Object.assign(new DriverFailure(safeErrorCode(error)), { sideEffectStarted }); }
  }

  function safeWorldResult(result) {
    if (!isRecord(result) || typeof result.ok !== 'boolean') throw new DriverFailure('BROWSER_PROTOCOL_ERROR');
    if (result.ok === false) {
      const code = /^[A-Z_]{1,64}$/.test(result.error?.code ?? '') ? result.error.code : 'BROWSER_ERROR';
      return failureResult(code, { sideEffectStarted: result.sideEffectStarted === true });
    }
    return result;
  }

  function sanitizeObservation(result) {
    const safeControls = [];
    for (const control of Array.isArray(result.controls) ? result.controls.slice(0, MAX_CONTROLS) : []) {
      if (!isRecord(control) || typeof control.ref !== 'string' || !REF_ID.test(control.ref) ||
          typeof control.role !== 'string' || typeof control.label !== 'string') continue;
      const label = boundedText(control.label, 200, true).value;
      const type = typeof control.type === 'string' ? boundedText(control.type, 32, true).value : '';
      if (SENSITIVE_MARKERS.test(label) || SENSITIVE_MARKERS.test(type) || BLOCKED_INPUT_TYPES.has(type.toLowerCase())) continue;
      const options = Array.isArray(control.options) ? control.options.slice(0, 25).filter(isRecord).map(option => ({
        value: boundedText(option.value, 200, true).value,
        label: boundedText(option.label, 160, true).value,
        disabled: option.disabled === true,
      })) : undefined;
      if (options?.some(option => looksSensitiveValue(option.value) || SENSITIVE_MARKERS.test(option.label))) continue;
      const item = {
        ref: control.ref,
        role: boundedText(control.role, 32, true).value,
        label,
        disabled: control.disabled === true,
      };
      if (type) item.type = type;
      if (options) {
        item.options = options;
        item.optionsTruncated = control.optionsTruncated === true;
      }
      safeControls.push(item);
    }
    const text = boundedText(result.text, MAX_OBSERVATION_TEXT);
    return successResult({
      type: 'observe',
      url: displayUrl(result.url),
      title: boundedText(result.title, 200, true).value,
      text: text.value,
      textTruncated: result.textTruncated === true || text.truncated,
      controls: safeControls,
      controlsTruncated: result.controlsTruncated === true,
    });
  }

  function isCurrentRef(session, ref) {
    return session.refs.has(ref) && Date.now() < session.refsExpireAt;
  }

  function invalidateSessionRefs(id) {
    const session = sessions.get(id);
    if (!session || session.closed) return failureResult('SESSION_NOT_FOUND', { sideEffectStarted: false });
    invalidateHostRefs(session);
    return successResult({ invalidated: true });
  }

  async function pauseHarnessSession(harnessSessionId, tabId) {
    if (!plainString(harnessSessionId, 256) || !plainString(tabId, 128)) return failureResult('INVALID_REQUEST');
    const matched = [...sessions.values()].filter(session => session.harnessSessionId === harnessSessionId && session.tabId === tabId);
    for (const session of matched) {
      session.paused = true;
      invalidateHostRefs(session);
    }
    if (typeof host.pauseHarnessSession !== 'function') return failureResult('HOST_CONTROL_UNAVAILABLE');
    try {
      const result = await host.pauseHarnessSession(harnessSessionId, tabId);
      if (result === false || result?.ok === false) return failureResult('CONTROL_DENIED');
      return successResult({ paused: true });
    } catch (error) {
      return failureResult(safeErrorCode(error, 'CONTROL_DENIED'));
    }
  }

  async function resumeHarnessSession(harnessSessionId, tabId) {
    if (!plainString(harnessSessionId, 256) || !plainString(tabId, 128)) return failureResult('INVALID_REQUEST');
    const matched = [...sessions.values()].filter(session => session.harnessSessionId === harnessSessionId && session.tabId === tabId);
    for (const session of matched) {
      session.paused = true;
      invalidateHostRefs(session);
    }
    if (typeof host.resumeHarnessSession !== 'function') return failureResult('HOST_CONTROL_UNAVAILABLE');
    try {
      const result = await host.resumeHarnessSession(harnessSessionId, tabId);
      if (result === false || result?.ok === false) return failureResult('CONTROL_DENIED');
      for (const session of matched) {
        const tab = await boundTab(session);
        if (tab.mode !== 'agent') throw new DriverFailure('CONTROL_DENIED');
        session.mode = tab.mode;
        assertControl(tab, session, { checkRevision: false });
        session.revision = tab.revision;
        session.navigationPending = false;
        session.navigationCount += 1;
        session.navigationFinished?.();
        session.lastNavigationDenied = null;
        session.expectedAgentAction = false;
        session.allowAgentRevisionUntil = 0;
        session.paused = false;
        invalidateHostRefs(session);
      }
      return successResult({ resumed: true });
    } catch (error) {
      return failureResult(safeErrorCode(error, 'CONTROL_DENIED'));
    }
  }

  async function inspectTarget(session, request, signal) {
    if (!isCurrentRef(session, request.ref)) throw new DriverFailure('STALE_REF');
    const tab = await checkedTab(session);
    if (signal?.aborted) throw new DriverFailure('CANCELLED');
    const raw = await runWorld(session, { op: 'prepare', ref: request.ref, action: request.type }, signal);
    const result = safeWorldResult(raw);
    if (!result.ok) throw new DriverFailure(result.error.code);
    if (!isRecord(result) || result.type !== request.type) throw new DriverFailure('STALE_REF');
    const after = await boundTab(session);
    assertControl(after, session);
    if (request.type === 'click') {
      if (!Number.isFinite(result.x) || !Number.isFinite(result.y) || result.x < 0 || result.y < 0) throw new DriverFailure('STALE_REF');
      if (result.href && !isAllowedUrl(result.href, session.allowedOrigins)) throw new DriverFailure('ORIGIN_DENIED');
      if (result.formAction && !isAllowedUrl(result.formAction, session.allowedOrigins)) throw new DriverFailure('ORIGIN_DENIED');
    }
    return { tab: after, result };
  }

  function callInputGate(tab) {
    let result;
    try { result = host.beginAgentInput(tab.id); }
    catch { throw Object.assign(new DriverFailure('CONTROL_DENIED'), { sideEffectStarted: false }); }
    if (result === false || result?.ok === false) throw Object.assign(new DriverFailure('CONTROL_DENIED'), { sideEffectStarted: false });
    if (result && typeof result.then === 'function') throw Object.assign(new DriverFailure('INVALID_HOST'), { sideEffectStarted: false });
  }

  function emitTrustedInputs(tab, events) {
    const contents = tab.view.webContents;
    let started = false;
    callInputGate(tab);
    try {
      // The trusted approval UI has focus until this point. Native keyboard /
      // mouse dispatch must target the real page, not the browser chrome.
      contents.focus?.();
      for (const event of events) {
        if (!started) started = true;
        contents.sendInputEvent(event);
      }
    } catch {
      throw Object.assign(new DriverFailure('ACTION_FAILED'), { sideEffectStarted: started });
    } finally {
      try { host.endAgentInput(tab.id); } catch { /* the host gate closes in its own event turn */ }
    }
    return started;
  }

  async function waitForNavigation(session, previousCount, signal) {
    if (session.navigationCount === previousCount) await new Promise(resolve => setTimeout(resolve, 25));
    if (session.navigationCount === previousCount || !session.navigationPending) return;
    const pending = new Promise((resolve, reject) => {
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        session.navigationFinished = null;
        if (error) reject(error); else resolve();
      };
      const onAbort = () => finish(new DriverFailure('CANCELLED'));
      timer = setTimeout(() => finish(new DriverFailure('TIMEOUT')), timeoutMs);
      session.navigationFinished = () => finish();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    await pending;
  }

  async function adoptPostActionRevision(session) {
    const tab = await boundTab(session);
    assertControl(tab, session, { checkRevision: false });
    const revisionChanged = !Object.is(tab.revision, session.revision);
    session.revision = tab.revision;
    session.mode = tab.mode;
    if (revisionChanged) session.allowAgentRevisionUntil = 0;
    invalidateHostRefs(session);
    return tab;
  }

  async function navigate(session, url, signal) {
    if (!session.allowedOrigins.has(new URL(url).origin)) return failureResult('ORIGIN_DENIED', { sideEffectStarted: false });
    let tab;
    try { tab = await checkedTab(session); }
    catch (error) { return failureResult(safeErrorCode(error), { sideEffectStarted: false, contextClosed: session.closedByHost }); }
    if (signal?.aborted) return failureResult('CANCELLED', { sideEffectStarted: false });
    if (session.allowedOrigins.size === 0) return failureResult('ORIGIN_DENIED', { sideEffectStarted: false });
    const current = tab.view.webContents.getURL?.() ?? 'about:blank';
    const beforeNavigationCount = session.navigationCount;
    session.lastNavigationDenied = null;
    let pending;
    try {
      // The approval and ownership checks are the last calls before starting navigation.
      const latestTab = await boundTab(session);
      assertControl(latestTab, session);
      if (signal?.aborted) return failureResult('CANCELLED', { sideEffectStarted: false });
      session.expectedAgentAction = true;
      pending = latestTab.view.webContents.loadURL(url);
      session.allowAgentRevisionUntil = Date.now() + timeoutMs;
    } catch (error) {
      session.expectedAgentAction = false;
      return failureResult(safeErrorCode(error), { sideEffectStarted: false, contextClosed: session.closedByHost });
    }
    try {
      await raceWithInterruption(pending, timeoutMs, signal);
      await waitForNavigation(session, beforeNavigationCount, signal);
      if (session.lastNavigationDenied) throw new DriverFailure(session.lastNavigationDenied);
      const nextTab = await adoptPostActionRevision(session);
      const pageUrl = nextTab.view.webContents.getURL?.() ?? current;
      if (!isAllowedUrl(pageUrl, session.allowedOrigins, true)) throw new DriverFailure('ORIGIN_DENIED');
      return successResult({ type: 'navigate', url: displayUrl(pageUrl), sideEffectStarted: true,
        networkOutcome: 'unknown', retryable: false });
    } catch (error) {
      return failureResult(session.lastNavigationDenied || safeErrorCode(error, 'NAVIGATION_FAILED'), {
        sideEffectStarted: true, contextClosed: session.closedByHost,
      });
    } finally {
      session.expectedAgentAction = false;
    }
  }

  async function performDomAction(session, request, signal) {
    try { await inspectTarget(session, request, signal); }
    catch (error) { return failureResult(safeErrorCode(error), { sideEffectStarted: false, contextClosed: session.closedByHost }); }
    const previousNavigationCount = session.navigationCount;
    let dispatched = false;
    const payload = { op: 'perform', ref: request.ref, action: request.type,
      ...(request.type === 'fill' ? { text: request.text } : {}), ...(request.type === 'select' ? { values: request.values } : {}) };
    try {
      if (signal?.aborted) return failureResult('CANCELLED', { sideEffectStarted: false });
      // Recheck ownership immediately before dispatching the fixed isolated-world action.
      const latestTab = await boundTab(session);
      assertControl(latestTab, session);
      session.expectedAgentAction = true;
      session.refs.clear();
      session.refsExpireAt = 0;
      const pending = runWorld(session, payload, signal, true);
      dispatched = true;
      const raw = await pending;
      const result = safeWorldResult(raw);
      if (result.sideEffectStarted === true || result.ok) session.allowAgentRevisionUntil = Date.now() + timeoutMs;
      if (!result.ok) {
        if (result.sideEffectStarted === true) await adoptPostActionRevision(session).catch(() => {});
        return result;
      }
      if (result.sideEffectStarted !== true) return failureResult('BROWSER_PROTOCOL_ERROR', { sideEffectStarted: true });
      await waitForNavigation(session, previousNavigationCount, signal);
      const nextTab = await adoptPostActionRevision(session);
      if (!isAllowedUrl(nextTab.view.webContents.getURL?.() ?? 'about:blank', session.allowedOrigins, true)) {
        return failureResult('ORIGIN_DENIED', { sideEffectStarted: true });
      }
      return successResult({ type: request.type, url: displayUrl(nextTab.view.webContents.getURL?.() ?? 'about:blank'),
        ...(request.type === 'click' ? { clickMechanism: 'dom', trustedInput: false } : {}),
        sideEffectStarted: true, networkOutcome: 'unknown', retryable: false });
    } catch (error) {
      return failureResult(safeErrorCode(error, 'ACTION_FAILED'), {
        sideEffectStarted: error?.sideEffectStarted === false ? false : dispatched || error?.sideEffectStarted === true,
        contextClosed: session.closedByHost,
      });
    } finally {
      session.expectedAgentAction = false;
      session.refs.clear();
      session.refsExpireAt = 0;
    }
  }

  async function press(session, request, signal) {
    let target;
    try { target = await inspectTarget(session, request, signal); }
    catch (error) { return failureResult(safeErrorCode(error), { sideEffectStarted: false, contextClosed: session.closedByHost }); }
    const previousNavigationCount = session.navigationCount;
    let started = false;
    try {
      if (signal?.aborted) return failureResult('CANCELLED', { sideEffectStarted: false });
      // Focusing may run page handlers, so it is approved and counted as dispatch.
      const focusTab = await boundTab(session);
      assertControl(focusTab, session);
      session.expectedAgentAction = true;
      session.refs.clear();
      session.refsExpireAt = 0;
      let rawFocus;
      try {
        rawFocus = await runWorld(session, { op: 'perform', ref: request.ref, action: 'focus' }, signal, true);
        started = true;
      } catch (error) {
        started = error?.sideEffectStarted === true;
        throw error;
      }
      const focused = safeWorldResult(rawFocus);
      started = focused.sideEffectStarted === true;
      if (!focused.ok) return failureResult(focused.error.code, { sideEffectStarted: focused.sideEffectStarted === true });
      const keyCode = SAFE_PRESS_KEYS.get(request.key);
      const latestTab = await boundTab(session);
      assertControl(latestTab, session);
      emitTrustedInputs(latestTab, [
        { type: 'keyDown', keyCode },
        { type: 'keyUp', keyCode },
      ]);
      session.allowAgentRevisionUntil = Date.now() + timeoutMs;
      await waitForNavigation(session, previousNavigationCount, signal);
      if (session.lastNavigationDenied) throw new DriverFailure(session.lastNavigationDenied);
      const nextTab = await adoptPostActionRevision(session);
      return successResult({ type: 'press', url: displayUrl(nextTab.view.webContents.getURL?.() ?? 'about:blank'),
        sideEffectStarted: true, networkOutcome: 'unknown', retryable: false });
    } catch (error) {
      return failureResult(session.lastNavigationDenied || safeErrorCode(error, 'ACTION_FAILED'), {
        sideEffectStarted: error?.sideEffectStarted === false ? false : started || error?.sideEffectStarted === true,
        contextClosed: session.closedByHost,
      });
    } finally {
      session.expectedAgentAction = false;
      session.refs.clear();
      session.refsExpireAt = 0;
    }
  }

  async function observe(session, signal) {
    const tab = await checkedTab(session);
    if (signal?.aborted) return failureResult('CANCELLED', { sideEffectStarted: false });
    const currentUrl = tab.view.webContents.getURL?.() ?? 'about:blank';
    if (!isAllowedUrl(currentUrl, session.allowedOrigins, true)) return failureResult('ORIGIN_DENIED', { sideEffectStarted: false });
    const generation = session.generation + 1;
    const refs = Array.from({ length: MAX_CONTROLS }, () => randomUUID().replaceAll('-', ''));
    const raw = await runWorld(session, { op: 'observe', generation, refs, maxTextChars: MAX_OBSERVATION_TEXT,
      maxControls: MAX_CONTROLS, ttlMs: REF_TTL_MS, allowedOrigins: [...session.allowedOrigins] }, signal);
    const result = safeWorldResult(raw);
    if (!result.ok) return result;
    const after = await checkedTab(session);
    if (after.revision !== tab.revision) {
      invalidateHostRefs(session);
      return failureResult('STALE_REF', { sideEffectStarted: false });
    }
    session.generation = generation;
    const safe = sanitizeObservation(result);
    session.refs = new Set(safe.controls.map(control => control.ref));
    session.refsExpireAt = Date.now() + REF_TTL_MS;
    return safe;
  }

  async function bindHarnessSession(harnessSessionId, tabId) {
    if (!plainString(harnessSessionId, 256) || !plainString(tabId, 128)) return failureResult('INVALID_REQUEST');
    if (driverClosed) return failureResult('DRIVER_CLOSED');
    try {
      const result = await host.bindHarnessSession(harnessSessionId, tabId);
      if (result === false || result?.ok === false) return failureResult('BINDING_MISMATCH');
      return successResult({ bound: true });
    } catch (error) {
      return failureResult(safeErrorCode(error, 'BINDING_MISMATCH'));
    }
  }

  async function open(input = {}) {
    if (!hasOnlyKeys(input, new Set(['id', 'owner', 'sessionId', 'runId', 'taskId', 'storageState', 'signal']))) throw new DriverFailure('INVALID_REQUEST');
    if (driverClosed) throw new DriverFailure('DRIVER_CLOSED');
    if (!SESSION_ID.test(input.id ?? '') || !plainString(input.owner, 256) || !plainString(input.sessionId, 256) ||
        !plainString(input.runId, 256) || !plainString(input.taskId, 256)) throw new DriverFailure('INVALID_SESSION_ID');
    if (!validateSignal(input.signal)) throw new DriverFailure('INVALID_SIGNAL');
    if (input.signal?.aborted) throw new DriverFailure('CANCELLED');
    if (sessions.has(input.id)) throw new DriverFailure('SESSION_EXISTS');
    let tab;
    try { tab = normalizeTab(await host.getTabForSession(input.sessionId)); }
    catch (error) { throw new DriverFailure(safeErrorCode(error, 'TAB_NOT_FOUND')); }
    if (input.signal?.aborted) throw new DriverFailure('CANCELLED');
    const origins = await resolveOrigins(tab.id);
    if (input.signal?.aborted) throw new DriverFailure('CANCELLED');
    const initialUrl = tab.view.webContents.getURL?.() ?? 'about:blank';
    if (!isAllowedUrl(initialUrl, origins, true)) throw new DriverFailure('ORIGIN_DENIED');
    const initialSession = { id: input.id, tabId: tab.id };
    assertControl(tab, { ...initialSession, revision: tab.revision, mode: tab.mode });
    let bound = false;
    try {
      const result = await host.bindAgentSession(input.id, tab.id);
      if (result === false || result?.ok === false) throw new DriverFailure('BINDING_MISMATCH');
      bound = true;
      if (input.signal?.aborted) throw new DriverFailure('CANCELLED');
      let boundTab = normalizeTab(await host.getBoundTab(input.id));
      if (input.signal?.aborted) throw new DriverFailure('CANCELLED');
      if (boundTab.id !== tab.id) throw new DriverFailure('BINDING_MISMATCH');
      assertControl(boundTab, { ...initialSession, revision: boundTab.revision, mode: boundTab.mode });
      const session = {
        id: input.id, owner: input.owner, harnessSessionId: input.sessionId, runId: input.runId, taskId: input.taskId,
        tabId: tab.id, revision: boundTab.revision, mode: boundTab.mode, allowedOrigins: origins,
        namespace: `__micro_dsh_${randomUUID().replaceAll('-', '')}`,
        refs: new Set(), refsExpireAt: 0, generation: 0, epoch: 0, navigationCount: 0, navigationPending: false,
        lastNavigationDenied: null, expectedAgentAction: false, allowAgentRevisionUntil: 0,
        paused: false, busy: false, closed: false, closedByHost: false,
      };
      sessions.set(input.id, session);
      attachListeners(session, boundTab);
      return successResult();
    } catch (error) {
      if (bound) {
        try { await host.unbindAgentSession(input.id); } catch { /* keep the original open failure */ }
      }
      throw new DriverFailure(safeErrorCode(error, 'BROWSER_OPEN_FAILED'));
    }
  }

  async function execute(id, request, options = {}) {
    if (!SESSION_ID.test(id ?? '')) return failureResult('INVALID_SESSION_ID', { sideEffectStarted: false });
    if (!hasOnlyKeys(options, new Set(['signal', 'approved'])) || !validateSignal(options.signal)) return failureResult('INVALID_REQUEST', { sideEffectStarted: false });
    let parsed;
    try { parsed = validateRequest(request); } catch (error) { return failureResult(safeErrorCode(error, 'INVALID_REQUEST'), { sideEffectStarted: false }); }
    const interaction = parsed.type !== 'observe';
    if (interaction && options.approved !== true) return failureResult('APPROVAL_REQUIRED', { sideEffectStarted: false });
    const session = sessions.get(id);
    if (!session || session.closed) return failureResult('SESSION_NOT_FOUND', { sideEffectStarted: false, contextClosed: true });
    if (session.paused) return failureResult('SESSION_PAUSED', { sideEffectStarted: false });
    if (session.busy) return failureResult('SESSION_BUSY', { sideEffectStarted: false });
    if (options.signal?.aborted) return failureResult('CANCELLED', { sideEffectStarted: false });
    session.busy = true;
    try {
      if (parsed.type === 'observe') return await observe(session, options.signal);
      if (parsed.type === 'navigate') return await navigate(session, parsed.url, options.signal);
      if (parsed.type === 'click') return await performDomAction(session, parsed, options.signal);
      if (parsed.type === 'press') return await press(session, parsed, options.signal);
      return await performDomAction(session, parsed, options.signal);
    } catch (error) {
      return failureResult(safeErrorCode(error), { sideEffectStarted: false, contextClosed: session.closedByHost });
    } finally {
      session.busy = false;
    }
  }

  async function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return successResult({ closed: false });
    session.closed = true;
    session.refs.clear();
    session.refsExpireAt = 0;
    detachListeners(session);
    sessions.delete(id);
    try { await host.unbindAgentSession(id); }
    catch { return failureResult('UNBIND_FAILED'); }
    // Electron WebContentsViews belong to the host and may now be in manual use.
    return successResult({ closed: true });
  }

  async function getStorageState(_id) {
    // Chromium partition storage is owned by the host; credentials and cookies
    // are never exported through the BrowserRuntime driver contract.
    return { cookies: [], origins: [] };
  }

  async function preview(id) {
    return sessions.has(id)
      ? failureResult('PREVIEW_UNSUPPORTED', { sideEffectStarted: false })
      : failureResult('SESSION_NOT_FOUND', { sideEffectStarted: false, contextClosed: true });
  }

  async function close() {
    if (driverClosed) return;
    driverClosed = true;
    await Promise.allSettled([...sessions.keys()].map(id => closeSession(id)));
  }

  return {
    validateUrl,
    setAllowedOrigins,
    bindHarnessSession,
    open,
    execute,
    closeSession,
    invalidateSessionRefs,
    pauseHarnessSession,
    resumeHarnessSession,
    getStorageState,
    storageState: getStorageState,
    preview,
    close,
  };
}
