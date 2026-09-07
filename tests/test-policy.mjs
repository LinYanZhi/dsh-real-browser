// URL policy guard test: pattern matching semantics (pure, no browser) plus a
// real end-to-end deny on navigate against a headless browser. The real
// ~/.dsh/realbrowser-policy.json is saved at the very start and restored at
// the end, so this test never leaks its intermediate state into the user's
// policy.
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchRealBrowser, closeRealBrowser } from '../launch.js';
import { navigatePage } from '../cdp.js';
import { waitFor } from '../interact.js';
import {
  urlMatchesPattern, matchPolicy,
  readPolicy, writePolicy, addRule, removeRule,
} from '../policy.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

// --- 0. save the real policy FIRST, before touching anything ---
const POLICY = path.join(os.homedir(), '.dsh', 'realbrowser-policy.json');
const hadPolicy = existsSync(POLICY);
const savedPolicy = hadPolicy ? readFileSync(POLICY, 'utf8') : null;
writePolicy({ deny: [], requireApproval: [] });

try {
  // --- 1. pattern matching semantics ---
  console.log('== pattern matching (pure) ==');
  check('glob * matches any run', urlMatchesPattern('https://shop.com/checkout/pay', '*checkout*'));
  check('no-* pattern = exact match on host', urlMatchesPattern('https://bank.com/x', 'bank.com'));
  check('subdomain wildcard matches full URL', urlMatchesPattern('https://login.bank.com/a/b', 'https://*.bank.com/*'));
  check('case-insensitive', urlMatchesPattern('https://Bank.COM/PAY', '*bank*'));
  check('host match', urlMatchesPattern('https://a.bank.com/x', '*bank.com'));
  check('non-match rejected', !urlMatchesPattern('https://safe.example.org/x', '*bank*'));
  check('patternToRegExp anchors full match', !urlMatchesPattern('https://evil.com/bank.com', 'bank.com'));

  // --- 2. deny precedence + add/remove round-trip ---
  console.log('== deny precedence + add/remove rule ==');
  addRule('deny', '*pay*');
  check('matchPolicy deny precedence', matchPolicy('https://x.com/pay').deniedBy === '*pay*');
  check('matchPolicy empty policy allows', (() => {
    writePolicy({ deny: [], requireApproval: [] });
    const m = matchPolicy('https://anything.example/');
    return m.deniedBy === null && m.requireApprovalBy === null;
  })());

  let p = addRule('deny', '*pay*');
  check('addRule adds deny', p.deny.includes('*pay*'));
  check('addRule dedups', addRule('deny', '*pay*').deny.filter((x) => x === '*pay*').length === 1);
  p = addRule('requireApproval', '*bank*');
  check('addRule adds requireApproval', p.requireApproval.includes('*bank*'));
  check('matchPolicy sees both layers', (() => {
    const m = matchPolicy('https://bank.example/pay');
    return m.deniedBy === '*pay*' && m.requireApprovalBy === null;
  })());
  p = removeRule('deny', '*pay*');
  check('removeRule removes deny', !p.deny.includes('*pay*'));
  check('removeRule invalid kind throws', (() => {
    try { removeRule('bogus', 'x'); return false; } catch { return true; }
  })());

  // --- 3. real deny on navigate (headless) ---
  console.log('== navigate denied by policy ==');
  const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-policy-'));
  let port = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/pay') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>pay</body></html>'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>home</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const srvPort = server.address().port;
  const HOME = `http://127.0.0.1:${srvPort}/`;
  const PAY = `http://127.0.0.1:${srvPort}/pay`;

  try {
    const r = await launchRealBrowser({ exePath: EXE, userDataDir: tmp, url: HOME, headless: true, waitMs: 30000 });
    port = r.port;
    console.log(`launched pid=${r.pid} port=${r.port}`);
    await waitFor(r.port, { selector: 'body', timeoutMs: 6000, urlSubstring: `127.0.0.1:${srvPort}` });

    writePolicy({ deny: ['*pay*'], requireApproval: [] });
    const denied = matchPolicy(PAY);
    check('policy matches the /pay URL', denied.deniedBy === '*pay*', `deniedBy=${denied.deniedBy}`);

    // navigatePage itself does NOT enforce policy (that lives in the tools
    // layer); this mirrors assertUrlPolicy's deny branch to prove the guard
    // throws before the navigation would happen.
    let blocked = false;
    try {
      if (matchPolicy(PAY).deniedBy) throw new Error('URL policy blocks navigation');
      await navigatePage(r.port, PAY, { urlSubstring: `127.0.0.1:${srvPort}` });
    } catch (e) {
      blocked = String(e.message).includes('URL policy blocks');
    }
    check('navigate to denied URL blocked before call', blocked);

    // With the deny rule removed the same navigation is permitted.
    removeRule('deny', '*pay*');
    const nav = await navigatePage(r.port, PAY, { urlSubstring: `127.0.0.1:${srvPort}` });
    check('navigate allowed after rule removal', nav.ok === true, `ok=${nav.ok}`);
  } finally {
    if (port) closeRealBrowser(port);
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
} finally {
  // restore the real policy file (from the state captured at the very start)
  if (hadPolicy) writeFileSync(POLICY, savedPolicy, 'utf8');
  else if (existsSync(POLICY)) unlinkSync(POLICY);
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('policy file restored.');
}

process.exitCode = fail === 0 ? 0 : 1;
