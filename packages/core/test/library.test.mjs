/**
 * End-to-end ModLibrary test: import (extracted dir + real zip) -> auto-detect
 * -> enable/disable through the deployment ledger. This is the whole
 * "download, enable/disable, automatic" pipeline minus the network.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModLibrary } from '../src/mods/library.ts';
import { buildZip } from '../src/mods/ncmp.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-lib-'));
const base = path.join(tmp, 'appdata');
const white = path.join(tmp, 'game', 'alba_data');
async function w(p, c) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); }
async function r(p) { try { return await fs.readFile(p, 'utf8'); } catch { return null; } }

await w(path.join(white, 'sys/shared.bin'), 'VANILLA');
const lib = new ModLibrary(base);

console.log('ModLibrary end-to-end:');

// Import a "bare" extracted mod (top-level dir = data-root child).
const modAdir = path.join(tmp, 'extracted-A');
await w(path.join(modAdir, 'sys/shared.bin'), 'FROM-A');
await w(path.join(modAdir, 'sys/extraA.bin'), 'A-EXTRA');
const A = await lib.importExtracted('XIII-2', modAdir, { name: 'Mod A', author: 'tester' });
check('import auto-detects bare layout', A.layout === 'bare' && A.installable);
check('import staged disabled by default', A.enabled === false);

// Enable A -> deployed.
await lib.setEnabled('XIII-2', A.modName, true, white);
check('enable A deploys overlay', (await r(path.join(white, 'sys/shared.bin'))) === 'FROM-A');
check('enable A adds extra file', (await r(path.join(white, 'sys/extraA.bin'))) === 'A-EXTRA');

// Import a conflicting mod via a REAL zip, enable it at higher priority.
const zipBuf = buildZip([
  { name: 'My Mod B/alba_data/sys/shared.bin', data: Buffer.from('FROM-B') },
]);
const zipPath = path.join(tmp, 'modB.zip');
await fs.writeFile(zipPath, zipBuf);
const B = await lib.importArchive('XIII-2', zipPath, { name: 'Mod B', source: 'local' });
check('zip import + detect dataRoot layout', B.layout === 'dataRoot' && B.installable);
await lib.setEnabled('XIII-2', B.modName, true, white);
check('B (higher priority) wins shared.bin', (await r(path.join(white, 'sys/shared.bin'))) === 'FROM-B');
check('A-only file still present with both enabled', (await r(path.join(white, 'sys/extraA.bin'))) === 'A-EXTRA');

// Disable B -> falls back to A (not vanilla).
await lib.setEnabled('XIII-2', B.modName, false, white);
check('disable B falls back to A', (await r(path.join(white, 'sys/shared.bin'))) === 'FROM-A');

// Disable A -> vanilla restored, extra removed.
await lib.setEnabled('XIII-2', A.modName, false, white);
check('disable A restores vanilla', (await r(path.join(white, 'sys/shared.bin'))) === 'VANILLA');
check('disable A removes extra file', (await r(path.join(white, 'sys/extraA.bin'))) === null);

// Load order: with both enabled, reordering flips which mod wins a conflict.
await lib.setEnabled('XIII-2', A.modName, true, white);
await lib.setEnabled('XIII-2', B.modName, true, white);
let ordered = (await lib.list('XIII-2')).map((m) => m.modName); // priority asc
await lib.setOrder('XIII-2', ordered, white);
const lastWins = ordered[ordered.length - 1];
const expected = lastWins === A.modName ? 'FROM-A' : 'FROM-B';
check('lowest-in-list... last applied wins conflict', (await r(path.join(white, 'sys/shared.bin'))) === expected);
// Reverse the order -> the other mod now wins.
await lib.setOrder('XIII-2', [...ordered].reverse(), white);
const newLast = [...ordered].reverse()[ordered.length - 1];
check('reorder flips the conflict winner', (await r(path.join(white, 'sys/shared.bin'))) === (newLast === A.modName ? 'FROM-A' : 'FROM-B'));
await lib.setEnabled('XIII-2', A.modName, false, white);
await lib.setEnabled('XIII-2', B.modName, false, white);

// list reflects state.
const list = await lib.list('XIII-2');
check('list returns both mods', list.length === 2 && list.every((m) => !m.enabled));

// Regression: a .ncmp wrapped inside a downloaded .zip must auto-unwrap and
// detect as a normal Nova pack (not flagged "manual install").
const ncmpBuf = buildZip([
  { name: 'modconfig.ini', data: Buffer.from('[Mod]\nName=Wrapped\n') },
  { name: 'Data/chr/pc/c240/bin/c240.win32.trb', data: Buffer.from('TRB-DATA') },
]);
const wrappedZip = buildZip([{ name: 'Wrapped Mod.ncmp', data: ncmpBuf }]);
const wrappedPath = path.join(tmp, 'wrapped.zip');
await fs.writeFile(wrappedPath, wrappedZip);
const C = await lib.importArchive('XIII-2', wrappedPath, { name: 'Wrapped Mod' });
check('zip-wrapped .ncmp unwraps to installable ncmp layout', C.layout === 'ncmp' && C.installable);
check('zip-wrapped .ncmp note records the unwrap', /Unwrapped a bundled \.ncmp/.test(C.note));
await lib.setEnabled('XIII-2', C.modName, true, white);
check('wrapped .ncmp deploys its Data files', (await r(path.join(white, 'chr/pc/c240/bin/c240.win32.trb'))) === 'TRB-DATA');
await lib.setEnabled('XIII-2', C.modName, false, white);

// Importing a second mod with the SAME display name doesn't clobber the first —
// it gets a unique library key + a disambiguated display name.
const dupDir = path.join(tmp, 'extracted-dup');
await w(path.join(dupDir, 'sys/dup.bin'), 'DUP');
const Adup = await lib.importExtracted('XIII-2', dupDir, { name: 'Mod A' });
check('duplicate-name import gets a unique key', Adup.modName !== A.modName);
check('duplicate-name import disambiguates the display name', /\(2\)/.test(Adup.name));
check('both same-named mods coexist', (await lib.list('XIII-2')).filter((m) => m.modName === A.modName || m.modName === Adup.modName).length === 2);

// Resilient reconcile: a mod whose staged content is missing is skipped (and the
// rest still deploy) instead of the whole reconcile throwing.
for (const m of await lib.list('XIII-2')) await lib.setEnabled('XIII-2', m.modName, false, white);
await fs.rm(path.join(base, 'Mods', 'XIII-2', A.modName, 'content'), { recursive: true, force: true });
let reconcileThrew = false;
try {
  await lib.setEnabled('XIII-2', B.modName, true, white); // intact -> deploys
  await lib.setEnabled('XIII-2', A.modName, true, white); // content gone -> skipped, not fatal
} catch {
  reconcileThrew = true;
}
check('reconcile skips a content-missing mod without throwing', !reconcileThrew);
check('an intact mod still deploys despite a broken sibling', (await r(path.join(white, 'sys/shared.bin'))) === 'FROM-B');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
