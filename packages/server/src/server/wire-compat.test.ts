import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { createAgentMessageDeliveryStub } from "./test-utils/session-stubs.js";
import {
  createMessageReceiptsStub,
  createTestCreationService,
} from "./test-utils/session-stubs.js";
import pino from "pino";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  AgentTimelineItemPayloadSchema,
  FetchAgentTimelineResponseMessageSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { Session, type SessionOptions } from "./session.js";
import { WorkspaceSetupObservation } from "./workspace-setup-observation.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { DirectorySyncService } from "./directory-sync/index.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { AgentTimelineRow } from "./agent/agent-manager.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import { InMemoryAgentTimelineStore } from "./agent/agent-timeline-store.js";
import type { AgentTimelineFetchOptions } from "./agent/agent-timeline-store-types.js";
import { handleCreatePaseoWorktreeRequest } from "./worktree-session.js";
import { createPersistedProjectRecord } from "./workspace-registry.js";

const LegacyTimelineEntryPayloadSchema = z.object({
  provider: z.enum(["claude", "codex", "opencode"]),
  item: AgentTimelineItemPayloadSchema,
  timestamp: z.string(),
  seqStart: z.number().int().nonnegative(),
  seqEnd: z.number().int().nonnegative(),
  sourceSeqRanges: z.array(
    z.object({
      startSeq: z.number().int().nonnegative(),
      endSeq: z.number().int().nonnegative(),
    }),
  ),
  // Copied from v0.1.65-beta.3: no reasoning_merge on the wire yet.
  collapsed: z.array(z.enum(["assistant_merge", "tool_lifecycle"])),
});

const LegacyFetchAgentTimelineResponseMessageSchema = z.object({
  type: z.literal("fetch_agent_timeline_response"),
  payload: FetchAgentTimelineResponseMessageSchema.shape.payload.extend({
    entries: z.array(LegacyTimelineEntryPayloadSchema),
  }),
});

interface SessionInternals {
  handleFetchAgentTimelineRequest: (
    message: Extract<
      z.infer<typeof SessionInboundMessageSchema>,
      { type: "fetch_agent_timeline_request" }
    >,
  ) => Promise<void>;
}

class InMemoryAgentManager {
  private readonly timeline = new InMemoryAgentTimelineStore();

  constructor(
    rows: AgentTimelineRow[],
    private readonly resident = true,
  ) {
    this.timeline.initialize("agent-1", {
      epoch: "epoch-1",
      rows,
      nextSeq: (rows.at(-1)?.seq ?? 0) + 1,
    });
  }

  getAgent() {
    if (!this.resident) return null;
    return {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      updatedAt: new Date("2026-05-02T00:00:00.000Z"),
      lastUserMessageAt: null,
      lifecycle: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      },
      config: { provider: "codex", cwd: "/tmp/project" },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      persistence: null,
      historyPrimed: true,
      lastUsage: undefined,
      lastError: undefined,
      attention: { requiresAttention: false, attentionReason: null, attentionTimestamp: null },
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
      session: null,
      activeForegroundTurnId: null,
      labels: {},
    };
  }

  fetchTimeline(_agentId: string, options?: AgentTimelineFetchOptions) {
    return this.timeline.fetch("agent-1", options);
  }

  async fetchDurableTimeline(_agentId: string, options?: AgentTimelineFetchOptions) {
    return this.timeline.fetch("agent-1", options);
  }

  isStoredAgentPolicyGenerationAvailable() {
    return this.resident;
  }

  getTimeline(_agentId: string) {
    return this.timeline.getItems("agent-1");
  }

  listAgents() {
    return [];
  }

  subscribe() {
    return () => {};
  }
}

class EmptyAgentStorage {
  constructor(private readonly record: StoredAgentRecord | null = null) {}

  async list() {
    return this.record ? [this.record] : [];
  }

  async get(agentId: string) {
    return this.record?.id === agentId ? this.record : null;
  }
}

class EmptyProjectRegistry {
  async list() {
    return [];
  }

  async get() {
    return null;
  }

  async upsert() {}
  async archive() {}
  async remove() {}
  async initialize() {}
  async existsOnDisk() {
    return false;
  }
}

class EmptyWorkspaceRegistry {
  get() {
    return null;
  }

  list() {
    return [];
  }
}

