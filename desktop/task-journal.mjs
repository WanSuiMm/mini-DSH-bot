import { randomUUID } from 'node:crypto';
import { ServiceDatabase } from '../service/database.mjs';

const SESSION_STATUSES = new Set(['creating', 'active', 'paused', 'lost', 'closed']);
const COMMAND_STATUSES = new Set(['pending_approval', 'ready', 'running', 'succeeded', 'failed', 'unknown', 'rejected']);
const TERMINAL_COMMAND_STATUSES = new Set(['succeeded', 'failed', 'unknown', 'rejected']);
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'partial', 'cancelled', 'timed_out', 'recovery_required']);
const SAFE_ID = /^[\x21-\x7e]{1,256}$/u;

function fail(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function json(value, name = 'value') {
  let text;
  try { text = JSON.stringify(value); } catch { throw fail(`INVALID_${name.toUpperCase()}`); }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 128 * 1024) throw fail(`${name.toUpperCase()}_TOO_LARGE`);
  return text;
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function nowIso() { return new Date().toISOString(); }

function sessionFromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id, owner: row.owner, harnessSessionId: row.harness_session_id, runId: row.run_id,
    taskId: row.task_id, profileId: row.profile_id, workerId: row.worker_id, fence: Number(row.fence),
    status: row.status, leaseUntil: row.lease_until, createdAt: row.created_at,
    updatedAt: row.updated_at, expiresAt: row.expires_at,
  };
}

