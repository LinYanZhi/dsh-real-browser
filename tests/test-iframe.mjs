// Iframe penetration test: snapshot must tag elements inside a SAME-ORIGIN
// iframe with a `frame` path, report CROSS-ORIGIN iframes separately, and the
// interaction layer must reach same-origin iframe elements by ref (auto frame)
// or by selector + frame, while refusing cross-origin frames with a clear
// error. Self-cleaning: temp profile + whole-tree close ALWAYS run.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchRealBrowser, closeRealBrowser } from '../launch.js';
import { evaluateJs } from '../cdp.js';
import { snapshotInteractive } from '../snapshot.js';
import { clickElement, fillElement, findElements, waitFor } from '../interact.js';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-iframe-'));
let port = null;
let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

// Same-origin server: main page + /frame.html. Counter + input live in the frame.
let crossPortRef = 0; // assigned after both servers listen; requests come later
const same = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (req.url === '/frame.html') {
    res.end(`<!doctype html><html><body>
      <h1>Same-Origin Frame</h1>
      <button id="fbtn">Frame button</button>
      <input id="finput" placeholder="frame input">
      <script>window.fcount = 0; document.getElementById('fbtn').addEventListener('click', () => { window.fcount++; });</script>
    </body></html>`);
    return;
  }
  res.end(`<!doctype html><html><body>
    <h1>Iframe Test</h1>
    <button id="topbtn">Top button</button>
    <iframe id="same" src="/frame.html"></iframe>
    <iframe id="cross" src="http://127.0.0.1:${crossPortRef}/frame.html"></iframe>
  </body></html>`);
});

// Cross-origin server (different port = different origin).
const cross = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><body><button id="xbtn">Cross button</button></body></html>');
});

await new Promise((r) => same.listen(0, '127.0.0.1', r));
await new Promise((r) => cross.listen(0, '127.0.0.1', r));
const samePort = same.address().port;
const crossPort = cross.address().port;
crossPortRef = crossPort;

async function main() {
  const page = `http://127.0.0.1:${samePort}/`;
  const r = await launchRealBrowser({ exePath: EXE, userDataDir: tmp, url: page, headless: true, waitMs: 30000 });
  port = r.port;
  console.log(`launched pid=${r.pid} port=${r.port}`);
  await waitFor(r.port, { selector: '#same', timeoutMs: 6000, urlSubstring: `127.0.0.1:${samePort}` });

  console.log('\n== snapshot frames ==');
  const snap = await snapshotInteractive(r.port, { urlSubstring: `127.0.0.1:${samePort}` });
  const inFrame = snap.elements.find((e) => e.selector === '#fbtn');
  const top = snap.elements.find((e) => e.selector === '#topbtn');
  check('top-frame element has no frame field', top && top.frame === undefined, JSON.stringify(top));
  check('same-origin iframe element tagged frame="0"', inFrame && inFrame.frame === '0', JSON.stringify(inFrame));
  const crossF = (snap.crossOriginFrames || []).find((f) => f.src && f.src.includes(`:${crossPort}`));
  check('cross-origin iframe reported separately', !!crossF && crossF.frame === '1', JSON.stringify(snap.crossOriginFrames));

  console.log('\n== click inside iframe (by ref, frame carried automatically) ==');
  const btnRef = inFrame.ref;
  await clickElement(r.port, { ref: btnRef, urlSubstring: `127.0.0.1:${samePort}` });
  const count = await evaluateJs(r.port, `document.getElementById('same').contentWindow.fcount`, { urlSubstring: `127.0.0.1:${samePort}` });
  check('iframe button click incremented frame counter', count.value === 1, `fcount=${count.value}`);

  console.log('\n== fill inside iframe (selector + frame) ==');
  const fillRes = await fillElement(r.port, { selector: '#finput', frame: '0', value: 'hello-frame', urlSubstring: `127.0.0.1:${samePort}` });
  const val = await evaluateJs(r.port, `document.getElementById('same').contentDocument.getElementById('finput').value`, { urlSubstring: `127.0.0.1:${samePort}` });
  check('iframe fill set value', val.value === 'hello-frame', `value=${JSON.stringify(val.value)}`);
  check('fill returns value', fillRes.value === 'hello-frame');

  console.log('\n== find inside iframe ==');
  const found = await findElements(r.port, { selector: 'button', frame: '0', urlSubstring: `127.0.0.1:${samePort}` });
  check('find in frame 0 finds the frame button', found.count === 1 && found.elements[0].id === 'fbtn', `count=${found.count}`);

  console.log('\n== cross-origin iframe refused with clear error ==');
  try {
    await clickElement(r.port, { selector: '#xbtn', frame: '1', urlSubstring: `127.0.0.1:${samePort}` });
    check('cross-origin click throws', false, 'should have thrown');
  } catch (e) {
    check('cross-origin click errors with guidance', /cross-origin/.test(e.message), e.message.slice(0, 120));
  }
}

try {
  await main();
} catch (e) {
  console.error('TEST ERROR:', e.message);
  fail += 1;
} finally {
  if (port) closeRealBrowser(port);
  same.close();
  cross.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('cleaned up');
}

process.exitCode = fail === 0 ? 0 : 1;
