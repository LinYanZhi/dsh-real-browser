/**
 * real-browser tool registration — browser lifecycle & environment domain:
 * real_browser_list / launch / close / allow / env / fingerprint.
 * Register via registerBrowserTools(ctx, tools) from tools.js.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { discoverRunningBrowsers } from './discover.js';
import { launchRealBrowser, closeRealBrowser } from './launch.js';
import { assertAllowed, isAllowed, toggleAllowed, readAllowlist, inferKind } from './allowlist.js';
import { detectEnvironment, readProfiles, optimizeAvatars } from './env.js';
import { auditStealth } from './stealth.js';
import { stopDownloadTracking } from './downloads.js';
import { stopNetworkTracking } from './network.js';
import { text, requestAllowlistGrant } from './tools-common.js';

export function registerBrowserTools(ctx, tools) {
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
}
