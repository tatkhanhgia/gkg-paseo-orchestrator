import type { PluginHostProps } from "@getpaseo/plugin/client";

export type Theme = PluginHostProps["theme"];
export type Layout = PluginHostProps["layout"];

/** The workspace that receives terminals and files. `name` is for messages only. */
export interface TargetWorkspace {
  id: string;
  name?: string;
}
