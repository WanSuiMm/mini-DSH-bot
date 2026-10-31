import { readFile } from 'node:fs/promises';

const MAX_JSON_BYTES = 128 * 1024;
const MAX_LEASE_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const QUEUED_COMMAND_LIMIT = 100;
const SESSION_STATUSES = ['creating', 'active', 'paused', 'lost', 'closed'];
const COMMAND_STATUSES = ['pending_approval', 'ready', 'running', 'succeeded', 'failed', 'unknown', 'rejected'];
const QUEUED_STATUSES = ['pending_approval', 'ready', 'running'];
const SAFE_IDENTIFIER = /^[\x21-\x7e]{1,256}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function storeError(status, message) {
  return Object.assign(new Error(message), { status });
}

function databaseError(error) {
  if (Number.isInteger(error?.status)) return error;
  if (error?.code === '23505') return storeError(409, 'This browser record conflicts with an existing record.');
  return storeError(503, 'Browser persistence is temporarily unavailable.');
}

function identifier(name, value) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw storeError(400, `Invalid ${name}.`);
  }
  return value;
}

function optionalIdentifier(name, value) {
  return value === null || value === undefined ? null : identifier(name, value);
}

function integer(name, value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw storeError(400, `Invalid ${name}.`);
  }
  return value;
}

