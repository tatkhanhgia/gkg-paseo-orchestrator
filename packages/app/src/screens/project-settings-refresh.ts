import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * After a successful project config save, the workspace directory replica held by the
 * host runtime store can still reflect the pre-save script list until the next poll.
 * Ask the runtime to refresh it so workspace screens pick up added/changed/removed
 * scripts without requiring a full reload. Refresh failures are swallowed: the config
 * save itself already succeeded, so a stale-until-next-poll UI is the correct fallback
 * rather than surfacing a spurious save error.
 */
export function refreshWorkspaceScriptsAfterSave(serverId: string): void {
  void getHostRuntimeStore()
    .refreshWorkspaceDirectory({ serverId })
    .catch(() => undefined);
}
