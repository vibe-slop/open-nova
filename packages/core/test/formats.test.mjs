/**
 * Self-consistency tests for the inner-container formats WPD and TRB.
 *
 * WPD: build a container with repackWpd from named entries, unpack it, and
 * assert names + extensions + data round-trip; also hand-verify the on-disk
 * header bytes (magic, big-endian count, 32-byte record stride).
 *
 * TRB: hand-build a minimal valid 'SEDBRES ' container byte-by-byte and assert
 * unpackTrb reads it correctly (proves the reader matches the documented byte
 * layout independently of our writer), then assert the repackTrb -> unpackTrb
 * round-trip preserves every entry.
 *
 * NOTE: these prove the reader and writer agree with each other and with the
 * documented layout. Byte-identity against a real game install must be
 * confirmed separately. TRB repack is a best-effort inverse of unpack and does
 * NOT perform IMGB texture pairing.
 */
import { randomBytes } from 'node:crypto';
import { unpackWpd, repackWpd } from '../src/formats/wpd.ts';
import { unpackTrb, repackTrb } from '../src/formats/trb.ts';

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
// WPD
// ---------------------------------------------------------------------------
console.log('WPD:');
{
  const entries = [
    { name: 'header', ext: 'txbh', data: randomBytes(40) },
    { name: 'palette', ext: 'gtex', data: Buffer.from('hello world'.repeat(7)) },
    { name: 'noext', ext: '', data: randomBytes(3) }, // exercises 4-byte alignment
    { name: 'last', ext: 'bin', data: randomBytes(257) },
  ];

  const packed = repackWpd(entries);

  // Header byte checks against the documented layout.
  check('magic is "WPD\\0"', packed.toString('latin1', 0, 4) === 'WPD\0');
  check('count @4 is big-endian', packed.readUInt32BE(4) === entries.length);
  check('record table starts at 0x10', packed.length >= 16 + 32 * entries.length);

  // First record: name at +0, big-endian offset @+16, size @+20, ext @+24.
  check('record0 name field', packed.toString('utf8', 16, 16 + 6) === 'header');
  const rec0Off = packed.readUInt32BE(16 + 16);
  const rec0Size = packed.readUInt32BE(16 + 20);
  check('record0 size matches data', rec0Size === entries[0].data.length);
  check('record0 offset is absolute & in-bounds', rec0Off >= 16 + 32 * entries.length && rec0Off + rec0Size <= packed.length);
  check('record0 ext field', packed.toString('utf8', 16 + 24, 16 + 24 + 4) === 'txbh');

  const out = unpackWpd(packed);
  check('entry count round-trips', out.entries.length === entries.length);

  let allOk = true;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const o = out.entries[i];
    if (!o || o.name !== e.name || o.ext !== e.ext || !Buffer.from(e.data).equals(o.data)) {
      allOk = false;
      console.log(`    mismatch at ${i}: ${JSON.stringify({ name: o?.name, ext: o?.ext })}`);
    }
  }
  check('every name/ext/data round-trips', allOk);

  // Bad magic rejected.
  let threw = false;
  try {
    unpackWpd(Buffer.from('NOPE' + 'x'.repeat(60)));
  } catch {
    threw = true;
  }
  check('bad magic rejected', threw);

  // Repack -> unpack -> repack is byte-stable.
  const repacked = repackWpd(out.entries);
  check('repack is byte-stable', repacked.equals(packed));
}

