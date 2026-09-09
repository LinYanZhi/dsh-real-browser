/**
 * dsh-real-browser client — 视图B「全局配置」= 环境资产（机器上有什么+怎么管理）。
 *
 * 布局对齐 GLBT「全局浏览器配置」：浏览器选择条（GLBT 是可拖拽左栏，DSH 窄栏下
 * 改为顶部 tab 横条）+ 选中浏览器的详情面板 —— exe 路径编辑（持久化到
 * ~/.dsh/realbrowser-config.json）、用户数据目录块（默认 🔒 / 可CDP ⬡ / 自定义徽标）
 * + profiles 明细（头像/账号/下载目录 + 命令/快捷方式/关闭）、添加自定义目录、
 * 新建用户数据目录（含最小 Local State）、移除自定义目录、全部终止（确认后执行）。
 */
import React, { useState } from 'react';
import { BrowserIcon, ProfileAvatar, brandOf, PathText } from './widgets.js';

function ProfileMini({ cfg, accent, running, onAction }) {
  const cdp = !!cfg.cdp && cfg.restriction !== 'default_dir';
  const actions = (
    <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
      {cdp && <button type="button" className="rb-link-btn" title="查看启动命令" onClick={() => onAction('command', cfg)}>⎘ 命令</button>}
      <button type="button" className="rb-link-btn" title="创建桌面快捷方式" onClick={() => onAction('shortcut', cfg)}>★ 快捷方式</button>
      {running ? <button type="button" className="rb-link-btn" title="关闭该配置" onClick={() => onAction('close', cfg)}>■ 关闭</button> : null}
    </span>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 8 }}>
      <ProfileAvatar cfg={cfg} accent={accent} size={30} />
      <span style={{ fontWeight: 600, fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cfg.profileName || cfg.profileId}</span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {[cfg.id, cfg.user_name, cfg.email].filter(Boolean).join(' · ')}
      </span>
      {cfg.download_dir && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--dsw-alias-label-tertiary)', minWidth: 0, overflow: 'hidden' }}>⬇ <PathText text={cfg.download_dir} fontSize={11} style={{ maxWidth: 160 }} /></span>}
      <span style={{ flex: 1 }} />
      {running && <span style={{ color: 'var(--dsw-alias-state-success-primary)', fontSize: 11 }} title={`运行中 · CDP 端口 ${running.port ?? '?'}`}>● :{running.port ?? '?'}</span>}
      {actions}
    </div>
  );
}

function DirBlock({ block, accent, runningMap, onAction, onRemoveDir, onToast }) {
  return (
    <div style={{ border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '6px 8px', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13 }}>{block.cdp ? '⬡' : '🔒'}</span>
        <PathText text={block.userDataDir} fontSize={12.5} color="var(--dsw-alias-label-primary)" style={{ flex: 1, minWidth: 0 }} />
        {block.userConfigured && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)', borderRadius: 10, padding: '0 7px', whiteSpace: 'nowrap' }}>自定义目录</span>}
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>{block.cdp ? '可 CDP' : '默认 · 不可自动化'}</span>
        <span style={{ flex: 1 }} />
        {block.userConfigured && (
          <button
            type="button"
            className="rb-link-btn"
            title="从全局配置移除该目录（不移除授权，可在「当前配置」取消勾选）"
            onClick={() => { if (window.confirm(`从全局配置移除自定义目录？\n${block.userDataDir}\n（不移除磁盘文件与已有授权）`)) onRemoveDir(block.userDataDir); }}
            style={{ color: 'var(--dsw-alias-state-error-primary)' }}
          >
            ✕ 移除
          </button>
        )}
      </div>
      {block.profiles.length === 0 && <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5, padding: '2px 0 4px 22px' }}>（无用户配置 / 尚未启动过）</div>}
      {block.profiles.map((c) => (
        <ProfileMini key={c.profileId} cfg={c} accent={accent} running={runningMap.get(c.kind + '\u0000' + c.userDataDir + '\u0000' + (c.profileId ?? ''))} onAction={onAction} />
      ))}
    </div>
  );
}

