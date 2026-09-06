import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { createAgentCommand } from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";

const logger = createTestLogger();

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

async function removeRealAgentManagerWorkdir({
  agentManager,
  storage,
  workdir,
}: {
  agentManager: AgentManager;
  storage: AgentStorage;
  workdir: string;
}): Promise<void> {
  agentManager.prepareForShutdown();
  await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
  await agentManager.flushForShutdown();
  await storage.flush();
  rmSync(workdir, { recursive: true, force: true });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
      setupContinuation: { kind: "agent" as const, startAfterAgentCreate: () => {} },
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("role preflight fails before a session builder can create side effects", async () => {
  const buildSessionConfig = vi.fn(async (config: { provider: string; cwd: string }) => ({
    sessionConfig: config,
  }));
  const createAgent = vi.fn();
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      preflightRoleCreate: vi.fn(() => {
        throw new Error("bundled_policy_pack_missing");
      }),
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "codex", cwd: "/tmp/paseo-preflight" },
      workspaceId: "workspace-preflight",
      roleId: "lead",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig,
    }),
  ).rejects.toThrow("bundled_policy_pack_missing");
  expect(buildSessionConfig).not.toHaveBeenCalled();
  expect(createAgent).not.toHaveBeenCalled();
});

test("role preflight fails before MCP worktree or workspace creation", async () => {
  const createPaseoWorktree = vi.fn();
  const ensureWorkspaceForCreate = vi.fn();
  const createAgent = vi.fn();
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      preflightRoleCreate: vi.fn(() => {
        throw new Error("bundled_policy_pack_missing");
      }),
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    createPaseoWorktree,
    ensureWorkspaceForCreate,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "mcp",
      provider: "codex/gpt-5.5",
      roleId: "lead",
      title: "Preflight failure",
      labels: {},
      background: true,
      notifyOnFinish: false,
      worktree: { worktreeName: "should-not-exist", baseBranch: "main" },
    }),
  ).rejects.toThrow("bundled_policy_pack_missing");
  expect(createPaseoWorktree).not.toHaveBeenCalled();
  expect(ensureWorkspaceForCreate).not.toHaveBeenCalled();
  expect(createAgent).not.toHaveBeenCalled();
});

test("MCP create adopts and rolls back a workspace provisioned by its tool wrapper", async () => {
  const rollbackWorkspaceAfterFailedCreate = vi.fn(async () => undefined);
  const createAgent = vi.fn();
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      preflightRoleCreate: vi.fn(() => {
        throw new Error("workspace_protocol_admission_required: invalid");
      }),
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    rollbackWorkspaceAfterFailedCreate,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "mcp",
      provider: "codex/gpt-5.5",
      roleId: "lead",
      title: "Reject invalid protocol",
      cwd: "/tmp/paseo-precreated-workspace",
      workspaceId: "workspace-precreated",
      createdDirectoryWorkspaceId: "workspace-precreated",
      labels: {},
      background: true,
      notifyOnFinish: false,
    }),
  ).rejects.toThrow("workspace_protocol_admission_required: invalid");

  expect(rollbackWorkspaceAfterFailedCreate).toHaveBeenCalledWith("workspace-precreated");
  expect(createAgent).not.toHaveBeenCalled();
});

test("MCP create rolls back a freshly minted directory workspace when later admission fails", async () => {
  const ensureWorkspaceForCreate = vi.fn(async () => "workspace-rollback");
  const rollbackWorkspaceAfterFailedCreate = vi.fn(async () => undefined);
  const createAgent = vi.fn();
  const providerSnapshot = createProviderSnapshotManagerStub();
  providerSnapshot.resolveCreateConfig.mockRejectedValue(new Error("provider admission failed"));
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: { createAgent } as unknown as Parameters<
      typeof createAgentCommand
    >[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger,
    providerSnapshotManager: providerSnapshot.manager,
    ensureWorkspaceForCreate,
    rollbackWorkspaceAfterFailedCreate,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "mcp",
      provider: "codex/gpt-5.5",
      title: "Rollback failed create",
      cwd: "/tmp/paseo-rollback",
      labels: {},
      background: true,
      notifyOnFinish: false,
    }),
  ).rejects.toThrow("provider admission failed");

  expect(ensureWorkspaceForCreate).toHaveBeenCalledTimes(1);
  expect(rollbackWorkspaceAfterFailedCreate).toHaveBeenCalledWith("workspace-rollback");
  expect(createAgent).not.toHaveBeenCalled();
});

