import type {
  Evidence,
  ExecutionBudget,
  ExecutionContext,
  ModelAdapter,
  ModelMessage,
  ModelResponse,
  ModelToolCall,
  ResultEnvelope,
  StructuredError,
  SubtaskSpec,
  ToolRuntime,
  Usage,
} from "../contracts.js";
import { buildTaskMessages } from "../context/task-context.js";
import { executeDeepSeekHarnessToolCalls } from "../adapters/deepseek-harness-tool-calls.js";

const DEFAULT_MAX_TOOL_CALLS = 16;
const DEFAULT_MAX_MODEL_CALLS = 32;
const MAX_MODEL_CALLS = 512;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MAX_OUTPUT_TOKENS = 384_000;
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 2;
const FIRST_RECOVERY_OUTPUT_TOKENS = 4_096;
const DEFAULT_MAX_TOTAL_TOKENS = 32_768;
const DEFAULT_MAX_DURATION_MS = 120_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AgentLoopOptions {
  /** Maximum number of read-only tool calls dispatched concurrently. */
  maxParallelToolCalls?: number;
  /** Maximum number of model requests; defaults to 32 and is capped at 512. */
  maxModelCalls?: number;
  /** Maximum completion length for each model request. */
  maxOutputTokens?: number;
  /** Minimum completion reservation when provider context is finite; defaults to one token. */
  minOutputTokens?: number;
  /** Provider context limit, including prompt and requested completion. */
  maxContextTokens?: number;
  /** Disables only the cumulative task token cap; per-request, tool, model-call and time limits remain active. */
  disableCumulativeTokenLimit?: boolean;
  /** Retry output-length truncation up to two times, only when complete provider usage is available. */
  recoverOutputTruncation?: boolean;
  /** Additional policy text included in the system role for every model call. */
  systemInstructions?: readonly string[];
  /** Optional provider-facing projection; the original result remains in evidence and service audit records. */
  projectToolResultForModel?: (toolName: string, result: ResultEnvelope<unknown>) => unknown;
  /** Optional terminal acknowledgement for a single successful tool call; nonempty text ends the loop without another model request. */
  terminalToolResult?: (call: ModelToolCall, result: ResultEnvelope<unknown>) => string | undefined;
  /** Audit hook called before and after each provider request. Payloads contain metrics, never prompts or credentials. */
  onModelEvent?: (type: "model.request" | "model.request_blocked" | "model.response", payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
  /** Optional label for the model's role in the service flow. */
  modelPhase?: string;
}

interface EffectiveBudget {
  maxTokens: number;
  maxToolCalls: number;
  maxModelCalls: number;
  deadlineAtMs: number;
}

interface MutableUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  startedAt: number;
}

class LoopFailure extends Error {
  constructor(readonly structured: StructuredError) {
    super(structured.message);
    this.name = "LoopFailure";
  }
}

/**
 * Bounded model/tool loop. Tool calls are sent only through the supplied
 * ToolRuntime, with the intersection of the task and execution allowlists.
 * An AbortSignal can stop waiting for an adapter that ignores cancellation,
 * but it cannot preempt or roll back side effects already started by that adapter.
 */
export class AgentLoop {
  private readonly maxParallelToolCalls: number;
  private readonly maxModelCalls: number;
  private readonly maxOutputTokens: number;
  private readonly minOutputTokens: number;
  private readonly maxContextTokens?: number;
  private readonly disableCumulativeTokenLimit: boolean;
  private readonly recoverOutputTruncation: boolean;
  private readonly systemInstructions: readonly string[];
  private readonly projectToolResultForModel?: AgentLoopOptions["projectToolResultForModel"];
  private readonly terminalToolResult?: AgentLoopOptions["terminalToolResult"];
  private readonly onModelEvent?: AgentLoopOptions["onModelEvent"];
  private readonly modelPhase: string;

