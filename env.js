/**
 * Environment detection — the foundation layer.
 *
 * Mirrors the GLBT app-kit `appkit-core::browser` detection so the DSH AI sees
 * the same view of "what browsers are installed on this machine, their
 * profiles, and the user's browser configuration" that the Tauri apps use:
 *
 *   - installed browsers (Edge / Chrome): exe paths (registry App Paths +
 *     standard install paths), version (exe FileVersion, registry fallback),
 *     default user-data-dir, suggested user-data-dirs (sibling dirs that carry
 *     a `Local State`, plus "Edge Rpa" / "Chrome RPA" variant dirs)
 *   - per user-data-dir: profiles parsed from `Local State` →
 *     `/profile/info_cache` (id, name, user_name, email, path, download_dir,
 *     avatar)
 *   - avatar fallback chain (same order as the Rust impl): Screenshots/*,
 *     "Google/Edge Profile Picture.png", *.ico, Avatar dir, Preferences
 *     data:image + gaia_info_picture_url, info_cache data:image, info_cache
 *     avatar_icon http(s), IDR_PROFILE_AVATAR_N cache files under
 *     {User Data}\Avatars
 *
 * This layer performs NO launching and opens NO pages — it only reads registry,
 * files and process state. Ziniao is deliberately out of scope for now.
 *
 * Zero npm dependencies: registry/version go through PowerShell, everything
 * else is plain fs/JSON in Node.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readAvatarBase64, optimizeAvatars } from './env-avatars.js';
import { readConfig } from './config.js';

const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const SYSTEM_DOWNLOAD = path.join(os.homedir(), 'Downloads');

// ---------------------------------------------------------------------------
// Browser definitions
// ---------------------------------------------------------------------------

const BROWSER_DEFS = {
  edge: {
    kind: 'edge',
    browserName: 'Microsoft Edge',
    exe: 'msedge.exe',
    appPathKey: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    versionKeys: [
      { key: 'HKLM:\\SOFTWARE\\Microsoft\\Edge\\BLBeacon', value: 'version' },
      { key: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Microsoft Edge', value: 'DisplayVersion' },
    ],
    standardPaths: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(LOCAL_APPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    defaultUserDataDir: path.join(LOCAL_APPDATA, 'Microsoft', 'Edge', 'User Data'),
    rpaBrand: 'Edge',
  },
  chrome: {
    kind: 'chrome',
    browserName: 'Google Chrome',
    exe: 'chrome.exe',
    appPathKey: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    versionKeys: [
      { key: 'HKLM:\\SOFTWARE\\Google\\Update\\Clients\\{8A69D345-D564-463c-AFF1-A69D9E530F96}', value: 'pv' },
      { key: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Google Chrome', value: 'DisplayVersion' },
    ],
    standardPaths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(LOCAL_APPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    defaultUserDataDir: path.join(LOCAL_APPDATA, 'Google', 'Chrome', 'User Data'),
    rpaBrand: 'Chrome',
  },
};

/** Run a PowerShell script, returning trimmed stdout (empty on failure). */
function psOut(script) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * One PowerShell round-trip per browser: registry App Paths default value,
 * registry versions, exe FileVersion, and suggested user-data-dir scans
 * (sibling dirs with `Local State` + "{Brand} Rpa" variant subdirs).
 */
