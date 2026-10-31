import type { ExecutionContext, ModelAdapter, ModelMessage, ModelRequest, ModelResponse, ModelResponseTiming, ModelTokenCount, ModelToolCall, ResultEnvelope, Usage } from '../contracts.js';
import { estimateSerializedPromptTokens } from '../core/token-estimation.js';

interface ChatCompletionToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatCompletionMessage {
  role: ModelMessage['role'];
  content: string;
  tool_call_id?: string;
  tool_calls?: ChatCompletionToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAICompatibleStreamingOptions {
  /** Maximum encoded response bytes, including SSE framing. Defaults to 4 MiB; hard maximum is 32 MiB. */
  maxResponseBytes?: number;
  /** Maximum SSE data events, including [DONE]. Defaults to 8,192; hard maximum is 100,000. */
  maxEvents?: number;
  /** Maximum indexed tool calls in one response. Defaults to 32; the hard maximum is 128. */
  maxToolCalls?: number;
}

interface ResolvedStreamingOptions {
  maxResponseBytes: number;
  maxEvents: number;
  maxToolCalls: number;
}

const MAX_STREAM_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_EVENTS = 100_000;
const MAX_STREAM_TOOL_CALLS = 32;
const MAX_STREAM_TOOL_CALLS_HARD = 128;
type NormalizedAdapterFailureCode =
  | 'MODEL_STREAM_INVALID'
  | 'MODEL_STREAM_JSON_INVALID'
  | 'MODEL_STREAM_CONTENT_TYPE_INVALID'
  | 'MODEL_STREAM_INCOMPLETE'
  | 'MODEL_STREAM_TRUNCATED'
  | 'MODEL_STREAM_EVENT_LIMIT'
  | 'MODEL_STREAM_RESPONSE_LIMIT'
  | 'MODEL_STREAM_ORDER_INVALID'
  | 'MODEL_STREAM_EVENT_INVALID'
  | 'MODEL_STREAM_CHOICE_INDEX_INVALID'
  | 'MODEL_STREAM_DELTA_INVALID'
  | 'MODEL_STREAM_CONTENT_INVALID'
  | 'MODEL_STREAM_FINISH_REASON_INVALID'
  | 'MODEL_STREAM_USAGE_INVALID'
  | 'MODEL_STREAM_IDENTITY_INVALID'
  | 'MODEL_RESPONSE_FILTERED'
  | 'MODEL_STREAM_ROLE_INVALID'
  | 'MODEL_STREAM_TOOL_CALL_LIST_INVALID'
  | 'MODEL_STREAM_TOOL_CALL_INDEX_INVALID'
  | 'MODEL_STREAM_TOOL_CALL_TYPE_INVALID'
  | 'MODEL_STREAM_TOOL_CALL_ID_INVALID'
  | 'MODEL_STREAM_TOOL_FUNCTION_INVALID'
  | 'MODEL_STREAM_TOOL_NAME_INVALID'
  | 'MODEL_STREAM_TOOL_ARGUMENTS_INVALID'
  | 'MODEL_STREAM_TOOL_CALL_INDEX_GAP'
  | 'MODEL_TOOL_CALL_INCOMPLETE'
  | 'MODEL_TOOL_CALL_ID_DUPLICATE'
  | 'MODEL_TOOL_ARGUMENTS_INVALID'
  | 'MODEL_STREAM_TOOL_CALL_MISSING';

class AdapterFailure extends Error {
  constructor(readonly code: NormalizedAdapterFailureCode, readonly usage?: Usage) {
    super('Model response could not be validated');
    this.name = 'AdapterFailure';
  }
}

const SAFE_STREAM_FAILURE_CODES = new Map<string, NormalizedAdapterFailureCode>([
  ['Malformed Chat Completions stream event', 'MODEL_STREAM_EVENT_INVALID'],
  ['Unexpected Chat Completions choice index', 'MODEL_STREAM_CHOICE_INDEX_INVALID'],
  ['Malformed Chat Completions delta', 'MODEL_STREAM_DELTA_INVALID'],
  ['Malformed streamed assistant content', 'MODEL_STREAM_CONTENT_INVALID'],
  ['Malformed stream finish reason', 'MODEL_STREAM_FINISH_REASON_INVALID'],
  ['Malformed or premature terminal usage chunk', 'MODEL_STREAM_USAGE_INVALID'],
  ['Malformed streamed id', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Malformed streamed model', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Malformed streamed object', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Malformed streamed created', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Malformed streamed system_fingerprint', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Chat Completions id changed during the stream', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Chat Completions model changed during the stream', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Chat Completions object changed during the stream', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Chat Completions created changed during the stream', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Chat Completions system_fingerprint changed during the stream', 'MODEL_STREAM_IDENTITY_INVALID'],
  ['Received streamed content after terminal usage', 'MODEL_STREAM_ORDER_INVALID'],
  ['Received a choice after its terminal finish reason', 'MODEL_STREAM_ORDER_INVALID'],
  ['Received SSE data after [DONE]', 'MODEL_STREAM_ORDER_INVALID'],
  ['SSE stream ended inside an event', 'MODEL_STREAM_INCOMPLETE'],
  ['SSE stream ended without [DONE]', 'MODEL_STREAM_INCOMPLETE'],
  ['SSE stream ended without a finish reason', 'MODEL_STREAM_INCOMPLETE'],
  ['SSE model response was truncated', 'MODEL_STREAM_TRUNCATED'],
  ['SSE model response was filtered', 'MODEL_RESPONSE_FILTERED'],
  ['SSE model returned an unsupported finish reason', 'MODEL_STREAM_FINISH_REASON_INVALID'],
  ['SSE event limit exceeded', 'MODEL_STREAM_EVENT_LIMIT'],
  ['SSE response byte limit exceeded', 'MODEL_STREAM_RESPONSE_LIMIT'],
  ['Unexpected streamed message role', 'MODEL_STREAM_ROLE_INVALID'],
  ['Malformed streamed tool call list', 'MODEL_STREAM_TOOL_CALL_LIST_INVALID'],
  ['Malformed streamed tool call index', 'MODEL_STREAM_TOOL_CALL_INDEX_INVALID'],
  ['Unsupported streamed tool call type', 'MODEL_STREAM_TOOL_CALL_TYPE_INVALID'],
  ['Malformed streamed tool call ID', 'MODEL_STREAM_TOOL_CALL_ID_INVALID'],
  ['Malformed streamed tool function', 'MODEL_STREAM_TOOL_FUNCTION_INVALID'],
  ['Malformed streamed tool name', 'MODEL_STREAM_TOOL_NAME_INVALID'],
  ['Malformed streamed tool arguments', 'MODEL_STREAM_TOOL_ARGUMENTS_INVALID'],
  ['Streamed tool call indexes are incomplete', 'MODEL_STREAM_TOOL_CALL_INDEX_GAP'],
  ['Malformed tool call', 'MODEL_TOOL_CALL_INCOMPLETE'],
  ['Duplicate tool call ID', 'MODEL_TOOL_CALL_ID_DUPLICATE'],
  ['Tool-call finish reason has no calls', 'MODEL_STREAM_TOOL_CALL_MISSING'],
  ['Tool calls require a tool_calls finish reason', 'MODEL_STREAM_FINISH_REASON_INVALID'],
]);

function normalizedAdapterFailureCode(error: unknown): string {
  if (error instanceof AdapterFailure) return error.code;
  return error instanceof Error ? SAFE_STREAM_FAILURE_CODES.get(error.message) ?? 'MODEL_ADAPTER' : 'MODEL_ADAPTER';
}

function normalizeStreamFailure(error: unknown): AdapterFailure {
  if (error instanceof AdapterFailure) return error;
  const code = error instanceof Error ? SAFE_STREAM_FAILURE_CODES.get(error.message) : undefined;
  return new AdapterFailure(code ?? 'MODEL_STREAM_INVALID');
}

/** Explicit opt-in adapter; construction and import never call the network. */
export class OpenAICompatibleAdapter implements ModelAdapter {
  private readonly endpoint: string;
  private readonly tokenizerEndpoint?: string;
  private readonly streaming?: ResolvedStreamingOptions;
  private readonly now: () => number;
  countTokens?: ModelAdapter['countTokens'];
  constructor(private readonly options: {
    baseUrl: string; model: string; apiKey?: string;
    tools?: readonly ToolDefinition[]; timeoutMs?: number; tokenizerUrl?: string; thinkingMode?: 'disabled';
    /** Set this object to opt into bounded Chat Completions SSE; omitted means non-streaming. */
    streaming?: OpenAICompatibleStreamingOptions;
    fetchImpl?: typeof fetch;
    /** Monotonic clock injection for deterministic fixtures; defaults to performance.now(). */
    now?: () => number;
  }) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Expected an HTTP(S) base URL without credentials, query or fragment');
    }
    this.endpoint = `${url.href.replace(/\/$/, '')}/chat/completions`;
    if (!options.model.trim()) throw new Error('A model ID is required');
    if (options.thinkingMode !== undefined && options.thinkingMode !== 'disabled') throw new Error('thinkingMode currently supports only disabled');
    this.now = createMonotonicClock(options.now ?? (() => performance.now()));
    if (options.streaming !== undefined) this.streaming = resolveStreamingOptions(options.streaming);
    if (options.tokenizerUrl) {
      const tokenizerUrl = new URL(options.tokenizerUrl);
      if (!['http:', 'https:'].includes(tokenizerUrl.protocol) || tokenizerUrl.username || tokenizerUrl.password || tokenizerUrl.hash) {
        throw new Error('Expected an HTTP(S) tokenizer URL without credentials or fragment');
      }
      this.tokenizerEndpoint = tokenizerUrl.href;
      this.countTokens = (request, context) => this.requestTokenCount(request, context);
    }
  }

