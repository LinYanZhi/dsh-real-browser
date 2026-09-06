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

import { CdpSession, pickPageTarget, versionInfo, listTargets, evaluateJs } from './cdp.js';
import { collectInteractive } from './snapshot.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect to a page target's CDP session. */
async function withPageSession(port, urlSubstring, fn) {
  const target = await pickPageTarget(port, urlSubstring);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    return await fn(session, target);
  } finally {
    session.close();
  }
}

/** Connect to the browser-level CDP session (for Target.* commands). */
async function withBrowserSession(port, fn) {
  const info = await versionInfo(port);
  if (!info.webSocketDebuggerUrl) throw new Error(`no browser websocket on port ${port}`);
  const session = await CdpSession.connect(info.webSocketDebuggerUrl);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

async function evalInPage(session, expression) {
  const r = await session.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(
      `page JS error: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`.trim(),
    );
  }
  return r.result?.value;
}

/**
 * Resolve a target to { selector?, x, y }. Coordinates come from the element
 * center (or are taken verbatim when x/y are given).
 */
async function resolveTarget(port, target, urlSubstring) {
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return { x: target.x, y: target.y };
  }
  let selector = target.selector;
  if (target.ref) {
    const all = await collectInteractive(port, { urlSubstring });
    const n = Number(String(target.ref).replace(/^e/i, ''));
    const el = all[n - 1];
    if (!el) throw new Error(`ref ${target.ref} not found — re-run real_page_snapshot (DOM may have changed)`);
    selector = el.selector;
  }
  if (!selector) throw new Error('provide a ref, a CSS selector, or x/y coordinates');

  return withPageSession(port, urlSubstring, async (session) => {
    const result = await evalInPage(
      session,
      `(() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        if (els.length === 0) return { found: 0 };
        const el = els[0];
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { found: els.length, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`,
    );
    if (!result || result.found === 0) throw new Error(`no element matched selector "${selector}"`);
    if (result.found > 1) {
      // still proceed with the first match but surface the ambiguity
      return { selector, x: result.x, y: result.y, matched: result.found };
    }
    return { selector, x: result.x, y: result.y, matched: 1 };
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

export async function clickElement(port, { ref, selector, x, y, doubleClick, urlSubstring }) {
  const t = await resolveTarget(port, { ref, selector, x, y }, urlSubstring);
  return mouse(port, urlSubstring, t.x, t.y, doubleClick ? 'dblclick' : 'click');
}

export async function hoverElement(port, { ref, selector, x, y, urlSubstring }) {
  const t = await resolveTarget(port, { ref, selector, x, y }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    await session.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y });
    return { x: t.x, y: t.y };
  });
}

// ---------------------------------------------------------------------------
// Form actions (native setter + events, React/Vue-safe)
// ---------------------------------------------------------------------------

export async function fillElement(port, { ref, selector, value, clear = true, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const r = await evalInPage(
      session,
      `(() => {
        const el = document.querySelector(${JSON.stringify(target.selector)});
        if (!el) return { ok: false, reason: 'not found' };
        const set = (v) => {
          if (el.isContentEditable) { el.textContent = v; return; }
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const next = ${clear ? '""' : 'el.value'} + ${JSON.stringify(value)};
        set(next);
        return { ok: true, value: el.value };
      })()`,
    );
    if (!r?.ok) throw new Error(`fill failed: ${r?.reason ?? 'unknown'}`);
    return r;
  });
}

