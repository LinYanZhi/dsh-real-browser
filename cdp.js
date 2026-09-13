/**
 * Minimal zero-dependency CDP (Chrome DevTools Protocol) client.
 *
 * Built on Node's built-in WebSocket + fetch (Node >= 22). Speaks just enough
 * CDP to attach to a REAL browser — the user's Chrome/Edge profile or a Ziniao
 * fingerprint environment — and drive it for development debugging:
 * list targets, evaluate JS, read page DOM.
 *
 * No npm dependencies on purpose: it runs inside a DSH profile where adding
 * packages can hit pnpm allowBuilds / half-install pitfalls.
 */

/** The browser HTTP endpoint exposed by `--remote-debugging-port`. */
export async function httpJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(
      `CDP endpoint unreachable: ${url} (${e.message}) — the browser on this port is likely closed; verify with real_browser_list / real_browser_env.`,
    );
  }
  if (!res.ok) {
    throw new Error(`CDP HTTP ${res.status} for ${url}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(
      `CDP endpoint ${url} returned non-JSON HTTP ${res.status} — the port may be occupied by a non-browser service; pick a different port.`,
    );
  }
}

/** GET /json/version — the browser-level info (webSocketDebuggerUrl etc.). */
export function versionInfo(port) {
  return httpJson(`http://127.0.0.1:${port}/json/version`);
}

/** GET /json/list — every debug target (pages, iframes, workers, ...). */
export function listTargets(port) {
  return httpJson(`http://127.0.0.1:${port}/json/list`);
}

/** One WebSocket connection to a CDP endpoint (browser or page level). */
export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg?.id !== 'number') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    });
  }

  /** Connect to a `webSocketDebuggerUrl`. */
  static async connect(wsUrl, timeoutMs = 10000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout to ${wsUrl}`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect error to ${wsUrl} — the browser on this port may be closed; verify with real_browser_list.`));
      });
    });
    return new CdpSession(ws);
  }

  /** Send one CDP command and await its matching response. */
  async call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

/** Whether a page URL is a blank/startup placeholder (about:blank, newtab...). */
function isBlankUrl(url) {
  if (!url) return true;
  return (
    url === 'about:blank' ||
    url.startsWith('chrome://newtab') ||
    url.startsWith('edge://newtab') ||
    url.startsWith('chrome://startpages') ||
    url.startsWith('about:newtab')
  );
}

/** Whether a page URL is a real website (http/https), not an internal page. */
function isHttpUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

/**
 * Pick the page target to drive. With a `urlSubstring` it must match. Without
 * one, prefer the first real website page (http/https) — Chrome/Edge spawn
 * transient internal targets at startup (about:blank, edge://sync-confirmation,
 * newtab) that would otherwise shadow the page the user actually opened, and
 * freshly restored sessions can still be navigating. So when no urlSubstring
 * is given, retry briefly for a real http(s) page before falling back.
 */
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verify a picked target's document is actually committed: right after a
 * navigation the target's URL in /json/list is already the new page but the
 * document may still be the about:blank frame — evaluating then runs on the
 * blank frame. Returns true when the committed location is a real page.
 */
async function isCommitted(target) {
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    const r = await session.call('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    const href = String(r.result?.value ?? '');
    return href !== '' && !isBlankUrl(href);
  } catch {
    return false;
  } finally {
    session.close();
  }
}

/** Pick a candidate from a page list; prefer committed documents when possible. */
async function pickCommitted(candidates, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  for (const candidate of candidates) {
    if (await isCommitted(candidate)) return candidate;
  }
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await isCommitted(candidate)) return candidate;
    }
    await sleepMs(400);
  }
  return candidates[0];
}

