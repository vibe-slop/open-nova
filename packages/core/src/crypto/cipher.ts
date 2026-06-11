/**
 * Open reimplementation of the Final Fantasy XIII / XIII-2 / Lightning Returns
 * "filelist" block cipher used by Nova Chrysalia (and the original ff13crypt).
 *
 * The cipher is a custom 8-byte (64-bit) block cipher:
 *   - a 264-byte key schedule ("XOR table") derived from an 8-byte seed,
 *   - a per-block table offset (blockCounter & 0xF8),
 *   - byte-chaining (CBC-like) + an S-box,
 *   - 64-bit additive/subtractive mixing with two "special keys".
 *
 * Everything here is pure integer/byte math — no native dependencies, no
 * platform assumptions. Validated byte-for-byte against the original
 * NovaChrysalia.dll (see test/crypto.vectors.test.ts).
 *
 * The S-box (`IntegersArray.Integers` in the original) is the identity-plus-120
 * permutation: Integers[i] = (i + 120) mod 256. Extracted from the original
 * assembly's field-init blob (the decompiler could not recover it).
 */

const MASK64 = (1n << 64n) - 1n;
const MASK32 = 0xffffffffn;

/** S-box: Integers[i] = (i + 120) & 0xFF. Bijective. */
export function sbox(value: number): number {
  return (value + 120) & 0xff;
}

/** Inverse S-box: index whose sbox value == v  ->  (v - 120) & 0xFF. */
export function sboxInverse(value: number): number {
  return (value - 120) & 0xff;
}

