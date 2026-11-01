import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

/** What a plugin's UI gets back from `useDeviceFiles().pick()`, passed to its server code. */
export interface DeviceUploadHandle {
  id: string;
  fileName: string;
}

export interface ResolvedDeviceUpload {
  /** Absolute path of the uploaded file on the daemon host. */
  path: string;
  size: number;
  /** Deletes the upload. Call it once the file has been used; it never touches anything else. */
  remove(): Promise<void>;
}

// `FileUploadStore` names each upload `upload_<randomUUID()>`.
const UPLOAD_ID = /^upload_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DeviceUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceUploadError";
  }
}

/**
 * Resolves a device upload handle to its file under `uploadsDirectory`. The id must have the
 * shape the upload store gives it and the name must be a single path segment, so a handle cannot
 * name any other file. The upload's directory must resolve to itself (no symlinked directory),
 * and the file must be a regular file, not a link.
 */
export async function resolveDeviceUpload(
  uploadsDirectory: string,
  handle: DeviceUploadHandle,
): Promise<ResolvedDeviceUpload> {
  if (!UPLOAD_ID.test(handle.id)) throw new DeviceUploadError("Unknown upload.");
  const name = handle.fileName;
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new DeviceUploadError("Unknown upload.");
  }
  const root = await realpath(uploadsDirectory).catch(() => {
    throw new DeviceUploadError("Unknown upload.");
  });
  const directory = path.join(root, handle.id);
  const resolvedDirectory = await realpath(directory).catch(() => {
    throw new DeviceUploadError("The upload no longer exists.");
  });
  if (resolvedDirectory !== directory) throw new DeviceUploadError("Unknown upload.");
  const filePath = path.join(directory, name);
  const info = await lstat(filePath).catch(() => {
    throw new DeviceUploadError("The upload no longer exists.");
  });
  if (!info.isFile()) throw new DeviceUploadError("Unknown upload.");
  return {
    path: filePath,
    size: info.size,
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
