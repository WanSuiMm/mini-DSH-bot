import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BotStore } from '../service/bot/store.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'micro-dsh-bot-store-'));
  const filename = join(dir, 'bot-store.sqlite3');
  let store = new BotStore(filename, options);
  t.after(() => {
    store.close();
    const actual = resolve(dir);
    assert.ok(actual.startsWith(resolve(tmpdir()) + sep));
    rmSync(actual, { recursive: true, force: true });
  });
  return {
    filename,
    get store() { return store; },
    reopen() {
      store.close();
      store = new BotStore(filename, options);
      return store;
    },
  };
}

function bot(store, owner = 'alice', name = 'Research helper') {
  return store.createBot({ owner, name, role: 'research-assistant', instructions: 'Use the owner’s saved notes when relevant.' });
}

function inbound(owner, botId, eventId, conversationId, text, channel = 'web') {
  return { owner, botId, channel, eventId, conversationId, text };
}

function startRun(store, job, sessionId, runId) {
  const session = store.beginSessionCreation(job.owner, job.botId, job.channel, job.conversationId);
  if (session.status === 'starting') store.setSession(job.owner, job.botId, job.channel, job.conversationId, sessionId);
  store.attachSession(job.id, sessionId);
  return store.attachRun(job.id, runId);
}

test('due schedules keep admitted work when later schedules encounter inbox backpressure', t => {
  const f=fixture(t,{maxPending:1,maxOwnerPending:1,maxEvents:10}),b=bot(f.store);
  const anchor=Date.now()-1000;
  for(let i=0;i<2;i++)f.store.addSchedule({owner:'alice',botId:b.botId,channel:'web',conversationId:'timer-'+i,
    text:'scheduled work '+i,intervalMs:300000,anchorAt:anchor,enabled:true});
  const now=Date.now()+10;
  assert.equal(f.store.dueSchedules(now).length,1);
  assert.equal(f.store.listJobs('alice').length,1);
  assert.equal(f.store.dueSchedules(now).length,0);
  const first=f.store.reserveNext();startRun(f.store,first,'timer-session-1','timer-run-1');
  f.store.finishJob(first.id,{text:'complete'});
  assert.equal(f.store.dueSchedules(now).length,1);
  assert.equal(f.store.listJobs('alice').length,2);
});

test('Bots and saved memory are owner and Bot scoped, bounded, and disabled profiles reject new jobs', t => {
  const f = fixture(t), a = bot(f.store), b = bot(f.store, 'bob');
  assert.notEqual(a.botId, b.botId);
  f.store.putMemory('alice', a.botId, { id: 'tone', value: 'Concise, with sources.' });
  f.store.putMemory('bob', b.botId, { id: 'tone', value: 'Use short examples.' });
  assert.equal(f.store.listMemory('alice', a.botId)[0].value, 'Concise, with sources.');
  assert.equal(f.store.listMemory('bob', b.botId)[0].value, 'Use short examples.');
  assert.throws(() => f.store.listMemory('bob', a.botId), error => error.code === 'bot_not_found');

  for (let i = 1; i < 16; i++) f.store.putMemory('alice', a.botId, { id: `note-${i}`, value: `note ${i}` });
  f.store.putMemory('alice', a.botId, { id: 'note-1', value: 'updated note' });
  assert.throws(() => f.store.putMemory('alice', a.botId, { id: 'note-16', value: 'too many' }),
    error => error.code === 'memory_note_limit');
  assert.throws(() => f.store.putMemory('alice', a.botId, { id: 'long', value: 'x'.repeat(2001) }),
    error => error.code === 'invalid_memory_value');

  f.store.setBotEnabled('alice', a.botId, false);
  assert.throws(() => f.store.ingest(inbound('alice', a.botId, 'e-disabled', 'c1', 'hello')),
    error => error.code === 'bot_disabled');
  assert.equal(f.store.getBot('alice', a.botId).enabled, false);
  f.store.setBotEnabled('alice', a.botId, true);
  f.store.deleteBot('alice', a.botId);
  assert.throws(() => f.store.ingest(inbound('alice', a.botId, 'e-deleted', 'c1', 'hello')),
    error => error.code === 'bot_disabled');
});

test('inbox delivery is idempotent by owner, Bot, channel and event ID and rejects changed payloads', t => {
  const f = fixture(t), a = bot(f.store), b = bot(f.store, 'bob');
  const first = f.store.ingest(inbound('alice', a.botId, 'evt-1', 'room-1', 'hello'));
  const replay = f.store.ingest(inbound('alice', a.botId, 'evt-1', 'room-1', 'hello'));
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, first.job.id);
  assert.throws(() => f.store.ingest(inbound('alice', a.botId, 'evt-1', 'room-1', 'edited payload')),
    error => error.code === 'idempotency_conflict');

  const otherOwner = f.store.ingest(inbound('bob', b.botId, 'evt-1', 'room-1', 'hello'));
  assert.notEqual(otherOwner.job.id, first.job.id);
  assert.equal(f.store.listJobs('alice').length, 1);
  assert.equal(f.store.listJobs('bob').length, 1);
  assert.throws(() => f.store.getJob('bob', first.job.id), error => error.code === 'job_not_found');
  assert.throws(() => f.store.ingest(inbound('bob', a.botId, 'evt-2', 'room-1', 'cross-owner')),
    error => error.code === 'bot_not_found');
});

