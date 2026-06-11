/**
 * IMGB Repack2 (resize-capable repack) round-trip tests.
 *
 * Repack2 rebuilds the imgb from scratch so a replacement DDS may differ in
 * dimensions / mip count from the original. These synthetic tests build a
 * classic-2D header block + a DDS at a NEW size, run repackImgbResize, then
 * extract with unpackImgb and assert the rebuilt {header, imgb} yields a DDS
 * with the new dimensions/mipcount and the exact pixels we put in.
 */
import { repackImgbResize } from '../src/formats/imgb-repack2.ts';
import { unpackImgb } from '../src/formats/imgb.ts';
import { locateGtex, parseGtex } from '../src/formats/gtex.ts';
import { buildDdsHeader } from '../src/formats/dds.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

const ceil4 = (n) => n + ((4 - (n % 4)) % 4);

// Mirror of imgb-repack2's mip-size math, used to lay out synthetic DDS pixels.
function mipSizeFor(format, w, h) {
  if (format === 3 || format === 4) return h * w * 4;
  if (format === 24) return (ceil4(h) * ceil4(w) * 4) / 8; // DXT1
  return (ceil4(h) * ceil4(w) * 4) / 4; // DXT3/DXT5 (25/26)
}

function nextDim(format, w, h) {
  if (format !== 3) {
    h = Math.max(4, Math.floor(h / 2));
    w = Math.max(4, Math.floor(w / 2));
  } else {
    h = h === 1 ? 1 : Math.floor(h / 2);
    w = w === 1 ? 1 : Math.floor(w / 2);
  }
  return [w, h];
}

// Per-mip sizes the repacker will compute for (format, width, height, mipCount).
function mipSizes(format, width, height, mipCount) {
  const sizes = [];
  let w = width, h = height;
  for (let i = 0; i < mipCount; i++) {
    sizes.push(mipSizeFor(format, w, h));
    [w, h] = nextDim(format, w, h);
  }
  return sizes;
}

/**
 * Build a synthetic classic-2D header block for the ORIGINAL texture, with the
 * GTEX chunk at offset 64 (mirroring a real TRB/SEDB container header that
 * precedes GTEX — absolute offset 16 is the container's length field, which
 * `ExtraMipsOffsets` rewrites, and must NOT overlap the GTEX fields). The mip
 * table sits at GtexStart+24. `origMips` entries are pre-filled with junk so we
 * can verify the repacker overwrites/grows them.
 */
function buildClassic({ format, width, height, origMips }) {
  const tablePtr = 24;
  const g = 64; // GTEX magic deep into the block (past a synthetic container header)
  const headerLen = g + tablePtr + origMips * 8;
  const h = Buffer.alloc(headerLen, 0x99); // 0x99 junk so growth/overwrite is visible
  h.write('GTEX', g, 'ascii');
  h.writeUInt8(format, g + 6);
  h.writeUInt8(origMips, g + 7);
  h.writeUInt8(0, g + 9); // type 0 = classic 2D
  h.writeUInt16BE(width, g + 10);
  h.writeUInt16BE(height, g + 12);
  h.writeUInt16BE(0, g + 14); // depth
  h.writeUInt32BE(tablePtr, g + 16);
  // leave the original table region as junk; repacker overwrites it.
  return h;
}

/**
 * Build a DDS (128-byte header + pixels) at the given size, with each mip
 * filled with a distinct byte value so we can verify per-mip pixel placement.
 */
function buildDds({ format, width, height, mipCount }) {
  const head = buildDdsHeader({ format, width, height, mipCount });
  const sizes = mipSizes(format, width, height, mipCount);
  const parts = [head];
  sizes.forEach((sz, i) => parts.push(Buffer.alloc(sz, 0x10 + i)));
  return { dds: Buffer.concat(parts), sizes };
}

console.log('IMGB Repack2 (resize-capable):');

// ---------------------------------------------------------------------------
// 1. Resize a DXT1 texture to a NEW (smaller) size, same mip count.
// ---------------------------------------------------------------------------
{
  const format = 24; // DXT1
  // Original: 64x64, 2 mips. New: 32x32, 2 mips (different dimensions).
  const header0 = buildClassic({ format, width: 64, height: 64, origMips: 2 });
  const { dds, sizes } = buildDds({ format, width: 32, height: 32, mipCount: 2 });

  const { header, imgb } = repackImgbResize(header0, dds);

  // GTEX fields rewritten to the new size.
  const g = parseGtex(header, locateGtex(header));
  check('resize (same mips): width updated', g.width === 32);
  check('resize (same mips): height updated', g.height === 32);
  check('resize (same mips): mipCount updated', g.mipCount === 2);
  check('resize (same mips): format preserved', g.format === 24);

  // Header NOT grown (mip count unchanged).
  check('resize (same mips): header length unchanged', header.length === header0.length);

  // Round-trip: extract and compare dimensions + pixels.
  const [tex] = unpackImgb(header, imgb, 'tex');
  check('resize (same mips): one classic texture extracted', !!tex);
  const out = tex.dds;
  const total = sizes.reduce((a, b) => a + b, 0);
  check('resize (same mips): extracted DDS = 128 + pixels', out.length === 128 + total);
  // Per-mip pixels match what we put in.
  let off = 128, ok = true;
  sizes.forEach((sz, i) => {
    if (!out.subarray(off, off + sz).every((b) => b === (0x10 + i))) ok = false;
    off += sz;
  });
  check('resize (same mips): per-mip pixels round-trip', ok);
}

