import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class ServiceDatabase {
  constructor(path) {
    this.kind = 'sqlite';
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner TEXT NOT NULL,
        status TEXT NOT NULL, request TEXT NOT NULL, result TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        created TEXT NOT NULL, updated TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, cancel_requested_at TEXT,
        UNIQUE(session_id,idempotency_key));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory(namespace TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(namespace,id));
      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status,created);
      CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id,seq);`);
    const runColumns = new Set(this.db.prepare('PRAGMA table_info(runs)').all().map(column => column.name));
    if (!runColumns.has('lease_owner')) this.db.exec('ALTER TABLE runs ADD COLUMN lease_owner TEXT');
    if (!runColumns.has('lease_expires')) this.db.exec('ALTER TABLE runs ADD COLUMN lease_expires TEXT');
    if (!runColumns.has('cancel_requested')) this.db.exec('ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0');
    if (!runColumns.has('cancel_requested_at')) this.db.exec('ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT');
  }
  session(owner, id) { return this.db.prepare('SELECT * FROM sessions WHERE owner=? AND id=?').get(owner, id); }
  createSession(owner, title) {
    const record = { id: randomUUID(), owner, title, created: new Date().toISOString() };
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(record.id, owner, title, record.created);
    return record;
  }
  listSessions(owner) { return this.db.prepare('SELECT id,title,created FROM sessions WHERE owner=? ORDER BY created DESC').all(owner); }
  sessionRuns(owner, sessionId, limit = 50, before = undefined) {
    const rows = before
      ? this.db.prepare('SELECT id,status,request,result,created,updated FROM runs WHERE owner=? AND session_id=? AND created<? ORDER BY created DESC,id DESC LIMIT ?').all(owner, sessionId, before, limit)
      : this.db.prepare('SELECT id,status,request,result,created,updated FROM runs WHERE owner=? AND session_id=? ORDER BY created DESC,id DESC LIMIT ?').all(owner, sessionId, limit);
    return rows.map(row => ({ ...row, request: JSON.parse(row.request), result: row.result ? JSON.parse(row.result) : null }));
  }
  findRunByKey(owner, sessionId, key) {
    return this.db.prepare('SELECT id FROM runs WHERE owner=? AND session_id=? AND idempotency_key=?').get(owner, sessionId, key);
  }
  queueSize() { return this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='queued'").get().count; }
  createRun(owner, sessionId, key, input) {
    const request = JSON.stringify(input);
    const hash = createHash('sha256').update(request).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM runs WHERE session_id=? AND idempotency_key=?').get(sessionId, key);
      if (existing) {
        if (existing.request_hash !== hash) throw Object.assign(new Error('Idempotency key was used with a different request'), { status: 409 });
        this.db.exec('COMMIT');
        return { run: this.parseRun(existing), replayed: true };
      }
      const id = randomUUID(); const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO runs(id,session_id,owner,status,request,result,idempotency_key,request_hash,created,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, sessionId, owner, 'queued', request, null, key, hash, now, now);
      this.db.exec('COMMIT');
      return { run: this.getRun(owner, id), replayed: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  parseRun(row) { return row ? { ...row, cancel_requested: Boolean(row.cancel_requested), cancel_requested_at: row.cancel_requested_at ?? null,
    request: JSON.parse(row.request), result: row.result ? JSON.parse(row.result) : null } : undefined; }
  getRun(owner, id) { return this.parseRun(this.db.prepare('SELECT * FROM runs WHERE owner=? AND id=?').get(owner, id)); }
  pending() { return this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY created,id").all().map(row => this.parseRun(row)); }
  interrupted() { return this.db.prepare("SELECT * FROM runs WHERE status='running'").all().map(row => this.parseRun(row)); }
  claimNextRun(workerId, leaseMs = 60_000) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT id FROM runs WHERE status='queued' ORDER BY created,id LIMIT 1").get();
      if (!row) { this.db.exec('COMMIT'); return undefined; }
      const now = Date.now();
      const result = this.db.prepare("UPDATE runs SET status='running',lease_owner=?,lease_expires=?,updated=? WHERE id=? AND status='queued'")
        .run(workerId, new Date(now + leaseMs).toISOString(), new Date(now).toISOString(), row.id);
      this.db.exec('COMMIT');
      return result.changes ? this.parseRun(this.db.prepare('SELECT * FROM runs WHERE id=?').get(row.id)) : undefined;
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }
  renewRunLease(id, workerId, leaseMs = 60_000) {
    return Boolean(this.db.prepare("UPDATE runs SET lease_expires=?,updated=? WHERE id=? AND status='running' AND lease_owner=?")
      .run(new Date(Date.now() + leaseMs).toISOString(), new Date().toISOString(), id, workerId).changes);
  }
  cancelQueuedRun(id) {
    const now = new Date().toISOString();
    return Boolean(this.db.prepare("UPDATE runs SET status='cancelled',cancel_requested=1,cancel_requested_at=?,updated=? WHERE id=? AND status='queued'")
      .run(now, now, id).changes);
  }
  requestRunCancellation(id) {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE runs SET
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?),
      updated=? WHERE id=? AND status IN ('queued','running')`).run(now, now, id).changes === 1;
  }
  isRunCancellationRequested(id) {
    return Boolean(this.db.prepare('SELECT cancel_requested FROM runs WHERE id=?').get(id)?.cancel_requested);
  }
  setRun(id, status, result = null, workerId = undefined) {
    const terminal = ['succeeded', 'failed', 'partial', 'cancelled', 'timed_out'].includes(status);
    const update = workerId === undefined
      ? this.db.prepare('UPDATE runs SET status=?,result=?,updated=?,lease_owner=CASE WHEN ? THEN NULL ELSE lease_owner END,lease_expires=CASE WHEN ? THEN NULL ELSE lease_expires END WHERE id=?')
        .run(status, result === null ? null : JSON.stringify(result), new Date().toISOString(), terminal ? 1 : 0, terminal ? 1 : 0, id)
      : this.db.prepare('UPDATE runs SET status=?,result=?,updated=?,lease_owner=CASE WHEN ? THEN NULL ELSE lease_owner END,lease_expires=CASE WHEN ? THEN NULL ELSE lease_expires END WHERE id=? AND lease_owner=?')
        .run(status, result === null ? null : JSON.stringify(result), new Date().toISOString(), terminal ? 1 : 0, terminal ? 1 : 0, id, workerId);
    if (!update.changes) throw new Error('Run is no longer owned by this worker');
  }
  event(runId, type, payload) {
    const created = new Date().toISOString();
    const row = this.db.prepare('INSERT INTO events(run_id,type,payload,created) VALUES(?,?,?,?)').run(runId, type, JSON.stringify(payload), created);
    return { id: Number(row.lastInsertRowid), runId, type, payload, created };
  }
  events(runId, after = 0, limit = 1000) {
    return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit)
      .map(row => ({ id: row.seq, runId: row.run_id, type: row.type, payload: JSON.parse(row.payload), created: row.created }));
  }
  latestEvent(runId, type) {
    const row = this.db.prepare('SELECT payload FROM events WHERE run_id=? AND type=? ORDER BY seq DESC LIMIT 1').get(runId, type);
    return row ? JSON.parse(row.payload) : undefined;
  }
  taskStore(runId) {
    const db = this.db;
    return {
      async create(task) {
        db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.taskId, runId, JSON.stringify(task));
        return structuredClone(task);
      },
      async get(id) { const row = db.prepare('SELECT record FROM tasks WHERE id=? AND run_id=?').get(id, runId); return row ? JSON.parse(row.record) : undefined; },
      async update(task) {
        const result = db.prepare('UPDATE tasks SET record=? WHERE id=? AND run_id=?').run(JSON.stringify(task), task.taskId, runId);
        if (!result.changes) throw new Error('Task does not belong to this run');
        return structuredClone(task);
      },
      async delete(id) { return Boolean(db.prepare('DELETE FROM tasks WHERE id=? AND run_id=?').run(id, runId).changes); },
      async list(query = {}) {
        return db.prepare('SELECT record FROM tasks WHERE run_id=? ORDER BY id').all(runId).map(row => JSON.parse(row.record))
          .filter(task => (!query.sessionId || task.sessionId === query.sessionId) && (!query.parentTaskId || task.parentTaskId === query.parentTaskId) && (!query.status || task.status === query.status));
      },
    };
  }
  memoryList(namespace, query = '') {
    const now = Date.now();
    return this.db.prepare('SELECT record FROM memory WHERE namespace=? ORDER BY id').all(namespace).map(row => JSON.parse(row.record))
      .filter(record => !record.expiresAt || Date.parse(record.expiresAt) > now)
      .filter(record => !query || JSON.stringify(record.value).toLowerCase().includes(query.toLowerCase()));
  }
  memoryPut(namespace, id, value, { ttlMs, sourceRefs = [] } = {}) {
    if (!Number.isSafeInteger(ttlMs ?? 0) || (ttlMs ?? 0) < 0) throw Object.assign(new Error('Invalid memory TTL'), { status: 400 });
    const previous = this.memoryList(namespace).find(item => item.id === id);
    const now = new Date().toISOString();
    const record = { namespace, id, value, sourceRefs, createdAt: previous?.createdAt ?? now, updatedAt: now,
      version: (previous?.version ?? 0) + 1, ...(ttlMs ? { expiresAt: new Date(Date.now() + ttlMs).toISOString() } : {}) };
    this.db.prepare('INSERT INTO memory VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET record=excluded.record').run(namespace, id, JSON.stringify(record));
    return record;
  }
  memoryDelete(namespace, id) { return Boolean(this.db.prepare('DELETE FROM memory WHERE namespace=? AND id=?').run(namespace, id).changes); }
  close() { this.db.close(); }
}
