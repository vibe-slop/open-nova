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
  // (c) .7z / .rar dispatch. When the optional dep is ABSENT, the error must
  //     name the package + install command. When it's INSTALLED (e.g. CI after
  //     `npm install`), a fake archive must still route to the extractor and
  //     throw *some* error (invalid archive) — proving the dispatch path works.
  // -------------------------------------------------------------------------
  const has = async (pkg) => {
    try { await import(pkg); return true; } catch { return false; }
  };
  const cases = [
    { ext: '7z', pkg: '7z-wasm', dir: 'sz' },
    { ext: 'rar', pkg: 'node-unrar-js', dir: 'rr' },
  ];
  for (const c of cases) {
    const p = path.join(tmpRoot, `x.${c.ext}`);
    await fs.writeFile(p, Buffer.from(`not a real ${c.ext}`));
    let err;
    try {
      await extractArchive(p, path.join(tmpRoot, c.dir));
    } catch (e) {
      err = e;
    }
    const missingDepError = !!err && new RegExp(`npm i ${c.pkg}`).test(err.message);
    if (await has(c.pkg)) {
      // dep installed: must route to the real extractor (not the missing-dep error)
      check(`${c.ext}: routed to extractor (dep '${c.pkg}' present)`, !missingDepError);
    } else {
      // dep absent: must throw the clear, named install error
      check(`${c.ext}: error names '${c.pkg}' + install cmd`, missingDepError);
    }
  }

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