  async generate(request: ModelRequest, context: ExecutionContext): Promise<ResultEnvelope<ModelResponse>> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    try {
      const { messages, tools } = this.wireRequest(request, context);
      const requestStartedAtMs = this.now();
      const response = await (this.options.fetchImpl ?? fetch)(this.endpoint, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify({
          model: request.model ?? this.options.model, messages,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxOutputTokens ?? 512,
          ...(this.streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
          ...(this.options.thinkingMode ? { thinking: { type: this.options.thinkingMode } } : {}),
          ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
        }),
      });
      const responseHeadersAtMs = this.now();
      if (!response.ok) return { ok: false, error: { code: 'MODEL_HTTP', message: `Model endpoint returned HTTP ${response.status}`, retryable: false }, evidence: [] };
      if (this.streaming) {
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (mediaType !== 'text/event-stream' || !response.body) throw new AdapterFailure('MODEL_STREAM_CONTENT_TYPE_INVALID');
        let streamed: Awaited<ReturnType<typeof readChatCompletionStream>>;
        try {
          streamed = await readChatCompletionStream(response.body, signal, this.streaming, {
            requestStartedAtMs, responseHeadersAtMs,
            reasoningModeDisabled: this.options.thinkingMode === 'disabled', now: this.now,
          });
        } catch (error) {
          throw normalizeStreamFailure(error);
        }
        return { ok: true, data: streamed, ...(streamed.usage ? { usage: streamed.usage } : {}), evidence: [] };
      }
      const body = await response.json() as {
        choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[];
        usage?: unknown;
        model?: unknown;
      };
      const requestEndedAtMs = this.now();
      const choice = body.choices?.[0];
      if (!choice?.message) throw new Error('Model response has no message');
      if (choice.finish_reason === 'length') {
        let truncatedUsage: Usage | undefined;
        try {
          truncatedUsage = body.usage === undefined ? undefined : normalizeProviderUsage(body.usage, false);
        } catch {
          throw new AdapterFailure('MODEL_STREAM_USAGE_INVALID');
        }
        // Do not parse or expose a partial tool call. AgentLoop may retry only
        // when this envelope carries complete, validated provider usage.
        throw new AdapterFailure('MODEL_STREAM_TRUNCATED', truncatedUsage);
      }
      const calls = parseToolCalls(choice.message.tool_calls);
      const content = choice.message.content;
      if (content !== undefined && content !== null && typeof content !== 'string') {
        throw new Error('Malformed assistant content');
      }
      const usage = body.usage === undefined ? undefined : normalizeProviderUsage(body.usage, false);
      const finishReason = normalizeNonStreamingFinishReason(choice.finish_reason, calls?.length ?? 0);
      const normalizedUsage = usage;
      const providerModel = normalizeProviderModel(body.model);
      const timing: ModelResponseTiming = {
        streaming: false,
        requestStartedAtMs,
        responseHeadersAtMs,
        requestEndedAtMs,
        elapsedMs: requestEndedAtMs - requestStartedAtMs,
        contentDeltaCount: 0,
        contentDeltaGapsMs: [],
        contentDeltaGapSemantics: 'sse_content_event_interarrival_not_token_itl',
        ttftUnavailableReason: 'non_streaming',
        tpotUnavailableReason: 'non_streaming',
      };
      return { ok: true, data: {
        text: content ?? '', ...(providerModel ? { providerModel } : {}), toolCalls: calls,
        ...(normalizedUsage ? { usage: normalizedUsage } : {}), finishReason, timing,
      }, ...(normalizedUsage ? { usage: normalizedUsage } : {}), evidence: [] };
    } catch (error) {
      return { ok: false, error: {
        code: context.signal?.aborted ? 'CANCELLED' : timeout.aborted ? 'TIMED_OUT' : normalizedAdapterFailureCode(error),
        message: context.signal?.aborted ? 'Model request cancelled' : timeout.aborted ? 'Model request timed out' : 'Model response could not be read; check endpoint and tool-call format',
        retryable: false,
      }, ...(error instanceof AdapterFailure && error.usage ? { usage: error.usage } : {}), evidence: [] };
    }
  }

  private async requestTokenCount(request: ModelRequest, context: ExecutionContext): Promise<ResultEnvelope<ModelTokenCount>> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    try {
      const { messages, tools } = this.wireRequest(request, context);
      const response = await (this.options.fetchImpl ?? fetch)(this.tokenizerEndpoint!, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model ?? this.options.model, messages,
          ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
          add_generation_prompt: true,
        }),
      });
      if (!response.ok) return { ok: false, error: { code: 'TOKEN_COUNT_HTTP', message: `Tokenizer endpoint returned HTTP ${response.status}`, retryable: false }, evidence: [] };
      const body = await response.json() as { count?: unknown; max_model_len?: unknown };
      if (!Number.isSafeInteger(body.count) || (body.count as number) < 0 ||
        !Number.isSafeInteger(body.max_model_len) || (body.max_model_len as number) < 2) {
        throw new Error('Tokenizer response is missing a valid count or context limit');
      }
      return { ok: true, data: { inputTokens: body.count as number, maxContextTokens: body.max_model_len as number }, evidence: [] };
    } catch {
      return { ok: false, error: {
        code: context.signal?.aborted ? 'CANCELLED' : timeout.aborted ? 'TIMED_OUT' : 'TOKEN_COUNT_UNAVAILABLE',
        message: context.signal?.aborted ? 'Token count request cancelled' : timeout.aborted ? 'Token count request timed out' : 'Exact provider token count is unavailable; generation was not attempted',
        retryable: false,
      }, evidence: [] };
    }
  }

  estimatePromptTokens(request: ModelRequest, context: ExecutionContext): number {
    const { messages, tools } = this.wireRequest(request, context);
    return estimateSerializedPromptTokens({
      messages,
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
      add_generation_prompt: true,
    }, messages.length * 3 + tools.length * 8 + 3);
  }

  private wireRequest(request: ModelRequest, context: ExecutionContext) {
    const messages = normalizeConversation(request.messages);
    const allowedTools = new Set(context.allowedTools);
    const tools = (this.options.tools ?? []).filter(tool => allowedTools.has(tool.name));
    return { messages, tools };
  }
}

