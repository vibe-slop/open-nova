/** CLB crypt round-trip + LR config writer tests. */
import { isClb, decryptClb, encryptClb, CLB_MAGIC } from '../src/formats/clb.ts';
import { buildLrConfigurationIni, buildLrEnvironmentIni } from '../src/game/lr-config.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

console.log('CLB crypt + LR config:');

// Build a plaintext .clb: 'CLST' + 4-byte seed tail (8-byte header) + body (mult of 8).
const plain = Buffer.alloc(8 + 64);
plain.write('CLST', 0, 'ascii');
plain[4] = 0x12; plain[5] = 0x34; plain[6] = 0x56; plain[7] = 0x78; // seed tail
for (let i = 8; i < plain.length; i++) plain[i] = (i * 7 + 1) & 0xff;

check('isClb detects CLST magic', isClb(plain) && CLB_MAGIC === 0x54534c43);

const enc = encryptClb(plain);
check('encryptClb keeps 8-byte header', Buffer.compare(enc.subarray(0, 8), plain.subarray(0, 8)) === 0);
check('encryptClb changes the body', Buffer.compare(enc.subarray(8), plain.subarray(8)) !== 0);

const dec = decryptClb(enc);
// encrypt writes the checksum into the last 4 body bytes, so compare the body
// excluding that tail (real .clb files already carry the checksum there).
const bodyEnd = plain.length - 4;
check('decryptClb round-trips body (excl. checksum tail)', Buffer.compare(dec.data.subarray(8, bodyEnd), plain.subarray(8, bodyEnd)) === 0);
check('decryptClb checksum verifies', dec.checksumOk === true);

// LR config ini.
const cfg = buildLrConfigurationIni({ resolution: '1920x1080', frameRate: 'Variable', shadowing: 'High' });
check('LR Configuration.ini has section', cfg.startsWith('[Configuration]'));
check('LR Configuration.ini writes resolution (leading space)', cfg.includes('Graphics_Resolution= 1920x1080'));
check('LR Configuration.ini omits unset keys', !cfg.includes('Graphics_Glare'));
const env = buildLrEnvironmentIni({ voiceLanguage: 'English' });
check('LR Environment.ini', env.includes('[Environment]') && env.includes('VoiceLanguage= English'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
