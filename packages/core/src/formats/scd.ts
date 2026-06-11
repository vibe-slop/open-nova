/**
 * SCD sound container (Square Enix SEDBSSCF) — EXTRACT only.
 *
 * SCD is Square Enix's audio container used throughout the FFXIII trilogy. The
 * file begins with the 8-byte magic "SEDBSSCF" ("SEDB" + "SSCF") followed by an
 * SSCF header, a table of per-stream ("sub-song") offsets, and one stream header
 * per sub-song describing its codec, channel count, sample rate and the location
 * of its raw audio body. See the original NovaChrysalia.Formats/SCD.cs
 * (ConvertSCD).
 *
 * Header / layout (byte offsets; multi-byte fields are LITTLE- or BIG-ENDIAN per
 * the endianness flag at 0x0C — see {@link detectScdEndianness}):
 *   0x00  char[8]  magic               "SEDBSSCF"
 *   0x08  uint32   version             (3 for the FFXIII trilogy)
 *   0x0C  uint8    bigEndianFlag       0 = little-endian, 1 = big-endian
 *   0x0D  uint8    sscfHeaderSize
 *   0x10  uint32   scdSize             total file size (sanity check)
 *   ...
 *   0x30  uint16   tableCount0         (SSCF "table 0" entry count)
 *   0x32  uint16   tableCount1
 *   0x34  uint16   subSongCount        number of sub-song streams (SSCF table 1)
 *   0x36  uint16   unknown
 *   0x38  uint32   table0Pointer
 *   0x3C  uint32   streamOffsetTablePtr offset of the sub-song offset table
 *
 * Sub-song offset table (at `streamOffsetTablePtr`): `subSongCount` uint32
 * absolute offsets, one per sub-song. The original only ever reads the FIRST
 * entry; this implementation reads all `subSongCount` entries.
 *
 * Each entry points at an SCDStreamHeader (32 bytes):
 *   +0x00 uint32  streamSize          size of the raw audio body
 *   +0x04 uint32  channels
 *   +0x08 uint32  sampleRate
 *   +0x0C uint32  codec               see {@link ScdCodec}
 *   +0x10 uint32  loopStart
 *   +0x14 uint32  loopEnd
 *   +0x18 uint32  extraHeaderSize     bytes from the END of the stream header to
 *                                     the start of the raw audio body
 *   +0x1C uint32  auxChunkCount
 *
 * The "extra header" (codec-specific metadata) immediately follows the 32-byte
 * stream header; the raw audio body starts at `streamHeaderOffset + 32 +
 * extraHeaderSize` and is `streamSize` bytes long.
 *
 * EXTRACT only. Repacking audio INTO an SCD requires re-encoding to Square's
 * Vorbis variant via a native tool (the original delegates this to FAudio /
 * "NCVE") and is intentionally out of scope here — see NOTE at the bottom.
 */
import { BinaryReader } from '../archive/binary.js';

/** The 8-byte SCD magic ("SEDB" + "SSCF"). */
const MAGIC = 'SEDBSSCF';
/** Offset of the 1-byte big-endian flag in the SSCF header. */
const ENDIAN_FLAG_OFFSET = 0x0c;
/** Offset of the total-file-size field (used for endianness sanity checking). */
const SCD_SIZE_OFFSET = 0x10;
/** Offset of the sub-song count (SSCF "table 1" entry count). */
const SUBSONG_COUNT_OFFSET = 0x34;
/** Offset of the pointer to the sub-song offset table. */
const STREAM_OFFSET_TABLE_PTR = 0x3c;
/** Size in bytes of one SCDStreamHeader. */
const STREAM_HEADER_SIZE = 32;

/**
 * SCD stream codec ids (`SCDStreamCodec` in the original). These identify the
 * encoding of each sub-song's raw audio body.
 */
export enum ScdCodec {
  /** No/invalid codec. */
  None = -1,
  /** Linear PCM. */
  PCM = 1,
  /** Sony PS-ADPCM. */
  PsAdpcm = 3,
  /** Ogg Vorbis (extracted to `.ogg`; may be byte-XOR obfuscated). */
  Vorbis = 6,
  /** MPEG audio. */
  Mpeg = 7,
  /** Nintendo DSP-ADPCM. */
  DspAdpcm = 10,
  /** Microsoft XMA2. */
  Xma2 = 11,
  /** Microsoft ADPCM (extracted to `.wav`). */
  MsAdpcm = 12,
  /** Sony ATRAC3. */
  Atrac3 = 14,
  /** Sony ATRAC9. */
  Atrac9 = 22,
}

/** Human-readable codec name for a raw codec id (best effort). */
export function scdCodecName(codec: number): string {
  return ScdCodec[codec] ?? `Unknown(${codec})`;
}

