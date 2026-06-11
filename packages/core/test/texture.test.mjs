/**
 * Texture pipeline (GTEX + DDS + IMGB) self-consistency tests.
 *
 * Validated separately against REAL FFXIII-2 data on a Steam Deck (a c001
 * TRB+IMGB pair): 28 textures extracted, formats DXT1/BGRA, and extract →
 * repack-in-place reproduced the original imgb byte-for-byte. These synthetic
 * tests guard the format math + round-trip in CI without shipping game files.
 */
import { locateGtex, parseGtex, isSupportedGtex } from '../src/formats/gtex.ts';
import { buildDdsHeader, parseDdsHeader } from '../src/formats/dds.ts';
import { unpackImgb, repackImgbInPlace } from '../src/formats/imgb.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

// Build a synthetic classic-2D header block + imgb. DXT1 (format 24), 2 mips.
function buildClassic({ format = 24, width = 64, height = 64, mips = [] }) {
  // header: 4 junk bytes, then GTEX at offset 4.
  const tablePtr = 24;
  const headerLen = 4 + tablePtr + mips.length * 8;
  const h = Buffer.alloc(headerLen);
  const g = 4;
  h.write('GTEX', g, 'ascii');
  h.writeUInt8(format, g + 6);
  h.writeUInt8(mips.length, g + 7);
  h.writeUInt8(0, g + 9); // type 0 = classic
  h.writeUInt16BE(width, g + 10);
  h.writeUInt16BE(height, g + 12);
  h.writeUInt16BE(0, g + 14);
  h.writeUInt32BE(tablePtr, g + 16);
  let cur = g + tablePtr;
  for (const m of mips) {
    h.writeUInt32BE(m.start, cur);
    h.writeUInt32BE(m.size, cur + 4);
    cur += 8;
  }
  return h;
}

console.log('Texture pipeline (GTEX/DDS/IMGB):');

// DDS header round-trips through parse for each format.
for (const [format, w, h, mips] of [[24, 256, 128, 9], [25, 64, 64, 1], [26, 128, 128, 8], [3, 32, 32, 6], [4, 16, 16, 1]]) {
  const info = parseDdsHeader(buildDdsHeader({ format, width: w, height: h, mipCount: mips }));
  check(`dds header round-trip fmt${format}`, info.format === format && info.width === w && info.height === h && info.mipCount === mips);
}

// GTEX locate + parse.
{
  const m0 = { start: 0, size: 2048 }; // 64x64 DXT1 base = 16*16*8
  const m1 = { start: 2048, size: 512 }; // 32x32 DXT1
  const header = buildClassic({ width: 64, height: 64, mips: [m0, m1] });
  const start = locateGtex(header);
  check('locateGtex finds magic past junk', start === 4);
  const g = parseGtex(header, start);
  check('parseGtex reads fields', g.format === 24 && g.width === 64 && g.height === 64 && g.mipCount === 2 && g.type === 0);
  check('isSupportedGtex true for DXT1 classic', isSupportedGtex(g));

  // imgb with distinct pattern per mip.
  const imgb = Buffer.alloc(2048 + 512);
  imgb.fill(0xab, 0, 2048);
  imgb.fill(0xcd, 2048, 2560);

  const tex = unpackImgb(header, imgb, 'tex');
  check('unpackImgb returns one classic texture', tex.length === 1);
  const dds = tex[0].dds;
  check('extracted DDS = 128 header + 2560 pixels', dds.length === 128 + 2560);
  check('extracted pixels match imgb mips', dds.subarray(128, 128 + 2048).every((b) => b === 0xab) && dds.subarray(128 + 2048).every((b) => b === 0xcd));

  // Repack unchanged -> identical imgb.
  const back = repackImgbInPlace(header, imgb, dds);
  check('repack-in-place (unchanged) == original imgb', Buffer.compare(back, imgb) === 0);

  // Edit pixels (same size) -> injected at the right offsets.
  const edited = Buffer.from(dds);
  edited.fill(0x11, 128, 128 + 2048); // modify mip 0
  const back2 = repackImgbInPlace(header, imgb, edited);
  check('repack injects edited mip0', back2.subarray(0, 2048).every((b) => b === 0x11) && back2.subarray(2048).every((b) => b === 0xcd));

  // Resize is rejected.
  let threw = false;
  try {
    repackImgbInPlace(header, imgb, buildDdsHeader({ format: 24, width: 128, height: 128, mipCount: 2 }));
  } catch {
    threw = true;
  }
  check('repack rejects dimension mismatch (resize ban)', threw);
}

// Non-texture header (no GTEX) -> [].
check('unpackImgb skips non-GTEX header', unpackImgb(Buffer.from('not a texture block'), Buffer.alloc(16)).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
