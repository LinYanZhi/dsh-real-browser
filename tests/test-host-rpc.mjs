// Verify host.js RPC service methods accept POSITIONAL parameters exactly as the
// Typert gateway dispatches them (manifest parameter order), and that setAllowed
// persists to ~/.dsh/realbrowser-allowlist.json.
// Backs up and restores the real allowlist file so the user's state is untouched.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../host.js';

const FILE = path.join(os.homedir(), '.dsh', 'realbrowser-allowlist.json');
const POLICY = path.join(os.homedir(), '.dsh', 'realbrowser-policy.json');
const AI_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'AI');
const RPA_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data Rpa');
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const backup = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null;
const policyBackup = existsSync(POLICY) ? readFileSync(POLICY, 'utf8') : null;
const restore = () => {
  if (backup === null) {
    try { writeFileSync(FILE, JSON.stringify({ environments: [] }, null, 2)); } catch {}
  } else {
    writeFileSync(FILE, backup);
  }
  if (policyBackup === null) {
    try { writeFileSync(POLICY, JSON.stringify({ deny: [], requireApproval: [] }, null, 2)); } catch {}
  } else {
    writeFileSync(POLICY, policyBackup);
  }
};

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

try {
  const services = {};
  const ctx = { provide: (name, value) => { services[name] = value; } };
  apply(ctx);
  const svc = services.realBrowser;
  check('service provided', !!svc && typeof svc.setAllowed === 'function');

  // Baseline: the machine may already have allowlist entries (e.g. Chrome Rpa\Test),
  // so all length assertions are relative to the captured baseline, not absolute.
  const baselineEnvs = (() => {
    try { return JSON.parse(readFileSync(FILE, 'utf8')).environments || []; } catch { return []; }
  })();
  const baseline = baselineEnvs.length;
  const hasBaseline = (e) => baselineEnvs.some((b) => b.kind === e.kind && b.userDataDir === e.userDataDir && b.profileId === e.profileId);

  // 1. setAllowed ON, positionally like the gateway: (kind, userDataDir, profileId, allowed)
  await svc.setAllowed('edge', AI_DIR, 'Default', true);
  let raw = JSON.parse(readFileSync(FILE, 'utf8'));
  check('setAllowed(true) added 1 entry', raw.environments.length === baseline + 1, JSON.stringify(raw));
  check('entry has kind/userDataDir/profileId',
    !hasBaseline({ kind: 'edge', userDataDir: AI_DIR, profileId: 'Default' }) &&
      raw.environments.some((e) => e.kind === 'edge' && e.userDataDir === AI_DIR && e.profileId === 'Default'),
    JSON.stringify(raw.environments[raw.environments.length - 1]));

  // 2. getAllowlist reflects it
  const al = await svc.getAllowlist();
  check('getAllowlist reflects toggle', al.environments.some((e) => e.userDataDir === AI_DIR && e.profileId === 'Default'),
    JSON.stringify(al.environments));

  // 3. launch on the ALLOWED config passes the allowlist gate (fails later on real launch env issues — not the gate)
  //    Use a nonexistent exe to prove we got PAST assertAllowed (guard-2 error would mention user-data-dir).
  try {
    await svc.launch(EXE, AI_DIR, 'Default', 0, undefined, true, false);
    check('launch(allowed) passed allowlist gate', true);
  } catch (e) {
    const msg = String(e.message || e);
    check('launch(allowed) passed allowlist gate (no allowlist error)', !msg.includes('不在 AI 允许列表'), msg.slice(0, 120));
  }

  // 4. launch on a NOT-allowed config is rejected by the allowlist gate
  try {
    await svc.launch(EXE, RPA_DIR, 'Default', 0, undefined, true, false);
    check('launch(not-allowed) rejected', false, 'should have thrown');
  } catch (e) {
    const msg = String(e.message || e);
    check('launch(not-allowed) rejected with allowlist error', msg.includes('不在 AI 允许列表'), msg.slice(0, 120));
  }

  // 5. setAllowed OFF removes the entry
  await svc.setAllowed('edge', AI_DIR, 'Default', false);
  raw = JSON.parse(readFileSync(FILE, 'utf8'));
  check('setAllowed(false) removed entry', raw.environments.length === baseline, JSON.stringify(raw));

  // 6. detectEnv / listRunning basic shapes
  const env = await svc.detectEnv(false);
  check('detectEnv shape', Array.isArray(env.browsers) && env.browsers.length >= 1, JSON.stringify(Object.keys(env)));
  const run = await svc.listRunning();
  check('listRunning shape', Array.isArray(run.instances), JSON.stringify(Object.keys(run)));

  // 7. URL policy RPC (positional: kind, pattern)
  const pol0 = await svc.getPolicy();
  check('getPolicy shape', Array.isArray(pol0.deny) && Array.isArray(pol0.requireApproval), JSON.stringify(pol0));
  const added = await svc.policyAdd('deny', '*pay*');
  check('policyAdd persists', added.policy?.deny?.includes('*pay*'), JSON.stringify(added.policy));
  const pol1 = await svc.getPolicy();
  check('getPolicy reflects add', pol1.deny.includes('*pay*'));
  const removed = await svc.policyRemove('deny', '*pay*');
  check('policyRemove persists', !removed.policy?.deny?.includes('*pay*'), JSON.stringify(removed.policy));

  // 8. work mode RPC (positional: enabled)
  const wm0 = await svc.setWorkMode(true);
  check('setWorkMode(true) returns sensitive', wm0.sensitive === true, JSON.stringify(wm0));
  const wm1 = await svc.getWorkMode();
  check('getWorkMode reflects set', wm1.sensitive === true);
  const wm2 = await svc.setWorkMode(false);
  check('setWorkMode(false) resets', wm2.sensitive === false);

  console.log(failures === 0 ? '\nALL HOST RPC CHECKS PASS ✅' : `\n${failures} CHECK(S) FAILED ❌`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  restore();
  console.log('allowlist + policy files restored.');
}
