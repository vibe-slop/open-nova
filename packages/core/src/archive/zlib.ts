/**
 * zlib wrapper for the archive bodies, compressed at maximum level. This is
 * RFC1950 zlib (2-byte header 0x78 + Adler32 trailer), NOT raw deflate.
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
