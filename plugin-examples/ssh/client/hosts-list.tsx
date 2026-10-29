import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { hostsSettings, listConfigHostsRpc, type SshUserHost } from "../shared/contracts";
import { toHostEntries, type SshHostEntry } from "../shared/hosts";
import { AddHostForm } from "./add-host-form";
import { MIN_TOUCH_TARGET } from "./file-row";
import type { Layout, Theme } from "./types";

const NO_HOSTS: SshUserHost[] = [];
const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

interface HostRowProps {
  entry: SshHostEntry;
  theme: Theme;
  busy: boolean;
  selected: boolean;
  connectDisabled: boolean;
  onConnect(entry: SshHostEntry): void;
  onBrowse(entry: SshHostEntry): void;
  onRemove(entry: SshHostEntry): void;
}

function HostRow({
  entry,
  theme,
  busy,
  selected,
  connectDisabled,
  onConnect,
  onBrowse,
  onRemove,
}: HostRowProps) {
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      text: { flex: 1, minWidth: 0 },
      label: {
        color: theme.colors.foreground,
        fontWeight: selected ? ("600" as const) : undefined,
      },
      detail: { color: theme.colors.foregroundMuted },
      connect: {
        minHeight: MIN_TOUCH_TARGET,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
        opacity: connectDisabled ? 0.5 : 1,
      },
      connectText: { color: theme.colors.accentForeground },
      files: {
        minHeight: MIN_TOUCH_TARGET,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
      },
      filesText: { color: theme.colors.foreground },
      remove: {
        minWidth: MIN_TOUCH_TARGET,
        minHeight: MIN_TOUCH_TARGET,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
    }),
    [theme, selected, connectDisabled],
  );
  const handleConnect = useCallback(() => onConnect(entry), [entry, onConnect]);
  const handleBrowse = useCallback(() => onBrowse(entry), [entry, onBrowse]);
  const handleRemove = useCallback(() => onRemove(entry), [entry, onRemove]);
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.label} numberOfLines={1}>
          {entry.label}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {entry.detail}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Connect to ${entry.label}`}
        disabled={connectDisabled}
        onPress={handleConnect}
        style={styles.connect}
      >
        <Text style={styles.connectText}>Connect</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Browse files on ${entry.label}`}
        accessibilityState={selected ? SELECTED : NOT_SELECTED}
        onPress={handleBrowse}
        style={styles.files}
      >
        <Text style={styles.filesText}>Files</Text>
      </Pressable>
      {entry.source === "user" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${entry.label}`}
          disabled={busy}
          onPress={handleRemove}
          style={styles.remove}
        >
          <Icon name="Trash2" size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

interface HostsListProps {
  theme: Theme;
  layout: Layout;
  /** The host whose files are open, so its row can show it. */
  selectedKey: string | null;
  /** True while there is no workspace to open a terminal in. */
  connectDisabled: boolean;
  onConnect(entry: SshHostEntry): void;
  onBrowse(entry: SshHostEntry): void;
}

/** User-added and ssh-config hosts, with add and remove. Owns the host settings and config reads. */
export function HostsList({
  theme,
  layout,
  selectedKey,
  connectDisabled,
  onConnect,
  onBrowse,
}: HostsListProps) {
  const settings = useSettings(hostsSettings);
  const listConfigHosts = useRpc(listConfigHostsRpc);
  const config = useQuery({
    queryKey: ["ssh", "config-hosts"],
    queryFn: () => listConfigHosts({}),
  });
  const [adding, setAdding] = useState(false);
  const styles = useMemo(
    () => ({
      list: { gap: 12 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 20 },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      add: {
        minHeight: MIN_TOUCH_TARGET,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      addText: { color: theme.colors.foreground },
    }),
    [theme, layout.compact],
  );
  const userHosts = settings.status === "ready" ? settings.values.hosts : NO_HOSTS;
  const configHosts = config.data?.hosts;
  const entries = useMemo(
    () => toHostEntries(configHosts ?? [], userHosts),
    [configHosts, userHosts],
  );

  const handleRemove = useCallback(
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
  const handleAdd = useCallback(
    async (host: Omit<SshUserHost, "id">) => {
      if (settings.status !== "ready") return false;
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const saved = await settings.save(
        { hosts: [...settings.values.hosts, { ...host, id }] },
        settings.revision,
      );
      if (saved) setAdding(false);
      return saved;
    },
    [settings],
  );
  const showForm = useCallback(() => setAdding(true), []);
  const hideForm = useCallback(() => setAdding(false), []);

  return (
    <View style={styles.list}>
      <Text style={styles.title}>SSH hosts</Text>
      {settings.status === "loading" ? <Text style={styles.muted}>Loading hosts…</Text> : null}
      {settings.status === "error" || settings.status === "invalid" ? (
        <Text style={styles.error}>{settings.error}</Text>
      ) : null}
      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
      {config.data?.error ? (
        <Text style={styles.error}>
          Could not read {config.data.configPath}: {config.data.error}
        </Text>
      ) : null}
      {entries.map((entry) => (
        <HostRow
          key={entry.key}
          entry={entry}
          theme={theme}
          busy={settings.saving}
          selected={entry.key === selectedKey}
          connectDisabled={connectDisabled}
          onConnect={onConnect}
          onBrowse={onBrowse}
          onRemove={handleRemove}
        />
      ))}
      {entries.length === 0 && !config.isPending && settings.status === "ready" ? (
        <Text style={styles.muted}>
          No hosts yet. Add one, or define Host entries in ~/.ssh/config.
        </Text>
      ) : null}
      {adding ? (
        <AddHostForm
          theme={theme}
          disabled={settings.saving || settings.status !== "ready"}
          onAdd={handleAdd}
          onCancel={hideForm}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add host"
          onPress={showForm}
          style={styles.add}
        >
          <Text style={styles.addText}>Add host</Text>
        </Pressable>
      )}
    </View>
  );
}
