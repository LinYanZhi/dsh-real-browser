/**
 * Discover the REAL browser instances running on this machine.
 *
 * Scans Chrome / Edge / WebView2 / Ziniao (ziniaobrowser.exe) processes via
 * PowerShell `Get-CimInstance` and extracts the CDP debug port,
 * `--user-data-dir` and `--profile-directory` from each browser process
 * command line (mirrors the same process-scan approach used by the GLBT
 * app-kit Rust stack, without the Rust dependency).
 *
 * An instance is attachable only when it carries `--remote-debugging-port`
 * (Chrome's security model forbids attaching to a browser started without
 * one). Instances without a port are reported with a note so the AI knows why
 * it cannot attach.
 */

import { execFileSync } from 'node:child_process';

const BROWSER_NAMES = {
  'chrome.exe': 'chrome',
  'msedge.exe': 'edge',
  'msedgewebview2.exe': 'edge',
  'ziniaobrowser.exe': 'ziniao',
};

/** Extract `--key=value` (or `--key="value"`) from a command line. */
function extractArg(cmdline, key) {
  const needle = `${key}=`;
  const idx = cmdline.indexOf(needle);
  if (idx < 0) return undefined;
  const rest = cmdline.slice(idx + needle.length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end < 0 ? rest.slice(1) : rest.slice(1, end);
  }
  const m = rest.match(/^(\S+)/);
  return m ? m[1] : undefined;
}

/** Scan running browser processes; returns one entry per browser process. */
export function discoverRunningBrowsers() {
  const names = Object.keys(BROWSER_NAMES).join("' OR name='");
  const script =
    `Get-CimInstance Win32_Process -Filter "name='${names}'" ` +
    `| Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;

  let stdout = '';
  try {
    stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
    ).trim();
  } catch {
    return [];
  }
  if (!stdout) return [];

  let procs = [];
  try {
    procs = JSON.parse(stdout);
  } catch {
    try {
      procs = [JSON.parse(stdout)];
    } catch {
      return [];
    }
  }

  const out = [];
  for (const p of procs) {
    const cmdline = String(p.CommandLine ?? '');
    // Skip renderer / GPU / utility subprocesses — only the browser process
    // carries the debug port and user-data-dir.
    if (cmdline.includes('--type=')) continue;
    const exe = String(p.Name ?? '');
    const kind = BROWSER_NAMES[exe.toLowerCase()] ?? 'other';
    const portRaw = extractArg(cmdline, '--remote-debugging-port');
    const port = portRaw ? Number(portRaw) : undefined;
    const userDataDir = extractArg(cmdline, '--user-data-dir');
    const profileId = extractArg(cmdline, '--profile-directory');
    out.push({
      kind,
      pid: Number(p.ProcessId ?? 0),
      exe,
      ...(port ? { port } : {}),
      ...(userDataDir ? { userDataDir } : {}),
      ...(profileId ? { profileId } : {}),
      background: cmdline.includes('--no-startup-window'),
      attachable: port !== undefined,
      // 注意：不能把 note 设为 undefined（对象含 undefined 字段 → 工具框架
      // lossless JSON 校验失败 "value is not lossless JSON"）。无端口时
      // 才加 note，有端口时整字段省略。
      ...(port
        ? {}
        : { note: 'no --remote-debugging-port; cannot attach (relaunch it with a debug port, e.g. --remote-debugging-port=9222)' }),
    });
  }
  return out;
}
