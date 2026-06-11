/**
 * The three-game constant table for the FINAL FANTASY XIII trilogy Steam PC
 * ports. This replaces the original tool's `GameInfo` table (which baked in
 * Windows-only `\` separators and registry-derived install paths).
 *
 * All relative paths here use forward slashes; join them with `path.join()` at
 * use sites so they resolve correctly on every platform. The `number` field
 * (1/2/3) matches the `GameCode` used throughout the archive layer
 * (see archive/filelist.ts) and the `GameEntry=` value in `modconfig.ini`.
 */

/** Stable string identifier for each game in the trilogy. */
export type GameId = 'XIII' | 'XIII-2' | 'XIII-LR';

/** Static descriptor for one game in the trilogy. */
export interface GameInfo {
  /** Stable string id used throughout the codebase and in mod backups. */
  id: GameId;
  /** Numeric game code (1/2/3) — matches the archive `GameCode` + INI `GameEntry`. */
  number: 1 | 2 | 3;
  /** Human-readable title. */
  title: string;
  /** Steam application id (string, as Steam stores it). */
  steamAppId: string;
  /**
   * Name of the game's data-root folder under the install directory
   * (`white_data` for XIII, `alba_data` for XIII-2, `weiss_data` for LR). The
   * WhiteBin pairs (`filelist*`/`white_img*`) live under here.
   */
  dataRoot: string;
  /**
   * Name of the install folder under `steamapps/common/`. Used by Steam
   * discovery to locate the install (see game/steam.ts).
   */
  folder: string;
  /**
   * Path to the game executable, RELATIVE to the install folder, using forward
   * slashes. XIII and XIII-2 keep their exe deep under the data root; LR ships
   * the exe at the install root. Join with `path.join(installDir, exeRel)`.
   */
  exeRel: string;
}

/**
 * The canonical game table. Order matches the trilogy / numeric code.
 *
 * Verified constants from REVERSE-ENGINEERING.md §4:
 *   appids 292120 / 292140 / 345350.
 */
export const GAMES: readonly GameInfo[] = [
  {
    id: 'XIII',
    number: 1,
    title: 'FINAL FANTASY XIII',
    steamAppId: '292120',
    dataRoot: 'white_data',
    folder: 'FINAL FANTASY XIII',
    exeRel: 'white_data/prog/win/bin/ffxiiiimg.exe',
  },
  {
    id: 'XIII-2',
    number: 2,
    title: 'FINAL FANTASY XIII-2',
    steamAppId: '292140',
    dataRoot: 'alba_data',
    folder: 'FINAL FANTASY XIII-2',
    exeRel: 'alba_data/prog/win/bin/ffxiii2img.exe',
  },
  {
    id: 'XIII-LR',
    number: 3,
    title: 'LIGHTNING RETURNS: FINAL FANTASY XIII',
    steamAppId: '345350',
    dataRoot: 'weiss_data',
    folder: 'LIGHTNING RETURNS FINAL FANTASY XIII',
    exeRel: 'LRFF13.exe',
  },
] as const;

/** Look up a game by its numeric code (1/2/3). Returns undefined if unknown. */
export function getGameByNumber(n: number): GameInfo | undefined {
  return GAMES.find((g) => g.number === n);
}

/** Look up a game by its Steam application id (string). Returns undefined if unknown. */
export function getGameByAppId(appId: string): GameInfo | undefined {
  return GAMES.find((g) => g.steamAppId === appId);
}

/** Look up a game by its stable string id. Returns undefined if unknown. */
export function getGameById(id: GameId): GameInfo | undefined {
  return GAMES.find((g) => g.id === id);
}
