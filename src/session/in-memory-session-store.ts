import type { SessionRecord } from "../contracts.js";

/** Minimal session metadata store for local hosts and deterministic tests. */
export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(initial: readonly SessionRecord[] = []) {
    this.restore(initial);
  }

  async create(session: SessionRecord): Promise<SessionRecord> {
    validateSession(session);
    if (this.sessions.has(session.sessionId)) throw new Error(`Session already exists: ${session.sessionId}`);
    const stored = cloneValue(session);
    this.sessions.set(session.sessionId, stored);
    return cloneValue(stored);
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : cloneValue(session);
  }

  async update(session: SessionRecord): Promise<SessionRecord> {
    validateSession(session);
    if (!this.sessions.has(session.sessionId)) throw new Error(`Session does not exist: ${session.sessionId}`);
    const stored = cloneValue(session);
    this.sessions.set(session.sessionId, stored);
    return cloneValue(stored);
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }

  async list(): Promise<readonly SessionRecord[]> {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId))
      .map(cloneValue);
  }

  snapshot(): readonly SessionRecord[] {
    return [...this.sessions.values()].map(cloneValue);
  }

  restore(sessions: readonly SessionRecord[]): void {
    this.sessions.clear();
    for (const session of sessions) {
      validateSession(session);
      if (this.sessions.has(session.sessionId)) {
        throw new Error(`Duplicate session snapshot id: ${session.sessionId}`);
      }
      this.sessions.set(session.sessionId, cloneValue(session));
    }
  }
}

function validateSession(session: SessionRecord): void {
  if (typeof session.sessionId !== "string" || session.sessionId.trim().length === 0) {
    throw new TypeError("Session id must be a non-empty string");
  }
  if (!Number.isFinite(Date.parse(session.createdAt)) || !Number.isFinite(Date.parse(session.updatedAt))) {
    throw new TypeError("Session timestamps must be valid timestamps");
  }
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall back to an in-memory-only reference if metadata is not cloneable.
    }
  }
  return value;
}
