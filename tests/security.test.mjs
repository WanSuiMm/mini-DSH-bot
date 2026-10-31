import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionGuard, redactSensitive } from '../service/security/guard.mjs';
import { ToolRegistry } from '../dist/tools/registry.js';

const context = (names, signal) => ({ sessionId: 's', agentId: 'a', taskId: 't', runId: 'r', attempt: 1, allowedTools: names, contextRefs: [], budget: {}, signal });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'micro-dsh-policy-'));
  await writeFile(join(root, 'source.ts'), 'export const value = 1;');
  await writeFile(join(root, '.env'), 'NOT_A_REAL_SECRET=test');
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'id_ed25519'), 'FAKE PRIVATE KEY FIXTURE');
  return { root, guard: createExecutionGuard({ workspaceRoot: root }) };
}

test('guard blocks protected, outside, traversing and NTFS-ambiguous resources before dispatch', async () => {
  const { guard } = await fixture();
  let dispatched = 0;
  const decisions = [];
  const tools = new ToolRegistry({ guard, onDecision: decision => decisions.push(decision) });
  tools.register('read', () => { dispatched++; return { ok: true, data: 'read', evidence: [] }; }, { readOnly: true, policy: { effect: 'read', pathFields: ['path'] } });
  for (const path of ['.env', '.ENV.local', '.envrc', '.ssh/id_ed25519', '../outside', 'C:relative', 'source.ts:stream', '\\\\server\\share', 'source.ts.']) {
    const result = await tools.execute('read', { path }, context(['read']));
    assert.equal(result.ok, false, path);
    assert.equal(result.error.code, 'TOOL_POLICY_DENIED', path);
  }
  assert.equal(dispatched, 0);
  assert.equal((await tools.execute('read', { path: 'source.ts' }, context(['read']))).ok, true);
  assert.equal(dispatched, 1);
  assert.equal(decisions.length, 10);
  assert.ok(decisions.every(value => !JSON.stringify(value).includes('NOT_A_REAL_SECRET')));
});

test('filesystem junctions/symlinks cannot alias permitted paths', async t => {
  const { root, guard } = await fixture();
  await mkdir(join(root, 'actual'));
  await writeFile(join(root, 'actual', 'visible.txt'), 'fixture');
  try { await symlink(join(root, 'actual'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (cause) { if (cause.code === 'EPERM') return t.skip('OS account cannot create links'); throw cause; }
  await assert.rejects(guard.assertReadablePath('alias/visible.txt'), error => error.code === 'SYMLINK_PATH');
});

test('mutations require external approval and raw shell commands never execute', async () => {
  const { guard } = await fixture();
  let called = 0;
  const tools = new ToolRegistry({ guard });
  for (const [name, policy] of Object.entries({ shell: { effect: 'command' }, git: { effect: 'git' }, remove: { effect: 'delete', pathFields: ['path'] }, opaque: { effect: 'opaque' } })) {
    tools.register(name, () => { called++; return { ok: true, data: {}, evidence: [] }; }, { policy });
  }
  for (const args of [['reset', '--hard'], ['clean', '-fdx'], ['push', '--force']]) {
    const result = await tools.execute('git', { args }, context(['git']));
    assert.equal(result.error.code, 'TOOL_APPROVAL_REQUIRED');
  }
  for (const input of [{ command: 'rm -rf .' }, { command: 'pwsh', args: ['-Command', 'Remove-Item *'] }, { command: 'git', args: ['-c', 'alias.status=!echo side-effect', 'status'] }, { command: 'git', args: ['show', 'HEAD:.env'] }, { command: 'git', args: ['diff'] }]) {
    assert.equal((await tools.execute('shell', input, context(['shell']))).error.code, 'TOOL_POLICY_DENIED');
  }
  assert.equal((await tools.execute('remove', { path: 'source.ts' }, context(['remove']))).error.code, 'TOOL_APPROVAL_REQUIRED');
  assert.equal((await tools.execute('opaque', {}, context(['opaque']))).error.code, 'TOOL_APPROVAL_REQUIRED');
  assert.equal(called, 0);
  assert.equal((await tools.execute('git', { args: ['status', '--porcelain'] }, context(['git']))).ok, true);
  assert.equal(called, 1);
});

test('unknown policy, failed policy and failed durable audit all fail closed', async () => {
  const { guard } = await fixture();
  let called = 0;
  for (const settings of [{ guard }, { guard: { evaluate() { throw new Error('private path'); } } }, { guard, onDecision() { throw new Error('disk failed'); } }]) {
    const tools = new ToolRegistry(settings).register('read', () => { called++; return { ok: true, data: null, evidence: [] }; }, settings.onDecision ? { policy: { effect: 'read' } } : {});
    const result = await tools.execute('read', {}, context(['read']));
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /private path|disk failed/);
  }
  assert.equal(called, 0);
});

test('cancellation during policy audit blocks dispatch and inputs cannot change after checking', async () => {
  const abort = new AbortController();
  let called = 0;
  const { guard } = await fixture();
  const cancelled = new ToolRegistry({ guard, onDecision() { abort.abort(); } }).register('read', () => { called++; }, { policy: { effect: 'read' } });
  assert.equal((await cancelled.execute('read', {}, context(['read'], abort.signal))).error.code, 'CANCELLED');
  const input = { path: 'source.ts' };
  const tools = new ToolRegistry({ guard, onDecision() { input.path = '.env'; } }).register('read', value => { assert.equal(value.path, 'source.ts'); return { ok: true, data: null, evidence: [] }; }, { policy: { effect: 'read', pathFields: ['path'] } });
  assert.equal((await tools.execute('read', input, context(['read']))).ok, true);
  assert.equal(called, 0);
});

test('native and MCP metadata use the same guard; annotations cannot authorize unknown effects', async () => {
  const { guard } = await fixture();
  const tools = new ToolRegistry({ guard });
  let dispatched = 0;
  for (const source of ['native', 'mcp']) {
    tools.register(`${source}_read`, () => { dispatched++; return { ok: true, data: null, evidence: [] }; }, { readOnly: true, policy: { effect: 'read', source, pathFields: ['path'] } });
    assert.equal((await tools.execute(`${source}_read`, { path: '.env' }, context([`${source}_read`]))).error.code, 'TOOL_POLICY_DENIED');
  }
  assert.equal(dispatched, 0);
});

test('result/audit redaction removes configured secret shapes without altering normal business fields', async () => {
  const { guard } = await fixture();
  let audit;
  const tools = new ToolRegistry({ guard, onDispatch(call) { audit = call; } }).register('read', () => ({ ok: true, data: {
    api_key: 'fixture', Authorization: 'fixture', text: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----', price: 20, totalTokens: 10,
  }, evidence: [] }), { policy: { effect: 'read' } });
  const result = await tools.execute('read', { password: 'fixture', query: 'headphones' }, context(['read']));
  assert.equal(audit.input.password, '[REDACTED]');
  assert.equal(result.data.api_key, '[REDACTED]');
  assert.equal(result.data.text, '[REDACTED_PRIVATE_KEY]');
  assert.equal(result.data.price, 20);
  assert.equal(result.data.totalTokens, 10);
  assert.equal(redactSensitive({ query: 'normal query' }).query, 'normal query');
});
