/**
 * Interactive-element snapshot with compact element refs.
 *
 * Runs an in-page collection (via Runtime.evaluate) that walks the DOM and
 * numbers every interactive element `e1..eN` with:
 *   ref, tag, role, name, value/type (form fields), visible, center x/y,
 *   and a generated CSS selector.
 *
 * The ref is the interaction handle: `real_page_click(ref: "e3")` etc.
 * Refs are per-snapshot — after the DOM changes, re-snapshot (same model as
 * agent-browser's `@eN` refs).
 */

import { evaluateJs } from './cdp.js';
import { getWorkMode } from './workmode.js';

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider',
  'tab', 'searchbox', 'spinbutton', 'gridcell',
]);

/**
 * In-page collection script. Walks the top document AND every reachable
 * same-origin iframe (recursively), numbering every interactive element
 * `e1..eN`. Elements inside an iframe carry a `frame` field: a slash-joined
 * path of iframe indices, e.g. `"0"` (first iframe in the top document) or
 * `"0/1"` (first iframe inside that one). Same-origin frames are reachable
 * from the parent document; cross-origin iframes cannot be reached and are
 * reported separately in `crossOriginFrames` ({frame, src}) so the AI knows
 * the page has untouchable frames.
 * Returns { elements, crossOriginFrames }.
 */
const COLLECT_SCRIPT = `(() => {
  const INTERACTIVE_ROLES = new Set(${JSON.stringify([...INTERACTIVE_ROLES])});
  const isInteractive = (el) => {
    const tag = el.tagName;
    if (tag === 'BUTTON') return true;
    if (tag === 'A' && el.href) return true;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    const tab = el.getAttribute('tabindex');
    if (tab !== null && Number(tab) >= 0) return true;
    return false;
  };
  const cssPath = (doc, el) => {
    if (el.id) {
      const s = '#' + CSS.escape(el.id);
      try { if (doc.querySelectorAll(s).length === 1) return s; } catch {}
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const nameOf = (el) => {
    // Credential isolation: a password field is always labeled (password) —
    // before placeholder/title, so neither its value nor its semantics leak.
    if (el.tagName === 'INPUT' && (el.type === 'password')) return '(password)';
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.getAttribute('title')) return el.getAttribute('title');
    if (el.getAttribute('alt')) return el.getAttribute('alt');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || '';
    if (el.tagName === 'SELECT') {
      const o = el.options[el.selectedIndex];
      return o ? o.text : '';
    }
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  };
  const visible = (el) => {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const out = [];
  const crossOriginFrames = [];
  // ox/oy = cumulative iframe offset so reported x/y are TOP-VIEWPORT
  // coordinates (what CDP Input.dispatchMouseEvent expects), not iframe-local.
  const collectInDoc = (doc, framePath, ox, oy) => {
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (!isInteractive(node)) continue;
      const r = node.getBoundingClientRect();
      out.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || undefined,
        role: node.getAttribute('role') || undefined,
        name: nameOf(node) || undefined,
        type: node.getAttribute('type') || undefined,
        // Credential isolation: password values are masked IN-PAGE (never
        // leave the browser); sensitive work mode masks every field value.
        value: (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA')
          ? (node.type === 'password' ? '[redacted]' : node.value)
          : undefined,
        visible: visible(node),
        x: Math.round(r.left + r.width / 2 + ox),
        y: Math.round(r.top + r.height / 2 + oy),
        selector: cssPath(doc, node),
        frame: framePath || undefined,
      });
    }
    const iframes = doc.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i += 1) {
      const f = iframes[i];
      const childPath = framePath ? framePath + '/' + i : String(i);
      let cd = null;
      try { cd = f.contentDocument; } catch { cd = null; }
      if (cd && (cd.body || cd.documentElement)) {
        const fr = f.getBoundingClientRect();
        collectInDoc(cd, childPath, ox + fr.left, oy + fr.top);
      } else {
        crossOriginFrames.push({ frame: childPath, src: f.src || undefined });
      }
    }
  };
  collectInDoc(document, '', 0, 0);
  return JSON.stringify({ elements: out, crossOriginFrames });
})()`;

/**
 * Collect the interactive elements of the current page AND its reachable
 * same-origin iframes, assigning refs `e1..eN` (depth-first, top document
 * first). Elements from an iframe carry `frame` (a slash-joined iframe path).
 * @returns {Promise<Array>} elements with ref assigned here (e1..eN).
 */
export async function collectAll(port, opts = {}) {
  const r = await evaluateJs(port, COLLECT_SCRIPT, { urlSubstring: opts.urlSubstring });
  if (r.__exception) throw new Error(`snapshot JS error: ${r.text} ${r.description}`.trim());
  let parsed;
  try {
    parsed = JSON.parse(r.value ?? '{}');
  } catch {
    throw new Error('snapshot returned unparseable data');
  }
  return {
    elements: (parsed.elements ?? []).map((el, i) => {
      // Sensitive work mode: mask every field value server-side too (in case a
      // page exposes a secret through a non-password field).
      if (getWorkMode() && el.value !== undefined && el.value !== '[redacted]') {
        el = { ...el, value: '[redacted]' };
      }
      return { ...el, ref: `e${i + 1}` };
    }),
    crossOriginFrames: parsed.crossOriginFrames ?? [],
  };
}

/** @returns {Promise<Array>} the interactive elements only (refs e1..eN). */
export async function collectInteractive(port, opts = {}) {
  const { elements } = await collectAll(port, opts);
  return elements;
}

/**
 * Full interactive snapshot for the AI: origin + url + elements (+ iframe
 * info + optional caps).
 */
export async function snapshotInteractive(port, opts = {}) {
  const urlInfo = await evaluateJs(port, `JSON.stringify({ origin: location.origin, url: location.href })`, {
    urlSubstring: opts.urlSubstring,
  });
  let origin = '';
  let url = '';
  try {
    const info = JSON.parse(urlInfo.value ?? '{}');
    origin = info.origin ?? '';
    url = info.url ?? '';
  } catch { /* keep empty */ }

  const { elements, crossOriginFrames } = await collectAll(port, opts);
  const max = opts.maxElements ?? 120;
  const truncated = elements.length > max;
  return { origin, url, elements: truncated ? elements.slice(0, max) : elements, crossOriginFrames, truncated };
}
