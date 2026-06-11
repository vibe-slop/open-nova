/**
 * Self-test for src/formats/wdb.ts — the WDB game-database <-> structured JSON
 * module (FFXIII-2 / LR gameplay databases).
 *
 * Run: tsx test/wdb.test.mjs   (cwd: packages/core)
 *
 * Checks:
 *   1. REAL DATA round-trip: parse /tmp/deck/real.wdb then rebuild, asserting
 *      the rebuilt bytes are byte-identical to the original. Skipped (with a
 *      logged note) if the fixture is absent.
 *   2. SYNTHETIC bit-packing: a self-describing record with known i/u/f (+ uint
 *      and string) fields encodes then decodes back to the exact same values,
 *      and the encoded bytes match an independent reimplementation of the
 *      decompiled converter's bit-packing algorithm.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { parseWdb, buildWdb } from '../src/formats/wdb.ts';
import { repackWpd, unpackWpd } from '../src/formats/wpd.ts';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL- ${name}`);
    console.error('        ' + (err && err.stack ? err.stack.split('\n').join('\n        ') : err));
  }
}

// --------------------------------------------------------------------------
// 1. Real-data byte-faithful round-trip.
// --------------------------------------------------------------------------
const REAL_PATH = '/tmp/deck/real.wdb';
if (existsSync(REAL_PATH)) {
  test('real.wdb parses and rebuilds byte-identically', () => {
    const original = readFileSync(REAL_PATH);
    const parsed = parseWdb(original);
    // Sanity: it is a WPD container with at least one decoded record.
    assert.ok(parsed.records.length >= 1, 'expected at least one record');
    const rebuilt = buildWdb(parsed);
    assert.equal(
      Buffer.compare(rebuilt, original),
      0,
      `rebuilt (${rebuilt.length} bytes) differs from original (${original.length} bytes)`,
    );
  });
} else {
  console.log(`  note- ${REAL_PATH} absent; skipping real-data round-trip check`);
}

// --------------------------------------------------------------------------
// 2. Synthetic self-describing record with i/u/f fields.
// --------------------------------------------------------------------------

/**
 * Assemble a minimal self-describing (XIII-2 style) WDB containing one record.
 * Field layout (strtypelist type codes shown):
 *   cell 0 (type 0, bit-packed): i8a(i,8) + u8b(u,8) + u16c(u,16)  = 32 bits
 *   cell 1 (type 0, bit-packed): i0full(i,0 -> whole 32-bit word)
 *   cell 2 (type 3): u32d (plain uint32)
 *   cell 3 (type 1): fRate (float32)
 *   cell 4 (type 2): strFld (offset into !!string pool)
 */
function makeSyntheticWdb() {
  const fields = ['i8a', 'u8b', 'u16c', 'i0full', 'u32d', 'fRate', 'strFld'];
  const structItem = Buffer.from(fields.map((f) => f + '\0').join(''), 'utf8');
  const structItemNum = Buffer.alloc(4);
  structItemNum.writeUInt32BE(fields.length);
  // 5 cells: [0, 0, 3, 1, 2]
  const codes = [0, 0, 3, 1, 2];
  const strtypelist = Buffer.alloc(codes.length * 4);
  codes.forEach((c, i) => strtypelist.writeUInt32BE(c, i * 4));
  const version = Buffer.alloc(4);
  version.writeUInt32BE(7);
  const sheet = Buffer.from('TestSheet\0', 'utf8');
  const recBlob = Buffer.alloc(codes.length * 4);

  const entries = [
    { name: '!!sheetname', ext: '', data: sheet },
    { name: '!!string', ext: '', data: Buffer.from([0]) },
    { name: '!!strtypelist', ext: '', data: strtypelist },
    { name: '!!version', ext: '', data: version },
    { name: '!structitem', ext: '', data: structItem },
    { name: '!structitemnum', ext: '', data: structItemNum },
    { name: 'REC0', ext: '', data: recBlob },
  ];
  return repackWpd(entries);
}

