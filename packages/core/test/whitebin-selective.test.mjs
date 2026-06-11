/**
 * Selective-repack tests: repackArchiveSelective must inject a file in place
 * when its new body fits the original slot (posUnits unchanged, leftover bytes
 * NUL-wiped) and append it to the end otherwise (posUnits changed). Either way
 * every body must survive an unpack of the rebuilt archive.
 *
 * Self-consistency only: proves the selective writer agrees with the existing
 * pack/unpack readers. Byte-identity against Nova's RepackSelective is a
 * separate, install-backed check (see docs/ARCHITECTURE.md).
 */
import { randomBytes } from 'node:crypto';
import { packArchive, unpackArchive } from '../src/archive/whitebin.ts';
import { repackArchiveSelective } from '../src/archive/whitebin-selective.ts';

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

console.log('WhiteBin selective repack:');

// Uncompressed bodies keep the inject/append decision deterministic (no zlib
// size guessing): on-disk size == body length == cmpSize == uncmpSize.
const SHRINK = 'data/shrink.bin'; // starts large, edited smaller -> INJECT
const GROW = 'data/grow.bin'; //    starts small, edited larger -> APPEND
const KEEP = 'data/keep.bin'; //    untouched neighbour

const origShrink = randomBytes(4000);
const origGrow = randomBytes(300);
const origKeep = randomBytes(2500);

const inputs = [
  { virtualPath: SHRINK, data: origShrink, compress: false },
  { virtualPath: GROW, data: origGrow, compress: false },
  { virtualPath: KEEP, data: origKeep, compress: false },
];

const { filelist: flRaw, img } = packArchive(inputs, 2, { chunkCount: 1 });
const parsed = unpackArchive(flRaw, img, 2);

// Record original offsets so we can assert inject keeps them.
const posBefore = Object.fromEntries(parsed.filelist.files.map((f) => [f.virtualPath, f.posUnits]));

// shrink.bin -> 100 bytes (<= 4000 slot, fits -> inject in place).
// grow.bin   -> 9000 bytes (> 300 slot -> append, new offset).
const newShrink = randomBytes(100);
const newGrow = randomBytes(9000);

const edited = {
  [SHRINK]: newShrink,
  [GROW]: newGrow,
};

const { filelist: fl2, img: img2 } = repackArchiveSelective(
  parsed.filelist,
  (vp) => edited[vp] ?? parsed.files.find((u) => u.virtualPath === vp).data,
  img,
);

const reparsed = unpackArchive(fl2, img2, 2);
const posAfter = Object.fromEntries(reparsed.filelist.files.map((f) => [f.virtualPath, f.posUnits]));

// Inject case: offset preserved.
check('shrink.bin injected in place (posUnits unchanged)', posAfter[SHRINK] === posBefore[SHRINK]);
// The untouched neighbour fits too (unchanged body) -> also stays put.
check('keep.bin stays in place (posUnits unchanged)', posAfter[KEEP] === posBefore[KEEP]);
// Append case: offset changed (and moved past the original payload).
check('grow.bin appended (posUnits changed)', posAfter[GROW] !== posBefore[GROW]);
check('grow.bin offset past original payload', posAfter[GROW] * 0x800 >= img.length);

// Bodies all match after the rebuild.
const got = (vp) => reparsed.files.find((u) => u.virtualPath === vp);
check('shrink.bin body == edited (smaller)', got(SHRINK).data.equals(newShrink));
check('grow.bin body == edited (larger)', got(GROW).data.equals(newGrow));
check('keep.bin body == original (untouched)', got(KEEP).data.equals(origKeep));

// The in-place injection must have NUL-wiped the slot leftover: the bytes in
// img2 immediately after the new (100-byte) shrink body, within its old 4000-
// byte slot, must be zero — and must NOT equal the stale original bytes.
{
  const start = posBefore[SHRINK] * 0x800;
  const tail = img2.subarray(start + newShrink.length, start + origShrink.length);
  check('shrink.bin leftover slot NUL-wiped', tail.every((b) => b === 0));
}

// A second selective pass that changes nothing must be a no-op on all bodies.
{
  const { filelist: fl3, img: img3 } = repackArchiveSelective(
    reparsed.filelist,
    (vp) => reparsed.files.find((u) => u.virtualPath === vp).data,
    img2,
  );
  const r3 = unpackArchive(fl3, img3, 2);
  const stable =
    r3.files.find((u) => u.virtualPath === SHRINK).data.equals(newShrink) &&
    r3.files.find((u) => u.virtualPath === GROW).data.equals(newGrow) &&
    r3.files.find((u) => u.virtualPath === KEEP).data.equals(origKeep);
  check('idempotent no-op selective pass preserves all bodies', stable);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
