// Live network capture test: the FIRST networkRequests call activates CDP
// Network capture, a later fetch is recorded WITH its real HTTP method, and a
// method=POST filter actually matches (the bug this fixed: resource timing has
// no method, so the old filter was always empty). Self-cleaning.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchRealBrowser, closeRealBrowser } from '../launch.js';
import { networkRequests } from '../interact-aux.js';
import { waitFor } from '../interact.js';
import { evaluateJs } from '../cdp.js';
import { stopNetworkTracking } from '../network.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/submit') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><body><h1 id="t">net</h1></body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const srvPort = server.address().port;

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-network-'));
let port = null;

try {
  const r = await launchRealBrowser({
    exePath: EXE,
    userDataDir: tmp,
    url: `http://127.0.0.1:${srvPort}/`,
    headless: true,
    waitMs: 30000,
  });
  port = r.port;
  console.log(`launched pid=${r.pid} port=${r.port}`);
  await waitFor(r.port, { selector: '#t', timeoutMs: 6000, urlSubstring: `127.0.0.1:${srvPort}` });

  // First call: activates live capture, returns resource-timing history.
  const first = await networkRequests(r.port, { urlSubstring: `127.0.0.1:${srvPort}` });
  check('first call activates live capture', first.live === true, `live=${first.live}`);

  // Trigger a POST fetch, then read with method filter (live capture).
  await evaluateJs(
    r.port,
    `fetch('/api/submit', { method: 'POST', body: 'x' }).then(() => true)`,
    { urlSubstring: `127.0.0.1:${srvPort}`, awaitPromise: true },
  );
  await new Promise((res) => setTimeout(res, 1200));

  const live = await networkRequests(r.port, { urlSubstring: `127.0.0.1:${srvPort}` });
  const post = (live.requests || []).find((e) => e.method === 'POST' && String(e.url).includes('/api/submit'));
  check('live capture records the POST with method', !!post, JSON.stringify(post));
  check('POST status captured', post && String(post.status).startsWith('2'), `status=${post?.status}`);

  const filtered = await networkRequests(r.port, { method: 'POST', urlSubstring: `127.0.0.1:${srvPort}` });
  check('method=POST filter matches live entries', filtered.requests.length > 0 && filtered.requests.every((e) => e.method === 'POST'), `count=${filtered.requests.length}`);

  // Trigger a GET after activation and confirm the method filter finds it.
  await evaluateJs(
    r.port,
    `fetch('/api/get?x=1').then(() => true)`,
    { urlSubstring: `127.0.0.1:${srvPort}`, awaitPromise: true },
  );
  await new Promise((res) => setTimeout(res, 1200));
  const filteredGet = await networkRequests(r.port, { method: 'GET', urlSubstring: `127.0.0.1:${srvPort}` });
  check('method=GET filter matches live GET', filteredGet.requests.length > 0 && filteredGet.requests.every((e) => e.method === 'GET'), `count=${filteredGet.requests.length}`);
} finally {
  if (port) { stopNetworkTracking(port); closeRealBrowser(port); }
  server.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM: browser tree still releasing locks; leftover temp dir is harmless */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('cleaned up');
}

process.exitCode = fail === 0 ? 0 : 1;