/** Convert the internal conversation into Chat Completions messages and fail closed on broken tool turns. */
function normalizeConversation(messages: readonly ModelMessage[]): ChatCompletionMessage[] {
  if (!Array.isArray(messages)) throw new Error('Malformed conversation');
  const normalized: ChatCompletionMessage[] = [];
  const seenCallIds = new Set<string>();
  const pendingCallIds = new Set<string>();

  for (const value of messages as readonly unknown[]) {
    if (!isRecord(value) || !['system', 'user', 'assistant', 'tool'].includes(String(value.role)) || typeof value.content !== 'string') {
      throw new Error('Malformed conversation message');
    }
    const role = value.role as ModelMessage['role'];
    if (pendingCallIds.size > 0 && role !== 'tool') throw new Error('Conversation has unresolved tool calls');

    if (role === 'tool') {
      if (typeof value.toolCallId !== 'string' || value.toolCallId.trim().length === 0 || !pendingCallIds.has(value.toolCallId)) {
        throw new Error('Tool result has no matching assistant call');
      }
      pendingCallIds.delete(value.toolCallId);
      normalized.push({ role, content: value.content, tool_call_id: value.toolCallId });
      continue;
    }

    if (value.toolCallId !== undefined) throw new Error('Only tool messages may carry a tool call ID');
    const message: ChatCompletionMessage = { role, content: value.content };
    if (value.toolCalls !== undefined) {
      if (role !== 'assistant' || !Array.isArray(value.toolCalls)) throw new Error('Malformed assistant tool calls');
      if (value.toolCalls.length > 0) {
        message.tool_calls = value.toolCalls.map((rawCall: unknown): ChatCompletionToolCall => {
          if (!isRecord(rawCall) || typeof rawCall.id !== 'string' || rawCall.id.trim().length === 0 ||
            typeof rawCall.name !== 'string' || rawCall.name.trim().length === 0) {
            throw new Error('Malformed assistant tool call');
          }
          if (seenCallIds.has(rawCall.id)) throw new Error('Duplicate assistant tool call ID');
          const args = serializeToolArguments(rawCall.input);
          seenCallIds.add(rawCall.id);
          pendingCallIds.add(rawCall.id);
          return { id: rawCall.id, type: 'function', function: { name: rawCall.name, arguments: args } };
        });
      }
    }
    normalized.push(message);
  }

  if (pendingCallIds.size > 0) throw new Error('Conversation ends with unresolved tool calls');
  return normalized;
}

