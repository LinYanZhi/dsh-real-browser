/**
 * dsh-real-browser — root entry (package `.` export).
 *
 * A clean Cordis function plugin (name/apply only — no default export, no
 * extra named exports, so the Loader keeps the namespace). It registers the
 * realBrowser host service (typert RPC: detectEnv / listRunning / launch /
 * close), backing the DSH web "浏览器设置" settings section.
 *
 * WHY a bare package entry matters: the web client-modules scanner skips
 * subpath loader entries (e.g. `dsh-real-browser/tools`) as "not a package
 * root"; only a BARE package-name entry (`dsh-real-browser`) lets the scan
 * find `dsh.client` + `./client` and include the bundle in the boot graph.
 * The profile patch therefore mounts this package under its bare name.
 *
 * Programmatic imports use the subpath exports (./cdp, ./env, ./launch,
 * ./tools, ./host, ./typert, ./client).
 */
export { name, apply } from './host.js';
