import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEvidenceWriter,
  normalizeProviderUsage,
  parseProviderUsage,
  reconcileProviderUsage,
} from '../benchmarks/browser_task_eval_20261029/evidence.mjs';

const canonicalUsage = {
  inputTokens: 120,
  cacheHitInputTokens: 80,
  cacheMissInputTokens: 40,
  outputTokens: 20,
  totalTokens: 140,
};

test('provider usage accepts normalized raw values and the existing wrapper shapes', () => {
  assert.deepEqual(normalizeProviderUsage(canonicalUsage), canonicalUsage);
  assert.deepEqual(normalizeProviderUsage({ data: { usage: canonicalUsage } }), canonicalUsage);
  assert.deepEqual(normalizeProviderUsage({ usage: {
    prompt_tokens: 120,
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 40,
    completion_tokens: 20,
    total_tokens: 140,
  } }), canonicalUsage);
});

test('provider usage rejects broken totals and incomplete or inconsistent cache splits', () => {
  assert.equal(parseProviderUsage({ ...canonicalUsage, totalTokens: 141 }).reason, 'total_tokens_do_not_reconcile');
  assert.equal(parseProviderUsage({ ...canonicalUsage, cacheMissInputTokens: 39 }).reason, 'cache_tokens_do_not_reconcile');
  assert.equal(parseProviderUsage({ ...canonicalUsage, cacheMissInputTokens: undefined }).reason, 'cache_token_breakdown_incomplete');
  assert.equal(normalizeProviderUsage({ inputTokens: -1, outputTokens: 2, totalTokens: 1 }), undefined);
});

test('journal repairs an absent response usage, while genuinely unknown usage remains unknown', () => {
  const repaired = reconcileProviderUsage({
    responses: [{ id: 10, payload: { usageSource: 'provider_actual', actualProviderUsage: null } }],
    journal: [{ callIndex: 1, globalCallIndex: 7, actualProviderUsage: canonicalUsage }],
    dispatchedCalls: 1,
  });
  assert.equal(repaired.providerUsageComplete, true);
  assert.equal(repaired.calls[0].status, 'journal_used');
  assert.deepEqual(repaired.actualProviderUsage, canonicalUsage);

  const unknown = reconcileProviderUsage({
    responses: [{ id: 11, payload: { usageSource: 'provider_actual', actualProviderUsage: canonicalUsage } }],
    journal: [],
    dispatchedCalls: 1,
  });
  assert.equal(unknown.providerUsageComplete, false);
  assert.equal(unknown.usageUnknown, true);
  assert.equal(unknown.providerUsageUnknownCalls, 1);
  assert.equal(unknown.actualProviderUsage, null);
});

test('response and journal disagreements are not counted as complete usage', () => {
  const result = reconcileProviderUsage({
    responses: [{ id: 12, payload: { usageSource: 'provider_actual', actualProviderUsage: canonicalUsage } }],
    journal: [{ callIndex: 1, actualProviderUsage: { ...canonicalUsage, inputTokens: 121, cacheMissInputTokens: 41, totalTokens: 141 } }],
    dispatchedCalls: 1,
  });
  assert.equal(result.providerUsageComplete, false);
  assert.equal(result.calls[0].status, 'response_journal_usage_conflict');
  assert.equal(result.actualProviderUsage, null);
});

