import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";

import type {
  AgentClient,
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createDefaultSlpBundledPolicyRegistry } from "../policy/bundled/slp.js";
import { createProjectHarnessBindingService } from "../project/harness-binding-service.js";
import {
  inspectHarnessProjectMetadata,
  writeHarnessProjectMetadata,
} from "../project/harness-project-metadata-file.js";
import { DEFAULT_HARNESS_PROJECT_METADATA_PATH } from "../project/harness-bootstrap-defaults.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import type { PaseoToolCatalog } from "./tools/types.js";
import { buildWorkspaceProtocolTemplate } from "../../utils/workspace-protocol-file.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ProjectHarnessSession } from "../session/project-harness/project-harness-session.js";

const logger = createTestLogger();
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeRegistries(projectRoot: string) {
  const workspaceRegistry: Pick<WorkspaceRegistry, "get"> = {
    get: async (workspaceId) =>
      ({
        workspaceId,
        projectId: "project-1",
        cwd: projectRoot,
        kind: "directory",
        displayName: "R1 test workspace",
        title: null,
        branch: null,
        worktreeRoot: null,
        baseBranch: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
        createdAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:00:00.000Z",
        archivedAt: null,
      }) as never,
  };
  const project = {
    projectId: "project-1",
    rootPath: projectRoot,
    kind: "non_git" as const,
    displayName: "R1 test project",
    projectKey: null,
    workGraphId: null,
    customName: null,
    customIconRevision: null,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    archivedAt: null,
  };
  const projectRegistry: Pick<ProjectRegistry, "get" | "list"> = {
    get: async (projectId) => (projectId === project.projectId ? project : null) as never,
    list: async () => [project],
  };
  return { workspaceRegistry, projectRegistry };
}

function supervisorAssignment(): {
  version: 1;
  disposition: "supervision";
  objective: string;
  effectClass: "delegation";
  mutationBoundary: { mode: "no-write" };
  externalEffectBoundary: { mode: "denied" };
  evidence: string;
  handbackAndStop: string;
  notebookGrant: { scope: string; expiresAt: string };
} {
  return {
    version: 1,
    disposition: "supervision",
    objective: "Exercise bounded Supervisor notebook authority.",
    effectClass: "delegation",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    evidence: "Return the durable harness receipt and notebook revision.",
    handbackAndStop: "Stop after the bounded runtime proof.",
    notebookGrant: {
      scope: "R1 runtime notebook records",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
  };
}

function supervisorReadOnlyAssignment() {
  return {
    version: 1 as const,
    disposition: "supervision" as const,
    objective: "Exercise Supervisor notebook read context without write authority.",
    effectClass: "delegation" as const,
    mutationBoundary: { mode: "no-write" as const },
    externalEffectBoundary: { mode: "denied" as const },
    evidence: "Return the durable notebook identity without a writer grant.",
    handbackAndStop: "Stop after the bounded read-only runtime proof.",
  };
}

const capabilities = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsNativePaseoTools: true,
};

function makeSession(config: AgentSessionConfig): AgentSession {
  const sessionId = randomUUID();
  const session = {
    provider: "codex" as const,
    capabilities,
    id: sessionId,
    async run() {
      return { sessionId, finalText: "", timeline: [] };
    },
    async startTurn() {
      return { turnId: randomUUID() };
    },
    subscribe() {
      return () => {};
    },
    async *streamHistory() {},
    async getRuntimeInfo() {
      return {
        provider: "codex" as const,
        sessionId,
        model: config.model ?? "gpt-5.4",
        modeId: config.modeId ?? "read-only",
      };
    },
    async getAvailableModes() {
      return [];
    },
    async getCurrentMode() {
      return null;
    },
    async setMode() {},
    getPendingPermissions() {
      return [];
    },
    async respondToPermission() {},
    describePersistence() {
      return { provider: "codex" as const, sessionId };
    },
    async interrupt() {},
    async close() {},
  };
  return session as unknown as AgentSession;
}

