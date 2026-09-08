import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterAll, describe, expect, test } from "vitest";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { BeadsIssue } from "@getpaseo/protocol/beads/rpc-schemas";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import type { CouncilCaseRecord } from "@getpaseo/protocol/council/types";
import {
  SupervisorNotebookRecordSchema,
  serializeSupervisorNotebookRecord,
} from "@getpaseo/protocol/notebook-record";
import { AgentManager, type ManagedAgent } from "../agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "../agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentTimelineItem,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  ProviderCatalog,
  ProviderLaunchBinding,
} from "../agent-sdk-types.js";
import type { AgentTimelineFetchResult, AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { BeadsService } from "../../beads/beads-service.js";
import type { CouncilCaseStore } from "../../council/council-case-store.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import {
  createDefaultSlpBundledPolicyRegistry,
  type SlpBundledPolicyContribution,
} from "../../policy/bundled/slp.js";
import { materializeTrustedRoleBinding } from "../../policy/trusted-policy.js";
import { createProjectHarnessBindingService } from "../../project/harness-binding-service.js";
import { buildWorkspaceProtocolTemplate } from "../../../utils/workspace-protocol-file.js";
import type { PersistedRoleBinding } from "../role-binding.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { PaseoToolCatalog } from "./types.js";

const ISSUE_ID = "checkpoint-issue";
const CALLER_ID = "00000000-0000-4000-8000-000000000301";
const TARGET_ID = "00000000-0000-4000-8000-000000000302";
const BINDING_CWD = mkdtempSync(join(tmpdir(), "paseo-production-checkpoint-binding-"));
writeFileSync(
  join(BINDING_CWD, "WORKSPACE_PROTOCOL.md"),
  buildWorkspaceProtocolTemplate(BINDING_CWD),
  "utf8",
);
afterAll(() => rmSync(BINDING_CWD, { recursive: true, force: true }));

const ISSUE: BeadsIssue = {
  id: ISSUE_ID,
  title: "Checkpoint issue",
  status: "closed",
  priority: 2,
  issue_type: "task",
  assignee: "paseo-agent-peer-checkpoint",
  dependency_count: 23,
};

function assignment(
  role: "lead" | "peer",
  effectClass: AssignmentEnvelope["effectClass"],
): AssignmentEnvelope {
  return {
    version: 1,
    disposition: role === "lead" ? "lead-direct" : "peer-execution",
    objective: "Exercise the production checkpoint entrypoint.",
    effectClass,
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary:
      role === "lead" && effectClass !== "read-only"
        ? {
            mode: "bounded",
            scope:
              "Beads Central issue/work graph for this assignment only; no other external effects",
          }
        : { mode: "denied" },
    ...(role === "peer" ? { resourceGrants: { beadsIssueIds: [ISSUE_ID] } } : {}),
    evidence: "Return exact checkpoint evidence.",
    handbackAndStop: "Stop after the bounded checkpoint receipt.",
  };
}

async function makeBinding(
  role: "lead" | "peer",
  effectClass: AssignmentEnvelope["effectClass"],
  cwd = BINDING_CWD,
): Promise<{ binding: PersistedRoleBinding; contribution: SlpBundledPolicyContribution }> {
  const registry = createDefaultSlpBundledPolicyRegistry();
  const generation = registry.resolveActive("slp");
  const resolveHarnessBinding = createProjectHarnessBindingService({
    workspaceRegistry: {
      get: async (workspaceId) =>
        ({
          workspaceId,
          projectId: "project-1",
          cwd: BINDING_CWD,
          archivedAt: null,
        }) as never,
    },
    projectRegistry: {
      get: async (projectId) => ({ projectId, rootPath: BINDING_CWD, archivedAt: null }) as never,
      list: async () =>
        [{ projectId: "project-1", rootPath: BINDING_CWD, archivedAt: null }] as never,
    },
  });
  const binding = await materializeTrustedRoleBinding(generation, {
    roleId: role,
    provider: "codex",
    providerSupport: {
      status: "supported",
      injectionMethod: "mock-launch-context",
    },
    cwd,
    workspaceId: "workspace-1",
    assignment: assignment(role, effectClass),
    assignmentAssigner: { kind: "human-session" },
    agentId: role === "lead" ? CALLER_ID : TARGET_ID,
    resolveHarnessBinding,
  });
  return { binding, contribution: generation.contribution };
}

