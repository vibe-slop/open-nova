/**
 * IMGB texture extract (and repack-in-place) for the FFXIII Steam (win32) ports.
 *
 * A header block (a `.txb`/`.txbh`/`.vtex` entry inside a TRB/WPD container)
 * holds a GTEX chunk + a mip offset table; the pixels live in the paired
 * `.imgb` blob. `unpackImgb` reads each texture out to a DDS; `repackImgbInPlace`
 * writes edited DDS pixels back into the imgb at the original offsets (no resize
 * — the WPD/strict variant). Win32 uses plain copies (no PS3 swizzle/BGRA).
 */
import { locateGtex, parseGtex, typeSuffix, isSupportedGtex, type Gtex } from './gtex.js';
import { buildDdsHeader, parseDdsHeader, ddsPixels } from './dds.js';

export interface ExtractedTexture {
  /** Suggested filename, e.g. `c001C_01.win32.dds` or `..._cbmap_1.dds`. */
  fileName: string;
  dds: Buffer;
  gtex: Gtex;
}

interface MipEntry {
  start: number;
  size: number;
}

function readTable(header: Buffer, at: number, count: number): MipEntry[] {
  const out: MipEntry[] = [];
  let cur = at;
  for (let i = 0; i < count; i++) {
    out.push({ start: header.readUInt32BE(cur), size: header.readUInt32BE(cur + 4) });
    cur += 8;
  }
  return out;
}

/**
 * Extract every texture described by a header block to DDS buffers. Returns []
 * if the header has no GTEX chunk or an unsupported format/type (caller skips).
 */
export function unpackImgb(headerBlock: Uint8Array, imgb: Uint8Array, baseName = 'texture'): ExtractedTexture[] {
  const header = Buffer.isBuffer(headerBlock) ? headerBlock : Buffer.from(headerBlock);
  const img = Buffer.isBuffer(imgb) ? imgb : Buffer.from(imgb);
  const start = locateGtex(header);
  if (start < 0) return [];
  const g = parseGtex(header, start);
  if (!isSupportedGtex(g)) return [];

  const tableBase = g.start + g.tablePtr;
  const suffix = typeSuffix(g.type);
  const ddsOf = (mips: MipEntry[]): Buffer => {
    const head = buildDdsHeader({ format: g.format, width: g.width, height: g.height, mipCount: g.mipCount });
    const parts = [head];
    for (const m of mips) parts.push(img.subarray(m.start, m.start + m.size));
    return Buffer.concat(parts);
  };

  // Cubemap: 6 faces, mipCount entries each, contiguous table cursor.
  if (g.type === 1 || g.type === 5) {
    const out: ExtractedTexture[] = [];
    let cur = tableBase;
    for (let face = 0; face < 6; face++) {
      const mips = readTable(header, cur, g.mipCount);
      cur += g.mipCount * 8;
      out.push({ fileName: `${baseName}${suffix}${face + 1}.dds`, dds: ddsOf(mips), gtex: g });
    }
    return out;
  }

  // Stack: one entry holds (start, totalSize); slices are equal-sized.
  if (g.type === 2) {
    const entry = readTable(header, tableBase, 1)[0];
    const slices = Math.max(1, g.depth);
    const sliceSize = Math.floor(entry.size / slices);
    const out: ExtractedTexture[] = [];
    for (let i = 0; i < slices; i++) {
      const m: MipEntry = { start: entry.start + i * sliceSize, size: sliceSize };
      out.push({ fileName: `${baseName}${suffix}${i + 1}.dds`, dds: ddsOf([m]), gtex: g });
    }
    return out;
  }

  // Classic 2D (type 0/4).
  const mips = readTable(header, tableBase, g.mipCount);
  return [{ fileName: `${baseName}.dds`, dds: ddsOf(mips), gtex: g }];
}

/**
 * Write an edited DDS back into a COPY of the imgb at the original mip offsets,
 * WITHOUT resizing (the WPD/strict path). Throws if the DDS dimensions / format
 * / mip count differ from the GTEX header (resize is not allowed here). Returns
 * the modified imgb buffer. Only classic 2D is supported in-place for now.
 */
export function repackImgbInPlace(headerBlock: Uint8Array, imgb: Uint8Array, newDds: Uint8Array): Buffer {
  const header = Buffer.isBuffer(headerBlock) ? headerBlock : Buffer.from(headerBlock);
  const out = Buffer.from(imgb); // copy
  const start = locateGtex(header);
  if (start < 0) throw new Error('header block has no GTEX chunk');
  const g = parseGtex(header, start);
  if (g.type !== 0 && g.type !== 4) throw new Error('in-place repack supports classic 2D textures only');

  const dds = parseDdsHeader(newDds);
  if (dds.width !== g.width || dds.height !== g.height || dds.format !== g.format || dds.mipCount !== g.mipCount) {
    throw new Error(
      `DDS does not match texture (resize not allowed): got ${dds.width}x${dds.height} fmt${dds.format} mips${dds.mipCount}, expected ${g.width}x${g.height} fmt${g.format} mips${g.mipCount}`,
    );
  }
  const pixels = ddsPixels(newDds);
  const mips = readTable(header, g.start + g.tablePtr, g.mipCount);
  let src = 0;
  for (const m of mips) {
    pixels.copy(out, m.start, src, src + m.size);
    src += m.size;
  }
  return out;
}
