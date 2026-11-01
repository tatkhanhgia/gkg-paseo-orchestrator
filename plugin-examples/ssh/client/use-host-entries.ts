import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useMemo } from "react";
import { hostsSettings, listConfigHostsRpc, type SshUserHost } from "../shared/contracts";
import { toHostEntries, type SshHostEntry } from "../shared/hosts";

const NO_HOSTS: SshUserHost[] = [];

export type NewHost = Omit<SshUserHost, "id">;

/**
 * Every host the screen can connect to: the user's saved hosts (plugin settings, shared by every
 * client of the daemon host) and the aliases in the daemon user's `~/.ssh/config`. Also owns
 * adding, editing, and removing the saved ones.
 */
export function useHostEntries() {
  const settings = useSettings(hostsSettings);
  const listConfigHosts = useRpc(listConfigHostsRpc);
  const config = useQuery({
    queryKey: ["ssh", "config-hosts"],
    queryFn: () => listConfigHosts({}),
  });
  const userHosts = settings.status === "ready" ? settings.values.hosts : NO_HOSTS;
  const configHosts = config.data?.hosts;
  const entries = useMemo(
    () => toHostEntries(configHosts ?? [], userHosts),
    [configHosts, userHosts],
  );

  const errors: string[] = [];
  if (settings.status === "error" || settings.status === "invalid") errors.push(settings.error);
  if (settings.saveError) errors.push(settings.saveError);
  if (config.data?.error) {
    errors.push(`Could not read ${config.data.configPath}: ${config.data.error}`);
  }

  const remove = useCallback(
    (entry: SshHostEntry) => {
      if (settings.status !== "ready") return;
      const id = entry.key.slice("user:".length);
      void settings.save(
        { hosts: settings.values.hosts.filter((host) => host.id !== id) },
        settings.revision,
      );
    },
    [settings],
  );
  const add = useCallback(
    async (host: NewHost) => {
      if (settings.status !== "ready") return false;
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      return settings.save(
        { hosts: [...settings.values.hosts, { ...host, id }] },
        settings.revision,
      );
    },
    [settings],
  );
  const update = useCallback(
    async (id: string, host: NewHost) => {
      if (settings.status !== "ready") return false;
      return settings.save(
        {
          hosts: settings.values.hosts.map((current) =>
            current.id === id ? { ...host, id } : current,
          ),
        },
        settings.revision,
      );
    },
    [settings],
  );

  return {
    entries,
    userHosts,
    errors,
    loading: settings.status === "loading",
    ready: settings.status === "ready",
    saving: settings.saving,
    /** True once both reads finished and found nothing. */
    empty: entries.length === 0 && !config.isPending && settings.status === "ready",
    remove,
    add,
    update,
  };
}

export type HostEntries = ReturnType<typeof useHostEntries>;
