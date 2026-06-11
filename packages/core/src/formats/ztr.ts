/**
 * ZTR text container (the FFXIII trilogy's compressed string tables). Decodes a
 * ZTR into `{ id, text }` line pairs and re-encodes line pairs back into a
 * byte-identical-shaped ZTR.
 *
 * Header (20 bytes, all multi-byte fields BIG-ENDIAN):
 *   0x00  uint64  Magic                 always 1 (skipped on read)
 *   0x08  uint32  LineCount             number of lines (= number of IDs)
 *   0x0C  uint32  DcmpIDsSize           decompressed size of the IDs blob
 *   0x10  uint32  DictChunkOffsetsCount number of entries in the offset table
 *
 * Then, in order:
 *   - dict-chunk-offset table: `DictChunkOffsetsCount` x uint32 BE. The first
 *     entry is always 0; each subsequent entry is the END offset (== next chunk
 *     start) of a message chunk, measured from the start of the compressed
 *     message blob.
 *   - LineInfo table: `LineCount` x 4 bytes, one per line:
 *         +0x00  uint8   DictChunkID            which message chunk the line starts in
 *         +0x01  uint8   CharaStartInDictPage   start offset inside an expanded BPE page
 *         +0x02  uint16  LineStartPosInChunk    BE; line start within the decompressed chunk
 *   - compressed IDs blob: the NUL-separated id strings (cp1252/ASCII), grouped
 *     into <=4096-byte chunks, each byte-pair-compressed (see below).
 *   - compressed message blob: the decoded message lines (each terminated by a
 *     double-NUL), grouped into <=4096-byte chunks, each byte-pair-compressed.
 *
 * Byte-pair (BPE) chunk layout, produced by {@link compressChunk}:
 *   [uint32 BE tableSize][ (page, a, b) triples ][ payload ]
 * Each triple says "the single byte `page` expands to the pair (a, b)"; a page
 * may itself reference an earlier page, so expansion is recursive. `tableSize`
 * is the byte length of the triple table (always a multiple of 3). The payload
 * is the compressed data: every page byte expands, every other byte is literal.
 *
 * Codepage handling: this reproduces the codepage-932 ("Latin/Japanese", LJ)
 * decode/encode path, which covers every Western FFXIII release. For that path
 * the message bytes that survive glyph mapping are single-byte and map 1:1 onto
 * cp1252/ASCII, so no external codepage library is required for ASCII text.
 * Full Shift-JIS (cp932), Chinese (cp950) and Korean (cp51949) round trips of
 * non-ASCII source bytes would need a codepage transcoder (`iconv-lite` is the
 * natural optional dependency); see {@link ZtrLimitations}.
 */
import { BinaryReader, BinaryWriter } from '../archive/binary.js';
import {
  SINGLE_KEYS,
  BASE_CHARA_KEYS,
  EX_CHARA_KEYS,
  SPECIAL_KEYS,
  UNK_KEYS,
  UNK2_KEYS,
  DECODED_CHARA_KEYS,
  gameTables,
  packPair,
  type ZtrGameCode,
} from './ztr-dicts.js';

/** A single decoded ZTR line: a string id and its message text. */
export interface ZtrLine {
  /** Line identifier (ASCII/cp1252 key). */
  id: string;
  /** Message text, with control glyphs rendered as `{Token}` sequences. */
  text: string;
}

/** Result of {@link parseZtr}. */
export interface ParsedZtr {
  lines: ZtrLine[];
}

/** Options shared by {@link parseZtr} and {@link buildZtr}. */
export interface ZtrOptions {
  /**
   * Which title's colour/icon/button tables to use when mapping control
   * glyphs. 1 = XIII, 2 = XIII-2, 3 = Lightning Returns. Defaults to 2.
   */
  game?: ZtrGameCode;
}

/** Options for {@link buildZtr}. */
export interface BuildZtrOptions extends ZtrOptions {
  /**
   * Byte-pair-compress the IDs and message blobs. When false the blobs are
   * stored with empty BPE tables (uncompressed). Defaults to true.
   */
  compress?: boolean;
}