// ---------------------------------------------------------------------------
// 2. GROW the mip count: original has 1 mip, new DDS has 4 mips.
// ---------------------------------------------------------------------------
{
  const format = 24; // DXT1
  const header0 = buildClassic({ format, width: 64, height: 64, origMips: 1 });
  const { dds, sizes } = buildDds({ format, width: 64, height: 64, mipCount: 4 });

  const { header, imgb } = repackImgbResize(header0, dds);

  // Header grew by 8 bytes per extra mip (3 extra -> 24 bytes).
  check('grow mips: header grew by 8*extra', header.length === header0.length + 3 * 8);
  // New header length recorded as u32 LE at absolute offset 16.
  check('grow mips: header length written at +16 (LE)', header.readUInt32LE(16) === header.length);

  const g = parseGtex(header, locateGtex(header));
  check('grow mips: mipCount updated to 4', g.mipCount === 4);

  const [tex] = unpackImgb(header, imgb, 'tex');
  const out = tex.dds;
  const total = sizes.reduce((a, b) => a + b, 0);
  check('grow mips: extracted DDS = 128 + all 4 mips', out.length === 128 + total);
  let off = 128, ok = true;
  sizes.forEach((sz, i) => {
    if (!out.subarray(off, off + sz).every((b) => b === (0x10 + i))) ok = false;
    off += sz;
  });
  check('grow mips: all 4 mips round-trip', ok);

  // Padding: tail mips of a 64x64 DXT1 chain shrink below 16 bytes and must be
  // padded in the imgb. Verify the imgb is at least 16 bytes per mip.
  const minImgb = sizes.reduce((a, sz) => a + Math.max(sz, sz < 16 ? 16 : sz), 0);
  check('grow mips: imgb padded to >=16 bytes per small mip', imgb.length === minImgb);
}

// ---------------------------------------------------------------------------
// 3. Uncompressed (fmt 3/4) resize round-trip + 16-byte padding on tiny mips.
// ---------------------------------------------------------------------------
{
  const format = 3; // A8R8G8B8, multi-mip
  const header0 = buildClassic({ format, width: 8, height: 8, origMips: 4 });
  // New: 4x4 -> 2x2 -> 1x1 (3 mips). Smallest mip (1x1 = 4 bytes) needs padding.
  const { dds, sizes } = buildDds({ format, width: 4, height: 4, mipCount: 3 });

  const { header, imgb } = repackImgbResize(header0, dds);
  const g = parseGtex(header, locateGtex(header));
  check('fmt3 resize: dimensions updated', g.width === 4 && g.height === 4 && g.mipCount === 3 && g.format === 3);

  const [tex] = unpackImgb(header, imgb, 'tex');
  const out = tex.dds;
  const total = sizes.reduce((a, b) => a + b, 0);
  check('fmt3 resize: extracted DDS = 128 + pixels', out.length === 128 + total);
  let off = 128, ok = true;
  sizes.forEach((sz, i) => {
    if (!out.subarray(off, off + sz).every((b) => b === (0x10 + i))) ok = false;
    off += sz;
  });
  check('fmt3 resize: per-mip pixels round-trip', ok);
}

// ---------------------------------------------------------------------------
// 4. Errors: no GTEX, and cubemap/stack deferral.
// ---------------------------------------------------------------------------
{
  let threw = false;
  try { repackImgbResize(Buffer.from('no gtex here at all'), buildDdsHeader({ format: 24, width: 4, height: 4, mipCount: 1 })); }
  catch { threw = true; }
  check('no GTEX chunk throws', threw);

  // Cubemap (type 1) deferral.
  const cube = buildClassic({ format: 24, width: 16, height: 16, origMips: 1 });
  cube.writeUInt8(1, locateGtex(cube) + 9); // type 1 = cubemap
  let cubeThrew = false;
  try { repackImgbResize(cube, buildDdsHeader({ format: 24, width: 16, height: 16, mipCount: 1 })); }
  catch (e) { cubeThrew = /cubemap/.test(String(e)); }
  check('cubemap type is deferred (throws with note)', cubeThrew);

  // Stack (type 2) deferral.
  const stack = buildClassic({ format: 24, width: 16, height: 16, origMips: 1 });
  stack.writeUInt8(2, locateGtex(stack) + 9); // type 2 = stack
  let stackThrew = false;
  try { repackImgbResize(stack, buildDdsHeader({ format: 24, width: 16, height: 16, mipCount: 1 })); }
  catch (e) { stackThrew = /stack/.test(String(e)); }
  check('stack type is deferred (throws with note)', stackThrew);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
