import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  cancelTransferRpc,
  listRemoteFilesRpc,
  listWorkspaceFilesRpc,
  startDownloadRpc,
  startUploadRpc,
  transferStatusRpc,
  type FileEntry,
  type FileFailure,
  type Transfer,
} from "../shared/contracts";
import type { SshHostEntry } from "../shared/hosts";
import { remoteJoin, remoteParent } from "../shared/remote-path";
import { CANCELLED_MESSAGE } from "../shared/transfer-messages";
import { FileRow, MIN_TOUCH_TARGET } from "./file-row";
import { formatProgress } from "./format";
import type { Layout, TargetWorkspace, Theme } from "./types";

const REMOTE_KEY = ["ssh", "files", "remote"] as const;
const WORKSPACE_KEY = ["ssh", "files", "workspace"] as const;

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
        minHeight: MIN_TOUCH_TARGET,
        paddingHorizontal: 12,
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
  /** Explains why a toolbar button is disabled, when it is. */
  hint?: string | null;
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
  hint,
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
      {hint ? <Text style={styles.muted}>{hint}</Text> : null}
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

/** Why a toolbar button is disabled, or `null` when none is. */
function remoteHint(hasWorkspace: boolean, hasListing: boolean, loading: boolean): string | null {
  if (!hasWorkspace) return "Choose a target workspace to download or upload.";
  return hasListing ? null : uploadHint(loading);
}

/** Why Upload is disabled while the remote folder has no listing. */
function uploadHint(loading: boolean): string {
  return loading
    ? "Upload is available once the remote folder has loaded."
    : "Upload needs a remote folder that loaded. Press Refresh, or go Up.";
}

