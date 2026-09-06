import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterAll, describe, expect, test } from "vitest";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { BeadsIssue } from "@getpaseo/protocol/beads/rpc-schemas";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import type { CouncilCaseRecord } from "@getpaseo/protocol/council/types";
import { AgentManager, type ManagedAgent } from "../agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "../agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentMode,
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
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { BeadsService } from "../../beads/beads-service.js";
import type { CouncilCaseStore } from "../../council/council-case-store.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import {
  createDefaultSlpBundledPolicyRegistry,
  type SlpBundledPolicyContribution,
} from "../../policy/bundled/slp.js";
import { materializeTrustedRoleBinding } from "../../policy/trusted-policy.js";
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
): Promise<{ binding: PersistedRoleBinding; contribution: SlpBundledPolicyContribution }> {
  const registry = createDefaultSlpBundledPolicyRegistry();
  const generation = registry.resolveActive("slp");
  const binding = await materializeTrustedRoleBinding(generation, {
    roleId: role,
    provider: "codex",
    providerSupport: {
      status: "supported",
      injectionMethod: "mock-launch-context",
    },
    cwd: BINDING_CWD,
    workspaceId: "workspace-1",
    assignment: assignment(role, effectClass),
    assignmentAssigner: { kind: "human-session" },
  });
  return { binding, contribution: generation.contribution };
}

function storedRecord(
  id: string,
  roleBinding: PersistedRoleBinding,
  labels: Record<string, string> = {},
): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd: BINDING_CWD,
    workspaceId: "workspace-1",
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
    labels,
    lastStatus: "idle",
    config: null,
    persistence: null,
    roleBinding,
    coordinationSignals: [],
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

  constructor(
    private readonly records: Map<string, StoredAgentRecord>,
    private readonly contribution: SlpBundledPolicyContribution,
  ) {}

  getRoleBindingForToolCatalog(agentId: string): PersistedRoleBinding | undefined {
    return this.records.get(agentId)?.roleBinding;
  }

  getAgent(agentId: string): ManagedAgent | null {
    const record = this.records.get(agentId);
    return record ? liveRecord(record) : null;
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

function workspaceRegistry(): Pick<WorkspaceRegistry, "get"> {
  return {
    get: async (workspaceId) =>
      workspaceId === "workspace-1"
        ? ({
            workspaceId,
            projectId: "project-1",
            cwd: "/repo",
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

function councilCase(targetAgentId: string): CouncilCaseRecord {
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
        disposition: "completed",
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
}) {
  const { binding: callerBinding, contribution } = await makeBinding("lead", "delegation");
  const { binding: targetBinding } = await makeBinding("peer", "read-only");
  const records = new Map<string, StoredAgentRecord>([
    [CALLER_ID, storedRecord(CALLER_ID, callerBinding)],
    [
      TARGET_ID,
      storedRecord(TARGET_ID, targetBinding, {
        [PARENT_AGENT_ID_LABEL]: CALLER_ID,
      }),
    ],
  ]);
  if (input?.includeUnrelated) {
    const { binding: unrelatedBinding } = await makeBinding("peer", "read-only");
    records.set("unrelated-peer", storedRecord("unrelated-peer", unrelatedBinding));
  }
  const storage = new CheckpointStorage(records);
  const manager = new CheckpointManager(records, contribution);
  const councilStore =
    input?.includeCouncil === false ? null : { list: async () => [councilCase(TARGET_ID)] };
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
    workspaceRegistry: workspaceRegistry(),
    councilCaseStore: councilStore as unknown as Pick<CouncilCaseStore, "list">,
    logger: pino({ level: "silent" }),
  });
  return { catalog, manager };
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
    const manager = new AgentManager({
      clients: { codex: new CheckpointClient() },
      bundledPolicyPacks: policyRegistry,
      registry: storage,
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
});
