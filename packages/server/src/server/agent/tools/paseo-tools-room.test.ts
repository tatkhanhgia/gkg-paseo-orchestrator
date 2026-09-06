import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import pino from "pino";
import type { ChatMessage, ChatRoomDetail } from "@getpaseo/protocol/chat/types";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { FileBackedChatService } from "../../chat/chat-service.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import type { CouncilCaseStore } from "../../council/council-case-store.js";
import { createDefaultSlpBundledPolicyRegistry } from "../../policy/bundled/slp.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const slpContribution = createDefaultSlpBundledPolicyRegistry().resolveActive("slp").contribution;

class CouncilCaseStoreFake {
  public readonly created: unknown[] = [];
  public readonly assigned: unknown[] = [];
  public readonly recorded: unknown[] = [];

  public async create(input: unknown): Promise<unknown> {
    this.created.push(input);
    return input;
  }

  public async assertSeatLaunch(): Promise<void> {}

  public async assignSeat(input: unknown): Promise<unknown> {
    this.assigned.push(input);
    return input;
  }

  public async recordSeat(input: unknown): Promise<unknown> {
    this.recorded.push(input);
    return input;
  }
}

class RoomAgentManagerFake {
  public readonly metadataUpdates: Array<{
    agentId: string;
    updates: { title?: string; labels?: Record<string, string> };
  }> = [];

  public constructor(
    private readonly roleId?: "lead" | "peer" | "supervisor",
    private readonly child?: ManagedAgent,
  ) {}

  public getRoleBindingForToolCatalog(agentId: string) {
    return agentId === "agent-caller" && this.roleId ? { roleId: this.roleId } : undefined;
  }

  public resolveSlpPolicyForRoleBinding() {
    return slpContribution;
  }

  public resolveActiveSlpPolicy() {
    return slpContribution;
  }

  public getAgent(agentId: string): ManagedAgent | null {
    if (agentId === this.child?.id) {
      return this.child;
    }
    if (agentId !== "agent-caller") {
      return null;
    }
    return {
      id: agentId,
      cwd: "/tmp/room-agent",
      workspaceId: "workspace-room",
      internal: false,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Room caller" },
      labels: {},
    } as ManagedAgent;
  }

  public listAgents(): ManagedAgent[] {
    return [];
  }

  public async updateAgentMetadata(
    agentId: string,
    updates: { title?: string; labels?: Record<string, string> },
  ): Promise<void> {
    this.metadataUpdates.push({ agentId, updates });
  }
}

class RoomAgentStorageFake {
  public async get(): Promise<StoredAgentRecord | null> {
    return null;
  }

  public async list(): Promise<StoredAgentRecord[]> {
    return [];
  }
}

class RoomChatServiceFake {
  public readonly created: Array<Parameters<FileBackedChatService["createRoom"]>[0]> = [];
  public readonly dispatched: Array<Parameters<FileBackedChatService["dispatchMessage"]>[0]> = [];
  public readonly deleted: Array<Parameters<FileBackedChatService["deleteRoom"]>[0]> = [];
  public readonly messages: ChatMessage[];

  public constructor(
    messages: ChatMessage[] = [],
    private readonly dispatchError: Error | null = null,
  ) {
    this.messages = messages.map((message) => ({ authorKind: "agent", ...message }));
  }

  public async createRoom(
    input: Parameters<FileBackedChatService["createRoom"]>[0],
  ): Promise<ChatRoomDetail> {
    this.created.push(input);
    return {
      id: "room-1",
      name: input.name,
      purpose: input.purpose ?? null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      messageCount: 0,
      lastMessageAt: null,
    };
  }

  public async readMessages(
    input: Parameters<FileBackedChatService["readMessages"]>[0],
  ): Promise<ChatMessage[]> {
    return this.messages.filter(
      (message) =>
        message.roomId === input.room &&
        (!input.authorAgentId || message.authorAgentId === input.authorAgentId),
    );
  }

  public async listRoomPosterAgentIds(): Promise<string[]> {
    return [];
  }

