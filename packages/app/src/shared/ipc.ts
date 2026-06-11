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
  voiceJP: boolean;
  fullscreen: boolean;
  width: number | null;
  height: number | null;
  /** Explicit per-game install path overrides (when auto-detect fails). */
  gamePaths: Partial<Record<GameId, string>>;
}

export interface ModInfo {
  name: string;
  game: GameId;
  author: string;
  version: string;
  summary: string;
  installed: boolean;
  status: 'Installed' | 'Not Installed' | 'Wrong Game';
}

export interface ModInstallOptions {
  data: boolean;
  enVoice: boolean;
  jpVoice: boolean;
  external: boolean;
  code: boolean;
}

export interface GenerateModSpec {
  name: string;
  author: string;
  version: string;
  game: GameId;
  summary: string;
  dataDir?: string;
  enDataDir?: string;
  jpDataDir?: string;
  externalDir?: string;
  codeFile?: string;
  outputPath: string;
}

/** A mod in the library (staged; toggled enabled/disabled). */
export interface LibraryMod {
  modName: string;
  name: string;
  game: GameId;
  source: 'nexus' | 'local' | 'ncmp' | 'builtin';
  version: string;
  author: string;
  summary: string;
  pictureUrl?: string;
  layout: 'ncmp' | 'dataRoot' | 'bare' | 'installer' | 'texture-inject' | 'unknown';
  installable: boolean;
  enabled: boolean;
  priority: number;
  note: string;
  nexus?: { domain: string; modId: number; fileId: number };
}

export interface NexusAuth {
  hasKey: boolean;
  premium: boolean;
  userName: string | null;
  /** present after a download fails for lack of an nxm grant */
  rateLimited?: boolean;
}

/** Status pushed to the renderer as an nxm:// install proceeds. */
export interface NxmEvent {
  status: 'received' | 'downloading' | 'installed' | 'error';
  game?: GameId;
  modName?: string;
  message: string;
}

export type JobKind = 'unpack' | 'repack' | 'install' | 'uninstall' | 'import' | 'generate' | 'decrypt' | 'launch' | 'download';

export interface ProgressEvent {
  jobId: string;
  kind: JobKind;
  current: number;
  total: number;
  message: string;
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error';
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
  browseForFile(title?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;

  // Mods
  listMods(game: GameId): Promise<ModInfo[]>;
  importMod(ncmpPath: string): Promise<ModInfo[]>;
  removeMod(game: GameId, name: string): Promise<ModInfo[]>;
  installMod(game: GameId, name: string, opts: ModInstallOptions): Promise<{ ok: boolean; message: string }>;
  uninstallMod(game: GameId, name: string, opts: ModInstallOptions): Promise<{ ok: boolean; message: string }>;
  generateMod(spec: GenerateModSpec): Promise<{ ok: boolean; outputPath: string }>;

  // Archive tools
  decryptFilelist(inPath: string, outPath: string): Promise<{ ok: boolean; checksumOk: boolean }>;
  encryptFilelist(inPath: string, outPath: string): Promise<{ ok: boolean }>;
  unpackArchive(filelistPath: string, imgPath: string, outDir: string, game: GameId): Promise<{ ok: boolean; fileCount: number }>;

  // Game ops
  /** Size estimate + free-space check before unpacking (for the first-run gate). */
  getUnpackPlan(game: GameId): Promise<UnpackPlan>;
  /** Unpack the game's archives to a loose tree. `force` overrides the disk-space guard. */
  unpackGame(game: GameId, force?: boolean): Promise<{ ok: boolean; message: string }>;
  launchGame(game: GameId): Promise<{ ok: boolean; message: string }>;

  // Nexus auth
  getNexusAuth(): Promise<NexusAuth>;
  setNexusApiKey(key: string): Promise<NexusAuth>;
  clearNexusApiKey(): Promise<NexusAuth>;
  openNexusModsPage(game: GameId): Promise<void>;

  // Mod library (enable/disable model)
  libraryList(game: GameId): Promise<LibraryMod[]>;
  librarySetEnabled(game: GameId, modName: string, enabled: boolean): Promise<{ ok: boolean; message: string; mods: LibraryMod[] }>;
  librarySetOrder(game: GameId, orderedModNames: string[]): Promise<LibraryMod[]>;
  libraryRemove(game: GameId, modName: string): Promise<LibraryMod[]>;
  /** Open a file picker and import a local .zip/.7z/.rar/.ncmp into the library. */
  libraryImportFile(game: GameId): Promise<{ ok: boolean; message: string; mods: LibraryMod[] }>;
  /** Premium in-app install by Nexus mod+file id. */
  nexusInstall(game: GameId, modId: number, fileId: number): Promise<{ ok: boolean; message: string; mods: LibraryMod[] }>;

  // Events
  onProgress(cb: (e: ProgressEvent) => void): () => void;
  onLog(cb: (e: LogEvent) => void): () => void;
  onNxm(cb: (e: NxmEvent) => void): () => void;
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
  browseForFile: 'dialog:file',
  listMods: 'mods:list',
  importMod: 'mods:import',
  removeMod: 'mods:remove',
  installMod: 'mods:install',
  uninstallMod: 'mods:uninstall',
  generateMod: 'mods:generate',
  decryptFilelist: 'archive:decryptFilelist',
  encryptFilelist: 'archive:encryptFilelist',
  unpackArchive: 'archive:unpack',
  unpackPlan: 'game:unpackPlan',
  unpackGame: 'game:unpack',
  launchGame: 'game:launch',
  getNexusAuth: 'nexus:getAuth',
  setNexusApiKey: 'nexus:setKey',
  clearNexusApiKey: 'nexus:clearKey',
  openNexusModsPage: 'nexus:openPage',
  libraryList: 'library:list',
  librarySetEnabled: 'library:setEnabled',
  librarySetOrder: 'library:setOrder',
  libraryRemove: 'library:remove',
  libraryImportFile: 'library:importFile',
  nexusInstall: 'nexus:install',
  evProgress: 'event:progress',
  evLog: 'event:log',
  evNxm: 'event:nxm',
} as const;
