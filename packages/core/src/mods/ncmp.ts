/**
 * `.ncmp` ModPack reader/writer. An `.ncmp` is a plain ZIP archive (PKZIP / APPNOTE
 * format) containing `modconfig.ini` plus the mod's file tree (`Data/`,
 * `EN-Data/`, `JP-Data/`, `External/`, `Code/`, and optional presentation
 * assets). This module implements just enough of the ZIP format BY HAND — using
 * only Node's `zlib` (raw DEFLATE) and `crypto` (CRC via a small table) — to read
 * and write nested folders, with NO external dependencies.
 *
 * Supported on read: STORE (method 0) and DEFLATE (method 8) entries, with the
 * size/crc taken from the central directory (robust against streaming/data-
 * descriptor local headers). Supported on write: DEFLATE by default, with a
 * STORE fallback when compression does not help. Zip64 is not implemented (mod
 * packs are far below the 4 GiB / 65535-entry limits); a clear error is thrown
 * if those limits are exceeded.
 *
 * Entry names always use `/` separators (backslashes are normalised on both
 * read and write) so packs round-trip identically across Windows and Unix.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// ZIP signatures & constants
// ---------------------------------------------------------------------------
const SIG_LOCAL = 0x04034b50; // "PK\x03\x04" local file header
const SIG_CENTRAL = 0x02014b50; // "PK\x01\x02" central directory header
const SIG_EOCD = 0x06054b50; // "PK\x05\x06" end of central directory
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20; // 2.0 — DEFLATE + folders
const EOCD_MIN = 22; // EOCD record without comment

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3) — required by the ZIP format for each entry.
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** Compute the CRC-32 of a buffer (matches the ZIP / zlib polynomial). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One decoded ZIP entry. Directory entries (names ending in `/`) are skipped. */
export interface NcmpEntry {
  /** `/`-separated entry path. */
  name: string;
  /** Decompressed file contents. */
  data: Buffer;
}

/** Locate and parse the End Of Central Directory record. */
function findEocd(buf: Buffer): { entries: number; cdOffset: number; cdSize: number } {
  // Scan backwards for the EOCD signature (ZIP comment may follow it).
  const minStart = Math.max(0, buf.length - EOCD_MIN - 0xffff);
  for (let i = buf.length - EOCD_MIN; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const entries = buf.readUInt16LE(i + 10);
      const cdSize = buf.readUInt32LE(i + 12);
      const cdOffset = buf.readUInt32LE(i + 16);
      return { entries, cdOffset, cdSize };
    }
  }
  throw new Error('not a ZIP/.ncmp archive: End Of Central Directory not found');
}

