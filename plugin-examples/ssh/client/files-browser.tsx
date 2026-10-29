import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  downloadFileRpc,
  listRemoteFilesRpc,
  listWorkspaceFilesRpc,
  uploadFileRpc,
  type FileEntry,
  type FileFailure,
} from "../shared/contracts";
import type { SshHostEntry } from "../shared/hosts";
import { remoteJoin } from "../shared/remote-path";
import { FileRow } from "./file-row";

type Theme = PluginWorkspacePanelProps["theme"];

interface ToolbarButtonProps {
  theme: Theme;
  icon: string;
  label: string;
  disabled?: boolean;
  onPress(): void;
}

function ToolbarButton({ theme, icon, label, disabled, onPress }: ToolbarButtonProps) {
  const styles = useMemo(
    () => ({
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        padding: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        opacity: disabled ? 0.5 : 1,
      },
      label: { color: theme.colors.foreground },
    }),
    [theme, disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={styles.button}
    >
      <Icon name={icon} size={16} color={theme.colors.foreground} />
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

function failureText(
  result: { ok: true } | FileFailure | undefined,
  error: unknown,
): string | null {
  if (error) return error instanceof Error ? error.message : String(error);
  if (result && !result.ok) return result.message;
  return null;
}

interface PaneProps {
  theme: Theme;
  title: string;
  location: string;
  toolbar: ReactNode;
  failure: string | null;
  loading: boolean;
  entries: readonly FileEntry[] | null;
  truncated: boolean;
  actionLabel: string;
  actionIcon: string;
  busy: boolean;
  onOpenDirectory(entry: FileEntry): void;
  onAction(entry: FileEntry): void;
}

function Pane({
  theme,
  title,
  location,
  toolbar,
  failure,
  loading,
  entries,
  truncated,
  actionLabel,
  actionIcon,
  busy,
  onOpenDirectory,
  onAction,
}: PaneProps) {
  const styles = useMemo(
    () => ({
      pane: { flex: 1, minWidth: 0, gap: 8 },
      heading: { color: theme.colors.foreground, fontSize: 16 },
      location: { color: theme.colors.foregroundMuted },
      toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );
  return (
    <View style={styles.pane}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={styles.location} numberOfLines={2}>
        {location}
      </Text>
      <View style={styles.toolbar}>{toolbar}</View>
      {failure ? <Text style={styles.error}>{failure}</Text> : null}
      {loading ? <Text style={styles.muted}>Loading…</Text> : null}
      {entries?.map((entry) => (
        <FileRow
          key={entry.name}
          entry={entry}
          theme={theme}
          actionLabel={actionLabel}
          actionIcon={actionIcon}
          disabled={busy}
          onOpenDirectory={onOpenDirectory}
          onAction={onAction}
        />
      ))}
      {entries?.length === 0 ? <Text style={styles.muted}>This folder is empty.</Text> : null}
      {truncated ? <Text style={styles.muted}>Only the first entries are shown.</Text> : null}
    </View>
  );
}

function joinRelative(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function useRemoteListing(entry: SshHostEntry) {
  const listRemote = useRpc(listRemoteFilesRpc);
  const [path, setPath] = useState<string | undefined>(undefined);
  const key = useMemo(() => ["ssh", "files", "remote", entry.key], [entry.key]);
  const query = useQuery({
    queryKey: [...key, path ?? ""],
    queryFn: () => listRemote({ target: entry.target, path }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const listing = query.data?.ok ? query.data : null;
  const open = useCallback(
    (item: FileEntry) => {
      if (listing) setPath(remoteJoin(listing.path, item.name));
    },
    [listing],
  );
  const up = useCallback(() => {
    if (listing?.parent) setPath(listing.parent);
  }, [listing]);
  const home = useCallback(() => setPath(undefined), []);
  const refresh = useCallback(() => void query.refetch(), [query]);
  return { key, query, listing, open, up, home, refresh };
}

function useWorkspaceListing(workspaceId: string, enabled: boolean) {
  const listWorkspace = useRpc(listWorkspaceFilesRpc);
  const [directory, setDirectory] = useState("");
  const key = useMemo(() => ["ssh", "files", "workspace", workspaceId], [workspaceId]);
  const query = useQuery({
    queryKey: [...key, directory],
    queryFn: () => listWorkspace({ workspaceId, directory }),
    enabled,
    retry: false,
  });
  const listing = query.data?.ok ? query.data : null;
  const open = useCallback(
    (item: FileEntry) => {
      if (listing) setDirectory(joinRelative(listing.directory, item.name));
    },
    [listing],
  );
  const up = useCallback(() => {
    if (typeof listing?.parent === "string") setDirectory(listing.parent);
  }, [listing]);
  const root = useCallback(() => setDirectory(""), []);
  return { key, query, listing, directory, open, up, root };
}

function useTransfers(
  entry: SshHostEntry,
  workspaceId: string,
  remoteKey: readonly unknown[],
  workspaceKey: readonly unknown[],
) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const download = useRpc(downloadFileRpc);
  const upload = useRpc(uploadFileRpc);
  const downloadMutation = useMutation({
    mutationFn: (remotePath: string) => download({ target: entry.target, workspaceId, remotePath }),
    onSuccess(result) {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.show(
        `Saved "${result.fileName}" in the workspace directory. Open the file explorer to get it onto your phone or browser.`,
        { variant: "success" },
      );
      void queryClient.invalidateQueries({ queryKey: [...workspaceKey] });
    },
    onError: (error) => toast.error(error.message),
  });
  const uploadMutation = useMutation({
    mutationFn: (variables: { localPath: string; remoteDirectory: string }) =>
      upload({ target: entry.target, workspaceId, ...variables }),
    onSuccess(result) {
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.show(`Uploaded to ${result.remotePath}`, { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [...remoteKey] });
    },
    onError: (error) => toast.error(error.message),
  });
  return {
    busy: downloadMutation.isPending || uploadMutation.isPending,
    download: downloadMutation.mutate,
    upload: uploadMutation.mutate,
  };
}

type WorkspaceListing = ReturnType<typeof useWorkspaceListing>;
type RemoteListing = ReturnType<typeof useRemoteListing>;

interface UploadPaneProps {
  theme: Theme;
  workspace: WorkspaceListing;
  remotePath: string | null;
  busy: boolean;
  onUpload(entry: FileEntry): void;
}

function UploadPane({ theme, workspace, remotePath, busy, onUpload }: UploadPaneProps) {
  const listing = workspace.listing;
  const where = `${listing?.root ?? "Workspace"}${workspace.directory ? `/${workspace.directory}` : ""}`;
  const toolbar = (
    <>
      <ToolbarButton
        theme={theme}
        icon="ArrowUp"
        label="Up"
        disabled={typeof listing?.parent !== "string"}
        onPress={workspace.up}
      />
      <ToolbarButton theme={theme} icon="Home" label="Workspace" onPress={workspace.root} />
    </>
  );
  return (
    <Pane
      theme={theme}
      title="Upload from workspace"
      location={`${where} → ${remotePath ?? "remote"}`}
      toolbar={toolbar}
      failure={failureText(workspace.query.data, workspace.query.error)}
      loading={workspace.query.isFetching && !workspace.query.data}
      entries={listing?.entries ?? null}
      truncated={listing?.truncated ?? false}
      actionLabel="Upload"
      actionIcon="Upload"
      busy={busy || remotePath === null}
      onOpenDirectory={workspace.open}
      onAction={onUpload}
    />
  );
}

interface RemotePaneProps {
  theme: Theme;
  remote: RemoteListing;
  picking: boolean;
  busy: boolean;
  onTogglePicker(): void;
  onDownload(entry: FileEntry): void;
}

function RemotePane({ theme, remote, picking, busy, onTogglePicker, onDownload }: RemotePaneProps) {
  const listing = remote.listing;
  const toolbar = (
    <>
      <ToolbarButton
        theme={theme}
        icon="ArrowUp"
        label="Up"
        disabled={!listing?.parent}
        onPress={remote.up}
      />
      <ToolbarButton theme={theme} icon="Home" label="Home" onPress={remote.home} />
      <ToolbarButton theme={theme} icon="RefreshCw" label="Refresh" onPress={remote.refresh} />
      <ToolbarButton
        theme={theme}
        icon="Upload"
        label={picking ? "Close upload" : "Upload…"}
        disabled={!listing}
        onPress={onTogglePicker}
      />
    </>
  );
  return (
    <Pane
      theme={theme}
      title="Remote"
      location={listing?.path ?? "Remote home"}
      toolbar={toolbar}
      failure={failureText(remote.query.data, remote.query.error)}
      loading={remote.query.isFetching && !remote.query.data}
      entries={listing?.entries ?? null}
      truncated={listing?.truncated ?? false}
      actionLabel="Download"
      actionIcon="Download"
      busy={busy}
      onOpenDirectory={remote.open}
      onAction={onDownload}
    />
  );
}

interface FilesBrowserProps {
  entry: SshHostEntry;
  theme: Theme;
  layout: PluginWorkspacePanelProps["layout"];
  workspaceId: string;
  onClose(): void;
}

export function FilesBrowser({ entry, theme, layout, workspaceId, onClose }: FilesBrowserProps) {
  const [picking, setPicking] = useState(false);
  const remote = useRemoteListing(entry);
  const workspace = useWorkspaceListing(workspaceId, picking);
  const transfers = useTransfers(entry, workspaceId, remote.key, workspace.key);
  const remoteListing = remote.listing;
  const workspaceListing = workspace.listing;
  const { download, upload } = transfers;

  const handleDownload = useCallback(
    (item: FileEntry) => {
      if (remoteListing) download(remoteJoin(remoteListing.path, item.name));
    },
    [remoteListing, download],
  );
  const handleUpload = useCallback(
    (item: FileEntry) => {
      if (!workspaceListing || !remoteListing) return;
      upload({
        localPath: joinRelative(workspaceListing.directory, item.name),
        remoteDirectory: remoteListing.path,
      });
    },
    [workspaceListing, remoteListing, upload],
  );
  const handleTogglePicker = useCallback(() => setPicking((value) => !value), []);

  const styles = useMemo(
    () => ({
      screen: { gap: 12 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      title: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 18 },
      note: { color: theme.colors.foregroundMuted },
      status: { color: theme.colors.foreground },
      panes: {
        flexDirection: layout.compact || !picking ? ("column" as const) : ("row" as const),
        gap: 16,
      },
    }),
    [theme, layout.compact, picking],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          Files on {entry.label}
        </Text>
        <ToolbarButton theme={theme} icon="ArrowLeft" label="Hosts" onPress={onClose} />
      </View>
      <Text style={styles.note}>
        Downloads are saved in the directory of this workspace on the daemon host. Open the Paseo
        file explorer to get them onto your phone or browser. Existing files are never overwritten.
        Browsing needs a key or ssh-agent; the terminal still works for password logins.
      </Text>
      {transfers.busy ? (
        <Text style={styles.status}>Transferring… keep this panel open.</Text>
      ) : null}
      <View style={styles.panes}>
        <RemotePane
          theme={theme}
          remote={remote}
          picking={picking}
          busy={transfers.busy}
          onTogglePicker={handleTogglePicker}
          onDownload={handleDownload}
        />
        {picking ? (
          <UploadPane
            theme={theme}
            workspace={workspace}
            remotePath={remoteListing?.path ?? null}
            busy={transfers.busy}
            onUpload={handleUpload}
          />
        ) : null}
      </View>
    </View>
  );
}
