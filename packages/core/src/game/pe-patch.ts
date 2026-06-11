/**
 * Portable on-disk PE (Portable Executable) patching primitives, using only
 * Node `Buffer`. Rather than patching live process memory (writing into a
 * suspended game process at fixed module-relative offsets, which does not work
 * on Linux / Proton), these edit the SAME bytes in the on-disk executable
 * BEFORE launch: map each RVA to a file offset via the PE section table, keep a
 * `.original` backup, and launch the game through `steam://rungameid/<appid>`
 * so Steam/Proton wraps it.
 *
 * This module implements ONLY the PE-editing primitives:
 *   - Large-Address-Aware bit (trivial, fixed offsets).
 *   - rvaToFileOffset (walk the section table).
 *   - applyBytesAtRva / applyBytesAtFileOffset (in-place byte patches).
 *
 * The concrete RVAs for unpacked-mode / text-language / debug patches are
 * GAME-SPECIFIC and belong in game/launcher.ts, which is DEFERRED. launcher.ts
 * will also own the `.original` backup/restore lifecycle and the
 * `steam://rungameid/<appid>` launch. None of those RVAs are hardcoded here —
 * only the generic machinery.
 *
 * All functions operate on a Buffer (a copy of the exe). `patchLargeAddressAware`
 * and `applyBytes*` return a NEW Buffer; the input is never mutated.
 */

// --- PE structure offsets (all little-endian) -------------------------------
/** File offset of `e_lfanew` (the uint32 RVA-free pointer to the PE header). */
const E_LFANEW_OFFSET = 0x3c;
/** The 4-byte PE signature "PE\0\0" sits at the start of the PE header. */
const PE_SIGNATURE = 0x00004550; // 'P' 'E' 0 0, read as uint32 LE
/** Offset of NumberOfSections within the COFF/IMAGE_FILE_HEADER (uint16). */
const COFF_NUM_SECTIONS = 0x06;
/** Offset of SizeOfOptionalHeader within the COFF header (uint16). */
const COFF_SIZE_OPT_HEADER = 0x14;
/** Offset of Characteristics within the COFF header (uint16). */
const COFF_CHARACTERISTICS = 0x16;
/** The COFF header begins 4 bytes (the PE signature) past `peOffset`. */
const COFF_HEADER_SIZE_BEFORE_OPTIONAL = 0x18; // signature(4) + COFF header(20)
/** IMAGE_FILE_LARGE_ADDRESS_AWARE flag in COFF Characteristics. */
const LARGE_ADDRESS_AWARE_FLAG = 0x0020;

// --- Section header layout (40 bytes each) ----------------------------------
const SECTION_HEADER_SIZE = 40;
const SECTION_VIRTUAL_ADDRESS = 0x0c; // uint32
const SECTION_SIZE_OF_RAW_DATA = 0x10; // uint32
const SECTION_POINTER_TO_RAW_DATA = 0x14; // uint32

/** Read `e_lfanew` (the file offset of the PE header) and validate the signature. */
function readPeOffset(exeBuf: Buffer): number {
  if (exeBuf.length < E_LFANEW_OFFSET + 4) {
    throw new Error('buffer too small to be a PE file (no e_lfanew)');
  }
  const peOffset = exeBuf.readUInt32LE(E_LFANEW_OFFSET);
  if (peOffset + COFF_HEADER_SIZE_BEFORE_OPTIONAL > exeBuf.length) {
    throw new Error('e_lfanew points past end of buffer');
  }
  if (exeBuf.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error('missing PE signature ("PE\\0\\0") at e_lfanew');
  }
  return peOffset;
}

/**
 * True if the executable's COFF Characteristics has the
 * IMAGE_FILE_LARGE_ADDRESS_AWARE (0x0020) flag set.
 */
export function isLargeAddressAware(exeBuf: Buffer): boolean {
  const peOffset = readPeOffset(exeBuf);
  const characteristics = exeBuf.readUInt16LE(peOffset + COFF_CHARACTERISTICS);
  return (characteristics & LARGE_ADDRESS_AWARE_FLAG) !== 0;
}

