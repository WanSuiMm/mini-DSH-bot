import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserToolProvider, createBrowserToolGuard } from '../service/browser/provider.mjs';

// Prepared software checks. Execute on the designated server, not on this workstation.
const binding = { owner: 'alice', sessionId: 'harness-a', runId: 'run-a' };
const context = { sessionId: 'harness-a', runId: 'run-a', taskId: 'task-a', toolCallId: 'call-a' };
function handlers(provider) {
  const map = new Map(); provider.register({ register: (name, fn) => map.set(name, fn) }, binding); return map;
}

test('browser tools derive owner from the host and retain pending approval rather than claiming execution', async () => {
  const calls = [];
  const runtime = {
    bindRunContext() {},
    requireSession: async (...args) => { calls.push(['require', ...args]); },
    submit: async (...args) => { calls.push(['submit', ...args]); return { status: 'pending_approval', executed: false }; },
    waitForCommand: async () => ({ status: 'pending_approval', executed: false }),
  };
  const h = handlers(createBrowserToolProvider({ runtime }));
  const action = { type: 'click', ref: 'ref_a' };
  const result = await h.get('browser_action')({ sessionId: 'browser-a', action, owner: 'mallory' }, context);
  assert.equal(result.data.executed, false); assert.equal(result.data.status, 'pending_approval');
  assert.equal(calls[1][1], 'alice'); assert.deepEqual(calls[1][3], action);
  const priorCalls = calls.length;
  const denied = await h.get('browser_action')({ sessionId: 'browser-a', action }, { ...context, runId: 'different-run' });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'BROWSER_BINDING_MISMATCH');
  assert.equal(calls.length, priorCalls);
});

test('browser_open derives its idempotency key from the trusted tool call identity', async () => {
  const calls = [];
  const runtime = {
    bindRunContext() {},
    open: async input => {
      calls.push(input);
      return { session: { id: `session-${calls.length}` }, command: { status: 'succeeded' }, replayed: false };
    },
  };
  const h = handlers(createBrowserToolProvider({ runtime }));
  const input = { url: 'https://trusted.example/', openKey: 'model-supplied-key' };
  await h.get('browser_open')(input, context);
  await h.get('browser_open')(input, context);
  await h.get('browser_open')(input, { ...context, toolCallId: 'call-b' });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].owner, binding.owner);
  assert.equal(calls[0].openKey, calls[1].openKey);
  assert.notEqual(calls[0].openKey, 'model-supplied-key');
  assert.notEqual(calls[0].openKey, calls[2].openKey);
  assert.match(calls[0].openKey, /^tool-[a-f0-9]{64}$/);
});

test('missing provider call identity blocks admission instead of colliding with another action', async () => {
  let calls = 0;
  const h = handlers(createBrowserToolProvider({ runtime: { bindRunContext() {}, requireSession: async () => {}, submit: async () => { calls++; } } }));
  const result = await h.get('browser_observe')({ sessionId: 'browser-a' }, { ...context, toolCallId: undefined });
  assert.equal(result.error.code, 'BROWSER_TOOL_CALL_ID_REQUIRED'); assert.equal(calls, 0);
});

test('browser guard admits only the registered mediation path and preserves other network decisions', async () => {
  let delegated = 0;
  const guard = createBrowserToolGuard({ policyVersion: 'base', evaluate: async () => { delegated++; return { action: 'approval' }; } });
  const call = { name: 'browser_action', context: {}, options: { policy: { effect: 'network', source: 'browser-runtime', admission: 'journaled-v1' } } };
  assert.equal((await guard.evaluate(call)).action, 'allow');
  assert.equal((await guard.evaluate({ ...call, name: 'unregistered_network_tool' })).action, 'approval');
  assert.equal((await guard.evaluate({ ...call, options: { policy: { effect: 'network', source: 'mcp' } } })).action, 'approval');
  assert.equal(delegated, 2);
});
