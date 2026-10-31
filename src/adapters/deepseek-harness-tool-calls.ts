/**
 * Bounded tool-call scheduler ported from DeepSeek Harness `executeToolCalls`.
 * This file keeps the upstream scheduling contract while adapting it to the
 * smaller microDSH ModelToolCall / ResultEnvelope interfaces.
 *
 * Upstream: deepseek-ai/deepseek-harness, commit
 * 47f943859bef60e4160492346772ded9b24f765a, packages/core/agent-loop/src/tool-calls.ts
 * Copyright (c) 2026 DeepSeek. Licensed under MIT; see THIRD_PARTY_NOTICES.md.
 */

export type ToolExecutionMode = "parallel" | "exclusive";

export interface DeepSeekToolCallSchedulerOptions<TCall, TResult> {
  calls: readonly TCall[];
  signal: AbortSignal;
  maxParallelToolCalls: number;
  /** Re-read before each dispatch, matching the upstream live-mode check. */
  executionMode(call: TCall): ToolExecutionMode;
  /** Tool failures should normally be returned as TResult; rejection is a scheduler failure. */
  execute(call: TCall): Promise<TResult> | TResult;
  /** Supplies the ordered result for a call not dispatched after abort. */
  skippedResult(call: TCall): TResult;
}

export interface DeepSeekToolCallSchedulerResult<TResult> {
  /** One result per input call, committed in model order. */
  results: readonly TResult[];
  aborted: boolean;
  started: number;
}

/**
 * Run exclusive calls as barriers and parallel-safe calls in a bounded rolling
 * pool. Started calls are drained after abort or scheduler failure. Aborts add
 * synthetic results for every call that was not dispatched; scheduler failures
 * reject after draining without manufacturing result records.
 */
export async function executeDeepSeekHarnessToolCalls<TCall, TResult>(
  options: DeepSeekToolCallSchedulerOptions<TCall, TResult>,
): Promise<DeepSeekToolCallSchedulerResult<TResult>> {
  const { calls, signal, maxParallelToolCalls, executionMode, execute, skippedResult } = options;
  if (!Number.isSafeInteger(maxParallelToolCalls) || maxParallelToolCalls < 1 || maxParallelToolCalls > 32) {
    throw new TypeError("maxParallelToolCalls must be an integer from 1 through 32");
  }

  const results: (TResult | undefined)[] = new Array(calls.length);
  const startedCalls = new Array<boolean>(calls.length).fill(false);
  const inFlight = new Map<number, Promise<number>>();
  let next = 0;
  let started = 0;
  let schedulerFailure: { error: unknown } | undefined;

  const start = (index: number): void => {
    const call = calls[index]!;
    startedCalls[index] = true;
    started += 1;
    let dispatched: Promise<TResult>;
    try {
      dispatched = Promise.resolve(execute(call));
    } catch (error) {
      schedulerFailure ??= { error };
      inFlight.set(index, Promise.resolve(index));
      return;
    }
    inFlight.set(index, dispatched.then(
      result => {
        results[index] = result;
        return index;
      },
      error => {
        schedulerFailure ??= { error };
        return index;
      },
    ));
  };

  const drain = async (): Promise<void> => {
    await Promise.all(inFlight.values());
    inFlight.clear();
  };

  let aborted = signal.aborted;
  try {
    while (next < calls.length && !aborted) {
      const firstMode = executionMode(calls[next]!);
      if (firstMode === "exclusive") {
        if (inFlight.size > 0) {
          await drain();
          if (schedulerFailure !== undefined) throw schedulerFailure.error;
          aborted = signal.aborted;
          continue;
        }
        const index = next++;
        start(index);
        await inFlight.get(index);
        inFlight.delete(index);
        if (schedulerFailure !== undefined) throw schedulerFailure.error;
        aborted = signal.aborted;
        continue;
      }

      // A parallel group is a rolling pool. An exclusive call encountered
      // while filling the pool stays queued as the next barrier.
      while (next < calls.length && inFlight.size < maxParallelToolCalls && !signal.aborted) {
        if (executionMode(calls[next]!) !== "parallel") break;
        start(next++);
        if (schedulerFailure !== undefined) throw schedulerFailure.error;
      }

      if (inFlight.size > 0) {
        const settledIndex = await Promise.race(inFlight.values());
        inFlight.delete(settledIndex);
        if (schedulerFailure !== undefined) throw schedulerFailure.error;
      }
      aborted = signal.aborted;
    }
  } catch (error) {
    schedulerFailure ??= { error };
    await drain();
    throw schedulerFailure.error;
  }

  // Abort stops replenishment but does not abandon already-dispatched calls.
  if (inFlight.size > 0) {
    await drain();
    if (schedulerFailure !== undefined) throw schedulerFailure.error;
  }
  aborted ||= signal.aborted;

  if (schedulerFailure !== undefined) throw schedulerFailure.error;
  if (aborted || signal.aborted) {
    for (let index = 0; index < calls.length; index += 1) {
      if (!startedCalls[index]) results[index] = skippedResult(calls[index]!);
    }
  }

  const ordered = Array.from({ length: calls.length }, (_, index) => {
    const result = results[index];
    if (result === undefined) {
      throw new Error(`tool-call scheduler left call ${index} without a result`);
    }
    return result;
  });
  return { results: ordered, aborted: aborted || signal.aborted, started };
}
