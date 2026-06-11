/**
 * CLB script-file crypt (FFXIII trilogy compiled scripts, magic 'CLST').
 *
 * A .clb is the same block cipher as the filelist (see crypto/cipher.ts) but
 * keyed on the file's own first 8 bytes (the 'CLST' magic + 4 more), with an
 * 8-byte verbatim header and a trailing additive checksum. Mirrors
 * CryptoMain.ProcessClb. The cipher itself is validated byte-for-byte vs the DLL.
 */
import { generateXorTable, encryptBlocks, decryptBlocks, computeChecksum } from '../crypto/cipher.js';

export const CLB_MAGIC = 0x54534c43; // 'CLST' (little-endian uint32 at offset 0)
const HEADER = 8;

function readU32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function writeU32LE(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}

/** True if the buffer begins with the CLST magic. */
export function isClb(buf: Uint8Array): boolean {
  return buf.length >= 4 && readU32LE(buf, 0) === CLB_MAGIC;
}

/** Decrypt a .clb buffer (keeps the 8-byte header, decrypts the body). */
export function decryptClb(buf: Uint8Array): { data: Buffer; checksumOk: boolean } {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const num = b.length - HEADER;
  if (num % 8 !== 0) throw new Error('clb body length not a multiple of 8');
  const table = generateXorTable(b.subarray(0, 8));
  const decBody = decryptBlocks(table, b.subarray(HEADER, HEADER + num), num / 8);
  const out = Buffer.concat([b.subarray(0, HEADER), decBody]);
  // The decrypted body's last 4 bytes hold a checksum over (num-8)/4 words.
  let checksumOk = false;
  try {
    const stored = readU32LE(out, HEADER + num - 4);
    const computed = computeChecksum(out, HEADER, (num - 8) / 4);
    checksumOk = stored === computed;
  } catch { /* ignore */ }
  return { data: out, checksumOk };
}

/** Encrypt a plaintext .clb buffer back to its on-disk form. */
export function encryptClb(plain: Uint8Array): Buffer {
  const b = Buffer.from(plain);
  const num = b.length - HEADER;
  if (num % 8 !== 0) throw new Error('clb body length not a multiple of 8');
  // checksum tail over (num-8)/4 words, written at HEADER+num-4 before encrypt.
  const checksum = computeChecksum(b, HEADER, (num - 8) / 4);
  writeU32LE(b, HEADER + num - 4, checksum);
  const table = generateXorTable(b.subarray(0, 8));
  const encBody = encryptBlocks(table, b.subarray(HEADER, HEADER + num), num / 8);
  return Buffer.concat([b.subarray(0, HEADER), encBody]);
}
