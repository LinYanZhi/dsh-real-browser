// Stub of ./launch.js for tests that exercise the allowlist/approval gate in
// tools.js WITHOUT actually spawning a browser. Records every call so the test
// can assert the gate passed through to the real launch boundary.
export const launchCalls = [];

export async function launchRealBrowser(opts) {
  launchCalls.push({ ...opts });
  return { pid: 4242, port: 9222, wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x', tookOver: false, killed: 0, attached: false };
}

export function closeRealBrowser() {
  return 0;
}
