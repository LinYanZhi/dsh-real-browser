/**
 * Cordis plugin entry: registers the real-browser debugging tools so the DSH
 * AI can drive the browser the user is actually using (real Chrome/Edge
 * profiles, Ziniao fingerprint environments) — NOT the plugin's own Electron
 * sandbox browser.
 *
 * Mount (profile user patch layer, cordis.patch.yml):
 *   - insert:
 *       - id: real-browser-tools
 *         name: dsh-real-browser/tools
 *
 * Tools (31): env/list/launch/close/allow + fingerprint/policy/workmode/vault
 * management, plus the full page-interaction layer (dom/eval/navigate/
 * snapshot/click/fill/type/typeSecret/keys/select/check/hover/scroll/wait/
 * find/tabs/network/upload/console/downloads/captcha).
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { discoverRunningBrowsers } from './discover.js';
import { launchRealBrowser, closeRealBrowser } from './launch.js';
import { assertAllowed, isAllowed, toggleAllowed, readAllowlist, inferKind } from './allowlist.js';
import { listTargets, evaluateJs, readPageDom, navigatePage } from './cdp.js';
import { detectEnvironment, readProfiles, optimizeAvatars } from './env.js';
import { snapshotInteractive } from './snapshot.js';
import { auditStealth, cleanupStealthArtifacts } from './stealth.js';
import { listDownloads, stopDownloadTracking } from './downloads.js';
import { stopNetworkTracking } from './network.js';
import { matchPolicy, readPolicy, addRule, removeRule } from './policy.js';
import { detectCaptcha } from './captcha.js';
import {
  clickElement, hoverElement, fillElement, typeElement, typeSecret, pressKey, selectOption, checkElement,
  scrollPage, waitFor, findElements, listTabs, newTab, switchTab, closeTab,
  networkRequests, uploadFiles, readConsole,
} from './interact.js';
import { getWorkMode, setWorkMode, vaultSet, vaultGet, vaultList, vaultDelete, vaultHas } from './workmode.js';

/** Plugin name used by loader diagnostics. */
export const name = 'real-browser-tools';

/** This plugin consumes the tools registry service. */
export const inject = ['tools'];

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

