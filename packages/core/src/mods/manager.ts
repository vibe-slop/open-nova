/**
 * Mod manager — the install / uninstall / import / generate model for `.ncmp`
 * ModPacks.
 *
 * No database is tracked: state lives entirely in each mod's `modconfig.ini`
 * flags plus a per-game `Backup/` folder. Fully cross-platform (pure `fs` +
 * `path.join`, no Windows separators or APIs).
 *
 * Directory model (rooted at a configurable `basePath`, e.g. Electron's
 * `app.getPath('userData')`):
 *
 *   <basePath>/
 *     Mods/<gameId>/<modName>/   imported, extracted ModPacks
 *     Mods/Temp/                 scratch space for imports
 *     Backup/<gameId>/<rel>      originals saved before first overwrite
 *     Patches/<gameId>/          Code/*.nccp runtime patches
 *
 * `gameId` is the human id (`'XIII' | 'XIII-2' | 'XIII-LR'`); the manifest's
 * `GameEntry` field is the numeric `'1' | '2' | '3'`.
 *
 * INSTALL: walk `Data/` (and `EN-Data/` / `JP-Data/` per flags); for each file
 * the target is `<whitePath>/<relUnderData>`. BEFORE overwriting, copy the
 * existing original into `Backup/<gameId>/<rel>` — only if no backup exists yet
 * AND the original is present. Then copy the mod file over.
 *
 * UNINSTALL: for each touched file, restore from `Backup/` if present, else
 * delete. Per-mod state is recorded back into the mod's `modconfig.ini`
 * (`Installed` / `ENInstalled` / `JPInstalled`).
 *
 * NOTE (DEFERRED): files that live INSIDE a packed WPD container (`.bin/.wpd/
 * etc.`, detected via `_`-prefixed folder names in the unpacked tree) need a
 * container unpack/repack path. That is intentionally NOT done here —
 * loose-file overlay covers most mods for the MVP. See the
 * `TODO(wpd)` below.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Ini } from './ini.js';
import { extractNcmp, createNcmp } from './ncmp.js';

/** Human-readable game identifier used for on-disk folder names. */
export type GameId = 'XIII' | 'XIII-2' | 'XIII-LR';
/** Numeric `GameEntry` value stored in `modconfig.ini`. */
export type GameEntry = '1' | '2' | '3';

const CONFIG_SECTION = 'ModPackConfig';
/** Deliberately MISSPELLED — the on-disk section name the format expects. */
const STATE_SECTION = 'NovaChysaliaConfig';
const MODCONFIG = 'modconfig.ini';

const DATA_DIR = 'Data';
const EN_DATA_DIR = 'EN-Data';
const JP_DATA_DIR = 'JP-Data';
const EXTERNAL_DIR = 'External';
const CODE_DIR = 'Code';

/** Map a numeric `GameEntry` to its folder `GameId`. */
export function gameEntryToId(entry: GameEntry | string): GameId {
  switch (String(entry)) {
    case '1':
      return 'XIII';
    case '2':
      return 'XIII-2';
    case '3':
      return 'XIII-LR';
    default:
      throw new Error(`unknown GameEntry "${entry}" (expected 1|2|3)`);
  }
}

/** Map a folder `GameId` back to its numeric `GameEntry`. */
export function gameIdToEntry(id: GameId): GameEntry {
  switch (id) {
    case 'XIII':
      return '1';
    case 'XIII-2':
      return '2';
    case 'XIII-LR':
      return '3';
    default:
      throw new Error(`unknown GameId "${id}"`);
  }
}

/** Summary of an installed/imported ModPack. */
export interface ModInfo {
  /** Directory name under `Mods/<gameId>/`. */
  modName: string;
  /** Manifest `Name`. */
  name: string;
  gameId: GameId;
  gameEntry: GameEntry;
  version: string;
  author: string;
  summary: string;
  installed: boolean;
  enInstalled: boolean;
  jpInstalled: boolean;
  /** Absolute path to the extracted mod directory. */
  modDir: string;
  /** Whether each overlay tree is present in the pack. */
  hasData: boolean;
  hasEnData: boolean;
  hasJpData: boolean;
  hasCode: boolean;
  hasExternal: boolean;
}

/** Options controlling which overlay trees an install/uninstall touches. */
export interface InstallOptions {
  /** Apply `Data/` (default true). */
  data?: boolean;
  /** Apply `EN-Data/` (default false). */
  en?: boolean;
  /** Apply `JP-Data/` (default false). */
  jp?: boolean;
}