/** Endianness of an SCD container. */
export type ScdEndianness = 'little' | 'big';

/** A single decoded sub-song (stream) header. */
export interface ScdSubSong {
  /** Raw codec id (compare against {@link ScdCodec}). */
  codec: number;
  /** Channel count. */
  channels: number;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Absolute offset of the raw audio body within the container. */
  dataOffset: number;
  /** Length in bytes of the raw audio body. */
  dataSize: number;
  /** Loop start sample/marker (0 when unused). */
  loopStart: number;
  /** Loop end sample/marker (0 when unused). */
  loopEnd: number;
  /**
   * Bytes between the end of the 32-byte stream header and the start of the raw
   * audio body (codec-specific "extra header" region).
   */
  extraHeaderSize: number;
  /** Absolute offset of this sub-song's 32-byte stream header. */
  streamHeaderOffset: number;
}

/** Result of {@link parseScd}. */
export interface ParsedScd {
  /** SSCF version (3 for the FFXIII trilogy). */
  version: number;
  /** Endianness of the container's multi-byte fields. */
  endianness: ScdEndianness;
  /** Total file size as recorded in the header. */
  scdSize: number;
  /** Decoded sub-song headers, in table order. */
  subSongs: ScdSubSong[];
}

/**
 * Determine the endianness of an SCD container from the SSCF big-endian flag at
 * offset 0x0C (0 = little-endian, 1 = big-endian). The original treats PC files
 * as native little-endian structs; the FFXIII console builds (PS3/Xbox 360) set
 * this flag for big-endian. As a guard against a corrupt/ambiguous flag, the
 * detected endianness is cross-checked against the `scdSize` field: whichever
 * endianness makes `scdSize` equal the actual file length wins.
 *
 * @param buf the full SCD container bytes
 * @returns the detected endianness
 */
export function detectScdEndianness(buf: Uint8Array | Buffer): ScdEndianness {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const flag = b.readUInt8(ENDIAN_FLAG_OFFSET);
  let endianness: ScdEndianness = flag === 1 ? 'big' : 'little';

  // Sanity check via the total-size field: if the flagged endianness disagrees
  // with the file length but the other endianness matches it exactly, trust the
  // size field instead (defends against a mis-set/garbage flag byte).
  if (b.length >= SCD_SIZE_OFFSET + 4) {
    const sizeLE = b.readUInt32LE(SCD_SIZE_OFFSET);
    const sizeBE = b.readUInt32BE(SCD_SIZE_OFFSET);
    const matchLE = sizeLE === b.length;
    const matchBE = sizeBE === b.length;
    if (matchLE && !matchBE) endianness = 'little';
    else if (matchBE && !matchLE) endianness = 'big';
  }

  return endianness;
}

/**
 * Parse an SCD container header and all of its sub-song stream headers.
 * Validates the "SEDBSSCF" magic, detects endianness via
 * {@link detectScdEndianness}, then walks the sub-song offset table and reads
 * each {@link ScdSubSong}. Mirrors the offset arithmetic in the original's
 * ConvertSCD (`dataOffset = streamHeaderOffset + 32 + extraHeaderSize`) but
 * reads ALL sub-songs rather than only the first.
 *
 * @param buf the full SCD container bytes
 * @returns the parsed header and sub-song list
 * @throws if the magic is not "SEDBSSCF" or the structure runs out of bounds
 */
export function parseScd(buf: Uint8Array | Buffer): ParsedScd {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  const magic = data.toString('latin1', 0, 8);
  if (magic !== MAGIC) {
    throw new Error(`Not a valid SCD file (bad magic: ${JSON.stringify(magic)})`);
  }

  const endianness = detectScdEndianness(data);
  const be = endianness === 'big';
  const r = new BinaryReader(data, 8);

  const version = r.readU32(be);
  const scdSize = data.length >= SCD_SIZE_OFFSET + 4 ? new BinaryReader(data, SCD_SIZE_OFFSET).readU32(be) : data.length;

  // Sub-song count (SSCF "table 1" entry count) and the offset-table pointer.
  const subSongCount = new BinaryReader(data, SUBSONG_COUNT_OFFSET).readU16(be);
  const tablePtr = new BinaryReader(data, STREAM_OFFSET_TABLE_PTR).readU32(be);

  const subSongs: ScdSubSong[] = [];
  for (let i = 0; i < subSongCount; i++) {
    const entryPos = tablePtr + i * 4;
    if (entryPos + 4 > data.length) {
      throw new Error(`SCD sub-song offset table entry ${i} is out of bounds`);
    }
    const streamHeaderOffset = new BinaryReader(data, entryPos).readU32(be);
    // A zero offset marks an empty slot in the table (the table is sized to the
    // largest of several SSCF tables); skip it like the original ignores them.
    if (streamHeaderOffset === 0) continue;
    if (streamHeaderOffset + STREAM_HEADER_SIZE > data.length) {
      throw new Error(`SCD stream header ${i} at 0x${streamHeaderOffset.toString(16)} is out of bounds`);
    }

    const sr = new BinaryReader(data, streamHeaderOffset);
    const streamSize = sr.readU32(be);
    const channels = sr.readU32(be);
    const sampleRate = sr.readU32(be);
    const codec = sr.readU32(be);
    const loopStart = sr.readU32(be);
    const loopEnd = sr.readU32(be);
    const extraHeaderSize = sr.readU32(be);
    // auxChunkCount (sr position +0x1C) is read implicitly via the 32-byte stride.

    const dataOffset = streamHeaderOffset + STREAM_HEADER_SIZE + extraHeaderSize;

    subSongs.push({
      codec,
      channels,
      sampleRate,
      dataOffset,
      dataSize: streamSize,
      loopStart,
      loopEnd,
      extraHeaderSize,
      streamHeaderOffset,
    });
  }

  return { version, endianness, scdSize, subSongs };
}

