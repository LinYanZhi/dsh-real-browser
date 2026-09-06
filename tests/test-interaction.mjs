// End-to-end smoke of the interaction layer on a real (headless) browser.
// Self-cleaning: temp profile + whole-tree close ALWAYS run (try/finally).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchRealBrowser, closeRealBrowser } from '../launch.js';
import { navigatePage, evaluateJs } from '../cdp.js';
import { snapshotInteractive } from '../snapshot.js';
import {
  clickElement, fillElement, typeElement, pressKey, selectOption, checkElement,
  scrollPage, waitFor, findElements, listTabs, newTab, switchTab, closeTab, networkRequests, readConsole,
} from '../interact.js';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-interact-'));
let port = null;
let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const HTML = encodeURIComponent(`<!doctype html><html><body>
  <h1>Interact Test</h1>
  <button id="btn">Click me</button>
  <input id="txt" placeholder="Type here">
  <select id="sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <input id="chk" type="checkbox">
  <script>window.clicks = 0; document.getElementById('btn').addEventListener('click', () => { window.clicks++; });</script>
</body></html>`);
const PAGE = 'data:text/html,' + HTML;
const PIN = 'data:text/html'; // urlSubstring that uniquely matches the test tab

async function main() {
  const r = await launchRealBrowser({ exePath: EXE, userDataDir: tmp, url: PAGE, headless: true, waitMs: 30000 });
  port = r.port;
  console.log(`launched pid=${r.pid} port=${r.port}`);

  await waitFor(r.port, { jsCondition: `document.querySelector('#btn') !== null`, timeoutMs: 6000, urlSubstring: PIN });

  console.log('\n== snapshot ==');
  const snap = await snapshotInteractive(r.port, { urlSubstring: PIN });
  const byId = (id) => snap.elements.find((e) => e.selector === `#${id}`);
  check('snapshot has button', !!byId('btn'), byId('btn') ? `ref=${byId('btn').ref}` : '');
  check('snapshot has input', !!byId('txt'));
  check('snapshot has select', !!byId('sel'));
  const btnRef = byId('btn').ref;

  console.log('\n== click (by ref) ==');
  const clickRes = await clickElement(r.port, { ref: btnRef, urlSubstring: PIN });
  const clicks = await evaluateJs(r.port, `window.clicks`, { urlSubstring: PIN });
  check('click incremented counter', clicks.value === 1, `clicks=${clicks.value} (${clickRes.x},${clickRes.y})`);

  console.log('\n== fill (by selector) ==');
  const fillRes = await fillElement(r.port, { selector: '#txt', value: 'hello', urlSubstring: PIN });
  check('fill set value', fillRes.value === 'hello', `value=${JSON.stringify(fillRes.value)}`);

  console.log('\n== type ==');
  await typeElement(r.port, { selector: '#txt', text: ' world', urlSubstring: PIN });
  const typed = await evaluateJs(r.port, `document.getElementById('txt').value`, { urlSubstring: PIN });
  check('type appended', typed.value === 'hello world', `value=${JSON.stringify(typed.value)}`);

  console.log('\n== press_key ==');
  await pressKey(r.port, { key: 'Control+a', urlSubstring: PIN });
  check('press_key executed', true);

  console.log('\n== select ==');
  const selRes = await selectOption(r.port, { selector: '#sel', value: 'b', urlSubstring: PIN });
  check('select set value', selRes.value === 'b', `value=${JSON.stringify(selRes.value)}`);

  console.log('\n== check ==');
  const chkRes = await checkElement(r.port, { selector: '#chk', checked: true, urlSubstring: PIN });
  check('checkbox checked', chkRes.checked === true);

  console.log('\n== scroll / find / wait ==');
  await scrollPage(r.port, { direction: 'down', pixels: 100, urlSubstring: PIN });
  check('scroll executed', true);
  const found = await findElements(r.port, { selector: 'input', urlSubstring: PIN });
  check('find found 2 inputs', found.count === 2, `count=${found.count}`);
  const w = await waitFor(r.port, { jsCondition: `window.clicks === 1`, timeoutMs: 3000, urlSubstring: PIN });
  check('wait satisfied', w.satisfied === true);
  const w2 = await waitFor(r.port, { text: 'This text does not exist', timeoutMs: 1500, urlSubstring: PIN });
  check('wait timeout reports satisfied=false', w2.satisfied === false && w2.timedOut === true);

  console.log('\n== tabs ==');
  const tabsBefore = await listTabs(r.port);
  const created = await newTab(r.port, 'about:blank');
  const tabsAfter = await listTabs(r.port);
  check('tabs new added a tab', tabsAfter.length === tabsBefore.length + 1, `before=${tabsBefore.length} after=${tabsAfter.length}`);
  await switchTab(r.port, created.id);
  check('switch executed', true);
  await closeTab(r.port, created.id);
  const tabsEnd = await listTabs(r.port);
  check('tabs close removed it', tabsEnd.length === tabsBefore.length && !tabsEnd.some((t) => t.id === created.id), `count=${tabsEnd.length}`);

  console.log('\n== network ==');
  await navigatePage(r.port, 'https://example.com', { urlSubstring: PIN });
  await waitFor(r.port, { jsCondition: `document.readyState === 'complete'`, timeoutMs: 6000, urlSubstring: 'example.com' });
  await evaluateJs(r.port, `fetch('https://example.com/?cb=' + Date.now()).then(() => true)`, { urlSubstring: 'example.com', awaitPromise: true });
  await new Promise((res) => setTimeout(res, 600));
  const net = await networkRequests(r.port, { urlSubstring: 'example.com' });
  check('network captured requests', net.count > 0, `count=${net.count}`);

  console.log('\n== console ==');
  await readConsole(r.port, { urlSubstring: 'example.com' });
  await evaluateJs(r.port, `console.error('smoke-error-123'); true`, { urlSubstring: 'example.com' });
  await new Promise((res) => setTimeout(res, 300));
  const con = await readConsole(r.port, { urlSubstring: 'example.com' });
  check('console captured error', con.entries.some((e) => e.text.includes('smoke-error-123')), `count=${con.count}`);
}

try {
  await main();
} catch (e) {
  console.error('TEST ERROR:', e.message);
  fail += 1;
} finally {
  if (port) closeRealBrowser(port);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('cleaned up');
}

process.exitCode = fail === 0 ? 0 : 1;
