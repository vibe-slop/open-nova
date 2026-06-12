/**
 * ModLibrary — the high-level "everything automatic" API the app drives.
 *
 * A library mod is a staged folder under `Mods/<gameId>/<modName>/` containing
 * `content/` (the mod's files, however they were packaged) and `nova-mod.json`
 * (metadata + enabled flag + priority). The user only ever imports a mod and
 * toggles enabled; this class:
 *   - extracts/auto-detects arbitrary archives (zip/7z/rar/.ncmp) on import,
 *   - computes each enabled mod's provided files via {@link detectMod},
 *   - and reconciles the live game tree through the {@link Deployment} ledger
 *     (priority-based conflict resolution, reversible vanilla backups).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Deployment, type GameId, type ModProvider } from './deployment.js';
import { detectMod, type ModLayout } from './autodetect.js';
import { listContainerInjections } from './texture-inject.js';
import { reconcileFilelist } from './filelist-register.js';
import { listBuiltinFixes, fixGames } from './fixes.js';
import { extractArchive } from '../archive/extract.js';
import { extractNcmp } from './ncmp.js';

const META = 'nova-mod.json';
const CONTENT = 'content';

export type ModSource = 'local' | 'ncmp' | 'builtin';

export interface LibraryMod {
  /** Directory name under Mods/<gameId>/ (filesystem-safe). */
  modName: string;
  gameId: GameId;
  /** Display name. */
  name: string;
  source: ModSource;
  version: string;
  author: string;
  summary: string;
  pictureUrl?: string;
  layout: ModLayout;
  installable: boolean;
  enabled: boolean;
  /** Higher = wins conflicts (applied later). */
  priority: number;
  /** Note from auto-detection (e.g. why an installer mod isn't installable). */
  note: string;
  /** Always-on, always-first, cannot be disabled/removed/reordered (e.g. FF13 Fix). */
  locked: boolean;
}

export interface ImportMeta {
  name?: string;
  source?: ModSource;
  version?: string;
  author?: string;
  summary?: string;
  pictureUrl?: string;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 ._-]+/g, '_').replace(/\s+/g, ' ').trim() || 'mod';
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** DLLs that mark a Krisan-Thyme-style FF13 `.exe` patcher pack. */
const PATCHER_DLLS = ['whitebintools.dll', 'locatefile.dll', 'wpdtool.dll', 'imgblibrary.dll'];

