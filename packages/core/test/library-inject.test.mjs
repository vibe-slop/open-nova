/**
 * Texture-inject mods as first-class library mods: enable/disable through the
 * deployment ledger, with LOAD ORDER deciding the winner when two mods inject
 * the same texture (the "some mods need to go before the rain fix" case).
 * Also confirms the bundled rain fix registers as a re-orderable library mod.
 *
 * Validated against REAL FFXIII-2 data separately (rain fix enabled via the
 * library injected the real weather07 container, disable restored vanilla).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModLibrary } from '../src/mods/library.ts';
import { repackWpd, unpackWpd } from '../src/formats/wpd.ts';
import { buildDdsHeader } from '../src/formats/dds.ts';
import { unpackImgb } from '../src/formats/imgb.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

// classic DXT1 8x8 1-mip GTEX header block (mip = 32 bytes)
function gtex() {
  const h = Buffer.alloc(32);
  h.write('GTEX', 0, 'ascii');
  h.writeUInt8(24, 6); h.writeUInt8(1, 7); h.writeUInt8(0, 9);
  h.writeUInt16BE(8, 10); h.writeUInt16BE(8, 12); h.writeUInt16BE(0, 14);
  h.writeUInt32BE(24, 16); h.writeUInt32BE(0, 24); h.writeUInt32BE(32, 28);
  return h;
}
const dds = (fill) => Buffer.concat([buildDdsHeader({ format: 24, width: 8, height: 8, mipCount: 1 }), Buffer.alloc(32, fill)]);
const texOf = (white, dir) => {
  const xfv = path.join(white, dir, 'cont.xfv'); const imgb = path.join(white, dir, 'cont.imgb');
  return Promise.all([fs.readFile(xfv), fs.readFile(imgb)]).then(([x, i]) => unpackImgb(unpackWpd(x).entries.find((e) => e.name === 'tex0').data, i, 'tex0')[0].dds);
};

console.log('Texture-inject mods in the library (enable/disable + load order):');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'libinj-'));
const base = path.join(tmp, 'app'); const white = path.join(tmp, 'game');
const cdir = path.join(white, 'vfx/x');
await fs.mkdir(cdir, { recursive: true });
const vanillaImgb = Buffer.alloc(32, 0xaa);
await fs.writeFile(path.join(cdir, 'cont.imgb'), vanillaImgb);
await fs.writeFile(path.join(cdir, 'cont.xfv'), repackWpd([{ name: 'tex0', ext: 'vtex', data: gtex() }]));

const lib = new ModLibrary(base);
// Two injection mods targeting the SAME entry (tex0) with different pixels.
async function makeInjMod(name, fill) {
  const stage = path.join(tmp, 'stage-' + name);
  const p = path.join(stage, 'vfx/x/_cont.imgb');
  await fs.mkdir(p, { recursive: true });
  await fs.writeFile(path.join(p, 'tex0.vtex.dds'), dds(fill));
  return lib.importExtracted('XIII-2', stage, { name });
}
const A = await makeInjMod('Mod A', 0xbb);
const B = await makeInjMod('Mod B', 0xcc);
check('inject mods import as texture-inject layout', A.layout === 'texture-inject' && B.layout === 'texture-inject' && A.installable);

// Enable A only.
await lib.setEnabled('XIII-2', A.modName, true, white);
check('enable A injects A texture', (await texOf(white, 'vfx/x')).subarray(128).every((b) => b === 0xbb));

// Enable B (higher priority) -> B wins the shared texture.
await lib.setEnabled('XIII-2', B.modName, true, white);
let order = (await lib.list('XIII-2')).map((m) => m.modName); // priority asc
const lastWins = order[order.length - 1] === B.modName ? 0xcc : 0xbb;
check('both enabled: last-in-order wins shared texture', (await texOf(white, 'vfx/x')).subarray(128).every((b) => b === lastWins));

// Reorder so A is last -> A wins now.
await lib.setOrder('XIII-2', [B.modName, A.modName], white);
check('reorder flips the winner to A', (await texOf(white, 'vfx/x')).subarray(128).every((b) => b === 0xbb));

// Disable both -> vanilla restored.
await lib.setEnabled('XIII-2', A.modName, false, white);
await lib.setEnabled('XIII-2', B.modName, false, white);
check('disable all: container restored to vanilla', Buffer.compare(await fs.readFile(path.join(cdir, 'cont.imgb')), vanillaImgb) === 0);

// Bundled fixes register as re-orderable library mods.
await lib.syncBuiltinFixes('XIII-2');
const builtins = await lib.list('XIII-2');
const rain = builtins.find((m) => /Rain/.test(m.name));
check('bundled rain fix registered (texture-inject, disabled)', !!rain && rain.source === 'builtin' && rain.layout === 'texture-inject' && rain.enabled === false);
const ff13 = builtins.find((m) => /FF13 ?Fix/.test(m.name));
check(
  'bundled FF13 Fix registered (overlay, locked, first, on by default)',
  !!ff13 && ff13.source === 'builtin' && ff13.layout === 'bare' && ff13.enabled === true && ff13.locked === true && ff13.priority === 0,
);
check('FF13 Fix id-keyed (rename-safe)', ff13?.modName === 'ff13fix');

// A locked fix IS toggle-able — it can be turned off, and that choice must
// survive a re-sync (syncBuiltinFixes runs on every list/launch; it must not
// force the fix back on).
await lib.setEnabled('XIII-2', ff13.modName, false, white);
check('FF13 Fix can be disabled', (await lib.list('XIII-2')).find((m) => m.modName === 'ff13fix')?.enabled === false);
await lib.syncBuiltinFixes('XIII-2');
check('FF13 Fix stays disabled across a re-sync', (await lib.list('XIII-2')).find((m) => m.modName === 'ff13fix')?.enabled === false);

// ...but it can't be removed.
let ff13RemoveRefused = false;
try { await lib.remove('XIII-2', ff13.modName, white); } catch { ff13RemoveRefused = true; }
check('FF13 Fix refuses removal', ff13RemoveRefused && (await lib.list('XIII-2')).some((m) => m.modName === 'ff13fix'));

// ...and stays pinned first even if a reorder tries to move it.
await lib.setEnabled('XIII-2', ff13.modName, true, white); // re-enable for the overlay check below
await lib.setOrder('XIII-2', [A.modName, ff13.modName], white);
check('FF13 Fix stays priority 0 after a reorder attempt', (await lib.list('XIII-2')).find((m) => m.modName === 'ff13fix')?.priority === 0);

// FF13 Fix also targets base FFXIII (game 1), but not Lightning Returns.
await lib.syncBuiltinFixes('XIII');
check('FF13 Fix registered for XIII too', (await lib.list('XIII')).some((m) => m.modName === 'ff13fix' && m.locked));
await lib.syncBuiltinFixes('XIII-LR');
check('FF13 Fix NOT registered for Lightning Returns', !(await lib.list('XIII-LR')).some((m) => m.modName === 'ff13fix'));

// FF13 Fix is a loose-file overlay into prog/win/bin — works without unpacking.
await lib.reconcile('XIII-2', white);
const placed = await fs.readFile(path.join(white, 'prog/win/bin/d3d9.dll')).then(() => true).catch(() => false);
check('FF13 Fix overlays d3d9.dll into prog/win/bin on reconcile', placed);
check('FF13 Fix dxvk.conf placed', await fs.readFile(path.join(white, 'prog/win/bin/dxvk.conf'), 'utf8').then((s) => /samplerAnisotropy/.test(s)).catch(() => false));

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
