/**
 * TRB ("SEDBRES ") full repack — the byte-faithful inverse of {@link unpackTrb}.
 *
 * This module ports the original NovaChrysalia.Formats/TRB.cs `RepackTRB` path.
 * The original reassembles the container from the side files it wrote on unpack
 * (`SEDBRES_OFFSETS` = the header + descriptor table, `RESOURCE_TYPE`,
 * `RESOURCE_ID`, plus a freshly built body blob `_tempData`) and ONLY:
 *   1. rewrites each real resource's (offset, size) pair in the descriptor table,
 *   2. writes the two region descriptors' (offset, size) pairs using the
 *      original's fixed-formula sizes (`64 + 20*count` and `64 + 32*count`),
 *   3. patches the directory-data-length field @52 and the total-size field @16.
 * It never rebuilds the descriptor table or the region layout from scratch.
 *
 * This implementation mirrors that approach exactly (the "WPD repack" strategy:
 * keep the header + descriptor table + RESOURCE_TYPE + RESOURCE_ID regions
 * verbatim, rebuild only the data region and patch the offset table). Because the
 * original's region-descriptor `size` fields are written from fixed formulas
 * rather than the regions' true byte lengths, preserving them verbatim is what
 * makes a no-edit repack byte-identical to the source file. All offsets/sizes are
 * LITTLE-ENDIAN, matching the TRB container.
 *
 * Scope note: like the original this does NOT perform IMGB texture pairing
 * (`RepackIMGBType2`). It rebuilds the SEDBRES container faithfully from the
 * entries; if a caller has separately repacked a paired `.imgb`, the header
 * blocks held in the entries should already reflect that.
 *
 * @see {@link unpackTrb} for the format/region documentation this inverts.
 */
import { BinaryWriter } from '../archive/binary.js';
import { unpackTrb } from '../formats/trb.js';
import type { TrbEntry, UnpackedTrb } from '../formats/trb.js';

/** Offset of the directory-data-length field ("num"/dirDataLen) @0x34. */
const OFF_DIR_DATA_LEN = 52;
/** Offset of the resource-count field ("num"/count) @0x38. */
const OFF_RES_COUNT = 56;
/** Offset of the total-data-length field @0x10 (everything after the table). */
const OFF_TOTAL_DATA_LEN = 16;
/** Offset of the first 16-byte descriptor. */
const DESC_TABLE_START = 64;
/** Size of one resource descriptor. */
const DESC_SIZE = 16;
/** Default body alignment (the original's `_tempData` 4-byte pad). */
const DATA_ALIGN = 4;
/**
 * The descriptor `fieldC` value that requests stronger (16-byte) body alignment.
 * Observed on real FFXIII-2 TRBs for `.skl` / `phb` bodies (`fieldC == 4`). The
 * original tool only ever 4-byte-aligns `_tempData`, so it cannot reproduce these;
 * honouring `fieldC` here is what restores byte-identity with the shipped game
 * files. (`fieldC == 2` is the common case and uses {@link DATA_ALIGN}.)
 */
const FC_STRONG_ALIGN = 4;
/** The alignment applied when a resource's `fieldC` equals {@link FC_STRONG_ALIGN}. */
const STRONG_ALIGN = 16;

/**
 * Input for {@link repackTrb}: the structure produced by {@link unpackTrb}, with
 * any real entry's `data` optionally replaced. The final two entries
 * (RESOURCE_TYPE and RESOURCE_ID region descriptors) carry the verbatim region
 * bytes as their `data` and are emitted unchanged.
 */
export interface RepackTrbInput {
  /** All `resourceCount` entries, including the two trailing region entries. */
  entries: TrbEntry[];
  /** Number of 16-byte descriptors in the directory (incl. region descriptors). */
  resourceCount: number;
  /** Header + descriptor table (the original `SEDBRES_OFFSETS` side file). */
  offsetsRegion: Buffer;
}

/** Round `n` up to the next multiple of `align`. */
function ceilTo(n: number, align: number): number {
  const rem = n % align;
  return rem === 0 ? n : n + (align - rem);
}

