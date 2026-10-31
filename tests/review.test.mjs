import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createExecutionGuard } from '../service/security/guard.mjs';
import { runReviewCli, parseReviewCliArgs } from '../scripts/review.mjs';
import { createRepositoryReviewTools } from '../service/review/repository-tools.mjs';
import { createRepositoryReviewMcpServer } from '../service/review/mcp-server.mjs';
import { parseAndValidateReviewReport, validateReviewReport } from '../service/review/report-validation.mjs';
import { ToolRegistry } from '../dist/tools/registry.js';

async function makeRepo(t) {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const parent = await mkdtemp(join(projectRoot, '.review-fixture-'));
  const repoRoot = join(parent, 'repo');
  const hooks = join(parent, 'empty-hooks');
  await mkdir(repoRoot);
  await mkdir(hooks);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, env, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  git('init', '--quiet');
  const commit = message => git('-c', 'user.name=Review Test', '-c', 'user.email=review-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, 'commit', '--quiet', '-m', message);
  const addAll = () => git('add', '--all');
  const sha = () => git('rev-parse', 'HEAD').trim();
  t.after(async () => {
    const resolvedParent = await realpath(parent);
    if (resolvedParent.startsWith(await realpath(projectRoot)) && basename(resolvedParent).startsWith('.review-fixture-')) {
      await rm(resolvedParent, { recursive: true, force: true });
    }
  });
  return { parent, repoRoot, hooks, env, git, commit, addAll, sha };
}

async function buildFixture(t) {
  const repo = await makeRepo(t);
  await mkdir(join(repo.repoRoot, 'src'));
  await writeFile(join(repo.repoRoot, 'src', 'score.js'), 'export function score(input) {\n  return 1;\n}\n');
  await writeFile(join(repo.repoRoot, '.env'), 'APP_TOKEN=fixture-secret-value\n');
  repo.addAll();
  repo.commit('base');
  const base = repo.sha();
  await writeFile(join(repo.repoRoot, 'src', 'score.js'), 'export function score(input) {\n  if (!input) return 0;\n  return 1;\n}\n');
  await writeFile(join(repo.repoRoot, '.env'), 'APP_TOKEN=changed-fixture-secret\n');
  repo.addAll();
  repo.commit('head');
  const head = repo.sha();
  const guard = createExecutionGuard({ workspaceRoot: repo.repoRoot });
  const reviewTools = createRepositoryReviewTools({ repoRoot: repo.repoRoot, guard });
  return { ...repo, base, head, guard, reviewTools };
}

function makeContext(allowedTools) {
  return { sessionId: 'review-session', agentId: 'reviewer', taskId: 'review-task', runId: 'review-run', attempt: 1,
    allowedTools, contextRefs: [], budget: {}, signal: undefined };
}

test('real Git snapshot pins full commit SHAs and omits protected-file contents before returning diff text', async t => {
  const { repoRoot, base, head, reviewTools } = await buildFixture(t);
  const snapshot = await reviewTools.snapshot({ base, head });

  assert.match(snapshot.base, /^[a-f0-9]{40}$/i);
  assert.match(snapshot.head, /^[a-f0-9]{40}$/i);
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, 'src/score.js');
  assert.deepEqual(snapshot.files[0].addedLines, [{ line: 2, text: '  if (!input) return 0;' }]);
  assert.match(snapshot.diff, /if \(!input\) return 0/);
  assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false);
  assert.equal(snapshot.omittedByPolicyCount, 1);
  assert.equal(repoRoot.endsWith('repo'), true);
});

test('changed-line parsing preserves source lines that resemble Git file headers', async t => {
  const repo = await makeRepo(t);
  await writeFile(join(repo.repoRoot, 'notes.txt'), 'baseline\n');
  repo.addAll();
  repo.commit('base');
  const base = repo.sha();
  await writeFile(join(repo.repoRoot, 'notes.txt'), 'baseline\n++ source text\n-- source text\n');
  repo.addAll();
  repo.commit('head');
  const head = repo.sha();
  const guard = createExecutionGuard({ workspaceRoot: repo.repoRoot });
  const tools = createRepositoryReviewTools({ repoRoot: repo.repoRoot, guard });
  const snapshot = await tools.snapshot({ base, head });
  assert.deepEqual(snapshot.files[0].addedLines, [
    { line: 2, text: '++ source text' },
    { line: 3, text: '-- source text' },
  ]);
});

