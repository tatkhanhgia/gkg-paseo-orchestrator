import { useCallback, useMemo, type ReactNode } from "react";
import { router } from "expo-router";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Gavel,
  Scale,
  ShieldAlert,
  UsersRound,
} from "lucide-react-native";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useWorkspace } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import {
  buildHostAgentDetailRoute,
  buildHostCouncilRoute,
  buildHostCouncilsRoute,
} from "@/utils/host-routes";
import {
  councilCasePhaseLabel,
  councilCaseScopeIdentity,
  councilRoleLabel,
  councilTierLabel,
  describeCouncilPlacement,
  projectCouncilCases,
  isCouncilSeatReportReady,
  isCouncilSeatUnavailable,
  type CouncilCase,
  type CouncilPhase,
  type CouncilSeat,
} from "./model";
import { councilHeroSubtitle, councilSeatModelLabel } from "./council-presentation";
import { useCouncilCasesQuery } from "./data";

interface CouncilsScreenProps {
  serverId: string;
  selectedCaseId: string | null;
  selectedWorkspaceId?: string | null;
  selectedScopeId?: string | null;
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedCheck = withUnistyles(Check);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedClock = withUnistyles(Clock3);
const ThemedGavel = withUnistyles(Gavel);
const ThemedScale = withUnistyles(Scale);
const ThemedShieldAlert = withUnistyles(ShieldAlert);
const ThemedUsersRound = withUnistyles(UsersRound);
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundExtraMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});
const statusWarningMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const surfaceMapping = (theme: Theme) => ({ color: theme.colors.surface0 });
const statusSuccessMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const statusDangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

