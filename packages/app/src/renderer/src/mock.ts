/**
 * Mock NovaApi for running the renderer in a plain browser (vite dev) without
 * Electron/preload. Installed onto window.nova only when the real bridge is
 * absent. Lets the UI be developed and visually checked without a game install.
 */
import type { NovaApi, AppConfig, SteamInfo, ModInfo, GameId, LibraryMod, NexusAuth } from '../../shared/ipc';

let config: AppConfig = {
  selectedGame: 'XIII-2',
  filesystemMode: 'unpacked',
  textLanguage: 1,
  voiceJP: false,
  fullscreen: true,
  width: null,
  height: null,
  gamePaths: {},
};

const steam: SteamInfo = {
  steamRoot: '/home/deck/.local/share/Steam',
  libraries: ['/home/deck/.local/share/Steam', '/run/media/mmcblk0p1/steamapps'],
  games: [
    { id: 'XIII', number: 1, displayName: 'FINAL FANTASY XIII', steamAppId: '292120', installPath: null, installed: false, unpacked: false },
    { id: 'XIII-2', number: 2, displayName: 'FINAL FANTASY XIII-2', steamAppId: '292140', installPath: '/run/media/mmcblk0p1/steamapps/common/FINAL FANTASY XIII-2', installed: true, unpacked: false },
    { id: 'XIII-LR', number: 3, displayName: 'LIGHTNING RETURNS: FINAL FANTASY XIII', steamAppId: '345350', installPath: null, installed: false, unpacked: false },
  ],
};

const mods: Record<GameId, ModInfo[]> = {
  XIII: [],
  'XIII-2': [
    { name: 'FF XIII-2 HD', game: 'XIII-2', author: 'MJB', version: '1.1.0', summary: 'AI-upscaled textures and improved models.', installed: false, status: 'Not Installed' },
    { name: 'Better FMV Audio', game: 'XIII-2', author: 'Surihix', version: '1.0', summary: 'PS3-quality cutscene audio.', installed: true, status: 'Installed' },
  ],
  'XIII-LR': [],
};

let auth: NexusAuth = { hasKey: false, premium: false, userName: null };
const libMods: Record<GameId, LibraryMod[]> = {
  XIII: [],
  'XIII-2': [
    { modName: 'FF XIII-2 HD', name: 'FF XIII-2 HD', game: 'XIII-2', source: 'nexus', version: '1.1.0', author: 'MJB', summary: 'AI-upscaled textures.', layout: 'dataRoot', installable: true, enabled: true, priority: 1, note: '' },
    { modName: 'Console Button Prompts', name: 'Console Button Prompts', game: 'XIII-2', source: 'local', version: '2.2', author: 'Krisan Thyme', summary: 'Xbox/PS icons.', layout: 'bare', installable: true, enabled: false, priority: 2, note: '' },
  ],
  'XIII-LR': [],
};

const delay = <T>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export const mockApi: NovaApi = {
  getConfig: () => delay(config),
  setConfig: (patch) => delay((config = { ...config, ...patch })),
  detectSteam: () => delay(steam),
  setGamePath: (game, p) => {
    const g = steam.games.find((x) => x.id === game);
    if (g) { g.installPath = p; g.installed = true; }
    return delay(steam);
  },
  browseForFolder: () => delay('/run/media/mmcblk0p1/steamapps/common/FINAL FANTASY XIII-2'),
  browseForFile: () => delay('/home/deck/Downloads/example.ncmp'),
  listMods: (game) => delay(mods[game] ?? []),
  importMod: (game) => delay(mods['XIII-2']),
  removeMod: (game) => delay((mods[game] ?? []).filter(Boolean)),
  installMod: () => delay({ ok: true, message: 'Mod installed.' }),
  uninstallMod: () => delay({ ok: true, message: 'Mod uninstalled.' }),
  generateMod: (spec) => delay({ ok: true, outputPath: spec.outputPath }),
  decryptFilelist: () => delay({ ok: true, checksumOk: true }),
  encryptFilelist: () => delay({ ok: true }),
  unpackArchive: () => delay({ ok: true, fileCount: 1234 }),
  unpackGame: () => delay({ ok: true, message: 'Unpacked (mock).' }, 800),
  launchGame: () => delay({ ok: true, message: 'Launching via Steam…' }),

  getNexusAuth: () => delay(auth),
  setNexusApiKey: (key) => delay((auth = { hasKey: true, premium: key.includes('prem'), userName: 'DeckUser' })),
  clearNexusApiKey: () => delay((auth = { hasKey: false, premium: false, userName: null })),
  openNexusModsPage: () => delay(undefined),
  libraryList: (game) => delay(libMods[game] ?? []),
  librarySetEnabled: (game, modName, enabled) => {
    const m = (libMods[game] ?? []).find((x) => x.modName === modName);
    if (m) m.enabled = enabled;
    return delay({ ok: true, message: enabled ? 'Enabled.' : 'Disabled.', mods: libMods[game] ?? [] });
  },
  librarySetOrder: (game) => delay(libMods[game] ?? []),
  libraryRemove: (game, modName) => delay((libMods[game] = (libMods[game] ?? []).filter((m) => m.modName !== modName))),
  libraryImportFile: (game) => delay({ ok: true, message: 'Imported (mock).', mods: libMods[game] ?? [] }),
  nexusInstall: (game) => delay({ ok: true, message: 'Imported (mock).', mods: libMods[game] ?? [] }),

  onProgress: () => () => {},
  onLog: () => () => {},
  onNxm: () => () => {},
};

export function installMockIfNeeded(): void {
  if (typeof window !== 'undefined' && !window.nova) {
    (window as unknown as { nova: NovaApi }).nova = mockApi;
  }
}
