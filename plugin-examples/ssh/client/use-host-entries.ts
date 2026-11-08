import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useMemo } from "react";
import {
  hostsSettings,
  listConfigHostsRpc,
  type SshUserHost,
  type SshVpnProfile,
} from "../shared/contracts";
import { toHostEntries, type SshHostEntry } from "../shared/hosts";

const NO_HOSTS: SshUserHost[] = [];
const NO_PROFILES: SshVpnProfile[] = [];

export type NewHost = Omit<SshUserHost, "id">;

/**
 * Every host the screen can connect to: the user's saved hosts (plugin settings, shared by every
 * client of the daemon host) and the aliases in the daemon user's `~/.ssh/config`. Also owns
 * adding, editing, and removing the saved ones, and the VPN profiles they can name. Every save
 * writes the whole settings document, so each keeps the part it does not edit.
 */
export function useHostEntries() {
  const settings = useSettings(hostsSettings);
  const listConfigHosts = useRpc(listConfigHostsRpc);
  const config = useQuery({
    queryKey: ["ssh", "config-hosts"],
    queryFn: () => listConfigHosts({}),
  });
  const userHosts = settings.status === "ready" ? settings.values.hosts : NO_HOSTS;
  const vpnProfiles = settings.status === "ready" ? settings.values.vpnProfiles : NO_PROFILES;
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
        { ...settings.values, hosts: settings.values.hosts.filter((host) => host.id !== id) },
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
        { ...settings.values, hosts: [...settings.values.hosts, { ...host, id }] },
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
          ...settings.values,
          hosts: settings.values.hosts.map((current) =>
            current.id === id ? { ...host, id } : current,
          ),
        },
        settings.revision,
      );
    },
    [settings],
  );
  /** Adds a profile, or replaces `previousName`'s. A rename also renames it on the hosts using it. */
  const saveVpnProfile = useCallback(
    async (profile: SshVpnProfile, previousName?: string) => {
      if (settings.status !== "ready") return false;
      const { hosts, vpnProfiles: current } = settings.values;
      const next = previousName
        ? current.map((existing) => (existing.name === previousName ? profile : existing))
        : [...current, profile];
      const renamedHosts =
        previousName && previousName !== profile.name
          ? hosts.map((host) =>
              host.vpnProfile === previousName ? { ...host, vpnProfile: profile.name } : host,
            )
          : hosts;
      return settings.save({ hosts: renamedHosts, vpnProfiles: next }, settings.revision);
    },
    [settings],
  );
  /** Hosts that still name the removed profile fail with a clear message instead of skipping the VPN. */
  const removeVpnProfile = useCallback(
    async (name: string) => {
      if (settings.status !== "ready") return false;
      return settings.save(
        {
          ...settings.values,
          vpnProfiles: settings.values.vpnProfiles.filter((profile) => profile.name !== name),
        },
        settings.revision,
      );
    },
    [settings],
  );

  return {
    entries,
    userHosts,
    vpnProfiles,
    errors,
    loading: settings.status === "loading",
    ready: settings.status === "ready",
    saving: settings.saving,
    /** True once both reads finished and found nothing. */
    empty: entries.length === 0 && !config.isPending && settings.status === "ready",
    remove,
    add,
    update,
    saveVpnProfile,
    removeVpnProfile,
  };
}

export type HostEntries = ReturnType<typeof useHostEntries>;
