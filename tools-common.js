/**
 * Shared helpers for the real-browser tool registration modules.
 * text: render helper. requestAllowlistGrant / requestPolicyApproval: DSH
 * approval-gated grants. assertUrlPolicy: deny hard-block / requireApproval
 * approval for navigate/eval/click. currentPageUrl: current tab URL for guards.
 */
import { evaluateJs } from './cdp.js';
import { matchPolicy } from './policy.js';

const text = (t) => [{ type: 'text', text: t }];

/**
 * 通过 DSH 审批服务（ctx.approval）向用户申请把某个浏览器配置加入允许列表。
 * 用户在 Web GUI 会看到审批卡片（ui-approval 消费 approval/request waterfall），
 * 点「允许」返回 'allowed-once'，点「拒绝」返回 'rejected'。
 * @returns {Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>}
 */
async function requestAllowlistGrant(ctx, exec, kind, userDataDir, profileId) {
  const approval = ctx.get('approval');
  if (approval === undefined) {
    throw new Error(
      '审批服务不可用（approval service 未挂载），无法向用户申请授权。' +
        '请让用户在 DSH 设置 → 浏览器设置 中勾选该配置后重试。',
    );
  }
  if (exec.agent === undefined) {
    throw new Error(
      '当前工具调用缺少 Agent 会话上下文，无法发起审批。' +
        '请让用户在 DSH 设置 → 浏览器设置 中勾选该配置后重试。',
    );
  }
  const display = `${userDataDir}${profileId ? ` / ${profileId}` : ''}`;
  return approval.request({
    agent: exec.agent,
    toolName: 'real_browser_allow',
    reason: `AI 请求允许驱动浏览器配置：${display}。批准后 AI 才能启动/驱动该浏览器（可随时在 设置 → 浏览器设置 撤销）。`,
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    signal: exec.signal,
  });
}

/**
 * URL 策略守卫（第二层边界）：deny 规则硬拦截，requireApproval 规则走审批。
 * deny 不可被 AI 自行绕过（需用户编辑策略文件）；requireApproval 与 allowlist
 * 授权一样经 ctx.approval 弹审批卡片，用户批准（allowed-once）后放行本次操作。
 */
async function requestPolicyApproval(ctx, exec, url, pattern, operation) {
  const approval = ctx.get('approval');
  if (approval === undefined || exec.agent === undefined) {
    throw new Error(
      `URL 策略要求对 ${operation} ${url} 先获得批准（规则 "${pattern}"），但审批服务不可用。` +
        `请用户在 ~/.dsh/realbrowser-policy.json 中调整该规则后重试。`,
    );
  }
  return approval.request({
    agent: exec.agent,
    toolName: 'real_browser_policy',
    reason: `URL 策略要求批准：AI 请求${operation} ${url}（命中 requireApproval 规则 "${pattern}"）。批准后本次操作放行（策略本身不变）。`,
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    signal: exec.signal,
  });
}

/** 对目标 URL 做策略守卫：deny 硬拦截，requireApproval 弹审批。 */
async function assertUrlPolicy(ctx, exec, url, operation) {
  const hit = matchPolicy(url);
  if (hit.deniedBy) {
    throw new Error(
      `URL 策略拦截：${operation} ${url} 命中 deny 规则 "${hit.deniedBy}"。` +
        `AI 不能自行绕过 deny 规则——请用户在 ~/.dsh/realbrowser-policy.json 中调整（或用 real_browser_policy 经审批移除规则）。`,
    );
  }
  if (hit.requireApprovalBy) {
    const outcome = await requestPolicyApproval(ctx, exec, url, hit.requireApprovalBy, operation);
    if (outcome !== 'allowed-once') {
      throw new Error(
        outcome === 'rejected'
          ? `用户拒绝了对 ${operation} ${url} 的批准（规则 "${hit.requireApprovalBy}"），本次操作未执行。`
          : outcome === 'cancelled'
            ? `批准申请被取消，${operation} ${url} 未执行。`
            : `审批通道不可用，${operation} ${url} 未执行。请调整策略后重试。`,
      );
    }
  }
}

/** 当前页 URL（供 eval/click 等「操作当前页」的守卫用）。 */
async function currentPageUrl(port, urlSubstring) {
  const r = await evaluateJs(port, 'location.href', { urlSubstring });
  return typeof r.value === 'string' && r.value ? r.value : '';
}

export { text, requestAllowlistGrant, requestPolicyApproval, assertUrlPolicy, currentPageUrl };