function storedRecord(
  id: string,
  roleBinding: PersistedRoleBinding,
  labels: Record<string, string> = {},
  cwd = BINDING_CWD,
  coordinationSignals: StoredAgentRecord["coordinationSignals"] = [],
): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd,
    workspaceId: "workspace-1",
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
    labels,
    lastStatus: "idle",
    config: null,
    persistence: null,
    roleBinding,
    coordinationSignals,
  } as StoredAgentRecord;
}

function liveRecord(record: StoredAgentRecord): ManagedAgent {
  return {
    ...record,
    provider: "codex",
    config: { provider: "codex", cwd: "/repo" },
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    lifecycle: "idle",
    capabilities: {} as never,
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    session: {} as never,
  } as ManagedAgent;
}

function timelineRow(seq: number, timestamp: string, item: AgentTimelineItem): AgentTimelineRow {
  return { seq, timestamp, item };
}

class CheckpointStorage {
  constructor(readonly records: Map<string, StoredAgentRecord>) {}

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.records.get(agentId) ?? null;
  }

  async list(): Promise<StoredAgentRecord[]> {
    return [...this.records.values()];
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async setBeadsStatusCheckpoint(
    agentId: string,
    checkpoint: StoredAgentRecord["beadsStatusCheckpoint"] | null,
  ): Promise<void> {
    const existing = this.records.get(agentId);
    if (!existing) throw new Error(`Agent ${agentId} not found`);
    const next = { ...existing };
    if (checkpoint) {
      next.beadsStatusCheckpoint = checkpoint;
    } else {
      delete next.beadsStatusCheckpoint;
    }
    this.records.set(agentId, next);
  }
}

class CheckpointManager {
  failCheckpointResolution = false;
  timelineFetches = 0;

  constructor(
    private readonly records: Map<string, StoredAgentRecord>,
    private readonly contribution: SlpBundledPolicyContribution,
    private readonly timelineRows: readonly AgentTimelineRow[] = [],
  ) {}

  getRoleBindingForToolCatalog(agentId: string): PersistedRoleBinding | undefined {
    return this.records.get(agentId)?.roleBinding;
  }

  getAgent(agentId: string): ManagedAgent | null {
    const record = this.records.get(agentId);
    return record ? liveRecord(record) : null;
  }

  async fetchDurableTimeline(
    agentId: string,
    options?: { direction?: "tail" | "before" | "after"; limit?: number },
  ): Promise<AgentTimelineFetchResult> {
    this.timelineFetches += 1;
    const limit = options?.limit ?? this.timelineRows.length;
    const rows = this.timelineRows.slice(-limit);
    return {
      epoch: "checkpoint-test-epoch",
      direction: options?.direction ?? "tail",
      reset: false,
      staleCursor: false,
      gap: false,
      window: {
        minSeq: this.timelineRows[0]?.seq ?? 0,
        maxSeq: this.timelineRows.at(-1)?.seq ?? 0,
        nextSeq: (this.timelineRows.at(-1)?.seq ?? 0) + 1,
      },
      hasOlder: rows.length < this.timelineRows.length,
      hasNewer: false,
      rows: agentId === TARGET_ID ? [...rows] : [],
    };
  }

  listAgents(): ManagedAgent[] {
    return [...this.records.values()].map(liveRecord);
  }

  resolveSlpPolicyForRoleBinding(): SlpBundledPolicyContribution {
    if (this.failCheckpointResolution) {
      throw new Error("pinned SLP generation details must not cross the tool boundary");
    }
    return this.contribution;
  }

  resolveActiveSlpPolicy(): SlpBundledPolicyContribution {
    return this.contribution;
  }
}

