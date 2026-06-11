/**
 * IMGB Repack2 — resize-capable texture repack (the TRB variant).
 *
 * Where {@link repackImgbInPlace} (the strict/WPD path) forbids changing a
 * texture's dimensions, Repack2 rebuilds the `.imgb` blob from scratch so the
 * replacement DDS may differ in size, mip count, and format from the original.
 * It mirrors `NovaChrysalia.Formats.IMGB.Repack.IMGBRepack2Types.RepackClassicType`.
 *
 * The header block carries both the GTEX chunk AND the mip offset table; the
 * pixels live in the paired `.imgb`. We:
 *   1. (if the DDS has MORE mips than the original) grow the offset table by
 *      appending 8 zero bytes per extra mip to the end of the header block, then
 *      record the new header-block length as a u32 LE at absolute offset 16
 *      (`ExtraMipsOffsets`);
 *   2. rewrite GTEX fmt@+6, mipcount@+7, width@+10 (BE u16), height@+12 (BE u16);
 *   3. for each output mip: compute its size for the format (`ComputeMipSizes`),
 *      write start/size (BE u32, 8 bytes/entry) into the table at GtexStart+24,
 *      append the mip's pixels to a fresh imgb, pad the imgb to a 16-byte minimum
 *      per mip (`PadNullsForLastMips`), then halve the working dimensions
 *      (`NextMipHeightWidth`).
 *
 * Win32 only (PS3/x360 imgb repacking is unsupported by the original). Cubemap
 * (type 1/5) and stack (type 2) are deferred — see {@link repackImgbResize}.
 *
 * @see /Users/danielgriffiths/nova_decompiled/NovaChrysalia/NovaChrysalia.Formats.IMGB.Repack/IMGBRepack2Types.cs
 */
import { locateGtex, parseGtex } from './gtex.js';
import { parseDdsHeader, ddsPixels } from './dds.js';

/** Round `n` up to the next multiple of 4 (matches `n += (4 - n % 4) % 4`). */
function ceil4(n: number): number {
  return n + ((4 - (n % 4)) % 4);
}

/**
 * Mutable working state for the output texture, mirroring the
 * `OutImg*` fields the original mutates across `ComputeMipSizes` /
 * `NextMipHeightWidth`.
 */
interface OutState {
  format: number;
  width: number;
  height: number;
}

/**
 * Compute the byte size of the current mip for the given format, mutating
 * `s.width`/`s.height` for DXT formats (rounded up to a multiple of 4 in place,
 * exactly as the original does before the size math). Mirrors `ComputeMipSizes`.
 *
 * - fmt 3/4 (A8R8G8B8): `H * W * 4`
 * - fmt 24 (DXT1): `ceil4(H) * ceil4(W) / 2`
 * - fmt 25/26 (DXT3/DXT5): `ceil4(H) * ceil4(W)`
 */
function computeMipSize(s: OutState): number {
  switch (s.format) {
    case 3:
    case 4:
      return s.height * s.width * 4;
    case 24:
      s.height = ceil4(s.height);
      s.width = ceil4(s.width);
      return (s.height * s.width * 4) / 8;
    case 25:
    case 26:
      s.height = ceil4(s.height);
      s.width = ceil4(s.width);
      return (s.height * s.width * 4) / 4;
    default:
      throw new Error(`unsupported output format ${s.format}`);
  }
}

/**
 * Halve the working dimensions for the next mip. Mirrors `NextMipHeightWidth`:
 * uncompressed (fmt 3) clamps at 1, everything else clamps at 4.
 */
function nextMipHeightWidth(s: OutState): void {
  if (s.format !== 3) {
    s.height = Math.floor(s.height / 2);
    if (s.height < 4) s.height = 4;
    s.width = Math.floor(s.width / 2);
    if (s.width < 4) s.width = 4;
    return;
  }
  // fmt 3: halve down to a minimum of 1.
  s.height = s.height === 1 ? 1 : Math.floor(s.height / 2);
  s.width = s.width === 1 ? 1 : Math.floor(s.width / 2);
}

/** Result of a resize-capable repack: the (possibly grown) header + fresh imgb. */
export interface RepackResizeResult {
  /** Header block with rewritten GTEX fields, mip table, and (if grown) extra offsets. */
  header: Buffer;
  /** Freshly rebuilt imgb blob with mips appended sequentially. */
  imgb: Buffer;
}

