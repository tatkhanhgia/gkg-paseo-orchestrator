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

export const downloadFileRpc = defineRpc({
  name: "ssh.files.download",
  input: z.object({
    target: connectionTargetSchema,
    workspaceId: z.string().min(1),
    remotePath: remotePathSchema,
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      /** The file's name inside the workspace directory. */
      fileName: z.string(),
      size: z.number(),
    }),
    fileFailureSchema,
  ]),
});

export const uploadFileRpc = defineRpc({
  name: "ssh.files.upload",
  input: z.object({
    target: connectionTargetSchema,
    workspaceId: z.string().min(1),
    /** File relative to the workspace directory. */
    localPath: workspaceRelativePathSchema.min(1),
    /** Remote directory that receives the file. */
    remoteDirectory: remotePathSchema,
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      remotePath: z.string(),
      size: z.number(),
    }),
    fileFailureSchema,
  ]),
});