  constructor(
    private readonly model: ModelAdapter,
    private readonly tools: ToolRuntime,
    options: AgentLoopOptions = {},
  ) {
    this.maxParallelToolCalls = options.maxParallelToolCalls ?? 1;
    this.maxModelCalls = options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.minOutputTokens = options.minOutputTokens ?? 1;
    this.maxContextTokens = options.maxContextTokens;
    this.disableCumulativeTokenLimit = options.disableCumulativeTokenLimit ?? false;
    this.recoverOutputTruncation = options.recoverOutputTruncation ?? false;
    this.systemInstructions = options.systemInstructions ?? [];
    this.projectToolResultForModel = options.projectToolResultForModel;
    this.terminalToolResult = options.terminalToolResult;
    this.onModelEvent = options.onModelEvent;
    this.modelPhase = options.modelPhase ?? "worker";
    if (!Number.isSafeInteger(this.maxParallelToolCalls) || this.maxParallelToolCalls < 1 || this.maxParallelToolCalls > 32) {
      throw new TypeError("maxParallelToolCalls must be an integer from 1 through 32");
    }
    if (!Number.isSafeInteger(this.maxModelCalls) || this.maxModelCalls < 1 || this.maxModelCalls > MAX_MODEL_CALLS) {
      throw new TypeError(`maxModelCalls must be an integer from 1 through ${MAX_MODEL_CALLS}`);
    }
    if (!Number.isSafeInteger(this.maxOutputTokens) || this.maxOutputTokens < 1 || this.maxOutputTokens > MAX_OUTPUT_TOKENS) {
      throw new TypeError(`maxOutputTokens must be an integer from 1 through ${MAX_OUTPUT_TOKENS}`);
    }
    if (!Number.isSafeInteger(this.minOutputTokens) || this.minOutputTokens < 1 || this.minOutputTokens > this.maxOutputTokens) {
      throw new TypeError("minOutputTokens must be an integer from 1 through maxOutputTokens");
    }
    if (this.maxContextTokens !== undefined && (!Number.isSafeInteger(this.maxContextTokens) || this.maxContextTokens < 2)) {
      throw new TypeError("maxContextTokens must be an integer of at least 2");
    }
    if (typeof this.disableCumulativeTokenLimit !== "boolean") {
      throw new TypeError("disableCumulativeTokenLimit must be a boolean");
    }
    if (typeof this.recoverOutputTruncation !== "boolean") {
      throw new TypeError("recoverOutputTruncation must be a boolean");
    }
    if (this.systemInstructions.some(instruction => typeof instruction !== "string" || instruction.trim().length === 0)) {
      throw new TypeError("systemInstructions must contain nonempty strings");
    }
  }

  async run(
    task: SubtaskSpec,
    context: ExecutionContext,
  ): Promise<ResultEnvelope<ModelResponse>> {
    const usage: MutableUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      startedAt: Date.now(),
    };
    const evidence: Evidence[] = [];

    let budget: EffectiveBudget;
    try {
      assertContextMatchesTask(task, context);
      budget = resolveBudget(
        task.budget,
        context.budget,
        usage.startedAt,
        this.disableCumulativeTokenLimit,
        this.maxModelCalls,
        this.recoverOutputTruncation ? MAX_OUTPUT_RECOVERY_ATTEMPTS : 0,
      );
    } catch (cause) {
      return failedResult(structuredFrom(cause, "INVALID_TASK_CONTEXT"), evidence, usage);
    }

    const allowedTools = intersect(task.allowedTools, context.allowedTools);
    const allowedContextRefs = intersect(task.contextRefs, context.contextRefs);
    const mergedBudget = mergeBudget(task.budget, context.budget);
    if (this.disableCumulativeTokenLimit) {
      // Keep the internal unbounded sentinel out of model-visible execution context.
      delete mergedBudget.maxTokens;
    } else {
      mergedBudget.maxTokens = budget.maxTokens;
    }
    const loopContext: ExecutionContext = {
      ...context,
      allowedTools,
      contextRefs: allowedContextRefs,
      budget: {
        ...mergedBudget,
        maxToolCalls: budget.maxToolCalls,
        maxDurationMs: Math.max(0, budget.deadlineAtMs - usage.startedAt),
        deadlineAt: new Date(budget.deadlineAtMs).toISOString(),
      },
    };
    const abort = makeAbortScope(context.signal, budget.deadlineAtMs);
    const signalContext: ExecutionContext = { ...loopContext, signal: abort.signal };
    const messages = buildTaskMessages(
      { ...task, allowedTools, contextRefs: allowedContextRefs },
      [],
      allowedContextRefs,
    );
    if (this.systemInstructions.length > 0) {
      messages[0]!.content += " " + this.systemInstructions.join(" ");
    }
    const usedCallIds = new Set<string>();
    const knownEvidence = new Set<string>();
    let modelCalls = 0;
    let outputRecoveryAttempts = 0;
    let outputTokenCeiling = this.maxOutputTokens;
    let lastRequestedOutputTokens = this.maxOutputTokens;
    const reportedTokenBudget = this.disableCumulativeTokenLimit ? null : budget.maxTokens;
    const queueOutputRecovery = (reportedUsage: unknown): boolean => {
      if (!this.recoverOutputTruncation || outputRecoveryAttempts >= MAX_OUTPUT_RECOVERY_ATTEMPTS || !hasCompleteTokenUsage(reportedUsage)) {
        return false;
      }
      outputRecoveryAttempts += 1;
      outputTokenCeiling = Math.min(
        MAX_OUTPUT_TOKENS,
        Math.max(FIRST_RECOVERY_OUTPUT_TOKENS, lastRequestedOutputTokens * 2),
      );
      messages.push({
        role: "user",
        content: "The prior response reached its output limit. Its partial text and tool-call data were discarded; no tool calls from that response ran. Regenerate a complete, concise response using the conversation and tool results so far. Decide whether any further tool calls are needed, and return only complete calls with valid arguments.",
      });
      return true;
    };

