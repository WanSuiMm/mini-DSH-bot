import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertRuntimeIdentity, parseWorkerPlan, runCell, validatePlan } from '../benchmarks/appworld/runner.mjs';

const plan = () => ({ ...JSON.parse(readFileSync(new URL('../benchmarks/appworld/plan.template.json', import.meta.url))),
  task_ids: ['fixture_task'], model: { provider: 'fixture', model_id: 'fixture', model_revision: 'fixture-v1',
    api_key_env: 'TEST_MODEL_KEY', base_url: 'https://fixture.invalid', max_context_tokens: 32768, max_output_tokens: 512 } });
class World {
  constructor() { this.calls = []; this.changed = false; }
  async request(op, args = {}) {
    this.calls.push({ op, args });
    if (op === 'list_tasks') return { task_ids: ['fixture_task'] };
    if (op === 'start') { this.changed = false; return { instruction: 'Update one item and finish.', apps: ['todoist', 'supervisor', 'api_docs'], supervisor: {}, api_docs: {} }; }
    if (op === 'call') { this.changed = true; return { updated: true }; }
    if (op === 'evaluate') return { success: this.changed, num_tests: 1 };
    throw new Error('unexpected request');
  }
}
const response = (text, calls) => ({ ok: true, evidence: [], usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
  data: { text, finishReason: calls ? 'tool_call' : 'stop', ...(calls ? { toolCalls: calls } : {}) } });
const usageResponse = (text, calls, inputTokens, outputTokens, finishReason = 'stop') => ({
  ok: true, evidence: [], usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  data: { text, finishReason: calls ? 'tool_call' : finishReason, ...(calls ? { toolCalls: calls } : {}) },
});
const call = id => ({ id, name: 'appworld_api', input: { app: 'todoist', api: 'update_task', arguments: { task_id: 'one' } } });
const verifyCall = id => ({ id, name: 'appworld_api', input: { app: 'todoist', api: 'get_task', arguments: { task_id: 'one' } } });
const completionCall = id => ({ id, name: 'appworld_api', input: { app: 'supervisor', api: 'complete_task', arguments: { answer: 'fixture answer' } } });
const actionCompletionCall = id => ({ id, name: 'appworld_api', input: { app: 'supervisor', api: 'complete_task', arguments: { answer: null } } });

class CompletionWorld extends World {
  constructor({ failCompletion = false, completionResult = { message: 'Marked the active task complete.' } } = {}) {
    super(); this.failCompletion = failCompletion; this.completionResult = completionResult;
  }
  async request(op, args = {}) {
    if (op === 'call' && args.app === 'supervisor' && args.api === 'complete_task') {
      this.calls.push({ op, args });
      if (this.failCompletion) throw new Error('completion was not acknowledged');
      return this.completionResult;
    }
    if (op === 'evaluate') {
      this.calls.push({ op, args });
      return { success: this.changed, num_tests: 1 };
    }
    return super.request(op, args);
  }
}

test('durable event sink observes requests, responses and tool failures before return', async () => {
  const world = new World();
  world.request = async (op, args) => {
    if (op === 'call') throw Object.assign(new Error('fixture operation failed'), { code: 'FIXTURE_ERROR' });
    return World.prototype.request.call(world, op, args);
  };
  const observed = [];
  let turn = 0;
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: world,
    model: { generate: async () => ++turn === 1 ? response('', [call('one')]) : response('done') },
    runId: 'durable_fixture', onEvent: event => { observed.push(event); } });
  assert.deepEqual(observed, result.trace);
  assert.deepEqual(observed.map(event => event.sequence), observed.map((_, i) => i + 1));
  assert.ok(observed.find(event => event.type === 'model.request')?.request.messages.length);
  assert.ok(observed.find(event => event.type === 'model.response')?.result);
  assert.equal(observed.find(event => event.type === 'tool.failed')?.error.code, 'FIXTURE_ERROR');
  assert.ok(observed.every(event => typeof event.recorded_at === 'string'));
});

