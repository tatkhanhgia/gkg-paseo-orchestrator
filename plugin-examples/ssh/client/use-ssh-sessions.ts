import { useQuery } from "@tanstack/react-query";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { startSessionRpc } from "../shared/contracts";
import type { SshHostEntry } from "../shared/hosts";
import { openSshSession } from "./connect";

function describeError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The running ssh sessions: the plugin's owned terminals on this host, which belong to no
 * workspace. They outlive the screen, so the list is read from the daemon each time. Owned
 * terminals send no push events; callers refresh when a session ends.
 */
export function useSshSessions(refreshToken = 0) {
  const paseo = usePaseo();
  const startSession = useRpc(startSessionRpc);
  const query = useQuery({
    queryKey: ["ssh", "sessions", refreshToken],
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => (await paseo.terminals.list({ owned: true })).entries,
  });
  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  /** Starts ssh to `entry` and returns the new session's id once it is listed. */
  const open = useCallback(
    async (entry: SshHostEntry): Promise<string> => {
      const session = await openSshSession(startSession, entry);
      await refetch();
      return session.id;
    },
    [startSession, refetch],
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
