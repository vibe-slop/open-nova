import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  GAMES,
  getGameById,
  findSteamRoot,
  parseLibraryFolders,
  findGameInstall,
  ModManager,
  parseFilelist,
  buildFilelist,
  unpackArchive,
  decryptFilelist,
  encryptFilelist,
  isLargeAddressAware,
  patchLargeAddressAware,
  type GameId,
} from '@open-nova/core';
import { IPC, type AppConfig, type SteamInfo, type GameStatus, type ModInfo, type ModInstallOptions, type GenerateModSpec } from '../shared/ipc';

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

function send(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}
const log = (level: 'info' | 'warn' | 'error', message: string) => send(IPC.evLog, { level, message });

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

  ipcMain.handle(IPC.unpackGame, (_e, game: GameId) => unpackGame(game));
  ipcMain.handle(IPC.launchGame, (_e, game: GameId) => launchGame(game));
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
async function unpackGame(game: GameId): Promise<{ ok: boolean; message: string }> {
  const install = await resolveInstall(game);
  const g = getGameById(game);
  if (!install || !g) return { ok: false, message: 'Game not found.' };
  const root = join(install, g.dataRoot);

  const pairs = await findArchivePairs(root);
  if (pairs.length === 0) return { ok: false, message: 'No filelist/white_img pairs found.' };

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
  await fs.writeFile(join(root, UNPACKED_MARKER), new Date().toISOString());
  return { ok: true, message: `Unpacked ${pairs.length} archive(s).` };
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

  // Best-effort Large-Address-Aware patch of the on-disk exe.
  try {
    const exe = join(install, ...g.exeRel.split('/'));
    if (await exists(exe)) {
      const buf = await fs.readFile(exe);
      if (!isLargeAddressAware(buf)) {
        await fs.copyFile(exe, exe + '.original').catch(() => {});
        await fs.writeFile(exe, patchLargeAddressAware(buf));
        log('info', 'Applied Large-Address-Aware patch.');
      }
    }
  } catch (err) {
    log('warn', `LAA patch skipped: ${(err as Error).message}`);
  }

  const url = `steam://rungameid/${g.steamAppId}`;
  if (process.platform === 'linux') spawn('steam', [url], { detached: true, stdio: 'ignore' }).unref();
  else await shell.openExternal(url);
  log('info', `Launching ${game} via Steam…`);
  return { ok: true, message: 'Launching via Steam…' };
}

// --- Window ----------------------------------------------------------------

function createWindow(): void {
  const win = new BrowserWindow({
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

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  await loadConfig();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
