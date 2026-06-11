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
import { injectContainerTextures, restoreContainerTextures, type TextureInjectResult } from './texture-inject.js';

export interface BuiltinFix {
  id: string;
  name: string;
  game: string;
  summary: string;
  /** 'overlay' = drop loose files into the game tree; 'texture-inject' = inject DDS into containers. */
  kind: 'texture-inject' | 'overlay';
  payload: string;
  credit: string;
  source?: string;
  /** Apply by default out of the box (e.g. FF13Fix). */
  defaultEnabled?: boolean;
  /** absolute path to the fix directory */
  dir: string;
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

/** Apply a bundled texture-inject fix onto an unpacked game tree. */
export async function applyBuiltinFix(fix: BuiltinFix, whitePath: string, backupDir?: string): Promise<TextureInjectResult[]> {
  if (fix.kind !== 'texture-inject') throw new Error(`unsupported fix kind: ${fix.kind}`);
  return injectContainerTextures(path.join(fix.dir, fix.payload), whitePath, backupDir);
}

/** Remove a bundled fix (restore originals from backup). */
export async function removeBuiltinFix(fix: BuiltinFix, whitePath: string, backupDir: string): Promise<number> {
  return restoreContainerTextures(path.join(fix.dir, fix.payload), whitePath, backupDir);
}
