import type { Logger } from "pino";

import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeInput } from "../../paseo-worktree-service.js";
import { expandUserPath, resolvePathFromBase } from "../../path-utils.js";
import { toWorktreeRequestError } from "../../worktree-errors.js";
import type {
  AgentWorktreeSetupContinuation,
  CreatePaseoWorktreeSetupContinuationInput,
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../../worktree-session.js";
import type {
  AgentAttachment,
  AgentProfileLaunchReceipt,
  FirstAgentContext,
  GitSetupOptions,
} from "../../messages.js";
import type { AgentManager, CreateAgentOptions, ManagedAgent } from "../agent-manager.js";
import type { AgentPromptInput, AgentRunOptions, AgentSessionConfig } from "../agent-sdk-types.js";
import type { AgentStorage, FinishNotificationWatch } from "../agent-storage.js";
import type { AgentOwner } from "../agent-owner.js";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";
import type {
  AssignmentAssignerReceipt,
  AssignmentEnvelope,
} from "@getpaseo/protocol/assignment-contract";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { startCreatedAgentInitialPrompt } from "../agent-prompt.js";
import {
  attachFinishNotificationWatch,
  cancelFinishNotificationWatch,
  registerFinishNotificationWatch,
  type FinishNotificationDependencies,
} from "../finish-notification.js";
import { resolveCreateAgentTitles } from "../create-agent-title.js";
import { buildAgentPrompt } from "../prompt-attachments.js";
import { normalizeClientMessageId, resolveClientMessageId } from "../../client-message-id.js";
import { resolveRequiredProviderModel, type ResolvedProviderModel } from "../mcp-shared.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "../timeline-append.js";
import { resolveCreateAgentIntent } from "./intent.js";
import {
  councilLabelKeys,
  validateCouncilSeatBootstrapLabels,
} from "@getpaseo/protocol/council-labels";

export interface CreateAgentSessionWorktreeResult {
  sessionConfig: AgentSessionConfig;
  setupContinuation?: AgentWorktreeSetupContinuation;
  // Set when this build created a fresh worktree workspace. The agent must be
  // stamped with it so workspaceId-scoped archive can find the agent later.
  createdWorkspaceId?: string;
}

export interface CreateAgentCommandDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  paseoHome?: string;
  worktreesRoot?: string;
  terminalManager?: TerminalManager | null;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: EnsureWorkspaceForCreate;
  // Archives a directory workspace minted by ensureWorkspaceForCreate when
  // admission or provider launch fails before an agent exists.
  rollbackWorkspaceAfterFailedCreate?: (workspaceId: string) => Promise<void>;
  rollbackWorktreeAfterFailedCreate?: (
    createdWorktree: CreatePaseoWorktreeWorkflowResult,
  ) => Promise<void>;
  resolveCouncilSeatProjection?: FinishNotificationDependencies["resolveCouncilSeatProjection"];
}

export type EnsureWorkspaceForCreate = (
  cwd: string,
  firstAgentContext?: FirstAgentContext,
) => Promise<string>;

