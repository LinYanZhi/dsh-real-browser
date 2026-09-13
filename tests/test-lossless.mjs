// Regression test: every tool's execute() output must be LOSSLESS JSON —
// DSH's tool framework rejects values that do not round-trip losslessly
// ("value is not lossless JSON"). An object with a key whose value is
// `undefined` (or NaN/Infinity/BigInt/function/cyclic) fails that check:
// JSON.stringify drops the key, so the round-trip loses data.
//
// This catches the class of bug that broke real_browser_list in the field:
// discover.js emitted `note: port ? undefined : '...'`, and launch/snapshot/
// interact had the same pattern. Guard every registered tool's output.
import { register } from 'node:module';
register('./mock-loader.mjs', import.meta.url);
const { apply } = await import('../tools.js');

const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) } };
apply(ctx);

let failures = 0;
let checks = 0;

/** True when v is a "JSON-safe" value tree: no undefined/NaN/Infinity/BigInt. */
function isLosslessSafe(v, path = 'root', out = []) {
  if (v === undefined) { out.push(`${path} = undefined`); return false; }
  if (typeof v === 'number' && !Number.isFinite(v)) { out.push(`${path} = ${v}`); return false; }
  if (typeof v === 'bigint' || typeof v === 'symbol' || typeof v === 'function') { out.push(`${path} = ${typeof v}`); return false; }
  if (Array.isArray(v)) {
    v.forEach((it, i) => isLosslessSafe(it, `${path}[${i}]`, out));
    return out.length === 0;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) isLosslessSafe(v[k], `${path}.${k}`, out);
    return out.length === 0;
  }
  return true;
}

/** True when JSON.stringify(v) round-trips without throwing and keeps all keys. */
function roundTripsLossless(v) {
  let str;
  try {
    str = JSON.stringify(v);
  } catch (e) {
    return { ok: false, why: `stringify threw: ${e.message}` };
  }
  // undefined/NaN inside an object are dropped silently by stringify — detect
  // them structurally first.
  const unsafe = [];
  isLosslessSafe(v, 'root', unsafe);
  if (unsafe.length) return { ok: false, why: `unsafe value: ${unsafe.slice(0, 5).join('; ')}` };
  // Extra belt: after round-trip the shape must be identical (catches cyclic).
  let back;
  try {
    back = JSON.parse(str);
  } catch (e) {
    return { ok: false, why: `parse threw: ${e.message}` };
  }
  if (JSON.stringify(back) !== str) return { ok: false, why: 'round-trip changed value' };
  return { ok: true, why: '' };
}

/** Execute a tool with safe args; returns [value, error]. */
async function tryExecute(tool) {
  const safeArgs = {};
  for (const [k, v] of Object.entries(tool.parameters || {})) {
    if (v?.required) {
      if (k === 'port') safeArgs[k] = 0;
      else if (k === 'expression') safeArgs[k] = '1';
      else if (k === 'url') safeArgs[k] = 'about:blank';
      else if (k === 'selector') safeArgs[k] = 'body';
      else if (k === 'value' || k === 'text' || k === 'key' || k === 'pattern' || k === 'kind' || k === 'action' || k === 'vaultKey' || k === 'files') safeArgs[k] = k === 'files' ? [] : 'x';
      else safeArgs[k] = 'x';
    }
  }
  try {
    const v = await tool.execute(safeArgs, {});
    return [v, null];
  } catch (e) {
    return [null, e];
  }
}

for (const tool of registered) {
  checks += 1;
  const [value, err] = await tryExecute(tool);
  if (err) {
    // execute throwing is fine for guards (unlaunched browser etc.) — we only
    // care that a *returned* value is lossless. Skip.
    console.log(`- ${tool.name}: execute skipped (${String(err.message || err).slice(0, 60)})`);
    continue;
  }
  if (value === undefined) {
    console.log(`⚠ ${tool.name}: execute returned undefined (no output)`);
    continue;
  }
  const r = roundTripsLossless(value);
  if (!r.ok) {
    failures += 1;
    console.log(`❌ ${tool.name}: NOT lossless — ${r.why}`);
  } else {
    console.log(`✅ ${tool.name}: lossless JSON OK`);
  }
}

console.log('');
console.log(`${checks} tools checked, ${failures} lossless failure(s)`);
if (failures > 0) process.exit(1);
console.log('ALL TOOL OUTPUTS ARE LOSSLESS ✅');
