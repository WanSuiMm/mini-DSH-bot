import { DatabaseSync } from 'node:sqlite';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TABLE_COLUMNS = {
  bot_store_meta: ['version'],
  bot_profiles: ['bot_id', 'owner', 'name', 'role', 'instructions', 'enabled', 'deleted', 'created_at', 'updated_at'],
  bot_memory_notes: ['owner', 'bot_id', 'note_id', 'value', 'created_at', 'updated_at'],
  bot_jobs: ['id', 'owner', 'bot_id', 'channel', 'event_id', 'conversation_id', 'text', 'payload_hash', 'status', 'session_id', 'run_id', 'result_text', 'error_code', 'created_at', 'updated_at'],
  bot_sessions: ['owner', 'bot_id', 'channel', 'conversation_id', 'session_id', 'status', 'created_at', 'updated_at'],
  bot_outbox: ['id', 'job_id', 'owner', 'bot_id', 'channel', 'conversation_id', 'text', 'delivery_key', 'status', 'error_code', 'created_at', 'updated_at'],
  bot_schedules: ['schedule_id', 'owner', 'bot_id', 'channel', 'conversation_id', 'text', 'interval_ms', 'anchor_ms', 'next_due_ms', 'enabled', 'created_at', 'updated_at'],
};

const RECOVERY_ERROR = 'restart_during_start';

