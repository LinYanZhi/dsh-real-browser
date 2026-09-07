/**
 * dsh-real-browser — Client 面 Cordis 插件（DSH web 界面）。
 *
 * 在「设置」里注册「浏览器设置」栏目（settings.section 槽位）：
 * 显示已装浏览器 / 可 CDP 驱动的环境（RPA 子账号）/ 运行实例，
 * 数据经 host 侧 typert RPC（remote.realBrowser）获取。
 *
 * 打包：`node build-client.mjs` → client.js（esbuild CJS bundle）。
 * 声明：package.json `dsh.client.platform: web` + exports["./client"]。
 */

import React, { useState, useEffect, useCallback } from 'react';
import { TYPERT } from '../typert.js';
import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives';
import { EDGE_LOGO, CHROME_LOGO } from './icons.js';

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
  // Reuse the host TYPERT manifest invocations — they ARE the wire contract.
  const contribution = { package: TYPERT.package, descriptors: TYPERT.invocations };
  try {
    await remote.$mount(contribution);
    console.log('[dsh-real-browser] mounted remote contribution:', contribution.package);
  } catch (e) {
    console.warn('[dsh-real-browser] $mount failed:', e);
    return;
  }
  const rb = ctx.get('remote.realBrowser');
  if (!rb) {
    console.warn('[dsh-real-browser] remote.realBrowser unavailable — typert manifest not wired on host?');
    return;
  }
  console.log('[dsh-real-browser] remote.realBrowser ready');

  // Gateway envelope is { ok, value } on success and { ok:false, error } on
  // failure — treat non-ok as an error (throwing surfaces the real message in
  // the panel instead of silently staying on "loading").
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
    detectEnv: (includeAvatars) => call('detectEnv', Boolean(includeAvatars)),
    listRunning: () => call('listRunning'),
    getAllowlist: () => call('getAllowlist'),
    setAllowed: (cfg) => call('setAllowed', cfg.kind, cfg.userDataDir, cfg.profileId, Boolean(cfg.allowed)),
    getPolicy: () => call('getPolicy'),
    policyAdd: (kind, pattern) => call('policyAdd', kind, pattern),
    policyRemove: (kind, pattern) => call('policyRemove', kind, pattern),
    getWorkMode: () => call('getWorkMode'),
    setWorkMode: (enabled) => call('setWorkMode', Boolean(enabled)),
  };

  ctx.slots.inject(
    'settings.section',
    () => {
      console.log('[dsh-real-browser] registering settings.section (浏览器设置)');
      return ctx.slots.register(
        {
          name: 'settings.section',
          id: 'real-browser',
          order: 40,
          label: '浏览器设置',
          inject: () => ({ api }),
        },
        BrowserSettings,
      );
    },
  );

  // 开发环境标记：仅在 dev DSH（realbrowser-dev profile, 端口 3090）时生效。
  // 不显示「开发测试」文字徽标，改为把左上角 dsh logo 染成橙色，便于与主环境区分。
  // 主环境(3080)不显示。
  const isDev = typeof window !== 'undefined' && window.location.port === '3090';
  if (isDev) {
    console.log('[dsh-real-browser] dev environment detected — orange brand mark');
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
  // FishLogo 用 currentColor 填充：外层 span 设橙色即可把左上角 logo 染成橙色。
  return (
    <span style={{ color: '#f97316', display: 'inline-flex' }}>
      <FishLogo size={size} />
    </span>
  );
}

function DevBrandName() {
  return <BrandWordmark includeMark={false} />;
}

// ── 品牌识别：Edge / Chrome ──────────────────────────────────────────────
const brandOf = (kind) => (kind === 'chrome' ? '#4285f4' : '#0078d4');

