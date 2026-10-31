import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopBackend } from '../desktop/backend.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(20); }
  throw new Error('Timed out waiting for the desktop service state');
}
function fixture() {
  const sessions = new Map(), actions = [], steps = new Map();
  let value = '', writes = 0;
  const driver = {
    validateUrl: async () => ({ ok: true }),
    bindHarnessSession() {},
    async open(binding) { assert.equal(binding.owner, 'desktop-local-agent'); assert.ok(binding.sessionId); sessions.set(binding.id, binding); return { ok: true }; },
    async execute(id, request, options) {
      assert.ok(sessions.has(id));
      if (request.type !== 'observe') assert.equal(options.approved, true);
      actions.push(request.type);
      if (request.type === 'fill') value = request.text;
      if (request.type === 'click') writes++;
      return { ok: true, type: request.type, url: 'https://fixture.test/', text: value,
        controls: [{ ref: 'field', label: 'Article title' }, { ref: 'save', label: 'Save' }] };
    },
    async closeSession(id) { sessions.delete(id); },
    async getStorageState() { return { cookies: [], origins: [] }; },
    async preview() { return { ok: false, error: { code: 'PREVIEW_UNSUPPORTED' } }; },
    async close() {},
    async invalidateSessionRefs() {}, async pauseHarnessSession() {}, async resumeHarnessSession() {}
  };
  const modelFactory = () => ({
    executionProfile: 'desktop-fixture-v1', estimatePromptTokens: () => 100,
    async generate(_request, context) {
      const index = steps.get(context.runId) ?? 0; steps.set(context.runId, index + 1);
      const sessionId = [...sessions.keys()][0];
      let call;
      if (!sessionId) call = { name: 'browser_open', input: { url: 'https://fixture.test/' } };
      else if (actions.at(-1) !== 'observe') call = { name: 'browser_observe', input: { sessionId } };
      else if (!value) call = { name: 'browser_action', input: { sessionId, action: { type: 'fill', ref: 'field', text: 'Reviewed article' } } };
      else if (!writes) call = { name: 'browser_action', input: { sessionId, action: { type: 'click', ref: 'save' } } };
      return { ok: true, evidence: [], data: { text: call ? '' : 'Saved and read back.',
        toolCalls: call ? [{ id: `fixture-${index}`, ...call }] : [],
        finishReason: call ? 'tool_call' : 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } };
    }
  });
  return { driver, modelFactory, actions, writes: () => writes, value: () => value };
}

test('existing HarnessService executes a desktop-bound task with exact-hash approvals and durable results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-integration-'));
  const f = fixture(); let backend;
  try {
    backend = await createDesktopBackend({ stateRoot: root, driver: f.driver, modelFactory: f.modelFactory });
    await backend.ready();
    await backend.configure({ baseUrl: 'https://fixture.test/chat/completions', model: 'zero-paid-fixture', apiKey: 'fixture-not-a-real-key' });
    const submitted = await backend.submit({ tabId: 'tab-a', url: 'https://fixture.test/', prompt: 'Save an article and read it back.' });
    const seen = new Set();
    const task = await until(async () => {
      const current = (await backend.snapshot()).tasks.find(task => task.id === submitted.id);
      for (const command of current.commands) {
        if (command.status === 'pending_approval' && !seen.has(command.id)) {
          seen.add(command.id); await backend.approve('tab-a', command.id, command.requestHash);
        }
      }
      return ['succeeded', 'failed', 'partial'].includes(current.status) ? current : null;
    });
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    assert.match(task.output ?? '', /Saved and read back/);
    assert.equal(f.writes(), 1); assert.equal(f.value(), 'Reviewed article');
    assert.ok(f.actions.includes('observe'));
    assert.equal(seen.size, 3);
    assert.ok(backend.service instanceof (await import('../service/server.mjs')).HarnessService);
    assert.equal(backend.service.server.listening, false);
  } finally { await backend?.close(); await rm(root, { recursive: true, force: true }); }
});

test('manual takeover invalidates pending approval and explicit cancellation survives a new desktop backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-takeover-'));
  const f = fixture(); let backend;
  try {
    backend = await createDesktopBackend({ stateRoot: root, driver: f.driver, modelFactory: f.modelFactory });
    await backend.configure({ baseUrl: 'https://fixture.test/chat/completions', model: 'zero-paid-fixture' });
    const submitted = await backend.submit({ tabId: 'tab-a', url: 'https://fixture.test/', prompt: 'Fill the article.' });
    const command = await until(async () => (await backend.snapshot()).tasks.find(t => t.id === submitted.id)?.commands.find(c => c.status === 'pending_approval'));
    await backend.pause('tab-a');
    await assert.rejects(backend.approve('tab-a', command.id, command.requestHash));
    assert.equal(f.writes(), 0);
    await backend.cancel('tab-a');
    await backend.close(); backend = undefined;
    backend = await createDesktopBackend({ stateRoot: root, driver: fixture().driver });
    const task = (await backend.snapshot()).tasks.find(t => t.id === submitted.id);
    assert.equal(task.status, 'cancelled');
    assert.equal(task.recoverable, false);
  } finally { await backend?.close(); await rm(root, { recursive: true, force: true }); }
});

