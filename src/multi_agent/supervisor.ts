import type {
  EventRecord,
  ExecutionBudget,
  ExecutionContext,
  ResultEnvelope,
  StructuredError,
  SubtaskSpec,
  TaskRecord,
  TaskStatus,
  TaskStore,
} from "../contracts.js";

export type SupervisorWorker = (
  task: SubtaskSpec,
  context: ExecutionContext,
) => Promise<ResultEnvelope<unknown>>;

export interface SupervisorOptions {
  store: TaskStore;
  worker: SupervisorWorker;
  maxConcurrency: number;
  isReadOnlyTool?: (name: string) => boolean;
  onEvent?: (event: EventRecord) => void | Promise<void>;
}

export interface SupervisorResult {
  status: TaskStatus;
  tasks: readonly TaskRecord[];
  results: Readonly<Record<string, ResultEnvelope<unknown>>>;
}

export class SupervisorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorInputError";
  }
}

interface RuntimeTask {
  spec: SubtaskSpec;
  record: TaskRecord;
  readOnly: boolean;
  maxAttempt: number;
}

type AbortKind = "cancelled" | "timed_out";
type WorkerOutcome =
  | { kind: "result"; result: ResultEnvelope<unknown> }
  | { kind: "cancelled" }
  | { kind: "timed_out" };

interface UsageTotals {
  tokens?: number;
  toolCalls?: number;
}

const MAX_RETRIES = 1;

/**
 * Runs a persisted, bounded DAG of subtasks through an explicit worker callback.
 * The worker receives a newly-built context containing only the task's declared
 * references and tools. This is logical capability scoping, not an OS sandbox.
 */
export class Supervisor {
  private readonly store: TaskStore;
  private readonly worker: SupervisorWorker;
  private readonly configuredConcurrency: number;
  private readonly isReadOnlyTool: (name: string) => boolean;
  private readonly onEvent?: (event: EventRecord) => void | Promise<void>;
  private eventSequence = 0;
  private readonly eventRunId = globalThis.crypto.randomUUID();

