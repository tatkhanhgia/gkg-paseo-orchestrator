import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { BeadsIssue } from "@getpaseo/protocol/beads/rpc-schemas";
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
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import {
  NON_SLP_FIXTURE_PLUGIN_ID,
  NON_SLP_FIXTURE_EVENT_POLICY,
  NON_SLP_FIXTURE_POLICY_VERSION,
  createNonSlpFixtureRegistry,
} from "../../policy/non-slp-fixture-policy.js";
import {
  createTrustedPolicyPackResolver,
  materializeTrustedRoleBinding,
} from "../../policy/trusted-policy.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { PaseoToolCatalog } from "./types.js";
import { startEventPolicyRuntime } from "../event-policy-runtime.js";

const ISSUE: BeadsIssue = {
  id: "fixture-issue",
  title: "Fixture issue",
  status: "in_progress",
  priority: 2,
  issue_type: "task",
  assignee: null,
  dependency_count: 17,
};
const FIXTURE_CALLER_ID = "00000000-0000-4000-8000-000000000401";

function fixtureAssignment() {
  return {
    version: 1 as const,
    disposition: "peer-execution" as const,
    objective: "Exercise the trusted non-SLP catalog path.",
    effectClass: "read-only" as const,
    mutationBoundary: { mode: "no-write" as const },
    externalEffectBoundary: { mode: "denied" as const },
    resourceGrants: { beadsIssueIds: [ISSUE.id] },
    evidence: "Return the exact bounded catalog receipt.",
    handbackAndStop: "Stop after the bounded receipt.",
  };
}

async function createFixtureBinding() {
  const registry = createNonSlpFixtureRegistry();
  const generation = registry.resolveActive(NON_SLP_FIXTURE_PLUGIN_ID);
  const binding = await materializeTrustedRoleBinding(generation, {
    roleId: "peer",
    provider: "codex",
    providerSupport: {
      status: "supported",
      injectionMethod: "mock-launch-context",
    },
    cwd: "/repo",
    workspaceId: "workspace-1",
    assignment: fixtureAssignment(),
    assignmentAssigner: { kind: "human-session" },
    roleProfilePreferences: {
      allowedTools: ["beads_status", "beads_get", "beads_prime"],
    },
  });
  expect(binding.policyOwner).toMatchObject({
    kind: "plugin",
    pluginId: NON_SLP_FIXTURE_PLUGIN_ID,
    policyVersion: NON_SLP_FIXTURE_POLICY_VERSION,
  });
  return { binding, registry };
}

function record(id: string, roleBinding: StoredAgentRecord["roleBinding"]): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd: "/repo",
    workspaceId: "workspace-1",
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
    labels: {},
    lastStatus: "idle",
    config: null,
    persistence: null,
    roleBinding,
  } as StoredAgentRecord;
}