class EmptyDaemonConfigStore {
  get() {
    return {
      mcp: { injectIntoAgents: false },
      providers: {},
    };
  }

  onChange() {
    return () => {};
  }
}

class InMemoryWorktreeWorkflow {
  readonly capturedInputs: unknown[] = [];

  async create(input: unknown) {
    this.capturedInputs.push(input);
    return {} as never;
  }
}

function createSessionForWireCompatTest(options?: {
  clientCapabilities?: Record<string, unknown> | null;
  directorySync?: DirectorySyncService;
  messages?: SessionOutboundMessage[];
  onMessageToSource?: SessionOptions["onMessageToSource"];
  rows?: AgentTimelineRow[];
  historicalPolicyOnly?: boolean;
  workspaceRegistry?: SessionOptions["workspaceRegistry"];
}): Session {
  const messages = options?.messages ?? [];
  const rows: AgentTimelineRow[] = [
    {
      seq: 1,
      timestamp: "2026-05-02T00:00:00.000Z",
      item: { type: "reasoning", text: "Step " },
    },
    {
      seq: 2,
      timestamp: "2026-05-02T00:00:00.100Z",
      item: { type: "reasoning", text: "by step" },
    },
    {
      seq: 3,
      timestamp: "2026-05-02T00:00:00.200Z",
      item: { type: "assistant_message", text: "done" },
    },
  ];

  const historicalRecord: StoredAgentRecord | null = options?.historicalPolicyOnly
    ? {
        id: "agent-1",
        provider: "codex",
        cwd: "/tmp/project",
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
        labels: {},
        lastStatus: "closed",
        config: null,
      }
    : null;

  const session = new Session({
    workspaceRuntimeStore: createWorkspaceRuntimeStore(),
    messageReceipts: createMessageReceiptsStub(),
    agentMessages: createAgentMessageDeliveryStub(),
    creationService: createTestCreationService(),
    clientId: "wire-compat-client",
    permissions: OWNER_PERMISSIONS,
    clientCapabilities: options?.clientCapabilities ?? null,
    onMessage: (message) => messages.push(message),
    onMessageToSource: options?.onMessageToSource ?? ((_source, message) => messages.push(message)),
    logger: pino({ level: "silent" }),
    downloadTokenStore: {} as SessionOptions["downloadTokenStore"],
    pushNotifications: {} as SessionOptions["pushNotifications"],
    paseoHome: "/tmp/paseo-home",
    agentManager: new InMemoryAgentManager(
      options?.rows ?? rows,
      options?.historicalPolicyOnly !== true,
    ) as unknown as SessionOptions["agentManager"],
    agentStorage: new EmptyAgentStorage(
      historicalRecord,
    ) as unknown as SessionOptions["agentStorage"],
    projectRegistry: new EmptyProjectRegistry() as unknown as SessionOptions["projectRegistry"],
    workspaceRegistry:
      options?.workspaceRegistry ??
      (new EmptyWorkspaceRegistry() as unknown as SessionOptions["workspaceRegistry"]),
    directorySync: options?.directorySync,
    scheduleService: {} as SessionOptions["scheduleService"],
    checkoutDiffManager: {
      scheduleRefreshForCwd() {},
      onWorkspaceStateMayHaveChanged() {},
    } as unknown as SessionOptions["checkoutDiffManager"],
    github: {
      invalidate() {},
      async searchIssuesAndPrs() {
        return [];
      },
      async createPullRequest() {
        return null;
      },
    } as unknown as SessionOptions["github"],
    workspaceGitService: {
      async getCheckoutDiff() {
        return null;
      },
      async getSnapshot() {
        return null;
      },
      async suggestBranchesForCwd() {
        return [];
      },
      async listStashes() {
        return [];
      },

      async validateBranchRef() {
        return { ok: false, error: "not found" };
      },
      async hasLocalBranch() {
        return false;
      },
      async resolveRepoRemoteUrl() {
        return null;
      },
      async getProjectSlug() {
        return "project";
      },
    } as unknown as SessionOptions["workspaceGitService"],
    daemonConfigStore:
      new EmptyDaemonConfigStore() as unknown as SessionOptions["daemonConfigStore"],
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
  });

  session.updateClientCapabilities(options?.clientCapabilities ?? null, {});
  return session;
}