  constructor(options: SupervisorOptions) {
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new SupervisorInputError("maxConcurrency must be a positive integer");
    }
    this.store = options.store;
    this.worker = options.worker;
    this.configuredConcurrency = options.maxConcurrency;
    this.isReadOnlyTool = options.isReadOnlyTool ?? (() => false);
    this.onEvent = options.onEvent;
  }

  async run(
    tasks: readonly SubtaskSpec[],
    parentContext: ExecutionContext,
  ): Promise<SupervisorResult> {
    this.validateParentContext(parentContext);
    const specs = this.normalizeAndValidateTasks(tasks, parentContext);
    const parentDeadline = this.getParentDeadline(parentContext.budget);
    const effectiveConcurrency = this.getConcurrencyLimit(specs.length, parentContext.budget);

    if (specs.length === 0) {
      return { status: "succeeded", tasks: [], results: Object.freeze({}) };
    }

    const specById = new Map(specs.map((task) => [task.taskId, task]));
    const existingById = new Map<string, TaskRecord | undefined>();
    for (const spec of specs) {
      existingById.set(spec.taskId, await this.store.get(spec.taskId));
    }
    const externalDependencies = await this.loadExternalDependencies(
      specs,
      specById,
      parentContext,
    );
    this.validateGraph(specs, specById);
    this.validateAggregateBudgets(specs, parentContext.budget);
    for (const spec of specs) {
      const existing = existingById.get(spec.taskId);
      if (existing !== undefined) this.validateStoredTask(existing, spec);
    }

    const readOnlyById = new Map<string, boolean>();
    for (const spec of specs) {
      try {
        readOnlyById.set(spec.taskId, this.toolsAreReadOnly(spec.allowedTools));
      } catch (error) {
        throw new SupervisorInputError("read-only tool classification failed: " + errorMessage(error));
      }
    }

    const runtimeById = new Map<string, RuntimeTask>();
    for (const spec of specs) {
      const existing = existingById.get(spec.taskId);
      const runtime = await this.initializeTask(spec, existing, readOnlyById.get(spec.taskId)!);
      runtimeById.set(spec.taskId, runtime);
    }

    const runAbort = new AbortController();
    let abortKind: AbortKind | undefined;
    const abortRun = (kind: AbortKind): void => {
      if (abortKind !== undefined) return;
      abortKind = kind;
      runAbort.abort(kind);
    };

    const parentSignal = parentContext.signal;
    const onParentAbort = (): void => abortRun("cancelled");
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    let runTimer: ReturnType<typeof setTimeout> | undefined;
    if (parentDeadline !== undefined) {
      const remaining = Math.max(0, parentDeadline - Date.now());
      runTimer = setTimeout(() => abortRun("timed_out"), remaining);
      if (remaining === 0) abortRun("timed_out");
    }

    const active = new Map<string, Promise<string>>();
    const recordOrder = specs.map((spec) => spec.taskId);

    try {
      await this.emit(parentContext.sessionId, "supervisor.started", undefined, {
        taskIds: [...recordOrder],
        maxConcurrency: effectiveConcurrency,
      });

      while (true) {
        await this.resolveDependencyFailures(runtimeById, externalDependencies);

        if (abortKind !== undefined) {
          const terminalStatus = abortKind;
          for (const taskId of recordOrder) {
            const runtime = runtimeById.get(taskId)!;
            if (runtime.record.status === "queued" || runtime.record.status === "waiting") {
              await this.finishWithoutWorker(
                runtime,
                terminalStatus,
                abortKind === "cancelled" ? "PARENT_CANCELLED" : "PARENT_TIMEOUT",
                abortKind === "cancelled"
                  ? "The parent execution was cancelled before this task started."
                  : "The parent execution deadline expired before this task started.",
              );
            }
          }
        }

        const ready = recordOrder
          .map((taskId) => runtimeById.get(taskId)!)
          .filter((runtime) => this.isRunnable(runtime.record.status))
          .filter((runtime) =>
            runtime.spec.dependencies.every((dependencyId) => {
              const inBatch = runtimeById.get(dependencyId);
              if (inBatch) return inBatch.record.status === "succeeded";
              return externalDependencies.get(dependencyId)?.status === "succeeded";
            }),
          );

        if (abortKind === undefined) {
          for (const runtime of ready) {
            if (active.size >= effectiveConcurrency) break;
            if (!this.canStart(runtime, active, runtimeById)) continue;
            const promise = this.executeTask(runtime, parentContext, runAbort.signal, parentDeadline, () => abortKind)
              .then(() => runtime.spec.taskId);
            active.set(runtime.spec.taskId, promise);
          }
        }

        const hasUnfinished = recordOrder.some((taskId) =>
          this.isRunnable(runtimeById.get(taskId)!.record.status),
        );

        if (active.size === 0) {
          if (!hasUnfinished) break;

          // All submitted tasks were validated as a DAG. This guard catches a
          // corrupt persisted state or a store implementation that changed it.
          let progressed = false;
          for (const taskId of recordOrder) {
            const runtime = runtimeById.get(taskId)!;
            if (this.isRunnable(runtime.record.status) &&
                runtime.spec.dependencies.some((dependencyId) => {
                  const dependencyStatus = runtimeById.get(dependencyId)?.record.status ??
                    externalDependencies.get(dependencyId)?.status;
                  return dependencyStatus !== undefined && dependencyStatus !== "succeeded" &&
                    !this.isRunnable(dependencyStatus);
                })) {
              await this.finishWithoutWorker(
                runtime,
                "cancelled",
                "DEPENDENCY_FAILED",
                "A dependency did not succeed, so this task was not run.",
              );
              progressed = true;
            }
          }
          if (!progressed && abortKind === undefined) {
            throw new Error("Supervisor reached a non-runnable DAG state");
          }
          if (!progressed && abortKind !== undefined) continue;
          continue;
        }

        const settledTaskId = await Promise.race(active.values());
        active.delete(settledTaskId);
      }
    } finally {
      if (runTimer !== undefined) clearTimeout(runTimer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      if (!runAbort.signal.aborted) runAbort.abort("supervisor-finished");
    }

    const orderedTasks = recordOrder.map((taskId) => cloneTaskRecord(runtimeById.get(taskId)!.record));
    const resultEntries: Array<[string, ResultEnvelope<unknown>]> = [];
    for (const record of orderedTasks) {
      if (record.result !== undefined) resultEntries.push([record.taskId, record.result]);
    }
    const resultObject = Object.create(null) as Record<string, ResultEnvelope<unknown>>;
    for (const [taskId, result] of resultEntries) resultObject[taskId] = result;

    const status = this.aggregateStatus(orderedTasks);
    await this.emit(parentContext.sessionId, "supervisor.finished", undefined, {
      status,
      taskIds: [...recordOrder],
    });

    return {
      status,
      tasks: orderedTasks,
      results: Object.freeze(resultObject),
    };
  }

  private validateParentContext(context: ExecutionContext): void {
    if (!context || !nonEmpty(context.sessionId) || !nonEmpty(context.taskId) ||
        !nonEmpty(context.runId) || !nonEmpty(context.agentId)) {
      throw new SupervisorInputError("parentContext must include session, agent, task, and run identifiers");
    }
    validateBudget(context.budget, "parent budget");
    if (!Array.isArray(context.allowedTools) || !Array.isArray(context.contextRefs)) {
      throw new SupervisorInputError("parentContext tool and context reference lists must be arrays");
    }
  }

  private normalizeAndValidateTasks(
    tasks: readonly SubtaskSpec[],
    parentContext: ExecutionContext,
  ): SubtaskSpec[] {
    if (!Array.isArray(tasks)) throw new SupervisorInputError("tasks must be an array");
    const ids = new Set<string>();
    const normalized: SubtaskSpec[] = [];

    for (const input of tasks) {
      if (!input || typeof input !== "object") {
        throw new SupervisorInputError("every subtask must be an object");
      }
      if (!nonEmpty(input.taskId) || !nonEmpty(input.runId) || !nonEmpty(input.title) ||
          !nonEmpty(input.instructions)) {
        throw new SupervisorInputError("each subtask requires taskId, runId, title, and instructions");
      }
      if (ids.has(input.taskId)) {
        throw new SupervisorInputError("duplicate taskId: " + input.taskId);
      }
      ids.add(input.taskId);
      if (input.sessionId !== parentContext.sessionId) {
        throw new SupervisorInputError("subtask sessionId must match the parent session");
      }
      if (input.parentTaskId !== undefined && input.parentTaskId !== parentContext.taskId) {
        throw new SupervisorInputError("subtask parentTaskId must match the parent task");
      }
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 ||
          !Number.isSafeInteger(input.attempt + MAX_RETRIES)) {
        throw new SupervisorInputError("subtask attempt must be a positive integer");
      }
      if (!Array.isArray(input.dependencies) || !Array.isArray(input.contextRefs) ||
          !Array.isArray(input.allowedTools)) {
        throw new SupervisorInputError("subtask dependencies, contextRefs, and allowedTools must be arrays");
      }
      if (input.dependencies.some((id: string) => !nonEmpty(id)) ||
          input.contextRefs.some((ref: string) => !nonEmpty(ref)) ||
          input.allowedTools.some((tool: string) => !nonEmpty(tool))) {
        throw new SupervisorInputError("subtask references, tools, and dependency IDs must be non-empty strings");
      }
      if (new Set(input.dependencies).size !== input.dependencies.length) {
        throw new SupervisorInputError("subtask dependencies must not contain duplicates");
      }
      validateBudget(input.budget, "budget for task " + input.taskId);
      normalized.push({
        ...input,
        parentTaskId: parentContext.taskId,
        dependencies: [...input.dependencies],
        contextRefs: [...input.contextRefs],
        allowedTools: [...input.allowedTools],
        budget: { ...input.budget },
      });
    }

    const parentDepth = parentContext.budget.maxDelegationDepth;
    if (normalized.length > 0 && parentDepth !== undefined && parentDepth < 1) {
      throw new SupervisorInputError("parent maxDelegationDepth does not allow another delegation level");
    }
    if (parentDepth !== undefined) {
      const childDepthLimit = parentDepth - 1;
      for (const task of normalized) {
        const requested = task.budget.maxDelegationDepth;
        if (requested !== undefined && requested > childDepthLimit) {
          throw new SupervisorInputError("child maxDelegationDepth exceeds the remaining parent depth");
        }
        task.budget = {
          ...task.budget,
          maxDelegationDepth: requested ?? childDepthLimit,
        };
      }
    }

    const parentActiveLimit = parentContext.budget.maxActiveChildren;
    if (parentActiveLimit !== undefined) {
      for (const task of normalized) {
        const requested = task.budget.maxActiveChildren;
        if (requested !== undefined && requested > parentActiveLimit) {
          throw new SupervisorInputError("child maxActiveChildren exceeds the parent limit");
        }
        task.budget = {
          ...task.budget,
          maxActiveChildren: requested ?? parentActiveLimit,
        };
      }
    }

    return normalized;
  }

  private async loadExternalDependencies(
    tasks: readonly SubtaskSpec[],
    specById: ReadonlyMap<string, SubtaskSpec>,
    parentContext: ExecutionContext,
  ): Promise<Map<string, TaskRecord>> {
    const ids = new Set<string>();
    for (const task of tasks) {
      for (const dependencyId of task.dependencies) {
        if (!specById.has(dependencyId)) ids.add(dependencyId);
      }
    }
    const dependencies = new Map<string, TaskRecord>();
    for (const dependencyId of ids) {
      const record = await this.store.get(dependencyId);
      if (!record || record.sessionId !== parentContext.sessionId ||
          record.parentTaskId !== parentContext.taskId || record.status !== "succeeded") {
        throw new SupervisorInputError(
          "dependency " + dependencyId + " must be submitted or already succeeded under this parent",
        );
      }
      dependencies.set(dependencyId, record);
    }
    return dependencies;
  }

  private validateGraph(
    tasks: readonly SubtaskSpec[],
    specById: ReadonlyMap<string, SubtaskSpec>,
  ): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string): void => {
      if (visiting.has(taskId)) throw new SupervisorInputError("task dependencies contain a cycle");
      if (visited.has(taskId)) return;
      visiting.add(taskId);
      const task = specById.get(taskId)!;
      for (const dependencyId of task.dependencies) {
        if (dependencyId === taskId) {
          throw new SupervisorInputError("a task cannot depend on itself");
        }
        if (specById.has(dependencyId)) visit(dependencyId);
      }
      visiting.delete(taskId);
      visited.add(taskId);
    };
    for (const task of tasks) visit(task.taskId);
  }

  private validateAggregateBudgets(
    tasks: readonly SubtaskSpec[],
    parentBudget: ExecutionBudget,
  ): void {
    for (const key of ["maxTokens", "maxToolCalls"] as const) {
      const parentLimit = parentBudget[key];
      if (parentLimit === undefined) continue;
      let total = 0;
      for (const task of tasks) {
        const childLimit = task.budget[key];
        if (childLimit === undefined || !Number.isFinite(childLimit)) {
          throw new SupervisorInputError(
            "task " + task.taskId + " requires a finite " + key + " bound because the parent is bounded",
          );
        }
        total += childLimit;
      }
      if (total > parentLimit) {
        throw new SupervisorInputError(
          "sum of child " + key + " reservations exceeds the parent budget",
        );
      }
    }
  }

  private getConcurrencyLimit(taskCount: number, budget: ExecutionBudget): number {
    if (taskCount === 0) return this.configuredConcurrency;
    if (budget.maxActiveChildren === 0) {
      throw new SupervisorInputError("parent maxActiveChildren is zero");
    }
    return Math.min(this.configuredConcurrency, budget.maxActiveChildren ?? this.configuredConcurrency);
  }

  private getParentDeadline(budget: ExecutionBudget): number | undefined {
    const runStartedAt = Date.now();
    let parentDeadline = parseDeadline(budget.deadlineAt, "parent budget");
    if (budget.maxDurationMs !== undefined) {
      parentDeadline = minimum(parentDeadline, runStartedAt + budget.maxDurationMs);
    }
    return parentDeadline;
  }

  private async initializeTask(
    spec: SubtaskSpec,
    existing: TaskRecord | undefined,
    readOnly: boolean,
  ): Promise<RuntimeTask> {
    const now = new Date().toISOString();
    const maxAttempt = spec.attempt + MAX_RETRIES;
    if (existing !== undefined) {
      this.validateStoredTask(existing, spec);
      let record = cloneTaskRecord(existing);

      if (record.status === "running" || record.status === "waiting") {
        if (readOnly && record.attempt < maxAttempt) {
          // Unknown usage is charged at the full reservation so a recovered
          // read-only attempt cannot multiply a finite token or call budget.
          const priorUsage = usageTotals(record.result);
          const chargedUsage = {
            // record.result may belong to the previous failed attempt. It cannot
            // account for the currently interrupted attempt's in-flight calls.
            totalTokens: spec.budget.maxTokens ?? priorUsage.tokens,
            toolCalls: spec.budget.maxToolCalls ?? priorUsage.toolCalls,
          };
          record.result = record.result === undefined
            ? {
                ok: false,
                error: {
                  code: "INTERRUPTED_READ_ONLY_REQUEUED",
                  message: "Recovered a read-only task after interruption.",
                },
                evidence: [],
                usage: chargedUsage,
              }
            : {
                ...record.result,
                usage: { ...record.result.usage, ...chargedUsage },
              };
          record.attempt += 1;
          record.status = "queued";
          record.updatedAt = now;
          record = cloneTaskRecord(await this.store.update(record));
          await this.emit(record.sessionId, "task.requeued", record.taskId, {
            reason: "interrupted_read_only_task",
            attempt: record.attempt,
          });
        } else {
          this.setFailure(
            record,
            "INTERRUPTED_REQUIRES_REVIEW",
            "An interrupted task with possible side effects was not re-executed.",
            now,
          );
          record = cloneTaskRecord(await this.store.update(record));
          await this.emit(record.sessionId, "task.failed", record.taskId, {
            code: "INTERRUPTED_REQUIRES_REVIEW",
          });
        }
      } else if (
        record.status === "failed" &&
        record.result?.ok === false &&
        record.result.error.retryable === true &&
        readOnly &&
        record.attempt < maxAttempt &&
        this.canAccountForRetry(record.result, spec.budget)
      ) {
        record.attempt += 1;
        record.status = "queued";
        record.updatedAt = now;
        record = cloneTaskRecord(await this.store.update(record));
        await this.emit(record.sessionId, "task.requeued", record.taskId, {
          reason: "retryable_read_only_failure",
          attempt: record.attempt,
        });
      }

      return { spec, record, readOnly, maxAttempt };
    }

    const record: TaskRecord = {
      ...spec,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.store.create(record);
    this.validateStoredTask(created, spec);
    await this.emit(spec.sessionId, "task.queued", spec.taskId, { attempt: spec.attempt });
    return { spec, record: cloneTaskRecord(created), readOnly, maxAttempt };
  }

  private validateStoredTask(record: TaskRecord, spec: SubtaskSpec): void {
    if (record.taskId !== spec.taskId || record.sessionId !== spec.sessionId ||
        record.parentTaskId !== spec.parentTaskId || record.runId !== spec.runId) {
      throw new SupervisorInputError("stored task linkage does not match task " + spec.taskId);
    }
    if (record.attempt < spec.attempt || record.attempt > spec.attempt + MAX_RETRIES) {
      throw new SupervisorInputError("stored attempt is outside the bounded attempt range for task " + spec.taskId);
    }
    if (record.title !== spec.title || record.instructions !== spec.instructions ||
        !sameArray(record.dependencies, spec.dependencies) ||
        !sameArray(record.contextRefs, spec.contextRefs) ||
        !sameArray(record.allowedTools, spec.allowedTools) ||
        !sameBudget(record.budget, spec.budget)) {
      throw new SupervisorInputError("stored task definition differs from submitted task " + spec.taskId);
    }
    if (record.status === "succeeded" && record.result === undefined) {
      throw new SupervisorInputError("stored succeeded task is missing its result");
    }
  }

  private toolsAreReadOnly(tools: readonly string[]): boolean {
    return tools.every((tool) => this.isReadOnlyTool(tool));
  }

  private canStart(
    candidate: RuntimeTask,
    active: ReadonlyMap<string, Promise<string>>,
    runtimeById: ReadonlyMap<string, RuntimeTask>,
  ): boolean {
    if (active.size === 0) return true;
    if (!candidate.readOnly) return false;
    for (const taskId of active.keys()) {
      if (!runtimeById.get(taskId)!.readOnly) return false;
    }
    return true;
  }

  private isRunnable(status: TaskStatus): boolean {
    return status === "queued" || status === "waiting";
  }

  private async resolveDependencyFailures(
    runtimeById: ReadonlyMap<string, RuntimeTask>,
    externalDependencies: ReadonlyMap<string, TaskRecord>,
  ): Promise<void> {
    for (const runtime of runtimeById.values()) {
      if (!this.isRunnable(runtime.record.status)) continue;
      const failedDependency = runtime.spec.dependencies.find((dependencyId) => {
        const dependencyStatus = runtimeById.get(dependencyId)?.record.status ??
          externalDependencies.get(dependencyId)?.status;
        return dependencyStatus !== undefined && dependencyStatus !== "succeeded" &&
          !this.isRunnable(dependencyStatus);
      });
      if (failedDependency !== undefined) {
        await this.finishWithoutWorker(
          runtime,
          "cancelled",
          "DEPENDENCY_FAILED",
          "Dependency " + failedDependency + " did not succeed, so this task was not run.",
        );
      }
    }
  }

  private async finishWithoutWorker(
    runtime: RuntimeTask,
    status: "cancelled" | "timed_out",
    code: string,
    message: string,
  ): Promise<void> {
    runtime.record.status = status;
    runtime.record.result = failure(code, message);
    runtime.record.updatedAt = new Date().toISOString();
    runtime.record = cloneTaskRecord(await this.store.update(runtime.record));
    await this.emit(runtime.record.sessionId, "task." + status, runtime.record.taskId, { code });
  }

  private async executeTask(
    runtime: RuntimeTask,
    parentContext: ExecutionContext,
    runSignal: AbortSignal,
    parentDeadline: number | undefined,
    getAbortKind: () => AbortKind | undefined,
  ): Promise<void> {
    let consumed: UsageTotals = runtime.record.result === undefined
      ? { tokens: 0, toolCalls: 0 }
      : usageTotals(runtime.record.result);

    while (true) {
      if (runSignal.aborted) {
        const kind = getAbortKind() ?? "cancelled";
        await this.finishWithoutWorker(
          runtime,
          kind,
          kind === "cancelled" ? "PARENT_CANCELLED" : "PARENT_TIMEOUT",
          kind === "cancelled" ? "The parent execution was cancelled." : "The parent execution deadline expired.",
        );
        return;
      }

      runtime.record.status = "running";
      runtime.record.updatedAt = new Date().toISOString();
      runtime.record = cloneTaskRecord(await this.store.update(runtime.record));
      await this.emit(runtime.record.sessionId, "task.running", runtime.record.taskId, {
        attempt: runtime.record.attempt,
      });

      const childDeadline = this.getChildDeadline(runtime.spec.budget, parentDeadline);
      const remainingBudget = this.getRemainingBudget(runtime.spec.budget, consumed, childDeadline);
      const childController = new AbortController();
      const onRunAbort = (): void => childController.abort(getAbortKind() ?? "cancelled");
      if (runSignal.aborted) onRunAbort();
      else runSignal.addEventListener("abort", onRunAbort, { once: true });

      const taskForAttempt: SubtaskSpec = {
        ...runtime.spec,
        attempt: runtime.record.attempt,
        parentTaskId: runtime.record.parentTaskId,
        dependencies: [...runtime.spec.dependencies],
        contextRefs: [...runtime.spec.contextRefs],
        allowedTools: [...runtime.spec.allowedTools],
        budget: { ...remainingBudget },
      };
      const childContext: ExecutionContext = {
        sessionId: runtime.spec.sessionId,
        agentId: runtime.spec.taskId,
        taskId: runtime.spec.taskId,
        runId: runtime.spec.runId,
        attempt: runtime.record.attempt,
        allowedTools: [...runtime.spec.allowedTools],
        contextRefs: [...runtime.spec.contextRefs],
        budget: { ...remainingBudget },
        signal: childController.signal,
      };

      const outcome = await this.invokeWorker(
        taskForAttempt,
        childContext,
        runSignal,
        childController,
        childDeadline,
        parentDeadline,
        getAbortKind,
      );
      runSignal.removeEventListener("abort", onRunAbort);

      if (outcome.kind === "cancelled" || outcome.kind === "timed_out") {
        const code = outcome.kind === "cancelled" ? "PARENT_CANCELLED" : "TASK_TIMEOUT";
        await this.finishWithoutWorker(
          runtime,
          outcome.kind,
          code,
          outcome.kind === "cancelled"
            ? "The parent execution was cancelled while this task was running."
            : "The task deadline expired before the worker returned.",
        );
        return;
      }

      let result = outcome.result;
      const budgetError = this.resultBudgetError(result, runtime.spec.budget, consumed);
      if (budgetError !== undefined) result = failure(budgetError, "Worker usage exceeded its reserved task budget.", result);

      runtime.record.result = result;
      runtime.record.updatedAt = new Date().toISOString();
      runtime.record.status = result.ok ? "succeeded" : "failed";
      runtime.record = cloneTaskRecord(await this.store.update(runtime.record));
      await this.emit(
        runtime.record.sessionId,
        result.ok ? "task.succeeded" : "task.failed",
        runtime.record.taskId,
        result.ok ? { attempt: runtime.record.attempt } : { code: result.error.code },
      );

      if (result.ok || !runtime.readOnly || result.error.retryable !== true ||
          runtime.record.attempt >= runtime.maxAttempt || budgetError !== undefined ||
          !this.canAccountForRetry(result, runtime.spec.budget)) {
        return;
      }

      consumed = addUsage(consumed, usageTotals(result));
      runtime.record.attempt += 1;
      runtime.record.status = "queued";
      runtime.record.updatedAt = new Date().toISOString();
      runtime.record = cloneTaskRecord(await this.store.update(runtime.record));
      await this.emit(runtime.record.sessionId, "task.retrying", runtime.record.taskId, {
        attempt: runtime.record.attempt,
      });
    }
  }

  private async invokeWorker(
    task: SubtaskSpec,
    context: ExecutionContext,
    runSignal: AbortSignal,
    childController: AbortController,
    childDeadline: number | undefined,
    parentDeadline: number | undefined,
    getAbortKind: () => AbortKind | undefined,
  ): Promise<WorkerOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const taskHasEarlierDeadline = childDeadline !== undefined &&
      (parentDeadline === undefined || childDeadline < parentDeadline);
    if (runSignal.aborted) {
      const kind = getAbortKind() ?? "cancelled";
      childController.abort(kind);
      return kind === "cancelled" ? { kind: "cancelled" } : { kind: "timed_out" };
    }
    if (childDeadline !== undefined && childDeadline <= Date.now()) {
      childController.abort("task-timeout");
      return { kind: "timed_out" };
    }

    let abortListener: (() => void) | undefined;
    const abortOutcome = new Promise<WorkerOutcome>((resolve) => {
      abortListener = (): void => {
        const kind = getAbortKind() ?? "cancelled";
        resolve(kind === "cancelled" ? { kind: "cancelled" } : { kind: "timed_out" });
      };
      if (runSignal.aborted) abortListener();
      else runSignal.addEventListener("abort", abortListener, { once: true });
    });

    const timeoutOutcome = new Promise<WorkerOutcome>((resolve) => {
      if (!taskHasEarlierDeadline) return;
      const remaining = Math.max(0, childDeadline! - Date.now());
      timer = setTimeout(() => {
        childController.abort("task-timeout");
        resolve({ kind: "timed_out" });
      }, remaining);
    });

    const workerOutcome: Promise<WorkerOutcome> = Promise.resolve()
      .then(() => this.worker(task, context))
      .then((result) => ({ kind: "result", result: validateEnvelope(result) }) as WorkerOutcome)
      .catch((error) => ({
        kind: "result",
        result: failure("WORKER_EXCEPTION", errorMessage(error)),
      }) as WorkerOutcome);

    const outcome = await Promise.race([workerOutcome, abortOutcome, timeoutOutcome]);
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) runSignal.removeEventListener("abort", abortListener);
    if (outcome.kind !== "result") childController.abort(outcome.kind);
    return outcome;
  }

  private getChildDeadline(
    taskBudget: ExecutionBudget,
    parentDeadline: number | undefined,
  ): number | undefined {
    const now = Date.now();
    let deadline = minimum(parentDeadline, parseDeadline(taskBudget.deadlineAt, "task budget"));
    if (taskBudget.maxDurationMs !== undefined) {
      deadline = minimum(deadline, now + taskBudget.maxDurationMs);
    }
    return deadline;
  }

  private getRemainingBudget(
    taskBudget: ExecutionBudget,
    consumed: UsageTotals,
    deadline: number | undefined,
  ): ExecutionBudget {
    const remainingDuration = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
    const maxTokens = taskBudget.maxTokens === undefined
      ? undefined
      : Math.max(0, taskBudget.maxTokens - (consumed.tokens ?? 0));
    const maxToolCalls = taskBudget.maxToolCalls === undefined
      ? undefined
      : Math.max(0, taskBudget.maxToolCalls - (consumed.toolCalls ?? 0));
    return {
      ...taskBudget,
      maxTokens,
      maxToolCalls,
      maxDurationMs: remainingDuration,
      deadlineAt: deadline === undefined ? undefined : new Date(deadline).toISOString(),
    };
  }

  private resultBudgetError(
    result: ResultEnvelope<unknown>,
    taskBudget: ExecutionBudget,
    consumed: UsageTotals,
  ): string | undefined {
    const usage = usageTotals(result);
    if (taskBudget.maxTokens !== undefined && usage.tokens !== undefined &&
        (consumed.tokens ?? 0) + usage.tokens > taskBudget.maxTokens) {
      return "MAX_TOKENS_EXCEEDED";
    }
    if (taskBudget.maxToolCalls !== undefined && usage.toolCalls !== undefined &&
        (consumed.toolCalls ?? 0) + usage.toolCalls > taskBudget.maxToolCalls) {
      return "MAX_TOOL_CALLS_EXCEEDED";
    }
    return undefined;
  }

  private canAccountForRetry(result: ResultEnvelope<unknown>, taskBudget: ExecutionBudget): boolean {
    const usage = usageTotals(result);
    if (taskBudget.maxTokens !== undefined && usage.tokens === undefined) return false;
    if (taskBudget.maxToolCalls !== undefined && usage.toolCalls === undefined) return false;
    if (taskBudget.maxTokens !== undefined && usage.tokens !== undefined &&
        usage.tokens >= taskBudget.maxTokens) return false;
    if (taskBudget.maxToolCalls !== undefined && usage.toolCalls !== undefined &&
        usage.toolCalls >= taskBudget.maxToolCalls) return false;
    return true;
  }

  private setFailure(record: TaskRecord, code: string, message: string, now: string): void {
    record.status = "failed";
    record.result = failure(code, message);
    record.updatedAt = now;
  }

  private aggregateStatus(records: readonly TaskRecord[]): TaskStatus {
    if (records.length === 0 || records.every((record) => record.status === "succeeded")) {
      return "succeeded";
    }
    if (records.some((record) => record.status === "partial" || record.status === "succeeded") &&
        records.some((record) => record.status !== "succeeded")) {
      return "partial";
    }
    if (records.every((record) => record.status === "cancelled")) return "cancelled";
    if (records.every((record) => record.status === "timed_out")) return "timed_out";
    if (records.some((record) => record.status === "failed")) return "failed";
    if (records.some((record) => record.status === "timed_out")) return "timed_out";
    if (records.some((record) => record.status === "cancelled")) return "cancelled";
    return "partial";
  }

  private async emit(
    sessionId: string,
    type: string,
    taskId?: string,
    payload?: unknown,
  ): Promise<void> {
    if (this.onEvent === undefined) return;
    this.eventSequence += 1;
    const event: EventRecord = {
      eventId: sessionId + ":supervisor:" + this.eventRunId + ":" + this.eventSequence,
      sessionId,
      type,
      timestamp: new Date().toISOString(),
      actorId: "supervisor",
      taskId,
      payload,
    };
    try {
      await this.onEvent(event);
    } catch {
      // Event sinks are observability hooks. A failing hook must not strand tasks.
    }
  }
}

