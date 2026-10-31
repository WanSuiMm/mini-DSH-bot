import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessService, configuredModel } from '../service/server.mjs';

const response = data => ({ ok: true, data, evidence: [], usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
const headers = { Authorization: 'Bearer fixture-coding', 'Content-Type': 'application/json' };
async function request(base, path, body) {
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...headers, 'Idempotency-Key': 'fixture-run' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(res.ok, `${res.status} ${await res.clone().text()}`);
  return res.json();
}
async function complete(base, id) {
  for (let index = 0; index < 100; index++) {
    const run = await request(base, `/v1/runs/${id}`);
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Coding run did not finish');
}

test('coding HTTP path audits native and MCP-style providers at the shared execution boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'micro-dsh-coding-'));
  await writeFile(join(root, 'safe.ts'), 'export const safe = true;');
  await writeFile(join(root, '.env'), 'NOT_REAL_TOKEN=fixture');
  let executions = 0;
  const definitions = ['native_read', 'mcp_repo_read', 'mcp_repo_remove'].map(name => ({ name, description: 'fixture capability', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }));
  const provider = {
    definitions: () => definitions,
    register(registry) {
      for (const { name } of definitions) registry.register(name, () => { executions++; return response({ file: 'safe result' }); }, {
        readOnly: !name.endsWith('remove'), policy: { effect: name.endsWith('remove') ? 'delete' : 'read', source: name.startsWith('mcp') ? 'mcp' : 'native', pathFields: ['path'] },
      });
    },
  };
  let calls = 0;
  const model = { async generate(req) {
    if (calls++ === 0) return response({ text: '', finishReason: 'tool_call', toolCalls: [
      { id: 'safe', name: 'native_read', input: { path: 'safe.ts' } },
      { id: 'blocked', name: 'mcp_repo_read', input: { path: '.env' } },
      { id: 'approval', name: 'mcp_repo_remove', input: { path: 'safe.ts' } },
    ] });
    assert.match(JSON.stringify(req.messages), /TOOL_POLICY_DENIED/);
    assert.match(JSON.stringify(req.messages), /TOOL_APPROVAL_REQUIRED/);
    return response({ text: 'Read one file; two other operations were not executed.', finishReason: 'stop' });
  } };
  const service = new HarnessService({ database: join(root, 'service.sqlite'), authTokens: { 'fixture-coding': 'owner' }, model, toolset: 'coding', toolProviders: [provider], workspaceRoot: root, executionProfile: 'fixture-coding-v1' });
  const address = await service.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await request(base, '/v1/sessions', { title: 'controlled coding fixture' });
    const created = await request(base, `/v1/sessions/${session.id}/runs`, { prompt: 'Exercise all three requested operations', mode: 'single', memoryStrategy: 'none' });
    const run = await complete(base, created.run.id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run.result));
    assert.equal(executions, 1);
    const events = await service.database.events(run.id, 0, 1000);
    assert.deepEqual(events.filter(event => event.type === 'tool.policy').map(event => event.payload.action).sort(), ['allow', 'approval', 'deny']);
    assert.equal(events.filter(event => event.type === 'tool.call').length, 1);
    assert.equal(events.filter(event => event.type === 'tool.result').length, 1);
    assert.doesNotMatch(JSON.stringify(events), /NOT_REAL_TOKEN/);
    assert.equal(run.request.executionProfile, service.executionProfile);
  } finally { await service.close(); }
});

test('configuration identity rejects changed and absent profiles even with reserved work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'micro-dsh-profile-'));
  let modelCalls = 0;
  const provider = { definitions: () => [{ name: 'read_repo', description: 'fixture', parameters: { type: 'object' } }], register() {} };
  const model = { async generate() { modelCalls++; return response({ text: 'not expected' }); } };
  const baseline = new HarnessService({ database: join(root, 'baseline.sqlite'), authTokens: { 'fixture-coding': 'owner' }, toolset: 'coding', toolProviders: [provider], workspaceRoot: root, executionProfile: 'fixture-profile-v1', model });
  await baseline.readyPromise;
  const previousServiceProfile = baseline.executionProfile;
  await baseline.close();
  const service = new HarnessService({ database: join(root, 'queue.sqlite'), authTokens: { 'fixture-coding': 'owner' }, toolset: 'coding', toolProviders: [provider], workspaceRoot: root, executionProfile: 'fixture-profile-v1',
    maxOutputTokens: 2048, model });
  try {
    await service.readyPromise;
    assert.notEqual(service.executionProfile, previousServiceProfile, 'changed service limits must change the recovery identity');
    const session = await service.database.createSession('owner', 'profile check');
    for (const profile of [previousServiceProfile, 'outdated', undefined]) {
      const { run } = await service.database.createRun('owner', session.id, `profile-${profile}`, { prompt: 'review', mode: 'single', memoryStrategy: 'none', toolset: 'coding', executionProfile: profile, budget: { maxDurationMs: 1000, maxTokens: 2000, maxToolCalls: 3, maxActiveChildren: 1 } });
      await service.database.event(run.id, 'run.execution_reserved', { deadline: Date.now() + 1000, specs: [], tasks: [], childTokens: 1000, summaryTokens: 1000 });
      const claimed = await service.database.claimNextRun(service.workerId);
      assert.equal(claimed.id, run.id);
      await service.execute(claimed, new AbortController().signal);
      assert.equal((await service.database.getRun('owner', run.id)).result.code, 'TOOL_CONFIGURATION_CHANGED');
    }
    assert.equal(modelCalls, 0);
  } finally { await service.close(); }
});

test('configured coding worker advertises approved extensions; planner exposes no tool authority', async () => {
  let wire;
  const extraTools = [{ name: 'repository_review_diff', description: 'pinned diff', parameters: { type: 'object', properties: {}, additionalProperties: false } }];
  const adapter = configuredModel({ toolset: 'coding', model: 'fixture', baseUrl: 'https://invalid.example/v1', extraTools,
    fetchImpl: async (_url, options) => { wire = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ message: { content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); } });
  await adapter.generate({ messages: [{ role: 'user', content: 'review' }] }, { allowedTools: ['repository_review_diff'] });
  assert.deepEqual(wire.tools.map(tool => tool.function.name), ['repository_review_diff']);
});
