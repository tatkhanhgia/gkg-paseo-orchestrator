import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Icon,
  ScrollView,
  useDeviceFiles,
  useToast,
  type DeviceFiles,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import {
  cancelTransferRpc,
  startDownloadRpc,
  startUploadRpc,
  releaseDownloadRpc,
  transferStatusRpc,
  type FileFailure,
  type Transfer,
} from "../shared/contracts";
import { CANCELLED_MESSAGE } from "../shared/transfer-messages";
import { formatProgress } from "./format";
import type { Theme } from "./types";
import { FONT_SIZE, IconButton, SectionHeader, SPACE } from "./ui-kit";

export const REMOTE_KEY = ["ssh", "files", "remote"] as const;

// An older app's ui module has no useDeviceFiles. The import is a property read, so it is
// undefined there rather than a crash; the fallback is fixed per app, so hook order never changes.
const hostDeviceFiles: typeof useDeviceFiles | undefined = useDeviceFiles;
function noDeviceFiles(): DeviceFiles | null {
  return null;
}
const useDeviceFilesIfAvailable: () => DeviceFiles | null = hostDeviceFiles ?? noDeviceFiles;
export const UPDATE_APP_MESSAGE = "Update the Paseo app to download or upload files here.";

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

/** 0 to 100 while the size is known, otherwise `null`. */
function percentDone(transfer: Transfer | null): number | null {
  if (!transfer) return null;
  if (transfer.state === "done") return 100;
  if (transfer.total === null || transfer.total <= 0) return null;
  return Math.min(100, Math.floor((transfer.bytesDone / transfer.total) * 100));
}

function barColor(theme: Theme, transfer: Transfer | null, problem: string | null): string {
  if (problem || transfer?.state === "failed") return theme.colors.statusDanger;
  return transfer?.state === "done" ? theme.colors.statusSuccess : theme.colors.accent;
}

interface TransferRowProps {
  theme: Theme;
  compact: boolean;
  transfer: TransferRef;
  onFinished(transfer: Transfer): void;
  onDismiss(transferId: string): void;
}

/** One transfer: progress, Cancel while it runs, Dismiss after. Polling ends if the row unmounts. */
function TransferRow({ theme, compact, transfer: ref, onFinished, onDismiss }: TransferRowProps) {
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

  const problem = transferProblem(transfer, query.data, lostContact);
  const percent = percentDone(transfer);
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.sm,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.xs,
      },
      body: { flex: 1, minWidth: 0, gap: 2 },
      name: { color: theme.colors.foreground, fontSize: FONT_SIZE.body },
      detail: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
      error: { color: theme.colors.statusDanger, fontSize: FONT_SIZE.small },
      track: {
        height: 3,
        borderRadius: 2,
        overflow: "hidden" as const,
        backgroundColor: theme.colors.border,
      },
      fill: {
        height: 3,
        width: `${percent ?? 0}%` as const,
        backgroundColor: barColor(theme, transfer, problem),
      },
    }),
    [theme, percent, transfer, problem],
  );
  const verb = transfer?.kind === "upload" ? "Uploading" : "Downloading";
  const running = transfer?.state === "running" && !lostContact;
  return (
    <View style={styles.row}>
      <Icon
        name={transfer?.kind === "upload" ? "ArrowUp" : "ArrowDown"}
        size={16}
        color={theme.colors.foregroundMuted}
      />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {transfer ? `${verb} ${transfer.fileName}` : "Transfer"}
        </Text>
        {percent === null ? null : (
          <View style={styles.track}>
            <View style={styles.fill} />
          </View>
        )}
        {problem ? (
          <Text style={styles.error}>{problem}</Text>
        ) : (
          <Text style={styles.detail}>{describeTransfer(transfer)}</Text>
        )}
      </View>
      {lostContact ? (
        <IconButton
          theme={theme}
          compact={compact}
          icon="RefreshCw"
          label="Retry"
          onPress={retry}
        />
      ) : null}
      {running ? (
        <IconButton
          theme={theme}
          compact={compact}
          icon="X"
          label="Cancel"
          onPress={handleCancel}
        />
      ) : (
        <IconButton
          theme={theme}
          compact={compact}
          icon="X"
          label="Dismiss"
          onPress={handleDismiss}
        />
      )}
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
  compact: boolean;
  transfers: Transfers;
}

const MAX_LIST_HEIGHT = 176;

/**
 * Progress rows for started transfers, docked at the bottom of the sidebar. They poll only while
 * mounted, so the screen keeps this list on screen whichever tab is open; the daemon runs the
 * transfers regardless.
 */
export function TransferList({ theme, compact, transfers }: TransferListProps) {
  const styles = useMemo(
    () => ({
      dock: {
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        maxHeight: MAX_LIST_HEIGHT,
      },
    }),
    [theme],
  );
  if (transfers.refs.length === 0) return null;
  return (
    <View style={styles.dock}>
      <SectionHeader theme={theme} title="Transfers" count={transfers.refs.length} />
      <ScrollView>
        {transfers.refs.map((ref) => (
          <TransferRow
            key={ref.id}
            theme={theme}
            compact={compact}
            transfer={ref}
            onFinished={transfers.finished}
            onDismiss={transfers.dismiss}
          />
        ))}
      </ScrollView>
    </View>
  );
}
