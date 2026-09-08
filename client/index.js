/**
 * dsh-real-browser — Client 面 Cordis 插件（DSH web 界面）。
 *
 * 在「设置」里注册「浏览器设置」栏目（settings.section 槽位）：
 *   - 概览条：配置总数 / 已授权 / 运行中 + 凭证隔离 Work Mode + 刷新检测
 *   - 分段视图（不复刻 GLBT 布局）：
 *       「当前配置」= 授权边界（AI 能用什么）—— 分组卡片墙，点选/组选/⋮菜单
 *       「全局配置」= 环境资产（机器上有什么+怎么管理）—— 可折叠面板 + 内联编辑
 *   - URL 策略守卫（deny / requireApproval）区块
 * 数据经 host 侧 typert RPC（remote.realBrowser）获取；配置持久化到
 * ~/.dsh/realbrowser-config.json / realbrowser-allowlist.json / realbrowser-policy.json。
 *
 * 打包：`node build-client.mjs` → client.js（esbuild CJS bundle）。
 * 声明：package.json `dsh.client.platform: web` + exports["./client"]。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { TYPERT } from '../typert.js';
import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives';
import { keyOf, copyText, Toast, CommandModal } from './widgets.js';
import CurrentView from './current-view.js';
import GlobalView from './global-view.js';

export const name = 'real-browser-client';
export const inject = ['remote', 'slots'];

export async function apply(ctx) {
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

  // 开发环境标记：dev DSH（realbrowser-dev profile, 3090）把左上角 logo 染成橙色。
  const isDev = typeof window !== 'undefined' && window.location.port === '3090';
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
.rb-switch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; flex-shrink: 0; user-select: none; }
.rb-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.rb-switch .track { position: relative; width: 34px; height: 18px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover, #e5e9ef); transition: background .18s; display: inline-block; }
.rb-switch .thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .18s; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
.rb-switch input:checked + .track { background: var(--dsw-alias-state-success-primary); }
.rb-switch input:checked + .track .thumb { left: 18px; }
.rb-switch input:focus-visible + .track { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, #4c8bf5); }
.rb-card { transition: border-color .15s, box-shadow .15s, transform .08s; }
.rb-card:hover { border-color: var(--dsw-alias-border-l3); box-shadow: 0 3px 12px rgba(0,0,0,.09); transform: translateY(-1px); }
.rb-card--selected { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent) !important; box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }
.rb-card--restricted { opacity: .6; }
@keyframes rb-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
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
  const [view, setView] = useState('global');
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

  const allCount = groups.reduce((n, g) => n + g.profiles.length, 0);
  const allowedCount = groups.reduce((n, g) => n + g.profiles.filter((c) => allowedSet.has(keyOf(c))).length, 0);
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
          <button type="button" className="rb-btn" onClick={() => refresh(true)} disabled={loading} style={{ fontSize: 12, padding: '3px 10px' }}>
            {loading ? '检测中…' : '↻ 刷新检测'}
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
              onClick={() => setView(s.k)}
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
