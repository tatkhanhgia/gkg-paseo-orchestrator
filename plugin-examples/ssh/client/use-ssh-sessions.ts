import { useQuery } from "@tanstack/react-query";
import { usePaseo } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import type { SshHostEntry } from "../shared/hosts";
import { openSshSession } from "./connect";

function describeError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The ssh sessions running in a workspace: the plugin's owned terminals. They outlive the screen,
 * so the list is read from the daemon each time. Owned terminals send no push events; callers
 * refresh when a session ends.
 */
export function useSshSessions(workspaceId: string | null, refreshToken = 0) {
  const paseo = usePaseo();
  const query = useQuery({
    queryKey: ["ssh", "sessions", workspaceId, refreshToken],
    enabled: workspaceId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (workspaceId === null) return [];
      return (await paseo.terminals.list({ workspaceId, owned: true })).entries;
    },
  });
  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  /** Starts ssh to `entry` and returns the new session's id once it is listed. */
  const open = useCallback(
    async (entry: SshHostEntry): Promise<string> => {
      if (workspaceId === null) throw new Error("Choose a target workspace first.");
      const handle = await openSshSession(paseo, workspaceId, entry);
      await refetch();
      return handle.id;
    },
    [paseo, refetch, workspaceId],
  );
  const close = useCallback(
    async (id: string) => {
      await paseo.terminals.ref(id).kill();
      await refetch();
    },
    [paseo, refetch],
  );
  return {
    sessions: query.data ?? [],
    error: describeError(query.error),
    open,
    close,
    refresh,
  };
}