export interface CreateAgentFromSessionInput {
  kind: "session";
  agentId?: string;
  config: AgentSessionConfig;
  workspaceId: string;
  roleId?: PaseoRoleId;
  assignment?: AssignmentEnvelope;
  assignmentAssigner?: AssignmentAssignerReceipt;
  worktreeName?: string;
  initialPrompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  git?: GitSetupOptions;
  labels: Record<string, string>;
  env?: Record<string, string>;
  provisionalTitle: string | null;
  firstAgentContext: FirstAgentContext;
  buildSessionConfig: (
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<CreateAgentSessionWorktreeResult>;
}

export interface CreateAgentFromMcpInput {
  kind: "mcp";
  provider: string;
  roleId?: PaseoRoleId;
  executionProfileId?: string;
  assignment?: AssignmentEnvelope;
  title: string;
  initialPrompt?: string;
  config?: Partial<AgentSessionConfig>;
  cwd?: string;
  workspaceId?: string;
  /**
   * Directory workspace provisioned by the caller before this command ran.
   * The command adopts rollback ownership until an agent is durably created.
   */
  createdDirectoryWorkspaceId?: string;
  launchProfile?: AgentProfileLaunchReceipt;
  thinking?: string;
  features?: Record<string, unknown>;
  labels?: Record<string, string>;
  mode?: string;
  unattended?: boolean;
  promptFailure?: CreateAgentPromptFailureMode;
  background: boolean;
  notifyOnFinish: boolean;
  internal?: boolean;
  detached?: boolean;
  owner?: AgentOwner;
  env?: Record<string, string>;
  onCreated?: (created: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void | Promise<void>;
  onWorktreeCreated?: (createdWorktree: CreatePaseoWorktreeWorkflowResult) => void;
  callerAgentId?: string;
  callerContext?: {
    lockedCwd?: string;
    allowCustomCwd?: boolean;
    childAgentDefaultLabels?: Record<string, string>;
  } | null;
  worktree?: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

export type CreateAgentCommandInput = CreateAgentFromSessionInput | CreateAgentFromMcpInput;
export type CreateAgentPromptFailureMode = "throw" | "log" | "return-error";

export interface CreateAgentCommandResult {
  snapshot: ManagedAgent;
  liveSnapshot: ManagedAgent;
  background: boolean;
  initialPromptStarted: boolean;
  initialPromptError: unknown | null;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

export type BoundCreateAgentCommand = (
  input: CreateAgentCommandInput,
) => Promise<CreateAgentCommandResult>;

function requireResolvedWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new Error("createAgentCommand requires a resolved workspaceId");
  }
  return workspaceId;
}

export function formatProviderModel(provider: string, model: string | null | undefined): string {
  if (!model || provider.includes("/")) {
    return provider;
  }
  return `${provider}/${model}`;
}

function resolveProviderModel(providerValue: string): ResolvedProviderModel {
  const providerInput = providerValue.trim();
  if (providerInput.includes("/")) {
    return resolveRequiredProviderModel(providerInput);
  }
  if (!providerInput) {
    throw new Error("provider is required");
  }
  return { provider: providerInput, model: undefined };
}

interface ResolvedCreateAgent {
  config: AgentSessionConfig;
  createOptions: CreateAgentOptions;
  prompt?: AgentPromptInput;
  runOptions?: AgentRunOptions;
  setupContinuation?: AgentWorktreeSetupContinuation;
  background: boolean;
  promptFailure: CreateAgentPromptFailureMode;
  promptLogger?: Logger;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

interface CreateAgentTransaction {
  createdDirectoryWorkspaceId: string | null;
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
}

function createAgentTransaction(input: CreateAgentCommandInput): CreateAgentTransaction {
  return {
    createdDirectoryWorkspaceId:
      input.kind === "mcp" ? (input.createdDirectoryWorkspaceId ?? null) : null,
    createdWorktree: null,
  };
}

async function rollbackFailedCreate(
  dependencies: CreateAgentCommandDependencies,
  transaction: CreateAgentTransaction,
  createdAgentId: string | null,
): Promise<void> {
  if (createdAgentId) return;

  if (transaction.createdWorktree && dependencies.rollbackWorktreeAfterFailedCreate) {
    await dependencies
      .rollbackWorktreeAfterFailedCreate(transaction.createdWorktree)
      .catch((rollbackError) => {
        dependencies.logger.warn(
          {
            err: rollbackError,
            workspaceId: transaction.createdWorktree?.workspace.workspaceId,
          },
          "Failed to roll back worktree after agent create failed",
        );
      });
  }

  if (transaction.createdDirectoryWorkspaceId && dependencies.rollbackWorkspaceAfterFailedCreate) {
    await dependencies
      .rollbackWorkspaceAfterFailedCreate(transaction.createdDirectoryWorkspaceId)
      .catch((rollbackError) => {
        dependencies.logger.warn(
          {
            err: rollbackError,
            workspaceId: transaction.createdDirectoryWorkspaceId,
          },
          "Failed to roll back directory workspace after agent create failed",
        );
      });
  }
}

export async function createAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<CreateAgentCommandResult> {
  const transaction = createAgentTransaction(input);
  let createdAgentId: string | null = null;
  let finishWatch: FinishNotificationWatch | null = null;
  let finishWatchStop: (() => void) | null = null;
  try {
    assertCouncilCreateAuthority(input);
    preflightRoleCreate(dependencies.agentManager, input);
    const resolved =
      input.kind === "session"
        ? await resolveSessionCreateAgent(dependencies, input)
        : await resolveMcpCreateAgent(dependencies, input, transaction);

    const snapshot = await dependencies.agentManager.createAgent(
      resolved.config,
      input.kind === "session" ? input.agentId : undefined,
      resolved.createOptions,
    );
    createdAgentId = snapshot.id;

    resolved.setupContinuation?.startAfterAgentCreate({
      agentId: snapshot.id,
    });

    // Register the durable finish-notification intent BEFORE the initial
    // prompt is dispatched (not after, as the pre-G1 path did): if the
    // daemon crashes between dispatch and attaching the live watcher, this
    // durable record is the only evidence the intent ever existed for
    // restart recovery to reconcile against.
    const shouldWatchFinish =
      input.kind === "mcp" && Boolean(input.notifyOnFinish) && Boolean(input.callerAgentId);
    const finishNotificationDependencies = {
      agentManager: dependencies.agentManager,
      agentStorage: dependencies.agentStorage,
      logger: dependencies.logger,
      resolveCouncilSeatProjection: dependencies.resolveCouncilSeatProjection,
    };
    if (shouldWatchFinish && input.kind === "mcp" && input.callerAgentId) {
      finishWatch = await registerFinishNotificationWatch(finishNotificationDependencies, {
        childAgentId: snapshot.id,
        callerAgentId: input.callerAgentId,
        requireParentOwnership: true,
      });
      // Subscribe before dispatch so the accepted turn-start state is the
      // first factual run receipt available to this watch. An idle snapshot
      // before that point is intentionally not a finish outcome.
      finishWatchStop = attachFinishNotificationWatch(finishNotificationDependencies, {
        childAgentId: snapshot.id,
        watch: finishWatch,
      });
    }

    let liveSnapshot = snapshot;
    let initialPromptStarted = false;
    let initialPromptError: unknown | null = null;
    if (input.kind === "mcp") {
      await input.onCreated?.({
        agentId: snapshot.id,
        createdWorktree: resolved.createdWorktree ?? null,
      });
    }
    if (resolved.prompt !== undefined) {
      const sendResult = await sendInitialPrompt(dependencies, resolved, snapshot);
      initialPromptStarted = sendResult.started;
      liveSnapshot = sendResult.liveSnapshot;
      initialPromptError = sendResult.error ?? null;
    }

    if (finishWatch && !initialPromptStarted) {
      // The run this watch was for never started: nothing to watch, and
      // leaving it "active" would linger forever in restart resume.
      finishWatchStop?.();
      finishWatchStop = null;
      await cancelFinishNotificationWatch(finishNotificationDependencies, {
        childAgentId: snapshot.id,
        watch: finishWatch,
      });
    }

    return {
      snapshot,
      liveSnapshot,
      background: resolved.background,
      initialPromptStarted,
      initialPromptError,
      ...(resolved.createdWorktree ? { createdWorktree: resolved.createdWorktree } : {}),
    };
  } catch (error) {
    await rollbackFailedCreate(dependencies, transaction, createdAgentId);
    throw error;
  }
}

function preflightRoleCreate(agentManager: AgentManager, input: CreateAgentCommandInput): void {
  if (!input.roleId) return;
  if (input.kind === "session") {
    agentManager.preflightRoleCreate({
      provider: input.config.provider,
      roleId: input.roleId,
      assignment: input.assignment,
      systemPrompt: input.config.systemPrompt ?? undefined,
      ...(!input.worktreeName && !input.git ? { cwd: input.config.cwd } : {}),
    });
    return;
  }
  const parentAgent = input.callerAgentId
    ? requireParentAgent(agentManager, input.callerAgentId)
    : null;
  agentManager.preflightRoleCreate({
    provider: resolveProviderModel(input.provider).provider,
    roleId: input.roleId,
    executionProfileId: input.executionProfileId,
    assignment: input.assignment,
    systemPrompt: input.config?.systemPrompt ?? undefined,
    ...(!input.worktree ? { cwd: resolveMcpInitialCwd(input, parentAgent) } : {}),
  });
}

function assertCouncilCreateAuthority(input: CreateAgentCommandInput): void {
  const labels =
    input.kind === "mcp"
      ? { ...input.callerContext?.childAgentDefaultLabels, ...input.labels }
      : input.labels;
  const validationError = validateCouncilSeatBootstrapLabels(labels);
  if (validationError) {
    throw new Error(validationError);
  }
  if (councilLabelKeys(labels).length === 0) return;
  if (input.kind !== "mcp" || input.roleId !== "peer" || !input.callerAgentId) {
    throw new Error(
      "Council seat labels require an agent-scoped role-bound Peer created by a Lead",
    );
  }
}

function assertCouncilMcpParentAuthority(
  input: CreateAgentFromMcpInput,
  parentAgent: ManagedAgent | null,
): void {
  const labels = { ...input.callerContext?.childAgentDefaultLabels, ...input.labels };
  if (councilLabelKeys(labels).length > 0 && parentAgent?.roleBinding?.roleId !== "lead") {
    throw new Error("Council seat labels may be assigned only by a role-bound Lead");
  }
}

async function resolveSessionCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
): Promise<ResolvedCreateAgent> {
  const trimmedPrompt = input.initialPrompt?.trim();
  const {
    sessionConfig: builtSessionConfig,
    setupContinuation,
    createdWorkspaceId,
  } = await input.buildSessionConfig(
    input.config,
    input.git,
    input.worktreeName,
    input.firstAgentContext,
  );
  // Validate the requested mode against the provider's modes for the resolved
  // cwd. The app remembers mode preferences globally, so a saved mode can be
  // stale for a workspace whose provider config no longer defines it — reject
  // it here instead of letting the provider fail mid-turn.
  //
  // This runs after buildSessionConfig, which may already have created a
  // worktree and/or workspace record — cwd (required to resolve modes) is
  // only known once that step completes. If validation throws, any
  // worktree/workspace buildSessionConfig created is the caller's
  // responsibility to clean up (session.ts's handleCreateAgentRequest does
  // this for the worktree path via cleanupCreatedWorktreeAfterFailedAgentCreate;
  // this is a pre-existing gap for directory-only workspace creates, not
  // introduced by this validation).
  const resolvedCreateConfig = await dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: builtSessionConfig.cwd,
    provider: builtSessionConfig.provider,
    requestedMode: builtSessionConfig.modeId,
    featureValues: builtSessionConfig.featureValues,
    parent: null,
    // Resolve an unattended candidate for standing roles so write-authorized
    // assignments do not stop on provider ceremony. AgentManager then aligns
    // the effective capability with the immutable assignment: no-write is
    // provider-enforced or fails closed. Ordinary interactive sessions keep
    // the provider default unless their caller requests a mode explicitly.
    unattended: input.roleId !== undefined,
  });
  const sessionConfig: AgentSessionConfig = {
    ...builtSessionConfig,
    modeId: resolvedCreateConfig.modeId,
    featureValues: resolvedCreateConfig.featureValues,
  };
  const prompt = buildAgentPrompt(trimmedPrompt ?? "", input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;
  const clientMessageId = normalizeClientMessageId(input.clientMessageId);
  const runOptions: AgentRunOptions | undefined =
    input.outputSchema || clientMessageId
      ? {
          ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        }
      : undefined;
  const workspaceId = setupContinuation ? createdWorkspaceId : input.workspaceId;

  return {
    config: sessionConfig,
    createOptions: {
      labels: input.labels,
      initialPrompt: trimmedPrompt,
      env: input.env,
      initialTitle: input.provisionalTitle,
      // A legacy git/worktreeName worktree creates a fresh workspace, so the
      // agent belongs to that workspace, not the source one. createdWorkspaceId
      // is the freshly created worktree's workspace.
      workspaceId: requireResolvedWorkspaceId(workspaceId),
      roleId: input.roleId,
      assignment: input.assignment,
      assignmentAssigner: input.assignmentAssigner,
    },
    prompt: hasPromptContent ? prompt : undefined,
    runOptions,
    setupContinuation,
    background: true,
    promptFailure: "throw",
    promptLogger: dependencies.logger.child({
      clientMessageId: resolveClientMessageId(input.clientMessageId),
    }),
  };
}

async function resolveMcpCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
  transaction: CreateAgentTransaction,
): Promise<ResolvedCreateAgent> {
  const resolvedProviderModel = resolveProviderModel(input.provider);
  const provider = resolvedProviderModel.provider;
  const parentAgent = resolveMcpParentAgent(dependencies.agentManager, input.callerAgentId);
  assertCouncilMcpParentAuthority(input, parentAgent);
  const cwd = resolveMcpInitialCwd(input, parentAgent);
  const { resolvedCwd, setupContinuation, createdWorkspaceId, createdWorktree } =
    await resolveMcpCwd({
      dependencies,
      cwd,
      worktree: input.worktree,
      title: input.title,
      initialPrompt: input.initialPrompt ?? "",
    });
  recordMcpWorktreeProvision({
    dependencies,
    input,
    transaction,
    provider,
    resolvedCwd,
    createdWorktree,
  });

  const intent = await resolveCreateAgentIntent({
    explicitWorkspaceId: setupContinuation ? createdWorkspaceId : input.workspaceId,
    caller: parentAgent
      ? { id: parentAgent.id, cwd: resolvedCwd, workspaceId: parentAgent.workspaceId }
      : null,
    labels: input.labels,
    childAgentDefaultLabels: input.callerContext?.childAgentDefaultLabels,
    legacyDetached: input.detached ?? false,
    resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: resolvedCwd }),
    createWorkspace: async () => {
      const workspaceId = requireResolvedWorkspaceId(
        await ensureWorkspaceForMcpCreate(
          dependencies,
          resolvedCwd,
          input.title,
          input.initialPrompt ?? "",
        ),
      );
      transaction.createdDirectoryWorkspaceId = workspaceId;
      return { workspaceId, cwd: resolvedCwd };
    },
  });
  const resolvedCreateConfig = await resolveMcpProviderCreateConfig({
    dependencies,
    input,
    provider,
    resolvedCwd,
    parentAgent,
  });

  const trimmedPrompt = input.initialPrompt?.trim() ?? "";
  return {
    config: buildMcpSessionConfig({
      input,
      resolvedProviderModel,
      provider,
      resolvedCwd: intent.cwd,
      trimmedPrompt,
      resolvedMode: resolvedCreateConfig.modeId,
      resolvedFeatures: resolvedCreateConfig.featureValues,
    }),
    createOptions: {
      ...(Object.keys(intent.labels).length > 0 ? { labels: intent.labels } : {}),
      workspaceId: intent.workspaceId,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.launchProfile ? { launchProfile: input.launchProfile } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.roleId
        ? {
            roleId: input.roleId,
            ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
            assignment: input.assignment,
            assignmentAssigner: input.callerAgentId
              ? { kind: "agent", agentId: input.callerAgentId }
              : { kind: "human-session" },
          }
        : {}),
    },
    prompt: trimmedPrompt ? trimmedPrompt : undefined,
    setupContinuation,
    createdWorktree,
    background: input.background,
    promptFailure: input.promptFailure ?? "log",
  };
}