test('queue bounds apply globally and per owner while one active job blocks only its conversation', t => {
  const f = fixture(t, { maxPending: 4, maxOwnerPending: 3, maxEvents: 20 });
  const a = bot(f.store), b = bot(f.store, 'bob'), c = bot(f.store, 'carol');
  const one = f.store.ingest(inbound('alice', a.botId, 'a1', 'conversation-a', 'first')).job;
  const sameConversation = f.store.ingest(inbound('alice', a.botId, 'a2', 'conversation-a', 'second')).job;
  const otherConversation = f.store.ingest(inbound('alice', a.botId, 'a3', 'conversation-b', 'third')).job;
  assert.throws(() => f.store.ingest(inbound('alice', a.botId, 'a4', 'conversation-c', 'owner cap')),
    error => error.code === 'queue_full');

  const reserved = f.store.reserveNext();
  assert.equal(reserved.id, one.id);
  const next = f.store.reserveNext();
  assert.equal(next.id, otherConversation.id);
  assert.equal(f.store.reserveNext(), undefined);
  assert.equal(f.store.getJob('alice', sameConversation.id).status, 'queued');

  f.store.ingest(inbound('bob', b.botId, 'b1', 'conversation-b', 'another owner'));
  assert.throws(() => f.store.ingest(inbound('carol', c.botId, 'c1', 'conversation-c', 'global cap')),
    error => error.code === 'queue_full');
});

test('restart makes unbound starts unknown, requires explicit reconciliation, and preserves running IDs', t => {
  const f = fixture(t), b = bot(f.store);
  const lost = f.store.ingest(inbound('alice', b.botId, 'lost-start', 'room-lost', 'first')).job;
  assert.equal(f.store.reserveNext().id, lost.id);
  assert.equal(f.store.beginSessionCreation('alice', b.botId, 'web', 'room-lost').status, 'starting');

  const running = f.store.ingest(inbound('alice', b.botId, 'known-run', 'room-running', 'second')).job;
  assert.equal(f.store.reserveNext().id, running.id);
  startRun(f.store, running, 'c1-session-running', 'c1-run-running');
  const unknownRun = f.store.ingest(inbound('alice', b.botId, 'lost-run-reply', 'room-unknown-run', 'third')).job;
  assert.equal(f.store.reserveNext().id, unknownRun.id);
  const unknownRunSession = f.store.beginSessionCreation('alice', b.botId, 'web', 'room-unknown-run');
  assert.equal(unknownRunSession.status, 'starting');
  f.store.setSession('alice', b.botId, 'web', 'room-unknown-run', 'c1-session-unknown-run');
  f.store.attachSession(unknownRun.id, 'c1-session-unknown-run');
  f.store.markJobUnknown(unknownRun.id, 'lost_start_response');
  f.reopen();

  assert.equal(f.store.getJob('alice', lost.id).status, 'unknown');
  assert.equal(f.store.getSession('alice', b.botId, 'web', 'room-lost').status, 'unknown');
  assert.deepEqual(f.store.listRecoverableRuns().map(job => job.runId), ['c1-run-running']);
  assert.equal(f.store.getJob('alice', unknownRun.id).status, 'unknown');

  f.store.bindSession('alice', b.botId, 'web', 'room-lost', 'verified-existing-session');
  assert.throws(() => f.store.resolveUnknownJobNotStarted('alice', lost.id),
    error => error.code === 'session_verification_mismatch');
  const queued = f.store.resolveUnknownJobNotStarted('alice', lost.id, { verifiedSessionId: 'verified-existing-session' });
  assert.equal(queued.status, 'queued');
  assert.equal(f.store.reserveNext().id, lost.id);
  assert.equal(f.store.beginSessionCreation('alice', b.botId, 'web', 'room-lost').status, 'ready');
  f.store.attachSession(lost.id, 'verified-existing-session');
  const recovered = f.store.attachRun(lost.id, 'c1-run-retried');
  assert.equal(recovered.status, 'running');
  assert.equal(recovered.runId, 'c1-run-retried');

  const reconciled = f.store.reconcileUnknownRun('alice', unknownRun.id, {
    runId: 'c1-run-recovered', verifiedSessionId: 'c1-session-unknown-run',
  });
  assert.equal(reconciled.status, 'running');
  assert.equal(reconciled.runId, 'c1-run-recovered');
});

