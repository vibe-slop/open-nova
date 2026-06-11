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
import { injectIntoImgb, findHeaderPath, type ContainerInjection } from './texture-inject.js';

export type GameId = 'XIII' | 'XIII-2' | 'XIII-LR';

/** What a single enabled mod contributes, in priority order (low -> high). */
export interface ModProvider {
  modName: string;
  /** relative path under the game data root -> absolute source file path (loose overlay). */
  files: Map<string, string>;
  /** in-container texture injections this mod applies. */
  injections?: ContainerInjection[];
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
    // Paths touched last time: their current on-disk content is a MOD result,
    // not vanilla, so we must never capture them fresh as a "vanilla" backup.
    const previouslyTouched = new Set(Object.keys(ledger.files));

    // 1) Build the ordered op list per target path. Providers are already in
    //    priority order (low -> high), so a later op overrides/builds on earlier.
    type Op = { modName: string } & ({ kind: 'overlay'; source: string } | { kind: 'inject'; entryName: string; ddsPath: string });
    const opsByPath = new Map<string, Op[]>();
    const push = (rel: string, op: Op) => {
      const norm = rel.split(path.sep).join('/');
      (opsByPath.get(norm) ?? opsByPath.set(norm, []).get(norm)!).push(op);
    };
    for (const prov of providers) {
      for (const [rel, source] of prov.files) push(rel, { modName: prov.modName, kind: 'overlay', source });
      for (const inj of prov.injections ?? []) push(inj.containerRel, { modName: prov.modName, kind: 'inject', entryName: inj.entryName, ddsPath: inj.ddsPath });
    }
    const conflicts = [...opsByPath.entries()]
      .filter(([, ops]) => new Set(ops.map((o) => o.modName)).size > 1)
      .map(([p, ops]) => ({ path: p, winner: ops[ops.length - 1].modName, losers: ops.slice(0, -1).map((o) => o.modName) }));

    let deployed = 0;
    let restored = 0;

    // 2) Restore paths touched before but not any more (vanilla, then drop).
    for (const rel of previouslyTouched) {
      if (opsByPath.has(rel)) continue;
      const gameFile = path.join(whitePath, ...rel.split('/'));
      const backupFile = path.join(backupDir, ...rel.split('/'));
      if (await exists(backupFile)) {
        await copyFile(backupFile, gameFile);
        await fs.rm(backupFile, { force: true });
      } else if (await exists(gameFile)) {
        await fs.rm(gameFile, { force: true });
      }
      restored++;
    }

    // 3) For each touched path: capture vanilla once, reset to vanilla, then
    //    apply its ops in priority order (overlay replaces; inject modifies).
    for (const [rel, ops] of opsByPath) {
      const gameFile = path.join(whitePath, ...rel.split('/'));
      const backupFile = path.join(backupDir, ...rel.split('/'));
      const hadVanilla = await exists(backupFile);
      if (!previouslyTouched.has(rel) && !hadVanilla && (await exists(gameFile))) {
        await copyFile(gameFile, backupFile); // capture true vanilla once
      }
      // Reset to the vanilla baseline before re-applying (idempotent + correct on reorder).
      if (await exists(backupFile)) await copyFile(backupFile, gameFile);
      for (const op of ops) {
        if (op.kind === 'overlay') {
          await copyFile(op.source, gameFile);
        } else {
          const header = await findHeaderPath(gameFile);
          if (!header) continue; // container has no paired header (or not unpacked): skip
          const imgb = await fs.readFile(gameFile);
          const dds = await fs.readFile(op.ddsPath);
          await fs.writeFile(gameFile, injectIntoImgb(await fs.readFile(header.path), header.ext, imgb, op.entryName, dds));
        }
      }
      deployed++;
    }

    // 4) Persist the touched set (value = last contributor, for next-run vanilla logic).
    const newFiles: Record<string, string> = {};
    for (const [rel, ops] of opsByPath) newFiles[rel] = ops[ops.length - 1].modName;
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