test("MCP create rolls back a fresh worktree when target protocol admission fails", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "paseo-worktree-rollback-"));
  const rollbackWorktreeAfterFailedCreate = vi.fn(async () => undefined);
  const createAgent = vi.fn();
  const preflightRoleCreate = vi.fn((input: { cwd?: string }) => {
    if (input.cwd) throw new Error("workspace_protocol_admission_required: invalid");
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: { preflightRoleCreate, createAgent } as unknown as Parameters<
      typeof createAgentCommand
    >[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    createPaseoWorktree: fakeWorktreeCreator({
      repoRoot,
      createdWorkspaceId: "workspace-worktree-rollback",
    }),
    rollbackWorktreeAfterFailedCreate,
  };

  try {
    await expect(
      createAgentCommand(dependencies, {
        kind: "mcp",
        provider: "codex/gpt-5.5",
        roleId: "lead",
        title: "Rollback invalid target",
        cwd: repoRoot,
        labels: {},
        background: true,
        notifyOnFinish: false,
        worktree: { worktreeName: "rollback-target", baseBranch: "main" },
      }),
    ).rejects.toThrow("workspace_protocol_admission_required: invalid");

    expect(preflightRoleCreate).toHaveBeenCalledTimes(2);
    expect(rollbackWorktreeAfterFailedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ workspaceId: "workspace-worktree-rollback" }),
      }),
    );
    expect(createAgent).not.toHaveBeenCalled();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBandAuthorized: vi.fn(async () => false),
      hasInFlightRun: vi.fn(() => false),
      startAuthorizedAgentStream: vi.fn(async (...args: Parameters<typeof streamAgent>) =>
        streamAgent(...args),
      ),
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
    clientMessageId: "msg-create-1",
  });
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create rejects caller-forged Council receipt labels before provider work", async () => {
  const createAgent = vi.fn();
  const stub = createProviderSnapshotManagerStub();
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: { createAgent } as unknown as Parameters<
      typeof createAgentCommand
    >[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
      workspaceId: "ws-create-test",
      labels: {
        "council.phase": "verdict",
        "council.integrity": "valid",
        "council.report_receipt_version": "1",
      },
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    }),
  ).rejects.toThrow("is daemon-managed");

  expect(stub.resolveCreateConfig).not.toHaveBeenCalled();
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    featureValues: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      preflightRoleCreate: vi.fn(),
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      featureValues: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("session create requests unattended provider config for a role-bound launch", async () => {
  const snapshot = {
    id: "agent-role-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-role-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({ modeId: "bypassPermissions" });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      preflightRoleCreate: vi.fn(),
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "claude", cwd: "/tmp/paseo-create-role-test" },
    workspaceId: "ws-create-role-test",
    roleId: "lead",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      unattended: true,
    }),
  );
  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ modeId: "bypassPermissions" }),
    undefined,
    expect.objectContaining({ roleId: "lead" }),
  );
});

test("session create leaves an ordinary interactive launch attended", async () => {
  const snapshot = {
    id: "agent-interactive-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-interactive-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const stub = createProviderSnapshotManagerStub();
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "claude", cwd: "/tmp/paseo-create-interactive-test" },
    workspaceId: "ws-create-interactive-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({ unattended: false }),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const assignment: AssignmentEnvelope = {
    version: 1,
    disposition: "peer-execution",
    objective: "Inspect the provider default.",
    effectClass: "read-only",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    evidence: "Return provider resolution evidence.",
    handbackAndStop: "Stop after handback.",
  };
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      preflightRoleCreate: vi.fn(),
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        expect(input.unattended).toBe(true);
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    roleId: "peer",
    assignment,
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    background: true,
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    undefined,
    expect.objectContaining({
      workspaceId: "ws-create-test",
      roleId: "peer",
      assignment,
      assignmentAssigner: { kind: "human-session" },
    }),
  );
});

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create stamps the new worktree's workspaceId when a setup continuation runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({
          sessionConfig: config,
          setupContinuation: { kind: "agent", startAfterAgentCreate: () => {} },
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-new-worktree");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;
  let markCallbackStarted!: () => void;
  let releaseCallback!: () => void;
  const callbackStarted = new Promise<void>((resolve) => {
    markCallbackStarted = resolve;
  });
  const callbackGate = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });

  try {
    const createPromise = createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        background: true,
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: async ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
          markCallbackStarted();
          await callbackGate;
        },
      },
    );

    await callbackStarted;
    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
    releaseCallback();
    await createPromise;
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create registers a durable finish-notification watch before the initial prompt dispatches", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-finish-watch-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const { snapshot: child } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "watched child",
        cwd: workdir,
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: true,
        callerAgentId: parent.id,
      },
    );

    // Registered before the prompt was even sent — this is the durable evidence
    // a daemon restart between dispatch and attach would recover against.
    const storedChild = await storage.get(child.id);
    expect(storedChild?.finishNotificationWatches).toEqual([
      expect.objectContaining({ callerAgentId: parent.id, requireParentOwnership: true }),
    ]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create cancels the finish-notification watch when the initial prompt never starts", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-finish-watch-cancel-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    // No initialPrompt: sendInitialPrompt never runs, so the watch this create
    // registered must not linger "active" forever for restart resume to find.
    const { snapshot: child } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "unwatched child",
        cwd: workdir,
        background: true,
        notifyOnFinish: true,
        callerAgentId: parent.id,
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.finishNotificationWatches).toEqual([
      expect.objectContaining({ callerAgentId: parent.id, status: "stopped" }),
    ]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});
