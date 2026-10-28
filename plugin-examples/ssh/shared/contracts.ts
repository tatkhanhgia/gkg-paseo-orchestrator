import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

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
