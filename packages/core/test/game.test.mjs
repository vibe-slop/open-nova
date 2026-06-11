/**
 * Self-consistency tests for the game-discovery + launch-prep layer:
 *   - gameinfo lookups (by number, app id, string id) and known constants.
 *   - PE patching against a hand-built minimal fake PE buffer: the
 *     Large-Address-Aware bit round-trips, and rvaToFileOffset maps a known RVA
 *     into the correct section's raw data.
 *   - the minimal libraryfolders.vdf parser against a synthetic VDF string.
 *
 * NOTE: this proves the primitives are internally consistent and match the PE /
 * VDF / GameInfo specs. Real-hardware checks (a real exe under Proton, a real
 * Steam install) are exercised separately by game/launcher.ts against a live
 * install.
 */
import {
  GAMES,
  getGameByNumber,
  getGameByAppId,
  getGameById,
} from '../src/game/gameinfo.ts';
import {
  isLargeAddressAware,
  patchLargeAddressAware,
  rvaToFileOffset,
  applyBytesAtRva,
  applyBytesAtFileOffset,
} from '../src/game/pe-patch.ts';
import { parseLibraryFoldersVdf } from '../src/game/steam.ts';

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

// --- gameinfo ---------------------------------------------------------------
console.log('GameInfo table:');
check('three games present', GAMES.length === 3);
check('getGameByNumber(2) is XIII-2', getGameByNumber(2)?.id === 'XIII-2');
check('XIII-2 app id is 292140', getGameByNumber(2)?.steamAppId === '292140');
check('getGameByAppId 345350 is XIII-LR', getGameByAppId('345350')?.id === 'XIII-LR');
check('XIII-LR exe at root', getGameById('XIII-LR')?.exeRel === 'LRFF13.exe');
check('XIII dataRoot white_data', getGameById('XIII')?.dataRoot === 'white_data');
check('XIII-2 dataRoot alba_data', getGameById('XIII-2')?.dataRoot === 'alba_data');
check('XIII-LR dataRoot weiss_data', getGameById('XIII-LR')?.dataRoot === 'weiss_data');
check('XIII exeRel uses forward slashes', getGameById('XIII')?.exeRel === 'white_data/prog/win/bin/ffxiiiimg.exe');
check('XIII-2 exeRel uses forward slashes', getGameById('XIII-2')?.exeRel === 'alba_data/prog/win/bin/ffxiii2img.exe');
check('XIII folder name', getGameById('XIII')?.folder === 'FINAL FANTASY XIII');
check('unknown number returns undefined', getGameByNumber(9) === undefined);
check('numbers are 1/2/3 in order', GAMES.map((g) => g.number).join(',') === '1,2,3');

// --- minimal fake PE buffer -------------------------------------------------
// Layout we build:
//   0x00..      DOS header. e_lfanew (uint32 LE) at 0x3C -> peOffset.
//   peOffset:   "PE\0\0" signature (4 bytes)
//   peOffset+4: COFF/IMAGE_FILE_HEADER (20 bytes):
//                 +0  Machine(uint16)
//                 +2  NumberOfSections(uint16)
//                 +0x10 SizeOfOptionalHeader(uint16) [offset within COFF]
//                 +0x12 Characteristics(uint16)
//               (relative to peOffset: NumberOfSections @ +6,
//                SizeOfOptionalHeader @ +0x14, Characteristics @ +0x16)
//   peOffset+0x18: optional header (we give it SizeOfOptionalHeader bytes)
//   then: section table (40 bytes per section)
//   then: raw data we can patch into.
function buildFakePe() {
  const peOffset = 0x80; // arbitrary, > 0x40 so DOS header has room
  const sizeOfOptionalHeader = 0xe0; // typical PE32 optional header size
  const numSections = 2;

  const sectionTableStart = peOffset + 0x18 + sizeOfOptionalHeader;
  const sectionTableSize = numSections * 40;
  // Place section raw data after the section table, aligned a bit.
  const text = {
    name: '.text',
    virtualAddress: 0x1000,
    sizeOfRawData: 0x400,
    pointerToRawData: sectionTableStart + sectionTableSize + 0x10,
  };
  const data = {
    name: '.data',
    virtualAddress: 0x2000,
    sizeOfRawData: 0x400,
    pointerToRawData: text.pointerToRawData + text.sizeOfRawData,
  };

  const total = data.pointerToRawData + data.sizeOfRawData;
  const buf = Buffer.alloc(total);

  // DOS magic 'MZ' for realism (not required by our code).
  buf.write('MZ', 0, 'ascii');
  // e_lfanew @ 0x3C
  buf.writeUInt32LE(peOffset, 0x3c);
  // PE signature
  buf.writeUInt32LE(0x00004550, peOffset); // 'PE\0\0'
  // COFF header
  buf.writeUInt16LE(0x014c, peOffset + 4); // Machine = i386
  buf.writeUInt16LE(numSections, peOffset + 6); // NumberOfSections
  buf.writeUInt16LE(sizeOfOptionalHeader, peOffset + 0x14); // SizeOfOptionalHeader
  buf.writeUInt16LE(0x0102, peOffset + 0x16); // Characteristics (LAA NOT set)

  // Section headers
  function writeSection(base, sec) {
    buf.write(sec.name, base, 'ascii'); // name @ 0x00 (8 bytes)
    buf.writeUInt32LE(sec.virtualAddress, base + 0x0c);
    buf.writeUInt32LE(sec.sizeOfRawData, base + 0x10);
    buf.writeUInt32LE(sec.pointerToRawData, base + 0x14);
  }
  writeSection(sectionTableStart, text);
  writeSection(sectionTableStart + 40, data);

  return { buf, peOffset, text, data };
}