/**
 * Return a copy of the executable with the IMAGE_FILE_LARGE_ADDRESS_AWARE bit
 * set in the COFF Characteristics. This lets the 32-bit game address >2 GB,
 * avoiding out-of-memory crashes with large mods.
 *
 * The input buffer is not mutated. Idempotent: re-applying is a no-op.
 */
export function patchLargeAddressAware(exeBuf: Buffer): Buffer {
  const peOffset = readPeOffset(exeBuf);
  const out = Buffer.from(exeBuf); // copy
  const off = peOffset + COFF_CHARACTERISTICS;
  const characteristics = out.readUInt16LE(off);
  out.writeUInt16LE(characteristics | LARGE_ADDRESS_AWARE_FLAG, off);
  return out;
}

/**
 * Map a Relative Virtual Address (RVA) to a file offset by walking the PE
 * section table. Each section maps `[VirtualAddress, VirtualAddress + size)` in
 * memory to `[PointerToRawData, ...)` on disk; we find the containing section
 * and translate. Throws if the RVA falls in no section's raw data range.
 *
 * This is the on-disk equivalent of module-base + RVA addressing in memory.
 */
export function rvaToFileOffset(exeBuf: Buffer, rva: number): number {
  const peOffset = readPeOffset(exeBuf);
  const numSections = exeBuf.readUInt16LE(peOffset + COFF_NUM_SECTIONS);
  const sizeOfOptionalHeader = exeBuf.readUInt16LE(peOffset + COFF_SIZE_OPT_HEADER);

  // Section table follows: PE signature(4) + COFF header(20) + optional header.
  const sectionTableStart =
    peOffset + COFF_HEADER_SIZE_BEFORE_OPTIONAL + sizeOfOptionalHeader;

  for (let s = 0; s < numSections; s++) {
    const base = sectionTableStart + s * SECTION_HEADER_SIZE;
    if (base + SECTION_HEADER_SIZE > exeBuf.length) {
      throw new Error('section table runs past end of buffer');
    }
    const virtualAddress = exeBuf.readUInt32LE(base + SECTION_VIRTUAL_ADDRESS);
    const sizeOfRawData = exeBuf.readUInt32LE(base + SECTION_SIZE_OF_RAW_DATA);
    const pointerToRawData = exeBuf.readUInt32LE(base + SECTION_POINTER_TO_RAW_DATA);

    if (rva >= virtualAddress && rva < virtualAddress + sizeOfRawData) {
      return pointerToRawData + (rva - virtualAddress);
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is not contained in any PE section`);
}

/**
 * Return a copy of the executable with `bytes` written at the given file
 * offset. The input buffer is not mutated. Throws if the write would run past
 * the end of the buffer.
 */
export function applyBytesAtFileOffset(
  exeBuf: Buffer,
  fileOffset: number,
  bytes: Uint8Array | Buffer,
): Buffer {
  if (fileOffset < 0 || fileOffset + bytes.length > exeBuf.length) {
    throw new Error(
      `patch at file offset 0x${fileOffset.toString(16)} (${bytes.length} bytes) is out of range`,
    );
  }
  const out = Buffer.from(exeBuf); // copy
  Buffer.from(bytes).copy(out, fileOffset);
  return out;
}

/**
 * Return a copy of the executable with `bytes` written at the file offset that
 * the given RVA maps to (via the section table). Convenience wrapper combining
 * rvaToFileOffset + applyBytesAtFileOffset; this is the form the deferred
 * launcher.ts will use for its game-specific unpacked-mode / language / debug
 * patches. The input buffer is not mutated.
 */
export function applyBytesAtRva(
  exeBuf: Buffer,
  rva: number,
  bytes: Uint8Array | Buffer,
): Buffer {
  const fileOffset = rvaToFileOffset(exeBuf, rva);
  return applyBytesAtFileOffset(exeBuf, fileOffset, bytes);
}
