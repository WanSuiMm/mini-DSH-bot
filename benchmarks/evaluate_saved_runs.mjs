import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STRATEGIES = new Set(['single', 'multi', 'memory']);
const PLAN_BUDGET_FIELDS = ['max_tokens', 'max_tool_calls', 'max_duration_ms'];
const USAGE_FIELDS = ['tokens', 'tool_calls', 'duration_ms'];
const BACKEND_FIELDS = ['provider', 'model_id', 'model_revision', 'harness_id', 'harness_revision'];
const MAX_TASKS = 1000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a nonempty string`);
  return value.trim();
}

function readBounded(path, field) {
  const buffer = readFileSync(path);
  if (buffer.byteLength > MAX_INPUT_BYTES) fail(`${field} exceeds the ${MAX_INPUT_BYTES}-byte input limit`);
  return buffer;
}

function validateBudget(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...PLAN_BUDGET_FIELDS].sort())) {
    fail(`${field} must contain exactly ${PLAN_BUDGET_FIELDS.join(', ')}`);
  }
  for (const key of PLAN_BUDGET_FIELDS) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) fail(`${field}.${key} must be a positive safe integer`);
  }
  return value;
}

export function validateTaskPlan(path, expectedSha256) {
  const raw = readBounded(path, 'Task plan');
  let plan;
  try {
    plan = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    fail(`Cannot parse task plan JSON: ${error.message}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.schema_version !== 1) {
    fail('Task plan must be an object with schema_version=1');
  }
  for (const field of ['suite_id', 'suite_version', 'source']) nonempty(plan[field], field);
  if (!Array.isArray(plan.planned_strategies) || plan.planned_strategies.length < 2) {
    fail('planned_strategies must list at least two comparison strategies');
  }
  if (plan.planned_strategies.some(value => typeof value !== 'string' || !STRATEGIES.has(value))
      || new Set(plan.planned_strategies).size !== plan.planned_strategies.length
      || !plan.planned_strategies.includes('single')) {
    fail('planned_strategies must be unique values from single, multi, memory and include single');
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > MAX_TASKS) {
    fail(`tasks must contain between 1 and ${MAX_TASKS} frozen task definitions`);
  }
  const ids = new Set();
  for (let index = 0; index < plan.tasks.length; index += 1) {
    const task = plan.tasks[index];
    if (!task || typeof task !== 'object' || Array.isArray(task)) fail(`tasks[${index}] must be an object`);
    task.id = nonempty(task.id, `tasks[${index}].id`);
    if (ids.has(task.id)) fail(`Duplicate task ID: ${task.id}`);
    ids.add(task.id);
    nonempty(task.prompt, `task ${task.id} prompt`);
    validateBudget(task.budget, `task ${task.id} budget`);
    if (task.constraints !== undefined && (!task.constraints || typeof task.constraints !== 'object' || Array.isArray(task.constraints))) {
      fail(`task ${task.id} constraints must be an object when present`);
    }
  }
  const digest = sha256(raw);
  if (expectedSha256 && digest.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
    fail(`Task plan SHA-256 mismatch: expected ${expectedSha256}, found ${digest}`);
  }
  return { plan, digest };
}

function parseJsonl(path) {
  const raw = readBounded(path, 'Saved runs');
  const rows = [];
  const lines = raw.toString('utf8').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let row;
    try {
      row = JSON.parse(lines[index]);
    } catch (error) {
      fail(`Invalid saved-run JSONL line ${index + 1}: ${error.message}`);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`Saved-run row ${index + 1} must be an object`);
    rows.push(row);
  }
  return { rows, digest: sha256(raw) };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateBackend(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const backend = {};
  for (const key of BACKEND_FIELDS) backend[key] = nonempty(value[key], `${field}.${key}`);
  if (value.adapter_version !== undefined) backend.adapter_version = nonempty(value.adapter_version, `${field}.adapter_version`);
  return backend;
}

function validateUsage(value, budget, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...USAGE_FIELDS].sort())) {
    fail(`${field} must contain exactly ${USAGE_FIELDS.join(', ')}`);
  }
  for (const key of USAGE_FIELDS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(`${field}.${key} must be a nonnegative safe integer`);
  }
  const violations = [];
  for (const [usageKey, budgetKey] of [['tokens', 'max_tokens'], ['tool_calls', 'max_tool_calls'], ['duration_ms', 'max_duration_ms']]) {
    if (value[usageKey] > budget[budgetKey]) violations.push(`${usageKey}_exceeds_budget`);
  }
  return { usage: value, violations };
}

function validateTrace(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array, including for runs with no events`);
  for (let index = 0; index < value.length; index += 1) {
    const event = value[index];
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail(`${field}[${index}] must be an object`);
    nonempty(event.type, `${field}[${index}].type`);
  }
  return value;
}

function validateJudgment(value, task, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is required for a successful saved run`);
  if (typeof value.task_success !== 'boolean') fail(`${field}.task_success must be boolean`);
  if (typeof value.evaluator_id !== 'string' || !value.evaluator_id.trim()) fail(`${field}.evaluator_id must identify the evaluator`);
  if (typeof value.evaluator_version !== 'string' || !value.evaluator_version.trim()) fail(`${field}.evaluator_version must identify the evaluator version`);
  const hasConstraints = Object.keys(task.constraints ?? {}).length > 0;
  if (hasConstraints && typeof value.constraints_success !== 'boolean') {
    fail(`${field}.constraints_success must be boolean for constrained tasks`);
  }
  if (!hasConstraints && value.constraints_success !== null) {
    fail(`${field}.constraints_success must be null when the task has no declared constraints`);
  }
  return value;
}

