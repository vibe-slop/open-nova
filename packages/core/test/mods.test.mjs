/**
 * Self-consistency tests for the mod manager layer:
 *  - INI round-trip preserving the leading-space write quirk + the MISSPELLED
 *    `NovaChysaliaConfig` section + ReadBool semantics.
 *  - `.ncmp` create -> extract round-trip over a nested temp folder tree.
 *  - install onto a synthetic `whitePath`, then uninstall restoring originals
 *    exactly: a pre-existing file is backed up + restored byte-for-byte, and a
 *    brand-new file is deleted.
 *
 * No real game files are required; everything is synthesized in os.tmpdir().
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { Ini, parseIni, stringifyIni, parseBool } from '../src/mods/ini.ts';
import { createNcmp, extractNcmp, buildZip, parseZip, crc32 } from '../src/mods/ncmp.ts';
import { ModManager, gameEntryToId, gameIdToEntry } from '../src/mods/manager.ts';

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

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const tmpDirs = [];
async function tmp(prefix) {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// 1) INI round-trip + quirks
// ---------------------------------------------------------------------------
console.log('INI parser/writer:');
{
  const ini = new Ini();
  ini.set('ModPackConfig', 'Name', 'Cool Mod');
  ini.set('ModPackConfig', 'GameEntry', '2');
  // MISSPELLED section preserved verbatim.
  ini.setBool('NovaChysaliaConfig', 'Installed', false);
  ini.setBool('NovaChysaliaConfig', 'ENInstalled', true);

  const text = ini.stringify();
  check('writes leading-space quirk (Key= value)', text.includes('Name= Cool Mod'));
  check('preserves misspelled NovaChysaliaConfig section', text.includes('[NovaChysaliaConfig]'));

  const back = Ini.parse(text);
  check('round-trips Name value', back.get('ModPackConfig', 'Name') === 'Cool Mod');
  check('round-trips GameEntry', back.get('ModPackConfig', 'GameEntry') === '2');
  check('getBool true', back.getBool('NovaChysaliaConfig', 'ENInstalled') === true);
  check('getBool false', back.getBool('NovaChysaliaConfig', 'Installed') === false);

  // ReadBool edge cases.
  check('parseBool missing -> false', parseBool(undefined) === false);
  check('parseBool empty -> false', parseBool('') === false);
  check('parseBool TRUE (case-insensitive) -> true', parseBool('TRUE') === true);
  check('parseBool TrUe -> true', parseBool('TrUe') === true);
  check('parseBool garbage -> false', parseBool('yes') === false);

  // Case sensitivity of names.
  check('case-sensitive section miss', Ini.parse(text).get('modpackconfig', 'Name') === undefined);
  check('case-sensitive key miss', back.get('ModPackConfig', 'name') === undefined);

  // Tolerate a value WITHOUT the leading space on read.
  const noSpace = parseIni('[S]\r\nKey=novalue\r\n');
  check('tolerates value without leading space', noSpace.S.Key === 'novalue');

  // A value with multiple leading spaces only strips the first.
  const multi = parseIni('[S]\r\nKey=  two\r\n');
  check('strips only one leading space', multi.S.Key === ' two');

  // stringify/parse identity for an arbitrary nested object.
  const obj = { A: { x: '1', y: 'hello world' }, B: { z: 'true' } };
  const rt = parseIni(stringifyIni(obj));
  check('stringify->parse identity', JSON.stringify(rt) === JSON.stringify(obj));

  // File helpers.
  const d = await tmp('nova-ini-');
  const f = path.join(d, 'modconfig.ini');
  await ini.writeFile(f);
  const loaded = await Ini.readFile(f);
  check('file write/read round-trip', loaded.get('ModPackConfig', 'Name') === 'Cool Mod');
}

// ---------------------------------------------------------------------------
// 2) CRC + ZIP buffer round-trip (store + deflate)
// ---------------------------------------------------------------------------
console.log('ZIP / ncmp:');
{
  // Known CRC-32 vector: crc32("123456789") == 0xCBF43926.
  check('crc32 known vector', crc32(Buffer.from('123456789')) === 0xcbf43926);

  const inputs = [
    { name: 'modconfig.ini', data: Buffer.from('[ModPackConfig]\r\nName= X\r\n') },
    { name: 'Data\\sys\\a.bin', data: randomBytes(2000) }, // backslash -> normalised
    { name: 'Data/highly/compressible.txt', data: Buffer.from('A'.repeat(5000)) },
    { name: 'EN-Data/voice/v.scd', data: randomBytes(300) },
    { name: 'empty.dat', data: Buffer.alloc(0) },
  ];
  const zip = buildZip(inputs);
  const parsed = parseZip(zip);
  check('zip entry count', parsed.length === inputs.length);
  check('zip normalises backslashes', parsed.some((e) => e.name === 'Data/sys/a.bin'));
  let allMatch = true;
  for (const inp of inputs) {
    const want = Buffer.from(inp.data);
    const got = parsed.find((e) => e.name === inp.name.replace(/\\/g, '/'));
    if (!got || !want.equals(got.data)) allMatch = false;
  }
  check('zip data round-trip (store + deflate + empty)', allMatch);
  // Deflate actually shrank the compressible entry.
  check('compressible entry uses deflate (smaller than store)', zip.length < 5000 + 2000 + 300 + 1000);
}

// ---------------------------------------------------------------------------
// 3) createNcmp -> extractNcmp on a nested tree
// ---------------------------------------------------------------------------
{
  const src = await tmp('nova-ncmp-src-');
  await mkdir(path.join(src, 'Data', 'chr', 'serah'), { recursive: true });
  await mkdir(path.join(src, 'EN-Data', 'txt'), { recursive: true });
  await mkdir(path.join(src, 'Code'), { recursive: true });
  const files = {
    'modconfig.ini': Buffer.from('[ModPackConfig]\r\nName= Tree\r\n'),
    [path.join('Data', 'chr', 'serah', 'model.trb')]: randomBytes(4096),
    [path.join('Data', 'sys', 'config.bin')]: Buffer.from('config '.repeat(200)),
    [path.join('EN-Data', 'txt', 'strings.ztr')]: randomBytes(800),
    [path.join('Code', 'patch.nccp')]: randomBytes(64),
  };
  for (const [rel, data] of Object.entries(files)) {
    const full = path.join(src, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  const ncmp = path.join(await tmp('nova-ncmp-out-'), 'pack.ncmp');
  await createNcmp(src, ncmp);
  const dest = await tmp('nova-ncmp-dst-');
  await extractNcmp(ncmp, dest);

  let allMatch = true;
  for (const [rel, data] of Object.entries(files)) {
    const got = await readFile(path.join(dest, rel)).catch(() => null);
    if (!got || !Buffer.from(data).equals(got)) allMatch = false;
  }
  check('ncmp create->extract preserves nested tree', allMatch);
}

// ---------------------------------------------------------------------------
// 4) Manager: gameId mapping
// ---------------------------------------------------------------------------
console.log('ModManager:');
{
  check('gameEntryToId 2 -> XIII-2', gameEntryToId('2') === 'XIII-2');
  check('gameIdToEntry XIII-LR -> 3', gameIdToEntry('XIII-LR') === '3');
}

// ---------------------------------------------------------------------------
// 5) generate -> import -> install -> uninstall round-trip
// ---------------------------------------------------------------------------
{
  const base = await tmp('nova-base-');
  const mgr = new ModManager(base);

  // Build a mod that overwrites one pre-existing game file and adds a new one.
  const preExistingRel = path.join('sys', 'config.bin');
  const newRel = path.join('chr', 'serah', 'model.trb');
  const modConfigPayload = Buffer.from('MODDED-CONFIG-CONTENT');
  const newFilePayload = randomBytes(2048);

  const ncmp = path.join(base, 'pack.ncmp');
  await mgr.generateModPack(
    {
      name: 'Test Mod',
      gameEntry: '2',
      author: 'tester',
      version: '1.2.3',
      summary: 'a test',
      data: {
        'sys/config.bin': modConfigPayload,
        'chr/serah/model.trb': newFilePayload,
      },
      code: { 'runtime.nccp': randomBytes(32) },
    },
    ncmp,
  );
  check('generateModPack produced .ncmp', await exists(ncmp));

  // Import it.
  const info = await mgr.importModPack(ncmp);
  check('import sets Name', info.name === 'Test Mod');
  check('import sets gameId from GameEntry', info.gameId === 'XIII-2');
  check('imported mod dir exists', await exists(info.modDir));
  const list = await mgr.listMods();
  check('listMods finds the imported mod', list.length === 1 && list[0].name === 'Test Mod');

  // Build a synthetic unpacked game tree (whitePath).
  const whitePath = await tmp('nova-white-');
  const originalConfig = Buffer.from('ORIGINAL-CONFIG-BYTES-12345');
  await mkdir(path.join(whitePath, 'sys'), { recursive: true });
  await writeFile(path.join(whitePath, preExistingRel), originalConfig);
  // newRel does NOT exist yet in whitePath.
  check('pre-existing file present before install', await exists(path.join(whitePath, preExistingRel)));
  check('new file absent before install', !(await exists(path.join(whitePath, newRel))));

  // Install.
  await mgr.installMod(info.modName, whitePath, { data: true });

  const installedConfig = await readFile(path.join(whitePath, preExistingRel));
  check('install overwrote pre-existing file with mod content', installedConfig.equals(modConfigPayload));
  const installedNew = await readFile(path.join(whitePath, newRel));
  check('install added new file', installedNew.equals(newFilePayload));

  // Backup was created for the pre-existing file only.
  const backup = path.join(mgr.backupDir('XIII-2'), preExistingRel);
  check('backup created for pre-existing original', await exists(backup));
  const backupBytes = await readFile(backup);
  check('backup holds the EXACT original bytes', backupBytes.equals(originalConfig));
  check('no backup for the brand-new file', !(await exists(path.join(mgr.backupDir('XIII-2'), newRel))));

  // Code patch copied to Patches/<gameId>/
  check('code patch copied to Patches', await exists(path.join(mgr.patchesDir('XIII-2'), 'runtime.nccp')));

  // State flag persisted.
  const afterInstall = await mgr.readModInfo('XIII-2', info.modName);
  check('Installed flag set true after install', afterInstall.installed === true);

  // Uninstall.
  await mgr.uninstallMod(info.modName, whitePath, { data: true });

  const restored = await readFile(path.join(whitePath, preExistingRel));
  check('uninstall restored pre-existing original EXACTLY', restored.equals(originalConfig));
  check('uninstall deleted the brand-new file', !(await exists(path.join(whitePath, newRel))));
  check('backup consumed (removed) after restore', !(await exists(backup)));

  const afterUninstall = await mgr.readModInfo('XIII-2', info.modName);
  check('Installed flag cleared after uninstall', afterUninstall.installed === false);
}

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------
for (const d of tmpDirs) {
  await rm(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