    try {
      for (;;) {
        assertRunning(abort, budget);
        if (modelCalls >= budget.maxModelCalls) {
          throw failure("MODEL_CALL_LIMIT", "The task reached its model-call limit.", {
            modelCalls,
            maxModelCalls: budget.maxModelCalls,
          });
        }

        let promptTokens = this.model.estimatePromptTokens
          ? this.model.estimatePromptTokens({ messages: [...messages] }, signalContext)
          : estimateTokens(safeStringify(messages));
        let promptTokenSource = this.model.estimatePromptTokens
          ? "adapter_wire_estimate_includes_allowed_tools"
          : "message_estimate_tool_schemas_not_included";
        if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) {
          throw failure("TOKEN_COUNT_INVALID", "The model adapter returned an invalid local prompt estimate.");
        }
        let providerContextLimit = this.maxContextTokens;
        if (this.model.countTokens) {
          let counted;
          try {
            counted = await awaitAbortable(
              Promise.resolve(this.model.countTokens({ messages: [...messages] }, signalContext)),
              abort.signal,
            );
          } catch (cause) {
            await this.onModelEvent?.("model.request_blocked", {
              phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls + 1,
              reason: "token_preflight_unavailable", estimatedInputTokens: promptTokens, inputTokenSource: promptTokenSource,
            });
            assertRunning(abort, budget);
            throw failure("TOKEN_COUNT_UNAVAILABLE", `Provider token preflight failed: ${errorMessage(cause)}`);
          }
          if (!counted.ok) {
            await this.onModelEvent?.("model.request_blocked", {
              phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls + 1,
              reason: "token_preflight_unavailable", estimatedInputTokens: promptTokens, inputTokenSource: "provider_preflight_unavailable",
              providerErrorCode: counted.error.code,
            });
            assertRunning(abort, budget);
            throw failure("TOKEN_COUNT_UNAVAILABLE", "Provider token preflight failed; generation was not attempted.", {
              providerError: counted.error.code,
            });
          }
          if (!Number.isSafeInteger(counted.data.inputTokens) || counted.data.inputTokens < 0 ||
            (counted.data.maxContextTokens !== undefined && (!Number.isSafeInteger(counted.data.maxContextTokens) || counted.data.maxContextTokens < 2))) {
            throw failure("TOKEN_COUNT_INVALID", "Provider token preflight returned invalid counts.");
          }
          promptTokens = counted.data.inputTokens;
          promptTokenSource = "provider_tokenizer_preflight";
          if (counted.data.maxContextTokens !== undefined) {
            providerContextLimit = providerContextLimit === undefined
              ? counted.data.maxContextTokens
              : Math.min(providerContextLimit, counted.data.maxContextTokens);
          }
        }
        if (providerContextLimit !== undefined && promptTokens >= providerContextLimit) {
          await this.onModelEvent?.("model.request_blocked", {
            phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls + 1,
            reason: "provider_context_window", estimatedInputTokens: promptTokens, inputTokenSource: promptTokenSource,
            configuredContextLimit: providerContextLimit,
          });
          throw failure("CONTEXT_WINDOW_EXCEEDED", "The estimated prompt exceeds the configured provider context window.", {
            estimatedPromptTokens: promptTokens,
            maxContextTokens: providerContextLimit,
          });
        }
        const remainingTokens = budget.maxTokens - usage.totalTokens;
        if (promptTokens >= remainingTokens) {
          await this.onModelEvent?.("model.request_blocked", {
            phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls + 1,
            reason: "task_token_budget", estimatedInputTokens: promptTokens, inputTokenSource: promptTokenSource,
            taskTokensUsedBefore: usage.totalTokens, remainingTaskBudgetTokens: remainingTokens, taskTokenBudget: reportedTokenBudget,
            configuredContextLimit: providerContextLimit,
          });
          throw failure("TOKEN_BUDGET_EXCEEDED", "The remaining token budget is too small for the next model request.", {
            estimatedPromptTokens: promptTokens,
            usedTokens: usage.totalTokens,
            maxTokens: budget.maxTokens,
          });
        }

        const contextOutputTokens = providerContextLimit === undefined
          ? MAX_OUTPUT_TOKENS
          : providerContextLimit - promptTokens;
        const budgetOutputTokens = remainingTokens - promptTokens;
        if (budgetOutputTokens < this.minOutputTokens) {
          await this.onModelEvent?.("model.request_blocked", {
            phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls + 1,
            reason: "minimum_output_reservation_task_budget", estimatedInputTokens: promptTokens, inputTokenSource: promptTokenSource,
            minimumOutputTokens: this.minOutputTokens, availableOutputTokens: budgetOutputTokens,
            taskTokensUsedBefore: usage.totalTokens, remainingTaskBudgetTokens: this.disableCumulativeTokenLimit ? null : remainingTokens,
            taskTokenBudget: reportedTokenBudget,
          });
          throw failure("TOKEN_BUDGET_EXCEEDED", "The remaining task token budget cannot preserve the configured minimum completion length.", {
            estimatedPromptTokens: promptTokens,
            minimumOutputTokens: this.minOutputTokens,
            availableOutputTokens: budgetOutputTokens,
          });
        }
        if (contextOutputTokens < this.minOutputTokens) {
          await this.onModelEvent?.("model.request_blocked", {
            phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls + 1,
            reason: "minimum_output_reservation_context_window", estimatedInputTokens: promptTokens, inputTokenSource: promptTokenSource,
            minimumOutputTokens: this.minOutputTokens, availableOutputTokens: contextOutputTokens,
            configuredContextLimit: providerContextLimit,
          });
          throw failure("CONTEXT_WINDOW_EXCEEDED", "The provider context remainder cannot preserve the configured minimum completion length.", {
            estimatedPromptTokens: promptTokens,
            maxContextTokens: providerContextLimit,
            minimumOutputTokens: this.minOutputTokens,
            availableOutputTokens: contextOutputTokens,
          });
        }
        const maxOutputTokens = Math.min(outputTokenCeiling, budgetOutputTokens, contextOutputTokens);
        lastRequestedOutputTokens = maxOutputTokens;
        const request = { messages: [...messages], maxOutputTokens };
        modelCalls += 1;
        const toolMessages = messages.filter(message => message.role === "tool");
        const toolMessageText = toolMessages.map(message => message.content).join("\n");
        await this.onModelEvent?.("model.request", {
          phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls,
          inputTokensPreflight: promptTokens, inputTokenSource: promptTokenSource,
          configuredContextLimit: providerContextLimit, taskTokenBudget: reportedTokenBudget,
          taskTokensUsedBefore: usage.totalTokens, remainingTaskBudgetTokens: this.disableCumulativeTokenLimit ? null : remainingTokens,
          maxOutputTokensRequested: maxOutputTokens, completionTokensReserved: maxOutputTokens,
          minimumOutputTokens: this.minOutputTokens, outputRecoveryAttempt: outputRecoveryAttempts,
          toolMessageCount: toolMessages.length, toolMessageCharacters: toolMessageText.length,
          toolMessageTokensEstimated: estimateTokens(toolMessageText),
        });
        let generated: ResultEnvelope<ModelResponse>;
        try {
          generated = await awaitAbortable(
            Promise.resolve(this.model.generate(request, signalContext)),
            abort.signal,
          );
        } catch (cause) {
          addEstimatedInput(usage, promptTokens);
          await this.onModelEvent?.("model.response", {
            phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls,
            status: "error", inputTokenSource: promptTokenSource, actualProviderUsage: null,
            usageSource: "estimate_only_provider_response_unavailable",
            estimatedUsage: { inputTokens: promptTokens, outputTokens: 0, totalTokens: promptTokens },
            chargedUsage: { inputTokens: promptTokens, outputTokens: 0, totalTokens: promptTokens },
            cumulativeTaskTokensAfter: usage.totalTokens,
          });
          assertRunning(abort, budget);
          throw failure("MODEL_EXECUTION_FAILED", `Model adapter failed: ${errorMessage(cause)}`);
        }

        const modelResponse = generated.ok && isModelResponse(generated.data)
          ? generated.data
          : undefined;
        const reportedUsage: unknown = modelResponse && modelResponse.usage !== undefined
          ? modelResponse.usage
          : generated.usage;
        addEvidence(evidence, knownEvidence, generated.evidence);
        addEvidence(evidence, knownEvidence, modelResponse?.evidence);
        validateReportedUsage(reportedUsage);
        const responseUsage = reportedUsage as Usage | undefined;
        const callUsage = accountCallUsage(usage, responseUsage, promptTokens, modelResponse);
        const actualRequestTokens = callUsage.chargedUsage.inputTokens + callUsage.chargedUsage.outputTokens;
        const contextExceeded = providerContextLimit !== undefined && actualRequestTokens > providerContextLimit;
        const budgetExceeded = usage.totalTokens > budget.maxTokens;
        await this.onModelEvent?.("model.response", {
          phase: this.modelPhase, taskId: task.taskId, agentId: context.agentId, requestIndex: modelCalls,
          status: !generated.ok ? "error" : contextExceeded ? "context_window_exceeded_by_reported_usage" : budgetExceeded ? "task_budget_exceeded_by_reported_usage" : "ok",
          finishReason: modelResponse?.finishReason ?? "other", responseCharacters: modelResponse?.text.length ?? 0,
          toolCallCount: modelResponse?.toolCalls?.length ?? 0,
          inputTokenSource: promptTokenSource, actualProviderUsage: callUsage.providerUsage,
          timing: modelResponse?.timing ?? null, providerModel: modelResponse?.providerModel ?? null,
          usageSource: callUsage.usageSource, estimatedUsage: callUsage.estimatedUsage,
          chargedUsage: callUsage.chargedUsage, actualRequestTokens,
          configuredContextLimit: providerContextLimit, taskTokenBudget: reportedTokenBudget,
          cumulativeTaskTokensAfter: usage.totalTokens,
          ...(!generated.ok ? { errorCode: generated.error.code } : {}),
        });
        assertRunning(abort, budget);
        if (contextExceeded) {
          throw failure("CONTEXT_WINDOW_EXCEEDED", "Reported provider usage exceeded the configured per-request context limit.", {
            actualRequestTokens, maxContextTokens: providerContextLimit,
          });
        }
        if (usage.totalTokens > budget.maxTokens) {
          throw failure("TOKEN_BUDGET_EXCEEDED", "The model adapter reported usage above the task token budget.", {
            usedTokens: usage.totalTokens,
            maxTokens: budget.maxTokens,
          });
        }
        if (!generated.ok) {
          if (generated.error.code === "MODEL_STREAM_TRUNCATED" && queueOutputRecovery(responseUsage)) continue;
          throw new LoopFailure(generated.error);
        }

        if (!modelResponse) {
          throw failure("INVALID_MODEL_RESPONSE", "Model adapter returned a malformed response.");
        }
        const response = modelResponse;
        if (response.finishReason === "length") {
          if (queueOutputRecovery(responseUsage)) continue;
          throw failure("MODEL_OUTPUT_TRUNCATED", "The model reached its output limit before completing the response.", {
            requestIndex: modelCalls,
          });
        }
        const calls = response.toolCalls ?? [];
        if (response.finishReason === "tool_call" && calls.length === 0) {
          throw failure("INVALID_MODEL_RESPONSE", "Model marked the response as a tool call but supplied no calls.");
        }

        if (calls.length === 0) {
          const aggregateUsage = finishUsage(usage);
          const finalResponse: ModelResponse = {
            ...response,
            finishReason: response.finishReason ?? "stop",
            usage: aggregateUsage,
            evidence,
          };
          return { ok: true, data: finalResponse, evidence, usage: aggregateUsage };
        }

        if (calls.length > budget.maxToolCalls - usage.toolCalls) {
          throw failure("TOOL_BUDGET_EXCEEDED", "The model requested more tool calls than the task budget allows.", {
            requestedToolCalls: calls.length,
            usedToolCalls: usage.toolCalls,
            maxToolCalls: budget.maxToolCalls,
          });
        }
        validateToolCalls(calls, usedCallIds);

        messages.push({
          role: "assistant",
          content: response.text,
          toolCalls: calls,
        });

        for (const call of calls) { usedCallIds.add(call.id); usage.toolCalls += 1; }
        const scheduled = await executeDeepSeekHarnessToolCalls<ModelToolCall, ResultEnvelope<unknown>>({
          calls,
          signal: abort.signal,
          maxParallelToolCalls: this.maxParallelToolCalls,
          executionMode: call => this.tools.isReadOnly?.(call.name) === true ? "parallel" : "exclusive",
          execute: call => executeCall(this.tools, call, signalContext, allowedTools, abort.signal),
          skippedResult: (): ResultEnvelope<unknown> => ({ ok: false, error: {
            code: "TOOL_ABORTED_BEFORE_DISPATCH",
            message: "Tool call was aborted before it could start.",
          }, evidence: [] }),
        });
        let terminalTool: { index: number; text: string } | undefined;
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index]!;
          const toolResult = scheduled.results[index]!;
          addEvidence(evidence, knownEvidence, toolResult.evidence);
          if (!toolResult.ok) addEvidence(evidence, knownEvidence, [toolErrorEvidence(task.taskId, call, toolResult.error)]);
          const providerResult = this.projectToolResultForModel?.(call.name, toolResult) ?? toolResult;
          messages.push({ role: "tool", toolCallId: call.id, content: serializeToolResult(providerResult) });
          if (toolResult.ok && this.terminalToolResult) {
            const terminalText = this.terminalToolResult(call, toolResult);
            if (typeof terminalText === "string" && terminalText.trim().length > 0) {
              if (terminalTool !== undefined) {
                throw failure("MULTIPLE_TERMINAL_TOOL_RESULTS", "A model response produced multiple terminal tool acknowledgements.");
              }
              terminalTool = { index, text: terminalText };
            }
          }
        }
        assertRunning(abort, budget);
        if (terminalTool !== undefined) {
          if (terminalTool.index !== calls.length - 1) {
            throw failure("TERMINAL_TOOL_NOT_LAST", "A terminal tool acknowledgement was followed by additional requested tool calls.", {
              terminalToolIndex: terminalTool.index,
              toolCallCount: calls.length,
            });
          }
          const aggregateUsage = finishUsage(usage);
          const finalResponse: ModelResponse = {
            text: terminalTool.text,
            finishReason: "stop",
            usage: aggregateUsage,
            evidence,
          };
          return { ok: true, data: finalResponse, evidence, usage: aggregateUsage };
        }
      }
    } catch (cause) {
      const structured = abort.error() ?? structuredFrom(cause, "AGENT_LOOP_FAILED");
      const finalUsage = finishUsage(usage);
      return { ok: false, error: structured, evidence, usage: finalUsage };
    } finally {
      abort.dispose();
    }
  }
}