/** An extracted audio sub-stream from an SCD container. */
export interface ExtractedScdStream {
  /**
   * Suggested base name / extension hint for the extracted audio. `.ogg` for
   * Vorbis, `.wav` for the wrapped MS-ADPCM output, otherwise `.bin` for codecs
   * whose raw body the original does not transcode.
   */
  name?: string;
  /** The extracted audio bytes (a playable container for Vorbis/MS-ADPCM). */
  data: Buffer;
}

/**
 * Extract the raw audio sub-streams from an SCD container, mirroring the
 * original's ConvertSCD output:
 *
 *  - Codec 6 (Vorbis): emits an `.ogg`. When the Vorbis "extra header" marks the
 *    header block as XOR-obfuscated (`encodeType != 0`), the header bytes are
 *    de-obfuscated with the single-byte XOR key (`encodeByte`) and prepended to
 *    the audio body, exactly as the original does; otherwise the raw body is the
 *    complete `.ogg`.
 *  - Codec 12 (MS-ADPCM): emits a `.wav` by reconstructing the RIFF/`fmt `/`data`
 *    wrapper from the MSADPCMHeader stored in the extra header, then the body.
 *  - Any other codec: emits the raw body verbatim with a `.bin` hint (the
 *    original aborts on these, but extracting the bytes is still useful).
 *
 * @param buf the full SCD container bytes
 * @returns one entry per non-empty sub-song
 * @throws if the container header is invalid (via {@link parseScd})
 */
export function extractScd(buf: Uint8Array | Buffer): ExtractedScdStream[] {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const { endianness, subSongs } = parseScd(data);
  const be = endianness === 'big';

  const out: ExtractedScdStream[] = [];
  for (const s of subSongs) {
    if (s.codec === ScdCodec.Vorbis) {
      out.push(extractVorbis(data, s, be));
    } else if (s.codec === ScdCodec.MsAdpcm) {
      out.push(extractMsAdpcm(data, s, be));
    } else {
      // Unsupported transcode: hand back the raw body so the caller still gets
      // the bytes (the original aborts with a warning here).
      out.push({ name: '.bin', data: Buffer.from(data.subarray(s.dataOffset, s.dataOffset + s.dataSize)) });
    }
  }

  return out;
}

/**
 * Extract a Vorbis (codec 6) sub-song to a complete `.ogg`. Replicates the
 * original's two paths keyed on the VorbisEncodedHeader at
 * `streamHeaderOffset + 32`:
 *
 *   VorbisEncodedHeader (32 bytes):
 *     +0x00 int16 encodeType   0 = plain (body is already a full ogg)
 *     +0x02 int16 encodeByte   single-byte XOR key for the obfuscated header
 *     +0x14 int32 seekTableSize
 *     +0x18 int32 headerSize   size of the (XOR'd) ogg header block
 *
 * For `encodeType == 0` the raw body at `dataOffset` is the full ogg. Otherwise
 * the `headerSize`-byte header block (located after the seek table) is XOR'd with
 * `encodeByte` and prepended to the body.
 */