/**
 * Repack a TRB ("SEDBRES ") container from parsed entries, faithfully porting the
 * original `RepackTRB`. Pass the result of {@link unpackTrb} directly (optionally
 * after editing real entries' `data`); if only the raw entries are on hand, pass
 * `originalBuf` so the header + descriptor table can be recovered by re-parsing.
 *
 * Layout produced (matching the original exactly):
 *   - header + descriptor table         (verbatim from `offsetsRegion`, patched)
 *   - real resource bodies              (`resourceCount - 2` of them, 4-byte
 *                                        aligned after each body incl. the last)
 *   - RESOURCE_TYPE region              (verbatim; entries[resourceCount-2].data)
 *   - RESOURCE_ID region                (verbatim; entries[resourceCount-1].data)
 *
 * Patched header fields (all LITTLE-ENDIAN):
 *   - each real descriptor +4 = body offset relative to the table end
 *   - each real descriptor +8 = body size (unpadded byte length)
 *   - descriptor[count-2] +4  = total aligned body length; +8 = `64 + 20*count`
 *   - descriptor[count-1] +4  = body length + RESOURCE_TYPE length;
 *                          +8  = `64 + 32*count`
 *   - @0x34 dirDataLen        = descriptor[count-1].off + count*16
 *   - @0x10 totalDataLen      = tableEnd + bodies + TYPE + ID region lengths
 *
 * When the entries and regions are unchanged this reproduces the source file
 * byte-for-byte (validated against a real FFXIII-2 TRB; see the self-test).
 *
 * @param input parsed TRB structure ({@link unpackTrb} output, possibly edited),
 *   or a bare `{ entries, resourceCount }` when `originalBuf` is supplied.
 * @param originalBuf the original container bytes; required only when
 *   `input.offsetsRegion` is absent, used to recover the header + table verbatim.
 * @returns the reassembled TRB container bytes.
 * @throws if the entry count is inconsistent or the header region is too small.
 */