  public async dispatchMessage(
    input: Parameters<FileBackedChatService["dispatchMessage"]>[0],
  ): Promise<ChatMessage> {
    this.dispatched.push(input);
    if (this.dispatchError) throw this.dispatchError;
    return {
      id: "message-1",
      roomId: input.room,
      authorAgentId: input.authorAgentId,
      authorKind: input.authorKind,
      body: input.body,
      replyToMessageId: input.replyToMessageId ?? null,
      mentionAgentIds: [],
      createdAt: "2026-08-04T00:00:00.000Z",
    };
  }

  public async deleteRoom(
    input: Parameters<FileBackedChatService["deleteRoom"]>[0],
  ): Promise<void> {
    this.deleted.push(input);
  }
}

function createAuthoritativeWorkspaceRegistry(
  records: Record<string, { projectId: string; archivedAt: string | null }> = {
    "workspace-room": { projectId: "project-room", archivedAt: null },
  },
) {
  return {
    get: async (workspaceId: string) => {
      const record = records[workspaceId];
      return record ? { workspaceId, ...record } : null;
    },
    list: async () => [],
    upsert: async () => {},
  };
}

function createCatalog(options: {
  callerAgentId?: string;
  roleId?: "lead" | "peer" | "supervisor";
  agentManager?: RoomAgentManagerFake;
  chatService?: RoomChatServiceFake;
  enablePosting?: boolean;
  workspaceRegistry?: ReturnType<typeof createAuthoritativeWorkspaceRegistry>;
  councilCaseStore?: CouncilCaseStoreFake;
}) {
  return createPaseoToolCatalog({
    agentManager: (options.agentManager ??
      new RoomAgentManagerFake(options.roleId)) as unknown as AgentManager,
    agentStorage: new RoomAgentStorageFake() as unknown as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    callerAgentId: options.callerAgentId,
    chatService: options.chatService as unknown as FileBackedChatService,
    workspaceRegistry: (options.workspaceRegistry ??
      createAuthoritativeWorkspaceRegistry()) as unknown as WorkspaceRegistry,
    councilCaseStore: (options.councilCaseStore ??
      new CouncilCaseStoreFake()) as unknown as CouncilCaseStore,
    ...(options.enablePosting
      ? {
          resolveAgentIdentifier: async (identifier: string) => ({
            ok: true as const,
            agentId: identifier,
          }),
          sendAgentMessage: async () => {},
        }
      : {}),
    logger: pino({ level: "silent" }),
  });
}