/** Specification for {@link ModManager.generateModPack}. */
export interface ModPackSpec {
  name: string;
  gameEntry: GameEntry;
  version?: string;
  author?: string;
  summary?: string;
  /** Optional presentation assets (manifest field names). */
  image?: string;
  preview?: string;
  banner?: string;
  readme?: string;
  /** Files to place under `Data/` (key = relative path, value = bytes). */
  data?: Record<string, Buffer | Uint8Array>;
  /** Files to place under `EN-Data/`. */
  enData?: Record<string, Buffer | Uint8Array>;
  /** Files to place under `JP-Data/`. */
  jpData?: Record<string, Buffer | Uint8Array>;
  /** Files to place under `External/` (legacy Windows install scripts). */
  external?: Record<string, Buffer | Uint8Array>;
  /** Files to place under `Code/` (runtime `.nccp` patches). */
  code?: Record<string, Buffer | Uint8Array>;
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list files under `dir` relative to it; [] if `dir` is missing. */
async function walkRel(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) out.push(path.relative(dir, full));
    }
  }
  await rec(dir);
  return out;
}

/** Copy a file, creating the destination directory tree first. */
async function copyFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

/** Move a directory; falls back to copy+remove across filesystem boundaries. */
async function moveDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (await pathExists(dest)) await fs.rm(dest, { recursive: true, force: true });
  try {
    await fs.rename(src, dest);
  } catch {
    await fs.cp(src, dest, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ModManager
// ---------------------------------------------------------------------------

/** Mod manager bound to a single `basePath` (the app's writable data root). */
export class ModManager {
  constructor(private readonly basePath: string) {}

  /** `<basePath>/Mods` */
  get modsRoot(): string {
    return path.join(this.basePath, 'Mods');
  }
  /** `<basePath>/Mods/Temp` */
  get tempRoot(): string {
    return path.join(this.modsRoot, 'Temp');
  }
  /** `<basePath>/Mods/<gameId>` */
  modsDir(gameId: GameId): string {
    return path.join(this.modsRoot, gameId);
  }
  /** `<basePath>/Backup/<gameId>` */
  backupDir(gameId: GameId): string {
    return path.join(this.basePath, 'Backup', gameId);
  }
  /** `<basePath>/Patches/<gameId>` */
  patchesDir(gameId: GameId): string {
    return path.join(this.basePath, 'Patches', gameId);
  }

  /**
   * Import a `.ncmp`: extract to a temp folder, read `Name` + `GameEntry` from
   * its `modconfig.ini`, then move it into `Mods/<gameId>/<Name>`. Returns the
   * resulting {@link ModInfo}.
   */
  async importModPack(ncmpPath: string): Promise<ModInfo> {
    await fs.mkdir(this.tempRoot, { recursive: true });
    const scratch = await fs.mkdtemp(path.join(this.tempRoot, 'import-'));
    try {
      await extractNcmp(ncmpPath, scratch);

      const cfgPath = path.join(scratch, MODCONFIG);
      if (!(await pathExists(cfgPath))) {
        throw new Error(`ModPack is missing ${MODCONFIG}`);
      }
      const ini = await Ini.readFile(cfgPath);
      const name = ini.get(CONFIG_SECTION, 'Name');
      const entry = ini.get(CONFIG_SECTION, 'GameEntry');
      if (!name || !entry) {
        throw new Error(`${MODCONFIG} missing Name or GameEntry`);
      }
      const gameId = gameEntryToId(entry);
      const modName = sanitizeName(name);
      const dest = path.join(this.modsDir(gameId), modName);

      await moveDir(scratch, dest);
      return await this.readModInfo(gameId, modName);
    } finally {
      // moveDir already removed scratch on success; clean up on failure.
      if (await pathExists(scratch)) await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  /** List every imported mod across all three games. */
  async listMods(): Promise<ModInfo[]> {
    const ids: GameId[] = ['XIII', 'XIII-2', 'XIII-LR'];
    const out: ModInfo[] = [];
    for (const gameId of ids) {
      const dir = this.modsDir(gameId);
      if (!(await pathExists(dir))) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const cfg = path.join(dir, e.name, MODCONFIG);
        if (!(await pathExists(cfg))) continue;
        out.push(await this.readModInfo(gameId, e.name));
      }
    }
    return out;
  }

  /** Read a single mod's {@link ModInfo} from its on-disk `modconfig.ini`. */
  async readModInfo(gameId: GameId, modName: string): Promise<ModInfo> {
    const modDir = path.join(this.modsDir(gameId), modName);
    const ini = await Ini.readFile(path.join(modDir, MODCONFIG));
    return {
      modName,
      name: ini.getOr(CONFIG_SECTION, 'Name', modName),
      gameId,
      gameEntry: gameIdToEntry(gameId),
      version: ini.getOr(CONFIG_SECTION, 'Version', ''),
      author: ini.getOr(CONFIG_SECTION, 'Author', ''),
      summary: ini.getOr(CONFIG_SECTION, 'Summary', ''),
      installed: ini.getBool(STATE_SECTION, 'Installed'),
      enInstalled: ini.getBool(STATE_SECTION, 'ENInstalled'),
      jpInstalled: ini.getBool(STATE_SECTION, 'JPInstalled'),
      modDir,
      hasData: await pathExists(path.join(modDir, DATA_DIR)),
      hasEnData: await pathExists(path.join(modDir, EN_DATA_DIR)),
      hasJpData: await pathExists(path.join(modDir, JP_DATA_DIR)),
      hasCode: await pathExists(path.join(modDir, CODE_DIR)),
      hasExternal: await pathExists(path.join(modDir, EXTERNAL_DIR)),
    };
  }

  /**
   * Install a mod onto the unpacked game tree rooted at `whitePath`. Backs up
   * each original (once) before overwriting, copies `Code/*.nccp` into
   * `Patches/<gameId>/`, and records the per-tree state flags back into the
   * mod's `modconfig.ini`.
   */
  async installMod(modName: string, whitePath: string, opts: InstallOptions = {}): Promise<void> {
    const { gameId, modDir, ini } = await this.openMod(modName);
    const wantData = opts.data ?? true;
    const wantEn = opts.en ?? false;
    const wantJp = opts.jp ?? false;

    if (wantData) {
      await this.applyOverlay(path.join(modDir, DATA_DIR), whitePath, gameId);
      ini.setBool(STATE_SECTION, 'Installed', true);
    }
    if (wantEn) {
      await this.applyOverlay(path.join(modDir, EN_DATA_DIR), whitePath, gameId);
      ini.setBool(STATE_SECTION, 'ENInstalled', true);
    }
    if (wantJp) {
      await this.applyOverlay(path.join(modDir, JP_DATA_DIR), whitePath, gameId);
      ini.setBool(STATE_SECTION, 'JPInstalled', true);
    }

    // Copy Code/*.nccp runtime patches into Patches/<gameId>/ (idempotent).
    const codeDir = path.join(modDir, CODE_DIR);
    for (const rel of await walkRel(codeDir)) {
      await copyFile(path.join(codeDir, rel), path.join(this.patchesDir(gameId), rel));
    }

    await ini.writeFile(path.join(modDir, MODCONFIG));
  }

  /**
   * Uninstall a mod: for each file the mod touched, restore the backed-up
   * original if one exists, otherwise delete the file the mod added. Clears the
   * corresponding state flags.
   */
  async uninstallMod(modName: string, whitePath: string, opts: InstallOptions = {}): Promise<void> {
    const { gameId, modDir, ini } = await this.openMod(modName);
    const wantData = opts.data ?? true;
    const wantEn = opts.en ?? false;
    const wantJp = opts.jp ?? false;

    if (wantData) {
      await this.revertOverlay(path.join(modDir, DATA_DIR), whitePath, gameId);
      ini.setBool(STATE_SECTION, 'Installed', false);
    }
    if (wantEn) {
      await this.revertOverlay(path.join(modDir, EN_DATA_DIR), whitePath, gameId);
      ini.setBool(STATE_SECTION, 'ENInstalled', false);
    }
    if (wantJp) {
      await this.revertOverlay(path.join(modDir, JP_DATA_DIR), whitePath, gameId);
      ini.setBool(STATE_SECTION, 'JPInstalled', false);
    }

    await ini.writeFile(path.join(modDir, MODCONFIG));
  }

  /**
   * Generate a `.ncmp` ModPack from a {@link ModPackSpec}: lays out
   * `Data/`/`EN-Data/`/`JP-Data/`/`External/`/`Code/`, writes a byte-compatible
   * `modconfig.ini`, then zips the staging folder to `ncmpPath`.
   *
   * TODO(wpd): repacking files INTO an existing WPD/TRB container is deferred;
   * this only stages loose overlay files, which is sufficient for most mods.
   */
  async generateModPack(spec: ModPackSpec, ncmpPath: string): Promise<void> {
    await fs.mkdir(this.tempRoot, { recursive: true });
    const stage = await fs.mkdtemp(path.join(this.tempRoot, 'gen-'));
    try {
      await this.writeTree(path.join(stage, DATA_DIR), spec.data);
      await this.writeTree(path.join(stage, EN_DATA_DIR), spec.enData);
      await this.writeTree(path.join(stage, JP_DATA_DIR), spec.jpData);
      await this.writeTree(path.join(stage, EXTERNAL_DIR), spec.external);
      await this.writeTree(path.join(stage, CODE_DIR), spec.code);

      const ini = new Ini();
      ini.set(CONFIG_SECTION, 'Name', spec.name);
      ini.set(CONFIG_SECTION, 'Version', spec.version ?? '1.0');
      ini.set(CONFIG_SECTION, 'Author', spec.author ?? '');
      ini.set(CONFIG_SECTION, 'GameEntry', spec.gameEntry);
      ini.set(CONFIG_SECTION, 'Summary', spec.summary ?? '');
      ini.set(CONFIG_SECTION, 'Image', spec.image ?? '');
      ini.set(CONFIG_SECTION, 'Preview', spec.preview ?? '');
      ini.set(CONFIG_SECTION, 'Banner', spec.banner ?? '');
      ini.set(CONFIG_SECTION, 'Readme', spec.readme ?? '');
      // Misspelled state section name, as the format requires.
      ini.setBool(STATE_SECTION, 'DataPatch', !!spec.data && Object.keys(spec.data).length > 0);
      ini.setBool(STATE_SECTION, 'ENPatch', !!spec.enData && Object.keys(spec.enData).length > 0);
      ini.setBool(STATE_SECTION, 'JPPatch', !!spec.jpData && Object.keys(spec.jpData).length > 0);
      ini.setBool(STATE_SECTION, 'ExtPatch', !!spec.external && Object.keys(spec.external).length > 0);
      ini.setBool(STATE_SECTION, 'CodePatch', !!spec.code && Object.keys(spec.code).length > 0);
      ini.setBool(STATE_SECTION, 'Installed', false);
      ini.setBool(STATE_SECTION, 'ENInstalled', false);
      ini.setBool(STATE_SECTION, 'JPInstalled', false);
      await ini.writeFile(path.join(stage, MODCONFIG));

      await createNcmp(stage, ncmpPath);
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Resolve a mod by name across the three games and open its INI. */
  private async openMod(modName: string): Promise<{ gameId: GameId; modDir: string; ini: Ini }> {
    const ids: GameId[] = ['XIII', 'XIII-2', 'XIII-LR'];
    for (const gameId of ids) {
      const modDir = path.join(this.modsDir(gameId), modName);
      const cfg = path.join(modDir, MODCONFIG);
      if (await pathExists(cfg)) {
        return { gameId, modDir, ini: await Ini.readFile(cfg) };
      }
    }
    throw new Error(`mod "${modName}" not found under any game's Mods directory`);
  }

  /**
   * Overlay every file from `overlayDir` onto `whitePath`, backing up each
   * pre-existing original (once) into `Backup/<gameId>/<rel>` first.
   *
   * TODO(wpd): if `rel` descends into an `_`-prefixed container folder, the
   * surrounding WPD must be unpacked/repacked via `!!WPD_Records.txt`. That
   * path is not implemented; such files are copied as loose overlays, which is
   * correct only for already-unpacked containers.
   */
  private async applyOverlay(overlayDir: string, whitePath: string, gameId: GameId): Promise<void> {
    const backupRoot = this.backupDir(gameId);
    for (const rel of await walkRel(overlayDir)) {
      const target = path.join(whitePath, rel);
      const backup = path.join(backupRoot, rel);
      // Back up the original ONCE, only if it exists and no backup exists yet.
      if ((await pathExists(target)) && !(await pathExists(backup))) {
        await copyFile(target, backup);
      }
      await copyFile(path.join(overlayDir, rel), target);
    }
  }

  /**
   * Reverse an overlay: restore each touched file from `Backup/<gameId>/` if a
   * backup exists, else delete the file the mod added.
   */
  private async revertOverlay(overlayDir: string, whitePath: string, gameId: GameId): Promise<void> {
    const backupRoot = this.backupDir(gameId);
    for (const rel of await walkRel(overlayDir)) {
      const target = path.join(whitePath, rel);
      const backup = path.join(backupRoot, rel);
      if (await pathExists(backup)) {
        await copyFile(backup, target);
        await fs.rm(backup, { force: true });
      } else if (await pathExists(target)) {
        await fs.rm(target, { force: true });
      }
    }
  }

  /** Write a map of relative-path→bytes under `root` (skips an empty/undefined map). */
  private async writeTree(root: string, files?: Record<string, Buffer | Uint8Array>): Promise<void> {
    if (!files) return;
    const keys = Object.keys(files);
    if (keys.length === 0) return;
    for (const rel of keys) {
      const dest = path.join(root, ...rel.split(/[\\/]/));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from(files[rel]));
    }
  }
}

/** Sanitize a manifest Name into a safe single-segment folder name. */
function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'mod';
}