export function repackTrb(
  input: RepackTrbInput | UnpackedTrb | { entries: TrbEntry[]; resourceCount: number },
  originalBuf?: Uint8Array | Buffer,
): Buffer {
  const { entries, resourceCount } = input;

  if (entries.length !== resourceCount) {
    throw new Error(
      `TRB entry count (${entries.length}) must equal resourceCount (${resourceCount})`,
    );
  }
  if (resourceCount < 2) {
    throw new Error(
      `TRB must have at least 2 descriptors (RESOURCE_TYPE + RESOURCE_ID); got ${resourceCount}`,
    );
  }

  // Recover the header + descriptor table region (the SEDBRES_OFFSETS side file).
  // Prefer the preserved region; otherwise re-parse it from the original bytes so
  // reserved/unknown header bytes survive untouched.
  let offsetsRegion = (input as RepackTrbInput).offsetsRegion;
  if (!offsetsRegion && originalBuf) {
    offsetsRegion = unpackTrb(originalBuf).offsetsRegion;
  }
  if (!offsetsRegion) {
    throw new Error(
      'repackTrb needs the header + descriptor table: pass an unpackTrb() result (with offsetsRegion) or the original buffer',
    );
  }

  const tableEnd = DESC_TABLE_START + resourceCount * DESC_SIZE;
  if (offsetsRegion.length < tableEnd) {
    throw new Error(
      `TRB offsets region (${offsetsRegion.length}) smaller than the descriptor table (${tableEnd})`,
    );
  }

  // Copy the header + descriptor table verbatim; we patch only known fields.
  const head = Buffer.from(offsetsRegion.subarray(0, tableEnd));

  // The original loops `for (num7 = 1; num7 < count - 1; num7++)` — i.e. the real
  // resources are descriptors 0 .. count-3, and the final two (count-2, count-1)
  // are the RESOURCE_TYPE and RESOURCE_ID region descriptors.
  const realCount = resourceCount - 2;

  // Build the body region (`_tempData`): each real body is placed at an offset
  // aligned to its resource's requirement, then copied verbatim. The original tool
  // only 4-byte-aligns; real game files additionally 16-byte-align `fieldC == 4`
  // resources, so we align each body's START to `STRONG_ALIGN` when `fieldC == 4`
  // and `DATA_ALIGN` otherwise. Alignment is computed in ABSOLUTE file space
  // (`tableEnd + rel`) so it is correct even if `tableEnd` is not a multiple of the
  // chosen alignment. A trailing `DATA_ALIGN` pad after the last body keeps the
  // RESOURCE_TYPE region 4-byte aligned (the original's final `_tempData` pad).
  const bodyW = new BinaryWriter();
  const layout: { off: number; size: number }[] = [];
  for (let i = 0; i < realCount; i++) {
    const align = entries[i].fieldC === FC_STRONG_ALIGN ? STRONG_ALIGN : DATA_ALIGN;
    // Pad until (tableEnd + bodyW.length) is a multiple of `align`.
    const padTo = ceilTo(tableEnd + bodyW.length, align) - tableEnd;
    bodyW.writePadding(padTo - bodyW.length);
    const off = bodyW.length; // relative to tableEnd
    const data = entries[i].data;
    bodyW.writeBytes(data);
    layout.push({ off, size: data.length });
  }
  // Align the running length to DATA_ALIGN so RESOURCE_TYPE starts on a 4-byte
  // boundary (absolute space; tableEnd is 4-aligned by construction).
  bodyW.writePadding(ceilTo(tableEnd + bodyW.length, DATA_ALIGN) - tableEnd - bodyW.length);
  const bodies = bodyW.toBuffer();

  // RESOURCE_TYPE / RESOURCE_ID regions: emitted verbatim from the trailing two
  // entries' data (exactly as unpackTrb sliced them).
  const typeRegion = entries[resourceCount - 2].data;
  const idRegion = entries[resourceCount - 1].data;

  // Patch the real descriptors: +4 = body offset (rel. tableEnd), +8 = body size.
  for (let i = 0; i < realCount; i++) {
    const descBase = DESC_TABLE_START + i * DESC_SIZE;
    head.writeUInt32LE(layout[i].off >>> 0, descBase + 4);
    head.writeUInt32LE(layout[i].size >>> 0, descBase + 8);
  }

  // The two region descriptors. The original writes their offsets to the body
  // region and the *fixed-formula* sizes (NOT the regions' true byte lengths) —
  // preserving these formulas is what makes a no-edit repack byte-identical.
  const typeRel = bodies.length; // num14 = total aligned body length
  const idRel = typeRel + typeRegion.length; // num16 = bodies + TYPE region

  const typeDescBase = DESC_TABLE_START + (resourceCount - 2) * DESC_SIZE;
  head.writeUInt32LE(typeRel >>> 0, typeDescBase + 4);
  head.writeUInt32LE((64 + 20 * resourceCount) >>> 0, typeDescBase + 8); // valueToWrite2

  const idDescBase = DESC_TABLE_START + (resourceCount - 1) * DESC_SIZE;
  head.writeUInt32LE(idRel >>> 0, idDescBase + 4);
  head.writeUInt32LE((64 + 32 * resourceCount) >>> 0, idDescBase + 8); // valueToWrite3

  // Header length fields.
  // @0x34 dirDataLen = idRel + count*16 (the original's valueToWrite4). NB this is
  // NOT the same as idRel — unpackTrb's `namesBase = tableEnd + dirDataLen` relies
  // on this exact value to locate the RESOURCE_ID names.
  head.writeUInt32LE((idRel + resourceCount * DESC_SIZE) >>> 0, OFF_DIR_DATA_LEN);
  // @0x38 resource count (unchanged; rewritten for parity with the original copy).
  head.writeUInt32LE(resourceCount >>> 0, OFF_RES_COUNT);
  // @0x10 totalDataLen = tableEnd + bodies + TYPE + ID region byte lengths
  // (the original's valueToWrite5 = num2 + num13 + num15 + num17).
  const totalAfterHeader = tableEnd + bodies.length + typeRegion.length + idRegion.length;
  head.writeUInt32LE(totalAfterHeader >>> 0, OFF_TOTAL_DATA_LEN);

  // Assemble: header + table, real bodies, RESOURCE_TYPE, RESOURCE_ID.
  return Buffer.concat([head, bodies, typeRegion, idRegion]);
}

// Re-export the entry/region types so callers can import everything from here.
export type { TrbEntry, UnpackedTrb };