function commandFromRow(row) {
  if (!row) return undefined;
  return {
    id: row.id, owner: row.owner, sessionId: row.session_id, idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash, status: row.status, request: parseJson(row.request), result: parseJson(row.result),
    requiresApproval: Boolean(row.requires_approval), approvalDecision: row.approval_decision,
    approvedAt: row.approved_at, workerId: row.worker_id,
    fence: row.fence === null ? null : Number(row.fence), startedAt: row.started_at,
    finishedAt: row.finished_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function eventFromRow(row) {
  if (!row) return undefined;
  return { id: Number(row.seq), sessionId: row.session_id, type: row.type,
    payload: parseJson(row.payload), createdAt: row.created_at };
}

/** Durable browser-control tables sharing HarnessService's local SQLite connection. */
export class SQLiteBrowserStore {
  constructor(database, { runtimeLockName = 'micro-dsh-desktop-browser' } = {}) {
    const db = database?.db ?? database;
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw fail('SQLITE_DATABASE_REQUIRED');
    this.db = db;
    this.runtimeLockName = runtimeLockName;
    this.kind = 'sqlite';
  }

  async ready() {
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, harness_session_id TEXT NOT NULL, run_id TEXT NOT NULL,
        task_id TEXT NOT NULL, profile_id TEXT, worker_id TEXT NOT NULL, fence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('creating','active','paused','lost','closed')),
        lease_until TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        UNIQUE(owner,id));
      CREATE INDEX IF NOT EXISTS desktop_browser_sessions_run_idx ON browser_sessions(owner,run_id,status);
      CREATE TABLE IF NOT EXISTS browser_commands (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending_approval','ready','running','succeeded','failed','unknown','rejected')),
        request TEXT NOT NULL, result TEXT, requires_approval INTEGER NOT NULL, approval_decision TEXT,
        approved_at TEXT, worker_id TEXT, fence INTEGER, started_at TEXT, finished_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(owner,session_id,idempotency_key));
      CREATE INDEX IF NOT EXISTS desktop_browser_commands_session_idx ON browser_commands(owner,session_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS browser_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, session_id TEXT NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS desktop_browser_events_session_idx ON browser_events(owner,session_id,seq);
      CREATE TABLE IF NOT EXISTS desktop_tabs (
        id TEXT PRIMARY KEY, harness_session_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_tasks (
        id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, harness_session_id TEXT NOT NULL, run_id TEXT,
        prompt TEXT NOT NULL, url TEXT NOT NULL, allowed_origins TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, output TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS desktop_tasks_tab_idx ON desktop_tasks(tab_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS desktop_tasks_run_idx ON desktop_tasks(run_id);`);
  }

  async acquireRuntimeLock() { return true; }

  async createSession({ id, owner, harnessSessionId, runId, taskId, profileId = null, workerId,
    leaseMs = 60_000, ttlMs = 1_800_000, maxSessions = 4, maxOwnerSessions = 2 } = {}) {
    if (![id, owner, harnessSessionId, runId, taskId, workerId].every(value => typeof value === 'string' && SAFE_ID.test(value))) throw fail('BROWSER_SESSION_INVALID');
    const existing = this.db.prepare('SELECT * FROM browser_sessions WHERE owner=? AND id=?').get(owner, id);
    if (existing) return { session: sessionFromRow(existing), replayed: true };
    const currentTime = Date.now();
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions WHERE status IN ('creating','active','paused') AND lease_until>? AND expires_at>?").get(new Date(currentTime).toISOString(), new Date(currentTime).toISOString()).count;
    const ownerActive = this.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions WHERE owner=? AND status IN ('creating','active','paused') AND lease_until>? AND expires_at>?").get(owner, new Date(currentTime).toISOString(), new Date(currentTime).toISOString()).count;
    if (active >= maxSessions || ownerActive >= maxOwnerSessions) throw fail('BROWSER_SESSION_LIMIT', 429);
    const created = nowIso();
    const session = { id, owner, harnessSessionId, runId, taskId, profileId, workerId, fence: 1,
      status: 'creating', leaseUntil: new Date(currentTime + leaseMs).toISOString(), createdAt: created,
      updatedAt: created, expiresAt: new Date(currentTime + ttlMs).toISOString() };
    this.db.prepare(`INSERT INTO browser_sessions(id,owner,harness_session_id,run_id,task_id,profile_id,worker_id,fence,status,lease_until,created_at,updated_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, owner, harnessSessionId, runId, taskId, profileId, workerId,
      session.fence, session.status, session.leaseUntil, created, created, session.expiresAt);
    return { session, replayed: false };
  }

  async getSession(owner, id) {
    return sessionFromRow(this.db.prepare('SELECT * FROM browser_sessions WHERE owner=? AND id=?').get(owner, id));
  }

  async listSessions(owner, { limit = 50 } = {}) {
    return this.db.prepare('SELECT * FROM browser_sessions WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(owner, limit).map(sessionFromRow);
  }

  async touchSession({ owner, id, workerId, fence, leaseMs = 60_000 } = {}) {
    const now = Date.now();
    return Boolean(this.db.prepare(`UPDATE browser_sessions SET lease_until=?,updated_at=?
      WHERE owner=? AND id=? AND worker_id=? AND fence=? AND status='active' AND expires_at>?`)
      .run(new Date(now + leaseMs).toISOString(), new Date(now).toISOString(), owner, id, workerId,
        fence, new Date(now).toISOString()).changes);
  }

  async transitionSession({ owner, id, workerId, fence, status, reason = null } = {}) {
    if (!SESSION_STATUSES.has(status)) throw fail('BROWSER_SESSION_STATUS_INVALID');
    const now = nowIso();
    const update = this.db.prepare(`UPDATE browser_sessions SET status=?,updated_at=?,lease_until=?
      WHERE owner=? AND id=? AND worker_id=? AND fence=?`)
      .run(status, now, status === 'active' || status === 'paused' ? new Date(Date.now() + 60_000).toISOString() : now,
        owner, id, workerId, fence);
    const session = await this.getSession(owner, id);
    if (!update.changes || !session) throw fail('BROWSER_SESSION_FENCE_LOST', 409);
    if (reason) await this.appendEvent({ owner, sessionId: id, type: 'browser.session.transitioned', payload: { status, reason } });
    return session;
  }

  async closeSession(owner, id) {
    const now = nowIso();
    this.db.prepare("UPDATE browser_sessions SET status='closed',updated_at=?,lease_until=? WHERE owner=? AND id=?")
      .run(now, now, owner, id);
    return { closed: true };
  }

  async recoverExpired() {
    const now = new Date().toISOString();
    const expired = this.db.prepare("SELECT id,owner FROM browser_sessions WHERE status IN ('creating','active','paused') AND (lease_until<=? OR expires_at<=?)")
      .all(now, now);
    for (const item of expired) {
      this.db.prepare("UPDATE browser_sessions SET status='lost',updated_at=? WHERE owner=? AND id=? AND status IN ('creating','active','paused')")
        .run(now, item.owner, item.id);
      await this.invalidateUndispatched(item.owner, item.id, 'BROWSER_SESSION_EXPIRED');
      await this.markRunningUnknown(item.owner, item.id);
    }
    return expired.length;
  }

  async recoverPreviousWorkers(workerId) {
    const now = nowIso();
    const old = this.db.prepare("SELECT id,owner FROM browser_sessions WHERE worker_id<>? AND status IN ('creating','active','paused')")
      .all(workerId);
    for (const item of old) {
      this.db.prepare("UPDATE browser_sessions SET status='lost',updated_at=?,lease_until=? WHERE owner=? AND id=?")
        .run(now, now, item.owner, item.id);
      await this.invalidateUndispatched(item.owner, item.id, 'BROWSER_SESSION_INTERRUPTED');
      await this.markRunningUnknown(item.owner, item.id);
    }
    return old.length;
  }

  async hasUnknownCommandForRun(runId) {
    return Boolean(this.db.prepare(`SELECT 1 AS found FROM browser_commands c
      JOIN browser_sessions s ON s.owner=c.owner AND s.id=c.session_id
      WHERE s.run_id=? AND c.status='unknown' LIMIT 1`).get(runId));
  }

  async enqueueCommand({ id, owner, sessionId, idempotencyKey, requestHash, request, requiresApproval = false } = {}) {
    if (![id, owner, sessionId, idempotencyKey].every(value => typeof value === 'string' && SAFE_ID.test(value)) ||
      typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(requestHash)) throw fail('BROWSER_COMMAND_INVALID');
    const existing = this.db.prepare('SELECT * FROM browser_commands WHERE owner=? AND session_id=? AND idempotency_key=?')
      .get(owner, sessionId, idempotencyKey);
    if (existing) {
      if (existing.request_hash !== requestHash) throw fail('BROWSER_IDEMPOTENCY_CONFLICT', 409);
      return { command: commandFromRow(existing), replayed: true };
    }
    const created = nowIso();
    const status = requiresApproval ? 'pending_approval' : 'ready';
    this.db.prepare(`INSERT INTO browser_commands(id,owner,session_id,idempotency_key,request_hash,status,request,result,requires_approval,
      approval_decision,approved_at,worker_id,fence,started_at,finished_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?)`)
      .run(id, owner, sessionId, idempotencyKey, requestHash, status, json(request, 'browser_request'), null,
        requiresApproval ? 1 : 0, created, created);
    return { command: commandFromRow(this.db.prepare('SELECT * FROM browser_commands WHERE id=?').get(id)), replayed: false };
  }

  async getCommand(owner, id) {
    return commandFromRow(this.db.prepare('SELECT * FROM browser_commands WHERE owner=? AND id=?').get(owner, id));
  }

  async commands(owner, sessionId, limit = 100) {
    return this.db.prepare('SELECT * FROM browser_commands WHERE owner=? AND session_id=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(owner, sessionId, limit).map(commandFromRow);
  }

  async nextReadyCommand(owner, sessionId) {
    return commandFromRow(this.db.prepare("SELECT * FROM browser_commands WHERE owner=? AND session_id=? AND status='ready' ORDER BY created_at,id LIMIT 1")
      .get(owner, sessionId));
  }

  async approveCommand({ owner, id, decision, requestHash } = {}) {
    if (!['approve', 'reject'].includes(decision) || typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(requestHash)) throw fail('BROWSER_DECISION_INVALID');
    const command = await this.getCommand(owner, id);
    if (!command) throw fail('BROWSER_COMMAND_NOT_FOUND', 404);
    if (command.requestHash !== requestHash) throw fail('BROWSER_REQUEST_HASH_MISMATCH', 409);
    if (command.status !== 'pending_approval') {
      if (command.approvalDecision === decision && command.requestHash === requestHash) return command;
      throw fail('BROWSER_COMMAND_ALREADY_DECIDED', 409);
    }
    const now = nowIso();
    const status = decision === 'approve' ? 'ready' : 'rejected';
    const updated = this.db.prepare(`UPDATE browser_commands SET status=?,approval_decision=?,approved_at=?,updated_at=?
      WHERE owner=? AND id=? AND status='pending_approval' AND request_hash=?`)
      .run(status, decision, decision === 'approve' ? now : null, now, owner, id, requestHash);
    if (!updated.changes) {
      const current = await this.getCommand(owner, id);
      if (current?.approvalDecision === decision && current.requestHash === requestHash) return current;
      throw fail('BROWSER_COMMAND_ALREADY_DECIDED', 409);
    }
    return await this.getCommand(owner, id);
  }

  async beginCommand({ owner, id, sessionId, workerId, fence } = {}) {
    const session = await this.getSession(owner, sessionId);
    if (!session || session.status !== 'active' || session.workerId !== workerId || session.fence !== fence) return undefined;
    const now = nowIso();
    const result = this.db.prepare(`UPDATE browser_commands SET status='running',worker_id=?,fence=?,started_at=?,updated_at=?
      WHERE owner=? AND id=? AND session_id=? AND status='ready'`)
      .run(workerId, fence, now, now, owner, id, sessionId);
    return result.changes ? await this.getCommand(owner, id) : undefined;
  }

  async finishCommand({ owner, id, workerId, fence, status, result } = {}) {
    if (!COMMAND_STATUSES.has(status) || ['pending_approval', 'ready', 'running'].includes(status)) throw fail('BROWSER_COMMAND_STATUS_INVALID');
    const now = nowIso();
    const updated = this.db.prepare(`UPDATE browser_commands SET status=?,result=?,finished_at=?,updated_at=?
      WHERE owner=? AND id=? AND worker_id=? AND fence=? AND status='running'`)
      .run(status, json(result ?? null, 'browser_result'), now, now, owner, id, workerId, fence);
    if (updated.changes) return await this.getCommand(owner, id);
    const existing = await this.getCommand(owner, id);
    if (existing && TERMINAL_COMMAND_STATUSES.has(existing.status)) return existing;
    throw fail('BROWSER_COMMAND_FENCE_LOST', 409);
  }

  async appendEvent({ owner, sessionId, type, payload = {} } = {}) {
    if (![owner, sessionId, type].every(value => typeof value === 'string' && SAFE_ID.test(value))) throw fail('BROWSER_EVENT_INVALID');
    const created = nowIso();
    const inserted = this.db.prepare('INSERT INTO browser_events(owner,session_id,type,payload,created_at) VALUES(?,?,?,?,?)')
      .run(owner, sessionId, type, json(payload, 'browser_event'), created);
    return { id: Number(inserted.lastInsertRowid), sessionId, type, payload, createdAt: created };
  }

  async events(owner, sessionId, after = 0, limit = 100) {
    return this.db.prepare('SELECT * FROM browser_events WHERE owner=? AND session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(owner, sessionId, after, limit).map(eventFromRow);
  }

  async metrics(owner) {
    const rows = this.db.prepare('SELECT status,COUNT(*) AS count FROM browser_sessions WHERE owner=? GROUP BY status').all(owner);
    return Object.fromEntries([...SESSION_STATUSES].map(status => [status, Number(rows.find(row => row.status === status)?.count ?? 0)]));
  }

  async rejectUndispatchedForRun(owner, runId, reason = 'BROWSER_MANUAL_TAKEOVER') {
    const sessions = this.db.prepare("SELECT id FROM browser_sessions WHERE owner=? AND run_id=? AND status IN ('active','paused')")
      .all(owner, runId);
    let count = 0;
    for (const { id } of sessions) count += await this.invalidateUndispatched(owner, id, reason);
    return count;
  }

  async invalidateUndispatched(owner, sessionId, reason) {
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`UPDATE browser_commands SET status='rejected',approval_decision='reject',approved_at=NULL,
        result=?,finished_at=?,updated_at=? WHERE owner=? AND session_id=? AND status IN ('pending_approval','ready')`)
        .run(json({ code: reason, executed: false, requiresFreshObservation: true }, 'browser_result'), now, now, owner, sessionId);
      this.db.exec('COMMIT');
      return Number(result.changes);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async markRunningUnknown(owner, sessionId) {
    const now = nowIso();
    const result = this.db.prepare(`UPDATE browser_commands SET status='unknown',result=?,finished_at=?,updated_at=?
      WHERE owner=? AND session_id=? AND status='running'`)
      .run(json({ code: 'BROWSER_ACTION_OUTCOME_UNKNOWN', requiresHumanReconciliation: true }, 'browser_result'), now, now, owner, sessionId);
    return Number(result.changes);
  }

  /** ServiceDatabase owns the shared connection and closes it after BrowserRuntime shutdown. */
  async close() {}
}

/** Durable Electron task metadata; model/API credentials are deliberately absent from its schema. */
export class DesktopTaskJournal {
  constructor(database) {
    const db = database?.db ?? database;
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw fail('SQLITE_DATABASE_REQUIRED');
    this.db = db;
  }

  async ready() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_tabs (
        id TEXT PRIMARY KEY, harness_session_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_tasks (
        id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, harness_session_id TEXT NOT NULL, run_id TEXT,
        prompt TEXT NOT NULL, url TEXT NOT NULL, allowed_origins TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, output TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS desktop_tasks_tab_idx ON desktop_tasks(tab_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS desktop_tasks_run_idx ON desktop_tasks(run_id);`);
  }

  ensureTab(tabId, harnessSessionId, title = 'Browser tab') {
    this.db.prepare(`INSERT INTO desktop_tabs(id,harness_session_id,title,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`)
      .run(tabId, harnessSessionId, title, nowIso(), nowIso());
    return this.getTab(tabId);
  }

  getTab(tabId) {
    const row = this.db.prepare('SELECT * FROM desktop_tabs WHERE id=?').get(tabId);
    return row ? { id: row.id, harnessSessionId: row.harness_session_id, title: row.title,
      createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  listTabs() {
    return this.db.prepare('SELECT * FROM desktop_tabs ORDER BY created_at,id').all().map(row => ({ id: row.id,
      harnessSessionId: row.harness_session_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  createTask(task) {
    const now = task.createdAt ?? nowIso();
    this.db.prepare(`INSERT INTO desktop_tasks(id,tab_id,harness_session_id,run_id,prompt,url,allowed_origins,idempotency_key,status,output,error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(task.id, task.tabId, task.harnessSessionId, task.runId ?? null,
      task.prompt, task.url, json(task.allowedOrigins ?? [], 'allowed_origins'), task.idempotencyKey,
      task.status ?? 'submitting', task.output ?? null, task.error ?? null, now, task.updatedAt ?? now);
    return this.getTask(task.id);
  }

  getTask(taskId) {
    return this.#task(this.db.prepare('SELECT * FROM desktop_tasks WHERE id=?').get(taskId));
  }

  getTaskByRunId(runId) {
    return this.#task(this.db.prepare('SELECT * FROM desktop_tasks WHERE run_id=?').get(runId));
  }

  getTaskByKey(key) {
    return this.#task(this.db.prepare('SELECT * FROM desktop_tasks WHERE idempotency_key=?').get(key));
  }

  listTasks({ tabId, limit = 100 } = {}) {
    const rows = tabId
      ? this.db.prepare('SELECT * FROM desktop_tasks WHERE tab_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(tabId, limit)
      : this.db.prepare('SELECT * FROM desktop_tasks ORDER BY created_at DESC,id DESC LIMIT ?').all(limit);
    return rows.map(row => this.#task(row));
  }

  updateTask(taskId, updates) {
    const allowed = new Map([['runId', 'run_id'], ['status', 'status'], ['output', 'output'], ['error', 'error']]);
    const fields = Object.entries(updates).filter(([key, value]) => allowed.has(key) && value !== undefined);
    if (!fields.length) return this.getTask(taskId);
    const columns = fields.map(([key]) => `${allowed.get(key)}=?`).join(',');
    const values = fields.map(([, value]) => value ?? null);
    const result = this.db.prepare(`UPDATE desktop_tasks SET ${columns},updated_at=? WHERE id=?`)
      .run(...values, nowIso(), taskId);
    if (!result.changes) throw fail('DESKTOP_TASK_NOT_FOUND', 404);
    return this.getTask(taskId);
  }

  isTerminal(task) { return TERMINAL_TASK_STATUSES.has(task?.status); }

  #task(row) {
    if (!row) return undefined;
    return { id: row.id, tabId: row.tab_id, harnessSessionId: row.harness_session_id, runId: row.run_id,
      prompt: row.prompt, url: row.url, allowedOrigins: parseJson(row.allowed_origins) ?? [],
      idempotencyKey: row.idempotency_key, status: row.status, output: row.output, error: row.error,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
}

export { TERMINAL_TASK_STATUSES };
