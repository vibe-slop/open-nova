/**
 * Cross-platform Steam / Proton discovery. This REPLACES the original tool's
 * use of the Windows registry (which read `HKCU\...\Steam\SteamPath`, the
 * active-user id, and the per-game "Running" flag) with portable filesystem
 * probing that works on Linux, the Steam Deck, macOS and Windows.
 *
 * Strategy (per docs/ARCHITECTURE.md, "Windows-dependency inventory"):
 *   - Probe the well-known Steam root directories for the current platform.
 *   - Hand-parse `steamapps/libraryfolders.vdf` to enumerate every library
 *     (Steam can split installs across several drives / SD cards).
 *   - Look for `<library>/steamapps/common/<folder>` to find a game install.
 *   - Enumerate `<root>/userdata/*` for the active user (skipping the `0` and
 *     `anonymous` pseudo-accounts).
 *
 * Everything here is async (fs.promises) and tolerant of missing files — a
 * machine may have no Steam at all, or a Steam with no FFXIII installed.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GameInfo } from './gameinfo.js';

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Candidate Steam-root directories for the current platform, in priority order.
 * The first one that actually contains a `steamapps` directory wins.
 */
function candidateSteamRoots(): string[] {
  switch (process.platform) {
    case 'linux':
      // Native, classic, and Flatpak install layouts.
      return [
        '~/.steam/steam',
        '~/.local/share/Steam',
        '~/.var/app/com.valvesoftware.Steam/.local/share/Steam',
        '~/.steam/root',
      ].map(expandHome);
    case 'darwin':
      return ['~/Library/Application Support/Steam'].map(expandHome);
    case 'win32':
      // No registry read; fall back to the conventional install location.
      // (Steam can be installed elsewhere on Windows — a future enhancement
      // could read the registry behind a `win32`-only guard.)
      return ['C:/Program Files (x86)/Steam'];
    default:
      return [];
  }
}

/** True if `dir` exists and is a directory. */
async function isDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate the active Steam installation root, or null if none is found.
 * A directory qualifies only if it contains a `steamapps` subfolder.
 */
export async function findSteamRoot(): Promise<string | null> {
  for (const root of candidateSteamRoots()) {
    if (await isDir(path.join(root, 'steamapps'))) {
      return root;
    }
  }
  return null;
}

/**
 * Minimal VDF (Valve KeyValues) parser for `libraryfolders.vdf`, which has the
 * shape:
 *
 *   "libraryfolders"
 *   {
 *     "0"
 *     {
 *       "path"  "/home/deck/.steam/steam"
 *       ...
 *     }
 *     "1" { "path" "/run/media/sdcard/SteamLibrary" ... }
 *   }
 *
 * We only need each numeric top-level child's `path` value, so rather than
 * building a full tree we tokenize the quoted strings and brace structure and
 * pick out the `path` value inside each numeric block. This avoids pulling in a
 * VDF dependency (the original used `Gameloop.Vdf`).
 *
 * Returns the list of library paths in file order. Unknown / malformed input
 * yields an empty list rather than throwing.
 */
export function parseLibraryFoldersVdf(text: string): string[] {
  // Tokenize into quoted strings and the brace punctuation `{` / `}`.
  type Token = { kind: 'str'; value: string } | { kind: 'open' } | { kind: 'close' };
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          // Handle escaped chars (notably `\\` in Windows paths).
          const next = text[j + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          value += text[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'str', value });
      i = j + 1;
    } else if (ch === '{') {
      tokens.push({ kind: 'open' });
      i += 1;
    } else if (ch === '}') {
      tokens.push({ kind: 'close' });
      i += 1;
    } else {
      // Whitespace / anything else: skip.
      i += 1;
    }
  }

  const paths: string[] = [];
  // Walk tokens; depth 1 = inside "libraryfolders" block, depth 2 = inside a
  // numeric block. When we are at depth 2 and see a `"path"` key followed by a
  // string value, capture it.
  let depth = 0;
  let inNumericBlock = false;
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === 'open') {
      depth += 1;
      continue;
    }
    if (tok.kind === 'close') {
      if (depth === 2) inNumericBlock = false;
      depth -= 1;
      continue;
    }
    // A string token.
    if (depth === 1) {
      // Top-level key inside "libraryfolders". The numeric ones precede a block.
      const next = tokens[t + 1];
      if (/^\d+$/.test(tok.value) && next && next.kind === 'open') {
        inNumericBlock = true;
      }
    } else if (depth === 2 && inNumericBlock && tok.value === 'path') {
      const next = tokens[t + 1];
      if (next && next.kind === 'str') {
        paths.push(next.value);
        t += 1; // consume the value
      }
    }
  }
  return paths;
}

/**
 * Enumerate every Steam library directory for the given Steam root. Always
 * includes the root itself (Steam's primary library) plus every `path` listed
 * in `steamapps/libraryfolders.vdf`. Missing / unreadable VDF is tolerated.
 *
 * Returned paths are de-duplicated, preserving order.
 */
export async function parseLibraryFolders(steamRoot: string): Promise<string[]> {
  const libs: string[] = [steamRoot];
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  try {
    const text = await fs.readFile(vdfPath, 'utf8');
    for (const p of parseLibraryFoldersVdf(text)) libs.push(p);
  } catch {
    // No libraryfolders.vdf (or unreadable) — just use the root.
  }
  // De-duplicate, preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of libs) {
    const norm = path.normalize(l);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(l);
    }
  }
  return out;
}

/**
 * Find a game's install directory by scanning every Steam library for
 * `steamapps/common/<game.folder>`. Returns the absolute install directory, or
 * null if the game is not installed in any discoverable library.
 *
 * Steam discovery is automatic: pass `steamRoot` to skip re-probing.
 */
export async function findGameInstall(
  game: GameInfo,
  steamRoot?: string,
): Promise<string | null> {
  const root = steamRoot ?? (await findSteamRoot());
  if (!root) return null;
  const libs = await parseLibraryFolders(root);
  const candidates: string[] = [];
  for (const lib of libs) {
    const candidate = path.join(lib, 'steamapps', 'common', game.folder);
    if (await isDir(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 0) return null;
  // Prefer a candidate that actually contains the game's data root. Steam can
  // leave a STUB install folder (just setup.xml) in the internal library while
  // the real files live on an SD card — picking the first match would find the
  // stub. Fall back to the first folder if none has the data root yet.
  for (const c of candidates) {
    if (await isDir(path.join(c, game.dataRoot))) return c;
  }
  return candidates[0];
}

/**
 * Find the active Steam user's account id by enumerating `<root>/userdata/*`.
 * The `0` and `anonymous` entries are Steam's pseudo-accounts and are skipped.
 *
 * When several real accounts exist we return the most-recently-modified one as
 * a best-effort "active user" heuristic (the original read this from the
 * registry's `AutoLoginUser`, which has no portable equivalent). Returns null
 * if no real account directory is present.
 */
export async function findActiveSteamUser(steamRoot: string): Promise<string | null> {
  const userdata = path.join(steamRoot, 'userdata');
  let entries: string[];
  try {
    entries = await fs.readdir(userdata);
  } catch {
    return null;
  }
  const candidates: { id: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (name === '0' || name === 'anonymous') continue;
    if (!/^\d+$/.test(name)) continue;
    const full = path.join(userdata, name);
    try {
      const st = await fs.stat(full);
      if (st.isDirectory()) candidates.push({ id: name, mtimeMs: st.mtimeMs });
    } catch {
      // Ignore unreadable entries.
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].id;
}
