import type {
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
  MemoryWrite,
} from "../contracts.js";

export type ScopedMemoryWrite = Omit<MemoryWrite, "namespace">;
export type ScopedMemoryQuery = Omit<MemoryQuery, "namespace">;

/** Namespace-bound capability for a caller that should not choose namespaces. */
export interface ScopedMemoryStore {
  create(record: ScopedMemoryWrite): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  update(record: ScopedMemoryWrite): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
  list(query?: ScopedMemoryQuery): Promise<readonly MemoryRecord[]>;
  search(query?: ScopedMemoryQuery): Promise<readonly MemoryRecord[]>;
}

/** Small in-memory implementation with lazy TTL expiry and text retrieval. */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();

  constructor(initial: readonly MemoryRecord[] = []) {
    this.restore(initial);
  }

  async create(write: MemoryWrite): Promise<MemoryRecord> {
    validateWrite(write);
    const key = storageKey(write.namespace, write.id);
    this.purgeExpiredKey(key);
    if (this.records.has(key)) {
      throw new Error(`Memory record already exists: ${write.namespace}/${write.id}`);
    }

    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: write.id,
      namespace: write.namespace,
      value: cloneValue(write.value),
      createdAt: now,
      updatedAt: now,
      ...(write.sourceRefs === undefined
        ? {}
        : { sourceRefs: [...write.sourceRefs] }),
      ...(write.ttlMs === undefined ? {} : { expiresAt: new Date(Date.now() + write.ttlMs).toISOString() }),
      version: "1",
    };
    this.records.set(key, record);
    return cloneValue(record);
  }

  async get(namespace: string, id: string): Promise<MemoryRecord | undefined> {
    const key = storageKey(namespace, id);
    this.purgeExpiredKey(key);
    const record = this.records.get(key);
    return record === undefined ? undefined : cloneValue(record);
  }

  async update(write: MemoryWrite): Promise<MemoryRecord> {
    validateWrite(write);
    const key = storageKey(write.namespace, write.id);
    this.purgeExpiredKey(key);
    const current = this.records.get(key);
    if (!current) throw new Error(`Memory record does not exist: ${write.namespace}/${write.id}`);

    const now = new Date().toISOString();
    const nextVersion = Number.parseInt(current.version ?? "1", 10);
    const record: MemoryRecord = {
      ...current,
      value: cloneValue(write.value),
      updatedAt: now,
      version: String(Number.isFinite(nextVersion) ? nextVersion + 1 : 2),
      ...(write.sourceRefs === undefined
        ? {}
        : { sourceRefs: [...write.sourceRefs] }),
      ...(write.ttlMs === undefined
        ? {}
        : { expiresAt: new Date(Date.now() + write.ttlMs).toISOString() }),
    };
    this.records.set(key, record);
    return cloneValue(record);
  }

  async delete(namespace: string, id: string): Promise<boolean> {
    const key = storageKey(namespace, id);
    this.purgeExpiredKey(key);
    return this.records.delete(key);
  }

  async list(query: MemoryQuery): Promise<readonly MemoryRecord[]> {
    validateNamespace(query.namespace);
    this.purgeExpired();
    const records = [...this.records.values()]
      .filter((record) => record.namespace === query.namespace)
      .filter((record) => query.text === undefined || textMatches(record, query.text))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return applyLimit(records, query.limit).map(cloneValue);
  }

  async search(query: MemoryQuery): Promise<readonly MemoryRecord[]> {
    validateNamespace(query.namespace);
    this.purgeExpired();
    const text = normalizeText(query.text ?? "");
    if (text.length === 0) return [];

    const terms = text.split(/\s+/).filter(Boolean);
    const scored = [...this.records.values()]
      .filter((record) => record.namespace === query.namespace)
      .map((record) => ({ record, score: textScore(record, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
      .map(({ record }) => record);
    return applyLimit(scored, query.limit).map(cloneValue);
  }

  /** Snapshot only the live records; returned values are detached when possible. */
  snapshot(): readonly MemoryRecord[] {
    this.purgeExpired();
    return [...this.records.values()].map(cloneValue);
  }

  /** Replace store contents from a persisted snapshot. Expired entries are skipped. */
  restore(records: readonly MemoryRecord[]): void {
    this.records.clear();
    const now = Date.now();
    for (const input of records) {
      validateRecord(input);
      if (isExpired(input, now)) continue;
      const key = storageKey(input.namespace, input.id);
      if (this.records.has(key)) throw new Error(`Duplicate memory snapshot key: ${input.namespace}/${input.id}`);
      this.records.set(key, cloneValue(input));
    }
  }

  scoped(namespace: string): ScopedMemoryStore {
    validateNamespace(namespace);
    return {
      create: (write) => this.create({ ...write, namespace }),
      get: (id) => this.get(namespace, id),
      update: (write) => this.update({ ...write, namespace }),
      delete: (id) => this.delete(namespace, id),
      list: (query = {}) => this.list({ ...query, namespace }),
      search: (query = {}) => this.search({ ...query, namespace }),
    };
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (isExpired(record, now)) this.records.delete(key);
    }
  }

  private purgeExpiredKey(key: string): void {
    const record = this.records.get(key);
    if (record && isExpired(record, Date.now())) this.records.delete(key);
  }
}

function validateWrite(write: MemoryWrite): void {
  validateNamespace(write.namespace);
  if (typeof write.id !== "string" || write.id.trim().length === 0) {
    throw new TypeError("Memory record id must be a non-empty string");
  }
  if (write.ttlMs !== undefined && (!Number.isFinite(write.ttlMs) || write.ttlMs < 0)) {
    throw new TypeError("Memory TTL must be a finite non-negative number");
  }
}

function validateRecord(record: MemoryRecord): void {
  validateNamespace(record.namespace);
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    throw new TypeError("Memory record id must be a non-empty string");
  }
  if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new TypeError("Memory record timestamps must be valid timestamps");
  }
  if (record.expiresAt !== undefined && !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new TypeError("Memory record expiry must be a valid timestamp");
  }
}

function validateNamespace(namespace: string): void {
  if (typeof namespace !== "string" || namespace.trim().length === 0) {
    throw new TypeError("Memory namespace must be a non-empty string");
  }
}

function storageKey(namespace: string, id: string): string {
  return `${namespace.length}:${namespace}${id}`;
}

function isExpired(record: MemoryRecord, now: number): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now;
}

function textMatches(record: MemoryRecord, query: string): boolean {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length === 0) return true;
  const haystack = recordText(record);
  return normalizedQuery.split(/\s+/).every((term) => haystack.includes(term));
}

function textScore(record: MemoryRecord, terms: readonly string[]): number {
  const haystack = recordText(record);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function recordText(record: MemoryRecord): string {
  return normalizeText(`${record.id} ${safeStringify(record.value)} ${(record.sourceRefs ?? []).join(" ")}`);
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase();
}

function applyLimit<T>(values: readonly T[], limit: number | undefined): T[] {
  if (limit === undefined) return [...values];
  if (!Number.isFinite(limit) || limit < 0) throw new TypeError("Query limit must be a finite non-negative number");
  return values.slice(0, Math.floor(limit));
}

function safeStringify(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result ?? String(value);
  } catch {
    return String(value);
  }
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // The in-memory store still supports values that are not cloneable.
    }
  }
  return value;
}
