import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded, hasPendingAgentInitialization } from "./agent-loading.js";
import { startAgentRun } from "./agent-prompt.js";
import { AgentStorage } from "./agent-storage.js";
import { withAgentAuthorityLock } from "./agent-authority-lock.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, { purpose: "interactive" }]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("does not resume a predecessor with a released write lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-released-lead-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("expected Codex test client");
  let resumeCount = 0;
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (config, launchContext) => baseClient.createSession(config, launchContext),
    resumeSession: async (handle, overrides, launchContext, options) => {
      resumeCount += 1;
      return baseClient.resumeSession(handle, overrides, launchContext, options);
    },
    fetchCatalog: async (options) => baseClient.fetchCatalog(options),
    isAvailable: async () => baseClient.isAvailable(),
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000303";

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-released",
    });
    await manager.closeAgent(created.id);
    const record = await storage.get(agentId);
    if (!record) throw new Error("expected stored agent");
    let signalAuthorityHeld!: () => void;
    const authorityHeld = new Promise<void>((resolve) => {
      signalAuthorityHeld = resolve;
    });
    let allowReceiptPersist!: () => void;
    const receiptMayPersist = new Promise<void>((resolve) => {
      allowReceiptPersist = resolve;
    });
    const release = withAgentAuthorityLock(agentId, async () => {
      signalAuthorityHeld();
      await receiptMayPersist;
      await storage.upsert({
        ...record,
        leadHandoffs: [
          {
            id: "handoff-released",
            workspaceId: "workspace-released",
            predecessorAgentId: agentId,
            successorAgentId: "lead-new",
            currentWriteOwnerAgentId: "lead-new",
            objective: "Preserve released runtime closure",
            scope: ["runtime"],
            currentState: "Released",
            decisions: [],
            failedApproaches: [],
            successfulPatterns: [],
            evidenceIndex: [{ ref: "test", claim: "Released receipt exists" }],
            activeRisksAndBlockers: [],
            exactResumePoint: "Use fresh Lead identity",
            stopCondition: "Do not resume predecessor",
            status: "predecessor_released",
            createdAt: new Date().toISOString(),
            receipts: [],
          },
        ],
      });
    });
    await authorityHeld;
    const load = ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await Promise.resolve();
    expect(resumeCount).toBe(0);
    allowReceiptPersist();
    await release;

    await expect(load).rejects.toThrow(`agent_write_lease_released_runtime_closed: ${agentId}`);
    expect(resumeCount).toBe(0);
    expect(manager.getAgent(agentId)).toBeNull();
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("does not hold the authority lock while provider resume is pending", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-resume-liveness-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("expected Codex test client");
  let signalResumeStarted!: () => void;
  const resumeStarted = new Promise<void>((resolve) => {
    signalResumeStarted = resolve;
  });
  let allowResume!: () => void;
  const resumeAllowed = new Promise<void>((resolve) => {
    allowResume = resolve;
  });
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (config, launchContext) => baseClient.createSession(config, launchContext),
    resumeSession: async (handle, overrides, launchContext, options) => {
      signalResumeStarted();
      await resumeAllowed;
      return baseClient.resumeSession(handle, overrides, launchContext, options);
    },
    fetchCatalog: async (options) => baseClient.fetchCatalog(options),
    isAvailable: async () => baseClient.isAvailable(),
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000304";

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-resume-liveness",
    });
    await manager.closeAgent(created.id);
    const load = ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await resumeStarted;

    expect(hasPendingAgentInitialization(agentId)).toBe(true);
    await expect(withAgentAuthorityLock(agentId, async () => "authority-free")).resolves.toBe(
      "authority-free",
    );

    allowResume();
    await expect(load).resolves.toMatchObject({ id: agentId, lifecycle: "idle" });
    expect(hasPendingAgentInitialization(agentId)).toBe(false);
  } finally {
    allowResume();
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming a stored agent keeps its unread flag and its last-activity time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-resume-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000401";
  const lastActive = "2026-01-02T03:04:05.000Z";
  const markedUnread = "2026-01-09T03:04:05.000Z";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-a",
    });
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected a stored agent");
    }
    // The agent finished days ago, and was marked unread later without being opened, which
    // moves `updatedAt` on its own. Clients already hold that newer time, and
    // `acceptAgentDirectoryUpdate` drops anything older, so the resumed agent must not come
    // back carrying only `lastActivityAt`.
    await storage.upsert({
      ...stored,
      updatedAt: markedUnread,
      lastActivityAt: lastActive,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: lastActive,
    });

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
    await manager.flush();
    await storage.flush();

    // Loading the runtime is neither the agent working nor the user reading the chat.
    // Forging either rewrites the workspace's "last used" and drops it out of Ready to review.
    const resumed = await storage.get(agentId);
    expect(resumed?.requiresAttention).toBe(true);
    expect(resumed?.attentionReason).toBe("finished");
    expect(resumed?.updatedAt).toBe(markedUnread);
    expect(resumed?.lastActivityAt).toBe(markedUnread);
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(true);
    expect(manager.getAgent(agentId)?.updatedAt.toISOString()).toBe(markedUnread);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("loads an archived agent's history after its working directory is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-missing-cwd-"));
  const worktree = path.join(root, "managed-worktree");
  await mkdir(worktree, { recursive: true });
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000501";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: worktree }, agentId, {
      workspaceId: "workspace-worktree",
    });
    await startAgentRun(manager, agent.id, "what did you change", logger, {});
    // Dispatching a run does not finish it: the provider appends the reply to its
    // history afterwards, and the turn is finalized only once that append lands.
    // Archive after the turn is finalized so the transcript this test reads back is
    // already on disk when the worktree goes away.
    const finished = await manager.waitForAgentEvent(agent.id);
    expect(finished.status).toBe("idle");
    await manager.archiveAgent(agent.id);
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    // Archiving the workspace removes the worktree it owned. The agent's history is
    // persisted and reading it must not depend on that directory still being there.
    await rm(worktree, { recursive: true, force: true });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(loaded.id).toBe(agentId);
    // The transcript is replayed from the provider's persisted history, so the reply the
    // agent gave before the worktree went away is still readable.
    const replies = manager
      .getTimeline(agentId)
      .filter((item) => item.type === "assistant_message");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((item) => item.type === "assistant_message" && item.text.length > 0)).toBe(
      true,
    );
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
