/**
 * Download tracking for a REAL browser over CDP.
 *
 * Keeps ONE persistent browser-level WebSocket per CDP port that opts into
 * download events via Browser.setDownloadBehavior (eventsEnabled) and records
 * Browser.downloadWillBegin / Browser.downloadProgress into a per-port list.
 * Chrome/Edge require a downloadPath for behavior 'allow' — the caller may
 * pass one, and the default is the user's Downloads folder, so downloads keep
 * landing where the user expects while events are observed. The tracker
 * reports the suggested filename, URL, byte progress, and state so the AI can
 * verify a download it triggered.
 *
 * Tracking is passive: only downloads that happen AFTER this module first
 * activates on a port are recorded. The session closes itself when the
 * browser goes away (ws close/error), and real_browser_close stops it too.
 */

import { versionInfo, CdpSession } from './cdp.js';

/** port -> { session, downloads: [], enabled } */
const trackers = new Map();

/**
 * Activate download tracking on a port (idempotent). Returns the tracker.
 * @param {number} port - CDP debug port.
 * @param {{downloadDir?: string}} [opts] - where downloads land while tracking
 *   is active; defaults to the user's Downloads folder.
 * @returns {Promise<{enabled: boolean, downloads: Array}>}
 */
export async function ensureDownloadTracking(port, opts = {}) {
  const existing = trackers.get(port);
  if (existing) return existing;

  const downloadPath =
    opts.downloadDir ??
    (process.env.USERPROFILE
      ? `${process.env.USERPROFILE}\\Downloads`
      : (process.env.HOME || '.'));
  const info = await versionInfo(port);
  if (!info.webSocketDebuggerUrl) {
    throw new Error(`no browser websocket on port ${port} — is the browser still running?`);
  }
  const session = await CdpSession.connect(info.webSocketDebuggerUrl);
  const tracker = { port, session, downloads: [], enabled: true, downloadPath };
  try {
    await session.call('Browser.setDownloadBehavior', {
      behavior: 'allow',
      eventsEnabled: true,
      downloadPath,
    });
  } catch (e) {
    session.close();
    throw new Error(`could not enable download events on port ${port}: ${e.message}`);
  }

  session.ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (typeof msg?.method !== 'string') return;
    if (msg.method === 'Browser.downloadWillBegin') {
      const d = msg.params;
      tracker.downloads.push({
        guid: d.guid,
        url: d.url,
        suggestedFilename: d.suggestedFilename,
        state: 'inProgress',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: Date.now(),
      });
    } else if (msg.method === 'Browser.downloadProgress') {
      const d = msg.params;
      const entry = tracker.downloads.find((x) => x.guid === d.guid);
      if (!entry) return;
      entry.receivedBytes = d.receivedBytes ?? entry.receivedBytes;
      entry.totalBytes = d.totalBytes ?? entry.totalBytes;
      entry.state = d.state; // 'inProgress' | 'completed' | 'canceled'
      if (d.state === 'completed' || d.state === 'canceled') entry.finishedAt = Date.now();
    }
  });
  // The browser died (or the page went away) — drop the tracker so the next
  // call starts fresh instead of reading a dead session.
  const drop = () => trackers.delete(port);
  session.ws.addEventListener('close', drop);
  session.ws.addEventListener('error', drop);

  trackers.set(port, tracker);
  return tracker;
}

/**
 * List tracked downloads for a port. `clear` empties the list after reading.
 * Tracking is activated lazily on first call when not already active.
 * @returns {Promise<{tracking: boolean, downloads: Array}>}
 */
export async function listDownloads(port, { clear = false, downloadDir } = {}) {
  let tracker;
  try {
    tracker = await ensureDownloadTracking(port, { downloadDir });
  } catch {
    // The browser is unreachable — report tracking as off instead of failing.
    return { tracking: false, downloads: [] };
  }
  const downloads = tracker.downloads.slice();
  if (clear) tracker.downloads = [];
  return { tracking: tracker.enabled, downloads };
}

/** Stop tracking on a port (closes the persistent session). */
export function stopDownloadTracking(port) {
  const tracker = trackers.get(port);
  if (!tracker) return;
  trackers.delete(port);
  try {
    tracker.session.close();
  } catch {
    /* already closed */
  }
}