test('manual takeover and resume keep the original run and require a fresh observation before new approved writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-resume-'));
  const f = fixture(); let backend;
  try {
    backend = await createDesktopBackend({ stateRoot: root, driver: f.driver, modelFactory: f.modelFactory });
    await backend.configure({ baseUrl: 'https://fixture.test/chat/completions', model: 'zero-paid-fixture' });
    const submitted = await backend.submit({ tabId: 'tab-a', url: 'https://fixture.test/', prompt: 'Save after human review.' });
    const opening = await until(async () => (await backend.snapshot()).tasks[0].commands.find(c => c.status === 'pending_approval'));
    await backend.approve('tab-a', opening.id, opening.requestHash);
    const oldFill = await until(async () => (await backend.snapshot()).tasks[0].commands.find(c => c.type === 'fill' && c.status === 'pending_approval'));
    await backend.pause('tab-a');
    const paused = (await backend.snapshot()).tasks[0];
    assert.equal(paused.status, 'paused');
    await assert.rejects(backend.approve('tab-a', oldFill.id, oldFill.requestHash));
    const observationsBefore = f.actions.filter(action => action === 'observe').length;
    await backend.resume('tab-a');
    const seen = new Set([oldFill.id, opening.id]);
    const finished = await until(async () => {
      const task = (await backend.snapshot()).tasks[0];
      for (const command of task.commands) if (command.status === 'pending_approval' && !seen.has(command.id)) {
        seen.add(command.id); await backend.approve('tab-a', command.id, command.requestHash);
      }
      return ['succeeded', 'failed', 'partial'].includes(task.status) ? task : null;
    });
    assert.equal(finished.status, 'succeeded', JSON.stringify(finished));
    assert.equal(finished.runId, submitted.runId);
    assert.equal(f.writes(), 1);
    assert.ok(f.actions.filter(action => action === 'observe').length > observationsBefore);
    assert.equal(finished.commands.find(command => command.id === oldFill.id).status, 'rejected');
  } finally { await backend?.close(); await rm(root, { recursive: true, force: true }); }
});

test('restart preserves queued task identity and requires explicit recovery before any model generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-queued-recovery-'));
  let f = fixture(), backend;
  try {
    backend = await createDesktopBackend({ stateRoot: root, driver: f.driver, modelFactory: f.modelFactory });
    await backend.configure({ baseUrl: 'https://fixture.test/chat/completions', model: 'zero-paid-fixture' });
    backend.service.schedule = () => {}; // Freeze at a safe queue checkpoint, before any agent step.
    const submitted = await backend.submit({ tabId: 'tab-a', url: 'https://fixture.test/', prompt: 'Restore this queued task.' });
    const originalKey = backend.taskJournal.getTask(submitted.id).idempotencyKey;
    await backend.close(); backend = undefined;
    f = fixture();
    backend = await createDesktopBackend({ stateRoot: root, driver: f.driver, modelFactory: f.modelFactory });
    await backend.configure({ baseUrl: 'https://fixture.test/chat/completions', model: 'zero-paid-fixture' });
    const interrupted = (await backend.snapshot()).tasks[0];
    assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.recoverable, true);
    assert.equal(f.actions.length, 0);
    await backend.recover('tab-a', submitted.id);
    const seen = new Set();
    const final = await until(async () => {
      const task = (await backend.snapshot()).tasks[0];
      for (const command of task.commands) if (command.status === 'pending_approval' && !seen.has(command.id)) {
        seen.add(command.id); await backend.approve('tab-a', command.id, command.requestHash);
      }
      return ['succeeded', 'failed', 'partial'].includes(task.status) ? task : null;
    });
    assert.equal(final.status, 'succeeded', JSON.stringify(final));
    assert.equal(final.runId, submitted.runId);
    assert.equal(backend.taskJournal.getTask(submitted.id).idempotencyKey, originalKey);
    assert.equal(f.writes(), 1);
  } finally { await backend?.close(); await rm(root, { recursive: true, force: true }); }
});
