/**
 * dsh-real-browser client — 视图A「当前配置」= 授权边界（AI 能用什么）。
 *
 * 布局对齐 GLBT「当前浏览器配置」的视觉语言（不复刻其代码，只对齐观感）：
 * 方形 profile 卡片网格墙 —— 左上角锁定/⚠标记、右上角选中勾、大头像、
 * 名称/账号/来源目录、底部受限标签行；点击卡片 = 勾选授权（默认路径不可勾选），
 * 组头全选/全不选，**右键卡片** = 菜单（启动 / 查看启动命令 / 创建桌面快捷方式 /
 * 关闭该配置 / 全部终止）。
 * 运行状态点（●绿=运行带端口 / ○灰=未运行）。
 */
import React, { useState, useEffect } from 'react';
import { keyOf, BrowserIcon, ProfileAvatar, StatusDot, Menu, brandOf } from './widgets.js';

const dirName = (d) => {
  const s = String(d || '').replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts.length > 1 ? parts.slice(-2).join('\\') : s;
};

function ProfileCard({ cfg, allowed, running, onToggle, onMenu, onToast }) {
  const [menuPos, setMenuPos] = useState(null);
  const restricted = cfg.restriction === 'default_dir';
  const accent = brandOf(cfg.kind);

  const items = [
    { label: '启动（CDP）', icon: '▶', disabled: restricted || !cfg.cdp, onClick: () => onMenu('launch', cfg) },
    { label: '查看启动命令', icon: '⎘', disabled: restricted || !cfg.cdp, onClick: () => onMenu('command', cfg) },
    { label: '创建桌面快捷方式', icon: '★', onClick: () => onMenu('shortcut', cfg) },
    { label: '关闭该配置', icon: '■', disabled: !running, onClick: () => onMenu('close', cfg) },
    { divider: true },
    { label: `全部终止 ${cfg.kind === 'chrome' ? 'Chrome' : 'Edge'}`, icon: '⏹', danger: true, onClick: () => onMenu('killAll', cfg) },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* 正圆卡片（= 头像背景框，用户要求 100% 圆角）：正方形 + borderRadius:50%，
          元信息放圆外下方，避免椭圆/圆角矩形观感 */}
      <div
        className={`rb-card${allowed ? ' rb-card--selected' : ''}${restricted ? ' rb-card--restricted' : ''}`}
        onClick={() => { if (!restricted) onToggle(cfg); else onToast('浏览器默认用户路径不可用于自动化控制，只能走浏览器自身 UI', 'warn'); }}
        onContextMenu={(e) => { e.preventDefault(); setMenuPos({ x: e.clientX, y: e.clientY }); }}
        title={restricted ? '浏览器默认用户路径 — 基于浏览器安全规范，不可用于自动化控制；右键查看操作' : (allowed ? '已允许 AI 操作，点击取消授权；右键更多操作' : '点击允许 AI 操作该配置；右键更多操作')}
        style={{
          position: 'relative', width: 118, height: 118, borderRadius: '50%', clipPath: 'circle(50%)',
          border: '1px solid var(--dsw-alias-border-l2)',
          // 背景必须透明：头像/图标可能是透明底（用户要求），透出真实页面背景，
          // 不能画默认色（深色主题下白底/浅底框会盖在透明头像后面）
          background: 'transparent',
          cursor: restricted ? 'default' : 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
          opacity: restricted ? 0.6 : 1, userSelect: 'none', flexShrink: 0,
        }}
      >
        {/* 左上角标记：锁定 / 多用户警告 */}
        {restricted && (
          <span style={{ position: 'absolute', top: 10, left: 10, fontSize: 13 }} title="默认路径 · 不可自动化">🔒</span>
        )}
        {!restricted && cfg.restriction === 'multi_user' && (
          <span style={{ position: 'absolute', top: 10, left: 10, fontSize: 13 }} title="同 user-data-dir 含多个用户 — 同一时刻只能开一个实例（单实例锁），建议每用户独立目录">⚠</span>
        )}
        {/* 右上角：选中勾 */}
        {allowed && (
          <span style={{ position: 'absolute', top: 8, right: 8, width: 16, height: 16, borderRadius: '50%', background: accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, zIndex: 2 }}>✓</span>
        )}
        {/* 右键菜单（跟随鼠标位置） */}
        {menuPos && <Menu items={items} pos={menuPos} onClose={() => setMenuPos(null)} />}
        {/* 运行状态点 */}
        <div style={{ position: 'absolute', top: 16 }}>
          <StatusDot running={!!running} port={running?.port} />
        </div>
        {/* 头像（正圆） */}
        <ProfileAvatar cfg={cfg} accent={accent} size={64} />
      </div>
      {/* 圆外元信息 */}
      <div style={{ marginTop: 6, maxWidth: 140, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--dsw-alias-label-primary)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cfg.profileName || cfg.profileId}</div>
        <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[cfg.user_name, cfg.email].filter(Boolean).join(' · ') || cfg.profileId}
        </div>
        <div style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Consolas, monospace' }} title={cfg.userDataDir}>{dirName(cfg.userDataDir)}</div>
        {cfg.userConfigured && <div style={{ fontSize: 9.5, color: 'var(--dsw-alias-state-warn-primary)' }}>自定义目录</div>}
        <div style={{ fontSize: 10, color: restricted ? 'var(--dsw-alias-label-tertiary)' : cfg.restriction === 'multi_user' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
          {restricted ? '默认路径·不可用' : cfg.restriction === 'multi_user' ? '多用户目录·受限' : '单用户目录·可用'}
        </div>
      </div>
    </div>
  );
}

