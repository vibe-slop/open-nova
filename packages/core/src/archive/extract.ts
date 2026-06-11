/**
 * Cross-platform archive extraction dispatcher. Nexus mods are distributed as
 * `.zip`, `.7z`, and `.rar` (and our own `.ncmp` packs, which are plain ZIPs).
 * This module routes each container to the right extractor WITHOUT shelling out
 * to any system tool (no `unzip`, `7z`, or `unrar` binary required):
 *
 *   - `.zip` / `.ncmp` → our pure-Node ZIP reader (`extractNcmp`), zero deps.
 *   - `.7z`            → the optional WASM package `7z-wasm` (loaded lazily).
 *   - `.rar`           → the optional WASM package `node-unrar-js` (lazy).
 *
 * The 7z and RAR paths live behind dynamic `import()` so the package builds and
 * the (overwhelmingly common) ZIP path works with ZERO extra dependencies. The
 * optional WASM libraries are only required at runtime when a `.7z` / `.rar` is
 * actually encountered; the integrator installs them in the Electron app via
 * `optionalDependencies`. If a needed package is missing, a clear, actionable
 * error naming the install command is thrown.
 *
 * See docs/REVERSE-ENGINEERING.md §3 (the `.ncmp`/ZIP format) and the mod
 * installer flow in `mods/manager.ts`.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { extractNcmp } from '../mods/ncmp.js';

/** Archive containers we can dispatch on. `unknown` = unrecognised extension. */
export type ArchiveType = 'zip' | '7z' | 'rar' | 'unknown';

/**
 * Classify an archive purely by its file extension (case-insensitive). `.ncmp`
 * (our ModPack format) is a plain ZIP and is reported as `'zip'`. Anything we do
 * not recognise is `'unknown'`.
 */
export function detectArchiveType(filePath: string): ArchiveType {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.zip':
    case '.ncmp':
      return 'zip';
    case '.7z':
      return '7z';
    case '.rar':
      return 'rar';
    default:
      return 'unknown';
  }
}

/**
 * Extract `archivePath` into `destDir`, recreating the archive's folder tree.
 * The container type is detected by extension (see {@link detectArchiveType})
 * and dispatched to the appropriate extractor:
 *
 *   - ZIP/`.ncmp`: handled in-process by {@link extractNcmp} (no dependencies).
 *   - 7z / RAR: handled by an optional WASM package, loaded on demand. If the
 *     package is not installed, a clear `Error` is thrown naming the `npm i`
 *     command to run.
 *
 * `destDir` is created (recursively) before extraction. Throws for unknown
 * extensions, listing the supported types.
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const type = detectArchiveType(archivePath);
  switch (type) {
    case 'zip':
      // `.zip` and `.ncmp` share the same PKZIP layout — reuse the native
      // reader, which handles STORE + DEFLATE entries and nested folders.
      await extractNcmp(archivePath, destDir);
      return;
    case '7z':
      await extract7z(archivePath, destDir);
      return;
    case 'rar':
      await extractRar(archivePath, destDir);
      return;
    case 'unknown':
    default:
      throw new Error(
        `unsupported archive type for "${archivePath}" — supported extensions are ` +
          `.zip, .ncmp, .7z, .rar`,
      );
  }
}

// ---------------------------------------------------------------------------
// 7z — optional dependency `7z-wasm`
// ---------------------------------------------------------------------------

/**
 * Extract a `.7z` archive using the optional `7z-wasm` package.
 *
 * Wiring (the integrator installs this as an `optionalDependency` in the app):
 *   1. `npm i 7z-wasm`.
 *   2. The package's default export is an Emscripten factory:
 *      `SevenZipFactory(opts?) => Promise<module>`.
 *   3. The module exposes an in-memory virtual filesystem (`module.FS`, an
 *      Emscripten MEMFS). We write the archive bytes into it, then drive the
 *      7-Zip CLI via `module.callMain(['x', archive, '-o<dir>', '-y'])`
 *      (`x` = extract with full paths, `-o` = output dir, `-y` = assume yes).
 *   4. We walk the output directory inside the virtual FS and copy every file
 *      back out to the real `destDir` on disk.
 *
 * The dynamic import is wrapped so a missing package surfaces as a clear,
 * actionable error rather than a raw module-resolution failure.
 */
