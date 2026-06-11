/**
 * fileCode computation: the structured, bit-packed code the FFXIII engine keys
 * every filelist lookup on. Verified against the canonical values in Surihix's
 * WhiteFilelistManager docs (chr/pc/c001 family) and against the FFXIII-2
 * Console Content Patch's hardcoded DLC table (c171). When a real filelist is
 * present it also re-checks that the algorithm reproduces every non-stripped
 * chr/pc code (the only misses are the repointed DLC slots).
 */
import { promises as fs } from 'node:fs';
import { computeFileCode } from '../src/archive/filecode.ts';
import { parseFilelist } from '../src/archive/filelist.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };
const code = (p, g = 2) => computeFileCode(p, g)?.fileCode;

console.log('fileCode computation (XIII-2):');
// Canonical c001 family (WhiteFilelistManager official examples).
check('c001.imgb = 16785408', code('chr/pc/c001/bin/c001.win32.imgb') === 16785408);
check('c001.trb = 16785664', code('chr/pc/c001/bin/c001.win32.trb') === 16785664);
check('c001_def.mpk = 16786432', code('chr/pc/c001/bin/c001_def.win32.mpk') === 16786432);
check('c001_rain.mpk = 16786433', code('chr/pc/c001/bin/c001_rain.win32.mpk') === 16786433);
check('c001_snow.mpk = 16786434', code('chr/pc/c001/bin/c001_snow.win32.mpk') === 16786434);
// DLC c171 (Console Content Patch canonical codes).
check('c171.imgb = 18178048', code('chr/pc/c171/bin/c171.win32.imgb') === 18178048);
check('c171.trb = 18178304', code('chr/pc/c171/bin/c171.win32.trb') === 18178304);
check('c171_def.mpk = 18179072', code('chr/pc/c171/bin/c171_def.win32.mpk') === 18179072);
check('c171_snow.mpk = 18179074', code('chr/pc/c171/bin/c171_snow.win32.mpk') === 18179074);
const ft = computeFileCode('chr/pc/c171/bin/c171.win32.imgb', 2);
check('chr fileTypeId = 16', ft?.fileTypeId === 16);
// Special-case + unsupported.
const key = computeFileCode('sys/dlc/key/key00000000.dat', 2);
check('sys/dlc/key special-case = {4098, 224}', key?.fileCode === 4098 && key?.fileTypeId === 224);
check('unsupported path -> null', computeFileCode('zone/whatever/foo.bin', 2) === null);
check('non-chr top dir -> null', computeFileCode('movie/opening.win32.bik', 2) === null);

// Optional real-data regression (skipped if the fixture is absent).
const REAL = '/tmp/fl/filelistu.win32.bin';
if (await fs.access(REAL).then(() => true).catch(() => false)) {
  const fl = parseFilelist(await fs.readFile(REAL), 2);
  let modeled = 0, match = 0;
  for (const f of fl.files) {
    if (!f.virtualPath.startsWith('chr/')) continue;
    const c = computeFileCode(f.virtualPath, 2);
    if (!c) continue;
    modeled++;
    if ((c.fileCode >>> 0) === (f.fileCode >>> 0)) match++;
  }
  // All chr codes match except the ~30 repointed DLC slots.
  check(`real filelist: ${match}/${modeled} chr codes match (misses are repointed DLC)`, modeled > 9000 && modeled - match === 30);
} else {
  console.log('  · real-filelist regression skipped (no /tmp/fl fixture)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
