import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore, FileMemoryStore, lockState } from '../scripts/host.mjs';

test('Checkpoint keeps completed tasks across host instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'micro-dsh-checkpoint-'));
  try {
    const path = join(dir, 'tasks.json');
    const store = new FileTaskStore(path);
    const task = { sessionId: 's', taskId: 't', runId: 'r', attempt: 1, title: 't', instructions: 'work', dependencies: [], contextRefs: [], allowedTools: [], budget: {}, status: 'succeeded', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: { ok: true, data: 'done', evidence: [] } };
    await store.create(task);
    const restored = new FileTaskStore(path);
    assert.equal((await restored.get('t')).result.data, 'done');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('Memory is persistent, namespace scoped and deletable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'micro-dsh-memory-'));
  try {
    const path = join(dir, 'memory.json');
    const first = new FileMemoryStore(path);
    await first.create({ namespace: 'a', id: 'note', value: { text: 'evidence A' } });
    await first.create({ namespace: 'b', id: 'note', value: { text: 'evidence B' } });
    const second = new FileMemoryStore(path);
    assert.equal((await second.get('a', 'note')).value.text, 'evidence A');
    await second.delete('a', 'note');
    const third = new FileMemoryStore(path);
    assert.equal(await third.get('a', 'note'), undefined);
    assert.equal((await third.get('b', 'note')).value.text, 'evidence B');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('State directory cannot have two concurrent writers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'micro-dsh-lock-'));
  try {
    const release = lockState(dir);
    assert.throws(() => lockState(dir), /locked/);
    release();
    lockState(dir)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
