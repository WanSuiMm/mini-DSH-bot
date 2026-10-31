import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPlaywrightDriver } from '../service/browser/playwright-driver.mjs';

test('browser driver validates exact origins and keeps approval outside request data without launching a browser', async () => {
  const driver = await createPlaywrightDriver({ allowedOrigins: ['https://trusted.example'] });
  assert.deepEqual(driver.validateUrl('https://trusted.example/path?token=not-returned'), { ok: true });
  assert.deepEqual(driver.validateUrl('https://other.example/path'), { ok: false, error: { code: 'ORIGIN_DENIED' } });
  assert.deepEqual(driver.validateUrl('http://trusted.example/path'), { ok: false, error: { code: 'ORIGIN_DENIED' } });

  const unapproved = await driver.execute('session_1', { type: 'click', ref: 'freshref' });
  assert.deepEqual(unapproved, { ok: false, error: { code: 'APPROVAL_REQUIRED' }, sideEffectStarted: false });
  const forgedApproval = await driver.execute('session_1', { type: 'click', ref: 'freshref', approved: true }, { approved: false });
  assert.equal(forgedApproval.error.code, 'INVALID_REQUEST');
  assert.equal(forgedApproval.sideEffectStarted, false);
  const selectorInput = await driver.execute('session_1', { type: 'click', selector: 'body' }, { approved: true });
  assert.equal(selectorInput.error.code, 'INVALID_REQUEST');
  assert.equal(selectorInput.sideEffectStarted, false);
  await driver.close();
});

