import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AgentLoop } from '../dist/core/agent-loop.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { Supervisor } from '../dist/multi_agent/supervisor.js';
import { ScriptedSearchModel } from '../dist/adapters/scripted-search.js';
import { FileTaskStore, FileMemoryStore, lockState, searchForgeTool } from './host.mjs';

export async function runDemo({ index, state, python = 'python', onEvent }) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const stateDir = resolve(state);
  mkdirSync(stateDir, { recursive: true });
  const release = lockState(stateDir);
  try {
    const binding = {
      schema_version: 1, mode: 'scripted-search-demo-v1',
      index: resolve(index),
      manifest_sha256: createHash('sha256').update(readFileSync(join(resolve(index), 'manifest.json'))).digest('hex'),
    };
    const bindingPath = join(stateDir, 'binding.json');
    if (existsSync(bindingPath)) {
      if (JSON.stringify(JSON.parse(readFileSync(bindingPath, 'utf8'))) !== JSON.stringify(binding)) {
        throw new Error('Checkpoint input/index binding changed; use a new state directory');
      }
    } else if (existsSync(join(stateDir, 'checkpoint.json'))) {
      throw new Error('Checkpoint has no input binding; use a new state directory');
    } else writeFileSync(bindingPath, JSON.stringify(binding, null, 2), { flag: 'wx', mode: 0o600 });
    const store = new FileTaskStore(join(stateDir, 'checkpoint.json'));
    const memory = new FileMemoryStore(join(stateDir, 'memory.json'));
    const previousRun = await memory.get('session:search-demo', 'last-run');
    const tools = new ToolRegistry();
    tools.register('search', searchForgeTool({ python, index,
      script: process.env.SEARCHFORGE_TOOL_SCRIPT ?? (() => { throw new Error('Set SEARCHFORGE_TOOL_SCRIPT to the separately installed SearchForge tool entry'); })() }), { readOnly: true });
    const loop = new AgentLoop(new ScriptedSearchModel(), tools);
    const tasks = [
      ['search-retrieval', 'Search for technical guidance on hybrid retrieval BM25 and evidence citations'],
      ['search-runtime', 'Search for technical guidance on agent timeout cancellation memory namespace'],
    ].map(([taskId, instructions]) => ({
      sessionId: 'search-demo', parentTaskId: 'root', taskId, runId: 'demo-run', attempt: 1,
      title: taskId, instructions, dependencies: [], contextRefs: [], allowedTools: ['search'],
      budget: { maxTokens: 2048, maxToolCalls: 2, maxDurationMs: 5000 },
    }));
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    try {
      const supervisor = new Supervisor({ store, maxConcurrency: 2,
        worker: (task, context) => loop.run(task, context),
        isReadOnlyTool: name => tools.isReadOnly(name),
        onEvent: async event => {
          appendFileSync(join(stateDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
          await onEvent?.(event);
        },
      });
      const result = await supervisor.run(tasks, {
        sessionId: 'search-demo', agentId: 'supervisor', taskId: 'root', runId: 'demo-run', attempt: 1,
        allowedTools: ['search'], contextRefs: [], signal: controller.signal,
        budget: { maxTokens: 4096, maxToolCalls: 4, maxDurationMs: 15000, maxActiveChildren: 2, maxDelegationDepth: 1 },
      });
      const report = { schema_version: 1, mode: 'offline-scripted-protocol-demo',
        live_model_calls: 0, status: result.status,
        memory: { namespace: 'session:search-demo', previousRunAvailable: Boolean(previousRun) },
        tasks: result.tasks.map(task => ({ taskId: task.taskId, status: task.status, result: task.result })),
      };
      const entry = { id: 'last-run', namespace: 'session:search-demo', value: { status: result.status, tasks: tasks.map(task => task.taskId) }, ttlMs: 86_400_000 };
      if (previousRun) await memory.update(entry); else await memory.create(entry);
      writeFileSync(join(stateDir, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      return report;
    } finally { process.removeListener('SIGINT', interrupt); }
  } finally { release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const index = option('--index');
  const state = option('--state');
  if (!index || !state || args.includes('--help')) {
    console.log('node scripts/demo.mjs --index <SearchForge index> --state <new or existing checkpoint directory> [--python <executable>]');
    process.exit(args.includes('--help') ? 0 : 1);
  }
  try {
    const result = await runDemo({ index, state, python: option('--python') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'succeeded') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
