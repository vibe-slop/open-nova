/**
 * Selective WhiteBin repack — the optimization Nova's RepackSelective performs.
 *
 * Instead of rewriting the entire white_img payload from scratch (which moves
 * every body and shifts all offsets), this strategy edits an existing img in
 * place where possible:
 *
 *   - INJECT: if a file's new on-disk size (compressed, if the original was
 *     compressed) fits within the slot it already occupies (<= the original
 *     `cmpSize`), it is written back at its original offset (`posUnits * 0x800`)
 *     and the leftover bytes of the old slot are NUL-wiped. `posUnits` does not
 *     change, so unrelated entries keep their offsets.
 *   - APPEND: otherwise the new body is written to a 0x800-aligned position at
 *     the end of a copy of the original img, and the entry's `posUnits` is
 *     updated to point there. The stale bytes at the old offset are left as-is
 *     (the entry no longer references them).
 *
 * Either way each entry's `uncmpSize`/`cmpSize` are recomputed and the filelist
 * is rebuilt via {@link buildFilelist}.
 *
 * Mirrors NovaChrysalia.Formats.WhiteArchiveHelpers.Repack
 * (RepackProcesses.RepackTypeInject / RepackTypeAppend / CleanOldFile).
 * See docs/REVERSE-ENGINEERING.md §1.3.
 */
import { Filelist, WhiteFile, buildFilelist } from '../archive/filelist.js';
import { zlibCompress } from './zlib.js';

const ALIGN = 0x800;

/**
 * Selectively repack an archive against an existing img buffer.
 *
 * @param filelist  The parsed source filelist (its entries supply the original
 *                  offsets/sizes used to decide inject-vs-append).
 * @param getData   Supplies the (possibly modified) decompressed body for each
 *                  file, keyed by virtual path and entry. Returning the original
 *                  bytes round-trips.
 * @param originalImg  The original white_img payload to edit. Not mutated; a
 *                  copy is produced for appends.
 * @returns The rebuilt filelist buffer and the new img buffer.
 */
export function repackArchiveSelective(
  filelist: Filelist,
  getData: (virtualPath: string, file: WhiteFile) => Buffer,
  originalImg: Buffer,
): { filelist: Buffer; img: Buffer } {
  // Work on a mutable copy; appends grow it, injects overwrite in place.
  let img: Buffer = Buffer.from(originalImg);
  const newFiles: WhiteFile[] = [];

  for (const f of filelist.files) {
    const data = getData(f.virtualPath, f);
    const wasCompressed = f.uncmpSize !== f.cmpSize;

    // The bytes that will actually land in the img (compressed iff the original
    // entry was compressed), and the resulting size fields.
    const body = wasCompressed ? zlibCompress(data) : data;
    const uncmpSize = data.length;
    const cmpSize = body.length;

    if (cmpSize <= f.cmpSize) {
      // INJECT in place at the original offset; posUnits is preserved.
      const start = f.posUnits * ALIGN;
      body.copy(img, start);
      // NUL-wipe the leftover bytes of the old slot (oldCmpSize - newCmpSize).
      const leftover = f.cmpSize - cmpSize;
      if (leftover > 0) img.fill(0, start + cmpSize, start + cmpSize + leftover);

      newFiles.push({ ...f, uncmpSize, cmpSize });
    } else {
      // APPEND to the end of the img, 0x800-aligned, and update posUnits.
      img = alignBuffer(img, ALIGN);
      const posUnits = img.length / ALIGN;
      img = Buffer.concat([img, body]);

      newFiles.push({ ...f, posUnits, uncmpSize, cmpSize });
    }
  }

  const newFilelist: Filelist = { ...filelist, files: newFiles };
  return { filelist: buildFilelist(newFilelist), img };
}

/** Pad a buffer with NUL bytes up to the next multiple of `align`. */
function alignBuffer(buf: Buffer, align: number): Buffer {
  const rem = buf.length % align;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(align - rem)]);
}
