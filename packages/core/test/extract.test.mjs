/**
 * Tests for the cross-platform archive extraction dispatcher.
 *
 *   (a) detectArchiveType maps extensions correctly (incl. .ncmp -> zip).
 *   (b) A real in-memory ZIP with nested files round-trips through
 *       extractArchive and lands on disk with identical contents.
 *   (c) Dispatching to .7z / .rar WITHOUT the optional deps installed throws a
 *       clear Error naming the missing package + install command.
 *   (d) An unknown extension throws.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildZip } from '../src/mods/ncmp.ts';
import { detectArchiveType, extractArchive } from '../src/archive/extract.ts';

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

console.log('Archive extraction dispatcher:');

// ---------------------------------------------------------------------------
// (a) detectArchiveType
// ---------------------------------------------------------------------------
check('detect .zip -> zip', detectArchiveType('mods/Foo.zip') === 'zip');
check('detect .ncmp -> zip', detectArchiveType('mods/Foo.ncmp') === 'zip');
check('detect .7z -> 7z', detectArchiveType('mods/Foo.7z') === '7z');
check('detect .rar -> rar', detectArchiveType('mods/Foo.rar') === 'rar');
check('detect .bin -> unknown', detectArchiveType('mods/Foo.bin') === 'unknown');
check('detect case-insensitive .ZIP -> zip', detectArchiveType('FOO.ZIP') === 'zip');
check('detect no-extension -> unknown', detectArchiveType('README') === 'unknown');

// ---------------------------------------------------------------------------
// (b) real ZIP with nested files round-trips through extractArchive
// ---------------------------------------------------------------------------
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-nova-extract-'));
try {
  const entries = [
    { name: 'modconfig.ini', data: Buffer.from('[Mod]\nName=Test\n', 'utf8') },
    { name: 'Data/textures/hero.dds', data: Buffer.from('the quick brown fox '.repeat(200)) },
    { name: 'EN-Data/strings.ztr', data: Buffer.from([0, 1, 2, 3, 4, 5, 254, 255]) },
    { name: 'External/readme.txt', data: Buffer.from('hello world', 'utf8') },
    { name: 'empty.dat', data: Buffer.alloc(0) },
  ];

  const zipBuf = buildZip(entries);
  const zipPath = path.join(tmpRoot, 'mod.zip');
  await fs.writeFile(zipPath, zipBuf);

  const destDir = path.join(tmpRoot, 'out');
  await extractArchive(zipPath, destDir);

  let allMatch = true;
  let allExist = true;
  for (const e of entries) {
    const outPath = path.join(destDir, ...e.name.split('/'));
    let got;
    try {
      got = await fs.readFile(outPath);
    } catch {
      allExist = false;
      continue;
    }
    if (!Buffer.from(e.data).equals(got)) allMatch = false;
  }
  check('zip: all nested entries extracted to disk', allExist);
  check('zip: every extracted body matches the source', allMatch);

  // Nested directory structure was recreated.
  const dataStat = await fs.stat(path.join(destDir, 'Data', 'textures'));
  check('zip: nested folders recreated', dataStat.isDirectory());

  // extractArchive routed .ncmp through the same ZIP path.
  const ncmpPath = path.join(tmpRoot, 'mod.ncmp');
  await fs.writeFile(ncmpPath, zipBuf);
  const ncmpDest = path.join(tmpRoot, 'out-ncmp');
  await extractArchive(ncmpPath, ncmpDest);
  const ncmpReadme = await fs.readFile(path.join(ncmpDest, 'External', 'readme.txt'));
  check('ncmp: routed through zip extractor', ncmpReadme.toString('utf8') === 'hello world');

  // -------------------------------------------------------------------------
  // (c) .7z / .rar without optional deps installed -> clear, named error
  // -------------------------------------------------------------------------
  const sevenZipPath = path.join(tmpRoot, 'x.7z');
  await fs.writeFile(sevenZipPath, Buffer.from('not a real 7z'));
  let sevenErr;
  try {
    await extractArchive(sevenZipPath, path.join(tmpRoot, 'sz'));
  } catch (e) {
    sevenErr = e;
  }
  check('7z: throws when dep missing', sevenErr instanceof Error);
  check(
    "7z: error names the '7z-wasm' package",
    !!sevenErr && /7z-wasm/.test(sevenErr.message),
  );
  check(
    '7z: error includes install command',
    !!sevenErr && /npm i 7z-wasm/.test(sevenErr.message),
  );

  const rarPath = path.join(tmpRoot, 'x.rar');
  await fs.writeFile(rarPath, Buffer.from('not a real rar'));
  let rarErr;
  try {
    await extractArchive(rarPath, path.join(tmpRoot, 'rr'));
  } catch (e) {
    rarErr = e;
  }
  check('rar: throws when dep missing', rarErr instanceof Error);
  check(
    "rar: error names the 'node-unrar-js' package",
    !!rarErr && /node-unrar-js/.test(rarErr.message),
  );
  check(
    'rar: error includes install command',
    !!rarErr && /npm i node-unrar-js/.test(rarErr.message),
  );

  // -------------------------------------------------------------------------
  // (d) unknown extension throws
  // -------------------------------------------------------------------------
  const binPath = path.join(tmpRoot, 'mystery.bin');
  await fs.writeFile(binPath, Buffer.from('???'));
  let unknownErr;
  try {
    await extractArchive(binPath, path.join(tmpRoot, 'mb'));
  } catch (e) {
    unknownErr = e;
  }
  check('unknown: throws for unsupported extension', unknownErr instanceof Error);
  check(
    'unknown: error lists supported types',
    !!unknownErr && /\.zip/.test(unknownErr.message) && /\.7z/.test(unknownErr.message),
  );
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
