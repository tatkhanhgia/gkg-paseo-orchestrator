import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AssignmentEnvelopeSchema } from "@getpaseo/protocol/assignment-contract";
import type { PolicyOwner } from "@getpaseo/protocol/policy-owner";
import {
  COUNCIL_REPORT_RECEIPT_VERSION,
  COUNCIL_REPORT_RECEIPT_VERSION_LABEL,
} from "@getpaseo/protocol/council-labels";
import {
  CouncilPhaseSchema,
  CouncilSeatIntegritySchema,
  CouncilSeatReportReceiptSchema,
  CouncilSeatRoleSchema,
  CouncilTierSchema,
  type CouncilCaseRecord,
  type CouncilSeatReportReceipt,
  type CouncilSeatRole,
} from "@getpaseo/protocol/council/types";
import { ensureValidJson } from "../../json-utils.js";
import type { Logger } from "pino";

import type { AgentMode, AgentProvider, AgentSessionConfig } from "../agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import {
  buildAgentCheckpoint,
  type AgentCheckpointSources,
  type CheckpointCallerRelationship,
  type CheckpointCouncilSnapshot,
  type CheckpointPolicy,
  type CheckpointRoleActor,
} from "../agent-checkpoint.js";
import { readBeadsCheckpoint } from "../agent-checkpoint-adapter.js";
import {
  AgentProfileLaunchReceiptSchema,
  AgentProfileSchema,
  PeerSubroleSchema,
  type AgentProfile,
  type AgentProfileLaunchReceipt,
  type PeerDelegationModelRoute,
  type PeerDelegationRunMode,
  type PeerSubrole,
} from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import {
  orderPeerDelegationProfiles,
  resolvePeerDelegationProviderPriority,
  selectPeerDelegationProfileForSubrole,
  selectPeerDelegationProfiles,
} from "@getpaseo/protocol/peer-delegation-priority";
import {
  AgentFeatureSchema,
  AgentPermissionRequestPayloadSchema,
  AgentListItemPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
  WorkspaceScriptPayloadSchema,
} from "../../messages.js";
import type { AgentListItemPayload } from "../../messages.js";
import {
  buildStoredAgentPayload,
  toAgentListItemPayload,
  toAgentPayload,
} from "../agent-projections.js";
import { curateAgentActivity } from "../activity-curator.js";
import { selectItemsByProjectedLimit } from "../timeline-projection.js";
import type { AgentStorage, FinishNotificationWatch, StoredAgentRecord } from "../agent-storage.js";
import { ensureAgentLoaded, hasPendingAgentInitialization } from "../agent-loading.js";
import { isStoredAgentProviderAvailable } from "../../persistence-hooks.js";
import {
  archiveByScope,
  killTerminalsForWorkspace,
  requireActiveWorkspaceForArchive,
  type ArchiveDependencies,
} from "../../workspace-archive-service.js";
import {
  createAgentCommand,
  formatProviderModel,
  type CreateAgentFromMcpInput,
} from "../create-agent/create.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../../voice-types.js";
import type { FirstAgentContext } from "../../messages.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";
import { expandUserPath, isSameOrDescendantPath, resolvePathFromBase } from "../../path-utils.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type {
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../../worktree-session.js";
import type { ScheduleService } from "../../schedule/service.js";
import {
  ScheduleRunSchema,
  ScheduleSummarySchema,
  StoredScheduleSchema,
  type ScheduleCadence,
  type UpdateScheduleInput,
} from "@getpaseo/protocol/schedule/types";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  AgentModelSchema,
  AgentProviderEnum,
  AgentStatusEnum,
  ProviderModeSchema,
  ProviderSummarySchema,
  parseDurationString,
  resolveRequiredProviderModel,
  sanitizePermissionRequest,
  serializeSnapshotWithMetadata,
  toScheduleSummary,
  waitForAgentWithTimeout,
} from "../mcp-shared.js";
import { sendPromptToAgent } from "../agent-prompt.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  ChatMessageSchema,
  ChatRoomDetailSchema,
  type ChatMessage,
} from "@getpaseo/protocol/chat/types";
import { LaunchContractReceiptSchema } from "@getpaseo/protocol/launch-contract";
import type { FileBackedChatService } from "../../chat/chat-service.js";
import { postChatMessageWithMentions } from "../../chat/post.js";
import { respondToAgentPermission } from "../permission-response.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
  validateAgentLabelUpdate,
} from "../lifecycle-command.js";
import type { ForgeService } from "../../../services/forge-service.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type {
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../../workspace-registry.js";
import { resolveWorktreeSourceCwd } from "../../workspace-source.js";
import type { WorkspaceScriptsService } from "../../session/workspace-scripts/workspace-scripts-service.js";
import {
  type ArchiveCommandDependencies,
  type CreatePaseoWorktreeCommandInput,
  createPaseoWorktreeCommand,
} from "../../worktree/commands.js";
import { registerBrowserTools } from "../../browser-tools/tools.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import { registerBeadsTools } from "../../beads/beads-tools.js";
import { beadsActorForAgent, type BeadsService } from "../../beads/beads-service.js";
import type {
  PaseoToolCatalog,
  PaseoToolConfig,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "./types.js";
import { isPaseoToolEnabled } from "../paseo-tool-policy.js";
import {
  isPaseoSupportedProvider,
  type ProviderPaseoToolsPolicy,
} from "@getpaseo/protocol/provider-config";
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import {
  policyOwnerForRoleBinding,
  toRoleBindingReceipt,
  type PersistedRoleBinding,
} from "../role-binding.js";
import { toLaunchContractReceipt } from "../launch-contract.js";
import {
  PaseoRoleIdSchema,
  RoleBindingReceiptSchema,
  type RoleBindingInjectionMethod,
  type PaseoRoleId,
} from "@getpaseo/protocol/role-binding";
import { noWriteModeForInjectionMethod } from "../assignment-capability-boundary.js";
import {
  ManualCoordinationSignalKindSchema,
  CoordinationSignalResolutionSchema,
  CoordinationSignalSchema,
} from "@getpaseo/protocol/coordination-signal";
import { requestCoordinationSignal, resolveCoordinationSignal } from "../coordination-signals.js";
import {
  LeadHandoffPacketSchema,
  LeadHandoffTransitionSchema,
  PrepareLeadHandoffInputSchema,
} from "@getpaseo/protocol/lead-handoff";
import { prepareLeadHandoff, transitionLeadHandoff } from "../lead-handoffs.js";
import type { CouncilCaseStore } from "../../council/council-case-store.js";
import {
  attachFinishNotificationWatch,
  cancelFinishNotificationWatch,
  registerFinishNotificationWatch,
  type FinishNotificationDependencies,
} from "../finish-notification.js";

export interface PaseoToolHostDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager?: TerminalManager | null;
  getDaemonTcpPort?: () => number | null;
  scheduleService?: ScheduleService | null;
  chatService?: FileBackedChatService | null;
  councilCaseStore?: Pick<
    CouncilCaseStore,
    "list" | "create" | "assertSeatLaunch" | "assignSeat" | "recordSeat"
  > | null;
  resolveCouncilSeatProjection?: FinishNotificationDependencies["resolveCouncilSeatProjection"];
  resolveAgentIdentifier?: (
    identifier: string,
  ) => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
  sendAgentMessage?: (agentId: string, text: string) => Promise<void>;
  sendAgentMessageAtSafeBoundary?: (agentId: string, text: string) => Promise<void>;
  providerSnapshotManager: ProviderSnapshotManager;
  daemonConfigStore?: Pick<DaemonConfigStore, "get">;
  github?: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
  >;
  findWorkspaceIdForCwd?: ArchiveDependencies["findWorkspaceIdForCwd"];
  listActiveWorkspaces?: ArchiveDependencies["listActiveWorkspaces"];
  archiveWorkspaceRecord?: ArchiveDependencies["archiveWorkspaceRecord"];
  emitWorkspaceUpdatesForWorkspaceIds?: ArchiveDependencies["emitWorkspaceUpdatesForWorkspaceIds"];
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "list" | "upsert">;
  projectRegistry?: Pick<ProjectRegistry, "get" | "list">;
  createDirectoryWorkspace?: (
    cwd: string,
    title?: string | null,
    projectId?: string,
  ) => Promise<PersistedWorkspaceRecord>;
  workspaceScripts?: Pick<WorkspaceScriptsService, "list" | "launch" | "stop">;
  markWorkspaceArchiving?: ArchiveDependencies["markWorkspaceArchiving"];
  clearWorkspaceArchiving?: ArchiveDependencies["clearWorkspaceArchiving"];
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<string>;
  rollbackWorkspaceAfterFailedCreate?: (workspaceId: string) => Promise<void>;
  rollbackWorktreeAfterFailedCreate?: (
    createdWorktree: CreatePaseoWorktreeWorkflowResult,
  ) => Promise<void>;
  browserToolsEnabled?: boolean;
  browserToolsBroker?: BrowserToolsBroker | null;
  beadsService?: BeadsService | null;
  paseoToolPolicy?: ProviderPaseoToolsPolicy;
  paseoHome?: string;
  worktreesRoot?: string;
  /**
   * ID of the agent that is using this tool catalog.
   * Used for cwd/mode inheritance when agents spawn child agents.
   */
  callerAgentId?: string;
  /**
   * Optional resolver for session-bound speak handlers.
   * Used by hidden voice agents to narrate through daemon-managed TTS.
   */
  resolveSpeakHandler?: (callerAgentId: string) => VoiceSpeakHandler | null;
  resolveCallerContext?: (callerAgentId: string) => VoiceCallerContext | null;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
  logger: Logger;
}

type LaunchableAgentProfile = AgentProfile & { model: string };

const ExecutionProfileBindingReceiptSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

function councilSeatLaunch(
  labels: Readonly<Record<string, string>> | undefined,
): { caseId: string; role: CouncilSeatRole } | null {
  const caseId = labels?.["council.case_id"]?.trim();
  if (!caseId) return null;
  const role = CouncilSeatRoleSchema.parse(labels?.["council.role"]);
  return { caseId, role };
}

function requireCouncilReportContext(
  labels: Readonly<Record<string, string>>,
  agentId: string,
  reportSentinels: (role: CouncilSeatRole) => {
    startSentinel: string;
    endSentinel: string;
  },
): {
  roomId: string;
  kickoffMessageId: string;
  startSentinel: string;
  endSentinel: string;
} {
  const roomId = labels["council.room_id"]?.trim();
  const kickoffMessageId = labels["council.kickoff_message_id"]?.trim();
  const seatRole = CouncilSeatRoleSchema.safeParse(labels["council.role"]);
  if (!roomId || !kickoffMessageId || !seatRole.success) {
    throw new Error(
      `Council seat '${agentId}' is missing daemon-issued Room, kickoff, or role labels`,
    );
  }
  const sentinels = reportSentinels(seatRole.data);
  if (
    labels["council.report_start_sentinel"] !== sentinels.startSentinel ||
    labels["council.report_end_sentinel"] !== sentinels.endSentinel
  ) {
    throw new Error(`Council seat '${agentId}' has invalid report sentinel labels`);
  }
  return { roomId, kickoffMessageId, ...sentinels };
}

function assertCouncilSeatTerminal(agent: ManagedAgent): void {
  if (agent.lifecycle !== "idle" && agent.lifecycle !== "closed") {
    throw new Error(
      `Council seat '${agent.id}' is not terminal; current lifecycle is '${agent.lifecycle}'`,
    );
  }
  if (
    agent.lastError ||
    (agent.attention?.requiresAttention && agent.attention.attentionReason === "error")
  ) {
    throw new Error(`Council seat '${agent.id}' ended with an error`);
  }
}

function requireCouncilKickoff(input: {
  messages: readonly ChatMessage[];
  roomId: string;
  kickoffMessageId: string;
  callerAgentId: string;
  caseId: string;
  assertBody(body: string, caseId: string): void;
}): ChatMessage {
  const kickoff = input.messages.find((message) => message.id === input.kickoffMessageId);
  if (
    !kickoff ||
    kickoff.roomId !== input.roomId ||
    kickoff.authorAgentId !== input.callerAgentId ||
    kickoff.authorKind !== "agent"
  ) {
    throw new Error(`Council '${input.caseId}' kickoff receipt is unavailable or invalid`);
  }
  input.assertBody(kickoff.body, input.caseId);
  return kickoff;
}

function requireCouncilReport(input: {
  messages: readonly ChatMessage[];
  roomId: string;
  reportMessageId: string;
  agentId: string;
  kickoff: ChatMessage;
  startSentinel: string;
  endSentinel: string;
}): ChatMessage {
  const report = input.messages.find((message) => message.id === input.reportMessageId);
  if (
    !report ||
    report.roomId !== input.roomId ||
    report.authorAgentId !== input.agentId ||
    report.authorKind !== "agent"
  ) {
    throw new Error(
      `Council report '${input.reportMessageId}' is not authored by Peer '${input.agentId}' in Room '${input.roomId}'`,
    );
  }
  if (report.createdAt < input.kickoff.createdAt) {
    throw new Error(`Council report '${input.reportMessageId}' predates the Council kickoff`);
  }
  const reportLines = report.body.trim().split(/\r?\n/u);
  if (
    reportLines[0] !== input.startSentinel ||
    reportLines.at(-1) !== input.endSentinel ||
    reportLines.slice(1, -1).every((line) => line.trim().length === 0)
  ) {
    throw new Error(
      `Council report '${input.reportMessageId}' does not satisfy ${input.startSentinel}..${input.endSentinel}`,
    );
  }
  return report;
}

async function validateCouncilSeatReportReceipt(input: {
  agentManager: AgentManager;
  chatService: FileBackedChatService;
  target: Pick<ManagedAgent | StoredAgentRecord, "labels" | "roleBinding">;
  callerAgentId: string;
  caseId: string;
  agentId: string;
  phase: "sealed" | "review" | "audit" | "verdict";
  reportMessageId?: string;
}): Promise<CouncilSeatReportReceipt> {
  if (input.phase === "sealed") {
    throw new Error("A valid Council seat must advance beyond the sealed phase");
  }
  const liveTarget = input.agentManager.getAgent(input.agentId);
  if (!liveTarget) {
    throw new Error(
      `Council seat '${input.agentId}' must be loaded so its terminal lifecycle can be audited`,
    );
  }
  assertCouncilSeatTerminal(liveTarget);
  if (!input.reportMessageId) {
    throw new Error("integrity=valid requires reportMessageId from the Peer post_room receipt");
  }

  if (!input.target.roleBinding) {
    throw new Error(`Council seat '${input.agentId}' has no pinned role policy`);
  }
  const councilPolicy = input.agentManager.resolveSlpPolicyForRoleBinding(
    input.target.roleBinding,
  ).councilPolicy;
  const context = requireCouncilReportContext(
    input.target.labels,
    input.agentId,
    councilPolicy.reportSentinels,
  );
  const messages = await input.chatService.readMessages({ room: context.roomId, limit: 100 });
  const kickoff = requireCouncilKickoff({
    messages,
    callerAgentId: input.callerAgentId,
    ...context,
    caseId: input.caseId,
    assertBody: (body, caseId) => councilPolicy.assertKickoffBody({ body, caseId }),
  });
  const report = requireCouncilReport({
    messages,
    roomId: context.roomId,
    reportMessageId: input.reportMessageId,
    agentId: input.agentId,
    kickoff,
    startSentinel: context.startSentinel,
    endSentinel: context.endSentinel,
  });
  return {
    roomId: context.roomId,
    kickoffMessageId: context.kickoffMessageId,
    reportMessageId: input.reportMessageId,
    reportDigest: createHash("sha256").update(report.body).digest("hex"),
    authorAgentId: input.agentId,
    startSentinel: context.startSentinel,
    endSentinel: context.endSentinel,
    createdAt: report.createdAt,
  };
}

function assertCouncilSeatRecordAuthority(input: {
  target: Pick<ManagedAgent | StoredAgentRecord, "labels" | "roleBinding" | "workspaceId">;
  callerAgentId: string;
  callerWorkspaceId: string | undefined;
  caseId: string;
  agentId: string;
}): void {
  if (input.target.roleBinding?.roleId !== "peer") {
    throw new Error("A Council seat must be a role-bound Peer");
  }
  if (getParentAgentIdFromLabels(input.target.labels) !== input.callerAgentId) {
    throw new Error("A Lead may record only its own direct Peer child");
  }
  if (
    input.callerWorkspaceId &&
    input.target.workspaceId &&
    input.target.workspaceId !== input.callerWorkspaceId
  ) {
    throw new Error("A Council seat must belong to the Lead workspace");
  }
  if (input.target.labels["council.case_id"] !== input.caseId) {
    throw new Error(`Peer '${input.agentId}' is not a seat in Council '${input.caseId}'`);
  }
}

async function updateCouncilCompatibilityReceipt(input: {
  agentManager: AgentManager;
  logger: Logger;
  agentId: string;
  caseId: string;
  phase: "sealed" | "review" | "audit" | "verdict";
  integrity: "unspecified" | "valid" | "compromised" | "missing" | "redundant";
  disposition?: string;
  reportReceipt?: CouncilSeatReportReceipt;
}): Promise<void> {
  const labels: Record<string, string> = {
    "council.phase": input.phase,
    "council.integrity": input.integrity,
  };
  if (input.disposition) labels["council.disposition"] = input.disposition;
  if (input.reportReceipt) {
    labels["council.report_message_id"] = input.reportReceipt.reportMessageId;
    labels["council.report_digest"] = input.reportReceipt.reportDigest;
    labels["council.report_created_at"] = input.reportReceipt.createdAt;
    labels[COUNCIL_REPORT_RECEIPT_VERSION_LABEL] = COUNCIL_REPORT_RECEIPT_VERSION;
  }

  try {
    const result = await updateAgentCommand(
      { agentManager: input.agentManager },
      { agentId: input.agentId, labels },
      { allowCouncilLabels: true },
    );
    if (!result.accepted) {
      throw new Error(result.error ?? "Council compatibility label update was rejected");
    }
  } catch (error) {
    input.logger.warn(
      { agentId: input.agentId, caseId: input.caseId, error },
      "Canonical Council seat recorded but compatibility labels were not updated",
    );
  }
}

async function assertCanonicalCouncilSeatLaunch(input: {
  launch: { caseId: string; role: CouncilSeatRole } | null;
  store: PaseoToolHostDependencies["councilCaseStore"];
  callerAgentId: string | undefined;
  workspaceId: string | null;
}): Promise<void> {
  if (!input.launch) return;
  if (!input.callerAgentId || !input.store) {
    throw new Error("Council seat launch requires a Lead-owned canonical Council case");
  }
  await input.store.assertSeatLaunch(
    input.launch.caseId,
    input.launch.role,
    input.callerAgentId,
    input.workspaceId,
  );
}

