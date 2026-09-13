/**
 * Interaction primitives over CDP for a REAL browser.
 *
 * Target model (matches agent-browser's `@eN` refs):
 *   - ref      "e3"  — the 3rd interactive element from the last real_page_snapshot
 *   - selector "css" — any CSS selector (must match exactly one element)
 *   - x/y            — viewport coordinates (for click / hover)
 *
 * fill/check/select use the native value setter + input/change events so
 * React/Vue controlled inputs update correctly. click/hover use real CDP
 * mouse events at the element's coordinates.
 */

import { CdpSession, pickPageTarget, versionInfo } from './cdp.js';
import { collectInteractive } from './snapshot.js';
import { getWorkMode, vaultGet } from './workmode.js';
import { ensureNetworkTracking, readNetwork } from './network.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the JS prologue that resolves a frame path to `__root` (a Document).
 * A frame path is a slash-joined list of iframe indices from real_page_snapshot:
 *   ""    -> the top document
 *   "0"   -> the first iframe of the top document
 *   "0/1" -> the first iframe inside that one
 * Same-origin frames are reachable from the parent; a cross-origin or vanished
 * iframe throws inside the page with a specific message. `__ox`/`__oy` carry
 * the cumulative iframe offset so element coordinates can be converted from
 * iframe-local to TOP-VIEWPORT (what CDP Input.dispatchMouseEvent expects).
 */
