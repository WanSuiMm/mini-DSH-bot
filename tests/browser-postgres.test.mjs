import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const databaseUrl = process.env.MICRO_DSH_BROWSER_TEST_DATABASE_URL;

test('PostgreSQL browser store isolates owners and serializes leases, recovery, approvals, and idempotency', {
  skip: !databaseUrl && 'Set MICRO_DSH_BROWSER_TEST_DATABASE_URL to opt into an isolated PostgreSQL schema.',
}, async t => {
  const [{ Pool }, { PostgresBrowserStore }] = await Promise.all([
    import('pg'),
    import('../service/browser/postgres-store.mjs'),
  ]);
  const admin = new Pool({ connectionString: databaseUrl, max: 2, application_name: 'mini-dsh-browser-test-admin' });
  const schema = `browser_store_test_${randomUUID().replaceAll('-', '')}`;
  let schemaCreated = false;
  let pool;
  let store;
  t.after(async () => {
    if (store) await store.close().catch(() => {});
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  });

  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    options: `-c search_path=${schema}`,
    application_name: 'mini-dsh-browser-test',
  });
  store = new PostgresBrowserStore(pool);
  await store.ready();

  const sessionInput = (overrides = {}) => ({
    id: randomUUID(),
    owner: 'owner-a',
    harnessSessionId: `harness-${randomUUID()}`,
    runId: `run-${randomUUID()}`,
    taskId: `task-${randomUUID()}`,
    profileId: null,
    workerId: `worker-${randomUUID()}`,
    ...overrides,
  });
  const activeSession = async input => {
    const created = await store.createSession(input);
    const session = await store.transitionSession({
      owner: input.owner,
      id: input.id,
      workerId: input.workerId,
      fence: created.session.fence,
      status: 'active',
    });
    return session;
  };

  await t.test('profile leases serialize concurrent owners and all reads remain owner-scoped', async () => {
    const sharedProfile = 'profile-shared';
    const attempts = await Promise.allSettled([
      store.createSession(sessionInput({ profileId: sharedProfile, maxSessions: 8, maxOwnerSessions: 8 })),
      store.createSession(sessionInput({ profileId: sharedProfile, maxSessions: 8, maxOwnerSessions: 8 })),
    ]);
    const winners = attempts.filter(attempt => attempt.status === 'fulfilled');
    const losers = attempts.filter(attempt => attempt.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.status, 409);

    const session = winners[0].value.session;
    assert.equal((await store.getSession('owner-b', session.id)), undefined);
    await assert.rejects(store.events('owner-b', session.id), error => error.status === 404);
    const command = await store.enqueueCommand({
      id: randomUUID(), owner: 'owner-a', sessionId: session.id, idempotencyKey: 'owner-test-key',
      requestHash: 'a'.repeat(64), request: { action: 'read' },
    });
    assert.equal(await store.getCommand('owner-b', command.command.id), undefined);
    await assert.rejects(store.commands('owner-b', session.id), error => error.status === 404);
  });

  await t.test('concurrent admission respects global and per-owner limits', async () => {
    const current = Number((await pool.query(
      `SELECT COUNT(*) AS count FROM browser_sessions
       WHERE status IN ('creating','active','paused') AND lease_until>NOW() AND expires_at>NOW()`,
    )).rows[0].count);
    const globalAttempts = await Promise.allSettled([
      store.createSession(sessionInput({ owner: 'global-a', maxSessions: current + 1, maxOwnerSessions: 10 })),
      store.createSession(sessionInput({ owner: 'global-b', maxSessions: current + 1, maxOwnerSessions: 10 })),
    ]);
    assert.equal(globalAttempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
    const globalRejected = globalAttempts.find(attempt => attempt.status === 'rejected');
    assert.equal(globalRejected.reason.status, 429);

    const ownerAttempts = await Promise.allSettled([
      store.createSession(sessionInput({ owner: 'quota-owner', maxSessions: 100, maxOwnerSessions: 1 })),
      store.createSession(sessionInput({ owner: 'quota-owner', maxSessions: 100, maxOwnerSessions: 1 })),
    ]);
    assert.equal(ownerAttempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
    assert.equal(ownerAttempts.find(attempt => attempt.status === 'rejected').reason.status, 429);
  });

  await t.test('an expired running command becomes unknown and cannot be claimed again', async () => {
    const input = sessionInput();
    const session = await activeSession(input);
    const queued = await store.enqueueCommand({
      id: randomUUID(), owner: input.owner, sessionId: input.id, idempotencyKey: 'recover-key',
      requestHash: 'b'.repeat(64), request: { action: 'click', target: 'button' },
    });
    const running = await store.beginCommand({
      owner: input.owner, id: queued.command.id, sessionId: input.id, workerId: input.workerId, fence: session.fence,
    });
    assert.equal(running.status, 'running');

    await pool.query("UPDATE browser_sessions SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [input.id]);
    const recovered = await store.recoverExpired();
    assert.equal(recovered.sessions.length, 1);
    assert.equal(recovered.sessions[0].status, 'lost');
    assert.equal(recovered.commands.length, 1);
    assert.equal(recovered.commands[0].status, 'unknown');
    assert.equal(recovered.commands[0].result.code, 'BROWSER_ACTION_OUTCOME_UNKNOWN');
    assert.equal(recovered.commands[0].result.requiresHumanReconciliation, true);
    assert.equal(await store.beginCommand({
      owner: input.owner, id: queued.command.id, sessionId: input.id, workerId: input.workerId, fence: session.fence,
    }), undefined);
    assert.equal((await store.getCommand(input.owner, queued.command.id)).status, 'unknown');
  });

  await t.test('a service restart invalidates stale approvals and preserves dispatched uncertainty', async () => {
    const input = sessionInput({ workerId: 'worker-before-restart' });
    const session = await activeSession(input);
    const pending = await store.enqueueCommand({
      id: randomUUID(), owner: input.owner, sessionId: input.id, idempotencyKey: 'pending-before-restart',
      requestHash: 'e'.repeat(64), request: { type: 'click', ref: 'fresh-ref' }, requiresApproval: true,
    });
    const ready = await store.enqueueCommand({
      id: randomUUID(), owner: input.owner, sessionId: input.id, idempotencyKey: 'approved-before-restart',
      requestHash: 'f'.repeat(64), request: { type: 'click', ref: 'fresh-ref-2' }, requiresApproval: true,
    });
    await store.approveCommand({ owner: input.owner, id: ready.command.id, decision: 'approve', requestHash: 'f'.repeat(64) });
    const running = await store.enqueueCommand({
      id: randomUUID(), owner: input.owner, sessionId: input.id, idempotencyKey: 'running-before-restart',
      requestHash: '1'.repeat(64), request: { type: 'click', ref: 'fresh-ref-3' }, requiresApproval: true,
    });
    await store.approveCommand({ owner: input.owner, id: running.command.id, decision: 'approve', requestHash: '1'.repeat(64) });
    await store.beginCommand({ owner: input.owner, id: running.command.id, sessionId: input.id, workerId: input.workerId, fence: session.fence });

    const recovered = await store.recoverPreviousWorkers('worker-after-restart');
    assert.equal(recovered.sessions.length, 1);
    assert.equal(recovered.sessions[0].status, 'lost');
    assert.equal((await store.getCommand(input.owner, pending.command.id)).status, 'rejected');
    const invalidated = await store.getCommand(input.owner, ready.command.id);
    assert.equal(invalidated.status, 'rejected');
    assert.equal(invalidated.approvalDecision, 'approve', 'the prior human decision remains auditable but cannot dispatch');
    assert.equal((await store.getCommand(input.owner, running.command.id)).status, 'unknown');
    assert.equal((await store.getCommand(input.owner, running.command.id)).result.code, 'BROWSER_ACTION_OUTCOME_UNKNOWN');
    assert.equal(await store.hasUnknownCommandForRun(input.runId), true);
  });

  await t.test('approval requires the request hash and command idempotency rejects changed requests', async () => {
    const input = sessionInput();
    await activeSession(input);
    const first = await store.enqueueCommand({
      id: randomUUID(), owner: input.owner, sessionId: input.id, idempotencyKey: 'approval-key',
      requestHash: 'c'.repeat(64), request: { action: 'submit', value: 'yes' }, requiresApproval: true,
    });
    assert.equal(first.command.status, 'pending_approval');
    const replay = await store.enqueueCommand({
      id: randomUUID(), owner: input.owner, sessionId: input.id, idempotencyKey: 'approval-key',
      requestHash: 'c'.repeat(64), request: { action: 'submit', value: 'yes' }, requiresApproval: true,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.command.id, first.command.id);
    await assert.rejects(store.enqueueCommand({
      id: randomUUID(), owner: input.owner, sessionId: input.id, idempotencyKey: 'approval-key',
      requestHash: 'd'.repeat(64), request: { action: 'submit', value: 'no' }, requiresApproval: true,
    }), error => error.status === 409);
    await assert.rejects(store.approveCommand({
      owner: input.owner, id: first.command.id, decision: 'approve', requestHash: 'e'.repeat(64),
    }), error => error.status === 409);

    const approved = await store.approveCommand({
      owner: input.owner, id: first.command.id, decision: 'approve', requestHash: 'c'.repeat(64),
    });
    assert.equal(approved.status, 'ready');
    assert.equal(approved.approvalDecision, 'approve');
    assert.ok(approved.approvedAt);
    const repeated = await store.approveCommand({
      owner: input.owner, id: first.command.id, decision: 'approve', requestHash: 'c'.repeat(64),
    });
    assert.equal(repeated.id, approved.id);
    await assert.rejects(store.approveCommand({
      owner: input.owner, id: first.command.id, decision: 'reject', requestHash: 'c'.repeat(64),
    }), error => error.status === 409);
    assert.equal((await store.nextReadyCommand(input.owner, input.id)).id, first.command.id);
  });
});
