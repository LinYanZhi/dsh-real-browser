/**
 * dsh-real-browser — Host 面 Cordis 插件。
 *
 * 注册 `realBrowser` service（与 typert.js 清单的 service/namespace 对应），
 * 由 typert 网关桥接到 `ctx.remote.realBrowser`，供 DSH web 客户端
 * （浏览器设置栏目）调用：环境检测 / 允许列表 / 启动 / 关闭。
 *
 * 关键：服务对象必须挂不可枚举的 `typertRemote` 绑定
 * `{ service, serviceKey, namespace }`（照 dsh-cost-meter 的写法），
 * 否则网关报 "Service has no visible typertRemote binding"。
 *
 * AI 操作边界：launch 前先 assertAllowed —— 用户未在设置里勾选的浏览器配置，
 * AI 一律拒绝操作（范围/边界由用户勾选决定）。
 *
 * Mount（profile 用户 patch 层，用裸包名，client 扫描才认）：
 *   - insert:
 *       - id: real-browser
 *         name: dsh-real-browser
 */

import { detectEnvironment } from './env.js';
import { discoverRunningBrowsers } from './discover.js';
import { launchRealBrowser, closeRealBrowser } from './launch.js';
import { readAllowlist, toggleAllowed, assertAllowed, inferKind } from './allowlist.js';
import { readPolicy, addRule, removeRule } from './policy.js';
import { getWorkMode, setWorkMode } from './workmode.js';

/** Plugin name used by loader diagnostics. */
export const name = 'real-browser-host';

/**
 * Build the realBrowser service with the Typert Remote binding the gateway
 * requires, then provide it.
 */
export function apply(ctx) {
  const service = {
    async detectEnv(includeAvatars = false) {
      return { browsers: detectEnvironment({ includeAvatars: Boolean(includeAvatars) }) };
    },
    async listRunning() {
      return { instances: discoverRunningBrowsers() };
    },
    /** 当前允许列表（含检测到的全部环境 + 各自允许状态）。 */
    async getAllowlist() {
      return { environments: readAllowlist().environments };
    },
    /**
     * 切换某个配置的允许状态（用户在设置里勾选/取消）。
     * Typert 网关按清单参数顺序位置调用服务方法（对照 dsh-cost-meter），
     * 因此签名必须是 (kind, userDataDir, profileId, allowed)，
     * 与 typert.js 的 setAllowed invocation 参数一致——否则只收到第一个参数。
     */
    async setAllowed(kind, userDataDir, profileId, allowed) {
      return { environments: toggleAllowed({ kind, userDataDir, profileId, allowed }).environments };
    },
    /** 启动前强制校验允许列表——不在列表内直接拒绝。参数顺序与 typert.js launch 一致。 */
    async launch(exePath, userDataDir, profileId, port, url, headless, force) {
      assertAllowed(inferKind(exePath), userDataDir, profileId);
      return launchRealBrowser({ exePath, userDataDir, profileId, port, url, headless, force });
    },
    async close(port) {
      return { killed: closeRealBrowser(port) };
    },
    /** 当前 URL 策略（deny / requireApproval 规则）。 */
    async getPolicy() {
      return readPolicy();
    },
    /** 新增一条策略规则（用户/设置页操作，无审批——用户即权威）。 */
    async policyAdd(kind, pattern) {
      return { policy: addRule(kind, pattern) };
    },
    /** 移除一条策略规则（设置页操作，无审批）。 */
    async policyRemove(kind, pattern) {
      return { policy: removeRule(kind, pattern) };
    },
    /** 当前凭证隔离 Work Mode。 */
    async getWorkMode() {
      return { sensitive: getWorkMode() };
    },
    /** 切换凭证隔离 Work Mode。 */
    async setWorkMode(enabled) {
      return { sensitive: setWorkMode(Boolean(enabled)) };
    },
  };

  // Typert gateway binding (non-enumerable, mirrors dsh-cost-meter).
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: 'realBrowser', namespace: 'realBrowser' },
  });

  ctx.provide('realBrowser', service);
}
