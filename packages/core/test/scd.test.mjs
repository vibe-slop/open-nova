/**
 * Tests for the SCD sound container extractor (src/formats/scd.ts).
 *
 * 1. REAL DATA: load /tmp/deck/real.scd (a real FFXIII-2 SCD, "SEDBSSCF" magic,
 *    ~7936 bytes), parse it and assert the magic is recognised, the endianness
 *    is detected, there is >= 1 sub-song, and every sub-song's data offset/size
 *    lies within the file. extractScd must then return a body per sub-song. When
 *    the fixture is absent the real check is logged + skipped.
 *
 * 2. SYNTHETIC: hand-build a minimal valid little-endian "SEDBSSCF" header with a
 *    single Vorbis (codec 6, plain) sub-song byte-by-byte and assert parseScd
 *    reads it correctly (proving the reader matches the documented byte layout
 *    independently of any real file), plus extractScd returns the raw ogg body.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseScd, extractScd, detectScdEndianness, ScdCodec, scdCodecName } from '../src/formats/scd.ts';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Real data
// ---------------------------------------------------------------------------
console.log('SCD (real /tmp/deck/real.scd):');
const REAL = '/tmp/deck/real.scd';
if (existsSync(REAL)) {
  const buf = readFileSync(REAL);
  check('magic is "SEDBSSCF"', buf.toString('latin1', 0, 8) === 'SEDBSSCF');

  const parsed = parseScd(buf);
  check('endianness detected (little for PC build)', parsed.endianness === 'little');
  check('version is 3', parsed.version === 3);
  check('scdSize matches file length', parsed.scdSize === buf.length);
  check('>= 1 sub-song', parsed.subSongs.length >= 1);

  let allInBounds = parsed.subSongs.length >= 1;
  for (const s of parsed.subSongs) {
    if (s.dataOffset < 0 || s.dataSize < 0 || s.dataOffset + s.dataSize > buf.length) {
      allInBounds = false;
    }
    if (s.streamHeaderOffset + 32 > buf.length) allInBounds = false;
    if (s.channels < 1 || s.sampleRate <= 0) allInBounds = false;
  }
  check('all sub-song offsets/sizes within bounds', allInBounds);

  const s0 = parsed.subSongs[0];
  console.log(
    `    sub-song[0]: codec=${s0.codec} (${scdCodecName(s0.codec)}) channels=${s0.channels} ` +
      `sampleRate=${s0.sampleRate} dataOffset=${s0.dataOffset} dataSize=${s0.dataSize}`,
  );

  const extracted = extractScd(buf);
  check('extractScd returns one entry per sub-song', extracted.length === parsed.subSongs.length);
  check('extracted[0] has non-empty data', extracted[0].data.length > 0);
  check('extracted[0] has a name hint', typeof extracted[0].name === 'string' && extracted[0].name.length > 0);
} else {
  console.log(`  … skipped: ${REAL} not present`);
}

// ---------------------------------------------------------------------------
// Synthetic header (little-endian, single plain-Vorbis sub-song)
// ---------------------------------------------------------------------------
console.log('SCD (synthetic header):');
{
  // Layout we will build:
  //   0x00 magic "SEDBSSCF"
  //   0x08 version=3
  //   0x0C endianFlag=0 (LE)
  //   0x34 subSongCount=1
  //   0x3C streamOffsetTablePtr=0x40
  //   0x40 offset-table: [streamHeaderOffset=0x60]
  //   0x60 SCDStreamHeader (32 bytes): streamSize, channels=2, sampleRate=44100,
  //        codec=6 (Vorbis), loopStart=0, loopEnd=0, extraHeaderSize=32, aux=0
  //   0x80 VorbisEncodedHeader (32 bytes): encodeType=0 (plain) -> rest zero
  //   0xA0 raw ogg body
  const OGG_BODY = Buffer.from('OggS-FAKE-VORBIS-BODY');
  const STREAM_HDR = 0x60;
  const EXTRA_SIZE = 32;
  const DATA_OFFSET = STREAM_HDR + 32 + EXTRA_SIZE; // 0xA0
  const total = DATA_OFFSET + OGG_BODY.length;

  const b = Buffer.alloc(total);
  b.write('SEDBSSCF', 0, 'latin1');
  b.writeUInt32LE(3, 0x08); // version
  b.writeUInt8(0, 0x0c); // endian flag = little
  b.writeUInt32LE(total, 0x10); // scdSize = file length
  b.writeUInt16LE(1, 0x34); // subSongCount
  b.writeUInt32LE(0x40, 0x3c); // streamOffsetTablePtr
  b.writeUInt32LE(STREAM_HDR, 0x40); // offset-table entry 0

  // SCDStreamHeader @ 0x60
  b.writeUInt32LE(OGG_BODY.length, STREAM_HDR + 0x00); // streamSize
  b.writeUInt32LE(2, STREAM_HDR + 0x04); // channels
  b.writeUInt32LE(44100, STREAM_HDR + 0x08); // sampleRate
  b.writeUInt32LE(ScdCodec.Vorbis, STREAM_HDR + 0x0c); // codec = 6
  b.writeUInt32LE(0, STREAM_HDR + 0x10); // loopStart
  b.writeUInt32LE(0, STREAM_HDR + 0x14); // loopEnd
  b.writeUInt32LE(EXTRA_SIZE, STREAM_HDR + 0x18); // extraHeaderSize
  b.writeUInt32LE(0, STREAM_HDR + 0x1c); // auxChunkCount

  // VorbisEncodedHeader @ 0x80: encodeType = 0 (plain) — leave rest zero.
  b.writeUInt16LE(0, STREAM_HDR + 32 + 0x00);

  // Raw body @ 0xA0
  OGG_BODY.copy(b, DATA_OFFSET);

  check('detectScdEndianness => little', detectScdEndianness(b) === 'little');

  const parsed = parseScd(b);
  check('version parsed = 3', parsed.version === 3);
  check('exactly 1 sub-song', parsed.subSongs.length === 1);

  const s = parsed.subSongs[0];
  check('codec = Vorbis (6)', s.codec === ScdCodec.Vorbis);
  check('channels = 2', s.channels === 2);
  check('sampleRate = 44100', s.sampleRate === 44100);
  check('extraHeaderSize = 32', s.extraHeaderSize === EXTRA_SIZE);
  check('dataOffset computed (hdr+32+extra)', s.dataOffset === DATA_OFFSET);
  check('dataSize = body length', s.dataSize === OGG_BODY.length);

  const extracted = extractScd(b);
  check('extract returns 1 stream', extracted.length === 1);
  check('extracted name hint is .ogg', extracted[0].name === '.ogg');
  check('plain-Vorbis body extracted verbatim', extracted[0].data.equals(OGG_BODY));

  // Bad magic must throw.
  let threw = false;
  try {
    parseScd(Buffer.from('NOTANSCD........'));
  } catch {
    threw = true;
  }
  check('parseScd throws on bad magic', threw);
}

// ---------------------------------------------------------------------------
console.log(`\nSCD: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
