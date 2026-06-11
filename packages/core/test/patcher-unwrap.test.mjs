/**
 * Krisan-Thyme-style `.exe` patcher packs (Leviathan's Tears, the Console
 * Content Patch, …) ship their real payload inside a `PatchData.bin` ZIP next
 * to an `FFXIII2*.exe` + `WhiteBinTools.dll`. open-nova used to flag these as
 * non-installable Windows installers. importExtracted now unwraps PatchData.bin
 * and classifies the inner tree, so the patch installs natively.
 *
 * Covers both payload shapes the family uses: whole-file (content-restore) and
 * in-container texture injection.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModLibrary } from '../src/mods/library.ts';
import { detectMod } from '../src/mods/autodetect.ts';
import { buildZip } from '../src/mods/ncmp.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

console.log('Windows .exe patcher unwrap (PatchData.bin -> native mod):');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'patcher-'));
const base = path.join(tmp, 'app');

// --- a whole-file (content-restore) patcher pack ---
const whole = path.join(tmp, 'whole');
await fs.mkdir(whole, { recursive: true });
await fs.writeFile(path.join(whole, 'FFXIII2ConsoleContentPatch.exe'), Buffer.from('MZ fake'));
await fs.writeFile(path.join(whole, 'WhiteBinTools.dll'), Buffer.from('fake'));
await fs.writeFile(path.join(whole, 'LocateFile.dll'), Buffer.from('fake'));
await fs.writeFile(
  path.join(whole, 'PatchData.bin'),
  buildZip([
    { name: 'chr/pc/c171/bin/c171.win32.imgb', data: Buffer.alloc(64, 1) },
    { name: 'chr/pc/c171/bin/c171.win32.trb', data: Buffer.alloc(32, 2) },
    { name: 'db/resident/wdbpack.bin', data: Buffer.alloc(16, 3) },
  ]),
);

// Sanity: the pack as-is (with the .exe) classifies as a non-installable installer.
const asInstaller = await detectMod(whole);
check('raw pack (with .exe) detects as non-installable installer', asInstaller.layout === 'installer' && asInstaller.installable === false);

const lib = new ModLibrary(base);
const m1 = await lib.importExtracted('XIII-2', whole, { name: 'Console Content Patch' });
check('whole-file patcher unwraps to installable bare overlay', m1.layout === 'bare' && m1.installable === true);
check('note records the patcher unwrap', /Unwrapped from a Windows patcher/.test(m1.note));
// the staged content/ holds the unwrapped tree, not the .exe shell
const c1 = path.join(lib.modsDir('XIII-2'), m1.modName, 'content');
const staged = await fs.readFile(path.join(c1, 'chr/pc/c171/bin/c171.win32.imgb')).then(() => true).catch(() => false);
const noExe = !(await fs.readFile(path.join(c1, 'FFXIII2ConsoleContentPatch.exe')).then(() => true).catch(() => false));
check('staged content is the unwrapped payload (files present, .exe gone)', staged && noExe);

// --- a texture-inject patcher pack (Leviathan's-Tears shape) ---
const tex = path.join(tmp, 'tex');
await fs.mkdir(tex, { recursive: true });
await fs.writeFile(path.join(tex, 'FFXIII2LeviathansTears.exe'), Buffer.from('MZ fake'));
await fs.writeFile(path.join(tex, 'WPDtool.dll'), Buffer.from('fake'));
await fs.writeFile(
  path.join(tex, 'PatchData.bin'),
  buildZip([
    { name: 'vfx/weather/weather07/_veffs.win32.imgb/tex0.vtex.dds', data: Buffer.alloc(128, 7) },
  ]),
);
const m2 = await lib.importExtracted('XIII-2', tex, { name: "Leviathan's Tears" });
check('texture-inject patcher unwraps to installable texture-inject layout', m2.layout === 'texture-inject' && m2.installable === true);

// --- a genuine installer with NO PatchData.bin stays non-installable ---
const plain = path.join(tmp, 'plain');
await fs.mkdir(plain, { recursive: true });
await fs.writeFile(path.join(plain, 'install.bat'), Buffer.from('echo hi'));
const m3 = await lib.importExtracted('XIII-2', plain, { name: 'Some Installer' });
check('plain installer (no PatchData.bin) stays non-installable', m3.layout === 'installer' && m3.installable === false);

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