function normalizeRecords(plan, responseRows, taskDigest) {
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  const plannedKeys = new Set(plan.tasks.flatMap(task => plan.planned_strategies.map(strategy => `${task.id}\0${strategy}`)));
  const mapped = new Map();
  const validated = new Map();
  const allowedStatuses = new Set(['ok', 'failed', 'timeout', 'cancelled', 'partial']);
  for (let index = 0; index < responseRows.length; index += 1) {
    const record = responseRows[index];
    const taskId = nonempty(record.task_id, `saved run ${index + 1} task_id`);
    const strategy = nonempty(record.strategy, `saved run ${index + 1} strategy`);
    const key = `${taskId}\0${strategy}`;
    if (!plannedKeys.has(key)) fail(`Unexpected saved run: ${taskId}/${strategy}`);
    if (mapped.has(key)) fail(`Duplicate saved run: ${taskId}/${strategy}`);
    if (typeof record.task_plan_sha256 !== 'string' || record.task_plan_sha256.toLowerCase() !== taskDigest.toLowerCase()) {
      fail(`Saved run ${taskId}/${strategy} is not pinned to this task plan`);
    }
    const task = tasks.get(taskId);
    const status = nonempty(record.status, `saved run ${taskId}/${strategy} status`);
    if (!allowedStatuses.has(status)) fail(`Invalid status for ${taskId}/${strategy}: ${status}`);
    if (stableJson(record.budget) !== stableJson(task.budget)) fail(`Budget mismatch for ${taskId}/${strategy}`);
    const backend = validateBackend(record.backend, `saved run ${taskId}/${strategy} backend`);
    const { usage, violations } = validateUsage(record.usage, task.budget, `saved run ${taskId}/${strategy} usage`);
    const trace = validateTrace(record.trace, `saved run ${taskId}/${strategy} trace`);
    const judgment = status === 'ok'
      ? validateJudgment(record.judgment, task, `saved run ${taskId}/${strategy} judgment`)
      : record.judgment ?? null;
    const normalized = { record, task, strategy, status, backend, usage, violations, trace, judgment };
    mapped.set(key, record);
    validated.set(key, normalized);
  }
  return { tasks, plannedKeys, mapped, validated };
}

function traceEvidenceRefs(trace) {
  const refs = [];
  for (const event of trace) {
    if (Array.isArray(event.evidence_refs)) {
      for (const ref of event.evidence_refs) if (typeof ref === 'string') refs.push(ref);
    }
    if (Array.isArray(event.evidence)) {
      for (const item of event.evidence) {
        if (typeof item === 'string') refs.push(item);
        else if (item && typeof item.id === 'string') refs.push(item.id);
      }
    }
  }
  return [...new Set(refs)];
}

