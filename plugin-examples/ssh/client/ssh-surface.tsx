import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo } from "react";
import type { TargetWorkspace } from "./types";
import { SshScreen } from "./ssh-screen";
import { useTargetWorkspace } from "./use-target-workspace";
import { WorkspacePicker } from "./workspace-picker";

/** The sidebar screen: no workspace is implied, so it asks for one and remembers the answer. */
export function SshSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const target = useTargetWorkspace();
  const selected = target.selected;
  const workspace = useMemo<TargetWorkspace | null>(
    () => (selected ? { id: selected.id, name: selected.label } : null),
    [selected],
  );
  // `navigation` is absent on older clients; the "Opened terminal" toast still names the workspace.
  const handleConnected = useCallback(
    (connected: TargetWorkspace) => navigation?.openWorkspace({ workspaceId: connected.id }),
    [navigation],
  );
  const picker = (
    <WorkspacePicker
      theme={theme}
      options={target.options}
      selected={selected}
      loading={target.loading}
      error={target.error}
      onChoose={target.choose}
      onRefresh={target.refresh}
    />
  );
  return (
    <SshScreen theme={theme} layout={layout} workspace={workspace} onConnected={handleConnected}>
      {picker}
    </SshScreen>
  );
}
