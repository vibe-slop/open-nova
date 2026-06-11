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
import { listBuiltinFixes } from './fixes.js';
import { extractArchive } from '../archive/extract.js';

const META = 'nova-mod.json';
const CONTENT = 'content';

export type ModSource = 'nexus' | 'local' | 'ncmp' | 'builtin';

export interface NexusRef {
  domain: string;
  modId: number;
  fileId: number;
}

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
  nexus?: NexusRef;
  layout: ModLayout;
  installable: boolean;
  enabled: boolean;
  /** Higher = wins conflicts (applied later). */
  priority: number;
  /** Note from auto-detection (e.g. why an installer mod isn't installable). */
  note: string;
}

export interface ImportMeta {
  name?: string;
  source?: ModSource;
  version?: string;
  author?: string;
  summary?: string;
  pictureUrl?: string;
  nexus?: NexusRef;
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
    const detected = await detectMod(extractedDir);
    const name = meta.name ?? path.basename(extractedDir);
    const modName = safeName(name);
    const dir = this.modDir(gameId, modName);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    // Move the detected content root into content/.
    await moveContents(detected.contentRoot, path.join(dir, CONTENT));

    const enabledMods = (await this.list(gameId)).filter((m) => m.enabled);
    const maxPriority = enabledMods.reduce((m, x) => Math.max(m, x.priority), 0);

    const mod: LibraryMod = {
      modName,
      gameId,
      name,
      source: meta.source ?? 'local',
      version: meta.version ?? '',
      author: meta.author ?? '',
      summary: meta.summary ?? '',
      pictureUrl: meta.pictureUrl,
      nexus: meta.nexus,
      layout: detected.layout,
      installable: detected.installable,
      enabled: false,
      priority: maxPriority + 1,
      note: detected.note,
    };
    await this.writeMeta(mod);
    return mod;
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
    if (mod?.enabled) {
      mod.enabled = false;
      await this.writeMeta(mod);
      await this.reconcile(gameId, whitePath);
    }
    await fs.rm(this.modDir(gameId, modName), { recursive: true, force: true });
  }

  /**
   * Ensure the bundled built-in fixes (e.g. the rain-translucency fix) appear in
   * the library as normal mods — disabled by default, re-orderable like any
   * other. Idempotent: skips fixes already present.
   */
  async syncBuiltinFixes(gameId: GameId): Promise<void> {
    const existing = await this.list(gameId);
    let priority = existing.reduce((m, x) => Math.max(m, x.priority), 0);
    for (const fix of await listBuiltinFixes()) {
      if (fix.game !== gameId) continue;
      const modName = safeName(fix.name);
      if (existing.some((m) => m.modName === modName)) continue;
      const dir = this.modDir(gameId, modName);
      await fs.mkdir(path.join(dir, CONTENT), { recursive: true });
      await fs.cp(path.join(fix.dir, fix.payload), path.join(dir, CONTENT), { recursive: true });
      const detected = await detectMod(path.join(dir, CONTENT));
      await this.writeMeta({
        modName,
        gameId,
        name: fix.name,
        source: 'builtin',
        version: '1.3',
        author: 'Krisan Thyme',
        summary: fix.summary,
        layout: detected.layout,
        installable: detected.installable,
        enabled: fix.defaultEnabled ?? false,
        priority: ++priority,
        note: fix.credit,
      });
    }
  }

  /** Re-deploy the game tree to match the currently-enabled mods. */
  async reconcile(gameId: GameId, whitePath: string): Promise<void> {
    const enabled = (await this.list(gameId)).filter((m) => m.enabled).sort((a, b) => a.priority - b.priority);
    const providers: ModProvider[] = [];
    for (const m of enabled) {
      const content = path.join(this.modDir(gameId, m.modName), CONTENT);
      const detected = await detectMod(content);
      const injections = await listContainerInjections(content);
      providers.push({ modName: m.modName, files: detected.files, injections });
    }
    await this.deployment.reconcile(gameId, whitePath, providers);
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