function validateBudget(budget: ExecutionBudget, label: string): void {
  if (!budget || typeof budget !== "object") {
    throw new SupervisorInputError(label + " must be an object");
  }
  for (const key of ["maxTokens", "maxToolCalls", "maxActiveChildren", "maxDelegationDepth"] as const) {
    const value = budget[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new SupervisorInputError(label + " " + key + " must be a finite non-negative integer");
    }
  }
  if (budget.maxDurationMs !== undefined &&
      (!Number.isFinite(budget.maxDurationMs) || budget.maxDurationMs < 0)) {
    throw new SupervisorInputError(label + " maxDurationMs must be finite and non-negative");
  }
  parseDeadline(budget.deadlineAt, label);
}

function parseDeadline(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new SupervisorInputError(label + " deadlineAt must be a valid date");
  return parsed;
}

function minimum(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBudget(left: ExecutionBudget, right: ExecutionBudget): boolean {
  const keys: readonly (keyof ExecutionBudget)[] = [
    "maxTokens",
    "maxToolCalls",
    "maxDurationMs",
    "deadlineAt",
    "maxActiveChildren",
    "maxDelegationDepth",
  ];
  return keys.every((key) => left[key] === right[key]);
}

function cloneTaskRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    dependencies: [...record.dependencies],
    contextRefs: [...record.contextRefs],
    allowedTools: [...record.allowedTools],
    budget: { ...record.budget },
    result: record.result === undefined ? undefined : cloneEnvelope(record.result),
  };
}

