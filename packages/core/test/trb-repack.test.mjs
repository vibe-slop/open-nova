/**
 * TRB ("SEDBRES ") full-repack tests — VALIDATED ON REAL DATA.
 *
 * Primary path: load /tmp/deck/c001.trb (a real FFXIII-2 TRB, 1385635 bytes),
 * unpackTrb it, repackTrb the UNCHANGED entries, and assert:
 *   - the repack is byte-identical to the source (Buffer.compare === 0), and
 *   - re-unpacking the repack reproduces the same entries (names + types + data).
 * Then edit one real entry's bytes (same length) and assert the edit survives the
 * round-trip while everything else is preserved.
 *
 * Fallback path (if /tmp/deck/c001.trb is absent): build a synthetic SEDBRES
 * container byte-by-byte, then unpack -> repack -> unpack and assert functional
 * equivalence plus a same-length edit round-trip.
 *
 * The repack keeps the header + descriptor table + RESOURCE_TYPE + RESOURCE_ID
 * regions verbatim, rebuilds only the body region, and patches the offset/size
 * table and the @52/@16 header fields, so a no-edit repack is byte-identical to
 * the source.
 */
import { existsSync, readFileSync } from 'node:fs';
import { unpackTrb } from '../src/formats/trb.ts';
import { repackTrb } from '../src/formats/trb-repack.ts';

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

/** Assert that two unpacked structures carry the same entries (names+types+data). */
function entriesEqual(a, b) {
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    const ea = a.entries[i];
    const eb = b.entries[i];
    if (ea.name !== eb.name) return false;
    if (ea.type !== eb.type) return false;
    if (!Buffer.from(ea.data).equals(Buffer.from(eb.data))) return false;
  }
  return true;
}

const REAL_PATH = '/tmp/deck/c001.trb';