console.log('\nPE patching:');
const { buf: peBuf, peOffset, text, data } = buildFakePe();

// Large Address Aware
check('LAA initially not set', isLargeAddressAware(peBuf) === false);
const patched = patchLargeAddressAware(peBuf);
check('patch sets LAA bit', isLargeAddressAware(patched) === true);
check('patch does not mutate input', isLargeAddressAware(peBuf) === false);
// Verify only the LAA bit changed in Characteristics (0x0102 -> 0x0122).
check(
  'characteristics OR 0x20',
  patched.readUInt16LE(peOffset + 0x16) === (0x0102 | 0x0020),
);
// Idempotent
check('patch is idempotent', patchLargeAddressAware(patched).equals(patched));

// rvaToFileOffset for a known RVA inside .text
{
  const rva = text.virtualAddress + 0x123;
  const expected = text.pointerToRawData + 0x123;
  check('rvaToFileOffset .text', rvaToFileOffset(peBuf, rva) === expected);
}
// rvaToFileOffset for a known RVA inside .data
{
  const rva = data.virtualAddress + 0x10;
  const expected = data.pointerToRawData + 0x10;
  check('rvaToFileOffset .data', rvaToFileOffset(peBuf, rva) === expected);
}
// RVA outside any section throws
{
  let threw = false;
  try {
    rvaToFileOffset(peBuf, 0x9000);
  } catch {
    threw = true;
  }
  check('rvaToFileOffset out-of-range throws', threw);
}

// applyBytesAtRva writes to the mapped file offset
{
  const rva = text.virtualAddress + 0x20;
  const fileOff = text.pointerToRawData + 0x20;
  const out = applyBytesAtRva(peBuf, rva, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  check('applyBytesAtRva writes at mapped offset',
    out[fileOff] === 0xde && out[fileOff + 1] === 0xad && out[fileOff + 2] === 0xbe && out[fileOff + 3] === 0xef);
  check('applyBytesAtRva does not mutate input', peBuf[fileOff] === 0x00);
}

// applyBytesAtFileOffset bounds check
{
  let threw = false;
  try {
    applyBytesAtFileOffset(peBuf, peBuf.length - 1, Buffer.from([1, 2, 3, 4]));
  } catch {
    threw = true;
  }
  check('applyBytesAtFileOffset out-of-range throws', threw);
}

// --- VDF parser -------------------------------------------------------------
console.log('\nlibraryfolders.vdf parser:');
const vdf = `
"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"/home/deck/.local/share/Steam"
\t\t"label"\t\t""
\t\t"contentid"\t\t"1234567890"
\t\t"apps"
\t\t{
\t\t\t"292140"\t\t"12345678"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"/run/media/mmcblk0p1/SteamLibrary"
\t\t"label"\t\t"SD Card"
\t\t"apps"
\t\t{
\t\t\t"345350"\t\t"87654321"
\t\t}
\t}
}
`;
const paths = parseLibraryFoldersVdf(vdf);
check('vdf yields 2 library paths', paths.length === 2);
check('vdf path 0 correct', paths[0] === '/home/deck/.local/share/Steam');
check('vdf path 1 correct', paths[1] === '/run/media/mmcblk0p1/SteamLibrary');

// Windows-style escaped backslashes in a path
const winVdf = `"libraryfolders"{"0"{"path"\t"C:\\\\Program Files (x86)\\\\Steam"}}`;
const winPaths = parseLibraryFoldersVdf(winVdf);
check('vdf handles escaped backslashes', winPaths.length === 1 && winPaths[0] === 'C:\\Program Files (x86)\\Steam');

// Empty / malformed input is tolerated
check('vdf empty string -> []', parseLibraryFoldersVdf('').length === 0);
check('vdf garbage -> []', parseLibraryFoldersVdf('not a vdf at all').length === 0);

// findGameInstall must prefer the library that actually contains the game's
// data root (Steam can leave a stub install folder in the internal library
// while the real files live on an SD card — the Steam Deck case).
{
  const { promises: fs } = await import('node:fs');
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { findGameInstall } = await import('../src/game/steam.ts');
  const { getGameById } = await import('../src/game/gameinfo.ts');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-steam-'));
  const internal = path.join(tmp, 'steam');
  const sd = path.join(tmp, 'sdcard');
  const g = getGameById('XIII-2');
  // internal = stub (folder exists, no alba_data); sd = real (has alba_data).
  await fs.mkdir(path.join(internal, 'steamapps', 'common', g.folder), { recursive: true });
  await fs.mkdir(path.join(sd, 'steamapps', 'common', g.folder, g.dataRoot), { recursive: true });
  await fs.mkdir(path.join(internal, 'steamapps'), { recursive: true });
  await fs.writeFile(
    path.join(internal, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n  "0"\n  {\n    "path"  "${internal}"\n  }\n  "1"\n  {\n    "path"  "${sd}"\n  }\n}\n`,
  );
  const found = await findGameInstall(g, internal);
  check('findGameInstall prefers the data-root install over a stub', found === path.join(sd, 'steamapps', 'common', g.folder));
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
