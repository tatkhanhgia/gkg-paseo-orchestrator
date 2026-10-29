import { unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { z } from "zod";
import type {
  FileEntry,
  FileFailure,
  cancelTransferRpc,
  listRemoteFilesRpc,
  listWorkspaceFilesRpc,
  startDownloadRpc,
  startUploadRpc,
  transferStatusRpc,
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
  describeErrno,
  listWorkspaceDirectory,
  openUploadSource,
  resolveRoot,
  type UploadSource,
} from "./local-files";
import { SftpClient, SftpStatusError } from "./sftp-client";
import { kindFromPermissions, SftpProtocolError, StatusCode } from "./sftp-wire";
import { FileOpError, withSftp } from "./ssh-transport";
import { toTransfer, TransferRegistry, type TransferRecord } from "./transfers";

type Paseo = import("@getpaseo/plugin/server").PluginHandlerContext["paseo"];
type Input<Contract extends { input: z.ZodType }> = z.output<Contract["input"]>;
interface Context {
  paseo: Paseo;
}

// Plugin RPCs time out on the client after 60 s. Every RPC below returns well inside that:
// listings stop at 25 s, and copies run in the background behind start/status/cancel RPCs.
const LIST_TIMEOUT_MS = 25_000;
const TRANSFER_TIMEOUT_MS = 30 * 60_000;
export const MAX_TRANSFER_BYTES = 2 * 1024 ** 3;
const MAX_REMOTE_ENTRIES = 2000;
const SYMLINK_RESOLVE_LIMIT = 200;
const CHUNK_BYTES = 32 * 1024;
const WINDOW = 16;
/** Each listing spawns its own ssh, so cap how many run at once. */
const MAX_CONCURRENT_LISTINGS = 4;

let activeListings = 0;
const transfers = new TransferRegistry();

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
    return failure(
      "failed",
      "The remote host refused the operation. Its disk may be full or over quota, or the path may not allow it.",
    );
  }
  if (error instanceof SftpProtocolError) {
    return failure("failed", "The remote host sent an invalid SFTP reply.");
  }
  const known = describeErrno((error as NodeJS.ErrnoException | undefined)?.code);
  if (known) return failure(known.code, known.message);
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

/** Like `capture`, for listings that start an ssh process. */
async function limitedListing<T extends object>(
  operation: () => Promise<T>,
): Promise<({ ok: true } & T) | FileFailure> {
  if (activeListings >= MAX_CONCURRENT_LISTINGS) {
    return failure("busy", "Too many listings are running. Try again in a moment.");
  }
  activeListings += 1;
  try {
    return await capture(operation);
  } finally {
    activeListings -= 1;
  }
}