function createCouncilSeatAssignmentHooks(input: {
  launch: { caseId: string; role: CouncilSeatRole } | null;
  store: PaseoToolHostDependencies["councilCaseStore"];
  callerAgentId: string | undefined;
  workspaceId: string | null;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): Pick<CreateAgentFromMcpInput, "onCreated"> {
  const { launch, callerAgentId, store } = input;
  if (!launch || !callerAgentId || !store) return {};
  return {
    onCreated: async ({ agentId }) => {
      try {
        await store.assignSeat({
          caseId: launch.caseId,
          role: launch.role,
          agentId,
          parentAgentId: callerAgentId,
          workspaceId: input.workspaceId,
        });
      } catch (error) {
        await archiveAgentCommand(
          {
            agentManager: input.agentManager,
            agentStorage: input.agentStorage,
            logger: input.logger,
          },
          agentId,
        ).catch((archiveError) => {
          input.logger.error(
            { archiveError, agentId, caseId: launch.caseId },
            "Failed to archive an unassigned Council seat",
          );
        });
        throw error;
      }
    },
  };
}

function formatPeerRouteList(routes: readonly PeerDelegationModelRoute[]): string[] {
  return routes.map((route) => formatProviderModel(route.provider, route.model));
}

function selectPeerLaunchProfile(input: {
  profileIds: readonly string[];
  profiles: readonly AgentProfile[];
  requestedProfileId?: string;
  requestedSubrole?: PeerSubrole;
  defaultSubrole?: PeerSubrole;
  providerPriority?: readonly string[];
}): AgentProfile {
  if (input.profileIds.length === 0) {
    throw new Error(
      "Lead-to-Peer creation is blocked because no Agent Profiles are Human-approved",
    );
  }
  const profilesById = new Map(input.profiles.map((profile) => [profile.id, profile]));
  if (input.requestedProfileId !== undefined) {
    if (!input.profileIds.includes(input.requestedProfileId)) {
      throw new Error(
        `Peer Agent Profile '${input.requestedProfileId}' is not allowed by the Human-configured policy`,
      );
    }
    const requested = profilesById.get(input.requestedProfileId);
    if (!requested) {
      throw new Error(
        `Peer Agent Profile '${input.requestedProfileId}' no longer exists; call list_profiles and choose an exact returned ID`,
      );
    }
    if (input.requestedSubrole && requested.peerSubrole !== input.requestedSubrole) {
      const profileSubrole = requested.peerSubrole
        ? `'${requested.peerSubrole}'`
        : "no Peer subrole";
      throw new Error(
        `Peer Agent Profile '${requested.name}' (${requested.id}) is tagged for ${profileSubrole} and cannot satisfy requested subrole '${input.requestedSubrole}'`,
      );
    }
    return requested;
  }

  const available = input.profileIds.flatMap((id) => {
    const candidate = profilesById.get(id);
    return candidate ? [candidate] : [];
  });
  if (available.length === 0) {
    throw new Error(
      "The Human-approved Peer Agent Profiles no longer exist; ask the Human to update Agents settings",
    );
  }
  const selectedSubrole = input.requestedSubrole ?? input.defaultSubrole;
  if (selectedSubrole) {
    const selected = selectPeerDelegationProfileForSubrole(
      available,
      available.map((profile) => profile.id),
      input.providerPriority,
      selectedSubrole,
    );
    if (!selected) {
      throw new Error(
        `No Human-approved Peer Agent Profile is tagged for subrole '${selectedSubrole}'; choose an exact launchProfileId or update Agents settings`,
      );
    }
    return selected;
  }
  if (available.length > 1) {
    throw new Error(
      `Select an exact Human-approved Peer Agent Profile with launchProfileId: ${available
        .map((candidate) => `${candidate.name} (${candidate.id})`)
        .join(", ")}`,
    );
  }
  return available[0];
}

function projectLaunchProfileReceipt(profile: LaunchableAgentProfile | undefined): {
  launchProfile?: AgentProfileLaunchReceipt;
} {
  if (!profile) return {};
  return {
    launchProfile: {
      id: profile.id,
      name: profile.name,
      ...(profile.peerSubrole ? { peerSubrole: profile.peerSubrole } : {}),
    },
  };
}

function resolvePeerPolicyProviderRoute(
  requestedProvider: string,
  allowedRoutes: readonly PeerDelegationModelRoute[] | undefined,
): string {
  if (allowedRoutes?.length === 0) {
    throw new Error(
      "Lead-to-Peer creation is disabled by the Human-configured Peer delegation model policy",
    );
  }
  if (requestedProvider || allowedRoutes === undefined) return requestedProvider;
  if (allowedRoutes.length === 1) {
    const onlyRoute = allowedRoutes[0];
    return formatProviderModel(onlyRoute.provider, onlyRoute.model);
  }
  throw new Error(
    `Select an exact Human-approved Peer provider/model route: ${formatPeerRouteList(allowedRoutes).join(", ")}`,
  );
}

function assertPeerPolicyAllowsRoute(
  providerRoute: string,
  provider: string,
  model: string | undefined,
  allowedRoutes: readonly PeerDelegationModelRoute[] | undefined,
): void {
  if (
    allowedRoutes === undefined ||
    allowedRoutes.some((route) => route.provider === provider && route.model === model)
  ) {
    return;
  }
  throw new Error(
    `Peer route '${providerRoute}' is not allowed by the Human-configured policy. Allowed routes: ${formatPeerRouteList(allowedRoutes).join(", ") || "none"}`,
  );
}

function resolvePeerPolicyMode(input: {
  provider: string;
  modes: readonly AgentMode[];
  defaultModeId: string | null | undefined;
  runMode: PeerDelegationRunMode;
}): string {
  const { provider, modes, defaultModeId, runMode } = input;
  if (runMode === "unattended") {
    const unattendedMode = modes.find((mode) => mode.isUnattended === true);
    if (unattendedMode) return unattendedMode.id;
    const manifestUnattendedModeId = getUnattendedModeId(provider);
    if (manifestUnattendedModeId && modes.some((mode) => mode.id === manifestUnattendedModeId)) {
      return manifestUnattendedModeId;
    }
    throw new Error(
      `Provider '${provider}' has no qualified unattended mode for Human-approved Peer delegation`,
    );
  }

  const defaultMode = modes.find((mode) => mode.id === defaultModeId);
  if (defaultMode && defaultMode.isUnattended !== true) return defaultMode.id;
  const guardedMode =
    modes.find((mode) => mode.isUnattended !== true && mode.colorTier !== "planning") ??
    modes.find((mode) => mode.isUnattended !== true);
  if (guardedMode) return guardedMode.id;
  throw new Error(`Provider '${provider}' has no guarded mode for Human-approved Peer delegation`);
}

function registerConfiguredBeadsTools(
  options: PaseoToolHostDependencies,
  registerTool: Parameters<typeof registerBeadsTools>[0]["registerTool"],
): void {
  if (!options.callerAgentId || !options.beadsService || !options.workspaceRegistry) return;
  const roleBinding = resolveCatalogRoleBinding(options.agentManager, options.callerAgentId);
  if (!roleBinding) return;
  registerBeadsTools({
    registerTool,
    service: options.beadsService,
    agentStorage: options.agentStorage,
    workspaceRegistry: options.workspaceRegistry,
    projectRegistry: options.projectRegistry,
    callerAgentId: options.callerAgentId,
    roleId: roleBinding.roleId,
  });
}

function resolveCatalogRoleBinding(agentManager: AgentManager, agentId: string) {
  const resolver = (
    agentManager as AgentManager & {
      getRoleBindingForToolCatalog?: AgentManager["getRoleBindingForToolCatalog"];
    }
  ).getRoleBindingForToolCatalog;
  return typeof resolver === "function"
    ? resolver.call(agentManager, agentId)
    : agentManager.getAgent(agentId)?.roleBinding;
}

function resolveOptionalCatalogRoleBinding(
  agentManager: AgentManager,
  agentId: string | undefined,
) {
  return agentId ? resolveCatalogRoleBinding(agentManager, agentId) : undefined;
}

function projectFoundationLaunchReceipts(
  agent: Pick<ManagedAgent, "roleBinding" | "launchContract">,
  options?: { includeExecutionProfile?: boolean },
) {
  return {
    ...(agent.roleBinding ? { roleBinding: toRoleBindingReceipt(agent.roleBinding) } : {}),
    ...(agent.launchContract
      ? { launchContract: toLaunchContractReceipt(agent.launchContract) }
      : {}),
    ...(options?.includeExecutionProfile && agent.roleBinding?.executionProfile
      ? { executionProfile: agent.roleBinding.executionProfile }
      : {}),
  };
}

function resolveCoordinationDescriptions(
  agentManager: AgentManager,
  hasCallerRoleBinding: boolean,
  resolvePolicy: () => ReturnType<AgentManager["resolveSlpPolicyForRoleBinding"]>,
) {
  const hasResolver = hasCallerRoleBinding
    ? typeof (
        agentManager as AgentManager & {
          resolveSlpPolicyForRoleBinding?: AgentManager["resolveSlpPolicyForRoleBinding"];
        }
      ).resolveSlpPolicyForRoleBinding === "function"
    : typeof (
        agentManager as AgentManager & {
          resolveActiveSlpPolicy?: AgentManager["resolveActiveSlpPolicy"];
        }
      ).resolveActiveSlpPolicy === "function";
  const unavailable = "Requires an active bundled role policy.";
  const fallback = {
    prepareLeadHandoff: unavailable,
    transitionLeadHandoff: unavailable,
    signalAgent: unavailable,
    askAttentionQuestion: unavailable,
    resolveAgentSignal: unavailable,
  };
  if (!hasResolver) return fallback;
  try {
    return resolvePolicy().coordinationPolicy.descriptions;
  } catch (error) {
    if (hasCallerRoleBinding) throw error;
    return fallback;
  }
}

function resolveCatalogCoordinationDescriptions(input: {
  agentManager: AgentManager;
  callerRoleBinding: PersistedRoleBinding | undefined;
  resolveSlpPolicy: () => ReturnType<AgentManager["resolveSlpPolicyForRoleBinding"]>;
}) {
  if (input.callerRoleBinding && !isSlpPolicyBinding(input.callerRoleBinding)) {
    return {
      prepareLeadHandoff: "Unsupported for this pinned policy owner.",
      transitionLeadHandoff: "Unsupported for this pinned policy owner.",
      signalAgent: "Unsupported for this pinned policy owner.",
      askAttentionQuestion: "Unsupported for this pinned policy owner.",
      resolveAgentSignal: "Unsupported for this pinned policy owner.",
    };
  }
  return resolveCoordinationDescriptions(
    input.agentManager,
    input.callerRoleBinding !== undefined,
    input.resolveSlpPolicy,
  );
}

type CheckpointToolRegistrar = (
  name: string,
  config: PaseoToolConfig,
  handler: (
    input: { agentId: string },
    context: PaseoToolExecutionContext,
  ) => Promise<PaseoToolResult>,
) => void;

function registerAgentCheckpointTool(input: {
  callerAgentId: string | undefined;
  options: PaseoToolHostDependencies;
  registerTool: CheckpointToolRegistrar;
}): void {
  const callerAgentId = input.callerAgentId;
  if (!callerAgentId) return;
  input.registerTool(
    "get_agent_checkpoint",
    {
      title: "Get agent checkpoint",
      description:
        "Read a bounded, evidence-backed checkpoint for an exact agent relationship. This is read-only: it reports lifecycle, pending permission, coordination, canonical Council, and exact target-bound Beads evidence without inferring completion or acceptance.",
      inputSchema: {
        agentId: z.string().trim().min(1),
      },
    },
    async ({ agentId }, context) => ({
      content: [],
      structuredContent: ensureValidJson({
        checkpoint: await buildProductionAgentCheckpoint({
          options: input.options,
          callerAgentId,
          targetAgentId: agentId,
          signal: context.signal,
        }),
      }),
    }),
  );
}

function executionProfileInputShape(enabled: boolean): z.ZodRawShape {
  if (!enabled) {
    return {};
  }
  return {
    executionProfile: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional execution profile ID owned by the selected role policy."),
  };
}

function executionProfileOutputShape(enabled: boolean): z.ZodRawShape {
  if (!enabled) {
    return {};
  }
  return { executionProfile: ExecutionProfileBindingReceiptSchema.optional() };
}

function resolveExecutionProfileRequest(
  parsedArgs: object,
  callerRoleId: string | undefined,
  resolvePolicy: () => ReturnType<AgentManager["resolveSlpPolicyForRoleBinding"]>,
) {
  if (!("executionProfile" in parsedArgs) || parsedArgs.executionProfile === undefined) {
    return undefined;
  }
  return resolvePolicy().executionProfilePolicy.resolveCreateRequest({
    value: parsedArgs.executionProfile,
    callerRoleId,
    requestedRole: "role" in parsedArgs ? parsedArgs.role : undefined,
  });
}

type AgentScopedRoleTopologyAction =
  | { kind: "create_agent"; requestedRole: PaseoRoleId | undefined }
  | { kind: "send_agent_prompt"; targetAgentId: string };

function hasSupervisorDelegationLease(caller: StoredAgentRecord): boolean {
  return (
    caller.roleBinding?.roleId === "supervisor" &&
    caller.roleBinding.assignmentContract?.envelope.effectClass === "delegation"
  );
}

function hasLeadDelegationAuthority(caller: StoredAgentRecord): boolean {
  if (caller.roleBinding?.roleId !== "lead") return false;
  const effectClass = caller.roleBinding.assignmentContract?.envelope.effectClass;
  return effectClass === "mutating" || effectClass === "delegation";
}

function assertRoleBoundCreateAuthorized(
  caller: StoredAgentRecord,
  requestedRole: PaseoRoleId | undefined,
): void {
  const callerRole = caller.roleBinding?.roleId;
  if (callerRole === "lead") {
    if (requestedRole === "peer" && hasLeadDelegationAuthority(caller)) return;
    if (requestedRole === "peer") {
      throw new Error(
        "A role-bound Lead needs Work & coordinate or Coordinate only authority to create a Peer",
      );
    }
    throw new Error("A role-bound Lead may create only a role-bound Peer");
  }
  if (callerRole === "supervisor") {
    if (hasSupervisorDelegationLease(caller) && requestedRole === "lead") return;
    throw new Error(
      "A role-bound Supervisor may create only a role-bound Lead under a Human-issued delegation assignment",
    );
  }
  throw new Error(`Role-bound ${callerRole} agents cannot use create_agent`);
}

async function assertRoleBoundPromptAuthorized(input: {
  agentStorage: AgentStorage;
  caller: StoredAgentRecord;
  callerAgentId: string;
  targetAgentId: string;
}): Promise<void> {
  const target = await input.agentStorage.get(input.targetAgentId);
  if (!target) {
    throw new Error(`Target agent ${input.targetAgentId} is unavailable in durable storage`);
  }
  const callerRole = input.caller.roleBinding?.roleId;
  const isDirectChild = getParentAgentIdFromLabels(target.labels) === input.callerAgentId;
  if (callerRole === "lead") {
    if (
      hasLeadDelegationAuthority(input.caller) &&
      target.roleBinding?.roleId === "peer" &&
      isDirectChild
    ) {
      return;
    }
    if (!hasLeadDelegationAuthority(input.caller)) {
      throw new Error(
        "A role-bound Lead needs Work & coordinate or Coordinate only authority to prompt a Peer",
      );
    }
    throw new Error("A role-bound Lead may prompt only its own direct Peer child");
  }
  if (callerRole === "supervisor") {
    if (
      hasSupervisorDelegationLease(input.caller) &&
      target.roleBinding?.roleId === "lead" &&
      isDirectChild
    ) {
      return;
    }
    throw new Error(
      "A role-bound Supervisor may prompt only its own direct Lead child under a Human-issued delegation assignment",
    );
  }
  throw new Error(`Role-bound ${callerRole} agents cannot use send_agent_prompt`);
}

async function assertAgentScopedRoleTopologyAuthorized(params: {
  agentStorage: AgentStorage;
  callerAgentId: string | undefined;
  action: AgentScopedRoleTopologyAction;
}): Promise<void> {
  if (!params.callerAgentId) {
    return;
  }

  const caller = await params.agentStorage.get(params.callerAgentId);
  if (!caller) {
    throw new Error(`Caller agent ${params.callerAgentId} is unavailable in durable storage`);
  }
  const callerRole = caller.roleBinding?.roleId;
  if (!callerRole) {
    return;
  }
  if (params.action.kind === "create_agent") {
    assertRoleBoundCreateAuthorized(caller, params.action.requestedRole);
    return;
  }
  await assertRoleBoundPromptAuthorized({
    agentStorage: params.agentStorage,
    caller,
    callerAgentId: params.callerAgentId,
    targetAgentId: params.action.targetAgentId,
  });
}

function policyOwnersMatch(left: PolicyOwner, right: PolicyOwner): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "legacy-core" || right.kind === "legacy-core") return true;
  return (
    left.pluginId === right.pluginId &&
    left.generationDigest === right.generationDigest &&
    left.policyVersion === right.policyVersion
  );
}

function isSlpPolicyBinding(binding: PersistedRoleBinding): boolean {
  const owner = policyOwnerForRoleBinding(binding);
  return owner.kind === "legacy-core" || owner.pluginId === "slp";
}

function resolveBinding(
  record: StoredAgentRecord | null,
  live: Pick<ManagedAgent, "roleBinding"> | null,
): PersistedRoleBinding | undefined {
  return record?.roleBinding ?? live?.roleBinding;
}

function hasCurrentBeadsStatusCheckpoint(record: StoredAgentRecord): boolean {
  const assignmentDigest = record.roleBinding?.assignmentContract?.receipt.assignmentDigest;
  return Boolean(
    assignmentDigest && record.beadsStatusCheckpoint?.assignmentDigest === assignmentDigest,
  );
}

function resolveCheckpointRelationship(input: {
  callerAgentId: string;
  caller: StoredAgentRecord;
  targetAgentId: string;
  target: StoredAgentRecord | null;
  targetLive: ManagedAgent | null;
}): CheckpointCallerRelationship {
  if (input.callerAgentId === input.targetAgentId) return "self";
  if (!input.target) return "unrelated";

  const targetBinding = resolveBinding(input.target, input.targetLive);
  const parentAgentId = getParentAgentIdFromLabels(input.target.labels);
  if (
    input.caller.roleBinding?.roleId === "lead" &&
    hasLeadDelegationAuthority(input.caller) &&
    targetBinding?.roleId === "peer" &&
    parentAgentId === input.callerAgentId
  ) {
    return "owns-target";
  }
  if (
    input.caller.roleBinding?.roleId === "supervisor" &&
    hasSupervisorDelegationLease(input.caller) &&
    targetBinding?.roleId === "lead" &&
    parentAgentId === input.callerAgentId
  ) {
    return "supervises-target";
  }
  return "unrelated";
}

/**
 * Translate the persisted role profile into the checkpoint policy's semantic
 * action ceiling. The mapping is deliberately narrower than the raw tool
 * list: each action is emitted only when the exact selected tool and current
 * assignment effect class can carry that operation.
 */
