/**
 * zlib wrapper matching the original's use of System.IO.Compression.ZLibStream
 * at CompressionLevel.SmallestSize. This is RFC1950 zlib (2-byte header 0x78 +
 * Adler32 trailer), NOT raw deflate.
 */
import { deflateSync, inflateSync } from 'node:zlib';

/** Compress with max level; output carries the 0x78 0xDA zlib header. */
export function zlibCompress(data: Uint8Array): Buffer {
  return deflateSync(data, { level: 9 });
}

/** Inflate an RFC1950 zlib stream. */
export function zlibDecompress(data: Uint8Array): Buffer {
  return inflateSync(data);
}

/** True if the buffer begins with a zlib header at `off`. */
export function looksLikeZlib(data: Uint8Array, off = 0): boolean {
  // 0x78 0x01 / 0x9C / 0xDA are the common zlib CMF/FLG combos; the game uses 0xDA.
  return data[off] === 0x78 && (data[off + 1] === 0xda || data[off + 1] === 0x9c || data[off + 1] === 0x01);
}
