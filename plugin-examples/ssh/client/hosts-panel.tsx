import { useQuery } from "@tanstack/react-query";
import {
  type PluginWorkspacePanelProps,
  useRpc,
  usePaseo,
  useSettings,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { hostsSettings, listConfigHostsRpc, type SshUserHost } from "../shared/contracts";
import { toHostEntries, type SshHostEntry } from "../shared/hosts";
import { AddHostForm } from "./add-host-form";
import { openSshTerminal } from "./connect";
import { FilesBrowser } from "./files-browser";

const NO_HOSTS: SshUserHost[] = [];

interface HostRowProps {
  entry: SshHostEntry;
  theme: PluginWorkspacePanelProps["theme"];
  busy: boolean;
  onConnect(entry: SshHostEntry): void;
  onBrowse(entry: SshHostEntry): void;
  onRemove(entry: SshHostEntry): void;
}

function HostRow({ entry, theme, busy, onConnect, onBrowse, onRemove }: HostRowProps) {
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
      label: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
      connect: { padding: 8, borderRadius: 8, backgroundColor: theme.colors.accent },
      connectText: { color: theme.colors.accentForeground },
      files: {
        padding: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      filesText: { color: theme.colors.foreground },
      remove: { padding: 8 },
    }),
    [theme],
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
        onPress={handleConnect}
        style={styles.connect}
      >
        <Text style={styles.connectText}>Connect</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Browse files on ${entry.label}`}
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

export function HostsPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const settings = useSettings(hostsSettings);
  const listConfigHosts = useRpc(listConfigHostsRpc);
  const config = useQuery({
    queryKey: ["ssh", "config-hosts"],
    queryFn: () => listConfigHosts({}),
  });
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState<SshHostEntry | null>(null);
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 12 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 20 },
      heading: { color: theme.colors.foregroundMuted },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      add: { padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
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

  const handleConnect = useCallback(
    async (entry: SshHostEntry) => {
      try {
        await openSshTerminal(paseo, workspaceId, entry);
        // Plugins cannot focus a terminal tab, so point the user at it.
        toast.show(`Opened terminal "ssh ${entry.label}". Select it in the workspace tabs.`, {
          variant: "success",
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [paseo, toast, workspaceId],
  );
  const handleConnectPress = useCallback(
    (entry: SshHostEntry) => {
      void handleConnect(entry);
    },
    [handleConnect],
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
  const handleBrowse = useCallback((entry: SshHostEntry) => setBrowsing(entry), []);
  const closeBrowser = useCallback(() => setBrowsing(null), []);
  const showForm = useCallback(() => setAdding(true), []);
  const hideForm = useCallback(() => setAdding(false), []);

  if (browsing) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <FilesBrowser
          entry={browsing}
          theme={theme}
          layout={layout}
          workspaceId={workspaceId}
          onClose={closeBrowser}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
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
          onConnect={handleConnectPress}
          onBrowse={handleBrowse}
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
    </ScrollView>
  );
}