function resolveMcpParentAgent(
  agentManager: AgentManager,
  callerAgentId: string | undefined,
): ManagedAgent | null {
  return callerAgentId ? requireParentAgent(agentManager, callerAgentId) : null;
}

function recordMcpWorktreeProvision(input: {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  transaction: CreateAgentTransaction;
  provider: string;
  resolvedCwd: string;
  createdWorktree: CreatePaseoWorktreeWorkflowResult | undefined;
}): void {
  input.transaction.createdWorktree = input.createdWorktree ?? null;
  if (input.createdWorktree) input.input.onWorktreeCreated?.(input.createdWorktree);
  if (!input.input.roleId || !input.createdWorktree) return;
  input.dependencies.agentManager.preflightRoleCreate({
    provider: input.provider,
    roleId: input.input.roleId,
    executionProfileId: input.input.executionProfileId,
    assignment: input.input.assignment,
    systemPrompt: input.input.config?.systemPrompt ?? undefined,
    cwd: input.resolvedCwd,
  });
}

function resolveMcpInitialCwd(
  input: CreateAgentFromMcpInput,
  parentAgent: ManagedAgent | null,
): string {
  if (!parentAgent) {
    return expandUserPath(input.cwd ?? process.cwd());
  }
  return resolveChildAgentCwd({
    parentCwd: parentAgent.cwd,
    requestedCwd: input.cwd,
    lockedCwd: input.callerContext?.lockedCwd,
    allowCustomCwd: input.callerContext?.allowCustomCwd ?? true,
  });
}

