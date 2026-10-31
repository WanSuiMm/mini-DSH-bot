/** Public contracts for the minimal runtime. No OS isolation is implied. */

/** Agent lifecycle and supervisor delegation contracts. */
export type AgentStatus = "idle" | "running" | "waiting" | "stopped";
export interface AgentState {
  agentId: string;
  status: AgentStatus;
  sessionId: string;
  currentTaskId?: string;
  lastError?: StructuredError;
}
export type TaskStatus = "queued" | "running" | "waiting" | "succeeded" | "partial" | "failed" | "cancelled" | "timed_out";
export interface ExecutionBudget {
  maxTokens?: number; maxToolCalls?: number;
  maxDurationMs?: number; deadlineAt?: string;
  maxActiveChildren?: number; maxDelegationDepth?: number;
}
export interface SubtaskSpec {
  sessionId: string;
  parentTaskId?: string;
  taskId: string;
  runId: string;
  attempt: number;
  title: string;
  instructions: string;
  dependencies: readonly string[];
  contextRefs: readonly string[];
  allowedTools: readonly string[];
  budget: ExecutionBudget;
}
export interface TaskRecord extends SubtaskSpec {
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  result?: ResultEnvelope;
}

/** Structured result, evidence, error, and usage contracts. */
export interface Evidence {
  id: string;
  kind: "artifact" | "tool_output" | "citation" | "message" | "log";
  ref?: string;
  summary?: string;
  metadata?: Readonly<Record<string, unknown>>;
}
export interface StructuredError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}
export interface Usage {
  inputTokens?: number; outputTokens?: number;
  totalTokens?: number; toolCalls?: number; elapsedMs?: number;
  /** Provider-reported cached prompt tokens. Missing means unknown, never zero. */
  cacheHitInputTokens?: number;
  /** Provider-reported uncached prompt tokens. Missing means unknown, never inferred. */
  cacheMissInputTokens?: number;
  /** Provider-reported reasoning tokens, when exposed by the provider. */
  reasoningOutputTokens?: number;
}
export type ResultEnvelope<T = unknown> =
  | { ok: true; data: T; evidence: readonly Evidence[]; usage?: Usage }
  | { ok: false; error: StructuredError; evidence: readonly Evidence[]; usage?: Usage };

/** Logical session and event records. */
export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Readonly<Record<string, unknown>>;
}
export interface EventRecord {
  eventId: string;
  sessionId: string;
  type: string;
  timestamp: string;
  actorId?: string;
  taskId?: string;
  payload?: unknown;
}

/** Namespace-scoped memory CRUD; TTL expiry is part of the store contract. */
export interface MemoryRecord {
  id: string; namespace: string;
  value: unknown;
  createdAt: string; updatedAt: string;
  expiresAt?: string;
  sourceRefs?: readonly string[];
  version?: string;
}
export interface MemoryWrite {
  id: string; namespace: string;
  value: unknown;
  ttlMs?: number;
  sourceRefs?: readonly string[];
}
export interface MemoryQuery { namespace: string; text?: string; limit?: number; }
export interface MemoryStore {
  create(record: MemoryWrite): Promise<MemoryRecord>;
  get(namespace: string, id: string): Promise<MemoryRecord | undefined>;
  update(record: MemoryWrite): Promise<MemoryRecord>;
  delete(namespace: string, id: string): Promise<boolean>;
  list(query: MemoryQuery): Promise<readonly MemoryRecord[]>;
  search(query: MemoryQuery): Promise<readonly MemoryRecord[]>;
}

/** Runtime adapter boundaries carry per-call execution context. */
export interface ExecutionContext {
  sessionId: string; agentId: string;
  taskId: string; runId: string;
  attempt: number;
  /** Provider-assigned call identity, available to durable tool observers. */
  toolCallId?: string;
  allowedTools: readonly string[];
  contextRefs: readonly string[];
  budget: ExecutionBudget;
  signal?: AbortSignal;
}
export interface ToolRuntime {
  execute<T = unknown>(name: string, input: unknown, context: ExecutionContext): Promise<ResultEnvelope<T>>;
  /** True only when repeated or concurrent execution cannot change external state. */
  isReadOnly?(name: string): boolean;
}
export interface ModelToolCall { id: string; name: string; input: unknown; }
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string; toolCallId?: string; toolCalls?: readonly ModelToolCall[];
}
export interface ModelRequest {
  messages: readonly ModelMessage[];
  model?: string; temperature?: number; maxOutputTokens?: number;
}
/** Adapter-observed monotonic timing. SSE content-delta gaps are event inter-arrivals, not token ITL. */
export interface ModelResponseTiming {
  streaming: boolean;
  requestStartedAtMs: number;
  responseHeadersAtMs: number;
  requestEndedAtMs: number;
  elapsedMs: number;
  /** Times of non-empty SSE `delta.content` events; an event may contain multiple tokens. */
  firstContentDeltaAtMs?: number;
  lastContentDeltaAtMs?: number;
  contentDeltaCount: number;
  /** Inter-arrival gaps between non-empty content events; not token latency. */
  contentDeltaGapsMs: readonly number[];
  contentDeltaGapSemantics: "sse_content_event_interarrival_not_token_itl";
  ttftMs?: number;
  ttftUnavailableReason?: "non_streaming" | "no_content_delta";
  /** Mean TPOT estimate, present only for eligible pure-text streams with >=2 content events. */
  meanTpotMs?: number;
  tpotUnavailableReason?:
    | "non_streaming"
    | "no_content_delta"
    | "reasoning_present"
    | "reasoning_unknown"
    | "tool_calls_present"
    | "non_text_delta_present"
    | "output_token_count_unknown"
    | "fewer_than_two_output_tokens"
    | "fewer_than_two_content_deltas";
}
export interface ModelResponse {
  text: string;
  /** Provider-reported model ID when the completion response includes one. */
  providerModel?: string;
  finishReason?: "stop" | "tool_call" | "length" | "other";
  usage?: Usage;
  timing?: ModelResponseTiming;
  evidence?: readonly Evidence[];
  toolCalls?: readonly ModelToolCall[];
}
export interface ModelTokenCount { inputTokens: number; maxContextTokens?: number; }
export interface ModelAdapter {
  generate(request: ModelRequest, context: ExecutionContext): Promise<ResultEnvelope<ModelResponse>>;
  /** Optional exact provider preflight. When configured, failure must stop generation. */
  countTokens?(request: ModelRequest, context: ExecutionContext): Promise<ResultEnvelope<ModelTokenCount>>;
  /** Optional local estimate of the serialized provider prompt, including allowed tool schemas. */
  estimatePromptTokens?(request: ModelRequest, context: ExecutionContext): number;
}
export interface SubagentRunner {
  run(subtask: SubtaskSpec, context: ExecutionContext): Promise<TaskRecord>;
}

/** Task persistence contracts for the supervisor and subagents. */
export interface TaskQuery {
  sessionId?: string; parentTaskId?: string; status?: TaskStatus;
}
export interface TaskStore {
  create(task: TaskRecord): Promise<TaskRecord>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  update(task: TaskRecord): Promise<TaskRecord>;
  delete(taskId: string): Promise<boolean>;
  list(query?: TaskQuery): Promise<readonly TaskRecord[]>;
}
