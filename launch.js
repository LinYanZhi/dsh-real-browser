/**
 * Launch / attach / take over / close a REAL browser with a chosen profile.
 *
 * Implements the full GLBT `start_or_connect` semantics on top of CDP:
 *
 *   - already running WITH a debug port  -> attach (return the port, no spawn)
 *   - not running                         -> pick a free port, launch fresh, wait
 *   - running WITHOUT a debug port        -> the profile is locked; by default
 *     fail with a clear message, with `force: true` kill the lockers and relaunch
 *
 * Built-in platform guards (the AI should never have to discover these):
 *   - the DEFAULT user-data-dir (e.g. `...\Edge\User Data`) refuses a debug
 *     port ("DevTools remote debugging requires a non-default data directory")
 *     -> fail fast with the reason
 *   - a user-data-dir that does not exist -> fail fast (pick an existing
 *     environment from real_browser_env instead of creating new configs)
 *   - attaching requires `--remote-debugging-port` at launch
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { versionInfo } from './cdp.js';
import { discoverRunningBrowsers } from './discover.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Default user-data-dir per family, used to catch background holders. */
const DEFAULT_DIRS = {
  edge: (process.env.LOCALAPPDATA || '') + '\\Microsoft\\Edge\\User Data',
  chrome: (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\User Data',
};

const normalize = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();

/** Ask the OS for a currently-free TCP port (small race window, fine for dev). */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Kill browser processes that hold the given user-data-dir (case-insensitive).
 * Matches:
 *   - any browser process whose --user-data-dir equals the target
 *   - a `--no-startup-window` background process of the same family when the
 *     target is that family's default dir (its command line carries no
 *     --user-data-dir, but it owns the default profile and makes Edge/Chrome
 *     answer "already open in another session")
 */
export function killProfileLockers(userDataDir) {
  const target = normalize(userDataDir);
  const defaultOf = (kind) => normalize(DEFAULT_DIRS[kind] || '');
  const hits = discoverRunningBrowsers().filter((i) => {
    if (i.kind !== 'edge' && i.kind !== 'chrome') return false;
    if (i.userDataDir && normalize(i.userDataDir) === target) return true;
    if (i.background && defaultOf(i.kind) === target) return true;
    return false;
  });
  for (const h of hits) {
    try {
      process.kill(h.pid);
    } catch {
      /* already gone */
    }
  }
  return hits.length;
}

/**
 * Close the WHOLE browser tree on the given CDP port. Kills every process
 * whose command line carries `--remote-debugging-port=<port>` — the browser
 * process AND its renderer/GPU/utility children (they inherit the flag and
 * would otherwise linger as orphans when only the main pid is killed).
 */
export function closeRealBrowser(port) {
  const script =
    `Get-CimInstance Win32_Process -Filter "name='chrome.exe' OR name='msedge.exe' OR name='msedgewebview2.exe'" ` +
    `| Where-Object { $_.CommandLine -match '--remote-debugging-port=${port}' } ` +
    `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`;
  let killed = 0;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    ).trim();
    killed = out ? out.split(/\r?\n/).filter(Boolean).length : 0;
  } catch {
    killed = 0;
  }
  return killed;
}

/**
 * Launch (or attach to) a real browser with a given profile + debug port.
 *
 * @param {object} opts
 * @param {string} opts.exePath - path to chrome.exe / msedge.exe / etc.
 * @param {string} opts.userDataDir - an EXISTING non-default user-data-dir.
 * @param {string} [opts.profileId] - --profile-directory value (Chrome profile).
 * @param {number} [opts.port] - CDP port; a free port is picked when omitted.
 * @param {string} [opts.url] - initial URL to open.
 * @param {boolean} [opts.headless] - launch headless.
 * @param {number} [opts.waitMs] - debug-port wait (default 45s; real profiles
 *   cold-start slower than fresh temp profiles).
 * @param {boolean} [opts.force] - kill lockers and relaunch with the debug port.
 * @returns {Promise<{pid:number|null, port:number, wsUrl?:string, tookOver:boolean,
 *   killed:number, attached:boolean}>}
 */
export async function launchRealBrowser(opts) {
  const kind = /chrome\.exe$/i.test(opts.exePath) ? 'chrome' : 'edge';
  const targetDir = opts.userDataDir;

  // Guard 1: the DEFAULT profile dir can never be debug-launched.
  if (normalize(targetDir) === normalize(DEFAULT_DIRS[kind])) {
    throw new Error(
      `cannot enable CDP on the DEFAULT ${kind === 'edge' ? 'Edge' : 'Chrome'} profile directory (${targetDir}): Chrome/Edge refuse remote debugging on the default data directory for security. Use a NON-default user-data-dir (e.g. the RPA environments like "Edge User Data Rpa"), or drive a profile under it through the browser's own UI.`,
    );
  }

  // Guard 2: only drive EXISTING environments — never create new configs.
  // (Checked after the default-dir guard so the clearer error wins for it.)
  if (!existsSync(targetDir)) {
    throw new Error(
      `user-data-dir does not exist: ${targetDir}. Do NOT create new browser configs — pick an existing environment from real_browser_env (e.g. "Edge User Data Rpa").`,
    );
  }

  const running = discoverRunningBrowsers();
  const sameEnv = running.find(
    (i) =>
      (i.kind === kind) &&
      i.userDataDir &&
      normalize(i.userDataDir) === normalize(targetDir) &&
      (opts.profileId ? i.profileId === opts.profileId : true),
  );

  // Attach case: the same environment is already running WITH a debug port.
  if (sameEnv?.port) {
    return { pid: sameEnv.pid, port: sameEnv.port, wsUrl: undefined, tookOver: false, killed: 0, attached: true };
  }

  const port = opts.port ?? (await pickFreePort());

  // Takeover case: the same environment is running WITHOUT a port.
  if (sameEnv && !opts.force) {
    throw new Error(
      `profile is in use: browser pid=${sameEnv.pid} owns ${targetDir} without a debug port. Ask the human to close it, or retry with force:true to kill it and relaunch with the debug port.`,
    );
  }
  let killed = 0;
  if (sameEnv || opts.force) {
    killed = killProfileLockers(targetDir);
    if (killed > 0) await sleep(800); // let old processes die before relaunch
  }

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${targetDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (opts.profileId) args.push(`--profile-directory=${opts.profileId}`);
  if (opts.headless) args.push('--headless=new');
  if (opts.url) args.push(opts.url);

  const child = spawn(opts.exePath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  const waitMs = opts.waitMs ?? 45000;
  const deadline = Date.now() + waitMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const info = await versionInfo(port);
      return {
        pid: child.pid ?? null,
        port,
        wsUrl: info.webSocketDebuggerUrl,
        tookOver: killed > 0,
        killed,
        attached: false,
      };
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }

  // The port never came up. Clean up our own spawn: the browser may still be
  // cold-starting and would otherwise come up later as an orphan (a stale
  // process holding the profile and a stray window). Close the whole tree on
  // this port before failing loudly.
  const cleaned = closeRealBrowser(port);

  throw new Error(
    `browser debug port ${port} not ready in ${waitMs}ms (${String(lastErr)}); exe=${opts.exePath}, userDataDir=${targetDir}. Cleaned up ${cleaned} spawned process(es).`,
  );
}
