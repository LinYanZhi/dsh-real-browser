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
 * Tools (31) are registered from three domain modules:
 *   tools-browser.js — browser lifecycle & environment (list/launch/close/allow/env/fingerprint)
 *   tools-page.js    — page interaction (dom/eval/navigate/snapshot/click/fill/…/downloads)
 *   tools-guard.js   — security boundary (policy/work_mode/vault)
 * Shared helpers live in tools-common.js.
 */

/** Plugin name used by loader diagnostics. */
export const name = 'real-browser-tools';

/** This plugin consumes the tools registry service. */
export const inject = ['tools'];

import { registerBrowserTools } from './tools-browser.js';
import { registerPageTools } from './tools-page.js';
import { registerGuardTools } from './tools-guard.js';

export function apply(ctx) {
  registerBrowserTools(ctx, ctx.tools);
  registerPageTools(ctx, ctx.tools);
  registerGuardTools(ctx, ctx.tools);
}
