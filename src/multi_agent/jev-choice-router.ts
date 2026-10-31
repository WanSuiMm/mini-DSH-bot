/**
 * One-shot, host-bounded routing through TypeSafe System One Choice.
 * Jev returns a decision only; this module never discovers or invokes tools.
 */

export type JevState = string | Readonly<Record<string, unknown>> | readonly unknown[];

export interface JevRouteCandidate<T> {
  /** Stable protocol option name and host-side lookup key. */
  id: string;
  /** Host-authored explanation shown to Jev. */
  description: string;
  /** Host-owned execution value; it is never serialized to TypeSafe. */
  value: T;
}

export interface JevChoiceRouterOptions {
  apiKey: string;
  /** Exact model name selected by the host from TypeSafe's model catalog. */
  model: string;
  /** API root (default: https://api.typesafe.ai/v1), without /systemone. */
  baseUrl?: string;
  /** Injected HTTP transport; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  minConfidence: number;
}

export interface JevRouteReceipt {
  status: "selected" | "fallback" | "bypassed" | "cancelled";
  selectedId?: string;
  source: "jev" | "host_fallback" | "host_rule";
  reason?: string;
  requestedModel?: string;
  returnedModel?: string;
  confidence?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  credits?: number;
  requestId?: string;
  elapsedMs?: number;
  /** True when the injected transport was invoked; it is not an exactly-once guarantee. */
  requestAttempted?: boolean;
}

export interface JevChoiceResult<T> {
  candidate?: JevRouteCandidate<T>;
  receipt: JevRouteReceipt;
}

export interface JevChooseInput<T> {
  enabled: boolean;
  state: JevState;
  candidates: readonly JevRouteCandidate<T>[];
  fallbackId: string;
  signal?: AbortSignal;
  /** Optional deterministic host rule, run before any network request. */
  hostRule?: (state: JevState, candidates: readonly JevRouteCandidate<T>[]) => string | undefined;
  /** Stable per-run request marker; this client never retries or claims exactly-once delivery. */
  idempotencyKey?: string;
}

type FetchOutcome =
  | { kind: "response"; response: Response; bodyText?: string; requestAttempted: true }
  | { kind: "oversize"; response: Response; requestAttempted: true }
  | { kind: "timeout"; requestAttempted: boolean }
  | { kind: "cancelled"; requestAttempted: boolean }
  | { kind: "error"; requestAttempted: boolean };

const MAX_REQUEST_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

