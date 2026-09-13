/**
 * dsh-real-browser — Client 面 Cordis 插件（DSH web 界面）。
 *
 * 在「设置」里注册「浏览器设置」栏目（settings.section 槽位）：
 *   - 概览条：配置总数 / 已授权 / 运行中 + 刷新检测
 *   - 分段视图（不复刻 GLBT 布局）：
 *       「当前配置」= 授权边界（AI 能用什么）—— 分组卡片墙，点选/组选/⋮菜单
 *       「全局配置」= 环境资产（机器上有什么+怎么管理）—— 可折叠面板 + 内联编辑
 * ⚠️ 刻意不在设置页提供：凭证隔离 Work Mode、URL 策略守卫（deny/requireApproval）——
 *    两个功能的 AI 工具（real_browser_work_mode / real_browser_policy）与 host RPC 保留，
 *    但设置页 UI 曾于 d95f8d4 有意移除（commit message：「移除凭证隔离/URL 策略守卫区块
 *    （AI 工具保留）」）。不要因下方 api 里有 getWorkMode/setWorkMode/getPolicy 等就补 UI。
 * 数据经 host 侧 typert RPC（remote.realBrowser）获取；配置持久化到
 * ~/.dsh/realbrowser-config.json / realbrowser-allowlist.json / realbrowser-policy.json。
 *
 * 打包：`node build-client.mjs` → client.js（esbuild CJS bundle）。
 * 声明：package.json `dsh.client.platform: web` + exports["./client"]。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { TYPERT } from '../typert.js';
import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives';
import { keyOf, copyText, Toast, CommandModal, RefreshIcon } from './widgets.js';
import CurrentView from './current-view.js';
import GlobalView from './global-view.js';

export const name = 'real-browser-client';
export const inject = ['remote', 'slots'];

export async function apply(ctx) {
  // 开发环境标记：仅 dev DSH（realbrowser-dev profile, 3090）时生效，主环境(3080)不显示。
  // 左上角 logo 染成橙色 + 浏览器标签页 favicon 换成同色鲸鱼，两个环境一眼可区分。
  const isDev = typeof window !== 'undefined' && window.location.port === '3090';
  if (isDev) applyDevFavicon();

  const remote = ctx.remote;
  const slots = ctx.get('slots');
  if (!remote || typeof remote.$mount !== 'function' || !slots) {
    console.warn('[dsh-real-browser] client prerequisites missing (remote/slots)');
    return;
  }

  // $mount expects a TypertRemoteContribution: { package, descriptors }.
  const contribution = { package: TYPERT.package, descriptors: TYPERT.invocations };
  try {
    await remote.$mount(contribution);
  } catch (e) {
    console.warn('[dsh-real-browser] $mount failed:', e);
    return;
  }
  const rb = ctx.get('remote.realBrowser');
  if (!rb) {
    console.warn('[dsh-real-browser] remote.realBrowser unavailable');
    return;
  }

  // Gateway envelope is { ok, value } on success and { ok:false, error } on
  // failure — treat non-ok as an error.
  const call = async (method, ...args) => {
    const r = await rb[method](...args);
    if (r && typeof r === 'object' && 'ok' in r) {
      if (r.ok !== true) {
        const msg = r.error && (r.error.message || r.error.description) ? (r.error.message || r.error.description) : JSON.stringify(r.error || r);
        throw new Error(`${method} failed: ${msg}`);
      }
      return r.value;
    }
    return r;
  };

  const api = {
    detectEnv: (includeAvatars, force) => call('detectEnv', Boolean(includeAvatars), Boolean(force)),
    listRunning: () => call('listRunning'),
    getAllowlist: () => call('getAllowlist'),
    setAllowed: (cfg) => call('setAllowed', cfg.kind, cfg.userDataDir, cfg.profileId ?? '', Boolean(cfg.allowed)),
    // 以下 5 个 RPC 刻意保留但**不提供设置页 UI**（d95f8d4 有意移除 UI，AI 工具保留）：
    // getWorkMode/setWorkMode = 凭证隔离 Work Mode（AI 工具 real_browser_work_mode）
    // getPolicy/policyAdd/policyRemove = URL 策略守卫（AI 工具 real_browser_policy）
    // 不要因为这里存在就补 UI——见文件头部 ⚠️ 注释。
    getPolicy: () => call('getPolicy'),
    policyAdd: (kind, pattern) => call('policyAdd', kind, pattern),
    policyRemove: (kind, pattern) => call('policyRemove', kind, pattern),
    getWorkMode: () => call('getWorkMode'),
    setWorkMode: (enabled) => call('setWorkMode', Boolean(enabled)),
    getConfig: () => call('getConfig'),
    setConfig: (exePaths, userDataDirs) => call('setConfig', exePaths ?? null, userDataDirs ?? null),
    getLaunchCommand: (o) => call('getLaunchCommand', o.exePath, o.userDataDir, o.profileId ?? '', o.port ?? 0),
    createUserDataDir: (o) => call('createUserDataDir', o.kind, o.parentDir, o.dirName),
    createShortcut: (o) => call('createShortcut', o.kind, o.exePath, o.profileId ?? '', o.userDataDir, o.profileName, o.port ?? 0),
    closeProfile: (o) => call('closeProfile', o.kind, o.userDataDir, o.profileId ?? ''),
    killAll: (kind) => call('killAll', kind),
    launch: (o) => call('launch', o.exePath, o.userDataDir, o.profileId ?? '', o.port ?? 0, o.url ?? '', o.headless ?? false, o.force ?? false),
  };

  ctx.slots.inject(
    'settings.section',
    () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'real-browser',
          order: 40,
          label: '浏览器设置',
          inject: () => ({ api }),
        },
        BrowserSettings,
      ),
  );

  // 开发环境标记：dev DSH 把左上角 logo 染成橙色（favicon 切换见 apply 开头）。
  if (isDev) {
    ctx.slots.inject('sidebar.brand.mark', () =>
      ctx.slots.register(
        { name: 'sidebar.brand.mark', id: 'real-browser-dev-mark', order: -1000 },
        DevBrandMark,
      ),
    );
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.register(
        { name: 'sidebar.brand.name', id: 'real-browser-dev-name', order: -1000 },
        DevBrandName,
      ),
    );
  }
}

function DevBrandMark({ size }) {
  return (
    <span style={{ color: '#f97316', display: 'inline-flex' }}>
      <FishLogo size={size} />
    </span>
  );
}

function DevBrandName() {
  return <BrandWordmark includeMark={false} />;
}

// dev 环境专用橙色鲸鱼 favicon：与主环境默认黑白图标区分（颜色与左上角 logo 一致 #f97316）。
const ORANGE_FAVICON_PATH = 'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z';
const ORANGE_FAVICON =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50" fill="none"><path d="' +
      ORANGE_FAVICON_PATH +
      '" fill="#f97316" fill-rule="nonzero"/></svg>',
  );

function applyDevFavicon() {
  const link =
    document.querySelector('link[rel="icon"]') || document.createElement('link');
  if (!link.parentNode) {
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = ORANGE_FAVICON;
}

// 少量 hover / 动效依赖类选择器（inline style 不支持 :hover）
const UI_CSS = `
.rb-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform, #fff); color: var(--dsw-alias-label-secondary); border-radius: 6px; cursor: pointer; transition: border-color .15s, background .15s, color .15s; }
.rb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover); }
.rb-btn:disabled { opacity: .55; cursor: default; }
.rb-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform, #fff); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 5px 8px; font-size: 12.5px; outline: none; }
.rb-input:focus { border-color: var(--dsw-alias-brand-primary, #4c8bf5); }
.rb-link-btn { border: none; background: none; color: var(--dsw-alias-label-secondary); font-size: 11.5px; cursor: pointer; padding: 2px 5px; border-radius: 5px; }
.rb-link-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.rb-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rb-profile-row { transition: background .15s ease; }
.rb-profile-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rb-profile-row:hover .rb-link-btn { color: var(--dsw-alias-label-primary); }
.rb-switch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; flex-shrink: 0; user-select: none; }
.rb-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.rb-switch .track { position: relative; width: 34px; height: 18px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover, #e5e9ef); transition: background .18s; display: inline-block; }
.rb-switch .thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .18s; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
.rb-switch input:checked + .track { background: var(--dsw-alias-state-success-primary); }
.rb-switch input:checked + .track .thumb { left: 18px; }
.rb-switch input:focus-visible + .track { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, #4c8bf5); }
.rb-card { transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease, opacity .18s ease, background .18s ease; background: var(--dsw-alias-bg-module-platform, #fff); }
.rb-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); box-shadow: 0 6px 18px rgba(0,0,0,.16); }
.rb-card:hover .rb-card-avatar { transform: scale(1.05); }
.rb-card-avatar { transition: transform .18s ease; }
.rb-card--running { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, transparent); }
.rb-card--selected { border-color: var(--dsw-alias-brand-primary) !important; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); box-shadow: 0 0 0 1.5px var(--dsw-alias-brand-primary); }
.rb-card--restricted { opacity: .55; }
.rb-card--restricted:hover { transform: none; box-shadow: none; }
`;

/** 转换 detectEnv 原始输出 → 视图统一的 group 结构（含受限等级 / 自定义目录标注）。 */
export function buildGroups(browsersRaw) {
  const mkCfg = (b, p, userDataDir, cdp, userConfigured) => ({
    kind: b.browser_type,
    browserName: b.browser_name,
    version: b.browser_version,
    userDataDir,
    cdp,
    userConfigured: !!userConfigured,
    exePath: (b.exe_paths && b.exe_paths[0]) || '',
    profileId: p.id,
    profileName: p.name,
    user_name: p.user_name,
    email: p.email,
    path: p.path,
    download_dir: p.download_dir,
    avatar: p.avatar_base64 || '',
    restriction: p.restriction || (cdp ? 'none' : 'default_dir'),
  });
  return (browsersRaw || []).map((b) => {
    const blocks = [];
    if (b.installed && (b.profiles || []).length) {
      blocks.push({
        userDataDir: b.default_user_data_dir,
        cdp: false,
        userConfigured: false,
        profiles: (b.profiles || []).map((p) => mkCfg(b, p, b.default_user_data_dir, false, false)),
      });
    }
    for (const env of b.cdp_environments || []) {
      const ps = (env.profiles || []).map((p) => mkCfg(b, p, env.user_data_dir, true, env.user_configured));
      if (ps.length) blocks.push({ userDataDir: env.user_data_dir, cdp: true, userConfigured: !!env.user_configured, profiles: ps });
    }
    return {
      kind: b.browser_type,
      browserName: b.browser_name,
      version: b.browser_version,
      installed: b.installed,
      exePaths: b.exe_paths || [],
      defaultUserDataDir: b.default_user_data_dir,
      blocks,
      profiles: blocks.flatMap((bl) => bl.profiles),
    };
  });
}