async function executeCall(
  tools: ToolRuntime,
  call: ModelToolCall,
  context: ExecutionContext,
  allowedTools: readonly string[],
  signal: AbortSignal,
): Promise<ResultEnvelope<unknown>> {
  if (!allowedTools.includes(call.name)) {
    return {
      ok: false,
      error: {
        code: "TOOL_NOT_ALLOWED",
        message: `Tool '${call.name}' is not allowed for task '${context.taskId}'.`,
      },
      evidence: [],
    };
  }
  try {
    const toolContext = { ...context, toolCallId: call.id };
    return await Promise.resolve(tools.execute(call.name, call.input, toolContext));
  } catch (cause) {
    const aborted = signal.aborted;
    return {
      ok: false,
      error: {
        code: aborted ? "CANCELLED" : "TOOL_EXECUTION_FAILED",
        message: aborted ? "Tool execution was cancelled." : `Tool '${call.name}' failed: ${errorMessage(cause)}`,
        retryable: false,
      },
      evidence: [],
    };
  }
}

function assertContextMatchesTask(task: SubtaskSpec, context: ExecutionContext): void {
  if (
    task.sessionId !== context.sessionId ||
    task.taskId !== context.taskId ||
    task.runId !== context.runId ||
    task.attempt !== context.attempt
  ) {
    throw failure("CONTEXT_MISMATCH", "Execution context does not match the task identity.");
  }
}