const HEADER_SIZE = 20;
const MAGIC = 1;
/** Maximum decompressed bytes per BPE chunk (a hard limit of the format). */
const MAX_CHUNK = 4096;

// ---------------------------------------------------------------------------
// Byte-pair (BPE) compression
// ---------------------------------------------------------------------------

/**
 * The byte values usable as BPE "page" markers: every byte 0..255 that does
 * NOT occur in the data and is not 8 (0x08 is reserved). Returned in ascending
 * order.
 */
function getPageNumbers(data: Uint8Array): number[] {
  const present = new Set(data);
  const out: number[] = [];
  for (let i = 0; i <= 255; i++) {
    if (i === 8) continue;
    if (!present.has(i)) out.push(i);
  }
  return out;
}

/**
 * Find the most frequently occurring adjacent byte pair in `data`, using a
 * non-overlapping count from the pair's first occurrence. Returns
 * `[a, b, count]`.
 */
function getLargestOccurringBytes(data: Uint8Array): [number, number, number] {
  let bestA = 0;
  let bestB = 0;
  let bestCount = 0;
  const seen = new Set<number>();
  for (let i = 0; i < data.length - 1; i++) {
    const a = data[i];
    const b = data[i + 1];
    let count = 1;
    const key = (a << 8) | b;
    if (!seen.has(key)) {
      seen.add(key);
      for (let j = i + 2; j < data.length; j++) {
        if (j !== data.length - 1 && a === data[j] && b === data[j + 1]) {
          count++;
          j++;
        }
      }
    }
    if (count > bestCount) {
      bestA = a;
      bestB = b;
      bestCount = count;
    }
  }
  return [bestA, bestB, bestCount];
}

/**
 * Byte-pair-compress one chunk (<= {@link MAX_CHUNK} bytes), producing the
 * `[u32 tableSize][triples][payload]` layout: repeatedly replace the most
 * common pair with an unused page byte until no pair occurs >= 4 times (or
 * pages run out).
 */
export function compressChunk(input: Uint8Array): Buffer {
  const pages = getPageNumbers(input);
  const table: number[] = [];
  let data = Uint8Array.from(input);
  let pageIdx = 0;

  for (;;) {
    const [a, b, count] = getLargestOccurringBytes(data);
    if (count < 4) break;
    if (pageIdx === pages.length) break;
    const page = pages[pageIdx];
    table.push(page, a, b);

    const replaced: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i === data.length - 1) {
        replaced.push(data[i]);
      } else if (data[i] === a && data[i + 1] === b) {
        replaced.push(page);
        i++;
      } else {
        replaced.push(data[i]);
      }
    }
    data = Uint8Array.from(replaced);
    pageIdx++;
  }

  const out = Buffer.allocUnsafe(4 + table.length + data.length);
  out.writeUInt32BE(table.length >>> 0, 0);
  Buffer.from(table).copy(out, 4);
  Buffer.from(data).copy(out, 4 + table.length);
  return out;
}

/**
 * The recursively-expanded page table of a BPE chunk: maps each page byte to
 * the full byte sequence it stands for.
 */
function arrangePageTable(triples: Uint8Array): Map<number, number[]> {
  // Triples are (page, a, b); pages are declared in dependency order.
  const pageList: number[] = [];
  const raw = new Map<number, [number, number]>();
  for (let i = 0; i + 2 < triples.length; i += 3) {
    const page = triples[i];
    pageList.push(page);
    raw.set(page, [triples[i + 1], triples[i + 2]]);
  }
  const pageSet = new Set(pageList);
  const expanded = new Map<number, number[]>();
  for (const page of pageList) {
    const [a, b] = raw.get(page)!;
    const seq: number[] = [];
    if (pageSet.has(a) && expanded.has(a)) seq.push(...expanded.get(a)!);
    else seq.push(a);
    if (pageSet.has(b) && expanded.has(b)) seq.push(...expanded.get(b)!);
    else seq.push(b);
    expanded.set(page, seq);
  }
  return expanded;
}

