/**
 * In-container texture-mod installer (Tier B).
 *
 * Many FFXIII texture mods (and the Leviathan's Tears rain fix) ship edited DDS
 * textures destined for individual entries INSIDE a packed container, using the
 * convention a payload directory mirrors the game tree with an `_<container>`
 * folder holding the replacement `<entry>.dds` files, e.g.
 *
 *   vfx/field/weather/weather07/_veffs.jp.win32.imgb/v8cc….vtex.dds
 *
 * meaning "inject v8cc….vtex into vfx/field/weather/weather07/veffs.jp.win32.imgb".
 *
 * This walks such a payload, finds each container's `.imgb` + its paired header
 * (the WhiteBin header block: .xfv/.wpd/.xwb/.wpk/.xgr/.wdb, or a .trb), injects
 * the DDS via {@link repackImgbInPlace} (same-size, validated on real data), and
 * backs up the original imgb once so the change is reversible.
 *
 * Requires the game in unpacked mode (the loose containers present under
 * `whitePath`). Validated end-to-end against a real FFXIII-2 weather container.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unpackWpd } from '../formats/wpd.js';
import { unpackTrb } from '../formats/trb.js';
import { repackImgbInPlace } from '../formats/imgb.js';

export const HEADER_EXTS = ['.xfv', '.wpd', '.xwb', '.wpk', '.xgr', '.wdb', '.trb'];

/** A single injection: replace `entryName` inside the container at `containerRel` with `ddsPath`. */
export interface ContainerInjection {
  containerRel: string;
  entryName: string;
  ddsPath: string;
}

export interface TextureInjectResult {
  /** container imgb relative path */
  container: string;
  entry: string;
  ok: boolean;
  message: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Find every `_<container>/<entry>.dds` under a payload dir. */
export async function listContainerInjections(payloadDir: string): Promise<ContainerInjection[]> {
  return findInjections(payloadDir);
}

/** Resolve a container imgb's paired header file (.xfv/.wpd/.trb…). */
export async function findHeaderPath(imgbPath: string): Promise<{ path: string; ext: string } | null> {
  const dir = path.dirname(imgbPath);
  const baseNoImgb = path.basename(imgbPath).replace(/\.imgb$/i, '');
  for (const ext of HEADER_EXTS) {
    const cand = path.join(dir, baseNoImgb + ext);
    if (await exists(cand)) return { path: cand, ext };
  }
  return null;
}

/** Inject an edited DDS into an imgb buffer (pure). Returns the new imgb buffer. */
export function injectIntoImgb(headerBuf: Buffer, headerExt: string, imgb: Buffer, entryName: string, dds: Buffer): Buffer {
  const block = findEntry(headerBuf, headerExt, entryName);
  if (!block) throw new Error(`entry not found in container header: ${entryName}`);
  return repackImgbInPlace(block, imgb, dds);
}

async function findInjections(payloadDir: string): Promise<ContainerInjection[]> {
  const out: ContainerInjection[] = [];
  async function rec(dir: string): Promise<void> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('_')) {
          // _<container> folder: every .dds inside targets an entry in <container>.
          const containerName = e.name.slice(1);
          const containerRel = path.relative(payloadDir, path.join(path.dirname(full), containerName)).split(path.sep).join('/');
          for (const f of await fs.readdir(full, { withFileTypes: true })) {
            if (f.isFile() && f.name.toLowerCase().endsWith('.dds')) {
              out.push({ ddsPath: path.join(full, f.name), containerRel, entryName: f.name.replace(/\.dds$/i, '') });
            }
          }
        } else {
          await rec(full);
        }
      }
    }
  }
  await rec(payloadDir);
  return out;
}