function resolveBudget(
  taskBudget: ExecutionBudget,
  contextBudget: ExecutionBudget,
  startedAt: number,
  disableCumulativeTokenLimit: boolean,
  maxModelCalls: number,
  additionalModelCalls = 0,
): EffectiveBudget {
  const taskMaxTokens = optionalLimit(taskBudget.maxTokens, DEFAULT_MAX_TOTAL_TOKENS);
  const contextMaxTokens = optionalLimit(contextBudget.maxTokens, DEFAULT_MAX_TOTAL_TOKENS);
  const maxTokens = disableCumulativeTokenLimit
    ? Number.POSITIVE_INFINITY
    : Math.min(taskMaxTokens, contextMaxTokens);
  const maxToolCalls = Math.min(
    optionalLimit(taskBudget.maxToolCalls, DEFAULT_MAX_TOOL_CALLS),
    optionalLimit(contextBudget.maxToolCalls, DEFAULT_MAX_TOOL_CALLS),
  );
  const maxDurationMs = Math.min(
    optionalLimit(taskBudget.maxDurationMs, DEFAULT_MAX_DURATION_MS),
    optionalLimit(contextBudget.maxDurationMs, DEFAULT_MAX_DURATION_MS),
  );
  const durationDeadline = startedAt + maxDurationMs;
  if (!Number.isFinite(durationDeadline) || !Number.isFinite(new Date(durationDeadline).getTime())) {
    throw failure("INVALID_BUDGET", "The effective task duration is outside the supported timestamp range.");
  }

  const taskDeadline = parseDeadline(taskBudget.deadlineAt);
  const contextDeadline = parseDeadline(contextBudget.deadlineAt);
  const deadlines = [durationDeadline, taskDeadline, contextDeadline]
    .filter((value): value is number => value !== undefined);

  return {
    maxTokens,
    maxToolCalls,
    maxModelCalls: Math.min(maxModelCalls, maxToolCalls + 1 + additionalModelCalls),
    deadlineAtMs: Math.min(...deadlines),
  };
}

