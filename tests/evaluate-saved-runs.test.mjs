import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateSavedRuns, validateTaskPlan } from '../benchmarks/evaluate_saved_runs.mjs';

const budget = { max_tokens: 1000, max_tool_calls: 5, max_duration_ms: 30_000 };
const backend = {
  provider: 'fixture-provider',
  model_id: 'fixture-model',
  model_revision: 'fixture-rev-1',
  harness_id: 'micro-dsh',
  harness_revision: 'fixture-commit',
};

function plan() {
  return {
    schema_version: 1,
    suite_id: 'test-only-suite',
    suite_version: 'fixture-v1',
    source: 'unit-test-only',
    planned_strategies: ['single', 'multi', 'memory'],
    tasks: [{ id: 'task-1', prompt: 'Fixture prompt', budget, constraints: { required: ['source'] } }],
  };
}

function run(strategy, taskSuccess, taskPlanSha256, status = 'ok') {
  return {
    task_plan_sha256: taskPlanSha256,
    task_id: 'task-1',
    strategy,
    status,
    budget,
    usage: { tokens: 100, tool_calls: 2, duration_ms: 3000 },
    backend,
    judgment: status === 'ok'
      ? { task_success: taskSuccess, constraints_success: taskSuccess, evaluator_id: 'fixture-reviewer', evaluator_version: 'v1' }
      : undefined,
    trace: [{ type: 'tool_result', evidence_refs: ['source:1'] }],
    ...(status !== 'ok' ? { failure: { code: 'FIXTURE_FAILURE' } } : {}),
  };
}

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'micro-dsh-eval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tasksPath = path.join(root, 'tasks.json');
  const responsesPath = path.join(root, 'responses.jsonl');
  const outputPath = path.join(root, 'output');
  writeFileSync(tasksPath, JSON.stringify(plan()), 'utf8');
  return { root, tasksPath, responsesPath, outputPath };
}

test('offline adapter keeps missing strategies in the planned denominator and retains traces', t => {
  const paths = setup(t);
  const { digest } = validateTaskPlan(paths.tasksPath);
  writeFileSync(paths.responsesPath, `${JSON.stringify(run('single', true, digest))}\n${JSON.stringify(run('multi', false, digest, 'failed'))}\n`, 'utf8');
  const summary = evaluateSavedRuns({ ...paths, expectedTaskSha256: digest });
  assert.equal(summary.planned_task_strategy_cells, 3);
  assert.equal(summary.strategies.single.denominator, 1);
  assert.equal(summary.strategies.single.task_success_rate, 1);
  assert.equal(summary.strategies.multi.task_success_rate, 0);
  assert.equal(summary.strategies.multi.failure_count, 1);
  assert.equal(summary.strategies.memory.missing_response_count, 1);
  assert.equal(summary.strategies.memory.task_success_rate, 0);
  const cell = JSON.parse(readFileSync(path.join(paths.outputPath, 'evaluations.jsonl'), 'utf8').split('\n')[0]);
  assert.deepEqual(cell.evidence_refs, ['source:1']);
  assert.equal(cell.trace_event_count, 1);
  assert.equal(cell.backend.model_revision, 'fixture-rev-1');
});

test('task hash drift and duplicate task strategy records are rejected', t => {
  const paths = setup(t);
  const { digest } = validateTaskPlan(paths.tasksPath);
  writeFileSync(paths.tasksPath, JSON.stringify({ ...plan(), suite_version: 'changed-v2' }), 'utf8');
  assert.throws(() => validateTaskPlan(paths.tasksPath, digest), /SHA-256 mismatch/u);

  writeFileSync(paths.tasksPath, JSON.stringify(plan()), 'utf8');
  const { digest: restoredDigest } = validateTaskPlan(paths.tasksPath);
  writeFileSync(paths.responsesPath, `${JSON.stringify(run('single', true, restoredDigest))}\n${JSON.stringify(run('single', false, restoredDigest))}\n`, 'utf8');
  assert.throws(
    () => evaluateSavedRuns({ ...paths }),
    /Duplicate saved run/u,
  );
});

test('budget drift is rejected and actual over-budget usage is scored as failure', t => {
  const paths = setup(t);
  const { digest } = validateTaskPlan(paths.tasksPath);
  const mismatched = { ...run('single', true, digest), budget: { ...budget, max_tokens: budget.max_tokens + 1 } };
  writeFileSync(paths.responsesPath, `${JSON.stringify(mismatched)}\n`, 'utf8');
  assert.throws(() => evaluateSavedRuns({ ...paths }), /Budget mismatch/u);

  const overBudget = { ...run('single', true, digest), usage: { tokens: 1001, tool_calls: 2, duration_ms: 3000 } };
  writeFileSync(paths.responsesPath, `${JSON.stringify(overBudget)}\n`, 'utf8');
  const summary = evaluateSavedRuns({ ...paths });
  assert.equal(summary.strategies.single.budget_violation_count, 1);
  assert.equal(summary.strategies.single.task_success_rate, 0);
});
