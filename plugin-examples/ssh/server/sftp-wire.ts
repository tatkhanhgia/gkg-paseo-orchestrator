/** SFTP protocol version 3 (draft-ietf-secsh-filexfer-02), the version OpenSSH speaks. */

export const PacketType = {
  Init: 1,
  Version: 2,
  Open: 3,
  Close: 4,
  Read: 5,
  Write: 6,
  Lstat: 7,
  Fstat: 8,
  OpenDir: 11,
  ReadDir: 12,
  Remove: 13,
  RealPath: 16,
  Stat: 17,
  Status: 101,
  Handle: 102,
  Data: 103,
  Name: 104,
  Attrs: 105,
} as const;

export const OpenFlag = { Read: 0x01, Write: 0x02, Create: 0x08, Exclusive: 0x20 } as const;

export const StatusCode = {
  Ok: 0,
  Eof: 1,
  NoSuchFile: 2,
  PermissionDenied: 3,
  Failure: 4,
} as const;

const AttrFlag = { Size: 0x1, UidGid: 0x2, Permissions: 0x4, AcModTime: 0x8, Extended: 0x80000000 };

/** Largest frame accepted from the server; OpenSSH keeps its own frames under 256 KiB. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const TWO_POW_32 = 0x1_0000_0000;
const FILE_TYPE_MASK = 0o170000;

export class SftpProtocolError extends Error {}

export class PacketWriter {
  private readonly chunks: Buffer[] = [];

  u8(value: number): this {
    this.chunks.push(Buffer.from([value]));
    return this;
  }

  u32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0);
    this.chunks.push(buffer);
    return this;
  }

  u64(value: number): this {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(value / TWO_POW_32), 0);
    buffer.writeUInt32BE(value % TWO_POW_32, 4);
    this.chunks.push(buffer);
    return this;
  }

  /** A length-prefixed byte string: the only way a path or file name reaches the server. */
  string(value: string | Buffer): this {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    this.u32(bytes.length);
    this.chunks.push(bytes);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class PacketReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  private take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.buffer.length) {
      throw new SftpProtocolError("Truncated SFTP packet");
    }
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u32(): number {
    return this.take(4).readUInt32BE();
  }

  u64(): number {
    const bytes = this.take(8);
    return bytes.readUInt32BE(0) * TWO_POW_32 + bytes.readUInt32BE(4);
  }

  bytes(): Buffer {
    return this.take(this.u32());
  }

  string(): string {
    return this.bytes().toString("utf8");
  }
}

export interface SftpAttrs {
  size?: number;
  permissions?: number;
  /** Seconds since the epoch. */
  mtime?: number;
}

export function readAttrs(reader: PacketReader): SftpAttrs {
  const flags = reader.u32();
  const attrs: SftpAttrs = {};
  if (flags & AttrFlag.Size) attrs.size = reader.u64();
  if (flags & AttrFlag.UidGid) {
    reader.u32();
    reader.u32();
  }
  if (flags & AttrFlag.Permissions) attrs.permissions = reader.u32();
  if (flags & AttrFlag.AcModTime) {
    reader.u32();
    attrs.mtime = reader.u32();
  }
  if (flags & AttrFlag.Extended) {
    const count = reader.u32();
    for (let index = 0; index < count; index += 1) {
      reader.bytes();
      reader.bytes();
    }
  }
  return attrs;
}

export function writePermissionsAttrs(writer: PacketWriter, permissions: number): void {
  writer.u32(AttrFlag.Permissions).u32(permissions);
}

export function writeEmptyAttrs(writer: PacketWriter): void {
  writer.u32(0);
}

export type FileKind = "directory" | "file" | "symlink" | "other";

export function kindFromPermissions(permissions: number | undefined): FileKind {
  switch ((permissions ?? 0) & FILE_TYPE_MASK) {
    case 0o040000:
      return "directory";
    case 0o100000:
      return "file";
    case 0o120000:
      return "symlink";
    default:
      return "other";
  }
}

/** Frames a payload as `uint32 length | byte type | body`. */
export function encodePacket(type: number, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header[4] = type;
  return Buffer.concat([header, body]);
}