export default function GlobalView({ groups, config, runningMap, onSetExe, onAddDir, onRemoveDir, onCreateDir, onAction, onToast }) {
  const [active, setActive] = useState(() => (groups[0] ? groups[0].kind : null));
  const [exeDraft, setExeDraft] = useState('');
  const [dirDraft, setDirDraft] = useState('');
  const [parentDraft, setParentDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState('');

  const group = groups.find((g) => g.kind === active) || groups[0] || null;
  if (!group) {
    return <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12.5, padding: 16, textAlign: 'center' }}>无浏览器环境（点击右上角 ↻ 重新检测）</div>;
  }
  const accent = brandOf(group.kind);

  const doSetExe = async () => {
    setBusy('exe');
    try { await onSetExe(group.kind, exeDraft.trim() || group.exePaths[0]); } finally { setBusy(''); }
  };
  const doAddDir = async () => {
    const d = dirDraft.trim();
    if (!d) { onToast('请输入目录路径', 'warn'); return; }
    setBusy('dir');
    try { await onAddDir(group.kind, d); setDirDraft(''); } finally { setBusy(''); }
  };
  const doCreateDir = async () => {
    const parent = parentDraft.trim();
    const name = nameDraft.trim();
    if (!parent || !name) { onToast('请填写父目录与目录名', 'warn'); return; }
    setBusy('create');
    try { await onCreateDir(group.kind, parent, name); setNameDraft(''); setParentDraft(''); } finally { setBusy(''); }
  };
  const doKillAll = async () => {
    if (!window.confirm(`确定终止本机全部 ${group.browserName} 进程（含所有独立目录实例）？正在使用的窗口会被关闭。`)) return;
    setBusy('kill');
    try { await onAction('killAll', { kind: group.kind }); } finally { setBusy(''); }
  };

  return (
    <div>
      {/* 浏览器选择条（对齐 GLBT 左侧栏的角色） */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {groups.map((g) => (
          <button
            key={g.kind}
            type="button"
            onClick={() => { setActive(g.kind); setExeDraft(g.exePaths[0] || ''); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 10, cursor: 'pointer',
              border: active === g.kind ? `1.5px solid ${brandOf(g.kind)}` : '1px solid var(--dsw-alias-border-l2)',
              background: active === g.kind ? 'color-mix(in srgb, var(--dsw-alias-bg-module-platform, #fff) 60%, transparent)' : 'var(--dsw-alias-bg-module-platform, #fff)',
              fontWeight: active === g.kind ? 600 : 400, fontSize: 13, color: 'var(--dsw-alias-label-primary)',
            }}
          >
            <BrowserIcon kind={g.kind} size={22} />
            {g.browserName}
            <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, fontWeight: 400 }}>{g.installed ? (g.version ? `v${g.version}` : '') : '未安装'}</span>
          </button>
        ))}
      </div>

      {/* 详情面板 */}
      <div style={{ border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <strong style={{ fontSize: 13.5 }}>{group.browserName} 配置</strong>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="rb-btn"
            disabled={busy === 'kill'}
            onClick={doKillAll}
            style={{ fontSize: 11.5, padding: '2px 8px', color: 'var(--dsw-alias-state-error-primary)' }}
          >
            {busy === 'kill' ? '终止中…' : '全部终止'}
          </button>
        </div>

        {/* exe 路径 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>exe</span>
          <input
            className="rb-input"
            value={exeDraft || group.exePaths[0] || ''}
            onChange={(e) => setExeDraft(e.target.value)}
            placeholder="未检测到可执行文件，可手动填写后保存"
            title={group.exePaths[0] || 'exe 路径'}
            style={{ flex: 1 }}
          />
          <button type="button" className="rb-btn" disabled={busy === 'exe'} onClick={doSetExe}>{busy === 'exe' ? '保存中…' : '保存'}</button>
        </div>

        {/* 目录块 */}
        {group.blocks.map((b) => (
          <DirBlock key={b.userDataDir} block={b} accent={accent} runningMap={runningMap} onAction={onAction} onRemoveDir={(dir) => onRemoveDir(group.kind, dir)} onToast={onToast} />
        ))}

        {/* 添加自定义目录 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input
            className="rb-input"
            value={dirDraft}
            onChange={(e) => setDirDraft(e.target.value)}
            placeholder="添加自定义用户数据目录（跨会话保留）"
            style={{ flex: 1 }}
          />
          <button type="button" className="rb-btn" disabled={busy === 'dir'} onClick={doAddDir}>{busy === 'dir' ? '添加中…' : '+ 添加'}</button>
        </div>
        {/* 新建用户数据目录 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <input className="rb-input" value={parentDraft} onChange={(e) => setParentDraft(e.target.value)} placeholder="父目录（新建位置）" style={{ flex: 1.2 }} />
          <input className="rb-input" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="目录名" style={{ flex: 0.8 }} />
          <button type="button" className="rb-btn" disabled={busy === 'create'} onClick={doCreateDir}>{busy === 'create' ? '创建中…' : '新建目录'}</button>
        </div>
        <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, marginTop: 6 }}>
          自定义目录与 exe 路径持久化在 <code>~/.dsh/realbrowser-config.json</code>，跨会话保留；检测与 AI 的 <code>real_browser_env</code> 自动合并。
        </div>
      </div>
    </div>
  );
}