export class JevChoiceRouter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly minConfidence: number;

  /** Non-secret recovery identity. Never contains the API key or request state. */
  readonly executionProfile: string;

  constructor(options: JevChoiceRouterOptions) {
    if (!options || typeof options.apiKey !== "string" || !options.apiKey.trim()) {
      throw new TypeError("Jev router requires an API key from the host");
    }
    if (typeof options.model !== "string" || !options.model.trim() || options.model.length > 128) {
      throw new TypeError("Jev router requires an exact TypeSafe model name");
    }
    const baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if ((baseUrl.protocol !== "https:" && !isLoopbackHttp(baseUrl)) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new TypeError("Jev router baseUrl must be HTTPS (or local loopback HTTP) without credentials, query, or fragment");
    }
    if (!Number.isSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) || (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1) {
      throw new TypeError("Jev router timeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) ||
        (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) < 1 ||
        (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) > 65_536) {
      throw new TypeError("Jev router maxResponseBytes must be from 1 through 65536");
    }
    if (!Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1) {
      throw new TypeError("Jev router minConfidence must be between 0 and 1");
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new TypeError("Jev router requires a Fetch implementation");

    this.apiKey = options.apiKey;
    this.model = options.model;
    this.endpoint = `${baseUrl.toString().replace(/\/+$/, "")}/systemone`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.minConfidence = options.minConfidence;
    this.executionProfile = JSON.stringify({
      provider: "typesafe-systemone-choice",
      endpoint: this.endpoint,
      model: this.model,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
      minConfidence: this.minConfidence,
    });
  }

  async choose<T>(input: JevChooseInput<T>): Promise<JevChoiceResult<T>> {
    const validation = validateHostInput(input);
    if (validation) throw new TypeError(validation);
    const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
    const fallback = candidateById.get(input.fallbackId)!;
    const startedAt = Date.now();
    const fallbackResult = (status: "fallback" | "bypassed", reason: string): JevChoiceResult<T> => ({
      candidate: fallback,
      receipt: { status, selectedId: fallback.id, source: "host_fallback", reason, requestedModel: this.model,
        elapsedMs: Date.now() - startedAt },
    });

    if (input.signal?.aborted) {
      return { receipt: { status: "cancelled", source: "host_fallback", reason: "cancelled_before_request", requestedModel: this.model } };
    }
    if (!input.enabled) return fallbackResult("bypassed", "disabled");

    if (input.hostRule) {
      let ruleId: string | undefined;
      try { ruleId = input.hostRule(input.state, input.candidates); }
      catch { return fallbackResult("fallback", "host_rule_error"); }
      if (ruleId !== undefined) {
        const candidate = candidateById.get(ruleId);
        if (!candidate) return fallbackResult("fallback", "host_rule_unknown_candidate");
        return { candidate, receipt: { status: "bypassed", selectedId: candidate.id, source: "host_rule",
          reason: "host_rule", requestedModel: this.model, elapsedMs: Date.now() - startedAt } };
      }
    }

    // A one-option Choice is not portable across hosted models. The host has
    // already narrowed the legal route set, so deterministically use its fallback.
    if (input.candidates.length < 2) return fallbackResult("bypassed", "fewer_than_two_host_candidates");

    const criteria = Object.fromEntries(input.candidates.map(({ id, description }) => [id, description]));
    const body = {
      model: this.model,
      state: input.state,
      questions: {
        route: {
          type: "choice",
          instructions: "Choose one host-provided execution mode. The available tools and permissions are fixed by the host and cannot be changed by this decision.",
          criteria,
        },
      },
    };
    let serialized: string;
    try { serialized = JSON.stringify(body); }
    catch { return fallbackResult("fallback", "invalid_state"); }
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
      return fallbackResult("fallback", "request_too_large");
    }

    const fetchOutcome = await this.fetchAndReadOnce(serialized, input.signal, input.idempotencyKey);
    if (fetchOutcome.kind === "cancelled") {
      return { receipt: { status: "cancelled", source: "host_fallback", reason: "cancelled", requestedModel: this.model,
        requestAttempted: fetchOutcome.requestAttempted, elapsedMs: Date.now() - startedAt } };
    }
    if (fetchOutcome.kind === "timeout") {
      const timedOut = fallbackResult("fallback", "timeout");
      timedOut.receipt.requestAttempted = fetchOutcome.requestAttempted;
      return timedOut;
    }
    if (fetchOutcome.kind === "error") {
      const failed = fallbackResult("fallback", "transport_error");
      failed.receipt.requestAttempted = fetchOutcome.requestAttempted;
      return failed;
    }
    if (fetchOutcome.kind === "oversize") return this.withResponseMetadata(fallbackResult("fallback", "response_too_large"), fetchOutcome.response, startedAt);
    const { response } = fetchOutcome;
    if (!response.ok) return this.withResponseMetadata(fallbackResult("fallback", `http_${response.status}`), response, startedAt);

    let payload: unknown;
    if (typeof fetchOutcome.bodyText !== "string") return this.withResponseMetadata(fallbackResult("fallback", "empty_response_body"), response, startedAt);
    try { payload = JSON.parse(fetchOutcome.bodyText); }
    catch { return this.withResponseMetadata(fallbackResult("fallback", "invalid_json"), response, startedAt); }
    const parsed = parseChoiceResponse(payload, input.candidates);
    if (!parsed) {
      const invalid = fallbackResult("fallback", "invalid_or_unknown_choice");
      invalid.receipt.usage = readUsage(payload);
      return this.withResponseMetadata(invalid, response, startedAt);
    }
    if (parsed.confidence < this.minConfidence) {
      const low = fallbackResult("fallback", "low_confidence");
      low.receipt.confidence = parsed.confidence;
      low.receipt.returnedModel = parsed.model;
      low.receipt.usage = parsed.usage;
      return this.withResponseMetadata(low, response, startedAt);
    }

    return this.withResponseMetadata({ candidate: candidateById.get(parsed.choice)!, receipt: {
      status: "selected", selectedId: parsed.choice, source: "jev", requestedModel: this.model,
      returnedModel: parsed.model, confidence: parsed.confidence, ...(parsed.usage ? { usage: parsed.usage } : {}),
    } }, response, startedAt);
  }

  private async fetchAndReadOnce(body: string, signal?: AbortSignal, idempotencyKey?: string): Promise<FetchOutcome> {
    if (signal?.aborted) return { kind: "cancelled", requestAttempted: false };
    const controller = new AbortController();
    let requestAttempted = false;
    let resolveStop!: (outcome: FetchOutcome) => void;
    const stopped = new Promise<FetchOutcome>((resolve) => { resolveStop = resolve; });
    const onAbort = (): void => { controller.abort(); resolveStop({ kind: "cancelled", requestAttempted }); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { controller.abort(); resolveStop({ kind: "timeout", requestAttempted }); }, this.timeoutMs);
    const request = Promise.resolve().then(async (): Promise<FetchOutcome> => {
      if (controller.signal.aborted) return signal?.aborted ? { kind: "cancelled", requestAttempted } : { kind: "timeout", requestAttempted };
      requestAttempted = true;
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // A tracing marker only; this client sends one request and makes no delivery guarantee.
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { kind: "response", response, requestAttempted: true };
      }
      const bodyText = await readBoundedBody(response, this.maxResponseBytes);
      return bodyText === undefined ? { kind: "oversize", response, requestAttempted: true }
        : { kind: "response", response, bodyText, requestAttempted: true };
    }).catch((): FetchOutcome => controller.signal.aborted
      ? (signal?.aborted ? { kind: "cancelled", requestAttempted } : { kind: "timeout", requestAttempted })
      : { kind: "error", requestAttempted });
    try { return await Promise.race([request, stopped]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private withResponseMetadata<T>(result: JevChoiceResult<T>, response: Response, startedAt: number): JevChoiceResult<T> {
    const rawRequestId = response.headers.get("X-Request-Id") ?? undefined;
    const requestId = rawRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(rawRequestId) ? rawRequestId : undefined;
    const creditText = response.headers.get("X-System-One-Credits");
    const credits = creditText !== null && creditText.length <= 16 && /^\d+$/.test(creditText) && Number.isSafeInteger(Number(creditText))
      ? Number(creditText) : undefined;
    result.receipt = {
      ...result.receipt,
      ...(requestId ? { requestId } : {}),
      ...(credits === undefined ? {} : { credits }),
      requestAttempted: true,
      elapsedMs: Date.now() - startedAt,
    };
    return result;
  }
}

function validateHostInput<T>(input: JevChooseInput<T>): string | undefined {
  if (!input || typeof input !== "object") return "route input is required";
  if (typeof input.enabled !== "boolean") return "enabled must be an explicit boolean";
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 255) return "host candidates must contain 1 through 255 entries";
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate || typeof candidate.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.id) ||
        typeof candidate.description !== "string" || !candidate.description.trim() || candidate.description.length > 2000 ||
        ids.has(candidate.id)) return "host candidates must have unique protocol-safe ids and descriptions";
    ids.add(candidate.id);
  }
  if (typeof input.fallbackId !== "string" || !ids.has(input.fallbackId)) return "fallbackId must name a host candidate";
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey))) {
    return "idempotencyKey must be a stable header-safe value";
  }
  if (input.signal !== undefined && typeof input.signal?.addEventListener !== "function") return "signal must be an AbortSignal";
  return undefined;
}

