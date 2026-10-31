import type {
  BrowserCommand,
  BrowserConfig,
  BrowserEvent,
  BrowserPreview,
  BrowserSession,
  HarnessSession,
  RunCreateResponse,
  RunLookupResponse,
  RunRecord,
  SessionDetailResponse,
} from './types';

export class ApiError extends Error {
  readonly status: number | null;
  readonly uncertain: boolean;

  constructor(message: string, status: number | null = null, uncertain = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.uncertain = uncertain;
  }
}

interface TrackedRequest {
  controller: AbortController;
  signal?: AbortSignal;
  removeAbortListener: () => void;
  token: string;
  generation: number;
  timedOut: () => boolean;
  release: () => void;
}

function abortError(): DOMException {
  return new DOMException('Request was cancelled.', 'AbortError');
}

function responseMessage(status: number, code: unknown): string {
  if (status === 401) return '凭证无效或已过期，请重新连接。';
  if (status === 403) return '当前凭证无权执行此操作。';
  if (status === 404) return '记录已不存在或已被清理。';
  if (code === 'BROWSER_RUN_NOT_ACTIVE') return '任务已结束，请重新发起。';
  if (status === 409) return '操作状态已变化，请刷新后核对。';
  if (status === 429) return '服务繁忙，请稍后再试。';
  if (status === 413) return '请求内容过大，请缩短后重试。';
  if (status >= 500) return '服务暂时不可用，请稍后再试。';
  if (typeof code === 'string' && code === 'invalid_fields') return '请求内容未被接受，请检查输入。';
  return '请求未被接受，请检查输入后重试。';
}

function isBrowserEvent(value: unknown): value is BrowserEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<BrowserEvent>;
  return Number.isSafeInteger(event.id) && typeof event.type === 'string';
}

export class BrowserApi {
  #token: string | null;
  #generation = 0;
  #controllers = new Set<AbortController>();
  #onAuthExpired: () => void;

  constructor(token: string, onAuthExpired: () => void) {
    this.#token = token;
    this.#onAuthExpired = onAuthExpired;
  }

  get connected(): boolean {
    return this.#token !== null;
  }

  clear(): void {
    this.#generation += 1;
    this.#token = null;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  #track(signal?: AbortSignal, timeoutMs?: number): TrackedRequest {
    if (!this.#token) throw abortError();

    const controller = new AbortController();
    const token = this.#token;
    const generation = this.#generation;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let didTimeout = false;
    const onAbort = () => controller.abort();

    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, timeoutMs);
    }

