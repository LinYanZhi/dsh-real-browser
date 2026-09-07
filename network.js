/**
 * Live network capture for a REAL browser over CDP (Network domain).
 *
 * Performance Resource Timing (the old real_page_network source) has no HTTP
 * method — a `method` filter on it was always empty. This module fixes that
 * properly: ONE persistent page-level WebSocket per port opts into the CDP
 * Network domain and records requestWillBeSent / responseReceived /
 * loadingFinished into a ring buffer (last 500), giving real method, URL,
 * resource type, status and duration for requests that happen AFTER the
 * recorder is active.
 *
 * Lifecycle mirrors downloads.js: the first call activates capture, the
 * session closes itself when the browser goes away, and real_browser_close /
 * stopNetworkTracking tears it down. Requests before activation are not
 * recorded — callers fall back to resource timing for those.
 */

import { pickPageTarget, CdpSession } from './cdp.js';

/** port -> { session, entries: [], enabled } */
const recorders = new Map();

/**
 * Activate live network capture on a port (idempotent). Returns the recorder.
 * @param {number} port - CDP debug port.
 * @param {{urlSubstring?: string}} [opts] - which tab to listen to.
 * @returns {Promise<{enabled: boolean, entries: Array}>}
 */
export async function ensureNetworkTracking(port, opts = {}) {
  const existing = recorders.get(port);
  if (existing) return existing;

  const target = await pickPageTarget(port, opts.urlSubstring);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  const recorder = { port, session, entries: [], enabled: true };
  const pending = new Map(); // requestId -> partial entry

  try {
    await session.call('Network.enable', {});
  } catch (e) {
    session.close();
    throw new Error(`could not enable Network domain on port ${port}: ${e.message}`);
  }

  session.ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (typeof msg?.method !== 'string') return;
    const p = msg.params;
    if (msg.method === 'Network.requestWillBeSent') {
      pending.set(p.requestId, {
        requestId: p.requestId,
        method: p.request?.method ?? 'GET',
        url: p.request?.url ?? '',
        type: p.type ?? 'Other',
        start: p.timestamp ?? 0,
      });
    } else if (msg.method === 'Network.responseReceived') {
      const e = pending.get(p.requestId);
      if (e) {
        e.status = p.response?.status ?? null;
        e.statusText = p.response?.statusText ?? '';
      }
    } else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
      const e = pending.get(p.requestId);
      if (!e) return;
      pending.delete(p.requestId);
      if (msg.method === 'Network.loadingFailed') {
        e.status = e.status ?? 0;
        e.failed = p.errorText ?? true;
      }
      e.duration = Math.round(((p.timestamp ?? e.start) - e.start) * 1000);
      recorder.entries.push(e);
      if (recorder.entries.length > 500) recorder.entries.splice(0, recorder.entries.length - 500);
    }
  });

  const drop = () => recorders.delete(port);
  session.ws.addEventListener('close', drop);
  session.ws.addEventListener('error', drop);

  recorders.set(port, recorder);
  return recorder;
}

/** Apply the same filters as the tool (url substring / type / method / status). */
function applyFilters(entries, { filter, initiatorType, method, status, max = 100 }) {
  let out = entries;
  if (filter) out = out.filter((e) => e.url.includes(filter));
  if (initiatorType) out = out.filter((e) => String(e.type ?? '').toLowerCase() === String(initiatorType).toLowerCase());
  if (method) out = out.filter((e) => String(e.method ?? '').toUpperCase() === String(method).toUpperCase());
  if (status) out = out.filter((e) => e.status !== null && e.status !== undefined && String(e.status).startsWith(String(status).replace(/x+/gi, '')));
  return out.slice(-max).reverse();
}

/**
 * Read live entries for a port. Returns null when capture is not active
 * (caller falls back to resource timing).
 * @returns {Promise<{live: true, requests: Array} | null>}
 */
export async function readNetwork(port, filters = {}) {
  const rec = recorders.get(port);
  if (!rec) return null;
  return { live: true, requests: applyFilters(rec.entries, filters) };
}

/** Stop capture on a port (closes the persistent session). */
export function stopNetworkTracking(port) {
  const rec = recorders.get(port);
  if (!rec) return;
  recorders.delete(port);
  try {
    rec.session.close();
  } catch {
    /* already closed */
  }
}