test('success atomically creates one stable outbox; Web requires owner and key acknowledgment', t => {
  const f = fixture(t), b = bot(f.store);
  const job = f.store.ingest(inbound('alice', b.botId, 'web-event', 'web-room', 'question')).job;
  assert.equal(f.store.reserveNext().id, job.id);
  startRun(f.store, job, 'web-session', 'web-run');
  const done = f.store.finishJob(job.id, { text: 'answer' });
  assert.equal(done.job.status, 'succeeded');
  assert.equal(done.outbox.status, 'pending');
  assert.match(done.outbox.deliveryKey, /^bot-v1-[0-9a-f]{64}$/u);
  const replay = f.store.finishJob(job.id, { text: 'answer' });
  assert.equal(replay.outbox.id, done.outbox.id);
  assert.throws(() => f.store.finishJob(job.id, { text: 'different answer' }),
    error => error.code === 'completion_conflict');
  assert.equal(f.store.claimOutbound(), undefined, 'Web output is delivered through fetch and client ACK');
  assert.throws(() => f.store.ackWebOutbox('bob', done.outbox.id, done.outbox.deliveryKey),
    error => error.code === 'outbox_not_found');
  assert.throws(() => f.store.ackWebOutbox('alice', done.outbox.id, 'wrong-key'),
    error => error.code === 'delivery_key_mismatch');
  assert.equal(f.store.ackWebOutbox('alice', done.outbox.id, done.outbox.deliveryKey).status, 'delivered');
  assert.equal(f.store.ackWebOutbox('alice', done.outbox.id, done.outbox.deliveryKey).status, 'delivered');
});

test('a push delivery interrupted during restart becomes unknown and is never claimed again', t => {
  const f = fixture(t), b = bot(f.store);
  const job = f.store.ingest(inbound('alice', b.botId, 'push-event', 'push-room', 'question', 'telegram')).job;
  f.store.reserveNext();
  startRun(f.store, job, 'push-session', 'push-run');
  const outbox = f.store.finishJob(job.id, { text: 'answer' }).outbox;
  assert.equal(f.store.claimOutbound().status, 'delivering');
  f.reopen();
  assert.equal(f.store.listOutbox('alice')[0].status, 'unknown');
  assert.equal(f.store.claimOutbound(), undefined);
});

test('interval schedules default disabled, deduplicate due buckets, and skip paused catch-up', t => {
  const f = fixture(t), b = bot(f.store);
  const anchor = Date.now() - 3600000;
  const schedule = f.store.addSchedule({ owner: 'alice', botId: b.botId, channel: 'web',
    conversationId: 'daily-room', text: 'Summarize today.', intervalMs: 300000, anchorAt: anchor });
  assert.equal(schedule.enabled, false);
  assert.equal(f.store.dueSchedules(Date.now() + 86400000).length, 0);

  const enabled = f.store.setScheduleEnabled('alice', schedule.scheduleId, true);
  const dueAt = Date.parse(enabled.nextDueAt);
  assert.equal(f.store.dueSchedules(dueAt - 1).length, 0);
  const first = f.store.dueSchedules(dueAt);
  assert.equal(first.length, 1);
  assert.equal(first[0].job.eventId, `schedule_${schedule.scheduleId}_${dueAt}`);
  assert.equal(f.store.dueSchedules(dueAt).length, 0);

  f.store.setScheduleEnabled('alice', schedule.scheduleId, false);
  const resumed = f.store.setScheduleEnabled('alice', schedule.scheduleId, true);
  assert.ok(Date.parse(resumed.nextDueAt) > Date.now());
  assert.throws(() => f.store.addSchedule({ owner: 'alice', botId: b.botId, channel: 'web',
    conversationId: 'too-fast', text: 'Run too often.', intervalMs: 299999, anchorAt: anchor }),
  error => error.code === 'invalid_interval_ms');
});

test('store lock and foreign SQLite files are rejected without altering foreign tables', t => {
  const f = fixture(t), b = bot(f.store);
  assert.throws(() => new BotStore(f.filename), error => error.code === 'store_locked');
  assert.equal(f.store.getBot('alice', b.botId).botId, b.botId);

  const foreignPath = join(resolve(tmpdir()), `bot-store-foreign-${Date.now()}-${Math.random()}.sqlite3`);
  const foreign = new DatabaseSync(foreignPath);
  foreign.exec('CREATE TABLE original_evidence(value TEXT)');
  foreign.close();
  try {
    assert.throws(() => new BotStore(foreignPath), error => error.code === 'foreign_database');
    const check = new DatabaseSync(foreignPath, { readOnly: true });
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name),
      ['original_evidence']);
    check.close();
  } finally {
    rmSync(foreignPath, { force: true });
    rmSync(`${foreignPath}-wal`, { force: true });
    rmSync(`${foreignPath}-shm`, { force: true });
    rmSync(`${foreignPath}.owner-lock`, { force: true });
  }
});