test('evidence writer deduplicates events, preserves references and codes, and hashes exact saved bytes', async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'browser-evidence-'));
  const rootDir = join(parent, 'run-evidence');
  try {
    const writer = await createEvidenceWriter({ rootDir });
    await writer.writeCellSnapshot('task::single', { runId: 'run-1', result: { code: 'RUN_FAILED' } });
    const event = {
      id: 9,
      type: 'tool.result',
      payload: {
        ref: 'r17',
        href: 'https://example.test/details',
        errorCode: 'BROWSER_ACTION_OUTCOME_UNKNOWN',
        Authorization: 'Bearer secretsecretsecret',
        cookie: 'sid=private-cookie',
        text: 'Authorization: Basic private-basic\nCookie: session=private-cookie',
      },
    };
    assert.deepEqual(await writer.appendHarnessEvents('task::single', [event, event]), { appended: 1, duplicates: 1 });
    const eventsPath = join(rootDir, 'task--single', 'harness-events.jsonl');
    const contents = await fs.readFile(eventsPath, 'utf8');
    const records = contents.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].event.payload.ref, 'r17');
    assert.equal(records[0].event.payload.href, 'https://example.test/details');
    assert.equal(records[0].event.payload.errorCode, 'BROWSER_ACTION_OUTCOME_UNKNOWN');
    assert.equal(records[0].trustBoundary, 'untrusted_harness_or_browser_data');
    assert.doesNotMatch(contents, /secretsecretsecret|private-cookie|private-basic/);

    const manifest = JSON.parse(await fs.readFile(join(rootDir, 'evidence-manifest.json'), 'utf8'));
    const entry = manifest.artifacts['task--single/harness-events.jsonl'];
    assert.equal(entry.lengthBytes, Buffer.byteLength(contents));
    assert.equal(entry.sha256, createHash('sha256').update(contents).digest('hex'));
    await writer.close();
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('event identity is scoped to its cell and browser session', async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'browser-evidence-identity-'));
  const rootDir = join(parent, 'run-evidence');
  try {
    const writer = await createEvidenceWriter({ rootDir });
    await writer.appendHarnessEvents('task_a::single', [{ id: 1, type: 'run.failed', payload: { code: 'CELL_A' } }]);
    await writer.appendHarnessEvents('task_b::single', [{ id: 1, type: 'run.failed', payload: { code: 'CELL_B' } }]);
    const browserA = {
      id: 5,
      sessionId: 'browser-session-a',
      type: 'browser.observe',
      payload: { ref: 'ref-a', href: 'https://example.test/a' },
    };
    const browserB = {
      id: 5,
      sessionId: 'browser-session-b',
      type: 'browser.observe',
      payload: { ref: 'ref-b', href: 'https://example.test/b' },
    };
    assert.deepEqual(await writer.appendBrowserEvents('task_a::single', [browserA, browserB, browserA]), {
      appended: 2,
      duplicates: 1,
    });

    const cellAEvents = (await fs.readFile(join(rootDir, 'task_a--single', 'harness-events.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    const cellBEvents = (await fs.readFile(join(rootDir, 'task_b--single', 'harness-events.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    assert.equal(cellAEvents[0].event.payload.code, 'CELL_A');
    assert.equal(cellBEvents[0].event.payload.code, 'CELL_B');

    const browserEvents = (await fs.readFile(join(rootDir, 'task_a--single', 'browser-events.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    assert.equal(browserEvents.length, 2);
    assert.deepEqual(browserEvents.map(item => item.event.sessionId), ['browser-session-a', 'browser-session-b']);
    assert.deepEqual(browserEvents.map(item => item.event.payload.ref), ['ref-a', 'ref-b']);
    assert.deepEqual(browserEvents.map(item => item.event.payload.href), ['https://example.test/a', 'https://example.test/b']);
    await writer.close();
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a failed evidence save rejects, poisons the writer, and retains earlier durable artifacts', async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'browser-evidence-fail-'));
  const rootDir = join(parent, 'run-evidence');
  let failEventOpen = false;
  const io = {
    ...fs,
    open: async (path, ...args) => {
      if (failEventOpen && String(path).endsWith('harness-events.jsonl')) {
        throw Object.assign(new Error('simulated storage failure'), { code: 'ENOSPC' });
      }
      return fs.open(path, ...args);
    },
  };
  try {
    const writer = await createEvidenceWriter({ rootDir, io });
    await writer.writeCellSnapshot('task::single', { runId: 'run-2', result: { code: 'RUN_FAILED' } });
    failEventOpen = true;
    await assert.rejects(writer.appendHarnessEvents('task::single', [{ id: 1, type: 'run.failed', payload: { code: 'RUN_FAILED' } }]), /simulated storage failure/);
    const snapshot = JSON.parse(await fs.readFile(join(rootDir, 'task--single', 'run-snapshot.json'), 'utf8'));
    assert.equal(snapshot.snapshot.result.code, 'RUN_FAILED');
    await assert.rejects(writer.writeCellSnapshot('task::single', { runId: 'run-3' }), /simulated storage failure/);
    await assert.rejects(writer.close(), /simulated storage failure/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
