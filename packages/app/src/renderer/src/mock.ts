/**
 * Mock NovaApi for running the renderer in a plain browser (vite dev) without
 * Electron/preload. Installed onto window.nova only when the real bridge is
 * absent. Lets the UI be developed and visually checked without a game install.
 */
import type { NovaApi, AppConfig, SteamInfo, GameId, LibraryMod, ProgressEvent } from '../../shared/ipc';

let config: AppConfig = {
  selectedGame: 'XIII',
  filesystemMode: 'unpacked',
  textLanguage: 1,
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

const libMods: Record<GameId, LibraryMod[]> = {
  XIII: [
    { modName: 'ff13fix', name: 'FF13 Fix', game: 'XIII', source: 'builtin', version: '1.3', author: 'rebtd7', summary: 'Essential PC-port fix: removes the frame pacer/stutter, fixes vibration, and forces 16x anisotropic filtering. On by default.', layout: 'bare', installable: true, enabled: true, priority: 0, note: '', locked: true },
  ],
  'XIII-2': [
    { modName: 'ff13fix', name: 'FF13 Fix', game: 'XIII-2', source: 'builtin', version: '1.3', author: 'rebtd7', summary: 'Essential PC-port fix: removes the frame pacer/stutter, fixes vibration, and forces 16x anisotropic filtering. On by default.', layout: 'bare', installable: true, enabled: true, priority: 0, note: '', locked: true },
    { modName: 'FF XIII-2 HD', name: 'FF XIII-2 HD', game: 'XIII-2', source: 'local', version: '1.1.0', author: 'MJB', summary: 'AI-upscaled textures.', layout: 'dataRoot', installable: true, enabled: true, priority: 1, note: '', locked: false },
    { modName: 'Console Button Prompts', name: 'Console Button Prompts', game: 'XIII-2', source: 'local', version: '2.2', author: 'Krisan Thyme', summary: 'Xbox/PS icons.', layout: 'bare', installable: true, enabled: false, priority: 2, note: '', locked: false },
  ],
  'XIII-LR': [],
};

const delay = <T>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(v), ms));

const progressCbs = new Set<(e: ProgressEvent) => void>();

export const mockApi: NovaApi = {
  getConfig: () => delay(config),
  setConfig: (patch) => delay((config = { ...config, ...patch })),
  // Return a fresh object each call (the real backend does), so React re-renders
  // after unpack flips a game's `unpacked` flag.
  detectSteam: () => delay({ ...steam, games: steam.games.map((g) => ({ ...g })) }),
  setGamePath: (game, p) => {
    const g = steam.games.find((x) => x.id === game);
    if (g) { g.installPath = p; g.installed = true; }
    return delay(steam);
  },
  browseForFolder: () => delay('/run/media/mmcblk0p1/steamapps/common/FINAL FANTASY XIII-2'),
  getUnpackPlan: (game) => {
    const g = steam.games.find((x) => x.id === game);
    return delay({
      installed: !!g?.installed,
      unpacked: !!g?.unpacked,
      estimateBytes: 32 * 1024 ** 3,
      freeBytes: 96 * 1024 ** 3,
      sufficient: true,
    });
  },
  unpackGame: async (game) => {
    for (let i = 1; i <= 8; i++) {
      await delay(null, 220);
      progressCbs.forEach((cb) => cb({ jobId: 'unpackGame', kind: 'unpack', current: i, total: 8, message: `archive ${i}` }));
    }
    const g = steam.games.find((x) => x.id === game);
    if (g) g.unpacked = true;
    return { ok: true, message: 'Unpacked (mock).' };
  },
  launchGame: () => delay({ ok: true, message: 'Launching via Steam…' }),
  restoreGame: () => delay({ ok: true, message: 'Restored to normal (mock).' }),

  libraryList: (game) => delay(libMods[game] ?? []),
  librarySetEnabled: (game, modName, enabled) => {
    const m = (libMods[game] ?? []).find((x) => x.modName === modName);
    if (m) m.enabled = enabled;
    return delay({ ok: true, message: enabled ? 'Enabled.' : 'Disabled.', mods: libMods[game] ?? [] });
  },
  librarySetOrder: (game) => delay(libMods[game] ?? []),
  libraryRemove: (game, modName) => {
    const m = (libMods[game] ?? []).find((x) => x.modName === modName);
    if (m?.locked) return delay(libMods[game] ?? []); // mirror core: locked fixes can't be removed
    return delay((libMods[game] = (libMods[game] ?? []).filter((x) => x.modName !== modName)));
  },
  libraryImportFile: (game) => delay({ ok: true, message: 'Imported (mock).', mods: libMods[game] ?? [] }),

  onProgress: (cb) => {
    progressCbs.add(cb);
    return () => progressCbs.delete(cb);
  },
};

export function installMockIfNeeded(): void {
  if (typeof window !== 'undefined' && !window.nova) {
    (window as unknown as { nova: NovaApi }).nova = mockApi;
  }
}
