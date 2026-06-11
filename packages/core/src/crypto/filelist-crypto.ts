/**
 * Filelist-level crypto: detects and (de)encrypts the FFXIII-2 / Lightning
 * Returns "filelist*.win32.bin" index files, which wrap the block cipher in
 * cipher.ts with a 32-byte header, an MD5-seed-derived key, and a trailing
 * additive checksum.
 *
 * FFXIII-1 filelists are NOT encrypted; only XIII-2 and LR are.
 *
 * Layout of an encrypted filelist:
 *   [0x00..0x10)  16-byte seed header (MD5-like). Key bytes pulled from here.
 *   [0x10..0x14)  uint32 BIG-ENDIAN  cryptBodySize (stored value; +8 = real)
 *   [0x14..0x18)  uint32 LITTLE      magic tag 501232760 (0x1DE5BCB8)
 *   [0x18..0x20)  reserved (8 bytes)
 *   [0x20..0x20+body)  encrypted body (multiple of 8)
 *   [.. EOF]      remainder bytes copied verbatim (not encrypted)
 *
 * NOTE: this framing layer should be validated against a real game filelist
 * before relying on the re-encrypt path in production.
 */
import { generateXorTable, encryptBlocks, decryptBlocks, computeChecksum } from './cipher.js';

export const FILELIST_MAGIC = 501232760; // 0x1DE5BCB8
const HEADER = 0x20; // 32-byte verbatim header
const TAG_OFFSET = 0x14;
const SIZE_OFFSET = 0x10;

function readU32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
function readU32BE(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}
function writeU32LE(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
  b[off + 2] = (v >>> 16) & 0xff;
  b[off + 3] = (v >>> 24) & 0xff;
}
function writeU32BE(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 24) & 0xff;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

/** True if the buffer carries the encrypted-filelist magic tag. */
export function isFilelistEncrypted(buf: Uint8Array): boolean {
  if (buf.length < TAG_OFFSET + 4) return false;
  return readU32LE(buf, TAG_OFFSET) === FILELIST_MAGIC;
}

/**
 * Derive the 8-byte cipher seed from the 16-byte filelist header. Exported for
 * regression testing of the sign-extension behaviour (see below).
 */
export function deriveSeed(buf: Uint8Array): Uint8Array {
  // value = (b[9]<<24) | (b[12]<<16) | (b[2]<<8) | b[0]. This is a SIGNED 32-bit
  // int cast to a 64-bit value, which sign-extends: if bit 31 is set the upper 4
  // seed bytes are 0xFF, not 0x00. The XOR-table generator consumes these 8 LE
  // bytes (then reverses them internally).
  const value = (buf[9] << 24) | (buf[12] << 16) | (buf[2] << 8) | buf[0]; // signed int32
  const seed = new Uint8Array(8);
  writeU32LE(seed, 0, value >>> 0); // low 32 bits
  writeU32LE(seed, 4, value < 0 ? 0xffffffff : 0); // sign extension to 64-bit
  return seed;
}

export interface DecryptResult {
  data: Uint8Array;
  checksumOk: boolean;
}

/**
 * Decrypt an encrypted filelist buffer. Returns the plaintext filelist plus a
 * flag indicating whether the embedded checksum verified.
 */
export function decryptFilelist(buf: Uint8Array): DecryptResult {
  if (!isFilelistEncrypted(buf)) {
    throw new Error('buffer is not an encrypted filelist (missing magic tag)');
  }
  const bodySize = (readU32BE(buf, SIZE_OFFSET) + 8) >>> 0;
  if (bodySize % 8 !== 0) throw new Error('filelist body size not a multiple of 8');

  const seed = deriveSeed(buf);
  const table = generateXorTable(seed);

  const body = buf.subarray(HEADER, HEADER + bodySize);
  const decryptedBody = decryptBlocks(table, body, bodySize / 8);

  const remainderStart = HEADER + bodySize;
  const remainder = buf.subarray(remainderStart);

  const out = new Uint8Array(HEADER + bodySize + remainder.length);
  out.set(buf.subarray(0, HEADER), 0);
  out.set(decryptedBody, HEADER);
  out.set(remainder, HEADER + bodySize);

  // Verify: the decrypted body stores its declared inner size (BE @ 0x10) and a
  // trailing checksum word at 0x20 + innerSize + 4 (LE), summing every 4th byte.
  let checksumOk = false;
  try {
    const innerSize = readU32BE(out, SIZE_OFFSET);
    const checkOffset = HEADER + innerSize + 4;
    if (checkOffset + 4 <= out.length) {
      const stored = readU32LE(out, checkOffset);
      const computed = computeChecksum(out, HEADER, innerSize / 4);
      checksumOk = stored === computed;
    }
  } catch {
    checksumOk = false;
  }

  return { data: out, checksumOk };
}

/**
 * Encrypt a plaintext filelist buffer back into the on-disk encrypted form.
 * Pads the body to an 8-byte multiple and writes the size fields + checksum the
 * format requires.
 */
export function encryptFilelist(plain: Uint8Array): Uint8Array {
  // Preprocess: pad body to 8, append 16 nulls, write body size BE @ 0x10 and
  // LE @ (length-16).
  let bodyLen = plain.length - HEADER;
  const pad = bodyLen % 8 === 0 ? 0 : 8 - (bodyLen % 8);
  const prepped = new Uint8Array(plain.length + pad + 16);
  prepped.set(plain, 0);
  bodyLen += pad; // padded body length (excludes the appended 16)
  writeU32BE(prepped, SIZE_OFFSET, bodyLen);
  writeU32LE(prepped, prepped.length - 16, bodyLen);

  // num = BE@0x10 + 8 = bytes to encrypt. The encrypted region's last 8 bytes
  // are [LE body-size @ num-8][checksum @ num-4]; decrypt re-derives the size at
  // offset 0x10 and verifies the checksum at +4 after it.
  const num = (bodyLen + 8) >>> 0;
  const seed = deriveSeed(prepped);
  const table = generateXorTable(seed);

  // Checksum over the body (num-8 bytes); stored in the last 4 bytes of the
  // encrypted region (the LE body-size at num-8 is left intact).
  const checksum = computeChecksum(prepped, HEADER, (num - 8) / 4);
  writeU32LE(prepped, HEADER + num - 4, checksum);

  const body = prepped.subarray(HEADER, HEADER + num);
  const encBody = encryptBlocks(table, body, num / 8);

  const remainder = prepped.subarray(HEADER + num);
  const out = new Uint8Array(HEADER + num + remainder.length);
  out.set(prepped.subarray(0, HEADER), 0);
  out.set(encBody, HEADER);
  out.set(remainder, HEADER + num);
  return out;
}
