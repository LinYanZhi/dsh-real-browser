/**
 * 浏览器运维操作（对齐 GLBT「当前浏览器配置」右键菜单能力）：
 *   - getLaunchCommand  组装完整启动命令（不启动，供查看/复制/快捷方式复用）
 *   - createUserDataDir 新建用户数据目录（含最小 Local State，检测立即可见）
 *   - createShortcut    桌面快捷方式（WScript.Shell，零依赖）
 *   - closeProfile      精确关闭某配置（按 --user-data-dir 匹配主进程，taskkill /T 杀整树）
 *   - killAll           全部终止某浏览器（含所有独立目录实例，影响大）
 *
 * 零 npm 运行时依赖：PowerShell（COM / CIM / taskkill）+ Node 内置。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 运行 PowerShell 脚本，返回 trimmed stdout（失败返回 ''）。 */
function psOut(script) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 16 * 1024 * 1024 },
    ).trim();
  } catch {
    return '';
  }
}

const EXE_BY_KIND = { edge: 'msedge.exe', chrome: 'chrome.exe', ziniao: 'ziniaobrowser.exe' };
const NAMES_FILTER = `name='chrome.exe' OR name='msedge.exe' OR name='msedgewebview2.exe' OR name='ziniaobrowser.exe'`;

/** 规范化路径：小写 + 斜杠统一 + 去尾斜杠（比较用）。 */
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/**
 * 组装一个 profile 的完整启动参数（与 launch.js 的 launch 参数一致）。
 * @returns {{ exe_path: string, args: string[], command_line: string, debug_port: number }}
 */
export function getLaunchCommand({ exePath, userDataDir, profileId, port }) {
  const debugPort = Number(port) || 0;
  const args = [
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (profileId) args.push(`--profile-directory=${profileId}`);
  const command_line = `"${exePath}" ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  return { exe_path: exePath, args, command_line, debug_port: debugPort };
}

/**
 * 新建用户数据目录（含最小 Local State，使 env 检测的 suggested 目录扫描立即可见）。
 * @returns {{ path: string, created: boolean, existed: boolean }}
 */
export function createUserDataDir({ kind, parentDir, dirName }) {
  const base = String(parentDir || '').trim();
  const name = String(dirName || '').trim();
  if (!base || !name) throw new Error('parentDir 与 dirName 必填');
  const dir = path.join(base, name);
  const existed = existsSync(dir);
  if (!existed) mkdirSync(dir, { recursive: true });
  const lsPath = path.join(dir, 'Local State');
  if (!existsSync(lsPath)) {
    try {
      writeFileSync(lsPath, JSON.stringify({ profile: { info_cache: {} } }, null, 2), 'utf8');
    } catch (e) {
      throw new Error(`创建 Local State 失败: ${e.message}`);
    }
  }
  return { path: dir, created: !existed, existed };
}

/**
 * 创建桌面快捷方式（WScript.Shell，PowerShell 5.1 可用）。
 * @returns {{ shortcut_path: string, overwritten: boolean }}
 */
export function createShortcut({ kind, exePath, profileId, userDataDir, profileName, port }) {
  const cmd = getLaunchCommand({ exePath, userDataDir, profileId, port });
  const name = String(profileName || profileId || 'Browser').trim() || 'Browser';
  const json = JSON.stringify({
    exe: String(exePath),
    args: cmd.args,
    desktop: path.join(os.homedir(), 'Desktop'),
    name,
  });
  const script = `
$ErrorActionPreference = 'Stop'
$o = '${json}' | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path $o.desktop ($o.name + '.lnk')
$overwrite = Test-Path $lnkPath
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $o.exe
$lnk.Arguments = ($o.args | ForEach-Object { if ($_ -match '\\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
$lnk.IconLocation = $o.exe + ',0'
$lnk.Description = 'dsh-real-browser: ' + $o.name
$lnk.Save()
[pscustomobject]@{ path = $lnkPath; overwritten = $overwrite } | ConvertTo-Json -Compress
`;
  const raw = psOut(script);
  if (!raw) throw new Error('创建快捷方式失败（PowerShell 无输出；桌面路径可能不可写）');
  try {
    const r = JSON.parse(raw);
    return { shortcut_path: r.path, overwritten: !!r.overwritten };
  } catch {
    throw new Error(`创建快捷方式失败: 无法解析输出 ${raw.slice(0, 120)}`);
  }
}

/**
 * 精确关闭某配置：按 --user-data-dir（可选 --profile-directory）匹配该配置的
 * 主浏览器进程，taskkill /T 杀整棵进程树（renderer/GPU 一并结束）。
 * @returns {{ killed: number, pids: number[] }}
 */
export function closeProfile({ kind, userDataDir, profileId }) {
  const json = JSON.stringify({ dir: userDataDir, profile: profileId || null });
  const script = `
$o = '${json}' | ConvertFrom-Json
$target = $o.dir.Replace('\\','/').ToLower().TrimEnd('/')
$targetLeaf = Split-Path -Leaf $o.dir
$procs = Get-CimInstance Win32_Process -Filter "name='chrome.exe' OR name='msedge.exe' OR name='msedgewebview2.exe' OR name='ziniaobrowser.exe'"
$main = @()
foreach ($p in $procs) {
  $c = [string]$p.CommandLine
  if ($c -match '--type=') { continue }
  if ($c -notmatch '--user-data-dir') { continue }
  $m = [regex]::Match($c, '--user-data-dir=(?:"([^"]*)"|(\\S+))')
  if (-not $m.Success) { continue }
  $ud = if ($m.Groups[1].Value) { $m.Groups[1].Value } else { $m.Groups[2].Value }
  if ($ud.Replace('\\','/').ToLower().TrimEnd('/') -ne $target) { continue }
  if ($o.profile) {
    $pm = [regex]::Match($c, '--profile-directory=(?:"([^"]*)"|(\\S+))')
    if ($pm.Success) {
      $pidv = if ($pm.Groups[1].Value) { $pm.Groups[1].Value } else { $pm.Groups[2].Value }
      if ($pidv -ne $o.profile) { continue }
    } else { continue }
  }
  $main += [int]$p.ProcessId
}
$ids = $main | Sort-Object -Unique
foreach ($id in $ids) { & taskkill /PID $id /T /F 2>$null | Out-Null; Start-Sleep -Milliseconds 200 }
$ids | ConvertTo-Json -Compress
`;
  const raw = psOut(script);
  let pids = [];
  if (raw) {
    try {
      pids = JSON.parse(raw);
      if (!Array.isArray(pids)) pids = [pids];
    } catch {
      pids = [];
    }
  }
  return { killed: pids.length, pids };
}

/**
 * 全部终止某浏览器（含所有独立目录实例）。影响大，UI 须先确认。
 * @returns {{ killed: number }}
 */
export function killAll({ kind }) {
  const exe = EXE_BY_KIND[kind];
  if (!exe) throw new Error(`unknown browser kind: ${kind}`);
  const script = `
$procs = Get-CimInstance Win32_Process -Filter "name='${exe}'" | Where-Object { $_.CommandLine -notmatch '--type=' }
$ids = @($procs | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
foreach ($id in $ids) { & taskkill /PID $id /T /F 2>$null | Out-Null; Start-Sleep -Milliseconds 150 }
$ids.Count
`;
  const raw = psOut(script);
  const n = Number(String(raw).trim());
  return { killed: Number.isFinite(n) ? n : 0 };
}

export { sleep };