test('registered model tools read only the fixed diff and changed file at the pinned head', async t => {
  const { repoRoot, hooks, base, head, reviewTools, git, sha, guard } = await buildFixture(t);
  const snapshot = await reviewTools.snapshot({ base, head });
  const registry = new ToolRegistry({ guard });
  reviewTools.register(registry);
  const allowedTools = reviewTools.definitions().map(tool => tool.name);
  assert.deepEqual(allowedTools, ['repository_review_diff', 'repository_review_file_at_head']);
  assert.equal(registry.isReadOnly('repository_review_diff'), true);

  const diff = await registry.execute('repository_review_diff', {}, makeContext(allowedTools));
  assert.equal(diff.ok, true);
  assert.equal(diff.data.head, head);
  assert.match(diff.data.diff, /if \(!input\) return 0/);

  await writeFile(join(repoRoot, 'src', 'score.js'), 'export function score(input) {\n  return 99;\n}\n');
  git('add', '--all');
  git('-c', 'user.name=Review Test', '-c', 'user.email=review-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, 'commit', '--quiet', '-m', 'later head');
  const laterHead = sha();
  const file = await registry.execute('repository_review_file_at_head', { path: 'src/score.js', startLine: 2, maxLines: 1 }, makeContext(allowedTools));
  assert.equal(file.ok, true);
  assert.equal(file.data.head, head);
  assert.deepEqual(file.data.lines, [{ line: 2, text: '  if (!input) return 0;' }]);
  await assert.rejects(reviewTools.snapshot({ base, head: laterHead }), { code: 'SNAPSHOT_IMMUTABLE' });
  assert.deepEqual(await reviewTools.snapshot({ base, head }), snapshot);
});

test('official MCP server exposes only the configured read-only snapshot tools', async t => {
  const { repoRoot, base, head, guard } = await buildFixture(t);
  const server = await createRepositoryReviewMcpServer({ repoRoot, workspaceRoot: repoRoot, base, head, guard });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'review-fixture-client', version: '0.1.0' });
  t.after(async () => { await Promise.allSettled([client.close(), server.close()]); });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['repository_review_diff', 'repository_review_file_at_head']);
  assert.equal(tools.tools.every(tool => tool.annotations?.readOnlyHint === true), true);
  const diff = await client.callTool({ name: 'repository_review_diff', arguments: {} });
  assert.equal(diff.isError, false);
  assert.equal(diff.structuredContent.head, head);
  assert.equal(JSON.stringify(diff).includes('fixture-secret'), false);
  const file = await client.callTool({ name: 'repository_review_file_at_head', arguments: { path: 'src/score.js', startLine: 2, maxLines: 1 } });
  assert.equal(file.isError, false);
  assert.deepEqual(file.structuredContent.lines, [{ line: 2, text: '  if (!input) return 0;' }]);
  const protectedRead = await client.callTool({ name: 'repository_review_file_at_head', arguments: { path: '.env' } });
  assert.equal(protectedRead.isError, true);
});

test('report validation rejects fabricated SHA, file, line, severity, and evidence; accepts only exact changed-line anchors', async t => {
  const { base, head, reviewTools } = await buildFixture(t);
  const snapshot = await reviewTools.snapshot({ base, head });
  const valid = {
    base,
    head,
    findings: [{ severity: 'high', file: 'src/score.js', line: 2, title: 'Unspecified input is treated as a valid score',
      description: 'The new branch converts a falsy input to zero, which can hide invalid input from the caller.', evidence: 'return 0' }],
    limitations: ['Review was limited to changed head-side lines and bounded file excerpts.'],
  };
  assert.deepEqual(validateReviewReport(valid, snapshot), valid);
  assert.throws(() => validateReviewReport({ ...valid, head: 'a'.repeat(40) }, snapshot), { code: 'INVALID_HEAD' });
  assert.throws(() => validateReviewReport({ ...valid, findings: [{ ...valid.findings[0], file: 'src/ghost.js' }] }, snapshot), { code: 'UNVERIFIED_ANCHOR' });
  assert.throws(() => validateReviewReport({ ...valid, findings: [{ ...valid.findings[0], line: 99 }] }, snapshot), { code: 'UNVERIFIED_ANCHOR' });
  assert.throws(() => validateReviewReport({ ...valid, findings: [{ ...valid.findings[0], severity: 'blocker' }] }, snapshot), { code: 'INVALID_SEVERITY' });
  assert.throws(() => validateReviewReport({ ...valid, findings: [{ ...valid.findings[0], evidence: 'this was never added' }] }, snapshot), { code: 'UNVERIFIED_EVIDENCE' });
  assert.throws(() => parseAndValidateReviewReport('{"base":', snapshot), { code: 'INVALID_JSON' });
});