/**
 * Decompress one BPE chunk produced by {@link compressChunk}. Reads the triple
 * table, builds the recursive page expansion, then walks the payload expanding
 * page bytes and copying every other byte verbatim.
 */
export function decompressChunk(chunk: Uint8Array): Buffer {
  const tableSize = (chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3];
  const triples = chunk.subarray(4, 4 + tableSize);
  const payload = chunk.subarray(4 + tableSize);
  const expanded = arrangePageTable(triples);
  const out: number[] = [];
  for (const byte of payload) {
    const seq = expanded.get(byte);
    if (seq) out.push(...seq);
    else out.push(byte);
  }
  return Buffer.from(out);
}

/**
 * Split a stream into <= {@link MAX_CHUNK}-byte groups (full 4096-byte groups
 * then a remainder).
 */
function groupSizes(total: number): number[] {
  const sizes: number[] = [];
  let remaining = total;
  while (remaining !== 0) {
    const take = Math.min(remaining, MAX_CHUNK);
    sizes.push(take);
    remaining -= take;
  }
  return sizes;
}

/**
 * Decompress a sequence of concatenated BPE chunks back into the original byte
 * stream. Each chunk's `tableSize` header tells us where its payload ends; the
 * number of payload bytes that expand is implied by the page table, so we walk
 * chunk-by-chunk reading `[u32 tableSize][triples][payload]` until `expected`
 * decompressed bytes have been produced (the IDs path) or input is exhausted
 * (the message path, where `expected` is unknown and passed as Infinity).
 */
