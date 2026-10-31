import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { UsageSourceRegistration } from "./usage.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";

export interface PluginHandlerContext {
  paseo: PaseoApi;
}

export type PluginSettingsState<Schema extends ZodType> =
  | {
      status: "ready";
      revision: string;
      values: ZodOutput<Schema>;
    }
  | {
      status: "invalid";
      revision: string;
      error: string;
    };

export interface PluginSettings<Schema extends ZodType> {
  read(): Promise<PluginSettingsState<Schema>>;
  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>): PluginCleanup;
}

/** A file the user picked on their device with `useDeviceFiles().pick()` in the plugin's UI. */
export interface PluginDeviceUpload {
  id: string;
  fileName: string;
}

export interface PluginResolvedDeviceUpload {
  /** Absolute path of the uploaded file on the daemon host. */
  path: string;
  size: number;
  /** Deletes the upload. Call it when the file has been used. */
  remove(): Promise<void>;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  /**
   * Resolves a device upload handle to its file on the daemon host. Rejects for anything that is
   * not an existing upload, so a handle from the UI cannot name another file. Absent on older
   * daemons; check before use.
   */
  resolveDeviceUpload?(upload: PluginDeviceUpload): Promise<PluginResolvedDeviceUpload>;
  registerSettings<Schema extends ZodType>(
    definition: import("../settings.js").SettingsDefinition<Schema>,
  ): PluginSettings<Schema>;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
  registerUsageSource(source: UsageSourceRegistration): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