function resolveCheckpointAllowedActions(binding: PersistedRoleBinding): string[] | null {
  const selectedTools = binding.roleProfile?.allowedTools;
  if (!selectedTools) return null;
  const tools = new Set(selectedTools);
  const actions: string[] = [];
  if (binding.roleId === "lead" && tools.has("send_agent_prompt")) {
    actions.push("request_status_update");
  }
  if (
    binding.roleId === "peer" &&
    binding.assignment?.mutationBoundary.mode !== "no-write" &&
    (tools.has("beads_create") || tools.has("beads_update") || tools.has("post_room"))
  ) {
    actions.push("continue_bounded_work");
  }
  if (binding.roleId === "peer" && tools.has("post_room")) {
    actions.push("handback_with_evidence");
  }
  if (
    binding.roleId === "supervisor" &&
    (tools.has("ask_attention_question") || tools.has("signal_agent"))
  ) {
    actions.push("flag_to_human");
  }
  return actions;
}

function toCheckpointActor(
  agentId: string,
  record: StoredAgentRecord | null,
  live: Pick<ManagedAgent, "roleBinding"> | null,
): CheckpointRoleActor {
  const binding = resolveBinding(record, live);
  return {
    agentId,
    roleId: binding?.roleId ?? null,
    assignment: binding?.assignment ?? null,
  };
}

function toCheckpointCouncilSnapshot(council: CouncilCaseRecord): CheckpointCouncilSnapshot {
  return {
    caseId: council.id,
    phase: council.phase,
    parentAgentId: council.parentAgentId,
    seats: council.seats.map((seat) => ({
      role: seat.role,
      agentId: seat.agentId,
      phase: seat.phase,
      integrity: seat.integrity,
      hasReportReceipt: seat.reportReceipt !== null,
      reportReceiptPointer: seat.reportReceipt?.reportMessageId ?? null,
      disposition: seat.disposition,
    })),
  };
}

async function readCheckpointCouncil(input: {
  store: Pick<CouncilCaseStore, "list"> | null | undefined;
  callerAgentId: string;
  targetAgentId: string;
  relationship: CheckpointCallerRelationship;
  targetWorkspaceId: string | undefined;
}): Promise<CheckpointCouncilSnapshot | null> {
  if (!input.store) return null;
  try {
    const candidates = (await input.store.list()).filter((council) => {
      const targetIsCaseOwner = council.parentAgentId === input.targetAgentId;
      const targetIsSeat = council.seats.some((seat) => seat.agentId === input.targetAgentId);
      if (!targetIsCaseOwner && !targetIsSeat) return false;
      if (
        (input.relationship === "owns-target" || input.relationship === "supervises-target") &&
        council.parentAgentId !== input.callerAgentId
      ) {
        return false;
      }
      if (
        input.targetWorkspaceId !== undefined &&
        council.workspaceId !== null &&
        council.workspaceId !== input.targetWorkspaceId
      ) {
        return false;
      }
      return true;
    });
    return candidates.length === 1 ? toCheckpointCouncilSnapshot(candidates[0]!) : null;
  } catch {
    return null;
  }
}

async function readCheckpointBeads(input: {
  options: PaseoToolHostDependencies;
  callerAgentId: string;
  targetAgentId: string;
  target: StoredAgentRecord;
  targetBinding: PersistedRoleBinding | undefined;
  signal?: AbortSignal;
}) {
  const issueIds = input.targetBinding?.assignmentContract?.envelope.resourceGrants?.beadsIssueIds;
  if (!issueIds || issueIds.length === 0) return { accessible: true as const, issue: null };
  if (issueIds.length !== 1) {
    return {
      accessible: false as const,
      reason: "exact Beads issue-to-target binding is unavailable",
    };
  }
  const workspaceId = input.target.workspaceId;
  if (!workspaceId || !input.options.workspaceRegistry || !input.options.beadsService) {
    return { accessible: false as const, reason: "Beads checkpoint is unavailable" };
  }
  const workspace = await input.options.workspaceRegistry.get(workspaceId).catch(() => null);
  if (!workspace || workspace.archivedAt) {
    return { accessible: false as const, reason: "Beads checkpoint is unavailable" };
  }
  if (input.options.projectRegistry) {
    const project = await input.options.projectRegistry.get(workspace.projectId).catch(() => null);
    if (!project || project.archivedAt) {
      return { accessible: false as const, reason: "Beads checkpoint is unavailable" };
    }
  }
  const snapshot = await readBeadsCheckpoint({
    service: input.options.beadsService,
    project: {
      projectId: workspace.projectId,
      actor: beadsActorForAgent(input.callerAgentId),
    },
    targetAgentId: input.targetAgentId,
    binding: { issueId: issueIds[0]!, targetAgentId: input.targetAgentId },
    // BeadsService.get exposes issue metadata, not a complete dependency read.
    // Keep dependency disposition UNKNOWN instead of promoting dependency_count.
    dependencies: { complete: false, openDependencyCount: null },
    signal: input.signal,
  });
  return snapshot.accessible
    ? snapshot
    : { accessible: false as const, reason: "Beads checkpoint is unavailable" };
}

function checkpointReadAuthorizationReason(input: {
  target: StoredAgentRecord | null;
  relationship: CheckpointCallerRelationship;
  ownerMatches: boolean;
}): string {
  if (!input.target) return "target lifecycle record is unavailable";
  if (input.relationship === "unrelated") {
    return "caller has no authorized relationship to target";
  }
  if (!input.ownerMatches) return "caller and target policy generations do not match";
  return "relationship and pinned policy owner are authorized";
}

function resolveCheckpointOwnerMatch(
  callerBinding: PersistedRoleBinding,
  targetBinding: PersistedRoleBinding | undefined,
): boolean {
  if (!targetBinding) return true;
  try {
    return policyOwnersMatch(
      policyOwnerForRoleBinding(callerBinding),
      policyOwnerForRoleBinding(targetBinding),
    );
  } catch {
    return false;
  }
}

function resolveCheckpointPendingPermission(targetLive: ManagedAgent | null) {
  if (!targetLive) return null;
  const request = Array.from(targetLive.pendingPermissions.values())[0];
  return request ? { key: request.id, requestedAt: null } : null;
}

function requireCheckpointCaller(input: {
  caller: StoredAgentRecord | null;
  callerBinding: PersistedRoleBinding | undefined;
}): { caller: StoredAgentRecord; callerBinding: PersistedRoleBinding } {
  if (!input.caller) throw new Error("checkpoint_policy_generation_unavailable");
  if (!input.callerBinding || !isSlpPolicyBinding(input.callerBinding)) {
    throw new Error("checkpoint_policy_generation_unavailable");
  }
  return { caller: input.caller, callerBinding: input.callerBinding };
}

async function resolveCheckpointTarget(input: {
  options: PaseoToolHostDependencies;
  callerAgentId: string;
  targetAgentId: string;
  caller: StoredAgentRecord;
  targetLive: ManagedAgent | null;
}): Promise<StoredAgentRecord | null> {
  const target =
    input.targetAgentId === input.callerAgentId
      ? input.caller
      : await input.options.agentStorage.get(input.targetAgentId);
  if (target?.internal || input.targetLive?.internal) {
    throw new Error("checkpoint_target_unavailable");
  }
  return target;
}

function isCheckpointReadAuthorized(
  target: StoredAgentRecord | null,
  relationship: CheckpointCallerRelationship,
  ownerMatches: boolean,
): boolean {
  return Boolean(target) && relationship !== "unrelated" && ownerMatches;
}

async function resolveCheckpointBeads(input: {
  options: PaseoToolHostDependencies;
  callerAgentId: string;
  targetAgentId: string;
  caller: StoredAgentRecord;
  target: StoredAgentRecord;
  targetBinding: PersistedRoleBinding | undefined;
  readAuthorized: boolean;
  signal?: AbortSignal;
}) {
  if (!input.readAuthorized) return { accessible: true as const, issue: null };
  const issueIds = input.targetBinding?.assignmentContract?.envelope.resourceGrants?.beadsIssueIds;
  if (!issueIds || issueIds.length === 0) return { accessible: true as const, issue: null };
  if (!hasCurrentBeadsStatusCheckpoint(input.caller)) {
    return { accessible: false as const, reason: "Beads checkpoint is unavailable" };
  }
  return readCheckpointBeads({
    options: input.options,
    callerAgentId: input.callerAgentId,
    targetAgentId: input.targetAgentId,
    target: input.target,
    targetBinding: input.targetBinding,
    signal: input.signal,
  });
}

async function buildProductionAgentCheckpoint(input: {
  options: PaseoToolHostDependencies;
  callerAgentId: string;
  targetAgentId: string;
  signal?: AbortSignal;
}): Promise<ReturnType<typeof buildAgentCheckpoint>> {
  const caller = await input.options.agentStorage.get(input.callerAgentId);
  const callerLive = input.options.agentManager.getAgent(input.callerAgentId);
  const { caller: resolvedCaller, callerBinding } = requireCheckpointCaller({
    caller,
    callerBinding: resolveBinding(caller, callerLive),
  });

  const targetLive = input.options.agentManager.getAgent(input.targetAgentId);
  const target = await resolveCheckpointTarget({
    options: input.options,
    callerAgentId: input.callerAgentId,
    targetAgentId: input.targetAgentId,
    caller: resolvedCaller,
    targetLive,
  });

  const targetBinding = resolveBinding(target, targetLive);
  const relationship = resolveCheckpointRelationship({
    callerAgentId: input.callerAgentId,
    caller: resolvedCaller,
    targetAgentId: input.targetAgentId,
    target,
    targetLive,
  });
  const ownerMatches = resolveCheckpointOwnerMatch(callerBinding, targetBinding);
  const readAuthorized = isCheckpointReadAuthorized(target, relationship, ownerMatches);
  const actor = toCheckpointActor(input.targetAgentId, target, targetLive);
  const callerActor = toCheckpointActor(input.callerAgentId, resolvedCaller, callerLive);
  const targetWorkspaceId = target?.workspaceId ?? targetLive?.workspaceId;
  const council = readAuthorized
    ? await readCheckpointCouncil({
        store: input.options.councilCaseStore,
        callerAgentId: input.callerAgentId,
        targetAgentId: input.targetAgentId,
        relationship,
        targetWorkspaceId,
      })
    : null;
  const beads = target
    ? await resolveCheckpointBeads({
        options: input.options,
        callerAgentId: input.callerAgentId,
        targetAgentId: input.targetAgentId,
        caller: resolvedCaller,
        target,
        targetBinding,
        readAuthorized,
        signal: input.signal,
      })
    : { accessible: true as const, issue: null };
  const sources: AgentCheckpointSources = {
    now: new Date(),
    caller: callerActor,
    target: actor,
    readAuthorization: {
      authorized: readAuthorized,
      reason: checkpointReadAuthorizationReason({ target, relationship, ownerMatches }),
    },
    callerContext: {
      relationshipToTarget: relationship,
      allowedActions: resolveCheckpointAllowedActions(callerBinding),
    },
    targetLifecycle: targetLive?.lifecycle ?? target?.lastStatus ?? null,
    pendingPermission: resolveCheckpointPendingPermission(targetLive),
    coordinationSignals: target?.coordinationSignals ?? [],
    council,
    beads,
  };
  let checkpointPolicy: CheckpointPolicy;
  try {
    checkpointPolicy =
      input.options.agentManager.resolveSlpPolicyForRoleBinding(callerBinding).checkpointPolicy;
  } catch {
    // A checkpoint is useful only when the caller's pinned SLP generation is
    // available. Do not expose resolver details (or accidentally let a
    // non-SLP contribution masquerade as SLP) through this read-only tool.
    throw new Error("checkpoint_policy_generation_unavailable");
  }
  return buildAgentCheckpoint(sources, checkpointPolicy);
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveAgentListActivityTime(agent: AgentListItemPayload): number {
  return Math.max(
    parseTimestamp(agent.updatedAt),
    parseTimestamp(agent.lastUserMessageAt),
    parseTimestamp(agent.attentionTimestamp),
    parseTimestamp(agent.archivedAt),
    parseTimestamp(agent.createdAt),
  );
}

interface ProviderSummary {
  id: AgentProvider;
  label: string;
  description: string;
  enabled: boolean;
  modes: AgentMode[];
  status: string;
  error?: string;
}

const WorkspaceAutomationSummarySchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  isolation: z.enum(["local", "worktree"]),
  kind: z.enum(["directory", "local_checkout", "worktree"]),
  title: z.string().nullable(),
});

function toWorkspaceAutomationSummary(workspace: PersistedWorkspaceRecord) {
  return {
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    isolation: workspace.kind === "worktree" ? ("worktree" as const) : ("local" as const),
    kind: workspace.kind,
    title: workspace.title,
  };
}

type WorkspaceWorktreeMode = "branch-off" | "checkout-branch" | "checkout-pr";

interface WorkspaceWorktreeOptions {
  mode?: WorkspaceWorktreeMode;
  worktreeSlug?: string;
  branchName?: string;
  baseBranch?: string;
  branch?: string;
  prNumber?: number;
  forge?: string;
}

type WorkspaceWorktreeTarget = Pick<
  CreatePaseoWorktreeCommandInput,
  "action" | "branchName" | "refName" | "checkoutSource"
>;

function assertOptionsAbsent(
  options: Array<[name: string, value: unknown]>,
  message: string,
): void {
  if (options.some(([, value]) => value !== undefined)) {
    throw new Error(message);
  }
}

function resolveWorkspaceWorktreeTarget(input: WorkspaceWorktreeOptions): WorkspaceWorktreeTarget {
  switch (input.mode ?? "branch-off") {
    case "branch-off":
      assertOptionsAbsent(
        [
          ["branch", input.branch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branch, prNumber, and forge require a checkout mode",
      );
      return {
        action: "branch-off",
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.baseBranch ? { refName: input.baseBranch } : {}),
      };
    case "checkout-branch":
      if (!input.branch) {
        throw new Error("branch is required for checkout-branch mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branchName, baseBranch, prNumber, and forge are not valid for checkout-branch mode",
      );
      return { action: "checkout", refName: input.branch };
    case "checkout-pr":
      if (input.prNumber === undefined) {
        throw new Error("prNumber is required for checkout-pr mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["branch", input.branch],
        ],
        "branchName, baseBranch, and branch are not valid for checkout-pr mode",
      );
      return {
        action: "checkout",
        checkoutSource: {
          kind: "change_request",
          ...(input.forge ? { forge: input.forge } : {}),
          number: input.prNumber,
        },
      };
  }
}

function toProviderSummary(entry: {
  provider: AgentProvider;
  label?: string;
  description?: string;
  enabled: boolean;
  modes?: AgentMode[];
  status: string;
  error?: string;
}): ProviderSummary {
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? "",
    enabled: entry.enabled,
    modes: entry.modes ?? [],
    status: entry.status === "ready" ? "available" : entry.status,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function compareAgentListItems(a: AgentListItemPayload, b: AgentListItemPayload): number {
  const attentionDelta =
    Number(b.requiresAttention ?? false) - Number(a.requiresAttention ?? false);
  if (attentionDelta !== 0) {
    return attentionDelta;
  }

  const statusOrder = {
    running: 0,
    initializing: 1,
    idle: 2,
    error: 3,
    closed: 4,
  } as Record<string, number>;
  const statusDelta = (statusOrder[a.status] ?? 999) - (statusOrder[b.status] ?? 999);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  return resolveAgentListActivityTime(b) - resolveAgentListActivityTime(a);
}

function resolveScheduleProviderAndModel(params: {
  provider?: string;
  defaultProvider: AgentProvider;
}): { provider: AgentProvider; model?: string } {
  const providerInput = params.provider?.trim() || params.defaultProvider;
  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return { provider: providerInput };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const model = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }

  return {
    provider: provider,
    model,
  };
}

function resolveScheduleUpdateProviderAndModel(params: {
  provider?: string;
  model?: string | null;
}): { provider?: string; model?: string | null } {
  const providerInput = params.provider?.trim();
  const modelInput = typeof params.model === "string" ? params.model.trim() : params.model;

  if (params.model !== undefined && modelInput === "") {
    throw new Error("model cannot be empty");
  }

  if (!providerInput) {
    return params.model !== undefined ? { model: modelInput } : {};
  }

  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return {
      provider: providerInput,
      ...(params.model !== undefined ? { model: modelInput } : {}),
    };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const modelFromProvider = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !modelFromProvider) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }
  if (params.model === null) {
    throw new Error("provider specifies a model but model is null");
  }
  if (typeof modelInput === "string" && modelInput !== modelFromProvider) {
    throw new Error("Conflicting model values provided");
  }

  return {
    provider,
    model: modelInput ?? modelFromProvider,
  };
}

interface ScheduleUpdateToolInput {
  id: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string | null;
  prompt?: string;
  maxRuns?: number | null;
  provider?: string;
  model?: string | null;
  mode?: string | null;
  cwd?: string;
  expiresIn?: string;
  clearExpires?: boolean;
}

function normalizeScheduleCadenceArg(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function normalizeScheduleTimeZoneArg(value: string | undefined): string | undefined {
  return normalizeScheduleCadenceArg(value);
}

function resolveScheduleUpdateCadence(input: ScheduleUpdateToolInput): ScheduleCadence | undefined {
  const every = normalizeScheduleCadenceArg(input.every);
  const cron = normalizeScheduleCadenceArg(input.cron);
  const timeZone = normalizeScheduleTimeZoneArg(input.timezone);

  if (every !== undefined && cron !== undefined) {
    throw new Error("Specify at most one of every or cron");
  }
  if (timeZone !== undefined && cron === undefined) {
    throw new Error("timezone can only be used with cron");
  }
  if (every !== undefined) {
    // COMPAT(scheduleEveryInput): accept the old hidden field and canonicalize it before write.
    // Added in v0.2.0; remove after 2027-01-17.
    const everyMs = parseDurationString(every);
    const expression = everyMsToFiveFieldCron(everyMs);
    if (expression) {
      return { type: "cron", expression };
    }
    throw new Error(`${every} cannot be represented faithfully by five-field cron`);
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron,
      ...(timeZone !== undefined ? { timezone: timeZone } : {}),
    };
  }
  return undefined;
}

function resolveScheduleUpdateExpiresAt(input: ScheduleUpdateToolInput): string | null | undefined {
  if (input.expiresIn !== undefined && input.clearExpires) {
    throw new Error("Specify at most one of expiresIn or clearExpires");
  }
  if (input.expiresIn !== undefined) {
    return new Date(Date.now() + parseDurationString(input.expiresIn)).toISOString();
  }
  if (input.clearExpires) {
    return null;
  }
  return undefined;
}

