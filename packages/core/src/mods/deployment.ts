/**
 * Deployment ledger — the engine behind "enable/disable, everything automatic".
 *
 * Instead of per-mod install/uninstall (which corrupts overlapping mods — the
 * backup only captures the first overwrite), this maintains a single source of
 * truth per game and RECONCILES the live game tree to match the set of enabled
 * mods in priority order:
 *
 *   - Each enabled mod "provides" a set of relative paths -> source files.
 *   - When several enabled mods provide the same path, the highest-priority one
 *     wins (later in the order = higher priority).
 *   - The first time any mod overlays a path, the VANILLA original is backed up
 *     once (shared across mods). When no enabled mod provides a path any more,
 *     the vanilla file is restored (or the added file deleted) and the backup
 *     removed.
 *
 * Enable, disable, and reorder are all just "recompute desired state and
 * reconcile" — so the UI only ever toggles flags and calls reconcile().
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type GameId = 'XIII' | 'XIII-2' | 'XIII-LR';

/** What a single enabled mod contributes, in priority order (low -> high). */
export interface ModProvider {
  modName: string;
  /** relative path under the game data root -> absolute source file path. */
  files: Map<string, string>;
}

interface Ledger {
  version: 1;
  /** relative path -> the modName that currently owns the deployed file. */
  files: Record<string, string>;
}

export interface ReconcileResult {
  deployed: number;
  restored: number;
  conflicts: { path: string; winner: string; losers: string[] }[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

export class Deployment {
  constructor(private readonly basePath: string) {}

  private ledgerPath(gameId: GameId): string {
    return path.join(this.basePath, 'Deploy', `${gameId}.json`);
  }

  private backupDir(gameId: GameId): string {
    return path.join(this.basePath, 'Backup', gameId);
  }

  async loadLedger(gameId: GameId): Promise<Ledger> {
    try {
      const j = JSON.parse(await fs.readFile(this.ledgerPath(gameId), 'utf8'));
      if (j && j.version === 1 && j.files) return j as Ledger;
    } catch {
      /* fall through */
    }
    return { version: 1, files: {} };
  }

  private async saveLedger(gameId: GameId, ledger: Ledger): Promise<void> {
    const p = this.ledgerPath(gameId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(ledger, null, 2), 'utf8');
  }

  /**
   * Reconcile the live game tree (`whitePath` = the unpacked data root) to the
   * given ordered set of enabled mod providers. Idempotent: calling it twice
   * with the same input is a no-op.
   */
  async reconcile(gameId: GameId, whitePath: string, providers: ModProvider[]): Promise<ReconcileResult> {
    const ledger = await this.loadLedger(gameId);
    const backupDir = this.backupDir(gameId);
    // Paths we deployed last time: their current on-disk content is a MOD file,
    // not vanilla, so we must never capture them as a "vanilla" backup.
    const previouslyOwned = new Set(Object.keys(ledger.files));

    // 1) Desired ownership: last provider wins; track conflicts for reporting.
    const desired = new Map<string, { modName: string; source: string }>();
    const contenders = new Map<string, string[]>();
    for (const prov of providers) {
      for (const [rel, source] of prov.files) {
        const norm = rel.split(path.sep).join('/');
        desired.set(norm, { modName: prov.modName, source });
        (contenders.get(norm) ?? contenders.set(norm, []).get(norm)!).push(prov.modName);
      }
    }
    const conflicts = [...contenders.entries()]
      .filter(([, mods]) => mods.length > 1)
      .map(([p, mods]) => ({ path: p, winner: mods[mods.length - 1], losers: mods.slice(0, -1) }));

    let deployed = 0;
    let restored = 0;

    // 2) Deploy desired files (capturing vanilla backup once per path).
    for (const [rel, { source }] of desired) {
      const gameFile = path.join(whitePath, ...rel.split('/'));
      const backupFile = path.join(backupDir, ...rel.split('/'));
      if (!previouslyOwned.has(rel) && !(await exists(backupFile)) && (await exists(gameFile))) {
        await copyFile(gameFile, backupFile); // capture vanilla once, on genuine first overlay
      }
      await copyFile(source, gameFile);
      deployed++;
    }

    // 3) Restore paths that were deployed before but are no longer desired.
    for (const rel of Object.keys(ledger.files)) {
      if (desired.has(rel)) continue;
      const gameFile = path.join(whitePath, ...rel.split('/'));
      const backupFile = path.join(backupDir, ...rel.split('/'));
      if (await exists(backupFile)) {
        await copyFile(backupFile, gameFile); // restore vanilla
        await fs.rm(backupFile, { force: true });
      } else if (await exists(gameFile)) {
        await fs.rm(gameFile, { force: true }); // mod-added file: remove
      }
      restored++;
    }

    // 4) Persist new ownership map.
    const newFiles: Record<string, string> = {};
    for (const [rel, { modName }] of desired) newFiles[rel] = modName;
    await this.saveLedger(gameId, { version: 1, files: newFiles });

    return { deployed, restored, conflicts };
  }
}

/**
 * Build a {@link ModProvider.files} map by walking a mod's overlay folders
 * (`Data/`, optionally `EN-Data/`/`JP-Data/`). Later folders override earlier
 * ones within the same mod.
 */
export async function collectModFiles(
  modDir: string,
  opts: { en?: boolean; jp?: boolean } = {},
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const folders = ['Data'];
  if (opts.en) folders.push('EN-Data');
  if (opts.jp) folders.push('JP-Data');
  for (const folder of folders) {
    const root = path.join(modDir, folder);
    if (!(await exists(root))) continue;
    await walk(root, root, files);
  }
  return files;
}

async function walk(root: string, dir: string, out: Map<string, string>): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else if (e.isFile()) out.set(path.relative(root, full).split(path.sep).join('/'), full);
  }
}
