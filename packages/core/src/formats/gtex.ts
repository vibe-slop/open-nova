/**
 * GTEX — the texture header chunk embedded inside a FFXIII image-header block
 * (a `.txb`/`.txbh`/`.vtex` entry within a TRB/WPD container). It describes one
 * texture (format, dimensions, mip count, type) and points at a mip offset
 * table that locates each mip's pixels inside the paired `.imgb` blob.
 *
 * All GTEX multi-byte fields are BIG-ENDIAN. Offsets are relative to the 'G' of
 * the 'GTEX' magic. Format/type enum values are extracted verbatim from the
 * original DLL (GtexImgFormatValues / GtexImgTypeValues).
 */

/** Accepted pixel formats: 3,4=A8R8G8B8 (mip/single), 24=DXT1, 25=DXT3, 26=DXT5. */
export const GTEX_FORMATS = [3, 4, 24, 25, 26] as const;
/** Accepted image types: 0,4=classic 2D, 1,5=cubemap, 2=stack (3/volume unsupported). */
export const GTEX_TYPES = [0, 4, 1, 5, 2] as const;

export interface Gtex {
  /** Offset of the 'GTEX' magic within the header block. */
  start: number;
  format: number;
  mipCount: number;
  type: number;
  width: number;
  height: number;
  depth: number;
  /** Mip offset-table location, relative to `start` (usually 24). */
  tablePtr: number;
}

const GTEX_MAGIC = 0x47544558; // 'GTEX'

/** Byte-scan for the 'GTEX' magic; returns its offset or -1. */
export function locateGtex(buf: Uint8Array): number {
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x47 && buf[i + 1] === 0x54 && buf[i + 2] === 0x45 && buf[i + 3] === 0x58) return i;
  }
  return -1;
}

/** Parse the fixed GTEX fields at `start` (big-endian). */
export function parseGtex(buf: Uint8Array, start: number): Gtex {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.readUInt32BE(start) !== GTEX_MAGIC) throw new Error('not a GTEX chunk');
  const mip = b.readUInt8(start + 7);
  return {
    start,
    format: b.readUInt8(start + 6),
    mipCount: mip === 0 ? 1 : mip,
    type: b.readUInt8(start + 9),
    width: b.readUInt16BE(start + 10),
    height: b.readUInt16BE(start + 12),
    depth: b.readUInt16BE(start + 14),
    tablePtr: b.readUInt32BE(start + 16),
  };
}

/** Filename suffix per image type (matches the original's naming). */
export function typeSuffix(type: number): string {
  if (type === 1 || type === 5) return '_cbmap_';
  if (type === 2) return '_stack_';
  return '';
}

export function isSupportedGtex(g: Gtex): boolean {
  return (GTEX_FORMATS as readonly number[]).includes(g.format) && (GTEX_TYPES as readonly number[]).includes(g.type);
}