/**
 * Rebuild a CLASSIC (type 0/4) texture's imgb from a replacement DDS that may
 * differ in dimensions, mip count, or format from the original. Returns the
 * edited header block and the fresh imgb.
 *
 * @param headerBlock The image header block (`.txb`/`.txbh`/`.vtex`) holding the
 *   GTEX chunk and mip offset table.
 * @param newDds The replacement DDS (128-byte header + pixels) at the new size.
 * @throws If the block has no GTEX chunk, the DDS pixel format is unsupported,
 *   or the texture is a cubemap/stack (deferred).
 */
export function repackImgbResize(headerBlock: Buffer, newDds: Buffer): RepackResizeResult {
  const start = locateGtex(headerBlock);
  if (start < 0) throw new Error('header block has no GTEX chunk');
  const g = parseGtex(headerBlock, start);

  if (g.type === 1 || g.type === 5) {
    throw new Error('repackImgbResize: cubemap (type 1/5) is deferred — not yet implemented');
  }
  if (g.type === 2) {
    throw new Error('repackImgbResize: stack (type 2) is deferred — not yet implemented');
  }
  if (g.type !== 0 && g.type !== 4) {
    throw new Error(`repackImgbResize: unsupported GTEX image type ${g.type}`);
  }

  const dds = parseDdsHeader(newDds);
  if (dds.format === 0) {
    throw new Error('repackImgbResize: DDS is in an unsupported pixel format');
  }

  // Mutable copy of the header block (we may grow it for extra mips).
  let header = Buffer.from(headerBlock);
  const pixels = ddsPixels(newDds);

  const origMips = g.mipCount; // GtexImgMipCount (>=1)
  const newMips = dds.mipCount; // OutImgMipCount

  // 1. Grow the offset table when the new DDS has more mips than the original:
  //    append 8 zero bytes per extra mip to the END of the header block, then
  //    record the new header-block length as a u32 LE at absolute offset 16.
  if (origMips < newMips) {
    const extra = (newMips - origMips) * 8;
    header = Buffer.concat([header, Buffer.alloc(extra)]);
    header.writeUInt32LE(header.length >>> 0, 16);
  }

  // 2. Rewrite the GTEX fixed fields for the new texture.
  header.writeUInt8(dds.format, start + 6);
  header.writeUInt8(newMips & 0xff, start + 7);
  header.writeUInt16BE(dds.width & 0xffff, start + 10);
  header.writeUInt16BE(dds.height & 0xffff, start + 12);

  // 3. Walk the mips: compute each size, write the (start,size) table entry at
  //    GtexStart+24 (8 bytes/mip, BE), append pixels to a fresh imgb, pad to a
  //    16-byte minimum, and halve the dimensions for the next mip.
  const s: OutState = { format: dds.format, width: dds.width, height: dds.height };
  const imgbChunks: Buffer[] = [];
  let imgbLen = 0; // current imgb length (mip start for the next entry)
  let srcPos = 0; // read cursor into the DDS pixels (advances by UNPADDED size)
  let tablePos = start + 24;

  for (let i = 0; i < newMips; i++) {
    const mipStart = imgbLen; // = imgb length BEFORE this mip is appended
    const mipSize = computeMipSize(s);

    header.writeUInt32BE(mipStart >>> 0, tablePos);
    header.writeUInt32BE(mipSize >>> 0, tablePos + 4);

    // Copy `mipSize` bytes of pixels from the DDS into the imgb.
    const slice = pixels.subarray(srcPos, srcPos + mipSize);
    imgbChunks.push(slice);
    imgbLen += slice.length;

    nextMipHeightWidth(s);

    // PadNullsForLastMips: pad the imgb to a 16-byte minimum for this mip.
    if (mipSize < 16) {
      const pad = 16 - mipSize;
      imgbChunks.push(Buffer.alloc(pad));
      imgbLen += pad;
    }

    // Advance the DDS read cursor by the unpadded mip size (matches `num`/`num2`).
    srcPos += mipSize;
    tablePos += 8;
  }

  return { header, imgb: Buffer.concat(imgbChunks, imgbLen) };
}
