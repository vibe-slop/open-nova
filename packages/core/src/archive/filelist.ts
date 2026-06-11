/**
 * Parse and rebuild the WhiteBin "filelist" index (the table of contents that
 * maps virtual paths to offsets/sizes in the white_img payload).
 *
 * Handles both entry layouts (FF13-1 vs FF13-2/LR) and transparently decrypts
 * encrypted (XIII-2/LR) filelists on parse, re-encrypting on build.
 */
import { BinaryReader, BinaryWriter, parsePathString, buildPathString } from './binary.js';
import { zlibCompress, zlibDecompress } from './zlib.js';
import { isFilelistEncrypted, decryptFilelist, encryptFilelist } from '../crypto/filelist-crypto.js';

export type GameCode = 1 | 2 | 3;

export interface WhiteFile {
  /** Entry FileCode (uint32). */
  fileCode: number;
  /** FileTypeID byte (FF13-2/LR only; 0 for FF13-1). */
  fileTypeId: number;
  /** Raw per-entry chunk sub-index byte (FF13-2/LR), preserved for faithful rebuild. */
  chunkSubByte: number;
  /** Which chunk this entry's path string lives in. */
  chunkIndex: number;
  /** Offset in white_img = posUnits * 0x800. */
  posUnits: number;
  uncmpSize: number;
  cmpSize: number;
  /** Virtual path ('/'-separated), or ' ' (single space) for no-path entries. */
  virtualPath: string;
}

export interface Filelist {
  gameCode: GameCode;
  encrypted: boolean;
  /** Verbatim 32-byte crypto header (present iff encrypted). */
  cryptoHeader?: Buffer;
  chunkCount: number;
  files: WhiteFile[];
}

/** Parse a filelist buffer (decrypting first if needed). */
export function parseFilelist(raw: Uint8Array, gameCode: GameCode): Filelist {
  const encrypted = gameCode !== 1 && isFilelistEncrypted(raw);
  let cryptoHeader: Buffer | undefined;
  let buf: Buffer;

  if (encrypted) {
    const dec = decryptFilelist(raw);
    buf = Buffer.from(dec.data);
    cryptoHeader = Buffer.from(buf.subarray(0, 32));
  } else {
    buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  }

  const base = encrypted ? 32 : 0;
  const r = new BinaryReader(buf);
  const chunkInfoOff = r.seek(base + 0).readU32() + base;
  const chunkDataOff = r.seek(base + 4).readU32() + base;
  const totalFiles = r.seek(base + 8).readU32();
  const entriesStart = base + 12;

  // Decompress all chunks.
  const chunkInfoSize = chunkDataOff - chunkInfoOff;
  const chunkCount = chunkInfoSize / 12;
  const chunkBlobs: Buffer[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const recPos = chunkInfoOff + i * 12;
    const cmpSize = r.seek(recPos + 4).readU32();
    const startOff = r.seek(recPos + 8).readU32();
    const comp = buf.subarray(chunkDataOff + startOff, chunkDataOff + startOff + cmpSize);
    chunkBlobs.push(zlibDecompress(comp));
  }

  const files: WhiteFile[] = [];
  let currentChunk = -1;

  for (let i = 0; i < totalFiles; i++) {
    const p = entriesStart + i * 8;
    const fileCode = r.seek(p).readU32();
    let chunkIndex: number;
    let pathPos: number;
    let chunkSubByte = 0;
    let fileTypeId = 0;

    if (gameCode === 1) {
      chunkIndex = r.seek(p + 4).readU16();
      pathPos = r.seek(p + 6).readU16();
    } else {
      let rawPos = r.seek(p + 4).readU16();
      chunkSubByte = r.seek(p + 6).readU8();
      fileTypeId = r.seek(p + 7).readU8();
      if (rawPos === 0 || rawPos === 0x8000) {
        currentChunk++;
        pathPos = 0;
      } else if (rawPos > 0x8000) {
        pathPos = rawPos - 0x8000;
      } else {
        pathPos = rawPos;
      }
      chunkIndex = currentChunk;
    }

    const blob = chunkBlobs[chunkIndex];
    const pathString = readCString(blob, pathPos);
    const fields = parsePathString(pathString);

    files.push({
      fileCode,
      fileTypeId,
      chunkSubByte,
      chunkIndex,
      posUnits: fields.posUnits,
      uncmpSize: fields.uncmpSize,
      cmpSize: fields.cmpSize,
      virtualPath: fields.virtualPath,
    });
  }

  return { gameCode, encrypted, cryptoHeader, chunkCount, files };
}

