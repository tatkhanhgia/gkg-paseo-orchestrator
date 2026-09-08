import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  CoordinationSignal,
  CoordinationSignalResolution,
} from "@getpaseo/protocol/coordination-signal";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useSessionStore } from "@/stores/session-store";
import { formatTimeAgo } from "@/utils/time";
import {
  partitionCoordinationSignals,
  resolveKindLabelKey,
} from "./coordination-signals-presentation";

const RESOLUTIONS: readonly CoordinationSignalResolution[] = [
  "acknowledged",
  "deferred",
  "declined",
  "completed",
];

// The pending queue plus a collapsed history toggle can still grow past a comfortable
// height; bound the scroll region instead of letting it push the composer off-screen.
// A flat pixel cap alone can still swallow most of a short pane, so it is additionally
// capped as a fraction of the current window height (see useSignalsScrollMaxHeight).
const SIGNALS_SCROLL_MAX_HEIGHT = 320;
const SIGNALS_SCROLL_MAX_HEIGHT_RATIO = 0.4;

function useSignalsScrollMaxHeight(): number {
  const { height } = useWindowDimensions();
  return Math.min(SIGNALS_SCROLL_MAX_HEIGHT, height * SIGNALS_SCROLL_MAX_HEIGHT_RATIO);
}

function resolveStatusLabel(
  status: CoordinationSignal["status"],
  t: (key: string) => string,
): string {
  return t(`agentPanel.coordinationSignals.status.${status}`);
}

function resolveStatusVariant(status: CoordinationSignal["status"]): StatusBadgeVariant {
  if (status === "pending") return "warning";
  if (status === "declined") return "error";
  if (status === "acknowledged" || status === "completed") return "success";
  return "muted";
}

function resolveKindLabel(
  signal: Pick<CoordinationSignal, "kind" | "question">,
  t: (key: string) => string,
): string {
  return t(resolveKindLabelKey(signal));
}

function formatLastOccurredAt(
  iso: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return t("agentPanel.coordinationSignals.lastOccurredAt", { time: iso });
  }
  return t("agentPanel.coordinationSignals.lastOccurredAt", { time: formatTimeAgo(parsed) });
}

function formatLastOccurredAtExact(
  iso: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parsed = new Date(iso);
  const localized = Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
  return t("agentPanel.coordinationSignals.lastOccurredAtExact", { time: localized });
}

function pendingKeyFor(signalId: string, resolution: CoordinationSignalResolution): string {
  return `${signalId}:${resolution}`;
}

