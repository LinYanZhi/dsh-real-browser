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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EDGE_PRESET_AVATARS } from './edge-avatars.js';

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

/** base64 data URL; >=200KB payloads are dropped (flag set) to keep tool output lean. */
function toAvatarBase64(bytes, mime) {
  if (bytes.length >= 200 * 1024) return { base64: '', tooLarge: true };
  return { base64: `data:${mime};base64,${bytes.toString('base64')}`, tooLarge: false };
}

/** Recursively find the first `data:image/...` string in a JSON value. */
function findImageDataUrl(value) {
  if (typeof value === 'string') {
    return value.startsWith('data:image/') && value.length > 0 ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findImageDataUrl(v);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const hit = findImageDataUrl(v);
      if (hit) return hit;
    }
  }
  return undefined;
}

const AVATAR_INDEX_FILES = [
  // 0-25 old avatars
  'avatar_generic.png','avatar_generic_aqua.png','avatar_generic_blue.png','avatar_generic_green.png',
  'avatar_generic_orange.png','avatar_generic_purple.png','avatar_generic_red.png','avatar_generic_yellow.png',
  'avatar_secret_agent.png','avatar_superhero.png','avatar_volley_ball.png','avatar_businessman.png',
  'avatar_ninja.png','avatar_alien.png','avatar_awesome.png','avatar_flower.png','avatar_pizza.png',
  'avatar_soccer.png','avatar_burger.png','avatar_cat.png','avatar_cupcake.png','avatar_dog.png',
  'avatar_horse.png','avatar_margarita.png','avatar_note.png','avatar_sun_cloud.png',
  // 26 placeholder
  '',
  // 27-55 modern avatars
  'avatar_origami_cat.png','avatar_origami_corgi.png','avatar_origami_dragon.png','avatar_origami_elephant.png',
  'avatar_origami_fox.png','avatar_origami_monkey.png','avatar_origami_panda.png','avatar_origami_penguin.png',
  'avatar_origami_pinkbutterfly.png','avatar_origami_rabbit.png','avatar_origami_unicorn.png',
  'avatar_illustration_basketball.png','avatar_illustration_bike.png','avatar_illustration_bird.png',
  'avatar_illustration_cheese.png','avatar_illustration_football.png','avatar_illustration_ramen.png',
  'avatar_illustration_sunglasses.png','avatar_illustration_sushi.png','avatar_illustration_tamagotchi.png',
  'avatar_illustration_vinyl.png','avatar_abstract_avocado.png','avatar_abstract_cappuccino.png',
  'avatar_abstract_icecream.png','avatar_abstract_icewater.png','avatar_abstract_melon.png',
  'avatar_abstract_onigiri.png','avatar_abstract_pizza.png','avatar_abstract_sandwich.png',
];

function mimeFor(ext) {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'ico') return 'image/x-icon';
  return 'image/png';
}

function readFileBytes(p) {
  try {
    return readFileSync(p);
  } catch {
    return undefined;
  }
}

