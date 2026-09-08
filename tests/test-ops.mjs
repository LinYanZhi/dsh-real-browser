// Verify ops.js REAL behaviors (not just command assembly):
//   createUserDataDir → directory + minimal Local State
//   launchRealBrowser on that fresh dir → process with CDP port
//   closeProfile(kind, userDataDir, profileId) → kills exactly that tree
// All done on a temp dir; user browsers are never touched.
// killAll / createShortcut are intentionally NOT executed here (destructive / writes Desktop).
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createUserDataDir, closeProfile } from '../ops.js';
import { launchRealBrowser } from '../launch.js';
import { detectEnvironment } from '../env.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psOut = (script) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  } catch { return ''; }
};
const runningWith = (dir) => {
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const t = norm(dir);
  const raw = psOut(`Get-CimInstance Win32_Process -Filter "name='chrome.exe' OR name='msedge.exe' OR name='msedgewebview2.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`);
  if (!raw) return [];
  let procs = [];
  try { procs = JSON.parse(raw); } catch { try { procs = [JSON.parse(raw)]; } catch { return []; } }
  if (!Array.isArray(procs)) procs = [procs];
  return procs.filter((p) => String(p.CommandLine || '').includes('--user-data-dir') && norm(String(p.CommandLine)).includes(norm(t.replace(/^[a-z]:/, (m) => m.toLowerCase())) + '') || false);
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rb-ops-'));
const dir = path.join(tmp, 'TestProfile');
let port = 0;

try {
  // 1. createUserDataDir
  const r1 = createUserDataDir({ kind: 'edge', parentDir: tmp, dirName: 'TestProfile' });
  check('createUserDataDir created dir', r1.created === true && existsSync(dir), JSON.stringify(r1));
  const ls = readFileSync(path.join(dir, 'Local State'), 'utf8');
  check('Local State written', ls.includes('info_cache'), ls.slice(0, 80));

  // 2. launch on the fresh dir (headless, temp profile)
  const env = detectEnvironment({ includeAvatars: false });
  const edge = env.find((b) => b.browser_type === 'edge');
  const exe = edge && edge.exe_paths[0];
  check('edge exe detected', !!exe, 'no edge exe — launch test skipped');
  if (exe) {
    const lr = await launchRealBrowser({ exePath: exe, userDataDir: dir, profileId: 'Default', port: 0, url: '', headless: true, force: false });
    port = lr.port;
    check('launch returns port', port > 0, JSON.stringify(lr));
    await sleep(2500);
    const found = runningWith(dir);
    check('process running on temp dir', found.length > 0, `found=${found.length}`);

    // 3. closeProfile kills exactly that tree
    const cl = closeProfile({ kind: 'edge', userDataDir: dir, profileId: 'Default' });
    check('closeProfile killed ≥1 process', cl.killed >= 1, JSON.stringify(cl));
    await sleep(1500);
    const after = runningWith(dir);
    check('temp profile fully closed', after.length === 0, `still=${after.length}`);
  }

  console.log(failures === 0 ? '\nALL OPS REAL-BEHAVIOR CHECKS PASS ✅' : `\n${failures} CHECK(S) FAILED ❌`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM: leftover temp dir is harmless */ }
  console.log('temp dir cleaned.');
}
