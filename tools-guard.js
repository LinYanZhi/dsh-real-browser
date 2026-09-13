/**
 * real-browser tool registration — security boundary domain:
 * real_browser_policy (URL guard) / work_mode (credential isolation) / vault.
 * Register via registerGuardTools(ctx, tools) from tools.js.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { matchPolicy, readPolicy, addRule, removeRule } from './policy.js';
import { getWorkMode, setWorkMode, vaultSet, vaultGet, vaultList, vaultDelete, vaultHas } from './workmode.js';
import { text, requestPolicyApproval } from './tools-common.js';

export function registerGuardTools(ctx, tools) {
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

    tools.register(defineTool({
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

    tools.register(defineTool({
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
}
