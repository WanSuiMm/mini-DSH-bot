import { redactSensitive } from '../security/guard.mjs';

/** Existing HarnessService authenticates the owner before calling this router. */
export async function handleBrowserRequest(service, runtime, owner, req, res, url) {
  if (!url.pathname.startsWith('/v1/browser/')) return false;
  const send = (status, data) => { service.send(res, status, redactSensitive(data)); return true; };
  if (url.pathname === '/v1/browser/config' && req.method === 'GET') return send(200, runtime.publicConfig ?? { allowedOrigins: [], preview: true });
  if (url.pathname === '/v1/browser/sessions' && req.method === 'GET') return send(200, await runtime.store.listSessions(owner));
  if (url.pathname === '/v1/browser/metrics' && req.method === 'GET') return send(200, await runtime.store.metrics(owner));
  const sessionMatch = /^\/v1\/browser\/sessions\/([^/]+)(?:\/(events|commands|close|preview))?$/.exec(url.pathname);
  if (sessionMatch) {
    const [, id, action] = sessionMatch;
    await runtime.requireSession(owner, id);
    if (!action && req.method === 'GET') return send(200, await runtime.store.getSession(owner, id));
    if (action === 'commands' && req.method === 'GET') return send(200, await runtime.store.commands(owner, id));
    if (action === 'preview' && req.method === 'GET') {
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      req.once('aborted', abort); res.once('close', abort);
      try {
        const preview = await runtime.preview(owner, id, controller.signal);
        if (res.destroyed || controller.signal.aborted) return true;
        return send(200, preview);
      }
      finally { req.off('aborted', abort); res.off('close', abort); }
    }
    if (action === 'events' && req.method === 'GET') {
      const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Invalid cursor'), { status: 400 });
      if ((req.headers.accept ?? '').includes('text/event-stream')) {
        await streamBrowserEvents(runtime, owner, id, after, req, res); return true;
      }
      return send(200, { events: await runtime.store.events(owner, id, after, 100) });
    }
    if (action === 'close' && req.method === 'POST') return send(200, await runtime.closeSession(owner, id));
  }
  const commandMatch = /^\/v1\/browser\/commands\/([^/]+)(?:\/(decision))?$/.exec(url.pathname);
  if (commandMatch) {
    const [, id, action] = commandMatch;
    if (!action && req.method === 'GET') {
      const command = await runtime.store.getCommand(owner, id);
      if (!command) throw Object.assign(new Error('Command not found'), { status: 404 });
      return send(200, command);
    }
    if (action === 'decision' && req.method === 'POST') {
      const body = await service.body(req);
      if (Object.keys(body).some(k => !['decision', 'requestHash'].includes(k)) || !['approve', 'reject'].includes(body.decision) || !/^[a-f0-9]{64}$/.test(body.requestHash ?? '')) throw Object.assign(new Error('Exact decision and requestHash required'), { status: 400 });
      return send(202, await runtime.decide(owner, id, body.decision, body.requestHash));
    }
  }
  throw Object.assign(new Error('Browser route not found'), { status: 404 });
}

async function streamBrowserEvents(runtime, owner, id, after, req, res) {
  runtime.streams ??= new Map();
  const streams = runtime.streams.get(owner) ?? new Set();
  const total = [...runtime.streams.values()].reduce((n, v) => n + v.size, 0);
  if (streams.size >= 2 || total >= 64) throw Object.assign(new Error('Browser event stream limit reached'), { status: 429 });
  streams.add(res); runtime.streams.set(owner, streams);
  let cursor = after; let timer; let closed = false; let polling = false;
  const cleanup = () => { closed = true; clearInterval(timer); clearTimeout(deadline); streams.delete(res); if (!streams.size) runtime.streams.delete(owner); };
  const deadline = setTimeout(() => res.end(), 120_000); deadline.unref();
  res.once('close', cleanup);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': browser-events\n\n');
  const poll = async () => {
    if (closed || polling || runtime.closed) { if (runtime.closed) res.end(); return; }
    polling = true;
    try {
      const events = await runtime.store.events(owner, id, cursor, 100);
      for (const event of events) {
        if (closed || res.writableEnded) break;
        if (res.writableLength > 256_000) { res.end(); break; }
        res.write(`id: ${event.id}\nevent: browser.event\ndata: ${JSON.stringify(redactSensitive(event))}\n\n`);
        cursor = event.id;
      }
      if (!events.length && !closed && !res.writableEnded) res.write(': heartbeat\n\n');
    } catch { res.end(); }
    finally { polling = false; }
  };
  await poll();
  if (!closed && !res.writableEnded) { timer = setInterval(() => { void poll(); }, 1000); timer.unref(); }
}