export function apply(ctx) {
  const tools = ctx.tools;

  tools.register(
    defineTool({
      name: 'real_browser_list',
      description:
        'List the REAL browser instances currently running on this machine — the user\'s actual Chrome/Edge/WebView2 profiles and Ziniao fingerprint environments — with their CDP debug port, user-data-dir, and profile-directory. Instances without a debug port are NOT attachable (relaunch with --remote-debugging-port). Use this first to find which real browser the AI can drive. This complements (not replaces) the plugin\'s own sandbox browser tools.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            instances: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) =>
          text(
            `Found ${value.instances.length} real browser instance(s):\n` +
              value.instances
                .map((i) =>
                  `- ${i.kind} pid=${i.pid}${i.port ? ` port=${i.port}` : ' (no port)'}` +
                  `${i.userDataDir ? ` userDataDir=${i.userDataDir}` : ''}` +
                  `${i.profileId ? ` profile=${i.profileId}` : ''}` +
                  (i.attachable ? ' [attachable]' : ' [not attachable]'),
                )
                .join('\n'),
          ),
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      async execute() {
        return { instances: discoverRunningBrowsers() };
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_browser_launch',
      description:
        'Launch / attach / take over a REAL browser with a real profile (user-data-dir + profile-directory) and a CDP debug port, preserving login state and extensions. Semantics (GLBT start_or_connect): if the same environment is already running WITH a debug port it attaches to it (attached=true, no spawn); if it is running WITHOUT a port it fails by default and succeeds with force:true (kills the lockers, incl. Edge background --no-startup-window holders, and relaunches with the port). IMPORTANT built-in guards: the DEFAULT user-data-dir (e.g. ...\\Edge\\User Data) is refused by Chrome/Edge for remote debugging — this call errors immediately with the reason; a non-existent user-data-dir is refused too (do not create new configs). Only drive existing NON-default environments returned by real_browser_env. ACCESS CONTROL: only profiles the user checked in 设置 → 浏览器设置 (the allowlist) can be driven. If the profile is NOT in the allowlist the call fails with guidance — then either ask the user to check it in settings, or retry with autoGrant:true, which pops an approval prompt and, once the user approves, adds the profile to the allowlist and continues the launch in the same call.',
      parameters: {
        exePath: { type: 'string', required: true, description: 'Path to chrome.exe / msedge.exe / etc.' },
        userDataDir: { type: 'string', required: true, description: 'An EXISTING non-default user-data-dir (--user-data-dir), e.g. from real_browser_env.cdp_environments.' },
        profileId: { type: 'string', description: 'Chrome profile id (--profile-directory), e.g. "Default".' },
        port: { type: 'number', description: 'CDP debug port; a free port is picked when omitted.' },
        url: { type: 'string', description: 'Initial URL to open.' },
        headless: { type: 'boolean', description: 'Launch headless (default false).' },
        force: { type: 'boolean', description: 'Kill a running browser that locks this profile and relaunch with the debug port (default false). Disruptive — only use when the human approves.' },
        waitMs: { type: 'number', description: 'How long to wait for the debug port (default 45000).' },
        autoGrant: { type: 'boolean', description: 'If the profile is not in the allowlist, ask the user for approval (approval prompt in the web GUI); on approval add it to the allowlist and continue the launch. Default false — without it, a non-allowed profile fails with guidance. Do not set true repeatedly after the user rejects.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pid: { oneOf: [{ type: 'number' }, { type: 'null' }] },
            port: { type: 'number' },
            wsUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            tookOver: { type: 'boolean' },
            killed: { type: 'number' },
            attached: { type: 'boolean' },
          },
        },
        render: (args, value) =>
          text(
            value.attached
              ? `Attached to already-running real browser pid=${value.pid} on CDP port ${value.port} (no new process spawned).`
              : value.tookOver
                ? `Took over profile (killed ${value.killed} old browser process(es)) — launched real browser pid=${value.pid} on CDP port ${value.port}.`
                : `Launched real browser pid=${value.pid} on CDP port ${value.port}.`,
          ),
      },
      timeoutMs: 120000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const kind = inferKind(args.exePath);
        // AI 操作边界：只有用户在设置 → 浏览器设置 里勾选的配置才允许拉起。
        if (!isAllowed(kind, args.userDataDir, args.profileId)) {
          if (args.autoGrant === true) {
            const outcome = await requestAllowlistGrant(ctx, exec, kind, args.userDataDir, args.profileId);
            if (outcome !== 'allowed-once') {
              throw new Error(
                outcome === 'rejected'
                  ? `用户拒绝了授权申请，未加入允许列表：${args.userDataDir}${args.profileId ? ` / ${args.profileId}` : ''}。不要再次自动请求授权；请用户自己在 设置 → 浏览器设置 勾选后重试。`
                  : outcome === 'cancelled'
                    ? '授权申请被取消，未加入允许列表。'
                    : '审批通道不可用（approval service 未挂载），无法申请授权。请用户自己在 设置 → 浏览器设置 勾选该配置后重试。',
              );
            }
            toggleAllowed({ kind, userDataDir: args.userDataDir, profileId: args.profileId, allowed: true });
          } else {
            assertAllowed(kind, args.userDataDir, args.profileId);
          }
        }
        return launchRealBrowser(args);
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_browser_close',
      description:
        'Close every browser process that exposes the given CDP debug port (the browser the AI launched/attached). Use to clean up after driving a real browser — the AI should close what it opened rather than leaving stray windows or processes.',
      parameters: {
        port: { type: 'number', required: true, description: 'CDP debug port of the real browser to close (from real_browser_launch / real_browser_list).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { killed: { type: 'number' } },
        },
        render: (_args, value) =>
          text(value.killed > 0 ? `Closed ${value.killed} browser process(es) on that port.` : 'No browser process found on that port (already closed).'),
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const killed = closeRealBrowser(args.port);
        stopDownloadTracking(args.port);
        stopNetworkTracking(args.port);
        return { killed };
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_browser_allow',
      description:
        'Grant or revoke AI access to a real browser profile by adding/removing it from the allowlist (the profiles the user checked in 设置 → 浏览器设置). Granting is gated: the tool asks the user for approval through the web GUI approval prompt and only writes the allowlist after the user approves (allowed-once). Use this when real_browser_launch reports the profile is NOT in the allowlist — instead of asking the user to manually check a checkbox, call this tool to request the grant; on approval, retry real_browser_launch. Do not call repeatedly after the user rejects. Revoking (allowed:false) is not gated (it only removes access).',
      parameters: {
        userDataDir: { type: 'string', required: true, description: 'The browser user-data-dir (--user-data-dir), e.g. "C:\\...\\Chrome Rpa\\ozon".' },
        profileId: { type: 'string', description: 'Profile id (--profile-directory), e.g. "Default".' },
        kind: { type: 'string', enum: ['chrome', 'edge'], description: 'Browser kind. Omit to infer from the user-data-dir path (contains "Chrome" → chrome, else edge).' },
        allowed: { type: 'boolean', description: 'true to grant access (default; requires user approval), false to revoke (immediate).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            granted: { type: 'boolean' },
            already: { type: 'boolean' },
            revoked: { type: 'boolean' },
            outcome: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            environments: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          if (value.revoked) return text('Removed the profile from the allowlist — AI can no longer drive it without a new grant.');
          if (value.already) return text('The profile was already in the allowlist — no change needed.');
          if (value.granted) return text('User approved — profile added to the allowlist. You can now call real_browser_launch for it.');
          return text(`Not granted (outcome: ${value.outcome ?? 'unknown'}). The profile stays outside the allowlist; do not auto-retry the grant.`);
        },
      },
      timeoutMs: 120000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const kind = args.kind ?? (/chrome/i.test(String(args.userDataDir || '')) ? 'chrome' : 'edge');
        const want = args.allowed !== false;
        if (isAllowed(kind, args.userDataDir, args.profileId)) {
          if (want) return { granted: true, already: true, revoked: false, outcome: null, environments: readAllowlist().environments };
          toggleAllowed({ kind, userDataDir: args.userDataDir, profileId: args.profileId, allowed: false });
          return { granted: false, already: false, revoked: true, outcome: null, environments: readAllowlist().environments };
        }
        if (!want) {
          return { granted: false, already: false, revoked: true, outcome: null, environments: readAllowlist().environments };
        }
        const outcome = await requestAllowlistGrant(ctx, exec, kind, args.userDataDir, args.profileId);
        if (outcome !== 'allowed-once') {
          return { granted: false, already: false, revoked: false, outcome, environments: readAllowlist().environments };
        }
        toggleAllowed({ kind, userDataDir: args.userDataDir, profileId: args.profileId, allowed: true });
        return { granted: true, already: false, revoked: false, outcome, environments: readAllowlist().environments };
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_browser_env',
      description:
        'Detect the browser environment on this machine (the foundation layer): which real browsers are installed (Edge / Chrome), exe paths, versions, and every user environment with its CDP capability. IMPORTANT capability model (built-in, do not rediscover): (1) the DEFAULT user-data-dir (e.g. ...\\Edge\\User Data) CANNOT be debug-launched — Chrome/Edge refuse remote debugging on the default data directory, so those profiles are only drivable through the browser\'s own UI; (2) NON-default user-data-dirs (e.g. the RPA environments ...\\Edge\\User Data Rpa) CAN be launched with a CDP debug port — these are listed in cdp_environments with their profiles; (3) attaching to an already-running browser requires it to carry --remote-debugging-port. Purely reads registry/files/process state — does NOT launch or open any page. Use this to decide WHICH environment to drive before acting.',
      parameters: {
        includeAvatars: {
          type: 'boolean',
          description: 'Include avatar base64 data per profile (can be large; default false).',
        },
        userDataDir: {
          type: 'string',
          description: 'Optional custom user-data-dir to read profiles from, instead of the detected defaults.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            browsers: { type: 'array', items: { type: 'object', additionalProperties: true } },
            customProfiles: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (args, value) => {
          const lines = [];
          for (const b of value.browsers) {
            lines.push(`## ${b.browser_name} (${b.browser_type}) — installed=${b.installed}${b.installed ? `, version=${b.browser_version || '(unknown)'}` : ''}`);
            if (!b.installed) continue;
            lines.push(`  exe: ${b.exe_paths.join(' | ')}`);
            lines.push(`  [默认目录 — 不可 CDP] ${b.default_user_data_dir}（Chrome/Edge 拒绝在默认数据目录开调试端口）`);
            lines.push(`    profiles (${b.profiles.length}):`);
            for (const p of b.profiles) {
              const av = p.avatar_base64 ? (args.includeAvatars ? `avatar(${p.avatar_has_icon ? 'icon' : 'image'})` : '(has avatar)') : '';
              lines.push(`      - ${p.id} | name=${p.name}${p.user_name ? ` (${p.user_name})` : ''}${p.email ? ` | ${p.email}` : ''}${av ? ` | ${av}` : ''} | dl=${p.download_dir}`);
            }
            const ce = b.cdp_environments || [];
            if (ce.length) {
              lines.push(`  [可 CDP 驱动的环境]（非默认目录）`);
              for (const env of ce) {
                const tag = env.user_configured ? '（自定义目录）' : '';
                lines.push(`    - ${env.user_data_dir}${tag}`);
                for (const p of env.profiles) {
                  const av = p.avatar_base64 ? (args.includeAvatars ? `avatar(${p.avatar_has_icon ? 'icon' : 'image'})` : '(has avatar)') : '';
                  const restr = p.restriction === 'multi_user' ? ' | 受限=同目录多用户(单实例锁)' : '';
                  lines.push(`        * ${p.id} | name=${p.name}${p.user_name ? ` (${p.user_name})` : ''}${p.email ? ` | ${p.email}` : ''}${av ? ` | ${av}` : ''}${restr}`);
                }
              }
            } else {
              lines.push('  [可 CDP 驱动的环境] （无）');
            }
          }
          if (value.customProfiles?.length) {
            lines.push(`## Custom user-data-dir profiles (${value.customProfiles.length})`);
            for (const p of value.customProfiles) {
              lines.push(`    - ${p.id} | name=${p.name} | dl=${p.download_dir}`);
            }
          }
          return text(lines.join('\n'));
        },
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const wantAvatars = args.includeAvatars === true;
        const browsers = detectEnvironment({ includeAvatars: wantAvatars });
        if (wantAvatars) optimizeAvatars(browsers); // 大头像 → 64px JPEG（缓存），省 context
        const customProfiles = args.userDataDir
          ? readProfiles(args.userDataDir, /edge/i.test(args.userDataDir), wantAvatars)
          : [];
        return { browsers, customProfiles };
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_browser_fingerprint',
      description:
        'Run a stealth audit of the driven REAL browser page (the page the user is looking at): the common automation-detection signals a shop/site could use to fingerprint the environment — navigator.webdriver, ChromeDriver cdc_* artifacts, plugin/mimeType surface, window.chrome shape, permissions state, headless heuristics, and any globals dsh-real-browser itself injected (e.g. the console-capture buffer). Each check reports clean/flagged plus its value, and the verdict is "clean" only when every check is clean. This is INFORMATION for deciding whether an RPA environment looks clean before driving it — the plugin never rewrites the page to "fix" fingerprints (that would itself be a detectable intervention). If dsh-artifacts shows a leftover console buffer, call real_page_console once or run cleanupStealthArtifacts via real_page_eval to remove it; the audit itself does not modify the page.',
      parameters: {
        port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
        urlSubstring: { type: 'string', description: 'Pick the tab whose url/title contains this; default = preferred page.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            verdict: { type: 'string', enum: ['clean', 'flagged'] },
            checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          const lines = [`Stealth audit on ${value.url || '(page)'} — verdict: ${value.verdict.toUpperCase()}`];
          for (const c of value.checks || []) {
            const tag = c.clean ? 'clean  ' : 'FLAGGED';
            lines.push(`  [${tag}] ${c.name} = ${c.value}`);
          }
          return text(lines.join('\n'));
        },
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) {
        return auditStealth(args.port, { urlSubstring: args.urlSubstring });
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_page_list',
      description:
        'List the open pages (tabs) of a real browser attached via its CDP debug port. Use to see what the user has open and pick which page to inspect with real_page_dom / real_page_eval.',
      parameters: {
        port: { type: 'number', required: true, description: 'CDP debug port of the real browser (from real_browser_list).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) =>
          text(
            value.pages.length === 0
              ? 'No open pages on this browser.'
              : value.pages.map((p, i) => `${i + 1}. ${p.title || '(no title)'} — ${p.url}`).join('\n'),
          ),
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const targets = await listTargets(args.port);
        const pages = targets
          .filter((t) => t.type === 'page')
          .map((t) => ({ id: t.id, title: t.title, url: t.url }));
        return { pages };
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_page_dom',
      description:
        'View the DOM of a page in a real browser (the page the user is looking at, with its real login state). Returns the full document HTML capped at maxChars, or one element matched by a CSS selector. Use to inspect real page structure when debugging selectors / scraping logic.',
      parameters: {
        port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
        urlSubstring: { type: 'string', description: 'Pick the tab whose url or title contains this substring; default = first page.' },
        selector: { type: 'string', description: 'CSS selector; returns the first matching element\'s outerHTML instead of the whole document.' },
        maxChars: { type: 'number', description: 'Cap on returned HTML length (default 100000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            html: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            found: { oneOf: [{ type: 'number' }, { type: 'null' }] },
            truncated: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
            __exception: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
          },
        },
        render: (args, value) => {
          if (value.__exception) return text(`JS error: ${value.text} ${value.description}`.trim());
          const head = value.selector
            ? `Selector "${args.selector}" matched ${value.found} element(s):`
            : `Page ${value.url ?? ''}${value.title ? ` — ${value.title}` : ''}:`;
          return text(`${head}\n${value.html ?? '(no html)'}`);
        },
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) {
        return readPageDom(args.port, {
          urlSubstring: args.urlSubstring,
          selector: args.selector,
          maxChars: args.maxChars,
        });
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_page_eval',
      description:
        'Execute JavaScript in a page of a real browser (the page the user is looking at). The expression runs in the page\'s main world, so DOM and app globals are reachable. Returns the serialized value (use JSON.stringify for objects), or the exception details. This is the primary probing tool for debugging: inspect state, click elements (element.click()), read fields, fill inputs, etc.',
      parameters: {
        port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
        expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate in the page.' },
        urlSubstring: { type: 'string', description: 'Pick the tab whose url or title contains this substring; default = first page.' },
        awaitPromise: { type: 'boolean', description: 'Await promises returned by the expression (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'object', additionalProperties: true }, { type: 'null' }] },
            type: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            subtype: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            __exception: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
            text: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        render: (_args, value) => {
          if (value.__exception) {
            return text(`JS exception: ${value.text} ${value.description}`.trim());
          }
          const v = typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
          return text(`=> ${v ?? '(undefined)'}`);
        },
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cur = await currentPageUrl(args.port, args.urlSubstring);
        if (cur) await assertUrlPolicy(ctx, exec, cur, '在页面执行 JS');
        return evaluateJs(args.port, args.expression, {
          urlSubstring: args.urlSubstring,
          awaitPromise: args.awaitPromise,
        });
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_page_navigate',
      description:
        'Navigate a page in a real browser to a URL (CDP Page.navigate). Use to move the driven browser to a specific page. The AI decides which URL is appropriate; be mindful this changes the real browser the human may be using.',
      parameters: {
        port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
        url: { type: 'string', required: true, description: 'The URL to navigate to.' },
        urlSubstring: { type: 'string', description: 'Pick the tab whose url or title contains this substring; default = first page.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            url: { type: 'string' },
            errorText: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            frameId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        render: (_args, value) =>
          text(value.ok ? `Navigated to ${value.url}.` : `Navigation failed: ${value.errorText ?? 'unknown error'}`),
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        await assertUrlPolicy(ctx, exec, args.url, '导航到');
        return navigatePage(args.port, args.url, { urlSubstring: args.urlSubstring });
      },
    }),
  );

  tools.register(
    defineTool({
      name: 'real_browser_policy',
      description:
        'Manage the URL policy guard — the second layer of the AI\'s operation boundary (above the environment allowlist). Rules: "deny" hard-blocks operations whose target URL matches the pattern (the AI cannot bypass it on its own — the user must edit ~/.dsh/realbrowser-policy.json), and "requireApproval" makes matching operations (navigate/eval/click) pop the DSH approval prompt first. Pattern syntax: glob-lite — `*` = any run of characters, no `*` = exact match, case-insensitive, matches full URL / host / host+path (e.g. "*checkout*", "https://*.bank.com/*"). Actions: list (default), add <kind> <pattern> (restricts the AI — free), remove <kind> <pattern> (loosens the AI\'s own constraint — requires user approval).',
      parameters: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], default: 'list', description: 'list (default) | add | remove.' },
        kind: { type: 'string', enum: ['deny', 'requireApproval'], description: 'Rule kind for add/remove.' },
        pattern: { type: 'string', description: 'URL pattern (glob-lite with * wildcards) for add/remove.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            deny: { type: 'array', items: { type: 'string' } },
            requireApproval: { type: 'array', items: { type: 'string' } },
            removed: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            outcome: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        render: (_args, value) => {
          const lines = ['URL policy (deny rules are NOT AI-bypassable; requireApproval rules pop an approval prompt):'];
          lines.push(`  deny: ${value.deny.length ? value.deny.map((p) => `"${p}"`).join(', ') : '(none)'}`);
          lines.push(`  requireApproval: ${value.requireApproval.length ? value.requireApproval.map((p) => `"${p}"`).join(', ') : '(none)'}`);
          if (value.removed) lines.push(`  removed rule: "${value.removed}"`);
          if (value.outcome !== null && value.outcome !== undefined) lines.push(`  approval outcome: ${value.outcome}`);
          return text(lines.join('\n'));
        },
      },
      timeoutMs: 120000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const action = args.action ?? 'list';
        if (action === 'list') {
          const p = readPolicy();
          return { deny: p.deny, requireApproval: p.requireApproval, removed: null, outcome: null };
        }
        if (!args.kind || !args.pattern) throw new Error('add/remove require kind (deny|requireApproval) and pattern');
        if (action === 'add') {
          const p = addRule(args.kind, args.pattern);
          return { deny: p.deny, requireApproval: p.requireApproval, removed: null, outcome: null };
        }
        // remove loosens the AI's own constraint — gate behind user approval.
        const outcome = await requestPolicyApproval(
          ctx,
          exec,
          '(policy edit)',
          args.pattern,
          `移除 ${args.kind} 规则`,
        );
        if (outcome !== 'allowed-once') {
          return { deny: readPolicy().deny, requireApproval: readPolicy().requireApproval, removed: null, outcome };
        }
        const p = removeRule(args.kind, args.pattern);
        return { deny: p.deny, requireApproval: p.requireApproval, removed: args.pattern, outcome };
      },
    }),
  );

  // ── Interaction layer ──────────────────────────────────────────────────────
  // Target model: ref ("e3", from real_page_snapshot) | CSS selector | x/y.
  // Each call site already wraps its options in defineTool(), so register() must
  // not wrap again: feeding a compiled ToolDefinition back into defineTool makes
  // its compiled `parameters` ({ type: 'object', properties, required }) be read
  // as a property map and fails schema compilation ("parameters.type ...").
  const register = (t) => tools.register(t);
  const TARGET = {
    ref: { type: 'string', description: 'Element ref from real_page_snapshot, e.g. "e3".' },
    selector: { type: 'string', description: 'CSS selector matching an element.' },
  };
  const FRAME = {
    frame: {
      type: 'string',
      description:
        'Same-origin iframe path from real_page_snapshot, e.g. "0" (first iframe in the top document) or "0/1" (first iframe inside that one). Omit for the top frame. A ref from a snapshot inside an iframe carries its frame automatically. Cross-origin iframes cannot be reached and are listed separately in the snapshot.',
    },
  };
  const PORT = { port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' } };
  const URLSUB = { urlSubstring: { type: 'string', description: 'Pick the tab whose url/title contains this; default = preferred page.' } };
  const urlOpts = (args) => ({ urlSubstring: args.urlSubstring });

  register(defineTool({
    name: 'real_page_snapshot',
    description:
      'Take an interactive-element snapshot of a page in a real browser. Every clickable/typeable element is numbered with a ref like "e3" plus its role, name, value, center x/y, and a CSS selector. Elements inside SAME-ORIGIN iframes are included and carry a "frame" field (e.g. "0", "0/1"); use that value as the frame argument of interaction tools, or just use the ref (it carries the frame). Cross-origin iframes cannot be reached and are listed in crossOriginFrames. Use this BEFORE interacting — other tools accept ref ("e3") or selector. Refs are per-snapshot: after the DOM changes, re-snapshot. This is the foundation for reliable interaction (agent-browser style).',
    parameters: { ...PORT, ...URLSUB, maxElements: { type: 'number', description: 'Cap on returned elements (default 120).' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { origin: { type: 'string' }, url: { type: 'string' }, elements: { type: 'array', items: { type: 'object', additionalProperties: true } }, crossOriginFrames: { type: 'array', items: { type: 'object', additionalProperties: true } }, truncated: { type: 'boolean' } } },
      render: (args, value) => {
        const lines = [`Page ${value.url || ''} (${value.origin || ''}) — ${value.elements.length} interactive element(s)${value.truncated ? ' (truncated)' : ''}:`];
        for (const el of value.elements) {
          lines.push(`  [${el.ref}]${el.frame ? ` frame=${el.frame}` : ''} <${el.tag}>${el.role ? ` role=${el.role}` : ''}${el.type ? ` type=${el.type}` : ''} ${el.visible ? '' : '(hidden) '}(${el.x},${el.y}) ${el.name ? JSON.stringify(el.name) : ''}${el.value !== undefined ? ` value=${JSON.stringify(String(el.value).slice(0, 40))}` : ''}`);
        }
        for (const f of value.crossOriginFrames || []) {
          lines.push(`  [cross-origin iframe frame=${f.frame} — not reachable from parent context] src=${f.src || '(inline)'}`);
        }
        return text(lines.join('\n'));
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return snapshotInteractive(args.port, { urlSubstring: args.urlSubstring, maxElements: args.maxElements });
    },
  }));

  register(defineTool({
    name: 'real_page_click',
    description: 'Click (or double-click) an element in a real browser, by ref ("e3"), CSS selector, or viewport x/y coordinates. Uses real CDP mouse events at the element center.',
    parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, x: { type: 'number', description: 'Viewport x (with y, instead of ref/selector).' }, y: { type: 'number', description: 'Viewport y (with x).' }, doubleClick: { type: 'boolean', description: 'Double click (default false).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Clicked at (${v.x},${v.y})${v.clickCount > 1 ? ' (double)' : ''}.`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cur = await currentPageUrl(args.port, args.urlSubstring);
      if (cur) await assertUrlPolicy(ctx, exec, cur, '点击页面元素');
      return clickElement(args.port, args);
    },
  }));

  register(defineTool({
    name: 'real_page_fill',
    description: 'Fill an input/textarea/contenteditable in a real browser with a value (native setter + input/change events, React/Vue-safe). clear=true replaces the value; false appends.',
    parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, value: { type: 'string', required: true, description: 'Value to set.' }, clear: { type: 'boolean', description: 'Clear first (default true).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Filled => ${JSON.stringify(v.value)}`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) { return fillElement(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_type',
    description: 'Type text into a focused element in a real browser (focuses the target, then inserts text via CDP Input.insertText — keystroke-like). Use for inputs that react to keydown.',
    parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, text: { type: 'string', required: true, description: 'Text to type.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Typed ${JSON.stringify(v.typed)}`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) { return typeElement(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_type_secret',
    description:
      'Type a VAULT secret into a field of a real browser WITHOUT the secret ever entering the tool arguments or the model context: pass only the vault key (set earlier with real_browser_vault action=set); the value is decrypted host-side (DPAPI) and typed via CDP Input.insertText. Returns only a key marker — the secret is never echoed. Use for login/password entry where the credential must stay invisible to the AI. Errors if the vault key does not exist.',
    parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, vaultKey: { type: 'string', required: true, description: 'Vault key whose secret should be typed (see real_browser_vault).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Typed ${v.typed}.`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) { return typeSecret(args.port, args); },
  }));

  register(defineTool({
    name: 'real_browser_work_mode',
    description:
      'Get or set sensitive Work Mode for credential isolation. When ON, the interaction layer stops echoing values back to the AI: real_page_fill / real_page_type return redacted results for EVERY field, and real_page_snapshot masks all input values (password fields are masked in ALL modes regardless of this switch). Turn it ON before a login/password-entry flow ("登录/填密环节 agent 不可见") and OFF after. State is per-session (resets when DSH restarts).',
    parameters: {
      action: { type: 'string', enum: ['get', 'set'], default: 'get', description: 'get (default) | set.' },
      enabled: { type: 'boolean', description: 'Desired state for action=set.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { sensitive: { type: 'boolean' } } },
      render: (_args, v) => text(v.sensitive ? 'Work Mode: SENSITIVE (values are redacted from AI context).' : 'Work Mode: normal (values echoed; password fields always redacted).'),
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.action === 'set') setWorkMode(args.enabled === true);
      return { sensitive: getWorkMode() };
    },
  }));

  register(defineTool({
    name: 'real_browser_vault',
    description:
      'Manage the encrypted credential vault (~/.dsh/realbrowser-vault.json): each value is encrypted at rest with Windows DPAPI (machine+user bound — only this machine/user can decrypt; the file never contains plaintext). Actions: set (store/overwrite a secret under a key), get (decrypt + return a secret — exposes it to the AI; prefer real_page_type_secret for typing it into a page), list (keys only, never values), delete. Use set for enrollment (user supplies the credential once), then real_page_type_secret with just the key for every later use.',
    parameters: {
      action: { type: 'string', enum: ['set', 'get', 'list', 'delete'], required: true, description: 'set | get | list | delete.' },
      key: { type: 'string', description: 'Vault key (required for set/get/delete).' },
      value: { type: 'string', description: 'Secret to store (required for action=set; encrypted before writing).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stored: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          value: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          keys: { type: 'array', items: { type: 'string' } },
          deleted: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: (args, v) => {
        if (args.action === 'list') return text(v.keys.length ? `vault keys: ${v.keys.join(', ')}` : 'vault is empty');
        if (args.action === 'set') return text(`stored vault key "${v.stored}" (DPAPI-encrypted at rest).`);
        if (args.action === 'delete') return text(`deleted vault key "${v.deleted}".`);
        return text(`vault["${args.key}"] = ${v.value === null ? '(not found)' : JSON.stringify(v.value)}`);
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.action === 'set') {
        if (!args.key || args.value === undefined) throw new Error('action=set requires key and value');
        vaultSet(args.key, args.value);
        return { stored: args.key, value: null, keys: vaultList(), deleted: null };
      }
      if (args.action === 'get') {
        if (!args.key) throw new Error('action=get requires key');
        return { stored: null, value: vaultHas(args.key) ? vaultGet(args.key) : null, keys: vaultList(), deleted: null };
      }
      if (args.action === 'list') return { stored: null, value: null, keys: vaultList(), deleted: null };
      if (args.action === 'delete') {
        if (!args.key) throw new Error('action=delete requires key');
        vaultDelete(args.key);
        return { stored: null, value: null, keys: vaultList(), deleted: args.key };
      }
      throw new Error('unknown vault action');
    },
  }));

  register(defineTool({
    name: 'real_page_press_key',
    description: 'Press a key or combination in a real browser, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a".',
    parameters: { ...PORT, ...URLSUB, key: { type: 'string', required: true, description: 'Key name or combination like "Enter" or "Control+a".' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Pressed ${v.key}.`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) { return pressKey(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_select',
    description: 'Select an option in a <select> in a real browser, by option value or visible text.',
    parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, value: { type: 'string', description: 'Option value to select.' }, text: { type: 'string', description: 'Option text to select (substring).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Selected value=${JSON.stringify(v.value)}`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) { return selectOption(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_check',
    description: 'Check or uncheck a checkbox/radio in a real browser (native setter + change event).',
    parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, checked: { type: 'boolean', description: 'Desired state (default true).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`checked=${v.checked}`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) { return checkElement(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_hover',
    description: 'Move the mouse over an element in a real browser (by ref/selector/x,y). Useful to trigger hover menus/tooltips.',
    parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, x: { type: 'number' }, y: { type: 'number' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Hovered at (${v.x},${v.y}).`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) { return hoverElement(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_scroll',
    description: 'Scroll a real browser page: pass a ref/selector to scroll that element into view, or pass direction (up/down/left/right) + pixels to scroll the window.',
    parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (with pixels).' }, pixels: { type: 'number', description: 'Scroll distance (default 400).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Scrolled: ${v.scrolled}`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) { return scrollPage(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_wait',
    description: 'Wait for a condition in a real browser: element (visible), text, URL substring, JS expression, or a fixed delay. Returns satisfied=true when met, or satisfied=false + timedOut=true (does NOT throw on timeout).',
    parameters: { ...PORT, ...URLSUB, ...FRAME, selector: { type: 'string', description: 'Wait for this element to be visible.' }, text: { type: 'string', description: 'Wait for this text (substring).' }, url: { type: 'string', description: 'Wait for URL containing this.' }, jsCondition: { type: 'string', description: 'JS expression to wait for, e.g. "window.ready === true" (runs in the given frame\'s document when frame is provided).' }, timeMs: { type: 'number', description: 'Fixed delay in ms.' }, timeoutMs: { type: 'number', description: 'Max wait (default 15000).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.satisfied ? `Condition satisfied after ${v.ms}ms.` : `Timed out after ${v.ms}ms.`) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) { return waitFor(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_find',
    description: 'Find elements matching a CSS selector in a real browser and return their tag/id/text/href/value/visibility. For inspecting what a selector matches before interacting.',
    parameters: { ...PORT, ...URLSUB, ...FRAME, selector: { type: 'string', required: true, description: 'CSS selector.' }, max: { type: 'number', description: 'Max results (default 20).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Found ${v.count} element(s) for "${v.selector}".`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) { return findElements(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_tabs',
    description: 'Manage tabs of a real browser over CDP: action list | new | switch | close. list returns tabs with ids ("t1"..). switch/close take a target id; new opens a URL (default about:blank).',
    parameters: { ...PORT, action: { type: 'string', enum: ['list', 'new', 'switch', 'close'], default: 'list' }, target: { type: 'string', description: 'Tab id (t1) for switch/close.' }, url: { type: 'string', description: 'URL for action=new.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, v) => {
      if (args.action === 'list' || args.action === undefined) return text(v.tabs ? v.tabs.map((t, i) => `${i + 1}. [${t.tab}] ${t.title || '(no title)'} — ${t.url}`).join('\n') || '(none)' : 'done');
      return text(`tabs ${args.action}: done`);
    } },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = args.action ?? 'list';
      if (action === 'list') return { tabs: await listTabs(args.port) };
      if (action === 'new') return newTab(args.port, args.url);
      if (action === 'switch') return switchTab(args.port, args.target);
      if (action === 'close') return closeTab(args.port, args.target);
      throw new Error(`unknown tabs action: ${action}`);
    },
  }));

  register(defineTool({
    name: 'real_page_network',
    description:
      'List network requests observed for a page in a real browser. The FIRST call activates live CDP Network capture on the picked tab (persistent listener, like downloads tracking) and returns the page\'s resource-timing history for immediate value; later calls return the live captures. Live capture carries the real HTTP method/status/resource type — resource timing does not, so a `method` filter only matches once live capture is active (re-call after the request). Filters: URL substring, initiator/resource type (e.g. xhr, fetch, script, image), HTTP method, response status prefix (e.g. "2", "4").',
    parameters: { ...PORT, ...URLSUB, filter: { type: 'string', description: 'URL substring filter.' }, initiatorType: { type: 'string', description: 'e.g. xhr, fetch, script, image (live: resource type like XHR/Fetch/Script).' }, method: { type: 'string', description: 'HTTP method (live capture only).' }, status: { type: 'string', description: 'Status prefix, e.g. "2", "4".' }, max: { type: 'number', description: 'Max results (default 100).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`${v.count} request(s)${v.live ? ' [live capture]' : ''}:\n` + (v.requests || []).map((r) => `  ${r.responseStatus ?? r.status ?? '—'} ${r.method ?? ''} ${r.initiatorType ?? r.type ?? ''} ${Math.round(r.duration)}ms ${r.url}`).join('\n') + (v.note ? `\n  note: ${v.note}` : '')) },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) { return networkRequests(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_upload',
    description: 'Set the files of a file <input> in a real browser via CDP DOM.setFileInputFiles (real file selection, works with upload forms).',
    parameters: { ...PORT, ...TARGET, ...URLSUB, files: { type: 'array', items: { type: 'string' }, required: true, description: 'Absolute file paths.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Uploaded ${v.uploaded.length} file(s).`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) { return uploadFiles(args.port, args); },
  }));

  register(defineTool({
    name: 'real_page_console',
    description: 'Read console messages captured by a real browser page (log/info/warn/error), optionally clearing the buffer. Capture starts when this tool first runs (injects a console hook).',
    parameters: { ...PORT, ...URLSUB, clear: { type: 'boolean', description: 'Clear after reading (default true).' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.entries.map((e) => `[${e.level}] ${e.text}`).join('\n') || `No console messages (count=${v.count}).`) },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) { return readConsole(args.port, { clear: args.clear, urlSubstring: args.urlSubstring }); },
  }));

  register(defineTool({
    name: 'real_page_captcha',
    description:
      'Scan the page in a real browser for captcha widgets: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, Geetest, NetEase Yidun, Aliyun noCaptcha, and generic iframe/image captcha heuristics. Each hit carries a confidence (iframe-family matches ~0.95, DOM widgets ~0.7-0.8, generic ~0.5). Passive read-only scan. When verdict=detected, the AI should STOP automated steps and let the user solve the captcha in the browser window — this is the high-frequency RPA shop-login pain point.',
    parameters: {
      port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
      urlSubstring: { type: 'string', description: 'Pick the tab whose url/title contains this; default = preferred page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          verdict: { type: 'string', enum: ['none', 'detected'] },
          detected: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        if (value.verdict === 'none') return text(`No captcha detected on ${value.url || '(page)'}.`);
        const lines = [`Captcha DETECTED on ${value.url || '(page)'} — stop automated steps and let the user solve it:`];
        for (const h of value.detected) lines.push(`  - ${h.type} (confidence ${h.confidence}): ${h.detail}`);
        return text(lines.join('\n'));
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return detectCaptcha(args.port, { urlSubstring: args.urlSubstring });
    },
  }));

  register(defineTool({
    name: 'real_page_downloads',
    description:
      'List downloads tracked for a real browser over CDP (from when tracking was first activated on this port): suggested filename, URL, byte progress, and state (inProgress/completed/canceled). Tracking activates on the first call, keeps a persistent listener, and redirects downloads for that browser to `downloadDir` (default: the user\'s Downloads folder, so files keep landing where expected). Downloads that happened BEFORE the first call are not recorded. Use after triggering a download in the page to verify it started/finished. clear=true empties the tracked list after reading. Returns tracking:false when the browser is unreachable.',
    parameters: {
      port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
      downloadDir: { type: 'string', description: 'Where downloaded files land while tracking is active (default: the user\'s Downloads folder).' },
      clear: { type: 'boolean', description: 'Clear the tracked list after reading (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tracking: { type: 'boolean' },
          downloads: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, v) => {
        if (!v.tracking) return text('Download tracking is not active — the browser on this port is unreachable.');
        if (v.downloads.length === 0) return text('No downloads tracked yet (tracking is active; downloads trigger when the page saves a file).');
        return text(
          `Download tracking active — ${v.downloads.length} download(s):\n` +
            v.downloads
              .map((d) => `  [${d.state}] ${d.suggestedFilename ?? '(unnamed)'} — ${d.receivedBytes}/${d.totalBytes} bytes — ${d.url}`)
              .join('\n'),
        );
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) { return listDownloads(args.port, { clear: args.clear, downloadDir: args.downloadDir }); },
  }));
}
