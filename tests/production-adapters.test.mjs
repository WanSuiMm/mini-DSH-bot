import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const enabled = process.env.MICRO_DSH_RUN_ADAPTER_SMOKE === '1';

test('Fastify, PostgreSQL and Redis production adapters persist service state with a fixture model', { skip: !enabled }, async () => {
  const databaseUrl = process.env.MICRO_DSH_DATABASE_URL;
  const redisUrl = process.env.MICRO_DSH_REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error('Adapter smoke requires PostgreSQL and Redis URLs in the process environment');

  const [{ Pool }, { PostgresServiceDatabase }, { RedisRunQuota }, { HarnessService }, { createFastifyServer }] = await Promise.all([
    import('pg'), import('../service/postgres-database.mjs'), import('../service/redis-quota.mjs'),
    import('../service/server.mjs'), import('../service/fastify-server.mjs'),
  ]);
  const owner = `adapter-smoke-${randomUUID()}`;
  const token = `fixture-token-${randomUUID()}`;
  const otherToken = `fixture-token-${randomUUID()}`;
  let database;
  let quota;
  let service;
  let http;
  const cleanupPool = new Pool({ connectionString: databaseUrl, max: 1, application_name: 'micro-dsh-adapter-smoke-cleanup' });

  const request = async (baseUrl, path, bearer, method = 'GET', body, headers = {}) => {
    const response = await fetch(baseUrl + path, { method, headers: {
      Authorization: `Bearer ${bearer}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };

  try {
    database = await PostgresServiceDatabase.connect(databaseUrl, { applicationName: 'micro-dsh-adapter-smoke' });
    quota = await RedisRunQuota.connect(redisUrl, { limit: 2, windowMs: 60_000 });
    const fixtureModel = { async generate(input) {
      return { ok: true, data: { text: `Fixture answer: ${input.messages.at(-1)?.content.slice(0, 80)}`, finishReason: 'stop' }, evidence: [], usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    } };
    service = new HarnessService({ database, authTokens: { [token]: owner, [otherToken]: `${owner}-other` }, model: fixtureModel,
      toolset: 'commerce', searchBaseUrl: 'http://127.0.0.1:1', quotaLimiter: quota });
    await service.readyPromise;
    http = await createFastifyServer(service);
    const address = new URL(await http.listen({ host: '127.0.0.1', port: 0 }));
    const baseUrl = address.origin;

    const created = await request(baseUrl, '/v1/sessions', token, 'POST', { title: 'Adapter smoke' });
    assert.equal(created.status, 201);
    const sessionId = created.data.id;
    const memoryPath = `/v1/sessions/${sessionId}/memory`;
    assert.equal((await request(baseUrl, memoryPath, token, 'PUT', { id: 'preference', value: { budget: 500, category: 'laptop' } })).status, 200);
    assert.equal((await request(baseUrl, `${memoryPath}?scope=account`, token, 'PUT', { id: 'currency', value: 'USD' })).status, 200);
    assert.equal((await request(baseUrl, memoryPath, otherToken)).status, 404);
    assert.equal((await request(baseUrl, `${memoryPath}?scope=account`, otherToken)).status, 404);
    await request(baseUrl, memoryPath, token, 'PUT', { id: 'short-lived', value: 'temporary', ttlMs: 20 });
    await delay(40);
    assert.equal((await request(baseUrl, memoryPath, token)).data.some(record => record.id === 'short-lived'), false);

    const runPath = `/v1/sessions/${sessionId}/runs`;
    const runRequest = { prompt: 'Find a lightweight laptop under $500', mode: 'single' };
    const runHeaders = { 'Idempotency-Key': 'adapter-run' };
    const submitted = await request(baseUrl, runPath, token, 'POST', runRequest, runHeaders);
    assert.equal(submitted.status, 202);
    const runId = submitted.data.run.id;
    let run;
    for (let attempt = 0; attempt < 100; attempt++) {
      run = (await request(baseUrl, `/v1/runs/${runId}`, token)).data;
      if (['succeeded', 'failed', 'partial', 'cancelled', 'timed_out'].includes(run.status)) break;
      await delay(20);
    }
    assert.equal(run.status, 'succeeded');
    assert.equal((await request(baseUrl, runPath, token, 'POST', runRequest, runHeaders)).data.replayed, true);
    assert.equal((await request(baseUrl, runPath, token, 'POST', { ...runRequest, prompt: 'changed' }, runHeaders)).status, 409);
    assert.equal((await request(baseUrl, `/v1/sessions/${sessionId}`, token)).data.runs[0].id, runId);

    const sameQuotaRequest = await quota.consume(owner, `${sessionId}:adapter-run`);
    assert.deepEqual(sameQuotaRequest, { allowed: true, limit: 2, remaining: 1 });
    assert.deepEqual(await quota.consume(owner, `${sessionId}:adapter-run-2`), { allowed: true, limit: 2, remaining: 0 });
    assert.equal((await quota.consume(owner, `${sessionId}:adapter-run-3`)).allowed, false);

    const ownerDigest = createHash('sha256').update(owner).digest('hex');
    const requestDigest = createHash('sha256').update(owner).update('\0').update(`${sessionId}:adapter-run`).digest('hex');
    const quotaBucket = `micro-dsh:run-quota:${ownerDigest}:${Math.floor(Date.now() / 60_000)}`;
    const quotaKeys = [quotaBucket, `micro-dsh:run-idempotency:${requestDigest}`,
      ...['adapter-run-2', 'adapter-run-3'].map(key => `micro-dsh:run-idempotency:${createHash('sha256').update(owner).update('\0').update(`${sessionId}:${key}`).digest('hex')}`)];
    await quota.client.del(quotaKeys);
    assert.equal(await quota.client.exists(quotaKeys), 0);

    await http.close(); http = undefined;
    await service.close(); service = undefined; database = undefined; quota = undefined;

    database = await PostgresServiceDatabase.connect(databaseUrl, { applicationName: 'micro-dsh-adapter-smoke-reopen' });
    assert.ok(await database.session(owner, sessionId));
    assert.equal((await database.sessionRuns(owner, sessionId))[0].status, 'succeeded');
    assert.equal((await database.memoryList(`${owner}:${sessionId}`)).find(record => record.id === 'preference').value.budget, 500);
    assert.equal((await database.memoryList(`${owner}:longterm`)).find(record => record.id === 'currency').value, 'USD');
    assert.equal((await database.memoryList(`${owner}:${sessionId}`)).some(record => record.id === 'short-lived'), false);
  } finally {
    if (http) await http.close().catch(() => {});
    if (service) await service.close().catch(() => {});
    else {
      if (database) await database.close().catch(() => {});
      if (quota) await quota.close().catch(() => {});
    }
    try {
      await cleanupPool.query('DELETE FROM runs WHERE owner=$1', [owner]);
      await cleanupPool.query('DELETE FROM memory WHERE namespace LIKE $1', [`${owner}:%`]);
      await cleanupPool.query('DELETE FROM sessions WHERE owner=$1', [owner]);
      const leftovers = (await cleanupPool.query(`SELECT
        (SELECT COUNT(*) FROM sessions WHERE owner=$1) AS sessions,
        (SELECT COUNT(*) FROM runs WHERE owner=$1) AS runs,
        (SELECT COUNT(*) FROM memory WHERE namespace LIKE $2) AS memories`, [owner, `${owner}:%`])).rows[0];
      assert.equal(Number(leftovers.sessions) + Number(leftovers.runs) + Number(leftovers.memories), 0);
    } finally { await cleanupPool.end(); }
    if (database) await database.close().catch(() => {});
  }
});
