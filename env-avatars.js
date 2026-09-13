/**
 * Avatar pipeline for environment detection — read (fallback chain) + optimize
 * (64px PNG content-hashed cache). Split from env.js so detection stays lean.
 *
 * readAvatarBase64 mirrors browser_avatar.rs fallback order; optimizeAvatars
 * shrinks large real profile pictures via scripts/avatar-resize.ps1 (zero npm
 * deps; failures degrade to the original avatar).
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { EDGE_PRESET_AVATARS } from './edge-avatars.js';

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
export function readAvatarBase64(profilePath, isEdge, userDataDir, info) {
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

// ---------------------------------------------------------------------------
// Avatar optimization — real profile pictures (Screenshots/*, "Profile
// Picture.png", Avatar dir…) can be 80–400KB each as base64, which bloats the
// RPC payload and UI rendering. Shrink anything larger than AVATAR_MIN_OPTIMIZE
// to a 64px PNG via scripts/avatar-resize.ps1 (System.Drawing — built into
// Windows PowerShell 5.1, zero npm deps). PNG keeps the alpha channel so
// transparent avatars stay transparent (JPEG would bake a black/white bg).
// Results are cached under ~/.dsh/cache/rb-avatars-v2/ (content-hashed);
// every failure degrades to the original avatar, so detection never breaks
// because of a resize hiccup.
// ---------------------------------------------------------------------------
// v2：09-09 的 avatar-resize 曾把二进制 JPEG 写进缓存（JS 端按 base64 文本读 → 乱码），
// 升级目录让坏缓存作废；读缓存一律过 isValidJpegBase64 魔数校验，坏数据永不复用。
const avatarCacheDir = path.join(os.homedir(), '.dsh', 'cache', 'rb-avatars-v2');
const AVATAR_MIN_OPTIMIZE = 24 * 1024; // base64 length: only touch > ~18KB images
const AVATAR_TARGET = 64;
const memAvatarCache = new Map(); // sha1(raw) -> small base64 data URL

function stripDataUrl(b64) {
  const s = String(b64 || '');
  if (!s.startsWith('data:image/')) return null;
  const idx = s.indexOf(';base64,');
  if (idx < 0) return null;
  // base64 可能含换行（preset/ico 常量里见过），去掉所有空白再解码
  const raw = s.slice(idx + 8).replace(/\s+/g, '');
  if (!raw) return null;
  const mime = s.slice(5, idx);
  const rawExt = mime.split('/')[1] || 'png';
  const ext = rawExt === 'x-icon' ? 'ico' : rawExt.replace('jpeg', 'jpg');
  return { raw, ext };
}

/**
 * True when `text` is base64 that decodes to a JPEG (magic FF D8 FF).
 * Guards the avatar resize cache/output so a corrupt write can never be
 * surfaced as an avatar (would render as 乱码 / broken image in the client).
 */
export function isValidJpegBase64(text) {
  if (typeof text !== 'string' || text.length < 4) return false;
  try {
    const buf = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  } catch {
    return false;
  }
}

/**
 * True when `text` is base64 that decodes to a PNG (magic 89 50 4E 47).
 * 压缩管线输出 PNG（保留 alpha 透明通道——透明头像不得被压成黑/白底），
 * 读缓存/输出时校验魔数，坏数据永不复用。
 */
export function isValidPngBase64(text) {
  if (typeof text !== 'string' || text.length < 4) return false;
  try {
    const buf = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    return buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  } catch {
    return false;
  }
}

/**
 * In-place: replace avatar_base64 of every large avatar with a 64px JPEG
 * (content-cached). Returns the same array for chaining.
 */
export function optimizeAvatars(browsers) {
  if (!Array.isArray(browsers)) return browsers;

  // 1) collect candidates (skip tiny / non-base64 avatars)
  //    遍历默认路径 profiles + cdp_environments 各目录 profiles
  const todo = [];
  const eachProfile = (fn) => {
    for (const b of browsers) {
      for (const p of (b.profiles || [])) fn(p);
      for (const c of (b.cdp_environments || [])) {
        for (const p of (c.profiles || [])) fn(p);
      }
    }
  };
  eachProfile((p) => {
    const b64 = String(p.avatar_base64 || '');
    if (!b64) return;
    const st = stripDataUrl(b64);
    if (!st) return;
    // image/x-icon 无条件转换：统一为 JPEG（GLBT 前端 img 也能直接显示 ico，
    // 但转 JPEG 可瘦身且格式统一）；其它格式只在超阈值时瘦身
    const isIcon = st.ext === 'ico';
    if (!isIcon && b64.length < AVATAR_MIN_OPTIMIZE) return;
    const hash = createHash('sha1').update(st.raw).digest('hex').slice(0, 24);
    todo.push({ p, hash, ext: st.ext });
  });
  if (todo.length === 0) return browsers;

  // 2) mem + disk cache hits
  let missing = [];
  try { mkdirSync(avatarCacheDir, { recursive: true }); } catch { /* best effort */ }
  for (const t of todo) {
    const mem = memAvatarCache.get(t.hash);
    if (mem) { t.p.avatar_base64 = mem; continue; }
    const jp = path.join(avatarCacheDir, `${t.hash}.${AVATAR_TARGET}px.png`);
    try {
      const small = readFileSync(jp, 'utf8');
      if (small && isValidPngBase64(small)) {
        const b64 = `data:image/png;base64,${small}`;
        t.p.avatar_base64 = b64;
        memAvatarCache.set(t.hash, b64);
        continue;
      }
    } catch { /* not cached */ }
    missing.push(t);
  }
  if (missing.length === 0) return browsers;

  // 3) batch resize via one PowerShell run
  const tmpDir = path.join(os.tmpdir(), `rb-av-${process.pid}-${Date.now()}`);
  try {
    const inDir = path.join(tmpDir, 'in');
    const outDir = path.join(tmpDir, 'out');
    mkdirSync(inDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    for (const t of missing) {
      const st = stripDataUrl(t.p.avatar_base64);
      if (!st) continue;
      try { writeFileSync(path.join(inDir, `${t.hash}.${st.ext}`), Buffer.from(st.raw, 'base64')); } catch { /* skip */ }
    }
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'avatar-resize.ps1');
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-InputDir', inDir, '-OutputDir', outDir, '-Size', String(AVATAR_TARGET)],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 },
    );
    for (const t of missing) {
      const jp = path.join(outDir, `${t.hash}.${AVATAR_TARGET}px.png`);
      try {
        const small = readFileSync(jp, 'utf8');
        if (small && isValidPngBase64(small)) {
          const b64 = `data:image/png;base64,${small}`;
          t.p.avatar_base64 = b64;
          memAvatarCache.set(t.hash, b64);
          try { writeFileSync(path.join(avatarCacheDir, `${t.hash}.${AVATAR_TARGET}px.png`), small); } catch { /* best effort */ }
        }
      } catch { /* keep original */ }
    }
  } catch (e) {
    // degrade: keep original avatars
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir leftover is harmless */ }
  }
  return browsers;
}