/** Independent port of the decompiled converter's bit-packing (for cross-check). */
function reverseBin(s) {
  let o = '';
  for (let i = s.length; i > 0; i--) o += s[i - 1];
  return o;
}
function intToBinFixed(v, w) {
  if (v < 0) {
    const f = (v >>> 0).toString(2).padStart(32, '0');
    return f.slice(f.length - w);
  }
  return v.toString(2).padStart(w, '0');
}
function uintToBinFixed(v, w) {
  return (v >>> 0).toString(2).padStart(w, '0');
}

test('synthetic self-describing fields are detected with correct type codes', () => {
  const parsed = parseWdb(makeSyntheticWdb());
  assert.equal(parsed.sheetName, 'TestSheet');
  assert.equal(parsed.version, 7);
  const byName = Object.fromEntries(parsed.fields.map((f) => [f.name, f.typeCode]));
  assert.deepEqual(byName, {
    i8a: 0,
    u8b: 0,
    u16c: 0,
    i0full: 0,
    u32d: 3,
    fRate: 1,
    strFld: 2,
  });
});

test('synthetic record: encode then decode reproduces i/u/f/uint/string values', () => {
  const parsed = parseWdb(makeSyntheticWdb());
  const rec = parsed.records[0];
  rec.values.i8a = -5; // signed 8-bit
  rec.values.u8b = 200; // unsigned 8-bit
  rec.values.u16c = 40000; // unsigned 16-bit
  rec.values.i0full = -123456; // full 32-bit signed word
  rec.values.u32d = 4000000000; // plain uint32
  rec.values.fRate = 1.5; // float32 (exactly representable)
  rec.values.strFld = 'hello'; // string pool

  const rebuilt = buildWdb(parsed);
  const v = parseWdb(rebuilt).records[0].values;
  assert.equal(v.i8a, -5);
  assert.equal(v.u8b, 200);
  assert.equal(v.u16c, 40000);
  assert.equal(v.i0full, -123456);
  assert.equal(v.u32d, 4000000000);
  assert.equal(v.fRate, 1.5);
  assert.equal(v.strFld, 'hello');
});

test('synthetic record: bit-packed cell0 bytes match the converter algorithm', () => {
  const parsed = parseWdb(makeSyntheticWdb());
  const rec = parsed.records[0];
  rec.values.i8a = -5;
  rec.values.u8b = 200;
  rec.values.u16c = 40000;
  rec.values.i0full = 0;
  rec.values.u32d = 0;
  rec.values.fRate = 0;
  rec.values.strFld = '';

  // Independently compute the expected cell-0 word: per-field MSB-first ->
  // per-field reverse -> concat -> whole-word reverse -> uint32 -> BE bytes.
  let text = '';
  text += reverseBin(intToBinFixed(-5, 8));
  text += reverseBin(uintToBinFixed(200, 8));
  text += reverseBin(uintToBinFixed(40000, 16));
  text = reverseBin(text);
  const expected = Buffer.alloc(4);
  expected.writeUInt32BE(parseInt(text, 2) >>> 0);

  const rebuilt = buildWdb(parsed);
  const recData = unpackWpd(rebuilt).entries.find((e) => e.name === 'REC0').data;
  assert.equal(
    recData.subarray(0, 4).toString('hex'),
    expected.toString('hex'),
    'cell0 bit-packed word should match the independent algorithm',
  );
});

test('synthetic record: build is stable (round-trips to itself)', () => {
  const parsed = parseWdb(makeSyntheticWdb());
  const rec = parsed.records[0];
  rec.values.i8a = 1;
  rec.values.u8b = 2;
  rec.values.u16c = 3;
  rec.values.i0full = 4;
  rec.values.u32d = 5;
  rec.values.fRate = 6.25;
  rec.values.strFld = 'world';
  const first = buildWdb(parsed);
  const second = buildWdb(parseWdb(first));
  assert.equal(Buffer.compare(first, second), 0, 'rebuild must be deterministic');
});

console.log(`\nwdb.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
