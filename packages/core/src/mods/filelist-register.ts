/**
 * Make mod-ADDED files visible to the engine by registering them in the live
 * filelist index.
 *
 * The FFXIII engine resolves every resource through the filelist (keyed on
 * `fileCode`), in BOTH packed and unpacked modes — the unpacked exe-patch only
 * changes the backing store (loose file vs archive), not the requirement that a
 * resource be indexed. So a mod that REPLACES an existing file needs no filelist
 * edit (the entry already exists; the deployment overlay/injection handles it),
 * but a mod that ADDS a file — most notably the DLC characters the Steam release
 * stripped — is invisible until its filelist entry exists.
 *
 * The Steam release "stripped" the DLC by repointing those entries' paths to
 * duplicates of base-game files while KEEPING their original `fileCode`s. Since
 * {@link computeFileCode} can reproduce the canonical code from a path, we find
 * the stripped entry by code and repoint it back — generically, with no per-mod
 * data. (A genuinely novel path whose code isn't already in the index can't be
 * made loadable without an external runtime hook, so it is reported unresolved.)
 *
 * All edits are reversible: the pristine filelist is backed up once and rebuilt
 * from that baseline on every reconcile, so disabling a mod restores it exactly.
 * Only runs when the game is unpacked (editing a packed filelist without also
 * repacking white_img would be destructive).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFilelist, buildFilelist, type Filelist, type GameCode } from '../archive/filelist.js';
import { computeFileCode } from '../archive/filecode.js';
import { getGameById, type GameId } from '../game/gameinfo.js';

/** Marker written by the unpacker; filelist edits only apply in unpacked mode. Must match the app. */
const UNPACKED_MARKER = '.open-nova-unpacked';

export interface RegisterResult {
  /** Entries repointed back to a mod-added path. */
  repointed: number;
  /** Paths that needed no index change (already present) or were repointed. */
  resolved: Set<string>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Repoint stripped entries in a parsed filelist back to the mod-added paths that
 * own their `fileCode`. Mutates `fl` in place. `wanted` maps each provided
 * virtual path to its on-disk (loose) size.
 */
export function registerPaths(fl: Filelist, game: GameCode, wanted: Map<string, number>): RegisterResult {
  const havePath = new Set(fl.files.map((f) => f.virtualPath));
  const byCode = new Map(fl.files.map((f) => [f.fileCode >>> 0, f]));
  const resolved = new Set<string>();
  let repointed = 0;

  for (const [virtualPath, size] of wanted) {
    if (havePath.has(virtualPath)) {
      resolved.add(virtualPath); // replacement: entry already exists, overlay handles it
      continue;
    }
    const cc = computeFileCode(virtualPath, game);
    if (!cc) continue;
    const entry = byCode.get(cc.fileCode >>> 0);
    if (!entry) continue; // canonical code not present in this filelist
    // Repoint the stripped/duplicate slot back to its real path. In unpacked
    // mode the data comes from the loose file, so position is irrelevant and
    // uncmp==cmp marks it stored-uncompressed.
    entry.virtualPath = virtualPath;
    entry.fileTypeId = cc.fileTypeId;
    entry.posUnits = 0;
    entry.uncmpSize = size;
    entry.cmpSize = size;
    resolved.add(virtualPath);
    repointed++;
  }
  return { repointed, resolved };
}

export interface FilelistReconcileResult {
  /** Total entries repointed across all filelist files. */
  repointed: number;
  /** Provided paths that could not be indexed (no existing entry, code not present). */
  unresolved: string[];
  /** Number of filelist files processed. */
  files: number;
}

/**
 * Reconcile every `sys/filelist*.win32.bin` under an unpacked game so the given
 * mod-added paths are indexed. Idempotent and reversible: each filelist's
 * pristine bytes are captured once under `backupDir` and every reconcile rebuilds
 * from that baseline, so a path no longer wanted is dropped automatically.
 */
export async function reconcileFilelist(opts: {
  whitePath: string;
  gameId: GameId;
  backupDir: string;
  /** virtual path -> on-disk loose size. */
  wanted: Map<string, number>;
}): Promise<FilelistReconcileResult> {
  const empty: FilelistReconcileResult = { repointed: 0, unresolved: [...opts.wanted.keys()], files: 0 };
  // Only safe in unpacked mode — editing a packed index without repacking
  // white_img would point entries at the wrong archive bytes.
  if (!(await exists(path.join(opts.whitePath, UNPACKED_MARKER)))) return empty;
  const game = getGameById(opts.gameId);
  if (!game) return empty;
  const gameCode = game.number as GameCode;

  const sysDir = path.join(opts.whitePath, 'sys');
  let names: string[];
  try {
    names = (await fs.readdir(sysDir)).filter((n) => /^filelist.*\.win32\.bin$/i.test(n));
  } catch {
    return empty;
  }

  let repointed = 0;
  const unresolved = new Set(opts.wanted.keys());
  for (const name of names) {
    const flPath = path.join(sysDir, name);
    const bkPath = path.join(opts.backupDir, name);
    const hasBackup = await exists(bkPath);
    // Rebuild from the pristine baseline: the backup if we've edited before,
    // else the live file (which is pristine until we first touch it).
    let fl: Filelist;
    try {
      fl = parseFilelist(await fs.readFile(hasBackup ? bkPath : flPath), gameCode);
    } catch {
      continue;
    }
    const res = registerPaths(fl, gameCode, opts.wanted);
    for (const p of res.resolved) unresolved.delete(p);
    if (res.repointed > 0) {
      if (!hasBackup) {
        await fs.mkdir(path.dirname(bkPath), { recursive: true });
        await fs.copyFile(flPath, bkPath); // capture pristine before the first edit
      }
      await fs.writeFile(flPath, buildFilelist(fl));
      repointed += res.repointed;
    } else if (hasBackup) {
      await fs.copyFile(bkPath, flPath); // previously edited, nothing wanted now -> restore
    }
  }
  return { repointed, unresolved: [...unresolved], files: names.length };
}