function buildScheduleUpdateInput(input: ScheduleUpdateToolInput): UpdateScheduleInput {
  const cadence = resolveScheduleUpdateCadence(input);
  const expiresAt = resolveScheduleUpdateExpiresAt(input);
  const providerModelPatch = resolveScheduleUpdateProviderAndModel({
    provider: input.provider,
    model: input.model,
  });
  const newAgentConfig = {
    ...(providerModelPatch.provider !== undefined ? { provider: providerModelPatch.provider } : {}),
    ...(providerModelPatch.model !== undefined ? { model: providerModelPatch.model } : {}),
    ...(input.mode !== undefined ? { modeId: input.mode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };

  return {
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(Object.keys(newAgentConfig).length > 0 ? { newAgentConfig } : {}),
  };
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

const TerminalSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});

function resolveTerminalKeyToken(key: string, literal: boolean): string {
  if (literal) {
    return key;
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}

export function createPaseoToolCatalog(options: PaseoToolHostDependencies): PaseoToolCatalog {
  const {
    agentManager,
    agentStorage,
    terminalManager,
    workspaceScripts,
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    callerAgentId,
    resolveSpeakHandler,
    resolveCallerContext,
    logger,
  } = options;
  const childLogger = logger.child({
    module: "agent",
    component: "paseo-tool-catalog",
  });
  const callerContext = callerAgentId ? (resolveCallerContext?.(callerAgentId) ?? null) : null;
  const callerRoleBinding = resolveOptionalCatalogRoleBinding(agentManager, callerAgentId);
  const callerRoleId = callerRoleBinding?.roleId;
  const resolveSlpPolicy = () =>
    callerRoleBinding
      ? agentManager.resolveSlpPolicyForRoleBinding(callerRoleBinding)
      : agentManager.resolveActiveSlpPolicy();
  const coordinationDescriptions = resolveCatalogCoordinationDescriptions({
    agentManager,
    callerRoleBinding,
    resolveSlpPolicy,
  });
  const canCreateExecutionProfile = callerRoleId === "lead";

  const parseToolInput = async (tool: PaseoToolDefinition, input: unknown): Promise<unknown> => {
    const inputSchema = tool.inputSchema;
    if (!inputSchema) {
      return input;
    }
    const schema =
      typeof inputSchema === "object" &&
      inputSchema !== null &&
      typeof (inputSchema as { safeParseAsync?: unknown }).safeParseAsync === "function"
        ? (inputSchema as z.ZodType)
        : z.object(inputSchema as z.ZodRawShape).passthrough();
    return schema.parseAsync(input);
  };

  const tools = new Map<string, PaseoToolDefinition>();
  const registerTool = (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => {
    if (!isPaseoToolEnabled(options.paseoToolPolicy, name)) {
      return;
    }
    tools.set(name, {
      name,
      title: config.title,
      description: config.description ?? name,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      handler: handler as PaseoToolDefinition["handler"],
    });
  };
  const toCatalog = (): PaseoToolCatalog => ({
    tools,
    getTool(name: string): PaseoToolDefinition | undefined {
      return tools.get(name);
    },
    async executeTool(
      name: string,
      input: unknown,
      context: PaseoToolExecutionContext = {},
    ): Promise<PaseoToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Paseo tool not found: ${name}`);
      }
      return tool.handler(await parseToolInput(tool, input), context);
    },
  });

  const buildCronScheduleCadence = (input: {
    cron: string | undefined;
    timezone?: string;
  }): ScheduleCadence => {
    const expression = input.cron?.trim() ?? "";
    if (!expression) {
      throw new Error("cron is required");
    }
    const timezone = normalizeScheduleTimeZoneArg(input.timezone);
    return {
      type: "cron",
      expression,
      ...(timezone !== undefined ? { timezone } : {}),
    };
  };

  const buildScheduleExpiry = (expiresIn: string | undefined): string | undefined => {
    return expiresIn === undefined
      ? undefined
      : new Date(Date.now() + parseDurationString(expiresIn)).toISOString();
  };

  const resolveCallerAgent = () => {
    if (!callerAgentId) {
      return null;
    }
    const parentAgent = agentManager.getAgent(callerAgentId);
    if (!parentAgent) {
      throw new Error(`Parent agent ${callerAgentId} not found`);
    }
    return parentAgent;
  };
  const resolveInheritedProviderConfig = (
    selectedProvider: string,
  ): Pick<AgentSessionConfig, "providerOptions"> | undefined => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent?.provider !== selectedProvider || !callerAgent.config?.providerOptions) {
      return undefined;
    }
    return { providerOptions: callerAgent.config.providerOptions };
  };

  const resolvePeerDelegationAllowedRoutes = () => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent?.roleBinding?.roleId !== "lead") return undefined;
    if (!daemonConfigStore) return undefined;
    const config = daemonConfigStore.get();
    const policy = config.peerDelegation;
    if (!policy?.enabled) return [];
    if (config.peerDelegationProfileIds !== undefined) {
      const selected = new Set(config.peerDelegationProfileIds);
      const seen = new Set<string>();
      return (config.agentProfiles ?? []).flatMap((profile) => {
        if (!selected.has(profile.id) || !profile.model?.trim()) return [];
        try {
          const route = resolveRequiredProviderModel(`${profile.provider}/${profile.model}`);
          if (!route.model) return [];
          if (!isPaseoSupportedProvider(route.provider, config.providers?.[route.provider])) {
            return [];
          }
          const key = formatProviderModel(route.provider, route.model);
          if (seen.has(key)) return [];
          seen.add(key);
          return [{ provider: route.provider, model: route.model }];
        } catch {
          return [];
        }
      });
    }
    return policy.allowedModels.filter((route) =>
      isPaseoSupportedProvider(route.provider, config.providers?.[route.provider]),
    );
  };

  const resolvePeerLaunchProfile = (input: {
    requestedRole?: PaseoRoleId;
    requestedProfileId?: string;
    requestedSubrole?: PeerSubrole;
    requestedProvider?: string;
    hasRequestedSettings: boolean;
  }): LaunchableAgentProfile | undefined => {
    const callerAgent = resolveCallerAgent();
    const isLeadToPeer =
      callerAgent?.roleBinding?.roleId === "lead" && input.requestedRole === "peer";
    if (!isLeadToPeer) {
      if (input.requestedProfileId !== undefined) {
        throw new Error("launchProfileId is only valid for role-bound Lead-to-Peer creation");
      }
      return undefined;
    }
    if (!daemonConfigStore) return undefined;
    const config = daemonConfigStore.get();
    const profileIds = config.peerDelegationProfileIds;
    if (profileIds === undefined) {
      if (input.requestedProfileId !== undefined) {
        throw new Error(
          "Peer Agent Profile routing is not configured on this host; ask the Human to select allowed profiles in Agents settings",
        );
      }
      return undefined;
    }
    if (!config.peerDelegation?.enabled) {
      throw new Error("Lead-to-Peer creation is disabled by the Human-configured policy");
    }
    const profile = selectPeerLaunchProfile({
      profileIds,
      profiles: config.agentProfiles ?? [],
      requestedProfileId: input.requestedProfileId,
      requestedSubrole: input.requestedSubrole,
      defaultSubrole: config.peerDelegationDefaultSubrole ?? undefined,
      providerPriority: config.peerDelegationProviderPriority,
    });

    if (!profile.model?.trim()) {
      throw new Error(
        `Peer Agent Profile '${profile.name}' (${profile.id}) has no model and cannot launch a role-bound Peer`,
      );
    }
    if (input.requestedProvider?.trim() || input.hasRequestedSettings) {
      throw new Error(
        "When Peer Agent Profile routing is configured, omit provider and settings; launchProfileId supplies the exact runtime preset",
      );
    }
    return { ...profile, model: profile.model.trim() };
  };

  const resolvePeerDelegationRunMode = (): PeerDelegationRunMode | undefined => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent?.roleBinding?.roleId !== "lead" || !daemonConfigStore) return undefined;
    const policy = daemonConfigStore.get().peerDelegation;
    return policy?.enabled ? policy.runMode : undefined;
  };

  const assertRequestedProviderModelAvailable = async (input: {
    provider: AgentProvider;
    model: string | undefined;
    requestedRole?: PaseoRoleId;
  }): Promise<void> => {
    if (!callerAgentId || !input.requestedRole) return;
    const models = await providerSnapshotManager.listModels({
      provider: input.provider,
      wait: true,
    });
    if (models.length === 0 || models.some((model) => model.id === input.model)) return;
    throw new Error(
      `Model '${input.model}' is not available for provider '${input.provider}'; call list_models and retry with an exact returned route, or omit provider to inherit the caller route`,
    );
  };

  const resolvePeerModeEnforcement = async (input: {
    provider: AgentProvider;
    requestedRole?: PaseoRoleId;
    requestedMode?: string;
    requestedCwd?: string;
    assignmentNoWrite?: boolean;
    launchProfile?: LaunchableAgentProfile;
  }): Promise<{ enforcedMode?: string; unattended?: boolean }> => {
    const runMode = input.requestedRole === "peer" ? resolvePeerDelegationRunMode() : undefined;
    if (!runMode && !input.assignmentNoWrite) return {};
    const providerEntry = await providerSnapshotManager.getProvider({
      provider: input.provider,
      cwd: input.requestedCwd,
      wait: true,
    });
    if (input.assignmentNoWrite) {
      const fallbackInjectionMethods: Partial<Record<AgentProvider, RoleBindingInjectionMethod>> = {
        codex: "codex-developer-instructions",
        claude: "claude-system-prompt",
        cursor: "cursor-project-rule-capsule",
        "gemini-antigravity": "antigravity-custom-agent",
      };
      const injectionMethod =
        providerEntry.roleBinding?.status === "supported"
          ? providerEntry.roleBinding.injectionMethod
          : fallbackInjectionMethods[input.provider];
      const enforcedMode = injectionMethod ? noWriteModeForInjectionMethod(injectionMethod) : null;
      if (!enforcedMode) {
        throw new Error(
          `assignment_capability_boundary_required: provider '${input.provider}' has no qualified no-write mode`,
        );
      }
      if (!(providerEntry.modes ?? []).some((mode) => mode.id === enforcedMode)) {
        throw new Error(
          `assignment_capability_boundary_required: provider '${input.provider}' does not expose required no-write mode '${enforcedMode}'`,
        );
      }
      return { enforcedMode, unattended: false };
    }
    if (!runMode) return {};
    const enforcedMode = resolvePeerPolicyMode({
      provider: input.provider,
      modes: providerEntry.modes ?? [],
      defaultModeId: providerEntry.defaultModeId,
      runMode,
    });
    if (input.requestedMode !== undefined && input.requestedMode !== enforcedMode) {
      if (input.launchProfile) {
        throw new Error(
          `Peer Agent Profile '${input.launchProfile.name}' (${input.launchProfile.id}) uses mode '${input.requestedMode}', which conflicts with the Human-configured '${runMode}' policy requiring '${enforcedMode}'. Update the stored profile or choose a compatible profile; caller settings cannot override launchProfileId`,
        );
      }
      throw new Error(
        `Peer mode '${input.requestedMode}' conflicts with the Human-configured '${runMode}' policy; use '${enforcedMode}' or omit settings.modeId`,
      );
    }
    return { enforcedMode, unattended: runMode === "unattended" };
  };

  const resolveCreateAgentProviderRoute = async (input: {
    requestedProvider?: string;
    requestedRole?: PaseoRoleId;
    requestedMode?: string;
    requestedCwd?: string;
    assignmentNoWrite?: boolean;
    launchProfile?: LaunchableAgentProfile;
  }): Promise<{
    providerRoute: string;
    provider: AgentProvider;
    enforcedMode?: string;
    unattended?: boolean;
  }> => {
    const requestedProvider = input.requestedProvider?.trim();
    const callerAgent = resolveCallerAgent();
    const inheritedModel = callerAgent?.config?.model ?? callerAgent?.runtimeInfo?.model;
    const allowedPeerRoutes =
      input.requestedRole === "peer" ? resolvePeerDelegationAllowedRoutes() : undefined;
    let providerRoute = resolvePeerPolicyProviderRoute(requestedProvider ?? "", allowedPeerRoutes);
    if (!providerRoute && callerAgent && inheritedModel) {
      providerRoute = formatProviderModel(callerAgent.provider, inheritedModel);
    }
    if (!providerRoute) {
      throw new Error(
        callerAgent
          ? "create_agent could not inherit a model from the caller; call list_models and provide an exact provider/model route"
          : "provider is required",
      );
    }

    const resolved = resolveRequiredProviderModel(providerRoute);
    assertPeerPolicyAllowsRoute(
      providerRoute,
      resolved.provider,
      resolved.model,
      allowedPeerRoutes,
    );
    await assertRequestedProviderModelAvailable({
      provider: resolved.provider,
      model: resolved.model,
      requestedRole: input.requestedRole,
    });
    const modeEnforcement = await resolvePeerModeEnforcement({
      provider: resolved.provider,
      requestedRole: input.requestedRole,
      requestedMode: input.requestedMode,
      requestedCwd: input.requestedCwd,
      assignmentNoWrite: input.assignmentNoWrite,
      launchProfile: input.launchProfile,
    });
    return {
      providerRoute,
      provider: resolved.provider,
      ...modeEnforcement,
    };
  };

  const resolveScopedCwd = (requestedCwd?: string, opts?: { required?: boolean }): string => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return resolveChildAgentCwd({
        parentCwd: callerAgent.cwd,
        requestedCwd,
        lockedCwd: callerContext?.lockedCwd,
        allowCustomCwd: callerContext?.allowCustomCwd ?? true,
      });
    }

    const trimmedCwd = requestedCwd?.trim();
    if (!trimmedCwd) {
      if (opts?.required) {
        throw new Error("cwd is required");
      }
      throw new Error("cwd is required outside an agent-scoped session");
    }

    return expandUserPath(trimmedCwd);
  };

  async function resolveTerminalWorkspaceId(resolvedCwd: string): Promise<string> {
    // An agent-spawned terminal belongs to the caller agent's workspace. Only if
    // the caller has no workspace do we mint one for the cwd.
    const callerAgent = callerAgentId ? agentManager.getAgent(callerAgentId) : null;
    if (callerAgent?.workspaceId) {
      return callerAgent.workspaceId;
    }

    if (!options.ensureWorkspaceForCreate) {
      throw new Error(
        callerAgentId
          ? `Caller agent ${callerAgentId} has no workspace and workspace minting is not configured`
          : "workspaceId is required outside an agent-scoped session",
      );
    }

    return options.ensureWorkspaceForCreate(resolvedCwd);
  }

  function resolveWorkspaceIdForRename(requestedWorkspaceId?: string): string {
    const explicitWorkspaceId = requestedWorkspaceId?.trim();
    if (explicitWorkspaceId) {
      return explicitWorkspaceId;
    }

    if (callerAgentId) {
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
      }
      return callerAgent.workspaceId;
    }
    throw new Error("workspaceId is required outside an agent-scoped session");
  }

  const buildCallerAgentScheduleConfigExtras = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    resolvedProvider: string,
  ): Record<string, unknown> => {
    return {
      ...(callerAgent.config.thinkingOptionId
        ? { thinkingOptionId: callerAgent.config.thinkingOptionId }
        : {}),
      ...(callerAgent.provider === resolvedProvider && callerAgent.config.providerOptions
        ? { providerOptions: callerAgent.config.providerOptions }
        : {}),
      ...(callerAgent.config.featureValues
        ? { featureValues: callerAgent.config.featureValues }
        : {}),
      ...(callerAgent.config.systemPrompt ? { systemPrompt: callerAgent.config.systemPrompt } : {}),
      ...(callerAgent.config.mcpServers ? { mcpServers: callerAgent.config.mcpServers } : {}),
    };
  };

  const buildCallerAgentScheduleConfig = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    params?: { provider?: string; cwd?: string },
  ) => {
    const hasProviderOverride = params?.provider !== undefined;
    const resolvedProviderModel = hasProviderOverride
      ? resolveScheduleProviderAndModel({
          provider: params?.provider,
          defaultProvider: callerAgent.provider,
        })
      : null;
    const resolvedProvider = resolvedProviderModel?.provider ?? callerAgent.provider;
    let resolvedModel: string | undefined;
    if (resolvedProviderModel?.model) {
      resolvedModel = resolvedProviderModel.model;
    } else if (!hasProviderOverride && callerAgent.config.model) {
      resolvedModel = callerAgent.config.model;
    }
    return {
      provider: resolvedProvider,
      cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : callerAgent.cwd,
      ...(callerAgent.currentModeId && callerAgent.provider === resolvedProvider
        ? {
            modeId: callerAgent.currentModeId,
          }
        : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...buildCallerAgentScheduleConfigExtras(callerAgent, resolvedProvider),
    };
  };

  const resolveNewAgentScheduleTarget = (params?: {
    provider?: string;
    cwd?: string;
    isolation?: "local" | "worktree";
  }) => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return {
        type: "new-agent" as const,
        config: {
          ...buildCallerAgentScheduleConfig(callerAgent, params),
          ...(params?.isolation ? { isolation: params.isolation } : {}),
        },
      };
    }

    if (!params?.provider?.trim()) {
      throw new Error("provider is required when target is new-agent");
    }

    const resolvedProviderModel = resolveScheduleProviderAndModel({
      provider: params?.provider,
      defaultProvider: params.provider,
    });
    return {
      type: "new-agent" as const,
      config: {
        provider: resolvedProviderModel.provider,
        cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
        ...(params?.isolation ? { isolation: params.isolation } : {}),
      },
    };
  };

  async function requireScheduleTarget(id: string, type: "agent" | "new-agent") {
    if (!scheduleService) {
      throw new Error("Schedule service is not configured");
    }
    const schedule = await scheduleService.inspect(id);
    if (schedule.target.type !== type) {
      throw new Error(
        type === "agent" ? `Heartbeat not found: ${id}` : `Schedule not found: ${id}`,
      );
    }
    return schedule;
  }

  async function requireCallerHeartbeat(id: string) {
    if (!callerAgentId) {
      throw new Error("Heartbeat operations require an agent-scoped session");
    }
    const schedule = await requireScheduleTarget(id, "agent");
    if (schedule.target.type !== "agent" || schedule.target.agentId !== callerAgentId) {
      throw new Error(`Heartbeat ${id} does not belong to caller ${callerAgentId}`);
    }
    return schedule;
  }
  const ProviderModelInputSchema = AgentProviderEnum.trim()
    .refine((value) => value.includes("/"), {
      message: "provider must be provider/model, for example codex/gpt-5.4",
    })
    .refine(
      (value) => {
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider/model, for example codex/gpt-5.4" },
    );
  const ProviderOrProviderModelInputSchema = AgentProviderEnum.trim()
    .min(1, "provider is required")
    .refine(
      (value) => {
        if (!value.includes("/")) {
          return true;
        }
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      {
        message: "provider must be provider or provider/model, for example codex/gpt-5.4",
      },
    );
  const CreateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode to configure before the first run."),
      thinkingOptionId: z.string().optional().describe("Thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const UpdateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode ID."),
      model: z.string().nullable().optional().describe("Model ID. Pass null to clear."),
      thinkingOptionId: z
        .string()
        .nullable()
        .optional()
        .describe("Thinking option ID. Pass null to clear."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const InspectProviderSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Draft session mode ID."),
      model: z.string().optional().describe("Draft model ID."),
      thinkingOptionId: z.string().optional().describe("Draft thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Draft provider feature values."),
    })
    .strict();
  const AgentRelationshipInputSchema = z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("subagent") })
      .strict()
      .describe("Create a child agent under this agent's subagent track."),
    z
      .object({ kind: z.literal("detached") })
      .strict()
      .describe("Create a root agent that does not appear in this agent's subagent track."),
  ]);
  const AgentCreateWorktreeTargetInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("branch-off"),
        worktreeSlug: z
          .string()
          .min(1)
          .optional()
          .describe("Optional worktree slug/path label. Omit to let Paseo generate one."),
        branchName: z
          .string()
          .min(1)
          .optional()
          .describe("Optional git branch name. Defaults to the worktree slug."),
        baseBranch: z
          .string()
          .min(1)
          .optional()
          .describe("Optional base branch. Defaults to the repository default branch."),
      })
      .strict()
      .describe("Create a new branch in a new Paseo worktree."),
    z
      .object({
        kind: z.literal("checkout-branch"),
        branch: z.string().min(1).describe("Existing branch to check out."),
      })
      .strict()
      .describe("Check out an existing branch in a new Paseo worktree."),
    z
      .object({
        kind: z.literal("checkout-pr"),
        githubPrNumber: z.number().int().positive().describe("GitHub pull request number."),
      })
      .strict()
      .describe("Check out a GitHub pull request in a new Paseo worktree."),
  ]);
  const AgentWorkspaceInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("current"),
        cwd: z.string().optional().describe("Optional runtime cwd. Defaults to the caller's cwd."),
      })
      .strict()
      .describe("Use the caller's current workspace."),
    z
      .object({
        kind: z.literal("existing"),
        workspaceId: z.string().min(1).describe("Existing workspace id to attach the agent to."),
        cwd: z
          .string()
          .optional()
          .describe("Optional runtime cwd. Defaults to the existing workspace cwd."),
      })
      .strict()
      .describe("Attach the agent to an existing workspace."),
    z
      .object({
        kind: z.literal("create"),
        source: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("directory"),
              path: z
                .string()
                .optional()
                .describe("Optional directory path. Defaults to the caller's cwd."),
            })
            .strict(),
          z
            .object({
              kind: z.literal("worktree"),
              cwd: z
                .string()
                .optional()
                .describe("Optional source repository. Defaults to the caller's cwd."),
              target: AgentCreateWorktreeTargetInputSchema,
            })
            .strict(),
        ]),
      })
      .strict()
      .describe("Create a new workspace for the agent."),
  ]);
  const createAgentProviderField = ProviderModelInputSchema.describe(
    "Required provider/model pair, for example codex/gpt-5.4.",
  );
  const commonCreateAgentFields = {
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
    role: PaseoRoleIdSchema.optional().describe(
      "Paseo Foundation role to bind through the provider-native durable instruction channel.",
    ),
    ...executionProfileInputShape(canCreateExecutionProfile),
    assignment: AssignmentEnvelopeSchema.optional().describe(
      "Required immutable one-task authority envelope when role is set.",
    ),
    labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
    settings: CreateAgentSettingsInputSchema.optional().describe(
      "Initial runtime settings for the new agent.",
    ),
    initialPrompt: z
      .string()
      .trim()
      .min(1, "initialPrompt is required")
      .describe("Required first task to run immediately after creation."),
  };
  const legacyCreateAgentPlacementFields = {
    relationship: AgentRelationshipInputSchema.describe(
      "Whether the created agent is a subagent under you or a detached root agent.",
    ),
    workspace: AgentWorkspaceInputSchema.describe(
      "Workspace ownership/location for the created agent.",
    ),
  };
  const canonicalCreateAgentFields = {
    ...commonCreateAgentFields,
    provider: createAgentProviderField,
    workspaceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Existing workspace id. Agent-scoped calls default to the caller workspace; top-level calls create a new local workspace when omitted.",
      ),
  };
  const agentToAgentInputSchema = {
    ...canonicalCreateAgentFields,
    launchProfileId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional exact Human-approved Agent Profile ID for a role-bound Lead creating a Peer. Call list_profiles first; omit only when the Human-configured defaultSubrole should resolve the route.",
      ),
    provider: createAgentProviderField
      .optional()
      .describe(
        "Optional provider/model override. Omit it to inherit the caller's exact validated provider/model route; never infer a provider from a model name.",
      ),
    cwd: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Directory for the child workspace. It must be the caller cwd or a descendant; omit it to use the caller workspace.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Get notified when the created agent finishes, errors, or needs permission. Set false only for truly fire-and-forget agents.",
      ),
  };
  const canonicalTopLevelInputSchema = {
    ...canonicalCreateAgentFields,
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the created agent finishes, errors, or needs permission.",
      ),
  };
  const legacyAgentToAgentInputSchema = {
    ...commonCreateAgentFields,
    launchProfileId: agentToAgentInputSchema.launchProfileId,
    provider: createAgentProviderField
      .optional()
      .describe("Optional provider/model override; omit it to inherit the caller route."),
    ...legacyCreateAgentPlacementFields,
    notifyOnFinish: agentToAgentInputSchema.notifyOnFinish,
  };
  const legacyTopLevelCreateAgentInputSchema = {
    ...commonCreateAgentFields,
    provider: createAgentProviderField,
    relationship: legacyCreateAgentPlacementFields.relationship.optional(),
    workspace: legacyCreateAgentPlacementFields.workspace.optional(),
    background: canonicalTopLevelInputSchema.background,
    notifyOnFinish: canonicalTopLevelInputSchema.notifyOnFinish,
    cwd: z
      .string()
      .optional()
      .describe("Legacy top-level working directory. Prefer workspace.source.path."),
    mode: z.string().optional().describe("Legacy session mode ID. Prefer settings.modeId."),
    thinking: z
      .string()
      .optional()
      .describe("Legacy thinking option ID. Prefer settings.thinkingOptionId."),
    features: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Legacy feature values. Prefer settings.features."),
    worktreeName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy worktree slug. Prefer workspace.source.target.worktreeSlug."),
    branchName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy branch name. Prefer workspace.source.target.branchName."),
    baseBranch: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy base branch. Prefer workspace.source.target.baseBranch."),
    refName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy branch/ref to check out. Prefer workspace.source.target.branch."),
    githubPrNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Legacy GitHub PR number. Prefer workspace.source.target.githubPrNumber."),
  };
  const createAgentInputSchema = z
    .object(callerAgentId ? agentToAgentInputSchema : canonicalTopLevelInputSchema)
    .passthrough();
  const agentToAgentCreateAgentArgsSchema = z.object(agentToAgentInputSchema).strict();
  const legacyAgentToAgentCreateAgentArgsSchema = z.object(legacyAgentToAgentInputSchema).strict();
  const canonicalTopLevelCreateAgentArgsSchema = z.object(canonicalTopLevelInputSchema).strict();
  const legacyTopLevelCreateAgentArgsSchema = z
    .object(legacyTopLevelCreateAgentInputSchema)
    .strict();
  const commonSendAgentPromptInputSchema = {
    agentId: z.string(),
    prompt: z.string(),
    sessionMode: z.string().optional().describe("Optional mode to set before running the prompt."),
  };
  const agentToAgentSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    background: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Run agent in background. Agent-scoped default is true so you can continue until the finish notification arrives. Set false only when you need a blocking response.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Get notified when the prompted agent finishes, errors, or needs permission. Set false only for truly fire-and-forget prompts.",
      ),
  };
  const topLevelSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the prompted agent finishes, errors, or needs permission.",
      ),
  };
  const sendAgentPromptInputSchema = callerAgentId
    ? agentToAgentSendAgentPromptInputSchema
    : topLevelSendAgentPromptInputSchema;
  const inspectProviderInputSchema = {
    provider: ProviderOrProviderModelInputSchema.describe(
      "Provider ID, optionally with a model ID (for example codex or codex/gpt-5.4).",
    ),
    cwd: z
      .string()
      .optional()
      .describe("Working directory used to resolve provider feature availability."),
    settings: InspectProviderSettingsInputSchema.optional().describe(
      "Draft provider settings used to compute available features.",
    ),
  };
  type AgentToAgentCreateAgentArgs = z.infer<typeof agentToAgentCreateAgentArgsSchema>;
  type LegacyAgentToAgentCreateAgentArgs = z.infer<typeof legacyAgentToAgentCreateAgentArgsSchema>;
  type TopLevelCreateAgentArgs = z.infer<typeof canonicalTopLevelCreateAgentArgsSchema>;
  type LegacyTopLevelCreateAgentArgs = z.infer<typeof legacyTopLevelCreateAgentArgsSchema>;

  if (options.voiceOnly || options.enableVoiceTools || callerContext?.enableVoiceTools) {
    registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak text to the user via daemon-managed voice output. Blocks until playback completes.",
        inputSchema: {
          text: z
            .string()
            .trim()
            .min(1, "text is required")
            .max(4000, "text must be 4000 characters or fewer"),
        },
        outputSchema: {
          ok: z.boolean(),
        },
      },
      async (args, context) => {
        if (!callerAgentId) {
          throw new Error("speak is only available to agent-scoped tool sessions");
        }
        const handler = resolveSpeakHandler?.(callerAgentId) ?? null;
        if (!handler) {
          throw new Error(`No speak handler registered for your session '${callerAgentId}'`);
        }
        await handler({
          text: args.text,
          callerAgentId,
          signal: context?.signal,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({ ok: true }),
        };
      },
    );
  }

  if (options.voiceOnly) {
    return toCatalog();
  }

  if (options.browserToolsEnabled && options.browserToolsBroker) {
    registerBrowserTools({
      registerTool,
      broker: options.browserToolsBroker,
      callerAgentId,
      resolveCallerAgent,
    });
  }

  registerConfiguredBeadsTools(options, registerTool);

  if (callerAgentId && options.chatService) {
    if (callerRoleId === "lead") {
      const resolveCallerRoomScope = async (): Promise<{
        workspaceId: string;
        projectId: string;
      }> => {
        const callerAgent = resolveCallerAgent();
        const workspaceId = callerAgent?.workspaceId;
        if (!workspaceId || !options.workspaceRegistry) {
          throw new Error("Caller has no active workspace to bind this room to");
        }
        const workspace = await options.workspaceRegistry.get(workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Caller workspace '${workspaceId}' is unavailable or archived`);
        }
        return { workspaceId, projectId: workspace.projectId };
      };

      registerTool(
        "create_room",
        {
          title: "Create room",
          description:
            "Lead-only: create a Paseo room for bounded coordination and return its exact identity. Automatically bound to the caller's current workspace and project.",
          inputSchema: {
            name: z.string().trim().min(1),
            purpose: z.string().trim().min(1).optional(),
          },
          outputSchema: {
            room: ChatRoomDetailSchema,
          },
        },
        async ({ name, purpose }) => {
          const { workspaceId, projectId } = await resolveCallerRoomScope();
          const room = await options.chatService!.createRoom({
            name,
            purpose,
            workspaceId,
            projectId,
          });
          return {
            content: [],
            structuredContent: ensureValidJson({ room }),
          };
        },
      );

      const CouncilSeatPlanSchema = z.object({
        role: CouncilSeatRoleSchema,
        peerSubrole: PeerSubroleSchema,
        executionProfile: z.string().trim().min(1).optional(),
        reportStartSentinel: z.string(),
        reportEndSentinel: z.string(),
        labels: z.record(z.string(), z.string()),
      });

      registerTool(
        "start_council",
        {
          title: "Start council",
          description:
            "Lead-only: create one real Paseo Room and return canonical launch labels for ordinary Peer seats. Call list_profiles, choose a Human-approved Agent Profile matching each peerSubrole, then call create_agent once per seat with the exact labels. This does not create a second orchestration runtime.",
          inputSchema: {
            title: z.string().trim().min(1).max(120),
            question: z.string().trim().min(1),
            // Omission is meaningful: the pinned Council policy distinguishes the bare default
            // from a roles-only compatibility input. Resolve both fields inside the policy rather
            // than letting the host's schema synthesize an indistinguishable default.
            tier: CouncilTierSchema.optional(),
            roles: z.array(CouncilSeatRoleSchema).max(3).optional(),
            roomName: z.string().trim().min(1).optional(),
          },
          outputSchema: {
            caseId: z.string(),
            title: z.string(),
            question: z.string(),
            tier: CouncilTierSchema,
            phase: CouncilPhaseSchema,
            room: ChatRoomDetailSchema,
            kickoff: ChatMessageSchema,
            seats: z.array(CouncilSeatPlanSchema),
          },
        },
        async ({ title, question, tier, roles, roomName }) => {
          if (!options.councilCaseStore) {
            throw new Error("Canonical Council case store is unavailable");
          }
          const councilPolicy = resolveSlpPolicy().councilPolicy;
          const resolvedCouncil = councilPolicy.resolveTierAndRoles({ tier, roles });
          const resolvedTier = resolvedCouncil.tier;
          const uniqueRoles = resolvedCouncil.roles;
          const caseId = `case_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
          const { workspaceId, projectId } = await resolveCallerRoomScope();
          const room = await options.chatService!.createRoom({
            name: roomName ?? `council-${caseId}`,
            purpose: `${title}: ${question}`,
            workspaceId,
            projectId,
          });
          let kickoff;
          try {
            kickoff = await options.chatService!.dispatchMessage({
              room: room.id,
              authorAgentId: callerAgentId,
              authorKind: "agent",
              body: councilPolicy.buildKickoffBody({
                caseId,
                title,
                question,
                tier: resolvedTier,
                roles: uniqueRoles,
              }),
            });
            await options.councilCaseStore.create({
              id: caseId,
              title,
              question,
              tier: resolvedTier,
              roomId: room.id,
              kickoffMessageId: kickoff.id,
              workspaceId,
              projectId,
              parentAgentId: callerAgentId,
              roles: uniqueRoles,
            });
          } catch (error) {
            await options.chatService!.deleteRoom({ room: room.id }).catch(() => undefined);
            throw error;
          }
          const seats = councilPolicy.buildSeatPlans({
            caseId,
            title,
            tier: resolvedTier,
            roomId: room.id,
            kickoffMessageId: kickoff.id,
            roles: uniqueRoles,
          });
          return {
            content: [],
            structuredContent: ensureValidJson({
              caseId,
              title,
              question,
              tier: resolvedTier,
              phase: "sealed",
              room,
              kickoff,
              seats,
            }),
          };
        },
      );

      registerTool(
        "record_council_seat",
        {
          title: "Record council seat",
          description:
            "Lead-only: audit one direct Peer child and update the daemon-owned canonical Council case. integrity=valid requires a terminal seat and the exact Peer-authored Room report message returned by post_room; agent labels are compatibility receipts only.",
          inputSchema: {
            caseId: z.string().trim().min(1),
            agentId: z.string().trim().min(1),
            phase: CouncilPhaseSchema,
            integrity: CouncilSeatIntegritySchema,
            reportMessageId: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe("Required when integrity=valid; exact message ID returned by post_room."),
            disposition: z.string().trim().min(1).max(240).optional(),
          },
          outputSchema: {
            agentId: z.string(),
            caseId: z.string(),
            phase: CouncilPhaseSchema,
            integrity: CouncilSeatIntegritySchema,
            disposition: z.string().optional(),
            reportReceipt: CouncilSeatReportReceiptSchema.optional(),
          },
        },
        async ({ caseId, agentId, phase, integrity, reportMessageId, disposition }) => {
          const target = agentManager.getAgent(agentId) ?? (await agentStorage.get(agentId));
          if (!target) {
            throw new Error(`Council seat agent '${agentId}' is unavailable`);
          }
          const caller = resolveCallerAgent();
          assertCouncilSeatRecordAuthority({
            target,
            callerAgentId,
            callerWorkspaceId: caller?.workspaceId,
            caseId,
            agentId,
          });
          let reportReceipt: CouncilSeatReportReceipt | undefined;
          if (integrity === "valid") {
            reportReceipt = await validateCouncilSeatReportReceipt({
              agentManager,
              chatService: options.chatService!,
              target,
              callerAgentId,
              caseId,
              agentId,
              phase,
              reportMessageId,
            });
          }
          if (!options.councilCaseStore) {
            throw new Error("Canonical Council case store is unavailable");
          }
          await options.councilCaseStore.recordSeat({
            caseId,
            agentId,
            phase,
            integrity,
            ...(disposition ? { disposition } : {}),
            ...(reportReceipt ? { reportReceipt } : {}),
          });
          await updateCouncilCompatibilityReceipt({
            agentManager,
            logger: childLogger,
            agentId,
            caseId,
            phase,
            integrity,
            ...(disposition ? { disposition } : {}),
            ...(reportReceipt ? { reportReceipt } : {}),
          });
          return {
            content: [],
            structuredContent: ensureValidJson({
              agentId,
              caseId,
              phase,
              integrity,
              ...(disposition ? { disposition } : {}),
              ...(reportReceipt ? { reportReceipt } : {}),
            }),
          };
        },
      );
    }

    registerTool(
      "read_room",
      {
        title: "Read room",
        description: "Read recent messages from a Paseo room by name or ID.",
        inputSchema: {
          room: z.string().trim().min(1).describe("Room name or ID."),
          limit: z.number().int().positive().max(100).optional().default(50),
          since: z.string().datetime().optional(),
        },
        outputSchema: {
          messages: z.array(ChatMessageSchema),
        },
      },
      async ({ room, limit = 50, since }) => {
        const messages = await options.chatService!.readMessages({
          room,
          limit,
          since,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({ messages }),
        };
      },
    );

    if (options.resolveAgentIdentifier && options.sendAgentMessage) {
      registerTool(
        "post_room",
        {
          title: "Post room message",
          description:
            "Post to a Paseo room as the calling agent. Use replyToMessageId to reply and @agent-id to wake another agent.",
          inputSchema: {
            room: z.string().trim().min(1).describe("Room name or ID."),
            body: z.string().trim().min(1),
            replyToMessageId: z.string().trim().min(1).optional(),
          },
          outputSchema: {
            message: ChatMessageSchema,
          },
        },
        async ({ room, body, replyToMessageId }) => {
          const message = await postChatMessageWithMentions({
            chatService: options.chatService!,
            room,
            authorAgentId: callerAgentId,
            authorKind: "agent",
            body,
            replyToMessageId,
            logger: childLogger,
            listStoredAgents: () => agentStorage.list(),
            listLiveAgents: () => agentManager.listAgents(),
            resolveAgentIdentifier: options.resolveAgentIdentifier!,
            sendAgentMessage: options.sendAgentMessage!,
          });
          return {
            content: [],
            structuredContent: ensureValidJson({ message }),
          };
        },
      );
    }
  }

  registerTool(
    "create_workspace",
    {
      title: "Create workspace",
      description:
        "Create a workspace using an existing local checkout or a new Paseo-managed worktree.",
      inputSchema: {
        isolation: z.enum(["local", "worktree"]),
        path: z
          .string()
          .optional()
          .describe("Local directory or source checkout. Defaults to your current workspace."),
        projectId: z.string().optional().describe("Existing project id to own the workspace."),
        title: z.string().trim().min(1).optional(),
        mode: z
          .enum(["branch-off", "checkout-branch", "checkout-pr"])
          .optional()
          .describe("Worktree creation mode. Defaults to branch-off."),
        worktreeSlug: z.string().trim().min(1).optional(),
        branchName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("New branch name for branch-off mode."),
        baseBranch: z.string().trim().min(1).optional().describe("Base ref for branch-off mode."),
        branch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Existing branch for checkout-branch mode."),
        prNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pull request or change request number for checkout-pr mode."),
        forge: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Forge for checkout-pr mode. Defaults to the source checkout."),
      },
      outputSchema: WorkspaceAutomationSummarySchema.shape,
    },
    async ({
      isolation,
      path,
      projectId,
      title,
      mode,
      worktreeSlug,
      branchName,
      baseBranch,
      branch,
      prNumber,
      forge,
    }) => {
      let workspace: PersistedWorkspaceRecord;
      if (isolation === "local") {
        const cwd = resolveScopedCwd(path, { required: true });
        assertOptionsAbsent(
          [
            ["mode", mode],
            ["worktreeSlug", worktreeSlug],
            ["branchName", branchName],
            ["baseBranch", baseBranch],
            ["branch", branch],
            ["prNumber", prNumber],
            ["forge", forge],
          ],
          "Worktree options require isolation worktree",
        );
        if (!options.createDirectoryWorkspace) {
          throw new Error("Workspace provisioning is not configured");
        }
        workspace = await options.createDirectoryWorkspace(cwd, title, projectId);
      } else {
        let cwd =
          path !== undefined || !projectId ? resolveScopedCwd(path, { required: true }) : null;
        if (!cwd) {
          if (!options.projectRegistry) {
            throw new Error("Project registry is not configured");
          }
          cwd = await resolveWorktreeSourceCwd({ projectId }, options.projectRegistry);
        }
        const worktreeTarget = resolveWorkspaceWorktreeTarget({
          mode,
          worktreeSlug,
          branchName,
          baseBranch,
          branch,
          prNumber,
          forge,
        });
        const result = await createPaseoWorktreeCommand(
          {
            paseoHome: options.paseoHome,
            worktreesRoot: options.worktreesRoot,
            createPaseoWorktreeWorkflow: options.createPaseoWorktree,
          },
          {
            cwd,
            ...(projectId ? { projectId } : {}),
            ...(worktreeSlug ? { worktreeSlug } : {}),
            ...worktreeTarget,
            ...(title ? { title } : {}),
          },
        );
        if (!result.ok) {
          throw result.cause;
        }
        workspace = result.createdWorktree.workspace;
      }

      return {
        content: [],
        structuredContent: ensureValidJson(toWorkspaceAutomationSummary(workspace)),
      };
    },
  );

  registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description: "List active workspaces.",
      inputSchema: {},
      outputSchema: { workspaces: z.array(WorkspaceAutomationSummarySchema) },
    },
    async () => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is not configured");
      }
      const workspaces = (await options.workspaceRegistry.list())
        .filter((workspace) => !workspace.archivedAt)
        .map(toWorkspaceAutomationSummary);
      return {
        content: [],
        structuredContent: ensureValidJson({ workspaces }),
      };
    },
  );

  registerTool(
    "archive_workspace",
    {
      title: "Archive workspace",
      description: "Archive a workspace and everything it owns.",
      inputSchema: { workspaceId: z.string().min(1) },
      outputSchema: {
        workspaceId: z.string(),
        archivedAgentIds: z.array(z.string()),
        removedDirectory: z.boolean(),
      },
    },
    async ({ workspaceId }) => {
      if (!options.listActiveWorkspaces) {
        throw new Error("Active workspace lister is required to archive workspaces");
      }
      const workspace = await requireActiveWorkspaceForArchive(
        { listActiveWorkspaces: options.listActiveWorkspaces },
        workspaceId,
      );
      const result = await archiveByScope(
        archiveWorktreeDependencies(options, {
          agentManager,
          agentStorage,
          terminalManager: terminalManager ?? null,
          logger: childLogger,
        }),
        {
          requestId: "mcp:archive_workspace",
          scope: { kind: "workspace", workspaceId: workspace.workspaceId },
        },
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          workspaceId,
          archivedAgentIds: result.archivedAgentIds,
          removedDirectory: result.removedDirectory,
        }),
      };
    },
  );

  registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create an agent. A role-bound Lead creating a Peer can pass an exact Human-approved launchProfileId, or omit it to use the Human-configured default Peer subrole and provider priority. Omit provider/settings when profile routing is configured because the resolved profile supplies them. Other agent-scoped creation can inherit the caller route. Top-level creation requires provider/model. An initial prompt is always required.",
      inputSchema: createAgentInputSchema,
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        workspaceId: z.string().optional(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(ProviderModeSchema),
        roleBinding: RoleBindingReceiptSchema.optional(),
        launchContract: LaunchContractReceiptSchema.optional(),
        launchProfile: AgentProfileLaunchReceiptSchema.optional(),
        ...executionProfileOutputShape(canCreateExecutionProfile),
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        guidance: z.string().optional(),
      },
    },
    async (args: unknown) => {
      const resolvedArgs = await resolveCreateAgentToolArgs(args);
      const { parsedArgs, worktree } = resolvedArgs;
      let workspaceRollbackTransferred = false;
      try {
        const councilLaunch = councilSeatLaunch(parsedArgs.labels);
        await assertCanonicalCouncilSeatLaunch({
          launch: councilLaunch,
          store: options.councilCaseStore,
          callerAgentId,
          workspaceId: resolvedArgs.workspaceId ?? null,
        });
        const councilSeatAssignmentHooks = createCouncilSeatAssignmentHooks({
          launch: councilLaunch,
          store: options.councilCaseStore,
          callerAgentId,
          workspaceId: resolvedArgs.workspaceId ?? null,
          agentManager,
          agentStorage,
          logger: childLogger,
        });
        const launchSettings = resolveCreateLaunchSettings(resolvedArgs);
        const { launchProfile } = launchSettings;
        const launchProfileReceipt = projectLaunchProfileReceipt(launchProfile);
        const executionProfileId = resolveExecutionProfileRequest(
          parsedArgs,
          callerRoleId,
          resolveSlpPolicy,
        );
        const { requestedBackground, notifyOnFinish } = resolveCreateRunBehavior(resolvedArgs);
        const {
          providerRoute,
          provider: selectedProvider,
          enforcedMode,
          unattended,
        } = await resolveCreateAgentProviderRoute({
          requestedProvider: launchSettings.requestedProvider,
          requestedRole: parsedArgs.role,
          requestedMode: launchSettings.requestedMode,
          requestedCwd: resolvedArgs.cwd,
          launchProfile,
          assignmentNoWrite: isNoWritePeerAssignment(parsedArgs),
        });
        const inheritedConfig = resolveInheritedProviderConfig(selectedProvider);
        workspaceRollbackTransferred = true;
        const {
          snapshot,
          background: createdInBackground,
          initialPromptStarted,
        } = await createAgentCommand(
          {
            agentManager,
            agentStorage,
            logger: childLogger,
            resolveCouncilSeatProjection: options.resolveCouncilSeatProjection,
            paseoHome: options.paseoHome,
            worktreesRoot: options.worktreesRoot,
            terminalManager,
            providerSnapshotManager,
            createPaseoWorktree: options.createPaseoWorktree,
            ...(options.ensureWorkspaceForCreate
              ? { ensureWorkspaceForCreate: options.ensureWorkspaceForCreate }
              : {}),
            ...(options.rollbackWorkspaceAfterFailedCreate
              ? { rollbackWorkspaceAfterFailedCreate: options.rollbackWorkspaceAfterFailedCreate }
              : {}),
            ...(options.rollbackWorktreeAfterFailedCreate
              ? { rollbackWorktreeAfterFailedCreate: options.rollbackWorktreeAfterFailedCreate }
              : {}),
          },
          {
            kind: "mcp",
            provider: providerRoute,
            roleId: parsedArgs.role,
            executionProfileId,
            assignment: parsedArgs.assignment,
            title: parsedArgs.title,
            initialPrompt: parsedArgs.initialPrompt,
            config: inheritedConfig,
            cwd: resolvedArgs.cwd,
            workspaceId: resolvedArgs.workspaceId,
            createdDirectoryWorkspaceId: resolvedArgs.createdDirectoryWorkspaceId,
            launchProfile: launchProfileReceipt.launchProfile,
            thinking: launchSettings.thinkingOptionId,
            features: launchSettings.featureValues,
            labels: parsedArgs.labels,
            mode: enforcedMode ?? launchSettings.requestedMode,
            unattended,
            background: requestedBackground,
            notifyOnFinish,
            detached: resolvedArgs.detached,
            callerAgentId,
            callerContext,
            worktree,
            ...councilSeatAssignmentHooks,
          },
        );

        try {
          if (!createdInBackground && initialPromptStarted) {
            const result = await waitForAgentWithTimeout(agentManager, snapshot.id, {
              waitForActive: true,
            });

            const liveSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
            const responseData = {
              agentId: snapshot.id,
              type: snapshot.provider,
              status: result.status,
              cwd: liveSnapshot.cwd,
              ...(liveSnapshot.workspaceId ? { workspaceId: liveSnapshot.workspaceId } : {}),
              currentModeId: liveSnapshot.currentModeId,
              availableModes: liveSnapshot.availableModes,
              ...projectFoundationLaunchReceipts(liveSnapshot, {
                includeExecutionProfile: canCreateExecutionProfile,
              }),
              ...launchProfileReceipt,
              lastMessage: result.lastMessage,
              permission: sanitizePermissionRequest(result.permission),
            };
            const validJson = ensureValidJson(responseData);

            const response = {
              content: [],
              structuredContent: validJson,
            };
            return response;
          }
        } catch (error) {
          childLogger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
          throw error;
        }

        // Return immediately for async creation.
        const currentSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
        const guidance =
          callerAgentId && notifyOnFinish && initialPromptStarted
            ? "You will get notified when the created agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives."
            : undefined;
        const response = {
          content: [],
          structuredContent: ensureValidJson({
            agentId: currentSnapshot.id,
            type: snapshot.provider,
            status: currentSnapshot.lifecycle,
            cwd: currentSnapshot.cwd,
            ...(currentSnapshot.workspaceId ? { workspaceId: currentSnapshot.workspaceId } : {}),
            currentModeId: currentSnapshot.currentModeId,
            availableModes: currentSnapshot.availableModes,
            ...projectFoundationLaunchReceipts(currentSnapshot, {
              includeExecutionProfile: canCreateExecutionProfile,
            }),
            ...launchProfileReceipt,
            lastMessage: null,
            permission: null,
            ...(guidance ? { guidance } : {}),
          }),
        };
        return response;
      } catch (error) {
        await rollbackCreateAgentWorkspaceAfterValidationFailure(
          resolvedArgs,
          workspaceRollbackTransferred,
        );
        throw error;
      }
    },
  );

  type ResolvedCreateAgentToolArgs =
    | {
        kind: "agent-scoped";
        parsedArgs: AgentToAgentCreateAgentArgs | LegacyAgentToAgentCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
        createdDirectoryWorkspaceId: string | undefined;
        worktree: CreateAgentFromMcpInput["worktree"];
      }
    | {
        kind: "top-level";
        parsedArgs: TopLevelCreateAgentArgs | LegacyTopLevelCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
        createdDirectoryWorkspaceId: string | undefined;
        worktree: CreateAgentFromMcpInput["worktree"];
      };

  function isNoWritePeerAssignment(parsedArgs: ResolvedCreateAgentToolArgs["parsedArgs"]): boolean {
    return (
      parsedArgs.role === "peer" && parsedArgs.assignment?.mutationBoundary.mode === "no-write"
    );
  }

  async function rollbackCreateAgentWorkspaceAfterValidationFailure(
    resolvedArgs: ResolvedCreateAgentToolArgs,
    workspaceRollbackTransferred: boolean,
  ): Promise<void> {
    if (
      workspaceRollbackTransferred ||
      !resolvedArgs.createdDirectoryWorkspaceId ||
      !options.rollbackWorkspaceAfterFailedCreate
    ) {
      return;
    }

    await options
      .rollbackWorkspaceAfterFailedCreate(resolvedArgs.createdDirectoryWorkspaceId)
      .catch((rollbackError) => {
        childLogger.warn(
          {
            err: rollbackError,
            workspaceId: resolvedArgs.createdDirectoryWorkspaceId,
          },
          "Failed to roll back directory workspace after create_agent validation failed",
        );
      });
  }

  function resolveCreateRunBehavior(resolvedArgs: ResolvedCreateAgentToolArgs): {
    requestedBackground: boolean;
    notifyOnFinish: boolean;
  } {
    if (resolvedArgs.kind === "agent-scoped") {
      return {
        requestedBackground: true,
        notifyOnFinish: resolvedArgs.parsedArgs.notifyOnFinish,
      };
    }
    return {
      requestedBackground: resolvedArgs.parsedArgs.background,
      notifyOnFinish: resolvedArgs.parsedArgs.notifyOnFinish ?? false,
    };
  }

  function resolveCreateLaunchSettings(resolvedArgs: ResolvedCreateAgentToolArgs): {
    launchProfile?: LaunchableAgentProfile;
    requestedProvider?: string;
    requestedMode?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
  } {
    const { parsedArgs } = resolvedArgs;
    const launchProfile =
      resolvedArgs.kind === "agent-scoped"
        ? resolvePeerLaunchProfile({
            requestedRole: parsedArgs.role,
            requestedProfileId:
              "launchProfileId" in parsedArgs ? parsedArgs.launchProfileId : undefined,
            requestedSubrole:
              callerRoleId === "lead" && parsedArgs.role === "peer"
                ? resolveSlpPolicy().executionProfilePolicy.resolvePeerSubrole({
                    executionProfile:
                      "executionProfile" in parsedArgs ? parsedArgs.executionProfile : undefined,
                    assignmentDisposition: parsedArgs.assignment?.disposition,
                  })
                : undefined,
            requestedProvider: parsedArgs.provider,
            hasRequestedSettings: parsedArgs.settings !== undefined,
          })
        : undefined;
    return {
      ...(launchProfile ? { launchProfile } : {}),
      requestedProvider: launchProfile
        ? `${launchProfile.provider}/${launchProfile.model}`
        : parsedArgs.provider,
      requestedMode: launchProfile?.modeId ?? parsedArgs.settings?.modeId,
      thinkingOptionId: launchProfile?.thinkingOptionId ?? parsedArgs.settings?.thinkingOptionId,
      featureValues: launchProfile?.featureValues ?? parsedArgs.settings?.features,
    };
  }

  async function resolveCreateAgentToolArgs(args: unknown): Promise<ResolvedCreateAgentToolArgs> {
    if (callerAgentId) {
      if (hasLegacyCreateAgentPlacement(args)) {
        // COMPAT(nestedCreateAgentPlacement): accept the old relationship/workspace shape without
        // advertising it to models. Added in v0.2.0; remove after 2027-01-17.
        const parsed = legacyAgentToAgentCreateAgentArgsSchema.parse(args);
        await assertAgentScopedRoleTopologyAuthorized({
          agentStorage,
          callerAgentId,
          action: { kind: "create_agent", requestedRole: parsed.role },
        });
        const { cwd, workspaceId, createdDirectoryWorkspaceId, worktree } =
          await resolveCreateAgentWorkspace(parsed.workspace, {
            title: parsed.title,
            prompt: parsed.initialPrompt,
          });
        return {
          kind: "agent-scoped",
          parsedArgs: parsed,
          detached: parsed.relationship.kind === "detached",
          cwd,
          workspaceId,
          createdDirectoryWorkspaceId,
          worktree,
        };
      }
      const parsed = agentToAgentCreateAgentArgsSchema.parse(args);
      await assertAgentScopedRoleTopologyAuthorized({
        agentStorage,
        callerAgentId,
        action: { kind: "create_agent", requestedRole: parsed.role },
      });
      const { cwd, workspaceId, createdDirectoryWorkspaceId } =
        await resolveCanonicalCreateAgentWorkspace(
          parsed.workspaceId,
          { title: parsed.title, prompt: parsed.initialPrompt },
          parsed.cwd,
        );
      return {
        kind: "agent-scoped",
        parsedArgs: parsed,
        detached: false,
        cwd,
        workspaceId,
        createdDirectoryWorkspaceId,
        worktree: undefined,
      };
    }
    if (hasLegacyCreateAgentPlacement(args)) {
      // COMPAT(nestedCreateAgentPlacement): see the agent-scoped branch above.
      const parsedArgs = normalizeTopLevelCreateAgentArgs(
        legacyTopLevelCreateAgentArgsSchema.parse(args),
      );
      if (parsedArgs.relationship?.kind === "subagent") {
        throw new Error("relationship subagent requires an agent-scoped tool session");
      }
      if (!parsedArgs.workspace) {
        throw new Error("Legacy create_agent placement could not be resolved");
      }
      const { cwd, workspaceId, createdDirectoryWorkspaceId, worktree } =
        await resolveCreateAgentWorkspace(parsedArgs.workspace, {
          title: parsedArgs.title,
          prompt: parsedArgs.initialPrompt,
        });
      return {
        kind: "top-level",
        parsedArgs,
        detached: true,
        cwd,
        workspaceId,
        createdDirectoryWorkspaceId,
        worktree,
      };
    }
    const parsedArgs = canonicalTopLevelCreateAgentArgsSchema.parse(args);
    const { cwd, workspaceId, createdDirectoryWorkspaceId } =
      await resolveCanonicalCreateAgentWorkspace(parsedArgs.workspaceId, {
        title: parsedArgs.title,
        prompt: parsedArgs.initialPrompt,
      });
    return {
      kind: "top-level",
      parsedArgs,
      detached: false,
      cwd,
      workspaceId,
      createdDirectoryWorkspaceId,
      worktree: undefined,
    };
  }

  function hasLegacyCreateAgentPlacement(args: unknown): boolean {
    if (!args || typeof args !== "object") {
      return false;
    }
    const input = args as Record<string, unknown>;
    return [
      "relationship",
      "workspace",
      ...(!callerAgentId ? ["cwd"] : []),
      "worktreeName",
      "branchName",
      "baseBranch",
      "refName",
      "githubPrNumber",
    ].some((key) => input[key] !== undefined);
  }

  async function resolveCanonicalCreateAgentWorkspace(
    workspaceId?: string,
    firstAgentContext?: FirstAgentContext,
    requestedCwd?: string,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string;
    createdDirectoryWorkspaceId: string | undefined;
  }> {
    if (workspaceId && requestedCwd) {
      throw new Error("Specify at most one of workspaceId or cwd");
    }
    if (workspaceId) {
      const resolved = await resolveCreateAgentWorkspace(
        { kind: "existing", workspaceId },
        undefined,
      );
      assertRoleBoundChildCwdWithinCallerRoot(resolved.cwd);
      return { cwd: resolved.cwd, workspaceId, createdDirectoryWorkspaceId: undefined };
    }
    if (requestedCwd) {
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      const cwd = resolveScopedCwd(requestedCwd, { required: true });
      assertRoleBoundChildCwdWithinCallerRoot(cwd);
      const createdDirectoryWorkspaceId = await options.ensureWorkspaceForCreate(
        cwd,
        firstAgentContext,
      );
      return {
        cwd,
        workspaceId: createdDirectoryWorkspaceId,
        createdDirectoryWorkspaceId,
      };
    }
    if (!callerAgentId) {
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      const cwd = process.cwd();
      const createdDirectoryWorkspaceId = await options.ensureWorkspaceForCreate(
        cwd,
        firstAgentContext,
      );
      return {
        cwd,
        workspaceId: createdDirectoryWorkspaceId,
        createdDirectoryWorkspaceId,
      };
    }
    const caller = resolveCallerAgent();
    if (!caller?.workspaceId) {
      throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
    }
    return {
      cwd: undefined,
      workspaceId: caller.workspaceId,
      createdDirectoryWorkspaceId: undefined,
    };
  }

  function assertRoleBoundChildCwdWithinCallerRoot(cwd: string | undefined): void {
    if (!callerAgentId || !cwd) return;
    const caller = resolveCallerAgent();
    if (!caller?.roleBinding) return;
    if (!isSameOrDescendantPath(caller.cwd, cwd)) {
      throw new Error(
        `Child workspace '${cwd}' is outside the role-bound caller cwd '${caller.cwd}'`,
      );
    }
  }

  function normalizeTopLevelCreateAgentArgs(
    args: LegacyTopLevelCreateAgentArgs,
  ): LegacyTopLevelCreateAgentArgs {
    const {
      cwd,
      mode,
      thinking,
      features,
      worktreeName,
      branchName,
      baseBranch,
      refName,
      githubPrNumber,
      ...canonicalCandidate
    } = args;
    const settings = {
      ...canonicalCandidate.settings,
      ...(mode ? { modeId: mode } : {}),
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      ...(features ? { features } : {}),
    };

    if (canonicalCandidate.relationship && canonicalCandidate.workspace) {
      return legacyTopLevelCreateAgentArgsSchema.parse({
        ...canonicalCandidate,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      });
    }

    if (canonicalCandidate.relationship || canonicalCandidate.workspace) {
      throw new Error("relationship and workspace must be provided together");
    }

    if (!cwd?.trim()) {
      throw new Error("cwd is required for legacy top-level create_agent calls");
    }

    const legacyWorktreeTarget = resolveLegacyCreateAgentWorktreeTarget({
      worktreeName,
      branchName,
      baseBranch,
      refName,
      githubPrNumber,
    });
    const workspace = legacyWorktreeTarget
      ? {
          kind: "create" as const,
          source: {
            kind: "worktree" as const,
            cwd,
            target: legacyWorktreeTarget,
          },
        }
      : {
          kind: "create" as const,
          source: {
            kind: "directory" as const,
            path: cwd,
          },
        };

    return legacyTopLevelCreateAgentArgsSchema.parse({
      ...canonicalCandidate,
      relationship: { kind: "detached" },
      workspace,
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    });
  }

  function resolveLegacyCreateAgentWorktreeTarget(input: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    githubPrNumber?: number;
  }): z.infer<typeof AgentCreateWorktreeTargetInputSchema> | null {
    if (input.githubPrNumber !== undefined) {
      return {
        kind: "checkout-pr",
        githubPrNumber: input.githubPrNumber,
      };
    }

    if (input.refName) {
      return {
        kind: "checkout-branch",
        branch: input.refName,
      };
    }

    if (input.worktreeName || input.branchName || input.baseBranch) {
      return {
        kind: "branch-off",
        worktreeSlug: input.worktreeName,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
      };
    }

    return null;
  }

  async function resolveCreateAgentWorkspace(
    workspace:
      | LegacyAgentToAgentCreateAgentArgs["workspace"]
      | NonNullable<LegacyTopLevelCreateAgentArgs["workspace"]>,
    firstAgentContext: FirstAgentContext | undefined,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string | undefined;
    createdDirectoryWorkspaceId: string | undefined;
    worktree: CreateAgentFromMcpInput["worktree"];
  }> {
    if (workspace.kind === "current") {
      if (!callerAgentId) {
        throw new Error("workspace current requires an agent-scoped tool session");
      }
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
      }
      return {
        cwd: workspace.cwd,
        workspaceId: callerAgent.workspaceId,
        createdDirectoryWorkspaceId: undefined,
        worktree: undefined,
      };
    }

    if (workspace.kind === "existing") {
      if (!options.listActiveWorkspaces) {
        throw new Error("Workspace lookup is not configured");
      }
      const existingWorkspace = (await options.listActiveWorkspaces()).find(
        (candidate) => candidate.workspaceId === workspace.workspaceId,
      );
      if (!existingWorkspace) {
        throw new Error(`Workspace ${workspace.workspaceId} not found`);
      }
      const cwd = workspace.cwd
        ? resolveScopedCwd(workspace.cwd, { required: true })
        : existingWorkspace.cwd;
      const lockedCwd = callerContext?.lockedCwd?.trim();
      if (lockedCwd && !isSameOrDescendantPath(expandUserPath(lockedCwd), cwd)) {
        throw new Error(`Workspace ${workspace.workspaceId} is outside the allowed cwd`);
      }
      return {
        cwd,
        workspaceId: workspace.workspaceId,
        createdDirectoryWorkspaceId: undefined,
        worktree: undefined,
      };
    }

    if (workspace.source.kind === "directory") {
      const cwd = resolveScopedCwd(workspace.source.path, { required: true });
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      const createdDirectoryWorkspaceId = await options.ensureWorkspaceForCreate(
        cwd,
        firstAgentContext,
      );
      return {
        cwd,
        workspaceId: createdDirectoryWorkspaceId,
        createdDirectoryWorkspaceId,
        worktree: undefined,
      };
    }

    const cwd = resolveScopedCwd(workspace.source.cwd, { required: true });
    return {
      cwd,
      workspaceId: undefined,
      createdDirectoryWorkspaceId: undefined,
      worktree: resolveCreateAgentWorktree(workspace.source.target),
    };
  }

  function resolveCreateAgentWorktree(
    target: z.infer<typeof AgentCreateWorktreeTargetInputSchema>,
  ): NonNullable<CreateAgentFromMcpInput["worktree"]> {
    switch (target.kind) {
      case "branch-off":
        return {
          action: "branch-off",
          worktreeName: target.worktreeSlug,
          branchName: target.branchName,
          baseBranch: target.baseBranch,
        };
      case "checkout-branch":
        return {
          action: "checkout",
          refName: target.branch,
        };
      case "checkout-pr":
        return {
          action: "checkout",
          githubPrNumber: target.githubPrNumber,
        };
      default:
        throw new Error("unreachable");
    }
  }

  registerTool(
    "prepare_lead_handoff",
    {
      title: "Prepare Lead handoff",
      description: coordinationDescriptions.prepareLeadHandoff,
      inputSchema: PrepareLeadHandoffInputSchema.omit({
        predecessorAgentId: true,
      }).shape,
      outputSchema: { handoff: LeadHandoffPacketSchema },
    },
    async (input) => {
      const caller = callerAgentId ? await agentStorage.get(callerAgentId) : null;
      const predecessorAgentId =
        resolveSlpPolicy().coordinationPolicy.assertPrepareLeadHandoffAuthority({
          callerAgentId,
          callerRoleId: caller?.roleBinding?.roleId,
        });
      const handoff = await prepareLeadHandoff({ agentStorage }, { ...input, predecessorAgentId });
      agentManager.notifyAgentState(predecessorAgentId);
      return { content: [], structuredContent: ensureValidJson({ handoff }) };
    },
  );

  registerTool(
    "transition_lead_handoff",
    {
      title: "Transition Lead handoff",
      description: coordinationDescriptions.transitionLeadHandoff,
      inputSchema: {
        predecessorAgentId: z.string().min(1),
        handoffId: z.string().min(1),
        transition: LeadHandoffTransitionSchema,
        successorAgentId: z.string().min(1).optional(),
        note: z.string().trim().min(1).max(1_000),
      },
      outputSchema: { handoff: LeadHandoffPacketSchema },
    },
    async ({ predecessorAgentId, handoffId, transition, successorAgentId, note }) => {
      resolveSlpPolicy().coordinationPolicy.assertLeadHandoffTransitionAuthority({
        callerAgentId,
        transition,
      });
      const handoff = await transitionLeadHandoff(
        {
          agentStorage,
          hasInFlightRun: (agentId) =>
            agentManager.hasInFlightRun(agentId) || hasPendingAgentInitialization(agentId),
          closePredecessorRuntime: async (agentId, signal) =>
            agentManager.closeAgentForLeadHandoff(agentId, signal),
        },
        {
          predecessorAgentId,
          handoffId,
          transition,
          actorAgentId: callerAgentId ?? null,
          successorAgentId,
          note,
        },
      );
      agentManager.notifyAgentState(predecessorAgentId);
      return { content: [], structuredContent: ensureValidJson({ handoff }) };
    },
  );

  registerTool(
    "ask_attention_question",
    {
      title: "Ask attention question",
      description: coordinationDescriptions.askAttentionQuestion,
      inputSchema: {
        agentId: z.string().min(1),
        observation: z.string().trim().min(1).max(1_000),
        question: z.string().trim().min(1).max(1_000),
        evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
      },
      outputSchema: {
        signal: CoordinationSignalSchema,
      },
    },
    async ({ agentId, observation, question, evidenceRefs }) => {
      if (!options.sendAgentMessageAtSafeBoundary) {
        throw new Error("Attention question delivery is unavailable");
      }
      const target = await agentStorage.get(agentId);
      if (!target || target.internal || target.archivedAt) {
        throw new Error(`Agent ${agentId} is not available`);
      }
      let requesterRoleId: PaseoRoleId | undefined;
      let requesterWorkspaceId: string | undefined;
      if (callerAgentId) {
        const caller = await agentStorage.get(callerAgentId);
        requesterRoleId = caller?.roleBinding?.roleId;
        requesterWorkspaceId = caller?.workspaceId;
      }
      const coordinationPolicy = resolveSlpPolicy().coordinationPolicy;
      coordinationPolicy.assertAttentionQuestionAuthority({
        targetAgentId: agentId,
        targetRoleId: target.roleBinding?.roleId,
        callerRoleId: requesterRoleId,
        callerAgentId,
        callerWorkspaceId: requesterWorkspaceId,
        targetWorkspaceId: target.workspaceId,
        observation,
        question,
        evidenceRefs,
      });
      agentManager.assertAttentionQuestionTargetSupport(target.roleBinding);
      const signal = await requestCoordinationSignal(
        {
          agentManager,
          agentStorage,
          sendAtSafeBoundary: options.sendAgentMessageAtSafeBoundary,
          logger: childLogger,
        },
        {
          targetAgentId: agentId,
          requestedByAgentId: callerAgentId ?? null,
          kind: "continuity_attention",
          severity: "info",
          reason: "An evidence-backed attention question was raised for review at a safe boundary.",
          observation,
          question,
          evidenceRefs,
          coalescingKey: coordinationPolicy.attentionQuestionCoalescingKey({
            requester: callerAgentId
              ? { kind: "agent", agentId: callerAgentId }
              : { kind: "human" },
            targetAgentId: agentId,
            observation,
            question,
          }),
        },
      );
      return { content: [], structuredContent: ensureValidJson({ signal }) };
    },
  );

  registerTool(
    "signal_agent",
    {
      title: "Signal agent",
      description: coordinationDescriptions.signalAgent,
      inputSchema: {
        agentId: z.string().min(1),
        kind: ManualCoordinationSignalKindSchema,
        reason: z.string().trim().min(1).max(1_000),
        relatedAgentId: z.string().min(1).optional(),
        evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
      },
      outputSchema: {
        signal: CoordinationSignalSchema,
      },
    },
    async ({ agentId, kind, reason, relatedAgentId, evidenceRefs }) => {
      if (!options.sendAgentMessageAtSafeBoundary) {
        throw new Error("Coordination signal delivery is unavailable");
      }
      const target = await agentStorage.get(agentId);
      if (!target || target.internal || target.archivedAt) {
        throw new Error(`Agent ${agentId} is not available`);
      }
      let requesterRoleId: PaseoRoleId | undefined;
      if (callerAgentId) {
        const caller = await agentStorage.get(callerAgentId);
        requesterRoleId = caller?.roleBinding?.roleId;
      }
      resolveSlpPolicy().coordinationPolicy.assertSignalAgentAuthority({
        targetAgentId: agentId,
        targetRoleId: target.roleBinding?.roleId,
        callerRoleId: requesterRoleId,
        callerAgentId,
        kind,
        relatedAgentId,
      });
      const signal = await requestCoordinationSignal(
        {
          agentManager,
          agentStorage,
          sendAtSafeBoundary: options.sendAgentMessageAtSafeBoundary,
          logger: childLogger,
        },
        {
          targetAgentId: agentId,
          requestedByAgentId: callerAgentId ?? null,
          kind,
          reason,
          relatedAgentId,
          evidenceRefs,
        },
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ signal }),
      };
    },
  );

  registerTool(
    "resolve_agent_signal",
    {
      title: "Resolve agent signal",
      description: coordinationDescriptions.resolveAgentSignal,
      inputSchema: {
        agentId: z.string().min(1).optional(),
        signalId: z.string().min(1),
        resolution: CoordinationSignalResolutionSchema,
        note: z.string().trim().max(1_000).optional(),
      },
      outputSchema: {
        signal: CoordinationSignalSchema,
      },
    },
    async ({ agentId, signalId, resolution, note }) => {
      const targetAgentId = resolveSlpPolicy().coordinationPolicy.assertResolveAgentSignalAuthority(
        {
          callerAgentId,
          requestedAgentId: agentId,
        },
      );
      const signal = await resolveCoordinationSignal(
        {
          agentManager,
          agentStorage,
          sendAtSafeBoundary: options.sendAgentMessageAtSafeBoundary ?? (async () => undefined),
          logger: childLogger,
        },
        { targetAgentId, signalId, resolution, note },
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ signal }),
      };
    },
  );

  registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a task to a running agent. Agent-scoped callers run in background by default; top-level callers wait by default.",
      inputSchema: sendAgentPromptInputSchema,
      outputSchema: {
        success: z.boolean(),
        status: AgentStatusEnum,
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        guidance: z.string().optional(),
      },
    },
    async ({
      agentId,
      prompt,
      sessionMode,
      background = Boolean(callerAgentId),
      notifyOnFinish = Boolean(callerAgentId),
    }) => {
      await assertAgentScopedRoleTopologyAuthorized({
        agentStorage,
        callerAgentId,
        action: { kind: "send_agent_prompt", targetAgentId: agentId },
      });
      const shouldNotifyOnFinish = Boolean(callerAgentId && notifyOnFinish && background);

      const finishNotificationDependencies: FinishNotificationDependencies = {
        agentManager,
        agentStorage,
        logger: childLogger,
        resolveCouncilSeatProjection: options.resolveCouncilSeatProjection,
      };
      let finishWatch: FinishNotificationWatch | null = null;
      let finishWatchStop: (() => void) | null = null;
      if (shouldNotifyOnFinish && callerAgentId) {
        finishWatch = await registerFinishNotificationWatch(finishNotificationDependencies, {
          childAgentId: agentId,
          callerAgentId,
          requireParentOwnership: true,
        });
        // Register and subscribe before dispatch so a turn that starts and
        // finishes quickly still produces a durable observed-run receipt.
        finishWatchStop = attachFinishNotificationWatch(finishNotificationDependencies, {
          childAgentId: agentId,
          watch: finishWatch,
        });
      }

      // Keep the durable intent for restart reconciliation: a send failure
      // may occur after the manager accepted the run but before this call
      // receives its dispatch receipt. No idle snapshot is treated as a
      // finish without the persisted observed-run proof.
      const dispatchResult = await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId,
        prompt,
        sessionMode,
        logger: childLogger,
      });
      if (finishWatch && dispatchResult.disposition === "out_of_band") {
        finishWatchStop?.();
        finishWatchStop = null;
        await cancelFinishNotificationWatch(finishNotificationDependencies, {
          childAgentId: agentId,
          watch: finishWatch,
        });
      }

      // If not running in background, wait for completion
      if (!background) {
        const result = await waitForAgentWithTimeout(agentManager, agentId, {
          waitForActive: true,
        });

        const responseData = {
          success: true,
          status: result.status,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
        };
        const validJson = ensureValidJson(responseData);

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
      }

      // Return immediately if background=true
      // Re-fetch snapshot since the state may have changed
      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        status: currentSnapshot?.lifecycle ?? "idle",
        lastMessage: null,
        permission: null,
        ...(shouldNotifyOnFinish
          ? {
              guidance:
                "You will get notified when the prompted agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.",
            }
          : {}),
      };
      const validJson = ensureValidJson(responseData);

      const response = {
        content: [],
        structuredContent: validJson,
      };
      return response;
    },
  );

  registerTool(
    "get_agent_status",
    {
      title: "Get agent status",
      description:
        "Return the latest snapshot for an exact agent ID, including lifecycle state, capabilities, and pending permissions. A running agent should resolve itself from PASEO_AGENT_ID; list_agents intentionally omits internal worker agents.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        status: AgentStatusEnum,
        snapshot: AgentSnapshotPayloadSchema,
      },
    },
    async ({ agentId }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (snapshot) {
        const structuredSnapshot = await serializeSnapshotWithMetadata(
          agentStorage,
          snapshot,
          childLogger,
          agentManager.getTimeline(snapshot.id),
        );
        return {
          content: [],
          structuredContent: ensureValidJson({
            status: snapshot.lifecycle,
            snapshot: structuredSnapshot,
          }),
        };
      }

      const record = await agentStorage.get(agentId);
      if (!record || record.internal) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const structuredSnapshot = buildStoredAgentPayload(
        record,
        new Set(providerSnapshotManager.listRegisteredProviderIds()),
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          status: structuredSnapshot.status,
          snapshot: structuredSnapshot,
        }),
      };
    },
  );

  registerAgentCheckpointTool({ callerAgentId, options, registerTool });

  registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List recent agents as compact metadata.",
      inputSchema: {
        includeArchived: z.boolean().optional().default(false),
        cwd: z.string().optional(),
        sinceHours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .default(48),
        statuses: z.array(AgentStatusEnum).optional(),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
      outputSchema: {
        agents: z.array(AgentListItemPayloadSchema),
      },
    },
    async ({ includeArchived = false, cwd, sinceHours = 48, statuses, limit = 50 }) => {
      const callerCwd = callerAgentId ? resolveCallerAgent()?.cwd : undefined;
      const requestedCwd = cwd?.trim() ? expandUserPath(cwd) : callerCwd;
      const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;
      const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
      const liveSnapshots = agentManager.listAgents();
      const liveAgents = await Promise.all(
        liveSnapshots.map((snapshot) =>
          serializeSnapshotWithMetadata(
            agentStorage,
            snapshot,
            childLogger,
            agentManager.getTimeline(snapshot.id),
          ),
        ),
      );
      const liveIds = new Set(liveSnapshots.map((snapshot) => snapshot.id));
      const storedRecords = await agentStorage.list();
      const registeredProviderIds = new Set(providerSnapshotManager.listRegisteredProviderIds());
      const storedAgents = storedRecords
        .filter((record) => !record.internal && !liveIds.has(record.id))
        .filter((record) => includeArchived || !record.archivedAt)
        .filter(
          (record) =>
            includeArchived || isStoredAgentProviderAvailable(record, registeredProviderIds),
        )
        .map((record) => buildStoredAgentPayload(record, registeredProviderIds));
      const agents = [...liveAgents, ...storedAgents]
        .map(toAgentListItemPayload)
        .filter((agent) => !requestedCwd || isSameOrDescendantPath(requestedCwd, agent.cwd))
        .filter((agent) => !statusFilter || statusFilter.has(agent.status))
        .filter((agent) => !agent.archivedAt || resolveAgentListActivityTime(agent) >= sinceMs)
        .sort(compareAgentListItems)
        .slice(0, limit);

      return {
        content: [],
        structuredContent: ensureValidJson({ agents }),
      };
    },
  );

  registerTool(
    "cancel_agent",
    {
      title: "Cancel agent run",
      description: "Abort the agent's current run but keep the agent alive for future tasks.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      const { cancelled } = await cancelAgentRunCommand(
        { agentManager, logger: childLogger },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ success: cancelled }),
      };
    },
  );

  registerTool(
    "archive_agent",
    {
      title: "Archive agent",
      description:
        "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await archiveAgentCommand(
        {
          agentManager,
          agentStorage,
          logger: childLogger,
        },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "kill_agent",
    {
      title: "Kill agent",
      description: "Terminate an agent session permanently.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await closeAgentCommand({ agentManager }, agentId);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent name, labels, and/or runtime settings.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
        settings: UpdateAgentSettingsInputSchema.optional().describe(
          "Runtime settings to apply to the agent.",
        ),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, name, labels, settings }) => {
      const labelError = validateAgentLabelUpdate(labels);
      if (labelError) {
        throw new Error(labelError);
      }
      if (settings?.modeId !== undefined) {
        await agentManager.setAgentMode(agentId, settings.modeId);
      }
      if (settings?.model !== undefined) {
        await agentManager.setAgentModel(agentId, settings.model);
      }
      if (settings?.thinkingOptionId !== undefined) {
        await agentManager.setAgentThinkingOption(agentId, settings.thinkingOptionId);
      }
      if (settings?.features) {
        for (const [featureId, value] of Object.entries(settings.features)) {
          await agentManager.setAgentFeature(agentId, featureId, value);
        }
      }

      if (name !== undefined || labels !== undefined) {
        const updateResult = await updateAgentCommand({ agentManager }, { agentId, name, labels });
        if (!updateResult.accepted) {
          throw new Error(updateResult.error ?? "Agent update was not accepted");
        }
      }

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "rename_workspace",
    {
      title: "Rename workspace",
      description:
        "Rename a workspace by setting its user-visible title. Omit workspaceId to rename your current workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Workspace id to rename. Omit to rename your current workspace."),
        title: z
          .string()
          .trim()
          .min(1, "title is required")
          .describe("New user-visible workspace title."),
      },
      outputSchema: {
        success: z.boolean(),
        workspaceId: z.string(),
        title: z.string(),
      },
    },
    async ({ workspaceId: requestedWorkspaceId, title }) => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is required to rename workspaces");
      }
      if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
        throw new Error("Workspace update emitter is required to rename workspaces");
      }

      const workspaceId = resolveWorkspaceIdForRename(requestedWorkspaceId);
      const existing = await options.workspaceRegistry.get(workspaceId);
      if (!existing) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }
      if (existing.archivedAt) {
        throw new Error(`Workspace ${workspaceId} is archived`);
      }

      await options.workspaceRegistry.upsert({
        ...existing,
        title,
        updatedAt: new Date().toISOString(),
      });
      await options.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);

      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          workspaceId,
          title,
        }),
      };
    },
  );

  registerTool(
    "list_workspace_scripts",
    {
      title: "List workspace scripts",
      description:
        "List configured workspace scripts and their lifecycle, service port, proxy URL, health, and terminal ID.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID whose configured scripts to list."),
      },
      outputSchema: {
        scripts: z.array(WorkspaceScriptPayloadSchema),
      },
    },
    async ({ workspaceId }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          scripts: await workspaceScripts.list(workspaceId),
        }),
      };
    },
  );

  registerTool(
    "start_workspace_script",
    {
      title: "Start workspace script",
      description:
        "Start one configured workspace script through Paseo's managed workspace-script launcher.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the configured script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to start."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.launch({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "stop_workspace_script",
    {
      title: "Stop workspace script",
      description: "Stop a running workspace script through its supervised terminal lifecycle.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the running script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to stop."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.stop({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "list_terminals",
    {
      title: "List terminals",
      description: "List terminals for a working directory or across all working directories.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        all: z.boolean().optional().describe("List terminals across all working directories."),
      },
      outputSchema: {
        terminals: z.array(TerminalSummarySchema),
      },
    },
    async ({ cwd, all }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminals = all
        ? (
            await Promise.all(
              terminalManager.listDirectories().map(async (directory) =>
                (await terminalManager.getTerminals(directory)).map((terminal) => ({
                  id: terminal.id,
                  name: terminal.name,
                  cwd: terminal.cwd,
                })),
              ),
            )
          ).flat()
        : (await terminalManager.getTerminals(resolveScopedCwd(cwd, { required: true }))).map(
            (terminal) => ({
              id: terminal.id,
              name: terminal.name,
              cwd: terminal.cwd,
            }),
          );

      return {
        content: [],
        structuredContent: ensureValidJson({ terminals }),
      };
    },
  );

  registerTool(
    "create_terminal",
    {
      title: "Create terminal",
      description: "Create a terminal session for a working directory.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        name: z.string().optional().describe("Optional terminal name."),
      },
      outputSchema: TerminalSummarySchema.shape,
    },
    async ({ cwd, name }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const workspaceId = await resolveTerminalWorkspaceId(resolvedCwd);

      const terminal = await terminalManager.createTerminal({
        cwd: resolvedCwd,
        workspaceId,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          id: terminal.id,
          name: terminal.name,
          cwd: terminal.cwd,
        }),
      };
    },
  );

  registerTool(
    "kill_terminal",
    {
      title: "Kill terminal",
      description: "Kill an existing terminal session.",
      inputSchema: {
        terminalId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      terminal.kill();

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "capture_terminal",
    {
      title: "Capture terminal",
      description: "Capture plain-text terminal output lines from a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
        scrollback: z.boolean().optional(),
        stripAnsi: z.boolean().optional().default(true),
      },
      outputSchema: {
        terminalId: z.string(),
        lines: z.array(z.string()),
        totalLines: z.number().int().nonnegative(),
      },
    },
    async ({ terminalId, start, end, scrollback, stripAnsi = true }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      if (!terminalManager.getTerminal(terminalId)) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      const capture = await terminalManager.captureTerminal(terminalId, {
        start: scrollback ? 0 : start,
        end,
        stripAnsi,
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
        }),
      };
    },
  );

  registerTool(
    "send_terminal_keys",
    {
      title: "Send terminal keys",
      description: "Send literal text or special key tokens to a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        keys: z.string(),
        literal: z.boolean().optional(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId, keys, literal = false }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      terminal.send({
        type: "input",
        data: resolveTerminalKeyToken(keys, literal),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description: "Create a recurring schedule that starts a new agent on a cron cadence.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        provider: (callerAgentId ? AgentProviderEnum.optional() : AgentProviderEnum).describe(
          "Provider, or provider/model (for example: codex or codex/gpt-5.4). Defaults to the caller's provider in an agent-scoped session.",
        ),
        cwd: z.string().optional(),
        isolation: z.enum(["local", "worktree"]).optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, provider, cwd, isolation, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: resolveNewAgentScheduleTarget({ provider, cwd, isolation }),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "create_heartbeat",
    {
      title: "Create heartbeat",
      description: "Create a recurring heartbeat that sends you a prompt on a cron cadence.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      if (!callerAgentId) {
        throw new Error("create_heartbeat requires an agent-scoped session");
      }
      resolveCallerAgent();

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: { type: "agent", agentId: callerAgentId },
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "delete_heartbeat",
    {
      title: "Delete heartbeat",
      description: "Delete one of your heartbeats.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: { success: z.boolean() },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireCallerHeartbeat(id);
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "list_schedules",
    {
      title: "List schedules",
      description: "List all schedules managed by the daemon.",
      inputSchema: {},
      outputSchema: {
        schedules: z.array(ScheduleSummarySchema),
      },
    },
    async () => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedules = (await scheduleService.list())
        .filter((schedule) => schedule.target.type === "new-agent")
        .map((schedule) => toScheduleSummary(schedule));
      return {
        content: [],
        structuredContent: ensureValidJson({ schedules }),
      };
    },
  );

  registerTool(
    "inspect_schedule",
    {
      title: "Inspect schedule",
      description: "Inspect a schedule and its run history.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedule = await requireScheduleTarget(id, "new-agent");
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "pause_schedule",
    {
      title: "Pause schedule",
      description: "Pause an active schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.pause(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "resume_schedule",
    {
      title: "Resume schedule",
      description: "Resume a paused schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.resume(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule permanently.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_schedule",
    {
      title: "Update schedule",
      description:
        "Update an existing schedule. Only provided fields are changed; omitted fields remain unchanged.",
      inputSchema: z
        .object({
          id: z.string(),
          cron: z.string().optional().describe("New cron expression."),
          timezone: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "IANA time zone for cron cadence; requires cron. For example: America/New_York.",
            ),
          name: z.string().nullable().optional().describe("New name (null to clear)."),
          prompt: z.string().trim().min(1).optional().describe("New prompt text."),
          maxRuns: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe("New max runs limit (null to clear)."),
          provider: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("New provider for new-agent target."),
          model: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New model for new-agent target (null to clear)."),
          mode: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New mode for new-agent target (null to clear)."),
          cwd: z.string().trim().min(1).optional().describe("New cwd for new-agent target."),
          expiresIn: z
            .string()
            .optional()
            .describe("New relative expiry duration (for example: 1h, 2d)."),
          clearExpires: z.boolean().optional().describe("Clear any schedule expiry."),
        })
        .passthrough(),
      outputSchema: StoredScheduleSchema.shape,
    },
    async (input) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(input.id, "new-agent");
      const schedule = await scheduleService.update(buildScheduleUpdateInput(input));

      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "schedule_logs",
    {
      title: "Schedule logs",
      description: "Get the run history (logs) for a schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        runs: z.array(ScheduleRunSchema),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      const runs = await scheduleService.logs(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ runs }),
      };
    },
  );

  registerTool(
    "run_schedule_once",
    {
      title: "Run schedule once",
      description: "Run a schedule immediately without changing its cron cadence.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireScheduleTarget(id, "new-agent");
      const schedule = await scheduleService.runOnce(id);
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "List configured agent providers, availability, and their modes.",
      inputSchema: {},
      outputSchema: {
        providers: z.array(ProviderSummarySchema),
      },
    },
    async () => {
      const providers = (await providerSnapshotManager.listProviders({ wait: true })).map(
        toProviderSummary,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ providers }),
      };
    },
  );

  registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "List models for an agent provider. For a role-bound Lead, this returns only Human-approved Peer delegation models.",
      inputSchema: {
        provider: AgentProviderEnum,
      },
      outputSchema: {
        provider: z.string(),
        models: z.array(AgentModelSchema),
      },
    },
    async ({ provider }) => {
      const discoveredModels = await providerSnapshotManager.listModels({
        provider,
        wait: true,
      });
      const allowedPeerRoutes = resolvePeerDelegationAllowedRoutes();
      const models =
        allowedPeerRoutes === undefined
          ? discoveredModels
          : discoveredModels.filter((model) =>
              allowedPeerRoutes.some(
                (route) => route.provider === provider && route.model === model.id,
              ),
            );
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider,
          models,
        }),
      };
    },
  );

  registerTool(
    "list_profiles",
    {
      title: "List agent profiles",
      description:
        "List Agent Profiles available for repeated launches. A role-bound Lead sees only " +
        "Human-approved Peer profiles plus providerPriority in highest-first order and the optional " +
        "defaultSubrole. Pass an exact profile id as create_agent.launchProfileId when the task needs " +
        "a specific route, or omit it to let the daemon resolve the configured default subrole. " +
        "Profile peerSubrole, notes, and priority are routing guidance " +
        "only; they cannot grant role, mutation, delegation, plugin, or acceptance authority. " +
        "Returns an empty list when no eligible profiles are configured.",
      inputSchema: {},
      outputSchema: {
        profiles: z.array(AgentProfileSchema),
        providerPriority: z.array(z.string()).optional(),
        defaultSubrole: PeerSubroleSchema.nullable().optional(),
      },
    },
    async () => {
      const config = daemonConfigStore?.get();
      const allProfiles = config?.agentProfiles ?? [];
      const callerAgent = resolveCallerAgent();
      const profileIds = config?.peerDelegationProfileIds;
      let profiles = allProfiles;
      let providerPriority: string[] | undefined;
      let defaultSubrole: PeerSubrole | null | undefined;
      if (callerAgent?.roleBinding?.roleId === "lead" && profileIds !== undefined) {
        defaultSubrole = config?.peerDelegationDefaultSubrole;
        if (config?.peerDelegation?.enabled) {
          const selectedProfiles = selectPeerDelegationProfiles(allProfiles, profileIds);
          providerPriority = resolvePeerDelegationProviderPriority(
            allProfiles,
            profileIds,
            config.peerDelegationProviderPriority,
          );
          profiles = orderPeerDelegationProfiles(selectedProfiles, providerPriority);
        } else {
          profiles = [];
          providerPriority = [];
        }
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          profiles,
          ...(providerPriority !== undefined ? { providerPriority } : {}),
          ...(defaultSubrole !== undefined ? { defaultSubrole } : {}),
        }),
      };
    },
  );

  registerTool(
    "inspect_provider",
    {
      title: "Inspect provider",
      description:
        "Inspect compact provider capabilities for orchestration, including modes and draft feature settings. Use list_models for the full model list.",
      inputSchema: inspectProviderInputSchema,
      outputSchema: {
        provider: AgentProviderEnum,
        label: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        enabled: z.boolean(),
        status: z.string(),
        modes: z.array(ProviderModeSchema).nullish(),
        selectedModel: z.string().nullable(),
        features: z.array(AgentFeatureSchema),
      },
    },
    async ({ provider, cwd, settings }) => {
      const resolvedProviderModel = resolveScheduleProviderAndModel({
        provider,
        defaultProvider: provider,
      });
      const providerId = resolvedProviderModel.provider;
      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const entry = await providerSnapshotManager.getProvider({
        cwd: resolvedCwd,
        provider: providerId,
        wait: true,
      });
      const summary = toProviderSummary(entry);
      if (!entry.enabled) {
        throw new Error(`Provider '${providerId}' is disabled`);
      }
      if (entry.status !== "ready") {
        throw new Error(entry.error ?? `Provider '${providerId}' is unavailable`);
      }
      const selectedModel = settings?.model ?? resolvedProviderModel.model;
      const features = await agentManager.listDraftFeatures({
        provider: providerId,
        cwd: resolvedCwd,
        ...(settings?.modeId ? { modeId: settings.modeId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(settings?.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
        ...(settings?.features ? { featureValues: settings.features } : {}),
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider: providerId,
          label: summary.label,
          description: summary.description,
          enabled: summary.enabled,
          status: summary.status,
          modes: summary.modes,
          selectedModel: selectedModel ?? null,
          features,
        }),
      };
    },
  );

  registerTool(
    "get_agent_activity",
    {
      title: "Get agent activity",
      description: "Return recent agent timeline entries as a curated summary.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      },
    },
    async ({ agentId, limit }) => {
      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        logger: childLogger,
      });
      const timeline = agentManager.getTimeline(agentId);
      const snapshot = agentManager.getAgent(agentId);

      const selection = selectItemsByProjectedLimit({
        items: timeline,
        direction: "tail",
        limit: limit ?? 0,
      });
      const curatedContent = curateAgentActivity(selection.items);
      const { totalProjected, shownProjected } = selection;

      const noun = totalProjected === 1 ? "activity" : "activities";
      const countHeader =
        limit && shownProjected < totalProjected
          ? `Showing ${shownProjected} of ${totalProjected} ${noun} (limited to ${limit})`
          : `Showing all ${totalProjected} ${noun}`;

      const contentWithCount = `${countHeader}\n\n${curatedContent}`;

      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          updateCount: timeline.length,
          currentModeId: snapshot?.currentModeId ?? null,
          content: contentWithCount,
        }),
      };
    },
  );

  registerTool(
    "set_agent_mode",
    {
      title: "Set agent session mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: {
        agentId: z.string(),
        modeId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        newMode: z.string(),
      },
    },
    async ({ agentId, modeId }) => {
      const result = await setAgentModeCommand({ agentManager }, { agentId, modeId });
      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          newMode: result.modeId,
        }),
      };
    },
  );

  registerTool(
    "list_pending_permissions",
    {
      title: "List pending permissions",
      description:
        "Return all pending permission requests across all agents with the normalized payloads.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string(),
            status: AgentStatusEnum,
            request: AgentPermissionRequestPayloadSchema,
          }),
        ),
      },
    },
    async () => {
      const permissions = agentManager.listAgents().flatMap((agent) => {
        const payload = toAgentPayload(agent);
        return payload.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: payload.status,
          request: sanitizePermissionRequest(request),
        }));
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ permissions }),
      };
    },
  );

  registerTool(
    "respond_to_permission",
    {
      title: "Respond to permission",
      description:
        "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, requestId, response }) => {
      await respondToAgentPermission({
        agentManager,
        agentId,
        requestId,
        response,
        logger: childLogger,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  return toCatalog();
}

interface ArchiveWorktreeCommandContext {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager | null;
  logger: Logger;
}

function archiveWorktreeDependencies(
  options: PaseoToolHostDependencies,
  context: ArchiveWorktreeCommandContext,
): ArchiveCommandDependencies {
  if (!options.github) {
    throw new Error("GitHub service is required to archive worktrees");
  }
  if (!options.workspaceGitService) {
    throw new Error("WorkspaceGitService is required to archive worktrees");
  }
  if (!options.archiveWorkspaceRecord) {
    throw new Error("Workspace registry archiver is required to archive worktrees");
  }
  if (!options.findWorkspaceIdForCwd) {
    throw new Error("Workspace resolver is required to archive worktrees");
  }
  if (!options.listActiveWorkspaces) {
    throw new Error("Active workspace lister is required to archive worktrees");
  }
  if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
    throw new Error("Workspace update emitter is required to archive worktrees");
  }
  if (!options.markWorkspaceArchiving) {
    throw new Error("Workspace archiving marker is required to archive worktrees");
  }
  if (!options.clearWorkspaceArchiving) {
    throw new Error("Workspace archiving clearer is required to archive worktrees");
  }
  return {
    paseoHome: options.paseoHome,
    paseoWorktreesBaseRoot: options.worktreesRoot,
    github: options.github,
    workspaceGitService: options.workspaceGitService,
    agentManager: context.agentManager,
    agentStorage: context.agentStorage,
    findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
    listActiveWorkspaces: options.listActiveWorkspaces,
    archiveWorkspaceRecord: options.archiveWorkspaceRecord,
    emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
    markWorkspaceArchiving: options.markWorkspaceArchiving,
    clearWorkspaceArchiving: options.clearWorkspaceArchiving,
    killTerminalsForWorkspace: (workspaceId: string) =>
      killTerminalsForWorkspace(
        {
          terminalManager: context.terminalManager,
          sessionLogger: context.logger,
        },
        workspaceId,
      ),
    sessionLogger: context.logger,
  };
}
