import { usePaseo } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { SshHostEntry } from "../shared/hosts";
import { openSshTerminal } from "./connect";
import { FilesBrowser, TransferList, useTransfers } from "./files-browser";
import { HostsList } from "./hosts-list";
import type { Layout, TargetWorkspace, Theme } from "./types";

const HOSTS_PANE_WIDTH = 360;

interface SshScreenProps {
  theme: Theme;
  layout: Layout;
  /** Where terminals open and files go; `null` until the user has chosen one. */
  workspace: TargetWorkspace | null;
  /** Shown above the hosts and files, e.g. the workspace picker. */
  children?: ReactNode;
  /** Runs after a terminal opened, e.g. to navigate to its workspace. */
  onConnected?(workspace: TargetWorkspace): void;
}

/**
 * Hosts and a remote file browser with transfers: side by side on wide layouts, one at a time on
 * compact ones. The same screen serves the sidebar surface and the workspace panel.
 */
export function SshScreen({
  theme,
  layout,
  workspace,
  children: header,
  onConnected,
}: SshScreenProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const transfers = useTransfers();
  const [browsing, setBrowsing] = useState<SshHostEntry | null>(null);

  const handleConnect = useCallback(
    async (entry: SshHostEntry) => {
      if (!workspace) {
        toast.error("Choose a target workspace first.");
        return;
      }
      try {
        await openSshTerminal(paseo, workspace.id, entry);
        onConnected?.(workspace);
        // Plugins cannot focus a terminal tab, so point the user at it.
        toast.show(
          `Opened terminal "ssh ${entry.label}"${workspace.name ? ` in ${workspace.name}` : ""}. Select it in the workspace tabs.`,
          { variant: "success" },
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [paseo, toast, workspace, onConnected],
  );
  const handleConnectPress = useCallback(
    (entry: SshHostEntry) => {
      void handleConnect(entry);
    },
    [handleConnect],
  );
  const handleBrowse = useCallback((entry: SshHostEntry) => setBrowsing(entry), []);
  const closeBrowser = useCallback(() => setBrowsing(null), []);

  const wide = !layout.compact;
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 12 },
      header: { paddingHorizontal: 24, paddingTop: 24 },
      split: { flex: 1, flexDirection: "row" as const },
      hostsPane: {
        width: HOSTS_PANE_WIDTH,
        flexGrow: 0,
        flexShrink: 0,
        borderRightWidth: 1,
        borderColor: theme.colors.border,
      },
      filesPane: { flex: 1, minWidth: 0 },
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );

  const hosts = (
    <HostsList
      theme={theme}
      layout={layout}
      selectedKey={browsing?.key ?? null}
      connectDisabled={workspace === null}
      onConnect={handleConnectPress}
      onBrowse={handleBrowse}
    />
  );
  const transferList = <TransferList theme={theme} transfers={transfers} />;
  const files = browsing ? (
    <FilesBrowser
      key={browsing.key}
      entry={browsing}
      theme={theme}
      layout={layout}
      workspace={workspace}
      transfers={transfers}
      onClose={wide ? undefined : closeBrowser}
    />
  ) : null;

  if (!wide) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        {header}
        {transferList}
        {files ?? hosts}
      </ScrollView>
    );
  }
  return (
    <View style={styles.screen}>
      {header ? <View style={styles.header}>{header}</View> : null}
      <View style={styles.split}>
        <ScrollView style={styles.hostsPane} contentContainerStyle={styles.content}>
          {hosts}
        </ScrollView>
        <ScrollView style={styles.filesPane} contentContainerStyle={styles.content}>
          {transferList}
          {files ?? <Text style={styles.muted}>Choose Files on a host to browse it.</Text>}
        </ScrollView>
      </View>
    </View>
  );
}
