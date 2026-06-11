/**
 * Minimal cursor-based binary reader/writer over Node Buffers, replacing the
 * original's BinaryReader/BinaryWriter + Stream helpers. Little-endian by
 * default; big-endian variants provided (the FFXIII formats mix both).
 */

export class BinaryReader {
  buf: Buffer;
  pos: number;

  constructor(data: Uint8Array | Buffer, pos = 0) {
    this.buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.buf.length;
  }

  seek(pos: number): this {
    this.pos = pos;
    return this;
  }

  skip(n: number): this {
    this.pos += n;
    return this;
  }

  readU8(): number {
    return this.buf.readUInt8(this.pos++);
  }

  readU16(be = false): number {
    const v = be ? this.buf.readUInt16BE(this.pos) : this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readU32(be = false): number {
    const v = be ? this.buf.readUInt32BE(this.pos) : this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readBytes(n: number): Buffer {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Read a NUL-terminated UTF-8 string starting at `at` (does not move cursor). */
  readCStringAt(at: number): string {
    let end = at;
    while (end < this.buf.length && this.buf[end] !== 0) end++;
    return this.buf.toString('utf8', at, end);
  }
}

export class BinaryWriter {
  private chunks: Buffer[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  writeU8(v: number): this {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v & 0xff, 0);
    return this.push(b);
  }

  writeU16(v: number, be = false): this {
    const b = Buffer.allocUnsafe(2);
    if (be) b.writeUInt16BE(v & 0xffff, 0);
    else b.writeUInt16LE(v & 0xffff, 0);
    return this.push(b);
  }

  writeU32(v: number, be = false): this {
    const b = Buffer.allocUnsafe(4);
    if (be) b.writeUInt32BE(v >>> 0, 0);
    else b.writeUInt32LE(v >>> 0, 0);
    return this.push(b);
  }

  writeBytes(data: Uint8Array | Buffer): this {
    return this.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  /** Append `n` NUL bytes. */
  writePadding(n: number): this {
    if (n <= 0) return this;
    return this.push(Buffer.alloc(n));
  }

  /** Pad with NUL bytes up to the next multiple of `align`. */
  alignTo(align: number): this {
    const rem = this._length % align;
    if (rem !== 0) this.writePadding(align - rem);
    return this;
  }

  private push(b: Buffer): this {
    this.chunks.push(b);
    this._length += b.length;
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this._length);
  }
}

/** Parse a chunk path string "pos:uncmpSize:cmpSize:path" (numbers in hex). */
export interface PathStringFields {
  posUnits: number;
  uncmpSize: number;
  cmpSize: number;
  virtualPath: string;
}

export function parsePathString(s: string): PathStringFields {
  const idx1 = s.indexOf(':');
  const idx2 = s.indexOf(':', idx1 + 1);
  const idx3 = s.indexOf(':', idx2 + 1);
  return {
    posUnits: parseInt(s.slice(0, idx1), 16) >>> 0,
    uncmpSize: parseInt(s.slice(idx1 + 1, idx2), 16) >>> 0,
    cmpSize: parseInt(s.slice(idx2 + 1, idx3), 16) >>> 0,
    virtualPath: s.slice(idx3 + 1),
  };
}

export function buildPathString(f: PathStringFields): string {
  return `${f.posUnits.toString(16)}:${f.uncmpSize.toString(16)}:${f.cmpSize.toString(16)}:${f.virtualPath}`;
}