async function emitTimelineResponse(options?: {
  clientCapabilities?: Record<string, unknown> | null;
  rows?: AgentTimelineRow[];
  historicalPolicyOnly?: boolean;
  request?: Partial<
    Extract<z.infer<typeof SessionInboundMessageSchema>, { type: "fetch_agent_timeline_request" }>
  >;
}): Promise<Extract<SessionOutboundMessage, { type: "fetch_agent_timeline_response" }>> {
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForWireCompatTest({
    clientCapabilities: options?.clientCapabilities,
    rows: options?.rows,
    messages,
    historicalPolicyOnly: options?.historicalPolicyOnly,
  });
  const internals = session as unknown as SessionInternals;

  await internals.handleFetchAgentTimelineRequest({
    type: "fetch_agent_timeline_request",
    requestId: "req-timeline",
    agentId: "agent-1",
    projection: "projected",
    ...options?.request,
  });

  const response = messages[0];
  expect(response?.type).toBe("fetch_agent_timeline_response");
  if (!response || response.type !== "fetch_agent_timeline_response") {
    throw new Error("Expected fetch_agent_timeline_response");
  }
  return response;
}

describe("wire compatibility", () => {
  test("sends project updates only to clients that declare support", async () => {
    const project = createPersistedProjectRecord({
      projectId: "project-1",
      rootPath: "/tmp/project",
      kind: "git",
      displayName: "project",
      customName: "Favorite project",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });
    const legacyMessages: SessionOutboundMessage[] = [];
    const capableMessages: SessionOutboundMessage[] = [];
    const legacy = createSessionForWireCompatTest({ messages: legacyMessages });
    const capable = createSessionForWireCompatTest({
      clientCapabilities: { [CLIENT_CAPS.projectUpdates]: true },
      messages: capableMessages,
    });

    await Promise.all([
      legacy.emitProjectUpdate({ kind: "upsert", project }),
      legacy.emitProjectUpdate({ kind: "remove", projectId: project.projectId }),
      capable.emitProjectUpdate({ kind: "upsert", project }),
      capable.emitProjectUpdate({ kind: "remove", projectId: project.projectId }),
    ]);

    expect(legacyMessages).toEqual([]);
    expect(capableMessages.map((message) => SessionOutboundMessageSchema.parse(message))).toEqual([
      {
        type: "project.update",
        payload: {
          generation: expect.any(String),
          seq: 1,
          kind: "upsert",
          project: {
            projectId: "project-1",
            projectDisplayName: "Favorite project",
            projectCustomName: "Favorite project",
            projectCustomIconRevision: null,
            projectIconRevision: "automatic:none:v1",
            projectRootPath: "/tmp/project",
            projectKind: "git",
          },
        },
      },
      {
        type: "project.update",
        payload: { kind: "remove", projectId: "project-1", generation: expect.any(String), seq: 2 },
      },
    ]);
  });

  test("publishes rapid project mutations in order before incremental reconciliation", async () => {
    const directorySync = new DirectorySyncService("generation");
    const initial = directorySync.synchronizeProjects([], {});
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForWireCompatTest({
      clientCapabilities: { [CLIENT_CAPS.projectUpdates]: true },
      directorySync,
      messages,
    });
    const project = createPersistedProjectRecord({
      projectId: "project-ordered",
      rootPath: "/tmp/project-ordered",
      kind: "git",
      displayName: "Ordered project",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });

    await Promise.all([
      session.emitProjectUpdate({ kind: "upsert", project }),
      session.emitProjectUpdate({ kind: "remove", projectId: project.projectId }),
    ]);

    expect(
      messages.flatMap((message) =>
        message.type === "project.update" ? [message.payload.kind] : [],
      ),
    ).toEqual(["upsert", "remove"]);
    expect(
      directorySync.synchronizeProjects([], {
        generation: initial.sync.generation,
        afterSeq: initial.sync.headSeq,
      }),
    ).toEqual({
      projects: [],
      sync: {
        generation: "generation",
        mode: "changes",
        headSeq: 2,
        removals: [{ id: "project-ordered", seq: 2 }],
      },
    });
  });

  test("downgrades reasoning_merge for clients that do not declare the capability", async () => {
    const response = await emitTimelineResponse();

    const currentParsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(currentParsed.payload.entries[0]?.collapsed).not.toContain("reasoning_merge");

    const legacyParsed = LegacyFetchAgentTimelineResponseMessageSchema.parse(response);
    expect(legacyParsed.payload.entries[0]?.collapsed).toEqual([]);
  });

  test("serves durable history without resuming an agent whose pinned policy is unavailable", async () => {
    const response = await emitTimelineResponse({ historicalPolicyOnly: true });

    const parsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(parsed.payload.error).toBeNull();
    expect(parsed.payload.agent.status).toBe("closed");
    expect(parsed.payload.entries).not.toHaveLength(0);
  });

  test("preserves reasoning_merge for clients that declare the capability", async () => {
    const response = await emitTimelineResponse({
      clientCapabilities: { [CLIENT_CAPS.reasoningMergeEnum]: true },
    });

    const currentParsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(currentParsed.payload.entries[0]?.collapsed).toContain("reasoning_merge");
  });

  test("carries canonical turn IDs to new clients while legacy schemas ignore them", async () => {
    const response = await emitTimelineResponse({
      rows: [
        {
          seq: 1,
          timestamp: "2026-05-02T00:00:00.000Z",
          turnId: "turn-1",
          item: { type: "user_message", text: "prompt", clientMessageId: "message-1" },
        },
        {
          seq: 2,
          timestamp: "2026-05-02T00:00:01.000Z",
          turnId: "turn-1",
          item: { type: "assistant_message", text: "done" },
        },
      ],
    });

    expect(FetchAgentTimelineResponseMessageSchema.parse(response).payload.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ turnId: "turn-1" })]),
    );
    expect(LegacyFetchAgentTimelineResponseMessageSchema.parse(response).payload.entries).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ turnId: expect.anything() })]),
    );
  });

  test("legacy worktree request shape normalizes to the same internal input as the new shape", async () => {
    const workflow = new InMemoryWorktreeWorkflow();

    const dependencies = {
      paseoHome: "/tmp/paseo-home",
      describeWorkspaceRecord: async () =>
        ({
          id: "ws-1",
          projectId: "proj-1",
          projectDisplayName: "repo",
          projectRootPath: "/tmp/repo",
          projectKind: "directory",
          workspaceKind: "checkout",
          name: "repo",
          cwd: "/tmp/repo",
          status: "ready",
          activityAt: null,
          scripts: [],
        }) as never,
      emit() {},
      sessionLogger: pino({ level: "silent" }),
      createPaseoWorktreeWorkflow: workflow.create.bind(workflow),
    };

    const legacyRequest = SessionInboundMessageSchema.parse({
      type: "create_paseo_worktree_request",
      requestId: "req-legacy",
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      nameContext: "Investigate flaky test",
      attachments: [
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 55,
          title: "Improve startup error details",
          url: "https://github.com/getpaseo/paseo/issues/55",
        },
      ],
    });

    const newRequest = SessionInboundMessageSchema.parse({
      type: "create_paseo_worktree_request",
      requestId: "req-new",
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      firstAgentContext: {
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: 55,
            title: "Improve startup error details",
            url: "https://github.com/getpaseo/paseo/issues/55",
          },
        ],
      },
    });

    if (legacyRequest.type !== "create_paseo_worktree_request") {
      throw new Error("Expected legacy worktree request");
    }
    if (newRequest.type !== "create_paseo_worktree_request") {
      throw new Error("Expected new worktree request");
    }

    await handleCreatePaseoWorktreeRequest(dependencies, legacyRequest);
    await handleCreatePaseoWorktreeRequest(dependencies, newRequest);

    expect(workflow.capturedInputs).toHaveLength(2);
    expect(workflow.capturedInputs[0]).toEqual(workflow.capturedInputs[1]);
    expect(workflow.capturedInputs[0]).toEqual({
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      firstAgentContext: {
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: 55,
            title: "Improve startup error details",
            url: "https://github.com/getpaseo/paseo/issues/55",
          },
        ],
      },
      refName: undefined,
      action: undefined,
      githubPrNumber: undefined,

      paseoHome: "/tmp/paseo-home",
    });
  });
});

