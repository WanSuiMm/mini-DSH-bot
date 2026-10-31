import assert from "node:assert/strict";
import test from "node:test";

import { Supervisor, SupervisorInputError } from "../dist/multi_agent/supervisor.js";
import { AgentLoop } from "../dist/core/agent-loop.js";
import { ToolRegistry } from "../dist/tools/registry.js";

class MemoryTaskStore {
  records = new Map();

  async create(task) {
    if (this.records.has(task.taskId)) throw new Error("duplicate taskId");
    const copy = clone(task);
    this.records.set(task.taskId, copy);
    return clone(copy);
  }

  async get(taskId) {
    const task = this.records.get(taskId);
    return task === undefined ? undefined : clone(task);
  }

  async update(task) {
    const copy = clone(task);
    this.records.set(task.taskId, copy);
    return clone(copy);
  }

  async delete(taskId) {
    return this.records.delete(taskId);
  }

  async list(query = {}) {
    return [...this.records.values()]
      .filter((task) => query.sessionId === undefined || task.sessionId === query.sessionId)
      .filter((task) => query.parentTaskId === undefined || task.parentTaskId === query.parentTaskId)
      .filter((task) => query.status === undefined || task.status === query.status)
      .map(clone);
  }
}

function clone(value) {
  return structuredClone(value);
}

function task(taskId, dependencies = [], overrides = {}) {
  return {
    sessionId: "session-1",
    parentTaskId: "parent-1",
    taskId,
    runId: "run-1",
    attempt: 1,
    title: taskId,
    instructions: "Do " + taskId,
    dependencies,
    contextRefs: ["ref:" + taskId],
    allowedTools: ["search"],
    budget: { maxTokens: 100, maxToolCalls: 1, maxDurationMs: 1000 },
    ...overrides,
  };
}

function parent(overrides = {}) {
  return {
    sessionId: "session-1",
    agentId: "root-agent",
    taskId: "parent-1",
    runId: "parent-run-1",
    attempt: 1,
    allowedTools: ["search", "parent-secret-tool"],
    contextRefs: ["parent-secret-ref"],
    budget: {},
    ...overrides,
  };
}

function ok(data, usage = {}) {
  return { ok: true, data, evidence: [], usage };
}

const readOnlySearch = (name) => name === "search";

test('a crashed retry cannot treat the preceding attempt usage as the current call cost', async () => {
  const store = new MemoryTaskStore();
  const spec = task('crashed-retry');
  const now = new Date().toISOString();
  await store.create({ ...spec, attempt: 2, status: 'running', createdAt: now, updatedAt: now,
    result: { ok: false, error: { code: 'PREVIOUS_ATTEMPT', message: 'Old retry result', retryable: true }, evidence: [], usage: { totalTokens: 10, toolCalls: 0 } } });
  let modelCalls = 0;
  const loop = new AgentLoop({ generate: async () => { modelCalls++; return ok({ text: 'must not be called' }); } }, new ToolRegistry());
  const supervisor = new Supervisor({ store, maxConcurrency: 1, isReadOnlyTool: readOnlySearch, worker: (item, context) => loop.run(item, context) });
  const result = await supervisor.run([spec], parent());
  assert.equal(modelCalls, 0);
  assert.notEqual(result.status, 'succeeded');
});

test("runs dependencies in order and respects the concurrent task limit", async () => {
  const store = new MemoryTaskStore();
  const started = [];
  const startedAt = new Map();
  const finishedAt = new Map();
  let active = 0;
  let peak = 0;
  const supervisor = new Supervisor({
    store,
    maxConcurrency: 2,
    isReadOnlyTool: readOnlySearch,
    worker: async (item) => {
      started.push(item.taskId);
      startedAt.set(item.taskId, Date.now());
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      finishedAt.set(item.taskId, Date.now());
      active -= 1;
      return ok(item.taskId);
    },
  });

  const result = await supervisor.run([
    task("a"),
    task("b", ["a"]),
    task("c"),
  ], parent());

  assert.equal(result.status, "succeeded");
  assert.ok(started.indexOf("b") > started.indexOf("a"));
  assert.ok(startedAt.get("b") >= finishedAt.get("a"));
  assert.ok(peak <= 2);
  assert.equal(peak, 2);
});

