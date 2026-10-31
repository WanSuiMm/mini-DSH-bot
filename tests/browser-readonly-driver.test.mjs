import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPlaywrightDriver } from '../service/browser/playwright-driver.mjs';

test('read-only browser rejects mutating actions and unlisted navigation before opening', async () => {
  const driver = await createPlaywrightDriver({ allowedOrigins: ['https://example.org'], readOnlyMode: true,
    readOnlyNavigationUrls: ['https://example.org/start'] });
  try {
    for (const request of [{ type: 'fill', ref: 'ref', text: 'x' }, { type: 'select', ref: 'ref', values: ['x'] },
      { type: 'press', ref: 'ref', key: 'Enter' }]) {
      assert.equal((await driver.execute('readonly_1', request, { approved: true })).error.code, 'READ_ONLY_ACTION_DENIED');
    }
    assert.equal((await driver.execute('readonly_1', { type: 'navigate', url: 'https://example.org/other' }, { approved: true })).error.code,
      'READ_ONLY_NAVIGATION_DENIED');
    assert.equal((await driver.execute('readonly_1', { type: 'navigate', url: 'https://example.org/start' }, { approved: true })).error.code,
      'SESSION_NOT_FOUND');
    for (const offset of [-1, 1.5, 10001, '10']) {
      assert.equal((await driver.execute('readonly_1', { type: 'observe', offset })).error.code, 'INVALID_REQUEST');
    }
  } finally { await driver.close(); }
});

test('read-only observation pagination reaches a footer link without enlarging a page or reusing stale refs', {
  skip: process.env.MICRO_DSH_RUN_BROWSER_TESTS !== '1',
}, async () => {
  const site = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/target') {
      res.write('<!doctype html><head><title>Target</title></head>');
      setTimeout(() => res.end('<body><main>Footer route reached</main></body>'), 200);
      return;
    }
    res.end('<title>Long page</title><main>' + Array.from({ length: 75 }, (_, index) =>
      `<a href="/unused/${index}">Item ${index}</a>`).join(' ') + '<a href="/target">Footer help</a></main>');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const origin = `http://127.0.0.1:${site.address().port}`;
  const driver = await createPlaywrightDriver({ allowedOrigins: [origin], allowHttp: { loopback: true },
    readOnlyMode: true, readOnlyNavigationUrls: [`${origin}/start`, `${origin}/target`],
    executablePath: process.env.MICRO_DSH_BROWSER_EXECUTABLE, maxControls: 10, timeoutMs: 10000 });
  try {
    await driver.open({ id: 'paged_readonly' });
    assert.equal((await driver.execute('paged_readonly', { type: 'navigate', url: `${origin}/start` })).ok, true);
    let observed = await driver.execute('paged_readonly', { type: 'observe' });
    assert.equal(observed.controls.some(control => control.label === 'Footer help'), false);
    const oldRef = observed.controls[0].ref;
    const seenLabels = observed.controls.map(control => control.label);
    let pages = 1;
    while (observed.nextControlsOffset !== null) {
      const offset = observed.nextControlsOffset;
      observed = await driver.execute('paged_readonly', { type: 'observe', offset });
      assert.equal(observed.ok, true);
      assert.equal(observed.controlsOffset, offset);
      assert.ok(observed.controls.length <= 10);
      seenLabels.push(...observed.controls.map(control => control.label));
      assert.ok(++pages <= 10);
    }
    assert.equal(new Set(seenLabels).size, 76);
    assert.equal((await driver.execute('paged_readonly', { type: 'click', ref: oldRef }, { approved: true })).error.code, 'STALE_REF');
    // A denied interaction also invalidates refs; obtain the final page again.
    observed = await driver.execute('paged_readonly', { type: 'observe', offset: observed.controlsOffset });
    const link = observed.controls.find(control => control.label === 'Footer help');
    assert.equal((await driver.execute('paged_readonly', { type: 'click', ref: link.ref }, { approved: true })).ok, true);
    assert.match((await driver.execute('paged_readonly', { type: 'observe' })).text, /Footer route reached/);
  } finally {
    await driver.close();
    await new Promise(resolve => site.close(resolve));
  }
});

test('read-only browser follows exact frozen links and blocks their background POST', {
  skip: process.env.MICRO_DSH_RUN_BROWSER_TESTS !== '1',
}, async () => {
  let posts = 0;
  const site = createServer((req, res) => {
    if (req.method === 'POST') { posts++; res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/target') { res.end('<!doctype html><title>Target</title><main>Frozen target reached</main>'); return; }
    res.end('<!doctype html><title>Start</title><main>Read-only fixture</main>' +
      '<button>Write</button><input aria-label="Name">' +
      '<a href="/target" onclick="fetch(\'/write\',{method:\'POST\'}).catch(()=>{});">Read target</a>');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const origin = `http://127.0.0.1:${site.address().port}`;
  const driver = await createPlaywrightDriver({ allowedOrigins: [origin], allowHttp: { loopback: true },
    readOnlyMode: true, readOnlyNavigationUrls: [`${origin}/start`, `${origin}/target`],
    executablePath: process.env.MICRO_DSH_BROWSER_EXECUTABLE, timeoutMs: 10_000 });
  try {
    await driver.open({ id: 'readonly_live', owner: 'test-owner', sessionId: 'harness-session', runId: 'run', taskId: 'task' });
    assert.equal((await driver.execute('readonly_live', { type: 'navigate', url: `${origin}/start` }, { approved: true })).ok, true);
    let observation = await driver.execute('readonly_live', { type: 'observe' });
    const button = observation.controls.find(item => item.label === 'Write');
    assert.ok(button);
    assert.equal((await driver.execute('readonly_live', { type: 'click', ref: button.ref }, { approved: true })).error.code,
      'READ_ONLY_ACTION_DENIED');
    observation = await driver.execute('readonly_live', { type: 'observe' });
    const link = observation.controls.find(item => item.label === 'Read target');
    assert.equal(link.href, `${origin}/target`);
    assert.equal((await driver.execute('readonly_live', { type: 'click', ref: link.ref }, { approved: true })).ok, true);
    const target = await driver.execute('readonly_live', { type: 'observe' });
    assert.match(target.text, /Frozen target reached/);
    assert.equal(posts, 0);
  } finally {
    await driver.close();
    await new Promise(resolve => site.close(resolve));
  }
});