function cloneEnvelope(result: ResultEnvelope<unknown>): ResultEnvelope<unknown> {
  if (result.ok) {
    return {
      ...result,
      evidence: [...result.evidence],
      usage: result.usage === undefined ? undefined : { ...result.usage },
    };
  }
  return {
    ...result,
    error: { ...result.error },
    evidence: [...result.evidence],
    usage: result.usage === undefined ? undefined : { ...result.usage },
  };
}

function validateEnvelope(value: unknown): ResultEnvelope<unknown> {
  if (value === null || typeof value !== "object") {
    return failure("INVALID_WORKER_RESULT", "Worker returned a value outside ResultEnvelope.");
  }
  const candidate = value as Partial<ResultEnvelope<unknown>>;
  if (!Array.isArray(candidate.evidence)) {
    return failure("INVALID_WORKER_RESULT", "Worker result is missing its evidence array.");
  }
    if (candidate.ok === true && Object.hasOwn(candidate, "data")) {
      return cloneEnvelope(candidate as ResultEnvelope<unknown>);
    }
  if (candidate.ok === false && candidate.error &&
      nonEmpty((candidate.error as StructuredError).code) &&
      typeof (candidate.error as StructuredError).message === "string") {
    return cloneEnvelope(candidate as ResultEnvelope<unknown>);
  }
  if (candidate.usage !== undefined && !validUsage(candidate.usage)) {
    return failure("INVALID_WORKER_RESULT", "Worker returned invalid usage counters.");
  }
  return failure("INVALID_WORKER_RESULT", "Worker returned an invalid ResultEnvelope.");
}