function jsonText(name, value, { nullable = false } = {}) {
  if (value === undefined && nullable) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw storeError(400, `Invalid ${name}.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
    throw storeError(400, `${name} must be valid JSON of at most 128 KiB.`);
  }
  try {
    JSON.parse(serialized);
  } catch {
    throw storeError(400, `Invalid ${name}.`);
  }
  return serialized;
}

function jsonValue(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sessionRecord(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    owner: row.owner,
    harnessSessionId: row.harness_session_id,
    runId: row.run_id,
    taskId: row.task_id,
    profileId: row.profile_id,
    workerId: row.worker_id,
    fence: Number(row.fence),
    status: row.status,
    leaseUntil: iso(row.lease_until),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
  };
}

function commandRecord(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    owner: row.owner,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    request: jsonValue(row.request),
    result: jsonValue(row.result),
    requiresApproval: row.requires_approval,
    approvalDecision: row.approval_decision,
    approvedAt: iso(row.approved_at),
    workerId: row.worker_id,
    fence: row.fence === null ? null : Number(row.fence),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventRecord(row) {
  if (!row) return undefined;
  const id = Number(row.seq);
  if (!Number.isSafeInteger(id)) throw storeError(503, 'The event cursor is outside the supported range.');
  return { id, sessionId: row.session_id, type: row.type, payload: jsonValue(row.payload), createdAt: iso(row.created_at) };
}

function statusCountObject(statuses, rows) {
  const result = Object.fromEntries(statuses.map(status => [status, 0]));
  for (const row of rows) result[row.status] = Number(row.count);
  return result;
}

/** Durable owner-scoped browser sessions and command queue. */
export class PostgresBrowserStore {
  #readyPromise;

  static async connect(connectionString, { max = 5 } = {}) {
    if (typeof connectionString !== 'string' || !connectionString.trim()) {
      throw storeError(400, 'A PostgreSQL connection string is required.');
    }
    integer('pool size', max, 1, 100);
    let Pool;
    try {
      ({ Pool } = await import('pg'));
    } catch {
      throw storeError(503, 'The PostgreSQL driver is unavailable.');
    }
    let pool;
    try {
      pool = new Pool({ connectionString, max, application_name: 'mini-dsh-browser-store' });
    } catch {
      throw storeError(400, 'Invalid PostgreSQL connection settings.');
    }
    const store = new PostgresBrowserStore(pool);
    try {
      await store.ready();
      return store;
    } catch (error) {
      await pool.end().catch(() => {});
      throw databaseError(error);
    }
  }

  constructor(pool, { runtimeLockName = 'mini-dsh-browser-runtime' } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw storeError(400, 'A PostgreSQL pool is required.');
    }
    if (typeof runtimeLockName !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runtimeLockName)) throw storeError(400, 'Invalid browser runtime lock name.');
    this.pool = pool;
    this.kind = 'postgresql';
    this.runtimeLockClient = undefined;
    this.runtimeLockName = runtimeLockName;
  }

  async acquireRuntimeLock() {
    if (this.runtimeLockClient) return true;
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [this.runtimeLockName]);
      if (result.rows[0]?.acquired !== true) throw storeError(503, 'Another browser service process already owns the database lease.');
      this.runtimeLockClient = client;
      return true;
    } catch (error) {
      if (this.runtimeLockClient !== client) client.release();
      throw databaseError(error);
    }
  }

  async ready() {
    if (!this.#readyPromise) {
      this.#readyPromise = (async () => {
        const sql = await readFile(new URL('./001_browser.sql', import.meta.url), 'utf8');
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mini-dsh-browser-schema', 0))");
          await client.query(sql);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      })().catch(error => {
        this.#readyPromise = undefined;
        throw databaseError(error);
      });
    }
    return this.#readyPromise;
  }

  async #query(sql, values = []) {
    await this.ready();
    try {
      return await this.pool.query(sql, values);
    } catch (error) {
      throw databaseError(error);
    }
  }

  async #transaction(work) {
    await this.ready();
    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw databaseError(error);
    } finally {
      client?.release();
    }
  }

  async #ownedSession(client, owner, id, { lock = false } = {}) {
    const row = (await client.query(
      `SELECT * FROM browser_sessions WHERE owner=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [owner, id],
    )).rows[0];
    if (!row) throw storeError(404, 'Browser session was not found.');
    return row;
  }

  async #insertEvent(client, owner, sessionId, type, payloadText) {
    const row = (await client.query(
      'INSERT INTO browser_events(owner,session_id,type,payload,created_at) VALUES($1,$2,$3,$4::jsonb,NOW()) RETURNING seq,session_id,type,payload,created_at',
      [owner, sessionId, type, payloadText],
    )).rows[0];
    return eventRecord(row);
  }

  async createSession({ id, owner, harnessSessionId, runId, taskId, profileId = null, workerId, leaseMs = 60_000, ttlMs = 1_800_000, maxSessions = 4, maxOwnerSessions = 2 } = {}) {
    identifier('session id', id);
    identifier('owner', owner);
    identifier('harness session id', harnessSessionId);
    identifier('run id', runId);
    identifier('task id', taskId);
    optionalIdentifier('profile id', profileId);
    identifier('worker id', workerId);
    integer('lease duration', leaseMs, 1, MAX_LEASE_MS);
    integer('session lifetime', ttlMs, 1, MAX_TTL_MS);
    integer('global session limit', maxSessions, 1, 100_000);
    integer('owner session limit', maxOwnerSessions, 1, 100_000);

    return this.#transaction(async client => {
      // A single transaction lock makes global and owner quota checks atomic.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mini-dsh-browser-session-quota', 0))");
      const prior = (await client.query('SELECT * FROM browser_sessions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (prior) {
        if (prior.owner !== owner) throw storeError(404, 'Browser session was not found.');
        const sameIdentity = prior.harness_session_id === harnessSessionId && prior.run_id === runId &&
          prior.task_id === taskId && prior.profile_id === profileId && prior.worker_id === workerId;
        if (!sameIdentity) throw storeError(409, 'Session id was already used for a different browser identity.');
        return { session: sessionRecord(prior), replayed: true };
      }

      if (profileId !== null) {
        const profileOwner = (await client.query(
          `SELECT id FROM browser_sessions
           WHERE owner=$1 AND profile_id=$2 AND status IN ('creating','active','paused')
             AND lease_until>NOW() AND expires_at>NOW()
           ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
          [owner, profileId],
        )).rows[0];
        if (profileOwner) throw storeError(409, 'This browser profile already has an active session.');
      }

      const counts = (await client.query(
        `SELECT COUNT(*) FILTER (WHERE owner=$1) AS owner_count, COUNT(*) AS global_count
         FROM browser_sessions
         WHERE status IN ('creating','active','paused') AND lease_until>NOW() AND expires_at>NOW()`,
        [owner],
      )).rows[0];
      if (Number(counts.global_count) >= maxSessions || Number(counts.owner_count) >= maxOwnerSessions) {
        throw storeError(429, 'Browser session capacity is full.');
      }

      const row = (await client.query(
        `INSERT INTO browser_sessions
          (id,owner,harness_session_id,run_id,task_id,profile_id,worker_id,fence,status,lease_until,created_at,updated_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,1,'creating',
           LEAST(NOW()+($8 * INTERVAL '1 millisecond'),NOW()+($9 * INTERVAL '1 millisecond')),
           NOW(),NOW(),NOW()+($9 * INTERVAL '1 millisecond')) RETURNING *`,
        [id, owner, harnessSessionId, runId, taskId, profileId, workerId, leaseMs, ttlMs],
      )).rows[0];
      return { session: sessionRecord(row), replayed: false };
    });
  }

  async getSession(owner, id) {
    identifier('owner', owner);
    identifier('session id', id);
    return sessionRecord((await this.#query('SELECT * FROM browser_sessions WHERE owner=$1 AND id=$2', [owner, id])).rows[0]);
  }

  async listSessions(owner, { limit = 50 } = {}) {
    identifier('owner', owner);
    integer('page size', limit, 1, 200);
    const rows = (await this.#query(
      'SELECT * FROM browser_sessions WHERE owner=$1 ORDER BY created_at DESC,id DESC LIMIT $2', [owner, limit],
    )).rows;
    return rows.map(sessionRecord);
  }

  async touchSession({ owner, id, workerId, fence, leaseMs = 60_000 } = {}) {
    identifier('owner', owner);
    identifier('session id', id);
    identifier('worker id', workerId);
    integer('fence', fence, 1, 2_147_483_647);
    integer('lease duration', leaseMs, 1, MAX_LEASE_MS);
    const result = await this.#query(
      `UPDATE browser_sessions
       SET lease_until=LEAST(NOW()+($5 * INTERVAL '1 millisecond'),expires_at),updated_at=NOW()
       WHERE owner=$1 AND id=$2 AND worker_id=$3 AND fence=$4
         AND status IN ('creating','active') AND lease_until>NOW() AND expires_at>NOW()`,
      [owner, id, workerId, fence, leaseMs],
    );
    return result.rowCount === 1;
  }

  async transitionSession({ owner, id, workerId, fence, status, reason = null } = {}) {
    identifier('owner', owner);
    identifier('session id', id);
    identifier('worker id', workerId);
    integer('fence', fence, 1, 2_147_483_647);
    if (!SESSION_STATUSES.includes(status)) throw storeError(400, 'Invalid browser session status.');
    if (reason !== null && (typeof reason !== 'string' || reason.length > 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(reason))) {
      throw storeError(400, 'Invalid transition reason.');
    }

    return this.#transaction(async client => {
      const prior = (await client.query(
        `SELECT *, (lease_until>NOW() AND expires_at>NOW()) AS lease_valid
         FROM browser_sessions WHERE owner=$1 AND id=$2 FOR UPDATE`, [owner, id],
      )).rows[0];
      if (!prior) throw storeError(404, 'Browser session was not found.');
      if (prior.worker_id !== workerId || Number(prior.fence) !== fence || !prior.lease_valid) {
        throw storeError(409, 'Browser session lease is no longer valid.');
      }
      if (['lost', 'closed'].includes(prior.status) && prior.status !== status) {
        throw storeError(409, 'Browser session is already terminal.');
      }
      const allowed = {
        creating: ['creating', 'active', 'paused', 'lost', 'closed'],
        active: ['active', 'paused', 'lost', 'closed'],
        paused: ['paused', 'active', 'lost', 'closed'],
        lost: ['lost'],
        closed: ['closed'],
      };
      if (!allowed[prior.status].includes(status)) throw storeError(409, 'Invalid browser session transition.');
      const row = (await client.query(
        'UPDATE browser_sessions SET status=$3,updated_at=NOW() WHERE owner=$1 AND id=$2 RETURNING *',
        [owner, id, status],
      )).rows[0];
      if (status === 'lost' || status === 'closed') {
        await client.query(
          `UPDATE browser_commands SET status='unknown',
             result=jsonb_build_object('code','BROWSER_ACTION_OUTCOME_UNKNOWN','requiresHumanReconciliation',true),
             finished_at=NOW(),updated_at=NOW()
           WHERE owner=$1 AND session_id=$2 AND status='running'`, [owner, id],
        );
        await client.query(
          `UPDATE browser_commands SET status='rejected',
             result=jsonb_build_object('code',$3,'executed',false),finished_at=NOW(),updated_at=NOW()
           WHERE owner=$1 AND session_id=$2 AND status IN ('pending_approval','ready')`,
          [owner, id, status === 'closed' ? 'BROWSER_SESSION_CLOSED' : 'BROWSER_SESSION_LOST'],
        );
      }
      if (prior.status !== status || reason !== null) {
        const payload = jsonText('event payload', { from: prior.status, to: status, ...(reason === null ? {} : { reason }) });
        await this.#insertEvent(client, owner, id, 'session.transition', payload);
      }
      return sessionRecord(row);
    });
  }

  async closeSession(owner, id) {
    identifier('owner', owner);
    identifier('session id', id);
    return this.#transaction(async client => {
      const prior = await this.#ownedSession(client, owner, id, { lock: true });
      if (prior.status !== 'closed') {
        const row = (await client.query(
          "UPDATE browser_sessions SET status='closed',updated_at=NOW() WHERE owner=$1 AND id=$2 RETURNING *", [owner, id],
        )).rows[0];
        await client.query(
          `UPDATE browser_commands SET status='unknown',
             result=jsonb_build_object('code','BROWSER_ACTION_OUTCOME_UNKNOWN','requiresHumanReconciliation',true,'reason','session_closed'),
             finished_at=NOW(),updated_at=NOW()
           WHERE owner=$1 AND session_id=$2 AND status='running'`, [owner, id],
        );
        await client.query(
          `UPDATE browser_commands SET status='rejected',result=jsonb_build_object('code','BROWSER_SESSION_CLOSED'),
             finished_at=NOW(),updated_at=NOW()
           WHERE owner=$1 AND session_id=$2 AND status IN ('pending_approval','ready')`, [owner, id],
        );
        await this.#insertEvent(client, owner, id, 'session.closed', jsonText('event payload', {}));
        return sessionRecord(row);
      }
      return sessionRecord(prior);
    });
  }

  async recoverExpired() {
    return this.#transaction(async client => {
      const sessions = (await client.query(
        `WITH expired AS (
           SELECT id FROM browser_sessions
           WHERE status IN ('creating','active','paused') AND (lease_until<=NOW() OR expires_at<=NOW())
           ORDER BY lease_until,id FOR UPDATE SKIP LOCKED
         )
         UPDATE browser_sessions AS bs
         SET status='lost',updated_at=NOW()
         FROM expired WHERE bs.id=expired.id
         RETURNING bs.*`,
      )).rows;
      if (sessions.length === 0) return { sessions: [], commands: [] };
      const sessionIds = sessions.map(row => row.id);
      const commands = (await client.query(
        `UPDATE browser_commands SET status='unknown',
           result=jsonb_build_object('code','BROWSER_ACTION_OUTCOME_UNKNOWN','requiresHumanReconciliation',true,'reason','lease_expired'),
           finished_at=NOW(),updated_at=NOW()
         WHERE session_id=ANY($1::text[]) AND status='running' RETURNING *`, [sessionIds],
      )).rows;
      const invalidated = (await client.query(
        `UPDATE browser_commands SET status='rejected',
           result=jsonb_build_object('code','BROWSER_SESSION_EXPIRED','executed',false),
           finished_at=NOW(),updated_at=NOW()
         WHERE session_id=ANY($1::text[]) AND status IN ('pending_approval','ready') RETURNING *`, [sessionIds],
      )).rows;
      for (const row of sessions) {
        await this.#insertEvent(client, row.owner, row.id, 'session.recovered_lost',
          jsonText('event payload', { reason: 'lease_expired' }));
      }
      for (const row of [...commands, ...invalidated]) {
        await this.#insertEvent(client, row.owner, row.session_id,
          row.status === 'unknown' ? 'command.recovered_unknown' : 'command.recovered_rejected',
          jsonText('event payload', { commandId: row.id, reason: 'lease_expired' }));
      }
      return { sessions: sessions.map(sessionRecord), commands: [...commands, ...invalidated].map(commandRecord) };
    });
  }

  async recoverPreviousWorkers(workerId) {
    identifier('worker id', workerId);
    return this.#transaction(async client => {
      const sessions = (await client.query(
        `SELECT * FROM browser_sessions
         WHERE status IN ('creating','active','paused') AND worker_id<>$1
         ORDER BY lease_until,id FOR UPDATE SKIP LOCKED`, [workerId],
      )).rows;
      if (!sessions.length) return { sessions: [], commands: [] };
      const sessionIds = sessions.map(row => row.id);
      const recoveredSessions = [];
      for (const row of sessions) {
        const updated = (await client.query(
          "UPDATE browser_sessions SET status='lost',updated_at=NOW() WHERE id=$1 AND worker_id<>$2 RETURNING *", [row.id, workerId],
        )).rows[0];
        if (updated) recoveredSessions.push(updated);
        await this.#insertEvent(client, row.owner, row.id, 'session.recovered_lost',
          jsonText('event payload', { reason: 'service_restart' }));
      }
      const commands = (await client.query(
        `UPDATE browser_commands SET
           status=CASE WHEN status='running' THEN 'unknown' ELSE 'rejected' END,
           result=CASE WHEN status='running'
             THEN jsonb_build_object('code','BROWSER_ACTION_OUTCOME_UNKNOWN','requiresHumanReconciliation',true,'reason','service_restart')
             ELSE jsonb_build_object('code','BROWSER_APPROVAL_INVALIDATED_BY_RESTART','executed',false) END,
           finished_at=NOW(),updated_at=NOW()
         WHERE session_id=ANY($1::text[]) AND status IN ('running','pending_approval','ready') RETURNING *`, [sessionIds],
      )).rows;
      for (const row of commands) {
        await this.#insertEvent(client, row.owner, row.session_id,
          row.status === 'unknown' ? 'command.recovered_unknown' : 'command.approval_invalidated',
          jsonText('event payload', { commandId: row.id, reason: 'service_restart' }));
      }
      return { sessions: recoveredSessions.map(sessionRecord), commands: commands.map(commandRecord) };
    });
  }

  async hasUnknownCommandForRun(runId) {
    identifier('run id', runId);
    const result = await this.#query(
      `SELECT 1 FROM browser_commands AS bc
       JOIN browser_sessions AS bs ON bs.owner=bc.owner AND bs.id=bc.session_id
       WHERE bs.run_id=$1 AND bc.status='unknown' LIMIT 1`, [runId],
    );
    return result.rowCount > 0;
  }

  async enqueueCommand({ id, owner, sessionId, idempotencyKey, requestHash, request, requiresApproval = false } = {}) {
    identifier('command id', id);
    identifier('owner', owner);
    identifier('session id', sessionId);
    identifier('idempotency key', idempotencyKey);
    if (typeof requestHash !== 'string' || !HASH.test(requestHash)) throw storeError(400, 'Invalid request hash.');
    if (typeof requiresApproval !== 'boolean') throw storeError(400, 'Invalid approval requirement.');
    const requestJson = jsonText('request', request);

    return this.#transaction(async client => {
      const session = await this.#ownedSession(client, owner, sessionId, { lock: true });
      const prior = (await client.query(
        'SELECT * FROM browser_commands WHERE owner=$1 AND session_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [owner, sessionId, idempotencyKey],
      )).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw storeError(409, 'Idempotency key was used with a different request.');
        return { command: commandRecord(prior), replayed: true };
      }
      const leaseValid = (await client.query(
        'SELECT (lease_until>NOW() AND expires_at>NOW()) AS valid FROM browser_sessions WHERE id=$1', [sessionId],
      )).rows[0]?.valid;
      if (!leaseValid || ['lost', 'closed'].includes(session.status)) {
        throw storeError(409, 'Browser session is no longer accepting commands.');
      }
      const queued = (await client.query(
        `SELECT COUNT(*) AS count FROM browser_commands
         WHERE owner=$1 AND session_id=$2 AND status=ANY($3::text[])`, [owner, sessionId, QUEUED_STATUSES],
      )).rows[0];
      if (Number(queued.count) >= QUEUED_COMMAND_LIMIT) throw storeError(429, 'Browser command queue is full.');

      const status = requiresApproval ? 'pending_approval' : 'ready';
      const row = (await client.query(
        `INSERT INTO browser_commands
          (id,owner,session_id,idempotency_key,request_hash,status,request,result,requires_approval,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,NULL,$8,NOW(),NOW()) RETURNING *`,
        [id, owner, sessionId, idempotencyKey, requestHash, status, requestJson, requiresApproval],
      )).rows[0];
      return { command: commandRecord(row), replayed: false };
    });
  }

  async getCommand(owner, id) {
    identifier('owner', owner);
    identifier('command id', id);
    return commandRecord((await this.#query('SELECT * FROM browser_commands WHERE owner=$1 AND id=$2', [owner, id])).rows[0]);
  }

  async commands(owner, sessionId, limit = 50) {
    identifier('owner', owner);
    identifier('session id', sessionId);
    integer('page size', limit, 1, 200);
    const session = await this.#query('SELECT id FROM browser_sessions WHERE owner=$1 AND id=$2', [owner, sessionId]);
    if (!session.rows[0]) throw storeError(404, 'Browser session was not found.');
    const rows = (await this.#query(
      'SELECT * FROM browser_commands WHERE owner=$1 AND session_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3',
      [owner, sessionId, limit],
    )).rows;
    return rows.map(commandRecord);
  }

  async nextReadyCommand(owner, sessionId) {
    identifier('owner', owner);
    identifier('session id', sessionId);
    const session = await this.#query('SELECT id FROM browser_sessions WHERE owner=$1 AND id=$2', [owner, sessionId]);
    if (!session.rows[0]) throw storeError(404, 'Browser session was not found.');
    const row = (await this.#query(
      "SELECT * FROM browser_commands WHERE owner=$1 AND session_id=$2 AND status='ready' ORDER BY created_at,id LIMIT 1",
      [owner, sessionId],
    )).rows[0];
    return commandRecord(row);
  }

  async approveCommand({ owner, id, decision, requestHash } = {}) {
    identifier('owner', owner);
    identifier('command id', id);
    if (!['approve', 'reject'].includes(decision)) throw storeError(400, 'Invalid approval decision.');
    if (typeof requestHash !== 'string' || !HASH.test(requestHash)) throw storeError(400, 'Invalid request hash.');

    return this.#transaction(async client => {
      const row = (await client.query('SELECT * FROM browser_commands WHERE owner=$1 AND id=$2 FOR UPDATE', [owner, id])).rows[0];
      if (!row) throw storeError(404, 'Browser command was not found.');
      if (row.request_hash !== requestHash) throw storeError(409, 'Approval request hash does not match the command.');
      if (row.approval_decision === decision) return commandRecord(row);
      if (row.approval_decision !== null) throw storeError(409, 'Browser command already has a different approval decision.');
      if (row.status !== 'pending_approval' || !row.requires_approval) {
        throw storeError(409, 'Browser command is not awaiting approval.');
      }
      const nextStatus = decision === 'approve' ? 'ready' : 'rejected';
      const updated = (await client.query(
        `UPDATE browser_commands SET status=$3,approval_decision=$4,
           approved_at=CASE WHEN $4='approve' THEN NOW() ELSE NULL END,updated_at=NOW()
         WHERE owner=$1 AND id=$2 RETURNING *`, [owner, id, nextStatus, decision],
      )).rows[0];
      return commandRecord(updated);
    });
  }

  async beginCommand({ owner, id, sessionId, workerId, fence } = {}) {
    identifier('owner', owner);
    identifier('command id', id);
    identifier('session id', sessionId);
    identifier('worker id', workerId);
    integer('fence', fence, 1, 2_147_483_647);

    return this.#transaction(async client => {
      const session = (await client.query(
        `SELECT *, (lease_until>NOW() AND expires_at>NOW()) AS lease_valid
         FROM browser_sessions WHERE owner=$1 AND id=$2 FOR UPDATE`, [owner, sessionId],
      )).rows[0];
      if (!session) throw storeError(404, 'Browser session was not found.');
      if (session.status !== 'active' || !session.lease_valid || session.worker_id !== workerId || Number(session.fence) !== fence) {
        return undefined;
      }
      const command = (await client.query(
        'SELECT * FROM browser_commands WHERE owner=$1 AND id=$2 AND session_id=$3 FOR UPDATE', [owner, id, sessionId],
      )).rows[0];
      if (!command || command.status !== 'ready') return undefined;
      const running = (await client.query(
        "SELECT id FROM browser_commands WHERE owner=$1 AND session_id=$2 AND status='running' LIMIT 1", [owner, sessionId],
      )).rows[0];
      if (running) return undefined;
      const updated = (await client.query(
        `UPDATE browser_commands SET status='running',worker_id=$3,fence=$4,started_at=NOW(),finished_at=NULL,updated_at=NOW()
         WHERE owner=$1 AND id=$2 AND status='ready' RETURNING *`, [owner, id, workerId, fence],
      )).rows[0];
      return commandRecord(updated);
    });
  }

  async finishCommand({ owner, id, workerId, fence, status, result } = {}) {
    identifier('owner', owner);
    identifier('command id', id);
    identifier('worker id', workerId);
    integer('fence', fence, 1, 2_147_483_647);
    if (!['succeeded', 'failed', 'unknown'].includes(status)) throw storeError(400, 'Invalid terminal command status.');
    const resultJson = jsonText('result', result);

    return this.#transaction(async client => {
      const identity = (await client.query(
        'SELECT session_id FROM browser_commands WHERE owner=$1 AND id=$2', [owner, id],
      )).rows[0];
      if (!identity) throw storeError(404, 'Browser command was not found.');
      const session = (await client.query(
        `SELECT *, (lease_until>NOW() AND expires_at>NOW()) AS lease_valid
         FROM browser_sessions WHERE owner=$1 AND id=$2 FOR UPDATE`, [owner, identity.session_id],
      )).rows[0];
      if (!session) throw storeError(404, 'Browser session was not found.');
      const command = (await client.query(
        'SELECT * FROM browser_commands WHERE owner=$1 AND id=$2 FOR UPDATE', [owner, id],
      )).rows[0];
      if (command.status !== 'running') throw storeError(409, 'Browser command is no longer running.');
      if (!session.lease_valid || session.worker_id !== workerId || Number(session.fence) !== fence ||
          command.worker_id !== workerId || Number(command.fence) !== fence) {
        throw storeError(409, 'Browser command lease is no longer valid.');
      }
      const updated = (await client.query(
        'UPDATE browser_commands SET status=$3,result=$4::jsonb,finished_at=NOW(),updated_at=NOW() WHERE owner=$1 AND id=$2 RETURNING *',
        [owner, id, status, resultJson],
      )).rows[0];
      return commandRecord(updated);
    });
  }

  async appendEvent({ owner, sessionId, type, payload = {} } = {}) {
    identifier('owner', owner);
    identifier('session id', sessionId);
    if (typeof type !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(type)) throw storeError(400, 'Invalid event type.');
    const payloadJson = jsonText('event payload', payload);
    return this.#transaction(async client => {
      await this.#ownedSession(client, owner, sessionId, { lock: true });
      return this.#insertEvent(client, owner, sessionId, type, payloadJson);
    });
  }

  async events(owner, sessionId, after = 0, limit = 100) {
    identifier('owner', owner);
    identifier('session id', sessionId);
    integer('event cursor', after, 0, Number.MAX_SAFE_INTEGER);
    integer('page size', limit, 1, 200);
    const session = await this.#query('SELECT id FROM browser_sessions WHERE owner=$1 AND id=$2', [owner, sessionId]);
    if (!session.rows[0]) throw storeError(404, 'Browser session was not found.');
    const rows = (await this.#query(
      'SELECT seq,session_id,type,payload,created_at FROM browser_events WHERE owner=$1 AND session_id=$2 AND seq>$3 ORDER BY seq LIMIT $4',
      [owner, sessionId, after, limit],
    )).rows;
    return rows.map(eventRecord);
  }

  async metrics(owner) {
    identifier('owner', owner);
    const [sessionRows, commandRows] = await Promise.all([
      this.#query('SELECT status,COUNT(*) AS count FROM browser_sessions WHERE owner=$1 GROUP BY status', [owner]),
      this.#query('SELECT status,COUNT(*) AS count FROM browser_commands WHERE owner=$1 GROUP BY status', [owner]),
    ]);
    return {
      sessions: statusCountObject(SESSION_STATUSES, sessionRows.rows),
      commands: statusCountObject(COMMAND_STATUSES, commandRows.rows),
    };
  }

  async close() {
    if (this.runtimeLockClient) {
      const client = this.runtimeLockClient;
      this.runtimeLockClient = undefined;
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [this.runtimeLockName]).catch(() => {});
      client.release();
    }
    await this.pool.end();
  }
}