export default function CurrentView({ groups, allowedSet, runningMap, onToggle, onToggleGroup, onMenu, onToast }) {
  const [hideDefault, setHideDefault] = useState(() => {
    try { return localStorage.getItem('rb-hide-default') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('rb-hide-default', hideDefault ? '1' : '0'); } catch {}
  }, [hideDefault]);

  const visibleCount = groups.reduce((n, g) => n + g.profiles.filter((c) => !(hideDefault && c.restriction === 'default_dir')).length, 0);

  return (
    <div>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }}>共 <b>{visibleCount}</b> 个用户配置</span>
        <span style={{ flex: 1 }} />
        <label className="rb-switch" title="启用后不再展示浏览器默认用户路径下的配置（默认路径不可自动化）">
          <input type="checkbox" checked={hideDefault} onChange={(e) => setHideDefault(e.target.checked)} />
          <span className="track"><span className="thumb" /></span>
          <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>隐藏不可控</span>
        </label>
      </div>

      {groups.map((g) => {
        const display = hideDefault ? g.profiles.filter((c) => c.restriction !== 'default_dir') : g.profiles;
        const selectable = display.filter((c) => c.restriction !== 'default_dir');
        const allowedN = selectable.filter((c) => allowedSet.has(keyOf(c))).length;
        const runN = display.filter((c) => runningMap.has(keyOf(c))).length;
        const allSelected = selectable.length > 0 && selectable.every((c) => allowedSet.has(keyOf(c)));
        return (
          <div key={g.kind} style={{ marginBottom: 16 }}>
            {/* 浏览器头 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px' }}>
              <BrowserIcon kind={g.kind} size={24} />
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{g.browserName}</span>
              {g.installed && g.version && <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>v{g.version}</span>}
              <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' }}>{g.profiles.length} 个配置</span>
              {runN > 0 && <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-state-success-primary)' }}>● {runN} 运行</span>}
              <span style={{ flex: 1 }} />
              <label className="rb-switch" title={allSelected ? '取消本组全部授权' : '全选本组可授权配置'}>
                <input type="checkbox" checked={allSelected} disabled={selectable.length === 0} onChange={(e) => onToggleGroup(g.kind, selectable, e.target.checked)} />
                <span className="track"><span className="thumb" /></span>
                <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>全选 {allowedN}/{selectable.length}</span>
              </label>
            </div>
            {/* 方形卡片网格 */}
            {display.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 10 }}>
                {display.map((c) => {
                  const k = keyOf(c);
                  return <ProfileCard key={k} cfg={c} allowed={allowedSet.has(k)} running={runningMap.get(k)} onToggle={onToggle} onMenu={onMenu} onToast={onToast} />;
                })}
              </div>
            ) : (
              <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: '10px 4px' }}>{g.installed ? '未检测到用户配置' : '浏览器未安装'}</div>
            )}
          </div>
        );
      })}
      {groups.length === 0 && <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12.5, padding: 16, textAlign: 'center' }}>无浏览器环境（点击右上角 ↻ 重新检测）</div>}
    </div>
  );
}
