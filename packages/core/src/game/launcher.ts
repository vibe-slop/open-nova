/**
 * Launch-time executable patching for the FFXIII trilogy.
 *
 * These edits are expressed as RVAs (module base + offset). They are applied to
 * the on-disk executable before launch (mapping each RVA to a file offset via
 * the PE section table), keeping a `.original` backup, rather than as live
 * process-memory writes to the running game.
 *
 *  - "unpacked mode" — the critical one: makes the game read loose files from
 *    the unpacked data tree instead of the white_img archives (so mods apply).
 *  - text language — forces the in-game text language (1..8).
 *  - debug — enables the engine debug features (XIII / XIII-2 only).
 */
import { applyBytesAtRva, patchLargeAddressAware, isLargeAddressAware } from './pe-patch.js';

/** Engine language id per textMode (1..8 = EN/FR/DE/IT/ES/JA/ZH/KO). */
const LANG_ID: Record<number, number> = { 1: 1, 2: 5, 3: 4, 4: 3, 5: 6, 6: 0, 7: 10, 8: 8 };

export interface LaunchPatchOptions {
  /** Apply the unpacked-mode patch (requires the game to be unpacked). */
  unpacked?: boolean;
  /** Force text language 1..8, or omit/0 to leave as-is. */
  textLanguage?: number;
  /** Enable engine debug (XIII / XIII-2 only). */
  debug?: boolean;
}

export interface ExePatch {
  rva: number;
  bytes: number[];
  label: string;
}

function langDwordLE(mode: number): number[] {
  const id = LANG_ID[mode] ?? 1;
  return [id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff];
}

/** Build the list of (rva, bytes) patches for a game + options. */
export function buildLaunchPatches(gameNumber: 1 | 2 | 3, opts: LaunchPatchOptions): ExePatch[] {
  const patches: ExePatch[] = [];
  const lang = opts.textLanguage && opts.textLanguage >= 1 && opts.textLanguage <= 8 ? opts.textLanguage : 0;

  if (gameNumber === 1) {
    if (opts.unpacked) patches.push({ rva: 12597, bytes: [0xeb], label: 'unpacked' }, { rva: 37626, bytes: [0xeb], label: 'unpacked' });
    if (lang) {
      patches.push(
        { rva: 30206, bytes: [0x01], label: 'lang' },
        { rva: 4418188, bytes: [0x28], label: 'lang' },
        { rva: 4418219, bytes: [0xc7, 0x05], label: 'lang' },
        { rva: 4418225, bytes: [...langDwordLE(lang), 0x8b, 0xe5, 0x5d, 0xc3], label: 'lang' },
      );
    }
    if (opts.debug) for (const rva of [38343, 38849, 38896, 39102]) patches.push({ rva, bytes: [0x00], label: 'debug' });
  } else if (gameNumber === 2) {
    if (opts.unpacked) patches.push({ rva: 39044, bytes: [0x75], label: 'unpacked' }, { rva: 59433, bytes: [0xeb], label: 'unpacked' });
    if (lang) {
      patches.push(
        { rva: 2828056, bytes: [0x24], label: 'lang' },
        { rva: 2828083, bytes: [0xc7, 0x05], label: 'lang' },
        { rva: 2828089, bytes: [...langDwordLE(lang), 0xc3], label: 'lang' },
      );
    }
    if (opts.debug) {
      patches.push({ rva: 59768, bytes: [0x00], label: 'debug' }, { rva: 59832, bytes: [0x00], label: 'debug' });
      patches.push({ rva: 59884, bytes: [0xff, 0xff, 0xff, 0xff], label: 'debug' });
    }
  } else {
    // Lightning Returns
    if (opts.unpacked) patches.push({ rva: 214937, bytes: [0xeb], label: 'unpacked' });
    if (lang) patches.push({ rva: 3489262, bytes: [0x90, 0x90, 0xb9, ...langDwordLE(lang)], label: 'lang' });
    // debug unsupported on LR
  }
  return patches;
}

/**
 * Return a copy of the executable with the launch patches applied (plus the
 * Large-Address-Aware bit, which the game needs to avoid out-of-memory crashes).
 * Throws if any patch offset is out of range (signals a wrong/updated exe).
 */
export function patchExeForLaunch(exeBuf: Buffer, gameNumber: 1 | 2 | 3, opts: LaunchPatchOptions): Buffer {
  let out = isLargeAddressAware(exeBuf) ? Buffer.from(exeBuf) : patchLargeAddressAware(exeBuf);
  for (const p of buildLaunchPatches(gameNumber, opts)) {
    out = applyBytesAtRva(out, p.rva, Buffer.from(p.bytes));
  }
  return out;
}
