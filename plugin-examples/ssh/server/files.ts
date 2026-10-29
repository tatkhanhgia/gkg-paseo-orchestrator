import { unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { z } from "zod";
import type {
  FileEntry,
  FileFailure,
  downloadFileRpc,
  listRemoteFilesRpc,
  listWorkspaceFilesRpc,
  uploadFileRpc,
} from "../shared/contracts";
import {
  describeInvalidRemoteName,
  describeInvalidRemotePath,
  describeUnsafeFileName,
  remoteBasename,
  remoteJoin,
  remoteParent,
} from "../shared/remote-path";
import {
  createDownloadTarget,
  listWorkspaceDirectory,
  openUploadSource,
  resolveRoot,
  type UploadSource,
} from "./local-files";
import { SftpClient, SftpStatusError } from "./sftp-client";
import { kindFromPermissions, SftpProtocolError, StatusCode } from "./sftp-wire";
import { FileOpError, withSftp } from "./ssh-transport";

type Paseo = import("@getpaseo/plugin/server").PluginHandlerContext["paseo"];
type Input<Contract extends { input: z.ZodType }> = z.output<Contract["input"]>;

const LIST_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 30 * 60_000;
const MAX_TRANSFER_BYTES = 2 * 1024 ** 3;
const MAX_REMOTE_ENTRIES = 2000;
const SYMLINK_RESOLVE_LIMIT = 200;
const CHUNK_BYTES = 32 * 1024;
const WINDOW = 16;
/** Each operation spawns its own ssh, so cap how many run at once. */
const MAX_CONCURRENT_OPERATIONS = 4;

let activeOperations = 0;

function failure(code: FileFailure["code"], message: string): FileFailure {
  return { ok: false, code, message };
}

function toFailure(error: unknown): FileFailure {
  if (error instanceof FileOpError) return failure(error.code, error.message);
  if (error instanceof SftpStatusError) {
    if (error.status === StatusCode.NoSuchFile) {
      return failure("not-found", "That path does not exist on the remote host.");
    }
    if (error.status === StatusCode.PermissionDenied) {
      return failure("permission", "The remote host denied access to that path.");
    }
    return failure("failed", `The remote host refused the request: ${error.message}`);
  }
  if (error instanceof SftpProtocolError) {
    return failure("failed", "The remote host sent an invalid SFTP reply.");
  }
  return failure("failed", error instanceof Error ? error.message : String(error));
}

async function capture<T extends object>(
  operation: () => Promise<T>,
): Promise<({ ok: true } & T) | FileFailure> {
  try {
    return { ok: true as const, ...(await operation()) };
  } catch (error) {
    return toFailure(error);
  }
}

/** Like `capture`, for operations that start an ssh process. */
async function limited<T extends object>(
  operation: () => Promise<T>,
): Promise<({ ok: true } & T) | FileFailure> {
  if (activeOperations >= MAX_CONCURRENT_OPERATIONS) {
    return failure("busy", "Too many file operations are running. Try again in a moment.");
  }
  activeOperations += 1;
  try {
    return await capture(operation);
  } finally {
    activeOperations -= 1;
  }
}

function noop(): void {}

async function workspaceDirectory(paseo: Paseo, workspaceId: string): Promise<string> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace?.workspaceDirectory) {
    throw new FileOpError("not-found", "This workspace has no directory on the daemon host.");
  }
  return workspace.workspaceDirectory;
}

function requireValidRemotePath(value: string, field: string): void {
  const reason = describeInvalidRemotePath(value);
  if (reason) throw new FileOpError("invalid", `The ${field} ${reason}.`);
}

async function requireRemoteDirectory(client: SftpClient, remotePath: string): Promise<string> {
  const resolved = await client.realpath(remotePath);
  const attrs = await client.stat(resolved);
  if (kindFromPermissions(attrs.permissions) !== "directory") {
    throw new FileOpError("not-a-directory", "That remote path is not a directory.");
  }
  return resolved;
}

async function describeRemoteEntries(
  client: SftpClient,
  directory: string,
  listed: Awaited<ReturnType<SftpClient["readdir"]>>["entries"],
): Promise<FileEntry[]> {
  let linksLeft = SYMLINK_RESOLVE_LIMIT;
  const entries = await Promise.all(
    listed.map(async (entry): Promise<FileEntry | null> => {
      if (describeInvalidRemoteName(entry.name)) return null;
      let attrs = entry.attrs;
      let kind = entry.kind;
      if (kind === "symlink" && linksLeft > 0) {
        linksLeft -= 1;
        // stat follows the link; a broken or denied link stays a plain symlink entry.
        const target = await client.stat(remoteJoin(directory, entry.name)).catch(() => null);
        if (target) {
          attrs = target;
          kind = kindFromPermissions(target.permissions);
        }
      }
      return {
        name: entry.name,
        kind,
        size: kind === "file" && attrs.size !== undefined ? attrs.size : null,
        mtime: attrs.mtime ?? null,
      };
    }),
  );
  return entries
    .filter((entry): entry is FileEntry => entry !== null)
    .sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );
}

export function listRemoteFiles(input: Input<typeof listRemoteFilesRpc>) {
  return limited(async () => {
    if (input.path !== undefined) requireValidRemotePath(input.path, "remote path");
    return withSftp(input.target, { timeoutMs: LIST_TIMEOUT_MS }, async (client) => {
      // "." is the start directory of an SFTP session, which is the remote home.
      const resolved = await requireRemoteDirectory(client, input.path ?? ".");
      const { entries, truncated } = await client.readdir(resolved, MAX_REMOTE_ENTRIES);
      return {
        path: resolved,
        parent: remoteParent(resolved),
        entries: await describeRemoteEntries(client, resolved, entries),
        truncated,
      };
    });
  });
}