test("setup progress is adapted per socket without changing the canonical snapshot", async () => {
  const legacy = {};
  const capable = {};
  const modern = {};
  const modernCapable = {};
  const delivered = new Map<object, SessionOutboundMessage[]>();
  const session = createSessionForWireCompatTest({
    onMessageToSource: (source, message) =>
      delivered.set(source, [...(delivered.get(source) ?? []), message]),
  });
  for (const [source, blocked, owned] of [
    [legacy, false, false],
    [capable, true, false],
    [modern, false, true],
    [modernCapable, true, true],
  ] as const) {
    session.updateClientCapabilities(
      {
        explicit_event_subscriptions: true,
        owned_subscriptions: owned,
        workspace_setup_blocked: blocked,
      },
      source,
    );
    await session.handleMessage(
      {
        type: "session.events.set_subscription.request",
        requestId: "setup",
        events: ["workspace_setup_progress"],
      },
      source,
    );
    expect(delivered.get(source)).toContainEqual(
      expect.objectContaining({ type: "session.events.set_subscription.response" }),
    );
  }
  delivered.clear();
  const message = {
    type: "workspace_setup_progress" as const,
    payload: {
      workspaceId: "fork-workspace",
      status: "blocked" as const,
      error: null,
      detail: {
        type: "worktree_setup" as const,
        worktreePath: "/workspace",
        branchName: "fork",
        log: "",
        commands: [],
      },
      blockedSource: {
        kind: "change_request" as const,
        forge: "github",
        number: 42,
        headRepository: "contributor/project",
      },
    },
  };
  session.publish(message);
  expect(delivered.get(capable)).toEqual([message]);
  expect(delivered.get(legacy)).toEqual([
    {
      ...message,
      payload: {
        ...message.payload,
        status: "failed",
        error:
          "Workspace setup is blocked pending approval of code from a fork pull request. Update Paseo to review and run setup.",
      },
    },
  ]);
  expect(delivered.get(modernCapable)).toEqual([
    { ...message, payload: { ...message.payload, subscriptionId: expect.any(String) } },
  ]);
  expect(delivered.get(modern)).toEqual([
    {
      ...message,
      payload: {
        ...message.payload,
        status: "failed",
        error: expect.stringContaining("Update Paseo"),
        subscriptionId: expect.any(String),
      },
    },
  ]);
  expect(message.payload.status).toBe("blocked");
  await session.cleanup();
});

