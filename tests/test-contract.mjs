// Verify the Typert RPC contract (invocations ↔ host service methods, no dup ids)
// and that the client bundle actually contains the new UI strings.
// Note: esbuild charset:ascii + minify emits Chinese as UPPERCASE \uXXXX text, so
// the bundle check searches for that escaped form (lowercase check would false-fail).
import { readFileSync } from 'node:fs';
import { TYPERT } from '../typert.js';
import { apply } from '../host.js';

// 1) typert ↔ host 契约
const svc = {};
apply({ provide: (k, v) => { svc[k] = v; }, remote: { register: () => {} } });
const hostSvc = svc.realBrowser;
const ids = new Set();
let dup = 0, missing = 0;
for (const inv of TYPERT.invocations) {
  if (ids.has(inv.id)) { dup++; console.log('DUP id:', inv.id); }
  ids.add(inv.id);
  const m = inv.method;
  if (typeof hostSvc[m] !== 'function') { missing++; console.log('MISSING host method:', m); continue; }
  const params = (inv.parameters || []).map((p) => p.name).join(',');
  console.log(`  ${m}(${params})`);
}
console.log(`invocations: ${TYPERT.invocations.length} | duplicate ids: ${dup} | missing host methods: ${missing}`);
if (dup || missing) process.exitCode = 1;

// 2) client bundle 内容（esbuild charset:ascii + minify → 中文以大写 \uXXXX 文本存在）
const b = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const esc = (s) => [...s].map((ch) => `\\u${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join('');
// Note: avoid check strings containing '·' (esbuild emits it as \xB7, not \u00B7)
// or leading/trailing spaces (minify may trim JSX text).
const checks = ['当前浏览器配置', '全局浏览器配置', '查看启动命令', '创建桌面快捷方式', '关闭该配置', '全部终止', '移除', '自定义目录', '新建目录', '隐藏不可控', '多用户目录', '单用户目录', '默认路径', '个用户配置'];
let ok = true;
for (const c of checks) {
  const hit = b.includes(esc(c));
  if (!hit) ok = false;
  console.log(`${hit ? 'in bundle' : 'MISSING   '}: ${c}`);
}
console.log(ok ? 'BUNDLE OK ✅' : 'BUNDLE INCOMPLETE ❌');
if (!ok) process.exitCode = 1;
