// Verifies the plugin module shape (name/inject/apply) and that every tool
// registers with a well-formed definition, and that real_browser_list's
// execute actually runs against this machine.
import { register } from 'node:module';
register('./mock-loader.mjs', import.meta.url);

const { name, inject, apply } = await import('../tools.js');

console.log('name  =', name);
console.log('inject=', inject.join(', '));

const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) } };
apply(ctx);

console.log('registered tools:', registered.map((t) => t.name).join(', '));

for (const t of registered) {
  if (!t.name || !t.description || !t.parameters || typeof t.execute !== 'function') {
    throw new Error(`malformed tool: ${t.name}`);
  }
  if (!t.output || typeof t.output.render !== 'function' || !t.output.schema) {
    throw new Error(`tool missing output/render: ${t.name}`);
  }
}
console.log(`all ${registered.length} tools well-formed ✅`);

// Exercise one real execute() end to end.
const list = registered.find((t) => t.name === 'real_browser_list');
const result = await list.execute({}, {});
console.log(`real_browser_list.execute => ${result.instances.length} instance(s)`);

const render = list.output.render({}, result);
console.log('render preview:', render[0].text.split('\n')[0]);
console.log('plugin-shape verification PASS ✅');
