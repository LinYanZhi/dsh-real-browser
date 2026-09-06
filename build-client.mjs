// Bundle the client plugin into client.js in the dsh client-modules factory
// format: window.__ModuleLoader__.load({ id, factory }). React stays external —
// the web client module system supplies it through the factory's `require`.
// Run: node build-client.mjs
import { build } from 'esbuild';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const INTERMEDIATE = 'client.tmp.js';
const OUTFILE = 'client.js';

await build({
  entryPoints: ['client/index.js'],
  outfile: INTERMEDIATE,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  loader: { '.js': 'jsx' },
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  minify: true,
  logLevel: 'info',
});

const body = readFileSync(INTERMEDIATE, 'utf8').trim();
rmSync(INTERMEDIATE, { force: true });
rmSync(`${OUTFILE}.map`, { force: true });
// The combo route concatenates every plugin's client.js into one classic
// script, so the bundle must self-register with __ModuleLoader__.load and must
// not touch module/require at the top level (both are provided per-factory).
const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-real-browser",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
    return module.exports;
  }
});
`;
writeFileSync(OUTFILE, wrapped);
console.log('client.js built ✅');
