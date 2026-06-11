// Produce the app icon at the path given as argv[2].
// Prefers the real bundled icon (build/icon.png — the FFXIII emblem); falls back
// to a generated placeholder so the build never fails if the asset is missing.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const real = [join(here, '..', 'build', 'icon.png'), join(here, '..', 'resources', 'icon.png')].find(existsSync);

if (real) {
  copyFileSync(real, out);
  console.log('icon copied from', real, '->', out);
} else {
  // Fallback placeholder: solid indigo #1b2347 with a cyan dot.
  const W = 256, H = 256;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const ro = y * (1 + W * 4); raw[ro] = 0; // filter none
    for (let x = 0; x < W; x++) {
      const o = ro + 1 + x * 4;
      const dx = x - 128, dy = y - 128, d = Math.sqrt(dx * dx + dy * dy);
      if (d < 60) { raw[o] = 0x4d; raw[o + 1] = 0xd6; raw[o + 2] = 0xf0; }
      else { raw[o] = 0x1b; raw[o + 1] = 0x23; raw[o + 2] = 0x47; }
      raw[o + 3] = 0xff;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(out, png);
  console.log('icon placeholder written:', out, png.length, 'bytes');
}