export async function pickPageTarget(port, urlSubstring) {
  const read = async () => {
    const targets = await listTargets(port);
    return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  };

  if (urlSubstring) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pages = await read();
      const hits = pages.filter(
        (p) => p.url.includes(urlSubstring) || (p.title ?? '').includes(urlSubstring),
      );
      if (hits.length > 0) return pickCommitted(hits);
      if (attempt < 4) await sleepMs(400);
    }
    const pages = await read();
    throw new Error(
      `no page matching "${urlSubstring}" on port ${port}; open pages: ${pages.map((p) => p.url).join(', ') || '(none)'}`,
    );
  }

  // Default: wait up to ~2s for a real website page to be present.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pages = await read();
    if (pages.length === 0) {
      throw new Error(`no page target on port ${port} (browser has no open pages)`);
    }
    const real = pages.filter((p) => isHttpUrl(p.url));
    if (real.length > 0) return pickCommitted(real);
    if (attempt < 4) await sleepMs(400);
  }
  const pages = await read();
  if (pages.length === 0) {
    throw new Error(`no page target on port ${port} (browser has no open pages)`);
  }
  const real = pages.filter((p) => isHttpUrl(p.url));
  const preferred = real.length > 0 ? real : pages.filter((p) => !isBlankUrl(p.url));
  return pickCommitted(preferred.length > 0 ? preferred : pages);
}

/**
 * Evaluate JS in a page. `expression` runs in the page's main world; DOM and
 * app globals are reachable. Returns the serialized value (returnByValue) or
 * the exception details when the script throws.
 */
export async function evaluateJs(port, expression, opts = {}) {
  const target = await pickPageTarget(port, opts.urlSubstring);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    const r = await session.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: Boolean(opts.awaitPromise),
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const out = { __exception: true, text: d.text, description: d.exception?.description ?? d.exception?.value ?? '' };
      if (d.lineNumber !== undefined) out.line = d.lineNumber;
      return out;
    }
    // Build the result with no undefined fields — the tool framework rejects
    // values that do not round-trip losslessly through JSON. JS expressions
    // may legitimately evaluate to undefined (e.g. `void 0`) — map to null.
    const out = { value: r.result?.value ?? null };
    if (r.result?.type) out.type = r.result.type;
    if (r.result?.subtype) out.subtype = r.result.subtype;
    return out;
  } finally {
    session.close();
  }
}

/**
 * Read a page's DOM (or one element matched by a CSS selector), capped at
 * `maxChars`. This is the "view the page the user is looking at" tool.
 */
export async function readPageDom(port, opts = {}) {
  const maxChars = opts.maxChars ?? 100_000;
  const expression = opts.selector
    ? `(() => {
        const els = document.querySelectorAll(${JSON.stringify(opts.selector)});
        if (els.length === 0) return JSON.stringify({ found: 0, selector: ${JSON.stringify(opts.selector)} });
        return JSON.stringify({ found: els.length, html: els[0].outerHTML });
      })()`
    : `JSON.stringify({ url: location.href, title: document.title, html: document.documentElement.outerHTML })`;

  // Startup transient: right after launch the target's URL is already set in
  // /json/list but its document has not committed yet — Runtime.evaluate then
  // runs on the about:blank frame. Retry briefly for a real (non-blank)
  // document unless the caller pinned a tab via urlSubstring.
  const isBlankDoc = (parsed) =>
    !parsed?.url || parsed.url === 'about:blank' || /^(chrome|edge):\/\/(newtab|startpages)/.test(parsed.url || '');

  let parsed;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = await evaluateJs(port, expression, { urlSubstring: opts.urlSubstring });
    if (r.__exception) return r;
    try {
      parsed = JSON.parse(r.value ?? 'null');
    } catch {
      parsed = { raw: r.value };
    }
    if (!isBlankDoc(parsed) || opts.urlSubstring || attempt >= 5) break;
    await sleepMs(500);
  }
  if (parsed && typeof parsed.html === 'string' && parsed.html.length > maxChars) {
    parsed.html = `${parsed.html.slice(0, maxChars)}\n… [truncated at ${maxChars} chars]`;
    parsed.truncated = true;
  }
  return parsed;
}

/**
 * Navigate the picked page to a URL (CDP Page.navigate). The caller decides
 * which URL is appropriate; this only performs the navigation.
 */
export async function navigatePage(port, url, opts = {}) {
  const target = await pickPageTarget(port, opts.urlSubstring);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    const r = await session.call('Page.navigate', { url });
    const out = { ok: !r.errorText, url };
    if (r.errorText) out.errorText = r.errorText;
    if (r.frameId) out.frameId = r.frameId;
    return out;
  } finally {
    session.close();
  }
}