/** True if the file begins with a local ZIP header (`PK\x03\x04`). */
async function looksLikeZip(p: string): Promise<boolean> {
  let fh: import('node:fs/promises').FileHandle | undefined;
  try {
    fh = await fs.open(p, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.readUInt32LE(0) === 0x04034b50;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Detect a Krisan-Thyme-style Windows `.exe` patcher (Leviathan's Tears, the
 * Console Content Patch, …): a `PatchData.bin` — itself a ZIP of the real
 * payload — shipped beside `FFXIII2*.exe` + `WhiteBinTools.dll`/`LocateFile.dll`.
 * The `.exe` only repacks the game archives on Windows; everything it would
 * apply lives inside PatchData.bin, so we can install it natively. Returns the
 * absolute path to the PatchData.bin ZIP, or null. Searches a few levels deep to
 * tolerate a wrapper folder.
 */
async function findPatcherPayload(dir: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
  const lower = fileNames.map((f) => f.toLowerCase());
  const payloadName = fileNames[lower.indexOf('patchdata.bin')];
  const hasSignature =
    lower.some((f) => f.endsWith('.exe')) || PATCHER_DLLS.some((d) => lower.includes(d));
  if (payloadName && hasSignature) {
    const p = path.join(dir, payloadName);
    if (await looksLikeZip(p)) return p;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findPatcherPayload(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find a nested `.ncmp` pack inside an extracted archive. A common distribution
 * pattern is a downloaded `.zip` that just wraps a single `.ncmp`; without this
 * the wrapper extracts to a lone `.ncmp` file that detectMod can't classify.
 * Returns the path to the first `.ncmp` found (depth-limited).
 */
async function findNestedNcmp(dir: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const ncmp = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.ncmp'));
  if (ncmp) return path.join(dir, ncmp.name);
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findNestedNcmp(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function moveContents(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(src)) {
    const from = path.join(src, e);
    const to = path.join(dest, e);
    try {
      await fs.rename(from, to);
    } catch {
      await fs.cp(from, to, { recursive: true });
      await fs.rm(from, { recursive: true, force: true });
    }
  }
}

export class ModLibrary {
  private readonly deployment: Deployment;

  constructor(private readonly basePath: string) {
    this.deployment = new Deployment(basePath);
  }

  modsDir(gameId: GameId): string {
    return path.join(this.basePath, 'Mods', gameId);
  }
  private tempDir(): string {
    return path.join(this.basePath, 'Mods', 'Temp');
  }
  private modDir(gameId: GameId, modName: string): string {
    return path.join(this.modsDir(gameId), modName);
  }

  /** Import a downloaded archive (zip/7z/rar/.ncmp): extract, auto-detect, stage. */
  async importArchive(gameId: GameId, archivePath: string, meta: ImportMeta = {}): Promise<LibraryMod> {
    await fs.mkdir(this.tempDir(), { recursive: true });
    const work = await fs.mkdtemp(path.join(this.tempDir(), 'imp-'));
    try {
      await extractArchive(archivePath, work);
      return await this.importExtracted(gameId, work, {
        name: meta.name ?? path.basename(archivePath).replace(/\.(zip|7z|rar|ncmp)$/i, ''),
        source: meta.source ?? 'local',
        ...meta,
      });
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  /** Stage an already-extracted directory as a library mod. */
  async importExtracted(gameId: GameId, extractedDir: string, meta: ImportMeta = {}): Promise<LibraryMod> {
    const name = meta.name ?? path.basename(extractedDir);

    // Unwrap nested payloads so detectMod sees the real mod tree, not a wrapper:
    //  - a `.ncmp` pack wrapped inside the downloaded archive (a common way mods
    //    are shared — a `.zip` that just contains a `.ncmp`), or
    //  - a Windows `.exe` patcher pack whose real payload is a sibling
    //    PatchData.bin ZIP.
    // detectMod re-classifies the unwrapped tree either way.
    const temps: string[] = [];
    let unwrapNote = '';

    const nestedNcmp = await findNestedNcmp(extractedDir);
    if (nestedNcmp) {
      await fs.mkdir(this.tempDir(), { recursive: true });
      const tmp = await fs.mkdtemp(path.join(this.tempDir(), 'ncmp-'));
      try {
        await extractNcmp(nestedNcmp, tmp);
        extractedDir = tmp;
        temps.push(tmp);
        unwrapNote = 'Unwrapped a bundled .ncmp pack. ';
      } catch {
        await fs.rm(tmp, { recursive: true, force: true }); // not a usable pack — detect as-is
      }
    }

    const payload = await findPatcherPayload(extractedDir);
    if (payload) {
      await fs.mkdir(this.tempDir(), { recursive: true });
      const tmp = await fs.mkdtemp(path.join(this.tempDir(), 'unwrap-'));
      try {
        await extractNcmp(payload, tmp);
        extractedDir = tmp;
        temps.push(tmp);
        unwrapNote = 'Unwrapped from a Windows patcher (PatchData.bin). ';
      } catch {
        await fs.rm(tmp, { recursive: true, force: true }); // not a usable ZIP — detect as-is
      }
    }

    try {
      const detected = await detectMod(extractedDir);
      // Pick a unique library key so importing a second mod with the same name
      // doesn't silently clobber the first; disambiguate the display name too.
      const baseName = safeName(name);
      let modName = baseName;
      let displayName = name;
      for (let n = 2; await exists(this.modDir(gameId, modName)); n++) {
        modName = `${baseName}-${n}`;
        displayName = `${name} (${n})`;
      }
      const dir = this.modDir(gameId, modName);
      await fs.mkdir(dir, { recursive: true });
      // Move the detected content root into content/.
      await moveContents(detected.contentRoot, path.join(dir, CONTENT));

      const enabledMods = (await this.list(gameId)).filter((m) => m.enabled);
      const maxPriority = enabledMods.reduce((m, x) => Math.max(m, x.priority), 0);

      const mod: LibraryMod = {
        modName,
        gameId,
        name: displayName,
        source: meta.source ?? 'local',
        version: meta.version ?? '',
        author: meta.author ?? '',
        summary: meta.summary ?? '',
        pictureUrl: meta.pictureUrl,
        layout: detected.layout,
        installable: detected.installable,
        enabled: false,
        priority: maxPriority + 1,
        note: unwrapNote ? `${unwrapNote}${detected.note}` : detected.note,
        locked: false,
      };
      await this.writeMeta(mod);
      return mod;
    } finally {
      for (const t of temps) await fs.rm(t, { recursive: true, force: true });
    }
  }

  async list(gameId: GameId): Promise<LibraryMod[]> {
    const root = this.modsDir(gameId);
    if (!(await exists(root))) return [];
    const out: LibraryMod[] = [];
    for (const e of await fs.readdir(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'Temp') continue;
      const metaPath = path.join(root, e.name, META);
      if (!(await exists(metaPath))) continue;
      try {
        out.push(JSON.parse(await fs.readFile(metaPath, 'utf8')) as LibraryMod);
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => a.priority - b.priority);
  }

  /** Enable or disable a mod, then reconcile the game tree. */
  async setEnabled(gameId: GameId, modName: string, enabled: boolean, whitePath: string): Promise<void> {
    const mod = await this.readMeta(gameId, modName);
    if (!mod) throw new Error(`mod not found: ${modName}`);
    if (enabled && !mod.installable) throw new Error(`mod "${mod.name}" is not auto-installable: ${mod.note}`);
    mod.enabled = enabled;
    await this.writeMeta(mod);
    await this.reconcile(gameId, whitePath);
  }

  /** Set the conflict-resolution order (array of modNames, low -> high priority). */
  async setOrder(gameId: GameId, orderedModNames: string[], whitePath: string): Promise<void> {
    const mods = await this.list(gameId);
    const rank = new Map(orderedModNames.map((n, i) => [n, i + 1]));
    for (const m of mods) {
      if (m.locked) {
        if (m.priority !== 0) { m.priority = 0; await this.writeMeta(m); } // pinned first
        continue;
      }
      const r = rank.get(m.modName);
      if (r !== undefined && r !== m.priority) {
        m.priority = r;
        await this.writeMeta(m);
      }
    }
    await this.reconcile(gameId, whitePath);
  }

  async remove(gameId: GameId, modName: string, whitePath: string): Promise<void> {
    const mod = await this.readMeta(gameId, modName);
    if (mod?.locked) throw new Error(`"${mod.name}" is required and can't be removed.`);
    if (mod?.enabled) {
      mod.enabled = false;
      await this.writeMeta(mod);
      await this.reconcile(gameId, whitePath);
    }
    await fs.rm(this.modDir(gameId, modName), { recursive: true, force: true });
  }

  /**
   * Ensure the bundled built-in fixes appear in the library as mods. Entries are
   * keyed by the fix **id** (rename-safe), and a fix can target several games via
   * its `games` list. Behaviour by kind:
   *   - normal fix  — staged once, disabled by default; the user's enable/order is
   *     then left alone (idempotent skip on re-sync).
   *   - locked fix  — re-synced every call to stay pinned priority 0 (first) and
   *     pick up renames; it can be toggled on/off (choice preserved) but not
   *     reordered or removed. Defaults on for new installs (fix.defaultEnabled).
   * Old name-keyed builtin entries (from before id-keying / a rename) are removed.
   */
  async syncBuiltinFixes(gameId: GameId): Promise<void> {
    const fixes = await listBuiltinFixes();
    const existing = await this.list(gameId);
    let priority = existing.reduce((m, x) => Math.max(m, x.priority), 0);

    for (const fix of fixes) {
      if (!fixGames(fix).includes(gameId)) continue;
      const modName = safeName(fix.id);
      const prior = existing.find((m) => m.modName === modName);
      const locked = fix.locked ?? false;
      if (prior && !locked) continue; // staged already — respect the user's choices

      const dir = this.modDir(gameId, modName);
      if (!(await exists(path.join(dir, CONTENT)))) {
        await fs.mkdir(path.join(dir, CONTENT), { recursive: true });
        await fs.cp(path.join(fix.dir, fix.payload), path.join(dir, CONTENT), { recursive: true });
      }
      const detected = await detectMod(path.join(dir, CONTENT));
      await this.writeMeta({
        modName,
        gameId,
        name: fix.name,
        source: 'builtin',
        version: '1.3',
        author: fix.author ?? 'Krisan Thyme',
        summary: fix.summary,
        layout: detected.layout,
        installable: detected.installable,
        // Locked fixes re-sync every call (to re-pin priority 0 + apply renames),
        // so enabled MUST come from the persisted choice — never force it on, or
        // the user could never keep it off. Defaults on for new installs.
        enabled: prior?.enabled ?? fix.defaultEnabled ?? false,
        priority: locked ? 0 : prior?.priority ?? ++priority,
        note: fix.credit,
        locked,
      });
    }

    // Drop stale builtin entries left behind by a rename / the old name-keyed
    // scheme. Built-in dirs are fully owned by us, so this is safe; their loose
    // files (if any were deployed) revert on the next reconcile.
    const validNames = new Set(fixes.map((f) => safeName(f.id)));
    for (const m of existing) {
      if (m.source === 'builtin' && !validNames.has(m.modName)) {
        await fs.rm(this.modDir(gameId, m.modName), { recursive: true, force: true });
      }
    }
  }

  /** Re-deploy the game tree to match the currently-enabled mods. */
  async reconcile(gameId: GameId, whitePath: string): Promise<void> {
    const enabled = (await this.list(gameId)).filter((m) => m.enabled).sort((a, b) => a.priority - b.priority);
    const providers: ModProvider[] = [];
    for (const m of enabled) {
      const content = path.join(this.modDir(gameId, m.modName), CONTENT);
      try {
        const detected = await detectMod(content);
        const injections = await listContainerInjections(content);
        providers.push({ modName: m.modName, files: detected.files, injections });
      } catch (err) {
        // A mod whose staged content is missing/unreadable must not break the
        // whole deploy — skip it and keep applying the rest.
        console.warn(`[open-nova] skipping mod "${m.modName}" (content unreadable): ${(err as Error).message}`);
      }
    }
    await this.deployment.reconcile(gameId, whitePath, providers);

    // Register any ADDED files (e.g. restored DLC characters) into the live
    // filelist so the engine can resolve them in unpacked mode. The index code
    // is computed from each path, so this is generic — replacements are skipped
    // (their entry already exists) and the edit is reversible.
    const wanted = new Map<string, number>();
    for (const p of providers) {
      for (const rel of p.files.keys()) {
        const dest = path.join(whitePath, ...rel.split('/'));
        try {
          wanted.set(rel, (await fs.stat(dest)).size);
        } catch {
          /* not deployed (skipped/conflict) — ignore */
        }
      }
    }
    await reconcileFilelist({
      gameId,
      whitePath,
      backupDir: path.join(this.basePath, 'FilelistBackup', gameId),
      wanted,
    });
  }

  /**
   * Tear down EVERYTHING this tool deployed, returning the game tree to vanilla:
   * restore every mod-overlaid / injected file from the deployment ledger (by
   * reconciling to zero providers) and restore each edited filelist from its
   * backup. Leaves mod metadata intact (mods stay staged/enabled in the library);
   * this only reverts the on-disk game files. Used by the app's "Restore" path.
   */
  async revertToVanilla(gameId: GameId, whitePath: string): Promise<void> {
    await this.deployment.reconcile(gameId, whitePath, []);
    await reconcileFilelist({
      gameId,
      whitePath,
      backupDir: path.join(this.basePath, 'FilelistBackup', gameId),
      wanted: new Map(),
    });
  }

  private async readMeta(gameId: GameId, modName: string): Promise<LibraryMod | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.modDir(gameId, modName), META), 'utf8')) as LibraryMod;
    } catch {
      return null;
    }
  }
  private async writeMeta(mod: LibraryMod): Promise<void> {
    const p = path.join(this.modDir(mod.gameId, mod.modName), META);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(mod, null, 2), 'utf8');
  }
}
