/**
 * The IPC contract between the renderer (UI) and the main process (which owns
 * all @open-nova/core logic). The renderer never touches the filesystem; it
 * calls `window.nova.*`, which the preload bridges to these channels.
 */

export type GameId = 'XIII' | 'XIII-2' | 'XIII-LR';

export interface GameStatus {
  id: GameId;
  number: 1 | 2 | 3;
  displayName: string;
  steamAppId: string;
  installPath: string | null;
  installed: boolean;
  unpacked: boolean;
}

export interface SteamInfo {
  steamRoot: string | null;
  libraries: string[];
  games: GameStatus[];
}

/** Pre-flight info for unpacking a game: size estimate vs. free disk space. */
export interface UnpackPlan {
  installed: boolean;
  unpacked: boolean;
  /** Estimated size of the unpacked loose tree, in bytes. */
  estimateBytes: number;
  /** Free space on the install drive, in bytes. */
  freeBytes: number;
  /** True if there's comfortably enough room (estimate + headroom). */
  sufficient: boolean;
}

export interface AppConfig {
  selectedGame: GameId;
  filesystemMode: 'unpacked' | 'packed';
  textLanguage: number; // 1..8 EN/FR/DE/IT/ES/JA/ZH/KO
  /** Explicit per-game install path overrides (when auto-detect fails). */
  gamePaths: Partial<Record<GameId, string>>;
}

/** A mod in the library (staged; toggled enabled/disabled). */
export interface LibraryMod {
  modName: string;
  name: string;
  game: GameId;
  source: 'local' | 'ncmp' | 'builtin';
  version: string;
  author: string;
  summary: string;
  pictureUrl?: string;
  layout: 'ncmp' | 'dataRoot' | 'bare' | 'installer' | 'texture-inject' | 'unknown';
  installable: boolean;
  enabled: boolean;
  priority: number;
  note: string;
  /** Always-on, always-first, can't be disabled/removed/reordered (e.g. FF13 Fix). */
  locked: boolean;
}

export type JobKind = 'unpack' | 'repack' | 'install' | 'uninstall' | 'import' | 'generate' | 'decrypt' | 'launch' | 'download';

export interface ProgressEvent {
  jobId: string;
  kind: JobKind;
  current: number;
  total: number;
  message: string;
}

/** The API surface exposed on `window.nova` in the renderer. */
export interface NovaApi {
  // Settings
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;

  // Steam / games
  detectSteam(): Promise<SteamInfo>;
  setGamePath(game: GameId, path: string): Promise<SteamInfo>;
  browseForFolder(title?: string): Promise<string | null>;

  // Game ops
  /** Size estimate + free-space check before unpacking (for the first-run gate). */
  getUnpackPlan(game: GameId): Promise<UnpackPlan>;
  /** Unpack the game's archives to a loose tree. `force` overrides the disk-space guard. */
  unpackGame(game: GameId, force?: boolean): Promise<{ ok: boolean; message: string }>;
  launchGame(game: GameId): Promise<{ ok: boolean; message: string }>;
  /** Revert the game to its normal packed/vanilla state (restore the exe + clear the unpacked flag). */
  restoreGame(game: GameId): Promise<{ ok: boolean; message: string }>;

  // Mod library (enable/disable model)
  libraryList(game: GameId): Promise<LibraryMod[]>;
  librarySetEnabled(game: GameId, modName: string, enabled: boolean): Promise<{ ok: boolean; message: string; mods: LibraryMod[] }>;
  librarySetOrder(game: GameId, orderedModNames: string[]): Promise<LibraryMod[]>;
  libraryRemove(game: GameId, modName: string): Promise<LibraryMod[]>;
  /** Open a file picker and import a local .zip/.7z/.rar/.ncmp into the library. */
  libraryImportFile(game: GameId): Promise<{ ok: boolean; message: string; mods: LibraryMod[] }>;

  // Events
  onProgress(cb: (e: ProgressEvent) => void): () => void;
}

declare global {
  interface Window {
    nova: NovaApi;
  }
}

/** Channel names (single source of truth for invoke handlers + preload). */
export const IPC = {
  getConfig: 'config:get',
  setConfig: 'config:set',
  detectSteam: 'steam:detect',
  setGamePath: 'steam:setGamePath',
  browseForFolder: 'dialog:folder',
  unpackPlan: 'game:unpackPlan',
  unpackGame: 'game:unpack',
  launchGame: 'game:launch',
  restoreGame: 'game:restore',
  libraryList: 'library:list',
  librarySetEnabled: 'library:setEnabled',
  librarySetOrder: 'library:setOrder',
  libraryRemove: 'library:remove',
  libraryImportFile: 'library:importFile',
  evProgress: 'event:progress',
} as const;
