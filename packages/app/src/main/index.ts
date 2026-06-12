import { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } from 'electron';
import { join, basename } from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  GAMES,
  getGameById,
  findSteamRoot,
  parseLibraryFolders,
  findGameInstall,
  ModLibrary,
  unpackArchive,
  parseFilelist,
  patchExeForLaunch,
  type GameId,
  type LibraryMod as CoreLibraryMod,
} from '@open-nova/core';
import { IPC, type AppConfig, type SteamInfo, type GameStatus, type LibraryMod, type UnpackPlan } from '../shared/ipc';

// --- Config persistence ---------------------------------------------------

const DEFAULT_CONFIG: AppConfig = {
  selectedGame: 'XIII',
  filesystemMode: 'unpacked',
  textLanguage: 1,
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

const library = () => new ModLibrary(app.getPath('userData'));

function send(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}
const log = (level: 'info' | 'warn' | 'error', message: string) => console[level](`[open-nova] ${message}`);

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
    locked: m.locked,
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
  ipcMain.handle(IPC.unpackPlan, (_e, game: GameId) => getUnpackPlan(game));
  ipcMain.handle(IPC.unpackGame, (_e, game: GameId, force?: boolean) => unpackGame(game, force ?? false));
  ipcMain.handle(IPC.launchGame, (_e, game: GameId) => launchGame(game));
  ipcMain.handle(IPC.restoreGame, (_e, game: GameId) => restoreGame(game));

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
}

async function whiteRootFor(game: GameId): Promise<string | null> {
  const install = await resolveInstall(game);
  const g = getGameById(game);
  if (!install || !g) return null;
  return join(install, g.dataRoot);
}


/** Count of in-flight unpacks — gates the "quit during unpack" confirmation. */
let unpacking = 0;

/**
 * Bulk-unpack every filelist/white_img pair under the game's data root into the
 * loose-file tree, then write the unpacked marker. Reuses the validated archive
 * layer. NEEDS validation on a real Steam Deck install.
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

  // Mark unpacking in-flight (gates the close-confirm dialog) and inhibit system
  // sleep/suspend so a multi-minute unpack isn't interrupted by the Deck dozing.
  unpacking++;
  const blockerId = powerSaveBlocker.start('prevent-app-suspension');
  try {
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
        // Stop immediately on any failure — a partial unpack leaves the loose tree
        // missing resources, which crashes the game in unpacked mode. Don't write
        // the unpacked marker, so the game stays in its normal packed state.
        const msg = `Unpacking failed on ${basename(filelist)}: ${(err as Error).message}. The game was only partially unpacked — use "Restore game to normal", then try again.`;
        log('error', msg);
        return { ok: false, message: msg };
      }
      send(IPC.evProgress, { jobId: 'unpackGame', kind: 'unpack', current: ++done, total: pairs.length, message: filelist });
    }
    await firstTimeSetup(root);
    await fs.writeFile(join(root, UNPACKED_MARKER), new Date().toISOString());
    // Deploy any already-enabled mods (incl. default-on fixes) right away so the
    // on-disk tree matches the toggles immediately after unpacking — not only at
    // the next launch. Best-effort: a reconcile failure doesn't fail the unpack.
    try {
      await library().syncBuiltinFixes(game);
      await library().reconcile(game, root);
      log('info', 'Deployed enabled mods after unpack.');
    } catch (err) {
      log('warn', `post-unpack reconcile: ${(err as Error).message}`);
    }
    return { ok: true, message: `Unpacked ${pairs.length} archive(s).` };
  } finally {
    unpacking--;
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  }
}

/**
 * Revert a game to its normal (packed/vanilla) state: tear down every deployed
 * mod overlay + filelist edit (restoring vanilla files from the ledger/backups),
 * restore the original exe from the `.original` backup (undoing the
 * unpacked-mode / LAA / language patch), and clear the unpacked flag. The game
 * then reads its original archives again; the extracted loose files remain on
 * disk but are ignored while packed.
 */