    this.#controllers.add(controller);
    return {
      controller,
      signal,
      token,
      generation,
      timedOut: () => didTimeout,
      removeAbortListener: () => signal?.removeEventListener('abort', onAbort),
      release: () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        this.#controllers.delete(controller);
      },
    };
  }

  #assertCurrent(request: TrackedRequest): void {
    if (request.generation !== this.#generation || request.controller.signal.aborted) throw abortError();
  }

  async #request<T>(path: string, options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<T> {
    const tracked = this.#track(options.signal, options.timeoutMs);
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${tracked.token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');

    try {
      const response = await fetch(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: tracked.controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });

      this.#assertCurrent(tracked);
      if (response.status === 401) {
        if (tracked.generation === this.#generation) this.#onAuthExpired();
        throw new ApiError('凭证无效或已过期，请重新连接。', 401);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      this.#assertCurrent(tracked);

      if (!response.ok) {
        const code = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
        throw new ApiError(responseMessage(response.status, code), response.status);
      }
      return payload as T;
    } catch (error) {
      if (tracked.generation !== this.#generation || options.signal?.aborted) throw abortError();
      if (error instanceof ApiError) throw error;
      if (tracked.timedOut()) throw new ApiError('请求等待超时，提交状态需要核对。', null, true);
      throw new ApiError('网络连接中断，请检查连接后核对当前状态。', null, true);
    } finally {
      tracked.removeAbortListener();
      tracked.release();
    }
  }

  getConfig(signal?: AbortSignal): Promise<BrowserConfig> {
    return this.#request('/v1/browser/config', { signal });
  }

  getSessions(signal?: AbortSignal): Promise<HarnessSession[]> {
    return this.#request('/v1/sessions', { signal });
  }

  getSessionDetail(sessionId: string, signal?: AbortSignal): Promise<SessionDetailResponse> {
    const query = new URLSearchParams({ limit: '1' });
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`, { signal });
  }

  createSession(title: string, signal?: AbortSignal): Promise<HarnessSession> {
    return this.#request('/v1/sessions', { method: 'POST', body: { title }, signal });
  }

  getBrowserSessions(signal?: AbortSignal): Promise<BrowserSession[]> {
    return this.#request('/v1/browser/sessions', { signal });
  }

  getCommands(sessionId: string, signal?: AbortSignal): Promise<BrowserCommand[]> {
    return this.#request(`/v1/browser/sessions/${encodeURIComponent(sessionId)}/commands`, { signal });
  }

  getRun(runId: string, signal?: AbortSignal): Promise<RunRecord> {
    return this.#request(`/v1/runs/${encodeURIComponent(runId)}`, { signal });
  }

  createRun(sessionId: string, prompt: string, key: string, signal?: AbortSignal): Promise<RunCreateResponse> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: {
        prompt,
        mode: 'single',
        memoryStrategy: 'none',
        budget: {
          maxDurationMs: 600_000,
          maxToolCalls: 40,
          maxTokens: 16_384,
          maxActiveChildren: 1,
        },
      },
      signal,
      timeoutMs: 45_000,
    });
  }

  lookupRun(sessionId: string, key: string, signal?: AbortSignal): Promise<RunLookupResponse> {
    const query = new URLSearchParams({ key });
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/run-lookup?${query.toString()}`, { signal });
  }

  cancelRun(runId: string, signal?: AbortSignal): Promise<unknown> {
    return this.#request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {}, signal });
  }

  decide(commandId: string, decision: 'approve' | 'reject', requestHash: string, signal?: AbortSignal): Promise<unknown> {
    return this.#request(`/v1/browser/commands/${encodeURIComponent(commandId)}/decision`, {
      method: 'POST',
      body: { decision, requestHash },
      signal,
    });
  }

  closeBrowserSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.#request(`/v1/browser/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: 'POST',
      body: {},
      signal,
    });
  }

  getPreview(sessionId: string, signal?: AbortSignal): Promise<BrowserPreview> {
    return this.#request(`/v1/browser/sessions/${encodeURIComponent(sessionId)}/preview`, { signal });
  }

  async streamEvents(
    sessionId: string,
    after: number,
    onEvent: (event: BrowserEvent) => void,
    onOpen: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const tracked = this.#track(signal);
    const query = new URLSearchParams({ after: String(Math.max(0, after)) });

    try {
      const response = await fetch(`/v1/browser/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`, {
        headers: {
          Authorization: `Bearer ${tracked.token}`,
          Accept: 'text/event-stream',
        },
        signal: tracked.controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });

      this.#assertCurrent(tracked);
      if (response.status === 401) {
        if (tracked.generation === this.#generation) this.#onAuthExpired();
        throw new ApiError('凭证无效或已过期，请重新连接。', 401);
      }
      if (!response.ok) throw new ApiError(responseMessage(response.status, null), response.status);
      if (!response.body) throw new ApiError('事件连接暂不可用。', null, true);
      onOpen();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!tracked.controller.signal.aborted) {
        const chunk = await reader.read();
        this.#assertCurrent(tracked);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 1_000_000) buffer = '';

        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const parsed = parseEventFrame(frame);
          if (parsed?.event === 'browser.event' && parsed.data) {
            try {
              const event: unknown = JSON.parse(parsed.data);
              if (isBrowserEvent(event)) onEvent(event);
            } catch {
              // Ignore a malformed event and keep the stream available for the next one.
            }
          }
        }
      }
    } catch (error) {
      if (tracked.generation !== this.#generation || signal?.aborted) throw abortError();
      if (error instanceof ApiError) throw error;
      throw new ApiError('事件连接中断。', null, true);
    } finally {
      tracked.removeAbortListener();
      tracked.release();
    }
  }
}

function parseEventFrame(frame: string): { event: string; data: string } | null {
  let event = '';
  const data: string[] = [];

  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }

  return data.length > 0 ? { event, data: data.join('\n') } : null;
}