function joinRelative(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function relativeParent(directory: string): string | null {
  const segments = directory.split("/").filter(Boolean);
  return segments.length === 0 ? null : segments.slice(0, -1).join("/");
}

function parentOfPath(path: string | undefined): string | null {
  return path === undefined ? null : remoteParent(path);
}

function useRemoteListing(entry: SshHostEntry) {
  const listRemote = useRpc(listRemoteFilesRpc);
  const [path, setPath] = useState<string | undefined>(undefined);
  const query = useQuery({
    queryKey: [...REMOTE_KEY, entry.key, path ?? ""],
    queryFn: () => listRemote({ target: entry.target, path }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const listing = query.data?.ok ? query.data : null;
  // After a failed listing there is no listing to ask for a parent, so work it out from the path.
  const parent = listing ? listing.parent : parentOfPath(path);
  const open = useCallback(
    (item: FileEntry) => {
      if (listing) setPath(remoteJoin(listing.path, item.name));
    },
    [listing],
  );
  const up = useCallback(() => {
    if (parent) setPath(parent);
  }, [parent]);
  const home = useCallback(() => setPath(undefined), []);
  const refresh = useCallback(() => void query.refetch(), [query]);
  return { query, listing, parent, open, up, home, refresh };
}

function useWorkspaceListing(workspaceId: string | null, enabled: boolean) {
  const listWorkspace = useRpc(listWorkspaceFilesRpc);
  const [directory, setDirectory] = useState("");
  // A folder of one workspace need not exist in another.
  useEffect(() => setDirectory(""), [workspaceId]);
  const query = useQuery({
    queryKey: [...WORKSPACE_KEY, workspaceId, directory],
    queryFn: () => {
      if (!workspaceId) throw new Error("Choose a target workspace first.");
      return listWorkspace({ workspaceId, directory });
    },
    enabled: enabled && workspaceId !== null,
    retry: false,
  });
  const listing = query.data?.ok ? query.data : null;
  const parent = listing ? listing.parent : relativeParent(directory);
  const open = useCallback(
    (item: FileEntry) => {
      if (listing) setDirectory(joinRelative(listing.directory, item.name));
    },
    [listing],
  );
  const up = useCallback(() => {
    if (parent !== null) setDirectory(parent);
  }, [parent]);
  const root = useCallback(() => setDirectory(""), []);
  return { query, listing, parent, directory, open, up, root };
}

const POLL_INTERVAL_MS = 1000;
/** After this many failed status calls in a row, polling stops and the row offers Retry. */
const MAX_POLL_FAILURES = 3;

/** Poll until the first reply, and then only while the transfer runs; an unknown id ends it. */
function shouldPoll(data: { ok: true; transfer: Transfer } | FileFailure | undefined): boolean {
  if (!data) return true;
  return data.ok && data.transfer.state === "running";
}

function describeTransfer(transfer: Transfer | null): string {
  if (!transfer) return "Checking…";
  if (transfer.state === "running") return formatProgress(transfer.bytesDone, transfer.total);
  if (transfer.state === "done") return "Done";
  return transfer.state === "failed" ? "Failed" : "Cancelled";
}

/** What went wrong with a transfer, or `null`. A clean cancel is not a problem; one that left a partial file is. */
function transferProblem(
  transfer: Transfer | null,
  data: { ok: true; transfer: Transfer } | FileFailure | undefined,
  lostContact: boolean,
): string | null {
  if (lostContact) {
    return "Lost contact with the daemon. The transfer may still be running; retry to check.";
  }
  if (data && !data.ok) return data.message;
  if (transfer?.state === "failed") return transfer.error?.message ?? "The transfer failed.";
  if (transfer?.state === "cancelled" && transfer.error?.message !== CANCELLED_MESSAGE) {
    return transfer.error?.message ?? null;
  }
  return null;
}

/** Polls a transfer's status; polling stops on a final state, an unknown id, or repeated failures. */
function useTransferStatus(transferId: string, workspaceId: string) {
  const status = useRpc(transferStatusRpc);
  const [failures, setFailures] = useState(0);
  const query = useQuery({
    queryKey: ["ssh", "files", "transfer", transferId],
    queryFn: async () => {
      try {
        const result = await status({ transferId, workspaceId });
        setFailures(0);
        return result;
      } catch (error) {
        setFailures((count) => count + 1);
        throw error;
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (current) =>
      failures < MAX_POLL_FAILURES && shouldPoll(current.state.data) ? POLL_INTERVAL_MS : false,
  });
  const retry = useCallback(() => {
    setFailures(0);
    void query.refetch();
  }, [query]);
  return { query, lostContact: failures >= MAX_POLL_FAILURES, retry };
}

interface TransferRowProps {
  theme: Theme;
  transfer: TransferRef;
  onFinished(transfer: Transfer): void;
  onDismiss(transferId: string): void;
}

/** One transfer: progress, Cancel while it runs, Dismiss after. Polling ends if the row unmounts. */
function TransferRow({ theme, transfer: ref, onFinished, onDismiss }: TransferRowProps) {
  const { id: transferId, workspaceId } = ref;
  const toast = useToast();
  const cancel = useRpc(cancelTransferRpc);
  const { query, lostContact, retry } = useTransferStatus(transferId, workspaceId);
  const transfer = query.data?.ok ? query.data.transfer : null;
  const ended = transfer && transfer.state !== "running" ? transfer : null;
  const reported = useRef(false);
  useEffect(() => {
    if (ended && !reported.current) {
      reported.current = true;
      onFinished(ended);
    }
  }, [ended, onFinished]);

  const handleCancel = useCallback(() => {
    cancel({ transferId, workspaceId }).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    );
  }, [cancel, transferId, workspaceId, toast]);
  const handleDismiss = useCallback(() => onDismiss(transferId), [onDismiss, transferId]);

  const styles = useMemo(
    () => ({
      row: { gap: 6, paddingVertical: 6, borderBottomWidth: 1, borderColor: theme.colors.border },
      name: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      actions: { flexDirection: "row" as const, gap: 8 },
    }),
    [theme],
  );
  const problem = transferProblem(transfer, query.data, lostContact);
  const verb = transfer?.kind === "upload" ? "Uploading" : "Downloading";
  const running = transfer?.state === "running" && !lostContact;
  return (
    <View style={styles.row}>
      <Text style={styles.name} numberOfLines={1}>
        {transfer ? `${verb} ${transfer.fileName}` : "Transfer"}
      </Text>
      {problem ? (
        <Text style={styles.error}>{problem}</Text>
      ) : (
        <Text style={styles.detail}>{describeTransfer(transfer)}</Text>
      )}
      <View style={styles.actions}>
        {lostContact ? (
          <ToolbarButton theme={theme} icon="RefreshCw" label="Retry" onPress={retry} />
        ) : null}
        {running ? (
          <ToolbarButton theme={theme} icon="X" label="Cancel" onPress={handleCancel} />
        ) : (
          <ToolbarButton theme={theme} icon="X" label="Dismiss" onPress={handleDismiss} />
        )}
      </View>
    </View>
  );
}

/** A started transfer and the workspace that owns it; only that workspace can read or cancel it. */
interface TransferRef {
  id: string;
  workspaceId: string;
}

export function useTransfers() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const startDownload = useRpc(startDownloadRpc);
  const startUpload = useRpc(startUploadRpc);
  const [refs, setRefs] = useState<TransferRef[]>([]);
  const onStarted = useCallback(
    (result: { ok: true; transferId: string } | FileFailure, workspaceId: string) => {
      if (result.ok) setRefs((current) => [...current, { id: result.transferId, workspaceId }]);
      else toast.error(result.message);
    },
    [toast],
  );
  const downloadMutation = useMutation({
    mutationFn: (variables: Parameters<typeof startDownload>[0]) => startDownload(variables),
    onSuccess: (result, variables) => onStarted(result, variables.workspaceId),
    onError: (error) => toast.error(error.message),
  });
  const uploadMutation = useMutation({
    mutationFn: (variables: Parameters<typeof startUpload>[0]) => startUpload(variables),
    onSuccess: (result, variables) => onStarted(result, variables.workspaceId),
    onError: (error) => toast.error(error.message),
  });
  const finished = useCallback(
    (transfer: Transfer) => {
      if (transfer.state === "done") {
        toast.show(
          transfer.kind === "download"
            ? `Saved "${transfer.fileName}" in the target workspace directory. Open the file explorer to get it onto your phone or browser.`
            : `Uploaded to ${transfer.remotePath ?? "the remote host"}`,
          { variant: "success" },
        );
      } else if (transfer.state === "failed") {
        toast.error(transfer.error?.message ?? "The transfer failed.");
      } else if (transfer.error && transfer.error.message !== CANCELLED_MESSAGE) {
        // Cancelled, but the partial file could not be removed: the message says where it is.
        toast.error(transfer.error.message);
      }
      void queryClient.invalidateQueries({
        queryKey: [...(transfer.kind === "download" ? WORKSPACE_KEY : REMOTE_KEY)],
      });
    },
    [toast, queryClient],
  );
  const dismiss = useCallback(
    (transferId: string) => setRefs((current) => current.filter((ref) => ref.id !== transferId)),
    [],
  );
  return {
    refs,
    starting: downloadMutation.isPending || uploadMutation.isPending,
    download: downloadMutation.mutate,
    upload: uploadMutation.mutate,
    finished,
    dismiss,
  };
}

export type Transfers = ReturnType<typeof useTransfers>;

interface TransferListProps {
  theme: Theme;
  transfers: Transfers;
}

/** Progress rows for started transfers. They poll only while mounted; the daemon runs them regardless. */
export function TransferList({ theme, transfers }: TransferListProps) {
  return (
    <>
      {transfers.refs.map((ref) => (
        <TransferRow
          key={ref.id}
          theme={theme}
          transfer={ref}
          onFinished={transfers.finished}
          onDismiss={transfers.dismiss}
        />
      ))}
    </>
  );
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
        disabled={workspace.parent === null}
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
      hint={
        remotePath === null
          ? "Waiting for the remote folder to load; files can be uploaded after that."
          : null
      }
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
  /** False while no target workspace is chosen: nothing can be downloaded or uploaded. */
  hasWorkspace: boolean;
  onTogglePicker(): void;
  onDownload(entry: FileEntry): void;
}

function RemotePane({
  theme,
  remote,
  picking,
  busy,
  hasWorkspace,
  onTogglePicker,
  onDownload,
}: RemotePaneProps) {
  const listing = remote.listing;
  const toolbar = (
    <>
      <ToolbarButton
        theme={theme}
        icon="ArrowUp"
        label="Up"
        disabled={!remote.parent}
        onPress={remote.up}
      />
      <ToolbarButton theme={theme} icon="Home" label="Home" onPress={remote.home} />
      <ToolbarButton theme={theme} icon="RefreshCw" label="Refresh" onPress={remote.refresh} />
      <ToolbarButton
        theme={theme}
        icon="Upload"
        label={picking ? "Close upload" : "Upload…"}
        disabled={!listing || (!hasWorkspace && !picking)}
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
      hint={remoteHint(hasWorkspace, listing !== null, remote.query.isFetching)}
      loading={remote.query.isFetching && !remote.query.data}
      entries={listing?.entries ?? null}
      truncated={listing?.truncated ?? false}
      actionLabel="Download"
      actionIcon="Download"
      busy={busy || !hasWorkspace}
      onOpenDirectory={remote.open}
      onAction={onDownload}
    />
  );
}

interface FilesBrowserProps {
  entry: SshHostEntry;
  theme: Theme;
  layout: Layout;
  /** Where downloads land and uploads come from; `null` until one is chosen. */
  workspace: TargetWorkspace | null;
  transfers: Transfers;
  /** Shows a back button when the host list is not on screen at the same time. */
  onClose?(): void;
}

export function FilesBrowser({
  entry,
  theme,
  layout,
  workspace: target,
  transfers,
  onClose,
}: FilesBrowserProps) {
  const workspaceId = target?.id ?? null;
  const [picking, setPicking] = useState(false);
  const remote = useRemoteListing(entry);
  const workspace = useWorkspaceListing(workspaceId, picking);
  const remoteListing = remote.listing;
  const workspaceListing = workspace.listing;
  const { download, upload } = transfers;

  const handleDownload = useCallback(
    (item: FileEntry) => {
      if (!remoteListing || !workspaceId) return;
      download({
        target: entry.target,
        workspaceId,
        remotePath: remoteJoin(remoteListing.path, item.name),
      });
    },
    [remoteListing, workspaceId, entry.target, download],
  );
  const handleUpload = useCallback(
    (item: FileEntry) => {
      if (!workspaceListing || !remoteListing || !workspaceId) return;
      upload({
        target: entry.target,
        workspaceId,
        localPath: joinRelative(workspaceListing.directory, item.name),
        remoteDirectory: remoteListing.path,
      });
    },
    [workspaceListing, remoteListing, workspaceId, entry.target, upload],
  );
  const handleTogglePicker = useCallback(() => setPicking((value) => !value), []);

  const styles = useMemo(
    () => ({
      screen: { gap: 12 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      title: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 18 },
      note: { color: theme.colors.foregroundMuted },
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
        {onClose ? (
          <ToolbarButton theme={theme} icon="ArrowLeft" label="Hosts" onPress={onClose} />
        ) : null}
      </View>
      <Text style={styles.note}>
        Downloads are saved in the directory of the target workspace on the daemon host. Open the
        Paseo file explorer to get them onto your phone or browser. Existing files are never
        overwritten. Transfers keep running on the daemon if you close this screen, but progress and
        cancel are only shown while it is open. Browsing needs a key or ssh-agent; the terminal
        still works for password logins.
      </Text>
      <View style={styles.panes}>
        <RemotePane
          theme={theme}
          remote={remote}
          picking={picking}
          busy={transfers.starting}
          hasWorkspace={workspaceId !== null}
          onTogglePicker={handleTogglePicker}
          onDownload={handleDownload}
        />
        {picking ? (
          <UploadPane
            theme={theme}
            workspace={workspace}
            remotePath={remoteListing?.path ?? null}
            busy={transfers.starting}
            onUpload={handleUpload}
          />
        ) : null}
      </View>
    </View>
  );
}