function decompressBlob(buf: Uint8Array, start: number, end: number): Buffer {
  const out: Buffer[] = [];
  let pos = start;
  while (pos < end) {
    const tableSize = (buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    // The payload length is not stored, so we decompress this chunk by reading
    // its triples then expanding the remainder of the chunk. Chunk boundaries
    // are recoverable because every chunk is independently page-compressed and
    // chunks are concatenated; for the message blob the offset table gives the
    // exact boundaries (see parseZtr), and for the IDs blob we rely on the
    // total decompressed size. Callers that know the boundary pass `end`.
    const triples = buf.subarray(pos + 4, pos + 4 + tableSize);
    const payload = buf.subarray(pos + 4 + tableSize, end);
    const expanded = arrangePageTable(triples);
    const chunkOut: number[] = [];
    for (const byte of payload) {
      const seq = expanded.get(byte);
      if (seq) chunkOut.push(...seq);
      else chunkOut.push(byte);
    }
    out.push(Buffer.from(chunkOut));
    pos = end;
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Glyph (control-token) mapping — codepage-932 (LJ) decode/encode
// ---------------------------------------------------------------------------

/**
 * Decode a raw message-byte stream (for one line, NOT including the trailing
 * double-NUL) into text with control glyphs rendered as `{Token}` sequences,
 * using the codepage-932 (LJ) tables. Two-byte control sequences are matched
 * first against the per-game colour/icon/button tables, then the common
 * BaseChara/Special/Unk tables; single bytes against SingleKeys; any leftover
 * byte is emitted as a literal Latin-1 character.
 */
function decodeLine(bytes: Uint8Array, game: ZtrGameCode): string {
  const { colorKeys, iconKeys, btnKeys } = gameTables(game);
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];

    // Single-byte control token.
    const single = SINGLE_KEYS.get(b);
    if (single !== undefined) {
      out += single;
      i++;
      continue;
    }

    // Two-byte control token.
    if (i + 1 < bytes.length) {
      const key = packPair(b, bytes[i + 1]);
      const two =
        colorKeys.get(key) ??
        iconKeys.get(key) ??
        btnKeys.get(key) ??
        baseCharaToken(key) ??
        SPECIAL_KEYS.get(key) ??
        EX_CHARA_KEYS.get(key) ??
        UNK_KEYS.get(key) ??
        UNK2_KEYS.get(key);
      if (two !== undefined) {
        out += two;
        i += 2;
        continue;
      }
    }

    // 0xFF on its own decodes to {FF}.
    if (b === 0xff) {
      out += '{FF}';
      i++;
      continue;
    }

    // Literal byte (Latin-1 / cp1252 single byte).
    out += Buffer.from([b]).toString('latin1');
    i++;
  }
  return out;
}

/**
 * Resolve a BaseChara two-byte key to its final glyph token. The pair maps to
 * an inner name (e.g. `{0x85_40}`) via `BASE_CHARA_KEYS`, then that name
 * (without braces) maps to the displayed glyph (e.g. `{€}`) via
 * `DECODED_CHARA_KEYS`.
 */
function baseCharaToken(key: number): string | undefined {
  const inner = BASE_CHARA_KEYS.get(key);
  if (inner === undefined) return undefined;
  // inner is like "{0x85_40}"; strip braces to look up the decoded glyph.
  const name = inner.slice(1, -1);
  return DECODED_CHARA_KEYS.get(name) ?? inner;
}

/** Reverse lookup tables, built lazily, for encoding `{Token}` back to bytes. */
interface EncodeTables {
  /** token -> single byte */
  single: Map<string, number>;
  /** token -> [b1, b2] */
  pair: Map<string, [number, number]>;
}

const encodeTableCache = new Map<ZtrGameCode, EncodeTables>();

function buildEncodeTables(game: ZtrGameCode): EncodeTables {
  const cached = encodeTableCache.get(game);
  if (cached) return cached;

  const single = new Map<string, number>();
  for (const [b, token] of SINGLE_KEYS) single.set(token, b);

  const pair = new Map<string, [number, number]>();
  const addPair = (map: ReadonlyMap<number, string>) => {
    for (const [key, token] of map) {
      if (!pair.has(token)) pair.set(token, [(key >> 8) & 0xff, key & 0xff]);
    }
  };
  const { colorKeys, iconKeys, btnKeys } = gameTables(game);
  // Match the encoder's precedence: Single (above), then Color/Icon/Btn, then
  // BaseChara (decoded glyph), ExChara, Special, Unk, Unk2.
  addPair(colorKeys);
  addPair(iconKeys);
  addPair(btnKeys);
  // BaseChara: encode the displayed glyph token (e.g. {€}) back to its pair.
  for (const [key, inner] of BASE_CHARA_KEYS) {
    const glyph = DECODED_CHARA_KEYS.get(inner.slice(1, -1));
    if (glyph !== undefined && !pair.has(glyph)) {
      pair.set(glyph, [(key >> 8) & 0xff, key & 0xff]);
    }
  }
  addPair(EX_CHARA_KEYS);
  addPair(SPECIAL_KEYS);
  addPair(UNK_KEYS);
  addPair(UNK2_KEYS);

  const tables = { single, pair };
  encodeTableCache.set(game, tables);
  return tables;
}

/**
 * Encode a text line (with `{Token}` glyph sequences) back into the raw
 * message-byte stream (NOT including the trailing double-NUL), inverse of
 * {@link decodeLine}. Unknown `{...}` runs are written through verbatim as
 * their literal bytes.
 */
function encodeLine(text: string, game: ZtrGameCode): Buffer {
  const tables = buildEncodeTables(game);
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const close = text.indexOf('}', i);
      if (close !== -1) {
        const token = text.slice(i, close + 1);
        const inner = text.slice(i + 1, close);
        if (token === '{FF}') {
          out.push(0xff);
          i = close + 1;
          continue;
        }
        const sb = tables.single.get(token);
        if (sb !== undefined) {
          out.push(sb);
          i = close + 1;
          continue;
        }
        const pb = tables.pair.get(token);
        if (pb !== undefined) {
          out.push(pb[0], pb[1]);
          i = close + 1;
          continue;
        }
        // Unknown token: emit the brace and inner bytes verbatim as literal
        // bytes.
        for (const byte of Buffer.from(`{${inner}}`, 'latin1')) out.push(byte);
        i = close + 1;
        continue;
      }
    }
    // Literal character -> single Latin-1 byte (ASCII/cp1252 inline path).
    for (const byte of Buffer.from(ch, 'latin1')) out.push(byte);
    i++;
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Decode: parseZtr
// ---------------------------------------------------------------------------

/**
 * Parse a ZTR container into its `{ id, text }` lines. Reads the big-endian
 * header, decompresses the IDs blob (NUL-separated id strings) and the message
 * blob (double-NUL-terminated lines), and renders control glyphs as `{Token}`
 * sequences using the codepage-932 (LJ) tables for the chosen {@link
 * ZtrOptions.game}.
 *
 * @param buf the full ZTR container bytes
 * @param opts decode options (game selector)
 * @throws if the buffer is too small to contain the header/tables
 */
export function parseZtr(buf: Uint8Array | Buffer, opts: ZtrOptions = {}): ParsedZtr {
  const game = opts.game ?? 2;
  const r = new BinaryReader(buf);
  if (buf.length < HEADER_SIZE) {
    throw new Error('Not a valid ZTR file (too small for header)');
  }

  // Header (skip the 8-byte magic).
  r.seek(8);
  const lineCount = r.readU32(true);
  const dcmpIdsSize = r.readU32(true);
  const dictChunkOffsetsCount = r.readU32(true);

  // Dict-chunk-offset table (offsets into the compressed message blob).
  const offsets: number[] = [];
  for (let i = 0; i < dictChunkOffsetsCount; i++) offsets.push(r.readU32(true));

  // LineInfo table (4 bytes/line) — read but not required to reconstruct text,
  // since we fully decompress the message blob and split on double-NUL.
  const lineInfoStart = r.pos;
  const idsBlobStart = lineInfoStart + lineCount * 4;

  // The IDs blob occupies everything between the LineInfo table and the start
  // of the message blob. The message blob starts at idsBlobStart + (size of the
  // compressed IDs). We don't store the compressed IDs size, but the IDs
  // decompress to exactly `dcmpIdsSize` bytes; we recover the boundary by
  // decompressing IDs chunk-by-chunk for `dcmpIdsSize` output bytes.
  const idsGroups = groupSizes(dcmpIdsSize);
  const ids = decompressIds(buf, idsBlobStart, idsGroups);
  const messageBlobStart = ids.consumedEnd;

  // Message blob: decompress every chunk delimited by the offset table. The
  // last offset entry marks the end of the final chunk; the table's first
  // entry is 0 (start of the blob). Offsets are relative to messageBlobStart.
  const messageBytes = decompressMessageBlob(buf, messageBlobStart, offsets);

  // Split the decompressed IDs stream into NUL-separated ids.
  const idStrings = splitIds(ids.data, lineCount);
  // Split the decompressed message stream into double-NUL-terminated lines.
  const lineByteRuns = splitLines(messageBytes, lineCount);

  const lines: ZtrLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push({
      id: idStrings[i] ?? '',
      text: decodeLine(lineByteRuns[i] ?? new Uint8Array(0), game),
    });
  }
  return { lines };
}