function extractVorbis(data: Buffer, s: ScdSubSong, be: boolean): ExtractedScdStream {
  const extraStart = s.streamHeaderOffset + STREAM_HEADER_SIZE;
  const vr = new BinaryReader(data, extraStart);
  const encodeType = vr.readU16(be);
  const encodeByte = vr.readU16(be) & 0xff;
  vr.skip(4 + 4 + 4); // unknown01, unknown02, unknown03 (float)
  const seekTableSize = vr.readU32(be);
  const headerSize = vr.readU32(be);

  if (encodeType === 0) {
    // Body at dataOffset is already a complete ogg stream.
    return { name: '.ogg', data: Buffer.from(data.subarray(s.dataOffset, s.dataOffset + s.dataSize)) };
  }

  // Obfuscated: header block lives after the seek table; de-XOR then prepend.
  const headerStart = extraStart + STREAM_HEADER_SIZE + seekTableSize;
  const header = Buffer.from(data.subarray(headerStart, headerStart + headerSize));
  for (let i = 0; i < header.length; i++) header[i] = header[i] ^ encodeByte;
  const body = data.subarray(s.dataOffset, s.dataOffset + s.dataSize);

  return { name: '.ogg', data: Buffer.concat([header, body], header.length + body.length) };
}

/**
 * Extract an MS-ADPCM (codec 12) sub-song to a `.wav` by rebuilding a minimal
 * RIFF wrapper from the MSADPCMHeader stored in the extra header.
 *
 *   MSADPCMHeader (at streamHeaderOffset + 32):
 *     +0x00 int16 formatTag      (2 = MS-ADPCM)
 *     +0x02 int16 channels
 *     +0x04 int32 sampleRate
 *     +0x08 int32 avgBytesPerSec
 *     +0x0C int16 blockAlign
 *     +0x0E int16 bitsPerSample
 *     +0x10 int16 cbSize         (size of the codec-specific `fmt ` extension)
 *
 * The original copies the 18-byte `WAVEFORMATEX` plus its `cbSize` extension
 * bytes (`fmt ` chunk) and the raw audio body (`data` chunk) into a standard
 * RIFF/WAVE file. The `fmt ` extension bytes sit immediately after the 18-byte
 * MSADPCMHeader, i.e. at `streamHeaderOffset + 32 + 18`.
 */
function extractMsAdpcm(data: Buffer, s: ScdSubSong, be: boolean): ExtractedScdStream {
  const extraStart = s.streamHeaderOffset + STREAM_HEADER_SIZE;
  const hr = new BinaryReader(data, extraStart);
  const formatTag = hr.readU16(be);
  const channels = hr.readU16(be);
  const sampleRate = hr.readU32(be);
  const avgBytesPerSec = hr.readU32(be);
  const blockAlign = hr.readU16(be);
  const bitsPerSample = hr.readU16(be);
  const cbSize = hr.readU16(be); // "dataSize" in the original = fmt extension size

  // Codec-specific `fmt ` extension bytes follow the 18-byte WAVEFORMATEX.
  const extStart = extraStart + 18;
  const fmtExt = data.subarray(extStart, extStart + cbSize);
  const body = data.subarray(s.dataOffset, s.dataOffset + s.dataSize);

  // RIFF wrapper: WAVE + fmt (18 + cbSize) + data. All RIFF fields little-endian.
  const fmtChunkSize = 18 + cbSize;
  const dataChunkSize = body.length;
  const riffSize = 4 /* "WAVE" */ + (8 + fmtChunkSize) + (8 + dataChunkSize);

  const head = Buffer.alloc(8 + 4 + 8 + 18);
  let p = 0;
  head.write('RIFF', p, 'latin1'); p += 4;
  head.writeUInt32LE(riffSize >>> 0, p); p += 4;
  head.write('WAVE', p, 'latin1'); p += 4;
  head.write('fmt ', p, 'latin1'); p += 4;
  head.writeUInt32LE(fmtChunkSize >>> 0, p); p += 4;
  head.writeUInt16LE(formatTag & 0xffff, p); p += 2;
  head.writeUInt16LE(channels & 0xffff, p); p += 2;
  head.writeUInt32LE(sampleRate >>> 0, p); p += 4;
  head.writeUInt32LE(avgBytesPerSec >>> 0, p); p += 4;
  head.writeUInt16LE(blockAlign & 0xffff, p); p += 2;
  head.writeUInt16LE(bitsPerSample & 0xffff, p); p += 2;
  head.writeUInt16LE(cbSize & 0xffff, p); p += 2;

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'latin1');
  dataHeader.writeUInt32LE(dataChunkSize >>> 0, 4);

  const wav = Buffer.concat([head, Buffer.from(fmtExt), dataHeader, Buffer.from(body)]);
  return { name: '.wav', data: wav };
}

/*
 * NOTE — REPACK IS OUT OF SCOPE.
 * The original NovaChrysalia ConvertAudio rebuilds an SCD from a source `.ogg`
 * or MS-ADPCM `.wav`. For Vorbis the source must first be re-encoded to Square's
 * non-serialized Vorbis variant using a native tool (FAudio's stb_vorbis /
 * "NCVE"); a JS-only implementation cannot perform Vorbis encoding. SCD repack is
 * therefore intentionally not implemented in this module.
 */