/** Rebuild a filelist buffer from a (possibly modified) Filelist model. */
export function buildFilelist(fl: Filelist): Buffer {
  const { gameCode, files } = fl;

  // 1) Group path strings by chunk, in entry order, recording each entry's
  //    byte offset within its chunk blob.
  const chunkBlobs: BinaryWriter[] = [];
  for (let i = 0; i < fl.chunkCount; i++) chunkBlobs.push(new BinaryWriter());
  const pathOffsets = new Array<number>(files.length);

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const w = chunkBlobs[f.chunkIndex];
    pathOffsets[i] = w.length;
    const s = buildPathString({
      posUnits: f.posUnits,
      uncmpSize: f.uncmpSize,
      cmpSize: f.cmpSize,
      virtualPath: f.virtualPath,
    });
    w.writeBytes(Buffer.from(s, 'utf8')).writeU8(0);
  }
  // 'end\0' terminator on the last chunk.
  if (fl.chunkCount > 0) chunkBlobs[fl.chunkCount - 1].writeBytes(Buffer.from('end', 'utf8')).writeU8(0);

  // 2) Entries section.
  const entries = new BinaryWriter();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    entries.writeU32(f.fileCode);
    if (gameCode === 1) {
      entries.writeU16(f.chunkIndex);
      entries.writeU16(pathOffsets[i]);
    } else {
      // Odd-indexed chunks carry the 0x8000 flag.
      const flag = f.chunkIndex % 2 === 1 ? 0x8000 : 0;
      entries.writeU16((pathOffsets[i] | flag) & 0xffff);
      entries.writeU8(f.chunkSubByte);
      entries.writeU8(f.fileTypeId);
    }
  }
  const entriesData = entries.toBuffer();

  // 3) Compress chunks, build chunk-info + chunk-data sections.
  const chunkInfo = new BinaryWriter();
  const chunkData = new BinaryWriter();
  let startOffset = 0;
  for (let i = 0; i < fl.chunkCount; i++) {
    const blob = chunkBlobs[i].toBuffer();
    const comp = zlibCompress(blob);
    chunkInfo.writeU32(blob.length);
    chunkInfo.writeU32(comp.length);
    chunkInfo.writeU32(startOffset);
    chunkData.writeBytes(comp);
    startOffset += comp.length;
  }
  const chunkInfoData = chunkInfo.toBuffer();
  const chunkDataData = chunkData.toBuffer();

  // 4) Header offsets are relative to the (post-crypto-header) base.
  const chunkInfoSectionOffset = 12 + entriesData.length;
  const chunkDataSectionOffset = 12 + entriesData.length + chunkInfoData.length;

  const out = new BinaryWriter();
  if (fl.encrypted && fl.cryptoHeader) out.writeBytes(fl.cryptoHeader);
  out.writeU32(chunkInfoSectionOffset);
  out.writeU32(chunkDataSectionOffset);
  out.writeU32(files.length);
  out.writeBytes(entriesData);
  out.writeBytes(chunkInfoData);
  out.writeBytes(chunkDataData);

  const plain = out.toBuffer();
  if (fl.encrypted) return Buffer.from(encryptFilelist(plain));
  return plain;
}

function readCString(blob: Buffer, at: number): string {
  let end = at;
  while (end < blob.length && blob[end] !== 0) end++;
  return blob.toString('utf8', at, end);
}