function mergeBudget(task: ExecutionBudget, context: ExecutionBudget): ExecutionBudget {
  const merged: ExecutionBudget = {};
  merged.maxTokens = minDefined(task.maxTokens, context.maxTokens);
  merged.maxToolCalls = minDefined(task.maxToolCalls, context.maxToolCalls);
  merged.maxDurationMs = minDefined(task.maxDurationMs, context.maxDurationMs);
  merged.maxActiveChildren = minDefined(task.maxActiveChildren, context.maxActiveChildren);
  merged.maxDelegationDepth = minDefined(task.maxDelegationDepth, context.maxDelegationDepth);
  const taskDeadline = parseDeadline(task.deadlineAt);
  const contextDeadline = parseDeadline(context.deadlineAt);
  const deadline = minDefined(taskDeadline, contextDeadline);
  if (deadline !== undefined) merged.deadlineAt = new Date(deadline).toISOString();
  return merged;
}

function optionalLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw failure("INVALID_BUDGET", "Budget values must be finite non-negative numbers.", { value });
  }
  return Math.floor(value);
}

function parseDeadline(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw failure("INVALID_BUDGET", "deadlineAt must be a valid timestamp.", { value });
  }
  return parsed;
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  return [...new Set(a.filter((name) => bSet.has(name)))];
}