if (existsSync(REAL_PATH)) {
  console.log('TRB repack (real FFXIII-2 data, c001.trb):');

  const original = readFileSync(REAL_PATH);
  check('magic is "SEDBRES "', original.toString('latin1', 0, 8) === 'SEDBRES ');

  const out = unpackTrb(original);
  check('unpacked some entries', out.entries.length > 2);
  check('resourceCount matches entry count', out.resourceCount === out.entries.length);

  // --- No-edit repack: byte-identical to the source. ---
  const repacked = repackTrb(out);
  check('no-edit repack length == source length', repacked.length === original.length);
  const identical = Buffer.compare(repacked, original) === 0;
  check('no-edit repack is BYTE-IDENTICAL (Buffer.compare === 0)', identical);
  if (!identical) {
    // Note the first diff for diagnostics; functional equivalence is asserted next.
    const n = Math.min(repacked.length, original.length);
    let firstDiff = -1;
    for (let i = 0; i < n; i++) {
      if (repacked[i] !== original[i]) {
        firstDiff = i;
        break;
      }
    }
    console.log(`    NOTE: first byte diff at offset ${firstDiff} (asserting functional equivalence instead)`);
  }

  // Functional equivalence: re-unpack must reproduce the same entries either way.
  const reout = unpackTrb(repacked);
  check('no-edit repack -> unpack reproduces all entries (functional round-trip)', entriesEqual(out, reout));

  // --- repackTrb from bare entries via originalBuf (no offsetsRegion). ---
  const bare = { entries: out.entries, resourceCount: out.resourceCount };
  const repackedFromBare = repackTrb(bare, original);
  check('repack from bare entries + originalBuf is byte-identical', Buffer.compare(repackedFromBare, original) === 0);

  // --- Edit one real entry's bytes (same length) and round-trip. ---
  // Pick the largest real body (a non-region entry) and flip every byte.
  const realCount = out.resourceCount - 2;
  let editIdx = 0;
  for (let i = 1; i < realCount; i++) {
    if (out.entries[i].data.length > out.entries[editIdx].data.length) editIdx = i;
  }
  const edited = {
    entries: out.entries.map((e, i) =>
      i === editIdx ? { ...e, data: Buffer.from(e.data.map((b) => b ^ 0xff)) } : e,
    ),
    resourceCount: out.resourceCount,
    offsetsRegion: out.offsetsRegion,
  };
  const editedPacked = repackTrb(edited);
  check('edited repack length unchanged (same-length edit)', editedPacked.length === original.length);
  const editedOut = unpackTrb(editedPacked);
  check('edited entry data survives round-trip', editedOut.entries[editIdx].data.equals(edited.entries[editIdx].data));
  check('edited entry name/type preserved', editedOut.entries[editIdx].name === out.entries[editIdx].name && editedOut.entries[editIdx].type === out.entries[editIdx].type);
  // Every OTHER entry must be untouched by the edit.
  let othersOk = true;
  for (let i = 0; i < out.entries.length; i++) {
    if (i === editIdx) continue;
    const a = out.entries[i];
    const b = editedOut.entries[i];
    if (a.name !== b.name || a.type !== b.type || !a.data.equals(b.data)) othersOk = false;
  }
  check('all other entries unaffected by the edit', othersOk);
} else {
  console.log('TRB repack (synthetic SEDBRES — /tmp/deck/c001.trb absent):');

  // Build a minimal valid container: 2 real bodies + the two region descriptors.
  //   index 0 (i=1)            -> real body A
  //   index 1 (i=2)            -> real body B
  //   index 2 (i=lastIdx=3)    -> RESOURCE_TYPE region descriptor
  //   index 3 (i=resCount=4)   -> RESOURCE_ID  region descriptor
  const resCount = 4;
  const DESC_TABLE_START = 64;
  const DESC_SIZE = 16;
  const tableEnd = DESC_TABLE_START + resCount * DESC_SIZE; // 64 + 64 = 128

  const dataA = Buffer.from('AAAAAAAAAAAAAAAAAA'); // 18 -> needs 2 bytes pad to align
  const dataB = Buffer.from('BBBBBBBB'); // 8 -> already aligned
  const nameA = 'modelA';
  const nameB = 'modelB';
  const typeA = 'txbh';
  const typeB = 'sdrb';

  // Body region (aligned after each body, incl. the last).
  const padA = (4 - (dataA.length % 4)) % 4;
  const padB = (4 - (dataB.length % 4)) % 4;
  const bodies = Buffer.concat([dataA, Buffer.alloc(padA), dataB, Buffer.alloc(padB)]);
  const typeRel = bodies.length;

  // RESOURCE_TYPE region: 4-byte tags stored byte-reversed (unpacker un-reverses).
  const rev = (s) => Buffer.from([s.charCodeAt(3), s.charCodeAt(2), s.charCodeAt(1), s.charCodeAt(0)]);
  const typeRegion = Buffer.concat([rev(typeA), rev(typeB)]);
  const idRel = typeRel + typeRegion.length;

  // RESOURCE_ID region — mirrors the real FFXIII-2 layout, which has TWO parts:
  //   (1) a `resCount` * 16-byte fixed id-record table (short ids, NUL-padded), then
  //   (2) the NUL-terminated full names that the unpacker actually reads, located
  //       via dirDataLen @52 (= idRel + resCount*16). The whole blob from the
  //       RESOURCE_ID descriptor offset to EOF is sliced as entries[last].data.
  const idRecord = (s) => {
    const b = Buffer.alloc(16);
    Buffer.from(s, 'utf8').copy(b);
    return b;
  };
  const idTable = Buffer.concat([
    idRecord('idA'), idRecord('idB'), idRecord('R_TYPE'), idRecord('R_ID'),
  ]); // resCount * 16 bytes
  const idNames = Buffer.concat([
    Buffer.from(nameA, 'utf8'), Buffer.from([0]),
    Buffer.from(nameB, 'utf8'), Buffer.from([0]),
    Buffer.from('RESOURCE_TYPE', 'utf8'), Buffer.from([0]),
    Buffer.from('RESOURCE_ID', 'utf8'), Buffer.from([0]),
  ]);
  const idRegion = Buffer.concat([idTable, idNames]);

  const header = Buffer.alloc(tableEnd);
  header.write('SEDBRES ', 0, 'latin1');
  // dirDataLen @52 = idRel + resCount*16 (offset of the full-names blob).
  header.writeUInt32LE(idRel + resCount * DESC_SIZE, 52);
  header.writeUInt32LE(resCount, 56);

  // desc 0 (real A): +4 off (rel tableEnd), +8 size
  header.writeUInt32LE(0xaa01, 64 + 0);
  header.writeUInt32LE(0, 64 + 4);
  header.writeUInt32LE(dataA.length, 64 + 8);
  header.writeUInt32LE(0xbb01, 64 + 12);
  // desc 1 (real B)
  header.writeUInt32LE(0xaa02, 80 + 0);
  header.writeUInt32LE(dataA.length + padA, 80 + 4);
  header.writeUInt32LE(dataB.length, 80 + 8);
  header.writeUInt32LE(0xbb02, 80 + 12);
  // desc 2 (RESOURCE_TYPE region): +4 = typeRel, +8 = 64 + 20*resCount
  header.writeUInt32LE(0, 96 + 0);
  header.writeUInt32LE(typeRel, 96 + 4);
  header.writeUInt32LE(64 + 20 * resCount, 96 + 8);
  header.writeUInt32LE(0, 96 + 12);
  // desc 3 (RESOURCE_ID region): +4 = idRel, +8 = 64 + 32*resCount
  header.writeUInt32LE(0, 112 + 0);
  header.writeUInt32LE(idRel, 112 + 4);
  header.writeUInt32LE(64 + 32 * resCount, 112 + 8);
  header.writeUInt32LE(0, 112 + 12);

  // totalDataLen @16 = the full file length (tableEnd + bodies + TYPE + ID).
  header.writeUInt32LE(tableEnd + bodies.length + typeRegion.length + idRegion.length, 16);

  const synthetic = Buffer.concat([header, bodies, typeRegion, idRegion]);

  const out = unpackTrb(synthetic);
  check('synthetic: unpacks resCount entries', out.entries.length === resCount);
  check('synthetic: real entry A name/type/data', out.entries[0].name === nameA && out.entries[0].type === typeA && out.entries[0].data.equals(dataA));
  check('synthetic: real entry B name/type/data', out.entries[1].name === nameB && out.entries[1].type === typeB && out.entries[1].data.equals(dataB));

  // No-edit repack: byte-identical (we built the file the same way repack assembles it).
  const repacked = repackTrb(out);
  check('synthetic: no-edit repack is byte-identical', Buffer.compare(repacked, synthetic) === 0);

  // Functional round-trip.
  const reout = unpackTrb(repacked);
  check('synthetic: repack -> unpack reproduces all entries', entriesEqual(out, reout));

  // Same-length edit round-trip.
  const edited = {
    entries: out.entries.map((e, i) =>
      i === 0 ? { ...e, data: Buffer.from(e.data.map((b) => b ^ 0xff)) } : e,
    ),
    resourceCount: out.resourceCount,
    offsetsRegion: out.offsetsRegion,
  };
  const editedOut = unpackTrb(repackTrb(edited));
  check('synthetic: edited entry survives round-trip', editedOut.entries[0].data.equals(edited.entries[0].data));
  check('synthetic: other entry unaffected', editedOut.entries[1].data.equals(dataB));

  // originalBuf path.
  const fromBare = repackTrb({ entries: out.entries, resourceCount: out.resourceCount }, synthetic);
  check('synthetic: repack from bare entries + originalBuf is byte-identical', Buffer.compare(fromBare, synthetic) === 0);
}

console.log('');
console.log(`trb-repack: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