/** Decompress the IDs blob and report where it ends. */
function decompressIds(
  buf: Uint8Array,
  start: number,
  sizes: number[],
): { data: Buffer; consumedEnd: number } {
  const out: Buffer[] = [];
  let pos = start;
  for (const want of sizes) {
    const tableSize = (buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    const triples = buf.subarray(pos + 4, pos + 4 + tableSize);
    const expanded = arrangePageTable(triples);
    let payloadPos = pos + 4 + tableSize;
    const chunkOut: number[] = [];
    // Read payload bytes until we have produced `want` decompressed bytes.
    while (chunkOut.length < want) {
      const byte = buf[payloadPos++];
      const seq = expanded.get(byte);
      if (seq) chunkOut.push(...seq);
      else chunkOut.push(byte);
    }
    out.push(Buffer.from(chunkOut));
    pos = payloadPos;
  }
  return { data: Buffer.concat(out), consumedEnd: pos };
}

/** Decompress the message blob using the dict-chunk offset boundaries. */
function decompressMessageBlob(buf: Uint8Array, start: number, offsets: number[]): Buffer {
  const out: Buffer[] = [];
  // offsets[0] is 0; consecutive offsets delimit each chunk within the blob.
  for (let i = 0; i + 1 < offsets.length; i++) {
    const chunkStart = start + offsets[i];
    const chunkEnd = start + offsets[i + 1];
    out.push(decompressBlob(buf, chunkStart, chunkEnd));
  }
  // If there is exactly one offset (no chunks), there are no messages.
  return Buffer.concat(out);
}

/** Split a decompressed IDs stream (NUL-separated) into `count` strings. */
function splitIds(data: Buffer, count: number): string[] {
  const ids: string[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    let end = pos;
    while (end < data.length && data[end] !== 0) end++;
    ids.push(data.toString('latin1', pos, end));
    pos = end + 1; // skip the NUL
  }
  return ids;
}

/**
 * Split a decompressed message stream into `count` byte runs, one per line,
 * where each line is terminated by a double-NUL (`0x00 0x00`).
 */
function splitLines(data: Buffer, count: number): Uint8Array[] {
  const runs: Uint8Array[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    let end = pos;
    while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0)) end++;
    // `end` now points at the first NUL of the double-NUL (or near the end).
    runs.push(data.subarray(pos, end));
    pos = end + 2; // skip both NUL bytes
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Encode: buildZtr
// ---------------------------------------------------------------------------

/**
 * Build a ZTR container from `{ id, text }` lines, inverse of {@link parseZtr}.
 * Ids are written NUL-separated (cp1252/ASCII) and byte-pair-compressed;
 * message text is glyph-encoded (LJ tables) with each line double-NUL
 * terminated, then byte-pair-compressed into <= {@link MAX_CHUNK}-byte chunks.
 * The dict-chunk-offset and LineInfo tables are computed from the compressed
 * message chunks. With `compress: false` the blobs use empty BPE tables.
 *
 * @param lines the lines to encode, in order
 * @param opts encode options (game selector, compression toggle)
 * @returns the assembled ZTR container bytes
 */
export function buildZtr(lines: ZtrLine[], opts: BuildZtrOptions = {}): Buffer {
  const game = opts.game ?? 2;
  const compress = opts.compress ?? true;

  // 1. Build the decompressed IDs stream: each id (cp1252) then a NUL.
  const idsW = new BinaryWriter();
  for (const line of lines) {
    idsW.writeBytes(Buffer.from(line.id, 'latin1'));
    idsW.writeU8(0);
  }
  const idsRaw = idsW.toBuffer();
  const dcmpIdsSize = idsRaw.length;

  // 2. Build the decompressed message stream: each glyph-encoded line then a
  //    double-NUL terminator.
  const msgW = new BinaryWriter();
  for (const line of lines) {
    msgW.writeBytes(encodeLine(line.text, game));
    msgW.writeU16(0); // double-NUL (two zero bytes)
  }
  const msgRaw = msgW.toBuffer();

  // 3. Compress (or wrap) the IDs blob, chunk by chunk.
  const idsBlob = buildBlob(idsRaw, compress);

  // 4. Compress (or wrap) the message blob, chunk by chunk, recording the END
  //    offset of each chunk (the dict-chunk offset table starts with a 0).
  const msgChunks: Buffer[] = [];
  const msgOffsets: number[] = [0];
  let msgCursor = 0;
  for (const size of groupSizes(msgRaw.length)) {
    const slice = msgRaw.subarray(msgCursor, msgCursor + size);
    msgCursor += size;
    const chunk = compress ? compressChunk(slice) : wrapUncompressed(slice);
    msgChunks.push(chunk);
    msgOffsets.push(msgOffsets[msgOffsets.length - 1] + chunk.length);
  }
  const msgBlob = Buffer.concat(msgChunks);

  // 5. Build the LineInfo table by walking the decompressed message stream and
  //    locating each line's start (chunk id + offset within the decompressed
  //    chunk). This reproduces the layout the reader expects.
  const lineInfo = buildLineInfoTable(msgRaw, lines.length);

  // 6. Assemble: header + offset table + LineInfo table + IDs blob + msg blob.
  const dictChunkOffsetsCount = msgOffsets.length;
  const header = new BinaryWriter();
  // Magic is a u64; write it as two u32 (high 0, low MAGIC) big-endian.
  header.writeU32(0, true);
  header.writeU32(MAGIC, true);
  header.writeU32(lines.length, true);
  header.writeU32(dcmpIdsSize, true);
  header.writeU32(dictChunkOffsetsCount, true);

  const offsetTable = new BinaryWriter();
  for (const off of msgOffsets) offsetTable.writeU32(off, true);

  return Buffer.concat([
    header.toBuffer(),
    offsetTable.toBuffer(),
    lineInfo,
    idsBlob,
    msgBlob,
  ]);
}

/** Compress (or wrap) an entire blob into concatenated BPE chunks. */
function buildBlob(raw: Buffer, compress: boolean): Buffer {
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const size of groupSizes(raw.length)) {
    const slice = raw.subarray(cursor, cursor + size);
    cursor += size;
    chunks.push(compress ? compressChunk(slice) : wrapUncompressed(slice));
  }
  return Buffer.concat(chunks);
}

