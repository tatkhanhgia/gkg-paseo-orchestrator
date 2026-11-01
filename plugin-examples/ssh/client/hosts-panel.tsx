import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SshScreen } from "./ssh-screen";

/** The workspace-tab panel: the same screen as the sidebar; the workspace it sits in plays no part. */
export function HostsPanel({ theme, layout, revision }: PluginWorkspacePanelProps) {
  return <SshScreen theme={theme} layout={layout} refreshToken={revision} />;
}