test('browser driver constrains network, controls, stale refs, and approved interaction outcomes', {
  skip: process.env.MICRO_DSH_RUN_BROWSER_TESTS !== '1',
}, async t => {
  const externalHits = [];
  const external = createServer((req, res) => {
    externalHits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('external');
  });
  external.listen(0, '127.0.0.1');
  await once(external, 'listening');
  const externalOrigin = `http://127.0.0.1:${external.address().port}`;
  let writes = 0;
  const app = createServer((req, res) => {
    if (req.url === '/write' && req.method === 'POST') {
      writes += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Write received</title>done');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `${externalOrigin}/redirect-target` });
      res.end();
      return;
    }
    res.setHeader('set-cookie', 'sessionid=COOKIE_FIXTURE_SECRET; HttpOnly; Path=/');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html><head><title>Fixture page</title></head><body>
        <main>Visible fixture text</main>
        <label for="normal">Name</label><input id="normal" name="name" value="FORM_VALUE_FIXTURE">
        <input type="password" id="password" name="password" value="PASSWORD_FIXTURE_SECRET">
        <input type="hidden" id="hidden" name="hidden" value="HIDDEN_FIXTURE_SECRET">
        <input type="file" id="file" name="upload">
        <select aria-label="Color"><option value="blue">Blue</option><option value="green">Green</option></select>
        <form action="/write" method="post"><button id="write" aria-label="Write">Write</button></form>
        <a id="external" href="${externalOrigin}/target">External link</a>
        <script>
          localStorage.setItem('fixture', 'LOCAL_STORAGE_FIXTURE_SECRET');
        </script>
      </body></html>`);
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const appOrigin = `http://127.0.0.1:${app.address().port}`;
  const driver = await createPlaywrightDriver({
    allowedOrigins: [appOrigin],
    allowHttp: { loopback: true },
    executablePath: process.env.MICRO_DSH_BROWSER_EXECUTABLE,
    timeoutMs: 5_000,
  });
  let opened = false;
  try {
    await driver.open({ id: 'browser_test' });
    opened = true;
    const navigation = await driver.execute('browser_test', { type: 'navigate', url: `${appOrigin}/` });
    assert.equal(navigation.ok, true);
    assert.equal(navigation.sideEffectStarted, true);

    const observed = await driver.execute('browser_test', { type: 'observe' });
    assert.equal(observed.ok, true);
    assert.equal(observed.url, `${appOrigin}/`);
    assert.match(observed.text, /Visible fixture text/);
    const encoded = JSON.stringify(observed);
    for (const secret of ['COOKIE_FIXTURE_SECRET', 'LOCAL_STORAGE_FIXTURE_SECRET', 'PASSWORD_FIXTURE_SECRET', 'HIDDEN_FIXTURE_SECRET', 'FORM_VALUE_FIXTURE']) {
      assert.equal(encoded.includes(secret), false);
    }
    assert.doesNotMatch(JSON.stringify(observed.controls), /password|hidden|upload/i);

    const name = observed.controls.find(control => control.label === 'Name');
    const write = observed.controls.find(control => control.label === 'Write');
    const externalLink = observed.controls.find(control => control.label === 'External link');
    assert.ok(name && write && externalLink);

    const preview = await driver.preview('browser_test');
    assert.equal(preview.ok, true);
    assert.equal(preview.contentType, 'image/jpeg');
    assert.equal(Number.isNaN(Date.parse(preview.capturedAt)), false);
    assert.equal(preview.width, 1280);
    assert.equal(preview.height, 800);
    const jpeg = Buffer.from(preview.dataBase64, 'base64');
    assert.equal(jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), true);
    assert.ok(jpeg.length <= 768 * 1024);
    for (const secret of ['FORM_VALUE_FIXTURE', 'PASSWORD_FIXTURE_SECRET', 'HIDDEN_FIXTURE_SECRET', 'filled fixture', 'LOCAL_STORAGE_FIXTURE_SECRET']) {
      assert.equal(JSON.stringify(preview).includes(secret), false);
    }

    const unapproved = await driver.execute('browser_test', { type: 'click', ref: write.ref });
    assert.equal(unapproved.error.code, 'APPROVAL_REQUIRED');
    assert.equal(unapproved.sideEffectStarted, false);

    const filled = await driver.execute('browser_test', { type: 'fill', ref: name.ref, text: 'filled fixture' }, { approved: true });
    assert.equal(filled.ok, true);
    assert.equal(filled.networkOutcome, 'unknown');
    assert.equal(filled.retryable, false);
    const stale = await driver.execute('browser_test', { type: 'click', ref: write.ref }, { approved: true });
    assert.equal(stale.error.code, 'STALE_REF');
    assert.equal(stale.sideEffectStarted, false);

    const next = await driver.execute('browser_test', { type: 'observe' });
    const freshWrite = next.controls.find(control => control.label === 'Write');
    const freshExternal = next.controls.find(control => control.label === 'External link');
    assert.ok(freshWrite && freshExternal);
    const blockedLink = await driver.execute('browser_test', { type: 'click', ref: freshExternal.ref }, { approved: true });
    assert.equal(blockedLink.error.code, 'ORIGIN_DENIED');
    assert.equal(blockedLink.sideEffectStarted, false);
    assert.deepEqual(externalHits, []);

    const invalidatedAfterDenial = await driver.execute('browser_test', { type: 'click', ref: freshWrite.ref }, { approved: true });
    assert.equal(invalidatedAfterDenial.error.code, 'STALE_REF');
    const afterDenial = await driver.execute('browser_test', { type: 'observe' });
    const currentWrite = afterDenial.controls.find(control => control.label === 'Write');
    assert.ok(currentWrite);
    const clicked = await driver.execute('browser_test', { type: 'click', ref: currentWrite.ref }, { approved: true });
    assert.equal(clicked.ok, true);
    assert.equal(clicked.networkOutcome, 'unknown');
    assert.equal(clicked.retryable, false);
    assert.equal(writes, 1);

    const redirect = await driver.execute('browser_test', { type: 'navigate', url: `${appOrigin}/redirect` });
    assert.equal(redirect.ok, false);
    assert.equal(redirect.sideEffectStarted, true);
    assert.equal(redirect.retryable, false);
    assert.equal(JSON.stringify(redirect).includes(externalOrigin), false);
    opened = false;
  } finally {
    if (opened) await driver.closeSession('browser_test');
    await driver.close();
    await Promise.all([
      new Promise(resolve => app.close(resolve)),
      new Promise(resolve => external.close(resolve)),
    ]);
  }
});