function makeClient(input: { failCreate?: boolean; failResume?: boolean }): AgentClient {
  const client = {
    provider: "codex" as const,
    capabilities,
    async isAvailable() {
      return true;
    },
    async materializeProviderLaunchBinding(launchInput: { config: AgentSessionConfig }) {
      return {
        providerId: "codex",
        providerFamily: "codex",
        model: launchInput.config.model ?? "gpt-5.4",
        credentialConfigured: true as const,
        routeKind: "codex-subscription" as const,
        modelProviderId: "openai" as const,
        authMethod: "codex-native" as const,
      };
    },
    async createSession(config: AgentSessionConfig) {
      if (input.failCreate) throw new Error("provider_create_failed");
      return makeSession(config);
    },
    async resumeSession(
      _handle: { provider: string; sessionId: string },
      config?: Partial<AgentSessionConfig>,
      _launchContext?: AgentLaunchContext,
    ) {
      if (input.failResume) throw new Error("provider_resume_failed");
      return makeSession({
        provider: "codex",
        cwd: config?.cwd ?? process.cwd(),
        model: config?.model ?? "gpt-5.4",
      });
    },
  };
  return client as unknown as AgentClient;
}

interface HarnessRegistries {
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  projectRegistry: Pick<ProjectRegistry, "get" | "list">;
}

function makeCatalogFactory(input: {
  manager: AgentManager;
  storage: AgentStorage;
  registries: HarnessRegistries;
  capture: (catalog: PaseoToolCatalog, callerAgentId?: string) => void;
}) {
  const providerSnapshotManager = {
    listRegisteredProviderIds: () => ["codex"],
    listModels: async () => [],
    listProviders: async () => [],
    getProvider: async () => null,
  };
  return ({
    callerAgentId,
    paseoToolPolicy,
  }: {
    callerAgentId?: string;
    paseoToolPolicy?: { enabled: boolean; allowedTools?: string[] };
  }) => {
    const catalog = createPaseoToolCatalog({
      agentManager: input.manager,
      agentStorage: input.storage,
      providerSnapshotManager: providerSnapshotManager as never,
      workspaceRegistry: input.registries.workspaceRegistry,
      projectRegistry: input.registries.projectRegistry,
      callerAgentId,
      paseoToolPolicy,
      logger,
    });
    input.capture(catalog, callerAgentId);
    return catalog;
  };
}

function validRecord() {
  return {
    schemaVersion: 1,
    recordId: "r1-runtime-record",
    episode: "runtime-binding",
    scope: "R1 runtime notebook records",
    observation: "The actual filtered Paseo catalog reached the durable notebook.",
    evidence: ["agent-manager-harness-binding.test.ts"],
    suspectedMechanism: {
      status: "supported",
      statement: "The pinned role binding carried the notebook context.",
    },
    impact: "authority",
    questionForLead: "Can E1 project this record without changing its causal meaning?",
    recovery: "Keep the expected-revision CAS receipt.",
    outcome: "One bounded record was appended without changing the binding.",
    patternStatus: "one-off",
    recommendation: "Preserve the receipt across resume.",
    escalation: "lead",
    currentEpisode: "Observed",
    laterEffect: "Unobserved",
    laterEffectEvidenceRefs: [],
    observedAt: "2026-09-07T00:00:00.000Z",
  } as const;
}

