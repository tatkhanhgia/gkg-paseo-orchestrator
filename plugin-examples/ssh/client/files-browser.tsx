import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useDeviceFiles, useToast, type DeviceFiles } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import {
  cancelTransferRpc,
  listRemoteFilesRpc,
  releaseDownloadRpc,
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
import type { Layout, Theme } from "./types";

const REMOTE_KEY = ["ssh", "files", "remote"] as const;

// An older app's ui module has no useDeviceFiles. The import is a property read, so it is
// undefined there rather than a crash; the fallback is fixed per app, so hook order never changes.
const hostDeviceFiles: typeof useDeviceFiles | undefined = useDeviceFiles;
function noDeviceFiles(): DeviceFiles | null {
  return null;
}
const useDeviceFilesIfAvailable: () => DeviceFiles | null = hostDeviceFiles ?? noDeviceFiles;
const UPDATE_APP_MESSAGE = "Update the Paseo app to download or upload files here.";

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
function remoteHint(canTransfer: boolean, hasListing: boolean, loading: boolean): string | null {
  if (!canTransfer) return UPDATE_APP_MESSAGE;
  return hasListing ? null : uploadHint(loading);
}

/** Why Upload is disabled while the remote folder has no listing. */
function uploadHint(loading: boolean): string {
  return loading
    ? "Upload is available once the remote folder has loaded."
    : "Upload needs a remote folder that loaded. Press Refresh, or go Up.";
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
function useTransferStatus(transferId: string) {
  const status = useRpc(transferStatusRpc);
  const [failures, setFailures] = useState(0);
  const query = useQuery({
    queryKey: ["ssh", "files", "transfer", transferId],
    queryFn: async () => {
      try {
        const result = await status({ transferId });
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
  const { id: transferId } = ref;
  const toast = useToast();
  const cancel = useRpc(cancelTransferRpc);
  const { query, lostContact, retry } = useTransferStatus(transferId);
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
    cancel({ transferId }).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    );
  }, [cancel, transferId, toast]);
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

/** A started transfer. Its id is all the daemon needs to report on it. */
interface TransferRef {
  id: string;
}

/** Where an upload goes: the host and the remote folder. The file comes from the device picker. */
type UploadTarget = Omit<z.input<(typeof startUploadRpc)["input"]>, "upload">;

export function useTransfers() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const deviceFiles = useDeviceFilesIfAvailable();
  const startDownload = useRpc(startDownloadRpc);
  const startUpload = useRpc(startUploadRpc);
  const releaseDownload = useRpc(releaseDownloadRpc);
  const [refs, setRefs] = useState<TransferRef[]>([]);
  const onStarted = useCallback(
    (result: { ok: true; transferId: string } | FileFailure) => {
      if (result.ok) setRefs((current) => [...current, { id: result.transferId }]);
      else toast.error(result.message);
    },
    [toast],
  );
  const downloadMutation = useMutation({
    mutationFn: (variables: Parameters<typeof startDownload>[0]) => startDownload(variables),
    onSuccess: onStarted,
    onError: (error) => toast.error(error.message),
  });
  const uploadMutation = useMutation({
    mutationFn: (variables: Parameters<typeof startUpload>[0]) => startUpload(variables),
    onSuccess: onStarted,
    onError: (error) => toast.error(error.message),
  });
  const { mutate: mutateUpload } = uploadMutation;
  /**
   * Opens this device's file picker, uploads the chosen file to the daemon host, then copies it
   * to the remote folder. Call it straight from a press: a browser opens its picker only then.
   */
  const uploadFromDevice = useCallback(
    (target: UploadTarget) => {
      if (!deviceFiles) {
        toast.error(UPDATE_APP_MESSAGE);
        return;
      }
      // The picker opens synchronously inside this call, before its first await.
      const pickAndUpload = async () => {
        const upload = await deviceFiles.pick();
        if (upload)
          mutateUpload({ ...target, upload: { id: upload.id, fileName: upload.fileName } });
      };
      pickAndUpload().catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
    },
    [deviceFiles, mutateUpload, toast],
  );
  /** Hands a finished download to this device, then lets the daemon remove its staged copy. */
  const saveToDevice = useCallback(
    async (transfer: Transfer & { staged: NonNullable<Transfer["staged"]> }) => {
      try {
        if (!deviceFiles) throw new Error(UPDATE_APP_MESSAGE);
        await deviceFiles.save(transfer.staged);
        toast.show(`Saved "${transfer.fileName}" to this device.`, { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        await releaseDownload({ transferId: transfer.id }).catch(() => undefined);
      }
    },
    [deviceFiles, releaseDownload, toast],
  );
  const finished = useCallback(
    (transfer: Transfer) => {
      if (transfer.state === "done" && transfer.kind === "download") {
        if (transfer.staged) void saveToDevice({ ...transfer, staged: transfer.staged });
      } else if (transfer.state === "done") {
        toast.show(`Uploaded to ${transfer.remotePath ?? "the remote host"}`, {
          variant: "success",
        });
      } else if (transfer.state === "failed") {
        toast.error(transfer.error?.message ?? "The transfer failed.");
      } else if (transfer.error && transfer.error.message !== CANCELLED_MESSAGE) {
        // Cancelled, but the partial file could not be removed: the message says where it is.
        toast.error(transfer.error.message);
      }
      if (transfer.kind === "upload")
        void queryClient.invalidateQueries({ queryKey: [...REMOTE_KEY] });
    },
    [toast, queryClient, saveToDevice],
  );
  const dismiss = useCallback(
    (transferId: string) => setRefs((current) => current.filter((ref) => ref.id !== transferId)),
    [],
  );
  return {
    refs,
    canTransfer: deviceFiles !== null,
    starting: downloadMutation.isPending || uploadMutation.isPending,
    download: downloadMutation.mutate,
    uploadFromDevice,
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

type RemoteListing = ReturnType<typeof useRemoteListing>;

interface RemotePaneProps {
  theme: Theme;
  remote: RemoteListing;
  busy: boolean;
  /** False on an app too old to move files to or from this device. */
  canTransfer: boolean;
  onUpload(): void;
  onDownload(entry: FileEntry): void;
}

function RemotePane({ theme, remote, busy, canTransfer, onUpload, onDownload }: RemotePaneProps) {
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
        label="Upload from device…"
        disabled={!listing || !canTransfer || busy}
        onPress={onUpload}
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
      hint={remoteHint(canTransfer, listing !== null, remote.query.isFetching)}
      loading={remote.query.isFetching && !remote.query.data}
      entries={listing?.entries ?? null}
      truncated={listing?.truncated ?? false}
      actionLabel="Download"
      actionIcon="Download"
      busy={busy || !canTransfer}
      onOpenDirectory={remote.open}
      onAction={onDownload}
    />
  );
}

interface FilesBrowserProps {
  entry: SshHostEntry;
  theme: Theme;
  layout: Layout;
  transfers: Transfers;
  /** Shows a back button when the host list is not on screen at the same time. */
  onClose?(): void;
}

export function FilesBrowser({ entry, theme, transfers, onClose }: FilesBrowserProps) {
  const remote = useRemoteListing(entry);
  const remoteListing = remote.listing;
  const { download, uploadFromDevice } = transfers;

  const handleDownload = useCallback(
    (item: FileEntry) => {
      if (!remoteListing) return;
      download({ target: entry.target, remotePath: remoteJoin(remoteListing.path, item.name) });
    },
    [remoteListing, entry.target, download],
  );
  const handleUpload = useCallback(() => {
    if (!remoteListing) return;
    uploadFromDevice({ target: entry.target, remoteDirectory: remoteListing.path });
  }, [remoteListing, entry.target, uploadFromDevice]);

  const styles = useMemo(
    () => ({
      screen: { gap: 12 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      title: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 18 },
      note: { color: theme.colors.foregroundMuted },
    }),
    [theme],
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
        Download saves a file to this device; Upload from device sends a file from this device to
        the folder shown. No workspace is involved. Existing remote files are never overwritten.
        Transfers keep running on the daemon if you close this screen, but progress, cancel, and the
        save to this device happen only while it is open. Browsing needs a key or ssh-agent; the
        terminal still works for password logins.
      </Text>
      <RemotePane
        theme={theme}
        remote={remote}
        busy={transfers.starting}
        canTransfer={transfers.canTransfer}
        onUpload={handleUpload}
        onDownload={handleDownload}
      />
    </View>
  );
}
