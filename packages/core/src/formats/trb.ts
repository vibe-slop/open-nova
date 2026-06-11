/**
 * TRB inner-container format ("SEDBRES " resource bundles). Used by the FFXIII
 * trilogy as an alternative to WPD for holding texture header blocks and other
 * sub-resources.
 *
 * Unlike WPD, TRB counts/offsets are LITTLE-ENDIAN and the container is split
 * into several regions. The resource directory is an array of fixed 16-byte
 * descriptors; the FINAL TWO descriptors are special — they describe the
 * RESOURCE_TYPE region (the 4-char type tags) and the RESOURCE_ID region (the
 * NUL-terminated resource names), respectively. All other descriptors point at
 * an actual sub-resource body.
 *
 * Header / layout (offsets are byte positions, fields LITTLE-ENDIAN):
 *   0x00  'SEDBRES '            8-byte magic (note the trailing space)
 *   0x10  uint32  totalDataLen  (rewritten on repack; sum of region sizes)
 *   0x34 (52) uint32 dirDataLen size of all resource-directory data that lives
 *                               AFTER the 16-byte descriptor table (i.e. the
 *                               offset, from the end of the descriptor table, of
 *                               the RESOURCE_ID name strings).
 *   0x38 (56) uint32 resCount   number of 16-byte descriptors in the directory.
 *   0x40 (64) descriptor[]      resCount entries, 16 bytes each:
 *           +0x00  uint32  field0    (type/flags; preserved verbatim)
 *           +0x04  uint32  dataOff   (offset of this body, relative to the end
 *                                     of the descriptor table)
 *           +0x08  uint32  field8    (preserved verbatim)
 *           +0x0C  uint32  fieldC    (preserved verbatim)
 *
 * After the descriptor table (at `tableEnd = 64 + resCount*16`):
 *   - RESOURCE_TYPE region: 4-byte type tags, one per real resource.
 *   - RESOURCE_ID region:   NUL-terminated names, one per real resource.
 *   - sub-resource bodies:  the actual file data, 4-byte aligned.
 *
 * Region starts are derived arithmetically:
 *   tableEnd  = 64 + resCount*16
 *   namesBase = tableEnd + dirDataLen           (RESOURCE_ID strings)
 *   typesBase = tableEnd + (descriptor[last].dataOff)   (RESOURCE_TYPE tags)
 * and the last two descriptors (indices resCount-2 and resCount-1) are the
 * TYPE and ID region descriptors rather than real bodies.
 *
 * NOTE: a full byte-identical repack requires the auxiliary SEDBRES_OFFSETS /
 * RESOURCE_TYPE / RESOURCE_ID regions plus the IMGB pairing path.
 * {@link unpackTrb} reproduces those regions in the returned structure;
 * {@link repackTrb} is a best-effort rebuild that must be validated against a
 * real install.
 */
import { BinaryReader, BinaryWriter } from '../archive/binary.js';

/** Offset of the directory-data-length field. */
const OFF_DIR_DATA_LEN = 52;
/** Offset of the resource-count field. */
const OFF_RES_COUNT = 56;
/** Offset of the first 16-byte descriptor. */
const DESC_TABLE_START = 64;
/** Size of one resource descriptor. */
const DESC_SIZE = 16;
/** Bodies are padded to this alignment. */
const DATA_ALIGN = 4;
/** The 8-byte magic (trailing space is significant). */
const MAGIC = 'SEDBRES ';

/** A single real sub-resource decoded from a TRB container. */
export interface TrbEntry {
  /** Resource name (from the RESOURCE_ID region, NUL stripped). */
  name: string;
  /**
   * 4-character resource type tag (from the RESOURCE_TYPE region). The 4 bytes
   * are reversed when read, so this is the human-readable form (e.g. "txbh").
   * Empty for the final descriptor which has no type tag.
   */
  type: string;
  /** Raw body bytes for this resource. */
  data: Buffer;
  /** The descriptor's first uint32 (type/flags) preserved verbatim. */
  field0: number;
  /** The descriptor's third uint32 preserved verbatim. */
  field8: number;
  /** The descriptor's fourth uint32 preserved verbatim. */
  fieldC: number;
}

/** Result of {@link unpackTrb}. */
export interface UnpackedTrb {
  /** The real sub-resources (excludes the two region-descriptor entries). */
  entries: TrbEntry[];
  /** Number of 16-byte descriptors in the directory (incl. region descriptors). */
  resourceCount: number;
  /**
   * The complete header + descriptor table region (offsets 0 .. tableEnd),
   * preserved verbatim so a faithful rebuild can reuse it.
   */
  offsetsRegion: Buffer;
}