function fail(code, status = 400, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function stringValue(value, name, max, { allowEmpty = false, multiline = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw fail(`invalid_${name}`);
  }
  if (value.includes('\0') || (!multiline && /[\x00-\x1f\x7f]/u.test(value))) {
    throw fail(`invalid_${name}`);
  }
  if (!allowEmpty && value.trim() !== value) throw fail(`invalid_${name}`);
  return value;
}

function ownerId(value) { return stringValue(value, 'owner', 100); }
function opaqueId(value, name, max = 256) { return stringValue(value, name, max); }
function bodyText(value, name = 'text', max = 12000, allowEmpty = false) {
  return stringValue(value, name, max, { allowEmpty, multiline: true });
}

function instantMs(value, name, defaultNow = false) {
  if (value === undefined && defaultNow) return Date.now();
  if (value instanceof Date) {
    const parsed = value.getTime();
    if (Number.isFinite(parsed)) return parsed;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  } else if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw fail(`invalid_${name}`);
}

function iso(ms) { return new Date(ms).toISOString(); }

function stableDeliveryKey(owner, botId, channel, eventId) {
  const digest = createHash('sha256').update(`${owner}\0${botId}\0${channel}\0${eventId}`).digest('hex');
  return `bot-v1-${digest}`;
}

function rowBot(row) {
  if (!row) return undefined;
  return {
    botId: row.bot_id,
    owner: row.owner,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    enabled: Boolean(row.enabled),
    deleted: Boolean(row.deleted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowJob(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    owner: row.owner,
    botId: row.bot_id,
    channel: row.channel,
    eventId: row.event_id,
    conversationId: row.conversation_id,
    text: row.text,
    status: row.status,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    resultText: row.result_text ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowSession(row) {
  if (!row) return undefined;
  return {
    owner: row.owner,
    botId: row.bot_id,
    channel: row.channel,
    conversationId: row.conversation_id,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowOutbox(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    jobId: row.job_id,
    owner: row.owner,
    botId: row.bot_id,
    channel: row.channel,
    conversationId: row.conversation_id,
    text: row.text,
    deliveryKey: row.delivery_key,
    status: row.status,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowSchedule(row) {
  if (!row) return undefined;
  return {
    scheduleId: row.schedule_id,
    owner: row.owner,
    botId: row.bot_id,
    channel: row.channel,
    conversationId: row.conversation_id,
    text: row.text,
    intervalMs: row.interval_ms,
    anchorAt: iso(row.anchor_ms),
    nextDueAt: iso(row.next_due_ms),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BotStore {
  constructor(filename, { maxPending = 100, maxOwnerPending = 20, maxEvents = 1000 } = {}) {
    for (const [value, name] of [[maxPending, 'max_pending'], [maxOwnerPending, 'max_owner_pending'], [maxEvents, 'max_events']]) {
      if (!Number.isSafeInteger(value) || value < 1) throw fail(`invalid_${name}`);
    }
    if(maxPending>1000||maxOwnerPending>1000||maxEvents>1000000||maxOwnerPending>maxPending)throw fail('store_capacity_limit');
    this.maxPending = maxPending;
    this.maxOwnerPending = maxOwnerPending;
    this.maxEvents = maxEvents;
    this.closed = false;

    const absolute = resolve(filename);
    mkdirSync(dirname(absolute), { recursive: true });
    this.filename = join(realpathSync(dirname(absolute)), basename(absolute));
    if (existsSync(this.filename)) {
      const entry = lstatSync(this.filename);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1) {
        throw fail('unsupported_store_alias', 409);
      }
    }

    this.lockPath = `${this.filename}.owner-lock`;
    this.lockValue = JSON.stringify({ pid: process.pid, instance: randomUUID() });
    try {
      try { this.lock = openSync(this.lockPath, 'wx', 0o600); }
      catch { throw fail('store_locked', 409, 'Store already has an owner; inspect stale locks manually.'); }
      writeFileSync(this.lock, this.lockValue);
      fsyncSync(this.lock);
      this.db = new DatabaseSync(this.filename);
      this.initialize();
      this.recoverInterruptedWork();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  initialize() {
    const names = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map(row => row.name).sort();
    const expected = Object.keys(TABLE_COLUMNS).sort();
    if (names.length && (names.length !== expected.length || names.some((name, index) => name !== expected[index]))) {
      throw fail('foreign_database', 409, 'Choose a new file for the Bot store.');
    }
    if (names.length) {
      for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
        const actual = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
        if (actual.length !== columns.length || actual.some((name, index) => name !== columns[index])) {
          throw fail('store_schema_mismatch', 409);
        }
      }
      const versions = this.db.prepare('SELECT version FROM bot_store_meta').all();
      if (versions.length !== 1 || versions[0].version !== 1) throw fail('store_version_mismatch', 409);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.db.exec('CREATE INDEX IF NOT EXISTS bot_jobs_queue_idx ON bot_jobs(status,created_at,id);');
      this.db.exec('CREATE INDEX IF NOT EXISTS bot_jobs_conversation_idx ON bot_jobs(owner,bot_id,channel,conversation_id,status);');
      this.db.exec('CREATE INDEX IF NOT EXISTS bot_outbox_queue_idx ON bot_outbox(status,created_at,id);');
      this.db.exec('CREATE INDEX IF NOT EXISTS bot_schedules_due_idx ON bot_schedules(enabled,next_due_ms);');
      return;
    }

    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE bot_store_meta(version INTEGER NOT NULL);
        CREATE TABLE bot_profiles(
          bot_id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
          instructions TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
          deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX bot_profiles_owner_name_idx ON bot_profiles(owner,name COLLATE NOCASE);
        CREATE TABLE bot_memory_notes(
          owner TEXT NOT NULL, bot_id TEXT NOT NULL, note_id TEXT NOT NULL, value TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(owner,bot_id,note_id), FOREIGN KEY(bot_id) REFERENCES bot_profiles(bot_id)
        );
        CREATE TABLE bot_sessions(
          owner TEXT NOT NULL, bot_id TEXT NOT NULL, channel TEXT NOT NULL, conversation_id TEXT NOT NULL,
          session_id TEXT, status TEXT NOT NULL CHECK(status IN ('starting','ready','unknown')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(owner,bot_id,channel,conversation_id), UNIQUE(session_id),
          FOREIGN KEY(bot_id) REFERENCES bot_profiles(bot_id)
        );
        CREATE TABLE bot_jobs(
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, bot_id TEXT NOT NULL, channel TEXT NOT NULL,
          event_id TEXT NOT NULL, conversation_id TEXT NOT NULL, text TEXT NOT NULL, payload_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','starting','running','succeeded','failed','unknown','cancelled')),
          session_id TEXT, run_id TEXT, result_text TEXT, error_code TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(owner,bot_id,channel,event_id), FOREIGN KEY(bot_id) REFERENCES bot_profiles(bot_id)
        );
        CREATE TABLE bot_outbox(
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, bot_id TEXT NOT NULL,
          channel TEXT NOT NULL, conversation_id TEXT NOT NULL, text TEXT NOT NULL, delivery_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('pending','delivering','delivered','unknown')),
          error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY(job_id) REFERENCES bot_jobs(id), FOREIGN KEY(bot_id) REFERENCES bot_profiles(bot_id)
        );
        CREATE TABLE bot_schedules(
          schedule_id TEXT PRIMARY KEY, owner TEXT NOT NULL, bot_id TEXT NOT NULL, channel TEXT NOT NULL,
          conversation_id TEXT NOT NULL, text TEXT NOT NULL, interval_ms INTEGER NOT NULL,
          anchor_ms INTEGER NOT NULL, next_due_ms INTEGER NOT NULL,
          enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY(bot_id) REFERENCES bot_profiles(bot_id)
        );
        CREATE INDEX bot_jobs_queue_idx ON bot_jobs(status,created_at,id);
        CREATE INDEX bot_jobs_conversation_idx ON bot_jobs(owner,bot_id,channel,conversation_id,status);
        CREATE INDEX bot_outbox_queue_idx ON bot_outbox(status,created_at,id);
        CREATE INDEX bot_schedules_due_idx ON bot_schedules(enabled,next_due_ms);
        INSERT INTO bot_store_meta(version) VALUES(1);
      `);
    });
  }

  transaction(operation) {
    if (!this.db || this.closed) throw fail('store_closed', 503);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      if (result && typeof result.then === 'function') throw fail('async_transaction_forbidden', 500);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already have been rolled back by SQLite */ }
      throw error;
    }
  }

  recoverInterruptedWork() {
    this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE bot_jobs SET status='unknown',error_code=?,updated_at=? WHERE status='starting'")
        .run(RECOVERY_ERROR, now);
      this.db.prepare("UPDATE bot_sessions SET status='unknown',updated_at=? WHERE status='starting'").run(now);
      this.db.prepare("UPDATE bot_outbox SET status='unknown',error_code='restart_during_delivery',updated_at=? WHERE status='delivering'")
        .run(now);
    });
  }

  assertBot(owner, botId, { active = false, includeDeleted = true } = {}) {
    const row = this.db.prepare('SELECT * FROM bot_profiles WHERE owner=? AND bot_id=?').get(owner, botId);
    if (!row) throw fail('bot_not_found', 404);
    if (active && (!row.enabled || row.deleted)) throw fail('bot_disabled', 409);
    if (!includeDeleted && row.deleted) throw fail('bot_not_found', 404);
    return rowBot(row);
  }

  createBot({ owner, name, role, instructions = '' }) {
    owner = ownerId(owner);
    name = stringValue(name, 'bot_name', 100);
    role = stringValue(role, 'bot_role', 100);
    instructions = bodyText(instructions, 'instructions', 8000, true);
    return this.transaction(() => {
      const now = new Date().toISOString();
      const botId = randomUUID();
      if(this.db.prepare('SELECT COUNT(*) AS n FROM bot_profiles WHERE owner=?').get(owner).n>=100)throw fail('bot_profile_limit',429);
      try {
        this.db.prepare('INSERT INTO bot_profiles(bot_id,owner,name,role,instructions,enabled,deleted,created_at,updated_at) VALUES(?,?,?,?,?,1,0,?,?)')
          .run(botId, owner, name, role, instructions, now, now);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) throw fail('bot_name_conflict', 409);
        throw error;
      }
      return rowBot(this.db.prepare('SELECT * FROM bot_profiles WHERE bot_id=?').get(botId));
    });
  }

  listBots(owner) {
    owner = ownerId(owner);
    return this.db.prepare('SELECT * FROM bot_profiles WHERE owner=? ORDER BY created_at DESC,bot_id DESC')
      .all(owner).map(rowBot);
  }

  getBot(owner, botId) {
    owner = ownerId(owner);
    botId = opaqueId(botId, 'bot_id', 64);
    return this.assertBot(owner, botId);
  }

  setBotEnabled(owner, botId, enabled) {
    owner = ownerId(owner);
    botId = opaqueId(botId, 'bot_id', 64);
    if (typeof enabled !== 'boolean') throw fail('invalid_enabled');
    return this.transaction(() => {
      const bot = this.assertBot(owner, botId, { includeDeleted: false });
      if (bot.enabled === enabled) return bot;
      const nowMs = Date.now();
      const now = iso(nowMs);
      this.db.prepare('UPDATE bot_profiles SET enabled=?,updated_at=? WHERE owner=? AND bot_id=?')
        .run(enabled ? 1 : 0, now, owner, botId);
      if (enabled) {
        this.db.prepare('UPDATE bot_schedules SET next_due_ms=?+interval_ms,updated_at=? WHERE owner=? AND bot_id=? AND enabled=1')
          .run(nowMs, now, owner, botId);
      }
      return rowBot(this.db.prepare('SELECT * FROM bot_profiles WHERE owner=? AND bot_id=?').get(owner, botId));
    });
  }

  deleteBot(owner, botId) {
    owner = ownerId(owner);
    botId = opaqueId(botId, 'bot_id', 64);
    return this.transaction(() => {
      const bot = this.assertBot(owner, botId);
      if (bot.deleted) return bot;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE bot_profiles SET enabled=0,deleted=1,updated_at=? WHERE owner=? AND bot_id=?')
        .run(now, owner, botId);
      return rowBot(this.db.prepare('SELECT * FROM bot_profiles WHERE owner=? AND bot_id=?').get(owner, botId));
    });
  }

  putMemory(owner, botId, { id, value }) {
    owner = ownerId(owner);
    botId = opaqueId(botId, 'bot_id', 64);
    id = opaqueId(id, 'memory_id', 100);
    value = bodyText(value, 'memory_value', 2000);
    return this.transaction(() => {
      this.assertBot(owner, botId, { includeDeleted: false });
      const existing = this.db.prepare('SELECT created_at FROM bot_memory_notes WHERE owner=? AND bot_id=? AND note_id=?')
        .get(owner, botId, id);
      if (!existing) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM bot_memory_notes WHERE owner=? AND bot_id=?').get(owner, botId).n;
        if (count >= 16) throw fail('memory_note_limit', 429);
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO bot_memory_notes(owner,bot_id,note_id,value,created_at,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(owner,bot_id,note_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .run(owner, botId, id, value, existing?.created_at ?? now, now);
      return rowMemory(this.db.prepare('SELECT owner,bot_id,note_id,value,created_at,updated_at FROM bot_memory_notes WHERE owner=? AND bot_id=? AND note_id=?')
        .get(owner, botId, id));
    });
  }

  listMemory(owner, botId) {
    owner = ownerId(owner);
    botId = opaqueId(botId, 'bot_id', 64);
    this.assertBot(owner, botId);
    return this.db.prepare('SELECT owner,bot_id,note_id,value,created_at,updated_at FROM bot_memory_notes WHERE owner=? AND bot_id=? ORDER BY note_id')
      .all(owner, botId).map(rowMemory);
  }

  deleteMemory(owner, botId, id) {
    owner = ownerId(owner);
    botId = opaqueId(botId, 'bot_id', 64);
    id = opaqueId(id, 'memory_id', 100);
    return this.transaction(() => {
      this.assertBot(owner, botId);
      return Boolean(this.db.prepare('DELETE FROM bot_memory_notes WHERE owner=? AND bot_id=? AND note_id=?').run(owner, botId, id).changes);
    });
  }

  normalizeInbound(input) {
    const owner = ownerId(input?.owner);
    const botId = opaqueId(input?.botId, 'bot_id', 64);
    const channel = opaqueId(input?.channel, 'channel', 100);
    const eventId = opaqueId(input?.eventId, 'event_id', 256);
    const conversationId = opaqueId(input?.conversationId, 'conversation_id', 256);
    const text = bodyText(input?.text);
    const createdAt = iso(instantMs(input?.createdAt, 'created_at', true));
    const payloadHash = createHash('sha256').update(JSON.stringify({ conversationId, text })).digest('hex');
    return { owner, botId, channel, eventId, conversationId, text, createdAt, payloadHash };
  }

  ingest(input) {
    const normalized = this.normalizeInbound(input);
    return this.transaction(() => this.ingestInTransaction(normalized));
  }

  ingestInTransaction(input) {
    const existing = this.db.prepare('SELECT * FROM bot_jobs WHERE owner=? AND bot_id=? AND channel=? AND event_id=?')
      .get(input.owner, input.botId, input.channel, input.eventId);
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) throw fail('idempotency_conflict', 409);
      return { job: rowJob(existing), replayed: true };
    }
    this.assertBot(input.owner, input.botId, { active: true, includeDeleted: false });
    const eventCount = this.db.prepare('SELECT COUNT(*) AS n FROM bot_jobs').get().n;
    if (eventCount >= this.maxEvents) throw fail('event_limit', 429);
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN owner=? THEN 1 ELSE 0 END) AS owner_total
      FROM bot_jobs WHERE status IN ('queued','starting','running','unknown')`).get(input.owner);
    if (counts.total >= this.maxPending || (counts.owner_total ?? 0) >= this.maxOwnerPending) {
      throw fail('queue_full', 429);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO bot_jobs(id,owner,bot_id,channel,event_id,conversation_id,text,payload_hash,status,
      session_id,run_id,result_text,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',NULL,NULL,NULL,NULL,?,?)`)
      .run(id, input.owner, input.botId, input.channel, input.eventId, input.conversationId,
        input.text, input.payloadHash, input.createdAt ?? now, now);
    return { job: rowJob(this.jobRow(id)), replayed: false };
  }

  jobRow(id) { return this.db.prepare('SELECT * FROM bot_jobs WHERE id=?').get(id); }

  listJobs(owner, { botId, limit = 100 } = {}) {
    owner = ownerId(owner);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw fail('invalid_limit');
    if (botId !== undefined) botId = opaqueId(botId, 'bot_id', 64);
    const rows = botId === undefined
      ? this.db.prepare('SELECT * FROM bot_jobs WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT ?').all(owner, limit)
      : this.db.prepare('SELECT * FROM bot_jobs WHERE owner=? AND bot_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(owner, botId, limit);
    return rows.map(rowJob);
  }

  getJob(owner, id) {
    owner = ownerId(owner);
    id = opaqueId(id, 'job_id', 64);
    const row = this.db.prepare('SELECT * FROM bot_jobs WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw fail('job_not_found', 404);
    return rowJob(row);
  }

  reserveNext() {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT j.id FROM bot_jobs j
        JOIN bot_profiles p ON p.bot_id=j.bot_id AND p.owner=j.owner
        LEFT JOIN bot_sessions s ON s.owner=j.owner AND s.bot_id=j.bot_id AND s.channel=j.channel AND s.conversation_id=j.conversation_id
        WHERE j.status='queued' AND p.enabled=1 AND p.deleted=0 AND COALESCE(s.status,'') NOT IN ('starting','unknown')
          AND NOT EXISTS (SELECT 1 FROM bot_jobs a WHERE a.owner=j.owner AND a.bot_id=j.bot_id AND a.channel=j.channel
            AND a.conversation_id=j.conversation_id AND a.status IN ('starting','running','unknown'))
        ORDER BY j.created_at,j.id LIMIT 1`).get();
      if (!row) return undefined;
      const now = new Date().toISOString();
      const changed = this.db.prepare("UPDATE bot_jobs SET status='starting',updated_at=? WHERE id=? AND status='queued'")
        .run(now, row.id).changes;
      if (!changed) return undefined;
      return rowJob(this.jobRow(row.id));
    });
  }

  listRecoverableRuns() {
    return this.db.prepare("SELECT * FROM bot_jobs WHERE status='running' AND run_id IS NOT NULL ORDER BY created_at,id")
      .all().map(rowJob);
  }

  sessionInput(owner, botId, channel, conversationId) {
    return {
      owner: ownerId(owner),
      botId: opaqueId(botId, 'bot_id', 64),
      channel: opaqueId(channel, 'channel', 100),
      conversationId: opaqueId(conversationId, 'conversation_id', 256),
    };
  }

  sessionRow(input) {
    return this.db.prepare('SELECT * FROM bot_sessions WHERE owner=? AND bot_id=? AND channel=? AND conversation_id=?')
      .get(input.owner, input.botId ?? input.bot_id, input.channel, input.conversationId ?? input.conversation_id);
  }

  beginSessionCreation(owner, botId, channel, conversationId) {
    const input = this.sessionInput(owner, botId, channel, conversationId);
    return this.transaction(() => {
      this.assertBot(input.owner, input.botId, { active: true, includeDeleted: false });
      const existing = this.sessionRow(input);
      if (existing?.status === 'ready' || existing?.status === 'unknown') return rowSession(existing);
      if (existing?.status === 'starting') throw fail('session_creation_in_progress', 409);
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO bot_sessions(owner,bot_id,channel,conversation_id,session_id,status,created_at,updated_at)
        VALUES(?,?,?,?,NULL,'starting',?,?)`).run(input.owner, input.botId, input.channel, input.conversationId, now, now);
      return rowSession(this.sessionRow(input));
    });
  }

  getSession(owner, botId, channel, conversationId) {
    const input = this.sessionInput(owner, botId, channel, conversationId);
    this.assertBot(input.owner, input.botId);
    return rowSession(this.sessionRow(input));
  }

  attachJobsToSession(input, sessionId, statuses) {
    const placeholders = statuses.map(() => '?').join(',');
    this.db.prepare(`UPDATE bot_jobs SET session_id=?,updated_at=? WHERE owner=? AND bot_id=? AND channel=?
      AND conversation_id=? AND status IN (${placeholders}) AND session_id IS NULL`)
      .run(sessionId, new Date().toISOString(), input.owner, input.botId, input.channel, input.conversationId, ...statuses);
  }

  writeSessionReady(input, sessionId, { allowStarting, allowUnknown }) {
    const existing = this.sessionRow(input);
    const now = new Date().toISOString();
    if (!existing) {
      this.db.prepare(`INSERT INTO bot_sessions(owner,bot_id,channel,conversation_id,session_id,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'ready',?,?)`).run(input.owner, input.botId, input.channel, input.conversationId, sessionId, now, now);
    } else if (existing.status === 'ready') {
      if (existing.session_id !== sessionId) throw fail('session_binding_conflict', 409);
    } else if (existing.status === 'starting' && allowStarting) {
      this.db.prepare(`UPDATE bot_sessions SET session_id=?,status='ready',updated_at=? WHERE owner=? AND bot_id=? AND channel=? AND conversation_id=?`)
        .run(sessionId, now, input.owner, input.botId, input.channel, input.conversationId);
    } else if (existing.status === 'unknown' && allowUnknown) {
      this.db.prepare(`UPDATE bot_sessions SET session_id=?,status='ready',updated_at=? WHERE owner=? AND bot_id=? AND channel=? AND conversation_id=?`)
        .run(sessionId, now, input.owner, input.botId, input.channel, input.conversationId);
    } else {
      throw fail('session_state_conflict', 409);
    }
    this.attachJobsToSession(input, sessionId, ['starting', ...(allowUnknown ? ['unknown'] : [])]);
    return rowSession(this.sessionRow(input));
  }

  setSession(owner, botId, channel, conversationId, sessionId) {
    const input = this.sessionInput(owner, botId, channel, conversationId);
    sessionId = opaqueId(sessionId, 'session_id', 256);
    return this.transaction(() => {
      this.assertBot(input.owner, input.botId);
      return this.writeSessionReady(input, sessionId, { allowStarting: true, allowUnknown: false });
    });
  }

  markSessionUnknown(owner, botId, channel, conversationId, code = 'session_start_unknown') {
    const input = this.sessionInput(owner, botId, channel, conversationId);
    code = opaqueId(code, 'error_code', 100);
    return this.transaction(() => {
      const row = this.sessionRow(input);
      if (!row) throw fail('session_not_found', 404);
      if (row.status === 'ready') throw fail('session_state_conflict', 409);
      if (row.status === 'unknown') return rowSession(row);
      this.db.prepare("UPDATE bot_sessions SET status='unknown',updated_at=? WHERE owner=? AND bot_id=? AND channel=? AND conversation_id=?")
        .run(new Date().toISOString(), input.owner, input.botId, input.channel, input.conversationId);
      this.db.prepare("UPDATE bot_jobs SET status='unknown',error_code=?,updated_at=? WHERE owner=? AND bot_id=? AND channel=? AND conversation_id=? AND status='starting' AND run_id IS NULL")
        .run(code, new Date().toISOString(), input.owner, input.botId, input.channel, input.conversationId);
      return rowSession(this.sessionRow(input));
    });
  }

  bindSession(owner, botId, channel, conversationId, sessionId) {
    const input = this.sessionInput(owner, botId, channel, conversationId);
    sessionId = opaqueId(sessionId, 'session_id', 256);
    return this.transaction(() => {
      this.assertBot(input.owner, input.botId);
      return this.writeSessionReady(input, sessionId, { allowStarting: false, allowUnknown: true });
    });
  }

  jobById(id) {
    const row = this.jobRow(id);
    if (!row) throw fail('job_not_found', 404);
    return row;
  }

  attachSession(jobId, sessionId) {
    jobId = opaqueId(jobId, 'job_id', 64);
    sessionId = opaqueId(sessionId, 'session_id', 256);
    return this.transaction(() => {
      const job = this.jobById(jobId);
      const session = this.sessionRow(job);
      if (!session || session.status !== 'ready' || session.session_id !== sessionId) throw fail('session_binding_conflict', 409);
      if (job.session_id && job.session_id !== sessionId) throw fail('session_binding_conflict', 409);
      if (!['starting', 'running', 'unknown'].includes(job.status)) throw fail('job_state_conflict', 409);
      this.db.prepare('UPDATE bot_jobs SET session_id=?,updated_at=? WHERE id=?')
        .run(sessionId, new Date().toISOString(), jobId);
      return rowJob(this.jobRow(jobId));
    });
  }

  attachRun(jobId, runId) {
    jobId = opaqueId(jobId, 'job_id', 64);
    runId = opaqueId(runId, 'run_id', 256);
    return this.transaction(() => {
      const job = this.jobById(jobId);
      if (job.status === 'running' && job.run_id === runId) return rowJob(job);
      if (job.status !== 'starting' || !job.session_id) throw fail('job_state_conflict', 409);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE bot_jobs SET status='running',run_id=?,error_code=NULL,updated_at=? WHERE id=? AND status='starting'")
        .run(runId, now, jobId);
      return rowJob(this.jobRow(jobId));
    });
  }

  markJobUnknown(jobId, code = 'run_start_unknown') {
    jobId = opaqueId(jobId, 'job_id', 64);
    code = opaqueId(code, 'error_code', 100);
    return this.transaction(() => {
      const job = this.jobById(jobId);
      if (job.status === 'unknown') return rowJob(job);
      if (!['starting', 'running'].includes(job.status)) throw fail('job_state_conflict', 409);
      this.db.prepare("UPDATE bot_jobs SET status='unknown',error_code=?,updated_at=? WHERE id=?")
        .run(code, new Date().toISOString(), jobId);
      return rowJob(this.jobRow(jobId));
    });
  }

  failJob(jobId, code = 'c1_run_failed') {
    jobId = opaqueId(jobId, 'job_id', 64);
    code = opaqueId(code, 'error_code', 100);
    return this.transaction(() => {
      const job = this.jobById(jobId);
      if (job.status === 'failed' && job.error_code === code) return rowJob(job);
      if (!['starting', 'running'].includes(job.status)) throw fail('job_state_conflict', 409);
      this.db.prepare("UPDATE bot_jobs SET status='failed',error_code=?,updated_at=? WHERE id=?")
        .run(code, new Date().toISOString(), jobId);
      return rowJob(this.jobRow(jobId));
    });
  }

  cancelJob(owner, jobId) {
    owner = ownerId(owner);
    jobId = opaqueId(jobId, 'job_id', 64);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM bot_jobs WHERE owner=? AND id=?').get(owner, jobId);
      if (!row) throw fail('job_not_found', 404);
      if (row.status === 'cancelled') return rowJob(row);
      if (row.status !== 'queued') throw fail('job_state_conflict', 409);
      this.db.prepare("UPDATE bot_jobs SET status='cancelled',updated_at=? WHERE owner=? AND id=?")
        .run(new Date().toISOString(), owner, jobId);
      return rowJob(this.jobRow(jobId));
    });
  }

  reconcileUnknownRun(owner, jobId, { runId, verifiedSessionId }) {
    owner = ownerId(owner);
    jobId = opaqueId(jobId, 'job_id', 64);
    runId = opaqueId(runId, 'run_id', 256);
    verifiedSessionId = opaqueId(verifiedSessionId, 'session_id', 256);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM bot_jobs WHERE owner=? AND id=?').get(owner, jobId);
      if (!row) throw fail('job_not_found', 404);
      if (row.session_id !== verifiedSessionId) throw fail('session_verification_mismatch', 409);
      const session = this.sessionRow(row);
      if (!session || session.status !== 'ready' || session.session_id !== verifiedSessionId) {
        throw fail('session_verification_mismatch', 409);
      }
      if (row.status === 'running' && row.run_id === runId) return rowJob(row);
      if (row.status !== 'unknown' || (row.run_id && row.run_id !== runId)) throw fail('job_state_conflict', 409);
      this.db.prepare("UPDATE bot_jobs SET status='running',run_id=?,error_code=NULL,updated_at=? WHERE owner=? AND id=?")
        .run(runId, new Date().toISOString(), owner, jobId);
      return rowJob(this.jobRow(jobId));
    });
  }

  resolveUnknownJobNotStarted(owner, jobId, { verifiedSessionId } = {}) {
    owner = ownerId(owner);
    jobId = opaqueId(jobId, 'job_id', 64);
    if (verifiedSessionId !== undefined) verifiedSessionId = opaqueId(verifiedSessionId, 'session_id', 256);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM bot_jobs WHERE owner=? AND id=?').get(owner, jobId);
      if (!row) throw fail('job_not_found', 404);
      if (row.status !== 'unknown' || row.run_id) throw fail('job_state_conflict', 409);
      const session = this.sessionRow(row);
      if (row.session_id === null && !session) {
        if (verifiedSessionId !== undefined) throw fail('session_verification_mismatch', 409);
      } else if (!verifiedSessionId || !session || session.status !== 'ready' || session.session_id !== verifiedSessionId || row.session_id !== verifiedSessionId) {
        throw fail('session_verification_mismatch', 409);
      }
      this.db.prepare("UPDATE bot_jobs SET status='queued',error_code=NULL,updated_at=? WHERE owner=? AND id=?")
        .run(new Date().toISOString(), owner, jobId);
      return rowJob(this.jobRow(jobId));
    });
  }

  finishJob(jobId, { text }) {
    jobId = opaqueId(jobId, 'job_id', 64);
    text = bodyText(text, 'result_text', 12000);
    return this.transaction(() => {
      const job = this.jobById(jobId);
      if (job.status === 'succeeded') {
        if (job.result_text !== text) throw fail('completion_conflict', 409);
        const outbox = this.db.prepare('SELECT * FROM bot_outbox WHERE job_id=?').get(jobId);
        return { job: rowJob(job), outbox: rowOutbox(outbox) };
      }
      if (job.status !== 'running') throw fail('job_state_conflict', 409);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE bot_jobs SET status='succeeded',result_text=?,error_code=NULL,updated_at=? WHERE id=?")
        .run(text, now, jobId);
      const deliveryKey = stableDeliveryKey(job.owner, job.bot_id, job.channel, job.event_id);
      const outboxId = randomUUID();
      this.db.prepare(`INSERT INTO bot_outbox(id,job_id,owner,bot_id,channel,conversation_id,text,delivery_key,status,error_code,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'pending',NULL,?,?)`)
        .run(outboxId, jobId, job.owner, job.bot_id, job.channel, job.conversation_id, text, deliveryKey, now, now);
      return { job: rowJob(this.jobRow(jobId)), outbox: rowOutbox(this.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(outboxId)) };
    });
  }

  listOutbox(owner, { botId, limit = 100 } = {}) {
    owner = ownerId(owner);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw fail('invalid_limit');
    if (botId !== undefined) botId = opaqueId(botId, 'bot_id', 64);
    const rows = botId === undefined
      ? this.db.prepare('SELECT * FROM bot_outbox WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT ?').all(owner, limit)
      : this.db.prepare('SELECT * FROM bot_outbox WHERE owner=? AND bot_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(owner, botId, limit);
    return rows.map(rowOutbox);
  }

  claimOutbound() {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM bot_outbox WHERE status='pending' AND channel<>'web' ORDER BY created_at,id LIMIT 1").get();
      if (!row) return undefined;
      this.db.prepare("UPDATE bot_outbox SET status='delivering',error_code=NULL,updated_at=? WHERE id=? AND status='pending'")
        .run(new Date().toISOString(), row.id);
      return rowOutbox(this.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(row.id));
    });
  }

  completeOutbound(id, outcome) {
    id = opaqueId(id, 'outbox_id', 64);
    if (!['delivered', 'unknown'].includes(outcome)) throw fail('invalid_outbox_outcome');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id);
      if (!row) throw fail('outbox_not_found', 404);
      if (row.status === outcome) return rowOutbox(row);
      if (row.status === 'delivered' || (row.status !== 'delivering' && !(row.status === 'unknown' && outcome === 'delivered'))) {
        throw fail('outbox_state_conflict', 409);
      }
      this.db.prepare('UPDATE bot_outbox SET status=?,error_code=?,updated_at=? WHERE id=?')
        .run(outcome, outcome === 'unknown' ? 'delivery_outcome_unknown' : null, new Date().toISOString(), id);
      return rowOutbox(this.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id));
    });
  }

  ackWebOutbox(owner, id, deliveryKey) {
    owner = ownerId(owner);
    id = opaqueId(id, 'outbox_id', 64);
    deliveryKey = opaqueId(deliveryKey, 'delivery_key', 100);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM bot_outbox WHERE owner=? AND id=? AND channel='web'")
        .get(owner, id);
      if (!row) throw fail('outbox_not_found', 404);
      if (row.delivery_key !== deliveryKey) throw fail('delivery_key_mismatch', 409);
      if (row.status === 'delivered') return rowOutbox(row);
      if (!['pending', 'delivering', 'unknown'].includes(row.status)) throw fail('outbox_state_conflict', 409);
      this.db.prepare("UPDATE bot_outbox SET status='delivered',error_code=NULL,updated_at=? WHERE owner=? AND id=?")
        .run(new Date().toISOString(), owner, id);
      return rowOutbox(this.db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id));
    });
  }

  addSchedule({ owner, botId, channel, conversationId, text, intervalMs, anchorAt, enabled = false }) {
    const input = this.sessionInput(owner, botId, channel, conversationId);
    text = bodyText(text, 'schedule_text');
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 300000 || intervalMs > 365 * 24 * 60 * 60 * 1000) {
      throw fail('invalid_interval_ms');
    }
    if (typeof enabled !== 'boolean') throw fail('invalid_enabled');
    const anchor = instantMs(anchorAt, 'anchor_at');
    return this.transaction(() => {
      this.assertBot(input.owner, input.botId, { active: true, includeDeleted: false });
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM bot_schedules WHERE owner=? AND bot_id=?')
        .get(input.owner, input.botId).n;
      if (count >= 32) throw fail('schedule_limit', 429);
      const scheduleId = randomUUID();
      const now = new Date().toISOString();
      const firstDue = enabled ? Math.max(anchor, Date.now()) : anchor;
      this.db.prepare(`INSERT INTO bot_schedules(schedule_id,owner,bot_id,channel,conversation_id,text,interval_ms,anchor_ms,next_due_ms,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(scheduleId, input.owner, input.botId, input.channel, input.conversationId, text,
          intervalMs, anchor, firstDue, enabled ? 1 : 0, now, now);
      return rowSchedule(this.db.prepare('SELECT * FROM bot_schedules WHERE schedule_id=?').get(scheduleId));
    });
  }

  listSchedules(owner, { botId, limit = 100 } = {}) {
    owner = ownerId(owner);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw fail('invalid_limit');
    if (botId !== undefined) botId = opaqueId(botId, 'bot_id', 64);
    const rows = botId === undefined
      ? this.db.prepare('SELECT * FROM bot_schedules WHERE owner=? ORDER BY created_at DESC,schedule_id DESC LIMIT ?').all(owner, limit)
      : this.db.prepare('SELECT * FROM bot_schedules WHERE owner=? AND bot_id=? ORDER BY created_at DESC,schedule_id DESC LIMIT ?').all(owner, botId, limit);
    return rows.map(rowSchedule);
  }

  setScheduleEnabled(owner, id, enabled) {
    owner = ownerId(owner);
    id = opaqueId(id, 'schedule_id', 64);
    if (typeof enabled !== 'boolean') throw fail('invalid_enabled');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM bot_schedules WHERE owner=? AND schedule_id=?').get(owner, id);
      if (!row) throw fail('schedule_not_found', 404);
      if (Boolean(row.enabled) === enabled) return rowSchedule(row);
      const bot = this.assertBot(owner, row.bot_id, { includeDeleted: false });
      if (enabled && !bot.enabled) throw fail('bot_disabled', 409);
      const nowMs = Date.now();
      this.db.prepare('UPDATE bot_schedules SET enabled=?,next_due_ms=?,updated_at=? WHERE owner=? AND schedule_id=?')
        .run(enabled ? 1 : 0, enabled ? nowMs + row.interval_ms : row.next_due_ms, iso(nowMs), owner, id);
      return rowSchedule(this.db.prepare('SELECT * FROM bot_schedules WHERE owner=? AND schedule_id=?').get(owner, id));
    });
  }

  dueSchedules(now = Date.now(), { catchUpCap = 1 } = {}) {
    const nowMs = instantMs(now, 'now');
    if (catchUpCap !== 1) throw fail('invalid_catch_up_cap');
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT s.* FROM bot_schedules s JOIN bot_profiles p
        ON p.owner=s.owner AND p.bot_id=s.bot_id
        WHERE s.enabled=1 AND s.next_due_ms<=? AND p.enabled=1 AND p.deleted=0
        ORDER BY s.next_due_ms,s.schedule_id LIMIT 1000`).all(nowMs);
      const result = [];
      for (const row of rows) {
        const bucket = row.next_due_ms;
        const eventId = `schedule_${row.schedule_id}_${bucket}`;
        const inbound = this.normalizeInbound({ owner: row.owner, botId: row.bot_id, channel: row.channel,
          eventId, conversationId: row.conversation_id, text: row.text, createdAt: iso(bucket) });
        let ingested;
        try { ingested = this.ingestInTransaction(inbound); }
        catch(error) {
          if(['queue_full','event_limit'].includes(error.code))break;
          throw error;
        }
        result.push(ingested);
        const next = row.anchor_ms + (Math.floor((nowMs - row.anchor_ms) / row.interval_ms) + 1) * row.interval_ms;
        this.db.prepare('UPDATE bot_schedules SET next_due_ms=?,updated_at=? WHERE schedule_id=?')
          .run(next, iso(nowMs), row.schedule_id);
      }
      return result;
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); } finally {
      if (this.lock !== undefined) {
        try { closeSync(this.lock); } catch { /* already closed */ }
        try {
          const stat = lstatSync(this.lockPath);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink <= 1 && readFileSync(this.lockPath, 'utf8') === this.lockValue) {
            unlinkSync(this.lockPath);
          }
        } catch { /* preserve a replaced or inaccessible lock */ }
        this.lock = undefined;
      }
    }
  }
}

function rowMemory(row) {
  if (!row) return undefined;
  return { owner: row.owner, botId: row.bot_id, id: row.note_id, value: row.value, createdAt: row.created_at, updatedAt: row.updated_at };
}
