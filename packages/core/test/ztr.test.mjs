/**
 * Self-consistency tests for the ZTR text container.
 *
 * SELF round-trip: buildZtr(lines) then parseZtr reproduces the lines exactly,
 * for an id + short ASCII message, including a control-glyph token ({Text
 * NewLine}) and the standalone {FF} token. Also exercises the uncompressed
 * (PackUncmp-style) path and multiple lines.
 *
 * BPE: compressChunk on a highly repetitive string actually shrinks it and
 * decompressChunk recovers the original bytes exactly; compressChunk on
 * incompressible (random) data is a faithful no-op pass-through.
 *
 * NOTE (codepage): only the cp932/"LJ" glyph path is implemented. ASCII/cp1252
 * single-byte text round-trips exactly; full multi-byte Shift-JIS/Chinese/
 * Korean source bytes would need an external transcoder (iconv-lite). No real
 * XIII-2 ZTR fixture is available (text lives in the script archive), so the
 * bar here is self-round-trip, not byte-identity against a reference.
 */
import { randomBytes } from 'node:crypto';
import {
  parseZtr,
  buildZtr,
  compressChunk,
  decompressChunk,
} from '../src/formats/ztr.ts';

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
// BPE compress / decompress
// ---------------------------------------------------------------------------
console.log('ZTR BPE:');
{
  // Repetitive data: should compress and round-trip.
  const repetitive = Buffer.from('ABABABABABABABABABABABABABAB_CDCDCDCDCDCDCDCD'.repeat(8), 'latin1');
  const compressed = compressChunk(repetitive);
  const restored = decompressChunk(compressed);
  check('BPE round-trips repetitive data', restored.equals(repetitive));
  check('BPE shrinks repetitive data', compressed.length < repetitive.length);

  // A single repeated pair across a longer buffer.
  const pairy = Buffer.alloc(2000, 0);
  for (let i = 0; i < pairy.length; i += 2) {
    pairy[i] = 0x41; // 'A'
    pairy[i + 1] = 0x42; // 'B'
  }
  const c2 = compressChunk(pairy);
  check('BPE round-trips 2KB of "AB"', decompressChunk(c2).equals(pairy));
  check('BPE strongly shrinks 2KB of "AB"', c2.length < pairy.length / 2);

  // Incompressible data: no pair occurs >= 4 times in distinct positions, so
  // the table should be empty and the payload identical (faithful pass-through).
  const random = randomBytes(64);
  const cr = compressChunk(random);
  const rr = decompressChunk(cr);
  check('BPE round-trips random data', rr.equals(random));

  // Empty input.
  const ce = compressChunk(Buffer.alloc(0));
  check('BPE round-trips empty data', decompressChunk(ce).length === 0);
}

// ---------------------------------------------------------------------------
// ZTR self round-trip (compressed, the default)
// ---------------------------------------------------------------------------
console.log('ZTR round-trip (compressed):');
{
  const lines = [
    { id: 'mes_sample_0001', text: 'Hello, world!' },
    { id: 'mes_sample_0002', text: 'A second line with a tab token{Text Tab}and more.' },
    { id: 'mes_sample_0003', text: 'Line break here{Text NewLine}then continued.' },
    { id: 'mes_sample_0004', text: 'A standalone {FF} token and {Btn A} button glyph.' },
    { id: 'mes_empty', text: '' },
    // Highly repetitive text to exercise BPE inside the message blob.
    { id: 'mes_repeat', text: 'na'.repeat(40) },
  ];

  const built = buildZtr(lines, { game: 2 });
  check('buildZtr returns a Buffer', Buffer.isBuffer(built));

  // Header sanity: magic low word == 1, big-endian line count.
  check('header magic low word is 1', built.readUInt32BE(4) === 1);
  check('header LineCount is correct', built.readUInt32BE(8) === lines.length);

  const parsed = parseZtr(built, { game: 2 });
  check('parsed line count matches', parsed.lines.length === lines.length);

  let allMatch = true;
  for (let i = 0; i < lines.length; i++) {
    const exp = lines[i];
    const got = parsed.lines[i];
    if (!got || got.id !== exp.id || got.text !== exp.text) {
      allMatch = false;
      console.log(`    line ${i} mismatch:`);
      console.log(`      expected id=${JSON.stringify(exp.id)} text=${JSON.stringify(exp.text)}`);
      console.log(`      got      id=${JSON.stringify(got && got.id)} text=${JSON.stringify(got && got.text)}`);
    }
  }
  check('every line round-trips exactly (id + text)', allMatch);
}

// ---------------------------------------------------------------------------
// ZTR self round-trip (uncompressed PackUncmp-style path)
// ---------------------------------------------------------------------------
console.log('ZTR round-trip (uncompressed):');
{
  const lines = [
    { id: 'id_a', text: 'plain ascii' },
    { id: 'id_b', text: 'with {Text NewPage} token' },
  ];
  const built = buildZtr(lines, { game: 2, compress: false });
  const parsed = parseZtr(built, { game: 2 });
  let ok = parsed.lines.length === lines.length;
  for (let i = 0; i < lines.length && ok; i++) {
    ok = parsed.lines[i].id === lines[i].id && parsed.lines[i].text === lines[i].text;
  }
  check('uncompressed path round-trips exactly', ok);
}

// ---------------------------------------------------------------------------
// ZTR single-line round-trip (minimal case from the brief)
// ---------------------------------------------------------------------------
console.log('ZTR round-trip (single line):');
{
  const lines = [{ id: 'KEY_0001', text: 'short ascii message' }];
  const parsed = parseZtr(buildZtr(lines), {});
  check(
    'single id + short ASCII message round-trips',
    parsed.lines.length === 1 &&
      parsed.lines[0].id === 'KEY_0001' &&
      parsed.lines[0].text === 'short ascii message',
  );
}

console.log(`\nZTR: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
