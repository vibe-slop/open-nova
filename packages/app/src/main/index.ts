import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import { join, resolve as resolvePath } from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  GAMES,
  getGameById,
  findSteamRoot,
  parseLibraryFolders,
  findGameInstall,
  ModManager,
  ModLibrary,
  unpackArchive,
  parseFilelist,
  decryptFilelist,
  encryptFilelist,
  patchExeForLaunch,
  NexusClient,
  NexusError,
  parseNxmUrl,
  gameIdForNxm,
  NEXUS_DOMAINS,
  type GameId,
  type LibraryMod as CoreLibraryMod,
} from '@open-nova/core';
import { IPC, type AppConfig, type SteamInfo, type GameStatus, type ModInfo, type ModInstallOptions, type GenerateModSpec, type LibraryMod, type NexusAuth, type NxmEvent, type UnpackPlan } from '../shared/ipc';

// --- Config persistence ---------------------------------------------------

const DEFAULT_CONFIG: AppConfig = {
  selectedGame: 'XIII-2',
  filesystemMode: 'unpacked',
  textLanguage: 1,
  voiceJP: false,
  fullscreen: true,
  width: null,
  height: null,
  gamePaths: {},
};

let configPath = '';
let config: AppConfig = DEFAULT_CONFIG;

async function loadConfig(): Promise<void> {
  configPath = join(app.getPath('userData'), 'config.json');
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(await fs.readFile(configPath, 'utf8')) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

const mm = () => new ModManager(app.getPath('userData'));
const library = () => new ModLibrary(app.getPath('userData'));

function send(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}
const log = (level: 'info' | 'warn' | 'error', message: string) => send(IPC.evLog, { level, message });
const nxmEvent = (e: NxmEvent) => send(IPC.evNxm, e);

// --- Nexus auth (API key stored encrypted via safeStorage) ----------------

function keyFile(): string {
  return join(app.getPath('userData'), 'nexus.key');
}

async function loadApiKey(): Promise<string | null> {
  try {
    const raw = await fs.readFile(keyFile());
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(raw);
    return raw.toString('utf8'); // fallback (no OS keychain)
  } catch {
    return null;
  }
}

async function storeApiKey(key: string): Promise<void> {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
  await fs.writeFile(keyFile(), data);
}

let nexusPremium = false;
let nexusUser: string | null = null;

async function nexusClient(): Promise<NexusClient | null> {
  const key = await loadApiKey();
  if (!key) return null;
  return new NexusClient({ apiKey: key, appVersion: app.getVersion() });
}

async function nexusAuth(): Promise<NexusAuth> {
  const client = await nexusClient();
  if (!client) return { hasKey: false, premium: false, userName: null };
  try {
    const v = await client.validate();
    nexusPremium = v.is_premium;
    nexusUser = v.name;
    return { hasKey: true, premium: v.is_premium, userName: v.name };
  } catch {
    return { hasKey: true, premium: false, userName: null };
  }
}

function toLibraryMod(m: CoreLibraryMod): LibraryMod {
  return {
    modName: m.modName,
    name: m.name,
    game: m.gameId,
    source: m.source,
    version: m.version,
    author: m.author,
    summary: m.summary,
    pictureUrl: m.pictureUrl,
    layout: m.layout,
    installable: m.installable,
    enabled: m.enabled,
    priority: m.priority,
    note: m.note,
    nexus: m.nexus,
  };
}

// --- Steam / game status --------------------------------------------------

const UNPACKED_MARKER = '.open-nova-unpacked';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function gatherSteam(): Promise<SteamInfo> {
  const steamRoot = await findSteamRoot();
  const libraries = steamRoot ? await parseLibraryFolders(steamRoot) : [];
  const games: GameStatus[] = [];
  for (const g of GAMES) {
    const override = config.gamePaths[g.id];
    const installPath = override ?? (await findGameInstall(g, steamRoot ?? undefined));
    const installed = !!installPath && (await exists(installPath));
    const unpacked = installed ? await exists(join(installPath!, g.dataRoot, UNPACKED_MARKER)) : false;
    games.push({
      id: g.id,
      number: g.number,
      displayName: g.title,
      steamAppId: g.steamAppId,
      installPath: installPath ?? null,
      installed,
      unpacked,
    });
  }
  return { steamRoot, libraries, games };
}

async function resolveInstall(game: GameId): Promise<string | null> {
  const override = config.gamePaths[game];
  if (override) return override;
  const g = getGameById(game);
  return g ? findGameInstall(g) : null;
}

function toModInfo(m: Awaited<ReturnType<ModManager['listMods']>>[number]): ModInfo {
  return {
    name: m.name,
    game: m.gameId,
    author: m.author,
    version: m.version,
    summary: m.summary,
    installed: m.installed,
    status: m.installed ? 'Installed' : 'Not Installed',
  };
}

// --- IPC handlers ----------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.getConfig, () => config);
  ipcMain.handle(IPC.setConfig, async (_e, patch: Partial<AppConfig>) => {
    config = { ...config, ...patch };
    await saveConfig();
    return config;
  });

  ipcMain.handle(IPC.detectSteam, () => gatherSteam());
  ipcMain.handle(IPC.setGamePath, async (_e, game: GameId, p: string) => {
    config.gamePaths = { ...config.gamePaths, [game]: p };
    await saveConfig();
    return gatherSteam();
  });

  ipcMain.handle(IPC.browseForFolder, async (_e, title?: string) => {
    const r = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.browseForFile, async (_e, title?: string, filters?: { name: string; extensions: string[] }[]) => {
    const r = await dialog.showOpenDialog({ title, properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle(IPC.listMods, async (_e, game: GameId) => (await mm().listMods()).filter((m) => m.gameId === game).map(toModInfo));
  ipcMain.handle(IPC.importMod, async (_e, ncmpPath: string) => {
    const info = await mm().importModPack(ncmpPath);
    log('info', `Imported "${info.name}".`);
    return (await mm().listMods()).filter((m) => m.gameId === info.gameId).map(toModInfo);
  });
  ipcMain.handle(IPC.removeMod, async (_e, game: GameId, name: string) => {
    const list = await mm().listMods();
    const found = list.find((m) => m.gameId === game && m.name === name);
    if (found) await fs.rm(found.modDir, { recursive: true, force: true });
    return (await mm().listMods()).filter((m) => m.gameId === game).map(toModInfo);
  });
  ipcMain.handle(IPC.installMod, async (_e, game: GameId, name: string, opts: ModInstallOptions) => {
    const whitePath = await whiteRootFor(game);
    if (!whitePath) return { ok: false, message: 'Game not found / not unpacked.' };
    const list = await mm().listMods();
    const m = list.find((x) => x.gameId === game && x.name === name);
    if (!m) return { ok: false, message: 'Mod not found.' };
    await mm().installMod(m.modName, whitePath, { data: opts.data, en: opts.enVoice, jp: opts.jpVoice });
    log('info', `Installed "${name}".`);
    return { ok: true, message: 'Mod installed.' };
  });
  ipcMain.handle(IPC.uninstallMod, async (_e, game: GameId, name: string, opts: ModInstallOptions) => {
    const whitePath = await whiteRootFor(game);
    if (!whitePath) return { ok: false, message: 'Game not found.' };
    const list = await mm().listMods();
    const m = list.find((x) => x.gameId === game && x.name === name);
    if (!m) return { ok: false, message: 'Mod not found.' };
    await mm().uninstallMod(m.modName, whitePath, { data: opts.data, en: opts.enVoice, jp: opts.jpVoice });
    log('info', `Uninstalled "${name}".`);
    return { ok: true, message: 'Mod uninstalled.' };
  });
  ipcMain.handle(IPC.generateMod, async (_e, spec: GenerateModSpec) => {
    const g = getGameById(spec.game)!;
    await mm().generateModPack(
      {
        name: spec.name,
        author: spec.author,
        version: spec.version,
        summary: spec.summary,
        gameEntry: String(g.number) as '1' | '2' | '3',
        data: spec.dataDir ? await readDirToMap(spec.dataDir) : undefined,
        enData: spec.enDataDir ? await readDirToMap(spec.enDataDir) : undefined,
        jpData: spec.jpDataDir ? await readDirToMap(spec.jpDataDir) : undefined,
        external: spec.externalDir ? await readDirToMap(spec.externalDir) : undefined,
      },
      spec.outputPath,
    );
    log('info', `Generated ${spec.outputPath}.`);
    return { ok: true, outputPath: spec.outputPath };
  });

  ipcMain.handle(IPC.decryptFilelist, async (_e, inPath: string, outPath: string) => {
    const buf = await fs.readFile(inPath);
    const r = decryptFilelist(buf);
    await fs.writeFile(outPath, r.data);
    log('info', `Decrypted ${inPath} (checksum ${r.checksumOk ? 'OK' : 'mismatch'}).`);
    return { ok: true, checksumOk: r.checksumOk };
  });
  ipcMain.handle(IPC.encryptFilelist, async (_e, inPath: string, outPath: string) => {
    const buf = await fs.readFile(inPath);
    await fs.writeFile(outPath, Buffer.from(encryptFilelist(buf)));
    return { ok: true };
  });
  ipcMain.handle(IPC.unpackArchive, async (_e, filelistPath: string, imgPath: string, outDir: string, game: GameId) => {
    const g = getGameById(game)!;
    const fl = await fs.readFile(filelistPath);
    const img = await fs.readFile(imgPath);
    const { files } = unpackArchive(fl, img, g.number);
    let i = 0;
    for (const f of files) {
      const rel = f.virtualPath === ' ' ? `noPath/FILE_${i}` : f.virtualPath;
      const dest = join(outDir, ...rel.split('/'));
      await fs.mkdir(join(dest, '..'), { recursive: true });
      await fs.writeFile(dest, f.data);
      send(IPC.evProgress, { jobId: 'unpack', kind: 'unpack', current: ++i, total: files.length, message: rel });
    }
    log('info', `Unpacked ${files.length} files to ${outDir}.`);
    return { ok: true, fileCount: files.length };
  });

  ipcMain.handle(IPC.unpackPlan, (_e, game: GameId) => getUnpackPlan(game));
  ipcMain.handle(IPC.unpackGame, (_e, game: GameId, force?: boolean) => unpackGame(game, force ?? false));
  ipcMain.handle(IPC.launchGame, (_e, game: GameId) => launchGame(game));

  // --- Nexus auth ---
  ipcMain.handle(IPC.getNexusAuth, () => nexusAuth());
  ipcMain.handle(IPC.setNexusApiKey, async (_e, key: string) => {
    await storeApiKey(key.trim());
    const auth = await nexusAuth();
    log(auth.userName ? 'info' : 'warn', auth.userName ? `Signed in to Nexus as ${auth.userName}${auth.premium ? ' (Premium)' : ''}.` : 'Nexus API key saved but could not validate.');
    return auth;
  });
  ipcMain.handle(IPC.clearNexusApiKey, async () => {
    await fs.rm(keyFile(), { force: true });
    nexusPremium = false;
    nexusUser = null;
    return { hasKey: false, premium: false, userName: null } satisfies NexusAuth;
  });
  ipcMain.handle(IPC.openNexusModsPage, async (_e, game: GameId) => {
    await shell.openExternal(`https://www.nexusmods.com/${NEXUS_DOMAINS[game]}?tab=popular`);
  });

  // --- Mod library (enable/disable) ---
  ipcMain.handle(IPC.libraryList, async (_e, game: GameId) => {
    // Ensure bundled fixes (e.g. the rain-translucency fix) appear as normal,
    // re-orderable mods in the list.
    await library().syncBuiltinFixes(game).catch(() => {});
    return (await library().list(game)).map(toLibraryMod);
  });
  ipcMain.handle(IPC.librarySetEnabled, async (_e, game: GameId, modName: string, enabled: boolean) => {
    const whitePath = await whiteRootFor(game);
    if (!whitePath) return { ok: false, message: 'Game not found / not unpacked.', mods: (await library().list(game)).map(toLibraryMod) };
    try {
      await library().setEnabled(game, modName, enabled, whitePath);
      log('info', `${enabled ? 'Enabled' : 'Disabled'} "${modName}".`);
      return { ok: true, message: enabled ? 'Enabled.' : 'Disabled.', mods: (await library().list(game)).map(toLibraryMod) };
    } catch (err) {
      log('error', (err as Error).message);
      return { ok: false, message: (err as Error).message, mods: (await library().list(game)).map(toLibraryMod) };
    }
  });
  ipcMain.handle(IPC.librarySetOrder, async (_e, game: GameId, order: string[]) => {
    const whitePath = await whiteRootFor(game);
    if (whitePath) await library().setOrder(game, order, whitePath);
    return (await library().list(game)).map(toLibraryMod);
  });
  ipcMain.handle(IPC.libraryRemove, async (_e, game: GameId, modName: string) => {
    const whitePath = (await whiteRootFor(game)) ?? '';
    await library().remove(game, modName, whitePath);
    return (await library().list(game)).map(toLibraryMod);
  });
  ipcMain.handle(IPC.libraryImportFile, async (_e, game: GameId) => {
    const r = await dialog.showOpenDialog({
      title: 'Import a mod',
      properties: ['openFile'],
      filters: [{ name: 'Mod archives', extensions: ['zip', '7z', 'rar', 'ncmp'] }],
    });
    if (r.canceled) return { ok: false, message: 'Cancelled.', mods: (await library().list(game)).map(toLibraryMod) };
    try {
      const mod = await library().importArchive(game, r.filePaths[0]);
      log('info', `Imported "${mod.name}" (${mod.layout}).`);
      return { ok: true, message: `Imported "${mod.name}".`, mods: (await library().list(game)).map(toLibraryMod) };
    } catch (err) {
      log('error', `Import failed: ${(err as Error).message}`);
      return { ok: false, message: (err as Error).message, mods: (await library().list(game)).map(toLibraryMod) };
    }
  });
  ipcMain.handle(IPC.nexusInstall, async (_e, game: GameId, modId: number, fileId: number) => {
    const result = await installFromNexus(game, modId, fileId);
    return { ...result, mods: (await library().list(game)).map(toLibraryMod) };
  });
}

// --- Nexus download + install --------------------------------------------

/** Stream a CDN URL to a temp file, emitting download progress. */
async function downloadTo(url: string, destFile: string, jobId: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  await fs.mkdir(join(destFile, '..'), { recursive: true });
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    received += chunk.length;
    send(IPC.evProgress, { jobId, kind: 'download', current: received, total, message: 'Downloading…' });
  }
  await fs.writeFile(destFile, Buffer.concat(chunks));
}

/** Premium in-app install: resolve the CDN link, download, import to library. */
async function installFromNexus(game: GameId, modId: number, fileId: number): Promise<{ ok: boolean; message: string }> {
  const client = await nexusClient();
  if (!client) return { ok: false, message: 'Add your Nexus API key in Settings first.' };
  const domain = NEXUS_DOMAINS[game];
  try {
    const info = await client.getModInfo(domain, modId);
    const links = await client.getDownloadLink(domain, modId, fileId);
    const files = await client.getModFiles(domain, modId);
    const file = files.files.find((f) => f.file_id === fileId);
    const tmp = join(app.getPath('temp'), `open-nova-${modId}-${fileId}-${file?.file_name ?? 'mod.zip'}`);
    nxmEvent({ status: 'downloading', game, message: `Downloading ${info.name}…` });
    await downloadTo(links[0].URI, tmp, `nexus-${modId}`);
    const mod = await library().importArchive(game, tmp, {
      name: info.name,
      source: 'nexus',
      version: info.version,
      author: info.author,
      summary: info.summary,
      pictureUrl: info.picture_url ?? undefined,
      nexus: { domain, modId, fileId },
    });
    await fs.rm(tmp, { force: true });
    nxmEvent({ status: 'installed', game, modName: mod.modName, message: `Imported "${mod.name}".` });
    log('info', `Imported "${mod.name}" from Nexus.`);
    return { ok: true, message: `Imported "${mod.name}". Enable it in the Mods tab.` };
  } catch (err) {
    const msg =
      err instanceof NexusError && err.status === 403
        ? 'This download needs Nexus Premium for in-app install. On the mod page, use "Mod Manager Download" instead.'
        : (err as Error).message;
    nxmEvent({ status: 'error', game, message: msg });
    log('error', `Nexus install failed: ${msg}`);
    return { ok: false, message: msg };
  }
}

/** Handle an nxm:// deep link (the website "Mod Manager Download" button). */
async function handleNxm(url: string): Promise<void> {
  try {
    const p = parseNxmUrl(url);
    const game = gameIdForNxm(p.domain);
    if (!game) {
      log('warn', `nxm link for unsupported game domain "${p.domain}".`);
      return;
    }
    nxmEvent({ status: 'received', game, message: `Received download for ${p.domain} mod ${p.modId}…` });
    const client = await nexusClient();
    if (!client) {
      nxmEvent({ status: 'error', game, message: 'Add your Nexus API key in Settings first.' });
      return;
    }
    if (p.key === undefined || p.expires === undefined) {
      nxmEvent({ status: 'error', game, message: 'nxm link missing its download grant.' });
      return;
    }
    const links = await client.getDownloadLink(p.domain, p.modId, p.fileId, { key: p.key, expires: p.expires });
    const info = await client.getModInfo(p.domain, p.modId).catch(() => null);
    const tmp = join(app.getPath('temp'), `open-nova-${p.modId}-${p.fileId}.archive`);
    nxmEvent({ status: 'downloading', game, message: `Downloading ${info?.name ?? 'mod'}…` });
    await downloadTo(links[0].URI, tmp, `nxm-${p.modId}`);
    const mod = await library().importArchive(game, tmp, {
      name: info?.name,
      source: 'nexus',
      version: info?.version,
      author: info?.author,
      summary: info?.summary,
      pictureUrl: info?.picture_url ?? undefined,
      nexus: { domain: p.domain, modId: p.modId, fileId: p.fileId },
    });
    await fs.rm(tmp, { force: true });
    nxmEvent({ status: 'installed', game, modName: mod.modName, message: `Imported "${mod.name}". Enable it in the Mods tab.` });
  } catch (err) {
    nxmEvent({ status: 'error', message: `nxm install failed: ${(err as Error).message}` });
    log('error', `nxm install failed: ${(err as Error).message}`);
  }
}

async function whiteRootFor(game: GameId): Promise<string | null> {
  const install = await resolveInstall(game);
  const g = getGameById(game);
  if (!install || !g) return null;
  return join(install, g.dataRoot);
}

async function readDirToMap(dir: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  async function rec(d: string, base: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) await rec(full, rel);
      else if (e.isFile()) out[rel] = await fs.readFile(full);
    }
  }
  await rec(dir, '');
  return out;
}

/**
 * Bulk-unpack every filelist/white_img pair under the game's data root into the
 * loose-file tree, then write the unpacked marker. Reuses the validated archive
 * layer. NEEDS validation on a real Steam Deck install (see ARCHITECTURE.md).
 */
async function unpackGame(game: GameId, force = false): Promise<{ ok: boolean; message: string }> {
  const install = await resolveInstall(game);
  const g = getGameById(game);
  if (!install || !g) return { ok: false, message: 'Game not found.' };
  const root = join(install, g.dataRoot);

  const pairs = await findArchivePairs(root);
  if (pairs.length === 0) return { ok: false, message: 'No filelist/white_img pairs found.' };

  // Disk-space guard: estimate the unpacked footprint and refuse if it won't fit
  // (unless the user explicitly forces it past the warning). Prevents a
  // half-finished unpack that fills the drive.
  if (!force) {
    const estimate = await estimateUnpackSize(pairs, g.number);
    const free = await freeSpaceFor(root);
    const needed = estimate * 1.05 + 256 * 1024 * 1024; // headroom for block rounding + setup file
    if (free > 0 && free < needed) {
      const msg = `Not enough disk space: unpacking needs ~${fmtGB(needed)}, but only ${fmtGB(free)} is free on the game drive.`;
      log('warn', msg);
      return { ok: false, message: msg };
    }
  }

  let done = 0;
  for (const { filelist, img } of pairs) {
    try {
      const { files } = unpackArchive(await fs.readFile(filelist), await fs.readFile(img), g.number);
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rel = f.virtualPath === ' ' ? `noPath/FILE_${i}` : f.virtualPath;
        const dest = join(root, ...rel.split('/'));
        if (await exists(dest)) continue;
        await fs.mkdir(join(dest, '..'), { recursive: true });
        await fs.writeFile(dest, f.data);
      }
      log('info', `Unpacked ${files.length} files from ${filelist}.`);
    } catch (err) {
      log('error', `Failed on ${filelist}: ${(err as Error).message}`);
    }
    send(IPC.evProgress, { jobId: 'unpackGame', kind: 'unpack', current: ++done, total: pairs.length, message: filelist });
  }
  await firstTimeSetup(root);
  await fs.writeFile(join(root, UNPACKED_MARKER), new Date().toISOString());
  return { ok: true, message: `Unpacked ${pairs.length} archive(s).` };
}

/** Candidate paths to a bundled resource (dev vs packaged). */
function resourceCandidates(name: string): string[] {
  return [
    join(process.resourcesPath ?? '', name), // electron-builder extraResources
    join(app.getAppPath(), 'resources', name), // dev (app package root)
    join(__dirname, '..', '..', 'resources', name), // dev (out/main → app root)
  ];
}

/**
 * Per-game first-time-setup the engine expects in unpacked mode: write the
 * debug font texture as a loose file (Nova does this; without it the engine can
 * fail to boot unpacked). Extracted verbatim from the original's resources.
 */
async function firstTimeSetup(whiteRoot: string): Promise<void> {
  try {
    let src: string | null = null;
    for (const c of resourceCandidates('DebugFontTextureDDS.bin')) {
      if (await exists(c)) { src = c; break; }
    }
    if (src) {
      const dest = join(whiteRoot, 'sys', 'debug', 'DebugFontTextureDDS.bin');
      await fs.mkdir(join(dest, '..'), { recursive: true });
      await fs.copyFile(src, dest);
      log('info', 'Wrote sys/debug/DebugFontTextureDDS.bin (unpacked-mode boot resource).');
    } else {
      log('warn', 'DebugFontTextureDDS.bin resource missing; unpacked boot may need it.');
    }
  } catch (err) {
    log('warn', `first-time setup: ${(err as Error).message}`);
  }
}

/** Sum of every entry's uncompressed size across the given archive pairs (bytes). */
async function estimateUnpackSize(pairs: { filelist: string; img: string }[], gameNumber: 1 | 2 | 3): Promise<number> {
  let total = 0;
  for (const { filelist } of pairs) {
    try {
      const fl = parseFilelist(await fs.readFile(filelist), gameNumber);
      for (const f of fl.files) total += f.uncmpSize >>> 0;
    } catch {
      /* unreadable filelist — skip its contribution to the estimate */
    }
  }
  return total;
}

/** Free bytes on the filesystem holding `p` (the install drive — may be an SD card). */
async function freeSpaceFor(p: string): Promise<number> {
  try {
    const st = await fs.statfs(p);
    return st.bavail * st.bsize;
  } catch {
    return 0; // unknown — caller treats 0 as "can't determine, don't block"
  }
}

function fmtGB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Pre-flight plan for the first-run unpack gate: size estimate vs. free space + status. */
async function getUnpackPlan(game: GameId): Promise<UnpackPlan> {
  const empty: UnpackPlan = { installed: false, unpacked: false, estimateBytes: 0, freeBytes: 0, sufficient: false };
  const install = await resolveInstall(game);
  const g = getGameById(game);
  if (!install || !g) return empty;
  const root = join(install, g.dataRoot);
  const installed = await exists(install);
  const unpacked = await exists(join(root, UNPACKED_MARKER));
  const pairs = await findArchivePairs(root);
  const estimateBytes = await estimateUnpackSize(pairs, g.number);
  const freeBytes = await freeSpaceFor(root);
  const needed = estimateBytes * 1.05 + 256 * 1024 * 1024;
  const sufficient = freeBytes === 0 || freeBytes >= needed;
  return { installed, unpacked, estimateBytes, freeBytes, sufficient };
}

async function findArchivePairs(root: string): Promise<{ filelist: string; img: string }[]> {
  const out: { filelist: string; img: string }[] = [];
  async function rec(d: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await rec(full);
      else if (/^filelist.*\.win32\.bin$/i.test(e.name)) {
        const suffix = e.name.replace(/^filelist/i, '').replace(/\.win32\.bin$/i, '');
        const imgName = `white${suffix.startsWith('_') ? suffix : '_img' + suffix}.win32.bin`;
        const img = join(d, imgName);
        if (await exists(img)) out.push({ filelist: full, img });
      }
    }
  }
  await rec(root);
  return out;
}