export async function typeElement(port, { ref, selector, text, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    await evalInPage(session, `(() => { const el = document.querySelector(${JSON.stringify(target.selector)}); if (!el) return false; el.focus(); return true; })()`);
    await session.call('Input.insertText', { text });
    return { typed: text };
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

export async function selectOption(port, { ref, selector, value, text, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const r = await evalInPage(
      session,
      `(() => {
        const el = document.querySelector(${JSON.stringify(target.selector)});
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
      })()`,
    );
    if (!r?.ok) throw new Error(`select failed: ${r?.reason ?? 'unknown'}${r?.options ? ' options: ' + r.options.join(' | ') : ''}`);
    return r;
  });
}

export async function checkElement(port, { ref, selector, checked, urlSubstring }) {
  const target = await resolveTarget(port, { ref, selector }, urlSubstring);
  return withPageSession(port, urlSubstring, async (session) => {
    const r = await evalInPage(
      session,
      `(() => {
        const el = document.querySelector(${JSON.stringify(target.selector)});
        if (!el) return { ok: false, reason: 'not found' };
        const set = (v) => {
          const proto = (el.tagName === 'INPUT' && el.type === 'checkbox') ? HTMLInputElement.prototype : null;
          if (proto) Object.getOwnPropertyDescriptor(proto, 'checked').set.call(el, v);
          else el.checked = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(${checked ? 'true' : 'false'});
        return { ok: true, checked: el.checked };
      })()`,
    );
    if (!r?.ok) throw new Error(`check failed: ${r?.reason ?? 'unknown'}`);
    return r;
  });
}

// ---------------------------------------------------------------------------
// Scroll / wait / find
// ---------------------------------------------------------------------------

export async function scrollPage(port, { ref, selector, direction, pixels, urlSubstring }) {
  return withPageSession(port, urlSubstring, async (session) => {
    if (ref || selector) {
      const target = await resolveTarget(port, { ref, selector }, urlSubstring);
      await evalInPage(session, `document.querySelector(${JSON.stringify(target.selector)}).scrollIntoView({ block: 'center' }); true`);
      return { scrolled: 'element into view' };
    }
    if (!direction) throw new Error('provide a selector/ref to scroll into view, or a direction');
    const dx = direction === 'left' ? -(pixels ?? 400) : direction === 'right' ? (pixels ?? 400) : 0;
    const dy = direction === 'up' ? -(pixels ?? 400) : direction === 'down' ? (pixels ?? 400) : 0;
    await evalInPage(session, `window.scrollBy({ top: ${dy}, left: ${dx}, behavior: 'auto' }); true`);
    return { scrolled: `${direction}${pixels ? ` ${pixels}px` : ''}` };
  });
}

export async function waitFor(port, { selector, text, url, jsCondition, timeMs, timeoutMs = 15000, urlSubstring }) {
  if (timeMs) {
    await sleep(timeMs);
    return { condition: 'delay', satisfied: true, ms: timeMs };
  }
  const conditions = [];
  if (selector) conditions.push(`document.querySelector(${JSON.stringify(selector)}) && (() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
  if (text) conditions.push(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`);
  if (url) conditions.push(`location.href.includes(${JSON.stringify(url)})`);
  if (jsCondition) conditions.push(`(${jsCondition})`);
  if (conditions.length === 0) throw new Error('provide selector, text, url, jsCondition, or timeMs');

  const expr = conditions.map((c) => `(${c})`).join(' && ');
  const start = Date.now();
  const session = await CdpSession.connect((await pickPageTarget(port, urlSubstring)).webSocketDebuggerUrl);
  try {
    while (Date.now() - start < timeoutMs) {
      const r = await session.call('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result?.value === true) return { condition: 'satisfied', satisfied: true, ms: Date.now() - start };
      await sleep(300);
    }
    return { condition: 'timeout', satisfied: false, timedOut: true, ms: Date.now() - start };
  } finally {
    session.close();
  }
}

export async function findElements(port, { selector, max = 20, urlSubstring }) {
  if (!selector) throw new Error('provide a CSS selector to find');
  return withPageSession(port, urlSubstring, async (session) => {
    const list = await evalInPage(
      session,
      `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(0, ${max}).map(el => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100) || undefined,
        href: (el.getAttribute('href') || undefined),
        value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : undefined,
        visible: (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
      })))`,
    );
    return { selector, count: JSON.parse(list ?? '[]').length, elements: JSON.parse(list ?? '[]') };
  });
}

// ---------------------------------------------------------------------------
// Tabs (browser-level Target domain)
// ---------------------------------------------------------------------------

export async function listTabs(port) {
  const targets = await listTargets(port);
  return targets
    .filter((t) => t.type === 'page')
    .map((t, i) => ({ tab: `t${i + 1}`, id: t.id, title: t.title, url: t.url }));
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
// Network (via Performance Resource Timing — no persistent listener needed)
// ---------------------------------------------------------------------------

export async function networkRequests(port, { filter, initiatorType, method, status, max = 100, urlSubstring }) {
  return withPageSession(port, urlSubstring, async (session) => {
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
    if (method) entries = entries.filter((e) => (e.method ?? '').toUpperCase() === method.toUpperCase());
    if (status) entries = entries.filter((e) => e.responseStatus !== null && String(e.responseStatus).startsWith(String(status).replace(/x+/gi, '')));
    return { count: Math.min(entries.length, max), requests: entries.slice(0, max) };
  });
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
  const INJECT = `(() => {
    if (!window.__realBrowserConsole) {
      window.__realBrowserConsole = [];
      for (const level of ['log','info','warn','error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
          window.__realBrowserConsole.push({ level, text: args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ').slice(0, 500) });
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
