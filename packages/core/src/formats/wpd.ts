/**
 * WPD inner-container format (the resource bundles found inside WhiteBin
 * payloads, used by the FFXIII trilogy to hold texture header blocks and other
 * sub-resources). See docs/REVERSE-ENGINEERING.md §5 and the original
 * NovaChrysalia.Formats/WPD.cs.
 *
 * Layout (all multi-byte fields BIG-ENDIAN):
 *   0x00  'WPD\0'              magic (4 bytes; the original writes "WPD" then
 *                              pads with NULs through to the record table @0x10)
 *   0x04  uint32  recordCount  (big-endian)
 *   0x08  ..0x0F               reserved/padding (zero)
 *   0x10  record table         recordCount entries, 32 bytes each:
 *           +0x00  char[16]    name      (NUL-terminated UTF-8, max 16 incl. NUL)
 *           +0x10  uint32      dataOffset (big-endian, ABSOLUTE within the file)
 *           +0x14  uint32      dataSize   (big-endian)
 *           +0x18  char[8]     ext       (NUL-terminated UTF-8 extension, no dot)
 *   data bodies follow the record table; each body is padded to a 4-byte
 *   boundary, in record order.
 */
import { BinaryReader, BinaryWriter } from '../archive/binary.js';

/** Size in bytes of one WPD record in the record table. */
const RECORD_SIZE = 32;
/** Offset of the first record in the record table. */
const RECORD_TABLE_START = 16;
/** Maximum bytes (including the NUL terminator) of the record name field. */
const NAME_FIELD_SIZE = 16;
/** Maximum bytes of the record extension field. */
const EXT_FIELD_SIZE = 8;
/** Data bodies are padded to this alignment, matching the original. */
const DATA_ALIGN = 4;

/** A single decoded entry of a WPD container. */
export interface WpdEntry {
  /** Resource name (the 16-byte name field, NUL stripped). */
  name: string;
  /**
   * File extension without the leading dot (the 8-byte ext field). Empty string
   * when the original stored no extension (the original treats "." as none).
   */
  ext: string;
  /** Raw body bytes for this entry. */
  data: Buffer;
}

/** Result of {@link unpackWpd}. */
export interface UnpackedWpd {
  entries: WpdEntry[];
}

/**
 * Unpack a WPD container into its named entries. Validates the `WPD\0` magic and
 * reads the big-endian record table starting at offset 16. Data bodies are
 * sliced using each record's absolute `dataOffset`/`dataSize`.
 *
 * @param buf the full WPD container bytes
 * @throws if the magic is not `WPD\0`
 */
export function unpackWpd(buf: Uint8Array | Buffer): UnpackedWpd {
  const r = new BinaryReader(buf);

  // Magic: the original reads 4 bytes and compares the leading text to "WPD".
  const magic = r.readBytes(4);
  if (magic[0] !== 0x57 || magic[1] !== 0x50 || magic[2] !== 0x44) {
    // 'W' 'P' 'D'
    throw new Error('Not a valid WPD file (bad magic)');
  }

  const recordCount = r.readU32(true);
  const entries: WpdEntry[] = [];

  let recPos = RECORD_TABLE_START;
  for (let i = 0; i < recordCount; i++) {
    const name = r.readCStringAt(recPos);
    const dataOffset = new BinaryReader(r.buf, recPos + 16).readU32(true);
    const dataSize = new BinaryReader(r.buf, recPos + 20).readU32(true);
    // The original prefixes a "." then treats a lone "." as "no extension";
    // here an absent extension is simply the empty string.
    const ext = r.readCStringAt(recPos + 24);

    const data = Buffer.from(r.buf.subarray(dataOffset, dataOffset + dataSize));
    entries.push({ name, ext, data });

    recPos += RECORD_SIZE;
  }

  return { entries };
}

/**
 * Rebuild a valid WPD container from a list of entries, preserving entry order
 * and the original's 4-byte body alignment. Names and extensions are encoded as
 * UTF-8 and truncated/padded to their fixed fields (16 and 8 bytes); offsets and
 * sizes are written big-endian, exactly matching {@link unpackWpd}.
 *
 * @param entries the entries to pack, in the order they should appear
 * @returns the assembled WPD container bytes
 * @throws if a name or extension does not fit its fixed-width field
 */
export function repackWpd(entries: WpdEntry[]): Buffer {
  const w = new BinaryWriter();

  // Header: 'WPD\0' then the big-endian record count, then pad through 0x10.
  w.writeBytes(Buffer.from('WPD\0', 'latin1'));
  w.writeU32(entries.length, true);
  // Pad from current length (8) up to the record table start (16).
  w.writePadding(RECORD_TABLE_START - w.length);

  // The record table is fixed-size; data bodies start right after it.
  const headerSize = RECORD_TABLE_START + entries.length * RECORD_SIZE;

  // First pass: lay out body offsets (absolute, 4-byte aligned) and bodies.
  const bodyW = new BinaryWriter();
  const layout: { offset: number; size: number }[] = [];
  for (const e of entries) {
    // Align the running body cursor to DATA_ALIGN before placing this body.
    bodyW.alignTo(DATA_ALIGN);
    const offset = headerSize + bodyW.length;
    bodyW.writeBytes(e.data);
    layout.push({ offset, size: e.data.length });
  }

  // Write the record table now that offsets/sizes are known.
  entries.forEach((e, i) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    if (nameBuf.length >= NAME_FIELD_SIZE) {
      throw new Error(`WPD entry name too long for 16-byte field: "${e.name}"`);
    }
    const nameField = Buffer.alloc(NAME_FIELD_SIZE);
    nameBuf.copy(nameField);
    w.writeBytes(nameField);

    w.writeU32(layout[i].offset, true);
    w.writeU32(layout[i].size, true);

    const extBuf = Buffer.from(e.ext, 'utf8');
    if (extBuf.length >= EXT_FIELD_SIZE) {
      throw new Error(`WPD entry ext too long for 8-byte field: "${e.ext}"`);
    }
    const extField = Buffer.alloc(EXT_FIELD_SIZE);
    extBuf.copy(extField);
    w.writeBytes(extField);
  });

  // Append the (aligned) data bodies.
  w.writeBytes(bodyW.toBuffer());

  return w.toBuffer();
}