async function resolveMcpProviderCreateConfig(params: {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  provider: string;
  resolvedCwd: string;
  parentAgent: ManagedAgent | null;
}): Promise<{ modeId?: string; featureValues?: Record<string, unknown> }> {
  const passthroughConfig = params.input.config;
  return params.dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: params.resolvedCwd,
    provider: params.provider,
    requestedMode: params.input.mode ?? passthroughConfig?.modeId,
    featureValues: params.input.features ?? passthroughConfig?.featureValues,
    parent: params.parentAgent,
    // A role-bound child must not silently fall back to an approval-bearing
    // provider default when a caller omits `unattended`. Explicit mode remains
    // authoritative inside the bounded assignment.
    unattended: params.input.unattended ?? params.input.roleId !== undefined,
  });
}

function buildMcpSessionConfig(params: {
  input: CreateAgentFromMcpInput;
  resolvedProviderModel: ResolvedProviderModel;
  provider: string;
  resolvedCwd: string;
  trimmedPrompt: string;
  resolvedMode?: string;
  resolvedFeatures?: Record<string, unknown>;
}): AgentSessionConfig {
  const passthroughConfig = params.input.config;
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: passthroughConfig?.title ?? params.input.title,
    initialPrompt: params.trimmedPrompt,
  });
  const featureValues = params.resolvedFeatures ?? passthroughConfig?.featureValues;
  const config: AgentSessionConfig = {
    ...passthroughConfig,
    provider: params.provider,
    cwd: params.resolvedCwd,
    modeId: params.resolvedMode ?? passthroughConfig?.modeId,
    model: params.resolvedProviderModel.model ?? passthroughConfig?.model,
    thinkingOptionId: params.input.thinking ?? passthroughConfig?.thinkingOptionId,
    internal: params.input.internal ?? passthroughConfig?.internal,
  };
  if (provisionalTitle) {
    config.title = provisionalTitle;
  }
  if (featureValues) {
    config.featureValues = featureValues;
  }
  return config;
}