async function extract7z(archivePath: string, destDir: string): Promise<void> {
  // Typed as `any`: the package may not be installed, so we must NOT add a
  // static import. The specifier is routed through a variable so TypeScript
  // does not try to resolve the (possibly absent) module at compile time —
  // the file must still typecheck/compile with zero extra deps.
  let mod: any;
  try {
    const specifier = '7z-wasm';
    mod = await import(specifier);
  } catch {
    throw new Error(
      "7z extraction needs the optional dependency '7z-wasm' — run: npm i 7z-wasm",
    );
  }

  const SevenZip: (opts?: unknown) => Promise<any> = mod.default ?? mod;
  const sevenZip = await SevenZip();

  const data = await fs.readFile(archivePath);

  // Lay out a clean work area inside the WASM in-memory FS.
  const inName = 'input.7z';
  const outDir = 'out';
  sevenZip.FS.writeFile(inName, data);
  sevenZip.FS.mkdir(outDir);

  // `x` keeps the stored directory structure; `-y` auto-confirms prompts.
  sevenZip.callMain(['x', inName, `-o${outDir}`, '-y']);

  await fs.mkdir(destDir, { recursive: true });
  await copyOutOfWasmFs(sevenZip.FS, outDir, destDir);
}

/**
 * Recursively copy a directory out of an Emscripten virtual FS to a real
 * directory on disk. `relParts` accumulates the path under `fsDir` so we
 * faithfully recreate nested folders inside `destDir`.
 */
async function copyOutOfWasmFs(
  FS: any,
  fsDir: string,
  destDir: string,
  relParts: string[] = [],
): Promise<void> {
  const here = relParts.length ? `${fsDir}/${relParts.join('/')}` : fsDir;
  const names: string[] = FS.readdir(here).filter((n: string) => n !== '.' && n !== '..');
  for (const name of names) {
    const fsPath = `${here}/${name}`;
    const stat = FS.stat(fsPath);
    // Emscripten exposes POSIX mode bits + `FS.isDir`/`FS.isFile` helpers.
    if (FS.isDir(stat.mode)) {
      await copyOutOfWasmFs(FS, fsDir, destDir, [...relParts, name]);
    } else {
      const bytes: Uint8Array = FS.readFile(fsPath);
      const outPath = path.join(destDir, ...relParts, name);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, Buffer.from(bytes));
    }
  }
}

// ---------------------------------------------------------------------------
// RAR — optional dependency `node-unrar-js`
// ---------------------------------------------------------------------------

/**
 * Extract a `.rar` archive using the optional `node-unrar-js` package.
 *
 * Wiring (the integrator installs this as an `optionalDependency` in the app):
 *   1. `npm i node-unrar-js`.
 *   2. Call `createExtractorFromData({ data })` (async) with the archive bytes
 *      to get an extractor backed by the bundled unrar WASM.
 *   3. `extractor.extract()` returns `{ files }`, a lazy iterable; iterating it
 *      is what actually performs decompression. Each item has a `fileHeader`
 *      (`{ name, flags: { directory } }`) and an `extraction` `Uint8Array`
 *      (absent for directory entries).
 *   4. We write each extracted file under `destDir`, recreating folders and
 *      sanitising entry names so extraction stays inside `destDir`.
 *
 * The dynamic import is wrapped so a missing package surfaces as a clear,
 * actionable error rather than a raw module-resolution failure.
 */
async function extractRar(archivePath: string, destDir: string): Promise<void> {
  // Typed as `any`: the package may not be installed, so we must NOT add a
  // static import. The specifier is routed through a variable so TypeScript
  // does not try to resolve the (possibly absent) module at compile time —
  // the file must still typecheck/compile with zero extra deps.
  let mod: any;
  try {
    const specifier = 'node-unrar-js';
    mod = await import(specifier);
  } catch {
    throw new Error(
      "RAR extraction needs the optional dependency 'node-unrar-js' — run: npm i node-unrar-js",
    );
  }

  const createExtractorFromData: (opts: { data: ArrayBufferLike }) => Promise<any> =
    mod.createExtractorFromData ?? mod.default?.createExtractorFromData;

  const fileBuf = await fs.readFile(archivePath);
  // node-unrar-js expects an ArrayBuffer; hand it a tight copy of our bytes.
  const arrayBuffer = fileBuf.buffer.slice(
    fileBuf.byteOffset,
    fileBuf.byteOffset + fileBuf.byteLength,
  );
  const extractor = await createExtractorFromData({ data: arrayBuffer });

  // Iterating `files` is what drives decompression (it is a lazy generator).
  const result = extractor.extract();
  await fs.mkdir(destDir, { recursive: true });

  for (const file of result.files) {
    const header = file.fileHeader;
    const rel = sanitizeRelPath(header.name);
    if (rel === '') continue;
    const outPath = path.join(destDir, rel);
    if (header.flags?.directory) {
      await fs.mkdir(outPath, { recursive: true });
      continue;
    }
    if (!file.extraction) continue; // defensive: skip entries with no payload
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, Buffer.from(file.extraction));
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a `\`/`/`-separated archive entry name and strip leading slashes
 * plus any `.`/`..` traversal segments so extraction can never escape the
 * destination directory.
 */
function sanitizeRelPath(name: string): string {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .join('/');
}
