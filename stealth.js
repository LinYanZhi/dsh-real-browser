/**
 * Stealth audit + artifact hygiene for driving a REAL browser over CDP.
 *
 * The plugin's security story is "已有浏览器环境控制层": when we attach to a
 * profile the user actually uses (RPA shop environments), we must NOT expose
 * automation in ways a site can detect — no injected enumerable globals, no
 * driver artifacts — while still giving the AI honest feedback about how
 * fingerprintable the driven browser looks.
 *
 * auditStealth() runs an in-page battery of the common automation-detection
 * signals (navigator.webdriver, cdc_* driver artifacts, plugin surface,
 * window.chrome shape, injected dsh-real-browser globals, headless heuristics)
 * and reports each check as clean / flagged. This is INFORMATION, not
 * enforcement: it tells the AI whether the environment looks clean before
 * driving an RPA shop, without ever modifying the page to "fix" fingerprints
 * (that intervention would itself be a detectable, and destructive, act).
 *
 * cleanupStealthArtifacts() removes globals dsh-real-browser injected into the
 * page (the console-capture buffer), so a driven page is left as we found it.
 *
 * Zero npm dependencies — the battery is plain Runtime.evaluate scripts.
 */

import { evaluateJs } from './cdp.js';

/** In-page battery; async because one check needs navigator.permissions. */
const AUDIT_SCRIPT = `(async () => {
  const out = [];
  const json = (v) => JSON.stringify(v, (k, x) =>
    typeof x === 'string' && x.length > 300 ? x.slice(0, 300) + '…' : x);
  const add = (id, name, value, clean) =>
    out.push({ id, name, value: json(value), clean: Boolean(clean) });

  // 1. navigator.webdriver — the single most common automation signal.
  add('webdriver', 'navigator.webdriver', navigator.webdriver, !navigator.webdriver);

  // 2. ChromeDriver (Selenium) artifacts on window.
  const cdc = Object.getOwnPropertyNames(window).filter((n) => n.toLowerCase().includes('cdc_'));
  add('cdc-artifacts', 'window cdc_* driver globals', cdc, cdc.length === 0);

  // 3. Globals dsh-real-browser itself may have injected (console hook etc.).
  const ours = ['__realBrowserConsole'].filter((n) => n in window);
  add('dsh-artifacts', 'dsh-real-browser globals in page', ours, ours.length === 0);

  // 4. Plugin / MIME surface (classic headless used to report 0).
  add('plugins', 'navigator.plugins.length', navigator.plugins.length, navigator.plugins.length > 0);
  add('mimetypes', 'navigator.mimeTypes.length', navigator.mimeTypes.length, navigator.mimeTypes.length > 0);

  // 5. window.chrome shape (its total absence is itself a flag; real Chrome
  //    exposes app/csi/loadTimes/runtime even in normal browsing — but the
  //    presence of app/runtime is shape info, not an automation signal, so
  //    those two are informational and never flag the verdict).
  const hasChrome = typeof window.chrome === 'object' && window.chrome !== null;
  add('chrome', 'window.chrome present', hasChrome, hasChrome);
  if (hasChrome) {
    add('chrome-app', 'window.chrome.app', typeof window.chrome.app === 'object', true);
    add('chrome-runtime', 'window.chrome.runtime', typeof window.chrome.runtime === 'object', true);
  }

  // 6. Permissions state (driven headless browsers often answer 'denied').
  let perm = 'n/a';
  try {
    const s = await navigator.permissions.query({ name: 'notifications' });
    perm = s.state;
  } catch { /* permission API unavailable — informational */ }
  add('permissions-notifications', 'permissions.notifications state', perm, perm !== 'denied');

  // 7. Environment info (informational — always 'clean', value carries data).
  add('useragent', 'navigator.userAgent', navigator.userAgent, true);
  add('languages', 'navigator.languages', Array.isArray(navigator.languages) ? navigator.languages.slice(0, 5) : [], true);
  add('platform', 'navigator.platform', navigator.platform, true);
  add('cores', 'navigator.hardwareConcurrency', navigator.hardwareConcurrency, true);
  add('memory', 'navigator.deviceMemory', navigator.deviceMemory ?? 'n/a', true);
  add('ua-data-brands', 'navigator.userAgentData brands', (navigator.userAgentData?.brands ?? []).map((b) => b.brand), true);
  add('viewport', 'innerWidth x innerHeight', innerWidth + 'x' + innerHeight, true);
  add('outer-delta', 'outerWidth - innerWidth', outerWidth - innerWidth, outerWidth - innerWidth >= 0);

  return JSON.stringify({ url: location.href, checks: out });
})()`;

/** Remove dsh-real-browser-injected globals from the page. */
const CLEANUP_SCRIPT = `(() => {
  const removed = [];
  for (const n of ['__realBrowserConsole']) {
    if (n in window) {
      try { delete window[n]; removed.push(n); }
      catch { try { Object.defineProperty(window, n, { value: undefined, configurable: true, writable: true }); removed.push(n + ' (overwritten)'); } catch { /* unfixable */ } }
    }
  }
  return JSON.stringify({ removed });
})()`;

/**
 * Run the stealth audit battery against the picked page.
 * @returns {Promise<{url: string, checks: Array<{id,name,value,clean}>, verdict: 'clean'|'flagged'}>}
 */
export async function auditStealth(port, opts = {}) {
  const r = await evaluateJs(port, AUDIT_SCRIPT, {
    urlSubstring: opts.urlSubstring,
    awaitPromise: true,
  });
  if (r.__exception) throw new Error(`stealth audit JS error: ${r.text} ${r.description}`.trim());
  let parsed;
  try {
    parsed = JSON.parse(r.value ?? '{}');
  } catch {
    throw new Error('stealth audit returned unparseable data');
  }
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  const verdict = checks.every((c) => c.clean) ? 'clean' : 'flagged';
  return { url: parsed.url ?? '', checks, verdict };
}

/**
 * Remove dsh-real-browser artifacts from the page (console buffer etc.).
 * @returns {Promise<{removed: string[]}>}
 */
export async function cleanupStealthArtifacts(port, opts = {}) {
  const r = await evaluateJs(port, CLEANUP_SCRIPT, { urlSubstring: opts.urlSubstring });
  if (r.__exception) throw new Error(`stealth cleanup JS error: ${r.text} ${r.description}`.trim());
  try {
    return JSON.parse(r.value ?? '{"removed":[]}');
  } catch {
    return { removed: [] };
  }
}
