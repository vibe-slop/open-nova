/** Mod layout auto-detection tests. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectMod } from '../src/mods/autodetect.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-detect-'));
async function w(p, c = 'x') { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); }
async function fresh(name) { const d = path.join(tmp, name); await fs.mkdir(d, { recursive: true }); return d; }

console.log('Mod layout auto-detection:');

// Nova .ncmp style
{
  const d = await fresh('nova');
  await w(path.join(d, 'modconfig.ini'), '[ModPackConfig]\n');
  await w(path.join(d, 'Data/sys/foo.bin'));
  await w(path.join(d, 'EN-Data/sound/v.scd'));
  const r = await detectMod(d);
  check('ncmp layout detected', r.layout === 'ncmp');
  check('ncmp maps Data + EN-Data flat', r.files.has('sys/foo.bin') && r.files.has('sound/v.scd'));
}

// Rooted at alba_data (with a wrapper folder around it)
{
  const d = await fresh('datarootwrap');
  await w(path.join(d, 'FF XIII-2 HD/alba_data/sys/tex.bin'));
  await w(path.join(d, 'FF XIII-2 HD/alba_data/chr/serah.trb'));
  const r = await detectMod(d);
  check('dataRoot layout detected (through wrapper)', r.layout === 'dataRoot');
  check('dataRoot strips alba_data prefix', r.files.has('sys/tex.bin') && r.files.has('chr/serah.trb'));
}

// Bare tree (top-level dirs are data-root children)
{
  const d = await fresh('bare');
  await w(path.join(d, 'sys/config.bin'));
  await w(path.join(d, 'txt/en/strings.ztr'));
  const r = await detectMod(d);
  check('bare layout detected', r.layout === 'bare');
  check('bare maps files as-is', r.files.has('sys/config.bin') && r.files.has('txt/en/strings.ztr'));
}

// Bare tree with a SINGLE top-level data-root child (must NOT be unwrapped away)
{
  const d = await fresh('single-sys');
  await w(path.join(d, 'sys/only.bin'));
  const r = await detectMod(d);
  check('single sys/ dir detected as bare (not unwrapped)', r.layout === 'bare' && r.files.has('sys/only.bin'));
}

// Windows installer pack
{
  const d = await fresh('installer');
  await w(path.join(d, 'FFXIII-2 HD.bat'), '@echo off');
  await w(path.join(d, 'SupportFiles/ff13tool.exe'));
  const r = await detectMod(d);
  check('installer layout detected', r.layout === 'installer');
  check('installer not installable', r.installable === false && r.files.size === 0);
}

// Unknown
{
  const d = await fresh('unknown');
  await w(path.join(d, 'readme.txt'), 'hi');
  await w(path.join(d, 'random/thing.dat'));
  const r = await detectMod(d);
  check('unknown layout flagged', r.layout === 'unknown' && !r.installable);
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