test('template cannot run until official IDs and model revision are frozen', () => {
  const template = JSON.parse(readFileSync(new URL('../benchmarks/appworld/plan.template.json', import.meta.url)));
  assert.throws(() => validatePlan(template), /official task IDs/);
  assert.equal(validatePlan(plan()).task_ids.length, 1);
  assert.throws(() => validatePlan({ ...plan(), max_runs: 1 }), /ceilings/);
  const providerLimit = plan(); providerLimit.model.max_output_tokens = 384000;
  assert.doesNotThrow(() => validatePlan(providerLimit));
  const aboveProviderLimit = plan(); aboveProviderLimit.model.max_output_tokens = 384001;
  assert.throws(() => validatePlan(aboveProviderLimit), /384000/);
  assert.throws(() => validatePlan({ ...plan(), repair_execution: 'yes' }), /repair_execution/);
});
test('planner rejects unknown dependencies, duplicate IDs and excessive workers', () => {
  assert.throws(() => parseWorkerPlan('{"tasks":[{"id":"a","instructions":"work","dependencies":["missing"]}]}'), /Dependencies/);
  assert.throws(() => parseWorkerPlan(JSON.stringify({ tasks: [1,2,3,4] })), /1–3/);
});
test('repaired planner accepts forward DAG references with stable topological order and rejects malformed graphs', () => {
  const forwardDag = JSON.stringify({ tasks: [
    { id: 'verify', instructions: 'verify the request', dependencies: ['prepare'] },
    { id: 'prepare', instructions: 'make the requested update', dependencies: [] },
  ] });
  assert.throws(() => parseWorkerPlan(forwardDag), /earlier workers/);
  assert.deepEqual(parseWorkerPlan(forwardDag, { repairExecution: true }).map(worker => worker.id), ['prepare', 'verify']);

  const unknownDependency = JSON.stringify({ tasks: [
    { id: 'worker', instructions: 'inspect state', dependencies: ['missing'] },
  ] });
  assert.throws(() => parseWorkerPlan(unknownDependency, { repairExecution: true }), /Unknown worker dependency/);
  const cyclicDag = JSON.stringify({ tasks: [
    { id: 'first', instructions: 'inspect state', dependencies: ['second'] },
    { id: 'second', instructions: 'inspect state', dependencies: ['first'] },
  ] });
  assert.throws(() => parseWorkerPlan(cyclicDag, { repairExecution: true }), /cycle/);
  const selfDependency = JSON.stringify({ tasks: [
    { id: 'worker', instructions: 'inspect state', dependencies: ['worker'] },
  ] });
  assert.throws(() => parseWorkerPlan(selfDependency, { repairExecution: true }), /itself/);
});
test('repaired planner defaults only omitted dependency fields to empty lists', () => {
  const omittedDependencies = JSON.stringify({ tasks: [
    { id: 'worker_1', instructions: 'inspect the first part' },
    { id: 'worker_2', instructions: 'inspect the second part' },
    { id: 'worker_3', instructions: 'combine observations and verify', dependencies: ['worker_1', 'worker_2'] },
  ] });
  assert.throws(() => parseWorkerPlan(omittedDependencies), /Dependencies must refer to earlier workers/);
  const workers = parseWorkerPlan(omittedDependencies, { repairExecution: true });
  assert.deepEqual(workers.map(worker => worker.id), ['worker_1', 'worker_2', 'worker_3']);
  assert.deepEqual(workers.map(worker => worker.dependencies), [[], [], ['worker_1', 'worker_2']]);

  const explicitNull = JSON.stringify({ tasks: [
    { id: 'worker', instructions: 'inspect state', dependencies: null },
  ] });
  assert.throws(() => parseWorkerPlan(explicitNull, { repairExecution: true }), /Invalid\/duplicate worker dependencies/);
});
test('remote model endpoints require TLS and runtime fingerprints reject dataset drift', () => {
  const p = plan(); p.model.base_url = 'http://example.com';
  assert.throws(() => validatePlan(p), /HTTPS/);
  p.model.base_url = 'http://127.0.0.1:8000/v1'; assert.doesNotThrow(() => validatePlan(p));
  const identity = { package: { sha256: 'a'.repeat(64) }, dataset: { sha256: 'b'.repeat(64) } };
  assert.doesNotThrow(() => assertRuntimeIdentity(identity, identity));
  assert.throws(() => assertRuntimeIdentity({ ...identity, dataset: { sha256: 'c'.repeat(64) } }, identity), /dataset/);
});
test('single strategy uses real AgentLoop/tool registration; score comes from evaluator, not assistant answer', async () => {
  const world = new World();
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: world, runId: 'single-fixture',
    model: { generate: async () => response('Task completed!') } });
  assert.equal(result.execution_ok, true); assert.equal(result.success, false);
  assert.equal(result.official_task_success, false); assert.equal(result.usage.total_tokens, 110);
  assert.deepEqual(world.calls.map(x => x.op), ['list_tasks', 'start', 'evaluate']);
});
test('tool execution reaches world, and official state judges success', async () => {
  const world = new World(); let n = 0;
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: world, runId: 'single-tool',
    model: { generate: async () => ++n === 1 ? response('', [call('c1')]) : response('done') } });
  assert.equal(result.success, true); assert.equal(result.usage.tool_calls, 1); assert.equal(result.usage.total_tokens, 220);
});
test('successful AppWorld completion acknowledgement ends the loop without another model call', async () => {
  const world = new CompletionWorld(); let count = 0;
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: world, runId: 'completion-ack',
    model: { generate: async () => { count++; return response('', [completionCall('complete')]); } } });
  assert.equal(count, 1);
  assert.equal(result.execution_ok, true);
  assert.equal(result.execution.data.text, 'Marked the active task complete.');
  assert.equal(result.usage.model_calls, 1);
  assert.equal(result.usage.tool_calls, 1);
  assert.equal(result.usage.total_tokens, 110);
  assert.equal(result.official_task_success, false);
  assert.equal(result.success, false);
  assert.deepEqual(world.calls.map(x => x.op), ['list_tasks', 'start', 'call', 'evaluate']);
});
test('cumulative token limit is opt-in to disable; per-request output cap and terminal acknowledgement remain active', async () => {
  const makeModel = disableCumulativeTokenLimit => {
    let count = 0;
    return {
      get count() { return count; },
      async generate(request, context) {
        assert.equal(request.maxOutputTokens, 512);
        if (disableCumulativeTokenLimit) assert.equal('maxTokens' in context.budget, false);
        count++;
        return count < 3
          ? usageResponse('', [call(`large-${count}`)], 32256, 512)
          : usageResponse('', [completionCall('complete-large')], 32256, 512);
      },
    };
  };

  const limitedModel = makeModel(false);
  const limited = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: new CompletionWorld(),
    runId: 'cumulative-limit-default', model: limitedModel });
  assert.equal(limited.success, false);
  assert.equal(limited.execution.error.code, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(limitedModel.count, 2);
  assert.equal(limited.usage.total_tokens, 65536);
  assert.equal(limited.budget.max_tokens, 65536);
  assert.equal(limited.token_budget_policy.cumulative_limit, 'enforced');

  const unboundedModel = makeModel(true);
  const unbounded = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: new CompletionWorld(),
    runId: 'cumulative-limit-disabled', model: unboundedModel, disableCumulativeTokenLimit: true });
  assert.equal(unbounded.success, true);
  assert.equal(unboundedModel.count, 3);
  assert.equal(unbounded.usage.total_tokens, 98304);
  assert.equal(unbounded.usage.complete, true);
  assert.equal(unbounded.budget_valid, true);
  assert.equal(unbounded.execution.data.text, 'Marked the active task complete.');
  assert.equal(unbounded.budget.max_tokens, null);
  assert.equal(unbounded.token_budget_policy.cumulative_limit, 'disabled');
  assert.equal(unbounded.token_budget_policy.source_plan_max_tokens, 65536);
  assert.equal(unbounded.token_budget_policy.effective_max_tokens, null);
});
test('failed AppWorld completion call does not terminate the loop', async () => {
  const world = new CompletionWorld({ failCompletion: true }); let count = 0;
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: world, runId: 'completion-failed',
    model: { generate: async () => ++count === 1
      ? response('', [completionCall('complete')])
      : response('Completion was not confirmed.') } });
  assert.equal(count, 2);
  assert.equal(result.execution_ok, true);
  assert.equal(result.execution.data.text, 'Completion was not confirmed.');
  assert.equal(result.usage.model_calls, 2);
  assert.equal(result.usage.tool_calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.trace.some(event => event.type === 'tool.failed'), true);
});
test('AppWorld completion error payload does not count as a terminal acknowledgement', async () => {
  const world = new CompletionWorld({ completionResult: { code: 'api_not_allowed', message: 'The API is not in this task\'s public API docs.' } });
  let count = 0;
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: world, runId: 'completion-error-payload',
    model: { generate: async () => ++count === 1
      ? response('', [completionCall('complete')])
      : response('Completion was not confirmed.') } });
  assert.equal(count, 2);
  assert.equal(result.execution_ok, true);
  assert.equal(result.usage.model_calls, 2);
  assert.equal(result.success, false);
});
test('a non-final completion call suppresses later AppWorld calls and fails the cell', async () => {
  const world = new CompletionWorld(); let count = 0;
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: world, runId: 'completion-not-last',
    model: { generate: async () => { count++; return response('', [completionCall('complete'), call('after-completion')]); } } });
  assert.equal(count, 1);
  assert.equal(result.execution_ok, false);
  assert.equal(result.execution.error.code, 'TERMINAL_TOOL_NOT_LAST');
  assert.equal(result.usage.model_calls, 1);
  assert.equal(result.usage.tool_calls, 1);
  assert.equal(result.execution.usage.toolCalls, 2);
  assert.equal(result.trace.some(event => event.type === 'tool.skipped_after_completion'), true);
  assert.equal(world.calls.filter(entry => entry.op === 'call').length, 1);
  assert.equal(world.calls.some(entry => entry.args.app === 'todoist'), false);
});
test('multi uses Supervisor, dependency outputs and one total planner/worker ledger', async () => {
  const world = new World(); const counters = {}; let dependencySeen = false;
  const model = { generate: async (request, context) => {
    const n = counters[context.agentId] = (counters[context.agentId] ?? 0) + 1;
    if (context.agentId === 'planner') return response(JSON.stringify({ tasks: [
      { id: 'discover', instructions: 'locate the item', dependencies: [] },
      { id: 'change', instructions: 'update it', dependencies: ['discover'] },
    ] }));
    if (context.agentId === 'discover') return response('item-one');
    dependencySeen = request.messages.some(m => m.content.includes('item-one'));
    return n === 1 ? response('', [call('change1')]) : response('done');
  } };
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'multi', client: world, model, runId: 'multi-fixture' });
  assert.equal(result.success, true); assert.equal(dependencySeen, true);
  assert.equal(result.usage.total_tokens, 440); assert.equal(result.usage.model_calls, 4);
  assert.equal(result.execution.workers.length, 2);
});
test('repaired multi borrows the shared tool budget and hands structured observations to a final verifier', async () => {
  const repairedPlan = plan(); repairedPlan.budget.max_tool_calls = 7;
  const world = new CompletionWorld(); const counters = {}; let handoffSeen = false; let finalVerificationPromptSeen = false;
  const model = { generate: async (request, context) => {
    const n = counters[context.agentId] = (counters[context.agentId] ?? 0) + 1;
    if (context.agentId === 'planner') return response(JSON.stringify({ tasks: [
      { id: 'inspect', instructions: 'inspect the target and report observed state', dependencies: [] },
      { id: 'prepare', instructions: 'prepare the requested update and report its result', dependencies: [] },
      { id: 'verify', instructions: 'verify the full request and finish', dependencies: [] },
    ] }));
    if (context.agentId === 'inspect') return n === 1
      ? response('', [call('inspect-1'), call('inspect-2'), call('inspect-3')])
      : response('Observed three AppWorld updates.');
    if (context.agentId === 'prepare') return n === 1
      ? response('', [call('prepare-1'), call('prepare-2')])
      : response('Prepared two AppWorld updates.');
    const prompt = request.messages.map(message => message.content ?? '').join('\n');
    handoffSeen ||= prompt.includes('Observed three AppWorld updates.') && prompt.includes('Prepared two AppWorld updates.')
      && prompt.includes('"updated":true');
    finalVerificationPromptSeen ||= prompt.includes('Independently inspect the current AppWorld state')
      && prompt.includes('verify every part of the original request');
    if (n === 1) return response('', [verifyCall('verify-final-state')]);
    return response('', [actionCompletionCall('complete-after-verification')]);
  } };

  const repaired = await runCell({ plan: repairedPlan, taskId: 'fixture_task', strategy: 'multi', client: world, model,
    runId: 'shared-tool-repair', repairExecution: true });
  assert.equal(repaired.success, true);
  assert.equal(repaired.usage.tool_calls, 7);
  assert.equal(handoffSeen, true);
  assert.equal(finalVerificationPromptSeen, true);
  assert.deepEqual(repaired.execution.worker_handoffs.inspect.observations[0].result, { updated: true });
  assert.equal(repaired.orchestration_policy.shared_global_tool_budget, true);
  const calls = world.calls.filter(entry => entry.op === 'call');
  assert.equal(calls.filter(entry => entry.args.app === 'supervisor' && entry.args.api === 'complete_task').length, 1);
  assert.equal(calls.at(-2).args.api, 'get_task');
  assert.equal(calls.at(-1).args.api, 'complete_task');

  const legacyPlan = plan(); legacyPlan.budget.max_tool_calls = 7;
  const legacyWorld = new CompletionWorld(); const legacyCounters = {};
  const legacyModel = { generate: async (_request, context) => {
    const n = legacyCounters[context.agentId] = (legacyCounters[context.agentId] ?? 0) + 1;
    if (context.agentId === 'planner') return response(JSON.stringify({ tasks: [
      { id: 'inspect', instructions: 'inspect the target and report observed state', dependencies: [] },
      { id: 'prepare', instructions: 'prepare the requested update and report its result', dependencies: [] },
      { id: 'verify', instructions: 'verify the full request and finish', dependencies: [] },
    ] }));
    if (context.agentId === 'inspect') return n === 1
      ? response('', [call('inspect-1'), call('inspect-2'), call('inspect-3')])
      : response('Observed three AppWorld updates.');
    if (context.agentId === 'prepare') return n === 1
      ? response('', [call('prepare-1'), call('prepare-2')])
      : response('Prepared two AppWorld updates.');
    return n === 1 ? response('', [verifyCall('verify-final-state')])
      : response('', [completionCall('complete-after-verification')]);
  } };
  const legacy = await runCell({ plan: legacyPlan, taskId: 'fixture_task', strategy: 'multi', client: legacyWorld,
    model: legacyModel, runId: 'shared-tool-legacy' });
  assert.equal(legacy.execution.status, 'partial');
  assert.equal(legacy.execution.workers.find(worker => worker.taskId === 'inspect').status, 'failed');
  assert.equal(legacy.orchestration_policy, undefined);
});
test('repaired mode denies intermediate completion and lets only the final verified worker close the world', async () => {
  const repairedPlan = plan(); repairedPlan.repair_execution = true;
  const world = new CompletionWorld(); const counters = {}; let finalSawDenial = false; let finalPromptSeen = false;
  const model = { generate: async (request, context) => {
    const n = counters[context.agentId] = (counters[context.agentId] ?? 0) + 1;
    if (context.agentId === 'planner') return response(JSON.stringify({ tasks: [
      { id: 'intermediate', instructions: 'collect the relevant task state', dependencies: [] },
      { id: 'final', instructions: 'verify the original request and finish it', dependencies: [] },
    ] }));
    if (context.agentId === 'intermediate') return n === 1
      ? response('', [completionCall('premature-completion')])
      : response('I collected an observation; the final worker still needs to verify current state.');
    const prompt = request.messages.map(message => message.content ?? '').join('\n');
    finalSawDenial ||= prompt.includes('FINAL_WORKER_ONLY') && prompt.includes('I collected an observation');
    finalPromptSeen ||= prompt.includes('Independently inspect the current AppWorld state');
    if (n === 1) return response('', [verifyCall('final-state-check')]);
    return response('', [actionCompletionCall('authorized-completion')]);
  } };

  const result = await runCell({ plan: repairedPlan, taskId: 'fixture_task', strategy: 'multi', client: world, model, runId: 'final-worker-only' });
  assert.equal(result.success, true);
  assert.equal(finalSawDenial, true);
  assert.equal(finalPromptSeen, true);
  assert.equal(result.trace.some(event => event.type === 'tool.denied' && event.code === 'FINAL_WORKER_ONLY'
    && event.agent_id === 'intermediate'), true);
  const completeEvents = result.trace.filter(event => event.type === 'tool.call' && event.app === 'supervisor' && event.api === 'complete_task');
  assert.equal(completeEvents.length, 1);
  assert.equal(completeEvents[0].agent_id, 'final');
  const worldCompletionCalls = world.calls.filter(entry => entry.op === 'call' && entry.args.app === 'supervisor'
    && entry.args.api === 'complete_task');
  assert.equal(worldCompletionCalls.length, 1);
  assert.deepEqual(world.calls.filter(entry => entry.op === 'call').map(entry => entry.args.api), ['get_task', 'complete_task']);
});
test('repaired multi topologically schedules forward dependencies and designates the last worker as final verifier', async () => {
  const world = new CompletionWorld(); const counters = {}; const workerStarts = []; let finalSawHandoff = false;
  const model = { generate: async (request, context) => {
    const n = counters[context.agentId] = (counters[context.agentId] ?? 0) + 1;
    if (context.agentId === 'planner') return response(JSON.stringify({ tasks: [
      { id: 'verify', instructions: 'check state and finish', dependencies: ['prepare'] },
      { id: 'prepare', instructions: 'make the requested change and report it', dependencies: [] },
    ] }));
    if (n === 1) workerStarts.push(context.agentId);
    if (context.agentId === 'prepare') return n === 1
      ? response('', [call('prepare-update')])
      : response('Prepared the requested task update.');
    const prompt = request.messages.map(message => message.content ?? '').join('\n');
    finalSawHandoff ||= prompt.includes('Prepared the requested task update.')
      && prompt.includes('Independently inspect the current AppWorld state');
    return n === 1 ? response('', [verifyCall('verify-forward-dag')])
      : response('', [actionCompletionCall('complete-forward-dag')]);
  } };

  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'multi', client: world, model,
    runId: 'forward-dag-repair', repairExecution: true });
  assert.equal(result.success, true);
  assert.deepEqual(workerStarts, ['prepare', 'verify']);
  assert.equal(finalSawHandoff, true);
  assert.deepEqual(result.execution.workers.map(worker => worker.taskId), ['prepare', 'verify']);
  assert.equal(result.orchestration_policy.worker_dependency_policy, 'stable_topological_dag');
  assert.equal(result.orchestration_policy.worker_plan_reordered, true);
  assert.equal(result.orchestration_policy.max_model_calls, plan().budget.max_tool_calls + 3);
});
test('disabled cumulative limit removes planner and worker token quotas while keeping their tool quotas', async () => {
  const multiPlan = plan();
  const makeModel = disableCumulativeTokenLimit => {
    const counts = new Map();
    return {
      calls: counts,
      async generate(request, context) {
        assert.equal(request.maxOutputTokens, 512);
        if (disableCumulativeTokenLimit) assert.equal('maxTokens' in context.budget, false);
        const count = (counts.get(context.agentId) ?? 0) + 1;
        counts.set(context.agentId, count);
        const measured = (text, calls) => usageResponse(text, calls, 24588, 512);
        if (context.agentId === 'planner') return measured(JSON.stringify({ tasks: [
          { id: 'discover', instructions: 'locate the item', dependencies: [] },
          { id: 'change', instructions: 'update it', dependencies: ['discover'] },
        ] }));
        if (context.agentId === 'discover') return measured('item-one');
        return count === 1 ? measured('', [call('change-large')]) : measured('done');
      },
    };
  };

  const limitedModel = makeModel(false);
  const limited = await runCell({ plan: multiPlan, taskId: 'fixture_task', strategy: 'multi', client: new World(),
    runId: 'multi-cumulative-default', model: limitedModel });
  assert.equal(limited.success, false);
  assert.equal(limited.execution.error.code, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(limitedModel.calls.get('planner'), 1);
  assert.equal(limited.usage.total_tokens, 25100);

  const unboundedModel = makeModel(true);
  const unbounded = await runCell({ plan: multiPlan, taskId: 'fixture_task', strategy: 'multi', client: new World(),
    runId: 'multi-cumulative-disabled', model: unboundedModel, disableCumulativeTokenLimit: true });
  assert.equal(unbounded.success, true);
  assert.equal(unbounded.usage.total_tokens, 100400);
  assert.equal(unbounded.usage.model_calls, 4);
  assert.equal(unbounded.usage.tool_calls, 1);
  assert.equal(unbounded.execution.workers.length, 2);
  assert.equal(unbounded.token_budget_policy.cumulative_limit, 'disabled');
});
test('disabled cumulative limit keeps provider context, output, tool and time limits active', async () => {
  const contextWorld = new World();
  let contextGenerations = 0;
  const contextBound = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: contextWorld,
    runId: 'context-bound', disableCumulativeTokenLimit: true, model: {
      countTokens: async () => ({ ok: true, data: { inputTokens: 32768, maxContextTokens: 32768 }, evidence: [] }),
      generate: async () => { contextGenerations++; return response('should not generate'); },
    } });
  assert.equal(contextBound.execution.error.code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(contextGenerations, 0);

  const outputPlan = plan(); outputPlan.model.max_output_tokens = 16;
  let requestedOutputTokens;
  const outputBound = await runCell({ plan: outputPlan, taskId: 'fixture_task', strategy: 'single', client: new World(),
    runId: 'output-bound', disableCumulativeTokenLimit: true, model: {
      generate: async request => {
        requestedOutputTokens = request.maxOutputTokens;
        return usageResponse('partial', undefined, 100, 16, 'length');
      },
    } });
  assert.equal(requestedOutputTokens, 16);
  assert.equal(outputBound.execution.error.code, 'MODEL_OUTPUT_TRUNCATED');

  const toolPlan = plan(); toolPlan.budget.max_tool_calls = 1;
  const toolBound = await runCell({ plan: toolPlan, taskId: 'fixture_task', strategy: 'single', client: new World(),
    runId: 'tool-bound', disableCumulativeTokenLimit: true, model: {
      generate: async () => usageResponse('', [call('tool-one'), call('tool-two')], 100, 10),
    } });
  assert.equal(toolBound.execution.error.code, 'TOOL_BUDGET_EXCEEDED');
  assert.equal(toolBound.usage.tool_calls, 0);

  const timePlan = plan(); timePlan.budget.max_duration_ms = 50;
  const timeBound = await runCell({ plan: timePlan, taskId: 'fixture_task', strategy: 'single', client: new World(),
    runId: 'time-bound', disableCumulativeTokenLimit: true, model: {
      generate: async (_request, context) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response('late')), 200);
        context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('fixture aborted')); }, { once: true });
      }),
    } });
  assert.equal(timeBound.execution_ok, false);
  assert.equal(timeBound.budget_valid, false);
  assert.ok(timeBound.usage.duration_ms >= 50);
});
test('missing provider usage stops new model dispatch and cannot produce a qualified score', async () => {
  const world = new World(); let count = 0;
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'multi', client: world, runId: 'missing-usage',
    model: { generate: async () => { count++; const r = response('ignored'); delete r.usage; return r; } } });
  assert.equal(result.success, false); assert.equal(result.usage.complete, false); assert.equal(result.usage.total_tokens, null);
  assert.equal(count, 1); assert.equal(world.calls.some(c => c.op === 'evaluate'), true);
});
test('evaluator failure remains a failed cell', async () => {
  const world = new World(); const request = world.request.bind(world);
  world.request = (op, args) => op === 'evaluate' ? Promise.reject(new Error('no evaluator')) : request(op, args);
  const result = await runCell({ plan: plan(), taskId: 'fixture_task', strategy: 'single', client: world, runId: 'eval-failure',
    model: { generate: async () => response('done') } });
  assert.equal(result.success, false); assert.equal(result.failure.code, 'EVALUATOR_ERROR');
});
