/**
 * Built-in community fixes bundled with open-nova (e.g. the rain-translucency
 * fix). Each lives under `assets/fixes/<id>/` with a `fix.json` manifest and a
 * `payload/` tree applied via the texture-injection installer.
 *
 * Assets are redistributed only with permission (see CREDITS.md).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuiltinFix {
  id: string;
  name: string;
  /** Mod author, shown in the library row (falls back to the bundled-fix author). */
  author?: string;
  /** Single game this fix applies to. Prefer `games` for multi-game fixes. */
  game?: string;
  /** Games this fix applies to (overrides `game` when present). */
  games?: string[];
  summary: string;
  /** 'overlay' = drop loose files into the game tree; 'texture-inject' = inject DDS into containers. */
  kind: 'texture-inject' | 'overlay';
  payload: string;
  credit: string;
  source?: string;
  /** Apply by default out of the box (e.g. FF13Fix). */
  defaultEnabled?: boolean;
  /** Always-on, always-first, cannot be disabled or removed (e.g. FF13Fix). */
  locked?: boolean;
  /** absolute path to the fix directory */
  dir: string;
}

/** The set of game ids a fix applies to. */
export function fixGames(fix: BuiltinFix): string[] {
  return fix.games ?? (fix.game ? [fix.game] : []);
}

/**
 * Directory holding the bundled fixes. Resolves from this module's location
 * (dev / CLI from source), or from `OPEN_NOVA_FIXES_DIR` when set — which the
 * Electron app points at its packaged resources, since the bundled main process
 * can't resolve the core source path.
 */
export function fixesDir(): string {
  if (process.env.OPEN_NOVA_FIXES_DIR) return process.env.OPEN_NOVA_FIXES_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'assets', 'fixes');
}

/** List the bundled fixes (reads each fix.json). */
export async function listBuiltinFixes(): Promise<BuiltinFix[]> {
  const root = fixesDir();
  let names: string[];
  try {
    names = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: BuiltinFix[] = [];
  for (const n of names) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, n, 'fix.json'), 'utf8'));
      out.push({ ...manifest, dir: path.join(root, n) });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function getBuiltinFix(id: string): Promise<BuiltinFix | null> {
  return (await listBuiltinFixes()).find((f) => f.id === id) ?? null;
}
