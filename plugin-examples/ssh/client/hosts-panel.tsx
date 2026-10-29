import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { SshScreen } from "./ssh-screen";
import type { TargetWorkspace } from "./types";

/** The workspace-tab panel: the workspace it sits in is the target, so there is no picker. */
export function HostsPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useMemo<TargetWorkspace>(() => ({ id: workspaceId }), [workspaceId]);
  return <SshScreen theme={theme} layout={layout} workspace={workspace} />;
}