/** Launch via Steam under Proton; opportunistically apply the LAA patch first. */
async function launchGame(game: GameId): Promise<{ ok: boolean; message: string }> {
  const install = await resolveInstall(game);
  const g = getGameById(game);
  if (!install || !g) return { ok: false, message: 'Game not found.' };

  // Apply enabled mods (incl. default-on fixes like FF13Fix) right before launch.
  try {
    await library().syncBuiltinFixes(game);
    await library().reconcile(game, join(install, g.dataRoot));
    log('info', 'Applied enabled mods + fixes.');
  } catch (err) {
    log('warn', `mod reconcile before launch: ${(err as Error).message}`);
  }

  // Patch the on-disk exe before launch. In unpacked mode this includes the
  // critical unpacked-mode branch override (so the game reads loose modded
  // files), plus text-language; otherwise just Large-Address-Aware. Always
  // re-patch from the pristine .original so toggling settings is clean.
  try {
    const exe = join(install, ...g.exeRel.split('/'));
    if (await exists(exe)) {
      const orig = exe + '.original';
      if (!(await exists(orig))) await fs.copyFile(exe, orig); // keep pristine backup
      const pristine = await fs.readFile(orig);
      const unpacked = config.filesystemMode === 'unpacked' && (await exists(join(install, g.dataRoot, UNPACKED_MARKER)));
      const patched = patchExeForLaunch(pristine, g.number, {
        unpacked,
        textLanguage: config.textLanguage,
      });
      await fs.writeFile(exe, patched);
      log('info', unpacked ? 'Patched exe: unpacked mode + LAA + language.' : 'Patched exe: LAA + language.');
      if (config.filesystemMode === 'unpacked' && !unpacked) {
        log('warn', 'Unpacked mode requested but game is not unpacked yet — launching packed. Run "Unpack game data" first.');
      }
    }
  } catch (err) {
    log('warn', `exe patch skipped: ${(err as Error).message}`);
  }

  const url = `steam://rungameid/${g.steamAppId}`;
  if (process.platform === 'linux') spawn('steam', [url], { detached: true, stdio: 'ignore' }).unref();
  else await shell.openExternal(url);
  log('info', `Launching ${game} via Steam…`);
  return { ok: true, message: 'Launching via Steam…' };
}