describe("Paseo room tools", () => {
  test("only exposes room tools to an agent-scoped catalog", () => {
    const chatService = new RoomChatServiceFake();
    const topLevel = createCatalog({ chatService, enablePosting: true });
    const agentReader = createCatalog({ callerAgentId: "agent-caller", chatService });
    const agentPoster = createCatalog({
      callerAgentId: "agent-caller",
      chatService,
      enablePosting: true,
    });

    expect(topLevel.getTool("read_room")).toBeUndefined();
    expect(topLevel.getTool("post_room")).toBeUndefined();
    expect(topLevel.getTool("create_room")).toBeUndefined();
    expect(agentReader.getTool("read_room")).toBeDefined();
    expect(agentReader.getTool("post_room")).toBeUndefined();
    expect(agentReader.getTool("create_room")).toBeUndefined();
    expect(agentPoster.getTool("post_room")).toBeDefined();
  });

  test("lets only a role-bound Lead create a room", async () => {
    const chatService = new RoomChatServiceFake();
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      chatService,
    });
    const peer = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "peer",
      chatService,
    });
    const supervisor = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "supervisor",
      chatService,
    });

    expect(peer.getTool("create_room")).toBeUndefined();
    expect(peer.getTool("start_council")).toBeUndefined();
    expect(peer.getTool("record_council_seat")).toBeUndefined();
    expect(supervisor.getTool("create_room")).toBeUndefined();
    expect(supervisor.getTool("start_council")).toBeUndefined();
    const result = await lead.executeTool("create_room", {
      name: "council-case",
      purpose: "One bounded challenge and response",
    });

    expect(chatService.created).toEqual([
      {
        name: "council-case",
        purpose: "One bounded challenge and response",
        workspaceId: "workspace-room",
        projectId: "project-room",
      },
    ]);
    expect(result.structuredContent).toEqual({
      room: expect.objectContaining({ id: "room-1", name: "council-case" }),
    });
  });

  test("binds a created room to the caller's authoritative project via the workspace registry", async () => {
    const chatService = new RoomChatServiceFake();
    const workspaceRegistry = {
      get: async (workspaceId: string) =>
        workspaceId === "workspace-room" ? { workspaceId, projectId: "project-room" } : null,
      list: async () => [],
      upsert: async () => {},
    };
    const lead = createPaseoToolCatalog({
      agentManager: new RoomAgentManagerFake("lead") as unknown as AgentManager,
      agentStorage: new RoomAgentStorageFake() as unknown as AgentStorage,
      providerSnapshotManager: {} as ProviderSnapshotManager,
      callerAgentId: "agent-caller",
      chatService: chatService as unknown as FileBackedChatService,
      workspaceRegistry: workspaceRegistry as unknown as WorkspaceRegistry,
      logger: pino({ level: "silent" }),
    });

    await lead.executeTool("create_room", { name: "council-case" });

    expect(chatService.created).toEqual([
      {
        name: "council-case",
        purpose: undefined,
        workspaceId: "workspace-room",
        projectId: "project-room",
      },
    ]);
  });

  test("fails closed instead of creating a room when the caller has no workspace", async () => {
    const chatService = new RoomChatServiceFake();
    const agentManager = {
      getRoleBindingForToolCatalog: () => ({ roleId: "lead" as const }),
      getAgent: () =>
        ({
          id: "agent-caller",
          cwd: "/tmp/room-agent",
          workspaceId: undefined,
          internal: false,
          lifecycle: "idle",
          currentModeId: null,
          availableModes: [],
          config: { title: "Room caller" },
          labels: {},
        }) as unknown as ManagedAgent,
      listAgents: () => [],
      updateAgentMetadata: async () => {},
    };
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      agentManager: agentManager as unknown as RoomAgentManagerFake,
      chatService,
    });

    await expect(lead.executeTool("create_room", { name: "council-case" })).rejects.toThrow(
      "Caller has no active workspace to bind this room to",
    );
    expect(chatService.created).toEqual([]);
  });

  test("fails closed instead of creating a room when the caller's workspace is archived", async () => {
    const chatService = new RoomChatServiceFake();
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      chatService,
      workspaceRegistry: createAuthoritativeWorkspaceRegistry({
        "workspace-room": { projectId: "project-room", archivedAt: "2026-08-01T00:00:00.000Z" },
      }),
    });

    await expect(lead.executeTool("create_room", { name: "council-case" })).rejects.toThrow(
      "Caller workspace 'workspace-room' is unavailable or archived",
    );
    expect(chatService.created).toEqual([]);
  });

  test("fails closed instead of starting a Council when the caller's workspace does not resolve", async () => {
    const chatService = new RoomChatServiceFake();
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      chatService,
      workspaceRegistry: createAuthoritativeWorkspaceRegistry({}),
    });

    await expect(
      lead.executeTool("start_council", {
        title: "Choose the implementation boundary",
        question: "Which change is smallest and still technically enforced?",
      }),
    ).rejects.toThrow("Caller workspace 'workspace-room' is unavailable or archived");
    expect(chatService.created).toEqual([]);
  });

  test("starts a Lead-owned Council with one Room and canonical Peer seat plans", async () => {
    const chatService = new RoomChatServiceFake();
    const councilCaseStore = new CouncilCaseStoreFake();
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      chatService,
      councilCaseStore,
    });

    const result = await lead.executeTool("start_council", {
      title: "Choose the implementation boundary",
      question: "Which change is smallest and still technically enforced?",
    });

    expect(chatService.created).toHaveLength(1);
    expect(chatService.dispatched).toEqual([
      expect.objectContaining({
        room: "room-1",
        authorAgentId: "agent-caller",
        body: expect.stringContaining("Sealed seats: architect, reviewer"),
      }),
    ]);
    expect(councilCaseStore.created).toEqual([
      expect.objectContaining({
        title: "Choose the implementation boundary",
        workspaceId: "workspace-room",
        projectId: "project-room",
        parentAgentId: "agent-caller",
        roles: ["architect", "reviewer"],
      }),
    ]);
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        caseId: expect.stringMatching(/^case_[a-f0-9]{12}$/u),
        phase: "sealed",
        room: expect.objectContaining({ id: "room-1" }),
        seats: [
          expect.objectContaining({
            role: "architect",
            peerSubrole: "architect",
            executionProfile: "solution-architect",
          }),
          expect.objectContaining({
            role: "reviewer",
            peerSubrole: "reviewer",
            executionProfile: "reviewer",
          }),
        ],
      }),
    );
  });

  test("removes the Room when canonical Council kickoff fails", async () => {
    const chatService = new RoomChatServiceFake([], new Error("kickoff write failed"));
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      chatService,
    });

    await expect(
      lead.executeTool("start_council", {
        title: "Rollback partial Council",
        question: "Does a failed kickoff leave an orphan Room?",
      }),
    ).rejects.toThrow("kickoff write failed");
    expect(chatService.deleted).toEqual([{ room: "room-1" }]);
  });

  test("supports a one-seat lens Council without inventing a second seat", async () => {
    const chatService = new RoomChatServiceFake();
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      chatService,
    });

    const result = await lead.executeTool("start_council", {
      title: "Review one bounded proposition",
      question: "Is the supplied evidence sufficient?",
      tier: "lens",
      roles: ["reviewer"],
    });

    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        tier: "lens",
        seats: [
          expect.objectContaining({
            role: "reviewer",
            executionProfile: "reviewer",
          }),
        ],
      }),
    );
  });

  test("lets a Lead record only its own direct Peer Council seat", async () => {
    const reportBody = [
      "SCOUT_COUNCIL_REPORT_V1",
      "VERDICT: usable independent report",
      "SCOUT_COUNCIL_REPORT_END",
    ].join("\n");
    const child = {
      id: "peer-seat",
      cwd: "/tmp/room-agent",
      workspaceId: "workspace-room",
      internal: false,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Scout seat" },
      labels: {
        "paseo.parent-agent-id": "agent-caller",
        "council.case_id": "case_123456789abc",
        "council.role": "scout",
        "council.room_id": "room-1",
        "council.kickoff_message_id": "kickoff-1",
        "council.report_start_sentinel": "SCOUT_COUNCIL_REPORT_V1",
        "council.report_end_sentinel": "SCOUT_COUNCIL_REPORT_END",
      },
      roleBinding: { roleId: "peer" },
    } as ManagedAgent;
    const agentManager = new RoomAgentManagerFake("lead", child);
    const councilCaseStore = new CouncilCaseStoreFake();
    const chatService = new RoomChatServiceFake([
      {
        id: "kickoff-1",
        roomId: "room-1",
        authorAgentId: "agent-caller",
        body: "Council case_123456789abc: Choose the implementation boundary",
        replyToMessageId: null,
        mentionAgentIds: [],
        createdAt: "2026-08-12T00:00:00.000Z",
      },
      {
        id: "report-1",
        roomId: "room-1",
        authorAgentId: "peer-seat",
        body: reportBody,
        replyToMessageId: null,
        mentionAgentIds: [],
        createdAt: "2026-08-12T00:01:00.000Z",
      },
    ]);
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      agentManager,
      chatService,
      councilCaseStore,
    });

    const result = await lead.executeTool("record_council_seat", {
      caseId: "case_123456789abc",
      agentId: "peer-seat",
      phase: "review",
      integrity: "valid",
      reportMessageId: "report-1",
      disposition: "usable independent report",
    });

    expect(agentManager.metadataUpdates).toEqual([
      {
        agentId: "peer-seat",
        updates: {
          labels: {
            "council.phase": "review",
            "council.integrity": "valid",
            "council.disposition": "usable independent report",
            "council.report_message_id": "report-1",
            "council.report_digest": createHash("sha256").update(reportBody).digest("hex"),
            "council.report_created_at": "2026-08-12T00:01:00.000Z",
            "council.report_receipt_version": "1",
          },
        },
      },
    ]);
    expect(councilCaseStore.recorded).toEqual([
      expect.objectContaining({
        caseId: "case_123456789abc",
        agentId: "peer-seat",
        phase: "review",
        integrity: "valid",
        reportReceipt: expect.objectContaining({ reportMessageId: "report-1" }),
      }),
    ]);
    expect(result.structuredContent).toEqual({
      agentId: "peer-seat",
      caseId: "case_123456789abc",
      phase: "review",
      integrity: "valid",
      disposition: "usable independent report",
      reportReceipt: {
        roomId: "room-1",
        kickoffMessageId: "kickoff-1",
        reportMessageId: "report-1",
        reportDigest: createHash("sha256").update(reportBody).digest("hex"),
        authorAgentId: "peer-seat",
        startSentinel: "SCOUT_COUNCIL_REPORT_V1",
        endSentinel: "SCOUT_COUNCIL_REPORT_END",
        createdAt: "2026-08-12T00:01:00.000Z",
      },
    });
  });

  test("rejects generic updates to daemon-managed Council labels", async () => {
    const child = {
      id: "peer-seat",
      cwd: "/tmp/room-agent",
      workspaceId: "workspace-room",
      internal: false,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Scout seat" },
      labels: { "council.case_id": "case_123456789abc" },
      roleBinding: { roleId: "peer" },
    } as ManagedAgent;
    const agentManager = new RoomAgentManagerFake("lead", child);
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      agentManager,
      chatService: new RoomChatServiceFake(),
    });

    await expect(
      lead.executeTool("update_agent", {
        agentId: "peer-seat",
        labels: {
          "council.integrity": "valid",
          "council.report_receipt_version": "1",
        },
      }),
    ).rejects.toThrow("Council labels are daemon-managed");
    expect(agentManager.metadataUpdates).toEqual([]);
  });

  test("rejects valid Council integrity without the exact Peer-authored Room receipt", async () => {
    const child = {
      id: "peer-seat",
      cwd: "/tmp/room-agent",
      workspaceId: "workspace-room",
      internal: false,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Scout seat" },
      labels: {
        "paseo.parent-agent-id": "agent-caller",
        "council.case_id": "case_123456789abc",
        "council.role": "scout",
        "council.room_id": "room-1",
        "council.kickoff_message_id": "kickoff-1",
        "council.report_start_sentinel": "SCOUT_COUNCIL_REPORT_V1",
        "council.report_end_sentinel": "SCOUT_COUNCIL_REPORT_END",
      },
      roleBinding: { roleId: "peer" },
    } as ManagedAgent;
    const agentManager = new RoomAgentManagerFake("lead", child);
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      agentManager,
      chatService: new RoomChatServiceFake(),
    });

    await expect(
      lead.executeTool("record_council_seat", {
        caseId: "case_123456789abc",
        agentId: "peer-seat",
        phase: "review",
        integrity: "valid",
      }),
    ).rejects.toThrow("integrity=valid requires reportMessageId");
    expect(agentManager.metadataUpdates).toEqual([]);
  });

  test("rejects valid Council integrity while the seat is still running", async () => {
    const child = {
      id: "peer-seat",
      cwd: "/tmp/room-agent",
      workspaceId: "workspace-room",
      internal: false,
      lifecycle: "running",
      currentModeId: null,
      availableModes: [],
      config: { title: "Scout seat" },
      labels: {
        "paseo.parent-agent-id": "agent-caller",
        "council.case_id": "case_123456789abc",
      },
      roleBinding: { roleId: "peer" },
    } as ManagedAgent;
    const agentManager = new RoomAgentManagerFake("lead", child);
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      agentManager,
      chatService: new RoomChatServiceFake(),
    });

    await expect(
      lead.executeTool("record_council_seat", {
        caseId: "case_123456789abc",
        agentId: "peer-seat",
        phase: "review",
        integrity: "valid",
        reportMessageId: "report-1",
      }),
    ).rejects.toThrow("is not terminal; current lifecycle is 'running'");
    expect(agentManager.metadataUpdates).toEqual([]);
  });

  test.each([
    {
      name: "wrong author",
      authorAgentId: "another-peer",
      authorKind: "agent" as const,
      body: "SCOUT_COUNCIL_REPORT_V1\nVERDICT: usable\nSCOUT_COUNCIL_REPORT_END",
      error: "is not authored by Peer",
    },
    {
      name: "client provenance",
      authorAgentId: "peer-seat",
      authorKind: "client" as const,
      body: "SCOUT_COUNCIL_REPORT_V1\nVERDICT: usable\nSCOUT_COUNCIL_REPORT_END",
      error: "is not authored by Peer",
    },
    {
      name: "wrong sentinel",
      authorAgentId: "peer-seat",
      authorKind: "agent" as const,
      body: "FORGED_COUNCIL_REPORT_V1\nVERDICT: usable\nFORGED_COUNCIL_REPORT_END",
      error: "does not satisfy SCOUT_COUNCIL_REPORT_V1..SCOUT_COUNCIL_REPORT_END",
    },
  ])("rejects a $name Council report", async ({ authorAgentId, authorKind, body, error }) => {
    const child = {
      id: "peer-seat",
      cwd: "/tmp/room-agent",
      workspaceId: "workspace-room",
      internal: false,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Scout seat" },
      labels: {
        "paseo.parent-agent-id": "agent-caller",
        "council.case_id": "case_123456789abc",
        "council.role": "scout",
        "council.room_id": "room-1",
        "council.kickoff_message_id": "kickoff-1",
        "council.report_start_sentinel": "SCOUT_COUNCIL_REPORT_V1",
        "council.report_end_sentinel": "SCOUT_COUNCIL_REPORT_END",
      },
      roleBinding: { roleId: "peer" },
    } as ManagedAgent;
    const agentManager = new RoomAgentManagerFake("lead", child);
    const lead = createCatalog({
      callerAgentId: "agent-caller",
      roleId: "lead",
      agentManager,
      chatService: new RoomChatServiceFake([
        {
          id: "kickoff-1",
          roomId: "room-1",
          authorAgentId: "agent-caller",
          body: "Council case_123456789abc: Choose the implementation boundary",
          replyToMessageId: null,
          mentionAgentIds: [],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        {
          id: "report-1",
          roomId: "room-1",
          authorAgentId,
          authorKind,
          body,
          replyToMessageId: null,
          mentionAgentIds: [],
          createdAt: "2026-08-12T00:01:00.000Z",
        },
      ]),
    });

    await expect(
      lead.executeTool("record_council_seat", {
        caseId: "case_123456789abc",
        agentId: "peer-seat",
        phase: "review",
        integrity: "valid",
        reportMessageId: "report-1",
      }),
    ).rejects.toThrow(error);
    expect(agentManager.metadataUpdates).toEqual([]);
  });

  test("binds post_room author identity to the calling agent", async () => {
    const chatService = new RoomChatServiceFake();
    const catalog = createCatalog({
      callerAgentId: "agent-caller",
      chatService,
      enablePosting: true,
    });

    const result = await catalog.executeTool("post_room", {
      room: "release-room",
      body: "Ready for review",
      authorAgentId: "spoofed-agent",
    });

    expect(chatService.dispatched).toEqual([
      expect.objectContaining({
        room: "release-room",
        body: "Ready for review",
        authorAgentId: "agent-caller",
        authorKind: "agent",
      }),
    ]);
    expect(result.structuredContent).toEqual({
      message: expect.objectContaining({
        authorAgentId: "agent-caller",
        authorKind: "agent",
      }),
    });
  });
});