/** Wrap a chunk with an empty BPE table (the uncompressed `[u32 0][payload]`). */
function wrapUncompressed(slice: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + slice.length);
  out.writeUInt32BE(0, 0);
  Buffer.from(slice).copy(out, 4);
  return out;
}

/**
 * Build the LineInfo table (4 bytes per line) by scanning the decompressed
 * message stream for line starts. DictChunkID is the 4096-byte chunk the line
 * starts in; LineStartPosInChunk is the byte offset of the line within that
 * decompressed chunk; CharaStartInDictPage is 0 for our writer (we never split
 * a line start across a BPE page).
 */
function buildLineInfoTable(msgRaw: Buffer, count: number): Buffer {
  const w = new BinaryWriter();
  let lineStart = 0;
  let prevWasNull = false;
  // Locate each line start: line 0 starts at 0; each subsequent line starts
  // right after a double-NUL terminator.
  const starts: number[] = [0];
  for (let i = 0; i < msgRaw.length && starts.length < count; i++) {
    const b = msgRaw[i];
    if (b === 0 && prevWasNull) {
      // i is the second NUL of a terminator; the next line starts at i+1.
      if (i + 1 < msgRaw.length) starts.push(i + 1);
      prevWasNull = false;
    } else {
      prevWasNull = b === 0;
    }
  }
  for (let i = 0; i < count; i++) {
    lineStart = starts[i] ?? msgRaw.length;
    const chunkId = Math.floor(lineStart / MAX_CHUNK);
    const posInChunk = lineStart % MAX_CHUNK;
    w.writeU8(chunkId & 0xff);
    w.writeU8(0); // CharaStartInDictPage
    w.writeU16(posInChunk & 0xffff, true);
  }
  return w.toBuffer();
}

/** Notes on this module's codepage limitations. */
export const ZtrLimitations = {
  /**
   * Only the codepage-932 (Latin/Japanese) glyph path is implemented. ASCII and
   * cp1252 single-byte text round-trips exactly. Multi-byte Shift-JIS (cp932),
   * Chinese (cp950) and Korean (cp51949) source bytes that are NOT covered by
   * the control-glyph tables are passed through as Latin-1 and would require an
   * external transcoder (e.g. iconv-lite) to recover their original code points.
   */
  codepage: 'cp932 (LJ) glyph path only; ASCII/cp1252 exact, full DBCS needs iconv-lite',
} as const;