// --- Window + nxm:// deep-link wiring --------------------------------------

let mainWindow: BrowserWindow | null = null;
/** nxm urls that arrive before the renderer is ready, replayed on load. */
const pendingNxm: string[] = [];

function routeNxm(url: string | undefined): void {
  if (!url || !url.startsWith('nxm://')) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) handleNxm(url);
  else pendingNxm.push(url);
}

const extractNxmUrl = (argv: string[]): string | undefined => argv.find((a) => a.startsWith('nxm://'));

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0b0d17',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    while (pendingNxm.length) handleNxm(pendingNxm.shift()!);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single-instance lock: a second launch (e.g. from clicking an nxm:// link)
// forwards its argv to the running instance instead of starting a new one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Register as the nxm:// protocol handler (dev-mode needs execPath + argv).
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('nxm', process.execPath, [resolvePath(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('nxm');
  }

  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    routeNxm(extractNxmUrl(argv)); // Windows/Linux deliver the url in argv
  });

  app.on('open-url', (_e, url) => routeNxm(url)); // macOS

  app.whenReady().then(async () => {
    await loadConfig();
    // Point @open-nova/core at the packaged bundled-fixes dir (the bundled main
    // process can't resolve the core source path).
    for (const c of resourceCandidates('fixes')) {
      if (await exists(c)) { process.env.OPEN_NOVA_FIXES_DIR = c; break; }
    }
    registerIpc();
    createWindow();
    routeNxm(extractNxmUrl(process.argv)); // cold-start with an nxm:// arg
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