function psRegistryAndDirs(def) {
  // JSON.stringify keeps backslashes doubled (`\\`) — that IS valid JSON, and
  // ConvertFrom-Json (PowerShell 5.1) turns them back into single backslashes.
  // Do NOT unescape here: single `\X` sequences are invalid JSON escapes and
  // make ConvertFrom-Json fail silently.
  const json = JSON.stringify(def);
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$d = '${json}' | ConvertFrom-Json
$out = [ordered]@{ appPath = $null; versions = @(); fileVersion = $null; siblings = @(); rpaDirs = @() }
$k = Get-Item $d.appPathKey
if ($k) { $out.appPath = [string]$k.GetValue('') }
foreach ($vk in $d.versionKeys) {
  $item = Get-ItemProperty $vk.key
  if ($item) { $v = [string]$item.($vk.value); if ($v) { $out.versions += $v } }
}
$exe = $out.appPath
if (-not $exe) { foreach ($sp in $d.standardPaths) { if (Test-Path $sp) { $exe = $sp; break } } }
if ($exe -and (Test-Path $exe)) {
  $fi = Get-Item $exe
  if ($fi) { $out.fileVersion = [string]$fi.VersionInfo.FileVersion }
}
$default = $d.defaultUserDataDir
$defaultLeaf = Split-Path -Leaf $default
$parent = Split-Path -Parent $default
if (Test-Path $parent) {
  $out.siblings = @(Get-ChildItem -Path $parent -Directory | Where-Object { $_.Name -ne $defaultLeaf -and (Test-Path (Join-Path $_.FullName 'Local State')) } | ForEach-Object { $_.FullName })
}
$rpa = Join-Path (Split-Path -Parent $parent) ($d.rpaBrand + ' Rpa')
if (Test-Path $rpa) {
  $out.rpaDirs = @(Get-ChildItem -Path $rpa -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'Local State') } | ForEach-Object { $_.FullName })
}
$out | ConvertTo-Json -Compress
`;
  const raw = psOut(script);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Profiles (Local State parsing)
// ---------------------------------------------------------------------------

/** Read and parse {User Data}\Local State, returning its parsed JSON or null. */
function readLocalState(userDataDir) {
  const lsPath = path.join(userDataDir, 'Local State');
  if (!existsSync(lsPath)) return null;
  try {
    return JSON.parse(readFileSync(lsPath, 'utf8'));
  } catch {
    return null;
  }
}


function readDownloadDirFromPrefs(profilePath) {
  const prefsPath = path.join(profilePath, 'Preferences');
  if (!existsSync(prefsPath)) return undefined;
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
    const d = prefs?.download?.default_directory;
    return typeof d === 'string' && d ? d : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read profiles for one user-data-dir (mirrors browser_profiles.rs).
 * @returns {Array} ProfileInfo-like objects, Default first.
 */
export function readProfiles(userDataDir, isEdge, includeAvatars = true) {
  const ls = readLocalState(userDataDir);
  const infoCache = ls?.profile?.info_cache;
  if (!ls || !infoCache || typeof infoCache !== 'object') return [];

  const out = [];
  for (const [profileId, info] of Object.entries(infoCache)) {
    if (!info || typeof info !== 'object') continue;
    const name = typeof info.name === 'string' ? info.name : profileId;
    const user_name = typeof info.user_name === 'string' ? info.user_name : '';
    const email = typeof info.email === 'string' ? info.email : '';
    const profilePath = path.join(userDataDir, profileId);

    let avatar = includeAvatars
      ? readAvatarBase64(profilePath, isEdge, userDataDir, info)
      : { base64: '', hasIcon: false };

    const downloadDir = readDownloadDirFromPrefs(profilePath) ?? SYSTEM_DOWNLOAD;

    out.push({
      id: profileId,
      name,
      user_name,
      email,
      path: profilePath,
      user_data_dir: userDataDir,
      download_dir: downloadDir,
      avatar_base64: avatar.base64,
      avatar_has_icon: avatar.hasIcon,
    });
  }

  out.sort((a, b) => {
    if (a.id === 'Default') return -1;
    if (b.id === 'Default') return 1;
    return a.id.localeCompare(b.id);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Detect environment (per browser)
// ---------------------------------------------------------------------------

/**
 * Detect one browser (Edge or Chrome) — mirrors browser_paths.rs detect_edge/detect_chrome.
 * 合并用户显式配置（~/.dsh/realbrowser-config.json）：自定义 exe 路径与自定义
 * 用户数据目录（如自建 RPA 环境）跨会话保留，检测时并入 suggested 目录与
 * cdp_environments；每个 profile 标注受限等级（对齐 GLBT profile-rules 三档）。
 * @param {'edge'|'chrome'} kind
 * @param {object} [opts] - { includeAvatars?: boolean, includeBase64?: boolean, userConfig?: object }
 */
export function detectBrowser(kind, opts = {}) {
  const def = BROWSER_DEFS[kind];
  if (!def) throw new Error(`unknown browser kind: ${kind}`);

  const reg = psRegistryAndDirs(def);
  const userCfg = opts.userConfig || { exePaths: {}, userDataDirs: {} };
  const userExe = typeof userCfg.exePaths?.[kind] === 'string' ? userCfg.exePaths[kind] : '';
  const userDirs = Array.isArray(userCfg.userDataDirs?.[kind]) ? userCfg.userDataDirs[kind] : [];

  const exePaths = [];
  const appPath = reg?.appPath;
  if (typeof appPath === 'string' && appPath && existsSync(appPath)) exePaths.push(appPath);
  for (const p of def.standardPaths) if (existsSync(p)) exePaths.push(p);
  if (userExe && existsSync(userExe)) exePaths.push(userExe);
  // dedup, sort
  const unique = [...new Set(exePaths)].sort();

  const installed = unique.length > 0;
  const defaultUserDataDir = def.defaultUserDataDir;

  // 用户自定义目录：规范化 + 去重；仅存在的目录纳入检测（不存在的在 UI 提示）
  const userDirsExisting = [...new Set(userDirs.map((d) => String(d).replace(/[\\/]+$/, '')))].filter((d) => d && existsSync(d));

  const userDataDirs = existsSync(defaultUserDataDir) ? [defaultUserDataDir] : [];
  const suggestedUserDataDirs = [
    ...(reg?.siblings ?? []),
    ...(reg?.rpaDirs ?? []),
    ...userDirsExisting,
  ].filter((d) => !userDataDirs.includes(d));

  // version: exe FileVersion preferred, registry fallback
  const browserVersion =
    (reg?.fileVersion || '') ||
    (Array.isArray(reg?.versions) && reg.versions.length > 0 ? reg.versions[0] : '');

  // 受限等级标注（对齐 GLBT profile-rules 三档，源自 2026-08-19 踩坑实测）：
  //   default_dir — 浏览器默认用户路径：完全受限，不可 CDP 自动化（只能走浏览器自身 UI）
  //   multi_user  — 同 user-data-dir 含多个用户：浏览器单实例锁（同目录同时只能开一个实例）→ 部分受限
  //   none        — 单用户目录：完全规范可用
  const annotate = (profiles, restriction) => profiles.map((p) => ({ ...p, restriction }));

  const profiles = installed
    ? annotate(readProfiles(defaultUserDataDir, kind === 'edge', opts.includeAvatars !== false), 'default_dir')
    : [];

  // Capability model (built-in platform knowledge, so callers/AI don't have to
  // rediscover it by trial and error):
  //  - the DEFAULT user-data-dir can never be debug-launched (Chrome/Edge refuse
  //    remote debugging on the default data directory)
  //  - non-default user-data-dirs (suggested dirs such as the RPA environments)
  //    CAN be debug-launched with `--remote-debugging-port`
  const cdpEnvironments = suggestedUserDataDirs
    .filter((d) => existsSync(d))
    .map((d) => {
      const ps = readProfiles(d, kind === 'edge', opts.includeAvatars !== false);
      const restriction = ps.length > 1 ? 'multi_user' : 'none';
      return {
        user_data_dir: d,
        cdp_supported: true,
        user_configured: userDirsExisting.includes(d),
        profiles: annotate(ps, restriction),
      };
    });

  return {
    browser_type: kind,
    browser_name: def.browserName,
    installed,
    exe_paths: unique,
    user_data_dirs: userDataDirs,
    default_user_data_dir: defaultUserDataDir,
    default_user_data_dir_cdp: false,
    default_user_data_dir_cdp_reason:
      'Chrome/Edge refuse remote debugging on the default data directory ("DevTools remote debugging requires a non-default data directory"); the default profile can only be driven via the browser\'s own UI, not CDP.',
    default_debug_port: 0,
    browser_version: browserVersion,
    suggested_user_data_dirs: suggestedUserDataDirs,
    profiles,
    cdp_environments: cdpEnvironments,
    children: [],
  };
}

/**
 * Detect the whole environment: Edge + Chrome (Ziniao comes later).
 * 合并 ~/.dsh/realbrowser-config.json 的用户显式配置。
 * @returns {Array} BrowserInfo-like objects for installed/present browsers.
 */
export { optimizeAvatars, isValidJpegBase64, isValidPngBase64 } from './env-avatars.js';

export function detectEnvironment(opts = {}) {
  const userConfig = opts.userConfig || readConfig();
  return [
    detectBrowser('edge', { ...opts, userConfig }),
    detectBrowser('chrome', { ...opts, userConfig }),
  ];
}
