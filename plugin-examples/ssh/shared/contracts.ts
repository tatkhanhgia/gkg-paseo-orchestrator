import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { MAX_REMOTE_PATH_LENGTH } from "./remote-path";
import { hasControlCharacter } from "./ssh-args";

/** A `Host` entry read from the daemon user's ssh config. Display data only. */
export const configHostSchema = z.object({
  alias: z.string(),
  hostName: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().optional(),
  identityFile: z.string().optional(),
});
export type SshConfigHost = z.infer<typeof configHostSchema>;

const vpnPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (value) => value.startsWith("/") && !hasControlCharacter(value),
    "must be an absolute path without control characters",
  );

/** Name of a VPN profile: how a host refers to it. */
export const vpnProfileNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "use letters, digits, '.', '_' or '-' (up to 64)");

/**
 * How to open the shared on-demand VPN for hosts that need it. Paths are daemon-host paths to the
 * shared `vpn_session.sh`, the openvpn binary, its config, and its management socket. They live in
 * the plugin settings and nowhere else: a client names a profile, never a path.
 */
export const vpnProfileSchema = z.object({
  name: vpnProfileNameSchema,
  script: vpnPathSchema,
  openvpnPath: vpnPathSchema,
  config: vpnPathSchema,
  managementSocket: vpnPathSchema,
});
export type SshVpnProfile = z.infer<typeof vpnProfileSchema>;

/** A host the user added in the plugin. Holds no password, passphrase, or key contents. */
export const userHostSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(255),
  user: z.string().trim().max(128).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().trim().max(1024).optional(),
  /** A `vpnProfiles` name: open that VPN for this host's sessions and file operations. */
  vpnProfile: vpnProfileNameSchema.optional(),
});
export type SshUserHost = z.infer<typeof userHostSchema>;

export const hostsSettings = defineSettings({
  id: "hosts",
  scope: "host",
  version: 1,
  // `vpnProfiles` and a host's `vpnProfile` were added without a version bump: both are optional or
  // defaulted, so every document saved before them still parses unchanged.
  schema: z.object({
    hosts: z.array(userHostSchema).max(200).default([]),
    vpnProfiles: z.array(vpnProfileSchema).max(20).default([]),
  }),
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
  /** A `vpnProfiles` name; the daemon looks it up in the plugin settings. */
  vpnProfile: z.string().max(64).optional(),
});

const remotePathSchema = z.string().min(1).max(MAX_REMOTE_PATH_LENGTH);

/** A running ssh session: a terminal the plugin owns, outside every workspace. */
export const sessionSchema = z.object({ id: z.string(), cwd: z.string(), name: z.string() });

/** Starts `ssh` in a terminal the plugin owns. It belongs to no workspace. */
export const startSessionRpc = defineRpc({
  name: "ssh.sessions.start",
  input: z.object({ target: connectionTargetSchema, label: z.string().max(80) }),
  output: z.union([
    z.object({ ok: z.literal(true), session: sessionSchema }),
    z.object({ ok: z.literal(false), message: z.string() }),
  ]),
});

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

export const transferStateSchema = z.enum(["running", "done", "failed", "cancelled"]);
export type TransferState = z.infer<typeof transferStateSchema>;

/** What the panel polls for. A transfer keeps running on the daemon whether or not it is polled. */
export const transferSchema = z.object({
  id: z.string(),
  kind: z.enum(["download", "upload"]),
  /** The file's name: on the remote host for a download, as picked on the device for an upload. */
  fileName: z.string(),
  state: transferStateSchema,
  bytesDone: z.number(),
  /** Total bytes, or `null` until the size is known. */
  total: z.number().nullable(),
  /** Set when `state` is `failed` or `cancelled`. */
  error: z.object({ code: fileErrorCodeSchema, message: z.string() }).optional(),
  /** Set when an upload is `done`. */
  remotePath: z.string().optional(),
  /**
   * Set when a download is `done`: the copy on the daemon host, waiting to be saved to the device
   * with `useDeviceFiles().save()`. Call `releaseDownloadRpc` after saving.
   */
  staged: z.object({ directory: z.string(), path: z.string() }).optional(),
});
export type Transfer = z.infer<typeof transferSchema>;

const transferStartedSchema = z.union([
  z.object({ ok: z.literal(true), transferId: z.string() }),
  fileFailureSchema,
]);

// Plugin RPCs time out on the client after 60 s, so a copy never runs inside one: these start it
// and return at once, and `transferStatusRpc` reports on it.
/** Copies a remote file into a private staging directory on the daemon host, never a workspace. */
export const startDownloadRpc = defineRpc({
  name: "ssh.files.start-download",
  input: z.object({ target: connectionTargetSchema, remotePath: remotePathSchema }),
  output: transferStartedSchema,
});

/** Copies a file the user picked on their device (`useDeviceFiles().pick()`) to the remote host. */
export const startUploadRpc = defineRpc({
  name: "ssh.files.start-upload",
  input: z.object({
    target: connectionTargetSchema,
    upload: z.object({ id: z.string().min(1).max(128), fileName: z.string().min(1).max(255) }),
    /** Remote directory that receives the file. */
    remoteDirectory: remotePathSchema,
  }),
  output: transferStartedSchema,
});

// A transfer id is a random UUID returned only to the client that started it.
export const transferStatusRpc = defineRpc({
  name: "ssh.files.transfer-status",
  input: z.object({ transferId: z.string().min(1) }),
  output: z.union([z.object({ ok: z.literal(true), transfer: transferSchema }), fileFailureSchema]),
});

export const cancelTransferRpc = defineRpc({
  name: "ssh.files.cancel-transfer",
  input: z.object({ transferId: z.string().min(1) }),
  output: z.union([z.object({ ok: z.literal(true) }), fileFailureSchema]),
});

/** The device has the downloaded file (or gave up); the staged copy may go. */
export const releaseDownloadRpc = defineRpc({
  name: "ssh.files.release-download",
  input: z.object({ transferId: z.string().min(1) }),
  output: z.union([z.object({ ok: z.literal(true) }), fileFailureSchema]),
});