function noop(): void {}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new FileOpError("cancelled", "The transfer was cancelled.");
}

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
  return limitedListing(async () => {
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

export function listWorkspaceFiles(input: Input<typeof listWorkspaceFilesRpc>, ctx: Context) {
  return capture(async () => {
    const root = await resolveRoot(await workspaceDirectory(ctx.paseo, input.workspaceId));
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
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
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
    throwIfCancelled(signal);
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
      onProgress(data.length);
      if (received === head.length) break;
      // A short read: ask again for the rest of this chunk only.
      data = await client.read(remote, head.offset + received, head.length - received);
    }
    fill();
  }
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
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<void> {
  const inflight: Promise<void>[] = [];
  for (let offset = 0; offset < source.size; ) {
    throwIfCancelled(signal);
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, source.size - offset));
    await readFully(source, chunk, offset);
    const reply = client.write(remote, offset, chunk).then(() => onProgress(chunk.length));
    reply.catch(noop);
    inflight.push(reply);
    if (inflight.length >= WINDOW) await inflight.shift();
    offset += chunk.length;
  }
  await Promise.all(inflight);
}

/** Records how a transfer ended. A cancel wins over whatever error the abort caused. */
function finishWithError(record: TransferRecord, error: unknown, suffix: string): void {
  const cancelled = record.abort.signal.aborted;
  const reason = cancelled ? failure("cancelled", "The transfer was cancelled.") : toFailure(error);
  const { code, message } = reason;
  transfers.finish(record, {
    state: cancelled ? "cancelled" : "failed",
    error: { code, message: `${message}${suffix}` },
  });
}

async function runDownload(
  record: TransferRecord,
  input: Input<typeof startDownloadRpc>,
  local: FileHandle,
  filePath: string,
): Promise<void> {
  const { signal } = record.abort;
  try {
    await withSftp(input.target, { timeoutMs: TRANSFER_TIMEOUT_MS, signal }, async (client) => {
      const attrs = await client.stat(input.remotePath);
      if (kindFromPermissions(attrs.permissions) !== "file") {
        throw new FileOpError("not-a-file", "Only regular files can be downloaded.");
      }
      if (attrs.size === undefined) {
        throw new FileOpError("failed", "The remote host did not report the file's size.");
      }
      if (attrs.size > MAX_TRANSFER_BYTES) {
        throw new FileOpError("too-large", "That file is larger than the 2 GiB limit.");
      }
      record.total = attrs.size;
      const remote = await client.openRead(input.remotePath);
      try {
        await copyRemoteToLocal(client, remote, local, attrs.size, signal, (bytes) => {
          record.bytesDone += bytes;
        });
      } finally {
        await client.close(remote).catch(noop);
      }
    });
    await local.close();
    transfers.finish(record, { state: "done" });
  } catch (error) {
    await local.close().catch(noop);
    // This process created the file exclusively, so a partial copy is its to remove.
    const removed = await unlink(filePath).then(
      () => true,
      () => false,
    );
    finishWithError(
      record,
      error,
      removed
        ? ""
        : ` A partial file named "${record.fileName}" may remain in the workspace directory; delete it in the file explorer.`,
    );
  }
}

async function runUpload(
  record: TransferRecord,
  input: Input<typeof startUploadRpc>,
  source: UploadSource,
): Promise<void> {
  const { signal } = record.abort;
  let partialRemotePath: string | null = null;
  try {
    await withSftp(input.target, { timeoutMs: TRANSFER_TIMEOUT_MS, signal }, async (client) => {
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
        await copyLocalToRemote(client, remote, source, signal, (bytes) => {
          record.bytesDone += bytes;
        });
        await client.close(remote);
        complete = true;
      } finally {
        if (!complete) {
          await client.close(remote).catch(noop);
          // The exclusive create above makes this file ours, so remove the partial copy.
          const removed = await client.remove(remotePath).then(
            () => true,
            () => false,
          );
          if (!removed) partialRemotePath = remotePath;
        }
      }
      record.remotePath = remotePath;
    });
    transfers.finish(record, { state: "done" });
  } catch (error) {
    finishWithError(
      record,
      error,
      partialRemotePath
        ? ` A partial file may remain at ${partialRemotePath} on the remote host and may need to be removed manually.`
        : "",
    );
  } finally {
    await source.handle.close().catch(noop);
  }
}

const BUSY = failure("busy", "Too many transfers are running. Wait for one to finish.");

/**
 * Validates the request, creates the local file, and starts the copy in the background. The RPC
 * returns as soon as the transfer id exists.
 */
export async function startDownload(input: Input<typeof startDownloadRpc>, ctx: Context) {
  try {
    requireValidRemotePath(input.remotePath, "remote path");
    const name = remoteBasename(input.remotePath);
    const nameProblem = describeUnsafeFileName(name);
    if (nameProblem) throw new FileOpError("invalid", `The remote file name ${nameProblem}.`);
    const record = transfers.begin("download", name);
    if (!record) return BUSY;
    try {
      const root = await resolveRoot(await workspaceDirectory(ctx.paseo, input.workspaceId));
      // Create the local file first: an existing file stops the download before any network use.
      const { handle, filePath } = await createDownloadTarget(root, name);
      void runDownload(record, input, handle, filePath);
    } catch (error) {
      transfers.discard(record);
      throw error;
    }
    return { ok: true as const, transferId: record.id };
  } catch (error) {
    return toFailure(error);
  }
}

export async function startUpload(input: Input<typeof startUploadRpc>, ctx: Context) {
  try {
    requireValidRemotePath(input.remoteDirectory, "remote directory");
    const record = transfers.begin("upload", input.localPath.split("/").at(-1) ?? "");
    if (!record) return BUSY;
    try {
      const root = await resolveRoot(await workspaceDirectory(ctx.paseo, input.workspaceId));
      const source = await openUploadSource(root, input.localPath);
      if (source.size > MAX_TRANSFER_BYTES) {
        await source.handle.close();
        throw new FileOpError("too-large", "That file is larger than the 2 GiB limit.");
      }
      record.fileName = source.name;
      record.total = source.size;
      void runUpload(record, input, source);
    } catch (error) {
      transfers.discard(record);
      throw error;
    }
    return { ok: true as const, transferId: record.id };
  } catch (error) {
    return toFailure(error);
  }
}

export function transferStatus(input: Input<typeof transferStatusRpc>) {
  const record = transfers.get(input.transferId);
  if (!record) {
    return failure("not-found", "That transfer is no longer known to the daemon.");
  }
  return { ok: true as const, transfer: toTransfer(record) };
}

/** Asks a running transfer to stop. It then removes its partial file and ends `cancelled`. */
export function cancelTransfer(input: Input<typeof cancelTransferRpc>) {
  const record = transfers.get(input.transferId);
  if (!record) return failure("not-found", "That transfer is no longer known to the daemon.");
  if (record.state === "running") record.abort.abort();
  return { ok: true as const };
}