test("worker context contains only the task's declared tools and references", async () => {
  const store = new MemoryTaskStore();
  let seen;
  const supervisor = new Supervisor({
    store,
    maxConcurrency: 1,
    isReadOnlyTool: readOnlySearch,
    worker: async (_item, context) => {
      seen = context;
      return ok("done");
    },
  });

  await supervisor.run([task("isolated")], parent());

  assert.deepEqual(seen.allowedTools, ["search"]);
  assert.deepEqual(seen.contextRefs, ["ref:isolated"]);
  assert.equal(seen.agentId, "isolated");
  assert.equal(seen.taskId, "isolated");
  assert.equal(seen.sessionId, "session-1");
  assert.deepEqual(Object.keys(seen).sort(), [
    "agentId", "allowedTools", "attempt", "budget", "contextRefs", "runId", "sessionId", "signal", "taskId",
  ]);
});

test("worker timeout and parent cancellation return promptly and aggregate partial work", async () => {
  const store = new MemoryTaskStore();
  let finishLateWorker;
  const supervisor = new Supervisor({
    store,
    maxConcurrency: 2,
    isReadOnlyTool: readOnlySearch,
    worker: async (item) => {
      if (item.taskId === "hang") return new Promise((resolve) => { finishLateWorker = resolve; });
      await new Promise((resolve) => setTimeout(resolve, 2));
      return ok("done");
    },
  });

  const timed = await supervisor.run([
    task("fast"),
    task("hang", [], { budget: { maxTokens: 100, maxToolCalls: 1, maxDurationMs: 20 } }),
  ], parent({ budget: { maxDurationMs: 1000 } }));
  assert.equal(timed.status, "partial");
  assert.equal(timed.tasks.find((item) => item.taskId === "hang").status, "timed_out");
  finishLateWorker(ok("late result"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await store.get("hang")).status, "timed_out");
  assert.equal((await store.get("hang")).result.error.code, "TASK_TIMEOUT");

  const controller = new AbortController();
  const cancelStore = new MemoryTaskStore();
  const cancelSupervisor = new Supervisor({
    store: cancelStore,
    maxConcurrency: 1,
    isReadOnlyTool: readOnlySearch,
    worker: async () => new Promise(() => {}),
  });
  const cancelledRun = cancelSupervisor.run([task("cancel-me")], parent({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  const cancelled = await cancelledRun;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.tasks[0].status, "cancelled");
});

test("reuses completed records and rejects changed definitions for an existing task ID", async () => {
  const store = new MemoryTaskStore();
  let calls = 0;
  const supervisor = new Supervisor({
    store,
    maxConcurrency: 1,
    isReadOnlyTool: readOnlySearch,
    worker: async () => {
      calls += 1;
      return ok("done");
    },
  });
  const plan = [task("stable")];

  await supervisor.run(plan, parent());
  const resumed = await supervisor.run(plan, parent());
  assert.equal(calls, 1);
  assert.equal(resumed.tasks[0].status, "succeeded");

  const changedDefinitions = [
    task("stable", [], { instructions: "changed instructions" }),
    task("stable", [], { allowedTools: ["write"] }),
    task("stable", [], { sessionId: "session-2" }),
    task("stable", [], { runId: "run-2" }),
  ];
  for (const changed of changedDefinitions) {
    await assert.rejects(() => supervisor.run([changed], parent()), SupervisorInputError);
  }
});

test("retries only an explicitly retryable read-only task within its reserved budget", async () => {
  const store = new MemoryTaskStore();
  const seen = [];
  const supervisor = new Supervisor({
    store,
    maxConcurrency: 1,
    isReadOnlyTool: readOnlySearch,
    worker: async (_item, context) => {
      seen.push({ attempt: context.attempt, tokens: context.budget.maxTokens, calls: context.budget.maxToolCalls });
      if (context.attempt === 1) {
        return {
          ok: false,
          error: { code: "TEMPORARY", message: "try again", retryable: true },
          evidence: [],
          usage: { totalTokens: 30, toolCalls: 1 },
        };
      }
      return ok("done", { totalTokens: 60, toolCalls: 1 });
    },
  });
  const boundedTask = task("retryable", [], {
    budget: { maxTokens: 100, maxToolCalls: 2 },
  });

  const retried = await supervisor.run([boundedTask], parent({ budget: { maxTokens: 100, maxToolCalls: 2 } }));
  assert.equal(retried.status, "succeeded");
  assert.deepEqual(seen, [
    { attempt: 1, tokens: 100, calls: 2 },
    { attempt: 2, tokens: 70, calls: 1 },
  ]);
  assert.equal(retried.tasks[0].attempt, 2);

  const mutatingStore = new MemoryTaskStore();
  let mutatingCalls = 0;
  const mutatingSupervisor = new Supervisor({
    store: mutatingStore,
    maxConcurrency: 1,
    isReadOnlyTool: readOnlySearch,
    worker: async () => {
      mutatingCalls += 1;
      return {
        ok: false,
        error: { code: "TEMPORARY", message: "try again", retryable: true },
        evidence: [],
        usage: { totalTokens: 1, toolCalls: 1 },
      };
    },
  });
  await mutatingSupervisor.run([
    task("mutating-once", [], {
      allowedTools: ["write"],
      budget: { maxTokens: 100, maxToolCalls: 2 },
    }),
  ], parent({ budget: { maxTokens: 100, maxToolCalls: 2 } }));
  assert.equal(mutatingCalls, 1);
});

test("validates aggregate reservations and serializes tasks with mutating tools", async () => {
  const budgetStore = new MemoryTaskStore();
  let budgetWorkerCalls = 0;
  const budgetSupervisor = new Supervisor({
    store: budgetStore,
    maxConcurrency: 2,
    isReadOnlyTool: readOnlySearch,
    worker: async () => {
      budgetWorkerCalls += 1;
      return ok("unexpected");
    },
  });
  await assert.rejects(
    () => budgetSupervisor.run([
      task("budget-a", [], { budget: { maxTokens: 60, maxToolCalls: 1 } }),
      task("budget-b", [], { budget: { maxTokens: 60, maxToolCalls: 1 } }),
    ], parent({ budget: { maxTokens: 100 } })),
    SupervisorInputError,
  );
  await assert.rejects(
    () => budgetSupervisor.run([
      task("budget-missing", [], { budget: { maxToolCalls: 1 } }),
    ], parent({ budget: { maxTokens: 100 } })),
    SupervisorInputError,
  );
  assert.equal(budgetWorkerCalls, 0);

  const store = new MemoryTaskStore();
  let active = 0;
  let overlap = false;
  const supervisor = new Supervisor({
    store,
    maxConcurrency: 3,
    isReadOnlyTool: readOnlySearch,
    worker: async (item) => {
      active += 1;
      if (item.taskId === "write") overlap ||= active > 1;
      else if (active > 1 && [...store.records.values()].some((record) => record.status === "running" && record.taskId === "write")) overlap = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return ok(item.taskId);
    },
  });
  const result = await supervisor.run([
    task("read-a"),
    task("write", [], { allowedTools: ["write"] }),
    task("read-b"),
  ], parent());
  assert.equal(result.status, "succeeded");
  assert.equal(overlap, false);
});

test("rejects duplicate task IDs, missing dependencies, and dependency cycles", async () => {
  const supervisor = new Supervisor({
    store: new MemoryTaskStore(),
    maxConcurrency: 1,
    isReadOnlyTool: readOnlySearch,
    worker: async () => ok("done"),
  });
  await assert.rejects(
    () => supervisor.run([task("dup"), task("dup")], parent()),
    SupervisorInputError,
  );
  await assert.rejects(
    () => supervisor.run([task("missing", ["unknown"])], parent()),
    SupervisorInputError,
  );
  await assert.rejects(
    () => supervisor.run([task("cycle-a", ["cycle-b"]), task("cycle-b", ["cycle-a"])], parent()),
    SupervisorInputError,
  );
});