const CHECKPOINT_AGENT_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsNativePaseoTools: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class CheckpointSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CHECKPOINT_AGENT_CAPABILITIES;
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    return { turnId: `checkpoint-turn-${this.id}` };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => {};
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: this.provider, sessionId: this.id, model: "gpt-5.4" };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(_modeId: string): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class CheckpointClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CHECKPOINT_AGENT_CAPABILITIES;
  private sessionCounter = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(
    _config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.sessionCounter += 1;
    return new CheckpointSession(`checkpoint-session-${this.sessionCounter}`);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.sessionCounter += 1;
    return new CheckpointSession(`checkpoint-session-${this.sessionCounter}`);
  }

  async materializeProviderLaunchBinding(input: {
    config: AgentSessionConfig;
    requestedModel?: string;
  }): Promise<ProviderLaunchBinding> {
    return {
      providerId: this.provider,
      providerFamily: this.provider,
      model: input.requestedModel ?? input.config.model ?? "gpt-5.4",
      credentialConfigured: true,
      routeKind: "codex-subscription",
      modelProviderId: "openai",
      authMethod: "codex-native",
    };
  }

  async fetchCatalog(): Promise<ProviderCatalog> {
    return {
      models: [{ provider: this.provider, id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
      modes: [],
    };
  }
}

function workspaceRegistry(workspaceCwd = BINDING_CWD): Pick<WorkspaceRegistry, "get"> {
  return {
    get: async (workspaceId) =>
      workspaceId === "workspace-1"
        ? ({
            workspaceId,
            projectId: "project-1",
            cwd: workspaceCwd,
            kind: "directory",
            displayName: "Checkpoint workspace",
            title: null,
            branch: null,
            worktreeRoot: null,
            baseBranch: null,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
            createdAt: "2026-09-06T10:00:00.000Z",
            updatedAt: "2026-09-06T10:00:00.000Z",
            archivedAt: null,
          } as never)
        : null,
  };
}

function councilCase(targetAgentId: string, disposition = "completed"): CouncilCaseRecord {
  const reportReceipt = {
    roomId: "room-1",
    kickoffMessageId: "kickoff-1",
    reportMessageId: "report-1",
    reportDigest: "a".repeat(64),
    authorAgentId: targetAgentId,
    startSentinel: "BEGIN REPORT",
    endSentinel: "END REPORT",
    createdAt: "2026-09-06T11:00:00.000Z",
  };
  return {
    schemaVersion: 1,
    id: "case-1",
    title: "Checkpoint council",
    question: "Is the bounded work ready?",
    tier: "debate",
    phase: "verdict",
    roomId: "room-1",
    kickoffMessageId: "kickoff-1",
    scopeId: "scope-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    parentAgentId: CALLER_ID,
    seats: [
      {
        role: "architect",
        round: "round-1",
        agentId: targetAgentId,
        phase: "verdict",
        integrity: "valid",
        disposition,
        reportReceipt,
        createdAt: "2026-09-06T10:00:00.000Z",
        updatedAt: "2026-09-06T11:00:00.000Z",
      },
    ],
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T11:00:00.000Z",
  };
}

async function createCheckpointCatalog(input?: {
  includeUnrelated?: boolean;
  includeCouncil?: boolean;
  timelineRows?: readonly AgentTimelineRow[];
  includeBeadsStatusCheckpoint?: boolean;
  workspaceCwd?: string;
  projectRoot?: string;
  targetCwd?: string;
  coordinationSignals?: StoredAgentRecord["coordinationSignals"];
  councilSeatDisposition?: string;
  registeredProjects?: readonly {
    projectId: string;
    rootPath: string;
    archivedAt: null;
  }[];
}) {
  const { binding: callerBinding, contribution } = await makeBinding("lead", "delegation");
  const { binding: targetBinding } = await makeBinding("peer", "read-only", input?.targetCwd);
  const records = new Map<string, StoredAgentRecord>([
    [CALLER_ID, storedRecord(CALLER_ID, callerBinding)],
    [
      TARGET_ID,
      storedRecord(
        TARGET_ID,
        targetBinding,
        {
          [PARENT_AGENT_ID_LABEL]: CALLER_ID,
        },
        input?.targetCwd,
        input?.coordinationSignals,
      ),
    ],
  ]);
  if (input?.includeUnrelated) {
    const { binding: unrelatedBinding } = await makeBinding("peer", "read-only");
    records.set("unrelated-peer", storedRecord("unrelated-peer", unrelatedBinding));
  }
  const storage = new CheckpointStorage(records);
  if (input?.includeBeadsStatusCheckpoint) {
    await storage.setBeadsStatusCheckpoint(CALLER_ID, {
      assignmentDigest: callerBinding.assignmentContract!.receipt.assignmentDigest,
      version: "1.2.0",
      checkedAt: "2026-09-06T10:30:00.000Z",
    });
  }
  const manager = new CheckpointManager(records, contribution, input?.timelineRows);
  const councilStore =
    input?.includeCouncil === false
      ? null
      : {
          list: async () => [councilCase(TARGET_ID, input?.councilSeatDisposition)],
        };
  const beadsService = {
    status: async () => ({ available: true, version: "1.2.0" }),
    get: async () => ISSUE,
  } as unknown as BeadsService;
  const catalog = createPaseoToolCatalog({
    agentManager: manager as unknown as AgentManager,
    agentStorage: storage as unknown as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    callerAgentId: CALLER_ID,
    paseoToolPolicy: {
      enabled: true,
      allowedTools: ["beads_status", "get_agent_checkpoint"],
    },
    beadsService,
    workspaceRegistry: workspaceRegistry(input?.workspaceCwd),
    projectRegistry: {
      get: async (projectId) =>
        ({
          projectId,
          rootPath: input?.projectRoot ?? BINDING_CWD,
          archivedAt: null,
        }) as never,
      list: async () =>
        (input?.registeredProjects ?? [
          { projectId: "project-1", rootPath: input?.projectRoot ?? BINDING_CWD, archivedAt: null },
        ]) as never,
    },
    councilCaseStore: councilStore as unknown as Pick<CouncilCaseStore, "list">,
    logger: pino({ level: "silent" }),
  });
  return {
    catalog,
    manager,
    assignmentDigest: targetBinding.assignmentContract!.receipt.assignmentDigest,
  };
}

function nativeEpisodeRequest(assignmentDigest: string, episodeId = "episode-native-1") {
  return {
    episodeId,
    projectId: "project-1",
    assignmentDigest,
    issueId: ISSUE_ID,
    objective: "Exercise the production checkpoint entrypoint.",
    window: {
      from: "2026-09-06T11:00:00.000Z",
      to: "2026-09-06T11:10:00.000Z",
      maxActivityItems: 10,
    },
  };
}

function pendingCandidateSignal(
  reason: string,
): NonNullable<StoredAgentRecord["coordinationSignals"]>[number] {
  return {
    id: "signal-candidate-narrative",
    targetAgentId: TARGET_ID,
    requestedByAgentId: CALLER_ID,
    workspaceId: "workspace-1",
    kind: "continuity_attention",
    reason,
    evidenceRefs: [],
    status: "pending",
    createdAt: "2026-09-06T11:00:00.000Z",
    deliveredAt: null,
    resolvedAt: null,
  };
}

describe("production get_agent_checkpoint tool", () => {
  test("is reachable through a real AgentManager role-bound catalog", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "paseo-production-checkpoint-manager-"));
    const logger = pino({ level: "silent" });
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    await storage.initialize();
    writeFileSync(
      join(workdir, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(workdir),
      "utf8",
    );
    const policyRegistry = createDefaultSlpBundledPolicyRegistry();
    const resolveHarnessBinding = createProjectHarnessBindingService({
      workspaceRegistry: {
        get: async (workspaceId) =>
          ({
            workspaceId,
            projectId: "project-checkpoint-manager",
            cwd: workdir,
            archivedAt: null,
          }) as never,
      },
      projectRegistry: {
        get: async (projectId) => ({ projectId, rootPath: workdir, archivedAt: null }) as never,
        list: async () =>
          [
            { projectId: "project-checkpoint-manager", rootPath: workdir, archivedAt: null },
          ] as never,
      },
    });
    const manager = new AgentManager({
      clients: { codex: new CheckpointClient() },
      bundledPolicyPacks: policyRegistry,
      registry: storage,
      resolveHarnessBinding,
      logger,
    });
    let catalog!: PaseoToolCatalog;
    try {
      await manager.createAgent({ provider: "codex", cwd: workdir, model: "gpt-5.4" }, CALLER_ID, {
        workspaceId: "workspace-1",
        roleId: "lead",
        assignment: assignment("lead", "delegation"),
      });
      await manager.createAgent({ provider: "codex", cwd: workdir, model: "gpt-5.4" }, TARGET_ID, {
        workspaceId: "workspace-1",
        roleId: "peer",
        assignment: assignment("peer", "read-only"),
        labels: { [PARENT_AGENT_ID_LABEL]: CALLER_ID },
      });

      const beadsGet = async (_project: unknown, issueId: string): Promise<BeadsIssue> => {
        expect(issueId).toBe(ISSUE_ID);
        return ISSUE;
      };
      catalog = createPaseoToolCatalog({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager: {} as ProviderSnapshotManager,
        callerAgentId: CALLER_ID,
        paseoToolPolicy: {
          enabled: true,
          allowedTools: ["beads_status", "get_agent_checkpoint"],
        },
        beadsService: {
          status: async () => ({ available: true, version: "1.2.0" }),
          get: beadsGet,
        } as unknown as BeadsService,
        workspaceRegistry: workspaceRegistry(),
        councilCaseStore: { list: async () => [councilCase(TARGET_ID)] } as unknown as Pick<
          CouncilCaseStore,
          "list"
        >,
        logger,
      });

      await catalog.executeTool("beads_status", {});
      const result = await catalog.executeTool("get_agent_checkpoint", { agentId: TARGET_ID });
      expect(result.structuredContent).toMatchObject({
        checkpoint: {
          agentId: TARGET_ID,
          disposition: "no-outstanding-dependency",
          evidence: expect.arrayContaining([
            expect.objectContaining({ kind: "council", pointer: "report-1" }),
            expect.objectContaining({ kind: "beads", pointer: ISSUE_ID }),
          ]),
        },
      });
    } finally {
      await manager.closeAgent(TARGET_ID).catch(() => undefined);
      await manager.closeAgent(CALLER_ID).catch(() => undefined);
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("projects canonical Council and target-bound Beads evidence through the catalog", async () => {
    const { catalog } = await createCheckpointCatalog();

    await catalog.executeTool("beads_status", {});
    const result = await catalog.executeTool("get_agent_checkpoint", { agentId: TARGET_ID });
    expect(result.structuredContent).toMatchObject({
      checkpoint: {
        agentId: TARGET_ID,
        disposition: "no-outstanding-dependency",
        waitingOn: [],
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: "council", pointer: "report-1" }),
          expect.objectContaining({ kind: "beads", pointer: ISSUE_ID }),
        ]),
      },
    });
    const checkpoint = (result.structuredContent as { checkpoint: { evidence: unknown[] } })
      .checkpoint;
    const beadsEvidence = checkpoint.evidence.find(
      (entry) => (entry as { kind?: string }).kind === "beads",
    ) as { summary: string } | undefined;
    expect(beadsEvidence?.summary).toContain("openDependencies=unknown");
    expect(beadsEvidence?.summary).not.toContain("openDependencies=23");
  });

  test("does not expose evidence for an unrelated target", async () => {
    const { catalog } = await createCheckpointCatalog({ includeUnrelated: true });

    await catalog.executeTool("beads_status", {});
    const result = await catalog.executeTool("get_agent_checkpoint", {
      agentId: "unrelated-peer",
    });
    expect(result.structuredContent).toMatchObject({
      checkpoint: {
        agentId: "unrelated-peer",
        disposition: "unauthorized",
        waitingOn: [],
        evidence: [],
      },
    });
  });

  test("fails closed without disclosing an unavailable pinned generation", async () => {
    const { catalog, manager } = await createCheckpointCatalog({ includeCouncil: false });
    manager.failCheckpointResolution = true;

    await catalog.executeTool("beads_status", {});
    await expect(
      catalog.executeTool("get_agent_checkpoint", { agentId: TARGET_ID }),
    ).rejects.toThrow("checkpoint_policy_generation_unavailable");
  });

  test("does not read target-bound Beads evidence without a current status checkpoint", async () => {
    const { catalog } = await createCheckpointCatalog();

    const result = await catalog.executeTool("get_agent_checkpoint", { agentId: TARGET_ID });
    expect(result.structuredContent).toMatchObject({
      checkpoint: {
        disposition: "unknown",
        evidence: expect.not.arrayContaining([expect.objectContaining({ kind: "beads" })]),
        unknowns: expect.arrayContaining([expect.stringContaining("beads_inaccessible")]),
      },
    });
  });

  test("keeps an authored candidate mention as a claim through the native adapter", async () => {
    const { catalog, manager, assignmentDigest } = await createCheckpointCatalog({
      includeBeadsStatusCheckpoint: true,
      timelineRows: [
        timelineRow(1, "2026-09-06T11:01:00.000Z", {
          type: "user_message",
          text: "Use candidate-good for this bounded episode.",
        }),
        timelineRow(2, "2026-09-06T11:02:00.000Z", {
          type: "tool_call",
          callId: "call-test-1",
          name: "run_command",
          status: "completed",
          error: null,
          detail: {
            type: "shell",
            command:
              "npm run test -- packages/server/src/server/agent/agent-episode-report.test.ts",
            cwd: BINDING_CWD,
            output: "passed",
            exitCode: 0,
          },
        }),
      ],
    });

    await catalog.executeTool("beads_status", {});
    const result = await catalog.executeTool("get_agent_checkpoint", {
      agentId: TARGET_ID,
      report: {
        episodeId: "episode-checkpoint-1",
        projectId: "project-1",
        assignmentDigest,
        issueId: ISSUE_ID,
        objective: "Exercise the production checkpoint entrypoint.",
        window: {
          from: "2026-09-06T11:00:00.000Z",
          to: "2026-09-06T11:10:00.000Z",
          maxActivityItems: 10,
        },
        candidate: {
          ref: "candidate-good",
          evidenceRefs: ["timeline:1"],
        },
      },
    });

    expect(manager.timelineFetches).toBe(1);
    expect(result.structuredContent).toMatchObject({
      checkpoint: { agentId: TARGET_ID },
      episodeReport: {
        status: "reportable",
        lineage: {
          project: { status: "present", observed: "project-1" },
          assignment: { status: "wired", observed: assignmentDigest },
          issue: { status: "present", observed: ISSUE_ID },
          candidate: { status: "unknown", observed: "candidate-good" },
          evidence: { status: "present" },
        },
        dimensions: {
          wiring: { status: "wired" },
          activity: { status: "exercised" },
          testPass: { status: "exercised" },
          leadAcceptance: { status: "unobserved" },
          laterEffect: { status: "unknown" },
          outcome: { status: "unknown" },
        },
        authority: {
          reportMayGrantWriter: false,
          reportMayMutateBeads: false,
          reportMayAccept: false,
          reportMayPromoteRule: false,
        },
      },
    });
  });

  test("preserves an exact typed checkpoint receipt as native candidate evidence", async () => {
    const { catalog, manager, assignmentDigest } = await createCheckpointCatalog({
      includeBeadsStatusCheckpoint: true,
    });

    await catalog.executeTool("beads_status", {});
    const result = await catalog.executeTool("get_agent_checkpoint", {
      agentId: TARGET_ID,
      report: {
        ...nativeEpisodeRequest(assignmentDigest),
        candidate: { ref: assignmentDigest, digest: assignmentDigest },
      },
    });

    expect(manager.timelineFetches).toBe(1);
    expect(result.structuredContent).toMatchObject({
      checkpoint: { agentId: TARGET_ID },
      episodeReport: {
        status: "reportable",
        lineage: {
          candidate: {
            status: "present",
            observed: assignmentDigest,
            sourceFacts: expect.arrayContaining([
              expect.objectContaining({
                pointer: `checkpoint:assignment:${assignmentDigest}`,
                sourceClass: "source-fact",
              }),
            ]),
          },
        },
      },
    });
  });

  test("does not promote a pending coordination signal narrative to candidate evidence", async () => {
    const digest = "d".repeat(64);
    const { catalog, manager, assignmentDigest } = await createCheckpointCatalog({
      includeBeadsStatusCheckpoint: true,
      includeCouncil: false,
      coordinationSignals: [pendingCandidateSignal(`candidate-good ${digest}`)],
    });

    await catalog.executeTool("beads_status", {});
    const result = await catalog.executeTool("get_agent_checkpoint", {
      agentId: TARGET_ID,
      report: {
        ...nativeEpisodeRequest(assignmentDigest),
        candidate: { ref: "candidate-good", digest },
      },
    });

    expect(manager.timelineFetches).toBe(1);
    expect(result.structuredContent).toMatchObject({
      episodeReport: {
        lineage: {
          candidate: {
            status: "unknown",
            observed: null,
            sourceFacts: [],
            claims: expect.arrayContaining([
              expect.objectContaining({
                pointer: "checkpoint:coordination-signal:signal-candidate-narrative",
                sourceClass: "agent-claim",
              }),
            ]),
          },
        },
      },
    });
  });

  test("does not promote a Council disposition narrative to candidate evidence", async () => {
    const digest = "e".repeat(64);
    const { catalog, manager, assignmentDigest } = await createCheckpointCatalog({
      includeBeadsStatusCheckpoint: true,
      councilSeatDisposition: `candidate-good ${digest}`,
    });

    await catalog.executeTool("beads_status", {});
    const result = await catalog.executeTool("get_agent_checkpoint", {
      agentId: TARGET_ID,
      report: {
        ...nativeEpisodeRequest(assignmentDigest),
        candidate: { ref: "candidate-good", digest },
      },
    });

    expect(manager.timelineFetches).toBe(1);
    expect(result.structuredContent).toMatchObject({
      episodeReport: {
        lineage: {
          candidate: {
            status: "unknown",
            observed: null,
            sourceFacts: [],
            claims: expect.arrayContaining([
              expect.objectContaining({
                pointer: expect.stringMatching(/^checkpoint:council:/u),
                sourceClass: "agent-claim",
              }),
            ]),
          },
        },
      },
    });
  });

  test("denies episode evidence before fetching activity for an unrelated target", async () => {
    const { catalog, manager } = await createCheckpointCatalog({
      includeUnrelated: true,
      timelineRows: [
        timelineRow(1, "2026-09-06T11:01:00.000Z", {
          type: "assistant_message",
          text: "candidate-good passed",
        }),
      ],
    });

    const result = await catalog.executeTool("get_agent_checkpoint", {
      agentId: "unrelated-peer",
      report: {
        episodeId: "episode-unauthorized",
        projectId: "project-1",
        assignmentDigest: "c".repeat(64),
        issueId: ISSUE_ID,
        objective: "Exercise the production checkpoint entrypoint.",
        window: {
          from: "2026-09-06T11:00:00.000Z",
          to: "2026-09-06T11:10:00.000Z",
          maxActivityItems: 10,
        },
        candidate: { ref: "candidate-good" },
      },
    });

    expect(manager.timelineFetches).toBe(0);
    expect(result.structuredContent).toMatchObject({
      episodeReport: {
        status: "unauthorized",
        dimensions: { activity: { status: "unknown", sourceFacts: [], claims: [] } },
        sourceFacts: [],
        claims: [],
      },
    });
  });

  test("skips bounded refs for wrong project or assignment and keeps an outside window unobserved", async () => {
    const timelineRows = [
      timelineRow(1, "2026-09-06T11:01:00.000Z", {
        type: "tool_call",
        callId: "call-test-2",
        name: "run_command",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm run typecheck", exitCode: 0 },
      }),
    ];
    const first = await createCheckpointCatalog({
      includeBeadsStatusCheckpoint: true,
      timelineRows,
    });
    await first.catalog.executeTool("beads_status", {});
    const request = {
      episodeId: "episode-negative",
      projectId: "project-1",
      assignmentDigest: first.assignmentDigest,
      issueId: ISSUE_ID,
      objective: "Exercise the production checkpoint entrypoint.",
      window: {
        from: "2026-09-06T11:00:00.000Z",
        to: "2026-09-06T11:10:00.000Z",
        maxActivityItems: 10,
      },
    };
    const wrongProject = await first.catalog.executeTool("get_agent_checkpoint", {
      agentId: TARGET_ID,
      report: { ...request, projectId: "wrong-project" },
    });
    expect(first.manager.timelineFetches).toBe(0);
    expect(wrongProject.structuredContent).toMatchObject({
      episodeReport: {
        status: "unknown",
        dimensions: { activity: { status: "unknown" } },
      },
    });

    const wrongAssignment = await first.catalog.executeTool("get_agent_checkpoint", {
      agentId: TARGET_ID,
      report: { ...request, assignmentDigest: "d".repeat(64) },
    });
    expect(first.manager.timelineFetches).toBe(0);
    expect(wrongAssignment.structuredContent).toMatchObject({
      episodeReport: {
        status: "unknown",
        dimensions: { activity: { status: "unknown" } },
      },
    });

    const outsideWindow = await first.catalog.executeTool("get_agent_checkpoint", {
      agentId: TARGET_ID,
      report: {
        ...request,
        window: {
          from: "2026-09-06T12:00:00.000Z",
          to: "2026-09-06T12:10:00.000Z",
          maxActivityItems: 10,
        },
      },
    });
    expect(first.manager.timelineFetches).toBe(1);
    expect(outsideWindow.structuredContent).toMatchObject({
      episodeReport: {
        status: "reportable",
        dimensions: {
          activity: { status: "unobserved" },
          testPass: { status: "unobserved" },
        },
      },
    });
  });

  test("denies a moved same-ID root before fetching bounded activity or notebook", async () => {
    const movedRoot = mkdtempSync(join(tmpdir(), "paseo-production-checkpoint-moved-root-"));
    try {
      const moved = await createCheckpointCatalog({
        includeBeadsStatusCheckpoint: true,
        projectRoot: movedRoot,
        workspaceCwd: movedRoot,
        timelineRows: [
          timelineRow(1, "2026-09-06T11:01:00.000Z", {
            type: "assistant_message",
            text: "candidate-good",
          }),
        ],
      });
      await moved.catalog.executeTool("beads_status", {});
      const result = await moved.catalog.executeTool("get_agent_checkpoint", {
        agentId: TARGET_ID,
        report: nativeEpisodeRequest(moved.assignmentDigest),
      });

      expect(moved.manager.timelineFetches).toBe(0);
      expect(result.structuredContent).toMatchObject({
        episodeReport: {
          status: "unknown",
          lineage: { project: { status: "unknown" } },
          notebook: { status: "unavailable", location: null },
        },
      });
    } finally {
      rmSync(movedRoot, { recursive: true, force: true });
    }
  });

  test("denies a registered child project under the parent workspace before notebook fetch", async () => {
    const childRoot = join(BINDING_CWD, "registered-child-project");
    mkdirSync(childRoot, { recursive: true });
    try {
      const child = await createCheckpointCatalog({
        includeBeadsStatusCheckpoint: true,
        targetCwd: childRoot,
        registeredProjects: [
          { projectId: "project-1", rootPath: BINDING_CWD, archivedAt: null },
          { projectId: "project-child", rootPath: childRoot, archivedAt: null },
        ],
      });
      await child.catalog.executeTool("beads_status", {});
      const result = await child.catalog.executeTool("get_agent_checkpoint", {
        agentId: TARGET_ID,
        report: nativeEpisodeRequest(child.assignmentDigest),
      });

      expect(child.manager.timelineFetches).toBe(0);
      expect(result.structuredContent).toMatchObject({
        episodeReport: {
          status: "unknown",
          lineage: { project: { status: "unknown" } },
          notebook: { status: "unavailable", location: null },
        },
      });
    } finally {
      rmSync(childRoot, { recursive: true, force: true });
    }
  });

  test("reads durable custom notebook identity after the writer claim is released", async () => {
    const metadataDirectory = join(BINDING_CWD, ".paseo");
    const customNotebook = join(BINDING_CWD, "docs", "custom-supervisor-notebook.md");
    mkdirSync(metadataDirectory, { recursive: true });
    mkdirSync(join(BINDING_CWD, "docs"), { recursive: true });
    const record = SupervisorNotebookRecordSchema.parse({
      schemaVersion: 1,
      recordId: "episode-native-custom",
      episode: "episode-native-custom",
      scope: "episode-scope",
      observation: "A custom notebook identity remains readable after release.",
      evidence: ["candidate-good"],
      suspectedMechanism: { status: "unknown", statement: "The mechanism is unknown." },
      impact: "quality",
      questionForLead: "Is the evidence sufficient?",
      recovery: "Keep the report read-only.",
      outcome: "The notebook remains available for review.",
      patternStatus: "one-off",
      recommendation: "Review without promotion.",
      escalation: "lead",
      currentEpisode: "Observed",
      laterEffect: "Unobserved",
      laterEffectEvidenceRefs: [],
      observedAt: "2026-09-06T11:00:00.000Z",
    });
    writeFileSync(
      join(metadataDirectory, "harness.json"),
      JSON.stringify({
        supervisorNotebookIdentity: {
          notebookId: "nb-custom-released",
          location: "docs/custom-supervisor-notebook.md",
        },
      }),
      "utf8",
    );
    writeFileSync(customNotebook, serializeSupervisorNotebookRecord(record), "utf8");

    try {
      const custom = await createCheckpointCatalog({ includeBeadsStatusCheckpoint: true });
      await custom.catalog.executeTool("beads_status", {});
      const result = await custom.catalog.executeTool("get_agent_checkpoint", {
        agentId: TARGET_ID,
        report: nativeEpisodeRequest(custom.assignmentDigest, "episode-native-custom"),
      });

      expect(custom.manager.timelineFetches).toBe(1);
      expect(result.structuredContent).toMatchObject({
        episodeReport: {
          status: "reportable",
          notebook: {
            status: "available",
            location: "docs/custom-supervisor-notebook.md",
            matchedRecordIds: ["episode-native-custom"],
          },
        },
      });
    } finally {
      rmSync(customNotebook, { force: true });
      rmSync(metadataDirectory, { recursive: true, force: true });
    }
  });
});
