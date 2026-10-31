import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const asIso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const jsonValue = value => typeof value === 'string' ? JSON.parse(value) : value;
const parsedRun = row => row ? { ...row, created: asIso(row.created), updated: asIso(row.updated),
  lease_expires: row.lease_expires ? asIso(row.lease_expires) : null,
  cancel_requested: Boolean(row.cancel_requested), cancel_requested_at: row.cancel_requested_at ? asIso(row.cancel_requested_at) : null,
  request: jsonValue(row.request), result: jsonValue(row.result) } : undefined;
const parsedSession = row => row ? { ...row, created: asIso(row.created) } : undefined;

/** PostgreSQL implementation of the asynchronous service store contract. */
export class PostgresServiceDatabase {
  static async connect(connectionString, { max = 10, applicationName = 'micro-dsh' } = {}) {
    if (typeof connectionString !== 'string' || !connectionString.trim()) throw new Error('PostgreSQL connection string is required');
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString, max, application_name: applicationName });
    const database = new PostgresServiceDatabase(pool);
    await database.migrate();
    return database;
  }

  constructor(pool) { this.pool = pool; this.kind = 'postgresql'; }

  async migrate() {
    const sql = await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8');
    await this.pool.query(sql);
  }

  async session(owner, id) {
    return parsedSession((await this.pool.query('SELECT id,owner,title,created FROM sessions WHERE owner=$1 AND id=$2', [owner, id])).rows[0]);
  }
  async createSession(owner, title) {
    const record = { id: randomUUID(), owner, title, created: new Date().toISOString() };
    await this.pool.query('INSERT INTO sessions(id,owner,title,created) VALUES($1,$2,$3,$4)', [record.id, owner, title, record.created]);
    return record;
  }
  async listSessions(owner) {
    const rows = (await this.pool.query('SELECT id,title,created FROM sessions WHERE owner=$1 ORDER BY created DESC', [owner])).rows;
    return rows.map(row => ({ ...row, created: asIso(row.created) }));
  }
  async sessionRuns(owner, sessionId, limit = 50, before = undefined) {
    const rows = before
      ? (await this.pool.query('SELECT id,status,request,result,created,updated FROM runs WHERE owner=$1 AND session_id=$2 AND created<$3 ORDER BY created DESC,id DESC LIMIT $4', [owner, sessionId, before, limit])).rows
      : (await this.pool.query('SELECT id,status,request,result,created,updated FROM runs WHERE owner=$1 AND session_id=$2 ORDER BY created DESC,id DESC LIMIT $3', [owner, sessionId, limit])).rows;
    return rows.map(row => ({ ...row, request: jsonValue(row.request), result: jsonValue(row.result), created: asIso(row.created), updated: asIso(row.updated) }));
  }
  async findRunByKey(owner, sessionId, key) {
    return (await this.pool.query('SELECT id FROM runs WHERE owner=$1 AND session_id=$2 AND idempotency_key=$3', [owner, sessionId, key])).rows[0];
  }
  async queueSize() {
    return Number((await this.pool.query("SELECT COUNT(*) AS count FROM runs WHERE status='queued'")).rows[0].count);
  }
  async createRun(owner, sessionId, key, input) {
    const serialized = JSON.stringify(input);
    const requestHash = createHash('sha256').update(serialized).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID(); const now = new Date().toISOString();
      const inserted = await client.query(`INSERT INTO runs(id,session_id,owner,status,request,result,idempotency_key,request_hash,created,updated)
        VALUES($1,$2,$3,'queued',$4::jsonb,NULL,$5,$6,$7,$7) ON CONFLICT(session_id,idempotency_key) DO NOTHING RETURNING *`,
      [id, sessionId, owner, serialized, key, requestHash, now]);
      if (inserted.rowCount) {
        await client.query('COMMIT');
        return { run: parsedRun(inserted.rows[0]), replayed: false };
      }
      const existing = (await client.query('SELECT * FROM runs WHERE session_id=$1 AND idempotency_key=$2 FOR UPDATE', [sessionId, key])).rows[0];
      if (!existing || existing.owner !== owner) throw Object.assign(new Error('Session run could not be loaded'), { status: 404 });
      if (existing.request_hash !== requestHash) throw Object.assign(new Error('Idempotency key was used with a different request'), { status: 409 });
      await client.query('COMMIT');
      return { run: parsedRun(existing), replayed: true };
    } catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; }
    finally { client.release(); }
  }
  async getRun(owner, id) { return parsedRun((await this.pool.query('SELECT * FROM runs WHERE owner=$1 AND id=$2', [owner, id])).rows[0]); }
  async pending() {
    const rows = (await this.pool.query("SELECT * FROM runs WHERE status='queued' ORDER BY created,id")).rows;
    return rows.map(parsedRun);
  }
  async interrupted() {
    const rows = (await this.pool.query("SELECT * FROM runs WHERE status='running'")).rows;
    return rows.map(parsedRun);
  }
  async claimNextRun(workerId, leaseMs = 60_000) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = (await client.query("SELECT id FROM runs WHERE status='queued' ORDER BY created,id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!selected) { await client.query('COMMIT'); return undefined; }
      const row = (await client.query(`UPDATE runs SET status='running',lease_owner=$2,lease_expires=NOW()+($3 * INTERVAL '1 millisecond'),updated=NOW()
        WHERE id=$1 AND status='queued' RETURNING *`, [selected.id, workerId, leaseMs])).rows[0];
      await client.query('COMMIT');
      return parsedRun(row);
    } catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; }
    finally { client.release(); }
  }
  async renewRunLease(id, workerId, leaseMs = 60_000) {
    const result = await this.pool.query("UPDATE runs SET lease_expires=NOW()+($3 * INTERVAL '1 millisecond'),updated=NOW() WHERE id=$1 AND status='running' AND lease_owner=$2", [id, workerId, leaseMs]);
    return result.rowCount === 1;
  }
  async cancelQueuedRun(id) {
    const result = await this.pool.query("UPDATE runs SET status='cancelled',cancel_requested=true,cancel_requested_at=COALESCE(cancel_requested_at,NOW()),updated=NOW() WHERE id=$1 AND status='queued'", [id]);
    return result.rowCount === 1;
  }
  async requestRunCancellation(id) {
    const result = await this.pool.query(`UPDATE runs SET
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      cancel_requested=true,cancel_requested_at=COALESCE(cancel_requested_at,NOW()),updated=NOW()
      WHERE id=$1 AND status IN ('queued','running')`, [id]);
    return result.rowCount === 1;
  }
  async isRunCancellationRequested(id) {
    return Boolean((await this.pool.query('SELECT cancel_requested FROM runs WHERE id=$1', [id])).rows[0]?.cancel_requested);
  }
  async setRun(id, status, result = null, workerId = undefined) {
    const terminal = ['succeeded', 'failed', 'partial', 'cancelled', 'timed_out'].includes(status);
    const values = [status, result === null ? null : JSON.stringify(result), terminal, id];
    const ownership = workerId === undefined ? '' : ' AND lease_owner=$5';
    if (workerId !== undefined) values.push(workerId);
    const update = await this.pool.query(`UPDATE runs SET status=$1,result=$2::jsonb,updated=NOW(),
      lease_owner=CASE WHEN $3 THEN NULL ELSE lease_owner END,lease_expires=CASE WHEN $3 THEN NULL ELSE lease_expires END WHERE id=$4${ownership}`, values);
    if (update.rowCount !== 1) throw new Error('Run is no longer owned by this worker');
  }
  async event(runId, type, payload) {
    const row = (await this.pool.query('INSERT INTO events(run_id,type,payload,created) VALUES($1,$2,$3::jsonb,NOW()) RETURNING seq,run_id,type,payload,created', [runId, type, JSON.stringify(payload)])).rows[0];
    return { id: Number(row.seq), runId: row.run_id, type: row.type, payload: jsonValue(row.payload), created: asIso(row.created) };
  }
  async events(runId, after = 0, limit = 1000) {
    const rows = (await this.pool.query('SELECT seq,run_id,type,payload,created FROM events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT $3', [runId, after, limit])).rows;
    return rows.map(row => ({ id: Number(row.seq), runId: row.run_id, type: row.type, payload: jsonValue(row.payload), created: asIso(row.created) }));
  }
  async latestEvent(runId, type) {
    const row = (await this.pool.query('SELECT payload FROM events WHERE run_id=$1 AND type=$2 ORDER BY seq DESC LIMIT 1', [runId, type])).rows[0];
    return row ? jsonValue(row.payload) : undefined;
  }
  taskStore(runId) {
    const pool = this.pool;
    return {
      async create(task) { await pool.query('INSERT INTO tasks(id,run_id,record) VALUES($1,$2,$3::jsonb)', [task.taskId, runId, JSON.stringify(task)]); return structuredClone(task); },
      async get(id) { const row = (await pool.query('SELECT record FROM tasks WHERE id=$1 AND run_id=$2', [id, runId])).rows[0]; return row ? jsonValue(row.record) : undefined; },
      async update(task) { const result = await pool.query('UPDATE tasks SET record=$1::jsonb WHERE id=$2 AND run_id=$3', [JSON.stringify(task), task.taskId, runId]); if (result.rowCount !== 1) throw new Error('Task does not belong to this run'); return structuredClone(task); },
      async delete(id) { return (await pool.query('DELETE FROM tasks WHERE id=$1 AND run_id=$2', [id, runId])).rowCount === 1; },
      async list(query = {}) {
        const rows = (await pool.query('SELECT record FROM tasks WHERE run_id=$1 ORDER BY id', [runId])).rows.map(row => jsonValue(row.record));
        return rows.filter(task => (!query.sessionId || task.sessionId === query.sessionId) && (!query.parentTaskId || task.parentTaskId === query.parentTaskId) && (!query.status || task.status === query.status));
      },
    };
  }
  async memoryList(namespace, query = '') {
    const rows = (await this.pool.query('SELECT record FROM memory WHERE namespace=$1 ORDER BY id', [namespace])).rows.map(row => jsonValue(row.record));
    const now = Date.now();
    return rows.filter(record => !record.expiresAt || Date.parse(record.expiresAt) > now)
      .filter(record => !query || JSON.stringify(record.value).toLowerCase().includes(query.toLowerCase()));
  }
  async memoryPut(namespace, id, value, { ttlMs, sourceRefs = [] } = {}) {
    if (!Number.isSafeInteger(ttlMs ?? 0) || (ttlMs ?? 0) < 0) throw Object.assign(new Error('Invalid memory TTL'), { status: 400 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${namespace}:${id}`]);
      const priorRow = (await client.query('SELECT record FROM memory WHERE namespace=$1 AND id=$2 FOR UPDATE', [namespace, id])).rows[0];
      const previous = priorRow ? jsonValue(priorRow.record) : undefined;
      const now = new Date().toISOString();
      const record = { namespace, id, value, sourceRefs, createdAt: previous?.createdAt ?? now, updatedAt: now,
        version: (previous?.version ?? 0) + 1, ...(ttlMs ? { expiresAt: new Date(Date.now() + ttlMs).toISOString() } : {}) };
      await client.query('INSERT INTO memory(namespace,id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET record=EXCLUDED.record', [namespace, id, JSON.stringify(record)]);
      await client.query('COMMIT');
      return record;
    } catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; }
    finally { client.release(); }
  }
  async memoryDelete(namespace, id) { return (await this.pool.query('DELETE FROM memory WHERE namespace=$1 AND id=$2', [namespace, id])).rowCount === 1; }
  async close() { await this.pool.end(); }
}