test("agent role receipts using the plugin launch hook reach only clients that advertise the capability", async () => {
  const roleBinding = { roleId: "peer", injectionMethod: "plugin-role-launch-hook" };
  // Only the receipt matters to the projection; the rest of the agent snapshot is irrelevant.
  const message = {
    type: "fetch_agent_response",
    payload: { requestId: "r1", error: null, agent: { id: "agent-1", roleBinding } },
  } as unknown as SessionOutboundMessage;
  const deliver = async (clientCapabilities: Record<string, unknown>) => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForWireCompatTest({ clientCapabilities, messages });
    session.publish(message);
    await session.cleanup();
    return messages;
  };

  expect(await deliver({ [CLIENT_CAPS.pluginRoleLaunchHookReceipt]: true })).toEqual([message]);
  expect(await deliver({})).toEqual([
    { ...message, payload: { requestId: "r1", error: null, agent: { id: "agent-1" } } },
  ]);

  // The capable socket registers last, so its capabilities are the session's current ones.
  const legacy = {};
  const capable = {};
  const delivered = new Map<object, SessionOutboundMessage[]>();
  const session = createSessionForWireCompatTest({
    onMessageToSource: (source, sent) =>
      delivered.set(source, [...(delivered.get(source) ?? []), sent]),
  });
  session.updateClientCapabilities({}, legacy);
  session.updateClientCapabilities({ [CLIENT_CAPS.pluginRoleLaunchHookReceipt]: true }, capable);
  const update = {
    type: "providers_snapshot_update",
    payload: { generatedAt: "now", entries: [{ provider: "plugin-role", roleBinding }] },
  } as unknown as SessionOutboundMessage;
  session.publish(update);
  await session.cleanup();
  expect(delivered.get(capable)).toEqual([update]);
  expect(delivered.get(legacy)).toEqual([
    { ...update, payload: { generatedAt: "now", entries: [{ provider: "plugin-role" }] } },
  ]);
});

