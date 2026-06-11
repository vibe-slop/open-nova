/**
 * In-container texture-injection + built-in fixes.
 *
 * Validated end-to-end against REAL FFXIII-2 data (Leviathan's Tears rain fix
 * injected into a real weather07 veffs container, re-extracted byte-exact, then
 * restored). These synthetic tests guard the logic in CI without game files,
 * and confirm the bundled rain fix is discoverable.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repackWpd, unpackWpd } from '../src/formats/wpd.ts';
import { buildDdsHeader } from '../src/formats/dds.ts';
import { unpackImgb } from '../src/formats/imgb.ts';
import { injectContainerTextures, restoreContainerTextures } from '../src/mods/texture-inject.ts';
import { listBuiltinFixes, getBuiltinFix } from '../src/mods/fixes.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

// Build a classic DXT1 8x8 1-mip GTEX header block (mip = 2*2*8 = 32 bytes).
function gtexHeader() {
  const h = Buffer.alloc(32);
  h.write('GTEX', 0, 'ascii');
  h.writeUInt8(24, 6); // DXT1
  h.writeUInt8(1, 7); // mips
  h.writeUInt8(0, 9); // classic
  h.writeUInt16BE(8, 10); h.writeUInt16BE(8, 12); h.writeUInt16BE(0, 14);
  h.writeUInt32BE(24, 16); // table ptr
  h.writeUInt32BE(0, 24); h.writeUInt32BE(32, 28); // mip: start 0, size 32
  return h;
}

console.log('Texture injection + built-in fixes:');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'txinj-'));
const white = path.join(tmp, 'alba_data');
const backup = path.join(tmp, 'backup');
const payload = path.join(tmp, 'payload');
const dir = path.join(white, 'vfx/x');
await fs.mkdir(dir, { recursive: true });

// Container = cont.imgb (32 bytes, pattern 0xAA) + cont.xfv (WPD with the GTEX header block "tex0.vtex").
const imgb = Buffer.alloc(32, 0xaa);
await fs.writeFile(path.join(dir, 'cont.imgb'), imgb);
const xfv = repackWpd([{ name: 'tex0', ext: 'vtex', data: gtexHeader() }]);
await fs.writeFile(path.join(dir, 'cont.xfv'), xfv);

// Payload: _cont.imgb/tex0.vtex.dds with NEW pixels (0xBB).
const newDds = Buffer.concat([buildDdsHeader({ format: 24, width: 8, height: 8, mipCount: 1 }), Buffer.alloc(32, 0xbb)]);
const pdir = path.join(payload, 'vfx/x/_cont.imgb');
await fs.mkdir(pdir, { recursive: true });
await fs.writeFile(path.join(pdir, 'tex0.vtex.dds'), newDds);

// Inject.
const res = await injectContainerTextures(payload, white, backup);
check('injection reports OK', res.length === 1 && res[0].ok);
const moddedImgb = await fs.readFile(path.join(dir, 'cont.imgb'));
check('imgb changed by injection', Buffer.compare(moddedImgb, imgb) !== 0);
const got = unpackImgb(gtexHeader(), moddedImgb, 'tex0')[0].dds;
check('re-extracted texture == injected DDS', Buffer.compare(got, newDds) === 0);
check('backup of original imgb created', await fs.readFile(path.join(backup, 'vfx/x/cont.imgb')).then((b) => Buffer.compare(b, imgb) === 0).catch(() => false));

// Restore.
const n = await restoreContainerTextures(payload, white, backup);
const restored = await fs.readFile(path.join(dir, 'cont.imgb'));
check('restore returns original imgb', n === 1 && Buffer.compare(restored, imgb) === 0);

// Missing container is reported, not thrown.
const res2 = await injectContainerTextures(payload, path.join(tmp, 'empty'), backup);
check('missing container reported gracefully', res2.length === 1 && !res2[0].ok);

await fs.rm(tmp, { recursive: true, force: true });

// Bundled rain fix is discoverable + credited.
const fixes = await listBuiltinFixes();
const rain = await getBuiltinFix('rain-leviathans-tears');
check('built-in rain fix listed', fixes.some((f) => f.id === 'rain-leviathans-tears'));
check('rain fix targets XIII-2 + texture-inject', rain && rain.game === 'XIII-2' && rain.kind === 'texture-inject');
check('rain fix credits Krisan Thyme', !!rain && /Krisan Thyme/.test(rain.credit));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