/** Locate a container's header block for an entry name, across WPD/TRB formats. */
function findEntry(headerBuf: Buffer, ext: string, entryName: string): Buffer | null {
  const entries = (ext === '.trb' ? (unpackTrb(headerBuf).entries ?? []) : (unpackWpd(headerBuf).entries ?? [])) as Array<{
    name: string;
    ext?: string;
    data: Buffer;
  }>;
  // DDS name is like "v8cc….vtex"; WPD entry name is the hash ("v8cc…") with ext "vtex".
  const base = entryName.replace(/\.[^.]+$/, '');
  const e =
    entries.find((x) => String(x.name) === entryName) ??
    entries.find((x) => `${x.name}.${x.ext ?? ''}` === entryName) ??
    entries.find((x) => String(x.name) === base) ??
    entries.find((x) => entryName.startsWith(String(x.name)) && String(x.name).length > 4);
  return e?.data ?? null;
}

/**
 * Apply a texture-injection payload onto an unpacked game tree. Backs up each
 * modified imgb to `backupDir/<rel>` (once) for reversibility.
 */
export async function injectContainerTextures(
  payloadDir: string,
  whitePath: string,
  backupDir?: string,
): Promise<TextureInjectResult[]> {
  const jobs = await findInjections(payloadDir);
  const results: TextureInjectResult[] = [];

  // Group by container so each imgb is read/written once even with many entries.
  const byContainer = new Map<string, typeof jobs>();
  for (const j of jobs) (byContainer.get(j.containerRel) ?? byContainer.set(j.containerRel, []).get(j.containerRel)!).push(j);

  for (const [containerRel, items] of byContainer) {
    const imgbPath = path.join(whitePath, ...containerRel.split('/'));
    if (!(await exists(imgbPath))) {
      for (const it of items) results.push({ container: containerRel, entry: it.entryName, ok: false, message: 'container .imgb not found (game unpacked?)' });
      continue;
    }
    // Find the paired header (same basename, header ext).
    const dir = path.dirname(imgbPath);
    const baseNoImgb = path.basename(imgbPath).replace(/\.imgb$/i, '');
    let headerPath: string | null = null;
    let headerExt = '';
    for (const ext of HEADER_EXTS) {
      const cand = path.join(dir, baseNoImgb + ext);
      if (await exists(cand)) { headerPath = cand; headerExt = ext; break; }
    }
    if (!headerPath) {
      for (const it of items) results.push({ container: containerRel, entry: it.entryName, ok: false, message: 'paired header (.xfv/.wpd/.trb…) not found' });
      continue;
    }

    const header = await fs.readFile(headerPath);
    let imgb: Buffer = await fs.readFile(imgbPath);
    // Back up the original imgb once.
    if (backupDir) {
      const bak = path.join(backupDir, ...containerRel.split('/'));
      if (!(await exists(bak))) {
        await fs.mkdir(path.dirname(bak), { recursive: true });
        await fs.writeFile(bak, imgb);
      }
    }
    for (const it of items) {
      try {
        const block = findEntry(header, headerExt, it.entryName);
        if (!block) { results.push({ container: containerRel, entry: it.entryName, ok: false, message: 'entry not found in container header' }); continue; }
        const dds = await fs.readFile(it.ddsPath);
        imgb = repackImgbInPlace(block, imgb, dds);
        results.push({ container: containerRel, entry: it.entryName, ok: true, message: 'injected' });
      } catch (err) {
        results.push({ container: containerRel, entry: it.entryName, ok: false, message: (err as Error).message });
      }
    }
    await fs.writeFile(imgbPath, imgb);
  }
  return results;
}

/** Restore the original imgb files from backups (undo an injection). */
export async function restoreContainerTextures(payloadDir: string, whitePath: string, backupDir: string): Promise<number> {
  const jobs = await findInjections(payloadDir);
  const containers = new Set(jobs.map((j) => j.containerRel));
  let restored = 0;
  for (const rel of containers) {
    const bak = path.join(backupDir, ...rel.split('/'));
    const live = path.join(whitePath, ...rel.split('/'));
    if (await exists(bak)) {
      await fs.copyFile(bak, live);
      await fs.rm(bak, { force: true });
      restored++;
    }
  }
  return restored;
}
