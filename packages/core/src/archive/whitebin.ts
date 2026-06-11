/**
 * Unpack/repack the WhiteBin payload (white_img*.win32.bin) using its filelist.
 *
 * Payload bodies are 0x800-aligned; each is stored raw or zlib-compressed
 * (decided per file by uncmpSize != cmpSize). See docs/REVERSE-ENGINEERING.md §1.3.
 */
import { Filelist, GameCode, WhiteFile, parseFilelist, buildFilelist } from './filelist.js';
import { BinaryWriter } from './binary.js';
import { zlibCompress, zlibDecompress } from './zlib.js';

const ALIGN = 0x800;

export interface UnpackedFile {
  virtualPath: string;
  data: Buffer;
  wasCompressed: boolean;
}

/** Unpack every file body out of the payload. */
export function unpackArchive(filelistRaw: Uint8Array, imgRaw: Uint8Array, gameCode: GameCode): {
  filelist: Filelist;
  files: UnpackedFile[];
} {
  const filelist = parseFilelist(filelistRaw, gameCode);
  const img = Buffer.isBuffer(imgRaw) ? imgRaw : Buffer.from(imgRaw);
  const files: UnpackedFile[] = [];

  for (const f of filelist.files) {
    const start = f.posUnits * ALIGN;
    const wasCompressed = f.uncmpSize !== f.cmpSize;
    let data: Buffer;
    if (wasCompressed) {
      const comp = img.subarray(start, start + f.cmpSize);
      data = zlibDecompress(comp);
    } else {
      data = Buffer.from(img.subarray(start, start + f.uncmpSize));
    }
    files.push({ virtualPath: f.virtualPath, data, wasCompressed });
  }

  return { filelist, files };
}

/**
 * Full rebuild: reassign positions and rewrite both files. `getData(virtualPath,
 * file)` returns the (possibly modified) body for each file; if it returns the
 * original bytes, the result round-trips. Compression is preserved per file.
 */
export function repackArchive(
  filelist: Filelist,
  getData: (virtualPath: string, file: WhiteFile) => Buffer,
): { filelist: Buffer; img: Buffer } {
  const imgW = new BinaryWriter();
  const newFiles: WhiteFile[] = [];

  for (const f of filelist.files) {
    const data = getData(f.virtualPath, f);
    imgW.alignTo(ALIGN);
    const posUnits = imgW.length / ALIGN;

    let uncmpSize: number;
    let cmpSize: number;
    if (f.uncmpSize !== f.cmpSize) {
      // was compressed -> recompress
      const comp = zlibCompress(data);
      imgW.writeBytes(comp);
      uncmpSize = data.length;
      cmpSize = comp.length;
    } else {
      imgW.writeBytes(data);
      uncmpSize = data.length;
      cmpSize = data.length;
    }

    newFiles.push({ ...f, posUnits, uncmpSize, cmpSize });
  }
  imgW.alignTo(ALIGN);

  const newFilelist: Filelist = { ...filelist, files: newFiles };
  return { filelist: buildFilelist(newFilelist), img: imgW.toBuffer() };
}

export interface PackInput {
  virtualPath: string;
  data: Buffer | Uint8Array;
  /** Store zlib-compressed (default true for non-trivial data). */
  compress?: boolean;
  fileCode?: number;
  fileTypeId?: number;
}

/**
 * Build a fresh archive (filelist + img) from a list of virtual files. Used for
 * tests and for creating new containers. Splits path strings across `chunkCount`
 * chunks (default 1) to exercise the chunk/flag machinery.
 */
export function packArchive(
  inputs: PackInput[],
  gameCode: GameCode,
  opts: { encrypted?: boolean; cryptoHeader?: Buffer; chunkCount?: number } = {},
): { filelist: Buffer; img: Buffer } {
  // FF13-2/LR read chunks via sequential advance, so chunk membership must be
  // CONTIGUOUS (files grouped into blocks), never interleaved.
  const n = inputs.length;
  const chunkCount = Math.max(1, Math.min(opts.chunkCount ?? 1, n || 1));
  const filesPerChunk = Math.max(1, Math.ceil(n / chunkCount));
  const imgW = new BinaryWriter();
  const files: WhiteFile[] = [];

  inputs.forEach((inp, i) => {
    const data = Buffer.isBuffer(inp.data) ? inp.data : Buffer.from(inp.data);
    const compress = inp.compress ?? true;
    imgW.alignTo(ALIGN);
    const posUnits = imgW.length / ALIGN;

    let uncmpSize: number;
    let cmpSize: number;
    if (compress) {
      const comp = zlibCompress(data);
      imgW.writeBytes(comp);
      uncmpSize = data.length;
      cmpSize = comp.length;
    } else {
      imgW.writeBytes(data);
      uncmpSize = data.length;
      cmpSize = data.length;
    }

    files.push({
      fileCode: inp.fileCode ?? i,
      fileTypeId: inp.fileTypeId ?? 0,
      chunkSubByte: 0,
      chunkIndex: Math.floor(i / filesPerChunk),
      posUnits,
      uncmpSize,
      cmpSize,
      virtualPath: inp.virtualPath,
    });
  });
  imgW.alignTo(ALIGN);

  let cryptoHeader = opts.cryptoHeader;
  if (opts.encrypted && !cryptoHeader) {
    // Minimal synthetic crypto header: 16-byte seed region + tag at 0x14.
    cryptoHeader = Buffer.alloc(32);
    // arbitrary seed bytes
    cryptoHeader[0] = 0xa1;
    cryptoHeader[2] = 0xb2;
    cryptoHeader[9] = 0xc3;
    cryptoHeader[12] = 0xd4;
    cryptoHeader.writeUInt32LE(501232760, 0x14); // FILELIST_MAGIC
  }

  const filelist: Filelist = {
    gameCode,
    encrypted: !!opts.encrypted,
    cryptoHeader,
    chunkCount,
    files,
  };
  return { filelist: buildFilelist(filelist), img: imgW.toBuffer() };
}
