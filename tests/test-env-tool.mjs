// Verify real_browser_env tool end-to-end through the plugin's tool layer.
import { register } from 'node:module';
register('./mock-loader.mjs', import.meta.url);
const { apply } = await import('../tools.js');

const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) } };
apply(ctx);

const envTool = registered.find((t) => t.name === 'real_browser_env');
if (!envTool) throw new Error('real_browser_env not registered');

const result = await envTool.execute({ includeAvatars: false }, {});
console.log('browsers:', result.browsers.length);
for (const b of result.browsers) {
  console.log(`  ${b.browser_name}: installed=${b.installed} version=${b.browser_version || '-'} profiles=${b.profiles.length}`);
}
const lines = envTool.output.render({ includeAvatars: false }, result)[0].text;
console.log('--- render preview ---');
console.log(lines.split('\n').slice(0, 12).join('\n'));
console.log('--- real_browser_env OK ✅ ---');