class FixtureStorage {
  readonly records = new Map<string, StoredAgentRecord>();

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.records.get(agentId) ?? null;
  }

  async list(): Promise<StoredAgentRecord[]> {
    return [...this.records.values()];
  }

  async upsert(next: StoredAgentRecord): Promise<void> {
    this.records.set(next.id, next);
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

class NonSlpCatalogManager {
  slpResolverCalls = 0;

  constructor(private readonly binding: NonNullable<StoredAgentRecord["roleBinding"]>) {}

  getRoleBindingForToolCatalog(agentId: string) {
    return agentId === FIXTURE_CALLER_ID ? this.binding : undefined;
  }

  getAgent(_agentId: string): ManagedAgent | null {
    return null;
  }

  listAgents(): ManagedAgent[] {
    return [];
  }

  resolveSlpPolicyForRoleBinding(): never {
    this.slpResolverCalls += 1;
    throw new Error("SLP resolver must not be used for this non-SLP catalog");
  }

  resolveActiveSlpPolicy(): never {
    this.slpResolverCalls += 1;
    throw new Error("active SLP resolver must not be used for this non-SLP catalog");
  }
}

const NATIVE_FIXTURE_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsNativePaseoTools: true,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class NativeFixtureSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly id = "fixture-native-session";
  readonly capabilities = NATIVE_FIXTURE_CAPABILITIES;

  async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    return { turnId: "fixture-turn" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => {};
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: this.provider, sessionId: this.id, model: "fixture-model" };
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

class NativeFixtureClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = NATIVE_FIXTURE_CAPABILITIES;
  lastLaunchContext: AgentLaunchContext | undefined;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(
    _config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.lastLaunchContext = launchContext;
    return new NativeFixtureSession();
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.lastLaunchContext = launchContext;
    return new NativeFixtureSession();
  }

  async materializeProviderLaunchBinding(input: {
    config: AgentSessionConfig;
    requestedModel?: string;
  }): Promise<ProviderLaunchBinding> {
    return {
      providerId: this.provider,
      providerFamily: this.provider,
      model: input.requestedModel ?? input.config.model ?? "fixture-model",
      credentialConfigured: true,
      routeKind: "codex-subscription",
      modelProviderId: "openai",
      authMethod: "codex-native",
    };
  }

  async fetchCatalog(): Promise<ProviderCatalog> {
    return {
      models: [
        {
          provider: this.provider,
          id: "fixture-model",
          label: "Fixture model",
          isDefault: true,
        },
      ],
      modes: [],
    };
  }
}

