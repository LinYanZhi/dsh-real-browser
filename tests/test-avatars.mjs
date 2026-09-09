// Avatar pipeline regression tests (09-09 乱码 bug 回归防护):
//   - isValidJpegBase64 拒绝坏数据（乱码缓存/输出永不复用）
//   - optimizeAvatars 的大 PNG 走真实 PS 压缩后必须是合法 JPEG（魔数 FFD8FF）
//   - 坏缓存条目被拒绝并重新生成（不把垃圾当头像）
//   - 小图 / http URL / 空头像原样透传（不误伤）
//   - 真实机器：每个非空头像都是合法 data URL（png/jpeg/ico 魔数校验）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectEnvironment, optimizeAvatars, isValidJpegBase64 } from '../env.js';

// ---- tiny PNG generator (node:zlib, no deps) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makePng(w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w * 3; x++) raw[off + 1 + x] = (Math.random() * 256) | 0;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const isJpeg = (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
const isPng = (buf) => buf.length >= 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e;
const isIco = (buf) => buf.length >= 3 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01;
const decodeDataUrl = (av) => {
  const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/s.exec(av);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') };
};

// 1) helper gates
assert.equal(isValidJpegBase64(''), false);
assert.equal(isValidJpegBase64('not base64 !!!'), false);
assert.equal(isValidJpegBase64(123), false);
const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
assert.equal(isValidJpegBase64(jpegB64), true);
assert.equal(isValidJpegBase64(jpegB64.replace(/(.{4})/g, '$1\n')), true, 'base64 with whitespace must pass');
console.log('  ✅ isValidJpegBase64 gates');

// 2) oversized PNG -> real PS resize -> valid JPEG
const bigPng = `data:image/png;base64,${makePng(512, 512).toString('base64')}`;
assert.ok(bigPng.length > 24 * 1024, `test PNG (${bigPng.length}b) should exceed optimize threshold`);
{
  const browsers = [{ profiles: [{ id: 't1', name: 'T1', avatar_base64: bigPng }], cdp_environments: [] }];
  optimizeAvatars(browsers);
  const av = browsers[0].profiles[0].avatar_base64;
  const d = decodeDataUrl(av);
  assert.ok(d, `expected data URL, got ${av.slice(0, 40)}`);
  assert.equal(d.mime, 'image/jpeg');
  assert.ok(isJpeg(d.buf), 'optimized avatar must decode to a real JPEG (FFD8FF)');
  console.log('  ✅ oversized PNG → valid 64px JPEG via PS resize');
}

// 3) corrupt cache entry is rejected & regenerated
{
  const raw = bigPng.slice(bigPng.indexOf(',') + 1).replace(/\s+/g, '');
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 24);
  const cachePath = path.join(os.homedir(), '.dsh', 'cache', 'rb-avatars-v2', `${hash}.64px.jpg`);
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, 'this is not a jpeg base64 !!!');
  const browsers = [{ profiles: [{ id: 't2', name: 'T2', avatar_base64: bigPng }], cdp_environments: [] }];
  optimizeAvatars(browsers);
  const av = browsers[0].profiles[0].avatar_base64;
  assert.ok(!av.includes('this is not a jpeg'), 'corrupt cache must never be surfaced');
  const d = decodeDataUrl(av);
  assert.ok(d && d.mime === 'image/jpeg' && isJpeg(d.buf), 'regenerated avatar must be a valid JPEG');
  rmSync(cachePath, { force: true });
  console.log('  ✅ corrupt cache rejected & regenerated');
}

// 4) small / http / empty pass through untouched
{
  const small = `data:image/png;base64,${makePng(16, 16).toString('base64')}`;
  const http = 'https://lh3.googleusercontent.com/example';
  const browsers = [{ profiles: [
    { id: 's', name: 'S', avatar_base64: small },
    { id: 'h', name: 'H', avatar_base64: http },
    { id: 'e', name: 'E', avatar_base64: '' },
  ], cdp_environments: [] }];
  optimizeAvatars(browsers);
  assert.equal(browsers[0].profiles[0].avatar_base64, small);
  assert.equal(browsers[0].profiles[1].avatar_base64, http);
  assert.equal(browsers[0].profiles[2].avatar_base64, '');
  console.log('  ✅ small / http / empty pass through untouched');
}

// 5) real machine: every non-empty avatar is a valid renderable data URL
{
  const envs = detectEnvironment({ includeAvatars: true });
  optimizeAvatars(envs);
  let count = 0;
  const check = (p, where) => {
    const av = p.avatar_base64 || '';
    if (!av) return;
    count++;
    const d = decodeDataUrl(av);
    assert.ok(d, `[${where}] ${p.name}: non-data avatar leaked to client: ${av.slice(0, 60)}`);
    assert.ok(isJpeg(d.buf) || isPng(d.buf) || isIco(d.buf),
      `[${where}] ${p.name}: data URL (${d.mime}) does not decode to png/jpeg/ico`);
  };
  for (const b of envs) {
    for (const p of b.profiles ?? []) check(p, 'default');
    for (const c of b.cdp_environments ?? []) for (const p of c.profiles ?? []) check(p, 'cdp');
  }
  console.log(`  ✅ real machine: ${count} avatar(s) all valid (png/jpeg/ico magic)`);
}

console.log('avatar pipeline tests PASS ✅');
