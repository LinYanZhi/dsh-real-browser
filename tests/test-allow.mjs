// Allowlist approval gate tests for tools.js:
//   - real_browser_allow: grant (approval-gated) / revoke (ungated) / already /
//     rejected / missing approval service / missing agent
//   - real_browser_launch: autoGrant:true grants via approval then launches;
//     autoGrant absent rejects with the actionable message; already-allowed
//     launches without consulting approval.
// ./launch.js is redirected to a stub (mock-launch.js) so nothing spawns.
// The real allowlist file is backed up and restored.
import { register } from 'node:module';
register('./mock-loader.mjs', import.meta.url);
register(new URL('./mock-launch-loader.mjs', import.meta.url), import.meta.url);

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCalls } from './mock-launch.js';

const FILE = path.join(os.homedir(), '.dsh', 'realbrowser-allowlist.json');
const DIR = 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome Rpa\\ozon';
const PROFILE = 'Default';
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const backup = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null;
const restore = () => {
  if (backup === null) {
    try { writeFileSync(FILE, JSON.stringify({ environments: [] }, null, 2)); } catch {}
  } else {
    writeFileSync(FILE, backup);
  }
};

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const { name, inject, apply } = await import('../tools.js');

function makeCtx(approval) {
  const registered = [];
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    get: (key) => (key === 'approval' ? approval : undefined),
  };
  apply(ctx);
  return { registered, ctx };
}

const exec = (agent = { id: 'test-agent' }) => ({ agent, signal: new AbortController().signal });
const execNoAgent = () => ({ signal: new AbortController().signal });

try {
  // ── real_browser_allow ──────────────────────────────────────────────────────
  const approved = { request: async (req) => { approved.seen = req; return 'allowed-once'; } };
  const { registered } = makeCtx(approved);
  const allow = registered.find((t) => t.name === 'real_browser_allow');
  check('real_browser_allow registered', !!allow, 'not found');

  // grant: not allowed → approval → allowed-once → written
  launchCalls.length = 0;
  const granted = await allow.execute({ userDataDir: DIR, profileId: PROFILE }, exec());
  check('grant returns granted:true', granted.granted === true, JSON.stringify(granted));
  check('grant wrote allowlist', granted.environments.some((e) => e.userDataDir === DIR && e.profileId === PROFILE), JSON.stringify(granted.environments));
  check('approval asked with agent + reason', approved.seen && approved.seen.agent && /ozon/.test(approved.seen.reason), JSON.stringify(approved.seen));

  // already allowed → no approval round-trip, already:true
  approved.seen = undefined;
  const again = await allow.execute({ userDataDir: DIR, profileId: PROFILE }, exec());
  check('already-allowed is idempotent', again.already === true && approved.seen === undefined, JSON.stringify(again));

  // revoke: allowed:false → immediate, no approval
  approved.seen = undefined;
  const revoked = await allow.execute({ userDataDir: DIR, profileId: PROFILE, allowed: false }, exec());
  check('revoke is immediate + no approval', revoked.revoked === true && approved.seen === undefined, JSON.stringify(revoked));
  check('revoke removed entry', !revoked.environments.some((e) => e.userDataDir === DIR && e.profileId === PROFILE), JSON.stringify(revoked.environments));

  // rejected → not written
  const rejected = { request: async () => 'rejected' };
  const { registered: r2 } = makeCtx(rejected);
  const allow2 = r2.find((t) => t.name === 'real_browser_allow');
  const denied = await allow2.execute({ userDataDir: DIR, profileId: PROFILE }, exec());
  check('rejected → granted:false, outcome:rejected', denied.granted === false && denied.outcome === 'rejected', JSON.stringify(denied));
  check('rejected → NOT written', !denied.environments.some((e) => e.userDataDir === DIR && e.profileId === PROFILE), JSON.stringify(denied.environments));

  // missing approval service → hard error with guidance
  const { registered: r3 } = makeCtx(undefined);
  const allow3 = r3.find((t) => t.name === 'real_browser_allow');
  try {
    await allow3.execute({ userDataDir: DIR, profileId: PROFILE }, exec());
    check('missing approval service throws', false, 'should have thrown');
  } catch (e) {
    check('missing approval service throws w/ guidance', /审批服务不可用/.test(e.message), e.message.slice(0, 120));
  }

  // missing agent → hard error with guidance
  const { registered: r4 } = makeCtx(approved);
  const allow4 = r4.find((t) => t.name === 'real_browser_allow');
  try {
    await allow4.execute({ userDataDir: DIR, profileId: PROFILE }, execNoAgent());
    check('missing agent throws', false, 'should have thrown');
  } catch (e) {
    check('missing agent throws w/ guidance', /Agent 会话上下文/.test(e.message), e.message.slice(0, 120));
  }

  // ── real_browser_launch + autoGrant ────────────────────────────────────────
  const { registered: r5 } = makeCtx({ request: async () => 'allowed-once' });
  const launch = r5.find((t) => t.name === 'real_browser_launch');
  check('real_browser_launch registered', !!launch, 'not found');

  // autoGrant on a not-allowed profile → approval → written → launch called
  launchCalls.length = 0;
  const launched = await launch.execute(
    { exePath: EXE, userDataDir: DIR, profileId: PROFILE, autoGrant: true },
    exec(),
  );
  check('autoGrant launches after approval', launched.port === 9222 && launchCalls.length === 1, JSON.stringify(launched));
  check('autoGrant wrote allowlist', readAllowlistRaw().environments.some((e) => e.userDataDir === DIR && e.profileId === PROFILE), 'entry missing');

  // no autoGrant on a not-allowed profile → actionable error
  // (first revoke what autoGrant just granted so the profile is NOT allowed)
  await allow.execute({ userDataDir: DIR, profileId: PROFILE, allowed: false }, exec());
  launchCalls.length = 0;
  try {
    await launch.execute({ exePath: EXE, userDataDir: DIR, profileId: PROFILE }, exec());
    check('no-autoGrant on not-allowed throws', false, 'should have thrown');
  } catch (e) {
    check(
      'no-autoGrant error names real_browser_allow + autoGrant',
      /real_browser_allow/.test(e.message) && /autoGrant/.test(e.message),
      e.message.slice(0, 160),
    );
  }

  // allowed profile → launches without consulting approval
  // (re-grant first — the previous step revoked the profile)
  await allow.execute({ userDataDir: DIR, profileId: PROFILE }, exec());
  approved.seen = undefined; // clear before asserting launch never asks
  launchCalls.length = 0;
  const direct = await launch.execute({ exePath: EXE, userDataDir: DIR, profileId: PROFILE }, exec());
  check('allowed profile launches directly', direct.port === 9222 && launchCalls.length === 1 && approved.seen === undefined, JSON.stringify(direct));

  console.log(failures === 0 ? '\nALL ALLOW/GATE CHECKS PASS ✅' : `\n${failures} CHECK(S) FAILED ❌`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  restore();
  console.log('allowlist file restored.');
}

function readAllowlistRaw() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { environments: [] }; }
}