/** Edge / Chrome 官方品牌 logo（内嵌 data URI，与 GLBT app-icons 同款）。 */
function BrowserIcon({ kind, size = 32 }) {
  const src = kind === 'chrome' ? CHROME_LOGO : EDGE_LOGO;
  const label = kind === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
  return (
    <img
      src={src}
      alt={label}
      title={label}
      draggable={false}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

// 少量 hover / 动效依赖类选择器（inline style 不支持 :hover）
const UI_CSS = `
.rb-card { transition: border-color .15s, box-shadow .15s; }
.rb-card:hover { border-color: var(--dsw-alias-border-l3, #d0d7de); box-shadow: 0 2px 10px rgba(0,0,0,.07); }
.rb-switch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; flex-shrink: 0; user-select: none; }
.rb-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.rb-switch .track { position: relative; width: 34px; height: 18px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover, #e5e9ef); transition: background .18s; display: inline-block; }
.rb-switch .thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .18s; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
.rb-switch input:checked + .track { background: #2da44e; }
.rb-switch input:checked + .track .thumb { left: 18px; }
.rb-switch input:focus-visible + .track { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, #4c8bf5); }
.rb-chip-x { border: none; background: none; cursor: pointer; padding: 0; line-height: 1; }
.rb-chip-x:hover { opacity: .7; }
`;

function BrowserSettings({ api }) {
  const [browsers, setBrowsers] = useState([]); // 按浏览器分组：{kind, name, version, installed, groups:[{userDataDir, cdp, dirLabel, profiles:[cfg]}]}
  const [allowedMap, setAllowedMap] = useState({});
  const [running, setRunning] = useState([]);
  const [policy, setPolicy] = useState({ deny: [], requireApproval: [] });
  const [sensitive, setSensitive] = useState(false);
  const [newPattern, setNewPattern] = useState('');
  const [newKind, setNewKind] = useState('deny');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.detectEnv(true); // 带头像
      const al = await api.getAllowlist();
      const allowed = new Set(((al && al.environments) || []).map((e) => keyOf(e)));
      const mkCfg = (kind, browserName, version, userDataDir, p, cdp) => ({
        kind, browserName, version, userDataDir, cdp,
        profileId: p.id, profileName: p.name, user_name: p.user_name, email: p.email,
        path: p.path, download_dir: p.download_dir, avatar: p.avatar_base64 || '',
      });
      const out = [];
      (d && d.browsers || []).forEach((b) => {
        if (!b.installed) { out.push({ kind: b.browser_type, name: b.browser_name, version: '', installed: false, groups: [] }); return; }
        const groups = [];
        const defProfiles = (b.profiles || []).map((p) => mkCfg(b.browser_type, b.browser_name, b.browser_version, b.default_user_data_dir, p, false));
        if (defProfiles.length) groups.push({ userDataDir: b.default_user_data_dir, cdp: false, dirLabel: '默认目录 · 不可CDP', profiles: defProfiles });
        (b.cdp_environments || []).forEach((env) => {
          const ps = (env.profiles || []).map((p) => mkCfg(b.browser_type, b.browser_name, b.browser_version, env.user_data_dir, p, true));
          if (ps.length) groups.push({ userDataDir: env.user_data_dir, cdp: true, dirLabel: '可CDP 驱动', profiles: ps });
        });
        out.push({ kind: b.browser_type, name: b.browser_name, version: b.browser_version, installed: true, groups });
      });
      setBrowsers(out);
      const all = out.flatMap((b) => b.groups.flatMap((g) => g.profiles));
      setAllowedMap(Object.fromEntries(all.map((c) => [keyOf(c), allowed.has(keyOf(c))])));
      const r = await api.listRunning();
      setRunning((r && r.instances) || []);
      const pl = await api.getPolicy();
      setPolicy({ deny: (pl && pl.deny) || [], requireApproval: (pl && pl.requireApproval) || [] });
      const wm = await api.getWorkMode();
      setSensitive(!!(wm && wm.sensitive));
    } catch (e) {
      setErr(String((e && e.message) || e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // 运行实例 → 命中 profile 的 key（kind\0userDataDir\0profileId）
  const runningMap = {};
  for (const i of running) {
    const k = `${i.kind}\u0000${i.userDataDir || ''}\u0000${i.profileId || ''}`;
    runningMap[k] = runningMap[k] || [];
    runningMap[k].push(i);
  }
  const runningCount = Object.keys(runningMap).length;

  const toggle = useCallback(async (cfg) => {
    const next = !allowedMap[keyOf(cfg)];
    setErr(null);
    try {
      await api.setAllowed({ ...cfg, allowed: next });
      setAllowedMap((m) => ({ ...m, [keyOf(cfg)]: next }));
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, allowedMap]);

  const toggleWorkMode = useCallback(async () => {
    setErr(null);
    try {
      const wm = await api.setWorkMode(!sensitive);
      setSensitive(!!(wm && wm.sensitive));
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, sensitive]);

  const addPolicyRule = useCallback(async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    setErr(null);
    try {
      const pl = await api.policyAdd(newKind, pattern);
      setPolicy({ deny: (pl && pl.policy && pl.policy.deny) || [], requireApproval: (pl && pl.policy && pl.policy.requireApproval) || [] });
      setNewPattern('');
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api, newPattern, newKind]);

  const removePolicyRule = useCallback(async (kind, pattern) => {
    setErr(null);
    try {
      const pl = await api.policyRemove(kind, pattern);
      setPolicy({ deny: (pl && pl.policy && pl.policy.deny) || [], requireApproval: (pl && pl.policy && pl.policy.requireApproval) || [] });
    } catch (e) { setErr(String((e && e.message) || e)); }
  }, [api]);

  const allCount = browsers.reduce((n, b) => n + b.groups.reduce((m, g) => m + g.profiles.length, 0), 0);
  const allowedCount = Object.values(allowedMap).filter(Boolean).length;

  return (
    <>
      <style>{UI_CSS}</style>
      <div style={{ padding: '4px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>浏览器配置</strong>
          <button type="button" onClick={load} disabled={loading} style={{ fontSize: 12, borderRadius: 6, padding: '3px 10px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform, #fff)' }}>
            {loading ? '检测中…' : '↻ 刷新检测'}
          </button>
          <label className="rb-switch" title="凭证隔离：开启后填密环节的值不回显给 AI（密码框任何模式下都不回显）">
            <input type="checkbox" checked={sensitive} onChange={toggleWorkMode} />
            <span className="track"><span className="thumb" /></span>
            <span style={{ fontSize: 12, color: sensitive ? '#f97316' : 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', fontWeight: sensitive ? 600 : 400 }}>
              {sensitive ? '凭证隔离 ON · 值不回显' : '凭证隔离 Work Mode'}
            </span>
          </label>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, marginLeft: 'auto' }}>
            已允许 <b style={{ color: allowedCount === allCount && allCount > 0 ? 'var(--dsw-alias-state-success-primary)' : 'inherit' }}>{allowedCount}</b>/{allCount} 个配置{runningCount ? ` · ${runningCount} 个配置运行中` : ''}
          </span>
        </div>
        <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: '0 0 12px', lineHeight: 1.6 }}>
          勾选 = 允许 AI 操作该浏览器配置（AI 只能在勾选的配置内启动/驱动浏览器）。Edge 与 Chrome 分区展示，头像来自各 profile 的用户配置。
        </p>
        {err && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, background: 'var(--dsw-alias-state-error-primary, #d1242f)15', borderRadius: 6, padding: '6px 10px' }}>错误: {err}</p>}
        {allCount === 0 && !err && <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>加载中…</p>}

      {browsers.map((b) => {
        const brand = brandOf(b.kind);
        const cnt = b.groups.reduce((n, g) => n + g.profiles.length, 0);
        const allowedN = b.groups.reduce((n, g) => n + g.profiles.filter((c) => allowedMap[keyOf(c)] === true).length, 0);
        const anyRunning = b.groups.some((g) => g.profiles.some((c) => (runningMap[keyOf(c)] || []).length > 0));
        return (
          <div key={b.kind} style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, marginBottom: 12, overflow: 'hidden', background: 'var(--dsw-alias-bg-module-platform, #fff)' }}>
            {/* 浏览器品牌头 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderLeft: `4px solid ${brand}`, borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
              <BrowserIcon kind={b.kind} size={38} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{b.name}</span>
                  {b.installed ? (
                    <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: 4, padding: '1px 6px' }}>v{b.version || '?'}</span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 4, padding: '1px 6px' }}>未安装</span>
                  )}
                  {anyRunning && <span style={{ fontSize: 11, color: '#2da44e', border: '1px solid #2da44e', borderRadius: 10, padding: '0 6px' }}>● 有实例运行</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 }}>
                  {b.kind === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'}{b.installed ? '' : ' · 未检测到安装'}
                </div>
              </div>
              {b.installed && (
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>
                  已允许 <b style={{ color: allowedN === cnt && cnt > 0 ? 'var(--dsw-alias-state-success-primary)' : 'inherit' }}>{allowedN}</b>/{cnt}
                </span>
              )}
            </div>
            {/* 主体：分组 + profile 卡片 */}
            <div style={{ padding: '10px 14px 12px' }}>
              {!b.installed && <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 }}>未检测到该浏览器。</p>}
              {b.groups.map((g, gi) => (
                <div key={g.userDataDir} style={{ marginBottom: gi === b.groups.length - 1 ? 0 : 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '6px 0 8px' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: g.cdp ? '#2da44e' : 'var(--dsw-alias-label-tertiary)', flexShrink: 0 }} />
                    <span style={{ color: g.cdp ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {g.cdp ? '可 CDP 驱动' : '默认目录 · 不可 CDP'}
                    </span>
                    <span style={{ color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.userDataDir}>{g.userDataDir}</span>
                  </div>
                  {g.profiles.map((c) => (
                    <ProfileCard key={keyOf(c)} cfg={c} accent={brand} allowed={allowedMap[keyOf(c)] === true} running={runningMap[keyOf(c)] || []} onToggle={() => toggle(c)} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* URL 策略守卫（AI 操作边界的第二层） */}
      <div style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '12px 14px', marginTop: 4, background: 'var(--dsw-alias-bg-module-platform, #fff)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>URL 策略守卫</span>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>deny 硬拦截 AI 操作匹配 URL；requireApproval 让匹配操作先弹审批（* = 任意串，不写 * = 精确匹配）</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <select value={newKind} onChange={(e) => setNewKind(e.target.value)} style={{ fontSize: 12, borderRadius: 6, padding: '4px 6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform, #fff)' }}>
            <option value="deny">deny</option>
            <option value="requireApproval">requireApproval</option>
          </select>
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addPolicyRule(); }}
            placeholder="如 *checkout* 或 https://*.bank.com/*"
            style={{ flex: 1, minWidth: 180, fontSize: 12, borderRadius: 6, padding: '4px 8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform, #fff)' }}
          />
          <button type="button" onClick={addPolicyRule} style={{ fontSize: 12, borderRadius: 6, padding: '4px 12px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform, #fff)' }}>添加规则</button>
        </div>
        {policy.deny.length === 0 && policy.requireApproval.length === 0 && (
          <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 }}>无规则 —— AI 可操作任意目标 URL（仍受上方「允许列表」的环境边界约束）。</p>
        )}
        {policy.deny.map((p) => (
          <RuleChip key={`deny-${p}`} label={`deny: ${p}`} tone="error" onRemove={() => removePolicyRule('deny', p)} />
        ))}
        {policy.requireApproval.map((p) => (
          <RuleChip key={`ra-${p}`} label={`requireApproval: ${p}`} tone="warn" onRemove={() => removePolicyRule('requireApproval', p)} />
        ))}
      </div>
    </div>
    </>
  );
}

function RuleChip({ label, tone, onRemove }) {
  const color = tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : '#f97316';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${color}55`, background: `${color}14`, color, borderRadius: 10, padding: '2px 8px', margin: '0 6px 6px 0', fontSize: 12, fontFamily: 'monospace' }}>
      {label}
      <button type="button" className="rb-chip-x" onClick={onRemove} style={{ color, fontSize: 12 }} title="移除规则">✕</button>
    </span>
  );
}

function ProfileCard({ cfg, accent, allowed, running, onToggle }) {
  const portText = running.map((i) => (i.port ? `:${i.port}` : '')).join('');
  return (
    <div className="rb-card" style={{ display: 'flex', gap: 12, alignItems: 'center', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '10px 12px', marginBottom: 8, background: 'var(--dsw-alias-bg-module-platform, #fff)' }}>
      {/* 头像：圆形 + 品牌色描边 */}
      <div style={{ width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, border: `2px solid ${accent}66`, background: `linear-gradient(135deg, ${accent}22, ${accent}0d)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {cfg.avatar ? (
          <img src={cfg.avatar} alt={cfg.profileName} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: '50%' }} />
        ) : (
          <span style={{ fontWeight: 700, fontSize: 18, color: accent }}>{(cfg.profileName || '?').charAt(0).toUpperCase()}</span>
        )}
      </div>
      {/* 信息 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>{cfg.profileName}</span>
          <span style={{ fontSize: 11, color: cfg.cdp ? '#2da44e' : 'var(--dsw-alias-label-tertiary)', border: `1px solid ${cfg.cdp ? '#2da44e' : 'var(--dsw-alias-border-l3)'}`, borderRadius: 10, padding: '0 6px', whiteSpace: 'nowrap' }}>
            {cfg.cdp ? '可CDP' : '不可CDP'}
          </span>
          {running.length > 0 && (
            <span style={{ fontSize: 11, color: '#2da44e', background: '#2da44e1a', borderRadius: 10, padding: '0 6px', whiteSpace: 'nowrap' }}>● 运行中{portText}</span>
          )}
          {cfg.user_name && <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>{cfg.user_name}</span>}
          {cfg.email && <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{cfg.email}</span>}
        </div>
        <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ whiteSpace: 'nowrap' }}>Profile <code style={{ background: 'var(--dsw-alias-markdown-inline-code)', borderRadius: 4, padding: '0 3px' }}>{cfg.profileId}</code></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }} title={cfg.download_dir}>
            下载 <code style={{ background: 'var(--dsw-alias-markdown-inline-code)', borderRadius: 4, padding: '0 3px' }}>{cfg.download_dir}</code>
          </span>
        </div>
        <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cfg.path}>
          {cfg.path}
        </div>
      </div>
      {/* 允许 AI switch */}
      <label className="rb-switch" title={allowed ? '已允许 AI 操作该配置，点击撤销' : '允许 AI 操作该配置'}>
        <input type="checkbox" checked={allowed} onChange={onToggle} />
        <span className="track"><span className="thumb" /></span>
        <span style={{ fontSize: 12, color: allowed ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>允许 AI</span>
      </label>
    </div>
  );
}

function keyOf(e) {
  return `${e.kind}\u0000${e.userDataDir}\u0000${e.profileId ?? ''}`;
}