function u32le(buf: Uint8Array, off: number): number {
  return (
    (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
  );
}

function putU32le(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

/**
 * Generate the 264-byte XOR table (key schedule) from an 8-byte seed.
 * Mirrors Generator.GenerateXORtable. NOTE: the original reverses the seed
 * in place; we operate on a copy so the caller's seed is untouched.
 */
export function generateXorTable(seedIn: Uint8Array): Uint8Array {
  if (seedIn.length !== 8) throw new Error('seed must be 8 bytes');
  const seed = seedIn.slice().reverse(); // reverse all 8 bytes

  let num = u32le(seed, 0);
  let num2 = u32le(seed, 4);
  num = ((num << 8) | (num >>> 24)) >>> 0; // rotate-left 8 (32-bit)
  num2 = ((num2 >>> 16) | (num2 << 16)) >>> 0; // rotate 16 (swap halves)

  // array2 = LE(num2) ++ LE(num)
  const block = new Uint8Array(8);
  putU32le(block, 0, num2);
  putU32le(block, 4, num);

  const table = new Uint8Array(264);

  // Block 0 derivation.
  block[0] = (block[0] + 69) & 0xff;
  for (let i = 1; i < 8; i++) {
    let t = block[i] + 212 + block[i - 1];
    t ^= block[i - 1] << 2;
    t ^= 0x45;
    block[i] = t & 0xff;
  }
  table.set(block, 0);

  // Blocks 1..32: next = (5 * prev) mod 2^64, emitted little-endian.
  let acc = bytesToU64le(block);
  let off = 8;
  for (let i = 1; i < 33; i++) {
    const num6 = acc & MASK32; // low 32
    const num7 = (acc >> 32n) & MASK32; // high 32
    let num8 = (5n * acc) & MASK64;
    num8 ^= (num7 << 32n) & MASK64;
    const num9 = (num6 ^ num8) & MASK32;
    let num10 = (num8 >> 32n) & MASK32;
    num8 = num6 | (num8 & 0xffffffff00000000n);
    const num11 = num9;
    const num12 = (num8 ^ num11) & MASK32;
    num10 = (num10 ^ num7) & MASK32;
    const num13 = num10;

    const out = new Uint8Array(8);
    putU32le(out, 0, Number(num12));
    putU32le(out, 4, Number(num13));
    table.set(out, off);

    acc = bytesToU64le(out);
    off += 8;
  }

  return table;
}

function bytesToU64le(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

/** Per-block subkeys derived from the XOR table at (blockCounter & 0xF8). */
interface BlockKey {
  offset: number;
  lowerVal: bigint;
  higherVal: bigint;
  specialKey1: bigint;
  specialKey2: bigint;
}

function blockKey(xorTable: Uint8Array, blockCounter: number): BlockKey {
  const offset = blockCounter & 0xf8;

  // Counter mix: (bc | bc<<10 | bc<<20 | bc<<30), split low/high 32.
  const bc = BigInt(blockCounter >>> 0);
  const mix = (bc | (bc << 10n) | (bc << 20n) | (bc << 30n)) & MASK64;
  const evalLow = mix & MASK32;
  const fvalHigh = (mix >> 32n) & MASK32;

  const lowerVal = BigInt(u32le(xorTable, offset));
  const higherVal = BigInt(u32le(xorTable, offset + 4));

  const carry = evalLow > 1587207352n ? 1n : 0n;
  const specialKey1 = (evalLow + 2707759943n) & MASK64;
  const specialKey2 = (fvalHigh + carry) & MASK64;

  return { offset, lowerVal, higherVal, specialKey1, specialKey2 };
}

/** Decrypt-direction byte transform: 8 rounds of (sbox then subtract table byte). */
function loopAByte(value: number, xorTable: Uint8Array, offset: number): number {
  let v = value & 0xff;
  for (let i = 0; i < 8; i++) {
    const s = sbox(v);
    v = (s - xorTable[offset + i]) & 0xff;
  }
  return v;
}

/** Encrypt-direction inverse: 8 rounds descending (add table byte then inverse sbox). */
function loopAByteReverse(value: number, xorTable: Uint8Array, offset: number): number {
  let v = value & 0xff;
  for (let i = 7; i >= 0; i--) {
    const t = (xorTable[offset + i] + v) & 0xff;
    v = sboxInverse(t);
  }
  return v;
}

/**
 * Decrypt `blockCount` 8-byte blocks. `data` holds the ciphertext body
 * (already excluding any verbatim header). Returns a new buffer.
 */
export function decryptBlocks(xorTable: Uint8Array, data: Uint8Array, blockCount: number): Uint8Array {
  const out = new Uint8Array(blockCount * 8);
  for (let i = 0; i < blockCount; i++) {
    const blockCounter = i * 8;
    const blockIndex = blockCounter >>> 3; // = i
    const p = i * 8;
    const a = data.subarray(p, p + 8);
    const k = blockKey(xorTable, blockCounter);

    const d1 = loopAByte(((blockIndex ^ 0x45) & 0xff) ^ a[0], xorTable, k.offset);
    const d2 = loopAByte(a[0] ^ a[1], xorTable, k.offset);
    const d3 = loopAByte(a[1] ^ a[2], xorTable, k.offset);
    const d4 = loopAByte(a[2] ^ a[3], xorTable, k.offset);
    const d5 = loopAByte(a[3] ^ a[4], xorTable, k.offset);
    const d6 = loopAByte(a[4] ^ a[5], xorTable, k.offset);
    const d7 = loopAByte(a[5] ^ a[6], xorTable, k.offset);
    const d8 = loopAByte(a[6] ^ a[7], xorTable, k.offset);

    const obj = new Uint8Array([d5, d6, d7, d8, d1, d2, d3, d4]);
    const num3 = BigInt(u32le(obj, 0));
    const num4 = BigInt(u32le(obj, 4));

    let num5 = num4;
    let num6 = num3;
    const carry = num5 < k.lowerVal ? 1n : 0n;
    num5 = (num5 - k.lowerVal) & MASK64;
    num6 = (num6 - k.higherVal) & MASK64;
    num6 = (num6 - carry) & MASK64;
    num5 = (num5 ^ k.specialKey1) & MASK64;
    num6 = (num6 ^ k.specialKey2) & MASK64;
    num5 = (num5 ^ k.lowerVal) & MASK64;
    num6 = (num6 ^ k.higherVal) & MASK64;

    putU32le(out, p, Number(num6 & MASK32)); // high word first
    putU32le(out, p + 4, Number(num5 & MASK32));
  }
  return out;
}

/** Encrypt `blockCount` 8-byte blocks. Inverse of decryptBlocks. */
export function encryptBlocks(xorTable: Uint8Array, data: Uint8Array, blockCount: number): Uint8Array {
  const out = new Uint8Array(blockCount * 8);
  for (let i = 0; i < blockCount; i++) {
    const blockCounter = i * 8;
    const blockIndex = blockCounter >>> 3;
    const p = i * 8;
    const a = data.subarray(p, p + 8);
    const k = blockKey(xorTable, blockCounter);

    // num4 (high word source) from a[7..4]; num3 (low word source) from a[3..0],
    // each sign-extended in the high 32 bits with 0xFFFFFFFF (matches original).
    let num3 = (0xffffffff00000000n | BigInt(beU32(a, 4, 7))) & MASK64;
    let num4 = (0xffffffff00000000n | BigInt(beU32(a, 0, 3))) & MASK64;

    num3 = (num3 ^ k.lowerVal) & MASK64;
    let num5 = (num4 ^ k.higherVal) & MASK64;
    num3 = (num3 ^ k.specialKey1) & MASK64;
    let num6 = (num5 ^ k.specialKey2) & MASK64;
    num3 = (num3 + k.lowerVal) & MASK64;
    let num7 = (num6 + k.higherVal) & MASK64;
    const carry = (num3 & MASK32) < k.lowerVal ? 1n : 0n;
    const num8 = (num7 + carry) & MASK32;
    const num9 = num3 & MASK32;

    const array2 = new Uint8Array(8);
    putU32le(array2, 0, Number(num9));
    putU32le(array2, 4, Number(num8));

    const c = new Uint8Array(8);
    c[0] = (((blockIndex ^ 0x45) & 0xff) ^ loopAByteReverse(array2[0], xorTable, k.offset)) & 0xff;
    for (let j = 1; j < 8; j++) {
      c[j] = (c[j - 1] ^ loopAByteReverse(array2[j], xorTable, k.offset)) & 0xff;
    }
    out.set(c, p);
  }
  return out;
}

/** Read bytes [lo..hi] (inclusive) of `a` as a big-endian uint32. */
function beU32(a: Uint8Array, lo: number, hi: number): number {
  // The original builds "FFFFFFFF" + hex(a[hi])..hex(a[lo]) reversed; the low
  // 32 bits are the bytes a[hi],a[hi-1],...,a[lo] in big-endian order.
  let v = 0;
  for (let i = hi; i >= lo; i--) v = ((v << 8) | a[i]) >>> 0;
  return v >>> 0;
}

/** Additive checksum: sum of every 4th byte over `count` words (mod 2^32). */
export function computeChecksum(data: Uint8Array, start: number, words: number): number {
  let sum = 0;
  let pos = start;
  for (let i = 0; i < words; i++) {
    sum = (sum + data[pos]) >>> 0;
    pos += 4;
  }
  return sum >>> 0;
}
