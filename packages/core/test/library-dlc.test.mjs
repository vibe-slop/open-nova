/**
 * DLC restoration end-to-end through the library: a mod that ADDS a file the
 * Steam release stripped (its entry was repointed to a duplicate path) becomes
 * visible because reconcile computes the file's canonical fileCode and repoints
 * the existing entry back. Disabling restores the pristine filelist.
 *
 * Generic: no per-mod data — the index code comes from computeFileCode.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModLibrary } from '../src/mods/library.ts';
import { buildFilelist, parseFilelist } from '../src/archive/filelist.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

console.log('DLC restore via filelist repoint (library reconcile):');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'libdlc-'));
const base = path.join(tmp, 'app');
const white = path.join(tmp, 'game'); // the unpacked alba_data tree

// A synthetic FFXIII-2 filelist: one STRIPPED slot (c171's canonical code,
// 18178048, but path repointed to a duplicate c204) plus a normal base entry.
const STRIPPED = 'chr/pc/c204/bin/c204.win32.imgb';
const REAL = 'chr/pc/c171/bin/c171.win32.imgb';
const fl = {
  gameCode: 2,
  encrypted: false,
  chunkCount: 1,
  files: [
    { fileCode: 18178048, fileTypeId: 16, chunkSubByte: 0, chunkIndex: 0, posUnits: 100, uncmpSize: 5000, cmpSize: 2000, virtualPath: STRIPPED },
    { fileCode: 17653760, fileTypeId: 16, chunkSubByte: 0, chunkIndex: 0, posUnits: 200, uncmpSize: 3000, cmpSize: 1500, virtualPath: 'chr/pc/c107/bin/c107.win32.imgb' },
  ],
};
await fs.mkdir(path.join(white, 'sys'), { recursive: true });
await fs.writeFile(path.join(white, 'sys/filelistu.win32.bin'), buildFilelist(fl));
await fs.writeFile(path.join(white, '.open-nova-unpacked'), ''); // unpacked-mode marker

const liveCodeToPath = async () => {
  const live = parseFilelist(await fs.readFile(path.join(white, 'sys/filelistu.win32.bin')), 2);
  const e = live.files.find((f) => (f.fileCode >>> 0) === 18178048);
  return e ? { path: e.virtualPath, uncmp: e.uncmpSize, cmp: e.cmpSize, pos: e.posUnits } : null;
};

check('baseline: code 18178048 points at the stripped duplicate', (await liveCodeToPath())?.path === STRIPPED);

// A mod that ADDS the real c171 model file (bare overlay).
const stage = path.join(tmp, 'mod');
await fs.mkdir(path.join(stage, 'chr/pc/c171/bin'), { recursive: true });
await fs.writeFile(path.join(stage, REAL), Buffer.alloc(777, 9)); // 777-byte body

const lib = new ModLibrary(base);
const mod = await lib.importExtracted('XIII-2', stage, { name: 'c171 DLC' });
check('mod imports as installable overlay', mod.installable && mod.layout === 'bare');

// Enable -> reconcile: deploys the loose file AND repoints the filelist entry.
await lib.setEnabled('XIII-2', mod.modName, true, white);
const loose = await fs.readFile(path.join(white, REAL)).then((b) => b.length).catch(() => -1);
check('loose c171 file deployed', loose === 777);
const after = await liveCodeToPath();
check('entry repointed to the real c171 path', after?.path === REAL);
check('entry sized to the loose file (uncmp==cmp==777, pos 0)', after?.uncmp === 777 && after?.cmp === 777 && after?.pos === 0);

// The c107 base entry is untouched.
const liveC107 = parseFilelist(await fs.readFile(path.join(white, 'sys/filelistu.win32.bin')), 2)
  .files.find((f) => f.virtualPath === 'chr/pc/c107/bin/c107.win32.imgb');
check('base c107 entry intact', !!liveC107 && liveC107.uncmpSize === 3000);

// Disable -> reconcile: filelist restored to the pristine (stripped) baseline.
await lib.setEnabled('XIII-2', mod.modName, false, white);
check('disable restores the pristine filelist (back to duplicate)', (await liveCodeToPath())?.path === STRIPPED);

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
