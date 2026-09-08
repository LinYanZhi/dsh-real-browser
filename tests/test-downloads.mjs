// Download tracking test: activating real_page_downloads-style tracking on a
// headless browser and triggering a page download must record the event
// (suggestedFilename, url, byte progress, completed state). Self-cleaning.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchRealBrowser, closeRealBrowser } from '../launch.js';
import { navigatePage } from '../cdp.js';
import { waitFor } from '../interact.js';
import { ensureDownloadTracking, listDownloads, stopDownloadTracking } from '../downloads.js';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-downloads-'));
const dlDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-dldir-'));
let port = null;
let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const server = http.createServer((req, res) => {
  if (req.url === '/file.bin') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="probe.bin"',
    });
    res.end(Buffer.alloc(1024, 7));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><body><a id="dl" href="/file.bin">download</a></body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const srvPort = server.address().port;

async function main() {
  const r = await launchRealBrowser({
    exePath: EXE,
    userDataDir: tmp,
    url: `http://127.0.0.1:${srvPort}/`,
    headless: true,
    waitMs: 30000,
  });
  port = r.port;
  console.log(`launched pid=${r.pid} port=${r.port}`);

  await waitFor(r.port, { selector: '#dl', timeoutMs: 6000, urlSubstring: '127.0.0.1' });
  await ensureDownloadTracking(r.port, { downloadDir: dlDir });

  // Trigger the download by navigating to the attachment URL.
  await navigatePage(r.port, `http://127.0.0.1:${srvPort}/file.bin`, { urlSubstring: '127.0.0.1' });

  let entry = null;
  for (let i = 0; i < 20 && !entry; i += 1) {
    await new Promise((res) => setTimeout(res, 500));
    const dls = await listDownloads(r.port, {});
    entry = dls.downloads.find((d) => d.suggestedFilename === 'probe.bin');
  }
  check('download event recorded (suggestedFilename probe.bin)', !!entry, JSON.stringify(entry));
  check('download reached completed state', entry && entry.state === 'completed', entry && `state=${entry.state}`);
  check('byte progress reported', entry && entry.receivedBytes === 1024 && entry.totalBytes === 1024, entry && `${entry.receivedBytes}/${entry.totalBytes}`);
  check('url recorded', entry && entry.url.includes('/file.bin'), entry && entry.url);

  // clear empties the list
  await listDownloads(r.port, { clear: true });
  const after = await listDownloads(r.port, {});
  check('clear empties tracked list', after.downloads.length === 0, `count=${after.downloads.length}`);
}

try {
  await main();
} catch (e) {
  console.error('TEST ERROR:', e.message);
  fail += 1;
} finally {
  if (port) { stopDownloadTracking(port); closeRealBrowser(port); }
  server.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM: leftover temp dir is harmless */ }
  try { rmSync(dlDir, { recursive: true, force: true }); } catch { /* EPERM: leftover temp dir is harmless */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('cleaned up');
}

process.exitCode = fail === 0 ? 0 : 1;