function framePrologue(framePath) {
  if (!framePath) return 'const __root = document; const __ox = 0, __oy = 0;';
  const parts = String(framePath).split('/').filter(Boolean);
  let code = 'let __root = document; let __ox = 0, __oy = 0;';
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid iframe path segment "${p}" in "${framePath}" — use the frame field from real_page_snapshot`);
    }
    code +=
      `\n{ const __ifr = __root.querySelectorAll('iframe')[${n}];` +
      ` if (!__ifr) throw new Error(${JSON.stringify(`frame ${framePath}: iframe [${n}] gone — re-snapshot`)});` +
      ` const __r = __ifr.getBoundingClientRect(); __ox += __r.left; __oy += __r.top;` +
      ` __root = __ifr.contentDocument;` +
      ` if (!__root) throw new Error(${JSON.stringify(`frame ${framePath}: iframe [${n}] is cross-origin — cannot reach from the parent context`)}); }`;
  }
  return code;
}

/**
 * Wrap a `(() => {...})()` body so it runs against `__root` (the document of
 * the given frame, or the top document when framePath is empty). The body's
 * `document.` references are rewritten to `__root.` so selectors resolve
 * inside the frame.
 */
function framed(framePath, body) {
  const rooted = body.replaceAll('document.', '__root.');
  return rooted.replace(/^\(\(\) => \{/, `(() => { ${framePrologue(framePath)}`);
}

/** Connect to a page target's CDP session. */
export async function withPageSession(port, urlSubstring, fn) {
  const target = await pickPageTarget(port, urlSubstring);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    return await fn(session, target);
  } finally {
    session.close();
  }
}

/** Connect to the browser-level CDP session (for Target.* commands). */
export async function withBrowserSession(port, fn) {
  const info = await versionInfo(port);
  if (!info.webSocketDebuggerUrl) throw new Error(`no browser websocket on port ${port}`);
  const session = await CdpSession.connect(info.webSocketDebuggerUrl);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

export async function evalInPage(session, expression) {
  const r = await session.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(
      `page JS error: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`.trim(),
    );
  }
  return r.result?.value;
}

/**
 * Resolve a target to { selector?, frame?, x, y }. Coordinates come from the
 * element center (or are taken verbatim when x/y are given). A ref carries its
 * snapshot frame; a bare selector resolves in the top frame unless `frame` is
 * passed explicitly.
 */
export async function resolveTarget(port, target, urlSubstring) {
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return { x: target.x, y: target.y };
  }
  let selector = target.selector;
  let frame = target.frame;
  if (target.ref) {
    const all = await collectInteractive(port, { urlSubstring });
    const n = Number(String(target.ref).replace(/^e/i, ''));
    const el = all[n - 1];
    if (!el) throw new Error(`ref ${target.ref} not found — re-run real_page_snapshot (DOM may have changed)`);
    selector = el.selector;
    frame = el.frame ?? frame;
  }
  if (!selector) throw new Error('provide a ref, a CSS selector, or x/y coordinates');

  return withPageSession(port, urlSubstring, async (session) => {
    const result = await evalInPage(
      session,
      framed(frame, `(() => {
        const els = __root.querySelectorAll(${JSON.stringify(selector)});
        if (els.length === 0) return { found: 0 };
        const el = els[0];
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { found: els.length, x: Math.round(r.left + r.width / 2 + __ox), y: Math.round(r.top + r.height / 2 + __oy) };
      })()`),
    );
    if (!result || result.found === 0) {
      throw new Error(`no element matched selector "${selector}"${frame ? ` in iframe ${frame}` : ''}`);
    }
    if (result.found > 1) {
      // still proceed with the first match but surface the ambiguity
      return { selector, frame, x: result.x, y: result.y, matched: result.found };
    }
    return { selector, frame, x: result.x, y: result.y, matched: 1 };
  });
}

// ---------------------------------------------------------------------------
// Mouse actions
// ---------------------------------------------------------------------------

async function mouse(port, urlSubstring, x, y, action) {
  const clickCount = action === 'dblclick' ? 2 : 1;
  return withPageSession(port, urlSubstring, async (session) => {
    await session.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (let i = 0; i < clickCount; i += 1) {
      await session.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i + 1 });
      await session.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i + 1 });
    }
    return { x, y, clickCount };
  });
}

export async function clickElement(port, { ref, selector, frame, x, y, doubleClick, urlSubstring }) {
  const t = await resolveTarget(port, { ref, selector, frame, x, y }, urlSubstring);
  return mouse(port, urlSubstring, t.x, t.y, doubleClick ? 'dblclick' : 'click');
}

export async function hoverElement(port, { ref, selector, frame, x, y, urlSubstring }) {
  const t = await resolveTarget(port, { ref, selector, frame, x, y }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    await session.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y });
    return { x: t.x, y: t.y };
  });
}

// ---------------------------------------------------------------------------
// Form actions (native setter + events, React/Vue-safe)
// ---------------------------------------------------------------------------

export async function fillElement(port, { ref, selector, frame, value, clear = true, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector, frame }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const r = await evalInPage(
      session,
      framed(target.frame, `(() => {
        const el = __root.querySelector(${JSON.stringify(target.selector)});
        if (!el) return { ok: false, reason: 'not found' };
        const set = (v) => {
          if (el.isContentEditable) { el.textContent = v; return; }
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // contenteditable has no .value — append against textContent there.
        const base = el.isContentEditable ? (${clear ? '""' : 'el.textContent'}) : (${clear ? '""' : 'el.value'});
        const next = base + ${JSON.stringify(value)};
        set(next);
        return { ok: true, value: el.value, type: (el.tagName === 'INPUT' ? (el.type || 'text') : null) };
      })()`),
    );
    if (!r?.ok) throw new Error(`fill failed: ${r?.reason ?? 'unknown'}`);
    // Credential isolation: never echo a password field's value; in sensitive
    // mode never echo ANY field's value.
    if (r.type === 'password' || getWorkMode()) {
      return { ok: true, filled: true, redacted: true, type: r.type };
    }
    return r;
  });
}

export async function typeElement(port, { ref, selector, frame, text, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector, frame }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const focus = await evalInPage(session, framed(target.frame, `(() => { const el = __root.querySelector(${JSON.stringify(target.selector)}); if (!el) return { ok: false }; el.focus(); return { ok: true, type: (el.tagName === 'INPUT' ? (el.type || 'text') : null) }; })()`));
    if (!focus?.ok) throw new Error('type target not found');
    await session.call('Input.insertText', { text });
    // Credential isolation: redact the echo for password fields (always) and
    // for every field in sensitive mode.
    if (focus.type === 'password' || getWorkMode()) return { typed: '[redacted]' };
    return { typed: text };
  });
}

/**
 * Type a VAULT secret into a field without the secret ever entering the tool
 * arguments or the model context: the caller passes only the vault key; the
 * value is decrypted host-side and typed via CDP. Returns only a key marker.
 */
export async function typeSecret(port, { vaultKey, ref, selector, frame, urlSubstring }) {
  if (!vaultKey || typeof vaultKey !== 'string') throw new Error('vaultKey is required');
  const secret = vaultGet(vaultKey);
  if (secret === undefined) {
    throw new Error(
      `vault key "${vaultKey}" not found — set it first with real_browser_vault action=set (the value is encrypted at rest with DPAPI).`,
    );
  }
  const target = await resolveTarget(port, { ref, selector, frame }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const focus = await evalInPage(session, framed(target.frame, `(() => { const el = __root.querySelector(${JSON.stringify(target.selector)}); if (!el) return { ok: false }; el.focus(); return { ok: true }; })()`));
    if (!focus?.ok) throw new Error('type target not found');
    await session.call('Input.insertText', { text: secret });
    return { typed: `[from vault: ${vaultKey}]` };
  });
}

export async function pressKey(port, { key, urlSubstring }) {
  // Parse combos like "Control+a" / "Enter" / "Shift+Tab".
  const parts = String(key).split('+');
  const MOD_BITS = { alt: 1, control: 2, meta: 4, shift: 8 };
  const modifiers = parts
    .slice(0, -1)
    .map((m) => ({ control: 'control', ctrl: 'control', alt: 'alt', shift: 'shift', meta: 'meta', command: 'meta' })[m.toLowerCase()])
    .filter(Boolean)
    .reduce((acc, m) => acc | (MOD_BITS[m] ?? 0), 0);
  const main = parts[parts.length - 1];
  const KEYMAP = {
    Enter: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27], Esc: ['Escape', 'Escape', 27],
    Backspace: ['Backspace', '', 8], Delete: ['Delete', '', 46], ArrowUp: ['ArrowUp', 'ArrowUp', 38],
    ArrowDown: ['ArrowDown', 'ArrowDown', 40], ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
    Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34],
    Space: [' ', ' ', 32], F5: ['F5', 'F5', 116],
  };
  return withPageSession(port, urlSubstring, async (session) => {
    const entry = KEYMAP[main];
    if (entry) {
      const [keyName, code, vk] = entry;
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
    } else if (main.length === 1) {
      const vk = main.toUpperCase().charCodeAt(0);
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: main, code: `Key${main.toUpperCase()}`, windowsVirtualKeyCode: vk, modifiers });
      await session.call('Input.dispatchKeyEvent', { type: 'char', text: main, key: main, code: `Key${main.toUpperCase()}`, windowsVirtualKeyCode: vk, modifiers });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: main, code: `Key${main.toUpperCase()}`, windowsVirtualKeyCode: vk, modifiers });
    } else {
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: main, modifiers });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: main, modifiers });
    }
    return { key, pressed: true };
  });
}

export async function selectOption(port, { ref, selector, frame, value, text, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector, frame }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const r = await evalInPage(
      session,
      framed(target.frame, `(() => {
        const el = __root.querySelector(${JSON.stringify(target.selector)});
        if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'not a <select>' };
        let idx = -1;
        for (let i = 0; i < el.options.length; i++) {
          const o = el.options[i];
          if (${value !== undefined ? `o.value === ${JSON.stringify(value)}` : 'false'} || ${text !== undefined ? `o.text.includes(${JSON.stringify(text)})` : 'false'}) { idx = i; break; }
        }
        if (idx < 0) return { ok: false, reason: 'no matching option', options: Array.from(el.options).map(o => o.text) };
        el.selectedIndex = idx;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      })()`),
    );
    if (!r?.ok) throw new Error(`select failed: ${r?.reason ?? 'unknown'}${r?.options ? ' options: ' + r.options.join(' | ') : ''}`);
    return r;
  });
}

export async function checkElement(port, { ref, selector, frame, checked, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector, frame }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const r = await evalInPage(
      session,
      framed(target.frame, `(() => {
        const el = __root.querySelector(${JSON.stringify(target.selector)});
        if (!el) return { ok: false, reason: 'not found' };
        const set = (v) => {
          const proto = (el.tagName === 'INPUT' && el.type === 'checkbox') ? HTMLInputElement.prototype : null;
          if (proto) Object.getOwnPropertyDescriptor(proto, 'checked').set.call(el, v);
          else el.checked = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(${checked ? 'true' : 'false'});
        return { ok: true, checked: el.checked };
      })()`),
    );
    if (!r?.ok) throw new Error(`check failed: ${r?.reason ?? 'unknown'}`);
    return r;
  });
}

// ---------------------------------------------------------------------------
// Scroll / wait / find
// ---------------------------------------------------------------------------

export async function scrollPage(port, { ref, selector, frame, direction, pixels, urlSubstring }) {
  return withPageSession(port, urlSubstring, async (session) => {
    if (ref || selector) {
      const target = await resolveTarget(port, { ref, selector, frame }, urlSubstring);
      await evalInPage(session, framed(target.frame, `(() => { __root.querySelector(${JSON.stringify(target.selector)}).scrollIntoView({ block: 'center' }); return true; })()`));
      return { scrolled: 'element into view' };
    }
    if (!direction) throw new Error('provide a selector/ref to scroll into view, or a direction');
    const dx = direction === 'left' ? -(pixels ?? 400) : direction === 'right' ? (pixels ?? 400) : 0;
    const dy = direction === 'up' ? -(pixels ?? 400) : direction === 'down' ? (pixels ?? 400) : 0;
    await evalInPage(session, `window.scrollBy({ top: ${dy}, left: ${dx}, behavior: 'auto' }); true`);
    return { scrolled: `${direction}${pixels ? ` ${pixels}px` : ''}` };
  });
}

export async function waitFor(port, { selector, text, url, jsCondition, frame, timeMs, timeoutMs = 15000, urlSubstring }) {
  if (timeMs) {
    await sleep(timeMs);
    return { condition: 'delay', satisfied: true, ms: timeMs };
  }
  const conditions = [];
  if (selector) conditions.push(`__root.querySelector(${JSON.stringify(selector)}) && (() => { const e = __root.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
  if (text) conditions.push(`__root.body && __root.body.innerText.includes(${JSON.stringify(text)})`);
  if (url) conditions.push(`location.href.includes(${JSON.stringify(url)})`);
  if (jsCondition) conditions.push(`(${frame ? String(jsCondition).replaceAll('document.', '__root.') : jsCondition})`);
  if (conditions.length === 0) throw new Error('provide selector, text, url, jsCondition, or timeMs');

  // Evaluate the whole condition set inside the chosen frame's document so
  // selectors/text resolve there; a vanished/cross-origin frame keeps polling
  // until the timeout (same as any other unmet condition).
  const expr = `(() => { ${framePrologue(frame)} ; return (${conditions.map((c) => `(${c})`).join(' && ')}); })()`;
  const start = Date.now();
  const session = await CdpSession.connect((await pickPageTarget(port, urlSubstring)).webSocketDebuggerUrl);
  try {
    while (Date.now() - start < timeoutMs) {
      const r = await session.call('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (!r.exceptionDetails && r.result?.value === true) return { condition: 'satisfied', satisfied: true, ms: Date.now() - start };
      await sleep(300);
    }
    return { condition: 'timeout', satisfied: false, timedOut: true, ms: Date.now() - start };
  } finally {
    session.close();
  }
}

export async function findElements(port, { selector, frame, max = 20, urlSubstring }) {
  if (!selector) throw new Error('provide a CSS selector to find');
  return withPageSession(port, urlSubstring, async (session) => {
    const list = await evalInPage(
      session,
      framed(frame, `(() => {
        return JSON.stringify(Array.from(__root.querySelectorAll(${JSON.stringify(selector)})).slice(0, ${max}).map(el => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100) || undefined,
          href: (el.getAttribute('href') || undefined),
          value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : undefined,
          visible: (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
        })));
      })()`),
    );
    const parsed = JSON.parse(list ?? '[]');
    return { selector, count: parsed.length, elements: parsed };
  });
}

// ---------------------------------------------------------------------------