export function listWorkspaceFiles(
  input: Input<typeof listWorkspaceFilesRpc>,
  { paseo }: { paseo: Paseo },
) {
  return capture(async () => {
    const root = await resolveRoot(await workspaceDirectory(paseo, input.workspaceId));
    return { root, ...(await listWorkspaceDirectory(root, input.directory ?? "")) };
  });
}

async function writeFully(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      written,
      data.length - written,
      position + written,
    );
    written += bytesWritten;
  }
}

/** Reads `size` bytes with several requests in flight; replies are consumed in offset order. */
async function copyRemoteToLocal(
  client: SftpClient,
  remote: Buffer,
  local: FileHandle,
  size: number,
): Promise<void> {
  const inflight: { offset: number; length: number; reply: Promise<Buffer | null> }[] = [];
  let nextOffset = 0;
  const fill = () => {
    while (inflight.length < WINDOW && nextOffset < size) {
      const length = Math.min(CHUNK_BYTES, size - nextOffset);
      const reply = client.read(remote, nextOffset, length);
      reply.catch(noop);
      inflight.push({ offset: nextOffset, length, reply });
      nextOffset += length;
    }
  };
  fill();
  for (let head = inflight.shift(); head; head = inflight.shift()) {
    let received = 0;
    let data = await head.reply;
    for (;;) {
      if (data === null || received + data.length > head.length) {
        throw new FileOpError(
          "failed",
          "The remote file changed or the server misbehaved during the download.",
        );
      }
      await writeFully(local, data, head.offset + received);
      received += data.length;
      if (received === head.length) break;
      // A short read: ask again for the rest of this chunk only.
      data = await client.read(remote, head.offset + received, head.length - received);
    }
    fill();
  }
}

export function downloadFile(input: Input<typeof downloadFileRpc>, { paseo }: { paseo: Paseo }) {
  return limited(async () => {
    requireValidRemotePath(input.remotePath, "remote path");
    const name = remoteBasename(input.remotePath);
    const nameProblem = describeUnsafeFileName(name);
    if (nameProblem) throw new FileOpError("invalid", `The remote file name ${nameProblem}.`);
    const root = await resolveRoot(await workspaceDirectory(paseo, input.workspaceId));
    // Create the local file first: an existing file stops the download before any network use.
    const { handle: local, filePath } = await createDownloadTarget(root, name);
    let complete = false;
    try {
      const size = await withSftp(
        input.target,
        { timeoutMs: TRANSFER_TIMEOUT_MS },
        async (client) => {
          const attrs = await client.stat(input.remotePath);
          if (kindFromPermissions(attrs.permissions) !== "file") {
            throw new FileOpError("not-a-file", "Only regular files can be downloaded.");
          }
          const remoteSize = attrs.size ?? 0;
          if (remoteSize > MAX_TRANSFER_BYTES) {
            throw new FileOpError("too-large", "That file is larger than the 2 GiB limit.");
          }
          const remote = await client.openRead(input.remotePath);
          try {
            await copyRemoteToLocal(client, remote, local, remoteSize);
          } finally {
            await client.close(remote).catch(noop);
          }
          return remoteSize;
        },
      );
      complete = true;
      return { fileName: name, size };
    } finally {
      await local.close().catch(noop);
      // This process created the file exclusively, so a partial copy is its to remove.
      if (!complete) await unlink(filePath).catch(noop);
    }
  });
}

async function readFully(source: UploadSource, buffer: Buffer, position: number): Promise<void> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await source.handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    if (bytesRead === 0) {
      throw new FileOpError("failed", "The local file changed during the upload.");
    }
    filled += bytesRead;
  }
}

async function copyLocalToRemote(
  client: SftpClient,
  remote: Buffer,
  source: UploadSource,
): Promise<void> {
  const inflight: Promise<void>[] = [];
  for (let offset = 0; offset < source.size; ) {
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, source.size - offset));
    await readFully(source, chunk, offset);
    const reply = client.write(remote, offset, chunk);
    reply.catch(noop);
    inflight.push(reply);
    if (inflight.length >= WINDOW) await inflight.shift();
    offset += chunk.length;
  }
  await Promise.all(inflight);
}

export function uploadFile(input: Input<typeof uploadFileRpc>, { paseo }: { paseo: Paseo }) {
  return limited(async () => {
    requireValidRemotePath(input.remoteDirectory, "remote directory");
    const root = await resolveRoot(await workspaceDirectory(paseo, input.workspaceId));
    const source = await openUploadSource(root, input.localPath);
    try {
      if (source.size > MAX_TRANSFER_BYTES) {
        throw new FileOpError("too-large", "That file is larger than the 2 GiB limit.");
      }
      return await withSftp(input.target, { timeoutMs: TRANSFER_TIMEOUT_MS }, async (client) => {
        const directory = await requireRemoteDirectory(client, input.remoteDirectory);
        const remotePath = remoteJoin(directory, source.name);
        if (await client.lstat(remotePath)) {
          throw new FileOpError(
            "exists",
            `"${source.name}" already exists in ${directory}. Nothing was changed.`,
          );
        }
        // O_EXCL again on the server, so a file created since the check is not overwritten.
        const remote = await client.openCreateExclusive(remotePath, source.mode);
        let complete = false;
        try {
          await copyLocalToRemote(client, remote, source);
          await client.close(remote);
          complete = true;
        } finally {
          if (!complete) {
            await client.close(remote).catch(noop);
            // The exclusive create above makes this file ours, so remove the partial copy.
            await client.remove(remotePath).catch(noop);
          }
        }
        return { remotePath, size: source.size };
      });
    } finally {
      await source.handle.close().catch(noop);
    }
  });
}
