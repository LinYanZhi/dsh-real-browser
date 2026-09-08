// Captcha detection test: a page carrying reCAPTCHA / Turnstile / Yidun /
// image-captcha markers must be detected with correct families, and a clean
// page must report none. Self-cleaning (headless, local HTTP server).
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchRealBrowser, closeRealBrowser } from '../launch.js';
import { detectCaptcha } from '../captcha.js';
import { navigatePage } from '../cdp.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const CAPTCHA_PAGE = `<!doctype html><html><body>
  <h1>login</h1>
  <iframe src="/api/recaptcha/anchor"></iframe>
  <div class="g-recaptcha" data-sitekey="6Lc-fake"></div>
  <iframe src="/challenges.cloudflare.com/turnstile"></iframe>
  <div class="nc-container"><div class="nc_scale"></div></div>
  <img src="/captcha.gif" alt="captcha-code">
  <button>登录</button>
</body></html>`;

const CLEAN_PAGE = `<!doctype html><html><body><h1>home</h1><button>go</button></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(req.url === '/clean' ? CLEAN_PAGE : CAPTCHA_PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const srvPort = server.address().port;

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-captcha-'));
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

  console.log('== captcha page ==');
  const hit = await detectCaptcha(r.port, { urlSubstring: `127.0.0.1:${srvPort}` });
  check('verdict detected', hit.verdict === 'detected', `verdict=${hit.verdict}`);
  const types = hit.detected.map((d) => d.type);
  check('reCAPTCHA detected (iframe + [data-sitekey])', types.includes('recaptcha'), types.join(', '));
  check('Turnstile detected', types.includes('turnstile'), types.join(', '));
  check('Yidun/noCaptcha detected (.nc-container)', types.includes('yidun-or-nocaptcha') || types.includes('aliyun-nocaptcha'), types.join(', '));
  check('image captcha detected', types.includes('image-captcha'), types.join(', '));
  check('confidence labels present', hit.detected.every((d) => typeof d.confidence === 'number' && d.confidence > 0));

  console.log('== clean page ==');
  await navigatePage(r.port, `http://127.0.0.1:${srvPort}/clean`, { urlSubstring: `127.0.0.1:${srvPort}` });
  await new Promise((res) => setTimeout(res, 600));
  const none = await detectCaptcha(r.port, { urlSubstring: `/clean` });
  check('verdict none on clean page', none.verdict === 'none', `verdict=${none.verdict} detected=${none.detected.length}`);
} finally {
  if (port) closeRealBrowser(port);
  server.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM: leftover temp dir is harmless */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('cleaned up');
}

process.exitCode = fail === 0 ? 0 : 1;
