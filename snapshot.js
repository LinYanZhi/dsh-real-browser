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

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider',
  'tab', 'searchbox', 'spinbutton', 'gridcell',
]);

/**
 * In-page collection script. Returns the list of interactive elements.
 * Kept as a string so it can be eval'd in the page (no closure capture).
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
  const cssPath = (el) => {
    if (el.id) {
      const s = '#' + CSS.escape(el.id);
      try { if (document.querySelectorAll(s).length === 1) return s; } catch {}
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
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (!isInteractive(node)) continue;
    const r = node.getBoundingClientRect();
    const item = {
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role') || undefined,
      name: nameOf(node) || undefined,
      type: node.getAttribute('type') || undefined,
      value: (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') ? node.value : undefined,
      visible: visible(node),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      selector: cssPath(node),
    };
    out.push(item);
  }
  return JSON.stringify(out);
})()`;

/**
 * Collect the interactive elements of the current page.
 * @returns {Promise<Array>} elements with ref assigned here (e1..eN).
 */
export async function collectInteractive(port, opts = {}) {
  const r = await evaluateJs(port, COLLECT_SCRIPT, { urlSubstring: opts.urlSubstring });
  if (r.__exception) throw new Error(`snapshot JS error: ${r.text} ${r.description}`.trim());
  let list = [];
  try {
    list = JSON.parse(r.value ?? '[]');
  } catch {
    throw new Error('snapshot returned unparseable data');
  }
  return list.map((el, i) => ({ ...el, ref: `e${i + 1}` }));
}

/**
 * Full interactive snapshot for the AI: origin + elements (+ optional caps).
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

  const elements = await collectInteractive(port, opts);
  const max = opts.maxElements ?? 120;
  const truncated = elements.length > max;
  return { origin, url, elements: truncated ? elements.slice(0, max) : elements, truncated };
}
