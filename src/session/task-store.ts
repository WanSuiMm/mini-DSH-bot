import type { TaskQuery, TaskRecord, TaskStore } from "../contracts.js";

/** In-memory task persistence with snapshot support for a host file adapter. */
export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(initial: readonly TaskRecord[] = []) {
    this.restore(initial);
  }

  async create(task: TaskRecord): Promise<TaskRecord> {
    validateTask(task);
    if (this.tasks.has(task.taskId)) throw new Error(`Task already exists: ${task.taskId}`);
    const stored = cloneValue(task);
    this.tasks.set(task.taskId, stored);
    return cloneValue(stored);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : cloneValue(task);
  }

  async update(task: TaskRecord): Promise<TaskRecord> {
    validateTask(task);
    if (!this.tasks.has(task.taskId)) throw new Error(`Task does not exist: ${task.taskId}`);
    const stored = cloneValue(task);
    this.tasks.set(task.taskId, stored);
    return cloneValue(stored);
  }

  async delete(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId);
  }

  async list(query: TaskQuery = {}): Promise<readonly TaskRecord[]> {
    return [...this.tasks.values()]
      .filter((task) => query.sessionId === undefined || task.sessionId === query.sessionId)
      .filter((task) => query.parentTaskId === undefined || task.parentTaskId === query.parentTaskId)
      .filter((task) => query.status === undefined || task.status === query.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId))
      .map(cloneValue);
  }

  snapshot(): readonly TaskRecord[] {
    return [...this.tasks.values()].map(cloneValue);
  }

  restore(tasks: readonly TaskRecord[]): void {
    this.tasks.clear();
    for (const task of tasks) {
      validateTask(task);
      if (this.tasks.has(task.taskId)) throw new Error(`Duplicate task snapshot id: ${task.taskId}`);
      this.tasks.set(task.taskId, cloneValue(task));
    }
  }
}

function validateTask(task: TaskRecord): void {
  if (typeof task.taskId !== "string" || task.taskId.trim().length === 0) {
    throw new TypeError("Task id must be a non-empty string");
  }
  if (typeof task.sessionId !== "string" || task.sessionId.trim().length === 0) {
    throw new TypeError("Session id must be a non-empty string");
  }
  if (!Number.isFinite(Date.parse(task.createdAt)) || !Number.isFinite(Date.parse(task.updatedAt))) {
    throw new TypeError("Task timestamps must be valid timestamps");
  }
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall back to an in-memory representation when the value is not cloneable.
    }
  }
  return value;
}
