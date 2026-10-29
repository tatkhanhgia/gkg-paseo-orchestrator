import { useQuery } from "@tanstack/react-query";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { targetWorkspaceSettings } from "../shared/contracts";
import { resolveWorkspaceId, toWorkspaceOptions } from "../shared/workspaces";

const PAGE_SIZE = 200;
/** Stops a daemon that keeps returning a next cursor from looping the picker forever. */
const MAX_PAGES = 5;

function describeError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/** The workspaces of the selected host, with the remembered choice resolved against them. */
export function useTargetWorkspace() {
  const paseo = usePaseo();
  const settings = useSettings(targetWorkspaceSettings);
  const query = useQuery({
    queryKey: ["ssh", "workspaces"],
    queryFn: async () => {
      const found = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await paseo.workspaces.list({ page: { limit: PAGE_SIZE, cursor } });
        found.push(...result.entries);
        if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      return found;
    },
    refetchOnWindowFocus: false,
  });
  // The pick shows at once; the saved copy catches up when the settings write returns.
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const options = useMemo(() => toWorkspaceOptions(query.data ?? []), [query.data]);
  const remembered =
    picked ?? (settings.status === "ready" ? settings.values.workspaceId : undefined);
  const selectedId =
    query.data && (settings.status === "ready" || picked)
      ? resolveWorkspaceId(remembered, options)
      : null;
  const selected = options.find((option) => option.id === selectedId) ?? null;

  const choose = useCallback(
    (workspaceId: string) => {
      setPicked(workspaceId);
      if (settings.status === "ready") void settings.save({ workspaceId }, settings.revision);
    },
    [settings],
  );
  const refresh = useCallback(() => void query.refetch(), [query]);
  const error = describeError(query.error);
  return {
    options,
    selected,
    loading: query.isPending || settings.status === "loading",
    error: error ?? (settings.saveError || null),
    choose,
    refresh,
  };
}
