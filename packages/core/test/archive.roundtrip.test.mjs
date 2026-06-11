/**
 * Self-consistency tests for the archive layer: pack -> unpack and
 * unpack -> repack -> unpack must preserve every file body, across both entry
 * layouts (FF13-1 vs FF13-2/LR), multi-chunk filelists, and the encrypted path.
 *
 * NOTE: this proves the reader and writer agree with each other. Byte-identity
 * against the ORIGINAL tool's output must be confirmed against a real install
 * (see docs/ARCHITECTURE.md milestone 2).
 */
import { randomBytes } from 'node:crypto';
import { packArchive, unpackArchive, repackArchive } from '../src/archive/whitebin.ts';
import { decryptFilelist, isFilelistEncrypted, deriveSeed } from '../src/crypto/filelist-crypto.ts';

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

function sampleFiles() {
  return [
    { virtualPath: 'sys/config.bin', data: Buffer.from('hello world '.repeat(40)), compress: true },
    { virtualPath: 'chr/serah/model.trb', data: randomBytes(5000), compress: false },
    { virtualPath: 'txt/en/strings.ztr', data: Buffer.from('the quick brown fox '.repeat(100)), compress: true },
    { virtualPath: ' ', data: randomBytes(123), compress: false }, // no-path sentinel
    { virtualPath: 'zone/z001/area.scd', data: randomBytes(33000), compress: true },
  ];
}

function eqFiles(inputs, unpacked) {
  if (inputs.length !== unpacked.length) return false;
  for (let i = 0; i < inputs.length; i++) {
    const want = Buffer.isBuffer(inputs[i].data) ? inputs[i].data : Buffer.from(inputs[i].data);
    const got = unpacked.find((u) => u.virtualPath === inputs[i].virtualPath);
    if (!got || !want.equals(got.data)) return false;
  }
  return true;
}

console.log('Archive layer round-trip:');

// Regression: filelist seed derivation must SIGN-EXTEND (the original casts a
// signed int32 to ulong). When header[9]'s high bit is set, the upper 4 seed
// bytes are 0xFF, not 0x00. Validated against a real FFXIII-2 filelist whose
// header byte[9]=0xa1 yields seed f5ca56a1ffffffff.
{
  const hi = new Uint8Array(16);
  hi[0] = 0xf5; hi[2] = 0xca; hi[12] = 0x56; hi[9] = 0xa1; // high bit set
  check('seed sign-extends when header[9] high bit set', Buffer.from(deriveSeed(hi)).toString('hex') === 'f5ca56a1ffffffff');
  const lo = new Uint8Array(16);
  lo[0] = 0xf5; lo[2] = 0xca; lo[12] = 0x56; lo[9] = 0x21; // high bit clear
  check('seed zero-extends when header[9] high bit clear', Buffer.from(deriveSeed(lo)).toString('hex') === 'f5ca562100000000');
}

for (const gameCode of [1, 2, 3]) {
  for (const chunkCount of [1, 3]) {
    const inputs = sampleFiles();
    const { filelist, img } = packArchive(inputs, gameCode, { chunkCount });
    const { files } = unpackArchive(filelist, img, gameCode);
    check(`pack->unpack gc${gameCode} chunks=${chunkCount}`, eqFiles(inputs, files));
  }
}

// Encrypted filelist (FF13-2 / LR)
for (const gameCode of [2, 3]) {
  const inputs = sampleFiles();
  const { filelist, img } = packArchive(inputs, gameCode, { encrypted: true, chunkCount: 2 });
  check(`encrypted: magic tag present gc${gameCode}`, isFilelistEncrypted(filelist));
  const dec = decryptFilelist(filelist);
  check(`encrypted: checksum verifies gc${gameCode}`, dec.checksumOk === true);
  const { files } = unpackArchive(filelist, img, gameCode);
  check(`encrypted pack->unpack gc${gameCode}`, eqFiles(inputs, files));
}

// Repack (modify a file body, ensure it survives a rebuild)
{
  const inputs = sampleFiles();
  const { filelist: fl, img } = packArchive(inputs, 2, { chunkCount: 2 });
  const parsed = unpackArchive(fl, img, 2);
  const edited = Buffer.from('EDITED CONTENT '.repeat(50));
  const { filelist: fl2, img: img2 } = repackArchive(parsed.filelist, (vp, f) =>
    vp === 'sys/config.bin' ? edited : parsed.files.find((u) => u.virtualPath === vp).data,
  );
  const reparsed = unpackArchive(fl2, img2, 2);
  const got = reparsed.files.find((u) => u.virtualPath === 'sys/config.bin');
  check('repack preserves edited body', !!got && got.data.equals(edited));
  const untouched = reparsed.files.find((u) => u.virtualPath === 'zone/z001/area.scd');
  const orig = parsed.files.find((u) => u.virtualPath === 'zone/z001/area.scd');
  check('repack preserves untouched bodies', !!untouched && untouched.data.equals(orig.data));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
