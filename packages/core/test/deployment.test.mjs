/**
 * Deployment ledger tests — the enable/disable/reorder + conflict semantics
 * that the per-mod install model couldn't do correctly.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Deployment } from '../src/mods/deployment.ts';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-deploy-'));
const base = path.join(tmp, 'appdata');
const white = path.join(tmp, 'game', 'alba_data');
const modsRoot = path.join(tmp, 'mods');

async function write(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}
async function read(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}
// A provider: map of relpath -> source file, materialized under modsRoot/<name>/Data.
async function provider(name, files) {
  const map = new Map();
  for (const [rel, content] of Object.entries(files)) {
    const src = path.join(modsRoot, name, rel);
    await write(src, content);
    map.set(rel, src);
  }
  return { modName: name, files: map };
}

// Vanilla game files.
await write(path.join(white, 'sys/shared.txt'), 'VANILLA-shared');
await write(path.join(white, 'sys/onlyVanilla.txt'), 'VANILLA-only');

const dep = new Deployment(base);

console.log('Deployment ledger:');

// Mod A overlays shared.txt + adds a new file. Mod B overlays shared.txt too.
const A = await provider('ModA', { 'sys/shared.txt': 'A-shared', 'sys/newFromA.txt': 'A-new' });
const B = await provider('ModB', { 'sys/shared.txt': 'B-shared' });

// Enable A only.
let r = await dep.reconcile('XIII-2', white, [A]);
check('A: shared.txt = A', (await read(path.join(white, 'sys/shared.txt'))) === 'A-shared');
check('A: newFromA.txt added', (await read(path.join(white, 'sys/newFromA.txt'))) === 'A-new');
check('A: vanilla untouched file intact', (await read(path.join(white, 'sys/onlyVanilla.txt'))) === 'VANILLA-only');

// Enable B at higher priority (after A) — B should win the conflict.
r = await dep.reconcile('XIII-2', white, [A, B]);
check('A+B: shared.txt = B (higher priority wins)', (await read(path.join(white, 'sys/shared.txt'))) === 'B-shared');
check('A+B: conflict reported', r.conflicts.some((c) => c.path === 'sys/shared.txt' && c.winner === 'ModB' && c.losers.includes('ModA')));
check('A+B: A-only file still present', (await read(path.join(white, 'sys/newFromA.txt'))) === 'A-new');

// Disable B (back to A only) — shared.txt must fall back to A, NOT to vanilla.
r = await dep.reconcile('XIII-2', white, [A]);
check('disable B: shared.txt falls back to A (not vanilla)', (await read(path.join(white, 'sys/shared.txt'))) === 'A-shared');

// Disable everything — vanilla restored, added file removed.
r = await dep.reconcile('XIII-2', white, []);
check('disable all: shared.txt restored to VANILLA', (await read(path.join(white, 'sys/shared.txt'))) === 'VANILLA-shared');
check('disable all: A-added file deleted', (await read(path.join(white, 'sys/newFromA.txt'))) === null);
check('disable all: vanilla-only file intact', (await read(path.join(white, 'sys/onlyVanilla.txt'))) === 'VANILLA-only');

// Re-enable B alone then disable — exercises mod-added-vs-vanilla on a shared path.
await dep.reconcile('XIII-2', white, [B]);
check('re-enable B: shared.txt = B', (await read(path.join(white, 'sys/shared.txt'))) === 'B-shared');
await dep.reconcile('XIII-2', white, []);
check('final disable: vanilla restored again', (await read(path.join(white, 'sys/shared.txt'))) === 'VANILLA-shared');

// Idempotency.
const before = await read(path.join(white, 'sys/shared.txt'));
await dep.reconcile('XIII-2', white, []);
check('idempotent reconcile', (await read(path.join(white, 'sys/shared.txt'))) === before);

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