/**
 * Unpack a TRB ("SEDBRES ") container. The descriptor table is read at offset
 * 64, region bases are derived from the directory-data-length field and the
 * last descriptors, and each real resource body is sliced by its (offset, size)
 * where the size of the last-but-one and last real resources is computed from
 * the following region.
 *
 * @param buf the full TRB container bytes
 * @throws if the magic is not `SEDBRES `
 */
export function unpackTrb(buf: Uint8Array | Buffer): UnpackedTrb {
  const r = new BinaryReader(buf);
  const fileLength = r.length;

  const magic = r.readBytes(8).toString('latin1');
  if (magic !== MAGIC) {
    throw new Error('Not a valid TRB file (bad magic)');
  }

  r.seek(OFF_DIR_DATA_LEN);
  const dirDataLen = r.readU32(false);
  const resCount = r.readU32(false); // read immediately after dirDataLen

  const tableEnd = DESC_TABLE_START + resCount * DESC_SIZE;
  const lastIdx = resCount - 1;

  // Offsets of the two region descriptors (RESOURCE_TYPE & RESOURCE_ID).
  // descriptor[resCount-2].dataOff (the +4 field) -> typeRegion size base
  const typeRegionRel = new BinaryReader(
    r.buf,
    DESC_TABLE_START + (resCount - 2) * DESC_SIZE + 4,
  ).readU32(false);
  // descriptor[resCount-1].dataOff -> used to bound the last-but-one body
  const idRegionRel = new BinaryReader(
    r.buf,
    DESC_TABLE_START + lastIdx * DESC_SIZE + 4,
  ).readU32(false);

  const namesBase = tableEnd + dirDataLen; // RESOURCE_ID strings
  const typesBase = tableEnd + typeRegionRel; // RESOURCE_TYPE tags

  const entries: TrbEntry[] = [];
  let descPos = DESC_TABLE_START + 4; // +4 lands on the dataOff field
  let nameCursor = namesBase;
  let typeCursor = typesBase;

  // Loop over all resCount descriptors (1-based index).
  for (let i = 1; i <= resCount; i++) {
    const name = r.readCStringAt(nameCursor);
    // advance the name cursor past this NUL-terminated string
    nameCursor += Buffer.byteLength(name, 'utf8') + 1;

    const descBase = descPos - 4;
    const field0 = new BinaryReader(r.buf, descBase + 0).readU32(false);
    const field8 = new BinaryReader(r.buf, descBase + 8).readU32(false);
    const fieldC = new BinaryReader(r.buf, descBase + 12).readU32(false);

    let dataOff: number;
    let dataSize: number;
    let type = '';

    if (i < lastIdx) {
      dataOff = new BinaryReader(r.buf, descPos).readU32(false) + tableEnd;
      dataSize = new BinaryReader(r.buf, descPos + 4).readU32(false);
      // 4-char type tag, stored byte-reversed on disk
      const tag = Buffer.from(r.buf.subarray(typeCursor, typeCursor + 4));
      type = Buffer.from([tag[3], tag[2], tag[1], tag[0]]).toString('latin1');
    } else if (i === lastIdx) {
      dataOff = new BinaryReader(r.buf, descPos).readU32(false) + tableEnd;
      dataSize = idRegionRel + tableEnd - dataOff;
    } else {
      dataOff = new BinaryReader(r.buf, descPos).readU32(false) + tableEnd;
      dataSize = fileLength - dataOff;
    }

    const data = Buffer.from(r.buf.subarray(dataOff, dataOff + dataSize));
    entries.push({ name, type, data, field0, field8, fieldC });

    descPos += DESC_SIZE;
    typeCursor += 4;
  }

  const offsetsRegion = Buffer.from(r.buf.subarray(0, tableEnd));
  return { entries, resourceCount: resCount, offsetsRegion };
}

/**
 * Input for {@link repackTrb}: the structure returned by {@link unpackTrb}, with
 * any entry `data` optionally replaced.
 */
export interface RepackTrbInput {
  entries: TrbEntry[];
  resourceCount: number;
  offsetsRegion: Buffer;
}