describe("AgentManager durable Project Harness lifecycle", () => {
  test("rejects a role-bound parent workspace with a registered child cwd before provider launch", async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "agent-manager-harness-parent-child-"));
    tempDirs.push(parentRoot);
    const childRoot = join(parentRoot, "registered-child");
    mkdirSync(childRoot, { recursive: true });
    writeFileSync(
      join(parentRoot, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(parentRoot),
      "utf8",
    );
    writeFileSync(
      join(childRoot, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(childRoot),
      "utf8",
    );

    const workspaces = new Map([
      [
        "workspace-parent",
        {
          workspaceId: "workspace-parent",
          projectId: "project-parent",
          cwd: parentRoot,
          kind: "directory" as const,
          displayName: "parent",
          title: null,
          branch: null,
          worktreeRoot: null,
          baseBranch: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      [
        "workspace-child",
        {
          workspaceId: "workspace-child",
          projectId: "project-child",
          cwd: childRoot,
          kind: "directory" as const,
          displayName: "child",
          title: null,
          branch: null,
          worktreeRoot: null,
          baseBranch: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:00:00.000Z",
          archivedAt: null,
        },
      ],
    ]);
    const projects = new Map([
      [
        "project-parent",
        {
          projectId: "project-parent",
          rootPath: parentRoot,
          kind: "non_git" as const,
          displayName: "parent",
          projectKey: null,
          workGraphId: null,
          customName: null,
          customIconRevision: null,
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      [
        "project-child",
        {
          projectId: "project-child",
          rootPath: childRoot,
          kind: "non_git" as const,
          displayName: "child",
          projectKey: null,
          workGraphId: null,
          customName: null,
          customIconRevision: null,
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:00:00.000Z",
          archivedAt: null,
        },
      ],
    ]);
    const registries = {
      workspaceRegistry: {
        get: async (workspaceId: string) => workspaces.get(workspaceId) ?? null,
        list: async () => Array.from(workspaces.values()),
      },
      projectRegistry: {
        get: async (projectId: string) => projects.get(projectId) ?? null,
        list: async () => Array.from(projects.values()),
      },
    };
    const storage = new AgentStorage(join(parentRoot, "agents"), logger);
    const resolver = createProjectHarnessBindingService(registries);
    let providerCreateCalls = 0;
    const client = makeClient({});
    const createSession = client.createSession.bind(client);
    client.createSession = async (...args) => {
      providerCreateCalls += 1;
      return createSession(...args);
    };
    const manager = new AgentManager({
      clients: { codex: client },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });

    await expect(
      manager.createAgent(
        { provider: "codex", cwd: childRoot, model: "gpt-5.4" },
        "00000000-0000-4000-8000-000000000505",
        {
          workspaceId: "workspace-parent",
          roleId: "supervisor",
          assignment: supervisorAssignment(),
        },
      ),
    ).rejects.toThrow(/harness_binding_registered_project_mismatch/u);
    expect(providerCreateCalls).toBe(0);
    expect(
      inspectHarnessProjectMetadata(parentRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH).status,
    ).toBe("missing");
  });

  test("keeps Product identity for a worktree under a registered Foundation container", async () => {
    const foundationRoot = mkdtempSync(
      join(tmpdir(), "agent-manager-harness-foundation-container-"),
    );
    const productRoot = mkdtempSync(join(tmpdir(), "agent-manager-harness-product-canonical-"));
    tempDirs.push(foundationRoot, productRoot);
    const worktreeRoot = join(foundationRoot, ".worktrees", "product");
    const cwd = join(worktreeRoot, "nested", "src");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(worktreeRoot, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(worktreeRoot),
      "utf8",
    );
    writeFileSync(join(cwd, "WORKSPACE_PROTOCOL.md"), buildWorkspaceProtocolTemplate(cwd), "utf8");

    const foundationProject = {
      projectId: "project-foundation",
      rootPath: foundationRoot,
      kind: "non_git" as const,
      displayName: "Foundation container",
      projectKey: null,
      workGraphId: null,
      customName: null,
      customIconRevision: null,
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
      archivedAt: null,
    };
    const productProject = {
      projectId: "project-product",
      rootPath: productRoot,
      kind: "git" as const,
      displayName: "Product canonical",
      projectKey: null,
      workGraphId: null,
      customName: null,
      customIconRevision: null,
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
      archivedAt: null,
    };
    const workspace = {
      workspaceId: "workspace-product-worktree",
      projectId: productProject.projectId,
      cwd: worktreeRoot,
      kind: "worktree" as const,
      displayName: "Product explicit worktree",
      title: null,
      branch: "r1-harness",
      worktreeRoot,
      baseBranch: "main",
      isPaseoOwnedWorktree: true,
      mainRepoRoot: foundationRoot,
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
      archivedAt: null,
    };
    const registries: HarnessRegistries = {
      workspaceRegistry: {
        get: async (workspaceId) => (workspaceId === workspace.workspaceId ? workspace : null),
      },
      projectRegistry: {
        get: async (projectId) => {
          if (projectId === foundationProject.projectId) return foundationProject;
          if (projectId === productProject.projectId) return productProject;
          return null;
        },
        list: async () => [foundationProject, productProject],
      },
    };
    const storage = new AgentStorage(join(productRoot, "agents"), logger);
    const resolver = createProjectHarnessBindingService(registries);
    let catalog: PaseoToolCatalog | undefined;
    const manager = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    manager.setPaseoToolCatalogFactory(
      makeCatalogFactory({
        manager,
        storage,
        registries,
        capture: (created) => {
          catalog = created;
        },
      }),
    );

    const created = await manager.createAgent(
      { provider: "codex", cwd, model: "gpt-5.4" },
      "00000000-0000-4000-8000-000000000511",
      {
        workspaceId: workspace.workspaceId,
        roleId: "supervisor",
        assignment: supervisorAssignment(),
      },
    );

    expect(created.roleBinding?.harnessBinding).toMatchObject({
      projectId: productProject.projectId,
      workspaceId: workspace.workspaceId,
      workspaceRoot: worktreeRoot,
      projectRoot: productRoot,
      cwd,
      notebook: {
        projectScope: "project:project-product",
        reportingTarget: "project:project-product:supervisor-notebook",
      },
    });
    expect(
      inspectHarnessProjectMetadata(productRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH).status,
    ).toBe("valid");
    expect(
      inspectHarnessProjectMetadata(foundationRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH).status,
    ).toBe("missing");

    const actualCatalog = catalog;
    expect(actualCatalog).toBeDefined();
    const read = await actualCatalog!.executeTool("read_project_notebook", {});
    expect(read.structuredContent).toMatchObject({
      projectId: productProject.projectId,
      projectScope: "project:project-product",
      reportingTarget: "project:project-product:supervisor-notebook",
      status: "missing",
    });
    const appended = await actualCatalog!.executeTool("append_project_notebook_record", {
      record: { ...validRecord(), recordId: "r1-worktree-container-record" },
      expectedRevision: null,
    });
    expect(appended.structuredContent).toMatchObject({
      projectId: productProject.projectId,
      recordId: "r1-worktree-container-record",
    });
    expect(existsSync(join(productRoot, "docs/harness/SUPERVISOR_NOTEBOOK.md"))).toBe(true);
    expect(existsSync(join(foundationRoot, "docs/harness/SUPERVISOR_NOTEBOOK.md"))).toBe(false);

    const stored = await storage.get(created.id);
    if (!stored?.persistence || !stored.roleBinding || !stored.launchContract) {
      throw new Error("worktree topology fixture did not persist the role launch contract");
    }
    const resumedManager = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    const resumed = await resumedManager.resumeAgentFromPersistence(
      stored.persistence,
      { model: "gpt-5.4" },
      created.id,
      {
        workspaceId: workspace.workspaceId,
        launchContract: stored.launchContract,
      },
    );
    expect(resumed.roleBinding?.harnessBinding).toMatchObject({
      projectId: productProject.projectId,
      workspaceRoot: worktreeRoot,
      projectRoot: productRoot,
      cwd,
    });

    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    resumedManager.prepareForShutdown();
    await Promise.all(
      resumedManager.listAgents().map((agent) => resumedManager.closeAgent(agent.id)),
    );
    await manager.flushForShutdown();
    await resumedManager.flushForShutdown();
  });

  test("commits the Supervisor writer only at provider launch, persists the pin, and resumes after a notebook append", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-manager-harness-runtime-"));
    tempDirs.push(projectRoot);
    writeFileSync(
      join(projectRoot, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(projectRoot),
      "utf8",
    );
    const storage = new AgentStorage(join(projectRoot, "agents"), logger);
    const registries = makeRegistries(projectRoot);
    const resolver = createProjectHarnessBindingService(registries);
    let catalog: PaseoToolCatalog | undefined;
    const manager = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    manager.setPaseoToolCatalogFactory(
      makeCatalogFactory({
        manager,
        storage,
        registries,
        capture: (created) => {
          catalog = created;
        },
      }),
    );

    const created = await manager.createAgent(
      { provider: "codex", cwd: projectRoot, model: "gpt-5.4" },
      "00000000-0000-4000-8000-000000000501",
      {
        workspaceId: "workspace-1",
        roleId: "supervisor",
        assignment: supervisorAssignment(),
      },
    );

    expect(created.roleBinding?.harnessBinding).toMatchObject({
      package: "paseo-project-harness",
      generation: 1,
      projectId: "project-1",
      workspaceId: "workspace-1",
      notebook: {
        projectScope: "project:project-1",
        reportingTarget: "project:project-1:supervisor-notebook",
        designatedWriterId: created.id,
      },
    });
    const metadata = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(metadata.status).toBe("valid");
    expect(metadata.status === "valid" ? metadata.metadata.supervisorNotebook : null).toMatchObject(
      {
        designatedWriterId: created.id,
      },
    );

    const actualCatalog = catalog;
    expect(actualCatalog).toBeDefined();
    const read = await actualCatalog!.executeTool("read_project_notebook", {});
    expect(read.structuredContent).toMatchObject({
      projectId: "project-1",
      notebookId: created.roleBinding?.harnessBinding?.notebook?.notebookId,
      projectScope: "project:project-1",
      reportingTarget: "project:project-1:supervisor-notebook",
      status: "missing",
    });
    const appended = await actualCatalog!.executeTool("append_project_notebook_record", {
      record: validRecord(),
      expectedRevision: null,
    });
    expect(appended.structuredContent).toMatchObject({
      projectId: "project-1",
      recordId: "r1-runtime-record",
    });

    const stored = await storage.get(created.id);
    expect(stored?.roleBinding?.harnessBinding).toEqual(created.roleBinding?.harnessBinding);
    if (!stored?.persistence || !stored.roleBinding || !stored.launchContract) {
      throw new Error("test setup did not persist the role launch contract");
    }
    const restarted = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    const resumed = await restarted.resumeAgentFromPersistence(
      stored.persistence,
      { model: "gpt-5.4" },
      created.id,
      {
        workspaceId: "workspace-1",
        launchContract: stored.launchContract,
      },
    );
    expect(resumed.roleBinding?.harnessBinding).toEqual(created.roleBinding?.harnessBinding);

    const driftedLaunchContract = {
      ...stored.launchContract,
      roleBinding: {
        ...stored.launchContract.roleBinding,
        harnessBinding: {
          ...stored.launchContract.roleBinding.harnessBinding,
          artifactDigest: "0".repeat(64),
        },
      },
    } as typeof stored.launchContract;
    const driftedManager = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    await expect(
      driftedManager.resumeAgentFromPersistence(
        stored.persistence,
        { model: "gpt-5.4" },
        created.id,
        { workspaceId: "workspace-1", launchContract: driftedLaunchContract },
      ),
    ).rejects.toThrow(/harness_binding_stale/u);
  });

  test("persists a Supervisor notebook identity even without a write grant", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-manager-harness-read-context-"));
    tempDirs.push(projectRoot);
    writeFileSync(
      join(projectRoot, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(projectRoot),
      "utf8",
    );
    const storage = new AgentStorage(join(projectRoot, "agents"), logger);
    const registries = makeRegistries(projectRoot);
    const manager = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: createProjectHarnessBindingService(registries),
      logger,
    });

    const created = await manager.createAgent(
      { provider: "codex", cwd: projectRoot, model: "gpt-5.4" },
      "00000000-0000-4000-8000-000000000503",
      {
        workspaceId: "workspace-1",
        roleId: "supervisor",
        assignment: supervisorReadOnlyAssignment(),
      },
    );

    expect(created.roleBinding?.harnessBinding?.notebook).toMatchObject({
      notebookId: expect.stringMatching(/^nb_[a-f0-9]{24}$/u),
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      projectScope: "project:project-1",
      reportingTarget: "project:project-1:supervisor-notebook",
      designatedWriterId: null,
      expiresAt: null,
    });
    expect(
      inspectHarnessProjectMetadata(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH).status,
    ).toBe("missing");
  });

  test("role-bound readers and a successor writer retain one custom notebook identity after release", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-manager-harness-custom-release-"));
    tempDirs.push(projectRoot);
    writeFileSync(
      join(projectRoot, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(projectRoot),
      "utf8",
    );
    const writerOneId = "00000000-0000-4000-8000-000000000506";
    const customClaim = {
      notebookId: "nb_manager-custom-release",
      location: "docs/custom/MANAGER-RELEASE.md",
      designatedWriterId: writerOneId,
      scope: "R1 runtime notebook records",
      expiresAt: "2027-01-01T00:00:00.000Z",
      establishedAt: "2026-09-07T00:00:00.000Z",
    };
    const seeded = writeHarnessProjectMetadata({
      repoRoot: projectRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: { supervisorNotebook: customClaim },
      expectedRevision: null,
      writerId: writerOneId,
    });
    expect(seeded.ok).toBe(true);

    const storage = new AgentStorage(join(projectRoot, "agents"), logger);
    const registries = makeRegistries(projectRoot);
    const resolver = createProjectHarnessBindingService(registries);
    const catalogs = new Map<string, PaseoToolCatalog>();
    const manager = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    manager.setPaseoToolCatalogFactory(
      makeCatalogFactory({
        manager,
        storage,
        registries,
        capture: (catalog, callerAgentId) => {
          if (callerAgentId) catalogs.set(callerAgentId, catalog);
        },
      }),
    );

    const oldReader = await manager.createAgent(
      { provider: "codex", cwd: projectRoot, model: "gpt-5.4" },
      "00000000-0000-4000-8000-000000000507",
      {
        workspaceId: "workspace-1",
        roleId: "supervisor",
        assignment: supervisorReadOnlyAssignment(),
      },
    );
    const writerOne = await manager.createAgent(
      { provider: "codex", cwd: projectRoot, model: "gpt-5.4" },
      writerOneId,
      {
        workspaceId: "workspace-1",
        roleId: "supervisor",
        assignment: supervisorAssignment(),
      },
    );
    const releaseMetadata = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    if (releaseMetadata.status !== "valid") {
      throw new Error("test release metadata must be valid");
    }
    const releaseMessages: unknown[] = [];
    const releaseSession = new ProjectHarnessSession({
      host: { emit: (message) => releaseMessages.push(message) },
      workspaceProvisioning: {
        resolveProjectHarnessTarget: async () => ({
          projectId: "project-1",
          workspaceId: "workspace-1",
          projectRoot,
          workspaceRoot: projectRoot,
          cwd: projectRoot,
        }),
      } as never,
      service: {} as never,
      bindingResolver: resolver,
      agentManager: manager,
      logger,
    });
    await releaseSession.handleNotebookReleaseRequest({
      type: "foundation.projectHarness.notebook.release.request",
      requestId: "manager-release-request",
      projectId: "project-1",
      workspaceId: "workspace-1",
      cwd: projectRoot,
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      designatedWriterId: writerOneId,
      expectedRevision: { status: "regular", ...releaseMetadata.revision },
    });
    expect(releaseMessages[0]).toMatchObject({
      type: "foundation.projectHarness.notebook.release.response",
      payload: {
        requestId: "manager-release-request",
        ok: true,
        result: {
          projectId: "project-1",
          workspaceId: "workspace-1",
          notebookId: customClaim.notebookId,
          location: customClaim.location,
          releasedWriterId: writerOneId,
          nextStep: "fresh_supervisor_role_first",
        },
      },
    });

    await expect(
      resolver.assertCurrent({ binding: writerOne.roleBinding!.harnessBinding! }),
    ).rejects.toThrow(/harness_binding_notebook_revoked/u);

    const oldWriterCatalog = catalogs.get(writerOneId);
    expect(oldWriterCatalog).toBeDefined();
    await expect(
      oldWriterCatalog!.executeTool("append_project_notebook_record", {
        record: { ...validRecord(), recordId: "r2-revoked-writer-record" },
        expectedRevision: null,
      }),
    ).rejects.toThrow(/notebook_grant_revoked/u);

    const freshReader = await manager.createAgent(
      { provider: "codex", cwd: projectRoot, model: "gpt-5.4" },
      "00000000-0000-4000-8000-000000000508",
      {
        workspaceId: "workspace-1",
        roleId: "supervisor",
        assignment: supervisorReadOnlyAssignment(),
      },
    );
    const writerTwo = await manager.createAgent(
      { provider: "codex", cwd: projectRoot, model: "gpt-5.4" },
      "00000000-0000-4000-8000-000000000509",
      {
        workspaceId: "workspace-1",
        roleId: "supervisor",
        assignment: supervisorAssignment(),
      },
    );

    for (const agent of [oldReader, freshReader, writerTwo]) {
      expect(agent.roleBinding?.harnessBinding?.notebook).toMatchObject({
        notebookId: customClaim.notebookId,
        location: customClaim.location,
      });
    }
    expect(oldReader.roleBinding?.harnessBinding?.notebook?.designatedWriterId).toBeNull();
    expect(freshReader.roleBinding?.harnessBinding?.notebook?.designatedWriterId).toBeNull();
    expect(writerTwo.roleBinding?.harnessBinding?.notebook?.designatedWriterId).toBe(
      "00000000-0000-4000-8000-000000000509",
    );

    const successorCatalog = catalogs.get(writerTwo.id);
    expect(successorCatalog).toBeDefined();
    const successorRead = await successorCatalog!.executeTool("read_project_notebook", {});
    expect(successorRead.structuredContent).toMatchObject({
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      status: "missing",
    });
    const successorAppend = await successorCatalog!.executeTool("append_project_notebook_record", {
      record: { ...validRecord(), recordId: "r2-successor-record" },
      expectedRevision: null,
    });
    expect(successorAppend.structuredContent).toMatchObject({
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      recordId: "r2-successor-record",
    });

    const readerCatalog = catalogs.get(oldReader.id);
    expect(readerCatalog).toBeDefined();
    const readerRead = await readerCatalog!.executeTool("read_project_notebook", {});
    expect(readerRead.structuredContent).toMatchObject({
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      designatedWriterId: writerTwo.id,
      status: "valid",
    });
    expect(readerRead.structuredContent).toMatchObject({
      content: expect.stringContaining("r2-successor-record"),
    });
    await expect(
      manager.createAgent(
        { provider: "codex", cwd: projectRoot, model: "gpt-5.4" },
        "00000000-0000-4000-8000-000000000510",
        {
          workspaceId: "workspace-1",
          roleId: "supervisor",
          assignment: supervisorAssignment(),
        },
      ),
    ).rejects.toThrow(/notebook_grant_writer_conflict/u);

    const metadata = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(metadata.status === "valid" ? metadata.metadata : null).toMatchObject({
      supervisorNotebookIdentity: {
        notebookId: customClaim.notebookId,
        location: customClaim.location,
      },
      supervisorNotebook: {
        notebookId: customClaim.notebookId,
        location: customClaim.location,
        designatedWriterId: "00000000-0000-4000-8000-000000000509",
      },
    });

    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
  });

  test("rolls back a prepared writer claim when provider create fails", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-manager-harness-rollback-"));
    tempDirs.push(projectRoot);
    writeFileSync(
      join(projectRoot, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(projectRoot),
      "utf8",
    );
    const storage = new AgentStorage(join(projectRoot, "agents"), logger);
    const registries = makeRegistries(projectRoot);
    const resolver = createProjectHarnessBindingService(registries);
    const manager = new AgentManager({
      clients: { codex: makeClient({ failCreate: true }) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });

    await expect(
      manager.createAgent(
        { provider: "codex", cwd: projectRoot, model: "gpt-5.4" },
        "00000000-0000-4000-8000-000000000502",
        {
          workspaceId: "workspace-1",
          roleId: "supervisor",
          assignment: supervisorAssignment(),
        },
      ),
    ).rejects.toThrow("provider_create_failed");
    const metadata = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(
      metadata.status === "valid" ? metadata.metadata.supervisorNotebook : null,
    ).toBeUndefined();
  });

  test("failed persisted resume preserves the pre-existing writer lease and allows the same agent to retry", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-manager-harness-resume-recovery-"));
    tempDirs.push(projectRoot);
    writeFileSync(
      join(projectRoot, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(projectRoot),
      "utf8",
    );
    const storage = new AgentStorage(join(projectRoot, "agents"), logger);
    const registries = makeRegistries(projectRoot);
    const resolver = createProjectHarnessBindingService(registries);
    const agentId = "00000000-0000-4000-8000-000000000504";
    const initial = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    await initial.createAgent({ provider: "codex", cwd: projectRoot, model: "gpt-5.4" }, agentId, {
      workspaceId: "workspace-1",
      roleId: "supervisor",
      assignment: supervisorAssignment(),
    });
    const stored = await storage.get(agentId);
    if (!stored?.persistence || !stored.launchContract) {
      throw new Error("test setup did not persist the writer lease");
    }
    const metadataPath = join(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH);
    const beforeFailure = readFileSync(metadataPath, "utf8");

    const failedResume = new AgentManager({
      clients: { codex: makeClient({ failResume: true }) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    await expect(
      failedResume.resumeAgentFromPersistence(stored.persistence, { model: "gpt-5.4" }, agentId, {
        workspaceId: "workspace-1",
        launchContract: stored.launchContract,
      }),
    ).rejects.toThrow("provider_resume_failed");
    expect(readFileSync(metadataPath, "utf8")).toBe(beforeFailure);
    expect(
      inspectHarnessProjectMetadata(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH),
    ).toMatchObject({
      status: "valid",
      metadata: { supervisorNotebook: { designatedWriterId: agentId } },
    });

    const retry = new AgentManager({
      clients: { codex: makeClient({}) },
      bundledPolicyPacks: createDefaultSlpBundledPolicyRegistry(),
      registry: storage,
      resolveHarnessBinding: resolver,
      logger,
    });
    const resumed = await retry.resumeAgentFromPersistence(
      stored.persistence,
      { model: "gpt-5.4" },
      agentId,
      { workspaceId: "workspace-1", launchContract: stored.launchContract },
    );
    expect(resumed.roleBinding?.harnessBinding?.notebook?.designatedWriterId).toBe(agentId);
    retry.prepareForShutdown();
    await retry.closeAgent(agentId);
    await retry.flushForShutdown();
    initial.prepareForShutdown();
    await initial.closeAgent(agentId);
    await initial.flushForShutdown();
  });
});