function createWorkspaceRegistry(): Pick<WorkspaceRegistry, "get"> {
  return {
    get: async (workspaceId) =>
      workspaceId === "workspace-1"
        ? ({
            workspaceId,
            projectId: "project-1",
            cwd: "/repo",
            kind: "directory",
            displayName: "Fixture",
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

function createCatalog(input: {
  manager: NonSlpCatalogManager;
  storage: FixtureStorage;
  beadsService: BeadsService;
}) {
  return createPaseoToolCatalog({
    agentManager: input.manager as unknown as AgentManager,
    agentStorage: input.storage as unknown as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    callerAgentId: FIXTURE_CALLER_ID,
    paseoToolPolicy: {
      enabled: true,
      allowedTools: ["beads_status", "beads_get", "beads_prime"],
    },
    beadsService: input.beadsService,
    workspaceRegistry: createWorkspaceRegistry(),
    logger: pino({ level: "silent" }),
  });
}

describe("trusted non-SLP tool-host path", () => {
  test("creates and executes a real catalog without resolving SLP descriptions", async () => {
    const { binding } = await createFixtureBinding();
    const storage = new FixtureStorage();
    storage.records.set(FIXTURE_CALLER_ID, record(FIXTURE_CALLER_ID, binding));
    const get = vi.fn(async (_context, issueId: string) => {
      expect(issueId).toBe(ISSUE.id);
      return ISSUE;
    });
    const beadsService = {
      status: async () => ({ available: true, version: "1.2.0" }),
      get,
    } as unknown as BeadsService;
    const manager = new NonSlpCatalogManager(binding);

    // This is the same factory boundary used by bootstrap/AgentManager launch;
    // no direct SLP contribution is supplied to the generic host.
    const catalogFactory = () => createCatalog({ manager, storage, beadsService });
    const catalog = await catalogFactory();

    expect(manager.slpResolverCalls).toBe(0);
    expect(catalog.getTool("beads_get")).toBeDefined();
    expect(catalog.getTool("start_council")).toBeUndefined();

    await catalog.executeTool("beads_status", {});
    const result = await catalog.executeTool("beads_get", {
      issueId: ISSUE.id,
      view: "checkpoint",
    });
    expect(result.structuredContent).toMatchObject({
      projectId: "project-1",
      view: "checkpoint",
      issue: { id: ISSUE.id, status: ISSUE.status },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("passes a non-SLP binding through the real AgentManager launch catalog factory", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "paseo-non-slp-catalog-manager-"));
    const logger = pino({ level: "silent" });
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    await storage.initialize();
    const registry = createNonSlpFixtureRegistry();
    const client = new NativeFixtureClient();
    const beadsGet = vi.fn(async (_context: unknown, issueId: string) => {
      expect(issueId).toBe(ISSUE.id);
      return { ...ISSUE, id: issueId };
    });
    const catalogs: PaseoToolCatalog[] = [];
    let manager!: AgentManager;
    manager = new AgentManager({
      clients: { codex: client },
      registry: storage,
      logger,
      trustedPolicyResolver: createTrustedPolicyPackResolver({ registry }),
      paseoToolCatalogFactory: ({ callerAgentId, paseoToolPolicy }) => {
        const catalog = createPaseoToolCatalog({
          agentManager: manager,
          agentStorage: storage,
          providerSnapshotManager: {} as ProviderSnapshotManager,
          callerAgentId,
          paseoToolPolicy,
          beadsService: {
            status: async () => ({ available: true, version: "1.2.0" }),
            get: beadsGet,
          } as unknown as BeadsService,
          workspaceRegistry: createWorkspaceRegistry(),
          logger,
        });
        catalogs.push(catalog);
        return catalog;
      },
    });
    const runtime = startEventPolicyRuntime({
      dependencies: {
        agentManager: manager,
        agentStorage: storage,
        sendAtSafeBoundary: async () => {},
        logger,
      },
      advertisedPolicies: [NON_SLP_FIXTURE_EVENT_POLICY],
      resolvePolicies: (agentId, event) =>
        manager.resolveBundledEventPoliciesForAgent(
          agentId,
          event.type === "agent_closure" ? event : undefined,
        ),
    });
    const resolveSlpForBinding = vi.spyOn(manager, "resolveSlpPolicyForRoleBinding");
    const resolveActiveSlp = vi.spyOn(manager, "resolveActiveSlpPolicy");

    try {
      const created = await manager.createAgent(
        { provider: "codex", cwd: workdir, model: "fixture-model" },
        FIXTURE_CALLER_ID,
        {
          workspaceId: "workspace-1",
          roleId: "peer",
          assignment: fixtureAssignment(),
        },
      );

      expect(created.roleBinding?.policyOwner).toMatchObject({
        kind: "plugin",
        pluginId: NON_SLP_FIXTURE_PLUGIN_ID,
      });
      expect(client.lastLaunchContext?.paseoTools).toBe(catalogs[0]);
      expect(resolveSlpForBinding).not.toHaveBeenCalled();
      expect(resolveActiveSlp).not.toHaveBeenCalled();
      expect(catalogs).toHaveLength(1);
      expect(catalogs[0]?.getTool("beads_get")).toBeDefined();

      await catalogs[0]!.executeTool("beads_status", {});
      const result = await catalogs[0]!.executeTool("beads_get", {
        issueId: ISSUE.id,
        view: "checkpoint",
      });
      expect(result.structuredContent).toMatchObject({
        projectId: "project-1",
        view: "checkpoint",
        issue: { id: ISSUE.id, status: ISSUE.status },
      });
      expect(beadsGet).toHaveBeenCalledTimes(1);
      const owner = created.roleBinding?.policyOwner;
      if (!owner || owner.kind !== "plugin") throw new Error("missing fixture policy owner");
      await manager.appendTimelineItem(created.id, {
        type: "assistant_message",
        text: "Fixture event through the native catalog launch path.",
      });
      const stateKey = `${owner.pluginId}@${owner.generationDigest}/${NON_SLP_FIXTURE_EVENT_POLICY.id}`;
      await vi.waitFor(async () => {
        expect((await storage.get(created.id))?.eventPolicyStates?.[stateKey]).toMatchObject({
          state: { streamEvents: 1 },
        });
      });
    } finally {
      await runtime.stop();
      await manager.closeAgent(FIXTURE_CALLER_ID).catch(() => undefined);
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
