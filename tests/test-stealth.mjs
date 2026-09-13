// Stealth audit test: the fingerprint battery reports a clean verdict on a
// freshly launched headless browser, the console hook is injected NON-
// enumerably (stealth hygiene), and cleanupStealthArtifacts removes it so the
// audit returns to clean. Self-cleaning (temp profile, local HTTP server).
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchRealBrowser, closeRealBrowser } from '../launch.js';
import { auditStealth, cleanupStealthArtifacts } from '../stealth.js';
import { readConsole } from '../interact-aux.js';
import { waitFor } from '../interact.js';
import { evaluateJs } from '../cdp.js';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-stealth-'));
let port = null;
let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><body><h1 id="hi">stealth probe</h1><button id="b">go</button></body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const srvPort = server.address().port;

async function main() {
  const r = await launchRealBrowser({
    exePath: EXE,
    userDataDir: tmp,
    url: `http://127.0.0.1:${srvPort}/`,
    headless: true,
    stealth: true,
    waitMs: 30000,
  });
  port = r.port;
  console.log(`launched pid=${r.pid} port=${r.port} (stealth flags)`);

  await waitFor(r.port, { selector: '#hi', timeoutMs: 6000, urlSubstring: '127.0.0.1' });

  // --- 1. clean battery on a fresh page ---
  const audit1 = await auditStealth(r.port, { urlSubstring: '127.0.0.1' });
  const byId = (id) => audit1.checks.find((c) => c.id === id);
  check('battery runs + parses', Array.isArray(audit1.checks) && audit1.checks.length > 5, `${audit1.checks.length} checks`);
  check('webdriver clean (false)', byId('webdriver')?.clean === true, `value=${byId('webdriver')?.value}`);
  check('no cdc_* driver artifacts', byId('cdc-artifacts')?.clean === true, `value=${byId('cdc-artifacts')?.value}`);
  check('no dsh artifacts on fresh page', byId('dsh-artifacts')?.clean === true, `value=${byId('dsh-artifacts')?.value}`);
  check('plugins surface present', byId('plugins')?.clean === true, `value=${byId('plugins')?.value}`);
  check('window.chrome present', byId('chrome')?.clean === true, `value=${byId('chrome')?.value}`);
  check('verdict clean', audit1.verdict === 'clean', `verdict=${audit1.verdict}`);

  // --- 2. console hook is non-enumerable (stealth hygiene) ---
  await readConsole(r.port, { clear: true, urlSubstring: '127.0.0.1' });
  const probe = await evaluateJs(
    r.port,
    `JSON.stringify({
      inWindow: '__realBrowserConsole' in window,
      inKeys: Object.keys(window).includes('__realBrowserConsole'),
      inForIn: (() => { for (const k in window) if (k === '__realBrowserConsole') return true; return false; })(),
      enumerable: (() => { const d = Object.getOwnPropertyDescriptor(window, '__realBrowserConsole'); return d ? d.enumerable : null; })()
    })`,
    { urlSubstring: '127.0.0.1' },
  );
  const p = JSON.parse(probe.value ?? '{}');
  check('hook reachable (in window)', p.inWindow === true, JSON.stringify(p));
  check('hook NON-enumerable (Object.keys)', p.inKeys === false);
  check('hook NON-enumerable (descriptor.enumerable=false)', p.enumerable === false, `enumerable=${p.enumerable}`);
  check('hook invisible to for..in', p.inForIn === false);

  // --- 3. audit now flags the dsh artifact; cleanup restores clean ---
  const audit2 = await auditStealth(r.port, { urlSubstring: '127.0.0.1' });
  const art = audit2.checks.find((c) => c.id === 'dsh-artifacts');
  check('audit flags injected console buffer', art?.clean === false, `value=${art?.value}`);
  check('verdict now flagged', audit2.verdict === 'flagged', `verdict=${audit2.verdict}`);

  const cleaned = await cleanupStealthArtifacts(r.port, { urlSubstring: '127.0.0.1' });
  check('cleanup removed the buffer', Array.isArray(cleaned.removed) && cleaned.removed.includes('__realBrowserConsole'), JSON.stringify(cleaned));

  const audit3 = await auditStealth(r.port, { urlSubstring: '127.0.0.1' });
  check('audit clean again after cleanup', audit3.verdict === 'clean', `verdict=${audit3.verdict}`);
}

try {
  await main();
} catch (e) {
  console.error('TEST ERROR:', e.message);
  fail += 1;
} finally {
  if (port) closeRealBrowser(port);
  server.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM: browser tree still releasing locks; leftover temp dir is harmless */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('cleaned up');
}

process.exitCode = fail === 0 ? 0 : 1;