// ---------------------------------------------------------------------------
// TRB — hand-built minimal valid 'SEDBRES ' container.
// ---------------------------------------------------------------------------
console.log('TRB (hand-built minimal container):');
{
  // We build: 1 real resource + the two region descriptors => resCount = 3.
  //   index 0 (i=1)        -> real body
  //   index 1 (i=lastIdx=2)-> RESOURCE_TYPE region descriptor
  //   index 2 (i=resCount=3)-> RESOURCE_ID region descriptor
  const resCount = 3;
  const DESC_TABLE_START = 64;
  const tableEnd = DESC_TABLE_START + resCount * 16; // 64 + 48 = 112

  const realData = randomBytes(20); // 20 -> needs 4 bytes of pad to align next
  const realName = 'serah_model';
  const realType = 'txbh'; // human-readable; stored byte-reversed on disk

  // Layout after tableEnd:
  //   [real body (20) + pad to 4 -> 20]  bodies region (relative off 0)
  //   [TYPE region: 1 tag * 4 bytes]     at relative off = 20
  //   [ID region: "serah_model\0"]       after the TYPE region
  const bodyAligned = Buffer.alloc(Math.ceil(realData.length / 4) * 4);
  realData.copy(bodyAligned);
  const typeRel = bodyAligned.length; // 20
  // RESOURCE_TYPE tag stored byte-reversed (unpacker un-reverses it).
  const typeBytes = Buffer.from([
    realType.charCodeAt(3),
    realType.charCodeAt(2),
    realType.charCodeAt(1),
    realType.charCodeAt(0),
  ]);
  const typeRegion = typeBytes;
  const idRel = typeRel + typeRegion.length;
  const idRegion = Buffer.concat([Buffer.from(realName, 'utf8'), Buffer.from([0])]);

  const header = Buffer.alloc(tableEnd);
  header.write('SEDBRES ', 0, 'latin1');
  // dirDataLen @0x34 (52) = idRel (names region offset relative to tableEnd)
  header.writeUInt32LE(idRel, 52);
  // resCount @0x38 (56)
  header.writeUInt32LE(resCount, 56);

  // descriptor 0 (real): +4 = body offset (rel tableEnd), +8 = body size
  header.writeUInt32LE(0xdead0001, 64 + 0); // field0 preserved
  header.writeUInt32LE(0, 64 + 4); // body offset rel tableEnd = 0
  header.writeUInt32LE(realData.length, 64 + 8); // body size
  header.writeUInt32LE(0xcafe0001, 64 + 12); // fieldC preserved

  // descriptor 1 (RESOURCE_TYPE region): +4 = typeRel
  header.writeUInt32LE(0, 64 + 16 + 0);
  header.writeUInt32LE(typeRel, 64 + 16 + 4);
  header.writeUInt32LE(0, 64 + 16 + 8);
  header.writeUInt32LE(0, 64 + 16 + 12);

  // descriptor 2 (RESOURCE_ID region): +4 = idRel
  header.writeUInt32LE(0, 64 + 32 + 0);
  header.writeUInt32LE(idRel, 64 + 32 + 4);
  header.writeUInt32LE(0, 64 + 32 + 8);
  header.writeUInt32LE(0, 64 + 32 + 12);

  // totalDataLen @0x10 (16) = everything after the descriptor table.
  const afterTable = bodyAligned.length + typeRegion.length + idRegion.length;
  header.writeUInt32LE(afterTable, 16);

  // The names region must contain ALL resCount names (the unpacker reads one
  // per descriptor). The real entry's name is 'serah_model'; the two region
  // entries get short names so the unpacker can advance its name cursor.
  const namesAll = Buffer.concat([
    Buffer.from(realName, 'utf8'),
    Buffer.from([0]),
    Buffer.from('TYPE', 'utf8'),
    Buffer.from([0]),
    Buffer.from('ID', 'utf8'),
    Buffer.from([0]),
  ]);

  // The hand-built minimal container places the ID/names region as the final
  // region (so the last entry's size = fileLength - off works out). The TYPE
  // region's bytes happen to be the un-reversed tag(s); the ID region holds all
  // the names. We set idRegion = namesAll for this minimal case.
  const trb = Buffer.concat([header, bodyAligned, typeRegion, namesAll]);

  // Fix up totalDataLen now that the ID region is the full names blob.
  trb.writeUInt32LE(bodyAligned.length + typeRegion.length + namesAll.length, 16);

  const out = unpackTrb(trb);
  check('SEDBRES magic accepted', out.resourceCount === resCount);
  check('reads resCount entries', out.entries.length === resCount);

  // Entry 0 is the real resource.
  const e0 = out.entries[0];
  check('real entry name', e0 && e0.name === realName);
  check('real entry type tag (un-reversed)', e0 && e0.type === realType);
  check('real entry data round-trips', e0 && realData.equals(e0.data));
  check('real entry preserves field0', e0 && e0.field0 === 0xdead0001);
  check('real entry preserves fieldC', e0 && e0.fieldC === 0xcafe0001);

  // Bad magic rejected.
  let threw = false;
  try {
    unpackTrb(Buffer.concat([Buffer.from('NOTRB!!!', 'latin1'), Buffer.alloc(120)]));
  } catch {
    threw = true;
  }
  check('bad magic rejected', threw);

  // repack -> unpack round-trip preserves all entries.
  const rebuilt = repackTrb(out);
  const out2 = unpackTrb(rebuilt);
  check('repack: entry count preserved', out2.entries.length === out.entries.length);
  let rtOk = out2.entries.length === out.entries.length;
  for (let i = 0; i < out.entries.length && rtOk; i++) {
    const a = out.entries[i];
    const b = out2.entries[i];
    if (a.name !== b.name || !a.data.equals(b.data)) rtOk = false;
    // type tags only meaningful for real entries (before the region descriptors)
    if (i < resCount - 2 && a.type !== b.type) rtOk = false;
  }
  check('repack -> unpack preserves names + data', rtOk);
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`formats: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
