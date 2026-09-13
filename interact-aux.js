/**
 * Auxiliary page primitives over CDP for a REAL browser — tabs management,
 * live network capture, file upload, and console capture. Split from
 * interact.js (core click/fill/type/etc.) so each module stays lean.
 */
import { listTargets } from './cdp.js';
import { ensureNetworkTracking, readNetwork } from './network.js';
import { withPageSession, withBrowserSession, evalInPage, resolveTarget } from './interact.js';

// Tabs (browser-level Target domain)
// ---------------------------------------------------------------------------

export async function listTabs(port) {
  const targets = await listTargets(port);
  return targets
    .filter((t) => t.type === 'page')
    .map((t, i) => ({ tab: `t${i + 1}`, id: t.id, title: t.title ?? '', url: t.url ?? '' }));
}

export async function newTab(port, url) {
  return withBrowserSession(port, async (session) => {
    const t = await session.call('Target.createTarget', { url: url ?? 'about:blank' });
    if (url) await session.call('Target.activateTarget', { targetId: t.targetId });
    return { id: t.targetId };
  });
}

export async function switchTab(port, targetId) {
  return withBrowserSession(port, async (session) => {
    await session.call('Target.activateTarget', { targetId });
    return { activated: targetId };
  });
}

export async function closeTab(port, targetId) {
  return withBrowserSession(port, async (session) => {
    const r = await session.call('Target.closeTarget', { targetId });
    return { closed: r.success ?? true, id: targetId };
  });
}

// ---------------------------------------------------------------------------
// Network (live CDP Network capture + resource-timing fallback)
// ---------------------------------------------------------------------------

/**
 * List network requests for a page. The FIRST call activates live CDP Network
 * capture on the picked tab (like downloads tracking) and returns the page's
 * resource-timing history for immediate value; subsequent calls return the
 * live captures (which carry the real HTTP method — resource timing does not,
 * so a `method` filter only matches once live capture is active).
 */
export async function networkRequests(port, { filter, initiatorType, method, status, max = 100, urlSubstring }) {
  // 1. Live capture: activate on first call; use live entries when present.
  let liveActive = false;
  let liveReq = [];
  try {
    await ensureNetworkTracking(port, { urlSubstring });
    liveActive = true;
    const live = await readNetwork(port, { filter, initiatorType, method, status, max });
    liveReq = live?.requests ?? [];
  } catch {
    liveActive = false;
  }

  // 2. Resource-timing fallback: for the first call (live buffer empty) or
  //    when capture could not start. No method data here.
  const fallback = await withPageSession(port, urlSubstring, async (session) => {
    const list = await evalInPage(
      session,
      `JSON.stringify(performance.getEntriesByType('resource').slice(-200).map(e => ({
        url: e.name, initiatorType: e.initiatorType, duration: Math.round(e.duration),
        transferSize: e.transferSize, responseStatus: e.responseStatus ?? null,
      })))`,
    );
    let entries = JSON.parse(list ?? '[]');
    if (filter) entries = entries.filter((e) => e.url.includes(filter));
    if (initiatorType) entries = entries.filter((e) => e.initiatorType === initiatorType);
    if (status) entries = entries.filter((e) => e.responseStatus !== null && String(e.responseStatus).startsWith(String(status).replace(/x+/gi, '')));
    return { count: Math.min(entries.length, max), requests: entries.slice(0, max) };
  });

  // A `method` filter only exists on live capture — never fall back to
  // resource timing for it (that path has no method data and would return
  // unfiltered rows, silently wrong).
  if (method) {
    return {
      live: liveActive,
      count: liveReq.length,
      requests: liveReq,
      ...(liveActive && liveReq.length === 0
        ? { note: 'no live request matched yet — requests that happen after capture activation are recorded; re-call after the request.' }
        : !liveActive
          ? { note: 'method filter needs live capture; the first real_page_network call activates it — re-call after the request.' }
          : {}),
    };
  }

  // Live data wins when it has anything.
  if (liveActive && liveReq.length > 0) {
    return { live: true, count: liveReq.length, requests: liveReq };
  }
  return { live: liveActive, count: fallback.count, requests: fallback.requests };
}

// ---------------------------------------------------------------------------
// Upload (real file chooser injection via CDP DOM domain)
// ---------------------------------------------------------------------------

export async function uploadFiles(port, { ref, selector, files, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const doc = await session.call('DOM.getDocument', { depth: -1, pierce: true });
    const node = await session.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: target.selector });
    if (!node.nodeId) throw new Error(`no input found for selector "${target.selector}"`);
    await session.call('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
    return { uploaded: files };
  });
}

// ---------------------------------------------------------------------------
// Console capture (in-page hook, read + clear)
// ---------------------------------------------------------------------------

export async function readConsole(port, { clear = true, urlSubstring } = {}) {
  // The capture buffer lives on window.__realBrowserConsole but is defined
  // NON-enumerable, so for..in / JSON.stringify(window) never expose it to the
  // page (stealth hygiene: driving the user's real profile must not leave
  // enumerable driver artifacts a shop site could fingerprint). Reads still
  // work, and real_browser_fingerprint / cleanupStealthArtifacts can see and
  // remove it.
  const INJECT = `(() => {
    if (!window.__realBrowserConsole) {
      const buf = [];
      try {
        Object.defineProperty(window, '__realBrowserConsole', { value: buf, configurable: true, writable: true, enumerable: false });
      } catch {
        window.__realBrowserConsole = buf; // last resort: enumerable fallback
      }
      for (const level of ['log','info','warn','error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
          // Re-resolve each call so a clear (which swaps in a fresh array)
          // keeps capturing; falls back to the closure buffer if deleted.
          (window.__realBrowserConsole || buf).push({ level, text: args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ').slice(0, 500) });
          orig(...args);
        };
      }
    }
    return true;
  })()`;
  return withPageSession(port, urlSubstring, async (session) => {
    await evalInPage(session, INJECT);
    const data = await evalInPage(
      session,
      clear
        ? `(() => { const all = window.__realBrowserConsole || []; window.__realBrowserConsole = []; return JSON.stringify(all); })()`
        : `JSON.stringify(window.__realBrowserConsole || [])`,
    );
    let entries = [];
    try {
      entries = JSON.parse(data ?? '[]');
    } catch { /* ignore */ }
    return { count: entries.length, entries };
  });
}