async function ensureWorkspaceForMcpCreate(
  dependencies: CreateAgentCommandDependencies,
  cwd: string,
  title: string,
  initialPrompt: string,
): Promise<string | undefined> {
  if (!dependencies.ensureWorkspaceForCreate) {
    return undefined;
  }
  return dependencies.ensureWorkspaceForCreate(cwd, { title, prompt: initialPrompt });
}

async function sendInitialPrompt(
  dependencies: CreateAgentCommandDependencies,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
): Promise<{ started: boolean; liveSnapshot: ManagedAgent; error?: unknown }> {
  try {
    const prompt = resolved.prompt;
    if (prompt === undefined) {
      return { started: false, liveSnapshot: snapshot };
    }
    const liveSnapshot = await startCreatedAgentInitialPrompt({
      agentManager: dependencies.agentManager,
      agentId: snapshot.id,
      snapshot,
      prompt,
      runOptions: resolved.runOptions,
      logger: resolved.promptLogger ?? dependencies.logger,
    });
    return { started: true, liveSnapshot };
  } catch (error) {
    if (resolved.promptFailure === "throw") {
      throw error;
    }
    if (resolved.promptFailure === "return-error") {
      return { started: false, liveSnapshot: snapshot, error };
    }
    dependencies.logger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
    return { started: false, liveSnapshot: snapshot };
  }
}