/** Parse every entry out of a ZIP/.ncmp buffer into name+data pairs. */
export function parseZip(buf: Buffer): NcmpEntry[] {
  const eocd = findEocd(buf);
  const out: NcmpEntry[] = [];
  let p = eocd.cdOffset;

  for (let n = 0; n < eocd.entries; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`corrupt central directory at offset ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;

    // Skip directory markers.
    if (name.endsWith('/')) continue;

    // Read the local header to find the real data offset (its name/extra lengths
    // can differ from the central directory's extra field).
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`corrupt local header for "${name}" at offset ${localOffset}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === METHOD_STORE) {
      data = Buffer.from(comp);
    } else if (method === METHOD_DEFLATE) {
      data = inflateRawSync(comp);
    } else {
      throw new Error(`unsupported ZIP compression method ${method} for "${name}"`);
    }
    if (data.length !== uncompSize) {
      throw new Error(`size mismatch for "${name}": expected ${uncompSize}, got ${data.length}`);
    }
    out.push({ name, data });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A file to place in a new ZIP/.ncmp. */
export interface ZipInput {
  /** Entry name (backslashes are normalised to `/`). */
  name: string;
  data: Buffer | Uint8Array;
  /**
   * Force STORE (no compression). By default each entry is DEFLATE-compressed
   * and STORE is used only when it would not shrink the data.
   */
  store?: boolean;
}

/**
 * Build a ZIP/.ncmp buffer from a list of files. Uses DEFLATE per entry, falling
 * back to STORE when compression does not help (or when `store` is set). Throws
 * if a Zip64 condition would be required (>4 GiB total / >65535 entries).
 */
export function buildZip(inputs: ZipInput[]): Buffer {
  if (inputs.length > 0xffff) {
    throw new Error('too many entries for a non-Zip64 archive (>65535)');
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const inp of inputs) {
    const name = inp.name.replace(/\\/g, '/');
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(inp.data) ? inp.data : Buffer.from(inp.data);
    const crc = crc32(data);

    let method = METHOD_STORE;
    let stored = data;
    if (!inp.store && data.length > 0) {
      const deflated = deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = METHOD_DEFLATE;
        stored = deflated;
      }
    }

    if (offset + 30 + nameBytes.length + stored.length > 0xffffffff) {
      throw new Error('archive exceeds 4 GiB; Zip64 is not supported');
    }

    // Local file header (30 bytes + name).
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(VERSION_NEEDED, 4);
    lh.writeUInt16LE(0, 6); // general purpose flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0x21, 12); // mod date (1980-01-01 valid minimum)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28); // extra length
    localParts.push(lh, nameBytes, stored);

    // Central directory header (46 bytes + name).
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    ch.writeUInt16LE(VERSION_NEEDED, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); // mod time
    ch.writeUInt16LE(0x21, 14); // mod date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBytes.length, 28);
    ch.writeUInt16LE(0, 30); // extra length
    ch.writeUInt16LE(0, 32); // comment length
    ch.writeUInt16LE(0, 34); // disk number start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(ch, nameBytes);

    offset += lh.length + nameBytes.length + stored.length;
  }

  const localBlob = Buffer.concat(localParts);
  const centralBlob = Buffer.concat(centralParts);

  // End Of Central Directory.
  const eocd = Buffer.alloc(EOCD_MIN);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with CD start
  eocd.writeUInt16LE(inputs.length, 8); // entries on this disk
  eocd.writeUInt16LE(inputs.length, 10); // total entries
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBlob, centralBlob, eocd]);
}

// ---------------------------------------------------------------------------
// Filesystem-level helpers
// ---------------------------------------------------------------------------

/** Recursively list every file under `dir`, returning paths relative to `dir`. */
async function walkFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(full, base)));
    } else if (e.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

/**
 * Extract a `.ncmp` (ZIP) into `destDir`, recreating its folder tree. Entry
 * names are normalised to `/` and any leading slashes / `..` traversal segments
 * are stripped so extraction stays inside `destDir`.
 */
export async function extractNcmp(ncmpPath: string, destDir: string): Promise<void> {
  const buf = await fs.readFile(ncmpPath);
  const entries = parseZip(buf);
  await fs.mkdir(destDir, { recursive: true });

  for (const entry of entries) {
    const rel = sanitizeEntryName(entry.name);
    if (rel === '') continue;
    const outPath = path.join(destDir, rel);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, entry.data);
  }
}

/**
 * Pack the entire contents of `srcDir` (recursively) into a `.ncmp` (ZIP) at
 * `ncmpPath`. Entry names are stored relative to `srcDir` with `/` separators,
 * in sorted order for deterministic output.
 */
export async function createNcmp(srcDir: string, ncmpPath: string): Promise<void> {
  const rels = (await walkFiles(srcDir)).sort();
  const inputs: ZipInput[] = [];
  for (const rel of rels) {
    const data = await fs.readFile(path.join(srcDir, rel));
    inputs.push({ name: rel.split(path.sep).join('/'), data });
  }
  const zip = buildZip(inputs);
  await fs.mkdir(path.dirname(ncmpPath), { recursive: true });
  await fs.writeFile(ncmpPath, zip);
}

/** Strip leading slashes and `..` path segments from a zip entry name. */
function sanitizeEntryName(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  return parts.join('/');
}
