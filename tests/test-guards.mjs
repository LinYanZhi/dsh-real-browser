// Verify launch.js built-in guards (no browser is launched; checks fail fast).
//  1. DEFAULT user-data-dir -> refused immediately with the platform reason
//  2. non-existent user-data-dir -> refused immediately (do not create configs)
//  3. a real NON-default dir (RPA) -> passes the guards (fails only on the
//     deliberately-truncated wait, proving it was NOT fast-failed)
import { launchRealBrowser } from '../launch.js';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEFAULT_UD = 'C:\\Users\\LinYanZhi\\AppData\\Local\\Microsoft\\Edge\\User Data';
const RPA_UD = 'C:\\Users\\LinYanZhi\\AppData\\Local\\Microsoft\\Edge\\User Data Rpa';
const GHOST_UD = 'C:\\Users\\LinYanZhi\\AppData\\Local\\Temp\\dsh-ghost-profile-please-never-create';

let failures = 0;
const expectError = (label, fn, pattern) => {
  const t0 = Date.now();
  try {
    throw new Error('noop');
  } catch {
    // eslint-disable-next-line no-empty
  }
  return fn()
    .then(() => {
      console.log(`❌ ${label}: expected error, got success`);
      failures += 1;
    })
    .catch((e) => {
      const ms = Date.now() - t0;
      const ok = ms < 3000 && pattern.test(e.message);
      console.log(`${ok ? '✅' : '❌'} ${label} (${ms}ms)${ok ? '' : ` — unexpected: ${e.message.slice(0, 120)}`}`);
      if (!ok) failures += 1;
    });
};

// Guard 1: default dir is refused (fast, with the platform reason).
await expectError('guard: default dir refused', () => launchRealBrowser({ exePath: EXE, userDataDir: DEFAULT_UD, profileId: 'Profile 1' }), /DEFAULT.*refuse remote debugging/i);

// Guard 2: non-existent dir is refused (fast).
await expectError('guard: non-existent dir refused', () => launchRealBrowser({ exePath: EXE, userDataDir: GHOST_UD }), /does not exist.*Do NOT create new/i);

// Guard 3: a real non-default dir passes guards (fails only on truncated wait).
try {
  const r = await launchRealBrowser({ exePath: EXE, userDataDir: RPA_UD, profileId: 'Default', waitMs: 1 });
  console.log('⚠️  RPA dir unexpectedly launched:', JSON.stringify(r));
  failures += 1;
} catch (e) {
  const ok = /not ready in 1ms/.test(e.message) && !/refuse remote debugging/i.test(e.message);
  console.log(`${ok ? '✅' : '❌'} guard: non-default dir passes guards (wait-only failure)`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? 'all guards PASS ✅' : `${failures} guard(s) FAILED ❌`);
process.exitCode = failures === 0 ? 0 : 1;
