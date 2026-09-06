/**
 * Smoke test for dsh-real-browser — validates the CDP pipeline end to end
 * against a REAL browser on this machine:
 *   1. discoverRunningBrowsers()          — scan what's running
 *   2. launch a browser with a fresh temp profile + debug port
 *   3. list open pages
 *   4. evaluate JS in the page
 *   5. read page DOM
 *   6. kill the launched browser
 *
 * Run: node smoke.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { discoverRunningBrowsers } from './discover.js';
import { launchRealBrowser } from './launch.js';
import { listTargets, evaluateJs, readPageDom } from './cdp.js';

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
];

function findExe() {
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  return null;
}

const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => {
  console.log(`  ❌ ${msg}`);
  process.exitCode = 1;
};

async function main() {
  console.log('== 1. discover running real browsers ==');
  const instances = discoverRunningBrowsers();
  console.log(`  found ${instances.length} browser process(es):`);
  for (const i of instances) {
    console.log(
      `    - ${i.kind} pid=${i.pid}${i.port ? ` port=${i.port}` : ' (no port)'}` +
        `${i.userDataDir ? ` ud=${i.userDataDir}` : ''}${i.profileId ? ` profile=${i.profileId}` : ''}` +
        ` [${i.attachable ? 'attachable' : 'not attachable'}]`,
    );
  }
  if (instances.length > 0) pass('discover works');

  console.log('\n== 2. launch a real browser with temp profile ==');
  const exe = findExe();
  if (!exe) {
    fail('no Edge/Chrome found to launch — cannot continue');
    return;
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-real-browser-'));
  console.log(`  exe: ${exe}\n  temp profile: ${tmpDir}`);
  const launched = await launchRealBrowser({
    exePath: exe,
    userDataDir: tmpDir,
    url: 'https://example.com',
    headless: true, // invisible, self-cleaning — does not disturb the human
  });
  console.log(`  launched pid=${launched.pid} port=${launched.port} ws=${launched.wsUrl}`);
  pass('launch + CDP endpoint up');
  // Let Chrome settle its target tree (transient about:blank tabs appear early).
  await new Promise((r) => setTimeout(r, 1200));

  try {
    console.log('\n== 3. list open pages ==');
    const targets = await listTargets(launched.port);
    const pages = targets.filter((t) => t.type === 'page');
    console.log(`  ${pages.length} page target(s):`);
    for (const p of pages) console.log(`    - ${p.title || '(no title)'} ${p.url}`);
    if (pages.length >= 1) pass('list pages');

    console.log('\n== 4. evaluate JS ==');
    const r1 = await evaluateJs(launched.port, `document.title`);
    console.log(`  document.title => ${JSON.stringify(r1.value)}`);
    const r2 = await evaluateJs(
      launched.port,
      `JSON.stringify({ ua: navigator.userAgent.slice(0, 40), ready: document.readyState })`,
    );
    console.log(`  probe => ${r2.value}`);
    const r3 = await evaluateJs(launched.port, `(() => { throw new Error('boom-test'); })()`);
    console.log(`  exception path => ${r3.__exception ? r3.text + ' ' + r3.description.slice(0, 40) : 'UNEXPECTED'}`);
    if (typeof r1.value === 'string') pass('evaluate JS (value)');
    if (r3.__exception) pass('evaluate JS (exception reporting)');

    console.log('\n== 5. read page DOM ==');
    const now = await listTargets(launched.port);
    console.log(`  page targets right now: ${now.filter((t) => t.type === 'page').map((t) => `[${t.url}]`).join(' ') || '(none)'}`);
    const dom = await readPageDom(launched.port, { maxChars: 500 });
    console.log(`  url=${dom.url}\n  title=${dom.title}`);
    console.log(`  html head: ${(dom.html ?? '').slice(0, 160).replace(/\n/g, ' ')}`);
    const el = await readPageDom(launched.port, { selector: 'title', maxChars: 500 });
    console.log(`  selector 'title' matched=${el.found}, html=${(el.html ?? '').slice(0, 80)}`);
    if (dom.html && dom.html.length > 0) pass('read page DOM');
    if (el.found >= 1) pass('read page DOM (selector)');
  } finally {
    console.log('\n== 6. cleanup ==');
    try {
      const { closeRealBrowser } = await import('./launch.js');
      const killed = closeRealBrowser(launched.port); // whole tree (incl. renderers)
      rmSync(tmpDir, { recursive: true, force: true });
      pass(`closed ${killed} browser process(es) + removed temp profile`);
    } catch (e) {
      fail(`cleanup failed: ${String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