function parseChoiceResponse<T>(payload: unknown, candidates: readonly JevRouteCandidate<T>[]): {
  model: string; choice: string; confidence: number; usage?: { inputTokens?: number; outputTokens?: number };
} | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, unknown>;
  if (typeof root.model !== "string" || !/^[^\u0000-\u001f\u007f]{1,128}$/.test(root.model) || !root.answers || typeof root.answers !== "object" || Array.isArray(root.answers)) return undefined;
  const answers = root.answers as Record<string, unknown>;
  const answer = answers.route;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  const route = answer as Record<string, unknown>;
  if (route.type !== "choice" || typeof route.choice !== "string" ||
      typeof route.confidence !== "number" || !Number.isFinite(route.confidence) || route.confidence < 0 || route.confidence > 1) return undefined;
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (!candidateIds.has(route.choice)) return undefined;
  if (!route.probabilities || typeof route.probabilities !== "object" || Array.isArray(route.probabilities)) return undefined;
  const probabilities = route.probabilities as Record<string, unknown>;
  const probabilityIds = Object.keys(probabilities);
  if (probabilityIds.length !== candidateIds.size || probabilityIds.some((id) => !candidateIds.has(id)) ||
      probabilityIds.some((id) => typeof probabilities[id] !== "number" || !Number.isFinite(probabilities[id]) ||
        (probabilities[id] as number) < 0 || (probabilities[id] as number) > 1)) return undefined;

  const usage = readUsage(root);
  if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { model: root.model, choice: route.choice, confidence: route.confidence as number, ...(usage ? { usage } : {}) };
}

function readUsage(payload: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const rawUsage = (payload as Record<string, unknown>).usage;
  if (rawUsage === undefined || rawUsage === null || typeof rawUsage !== "object" || Array.isArray(rawUsage)) return undefined;
  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if ((inputTokens !== undefined && (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0)) ||
      (outputTokens !== undefined && (typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0))) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    return response.body === null ? "" : undefined;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}
