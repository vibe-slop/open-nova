/**
 * Auto-detect the layout of an extracted mod folder and produce a flat
 * "provides" map (relative-path-under-the-game-data-root -> source file) that
 * the deployment ledger can apply — with no per-mod configuration.
 *
 * FF13 Nexus mods have no standard manifest, so we infer the layout:
 *   - a Nova `.ncmp` style pack (has modconfig.ini + Data/...),
 *   - a tree rooted at a game data-root folder (alba_data/white_data/weiss_data),
 *   - a "bare" tree whose top-level dirs are known data-root children (sys/, etc.),
 *   - a Windows `.bat`/`.exe` installer pack (can't be auto-applied on Linux).
 *
 * Wrapper folders (a single nested dir, as many archives have) are unwrapped
 * automatically.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Known game data-root folder names. */
export const DATA_ROOTS = ['alba_data', 'white_data', 'weiss_data'];

/** Top-level directories that appear directly under a game data root. */
export const DATA_ROOT_CHILDREN = new Set([
  'sys', 'zone', 'movie', 'udp', 'chr', 'txt', 'gui', 'map', 'sound', 'db',
  'event', 'battle', 'menu', 'image', 'fa', 'npc', 'pc', 'mon', 'weapon',
]);

const NOVA_OVERLAY_DIRS = ['Data', 'EN-Data', 'JP-Data'];

export type ModLayout = 'ncmp' | 'dataRoot' | 'bare' | 'installer' | 'unknown';

export interface DetectedMod {
  layout: ModLayout;
  /** relative-path-under-data-root -> absolute source file. Empty for installer/unknown. */
  files: Map<string, string>;
  /** The directory we determined the mod content is rooted at (after unwrapping). */
  contentRoot: string;
  /** Human-readable note (e.g. why it can't be auto-installed). */
  note: string;
  /** True when this can be enabled directly; false needs manual handling. */
  installable: boolean;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDir(p: string): Promise<{ dirs: string[]; files: string[] }> {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of await fs.readdir(p, { withFileTypes: true })) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  return { dirs, files };
}

async function walkInto(root: string, dir: string, out: Map<string, string>): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkInto(root, full, out);
    else if (e.isFile()) out.set(path.relative(root, full).split(path.sep).join('/'), full);
  }
}

/** Any Windows executable/script at the top level marks an installer-style mod. */
const INSTALLER_EXT = /\.(bat|exe|cmd)$/i;

/** Inspect an extracted mod directory and infer how to deploy it. */
export async function detectMod(extractedDir: string): Promise<DetectedMod> {
  let root = extractedDir;

  // Unwrap single-folder wrappers (e.g. archive contains one top dir), but stop
  // if the single folder is itself meaningful (a data root or Nova overlay).
  for (let i = 0; i < 8; i++) {
    const { dirs, files } = await listDir(root);
    if (files.length === 0 && dirs.length === 1) {
      const only = dirs[0];
      // Stop unwrapping if the single folder is itself meaningful: a data root,
      // a Nova overlay dir, or a data-root child (e.g. `sys/`) — descending into
      // it would discard the structure we need.
      if (
        DATA_ROOTS.includes(only.toLowerCase()) ||
        NOVA_OVERLAY_DIRS.includes(only) ||
        DATA_ROOT_CHILDREN.has(only.toLowerCase())
      ) {
        break;
      }
      root = path.join(root, only);
      continue;
    }
    break;
  }

  const { dirs, files } = await listDir(root);
  const lowerFiles = files.map((f) => f.toLowerCase());
  const dirSet = new Set(dirs);

  // 1) Nova .ncmp style: modconfig.ini + overlay dirs.
  if (lowerFiles.includes('modconfig.ini') || NOVA_OVERLAY_DIRS.some((d) => dirSet.has(d))) {
    const map = new Map<string, string>();
    for (const d of NOVA_OVERLAY_DIRS) {
      const dir = path.join(root, d);
      if (await isDir(dir)) await walkInto(dir, dir, map);
    }
    return { layout: 'ncmp', files: map, contentRoot: root, note: 'Nova ModPack layout.', installable: map.size > 0 };
  }

  // 2) Rooted at a game data-root folder: strip that prefix.
  const dataRootDir = dirs.find((d) => DATA_ROOTS.includes(d.toLowerCase()));
  if (dataRootDir) {
    const map = new Map<string, string>();
    const dir = path.join(root, dataRootDir);
    await walkInto(dir, dir, map);
    return { layout: 'dataRoot', files: map, contentRoot: dir, note: `Rooted at ${dataRootDir}/.`, installable: map.size > 0 };
  }

  // 3) Windows installer/patcher pack — a .bat/.exe/.cmd (or SupportFiles dir).
  //    These repack the archives in-place via Windows tools, so a loose-file
  //    overlay can't apply them on Linux.
  const installerFile = files.find((f) => INSTALLER_EXT.test(f));
  if (installerFile || dirSet.has('SupportFiles')) {
    return {
      layout: 'installer',
      files: new Map(),
      contentRoot: root,
      note: `Windows patcher (${installerFile ?? 'SupportFiles'}); run it under Wine/Proton, or use a pre-repacked release. Not auto-installable as loose files.`,
      installable: false,
    };
  }

  // 4) Bare tree whose top-level dirs look like data-root children.
  const knownChildren = dirs.filter((d) => DATA_ROOT_CHILDREN.has(d.toLowerCase()));
  if (knownChildren.length > 0) {
    const map = new Map<string, string>();
    await walkInto(root, root, map);
    return {
      layout: 'bare',
      files: map,
      contentRoot: root,
      note: `Loose-file tree (top-level: ${knownChildren.join(', ')}).`,
      installable: map.size > 0,
    };
  }

  return {
    layout: 'unknown',
    files: new Map(),
    contentRoot: root,
    note: 'Could not determine layout. Inspect the files and place them under a Data/ folder, or report the mod.',
    installable: false,
  };
}