test("scoped setup clients never receive session-wide setup output", async () => {
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForWireCompatTest({
    messages,
    clientCapabilities: { owned_subscriptions: true, workspace_setup_observation: true },
  });
  const source = {};
  session.updateClientCapabilities(
    { owned_subscriptions: true, workspace_setup_observation: true },
    source,
  );
  await session.handleMessage(
    {
      type: "session.events.set_subscription.request",
      requestId: "events",
      events: ["workspace_setup_progress"],
    },
    source,
  );
  messages.length = 0;
  for (const workspaceId of ["setup-a", "setup-b", "setup-c"]) {
    for (let chunk = 0; chunk < 10; chunk++) {
      session.publish({
        type: "workspace_setup_progress",
        payload: {
          workspaceId,
          status: "running",
          error: null,
          detail: {
            type: "worktree_setup",
            worktreePath: "/workspace",
            branchName: "setup",
            log: "output".repeat(chunk * 1000),
            commands: [],
          },
        },
      });
    }
  }
  expect(messages).toEqual([]);
  await session.cleanup();
});

test("setup output invalidates directory metadata only when visible setup status changes", () => {
  const setup = new WorkspaceSetupObservation();
  const earlier = {
    status: "failed" as const,
    error: "failed before any connection",
    detail: {
      type: "worktree_setup" as const,
      worktreePath: "/workspace",
      branchName: "test",
      log: "earlier output",
      commands: [],
    },
  };
  setup.publish("earlier", earlier);
  expect(setup.get("earlier")).toEqual(earlier);
  expect(setup.status({ workspaceId: "earlier", untrustedSource: null })).toBe("failed");
  const changes: boolean[] = [];
  setup.subscribe((_workspaceId, _snapshot, changed) => changes.push(changed));
  const detail = {
    type: "worktree_setup" as const,
    worktreePath: "/workspace",
    branchName: "test",
    log: "",
    commands: [
      {
        index: 0,
        command: "setup",
        cwd: "/workspace",
        log: "",
        status: "running" as const,
        exitCode: null,
      },
    ],
  };
  for (const log of ["", "one", "one two", "one two three"])
    setup.publish("workspace", { status: "running", error: null, detail: { ...detail, log } });
  setup.publish("workspace", { status: "failed", error: "failed", detail });
  expect(changes).toEqual([true, false, false, false, true]);
  expect(setup.status({ workspaceId: "workspace", untrustedSource: null })).toBe("failed");
  expect(setup.status({ workspaceId: "empty", untrustedSource: null })).toBeNull();
  setup.publish("empty", { status: "completed", error: null, detail: { ...detail, commands: [] } });
  expect(setup.status({ workspaceId: "empty", untrustedSource: null })).toBeNull();
});

test("setup observation includes a transition that happens during its initial registry read", async () => {
  let completeRead!: (value: null) => void;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const pendingRead = new Promise<null>((resolve) => {
    completeRead = resolve;
  });
  const messages: SessionOutboundMessage[] = [];
  const source = {};
  const session = createSessionForWireCompatTest({
    messages,
    clientCapabilities: { owned_subscriptions: true, workspace_setup_observation: true },
    workspaceRegistry: {
      get: () => {
        readStarted();
        return pendingRead;
      },
      list: () => [],
    } as unknown as SessionOptions["workspaceRegistry"],
  });
  session.updateClientCapabilities(
    { owned_subscriptions: true, workspace_setup_observation: true },
    source,
  );
  try {
    const request = session.handleMessage(
      { type: "workspace.setup.subscribe.request", workspaceId: "setup", requestId: "observe" },
      source,
    );
    await started;
    session.publish({
      type: "workspace_setup_progress",
      payload: {
        workspaceId: "setup",
        status: "failed",
        error: "bootstrap failure",
        detail: {
          type: "worktree_setup",
          worktreePath: "/workspace",
          branchName: "test",
          log: "failure output",
          commands: [],
        },
      },
    });
    completeRead(null);
    await request;
    expect(messages).toEqual([
      {
        type: "workspace.setup.subscribe.response",
        payload: {
          requestId: "observe",
          workspaceId: "setup",
          subscriptionId: expect.any(String),
          snapshot: {
            status: "failed",
            error: "bootstrap failure",
            detail: {
              type: "worktree_setup",
              worktreePath: "/workspace",
              branchName: "test",
              log: "failure output",
              commands: [],
            },
          },
        },
      },
    ]);
  } finally {
    await session.cleanup();
  }
});
