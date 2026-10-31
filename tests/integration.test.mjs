import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemo } from '../scripts/demo.mjs';

const searchForgeScript = process.env.SEARCHFORGE_TOOL_SCRIPT;
test('SearchForge ↔ two workers ↔ checkpoint recovery, with real local Python and no LLM', { skip: !searchForgeScript }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'micro-dsh-e2e-'));
  const python = process.env.SEARCHFORGE_PYTHON ?? 'python';
  try {
    const corpus = join(dir, 'docs');
    mkdirSync(corpus);
    writeFileSync(join(corpus, 'retrieval.md'), '# Retrieval\nBM25 hybrid retrieval requires evidence citations and source offsets.');
    writeFileSync(join(corpus, 'runtime.md'), '# Runtime\nAgent timeout cancellation propagates to children. Memory namespace isolates sessions.');
    const index = join(dir, 'index');
    const build = spawnSync(python, [resolve(searchForgeScript), 'build-index', '--corpus', corpus, '--index', index, '--backend', 'bm25'], { encoding: 'utf8', windowsHide: true });
    assert.equal(build.status, 0, build.stderr);
    const state = join(dir, 'state');
    let events = [];
    const first = await runDemo({ index, state, python, onEvent: event => events.push(event) });
    assert.equal(first.status, 'succeeded', JSON.stringify(first));
    assert.equal(first.tasks.length, 2);
    assert.ok(first.tasks.every(task => task.result.ok && task.result.evidence.length > 0));
    const checkpoint = JSON.parse(readFileSync(join(state, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.tasks.filter(task => task.status === 'succeeded').length, 2);
    // Persisted terminal results are reused even when the tool executable is unavailable.
    events = [];
    const resumed = await runDemo({ index, state, python: 'deliberately-missing-python-executable', onEvent: event => events.push(event) });
    assert.equal(resumed.status, 'succeeded');
    assert.equal(resumed.memory.previousRunAvailable, true);
    assert.deepEqual(resumed.tasks.map(task => task.result), first.tasks.map(task => task.result));
    const manifestPath = join(index, 'manifest.json');
    const changed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    changed.corpus_fingerprint = 'changed';
    writeFileSync(manifestPath, JSON.stringify(changed));
    await assert.rejects(() => runDemo({ index, state, python }), /binding changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