function serializeToolArguments(input: unknown): string {
  validateJsonValue(input, new Set<object>(), 0);
  const value = JSON.stringify(input);
  if (value === undefined) throw new Error('Tool arguments are not JSON serializable');
  return value;
}

function validateJsonValue(value: unknown, ancestors: Set<object>, depth: number): void {
  if (depth > 64) throw new Error('Tool arguments exceed the JSON nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Tool arguments contain a non-finite number');
    return;
  }
  if (typeof value !== 'object') throw new Error('Tool arguments are not JSON values');
  if (ancestors.has(value)) throw new Error('Tool arguments contain a cycle');

  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (keys.some(key => typeof key === 'symbol' || key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) {
        throw new Error('Tool argument arrays must contain only indexed values');
      }
      if (keys.length - 1 !== value.length) throw new Error('Tool argument arrays cannot be sparse');
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Tool arguments cannot contain accessors');
        validateJsonValue(descriptor.value, ancestors, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Tool arguments must use plain objects');
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('Tool arguments cannot contain symbol keys');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Tool arguments cannot contain accessors or hidden fields');
      validateJsonValue(descriptor.value, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function parseToolCalls(value: unknown): ModelToolCall[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('Malformed tool call list');
  const ids = new Set<string>();
  return value.map((rawCall: unknown): ModelToolCall => {
    if (!isRecord(rawCall) || typeof rawCall.id !== 'string' || rawCall.id.trim().length === 0 ||
      !isRecord(rawCall.function) || typeof rawCall.function.name !== 'string' || rawCall.function.name.trim().length === 0) {
      throw new Error('Malformed tool call');
    }
    if (typeof rawCall.function.arguments !== 'string') throw new AdapterFailure('MODEL_TOOL_ARGUMENTS_INVALID');
    if (ids.has(rawCall.id)) throw new Error('Duplicate tool call ID');
    ids.add(rawCall.id);
    let input: unknown;
    try {
      input = JSON.parse(rawCall.function.arguments) as unknown;
    } catch {
      throw new AdapterFailure('MODEL_TOOL_ARGUMENTS_INVALID');
    }
    return { id: rawCall.id, name: rawCall.function.name, input };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveStreamingOptions(value: OpenAICompatibleStreamingOptions): ResolvedStreamingOptions {
  if (!isRecord(value)) throw new TypeError('streaming must be an options object');
  const maxResponseBytes = value.maxResponseBytes ?? 4 * 1024 * 1024;
  const maxEvents = value.maxEvents ?? 8_192;
  const maxToolCalls = value.maxToolCalls ?? MAX_STREAM_TOOL_CALLS;
  if (!Number.isSafeInteger(maxResponseBytes) || (maxResponseBytes as number) < 1 || (maxResponseBytes as number) > MAX_STREAM_RESPONSE_BYTES) {
    throw new TypeError(`streaming.maxResponseBytes must be an integer from 1 through ${MAX_STREAM_RESPONSE_BYTES}`);
  }
  if (!Number.isSafeInteger(maxEvents) || (maxEvents as number) < 1 || (maxEvents as number) > MAX_STREAM_EVENTS) {
    throw new TypeError(`streaming.maxEvents must be an integer from 1 through ${MAX_STREAM_EVENTS}`);
  }
  if (!Number.isSafeInteger(maxToolCalls) || (maxToolCalls as number) < 1 || (maxToolCalls as number) > MAX_STREAM_TOOL_CALLS_HARD) {
    throw new TypeError(`streaming.maxToolCalls must be an integer from 1 through ${MAX_STREAM_TOOL_CALLS_HARD}`);
  }
  return {
    maxResponseBytes: maxResponseBytes as number,
    maxEvents: maxEvents as number,
    maxToolCalls: maxToolCalls as number,
  };
}

interface StreamToolCallAssembly {
  id: string;
  name: string;
  arguments: string;
}

interface StreamIdentity {
  id?: string;
  model?: string;
  object?: string;
  created?: number;
  system_fingerprint?: string;
}

interface StreamTimingContext {
  requestStartedAtMs: number;
  responseHeadersAtMs: number;
  reasoningModeDisabled: boolean;
  now: () => number;
}

async function readChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limits: ResolvedStreamingOptions,
  timingContext: StreamTimingContext,
): Promise<Pick<ModelResponse, 'text' | 'providerModel' | 'toolCalls' | 'finishReason' | 'usage' | 'timing'>> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const calls = new Map<number, StreamToolCallAssembly>();
  const identity: StreamIdentity = {};
  const dataLines: string[] = [];
  let buffer = '';
  let scanIndex = 0;
  let bytesRead = 0;
  let eventCount = 0;
  let doneSeen = false;
  let terminalReason: string | undefined;
  let usageSeen = false;
  let usage: ModelResponse['usage'];
  let toolCallLimitExceeded = false;
  let text = '';
  let reasoningPresent = false;
  let toolCallsPresent = false;
  let nonTextDeltaPresent = false;
  let firstContentDeltaAtMs: number | undefined;
  let lastContentDeltaAtMs: number | undefined;
  const contentDeltaGapsMs: number[] = [];
  let contentDeltaCount = 0;

  const observeUsage = (rawUsage: unknown): void => {
    if (terminalReason === undefined || !isRecord(rawUsage)) throw new Error('Malformed or premature terminal usage chunk');
    try {
      usage = normalizeProviderUsage(rawUsage, true);
    } catch {
      throw new AdapterFailure('MODEL_STREAM_USAGE_INVALID');
    }
    if ((usage.reasoningOutputTokens ?? 0) > 0) reasoningPresent = true;
    usageSeen = true;
  };

  const observeIdentity = (event: Record<string, unknown>): void => {
    for (const key of ['id', 'model', 'object', 'created', 'system_fingerprint'] as const) {
      const value = event[key];
      if (value === undefined || value === null) continue;
      const valid = key === 'created' ? Number.isSafeInteger(value) && (value as number) >= 0 : typeof value === 'string' && value.length > 0;
      if (!valid) throw new Error(`Malformed streamed ${key}`);
      if (identity[key] !== undefined && identity[key] !== value) throw new Error(`Chat Completions ${key} changed during the stream`);
      identity[key] = value as never;
    }
  };

  const processData = (data: string): void => {
    eventCount += 1;
    if (eventCount > limits.maxEvents) throw new Error('SSE event limit exceeded');
    if (doneSeen) throw new Error('Received SSE data after [DONE]');
    if (data === '[DONE]') {
      doneSeen = true;
      return;
    }
    if (usageSeen) throw new Error('Received streamed content after terminal usage');

    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new AdapterFailure('MODEL_STREAM_JSON_INVALID');
    }
    if (!isRecord(event) || !Array.isArray(event.choices)) {
      throw new Error('Malformed Chat Completions stream event');
    }
    observeIdentity(event);
    if (event.choices.length === 0) {
      observeUsage(event.usage);
      return;
    }
    if (event.choices.length !== 1 || !isRecord(event.choices[0])) throw new Error('Malformed Chat Completions stream event');
    const choice = event.choices[0];
    if (choice.index !== undefined && choice.index !== 0) throw new Error('Unexpected Chat Completions choice index');
    if (terminalReason !== undefined) throw new Error('Received a choice after its terminal finish reason');
    if (!isRecord(choice.delta)) throw new Error('Malformed Chat Completions delta');
    if (choice.delta.role !== undefined && choice.delta.role !== null && choice.delta.role !== 'assistant') {
      throw new Error('Unexpected streamed message role');
    }
    if (choice.delta.content !== undefined && choice.delta.content !== null) {
      if (typeof choice.delta.content !== 'string') throw new Error('Malformed streamed assistant content');
      text += choice.delta.content;
      if (choice.delta.content.length > 0) {
        const observedAtMs = timingContext.now();
        if (lastContentDeltaAtMs !== undefined) contentDeltaGapsMs.push(observedAtMs - lastContentDeltaAtMs);
        firstContentDeltaAtMs ??= observedAtMs;
        lastContentDeltaAtMs = observedAtMs;
        contentDeltaCount += 1;
      }
    }
    // Reasoning fields are deliberately ignored; only `content` becomes user-visible text.
    for (const key of ['reasoning_content', 'reasoning', 'analysis', 'thinking'] as const) {
      if (hasNonEmptyValue(choice.delta[key])) reasoningPresent = true;
    }
    if (choice.delta.tool_calls !== undefined && choice.delta.tool_calls !== null) {
      if (!Array.isArray(choice.delta.tool_calls)) throw new Error('Malformed streamed tool call list');
      if (choice.delta.tool_calls.length > 0) toolCallsPresent = true;
      for (const rawCall of choice.delta.tool_calls as unknown[]) {
        if (!isRecord(rawCall) || typeof rawCall.index !== 'number' || !Number.isFinite(rawCall.index) ||
          !Number.isInteger(rawCall.index) || rawCall.index < 0) {
          throw new Error('Malformed streamed tool call index');
        }
        // Reject policy overflow only after consuming the bounded response so a
        // provider's terminal usage chunk is retained. Check before using the
        // index as a collection key; a huge finite integer must never size an array.
        if (rawCall.index >= limits.maxToolCalls) {
          toolCallLimitExceeded = true;
          continue;
        }
        if (toolCallLimitExceeded) continue;
        const index = rawCall.index as number;
        let call = calls.get(index);
        if (!call) {
          call = { id: '', name: '', arguments: '' };
          calls.set(index, call);
        }
        if (rawCall.type !== undefined && rawCall.type !== null && rawCall.type !== 'function') throw new Error('Unsupported streamed tool call type');
        if (rawCall.id !== undefined && rawCall.id !== null) {
          if (typeof rawCall.id !== 'string') throw new Error('Malformed streamed tool call ID');
          call.id += rawCall.id;
        }
        if (rawCall.function !== undefined && rawCall.function !== null) {
          if (!isRecord(rawCall.function)) throw new Error('Malformed streamed tool function');
          if (rawCall.function.name !== undefined && rawCall.function.name !== null) {
            if (typeof rawCall.function.name !== 'string') throw new Error('Malformed streamed tool name');
            call.name += rawCall.function.name;
          }
          if (rawCall.function.arguments !== undefined && rawCall.function.arguments !== null) {
            if (typeof rawCall.function.arguments !== 'string') throw new Error('Malformed streamed tool arguments');
            call.arguments += rawCall.function.arguments;
          }
        }
      }
    }
    const recognizedDeltaKeys = new Set(['role', 'content', 'tool_calls', 'reasoning_content', 'reasoning', 'analysis', 'thinking']);
    if (Object.entries(choice.delta).some(([key, value]) => !recognizedDeltaKeys.has(key) && hasNonEmptyValue(value))) {
      nonTextDeltaPresent = true;
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== 'string') throw new Error('Malformed stream finish reason');
      terminalReason = choice.finish_reason;
    }
    // OpenAI-compatible providers may attach usage to the final choice frame
    // rather than send a separate choices: [] frame.
    if (event.usage !== undefined && event.usage !== null) observeUsage(event.usage);
  };

  const processLine = (line: string): void => {
    if (line === '') {
      if (dataLines.length > 0) processData(dataLines.join('\n'));
      dataLines.length = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== 'data') return;
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  };

  const drainLines = (final: boolean): void => {
    let consumed = 0;
    for (let index = scanIndex; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character === '\r' && index + 1 === buffer.length && !final) {
        scanIndex = index;
        break;
      }
      if (character !== '\n' && character !== '\r') continue;
      const width = character === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      processLine(buffer.slice(consumed, index));
      consumed = index + width;
      scanIndex = consumed;
      index += width - 1;
    }
    if (consumed > 0) {
      buffer = buffer.slice(consumed);
      scanIndex = 0;
    }
    if (final && (buffer.length > 0 || dataLines.length > 0)) throw new AdapterFailure('MODEL_STREAM_INCOMPLETE');
  };

  const onAbort = (): void => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error('SSE stream aborted');
      const item = await reader.read();
      if (signal.aborted) throw new Error('SSE stream aborted');
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > limits.maxResponseBytes) throw new Error('SSE response byte limit exceeded');
      buffer += decoder.decode(item.value, { stream: true });
      drainLines(false);
    }
    buffer += decoder.decode();
    drainLines(true);
    if (!doneSeen) throw new AdapterFailure('MODEL_STREAM_INCOMPLETE');
    if (terminalReason === undefined) throw new AdapterFailure('MODEL_STREAM_INCOMPLETE');
    if (toolCallLimitExceeded) throw new AdapterFailure('MODEL_STREAM_TOOL_CALL_INDEX_INVALID', usage);
    if (terminalReason === 'length') throw new AdapterFailure('MODEL_STREAM_TRUNCATED', usage);
    if (terminalReason === 'content_filter') throw new AdapterFailure('MODEL_RESPONSE_FILTERED');
    if (terminalReason !== 'stop' && terminalReason !== 'tool_calls') throw new Error('SSE model returned an unsupported finish reason');

    const indexes = [...calls.keys()].sort((left, right) => left - right);
    for (let index = 0; index < indexes.length; index += 1) {
      if (indexes[index] !== index) throw new Error('Streamed tool call indexes are incomplete');
    }
    const rawCalls = indexes.map(index => {
      const call = calls.get(index)!;
      return { id: call.id, function: { name: call.name, arguments: call.arguments } };
    });
    if (terminalReason === 'tool_calls' && rawCalls.length === 0) throw new Error('Tool-call finish reason has no calls');
    if (terminalReason === 'stop' && rawCalls.length > 0) throw new Error('Tool calls require a tool_calls finish reason');
    const toolCalls = parseToolCalls(rawCalls);
    if (toolCalls?.length) toolCallsPresent = true;
    const requestEndedAtMs = timingContext.now();
    const timing = buildStreamTiming({
      requestStartedAtMs: timingContext.requestStartedAtMs,
      responseHeadersAtMs: timingContext.responseHeadersAtMs,
      requestEndedAtMs,
      firstContentDeltaAtMs,
      lastContentDeltaAtMs,
      contentDeltaCount,
      contentDeltaGapsMs,
      reasoningPresent,
      toolCallsPresent,
      nonTextDeltaPresent,
      outputTokens: usage?.outputTokens,
      reasoningOutputTokens: usage?.reasoningOutputTokens,
      reasoningModeDisabled: timingContext.reasoningModeDisabled,
    });
    return {
      text,
      ...(identity.model ? { providerModel: identity.model } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
      finishReason: toolCalls?.length ? 'tool_call' : 'stop',
      ...(usage ? { usage } : {}), timing,
    };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function normalizeProviderUsage(value: unknown, requireComplete: boolean): Usage {
  if (!isRecord(value)) throw new Error('Malformed provider usage');
  const inputTokens = readOptionalCounter(value, 'prompt_tokens');
  const outputTokens = readOptionalCounter(value, 'completion_tokens');
  const totalTokens = readOptionalCounter(value, 'total_tokens');
  const cacheHitInputTokens = readCounterAliases([
    [value, 'prompt_cache_hit_tokens'], [value, 'cache_hit_input_tokens'],
    [readOptionalRecord(value, 'prompt_tokens_details'), 'cached_tokens'],
  ]);
  const cacheMissInputTokens = readCounterAliases([
    [value, 'prompt_cache_miss_tokens'], [value, 'cache_miss_input_tokens'],
  ]);
  const reasoningOutputTokens = readCounterAliases([
    [value, 'reasoning_output_tokens'], [value, 'reasoning_tokens'],
    [readOptionalRecord(value, 'completion_tokens_details'), 'reasoning_tokens'],
    [readOptionalRecord(value, 'output_tokens_details'), 'reasoning_tokens'],
  ]);

  if (requireComplete && (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined)) {
    throw new Error('Incomplete provider usage');
  }
  if (inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined &&
    (!Number.isSafeInteger(inputTokens + outputTokens) || inputTokens + outputTokens !== totalTokens)) {
    throw new Error('Inconsistent provider token usage');
  }
  if (inputTokens !== undefined && cacheHitInputTokens !== undefined && cacheHitInputTokens > inputTokens) {
    throw new Error('Cache-hit prompt tokens exceed total prompt tokens');
  }
  if (inputTokens !== undefined && cacheMissInputTokens !== undefined && cacheMissInputTokens > inputTokens) {
    throw new Error('Cache-miss prompt tokens exceed total prompt tokens');
  }
  if (cacheHitInputTokens !== undefined && cacheMissInputTokens !== undefined) {
    const cacheTotal = cacheHitInputTokens + cacheMissInputTokens;
    if (!Number.isSafeInteger(cacheTotal) || inputTokens !== undefined && cacheTotal !== inputTokens) {
      throw new Error('Inconsistent cached and uncached prompt token usage');
    }
  }
  if (outputTokens !== undefined && reasoningOutputTokens !== undefined && reasoningOutputTokens > outputTokens) {
    throw new Error('Reasoning output tokens exceed total completion tokens');
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheHitInputTokens !== undefined ? { cacheHitInputTokens } : {}),
    ...(cacheMissInputTokens !== undefined ? { cacheMissInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

type CounterLocation = readonly [Record<string, unknown> | undefined, string];

function readOptionalCounter(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(record, key) || record[key] === undefined) return undefined;
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Malformed provider usage field '${key}'`);
  return value as number;
}

function readOptionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!Object.hasOwn(record, key) || record[key] === undefined) return undefined;
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Malformed provider usage details '${key}'`);
  return value;
}

function readCounterAliases(locations: readonly CounterLocation[]): number | undefined {
  const found: number[] = [];
  for (const [record, key] of locations) {
    if (record === undefined) continue;
    const value = readOptionalCounter(record, key);
    if (value !== undefined) found.push(value);
  }
  if (found.some(value => value !== found[0])) throw new Error('Conflicting provider usage counter aliases');
  return found[0];
}

function normalizeProviderModel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Malformed provider model ID');
  return value;
}

function buildStreamTiming(input: {
  requestStartedAtMs: number;
  responseHeadersAtMs: number;
  requestEndedAtMs: number;
  firstContentDeltaAtMs: number | undefined;
  lastContentDeltaAtMs: number | undefined;
  contentDeltaCount: number;
  contentDeltaGapsMs: readonly number[];
  reasoningPresent: boolean;
  toolCallsPresent: boolean;
  nonTextDeltaPresent: boolean;
  outputTokens: number | undefined;
  reasoningOutputTokens: number | undefined;
  reasoningModeDisabled: boolean;
}): ModelResponseTiming {
  const common = {
    streaming: true,
    requestStartedAtMs: input.requestStartedAtMs,
    responseHeadersAtMs: input.responseHeadersAtMs,
    requestEndedAtMs: input.requestEndedAtMs,
    elapsedMs: input.requestEndedAtMs - input.requestStartedAtMs,
    contentDeltaCount: input.contentDeltaCount,
    contentDeltaGapsMs: [...input.contentDeltaGapsMs],
    contentDeltaGapSemantics: 'sse_content_event_interarrival_not_token_itl' as const,
    ...(input.firstContentDeltaAtMs !== undefined ? { firstContentDeltaAtMs: input.firstContentDeltaAtMs } : {}),
    ...(input.lastContentDeltaAtMs !== undefined ? { lastContentDeltaAtMs: input.lastContentDeltaAtMs } : {}),
  };
  if (input.firstContentDeltaAtMs === undefined || input.lastContentDeltaAtMs === undefined) {
    return { ...common, ttftUnavailableReason: 'no_content_delta', tpotUnavailableReason: 'no_content_delta' };
  }
  const ttftMs = input.firstContentDeltaAtMs - input.requestStartedAtMs;
  if (input.reasoningPresent) return { ...common, ttftMs, tpotUnavailableReason: 'reasoning_present' };
  if (input.toolCallsPresent) return { ...common, ttftMs, tpotUnavailableReason: 'tool_calls_present' };
  if (input.nonTextDeltaPresent) return { ...common, ttftMs, tpotUnavailableReason: 'non_text_delta_present' };
  if (input.outputTokens === undefined) return { ...common, ttftMs, tpotUnavailableReason: 'output_token_count_unknown' };
  if (!input.reasoningModeDisabled && input.reasoningOutputTokens !== 0) {
    return { ...common, ttftMs, tpotUnavailableReason: 'reasoning_unknown' };
  }
  if (input.outputTokens < 2) return { ...common, ttftMs, tpotUnavailableReason: 'fewer_than_two_output_tokens' };
  if (input.contentDeltaCount < 2) return { ...common, ttftMs, tpotUnavailableReason: 'fewer_than_two_content_deltas' };
  return {
    ...common,
    ttftMs,
    meanTpotMs: (input.lastContentDeltaAtMs - input.firstContentDeltaAtMs) / (input.outputTokens - 1),
  };
}

function hasNonEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function createMonotonicClock(now: () => number): () => number {
  let previous = Number.NEGATIVE_INFINITY;
  return () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || value < previous) throw new Error('Monotonic clock returned an invalid or decreasing timestamp');
    previous = value;
    return value;
  };
}

function normalizeNonStreamingFinishReason(value: unknown, toolCallCount: number): ModelResponse['finishReason'] {
  if (value === 'length') {
    if (toolCallCount > 0) throw new Error('Truncated response included tool calls');
    return 'length';
  }
  if (value === 'content_filter') throw new Error('Model response was filtered');
  if (value === 'tool_calls') {
    if (toolCallCount === 0) throw new Error('Tool-call finish reason has no calls');
    return 'tool_call';
  }
  if (value === 'stop') {
    if (toolCallCount > 0) throw new Error('Tool calls require a tool_calls finish reason');
    return 'stop';
  }
  if (value === undefined || value === null) {
    // A complete non-streaming JSON body is the compatibility boundary for providers that omit finish_reason.
    return toolCallCount > 0 ? 'tool_call' : 'stop';
  }
  throw new Error('Model returned an unsupported finish reason');
}
