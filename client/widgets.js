/**
 * dsh-real-browser client — 共享 UI 小组件。
 * 视觉语言：DSH 设计 token（--dsw-alias-*）+ 圆形官方 logo / 圆形头像 +
 * 品牌色左条标识授权。不复刻 GLBT 布局。
 */
import React, { useEffect, useRef, useState } from 'react';
import { EDGE_LOGO, CHROME_LOGO } from './icons.js';

/** 配置复合 key：kind\0userDataDir\0profileId */
export function keyOf(e) {
  return `${e.kind}\u0000${e.userDataDir}\u0000${e.profileId ?? ''}`;
}

export const brandOf = (kind) => (kind === 'chrome' ? '#4285f4' : '#0078d4');

/** 官方品牌 logo（圆形裁切，与 GLBT app-icons 同款）。 */
export function BrowserIcon({ kind, size = 32 }) {
  const src = kind === 'chrome' ? CHROME_LOGO : EDGE_LOGO;
  const label = kind === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
  return (
    <span
      style={{
        width: size, height: size, borderRadius: '50%', clipPath: 'circle(50%)',
        overflow: 'hidden', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', flexShrink: 0,
      }}
    >
      <img src={src} alt={label} title={label} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </span>
  );
}

/** 圆形头像：用户头像优先（正圆裁切，透明底无边框），无则首字母 + 品牌色。
 * 对齐 GLBT：avatar 非空直接 <img>（data URL / http URL 均可；Chrome/Edge 的
 * <img> 本身支持 x-icon/ico 与 png/jpeg 显示，格式交给浏览器，不做白名单）。
 * onError 兜底：任何加载失败（http URL 被 CSP/网络挡掉、数据损坏）都回退到
 * 首字母，绝不显示浏览器默认的「破图」图标。 */
export function ProfileAvatar({ cfg, accent, size = 44 }) {
  const av = cfg.avatar;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [av]);
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent',
      }}
    >
      {av && !failed ? (
        <img src={av} alt={cfg.profileName} draggable={false} onError={() => setFailed(true)} style={{ width: size, height: size, objectFit: 'cover', display: 'block' }} />
      ) : (
        <span style={{ fontWeight: 700, fontSize: Math.round(size * 0.42), color: accent, lineHeight: 1, userSelect: 'none' }}>
          {(cfg.profileName || cfg.profileId || '?').charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}

/** 运行状态点：● 绿 = 运行中（带端口），○ 灰 = 未运行。 */
export function StatusDot({ running, port }) {
  if (!running) {
    return <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--dsw-alias-border-l3)', flexShrink: 0, display: 'inline-block' }} title="未运行" />;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--dsw-alias-state-success-primary)', fontSize: 11, whiteSpace: 'nowrap' }} title={port ? `运行中 · CDP 端口 ${port}` : '运行中（无调试端口）'}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)', display: 'inline-block', animation: 'rb-pulse 1.6s ease-in-out infinite' }} />
      {port ? `:${port}` : '运行'}
    </span>
  );
}

/** 受限等级徽标（对齐 GLBT profile-rules 三档）。 */
export function RestrictionTag({ restriction }) {
  if (restriction === 'default_dir') {
    return <span title="浏览器默认用户路径：完全受限，不可 CDP 自动化（只能走浏览器自身 UI）" style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 10, padding: '0 7px', whiteSpace: 'nowrap' }}>🔒 默认目录 · 不可自动化</span>;
  }
  if (restriction === 'multi_user') {
    return <span title="同 user-data-dir 含多个用户：浏览器单实例锁（同目录同时只能开一个实例）→ 部分受限" style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)', borderRadius: 10, padding: '0 7px', whiteSpace: 'nowrap' }}>⧉ 同目录多用户</span>;
  }
  return null;
}

/** 轻量 dropdown 菜单（点击外部 / Esc 关闭）。传 pos={x,y} 时 fixed 定位跟随（右键菜单），否则锚定父级。 */
export function Menu({ items, onClose, align = 'right', pos }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const style = pos
    ? { position: 'fixed', zIndex: 200, left: pos.x, top: pos.y, minWidth: 172 }
    : { position: 'absolute', zIndex: 50, minWidth: 168, top: '100%', right: align === 'right' ? 0 : undefined, left: align === 'left' ? 0 : undefined, marginTop: 4 };
  return (
    <div
      ref={ref}
      style={{
        ...style,
        background: 'var(--dsw-alias-bg-module-platform, #fff)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8,
        boxShadow: '0 6px 20px rgba(0,0,0,.14)', padding: 4,
      }}
    >
      {items.map((it, i) =>
        it.divider ? (
          <div key={`d${i}`} style={{ height: 1, background: 'var(--dsw-alias-border-l1)', margin: '4px 6px' }} />
        ) : (
          <button
            key={it.label}
            type="button"
            disabled={it.disabled}
            onClick={() => { onClose(); it.onClick(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              padding: '7px 10px', fontSize: 12.5, border: 'none', borderRadius: 6, cursor: it.disabled ? 'default' : 'pointer',
              background: 'transparent', color: it.danger ? 'var(--dsw-alias-state-error-primary)' : it.disabled ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
              opacity: it.disabled ? 0.55 : 1,
            }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {it.icon && <span style={{ fontSize: 13, width: 16, textAlign: 'center' }}>{it.icon}</span>}
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.hint && <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** 启动命令弹窗（查看 / 复制）。 */
export function CommandModal({ info, onClose, onCopy }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div
        style={{ width: 620, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto', background: 'var(--dsw-alias-bg-module-platform, #fff)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12, padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <strong style={{ fontSize: 14 }}>启动命令{info.debug_port ? ` · 端口 ${info.debug_port}` : ''}</strong>
          <span style={{ flex: 1 }} />
          <button type="button" className="rb-btn" onClick={onCopy} style={{ fontSize: 12, padding: '3px 10px', marginRight: 6 }}>复制</button>
          <button type="button" className="rb-btn" onClick={onClose} style={{ fontSize: 12, padding: '3px 10px' }}>关闭</button>
        </div>
        <div style={{ background: 'var(--dsw-alias-markdown-inline-code)', borderRadius: 8, padding: 10, fontFamily: 'Consolas, monospace', fontSize: 12, wordBreak: 'break-all', marginBottom: 8 }}>{info.command_line}</div>
        <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
          <div style={{ marginBottom: 4 }}>参数（{info.args.length}）：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {info.args.map((a) => (
              <code key={a} style={{ background: 'var(--dsw-alias-markdown-inline-code)', borderRadius: 4, padding: '1px 6px', fontSize: 11.5 }}>{a}</code>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 轻量 toast（右上角）。 */
export function Toast({ text, tone }) {
  const color = tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)';
  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 200, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {text && <div style={{ border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, background: 'var(--dsw-alias-bg-module-platform, #fff)', color, borderRadius: 8, padding: '8px 12px', fontSize: 12.5, boxShadow: '0 4px 14px rgba(0,0,0,.12)', maxWidth: 380 }}>{text}</div>}
    </div>
  );
}

/** 复制文本到剪贴板（web 上下文）。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

/** 折叠面板 hook（展开状态持久化到 localStorage）。 */
export function useCollapse(key, defaultOpen = false) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(`rb-collapse-${key}`) === null ? defaultOpen : localStorage.getItem(`rb-collapse-${key}`) === '1'; } catch { return defaultOpen; }
  });
  const toggle = () => {
    setOpen((v) => {
      try { localStorage.setItem(`rb-collapse-${key}`, v ? '0' : '1'); } catch {}
      return !v;
    });
  };
  return [open, toggle];
}
