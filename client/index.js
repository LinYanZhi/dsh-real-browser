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
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <strong>浏览器配置</strong>
        <button type="button" onClick={load} disabled={loading} style={{ fontSize: 12 }}>
          {loading ? '检测中…' : '刷新检测'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={sensitive} onChange={toggleWorkMode} style={{ margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' }} />
          <span style={{ color: sensitive ? 'var(--dsw-alias-state-warning-primary, #f97316)' : 'var(--dsw-alias-label-tertiary)' }}>
            {sensitive ? '凭证隔离 ON（值不回显给 AI）' : '凭证隔离 Work Mode'}
          </span>
        </label>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>已允许 {allowedCount}/{allCount} 个配置{runningCount ? ` · ${runningCount} 个配置正在运行` : ''}</span>
      </div>
      <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: '0 0 10px' }}>
        勾选 = 允许 AI 操作该浏览器配置（AI 只能在勾选的配置内启动/驱动浏览器）。头像来自各 profile 的用户配置。
      </p>
      {err && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>错误: {err}</p>}
      {allCount === 0 && !err && <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>加载中…</p>}

      {browsers.map((b) => (
        <div key={b.kind} style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{b.name}</span>
            {b.installed ? <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>v{b.version || '?'}</span> : <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>未安装</span>}
          </div>
          {!b.installed && <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 }}>未检测到该浏览器。</p>}
          {b.groups.map((g) => (
            <div key={g.userDataDir} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: g.cdp ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)', margin: '4px 0' }}>■ {g.dirLabel} · {g.userDataDir}</div>
              {g.profiles.map((c) => (
                <ProfileCard key={keyOf(c)} cfg={c} allowed={allowedMap[keyOf(c)] === true} running={runningMap[keyOf(c)] || []} onToggle={() => toggle(c)} />
              ))}
            </div>
          ))}
        </div>
      ))}

      {/* URL 策略守卫（AI 操作边界的第二层） */}
      <div style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10, marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>URL 策略守卫</span>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>deny 硬拦截 AI 操作匹配 URL；requireApproval 让匹配操作先弹审批（glob-lite：* = 任意串，不写 * = 精确匹配）</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <select value={newKind} onChange={(e) => setNewKind(e.target.value)} style={{ fontSize: 12 }}>
            <option value="deny">deny</option>
            <option value="requireApproval">requireApproval</option>
          </select>
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addPolicyRule(); }}
            placeholder="如 *checkout* 或 https://*.bank.com/*"
            style={{ flex: 1, minWidth: 180, fontSize: 12 }}
          />
          <button type="button" onClick={addPolicyRule} style={{ fontSize: 12 }}>添加规则</button>
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
  );
}

function RuleChip({ label, tone, onRemove }) {
  const color = tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : '#f97316';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${color}`, color, borderRadius: 4, padding: '2px 6px', margin: '0 6px 6px 0', fontSize: 12 }}>
      {label}
      <button type="button" onClick={onRemove} style={{ border: 'none', background: 'none', cursor: 'pointer', color, fontSize: 12, padding: 0 }} title="移除规则">✕</button>
    </span>
  );
}

function ProfileCard({ cfg, allowed, running, onToggle }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: 8, marginBottom: 6, background: 'var(--dsw-alias-bg-module-platform)' }}>
      <div style={{ width: 36, height: 36, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: 'var(--dsw-alias-interactive-bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {cfg.avatar ? (
          <img src={cfg.avatar} alt={cfg.profileName} style={{ width: 36, height: 36, objectFit: 'cover' }} />
        ) : (
          <span style={{ fontWeight: 700, color: 'var(--dsw-alias-label-secondary)' }}>{(cfg.profileName || '?').charAt(0).toUpperCase()}</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>{cfg.profileName}</span>
          <span style={{ color: cfg.cdp ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)', fontSize: 11, border: '1px solid ' + (cfg.cdp ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l3)'), borderRadius: 4, padding: '0 4px' }}>
            {cfg.cdp ? '可CDP' : '不可CDP'}
          </span>
          {running.length > 0 && (
            <span style={{ color: 'var(--dsw-alias-state-success-primary)', fontSize: 11, border: '1px solid var(--dsw-alias-state-success-primary)', borderRadius: 4, padding: '0 4px' }}>
              运行中{running.map((i) => (i.port ? `:${i.port}` : '')).join('')}
            </span>
          )}
          {cfg.user_name && <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>{cfg.user_name}</span>}
          {cfg.email && <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{cfg.email}</span>}
        </div>
        <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, marginTop: 2 }}>
          Profile ID <code style={{ background: 'var(--dsw-alias-markdown-inline-code)', borderRadius: 4, padding: '0 3px' }}>{cfg.profileId}</code>
          {' · '}下载目录 <code style={{ background: 'var(--dsw-alias-markdown-inline-code)', borderRadius: 4, padding: '0 3px' }} title={cfg.download_dir}>{cfg.download_dir}</code>
        </div>
        <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, wordBreak: 'break-all' }} title={cfg.path}>
          {cfg.path}
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>
        <input type="checkbox" checked={allowed} onChange={onToggle} style={{ margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' }} />
        允许 AI
      </label>
    </div>
  );
}

function keyOf(e) {
  return `${e.kind}\u0000${e.userDataDir}\u0000${e.profileId ?? ''}`;
}