function requireParentAgent(agentManager: AgentManager, parentAgentId: string): ManagedAgent {
  const parentAgent = agentManager.getAgent(parentAgentId);
  if (!parentAgent) {
    throw new Error(`Parent agent ${parentAgentId} not found`);
  }
  return parentAgent;
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

async function resolveMcpCwd(params: {
  dependencies: CreateAgentCommandDependencies;
  cwd: string;
  title: string;
  initialPrompt: string;
  worktree: CreateAgentFromMcpInput["worktree"];
}): Promise<{
  resolvedCwd: string;
  setupContinuation?: AgentWorktreeSetupContinuation;
  createdWorkspaceId?: string;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}> {
  const { dependencies, worktree } = params;
  if (!worktree) {
    return { resolvedCwd: params.cwd };
  }
  const shouldCreateWorktree = Boolean(
    worktree.worktreeName || worktree.refName || worktree.action || worktree.githubPrNumber,
  );
  if (!shouldCreateWorktree) {
    return { resolvedCwd: params.cwd };
  }
  if (
    worktree.worktreeName &&
    !worktree.baseBranch &&
    !worktree.refName &&
    !worktree.action &&
    worktree.githubPrNumber === undefined
  ) {
    throw new Error("baseBranch is required when creating a worktree");
  }
  const baseBranch = worktree.baseBranch;
  const createdWorktree = await createMcpWorktree({
    input: {
      cwd: params.cwd,
      worktreeSlug: worktree.worktreeName,
      branchName: worktree.branchName,
      refName: worktree.refName,
      action: worktree.action,
      githubPrNumber: worktree.githubPrNumber,
      firstAgentContext: { title: params.title, prompt: params.initialPrompt },
      runSetup: false,
      paseoHome: dependencies.paseoHome,
      worktreesRoot: dependencies.worktreesRoot,
    },
    createPaseoWorktree: dependencies.createPaseoWorktree,
    resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
    setupContinuation: {
      kind: "agent",
      terminalManager: dependencies.terminalManager ?? null,
      appendTimelineItem: ({ agentId, item }) =>
        appendTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      emitLiveTimelineItem: ({ agentId, item }) =>
        emitLiveTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      logger: dependencies.logger,
    },
  });
  return {
    resolvedCwd: createdWorktree.workspace.cwd,
    setupContinuation: createdWorktree.setupContinuation,
    createdWorkspaceId: createdWorktree.workspace.workspaceId,
    createdWorktree,
  };
}

interface CreateMcpWorktreeOptions {
  input: CreatePaseoWorktreeInput;
  createPaseoWorktree: CreatePaseoWorktreeWorkflowFn | undefined;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
}

async function createMcpWorktree(
  options: CreateMcpWorktreeOptions,
): Promise<CreatePaseoWorktreeWorkflowResult> {
  try {
    if (!options.createPaseoWorktree) {
      throw new Error("Paseo worktree service is not configured");
    }
    return await options.createPaseoWorktree(options.input, {
      ...(options.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      ...(options.setupContinuation ? { setupContinuation: options.setupContinuation } : {}),
    });
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}
