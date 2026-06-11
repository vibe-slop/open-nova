/**
 * DDS (DirectDraw Surface) header construction + parsing, mirroring Nova
 * Chrysalia's DDSMethods. We EMIT a 128-byte little-endian header (DDS magic +
 * 124-byte DDS_HEADER incl. DDS_PIXELFORMAT) for a GTEX texture, and parse one
 * back (for repack) to recover format/dimensions/mips.
 */

const FOURCC = { 24: 'DXT1', 25: 'DXT3', 26: 'DXT5' } as const;

export interface DdsInfo {
  /** GTEX format code (3,4 uncompressed; 24/25/26 DXT). */
  format: number;
  width: number;
  height: number;
  mipCount: number;
}

const ceilDiv4 = (n: number) => Math.max(1, Math.floor((n + 3) / 4));

/** Build a 128-byte DDS header for a GTEX texture. Pixel data follows at +128. */
export function buildDdsHeader(info: DdsInfo): Buffer {
  const { format, width, height, mipCount } = info;
  const h = Buffer.alloc(128);
  h.writeUInt32LE(0x20534444, 0); // 'DDS '
  h.writeUInt32LE(124, 4); // dwSize
  h.writeUInt32LE(height, 12);
  h.writeUInt32LE(width, 16);
  h.writeUInt32LE(mipCount, 28);
  h.writeUInt32LE(32, 76); // DDS_PIXELFORMAT.dwSize
  h.writeUInt32LE(mipCount > 1 ? 0x401008 : 0x1000, 108); // dwCaps

  if (format === 3 || format === 4) {
    // Uncompressed A8R8G8B8 (BGRA in memory).
    h.writeUInt32LE(width * 4, 20); // pitch
    h.writeUInt32LE(mipCount > 1 ? 0x20fcf : 0x100f, 8); // dwFlags
    h.writeUInt32LE(0x41, 80); // ddspf flags: RGB | ALPHAPIXELS
    h.writeUInt32LE(32, 88); // RGBBitCount
    h.writeUInt32LE(0x00ff0000, 92); // R
    h.writeUInt32LE(0x0000ff00, 96); // G
    h.writeUInt32LE(0x000000ff, 100); // B
    h.writeUInt32LE(0xff000000, 104); // A
  } else {
    // DXT1/3/5.
    const blockBytes = format === 24 ? 8 : 16;
    h.writeUInt32LE(ceilDiv4(width) * ceilDiv4(height) * blockBytes, 20); // linearSize
    h.writeUInt32LE(mipCount > 1 ? 0xa1007 : 0x81007, 8); // dwFlags
    h.writeUInt32LE(0x4, 80); // ddspf flags: FOURCC
    h.write(FOURCC[format as 24 | 25 | 26], 84, 'ascii');
  }
  return h;
}

/** Parse a DDS header back to GTEX-relevant info (used on repack). */
export function parseDdsHeader(buf: Uint8Array): DdsInfo {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.readUInt32LE(0) !== 0x20534444) throw new Error('not a DDS file');
  const height = b.readUInt32LE(12);
  const width = b.readUInt32LE(16);
  const mipCount = Math.max(1, b.readUInt32LE(28));
  const ddspfFlags = b.readUInt32LE(80);
  let format: number;
  if (ddspfFlags & 0x4) {
    const fourcc = b.toString('ascii', 84, 88);
    format = fourcc === 'DXT1' ? 24 : fourcc === 'DXT3' ? 25 : fourcc === 'DXT5' ? 26 : 0;
  } else {
    format = mipCount > 1 ? 3 : 4; // uncompressed
  }
  return { format, width, height, mipCount };
}

/** Raw pixel bytes of a DDS file (everything after the 128-byte header). */
export function ddsPixels(buf: Uint8Array): Buffer {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.subarray(128);
}
