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

export type JobKind = 'unpack' | 'repack' | 'install' | 'uninstall' | 'import' | 'generate' | 'decrypt' | 'launch';

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
  unpackGame(game: GameId): Promise<{ ok: boolean; message: string }>;
  launchGame(game: GameId): Promise<{ ok: boolean; message: string }>;

  // Events
  onProgress(cb: (e: ProgressEvent) => void): () => void;
  onLog(cb: (e: LogEvent) => void): () => void;
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
  unpackGame: 'game:unpack',
  launchGame: 'game:launch',
  evProgress: 'event:progress',
  evLog: 'event:log',
} as const;