async function restoreGame(game: GameId): Promise<{ ok: boolean; message: string }> {
  const install = await resolveInstall(game);
  const g = getGameById(game);
  if (!install || !g) return { ok: false, message: 'Game not found.' };

  const did: string[] = [];
  // 1) Revert all mod overlays + filelist edits while the loose tree is still in
  //    place (restores vanilla files from the deployment ledger + filelist backups).
  try {
    await library().revertToVanilla(game, join(install, g.dataRoot));
    did.push('reverted all mod changes');
  } catch (err) {
    log('warn', `restore (revert mods): ${(err as Error).message}`);
  }
  // 2) Restore the original exe (undo the unpacked-mode / LAA / language patch).
  try {
    const exe = join(install, ...g.exeRel.split('/'));
    const orig = exe + '.original';
    if (await exists(orig)) {
      await fs.copyFile(orig, exe);
      did.push('restored the original game executable');
    }
  } catch (err) {
    log('warn', `restore (exe): ${(err as Error).message}`);
  }
  // 3) Clear the unpacked flag so the game is treated as vanilla/packed.
  try {
    const marker = join(install, g.dataRoot, UNPACKED_MARKER);
    if (await exists(marker)) {
      await fs.rm(marker);
      did.push('cleared the unpacked flag');
    }
  } catch (err) {
    log('warn', `restore (marker): ${(err as Error).message}`);
  }

  const summary = did.length ? did.join(', ') : 'nothing needed restoring (already vanilla)';
  log('info', `Restore ${game}: ${summary}.`);
  return {
    ok: true,
    message:
      `Restored to normal — ${summary}. The game now reads its original files. The extracted loose files ` +
      `stay on disk but are ignored while packed; to reclaim that space, use Steam → Verify integrity / Reinstall.`,
  };
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
 * debug font texture as a loose file (without it the engine can fail to boot
 * unpacked).
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
      if (e.isDirectory()) {
        await rec(full);
        continue;
      }
      // Match filelist<MID>.win32.bin and the split-part filelist<MID>.win32.bin2.
      const m = /^filelist(.*)\.win32\.bin(2?)$/i.exec(e.name);
      if (!m) continue;
      const mid = m[1]; // e.g. 'u', 'c', '_scru', '_z0049u'
      const part = m[2]; // '' or '2' (split archives)
      // The white_img name is irregular across archive families — try each
      // convention and use whichever actually exists on disk:
      //   sys main:   filelistu        -> white_imgu
      //   script:     filelist_scru    -> white_scru
      //   zone:       filelist_z0049u  -> white_z0049u_img   (and _img2 for .bin2)
      const candidates = [
        `white_img${mid}.win32.bin${part}`,
        `white${mid}.win32.bin${part}`,
        `white${mid}_img${part}.win32.bin`,
      ];
      for (const c of candidates) {
        const img = join(d, c);
        if (await exists(img)) {
          out.push({ filelist: full, img });
          break;
        }
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

  const warnings: string[] = [];

  // Apply enabled mods (incl. default-on fixes like FF13Fix) right before launch.
  try {
    await library().syncBuiltinFixes(game);
    await library().reconcile(game, join(install, g.dataRoot));
    log('info', 'Applied enabled mods + fixes.');
  } catch (err) {
    log('warn', `mod reconcile before launch: ${(err as Error).message}`);
    warnings.push(`couldn't apply mods (${(err as Error).message})`);
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
        const w = "the game isn't unpacked yet — launching unmodded. Run the one-time unpack first";
        log('warn', w);
        warnings.push(w);
      }
    } else {
      warnings.push('game executable not found — launching without patching');
    }
  } catch (err) {
    // A thrown patch error (e.g. the expected-byte guard) means we must NOT write
    // a half/wrong-patched exe — patchExeForLaunch returns a fresh buffer, so the
    // on-disk exe is untouched. Surface it instead of silently launching.
    log('error', `exe patch failed: ${(err as Error).message}`);
    warnings.push(`couldn't patch the game (${(err as Error).message}) — it may run unmodded`);
  }

  const url = `steam://rungameid/${g.steamAppId}`;
  try {
    if (process.platform === 'linux') {
      const child = spawn('steam', [url], { detached: true, stdio: 'ignore' });
      child.on('error', (e) => log('error', `failed to launch Steam: ${e.message}`));
      child.unref();
    } else {
      await shell.openExternal(url);
    }
  } catch (err) {
    return { ok: false, message: `Couldn't reach Steam to launch: ${(err as Error).message}` };
  }
  log('info', `Launching ${game} via Steam…`);

  return warnings.length
    ? { ok: false, message: `Launching via Steam, but ${warnings.join('; ')}.` }
    : { ok: true, message: 'Launching via Steam — the game should open shortly.' };
}

// --- Window + single-instance ---------------------------------------------

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const iconPath = resourceCandidates('icon.png').find((p) => existsSync(p));
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#e9eff7',
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  // Start maximized. The window is shown immediately (not deferred to
  // ready-to-show) so it can't get stuck hidden on the Deck's Wayland/XWayland
  // session; 1100×760 stays as the un-maximized restore size.
  mainWindow.maximize();

  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'));

  // Confirm before quitting mid-unpack — closing now would leave a partial,
  // crash-prone loose tree (the unpack runs in this process).
  let allowClose = false;
  mainWindow.on('close', (e) => {
    const win = mainWindow;
    if (allowClose || unpacking === 0 || !win) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep unpacking', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unpacking in progress',
      message: 'open-nova is still unpacking the game.',
      detail:
        'Quitting now will leave the game only partially unpacked — you\'d need to use "Restore game to normal" and unpack again. Quit anyway?',
    });
    if (choice === 1) {
      allowClose = true;
      win.close();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single-instance lock: a second launch focuses the running window instead of
// starting another instance.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await loadConfig();
    // Point @open-nova/core at the packaged bundled-fixes dir (the bundled main
    // process can't resolve the core source path).
    for (const c of resourceCandidates('fixes')) {
      if (await exists(c)) { process.env.OPEN_NOVA_FIXES_DIR = c; break; }
    }
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
