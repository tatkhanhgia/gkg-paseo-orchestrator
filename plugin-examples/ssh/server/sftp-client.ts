import type { Readable, Writable } from "node:stream";
import {
  encodePacket,
  kindFromPermissions,
  MAX_FRAME_BYTES,
  OpenFlag,
  PacketReader,
  PacketType,
  PacketWriter,
  readAttrs,
  SftpProtocolError,
  StatusCode,
  writeEmptyAttrs,
  writePermissionsAttrs,
  type FileKind,
  type SftpAttrs,
} from "./sftp-wire";

const PROTOCOL_VERSION = 3;

/** The server answered a request with a non-OK SFTP status. */
export class SftpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DirectoryEntry {
  name: string;
  kind: FileKind;
  attrs: SftpAttrs;
}

interface Response {
  type: number;
  reader: PacketReader;
}

interface Pending {
  resolve(response: Response): void;
  reject(error: Error): void;
}

/**
 * An SFTP v3 client over a byte stream pair. Requests carry an id, so several can be in flight;
 * the server's answers are matched back by id. Every path is sent as a length-prefixed byte
 * string, so no path can be read as anything but a path.
 */
export class SftpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private versionPending: Pending | null = null;
  private buffered: Buffer = Buffer.alloc(0);
  private failure: Error | null = null;

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    output.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  /**
   * Rejects every request in flight and every later one. The first failure wins. The owner of
   * the streams calls this when they close or fail, so it can attach the real cause.
   */
  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.versionPending?.reject(error);
    this.versionPending = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async init(): Promise<void> {
    if (this.failure) throw this.failure;
    const version = new Promise<Response>((resolve, reject) => {
      this.versionPending = { resolve, reject };
    });
    this.send(PacketType.Init, new PacketWriter().u32(PROTOCOL_VERSION).toBuffer());
    const { reader } = await version;
    if (reader.u32() < PROTOCOL_VERSION) {
      throw new SftpProtocolError("The server speaks an older SFTP version than 3");
    }
  }

  async realpath(path: string): Promise<string> {
    const response = await this.request(PacketType.RealPath, (w) => w.string(path));
    const names = this.names(response);
    if (names.length === 0) throw new SftpProtocolError("REALPATH returned no name");
    return names[0].name;
  }

  async stat(path: string): Promise<SftpAttrs> {
    return this.attrs(await this.request(PacketType.Stat, (w) => w.string(path)));
  }

  /** Attributes without following a final symlink, or `null` when nothing exists at `path`. */
  async lstat(path: string): Promise<SftpAttrs | null> {
    try {
      return this.attrs(await this.request(PacketType.Lstat, (w) => w.string(path)));
    } catch (error) {
      if (error instanceof SftpStatusError && error.status === StatusCode.NoSuchFile) return null;
      throw error;
    }
  }

  /** Lists a directory, skipping `.` and `..`, and stops reading after `limit` entries. */
  async readdir(
    path: string,
    limit: number,
  ): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
    const handle = this.handle(await this.request(PacketType.OpenDir, (w) => w.string(path)));
    const entries: DirectoryEntry[] = [];
    try {
      for (;;) {
        const response = await this.request(PacketType.ReadDir, (w) => w.string(handle));
        if (response.type === PacketType.Status) {
          const status = this.statusOf(response);
          if (status.code === StatusCode.Eof) return { entries, truncated: false };
          throw new SftpStatusError(status.code, status.message);
        }
        for (const entry of this.names(response)) {
          if (entry.name === "." || entry.name === "..") continue;
          if (entries.length >= limit) return { entries, truncated: true };
          entries.push(entry);
        }
      }
    } finally {
      await this.close(handle).catch(() => undefined);
    }
  }

  async openRead(path: string): Promise<Buffer> {
    return this.handle(
      await this.request(PacketType.Open, (w) => {
        w.string(path).u32(OpenFlag.Read);
        writeEmptyAttrs(w);
      }),
    );
  }

  /** Creates `path` and fails if anything already exists there (`O_CREAT | O_EXCL`). */
  async openCreateExclusive(path: string, permissions: number): Promise<Buffer> {
    return this.handle(
      await this.request(PacketType.Open, (w) => {
        w.string(path).u32(OpenFlag.Write | OpenFlag.Create | OpenFlag.Exclusive);
        writePermissionsAttrs(w, permissions);
      }),
    );
  }

  /** Reads up to `length` bytes at `offset`; `null` at end of file. */
  async read(handle: Buffer, offset: number, length: number): Promise<Buffer | null> {
    const response = await this.request(PacketType.Read, (w) =>
      w.string(handle).u64(offset).u32(length),
    );
    if (response.type === PacketType.Data) {
      const data = response.reader.bytes();
      // End of file is a STATUS reply, so empty DATA would make a copy loop spin forever, and
      // more than was asked for would write past the chunk's slot in the destination.
      if (data.length === 0) throw new SftpProtocolError("The server sent an empty DATA reply");
      if (data.length > length) throw new SftpProtocolError("The server sent more data than asked");
      return data;
    }
    if (response.type === PacketType.Status) {
      const status = this.statusOf(response);
      if (status.code === StatusCode.Eof) return null;
      throw new SftpStatusError(status.code, status.message);
    }
    throw new SftpProtocolError(`Unexpected SFTP reply ${response.type} to READ`);
  }

  async write(handle: Buffer, offset: number, data: Buffer): Promise<void> {
    this.expectOk(
      await this.request(PacketType.Write, (w) => w.string(handle).u64(offset).string(data)),
    );
  }

  async close(handle: Buffer): Promise<void> {
    this.expectOk(await this.request(PacketType.Close, (w) => w.string(handle)));
  }

  async remove(path: string): Promise<void> {
    this.expectOk(await this.request(PacketType.Remove, (w) => w.string(path)));
  }

  private send(type: number, body: Buffer): void {
    this.input.write(encodePacket(type, body));
  }

  private request(type: number, build: (writer: PacketWriter) => void): Promise<Response> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff_ffff ? 1 : this.nextId + 1;
    const writer = new PacketWriter().u32(id);
    build(writer);
    return new Promise<Response>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(type, writer.toBuffer());
    });
  }

  private receive(chunk: Buffer): void {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    try {
      while (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new SftpProtocolError(`SFTP frame of ${length} bytes is out of range`);
        }
        if (this.buffered.length < 4 + length) return;
        const frame = this.buffered.subarray(4, 4 + length);
        this.buffered = this.buffered.subarray(4 + length);
        this.dispatch(frame);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private dispatch(frame: Buffer): void {
    const type = frame[0];
    const reader = new PacketReader(frame.subarray(1));
    if (type === PacketType.Version) {
      this.versionPending?.resolve({ type, reader });
      this.versionPending = null;
      return;
    }
    const id = reader.u32();
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve({ type, reader });
  }

  private statusOf(response: Response): { code: number; message: string } {
    const code = response.reader.u32();
    return { code, message: response.reader.string() };
  }

  private expectOk(response: Response): void {
    if (response.type !== PacketType.Status) {
      throw new SftpProtocolError(`Unexpected SFTP reply ${response.type}`);
    }
    const status = this.statusOf(response);
    if (status.code !== StatusCode.Ok) throw new SftpStatusError(status.code, status.message);
  }

  private handle(response: Response): Buffer {
    if (response.type === PacketType.Handle) return response.reader.bytes();
    this.expectOk(response);
    throw new SftpProtocolError("The server returned no handle");
  }

  private attrs(response: Response): SftpAttrs {
    if (response.type === PacketType.Attrs) return readAttrs(response.reader);
    this.expectOk(response);
    throw new SftpProtocolError("The server returned no attributes");
  }

  private names(response: Response): DirectoryEntry[] {
    if (response.type !== PacketType.Name) {
      this.expectOk(response);
      throw new SftpProtocolError("The server returned no names");
    }
    const count = response.reader.u32();
    const entries: DirectoryEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = response.reader.string();
      response.reader.bytes();
      const attrs = readAttrs(response.reader);
      entries.push({ name, kind: kindFromPermissions(attrs.permissions), attrs });
    }
    return entries;
  }
}
