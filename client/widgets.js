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
      <img src={src} alt={label} title={label} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
    </span>
  );
}

/** 长文本/路径显示——对齐 DSH 插件生态（dsh-better-sidebar 同款）：
 *  单行：text-overflow:ellipsis + white-space:nowrap + overflow:hidden（+min-width:0/flex:1 由调用方给），
 *        悬停 title 显示完整内容——不做中间省略、不插零宽空格；
 *  多行：white-space:pre-wrap + word-break:break-word（断词换行）。 */
export function PathText({ text, singleLine = true, monospace = true, fontSize = 11, color, style }) {
  const full = String(text ?? '');
  return (
    <span
      title={full}
      style={{
        fontFamily: monospace ? 'Consolas, monospace' : undefined,
        fontSize,
        color,
        ...(singleLine
          ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom' }
          : { whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word' }),
        ...style,
      }}
    >
      {full}
    </span>
  );
}

/**
 * 轻量 SVG 图标集（16 viewBox，stroke=currentColor，feather 风格）。
 * 用户明确：不要 unicode 字符图标（🔒⚠✓⬡⬇ 等），一律用 SVG。
 */
function Svg({ size = 14, children, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden {...rest}>
      {children}
    </svg>
  );
}
export const LockIcon = (p) => <Svg {...p}><rect x="4.5" y="7.5" width="7" height="5.5" rx="1.5" /><path d="M6 7.5V6a2 2 0 0 1 4 0v1.5" /></Svg>;
export const WarnIcon = (p) => <Svg {...p}><path d="M8 3 14 13H2z" /><path d="M8 7v3" /><circle cx="8" cy="11.8" r="0.5" fill="currentColor" stroke="none" /></Svg>;
export const CheckIcon = (p) => <Svg {...p}><path d="M4 8.2 7 11.2 12.2 5" /></Svg>;
export const PlayIcon = (p) => <Svg {...p}><path d="M6 4.5v7l5.5-3.5z" fill="currentColor" stroke="none" /></Svg>;
export const CommandIcon = (p) => <Svg {...p}><path d="M5 5 2.5 8 5 11M11 5l2.5 3L11 11" /></Svg>;
export const StarIcon = (p) => <Svg {...p}><path d="m8 2.5 1.7 3.4 3.8.6-2.7 2.6.6 3.8-3.4-1.8-3.4 1.8.6-3.8-2.7-2.6 3.8-.6z" /></Svg>;
export const CloseIcon = (p) => <Svg {...p}><path d="M5 5l6 6M11 5l-6 6" /></Svg>;
export const StopIcon = (p) => <Svg {...p}><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" /></Svg>;
export const DownloadIcon = (p) => <Svg {...p}><path d="M8 3v7M5 7.5 8 10.5 11 7.5M3.5 13h9" /></Svg>;
export const DirIcon = (p) => <Svg {...p}><path d="M3 4.5h3l1.2 1.5H13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></Svg>;
export const RefreshIcon = (p) => <Svg {...p}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" /></Svg>;

/** 圆形头像：用户头像优先（正圆裁切，透明底无边框），无则首字母 + 品牌色。
 * 对齐 GLBT：avatar 非空直接 <img>（data URL / http URL 均可；Chrome/Edge 的
 * <img> 本身支持 x-icon/ico 与 png/jpeg 显示，格式交给浏览器，不做白名单）。
 * ⚠️ 硬性要求（用户多次强调）：头像必须是 100% 正圆——容器 clipPath:circle(50%)
 * + borderRadius:50% + overflow:hidden 三重保险，img 自身也带 borderRadius:50%，
 * 任何全局 CSS 覆盖 border-radius 都破坏不了圆形裁切。onError 兜底：加载失败
 * （http URL 被 CSP/网络挡掉、数据损坏）回退到首字母，绝不显示破图图标。 */
export function ProfileAvatar({ cfg, accent, size = 44 }) {
  const av = cfg.avatar;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [av]);
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%', clipPath: 'circle(50%)', overflow: 'hidden',
        flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent',
      }}
    >
      {av && !failed ? (
        <img src={av} alt={cfg.profileName} draggable={false} onError={() => setFailed(true)}
          style={{ width: size, height: size, objectFit: 'cover', display: 'block', borderRadius: '50%' }} />
      ) : (
        <span style={{ fontWeight: 700, fontSize: Math.round(size * 0.42), color: accent, lineHeight: 1, userSelect: 'none' }}>
          {(cfg.profileName || cfg.profileId || '?').charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
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

/** 启动命令弹窗（查看 / 复制）。Esc / 遮罩点击 / 关闭按钮均可关闭。 */
export function CommandModal({ info, onClose, onCopy }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div
        ref={ref}
        style={{ width: 620, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto', background: 'var(--dsw-alias-bg-module-platform, #fff)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12, padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <strong style={{ fontSize: 14 }}>启动命令{info.debug_port ? ` · 端口 ${info.debug_port}` : ''}</strong>
          <span style={{ flex: 1 }} />
          <button type="button" className="rb-btn" onClick={onCopy} style={{ fontSize: 12, padding: '3px 10px', marginRight: 6 }}>复制</button>
          <button type="button" className="rb-btn" onClick={onClose} style={{ fontSize: 12, padding: '3px 10px' }}>关闭</button>
        </div>
        <div style={{ background: 'var(--dsw-alias-markdown-inline-code)', borderRadius: 8, padding: 10, fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word', marginBottom: 8 }}>{info.command_line}</div>
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
      {text && <div style={{ border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, background: 'var(--dsw-alias-bg-module-platform, #fff)', color, borderRadius: 8, padding: '8px 12px', fontSize: 12.5, boxShadow: '0 4px 14px rgba(0,0,0,.12)', maxWidth: 380, animation: 'rb-toast-in .18s ease-out' }}>{text}</div>}
    </div>
  );
}

/** 危险操作确认弹窗（替代原生 window.confirm，与整体 UI 风格一致）。Esc / 遮罩 = 取消。 */
export function ConfirmModal({ title, message, confirmLabel = '确认', danger = true, onConfirm, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div
        style={{ width: 420, maxWidth: '90vw', background: 'var(--dsw-alias-bg-module-platform, #fff)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12, padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="rb-btn" onClick={onClose} style={{ fontSize: 12, padding: '4px 12px' }}>取消</button>
          <button
            type="button"
            className="rb-btn"
            onClick={() => { onConfirm(); onClose(); }}
            style={{ fontSize: 12, padding: '4px 12px', borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
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