export function CouncilsScreen({
  serverId,
  selectedCaseId,
  selectedWorkspaceId = null,
  selectedScopeId = null,
}: CouncilsScreenProps) {
  const isCompact = useIsCompactFormFactor();
  const agentsResult = useAggregatedAgents({ includeArchived: true });
  const hostAgents = useMemo(
    () => agentsResult.agents.filter((agent) => agent.serverId === serverId),
    [agentsResult.agents, serverId],
  );
  const casesQuery = useCouncilCasesQuery(serverId);
  const councils = useMemo(
    () => projectCouncilCases(casesQuery.data ?? [], hostAgents, serverId),
    [casesQuery.data, hostAgents, serverId],
  );
  const matchingCases = useMemo(
    () => councils.filter((council) => council.id === selectedCaseId),
    [councils, selectedCaseId],
  );
  const selectedCouncil = useMemo(() => {
    if (selectedWorkspaceId) {
      return (
        matchingCases.find(
          (council) => councilCaseScopeIdentity(council) === `workspace:${selectedWorkspaceId}`,
        ) ?? null
      );
    }
    if (selectedScopeId) {
      return (
        matchingCases.find((council) => councilCaseScopeIdentity(council) === selectedScopeId) ??
        null
      );
    }
    return matchingCases.length === 1 ? matchingCases[0] : null;
  }, [matchingCases, selectedScopeId, selectedWorkspaceId]);
  const isAmbiguous =
    Boolean(selectedCaseId) && !selectedWorkspaceId && !selectedScopeId && matchingCases.length > 1;
  const handleScopeChoiceBack = useCallback(() => {
    router.replace(buildHostCouncilsRoute(serverId));
  }, [serverId]);

  let content: ReactNode;
  if (!casesQuery.supportsCouncilCases) {
    content = (
      <CouncilEmpty
        text="Councils require a newer host"
        description="Update this Paseo host to read daemon-owned Council cases."
      />
    );
  } else if (!casesQuery.isConnected) {
    content = <CouncilEmpty text="Host offline" description="Reconnect the host to use Council." />;
  } else if (agentsResult.isInitialLoad || casesQuery.isPending) {
    content = <CouncilLoading />;
  } else if (casesQuery.isError) {
    content = (
      <CouncilEmpty text="Unable to load councils" description={toErrorMessage(casesQuery.error)} />
    );
  } else if (isCompact) {
    if (isAmbiguous) {
      content = (
        <View style={styles.detail} testID="council-scope-choice">
          <BackHeader title="Choose workspace" onBack={handleScopeChoiceBack} />
          <CouncilList councils={matchingCases} selectedCouncil={null} />
        </View>
      );
    } else if (selectedCaseId) {
      content = (
        <CouncilDetail
          council={selectedCouncil}
          requestedCaseId={selectedCaseId}
          serverId={serverId}
          compact
        />
      );
    } else {
      content = <CouncilList councils={councils} selectedCouncil={null} />;
    }
  } else {
    let desktopDetail: ReactNode;
    if (selectedCaseId && isAmbiguous) {
      desktopDetail = (
        <CouncilEmpty
          text="Choose a workspace"
          description="This case ID exists in more than one workspace. Select the exact scoped case from the list."
        />
      );
    } else if (selectedCaseId) {
      desktopDetail = (
        <CouncilDetail
          council={selectedCouncil}
          requestedCaseId={selectedCaseId}
          serverId={serverId}
          compact={false}
        />
      );
    } else {
      desktopDetail = (
        <CouncilEmpty text={councils.length === 0 ? "No councils yet" : "Select a council"} />
      );
    }
    content = (
      <View style={styles.desktopBody}>
        <View style={styles.desktopListPane}>
          <CouncilList councils={councils} selectedCouncil={selectedCouncil} />
        </View>
        <View style={styles.desktopDetailPane}>{desktopDetail}</View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="councils-screen">
      {isCompact && selectedCaseId ? null : <MenuHeader title="Councils" />}
      {content}
    </View>
  );
}

function CouncilLoading() {
  return (
    <View style={styles.centered}>
      <ThemedLoadingSpinner size="large" uniProps={foregroundMutedMapping} />
    </View>
  );
}

function CouncilEmpty({
  text,
  description = "Ask the current Lead to start Council. Cases appear here when its specialist Peer seats launch.",
}: {
  text: string;
  description?: string;
}) {
  return (
    <View style={styles.centered}>
      <ScaleEmptyState />
      <Text style={styles.emptyTitle}>{text}</Text>
      <Text style={styles.emptyDescription}>{description}</Text>
    </View>
  );
}

function ScaleEmptyState() {
  return (
    <View style={styles.emptyIcon}>
      <ThemedScale size={20} uniProps={foregroundExtraMutedMapping} />
    </View>
  );
}

function CouncilList({
  councils,
  selectedCouncil,
}: {
  councils: CouncilCase[];
  selectedCouncil: CouncilCase | null;
}) {
  if (councils.length === 0) {
    return <CouncilEmpty text="No councils yet" />;
  }

  return (
    <ScrollView testID="councils-list">
      <View style={styles.councilList}>
        {councils.map((council) => (
          <CouncilRow
            key={JSON.stringify([council.serverId, councilCaseScopeIdentity(council), council.id])}
            council={council}
            selected={council === selectedCouncil}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function councilScopeTestIdentity(council: CouncilCase): string {
  const scopeId = councilCaseScopeIdentity(council);
  const separator = scopeId.indexOf(":");
  return separator >= 0 ? scopeId.slice(separator + 1) : scopeId;
}

function CouncilRow({ council, selected }: { council: CouncilCase; selected: boolean }) {
  const phaseLabel = councilCasePhaseLabel(council);
  const workspace = useWorkspace(council.serverId, council.workspaceId ?? null);
  const placement = useMemo(
    () => describeCouncilPlacement(council, workspace),
    [council, workspace],
  );
  const scopeTestId = `${council.id}-${councilScopeTestIdentity(council)}`;
  const scopeId = councilCaseScopeIdentity(council);
  const workspaceScopeId = scopeId.startsWith("workspace:")
    ? scopeId.slice("workspace:".length)
    : undefined;
  const handlePress = useCallback(() => {
    router.push(
      buildHostCouncilRoute(
        council.serverId,
        council.id,
        workspaceScopeId,
        workspaceScopeId ? undefined : scopeId,
      ),
    );
  }, [council.id, council.serverId, scopeId, workspaceScopeId]);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.councilRow,
      selected && styles.councilRowSelected,
      (hovered || pressed) && styles.councilRowHovered,
    ],
    [selected],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={`${council.title}, ${phaseLabel}, ${council.readyCount} of ${council.reportSeatCount} reports ready${council.redundantCount > 0 ? `, ${council.redundantCount} replacement not counted` : ""}`}
      testID={`council-row-${scopeTestId}`}
    >
      <View style={styles.councilRowIcon}>
        <ThemedScale size={16} uniProps={foregroundMutedMapping} />
      </View>
      <View style={styles.councilRowBody}>
        <Text style={styles.councilRowTitle} numberOfLines={2}>
          {council.title}
        </Text>
        <Text
          style={styles.councilRowMeta}
          numberOfLines={1}
          testID={`council-row-phase-${scopeTestId}`}
        >
          {councilTierLabel(council.tier)} · {phaseLabel}
          {council.disposition ? ` · ${council.disposition}` : ""}
        </Text>
        <Text
          style={[styles.councilRowPlacement, placement.legacy && styles.councilRowMetaLegacy]}
          numberOfLines={1}
          testID={`council-row-placement-${scopeTestId}`}
        >
          {placement.text}
        </Text>
      </View>
      <View style={styles.councilRowCount}>
        <Text style={styles.councilRowCountValue}>
          {council.readyCount}/{council.reportSeatCount}
        </Text>
        <Text style={styles.councilRowCountLabel}>ready</Text>
      </View>
    </Pressable>
  );
}

function CouncilDetail({
  council,
  requestedCaseId,
  serverId,
  compact,
}: {
  council: CouncilCase | null;
  requestedCaseId: string;
  serverId: string;
  compact: boolean;
}) {
  const handleBack = useCallback(() => {
    router.replace(buildHostCouncilsRoute(serverId));
  }, [serverId]);
  const detailTitle = useMemo(() => <ScreenTitle>Council</ScreenTitle>, []);

  if (!council) {
    return (
      <View style={styles.detail}>
        {compact ? <BackHeader title="Council not found" onBack={handleBack} /> : null}
        <CouncilEmpty text="Council not found" />
      </View>
    );
  }

  return (
    <View style={styles.detail} testID={`council-detail-${requestedCaseId}`}>
      {compact ? (
        <BackHeader title="Council" onBack={handleBack} />
      ) : (
        <ScreenHeader left={detailTitle} />
      )}
      <ScrollView style={styles.detailScroll}>
        <View style={[styles.detailContent, compact && styles.detailContentCompact]}>
          <CouncilHero council={council} compact={compact} />
          <CouncilPhaseRail council={council} />
          <View style={styles.sectionHeading}>
            <View style={styles.sectionHeadingCopy}>
              <Text style={styles.sectionTitle}>Seats</Text>
              <Text style={styles.sectionDescription}>
                Parent-owned specialist Peers · sealed Round 1 stays private
              </Text>
            </View>
            <SeatCount count={council.seats.length} />
          </View>
          <View style={styles.seatGrid}>
            {council.seats.map((seat) => (
              <CouncilSeatCard
                key={`${seat.role}:${seat.round}:${seat.agentId ?? "unassigned"}`}
                seat={seat}
                casePhase={council.phase}
                compact={compact}
              />
            ))}
          </View>
          <CouncilDecisionSummary council={council} compact={compact} />
        </View>
      </ScrollView>
    </View>
  );
}

function CouncilHero({ council, compact }: { council: CouncilCase; compact: boolean }) {
  const tierLabel = councilTierLabel(council.tier);
  const workspace = useWorkspace(council.serverId, council.workspaceId ?? null);
  const placement = useMemo(
    () => describeCouncilPlacement(council, workspace),
    [council, workspace],
  );
  const dispositionLabel = council.disposition?.replaceAll("-", " ") ?? null;
  let reportMetricLabel = "reports ready";
  if (council.unavailableCount > 0) {
    const noun = council.unavailableCount === 1 ? "report" : "reports";
    reportMetricLabel = `${council.unavailableCount} ${noun} unavailable`;
  } else if (council.redundantCount > 0) {
    reportMetricLabel = `reports ready · ${council.redundantCount} not counted`;
  }

  return (
    <View style={styles.hero}>
      <View style={[styles.heroMain, compact && styles.heroMainCompact]}>
        <View style={styles.heroCopy}>
          <View style={styles.caseMeta}>
            <View style={styles.tierBadge}>
              {council.tier === "high-risk" ? (
                <ThemedShieldAlert size={13} uniProps={statusWarningMapping} />
              ) : (
                <ThemedScale size={13} uniProps={foregroundMutedMapping} />
              )}
              <Text style={styles.tierBadgeText}>{tierLabel}</Text>
            </View>
            {dispositionLabel ? (
              <View style={[styles.tierBadge, styles.dispositionBadge]}>
                <ThemedCircleAlert size={13} uniProps={statusWarningMapping} />
                <Text style={[styles.tierBadgeText, styles.dispositionBadgeText]}>
                  {dispositionLabel}
                </Text>
              </View>
            ) : null}
            <Text style={styles.caseId} numberOfLines={1}>
              CASE {council.id}
            </Text>
          </View>
          <Text style={styles.heroTitle}>{council.title}</Text>
          <Text
            style={[styles.heroPlacement, placement.legacy && styles.councilRowMetaLegacy]}
            testID="council-detail-placement"
          >
            {placement.text}
          </Text>
          <Text style={styles.heroSubtitle}>{councilHeroSubtitle(council)}</Text>
        </View>
        <View style={[styles.reportMetric, compact && styles.reportMetricCompact]}>
          <Text style={styles.reportMetricValue}>
            {council.readyCount}/{council.reportSeatCount}
          </Text>
          <Text style={styles.reportMetricLabel}>{reportMetricLabel}</Text>
        </View>
      </View>
    </View>
  );
}

function councilPhaseStageIndex(phase: CouncilPhase): number {
  if (phase === "sealed") {
    return 0;
  }
  if (phase === "verdict") {
    return 2;
  }
  return 1;
}

function CouncilPhaseRail({ council }: { council: CouncilCase }) {
  const currentIndex = councilPhaseStageIndex(council.phase);
  const verdictUnverified =
    council.phase === "verdict" && council.verdictProvenance === "unverified";
  const verdictStageLabel =
    council.phase === "verdict" ? councilCasePhaseLabel(council) : "Verdict";
  const stages = ["Sealed round", "Review", verdictStageLabel];

  return (
    <View
      style={styles.phaseRail}
      accessibilityLabel={`Council phase: ${councilCasePhaseLabel(council)}`}
      testID="council-phase-rail"
    >
      {stages.map((stage, index) => {
        const completed = index < currentIndex;
        const active = index === currentIndex;
        let marker: ReactNode = null;
        if (completed) {
          marker = <ThemedCheck size={12} uniProps={surfaceMapping} strokeWidth={3} />;
        } else if (active) {
          marker = <View style={styles.phaseDotInner} />;
        }
        return (
          <View key={stage} style={styles.phaseStage}>
            <View style={styles.phaseStageTrack}>
              <View
                style={[
                  styles.phaseDot,
                  completed && styles.phaseDotCompleted,
                  active && styles.phaseDotActive,
                  active && verdictUnverified && styles.phaseDotWarning,
                ]}
              >
                {marker}
              </View>
              {index < stages.length - 1 ? (
                <View
                  style={[styles.phaseLine, completed && styles.phaseLineCompleted]}
                  aria-hidden
                />
              ) : null}
            </View>
            <Text
              style={[
                styles.phaseLabel,
                (completed || active) && styles.phaseLabelReached,
                active && styles.phaseLabelActive,
                active && verdictUnverified && styles.phaseLabelWarning,
              ]}
            >
              {stage}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function SeatCount({ count }: { count: number }) {
  return (
    <View style={styles.seatCount}>
      <ThemedUsersRound size={16} uniProps={foregroundMutedMapping} />
      <Text style={styles.seatCountText}>{count}</Text>
    </View>
  );
}

function councilSeatRoundLabel(round: string): string {
  if (round === "verify") {
    return "Verification";
  }
  if (round === "audit") {
    return "Draft audit";
  }
  return `Round ${round}`;
}

function councilSeatStatusLabel(seat: CouncilSeat, ready: boolean): string {
  if (seat.integrity === "compromised") {
    return "Report excluded";
  }
  if (seat.integrity === "missing") {
    return "Report missing";
  }
  if (seat.integrity === "redundant") {
    return "Not counted";
  }
  if (ready) {
    return "Report ready";
  }
  if (!seat.agentId) {
    return "Awaiting launch";
  }
  if (!seat.agent) {
    return "Agent unavailable";
  }
  if (seat.agent.status === "error" || seat.agent.attentionReason === "error") {
    return "Seat failed";
  }
  if (
    seat.integrity === "unspecified" &&
    (seat.agent.status === "idle" || seat.agent.status === "closed")
  ) {
    return "Awaiting Lead audit";
  }
  if (seat.agent.status === "initializing") {
    return "Starting";
  }
  return "In progress";
}

function councilSeatBodyLabel(_seat: CouncilSeat): string {
  return "REPORT";
}

function councilSeatBodyText(seat: CouncilSeat, casePhase: CouncilPhase, ready: boolean): string {
  if (seat.integrity === "compromised") {
    return "Integrity review excluded this report. Open the agent to inspect the exact audit trail.";
  }
  if (seat.integrity === "missing") {
    return "This seat did not produce a usable report. Open the agent to inspect the blocker.";
  }
  if (seat.integrity === "redundant") {
    return "This replacement is preserved for audit but is not counted in the Council report total.";
  }
  if (ready) {
    return "The Lead recorded a daemon-validated Peer-authored Room receipt. Open the Room or agent timeline to inspect the complete evidence.";
  }
  if (!seat.agentId) {
    return "The Lead has not launched this canonical Council seat yet.";
  }
  if (!seat.agent) {
    return "The canonical case references this seat, but its agent record is unavailable.";
  }
  if (seat.agent.status === "error" || seat.agent.attentionReason === "error") {
    return "This seat ended with an error. Open the agent to inspect the failure before using its work.";
  }
  if (
    seat.integrity === "unspecified" &&
    (seat.agent.status === "idle" || seat.agent.status === "closed")
  ) {
    return "The seat finished, but the Lead has not marked its report as valid. Inspect the timeline before counting it.";
  }
  if (casePhase === "sealed") {
    return "Independent analysis is still sealed. The report becomes inspectable after the seat finishes.";
  }
  return "This seat is still working. Its complete report will remain in the agent timeline.";
}

function isCouncilSeatFailed(seat: CouncilSeat): boolean {
  if (seat.integrity === "compromised") return true;
  if (!seat.agent) return false;
  return seat.agent.status === "error" || seat.agent.attentionReason === "error";
}

function councilSeatStatusIcon(input: {
  failed: boolean;
  unavailable: boolean;
  redundant: boolean;
  ready: boolean;
}): ReactNode {
  if (input.failed) {
    return <ThemedCircleAlert size={15} uniProps={statusDangerMapping} />;
  }
  if (input.ready) {
    return <ThemedCheck size={16} uniProps={statusSuccessMapping} strokeWidth={2.5} />;
  }
  if (input.unavailable || input.redundant) {
    return <ThemedCircleAlert size={15} uniProps={statusWarningMapping} />;
  }
  return <ThemedClock size={15} uniProps={foregroundMutedMapping} />;
}

function CouncilSeatFooter({ seat, roleLabel }: { seat: CouncilSeat; roleLabel: string }) {
  const handleOpenAgent = useCallback(() => {
    if (!seat.agent) return;
    router.push(
      buildHostAgentDetailRoute(seat.agent.serverId, seat.agent.id, seat.agent.workspaceId),
    );
  }, [seat.agent]);
  const footerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.seatFooter,
      (hovered || pressed) && styles.seatFooterHovered,
    ],
    [],
  );

  if (!seat.agent) {
    return (
      <View style={styles.seatFooter}>
        <Text style={styles.seatFooterText}>
          {seat.agentId ? "Agent unavailable" : "Awaiting launch"}
        </Text>
      </View>
    );
  }
  return (
    <Pressable
      onPress={handleOpenAgent}
      style={footerStyle}
      accessibilityRole="button"
      accessibilityLabel={`Open ${roleLabel} agent`}
      testID={`council-open-agent-${seat.agent.id}`}
    >
      <Text style={styles.seatFooterText}>Open agent</Text>
      <ThemedChevronRight size={18} uniProps={foregroundMutedMapping} />
    </Pressable>
  );
}

function CouncilSeatCard({
  seat,
  casePhase,
  compact,
}: {
  seat: CouncilSeat;
  casePhase: CouncilPhase;
  compact: boolean;
}) {
  const ready = isCouncilSeatReportReady(seat);
  const unavailable = isCouncilSeatUnavailable(seat);
  const redundant = seat.integrity === "redundant";
  const failed = isCouncilSeatFailed(seat);
  const roleLabel = councilRoleLabel(seat.role);
  const roundLabel = councilSeatRoundLabel(seat.round);
  const modelLabel = councilSeatModelLabel(seat);
  const statusLabel = councilSeatStatusLabel(seat, ready);
  const bodyLabel = councilSeatBodyLabel(seat);
  const bodyText = councilSeatBodyText(seat, casePhase, ready);
  const statusIcon = councilSeatStatusIcon({ failed, unavailable, redundant, ready });

  return (
    <View style={[styles.seatCard, compact ? styles.seatCardCompact : styles.seatCardDesktop]}>
      <View style={styles.seatHeader}>
        <View style={styles.seatIdentity}>
          <View style={styles.seatAvatar}>
            <Text style={styles.seatAvatarText}>{roleLabel.charAt(0)}</Text>
          </View>
          <View style={styles.seatIdentityCopy}>
            <Text style={styles.seatRole} numberOfLines={1}>
              {roleLabel}
            </Text>
            <Text style={styles.seatMeta} numberOfLines={1}>
              {modelLabel} · {roundLabel}
            </Text>
          </View>
        </View>
        <View style={styles.seatStatus}>
          {statusIcon}
          <Text
            style={[
              styles.seatStatusText,
              ready && styles.seatStatusReady,
              failed && styles.seatStatusFailed,
              !failed && (unavailable || redundant) && styles.seatStatusWarning,
            ]}
          >
            {statusLabel}
          </Text>
        </View>
      </View>
      <View style={styles.seatBody}>
        <Text style={styles.eyebrow}>{bodyLabel}</Text>
        <Text style={styles.seatBodyText}>{bodyText}</Text>
      </View>
      <CouncilSeatFooter seat={seat} roleLabel={roleLabel} />
    </View>
  );
}

function councilVerdictCopy(council: CouncilCase): { title: string; text: string } {
  if (council.verdictProvenance === "lead-linked") {
    const disposition = council.disposition?.replaceAll("-", " ");
    return {
      title: disposition ? `Lead-linked verdict · ${disposition}` : "Lead-linked verdict marker",
      text: `${disposition ? `The Lead recorded a ${disposition} disposition. ` : ""}The canonical case entered verdict through its daemon-authorized Lead owner. Open the case owner or Room to inspect the binding decision and handoff evidence.`,
    };
  }
  if (council.phase === "verdict") {
    return {
      title: "Unverified verdict marker",
      text: "The canonical case is in verdict phase, but its linked owner does not have a daemon-issued Lead role binding. Do not treat this marker as a binding decision.",
    };
  }
  return {
    title: "Awaiting Lead verdict",
    text: "Seat count does not decide the outcome. Lead reconciles evidence and records the decision.",
  };
}

function CouncilDecisionSummary({ council, compact }: { council: CouncilCase; compact: boolean }) {
  const verdictLeadLinked = council.verdictProvenance === "lead-linked";
  const verdictCopy = councilVerdictCopy(council);
  const caseOwnerAgentId = council.lead?.id ?? council.parentAgentId;
  const handleOpenLead = useCallback(() => {
    if (!caseOwnerAgentId) {
      return;
    }
    router.push(buildHostAgentDetailRoute(council.serverId, caseOwnerAgentId, council.workspaceId));
  }, [council.serverId, council.workspaceId, caseOwnerAgentId]);
  const leadFooterStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.verdictFooter,
      (hovered || pressed) && styles.seatFooterHovered,
    ],
    [],
  );

  return (
    <View style={styles.summaryGrid}>
      <View
        style={[
          styles.summaryCard,
          compact ? styles.summaryCardCompact : styles.summaryCardDesktop,
        ]}
      >
        <Text style={styles.eyebrow}>ADAPTIVE DECISION MODEL</Text>
        <Text style={styles.summaryTitle}>Lead preserves every decision-changing unit</Text>
        <Text style={styles.summaryText}>
          Verification and targeted rebuttal apply only where evidence can change the verdict. Open
          a seat to inspect exact report evidence.
        </Text>
      </View>
      <View
        style={[
          styles.summaryCard,
          styles.verdictCard,
          compact ? styles.summaryCardCompact : styles.summaryCardDesktop,
        ]}
        testID="council-verdict-summary"
      >
        <View style={styles.verdictHeading}>
          <ThemedGavel size={16} uniProps={foregroundMutedMapping} />
          <Text style={styles.eyebrow}>VERDICT STATUS</Text>
        </View>
        <Text style={styles.summaryTitle}>{verdictCopy.title}</Text>
        <Text style={styles.summaryText}>{verdictCopy.text}</Text>
        {caseOwnerAgentId ? (
          <Pressable
            onPress={handleOpenLead}
            style={leadFooterStyle}
            accessibilityRole="button"
            accessibilityLabel={verdictLeadLinked ? "Open Lead agent" : "Open case owner agent"}
            testID="council-open-lead"
          >
            <Text style={styles.seatFooterText}>
              {verdictLeadLinked ? "Open Lead" : "Open case owner"}
            </Text>
            <ThemedChevronRight size={18} uniProps={foregroundMutedMapping} />
          </Pressable>
        ) : (
          <Text style={styles.leadUnavailable}>
            Lead link is unavailable for this historical case.
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  desktopBody: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  desktopListPane: {
    width: 320,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  desktopDetailPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[2],
  },
  emptyIcon: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  emptyDescription: {
    maxWidth: 360,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    textAlign: "center",
  },
  councilList: {
    padding: theme.spacing[2],
    gap: theme.spacing[1],
  },
  councilRow: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  councilRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  councilRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  councilRowIcon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  councilRowBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  councilRowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  councilRowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  councilRowPlacement: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  councilRowMetaLegacy: {
    fontStyle: "italic",
  },
  councilRowCount: {
    alignItems: "flex-end",
  },
  councilRowCountValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  councilRowCountLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  detail: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  detailScroll: {
    flex: 1,
    minHeight: 0,
  },
  detailContent: {
    width: "100%",
    maxWidth: 1180,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[8],
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[12],
    gap: theme.spacing[6],
  },
  detailContentCompact: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[8],
    gap: theme.spacing[6],
  },
  hero: {
    paddingBottom: theme.spacing[6],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  heroMain: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: theme.spacing[6],
  },
  heroMainCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[4],
  },
  heroCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[3],
  },
  caseMeta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  tierBadge: {
    minHeight: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tierBadgeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "capitalize",
  },
  dispositionBadge: {
    borderColor: theme.colors.statusWarning,
  },
  dispositionBadgeText: {
    color: theme.colors.statusWarning,
  },
  caseId: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.7,
  },
  heroTitle: {
    maxWidth: 760,
    color: theme.colors.foreground,
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 38,
  },
  heroPlacement: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  heroSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 23,
  },
  reportMetric: {
    minWidth: 112,
    paddingLeft: theme.spacing[6],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  reportMetricCompact: {
    minWidth: 0,
    alignSelf: "flex-start",
    paddingLeft: 0,
    borderLeftWidth: 0,
  },
  reportMetricValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  reportMetricLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  phaseRail: {
    flexDirection: "row",
    width: "100%",
    paddingBottom: theme.spacing[1],
  },
  phaseStage: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  phaseStageTrack: {
    flexDirection: "row",
    alignItems: "center",
  },
  phaseDot: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface0,
  },
  phaseDotCompleted: {
    borderColor: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.foregroundMuted,
  },
  phaseDotActive: {
    borderColor: theme.colors.foreground,
  },
  phaseDotWarning: {
    borderColor: theme.colors.statusWarning,
  },
  phaseDotInner: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foreground,
  },
  phaseLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.borderAccent,
  },
  phaseLineCompleted: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  phaseLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  phaseLabelReached: {
    color: theme.colors.foregroundMuted,
  },
  phaseLabelActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  phaseLabelWarning: {
    color: theme.colors.statusWarning,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: theme.spacing[4],
  },
  sectionHeadingCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
  },
  sectionDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  seatCount: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  seatCountText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  seatGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "stretch",
    gap: theme.spacing[4],
  },
  seatCard: {
    minWidth: 0,
    minHeight: 248,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  seatCardDesktop: {
    width: "48%",
    flexGrow: 1,
  },
  seatCardCompact: {
    width: "100%",
  },
  seatHeader: {
    minHeight: 76,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  seatIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  seatAvatar: {
    width: 38,
    height: 38,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  seatAvatarText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  seatIdentityCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  seatRole: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  seatMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  seatStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  seatStatusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  seatStatusReady: {
    color: theme.colors.statusSuccess,
  },
  seatStatusFailed: {
    color: theme.colors.statusDanger,
  },
  seatStatusWarning: {
    color: theme.colors.statusWarning,
  },
  seatBody: {
    flex: 1,
    minHeight: 116,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
  },
  eyebrow: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.8,
  },
  seatBodyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 21,
  },
  seatFooter: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  seatFooterHovered: {
    backgroundColor: theme.colors.surface2,
  },
  seatFooterText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  summaryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "stretch",
    gap: theme.spacing[4],
  },
  summaryCard: {
    minWidth: 0,
    minHeight: 174,
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  summaryCardDesktop: {
    width: "48%",
    flexGrow: 1,
  },
  summaryCardCompact: {
    width: "100%",
  },
  summaryTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 22,
  },
  summaryText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 21,
  },
  verdictCard: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.foregroundMuted,
  },
  verdictHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  verdictFooter: {
    minHeight: 42,
    marginHorizontal: -theme.spacing[6],
    marginBottom: -theme.spacing[6],
    marginTop: "auto",
    paddingHorizontal: theme.spacing[6],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  leadUnavailable: {
    marginTop: "auto",
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
}));