function makeAbortScope(
  externalSignal: AbortSignal | undefined,
  deadlineAtMs: number,
): {
  signal: AbortSignal;
  error: () => StructuredError | undefined;
  dispose: () => void;
} {
  const controller = new AbortController();
  let abortError: StructuredError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let externalListener: (() => void) | undefined;

  const abort = (error: StructuredError): void => {
    if (controller.signal.aborted) return;
    abortError = error;
    controller.abort(error);
  };
  const armDeadline = (): void => {
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) {
      abort({ code: "DEADLINE_EXCEEDED", message: "Task deadline exceeded." });
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (Date.now() >= deadlineAtMs) {
        abort({ code: "DEADLINE_EXCEEDED", message: "Task deadline exceeded." });
      } else {
        armDeadline();
      }
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };

  if (externalSignal?.aborted) {
    abort({ code: "CANCELLED", message: "Task was cancelled." });
  } else if (externalSignal) {
    externalListener = () => abort({ code: "CANCELLED", message: "Task was cancelled." });
    externalSignal.addEventListener("abort", externalListener, { once: true });
  }
  if (!controller.signal.aborted) armDeadline();

  return {
    signal: controller.signal,
    error: () => abortError,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      if (externalListener && externalSignal) {
        externalSignal.removeEventListener("abort", externalListener);
      }
    },
  };
}

function assertRunning(
  abort: { signal: AbortSignal; error: () => StructuredError | undefined },
  budget: EffectiveBudget,
): void {
  if (abort.signal.aborted) {
    throw new LoopFailure(abort.error() ?? { code: "CANCELLED", message: "Task was cancelled." });
  }
  if (Date.now() >= budget.deadlineAtMs) {
    throw failure("DEADLINE_EXCEEDED", "Task deadline exceeded.");
  }
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new LoopFailure({ code: "CANCELLED", message: "Task was cancelled." }));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason = signal.reason;
      reject(reason instanceof LoopFailure
        ? reason
        : new LoopFailure({ code: "CANCELLED", message: "Task was cancelled." }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function validateToolCalls(calls: readonly ModelToolCall[], used: ReadonlySet<string>): void {
  const current = new Set<string>();
  for (const call of calls) {
    if (
      typeof call.id !== "string" || call.id.length === 0 ||
      typeof call.name !== "string" || call.name.length === 0
    ) {
      throw failure("INVALID_MODEL_RESPONSE", "Every tool call needs a non-empty id and name.");
    }
    if (used.has(call.id) || current.has(call.id)) {
      throw failure("INVALID_MODEL_RESPONSE", `Model reused tool call id '${call.id}'.`);
    }
    current.add(call.id);
  }
}

function hasCompleteTokenUsage(value: unknown): value is Usage {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Partial<Usage>;
  return Number.isSafeInteger(usage.inputTokens) &&
    Number.isSafeInteger(usage.outputTokens) &&
    Number.isSafeInteger(usage.totalTokens) &&
    usage.inputTokens! + usage.outputTokens! === usage.totalTokens &&
    Number.isSafeInteger(usage.inputTokens! + usage.outputTokens!);
}

function accountCallUsage(
  usage: MutableUsage,
  reported: Usage | undefined,
  estimatedInput: number,
  response: ModelResponse | undefined,
): {
  providerUsage: Readonly<Record<string, number>> | null;
  usageSource: "provider_actual" | "provider_partial_plus_estimate" | "estimated_no_provider_usage";
  estimatedUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  chargedUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
} {
  const estimatedOutput = response
    ? estimateTokens(`${response.text}\n${safeStringify(response.toolCalls ?? [])}`)
    : 0;
  const estimatedUsage = { inputTokens: estimatedInput, outputTokens: estimatedOutput, totalTokens: estimatedInput + estimatedOutput };
  const inputTokens = reported?.inputTokens ?? estimatedInput;
  const outputText = response
    ? `${response.text}\n${safeStringify(response.toolCalls ?? [])}`
    : "";
  const outputTokens = reported?.outputTokens ?? estimateTokens(outputText);
  const totalTokens = reported?.totalTokens ?? inputTokens + outputTokens;
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.totalTokens += totalTokens;
  const providerUsage = reported ? Object.fromEntries(Object.entries(reported).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0)) : null;
  const providerFieldCount = [reported?.inputTokens, reported?.outputTokens, reported?.totalTokens].filter(value => value !== undefined).length;
  return {
    providerUsage,
    usageSource: providerFieldCount === 3 ? "provider_actual" : providerFieldCount > 0 ? "provider_partial_plus_estimate" : "estimated_no_provider_usage",
    estimatedUsage,
    chargedUsage: { inputTokens, outputTokens, totalTokens },
  };
}

function validateReportedUsage(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null) {
    throw failure("INVALID_MODEL_USAGE", "Model usage must be an object of non-negative finite numbers.");
  }
  const fields: readonly (keyof Usage)[] = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "toolCalls",
    "elapsedMs",
  ];
  for (const field of fields) {
    const amount = (value as Record<string, unknown>)[field];
    if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
      throw failure("INVALID_MODEL_USAGE", `Model usage field '${field}' must be a non-negative finite number.`, {
        field,
        value: amount,
      });
    }
  }
  const reported = value as Record<string, unknown>;
  for (const field of ["cacheHitInputTokens", "cacheMissInputTokens", "reasoningOutputTokens"] as const) {
    const amount = reported[field];
    if (amount !== undefined && (!Number.isSafeInteger(amount) || (amount as number) < 0)) {
      throw failure("INVALID_MODEL_USAGE", `Model usage field '${field}' must be a non-negative safe integer.`);
    }
  }
  const hit = reported.cacheHitInputTokens as number | undefined;
  const miss = reported.cacheMissInputTokens as number | undefined;
  const input = reported.inputTokens as number | undefined;
  const reasoning = reported.reasoningOutputTokens as number | undefined;
  const output = reported.outputTokens as number | undefined;
  if (input !== undefined && ((hit !== undefined && hit > input) || (miss !== undefined && miss > input))
      || hit !== undefined && miss !== undefined && (!Number.isSafeInteger(hit + miss) || input !== undefined && hit + miss !== input)
      || output !== undefined && reasoning !== undefined && reasoning > output) {
    throw failure("INVALID_MODEL_USAGE", "Model cache/reasoning token counters are inconsistent with input/output totals.");
  }
}

