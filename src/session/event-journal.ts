import type { EventRecord } from "../contracts.js";

export interface EventQuery {
  sessionId?: string;
  taskId?: string;
  type?: string;
  limit?: number;
}

export interface ScopedEventJournal {
  append(event: EventRecord): Promise<EventRecord>;
  list(query?: Omit<EventQuery, "sessionId">): Promise<readonly EventRecord[]>;
  snapshot(): readonly EventRecord[];
}

/** Append-only event journal with session filters and portable snapshots. */
export class EventJournal {
  private readonly events: EventRecord[] = [];
  private readonly eventIds = new Set<string>();

  constructor(initial: readonly EventRecord[] = []) {
    this.restore(initial);
  }

  async append(event: EventRecord): Promise<EventRecord> {
    validateEvent(event);
    if (this.eventIds.has(event.eventId)) throw new Error(`Event already exists: ${event.eventId}`);
    const stored = cloneValue(event);
    this.events.push(stored);
    this.eventIds.add(event.eventId);
    return cloneValue(stored);
  }

  async list(query: EventQuery = {}): Promise<readonly EventRecord[]> {
    if (query.limit !== undefined && (!Number.isFinite(query.limit) || query.limit < 0)) {
      throw new TypeError("Event query limit must be a finite non-negative number");
    }
    const matching = this.events
      .filter((event) => query.sessionId === undefined || event.sessionId === query.sessionId)
      .filter((event) => query.taskId === undefined || event.taskId === query.taskId)
      .filter((event) => query.type === undefined || event.type === query.type);
    const limited = query.limit === undefined ? matching : matching.slice(0, Math.floor(query.limit));
    return limited.map(cloneValue);
  }

  snapshot(): readonly EventRecord[] {
    return this.events.map(cloneValue);
  }

  restore(events: readonly EventRecord[]): void {
    this.events.length = 0;
    this.eventIds.clear();
    for (const event of events) {
      validateEvent(event);
      if (this.eventIds.has(event.eventId)) throw new Error(`Duplicate event snapshot id: ${event.eventId}`);
      this.events.push(cloneValue(event));
      this.eventIds.add(event.eventId);
    }
  }

  scoped(sessionId: string): ScopedEventJournal {
    validateNonEmpty(sessionId, "Session id");
    return {
      append: (event) => {
        if (event.sessionId !== sessionId) {
          throw new Error("Scoped journal cannot append an event from another session");
        }
        return this.append(event);
      },
      list: (query = {}) => this.list({ ...query, sessionId }),
      snapshot: () => this.snapshot().filter((event) => event.sessionId === sessionId),
    };
  }
}

function validateEvent(event: EventRecord): void {
  validateNonEmpty(event.eventId, "Event id");
  validateNonEmpty(event.sessionId, "Session id");
  validateNonEmpty(event.type, "Event type");
  if (!Number.isFinite(Date.parse(event.timestamp))) {
    throw new TypeError("Event timestamp must be a valid timestamp");
  }
}

function validateNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Event payloads are typically serializable; preserve in-memory use otherwise.
    }
  }
  return value;
}