function useResolveCoordinationSignal(serverId: string) {
  const { t } = useTranslation();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errorBySignalId, setErrorBySignalId] = useState<Record<string, string>>({});
  // Global dispatch guard: only one resolve mutation may be in flight at a time, across
  // every signal in this section. A ref (not state) is required because it must reject a
  // second dispatch synchronously, before the React state update from the first call
  // commits.
  const dispatchInFlightRef = useRef(false);

  const resolve = useCallback(
    async (input: {
      agentId: string;
      signalId: string;
      resolution: CoordinationSignalResolution;
    }) => {
      if (dispatchInFlightRef.current) {
        return;
      }
      dispatchInFlightRef.current = true;
      setPendingKey(pendingKeyFor(input.signalId, input.resolution));
      setErrorBySignalId((prev) => {
        if (!prev[input.signalId]) return prev;
        const next = { ...prev };
        delete next[input.signalId];
        return next;
      });
      try {
        const client = useSessionStore.getState().sessions[serverId]?.client;
        if (!client) {
          setErrorBySignalId((prev) => ({
            ...prev,
            [input.signalId]: t("common.errors.daemonClientUnavailable"),
          }));
          return;
        }
        await client.resolveCoordinationSignal(input);
      } catch (error) {
        setErrorBySignalId((prev) => ({
          ...prev,
          [input.signalId]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        dispatchInFlightRef.current = false;
        setPendingKey(null);
      }
    },
    [serverId, t],
  );

  return { resolve, pendingKey, errorBySignalId };
}

function CoordinationSignalResolveButton({
  agentId,
  signalId,
  resolution,
  resolve,
  isLoading,
  isRowBusy,
}: {
  agentId: string;
  signalId: string;
  resolution: CoordinationSignalResolution;
  resolve: (input: {
    agentId: string;
    signalId: string;
    resolution: CoordinationSignalResolution;
  }) => void;
  isLoading: boolean;
  isRowBusy: boolean;
}) {
  const { t } = useTranslation();

  const handlePress = useCallback(
    () => resolve({ agentId, signalId, resolution }),
    [resolve, agentId, signalId, resolution],
  );

  return (
    <Button
      size="xs"
      variant="outline"
      loading={isLoading}
      disabled={isRowBusy}
      onPress={handlePress}
      accessibilityLabel={t("agentPanel.coordinationSignals.resolveAccessibilityLabel", {
        resolution: t(`agentPanel.coordinationSignals.resolution.${resolution}`),
      })}
    >
      {t(`agentPanel.coordinationSignals.resolution.${resolution}`)}
    </Button>
  );
}

function CoordinationSignalResolveControls({
  agentId,
  signal,
  resolve,
  pendingKey,
}: {
  agentId: string;
  signal: CoordinationSignal;
  resolve: (input: {
    agentId: string;
    signalId: string;
    resolution: CoordinationSignalResolution;
  }) => void;
  pendingKey: string | null;
}) {
  // Resolve mutations are serialized globally (see useResolveCoordinationSignal): while
  // any disposition is in flight for any signal, every other disposition control across
  // every row is disabled, not just the ones on this row.
  const isAnyResolveInFlight = pendingKey !== null;

  return (
    <View style={styles.actions} accessibilityRole="none">
      {RESOLUTIONS.map((resolution) => (
        <CoordinationSignalResolveButton
          key={resolution}
          agentId={agentId}
          signalId={signal.id}
          resolution={resolution}
          resolve={resolve}
          isLoading={pendingKey === pendingKeyFor(signal.id, resolution)}
          isRowBusy={isAnyResolveInFlight}
        />
      ))}
    </View>
  );
}

function CoordinationSignalDetails({
  signal,
  evidenceRefs,
  evidenceEntries,
}: {
  signal: CoordinationSignal;
  evidenceRefs: readonly string[];
  evidenceEntries: ReadonlyArray<[string, unknown]>;
}) {
  const { t } = useTranslation();
  return (
    <View testID={`coordination-signal-${signal.id}-details`}>
      <Text style={styles.evidence}>
        {t("agentPanel.coordinationSignals.reasonLabel")}: {signal.reason}
      </Text>
      {signal.observation ? (
        <Text style={styles.evidence}>
          {t("agentPanel.coordinationSignals.observationLabel")}: {signal.observation}
        </Text>
      ) : null}
      {signal.question ? (
        <Text style={styles.evidence}>
          {t("agentPanel.coordinationSignals.questionLabel")}: {signal.question}
        </Text>
      ) : null}
      {evidenceRefs.length > 0 ? (
        <Text style={styles.evidence}>
          {t("agentPanel.coordinationSignals.evidenceLabel")}: {evidenceRefs.join(", ")}
        </Text>
      ) : null}
      {evidenceEntries.length > 0 ? (
        <Text style={styles.evidence}>
          {t("agentPanel.coordinationSignals.evidenceDetailLabel")}:{" "}
          {evidenceEntries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}
        </Text>
      ) : null}
      {signal.lastOccurredAt ? (
        <Text style={styles.evidence}>{formatLastOccurredAtExact(signal.lastOccurredAt, t)}</Text>
      ) : null}
    </View>
  );
}

function CoordinationSignalRow({
  signal,
  agentId,
  canResolve,
  resolve,
  pendingKey,
  errorMessage,
}: {
  signal: CoordinationSignal;
  agentId: string;
  canResolve: boolean;
  resolve: (input: {
    agentId: string;
    signalId: string;
    resolution: CoordinationSignalResolution;
  }) => void;
  pendingKey: string | null;
  errorMessage: string | undefined;
}) {
  const { t } = useTranslation();
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const toggleDetails = useCallback(() => setDetailsExpanded((prev) => !prev), []);
  const evidenceRefs = signal.evidenceRefs;
  // Raw evidence, including explicit null/undefined values, is audit-relevant and must
  // never be silently dropped (UX-08); it moves into the details disclosure below rather
  // than cluttering the compact primary surface, but nothing is discarded.
  const evidenceEntries = signal.evidence ? Object.entries(signal.evidence) : [];
  const occurrenceCount = signal.occurrenceCount ?? 1;
  const showResolveControls = canResolve && signal.status === "pending";
  // Only a `continuity_attention` signal that actually carries a question expects a
  // reply; every other continuity_attention is a notice with nothing to answer (UX-07).
  const isRealQuestion = signal.kind === "continuity_attention" && Boolean(signal.question);
  const isNotice = signal.kind === "continuity_attention" && !signal.question;
  // A question already resolved is no longer awaiting a reply; only claim
  // "action needed" while the signal is still pending.
  const needsActionNow = isRealQuestion && signal.status === "pending";
  // The primary surface truncates reason/observation/question to keep the row compact;
  // the details disclosure always carries the full, untruncated text alongside the raw
  // evidence so nothing shown above is ever the only place it is readable (UX-08).

  return (
    <View style={styles.row} testID={`coordination-signal-${signal.id}`}>
      <View style={styles.headerRow}>
        <Text style={styles.kind}>{resolveKindLabel(signal, t)}</Text>
        <StatusBadge
          label={resolveStatusLabel(signal.status, t)}
          variant={resolveStatusVariant(signal.status)}
        />
      </View>
      {isRealQuestion || isNotice ? (
        <Text style={styles.actionHint}>
          {needsActionNow
            ? t("agentPanel.coordinationSignals.actionNeededLabel")
            : t("agentPanel.coordinationSignals.noActionNeededLabel")}
        </Text>
      ) : null}
      <Text style={styles.reason} numberOfLines={2}>
        {t("agentPanel.coordinationSignals.reasonLabel")}: {signal.reason}
      </Text>
      {signal.observation ? (
        <Text style={styles.detail} numberOfLines={2}>
          {t("agentPanel.coordinationSignals.observationLabel")}: {signal.observation}
        </Text>
      ) : null}
      {signal.question ? (
        <Text style={styles.detail} numberOfLines={2}>
          {t("agentPanel.coordinationSignals.questionLabel")}: {signal.question}
        </Text>
      ) : null}
      <Text style={styles.meta}>
        {t("agentPanel.coordinationSignals.occurrenceCount", { count: occurrenceCount })}
        {signal.lastOccurredAt ? ` · ${formatLastOccurredAt(signal.lastOccurredAt, t)}` : ""}
      </Text>
      <Button
        size="xs"
        variant="ghost"
        onPress={toggleDetails}
        testID={`coordination-signal-${signal.id}-details-toggle`}
        accessibilityLabel={
          detailsExpanded
            ? t("agentPanel.coordinationSignals.detailsToggleHide")
            : t("agentPanel.coordinationSignals.detailsToggleShow")
        }
      >
        {detailsExpanded
          ? t("agentPanel.coordinationSignals.detailsToggleHide")
          : t("agentPanel.coordinationSignals.detailsToggleShow")}
      </Button>
      {detailsExpanded ? (
        <CoordinationSignalDetails
          signal={signal}
          evidenceRefs={evidenceRefs}
          evidenceEntries={evidenceEntries}
        />
      ) : null}
      {showResolveControls ? (
        <CoordinationSignalResolveControls
          agentId={agentId}
          signal={signal}
          resolve={resolve}
          pendingKey={pendingKey}
        />
      ) : null}
      {errorMessage ? (
        <Alert
          variant="error"
          title={t("agentPanel.coordinationSignals.resolveErrorLabel")}
          description={errorMessage}
          testID={`coordination-signal-${signal.id}-error`}
        />
      ) : null}
    </View>
  );
}

export function CoordinationSignalsSection({
  signals,
  agentId,
  serverId,
  canResolve = false,
}: {
  signals: readonly CoordinationSignal[] | undefined;
  agentId?: string;
  serverId?: string;
  canResolve?: boolean;
}) {
  const { t } = useTranslation();
  const featureEnabled = useSessionStore((state) =>
    serverId
      ? state.sessions[serverId]?.serverInfo?.features?.coordinationSignalResolution === true
      : false,
  );
  const hasClient = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.client != null : false,
  );
  const { resolve, pendingKey, errorBySignalId } = useResolveCoordinationSignal(serverId ?? "");
  // History is presentation-only and collapsed by default so a long resolved backlog
  // never forces the pending queue and composer out of view (UX-01). This never calls
  // `resolve` and never mutates the daemon's stored signals — collapsing is purely local
  // view state.
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const toggleHistoryExpanded = useCallback(() => setHistoryExpanded((prev) => !prev), []);
  const scrollMaxHeight = useSignalsScrollMaxHeight();

  if (!signals || signals.length === 0) return null;

  const resolveEnabled =
    canResolve && featureEnabled && hasClient && Boolean(agentId) && Boolean(serverId);
  const { pending, history } = partitionCoordinationSignals(signals);
  const visibleHistory = historyExpanded ? history : [];

  return (
    <View style={styles.container} testID="coordination-signals-section">
      <Text style={styles.title} accessibilityRole="header">
        {t("agentPanel.coordinationSignals.title")}
      </Text>
      <ScrollView style={[styles.scrollRegion, { maxHeight: scrollMaxHeight }]} nestedScrollEnabled>
        {pending.map((signal) => (
          <CoordinationSignalRow
            key={signal.id}
            signal={signal}
            agentId={agentId ?? ""}
            canResolve={resolveEnabled}
            resolve={resolve}
            pendingKey={pendingKey}
            errorMessage={errorBySignalId[signal.id]}
          />
        ))}
        {visibleHistory.map((signal) => (
          <CoordinationSignalRow
            key={signal.id}
            signal={signal}
            agentId={agentId ?? ""}
            canResolve={resolveEnabled}
            resolve={resolve}
            pendingKey={pendingKey}
            errorMessage={errorBySignalId[signal.id]}
          />
        ))}
      </ScrollView>
      {history.length > 0 ? (
        <Button
          size="xs"
          variant="ghost"
          onPress={toggleHistoryExpanded}
          testID="coordination-signals-history-toggle"
          accessibilityLabel={
            historyExpanded
              ? t("agentPanel.coordinationSignals.historyToggleCollapse")
              : t("agentPanel.coordinationSignals.historyToggleExpand", { count: history.length })
          }
        >
          {historyExpanded
            ? t("agentPanel.coordinationSignals.historyToggleCollapse")
            : t("agentPanel.coordinationSignals.historyToggleExpand", { count: history.length })}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  scrollRegion: {},
  row: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  kind: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  actionHint: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  reason: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  detail: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  evidence: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