function scorePlan(plan, taskDigest, responseDigest, responseRows) {
  const { plannedKeys, validated } = normalizeRecords(plan, responseRows, taskDigest);
  const cells = [];
  for (const task of plan.tasks) {
    for (const strategy of plan.planned_strategies) {
      const key = `${task.id}\0${strategy}`;
      const item = validated.get(key);
      const missing = !item;
      const budgetViolations = item?.violations ?? [];
      const status = missing ? 'missing_response' : budgetViolations.length ? 'budget_exceeded' : item.status;
      const rawJudgment = item?.judgment ?? null;
      const judgedSuccess = status === 'ok' && rawJudgment?.task_success === true;
      const hasConstraints = Object.keys(task.constraints ?? {}).length > 0;
      const constraintsSuccess = hasConstraints
        ? status === 'ok' && rawJudgment?.constraints_success === true
        : null;
      const trace = item?.trace ?? [];
      const traceText = stableJson(trace);
      cells.push({
        task_id: task.id,
        strategy,
        status,
        task_success: judgedSuccess,
        constraints_success: constraintsSuccess,
        constrained_task: hasConstraints,
        budget: task.budget,
        usage: item?.usage ?? null,
        budget_violations: budgetViolations,
        backend: item?.backend ?? null,
        judgment: rawJudgment,
        evidence_refs: traceEvidenceRefs(trace),
        trace_event_count: trace.length,
        trace_sha256: sha256(traceText),
        trace,
        failure: item?.record?.failure ?? (missing ? { code: 'MISSING_RESPONSE' } : budgetViolations.length ? { code: 'BUDGET_EXCEEDED' } : item.status !== 'ok' ? item.record.failure ?? { code: item.status.toUpperCase() } : null),
      });
    }
  }

  const byStrategy = {};
  for (const strategy of plan.planned_strategies) {
    const rows = cells.filter(cell => cell.strategy === strategy);
    const constrained = rows.filter(cell => cell.constrained_task);
    const backends = [...new Map(rows.filter(cell => cell.backend).map(cell => [stableJson(cell.backend), cell.backend])).values()];
    const usageRows = rows.filter(cell => cell.usage);
    byStrategy[strategy] = {
      denominator: rows.length,
      response_count: rows.filter(cell => cell.status !== 'missing_response').length,
      missing_response_count: rows.filter(cell => cell.status === 'missing_response').length,
      failure_count: rows.filter(cell => cell.status !== 'ok').length,
      task_success_count: rows.filter(cell => cell.task_success).length,
      task_success_rate: rows.filter(cell => cell.task_success).length / rows.length,
      constraints_denominator: constrained.length,
      constraints_success_count: constrained.filter(cell => cell.constraints_success).length,
      constraints_success_rate: constrained.length ? constrained.filter(cell => cell.constraints_success).length / constrained.length : null,
      budget_violation_count: rows.filter(cell => cell.budget_violations.length > 0).length,
      total_tokens_observed: usageRows.reduce((total, cell) => total + cell.usage.tokens, 0),
      total_tool_calls_observed: usageRows.reduce((total, cell) => total + cell.usage.tool_calls, 0),
      total_duration_ms_observed: usageRows.reduce((total, cell) => total + cell.usage.duration_ms, 0),
      usage_observed_count: usageRows.length,
      backends,
    };
  }
  const modelIdentities = new Set(cells.filter(cell => cell.backend).map(cell =>
    stableJson({ provider: cell.backend.provider, model_id: cell.backend.model_id, model_revision: cell.backend.model_revision })));
  const comparisonEligible = cells.every(cell => cell.status === 'ok') && modelIdentities.size === 1;
  const summary = {
    schema_version: 1,
    suite_id: plan.suite_id,
    suite_version: plan.suite_version,
    source: plan.source,
    task_plan_sha256: taskDigest,
    saved_runs_sha256: responseDigest,
    planned_tasks: plan.tasks.length,
    planned_strategies: plan.planned_strategies,
    planned_task_strategy_cells: plannedKeys.size,
    observed_saved_runs: validated.size,
    shared_model_identity: modelIdentities.size === 1,
    comparison_eligible: comparisonEligible,
    comparison_boundary: 'Eligibility checks supplied model identities, complete responses and fixed budgets only. Exact decoding/tool configuration and judgment provenance still require external receipts; no causal gain is established.',
    comparable_budget_policy: 'Every saved run must declare the exact per-task total budget in the frozen plan; usage above any token, tool-call, or wall-time limit is scored as a failure.',
    judgment_policy: 'Task and constraint success are taken only from the saved, versioned evaluator judgment; this adapter does not infer semantic correctness from traces.',
    trace_policy: 'Full per-run traces and deduplicated evidence references are included in evaluations.jsonl.',
    strategies: byStrategy,
    claim_boundary: 'Offline scoring of supplied saved runs only. No model/API call, quality claim, cost benefit, or causal improvement is inferred by this adapter.',
  };
  return { summary, cells };
}

export function evaluateSavedRuns({ tasksPath, responsesPath, outputPath, expectedTaskSha256 }) {
  const { plan, digest: taskDigest } = validateTaskPlan(tasksPath, expectedTaskSha256);
  const { rows, digest: responseDigest } = parseJsonl(responsesPath);
  const { summary, cells } = scorePlan(plan, taskDigest, responseDigest, rows);
  mkdirSync(outputPath, { recursive: false });
  writeFileSync(`${outputPath}/evaluations.jsonl`, `${cells.map(cell => JSON.stringify(cell)).join('\n')}\n`, 'utf8');
  writeFileSync(`${outputPath}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) fail(`Expected --name value, received ${key}`);
    const name = key.slice(2);
    if (!['tasks', 'responses', 'output', 'expected-task-sha256'].includes(name)) fail(`Unknown option: ${key}`);
    if (options[name]) fail(`Duplicate option: ${key}`);
    options[name] = argv[index + 1];
    index += 1;
  }
  for (const name of ['tasks', 'responses', 'output']) if (!options[name]) fail(`Missing --${name}`);
  if (!options['expected-task-sha256']) fail('Missing --expected-task-sha256');
  if (options['expected-task-sha256'] && !/^[a-f0-9]{64}$/iu.test(options['expected-task-sha256'])) {
    fail('--expected-task-sha256 must be 64 hexadecimal characters');
  }
  return options;
}

function main() {
  try {
    if (process.argv.length === 3 && ['-h', '--help'].includes(process.argv[2])) {
      process.stdout.write('Usage: node evaluate_saved_runs.mjs --tasks PLAN.json --expected-task-sha256 HEX --responses RUNS.jsonl --output NEW_DIR\n');
      return;
    }
    const options = parseArgs(process.argv.slice(2));
    const summary = evaluateSavedRuns({
      tasksPath: options.tasks,
      responsesPath: options.responses,
      outputPath: options.output,
      expectedTaskSha256: options['expected-task-sha256'],
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`saved-run evaluation error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
