/**
 * Compute a filelist entry's `fileCode` from its virtual path.
 *
 * The FFXIII engine resolves every resource through the filelist, keyed on a
 * `fileCode`: a STRUCTURED, bit-packed integer (NOT a hash) encoding the file's
 * category, model/zone id, extension and a small variant index. Because it is
 * deterministic, open-nova can synthesise the correct code for any supported
 * path — which is what lets it RE-POINT the entries that the Steam releases
 * stripped (their original DLC `fileCode`s are still in the index, just pointed
 * at duplicate paths) and, in principle, register brand-new files, all without
 * any per-mod data.
 *
 * The layout is reverse-engineered from Surihix's open-source WhiteFilelistManager
 * (`PathGenTools`) and verified to reproduce 9,085/9,085 non-stripped `chr/pc`
 * codes in a real FFXIII-2 filelist (the 30 it "misses" are exactly the
 * repointed DLC slots — see docs/REVERSE-ENGINEERING.md).
 *
 * Field widths and ids differ per game and per top-level directory; only the
 * handlers we have verified are implemented. Unsupported paths return null and
 * the caller treats the file as not auto-indexable (a plain replacement still
 * works without any filelist edit, since its entry already exists).
 */
import type { GameCode } from './filelist.js';

export interface ComputedCode {
  /** The packed u32 file code. */
  fileCode: number;
  /** The entry type byte (e.g. 16 for chr/pc on XIII-2/LR). */
  fileTypeId: number;
}

/** chr category ids (the 2nd path segment), shared across the trilogy. */
const CHR_CATEGORY: Record<string, number> = {
  pc: 2, exte: 4, fa: 5, mon: 12, npc: 13, summon: 18, weapon: 22,
};

/** Leading run of digits in a path segment (`c171` → 171, `loc0500` → 500). */
function deriveNum(segment: string): number {
  const m = /([0-9]+)/.exec(segment.split('.')[0]);
  return m ? parseInt(m[1], 10) : -1;
}

/** Classify a `chr` file's extension into (extnId, mpkVariant). null if unknown. */
function chrExtension(name: string): { extnId: number; mpk: number } | null {
  if (name.endsWith('.win32.imgb')) return { extnId: 0, mpk: 0 };
  if (name.endsWith('.win32.trb')) return { extnId: 1, mpk: 0 };
  if (name.endsWith('.win32.mpk')) {
    const mpk = name.endsWith('_rain.win32.mpk') ? 1 : name.endsWith('_snow.win32.mpk') ? 2 : 0;
    return { extnId: 4, mpk };
  }
  return null;
}

/** chr/* handler. `chr/<category>/<model>/bin/<file>`. */
function chrCode(seg: string[], game: GameCode): ComputedCode | null {
  const category = CHR_CATEGORY[seg[1]];
  if (category === undefined) return null;
  const modelId = deriveNum(seg[2]);
  if (modelId < 0 || modelId > 999) return null;
  const name = seg[seg.length - 1];
  const ext = chrExtension(name);
  if (!ext) return null;
  // XIII-LR / XIII have no `.mpk` family; only imgb/trb are valid there.
  if ((game === 1 || game === 3) && ext.extnId === 4) return null;

  let code: number;
  if (game === 2) {
    // reserved(4)=0 | category(5) | modelID(10) | extn(5) | mpk(8)
    code = ((category << 23) | (modelId << 13) | (ext.extnId << 8) | ext.mpk) >>> 0;
  } else if (game === 3) {
    // reserved(4)=0 | category(5) | modelID(10) | extn(5) | reserved(8)=0
    code = ((category << 23) | (modelId << 13) | (ext.extnId << 8)) >>> 0;
  } else {
    // XIII (game 1): mainType(4)=1 | category(5) | modelID(10) | extn(5) | reserved(8)=0
    code = ((1 << 28) | (category << 23) | (modelId << 13) | (ext.extnId << 8)) >>> 0;
  }
  return { fileCode: code, fileTypeId: 16 };
}

/**
 * Compute the `fileCode` (and `fileTypeId`) for a `/`-separated virtual path on
 * the given game, or null when the path's directory isn't a handler we have
 * verified. The result is the canonical Square-Enix code, so it can be matched
 * against a live filelist's existing entries.
 */
export function computeFileCode(virtualPath: string, game: GameCode): ComputedCode | null {
  // A single hardcoded special case in the original tool.
  if (virtualPath === 'sys/dlc/key/key00000000.dat') return { fileCode: 4098, fileTypeId: 224 };

  const seg = virtualPath.split('/');
  if (seg.length < 3) return null;
  switch (seg[0]) {
    case 'chr':
      return chrCode(seg, game);
    default:
      return null;
  }
}