/** Avatar fallback chain (mirrors browser_avatar.rs). Returns {base64, hasIcon}. */
function readAvatarBase64(profilePath, isEdge, userDataDir, info) {
  const attempt = (bytes, mime, isIcon) => {
    if (!bytes || bytes.length === 0) return null;
    const enc = toAvatarBase64(bytes, mime);
    return { base64: enc.base64, hasIcon: isIcon, tooLarge: enc.tooLarge };
  };

  // 1. Screenshots dir (png/jpg/jpeg)
  const shots = path.join(profilePath, 'Screenshots');
  if (existsSync(shots)) {
    for (const f of readdirSync(shots)) {
      const ext = path.extname(f).toLowerCase().slice(1);
      if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') {
        const hit = attempt(readFileBytes(path.join(shots, f)), mimeFor(ext), false);
        if (hit) return hit;
      }
    }
  }

  // 2. Google/Edge Profile Picture.png etc.
  for (const name of ['Google Profile Picture.png', 'Edge Profile Picture.png', 'Profile Picture.png', 'avatar.jpg', 'avatar.png']) {
    const p = path.join(profilePath, name);
    if (existsSync(p)) {
      const ext = path.extname(p).toLowerCase().slice(1) || 'png';
      const hit = attempt(readFileBytes(p), mimeFor(ext), false);
      if (hit) return hit;
    }
  }

  // 3. ico icons
  for (const name of ['Edge Profile.ico', 'Google Profile.ico', 'Profile.ico', 'avatar.ico']) {
    const p = path.join(profilePath, name);
    if (existsSync(p)) {
      const hit = attempt(readFileBytes(p), 'image/x-icon', true);
      if (hit) return hit;
    }
  }

  // 4. Avatar dir
  const avatarDir = path.join(profilePath, 'Avatar');
  if (existsSync(avatarDir)) {
    for (const f of readdirSync(avatarDir)) {
      const ext = path.extname(f).toLowerCase().slice(1);
      if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') {
        const hit = attempt(readFileBytes(path.join(avatarDir, f)), mimeFor(ext), false);
        if (hit) return hit;
      }
    }
  }

  // 5. Preferences: data:image + gaia_info_picture_url
  const prefsPath = path.join(profilePath, 'Preferences');
  let prefs = null;
  if (existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
    } catch {
      prefs = null;
    }
  }
  if (prefs) {
    const pic = findImageDataUrl(prefs);
    if (pic) return { base64: pic, hasIcon: false };
    const gaia = prefs?.profile?.gaia_info_picture_url;
    if (typeof gaia === 'string' && (gaia.startsWith('http://') || gaia.startsWith('https://'))) {
      return { base64: gaia, hasIcon: false };
    }
  }

  // 6. Edge root-level Avatars / Profile Avatars / GAIAPicture dirs
  if (isEdge && userDataDir) {
    for (const dirName of ['Avatars', 'Profile Avatars', 'GAIAPicture']) {
      const dir = path.join(userDataDir, dirName);
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          const ext = path.extname(f).toLowerCase().slice(1);
          if (ext === 'png' || ext === 'jpg' || ext === 'webp' || ext === 'ico') {
            const hit = attempt(readFileBytes(path.join(dir, f)), mimeFor(ext), ext === 'ico');
            if (hit) return hit;
          }
        }
      }
    }
  }

  // 7. info_cache: data:image / avatar_icon http(s) / IDR_PROFILE_AVATAR_N
  if (info) {
    const pic = findImageDataUrl(info);
    if (pic) return { base64: pic, hasIcon: false };
    const iconUrl = info.avatar_icon;
    if (typeof iconUrl === 'string' && (iconUrl.startsWith('http://') || iconUrl.startsWith('https://'))) {
      return { base64: iconUrl, hasIcon: false };
    }
    if (typeof iconUrl === 'string' && iconUrl.includes('IDR_PROFILE_AVATAR_')) {
      const n = Number(iconUrl.slice(iconUrl.indexOf('IDR_PROFILE_AVATAR_') + 'IDR_PROFILE_AVATAR_'.length));
      // Chrome 路径：新版 Chrome/Edge(151+) 会把"使用过的"预设头像缓存到
      // {User Data}\Avatars\{文件名}（Chromium 的 index->文件名映射）。
      const fname = AVATAR_INDEX_FILES[n];
      if (fname) {
        const cached = readFileBytes(path.join(userDataDir, 'Avatars', fname));
        if (cached) return attempt(cached, 'image/png', false);
      }
      // Edge 路径：Edge 预设头像没有 {User Data}\Avatars 缓存目录，头像图片只存在
      // Edge 二进制的 .pak 资源里（按需合成）——本地文件系统找不到，只能内嵌资源。
      // Edge 的 index 语义与 Chromium 不同（如 Edge 21=狗/22=猫/24=刺猬/25=宇航员…），
      // 见 edge-avatars.js（提取自 GLBT app-kit edge_avatars.rs，来源 Edge 设置页头像选择器）。
      if (isEdge) {
        const b64 = EDGE_PRESET_AVATARS[n];
        if (b64) return attempt(Buffer.from(b64, 'base64'), 'image/png', false);
      }
    }
  }

  return { base64: '', hasIcon: false };
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
 * @param {'edge'|'chrome'} kind
 * @param {object} [opts] - { includeAvatars?: boolean, includeBase64?: boolean }
 */
export function detectBrowser(kind, opts = {}) {
  const def = BROWSER_DEFS[kind];
  if (!def) throw new Error(`unknown browser kind: ${kind}`);

  const reg = psRegistryAndDirs(def);

  const exePaths = [];
  const appPath = reg?.appPath;
  if (typeof appPath === 'string' && appPath && existsSync(appPath)) exePaths.push(appPath);
  for (const p of def.standardPaths) if (existsSync(p)) exePaths.push(p);
  // dedup, sort
  const unique = [...new Set(exePaths)].sort();

  const installed = unique.length > 0;
  const defaultUserDataDir = def.defaultUserDataDir;
  const userDataDirs = existsSync(defaultUserDataDir) ? [defaultUserDataDir] : [];
  const suggestedUserDataDirs = [...(reg?.siblings ?? []), ...(reg?.rpaDirs ?? [])];

  // version: exe FileVersion preferred, registry fallback
  const browserVersion =
    (reg?.fileVersion || '') ||
    (Array.isArray(reg?.versions) && reg.versions.length > 0 ? reg.versions[0] : '');

  const profiles = installed
    ? readProfiles(defaultUserDataDir, kind === 'edge', opts.includeAvatars !== false)
    : [];

  // Capability model (built-in platform knowledge, so callers/AI don't have to
  // rediscover it by trial and error):
  //  - the DEFAULT user-data-dir can never be debug-launched (Chrome/Edge refuse
  //    remote debugging on the default data directory)
  //  - non-default user-data-dirs (suggested dirs such as the RPA environments)
  //    CAN be debug-launched with `--remote-debugging-port`
  const cdpEnvironments = suggestedUserDataDirs
    .filter((d) => existsSync(d))
    .map((d) => ({
      user_data_dir: d,
      cdp_supported: true,
      profiles: readProfiles(d, kind === 'edge', opts.includeAvatars !== false),
    }));

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
 * @returns {Array} BrowserInfo-like objects for installed/present browsers.
 */
export function detectEnvironment(opts = {}) {
  return [
    detectBrowser('edge', opts),
    detectBrowser('chrome', opts),
  ];
}