function validUsage(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "toolCalls", "elapsedMs"] as const) {
    const counter = usage[key];
    if (counter !== undefined && (typeof counter !== "number" || !Number.isFinite(counter) || counter < 0)) {
      return false;
    }
  }
  return true;
}

function failure(
  code: string,
  message: string,
  prior?: ResultEnvelope<unknown>,
): ResultEnvelope<unknown> {
  return {
    ok: false,
    error: { code, message },
    evidence: prior?.evidence ?? [],
    usage: prior?.usage,
  };
}

function usageTotals(result: ResultEnvelope<unknown> | undefined): UsageTotals {
  if (result?.usage === undefined) return {};
  const usage = result.usage;
  const tokens = usage.totalTokens ?? (
    usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined
  );
  return {
    tokens: tokens !== undefined && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined,
    toolCalls: usage.toolCalls !== undefined && Number.isFinite(usage.toolCalls) && usage.toolCalls >= 0
      ? usage.toolCalls
      : undefined,
  };
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    tokens: left.tokens === undefined || right.tokens === undefined ? undefined : left.tokens + right.tokens,
    toolCalls: left.toolCalls === undefined || right.toolCalls === undefined
      ? undefined
      : left.toolCalls + right.toolCalls,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" ? error : "Worker threw an unknown error.";
}