/** localStorage 检测缓存：打开设置页首帧立即渲染上次结果（后台刷新覆盖），消除转圈等待。 */
const ENV_CACHE_KEY = 'rb-env-cache-v2'; // v2：头像均为优化后小图，且 ProfileAvatar 不再做 mime 白名单
function loadEnvCache() {
  try {
    const raw = localStorage.getItem(ENV_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.browsers) ? parsed.browsers : [];
  } catch { return []; }
}
function saveEnvCache(browsers) {
  try { localStorage.setItem(ENV_CACHE_KEY, JSON.stringify({ at: Date.now(), browsers })); } catch { /* quota/best effort */ }
}

function BrowserSettings({ api }) {
  const [rawBrowsers, setRawBrowsers] = useState(loadEnvCache);
  const [allowlist, setAllowlist] = useState({ environments: [] });
  const [running, setRunning] = useState([]);
  const [config, setConfig] = useState({ exePaths: {}, userDataDirs: {} });
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('rb-view') === 'current' ? 'current' : 'global'; } catch { return 'global'; }
  });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [toast, setToast] = useState(null);
  const [cmdModal, setCmdModal] = useState(null);

  const showToast = useCallback((text, tone = 'ok') => setToast({ text, tone }), []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    setErr(null);
    try {
      const [d, al, r, cfg] = await Promise.all([
        api.detectEnv(true, force),
        api.getAllowlist(),
        api.listRunning(),
        api.getConfig(),
      ]);
      setRawBrowsers((d && d.browsers) || []);
      if (d && d.browsers) saveEnvCache(d.browsers);
      setAllowlist((al && al.environments) ? { environments: al.environments } : { environments: [] });
      setRunning((r && r.instances) || []);
      setConfig((cfg && { exePaths: cfg.exePaths || {}, userDataDirs: cfg.userDataDirs || {} }) || { exePaths: {}, userDataDirs: {} });
    } catch (e) {
      setErr(String((e && e.message) || e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  // 运行实例轮询（5s）：仅更新 running，不打扰其它状态
  useEffect(() => {
    const t = setInterval(() => {
      api.listRunning().then((r) => setRunning((r && r.instances) || [])).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [api]);

  const groups = useMemo(() => buildGroups(rawBrowsers), [rawBrowsers]);
  const allowedSet = useMemo(
    () => new Set((allowlist.environments || []).map((e) => keyOf(e))),
    [allowlist],
  );
  // 运行实例 → per-profile 端口（Map<key,{port}>）；cfg 查精确 key，fallback 同目录无 profile 标识
  const [runningMap, setRunningMap] = useState(new Map());
  useEffect(() => {
    const m = new Map();
    for (const i of running) {
      m.set(`${i.kind}\u0000${i.userDataDir || ''}\u0000${i.profileId || ''}`, { port: i.port });
    }
    setRunningMap(m);
  }, [running]);
  const runningOf = useCallback(
    (cfg) => runningMap.get(keyOf(cfg)) || runningMap.get(`${cfg.kind}\u0000${cfg.userDataDir}\u0000`),
    [runningMap],
  );

  const allCount = groups.reduce((n, g) => n + g.profiles.filter((c) => c.restriction !== 'default_dir').length, 0);
  const allowedCount = groups.reduce((n, g) => n + g.profiles.filter((c) => c.restriction !== 'default_dir' && allowedSet.has(keyOf(c))).length, 0);
  const runningCount = groups.reduce((n, g) => n + g.profiles.filter((c) => runningOf(c)).length, 0);

  const toggle = useCallback(async (cfg) => {
    const next = !allowedSet.has(keyOf(cfg));
    setErr(null);
    try {
      await api.setAllowed({ ...cfg, allowed: next });
      const al = await api.getAllowlist();
      setAllowlist({ environments: (al && al.environments) || [] });
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, allowedSet]);

  const toggleGroup = useCallback(async (kind, selectables, checked) => {
    setErr(null);
    try {
      await Promise.all(selectables.map((c) => api.setAllowed({ ...c, allowed: checked })));
      const al = await api.getAllowlist();
      setAllowlist({ environments: (al && al.environments) || [] });
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api]);

  // ── 卡片 ⋮ 菜单动作 ──
  const onMenu = useCallback(async (action, cfg) => {
    setErr(null);
    try {
      if (action === 'launch') {
        const res = await api.launch({ exePath: cfg.exePath, userDataDir: cfg.userDataDir, profileId: cfg.profileId, port: 0, url: '', headless: false, force: false });
        showToast(res && res.attached ? `已接管运行中的浏览器（端口 ${res.port}）` : `已启动（PID ${res.pid || '-'}，端口 ${res.port}）`);
        refresh();
      } else if (action === 'command') {
        const info = await api.getLaunchCommand({ exePath: cfg.exePath, userDataDir: cfg.userDataDir, profileId: cfg.profileId, port: 0 });
        setCmdModal(info);
      } else if (action === 'shortcut') {
        const r = await api.createShortcut({ kind: cfg.kind, exePath: cfg.exePath, profileId: cfg.profileId, userDataDir: cfg.userDataDir, profileName: cfg.profileName || cfg.profileId, port: 0 });
        showToast(r.overwritten ? `已覆盖桌面快捷方式: ${r.shortcut_path}` : `已创建桌面快捷方式: ${r.shortcut_path}`);
      } else if (action === 'close') {
        const r = await api.closeProfile(cfg);
        showToast(`已关闭 ${r.killed} 个进程`, r.killed > 0 ? 'ok' : 'warn');
        refresh();
      } else if (action === 'killAll') {
        const r = await api.killAll(cfg.kind);
        showToast(`已终止全部 ${cfg.kind === 'chrome' ? 'Chrome' : 'Edge'} 进程（${r.killed} 个主进程）`);
        refresh();
      }
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, refresh, showToast]);

  // ── 全局配置动作 ──
  const onSetExe = useCallback(async (kind, exePath) => {
    try {
      const cfg = await api.setConfig({ [kind]: exePath }, null);
      setConfig({ exePaths: cfg.exePaths || {}, userDataDirs: cfg.userDataDirs || {} });
      showToast(`已保存 ${kind} 的 exe 路径`);
      refresh();
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, refresh, showToast]);

  const onAddDir = useCallback(async (kind, dir) => {
    try {
      const list = [...(config.userDataDirs[kind] || []).filter((d) => d !== dir), dir];
      const cfg = await api.setConfig(null, { [kind]: list });
      setConfig({ exePaths: cfg.exePaths || {}, userDataDirs: cfg.userDataDirs || {} });
      showToast(`已添加自定义目录: ${dir}`);
      refresh();
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, config, refresh, showToast]);

  const onCreateDir = useCallback(async (kind, parent, name) => {
    try {
      const r = await api.createUserDataDir({ kind, parentDir: parent, dirName: name });
      // 自动加入自定义目录配置，保证检测/授权可见
      const path = r.path;
      const list = [...(config.userDataDirs[kind] || []).filter((d) => d !== path), path];
      await api.setConfig(null, { [kind]: list });
      setConfig({ exePaths: (await api.getConfig()).exePaths || {}, userDataDirs: (await api.getConfig()).userDataDirs || {} });
      showToast(r.existed ? `目录已存在并加入配置: ${path}` : `已创建用户数据目录: ${path}`);
      refresh();
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, config, refresh, showToast]);

  const onRemoveDir = useCallback(async (kind, dir) => {
    try {
      const list = (config.userDataDirs[kind] || []).filter((d) => d !== dir);
      const cfg = await api.setConfig(null, { [kind]: list });
      setConfig({ exePaths: cfg.exePaths || {}, userDataDirs: cfg.userDataDirs || {} });
      showToast(`已移除自定义目录: ${dir}`);
      refresh();
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, config, refresh, showToast]);

  return (
    <>
      <style>{UI_CSS}</style>
      <div style={{ padding: '4px 0' }}>
        {/* 概览条 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>浏览器配置</strong>
          <button type="button" className="rb-btn" onClick={() => refresh(true)} disabled={loading} style={{ fontSize: 12, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {loading ? '检测中…' : <><RefreshIcon size={12} />刷新检测</>}
          </button>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            已授权 <b style={{ color: allowedCount === allCount && allCount > 0 ? 'var(--dsw-alias-state-success-primary)' : 'inherit' }}>{allowedCount}</b>/{allCount} 个配置
            {runningCount ? ` · 运行 ${runningCount}` : ''}
          </span>
        </div>

        {/* 分段切换 */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {[
            { k: 'global', label: '全局浏览器配置' },
            { k: 'current', label: '当前浏览器配置' },
          ].map((s) => (
            <button
              key={s.k}
              type="button"
              onClick={() => { setView(s.k); try { localStorage.setItem('rb-view', s.k); } catch {} }}
              style={{
                fontSize: 12.5, padding: '5px 14px', borderRadius: 999, cursor: 'pointer',
                border: view === s.k ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
                background: view === s.k ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)' : 'var(--dsw-alias-bg-module-platform, #fff)',
                color: view === s.k ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                fontWeight: view === s.k ? 600 : 400,
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {err && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)', borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>错误: {err}</p>}
        {allCount === 0 && !err && <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, marginBottom: 10 }}>加载中…</p>}

        {view === 'current' ? (
          <CurrentView groups={groups} allowedSet={allowedSet} runningMap={runningMap} onToggle={toggle} onToggleGroup={toggleGroup} onMenu={onMenu} onToast={showToast} />
        ) : (
          <GlobalView
            groups={groups}
            config={config}
            runningMap={runningMap}
            onSetExe={onSetExe}
            onAddDir={onAddDir}
            onRemoveDir={onRemoveDir}
            onCreateDir={onCreateDir}
            onAction={onMenu}
            onToast={showToast}
          />
        )}
      </div>
      {cmdModal && <CommandModal info={cmdModal} onClose={() => setCmdModal(null)} onCopy={() => copyText(cmdModal.command_line).then((ok) => showToast(ok ? '已复制启动命令' : '复制失败', ok ? 'ok' : 'error'))} />}
      <Toast text={toast ? toast.text : null} tone={toast ? toast.tone : 'ok'} />
    </>
  );
}

// ── 供测试/复用导出 ──
export { BrowserSettings };
