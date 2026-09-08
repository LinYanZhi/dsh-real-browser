/**
 * 全局浏览器配置持久化（~/.dsh/realbrowser-config.json）。
 *
 * 语义对齐 GLBT「全局浏览器配置」中的 exe_paths / user_data_dirs 配置项：
 * 检测（real_browser_env / detectEnv）时合并这些用户显式配置的路径，
 * 使不在标准位置的自定义 RPA 目录（如易得客、自建环境）也能被 AI 与
 * 设置页看到，且配置跨会话保留（不像检测结果那样每次重扫）。
 *
 * 结构：
 *   {
 *     "exePaths":      { "edge": "C:\\...\\msedge.exe", "chrome": "C:\\...\\chrome.exe" },
 *     "userDataDirs":  { "edge": ["C:\\...\\Edge Rpa", ...], "chrome": [...] },
 *     "updatedAt":     "<ISO>"
 *   }
 *
 * 单元 = 浏览器类型（kind），目录 = 一个 --user-data-dir。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = path.join(os.homedir(), '.dsh', 'realbrowser-config.json');

const EMPTY = { exePaths: {}, userDataDirs: {}, updatedAt: null };

/** 读取配置（缺失/损坏 → 空配置：不丢数据，读失败不抛）。 */
export function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      return {
        exePaths:
          raw.exePaths && typeof raw.exePaths === 'object' && !Array.isArray(raw.exePaths)
            ? raw.exePaths
            : {},
        userDataDirs:
          raw.userDataDirs && typeof raw.userDataDirs === 'object' && !Array.isArray(raw.userDataDirs)
            ? raw.userDataDirs
            : {},
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      };
    }
  } catch {
    /* fall through */
  }
  return { ...EMPTY };
}

/** 写入配置（单写者，原子性不关键）。 */
export function writeConfig(cfg) {
  const dir = path.dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2));
}

const normDirs = (list) => [...new Set((Array.isArray(list) ? list : []).filter((d) => typeof d === 'string' && d.trim()))];

/** 设置某浏览器的 exe 路径（空串/不存在 → 移除该键）。返回最新配置。 */
export function setExePath(kind, exePath) {
  const cfg = readConfig();
  const exe = String(exePath || '').trim();
  if (exe && existsSync(exe)) cfg.exePaths[kind] = exe;
  else delete cfg.exePaths[kind];
  writeConfig(cfg);
  return cfg;
}

/** 覆盖某浏览器的用户数据目录列表。返回最新配置。 */
export function setUserDataDirs(kind, dirs) {
  const cfg = readConfig();
  const list = normDirs(dirs);
  if (list.length) cfg.userDataDirs[kind] = list;
  else delete cfg.userDataDirs[kind];
  writeConfig(cfg);
  return cfg;
}

/** 追加一个用户数据目录（去重）。返回最新配置。 */
export function addUserDataDir(kind, dir) {
  const cfg = readConfig();
  const list = normDirs(cfg.userDataDirs[kind]);
  const d = String(dir || '').trim();
  if (!d) return cfg;
  if (!list.includes(d)) list.push(d);
  cfg.userDataDirs[kind] = list;
  writeConfig(cfg);
  return cfg;
}

/** 移除一个用户数据目录。返回最新配置。 */
export function removeUserDataDir(kind, dir) {
  const cfg = readConfig();
  const list = normDirs(cfg.userDataDirs[kind]).filter((d) => d !== dir);
  if (list.length) cfg.userDataDirs[kind] = list;
  else delete cfg.userDataDirs[kind];
  writeConfig(cfg);
  return cfg;
}
