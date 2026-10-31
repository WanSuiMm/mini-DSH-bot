import type {
  ExecutionContext,
  ResultEnvelope,
  StructuredError,
  ToolRuntime,
} from "../contracts.js";

export type ToolHandler<T = unknown> = (
  input: unknown,
  context: ExecutionContext,
) => ResultEnvelope<T> | Promise<ResultEnvelope<T>>;

export interface ToolRegistrationOptions {
  readOnly?: boolean;
  /** Trusted host metadata. Never take permissions from model/server annotations. */
  policy?: Readonly<Record<string, unknown>>;
}

export interface ToolGuardDecision {
  action: "allow" | "deny" | "approval";
  ruleId: string;
  reason: string;
  policyVersion?: string;
}
export interface ToolExecutionGuard {
  evaluate(call: { name: string; input: unknown; context: ExecutionContext; options: ToolRegistrationOptions }): ToolGuardDecision | Promise<ToolGuardDecision>;
  redact?(value: unknown): unknown;
}
export interface ToolRegistryOptions {
  guard?: ToolExecutionGuard;
  /** Failure to persist an audit decision blocks dispatch. No arguments are included. */
  onDecision?(decision: ToolGuardDecision, call: { name: string; context: ExecutionContext }): void | Promise<void>;
  onDispatch?(call: { name: string; input: unknown; context: ExecutionContext }): void | Promise<void>;
  onResult?(result: ResultEnvelope<unknown>, call: { name: string; context: ExecutionContext }): void | Promise<void>;
}

interface ToolRegistration {
  handler: ToolHandler<unknown>;
  readOnly: boolean;
  options: ToolRegistrationOptions;
}

/** An explicit named-tool allowlist. This registry does not expose a shell. */
export class ToolRegistry implements ToolRuntime {
  private readonly registrations = new Map<string, ToolRegistration>();
  constructor(private readonly settings: ToolRegistryOptions = {}) {}

  register<T = unknown>(
    name: string,
    handler: ToolHandler<T>,
    options: ToolRegistrationOptions = {},
  ): this {
    const normalizedName = validateName(name);
    if (this.registrations.has(normalizedName)) {
      throw new Error(`Tool already registered: ${normalizedName}`);
    }
    if (typeof handler !== "function") {
      throw new TypeError("Tool handler must be a function");
    }

    this.registrations.set(normalizedName, {
      handler: handler as ToolHandler<unknown>,
      readOnly: options.readOnly ?? false,
      options: structuredClone(options),
    });
    return this;
  }

  isReadOnly(name: string): boolean {
    const registration = this.registrations.get(name);
    return Boolean(registration?.readOnly && (!this.settings.guard || registration.options.policy?.effect === "read"));
  }

  has(name: string): boolean {
    return this.registrations.has(name);
  }

  names(): readonly string[] {
    return [...this.registrations.keys()];
  }

  async execute<T = unknown>(
    name: string,
    input: unknown,
    context: ExecutionContext,
  ): Promise<ResultEnvelope<T>> {
    if (!context.allowedTools.includes(name)) {
      return failure("TOOL_NOT_ALLOWED", `Tool '${name}' is not allowed for this task.`);
    }
    const registration = this.registrations.get(name);
    if (!registration) {
      return failure("UNKNOWN_TOOL", `No tool is registered as '${name}'.`);
    }
    if (context.signal?.aborted) {
      return failure("CANCELLED", "Tool execution was cancelled before it started.");
    }

    try {
      // Snapshot inputs before the asynchronous policy check: callers cannot swap
      // an already approved path or argv while the guard is awaiting filesystem IO.
      const checkedInput = structuredClone(input);
      if (this.settings.guard) {
        let decision: ToolGuardDecision;
        try {
          decision = await this.settings.guard.evaluate({ name, input: checkedInput, context, options: registration.options });
          if (!decision || !["allow", "deny", "approval"].includes(decision.action) || !decision.ruleId || !decision.reason) {
            return failure("TOOL_GUARD_FAILED", "The execution policy returned an invalid decision.");
          }
          await this.settings.onDecision?.(decision, { name, context });
        } catch {
          return failure("TOOL_GUARD_FAILED", "The execution policy or its audit could not be checked.");
        }
        if (decision.action !== "allow") {
          return failure(decision.action === "approval" ? "TOOL_APPROVAL_REQUIRED" : "TOOL_POLICY_DENIED", decision.reason);
        }
      }
      // Cancellation may arrive during path resolution or durable auditing.
      if (context.signal?.aborted) return failure("CANCELLED", "Tool execution was cancelled before dispatch.");
      await this.settings.onDispatch?.({ name, input: this.settings.guard?.redact ? this.settings.guard.redact(checkedInput) : checkedInput, context });
      if (context.signal?.aborted) return failure("CANCELLED", "Tool execution was cancelled before dispatch.");
      const rawResult = await registration.handler(checkedInput, context);
      const result = this.settings.guard?.redact ? this.settings.guard.redact(rawResult) : rawResult;
      if (!isResultEnvelope(result)) {
        return failure("INVALID_TOOL_RESULT", `Tool '${name}' returned an invalid result envelope.`);
      }
      await this.settings.onResult?.(result, { name, context });
      return result as ResultEnvelope<T>;
    } catch (cause) {
      const error: StructuredError = {
        code: "TOOL_EXECUTION_FAILED",
        message: this.settings.guard ? `Tool '${name}' failed.` : `Tool '${name}' failed: ${errorMessage(cause)}`,
        retryable: false,
      };
      return { ok: false, error, evidence: [] };
    }
  }
}

function validateName(name: string): string {
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new TypeError("Tool names must start with a letter and contain at most 64 safe characters");
  }
  return name;
}

function isResultEnvelope(value: unknown): value is ResultEnvelope<unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const envelope = value as { ok?: unknown; evidence?: unknown; error?: unknown };
  if (typeof envelope.ok !== "boolean" || !Array.isArray(envelope.evidence)) return false;
  if (!envelope.ok) {
    return typeof envelope.error === "object" && envelope.error !== null;
  }
  return "data" in (value as object);
}

function failure(code: string, message: string): ResultEnvelope<never> {
  return { ok: false, error: { code, message }, evidence: [] };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