function addEstimatedInput(usage: MutableUsage, estimatedInput: number): void {
  usage.inputTokens += estimatedInput;
  usage.totalTokens += estimatedInput;
}

function estimateTokens(text: string): number {
  // Fallback estimate only; it is not intended to match any provider tokenizer.
  let units = 0;
  let asciiRun = 0;
  const flushAscii = (): void => {
    units += Math.ceil(asciiRun / 4);
    asciiRun = 0;
  };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      if (/\s/.test(char)) {
        flushAscii();
      } else {
        asciiRun += 1;
      }
    } else {
      flushAscii();
      units += 1;
    }
  }
  flushAscii();
  return units;
}

function finishUsage(usage: MutableUsage): Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    toolCalls: usage.toolCalls,
    elapsedMs: Math.max(0, Date.now() - usage.startedAt),
  };
}

function addEvidence(
  target: Evidence[],
  known: Set<string>,
  incoming: readonly Evidence[] | undefined,
): void {
  for (const item of incoming ?? []) {
    const key = item.id || `${item.kind}:${item.ref ?? ""}:${item.summary ?? ""}`;
    if (known.has(key)) continue;
    known.add(key);
    target.push(item);
  }
}

function toolErrorEvidence(taskId: string, call: ModelToolCall, error: StructuredError): Evidence {
  return {
    id: `${taskId}:tool:${call.id}:error`,
    kind: "tool_output",
    summary: `${call.name} returned ${error.code}: ${error.message}`,
    metadata: { tool: call.name, callId: call.id, errorCode: error.code },
  };
}

function serializeToolResult(result: unknown): string {
  return safeStringify(result);
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function isModelResponse(value: unknown): value is ModelResponse {
  return typeof value === "object" && value !== null && "text" in value &&
    typeof (value as { text?: unknown }).text === "string";
}

function failedResult(
  error: StructuredError,
  evidence: readonly Evidence[],
  usage: MutableUsage,
): ResultEnvelope<ModelResponse> {
  return { ok: false, error, evidence, usage: finishUsage(usage) };
}

function structuredFrom(cause: unknown, fallbackCode: string): StructuredError {
  if (cause instanceof LoopFailure) return cause.structured;
  if (cause instanceof Error && "structured" in cause) {
    const structured = (cause as Error & { structured?: unknown }).structured;
    if (isStructuredError(structured)) return structured;
  }
  return {
    code: fallbackCode,
    message: errorMessage(cause),
    retryable: false,
  };
}

function isStructuredError(value: unknown): value is StructuredError {
  return typeof value === "object" && value !== null &&
    "code" in value && typeof (value as { code?: unknown }).code === "string" &&
    "message" in value && typeof (value as { message?: unknown }).message === "string";
}

function failure(code: string, message: string, details?: unknown): LoopFailure {
  return new LoopFailure({ code, message, retryable: false, details });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
