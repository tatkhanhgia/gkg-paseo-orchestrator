import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { MAX_REMOTE_PATH_LENGTH } from "./remote-path";

/** A `Host` entry read from the daemon user's ssh config. Display data only. */
export const configHostSchema = z.object({
  alias: z.string(),
  hostName: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().optional(),
  identityFile: z.string().optional(),
});
export type SshConfigHost = z.infer<typeof configHostSchema>;

/** A host the user added in the plugin. Holds no password, passphrase, or key contents. */
export const userHostSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(255),
  user: z.string().trim().max(128).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().trim().max(1024).optional(),
});
export type SshUserHost = z.infer<typeof userHostSchema>;

export const hostsSettings = defineSettings({
  id: "hosts",
  scope: "host",
  version: 1,
  schema: z.object({ hosts: z.array(userHostSchema).max(200).default([]) }),
});

/** The workspace the surface opens terminals in and transfers files to; remembered across sessions. */
export const targetWorkspaceSettings = defineSettings({
  id: "target-workspace",
  scope: "host",
  version: 1,
  schema: z.object({ workspaceId: z.string().min(1).max(256).optional() }),
});

export const listConfigHostsRpc = defineRpc({
  name: "ssh.config-hosts",
  input: z.object({}),
  output: z.object({
    hosts: z.array(configHostSchema),
    configPath: z.string(),
    error: z.string().optional(),
  }),
});

/** The connection fields the daemon turns into an `ssh` argv. Re-validated on the daemon. */
export const connectionTargetSchema = z.object({
  host: z.string().min(1).max(255),
  user: z.string().max(128).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().max(1024).optional(),
});

const remotePathSchema = z.string().min(1).max(MAX_REMOTE_PATH_LENGTH);
/** A path under the workspace directory, `/`-separated and relative to it. `""` is the root. */
const workspaceRelativePathSchema = z.string().max(MAX_REMOTE_PATH_LENGTH);

export const fileErrorCodeSchema = z.enum([
  "invalid",
  "auth",
  "host-key",
  "connect",
  "subsystem",
  "not-found",
  "permission",
  "exists",
  "not-a-file",
  "not-a-directory",
  "too-large",
  "busy",
  "timeout",
  "cancelled",
  "failed",
]);
export type FileErrorCode = z.infer<typeof fileErrorCodeSchema>;

const fileFailureSchema = z.object({
  ok: z.literal(false),
  code: fileErrorCodeSchema,
  message: z.string(),
});
export type FileFailure = z.infer<typeof fileFailureSchema>;

export const fileEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["directory", "file", "symlink", "other"]),
  /** Bytes, or `null` when the server did not report a size. */
  size: z.number().nullable(),
  /** Modification time in seconds since the epoch, or `null` when unknown. */
  mtime: z.number().nullable(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

const listingShape = {
  entries: z.array(fileEntrySchema),
  /** True when the directory held more entries than the listing limit. */
  truncated: z.boolean(),
};

export const listRemoteFilesRpc = defineRpc({
  name: "ssh.files.list-remote",
  input: z.object({
    target: connectionTargetSchema,
    /** Absolute or home-relative path; omit for the remote home directory. */
    path: remotePathSchema.optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      /** The directory as the server resolved it. */
      path: z.string(),
      parent: z.string().nullable(),
      ...listingShape,
    }),
    fileFailureSchema,
  ]),
});

export const listWorkspaceFilesRpc = defineRpc({
  name: "ssh.files.list-workspace",
  input: z.object({
    workspaceId: z.string().min(1),
    /** Directory relative to the workspace directory; omit for the workspace directory itself. */
    directory: workspaceRelativePathSchema.optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      /** The workspace directory on the daemon host. */
      root: z.string(),
      directory: z.string(),
      parent: z.string().nullable(),
      ...listingShape,
    }),
    fileFailureSchema,
  ]),
});

export const transferStateSchema = z.enum(["running", "done", "failed", "cancelled"]);
export type TransferState = z.infer<typeof transferStateSchema>;

/** What the panel polls for. A transfer keeps running on the daemon whether or not it is polled. */
export const transferSchema = z.object({
  id: z.string(),
  kind: z.enum(["download", "upload"]),
  /** The file's name in the workspace directory (download) or on the remote host (upload). */
  fileName: z.string(),
  state: transferStateSchema,
  bytesDone: z.number(),
  /** Total bytes, or `null` until the size is known. */
  total: z.number().nullable(),
  /** Set when `state` is `failed` or `cancelled`. */
  error: z.object({ code: fileErrorCodeSchema, message: z.string() }).optional(),
  /** Set when an upload is `done`. */
  remotePath: z.string().optional(),
});
export type Transfer = z.infer<typeof transferSchema>;

const transferStartedSchema = z.union([
  z.object({ ok: z.literal(true), transferId: z.string() }),
  fileFailureSchema,
]);

// Plugin RPCs time out on the client after 60 s, so a copy never runs inside one: these start it
// and return at once, and `transferStatusRpc` reports on it.
export const startDownloadRpc = defineRpc({
  name: "ssh.files.start-download",
  input: z.object({
    target: connectionTargetSchema,
    workspaceId: z.string().min(1),
    remotePath: remotePathSchema,
  }),
  output: transferStartedSchema,
});

export const startUploadRpc = defineRpc({
  name: "ssh.files.start-upload",
  input: z.object({
    target: connectionTargetSchema,
    workspaceId: z.string().min(1),
    /** File relative to the workspace directory. */
    localPath: workspaceRelativePathSchema.min(1),
    /** Remote directory that receives the file. */
    remoteDirectory: remotePathSchema,
  }),
  output: transferStartedSchema,
});

export const transferStatusRpc = defineRpc({
  name: "ssh.files.transfer-status",
  // A transfer is only visible to the workspace that started it.
  input: z.object({ transferId: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.union([z.object({ ok: z.literal(true), transfer: transferSchema }), fileFailureSchema]),
});

export const cancelTransferRpc = defineRpc({
  name: "ssh.files.cancel-transfer",
  input: z.object({ transferId: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.union([z.object({ ok: z.literal(true) }), fileFailureSchema]),
});
