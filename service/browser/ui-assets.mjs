import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('../../browser-ui/dist/', import.meta.url));
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

/** Public shell only. Private API, images and event feeds keep their Bearer authentication. */
export async function serveBrowserUi(req, res, url) {
  if (url.pathname !== '/browser' && !url.pathname.startsWith('/browser/')) return false;
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }); res.end(); return true;
  }
  if (url.pathname === '/browser') { res.writeHead(308, { Location: '/browser/', 'Cache-Control': 'no-store' }); res.end(); return true; }
  let relative = 'index.html'; let type = 'text/html; charset=utf-8';
  if (url.pathname !== '/browser/') {
    const match = /^\/browser\/(assets\/[A-Za-z0-9_.-]+\.(js|css|svg|woff2))$/.exec(url.pathname);
    if (!match) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return true; }
    relative = match[1]; type = MIME['.' + match[2]];
  }
  try {
    const file = resolve(ROOT, relative);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) throw new Error('invalid UI asset');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(relative === 'index.html' ? 503 : 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'Browser workspace assets are unavailable. Build browser-ui before enabling the workspace.');
  }
  return true;
}
