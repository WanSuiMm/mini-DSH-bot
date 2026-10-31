import { createHash } from 'node:crypto';

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

const incrementOnceScript = `
local previous = redis.call('GET', KEYS[2])
if previous then return {tonumber(previous), 0} end
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if count <= tonumber(ARGV[2]) then redis.call('SET', KEYS[2], count, 'PX', ARGV[3]) end
return {count, 1}
`;

/** Shared per-owner run admission counter backed by Redis. */
export class RedisRunQuota {
  static async connect(url, { limit = 60, windowMs = 60_000 } = {}) {
    if (typeof url !== 'string' || !url.trim()) throw new Error('Redis URL is required');
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1000) {
      throw new Error('Redis quota limit and window must be positive finite integers');
    }
    const { createClient } = await import('redis');
    const client = createClient({ url });
    client.on('error', () => {});
    await client.connect();
    return new RedisRunQuota(client, limit, windowMs);
  }

  constructor(client, limit, windowMs) {
    this.client = client; this.limit = limit; this.windowMs = windowMs;
  }

  async consume(owner, idempotencyKey) {
    const digest = createHash('sha256').update(owner).digest('hex');
    const bucket = Math.floor(Date.now() / this.windowMs);
    const key = `micro-dsh:run-quota:${digest}:${bucket}`;
    let count;
    if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
      const requestDigest = createHash('sha256').update(owner).update('\0').update(idempotencyKey).digest('hex');
      const dedupeKey = `micro-dsh:run-idempotency:${requestDigest}`;
      const result = await this.client.eval(incrementOnceScript, {
        keys: [key, dedupeKey],
        arguments: [String(this.windowMs), String(this.limit), String(24 * 60 * 60 * 1000)],
      });
      count = Number(result[0]);
    } else {
      count = Number(await this.client.eval(incrementScript, { keys: [key], arguments: [String(this.windowMs)] }));
    }
    return { allowed: count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - count) };
  }

  async close() { await this.client.quit(); }
}
