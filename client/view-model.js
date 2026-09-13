/**
 * dsh-real-browser client — 视图数据层（纯函数，无 React 依赖）。
 * buildGroups：detectEnv 原始输出 → 视图统一 group 结构（含受限等级/自定义目录标注）。
 * env cache：localStorage 检测缓存——打开设置页首帧立即渲染上次结果（后台刷新覆盖），
 *            消除转圈等待。
 */

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
export function loadEnvCache() {
  try {
    const raw = localStorage.getItem(ENV_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.browsers) ? parsed.browsers : [];
  } catch { return []; }
}
export function saveEnvCache(browsers) {
  try { localStorage.setItem(ENV_CACHE_KEY, JSON.stringify({ at: Date.now(), browsers })); } catch { /* quota/best effort */ }
}
