// Work Mode + credential vault test: DPAPI round-trip with plaintext never at
// rest, vault list/delete, the work-mode toggle, and real headless checks that
// password fields are redacted in snapshot/fill and that typeSecret types a
// vault value without ever exposing it. The real vault file is saved at the
// start and restored at the end.
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchRealBrowser, closeRealBrowser } from '../launch.js';
import { snapshotInteractive } from '../snapshot.js';
import { fillElement, typeSecret } from '../interact.js';
import { evaluateJs, navigatePage } from '../cdp.js';
import {
  getWorkMode, setWorkMode,
  vaultSet, vaultGet, vaultList, vaultDelete, vaultHas,
} from '../workmode.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

// --- 0. save the real vault file FIRST ---
const VAULT = path.join(os.homedir(), '.dsh', 'realbrowser-vault.json');
const hadVault = existsSync(VAULT);
const savedVault = hadVault ? readFileSync(VAULT, 'utf8') : null;
const PLAINTEXT = 'S3cret!value-90210';

try {
  // --- 1. vault DPAPI round-trip + at-rest hygiene ---
  console.log('== vault (DPAPI, at-rest encrypted) ==');
  vaultSet('test-secret', PLAINTEXT);
  check('vaultGet returns the plaintext', vaultGet('test-secret') === PLAINTEXT, `len=${(vaultGet('test-secret') || '').length}`);
  const raw = readFileSync(VAULT, 'utf8');
  check('plaintext NOT present in vault file', !raw.includes(PLAINTEXT), 'file is encrypted at rest');
  check('vaultHas true', vaultHas('test-secret'));
  check('vaultList includes the key', vaultList().includes('test-secret'));
  check('vaultGet missing key -> undefined', vaultGet('nope') === undefined);

  // --- 2. work mode toggle (pure) ---
  console.log('== work mode ==');
  setWorkMode(false);
  check('default work mode is normal', getWorkMode() === false);
  setWorkMode(true);
  check('setWorkMode(true) flips it', getWorkMode() === true);
  setWorkMode(false);
  check('setWorkMode(false) restores', getWorkMode() === false);

  // --- 3. password hygiene + typeSecret (headless) ---
  console.log('== credential isolation on a real page ==');
  const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-vault-'));
  let port = null;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><input id="user" placeholder="User"><input id="pw" type="password" placeholder="Pass"></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const srvPort = server.address().port;
  const HOME = `http://127.0.0.1:${srvPort}/`;

  try {
    const r = await launchRealBrowser({ exePath: EXE, userDataDir: tmp, url: HOME, headless: true, waitMs: 30000 });
    port = r.port;
    console.log(`launched pid=${r.pid} port=${r.port}`);
    await new Promise((res) => setTimeout(res, 1200));

    // snapshot: password value masked IN-PAGE (never leaves the browser)
    const snap = await snapshotInteractive(r.port, { urlSubstring: `127.0.0.1:${srvPort}` });
    const pwEl = snap.elements.find((e) => e.selector === '#pw');
    const userEl = snap.elements.find((e) => e.selector === '#user');
    check('snapshot has the password field', !!pwEl);
    check('password value masked in snapshot', pwEl?.value === undefined || pwEl.value === '[redacted]', `value=${JSON.stringify(pwEl?.value)}`);
    check('password name masked in snapshot', pwEl?.name === '(password)', `name=${JSON.stringify(pwEl?.name)}`);

    // fill: password target returns redacted, normal field echoes (normal mode)
    const fillPw = await fillElement(r.port, { selector: '#pw', value: 'hunter2', urlSubstring: `127.0.0.1:${srvPort}` });
    check('fill into password returns redacted', fillPw.redacted === true && fillPw.value === undefined, JSON.stringify(fillPw));
    const fillUser = await fillElement(r.port, { selector: '#user', value: 'bob', urlSubstring: `127.0.0.1:${srvPort}` });
    check('fill into normal field echoes value (normal mode)', fillUser.value === 'bob', JSON.stringify(fillUser));

    // work mode ON: all fills redacted
    setWorkMode(true);
    const fillUser2 = await fillElement(r.port, { selector: '#user', value: 'alice', urlSubstring: `127.0.0.1:${srvPort}` });
    check('sensitive mode: normal field fill redacted', fillUser2.redacted === true && fillUser2.value === undefined, JSON.stringify(fillUser2));
    const snap2 = await snapshotInteractive(r.port, { urlSubstring: `127.0.0.1:${srvPort}` });
    const userEl2 = snap2.elements.find((e) => e.selector === '#user');
    check('sensitive mode: snapshot masks all values', userEl2?.value === '[redacted]', `value=${JSON.stringify(userEl2?.value)}`);
    setWorkMode(false);

    // typeSecret: types a vault value without exposing it
    const VAULT_SECRET = 'vault-secret-99';
    vaultSet('shop-pw', VAULT_SECRET);
    // clear the field first (insertText appends at the cursor)
    await fillElement(r.port, { selector: '#pw', value: '', urlSubstring: `127.0.0.1:${srvPort}` });
    const ts = await typeSecret(r.port, { vaultKey: 'shop-pw', selector: '#pw', urlSubstring: `127.0.0.1:${srvPort}` });
    check('typeSecret returns only a key marker', ts.typed === '[from vault: shop-pw]', JSON.stringify(ts));
    check('typeSecret result never contains the secret', !JSON.stringify(ts).includes(VAULT_SECRET));
    const val = await evaluateJs(r.port, `document.getElementById('pw').value`, { urlSubstring: `127.0.0.1:${srvPort}` });
    check('the secret actually landed in the field', val.value === VAULT_SECRET, `valueLen=${String(val.value).length}`);

    // typeSecret with a missing key errors with guidance
    let missing = false;
    try { await typeSecret(r.port, { vaultKey: 'no-such-key', selector: '#pw', urlSubstring: `127.0.0.1:${srvPort}` }); } catch (e) { missing = String(e.message).includes('not found'); }
    check('typeSecret missing key errors with guidance', missing);
  } finally {
    if (port) closeRealBrowser(port);
    server.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM: leftover temp dir is harmless */ }
  }

  // --- 4. delete ---
  console.log('== vault delete ==');
  vaultDelete('test-secret');
  check('vaultDelete removes the key', !vaultList().includes('test-secret'));
  vaultDelete('shop-pw');
  check('vaultDelete removes shop-pw', !vaultList().includes('shop-pw'));
} finally {
  // restore the real vault file
  if (hadVault) writeFileSync(VAULT, savedVault, 'utf8');
  else if (existsSync(VAULT)) unlinkSync(VAULT);
  setWorkMode(false);
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('vault file restored, work mode reset.');
}

process.exitCode = fail === 0 ? 0 : 1;
