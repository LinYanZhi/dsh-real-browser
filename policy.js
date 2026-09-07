/**
 * URL policy guard — the second layer of the AI's operation boundary.
 *
 * The allowlist (allowlist.js) gates WHICH browser environment the AI may
 * drive. The URL policy adds per-operation rules on the TARGET URL, above and
 * beyond that: a deny rule hard-blocks operations against matching URLs, and a
 * requireApproval rule makes matching operations go through the DSH approval
 * prompt first. The AI cannot bypass a deny rule on its own — the user must
 * edit the policy.
 *
 * Persisted to ~/.dsh/realbrowser-policy.json:
 *   { "deny": ["https://*.example.com/pay/*", "*checkout*"],
 *     "requireApproval": ["*bank/*"] }
 *
 * Pattern syntax: glob-lite. `*` = any run of characters (including none).
 * A pattern without `*` acts as an exact match. Matching is case-insensitive
 * and applies to the full URL, the host, or host+path — so `*checkout*`
 * matches any URL containing "checkout", and `*.bank.com/*` matches
 * https://login.bank.com/... too.
 *
 * This module is pure data + matching (no ctx/approval) so it is unit-testable;
 * the tools layer owns the approval gating (it holds ctx.approval + exec).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = path.join(os.homedir(), '.dsh', 'realbrowser-policy.json');
const KINDS = ['deny', 'requireApproval'];

/** Read the policy file (missing/corrupt -> empty policy: allow everything). */
export function readPolicy() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      deny: Array.isArray(raw?.deny) ? raw.deny : [],
      requireApproval: Array.isArray(raw?.requireApproval) ? raw.requireApproval : [],
    };
  } catch {
    return { deny: [], requireApproval: [] };
  }
}

/** Write the policy file (creates the parent dir on demand). */
export function writePolicy(policy) {
  const dir = path.dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ deny: policy.deny ?? [], requireApproval: policy.requireApproval ?? [] }, null, 2));
}

/** Convert a glob-lite pattern to a RegExp (`*` -> `.*`, anchored, /i). */
export function patternToRegExp(pattern) {
  const s = String(pattern).trim();
  if (!s) return null;
  const escaped = s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Whether a URL matches a pattern (full URL, host, or host+path). */
export function urlMatchesPattern(url, pattern) {
  const re = patternToRegExp(pattern);
  if (!re) return false;
  if (re.test(url)) return true;
  try {
    const u = new URL(url);
    if (re.test(u.host)) return true;
    if (re.test(`${u.host}${u.pathname}`)) return true;
  } catch {
    /* not a parseable URL — fall through */
  }
  return false;
}

/**
 * Match a URL against the policy. deny takes precedence over requireApproval.
 * @returns {{ deniedBy: string|null, requireApprovalBy: string|null }}
 */
export function matchPolicy(url) {
  const p = readPolicy();
  const deniedBy = p.deny.find((pat) => urlMatchesPattern(url, pat)) ?? null;
  const requireApprovalBy =
    deniedBy === null
      ? p.requireApproval.find((pat) => urlMatchesPattern(url, pat)) ?? null
      : null;
  return { deniedBy, requireApprovalBy };
}

/** Add a rule (kind must be deny|requireApproval); returns the new policy. */
export function addRule(kind, pattern) {
  if (!KINDS.includes(kind)) throw new Error(`policy kind must be one of: ${KINDS.join(', ')}`);
  const p = readPolicy();
  const s = String(pattern).trim();
  if (!s) throw new Error('pattern must not be empty');
  if (!p[kind].includes(s)) p[kind].push(s);
  writePolicy(p);
  return p;
}

/** Remove a rule; returns the new policy. */
export function removeRule(kind, pattern) {
  if (!KINDS.includes(kind)) throw new Error(`policy kind must be one of: ${KINDS.join(', ')}`);
  const p = readPolicy();
  p[kind] = p[kind].filter((x) => x !== pattern);
  writePolicy(p);
  return p;
}