/**
 * Best-effort TRB rebuild. PARTIAL / NEEDS REAL-HARDWARE VALIDATION.
 *
 * This is the EXACT INVERSE of {@link unpackTrb}: it consumes the same `entries`
 * array (all `resourceCount` of them, including the final two which carry the
 * RESOURCE_TYPE and RESOURCE_ID region bytes as their `data`), reuses the
 * preserved `offsetsRegion` (header + descriptor table) so reserved/unknown
 * header bytes survive verbatim, lays the real bodies out 4-byte aligned, then
 * appends the RESOURCE_TYPE region followed by the RESOURCE_ID region, and
 * patches every descriptor's offset/size plus the relevant header length
 * fields. By construction, feeding the output back into {@link unpackTrb}
 * reproduces the same structure (round-trip safe).
 *
 * It does NOT perform IMGB texture pairing, and byte-identity with a real
 * install's files is UNVERIFIED until checked. Treat this as a
 * correct-by-round-trip rebuild, not a guaranteed-identical one.
 *
 * @param input parsed TRB structure (typically straight from {@link unpackTrb})
 * @returns the reassembled TRB container bytes
 * @throws if the structure is inconsistent with the descriptor table
 */
export function repackTrb(input: RepackTrbInput): Buffer {
  const { entries, resourceCount } = input;
  if (entries.length !== resourceCount) {
    throw new Error(
      `TRB entry count (${entries.length}) must equal resourceCount (${resourceCount})`,
    );
  }
  const tableEnd = DESC_TABLE_START + resourceCount * DESC_SIZE;
  if (input.offsetsRegion.length < tableEnd) {
    throw new Error('TRB offsets region smaller than the descriptor table');
  }

  // Start from the preserved header + descriptor table so reserved/unknown
  // header bytes survive untouched; we patch only the fields we understand.
  const head = Buffer.from(input.offsetsRegion.subarray(0, tableEnd));

  // Indices that the unpacker treats specially:
  //   resCount-2 (1-based i == lastIdx)  -> RESOURCE_TYPE region descriptor
  //   resCount-1 (1-based i == resCount) -> RESOURCE_ID  region descriptor
  // Everything before resCount-2 is a real body.
  const realCount = resourceCount - 2;

  // Lay out the real bodies (4-byte aligned) at offsets relative to tableEnd.
  const bodyW = new BinaryWriter();
  const layout: { off: number; size: number }[] = [];
  for (let i = 0; i < realCount; i++) {
    bodyW.alignTo(DATA_ALIGN);
    const off = bodyW.length; // relative to tableEnd
    bodyW.writeBytes(entries[i].data);
    layout.push({ off, size: entries[i].data.length });
  }
  const bodies = bodyW.toBuffer();

  // The final two entries carry the region bytes verbatim (as produced by
  // unpackTrb): entries[resCount-2].data == RESOURCE_TYPE region,
  // entries[resCount-1].data == RESOURCE_ID region.
  const typeRegion = entries[resourceCount - 2].data;
  const idRegion = entries[resourceCount - 1].data;

  // Region order on disk after the bodies: RESOURCE_TYPE, then RESOURCE_ID.
  const typeRel = bodies.length; // relative to tableEnd
  const idRel = typeRel + typeRegion.length; // relative to tableEnd

  // Patch the descriptor table for the real entries. unpackTrb reads the body
  // offset from descriptor +4 and the body size from descriptor +8.
  for (let i = 0; i < realCount; i++) {
    const descBase = DESC_TABLE_START + i * DESC_SIZE;
    head.writeUInt32LE(layout[i].off >>> 0, descBase + 4);
    head.writeUInt32LE(layout[i].size >>> 0, descBase + 8);
  }

  // The two region descriptors. unpackTrb reads their region start from +4.
  const typeDescBase = DESC_TABLE_START + (resourceCount - 2) * DESC_SIZE;
  head.writeUInt32LE(typeRel >>> 0, typeDescBase + 4);
  const idDescBase = DESC_TABLE_START + (resourceCount - 1) * DESC_SIZE;
  head.writeUInt32LE(idRel >>> 0, idDescBase + 4);

  // Header length fields.
  // dirDataLen @0x34 = offset of RESOURCE_ID region (relative to tableEnd):
  // unpackTrb computes namesBase = tableEnd + dirDataLen.
  head.writeUInt32LE(idRel >>> 0, OFF_DIR_DATA_LEN);
  // resource count @0x38 (unchanged, but rewritten for clarity).
  head.writeUInt32LE(resourceCount >>> 0, OFF_RES_COUNT);
  // totalDataLen @0x10 = everything after the descriptor table.
  const afterTable = bodies.length + typeRegion.length + idRegion.length;
  head.writeUInt32LE(afterTable >>> 0, 0x10);

  // Assemble: header+table, real bodies, TYPE region, ID region.
  return Buffer.concat([head, bodies, typeRegion, idRegion]);
}
