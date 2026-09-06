/**
 * AI 操作边界（allowlist）：用户勾选允许 AI 操作的浏览器配置。
 *
 * 持久化到 ~/.dsh/realbrowser-allowlist.json，host 工具与 RPC 共读。
 * 未勾选的配置，AI 的 launch/attach 会被拒绝（"不在允许列表"）。
 *
 * 单元 = 一个浏览器配置：(kind, userDataDir, profileId)。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = path.join(os.homedir(), '.dsh', 'realbrowser-allowlist.json');

/** 读取允许列表（缺失/损坏 → 空列表：默认全部不允许，用户显式勾选才放行）。 */
export function readAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    if (raw && Array.isArray(raw.environments)) return raw;
  } catch { /* fall through */ }
  return { environments: [] };
}

/** 写入允许列表（原子性不关键，单写者）。 */
export function writeAllowlist(list) {
  const dir = path.dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

/** 该配置是否被允许。profileId 未指定时按 userDataDir 层匹配（同目录任意 profile 放行）。 */
export function isAllowed(kind, userDataDir, profileId) {
  const list = readAllowlist();
  return list.environments.some(
    (e) =>
      e.userDataDir === userDataDir &&
      (e.profileId === undefined || e.profileId === '' || e.profileId === profileId),
  );
}

/** 断言允许，否则抛错（launch/attach 入口调用）。 */
export function assertAllowed(kind, userDataDir, profileId) {
  if (!isAllowed(kind, userDataDir, profileId)) {
    throw new Error(
      `浏览器配置不在 AI 允许列表内：${userDataDir}${profileId ? ` / ${profileId}` : ''}。` +
        `请在 DSH 设置 → 浏览器设置 中勾选该配置后重试（AI 只可操作已勾选的配置）。`,
    );
  }
}

/** 切换某个配置的允许状态，返回最新列表。 */
export function toggleAllowed({ kind, userDataDir, profileId, allowed }) {
  const list = readAllowlist();
  const key = (e) => `${e.kind}\u0000${e.userDataDir}\u0000${e.profileId ?? ''}`;
  const target = `${kind}\u0000${userDataDir}\u0000${profileId ?? ''}`;
  list.environments = list.environments.filter((e) => key(e) !== target);
  if (allowed) list.environments.push({ kind, userDataDir, ...(profileId ? { profileId } : {}) });
  writeAllowlist(list);
  return list;
}

/** 从 exePath 推断浏览器 kind（chrome/edge），供未显式传 kind 的调用兜底。 */
export function inferKind(exePath) {
  return /chrome\.exe$/i.test(String(exePath || '')) ? 'chrome' : 'edge';
}