test('review path safety blocks traversal, protected files, and symlink traversal', async t => {
  const { parent, repoRoot, base, head, reviewTools, guard } = await buildFixture(t);
  const snapshot = await reviewTools.snapshot({ base, head });
  const registry = new ToolRegistry({ guard });
  reviewTools.register(registry);
  const allowedTools = reviewTools.definitions().map(tool => tool.name);
  const blockedTraversal = await registry.execute('repository_review_file_at_head', { path: '../outside.txt' }, makeContext(allowedTools));
  const blockedSecret = await registry.execute('repository_review_file_at_head', { path: '.env' }, makeContext(allowedTools));
  assert.equal(blockedTraversal.ok, false);
  assert.equal(blockedSecret.ok, false);

  let denyLinkPath = false;
  const symlinkAwareGuard = {
    ...guard,
    assertReadablePath: async path => {
      if (denyLinkPath && path.toLowerCase().includes('src\\score.js')) throw Object.assign(new Error('blocked link'), { code: 'SYMLINK_PATH' });
      return guard.assertReadablePath(path);
    },
  };
  const symlinkAwareTools = createRepositoryReviewTools({ repoRoot, guard: symlinkAwareGuard });
  await symlinkAwareTools.snapshot({ base, head });
  const symlinkAwareRegistry = new ToolRegistry({ guard: symlinkAwareGuard });
  symlinkAwareTools.register(symlinkAwareRegistry);
  denyLinkPath = true;
  const rejectedByGuard = await symlinkAwareRegistry.execute('repository_review_file_at_head', { path: 'src/score.js', startLine: 1, maxLines: 2 }, makeContext(allowedTools));
  assert.equal(rejectedByGuard.ok, false, 'the review adapter must stop when its injected path guard reports a symlink');
  denyLinkPath = false;

  const realSource = join(repoRoot, 'src');
  const parkedSource = join(repoRoot, 'src-reviewed-original');
  const outside = join(parent, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'score.js'), 'fixture secret outside repository\n');
  await rename(realSource, parkedSource);
  try {
    await symlink(outside, realSource, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    await rename(parkedSource, realSource);
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code)) {
      t.diagnostic(`real symlink creation unavailable in this sandbox: ${error.code}; injected guard rejection was verified`);
      return;
    }
    throw error;
  }
  try {
    const blockedLink = await registry.execute('repository_review_file_at_head', { path: 'src/score.js', startLine: 1, maxLines: 2 }, makeContext(allowedTools));
    assert.equal(blockedLink.ok, false);
    await assert.rejects(guard.assertReadablePath(join(repoRoot, 'src', 'score.js')));
  } finally {
    if (process.platform === 'win32') {
      const { rmdir } = await import('node:fs/promises');
      await rmdir(realSource);
    } else await unlink(realSource);
    await rename(parkedSource, realSource);
  }
  assert.equal(snapshot.head, head);
});

test('review CLI returns without reading model configuration or making a model call by default', async () => {
  let output = '';
  const env = new Proxy({}, { get() { throw new Error('environment should not be read without --execute'); } });
  const code = await runReviewCli(parseReviewCliArgs([]), { env, stdout: { write: value => { output += value; } } });
  assert.equal(code, 0);
  assert.match(output, /No model request was made/);
});
