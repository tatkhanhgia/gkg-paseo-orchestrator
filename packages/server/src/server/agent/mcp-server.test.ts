import {
  createFinishSubscriptions,
  createFinishObservation,
  type FinishSubscriptionStore,
  type FinishSubscriptions,
  type FinishSubscription,
} from "./finish-subscriptions/index.js";
import type { AgentMessageDelivery } from "./agent-messages/index.js";
import { createTestAgentMessages } from "../test-utils/agent-messages.js";
import { parseAgentMessage } from "./agent-messages/index.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createAgentMcpServer as createAgentMcpServerWithDependencies } from "./mcp-server.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { OmpAgentClient } from "./providers/omp/agent.js";
import { FakeOmp } from "./providers/omp/test-utils/fake-omp.js";
import type {
  AgentClient,
  AgentMode,
  AgentPermissionRequest,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
  ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import {
  AgentListItemPayloadSchema,
  AgentPermissionRequestPayloadSchema,
  AgentSnapshotPayloadSchema,
} from "@getpaseo/protocol/messages";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../workspace-registry.js";
import type {
  CreateScheduleInput,
  StoredSchedule,
  UpdateScheduleInput,
} from "@getpaseo/protocol/schedule/types";
import type { ScheduleService } from "../schedule/service.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import {
  createPaseoWorktree as createPaseoWorktreeService,
  type CreatePaseoWorktreeInput,
} from "../paseo-worktree-service.js";
import {
  createPaseoWorktreeWorkflow,
  type CreatePaseoWorktreeWorkflowFn,
} from "../worktree-session.js";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import { WorkspaceAutoName } from "../workspace-auto-name.js";
import { createGitMutationService } from "../session/git-mutation/git-mutation-service.js";
import type { GeneratedWorkspaceName } from "../worktree-branch-name-generator.js";
import type { ForgeService } from "../../services/forge-service.js";
import { areEquivalentPaths } from "../../utils/path.js";
import { createTerminalManager, type TerminalManager } from "../../terminal/terminal-manager.js";
import { createWorkerTerminalManager } from "../../terminal/worker-terminal-manager.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";
import { PASEO_TOOL_NAMES } from "@getpaseo/protocol/paseo-tool-presentation/index";
import { MutableDaemonConfigSchema, type AgentProfile } from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { BrowserToolsBroker, BrowserToolsExecuteInput } from "../browser-tools/broker.js";
import type { BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import { createWorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { materializeAssignmentContract } from "./assignment-contract.js";
import {
  assignmentExternalEffectBoundaryFor,
  type AssignmentEffectClass,
} from "@getpaseo/protocol/assignment-contract";
import { createDefaultSlpBundledPolicyRegistry } from "../policy/bundled/slp.js";
import { attentionQuestionCoalescingKey } from "../policy/bundled/slp/coordination-policy.js";

const REPO_CWD = resolvePath("/tmp/repo");
const TARGET_CWD = resolvePath("/tmp/target");
const BROWSER_WORKSPACE_ID = "wks_browser_tools";
const slpContribution = createDefaultSlpBundledPolicyRegistry().resolveActive("slp").contribution;

interface LooseSafeParseResult {
  success: boolean;
  data: unknown;
  error: {
    issues: Array<{ path: Array<string | number>; message: string; code: string }>;
  };
}

interface LooseInputSchema {
  safeParseAsync(input: unknown): Promise<LooseSafeParseResult>;
}

interface LooseStructuredContent {
  [key: string]: unknown;
}

interface LooseContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface RegisteredMcpTool {
  inputSchema: LooseInputSchema;
  description?: string;
  callback?: (
    input: unknown,
    extra?: unknown,
  ) => Promise<{
    structuredContent: LooseStructuredContent;
    content?: LooseContentBlock[];
  }>;
  handler?: (input: unknown) => Promise<{
    structuredContent: LooseStructuredContent;
    content?: LooseContentBlock[];
  }>;
}

interface RegisteredMcpToolWithHandler extends RegisteredMcpTool {
  handler: (input: unknown) => Promise<{
    structuredContent: LooseStructuredContent;
    content?: LooseContentBlock[];
  }>;
}

const subscriptionServices: FinishSubscriptions[] = [];
afterEach(async () => {
  for (const service of subscriptionServices.splice(0)) await service.close();
});
const serverSubscriptionRecords = new WeakMap<object, Map<string, FinishSubscription>>();
const serverSubscriptions = new WeakMap<object, FinishSubscriptions>();
const serverDeliveries = new WeakMap<object, AgentMessageDelivery>();
const toolDeliveries = new WeakMap<object, AgentMessageDelivery>();

function lookupTool(
  server: Awaited<ReturnType<typeof createAgentMcpServer>>,
  name: string,
): RegisteredMcpTool | undefined {
  const tools: Record<string, RegisteredMcpTool> = Reflect.get(server, "_registeredTools");
  return tools[name];
}

function registeredTool(
  server: Awaited<ReturnType<typeof createAgentMcpServer>>,
  name: string,
): RegisteredMcpToolWithHandler {
  const tool = lookupTool(server, name);
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const handler = tool.handler ?? tool.callback;
  if (!handler) {
    throw new Error(`MCP tool has no callable handler: ${name}`);
  }
  const registered = { ...tool, handler };
  const delivery = serverDeliveries.get(server);
  if (delivery) toolDeliveries.set(registered, delivery);
  return registered;
}

async function invokeToolWithParsedInput(
  tool: RegisteredMcpToolWithHandler,
  input: Record<string, unknown>,
) {
  const parsed = await tool.inputSchema.safeParseAsync(input);
  expect(parsed.success).toBe(true);
  const response = await tool.handler(parsed.data);
  if (response.structuredContent.deliveryStatus === "queued") {
    await toolDeliveries
      .get(tool)!
      .waitForDispatch(input.agentId as string, new AbortController().signal);
  }
  return response;
}

function agentsOf(response: {
  structuredContent: LooseStructuredContent;
}): Array<Record<string, unknown>> {
  return z.array(z.record(z.string(), z.unknown())).parse(response.structuredContent.agents);
}

function expectSingleTextContent(response: { content?: LooseContentBlock[] }): string {
  const content = response.content ?? [];
  expect(content).toHaveLength(1);
  const block = content[0];
  expect(block?.type).toBe("text");
  return z.string().min(1).parse(block?.text);
}

async function waitForWorkspaceTitle(
  workspaceRecords: Map<string, PersistedWorkspaceRecord>,
  workspaceId: string,
  title: string,
): Promise<void> {
  await vi.waitFor(() => expect(workspaceRecords.get(workspaceId)?.title).toBe(title), {
    timeout: 5_000,
  });
}

async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function removeAgentStateDir(
  agentManager: AgentManager,
  storage: AgentStorage,
  path: string,
): Promise<void> {
  await agentManager.flush();
  await storage.flush();
  await removeTempDir(path);
}

type AgentManagerSpies = ReturnType<typeof buildAgentManagerSpies>;
type AgentStorageSpies = ReturnType<typeof buildAgentStorageSpies>;

interface TestDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  spies: {
    agentManager: AgentManagerSpies;
    agentStorage: AgentStorageSpies;
  };
}

function expectAgentMessageStreamed(
  streamAgent: { mock: { calls: unknown[][] } },
  input: { targetId: string; senderId: string; text: string },
): void {
  const call = streamAgent.mock.calls.find(([agentId]) => agentId === input.targetId);
  const message = typeof call?.[1] === "string" ? parseAgentMessage(call[1]) : null;
  expect(message).toMatchObject({
    source: { kind: "agent-message", agentId: input.senderId },
    text: input.text,
  });
  expect(call?.[2]).toEqual({ clientMessageId: message?.id });
}

function buildAgentManagerSpies() {
  const tryRunOutOfBand = vi.fn().mockReturnValue(false);
  const streamAgent = vi.fn(() => (async function* noop() {})());
  return {
    createAgent: vi.fn(),
    waitForAgentEvent: vi.fn().mockResolvedValue({
      status: "idle",
      permission: null,
      lastMessage: null,
    }),
    setAgentMode: vi.fn().mockResolvedValue(undefined),
    setAgentModel: vi.fn().mockResolvedValue(undefined),
    setAgentThinkingOption: vi.fn().mockResolvedValue(undefined),
    setAgentFeature: vi.fn().mockResolvedValue(undefined),
    setLabels: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    updateAgentMetadata: vi.fn().mockResolvedValue(undefined),
    archiveAgent: vi.fn().mockResolvedValue({ archivedAt: new Date().toISOString() }),
    unarchiveSnapshot: vi.fn().mockResolvedValue(false),
    notifyAgentState: vi.fn(),
    getAgent: vi.fn(),
    getProviderRoleBindingSupport: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    getTimeline: vi.fn().mockReturnValue([]),
    resumeAgentFromPersistence: vi.fn(),
    hydrateTimelineFromProvider: vi.fn().mockResolvedValue(undefined),
    appendTimelineItem: vi.fn().mockResolvedValue(undefined),
    emitLiveTimelineItem: vi.fn().mockResolvedValue(undefined),
    hasInFlightRun: vi.fn().mockReturnValue(false),
    steerOrReplaceActiveTurn: async () => ({ status: "inactive" as const }),
    // Like AgentManager: the authorized entry point checks the write lease, then delegates.
    steerOrReplaceActiveTurnAuthorized(
      this: { steerOrReplaceActiveTurn: (...args: unknown[]) => unknown },
      ...args: unknown[]
    ) {
      return this.steerOrReplaceActiveTurn(...args);
    },
    tryRunOutOfBand,
    tryRunOutOfBandAuthorized: tryRunOutOfBand,
    subscribe: vi.fn().mockReturnValue(() => {}),
    streamAgent,
    startAuthorizedAgentStream: streamAgent,
    replaceAgentRun: vi.fn(() => (async function* noop() {})()),
    waitForAgentRunStart: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn(),
    cancelAgentRun: vi.fn(),
    getPendingPermissions: vi.fn(),
    getRegisteredProviderIds: vi.fn().mockReturnValue(["claude"]),
    listDraftFeatures: vi.fn(),
    preflightRoleCreate: vi.fn(),
    resolveSlpPolicyForRoleBinding: vi.fn(() => slpContribution),
    resolveActiveSlpPolicy: vi.fn(() => slpContribution),
    assertAttentionQuestionTargetSupport: vi.fn(),
  };
}

function buildAgentStorageSpies() {
  return {
    get: vi.fn().mockResolvedValue(null),
    setTitle: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    applySnapshot: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
  };
}

function createTestDeps(): TestDeps {
  const agentManagerSpies = buildAgentManagerSpies();
  const agentStorageSpies = buildAgentStorageSpies();

  return {
    agentManager: agentManagerSpies as unknown as AgentManager,
    agentStorage: agentStorageSpies as unknown as AgentStorage,
    spies: {
      agentManager: agentManagerSpies,
      agentStorage: agentStorageSpies,
    },
  };
}

function createTerminalManagerStub(overrides: Partial<TerminalManager> = {}): TerminalManager {
  return {
    getTerminals: vi.fn().mockResolvedValue([]),
    createTerminal: vi.fn(),
    registerCwdEnv: vi.fn(),
    getTerminal: vi.fn(),
    getTerminalState: vi.fn().mockResolvedValue(null),
    killTerminal: vi.fn(),
    killTerminalAndWait: vi.fn().mockResolvedValue(undefined),
    captureTerminal: vi.fn().mockResolvedValue({ lines: [], totalLines: 0 }),
    listDirectories: vi.fn().mockReturnValue([]),
    killAll: vi.fn(),
    subscribeTerminalsChanged: vi.fn().mockReturnValue(() => {}),
    subscribeTerminalWorkspaceContributionChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as TerminalManager;
}

type ProviderSnapshotManagerStub = ReturnType<typeof createProviderSnapshotManagerStub>;

interface ConfigureProviderEntry {
  provider: AgentProvider;
  label?: string;
  description?: string;
  enabled?: boolean;
  defaultModeId?: string;
  modes?: AgentMode[];
}

// Builds a ProviderSnapshotEntry for tests that need to configure listProviders /
// getProvider directly. Mirrors the shape MCP server reads from the manager:
// status: "ready" for enabled+available, "unavailable" for disabled.
function buildSnapshotEntry(entry: ConfigureProviderEntry): ProviderSnapshotEntry {
  const enabled = entry.enabled ?? true;
  if (!enabled) {
    return {
      provider: entry.provider,
      status: "unavailable",
      enabled: false,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.defaultModeId !== undefined ? { defaultModeId: entry.defaultModeId } : {}),
      modes: [],
    };
  }
  return {
    provider: entry.provider,
    status: "ready",
    enabled: true,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.defaultModeId !== undefined ? { defaultModeId: entry.defaultModeId } : {}),
    modes: entry.modes ?? [],
  };
}

// Shared helper used by ~60 create_agent / update_agent / list_agents tests that
// only need a "normal" provider catalog (claude, codex, opencode). OpenCode
// create-config behavior delegates to the production provider client.
//
// NOTE: This is NOT a registry. It directly configures the public stub surface.
// Per-test customization is done by overriding individual stub methods after
// calling this helper.
interface ConfigureOpenCodeProviderStubOptions {
  customOpenCodeProvider?: AgentProvider;
}

function configureOpenCodeProviderStub(
  stub: ProviderSnapshotManagerStub,
  options: ConfigureOpenCodeProviderStubOptions = {},
): void {
  const claudeModes: AgentMode[] = [
    { id: "default", label: "Default", description: "Ask first" },
    { id: "plan", label: "Plan", description: "Read only" },
    { id: "bypassPermissions", label: "Bypass", description: "No prompts", isUnattended: true },
  ];
  const codexModes: AgentMode[] = [
    { id: "default", label: "Default", description: "Default" },
    { id: "read-only", label: "Read only", description: "No writes" },
    { id: "auto", label: "Auto", description: "Auto" },
    { id: "full-access", label: "Full Access", description: "No prompts", isUnattended: true },
  ];
  const opencodeModes: AgentMode[] = [
    { id: "build", label: "Build", description: "Can edit" },
    { id: "plan", label: "Plan", description: "Read-only" },
    { id: "paseo-custom", label: "Paseo Custom", description: "Custom OpenCode agent" },
  ];
  const entries: ProviderSnapshotEntry[] = [
    buildSnapshotEntry({
      provider: "claude",
      label: "Claude",
      description: "Anthropic Claude",
      defaultModeId: "default",
      modes: claudeModes,
    }),
    buildSnapshotEntry({
      provider: "codex",
      label: "Codex",
      description: "OpenAI Codex",
      defaultModeId: "default",
      modes: codexModes,
    }),
    buildSnapshotEntry({
      provider: "opencode",
      label: "OpenCode",
      description: "OpenCode agent",
      defaultModeId: "build",
      modes: opencodeModes,
    }),
  ];
  const customOpenCodeModes: AgentMode[] = [
    ...opencodeModes,
    { id: "paseo-custom", label: "Paseo Custom" },
  ];
  if (options.customOpenCodeProvider) {
    entries.push(
      buildSnapshotEntry({
        provider: options.customOpenCodeProvider,
        label: "OpenCode Custom",
        description: "Custom OpenCode agent",
        defaultModeId: "build",
        modes: customOpenCodeModes,
      }),
    );
  }
  const modesByProvider: Record<string, AgentMode[]> = {
    claude: claudeModes,
    codex: codexModes,
    opencode: opencodeModes,
  };
  if (options.customOpenCodeProvider) {
    modesByProvider[options.customOpenCodeProvider] = customOpenCodeModes;
  }

  stub.listRegisteredProviderIds.mockReturnValue(entries.map((entry) => entry.provider));
  stub.hasProvider.mockImplementation((provider) =>
    Object.prototype.hasOwnProperty.call(modesByProvider, provider),
  );
  stub.getProviderLabel.mockImplementation((provider) => {
    const entry = entries.find((e) => e.provider === provider);
    return entry?.label ?? provider;
  });
  stub.listProviders.mockImplementation(async (input) => {
    const opts = (input ?? {}) as { providers?: AgentProvider[] };
    if (!opts.providers) return entries;
    const filter = new Set(opts.providers);
    return entries.filter((e) => filter.has(e.provider));
  });
  stub.getProvider.mockImplementation(async (input) => {
    const opts = input as { provider: AgentProvider };
    const entry = entries.find((e) => e.provider === opts.provider);
    if (!entry) throw new Error(`Provider ${opts.provider} is not configured`);
    return entry;
  });
  stub.listModels.mockResolvedValue([]);
  stub.listModes.mockImplementation(async (input) => {
    const opts = input as { provider: AgentProvider };
    return modesByProvider[opts.provider] ?? [];
  });
  stub.resolveCreateConfig.mockImplementation(async (input) => {
    const opts = input as {
      provider: AgentProvider;
      requestedMode: string | undefined;
      featureValues: Record<string, unknown> | undefined;
    };
    return { modeId: opts.requestedMode, featureValues: opts.featureValues };
  });
}

// Quick helper: returns a manager configured with the standard OpenCode catalog.
function createOpenCodeManager(options?: ConfigureOpenCodeProviderStubOptions): {
  manager: ProviderSnapshotManagerStub["manager"];
  stub: ProviderSnapshotManagerStub;
} {
  const stub = createProviderSnapshotManagerStub();
  configureOpenCodeProviderStub(stub, options);
  return { manager: stub.manager, stub };
}

// Quick helper: returns a bare stub manager seam. Use when the test does not
// care about provider behavior at all (terminal tests, schema-only tests,
// stored-agent listing tests where the stored agent's provider just needs to
// be in listRegisteredProviderIds).
function createClaudeOnlyManager(): ProviderSnapshotManagerStub["manager"] {
  const stub = createProviderSnapshotManagerStub();
  stub.listRegisteredProviderIds.mockReturnValue(["claude"]);
  stub.hasProvider.mockImplementation((provider) => provider === "claude");
  return stub.manager;
}

function createStoredRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = "2026-04-11T00:00:00.000Z";
  return {
    id: "stored-agent",
    provider: "claude",
    cwd: "/tmp/stored-project",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastUserMessageAt: null,
    title: "Stored agent",
    labels: {},
    lastStatus: "closed",
    lastModeId: "default",
    config: {
      modeId: "default",
      model: "claude-sonnet-4-20250514",
    },
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-123",
      model: "claude-sonnet-4-20250514",
    },
    features: [],
    persistence: {
      provider: "claude",
      sessionId: "session-123",
    },
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

function createActiveStoredRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return createStoredRecord({ archivedAt: null, ...overrides });
}

function createTestRoleBinding(
  roleId: PaseoRoleId,
  requestedEffectClass?: AssignmentEffectClass,
): NonNullable<StoredAgentRecord["roleBinding"]> {
  let readership: "full" | "assignment-only" | "governance-only";
  if (roleId === "lead") {
    readership = "full";
  } else if (roleId === "peer") {
    readership = "assignment-only";
  } else {
    readership = "governance-only";
  }
  let disposition: "lead-direct" | "peer-execution" | "supervision" = "lead-direct";
  if (roleId === "peer") disposition = "peer-execution";
  if (roleId === "supervisor") disposition = "supervision";
  const effectClass = requestedEffectClass ?? (roleId === "lead" ? "mutating" : undefined);
  const assignmentContract = effectClass
    ? materializeAssignmentContract({
        roleId,
        assigner: { kind: "human-session" },
        workspaceId: "wks_bound",
        cwd: "/tmp/test",
        envelope: {
          version: 1,
          disposition,
          objective: "Coordinate the exact Human-authorized child topology",
          effectClass,
          mutationBoundary:
            effectClass === "mutating"
              ? { mode: "bounded-write", scope: "/tmp/test" }
              : { mode: "no-write" },
          externalEffectBoundary: assignmentExternalEffectBoundaryFor(roleId, effectClass),
          evidence: "Return exact child launch receipts.",
          handbackAndStop: "Stop when the bounded topology is established.",
        },
        createdAt: new Date("2026-08-09T00:00:00.000Z"),
      })
    : undefined;
  return {
    roleId,
    definitionVersion: "test-role-contract",
    definitionDigest: "a".repeat(64),
    bindingDigest: "b".repeat(64),
    provider: "codex",
    injectionMethod: "codex-developer-instructions",
    qualification: "implementation-supported",
    workspaceProtocol: {
      status: "missing",
      readership,
      path: "/tmp/test/WORKSPACE_PROTOCOL.md",
    },
    createdAt: "2026-08-09T00:00:00.000Z",
    instructions: `Test ${roleId} instructions`,
    ...(assignmentContract ? { assignmentContract } : {}),
  };
}

function mockStoredAgentRecords(get: AgentStorageSpies["get"], records: StoredAgentRecord[]): void {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  get.mockImplementation(async (agentId: string) => recordsById.get(agentId) ?? null);
}

// The real AgentManager persists a record for every agent it creates, and create_agent
// registers a durable finish-notification watch on that record. The createAgent spy does
// not persist, so resolve the agents it returned as stored records too.
function mockStoredAgentRecordsWithCreatedChildren(
  spies: TestDeps["spies"],
  records: StoredAgentRecord[],
): void {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  spies.agentStorage.get.mockImplementation(async (agentId: string) => {
    const stored = recordsById.get(agentId);
    if (stored) return stored;
    for (const result of spies.agentManager.createAgent.mock.results) {
      if (result.type !== "return") continue;
      const created = (await result.value) as ManagedAgent | undefined;
      if (created?.id === agentId) {
        return createActiveStoredRecord({ id: created.id, cwd: created.cwd });
      }
    }
    return null;
  });
}

function expectedCreateTopologyError(roleId: PaseoRoleId): string {
  if (roleId === "lead") return "A role-bound Lead may create only a role-bound Peer";
  if (roleId === "supervisor") {
    return "A role-bound Supervisor may create only a role-bound Lead under a Human-issued delegation assignment";
  }
  return `Role-bound ${roleId} agents cannot use create_agent`;
}

function expectedPromptTopologyError(roleId: PaseoRoleId): string {
  if (roleId === "lead") return "A role-bound Lead may prompt only its own direct Peer child";
  if (roleId === "supervisor") {
    return "A role-bound Supervisor may prompt only its own direct Lead child under a Human-issued delegation assignment";
  }
  return `Role-bound ${roleId} agents cannot use send_agent_prompt`;
}

function createManagedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  const now = new Date();
  return {
    id: "live-agent",
    provider: "claude",
    cwd: "/tmp/live-project",
    config: {},
    runtimeInfo: undefined,
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
    lifecycle: "idle",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    features: [],
    pendingPermissions: new Map(),
    persistence: null,
    labels: {},
    attention: { requiresAttention: false },
    ...overrides,
  } as ManagedAgent;
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    }),
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

class FakeBrowserToolsBroker {
  public readonly calls: BrowserToolsExecuteInput[] = [];

  public constructor(private readonly response: BrowserToolsResponsePayload) {}

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    this.calls.push(input);
    return this.response;
  }
}

class BoundaryAgentManagerFake {
  private readonly agent = createManagedAgent({
    id: "agent-1",
    cwd: REPO_CWD,
    workspaceId: BROWSER_WORKSPACE_ID,
  });

  public getAgent(agentId: string): ManagedAgent | null {
    return agentId === this.agent.id ? this.agent : null;
  }

  public listAgents(): ManagedAgent[] {
    return [];
  }
}

class BoundaryAgentStorageFake {
  public async list(): Promise<StoredAgentRecord[]> {
    return [];
  }
}

class BoundaryProviderSnapshotManagerFake {
  public listRegisteredProviderIds(): AgentProvider[] {
    return [];
  }

  public hasProvider(): boolean {
    return false;
  }

  public getProviderLabel(provider: AgentProvider): string {
    return provider;
  }

  public async listProviders(): Promise<ProviderSnapshotEntry[]> {
    return [];
  }

  public async getProvider(): Promise<ProviderSnapshotEntry> {
    throw new Error("Provider catalog is not used by this boundary test");
  }

  public async listModels(): Promise<[]> {
    return [];
  }

  public async listModes(): Promise<[]> {
    return [];
  }
}

async function connectInMemoryMcpClient(server: Awaited<ReturnType<typeof createAgentMcpServer>>) {
  const client = new Client({ name: "paseo-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function createStoredSchedule(input: CreateScheduleInput): StoredSchedule {
  const now = "2026-04-11T00:00:00.000Z";
  return {
    id: "schedule-1",
    name: input.name ?? null,
    prompt: input.prompt,
    cadence: input.cadence,
    target: input.target,
    status: "active",
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: input.expiresAt ?? null,
    maxRuns: input.maxRuns ?? null,
    runs: [],
  };
}

function createArchiveWorkspaceRecordMutator(
  activeWorkspaces: Array<{
    workspaceId: string;
    cwd: string;
    kind: "worktree" | "local_checkout" | "directory";
  }>,
  archivedWorkspaceIds: string[],
) {
  return async (workspaceId: string) => {
    archivedWorkspaceIds.push(workspaceId);
    const index = activeWorkspaces.findIndex((workspace) => workspace.workspaceId === workspaceId);
    if (index !== -1) {
      activeWorkspaces.splice(index, 1);
    }
  };
}

function createPaseoWorktreeForMcpTest(options: {
  paseoHome: string;
  broadcasts: string[];
  createdWorkspaceIds?: string[];
  workspaceRecords?: Map<string, PersistedWorkspaceRecord>;
  generateWorkspaceName?: () => Promise<GeneratedWorkspaceName | null>;
  startedAgentSetupIds?: string[];
}): CreatePaseoWorktreeWorkflowFn {
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = options.workspaceRecords ?? new Map<string, PersistedWorkspaceRecord>();
  const github = createGitHubServiceStub();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger: createTestLogger(),
    paseoHome: options.paseoHome,
    deps: { forgeOverrides: { github } },
  });
  const projectRegistry: ProjectRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(projects.values()),
    get: async (projectId) => projects.get(projectId) ?? null,
    getOrCreateActiveByRoot: async (allocation) => {
      const existing = Array.from(projects.values()).find(
        (project) =>
          areEquivalentPaths(project.rootPath, allocation.rootPath) && !project.archivedAt,
      );
      if (existing) return existing;
      const project = createPersistedProjectRecord({
        projectId: `prj_test_${projects.size + 1}`,
        rootPath: allocation.rootPath,
        kind: allocation.kind,
        displayName: allocation.displayName,
        createdAt: allocation.timestamp,
        updatedAt: allocation.timestamp,
      });
      projects.set(project.projectId, project);
      return project;
    },
    upsert: async (record) => {
      projects.set(record.projectId, record);
    },
    archive: async (projectId, archivedAt) => {
      const project = projects.get(projectId);
      if (project) projects.set(projectId, { ...project, archivedAt });
    },
    remove: async (projectId) => {
      projects.delete(projectId);
    },
  };
  const workspaceRegistry: WorkspaceRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    get: async (workspaceId: string) => workspaces.get(workspaceId) ?? null,
    list: async () => Array.from(workspaces.values()),
    update: async (workspaceId, updater) => {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) return null;
      const updated = updater(workspace);
      workspaces.set(workspaceId, updated);
      return updated;
    },
    upsert: async (record: PersistedWorkspaceRecord) => {
      workspaces.set(record.workspaceId, record);
    },
    archive: async (workspaceId, archivedAt) => {
      const workspace = workspaces.get(workspaceId);
      if (workspace) workspaces.set(workspaceId, { ...workspace, archivedAt });
    },
    remove: async (workspaceId) => {
      workspaces.delete(workspaceId);
    },
  };
  const workspaceProvisioning = createWorkspaceProvisioningService({
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    isDirectory: async () => true,
    logger: createTestLogger(),
  });
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager: buildAgentManagerSpies() as unknown as AgentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager: createOpenCodeManager().manager,
    readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
    gitMutation: createGitMutationService({
      workspaceGitService,
      github,
      logger: createTestLogger(),
    }),
    emitWorkspaceUpdateForCwd: async (cwd) => {
      const workspace = Array.from(workspaces.values()).find((record) => record.cwd === cwd);
      options.broadcasts.push(z.string().parse(workspace?.workspaceId));
    },
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      options.broadcasts.push(workspaceId);
    },
    logger: createTestLogger(),
    generateWorkspaceName: options.generateWorkspaceName ?? (async () => null),
  });

  return async (input, serviceOptions) => {
    const result = await createPaseoWorktreeWorkflow(
      {
        paseoHome: options.paseoHome,
        createPaseoWorktree: (workflowInput, workflowOptions) =>
          createPaseoWorktreeService(workflowInput, {
            github,
            ...(workflowOptions?.resolveDefaultBranch
              ? { resolveDefaultBranch: workflowOptions.resolveDefaultBranch }
              : {}),
            workspaceGitService,
            workspaceProvisioning,
          }),
        warmWorkspaceGitData: async () => {},
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          workspaceAutoName.scheduleForWorktree(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          options.broadcasts.push(workspaceId);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        emit: () => {},
        sessionLogger: createTestLogger(),
        terminalManager: null,
        serviceProxy: null,
        scriptRuntimeStore: null,
        getDaemonTcpPort: null,
        getDaemonTcpHost: null,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
    options.broadcasts.push(result.workspace.workspaceId);
    options.createdWorkspaceIds?.push(result.workspace.workspaceId);
    return result;
  };
}

// Typed in-memory workspace port for catalogue tests without workspace setup.
async function createAgentMcpServer(
  options: Parameters<typeof createAgentMcpServerWithDependencies>[0],
  subscriptionStore?: FinishSubscriptionStore,
) {
  const messages = createTestAgentMessages(options);
  const records = new Map<string, FinishSubscription>();
  const subscriptions = createFinishSubscriptions({
    store: subscriptionStore ?? {
      list: async () => [...records.values()],
      put: async (record) => {
        records.set(record.id, record);
      },
      remove: async (id) => {
        records.delete(id);
      },
    },
    messages: () => messages,
    callerIsActive: async (id) => !(await options.agentStorage.get(id))?.archivedAt,
    serverId: options.serverId ?? "self",
    logger: options.logger,
    ...createFinishObservation({
      ...options,
      messages: () => messages,
      serverId: options.serverId ?? "self",
      hosts: () => {
        if (!options.hosts) throw new Error("No hosts");
        return options.hosts();
      },
    }),
  });
  subscriptionServices.push(subscriptions);
  const server = await createAgentMcpServerWithDependencies({
    agentMessages: () => messages,
    finishSubscriptions: () => subscriptions,
    workspaceRegistry: { get: async () => null, list: async () => [], upsert: async () => {} },
    ...options,
  });
  serverSubscriptionRecords.set(server, records);
  serverSubscriptions.set(server, subscriptions);
  serverDeliveries.set(server, messages);
  return server;
}

describe("bundled Paseo skill", () => {
  it("documents only advertised create_workspace input names", async () => {
    const server = await createAgentMcpServer({
      agentManager: new BoundaryAgentManagerFake() as AgentManager,
      agentStorage: new BoundaryAgentStorageFake() as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      logger: createTestLogger(),
    });
    const client = await connectInMemoryMcpClient(server);

    try {
      const skill = await readFile(
        new URL("../../../../../skills/paseo/SKILL.md", import.meta.url),
        "utf8",
      );
      const paragraph = skill.split("\n").find((line) => line.startsWith("**`create_workspace`**"));
      expect(paragraph).toBeTypeOf("string");
      // The final sentence describes output, rather than tool inputs.
      const inputGuidance = paragraph!.split("Returns ")[0]!;
      const documentedInputs = [...inputGuidance.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/g)].map(
        (match) => match[1]!,
      );
      expect(documentedInputs.length).toBeGreaterThan(0);
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "create_workspace")!;
      const properties = tool.inputSchema.properties!;
      const advertisedNamesAndValues = new Set([
        ...Object.keys(properties),
        ...Object.values(properties).flatMap((property) =>
          typeof property === "object" && property !== null && Array.isArray(property.enum)
            ? property.enum
            : [],
        ),
      ]);
      expect(documentedInputs.filter((name) => !advertisedNamesAndValues.has(name))).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("Paseo tool timeline presentation", () => {
  it("catalogs a timeline label for every advertised tool", async () => {
    const server = await createAgentMcpServer({
      agentManager: new BoundaryAgentManagerFake() as AgentManager,
      agentStorage: new BoundaryAgentStorageFake() as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      browserToolsEnabled: true,
      browserToolsBroker: new FakeBrowserToolsBroker({
        requestId: "req-catalog",
        ok: true,
        result: { command: "list_tabs", tabs: [] },
      }) as BrowserToolsBroker,
      callerAgentId: "agent-1",
      logger: createTestLogger(),
    });
    const client = await connectInMemoryMcpClient(server);

    try {
      const { tools } = await client.listTools();
      const cataloged = new Set<string>(PASEO_TOOL_NAMES);
      // speak renders as a voice message, not a tool call row.
      const uncataloged = tools
        .map((tool) => tool.name)
        .filter((name) => name !== "speak" && !cataloged.has(name));
      expect(tools.length).toBeGreaterThan(40);
      expect(uncataloged).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("browser MCP tools", () => {
  const logger = createTestLogger();

  it("omits output schemas from tools/list and keeps tool call content model-visible", async () => {
    const agentManager = new BoundaryAgentManagerFake();
    const agentStorage = new BoundaryAgentStorageFake();
    const broker = new FakeBrowserToolsBroker({
      requestId: "req-browser-tabs",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    const serverOptions = {
      agentManager: agentManager as AgentManager,
      agentStorage: agentStorage as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      browserToolsEnabled: true,
      browserToolsBroker: broker as BrowserToolsBroker,
      callerAgentId: "agent-1",
      logger,
    };
    const server = await createAgentMcpServer(serverOptions);
    const client = await connectInMemoryMcpClient(server);

    try {
      const browserResult = await client.callTool({
        name: "browser_list_tabs",
        arguments: {},
      });
      const listAgentsResult = await client.callTool({
        name: "list_agents",
        arguments: {},
      });

      expect(broker.calls).toEqual([
        {
          agentId: "agent-1",
          cwd: REPO_CWD,
          workspaceId: BROWSER_WORKSPACE_ID,
          command: { command: "list_tabs", args: {} },
        },
      ]);
      expect(browserResult.isError).not.toBe(true);
      expect(browserResult.structuredContent).toEqual({
        ok: true,
        result: { command: "list_tabs", tabs: [] },
        context: { agentId: "agent-1", cwd: REPO_CWD, workspaceId: BROWSER_WORKSPACE_ID },
      });
      expect(listAgentsResult.isError).not.toBe(true);
      expect(listAgentsResult.structuredContent).toEqual({
        agents: [],
      });
      expectSingleTextContent(browserResult);
      expect(expectSingleTextContent(listAgentsResult)).toContain('"agents": []');

      const listedTools = await client.listTools();
      expect(listedTools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["browser_list_tabs", "list_agents"]),
      );
      for (const tool of listedTools.tools) {
        expect(tool, `${tool.name} outputSchema`).not.toHaveProperty("outputSchema");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns screenshot pixels as image content and keeps structured content metadata-only", async () => {
    const agentManager = new BoundaryAgentManagerFake();
    const agentStorage = new BoundaryAgentStorageFake();
    const broker = new FakeBrowserToolsBroker({
      requestId: "req-browser-screenshot",
      ok: true,
      result: {
        command: "screenshot",
        browserId: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgo=",
        width: 800,
        height: 600,
      },
    });
    const server = await createAgentMcpServer({
      agentManager: agentManager as AgentManager,
      agentStorage: agentStorage as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      browserToolsEnabled: true,
      browserToolsBroker: broker as BrowserToolsBroker,
      callerAgentId: "agent-1",
      logger,
    });
    const client = await connectInMemoryMcpClient(server);

    try {
      const response = await client.callTool({
        name: "browser_screenshot",
        arguments: { browserId: "11111111-1111-4111-8111-111111111111" },
      });

      expect(broker.calls).toEqual([
        {
          agentId: "agent-1",
          cwd: REPO_CWD,
          workspaceId: BROWSER_WORKSPACE_ID,
          command: {
            command: "screenshot",
            args: {
              browserId: "11111111-1111-4111-8111-111111111111",
              fullPage: false,
            },
          },
        },
      ]);
      expect(response.content).toEqual([
        { type: "text", text: "Captured browser screenshot (800x600)." },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ]);
      expect(response.structuredContent).toEqual({
        ok: true,
        result: {
          command: "screenshot",
          browserId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/png",
          width: 800,
          height: 600,
        },
        context: {
          agentId: "agent-1",
          cwd: REPO_CWD,
          workspaceId: BROWSER_WORKSPACE_ID,
          browserId: "11111111-1111-4111-8111-111111111111",
        },
      });
      expect(JSON.stringify(response.structuredContent)).not.toContain("iVBORw0KGgo=");
      expect(JSON.stringify(response.structuredContent)).not.toContain("dataBase64");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not register browser tools when browser tools are disabled", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "agent-1",
      cwd: REPO_CWD,
      workspaceId: BROWSER_WORKSPACE_ID,
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      browserToolsEnabled: false,
      callerAgentId: "agent-1",
      logger,
    });

    const client = await connectInMemoryMcpClient(server);
    try {
      const listedTools = await client.listTools();
      const toolNames = listedTools.tools.map((tool) => tool.name);

      expect(toolNames).not.toContain("browser_list_tabs");
      expect(toolNames).not.toContain("browser_snapshot");
      expect(toolNames).toEqual(expect.arrayContaining(["create_agent", "list_agents"]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("applies provider policy after the browser-tools host gate", async () => {
    const agentManager = new BoundaryAgentManagerFake();
    const agentStorage = new BoundaryAgentStorageFake();
    const broker = new FakeBrowserToolsBroker({
      requestId: "req-browser-policy",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    const server = await createAgentMcpServer({
      agentManager: agentManager as AgentManager,
      agentStorage: agentStorage as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      browserToolsEnabled: true,
      browserToolsBroker: broker as BrowserToolsBroker,
      callerAgentId: "agent-1",
      paseoToolPolicy: { disabledTools: ["browser_list_tabs"] },
      logger,
    });

    expect(lookupTool(server, "browser_list_tabs")).toBeUndefined();
    expect(lookupTool(server, "browser_snapshot")).toBeDefined();
  });

  it("filters policy-disabled tools from MCP listing and calls", async () => {
    const agentManager = new BoundaryAgentManagerFake();
    const agentStorage = new BoundaryAgentStorageFake();
    const broker = new FakeBrowserToolsBroker({
      requestId: "req-browser-policy-call",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    const server = await createAgentMcpServer({
      agentManager: agentManager as AgentManager,
      agentStorage: agentStorage as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      browserToolsEnabled: true,
      browserToolsBroker: broker as BrowserToolsBroker,
      callerAgentId: "agent-1",
      paseoToolPolicy: { disabledTools: ["list_agents", "browser_list_tabs"] },
      logger,
    });
    const client = await connectInMemoryMcpClient(server);

    try {
      const listedTools = await client.listTools();
      const toolNames = listedTools.tools.map((tool) => tool.name);

      expect(toolNames).not.toContain("list_agents");
      expect(toolNames).not.toContain("browser_list_tabs");
      expect(toolNames).toEqual(expect.arrayContaining(["create_agent", "browser_snapshot"]));
      await expect(client.callTool({ name: "list_agents", arguments: {} })).rejects.toThrow(
        "Tool list_agents not found",
      );
      await expect(client.callTool({ name: "browser_list_tabs", arguments: {} })).rejects.toThrow(
        "Tool browser_list_tabs not found",
      );
      expect(broker.calls).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("registers only explicitly allowed MCP tools", async () => {
    const agentManager = new BoundaryAgentManagerFake();
    const agentStorage = new BoundaryAgentStorageFake();
    const server = await createAgentMcpServer({
      agentManager: agentManager as AgentManager,
      agentStorage: agentStorage as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      browserToolsEnabled: true,
      browserToolsBroker: new FakeBrowserToolsBroker({
        requestId: "req-browser-allowlist",
        ok: true,
        result: { command: "list_tabs", tabs: [] },
      }) as BrowserToolsBroker,
      callerAgentId: "agent-1",
      paseoToolPolicy: { allowedTools: ["list_agents"] },
      logger,
    });
    const client = await connectInMemoryMcpClient(server);

    try {
      const listedTools = await client.listTools();
      const toolNames = listedTools.tools.map((tool) => tool.name);

      expect(toolNames).toContain("list_agents");
      expect(toolNames).not.toContain("create_agent");
      expect(toolNames).not.toContain("browser_snapshot");
      await expect(client.callTool({ name: "create_agent", arguments: {} })).rejects.toThrow(
        "Tool create_agent not found",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("wires browser tools through the browser tools broker", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "agent-1",
      cwd: REPO_CWD,
      workspaceId: BROWSER_WORKSPACE_ID,
    });
    const execute = vi.fn().mockResolvedValue({
      requestId: "req-browser-tabs",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      browserToolsEnabled: true,
      browserToolsBroker: { execute } as never,
      callerAgentId: "agent-1",
      logger,
    });
    const tool = registeredTool(server, "browser_list_tabs");

    const response = await tool.handler({});

    expect(execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: REPO_CWD,
      workspaceId: BROWSER_WORKSPACE_ID,
      command: { command: "list_tabs", args: {} },
    });
    expect(response.content).toEqual([
      {
        type: "text",
        text: "No Paseo browser tabs are open. Call browser_new_tab to create one.",
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: { command: "list_tabs", tabs: [] },
      context: { agentId: "agent-1", cwd: REPO_CWD, workspaceId: BROWSER_WORKSPACE_ID },
    });
  });

  it("tells browser callers without a workspace how to proceed before broker execution", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({ id: "agent-1", cwd: REPO_CWD });
    const execute = vi.fn().mockResolvedValue({
      requestId: "req-browser-tabs",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      browserToolsEnabled: true,
      browserToolsBroker: { execute } as never,
      callerAgentId: "agent-1",
      logger,
    });
    const tool = registeredTool(server, "browser_list_tabs");

    const response = await tool.handler({});

    expect(execute).not.toHaveBeenCalled();
    expect(response.content).toEqual([
      {
        type: "text",
        text: "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.",
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: {
        code: "browser_denied",
        message:
          "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.",
        retryable: false,
      },
      context: { agentId: "agent-1", cwd: REPO_CWD },
    });
  });
});

describe("terminal MCP tools", () => {
  const logger = createTestLogger();

  it.each<[string, string, string, boolean]>([
    ["Down", "\x1b[B", "", false],
    ["Up", "\x1b[A", "", false],
    ["Left", "\x1b[D", "", false],
    ["Right", "\x1b[C", "", false],
    ["PageUp", "\x1b[5~", "", false],
    ["PageDown", "\x1b[6~", "", false],
    ["Home", "\x1b[H", "", false],
    ["End", "\x1b[F", "", false],
    ["Insert", "\x1b[2~", "", false],
    ["Delete", "\x1b[3~", "", false],
    ["F1", "\x1bOP", "", false],
    ["F5", "\x1b[15~", "", false],
    ["F12", "\x1b[24~", "", false],
    ["S-Tab", "\x1b[Z", "", false],
    ["C-r", "\x12", "", false],
    ["M-b", "\x1bb", "", false],
    ["C-M-Left", "\x1b[1;7D", "", false],
    ["C-S-Up", "\x1b[1;6A", "", false],
    ["C-Space", "\x00", "", false],
    ["Enter", "\r", "", false],
    ["Tab", "\t", "", false],
    ["Escape", "\x1b", "", false],
    ["Space", " ", "", false],
    ["BSpace", "\x7f", "", false],
    ["C-c", "\x03", "", false],
    ["C-d", "\x04", "", false],
    ["C-z", "\x1a", "", false],
    ["C-l", "\x0c", "", false],
    ["C-a", "\x01", "", false],
    ["C-e", "\x05", "", false],
    ["Down", "\x1bOB", "\x1b[?1h", false],
    ["S-Enter", "\x1b[13;2u", "\x1b[=1;1u", false],
    ["C-Enter", "\x1b[13;28;13;1;8;1_", "\x1b[?9001h", false],
    ["echo hello\r", "echo hello\r", "", false],
    ["\x1b[B", "\x1b[B", "", false],
    ["UnknownKey", "UnknownKey", "", false],
    ["constructor", "constructor", "", false],
    ["__proto__", "__proto__", "", false],
    ["", "", "", false],
    ["Down", "Down", "\x1b[?1h", true],
    ["C-r", "C-r", "", true],
    ["S-Tab", "S-Tab", "", true],
  ])(
    "sends terminal token %j as %j (preamble=%j, literal=%s)",
    async (keys, data, preamble, literal) => {
      const { agentManager, agentStorage } = createTestDeps();
      const send = vi.fn();
      const terminalManager = createTerminalManagerStub({
        getTerminal: vi.fn().mockReturnValue({
          send,
          getReplayPreamble: () => preamble,
        }),
      });
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createClaudeOnlyManager(),
        terminalManager,
        logger,
      });

      try {
        const response = await registeredTool(server, "send_terminal_keys").handler({
          terminalId: "term-1",
          keys,
          literal,
        });
        expect(response.structuredContent).toEqual({ success: true });
        expect(send).toHaveBeenCalledExactlyOnceWith({ type: "input", data });
      } finally {
        await server.close();
      }
    },
  );

  it.each([
    ["in-process", createTerminalManager],
    ["worker", createWorkerTerminalManager],
  ] as const)(
    "delivers MCP key tokens through %s after terminal input modes change",
    async (_name, createManager) => {
      const { agentManager, agentStorage } = createTestDeps();
      const terminalManager = createManager();
      const terminal = await terminalManager.createTerminal({
        cwd: process.cwd(),
        workspaceId: "ws-terminal-keys",
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.setRawMode(true);
         process.stdout.write("READY\\r\\n");
         process.stdin.on("data", data => {
           if (data.toString() === "application") {
             process.stdout.write("\\x1b[?1hAPPLICATION_READY\\r\\n");
             return;
           }
           if (data.toString() === "normal") {
             process.stdout.write("\\x1b[?1lNORMAL_READY\\r\\n");
             return;
           }
           process.stdout.write("HEX:" + data.toString("hex") + "\\r\\n");
         });`,
        ],
      });
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createClaudeOnlyManager(),
        terminalManager,
        logger,
      });

      let output = "";
      const unsubscribe = terminal.subscribe((message) => {
        if (message.type === "output") {
          output += message.data;
        }
      });
      // Every key travels through the PTY and back; on loaded Windows runners one round
      // trip can take seconds, so each wait gets the same budget as the first.
      const roundTrip = { timeout: 5000 };
      try {
        await vi.waitFor(async () => {
          const capture = await terminalManager.captureTerminal(terminal.id);
          expect(capture.lines).toContain("READY");
        }, roundTrip);
        const tool = registeredTool(server, "send_terminal_keys");
        await tool.handler({ terminalId: terminal.id, keys: "application", literal: true });
        await vi.waitFor(() => expect(output).toContain("APPLICATION_READY"), roundTrip);
        for (const [keys, hex] of [
          ["Down", "1b4f42"],
          ["Up", "1b4f41"],
          ["Left", "1b4f44"],
          ["Right", "1b4f43"],
          ["PageDown", "1b5b367e"],
          ["S-Tab", "1b5b5a"],
          ["C-r", "12"],
          ["M-b", "1b62"],
        ]) {
          await tool.handler({ terminalId: terminal.id, keys });
          await vi.waitFor(async () => {
            const capture = await terminalManager.captureTerminal(terminal.id);
            expect(capture.lines.join("\n")).toContain(`HEX:${hex}`);
          }, roundTrip);
        }
        await tool.handler({ terminalId: terminal.id, keys: "normal", literal: true });
        await vi.waitFor(() => expect(output).toContain("NORMAL_READY"), roundTrip);
        await tool.handler({ terminalId: terminal.id, keys: "Down" });
        await vi.waitFor(async () => {
          const capture = await terminalManager.captureTerminal(terminal.id);
          expect(capture.lines).toContain("HEX:1b5b42");
        }, roundTrip);
      } finally {
        unsubscribe();
        await server.close();
        await terminalManager.killTerminalAndWait(terminal.id);
        terminalManager.killAll();
      }
    },
  );

  it("captures terminal output through the terminal manager authority", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const captureTerminal = vi.fn().mockResolvedValue({
      lines: ["from worker scrollback"],
      totalLines: 42,
    });
    const terminalManager = createTerminalManagerStub({
      getTerminal: vi.fn().mockReturnValue({
        id: "term-1",
        name: "daemon",
        cwd: process.cwd(),
        getState: vi.fn().mockReturnValue({ scrollback: [], grid: [[]] }),
      }),
      captureTerminal,
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      terminalManager,
      logger,
    });
    const tool = registeredTool(server, "capture_terminal");

    const response = await tool.handler({
      terminalId: "term-1",
      scrollback: true,
      stripAnsi: false,
      start: -10,
      end: -1,
    });

    expect(captureTerminal).toHaveBeenCalledWith("term-1", {
      start: 0,
      end: -1,
      stripAnsi: false,
    });
    expect(response.structuredContent).toEqual({
      terminalId: "term-1",
      lines: ["from worker scrollback"],
      totalLines: 42,
    });
  });
});

describe("ask_attention_question MCP tool", () => {
  const logger = createTestLogger();
  const question = {
    observation: "The evidence conflicts with the current conclusion.",
    question: "What evidence supports the current conclusion?",
    evidenceRefs: ["timeline:q1"],
  };

  function setupAttentionQuestionScenario(targetPolicyOwner: unknown, running = true) {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const registry = createDefaultSlpBundledPolicyRegistry();
    const caller = createManagedAgent({
      id: "supervisor-46",
      cwd: REPO_CWD,
      workspaceId: "wks_attention",
      roleBinding: createTestRoleBinding("supervisor"),
    });
    let target = createActiveStoredRecord({
      id: "target-agent",
      cwd: REPO_CWD,
      workspaceId: "wks_attention",
      roleBinding: {
        ...createTestRoleBinding("lead"),
        policyOwner: (targetPolicyOwner === null ? undefined : targetPolicyOwner) as never,
      },
      coordinationSignals: [],
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    spies.agentManager.hasInFlightRun.mockReturnValue(running);
    spies.agentStorage.get.mockImplementation(async (agentId: string) => {
      if (agentId === caller.id) {
        return createActiveStoredRecord({
          id: caller.id,
          cwd: caller.cwd,
          workspaceId: caller.workspaceId,
          roleBinding: caller.roleBinding,
        });
      }
      return agentId === target.id ? target : null;
    });
    spies.agentStorage.upsert.mockImplementation(async (record: StoredAgentRecord) => {
      if (record.id === target.id) target = record;
    });
    spies.agentManager.assertAttentionQuestionTargetSupport.mockImplementation((binding) =>
      AgentManager.prototype.assertAttentionQuestionTargetSupport.call(
        { bundledPolicyPacks: registry } as unknown as AgentManager,
        binding,
      ),
    );
    return {
      agentManager,
      agentStorage,
      spies,
      registry,
      caller,
      getTarget: () => target,
    };
  }

  it("keeps Q1/Q2 distinct and merges only exact normalized recurrence for a .46 target", async () => {
    const registry = createDefaultSlpBundledPolicyRegistry();
    const scenario = setupAttentionQuestionScenario(registry.resolveActive("slp").owner);
    const server = await createAgentMcpServer({
      agentManager: scenario.agentManager,
      agentStorage: scenario.agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: scenario.caller.id,
      sendAgentMessageAtSafeBoundary: vi.fn(async () => undefined),
      logger,
    });
    const tool = registeredTool(server, "ask_attention_question");

    const first = await invokeToolWithParsedInput(tool, {
      agentId: "target-agent",
      ...question,
    });
    const distinct = await invokeToolWithParsedInput(tool, {
      agentId: "target-agent",
      observation: "The current status omits the reviewed constraint.",
      question: "Which constraint explains the observed delay?",
      evidenceRefs: ["timeline:q2"],
    });
    const recurrence = await invokeToolWithParsedInput(tool, {
      agentId: "target-agent",
      observation: "  the EVIDENCE conflicts with the current conclusion. ",
      question: " WHAT evidence supports the current conclusion? ",
      evidenceRefs: ["timeline:q1:repeat"],
    });

    expect(distinct.structuredContent.signal).not.toMatchObject({
      id: (first.structuredContent.signal as { id: string }).id,
    });
    expect(recurrence.structuredContent.signal).toMatchObject({
      id: (first.structuredContent.signal as { id: string }).id,
      occurrenceCount: 2,
      evidenceRefs: ["timeline:q1", "timeline:q1:repeat"],
    });
    expect(scenario.getTarget().coordinationSignals).toHaveLength(2);
    expect(scenario.getTarget().coordinationSignals?.[0]).toMatchObject({
      requestedByAgentId: "supervisor-46",
      source: { kind: "agent", agentId: "supervisor-46" },
      coalescingKey: attentionQuestionCoalescingKey({
        ...question,
        requester: { kind: "agent", agentId: "supervisor-46" },
        targetAgentId: "target-agent",
      }),
    });
  });

  it("delivers agent Q2 after a distinct Q1 was already delivered", async () => {
    const registry = createDefaultSlpBundledPolicyRegistry();
    const scenario = setupAttentionQuestionScenario(registry.resolveActive("slp").owner, false);
    const delivered: string[] = [];
    const server = await createAgentMcpServer({
      agentManager: scenario.agentManager,
      agentStorage: scenario.agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: scenario.caller.id,
      sendAgentMessageAtSafeBoundary: vi.fn(async (_agentId, message) => {
        delivered.push(message);
      }),
      logger,
    });
    const tool = registeredTool(server, "ask_attention_question");

    await invokeToolWithParsedInput(tool, { agentId: "target-agent", ...question });
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    await invokeToolWithParsedInput(tool, {
      agentId: "target-agent",
      observation: "The current status omits the reviewed constraint.",
      question: "Which constraint explains the observed delay?",
      evidenceRefs: ["timeline:q2"],
    });
    await vi.waitFor(() => expect(delivered).toHaveLength(2));

    expect(delivered[0]).toContain(question.question);
    expect(delivered[1]).toContain("Which constraint explains the observed delay?");
    expect(scenario.getTarget().coordinationSignals).toHaveLength(2);
  });

  it.each([
    {
      name: "removed-historical",
      owner: {
        kind: "plugin",
        pluginId: "slp",
        policyVersion: "1.0.0",
        generationDigest: "569c7f4633b7ffacb2e63c0ee3dda1ea882bc050bc456fdc8ac0c466f4f483f0",
      },
      error: "target_generation_unavailable",
    },
    { name: "legacy", owner: { kind: "legacy-core" }, error: "legacy-or-non-slp" },
    { name: "missing", owner: null, error: "owner_missing" },
    { name: "corrupt", owner: { kind: "plugin", pluginId: "slp" }, error: "owner_invalid" },
    {
      name: "unknown",
      owner: {
        kind: "plugin",
        pluginId: "slp",
        policyVersion: "1.1.0",
        generationDigest: "f".repeat(64),
      },
      error: "target_generation_unavailable",
    },
  ])("rejects a $name target generation before persistence", async ({ owner, error }) => {
    const scenario = setupAttentionQuestionScenario(owner);
    const server = await createAgentMcpServer({
      agentManager: scenario.agentManager,
      agentStorage: scenario.agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: scenario.caller.id,
      sendAgentMessageAtSafeBoundary: vi.fn(async () => undefined),
      logger,
    });

    await expect(
      invokeToolWithParsedInput(registeredTool(server, "ask_attention_question"), {
        agentId: "target-agent",
        ...question,
      }),
    ).rejects.toThrow(error);
    expect(scenario.getTarget().coordinationSignals).toEqual([]);
    expect(scenario.spies.agentStorage.upsert).not.toHaveBeenCalled();
  });
});

describe("create_agent MCP tool", () => {
  const logger = createTestLogger();
  const existingCwd = process.cwd();
  const detachedDirectoryWorkspace = (path = existingCwd) => ({
    relationship: { kind: "detached" as const },
    workspace: { kind: "create" as const, source: { kind: "directory" as const, path } },
  });
  const subagentCurrentWorkspace = (cwd?: string) => ({
    relationship: { kind: "subagent" as const },
    workspace: { kind: "current" as const, ...(cwd ? { cwd } : {}) },
  });
  const detachedCurrentWorkspace = (cwd?: string) => ({
    relationship: { kind: "detached" as const },
    workspace: { kind: "current" as const, ...(cwd ? { cwd } : {}) },
  });
  const detachedExistingWorkspace = (workspaceId: string, cwd?: string) => ({
    relationship: { kind: "detached" as const },
    workspace: { kind: "existing" as const, workspaceId, ...(cwd ? { cwd } : {}) },
  });
  const ensureWorkspaceForCreate = async () => "workspace-created";

  it("allows a role-bound Lead to create a role-bound Peer", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(
      createManagedAgent({
        id: "peer-agent",
        cwd: existingCwd,
        workspaceId: "wks_lead",
        roleBinding: createTestRoleBinding("peer"),
      }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: caller.id,
      logger,
    });

    await registeredTool(server, "create_agent").handler({
      title: "Peer child",
      provider: "opencode/gpt-5.4",
      role: "peer",
      initialPrompt: "Do bounded work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "opencode", model: "gpt-5.4" }),
      undefined,
      expect.objectContaining({
        labels: expect.objectContaining({ [PARENT_AGENT_ID_LABEL]: caller.id }),
        workspaceId: "wks_lead",
        roleId: "peer",
      }),
    );
  });

  it("rejects a Lead Peer route outside the Human-configured model policy before creation", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: {
        get: () =>
          ({
            peerDelegation: {
              enabled: true,
              runMode: "unattended",
              allowedModels: [{ provider: "codex", model: "gpt-5.4" }],
            },
          }) as never,
      },
      callerAgentId: caller.id,
      logger,
    });

    await expect(
      registeredTool(server, "create_agent").handler({
        title: "Disallowed Peer",
        provider: "opencode/gpt-4",
        role: "peer",
        initialPrompt: "Do bounded work",
      }),
    ).rejects.toThrow("is not allowed by the Human-configured policy");
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("blocks Lead-to-Peer creation when Human delegation is switched off", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: {
        get: () =>
          ({
            providers: {},
            peerDelegation: {
              enabled: false,
              runMode: "unattended",
              allowedModels: [{ provider: "codex", model: "gpt-5.4" }],
            },
          }) as never,
      },
      callerAgentId: caller.id,
      logger,
    });

    await expect(
      registeredTool(server, "create_agent").handler({
        title: "Blocked Peer",
        provider: "codex/gpt-5.4",
        role: "peer",
        initialPrompt: "Do bounded work",
      }),
    ).rejects.toThrow("Lead-to-Peer creation is disabled");
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("selects the only Human-approved Peer route when a Lead omits provider", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      provider: "claude",
      config: { model: "claude-haiku-4-5" },
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(
      createManagedAgent({ id: "peer-agent", roleBinding: createTestRoleBinding("peer") }),
    );
    const manager = createOpenCodeManager();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: manager.manager,
      daemonConfigStore: {
        get: () =>
          ({
            peerDelegation: {
              enabled: true,
              runMode: "guarded",
              allowedModels: [{ provider: "codex", model: "gpt-5.4" }],
            },
          }) as never,
      },
      callerAgentId: caller.id,
      logger,
    });

    await registeredTool(server, "create_agent").handler({
      title: "Approved Peer",
      role: "peer",
      initialPrompt: "Do bounded work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex", model: "gpt-5.4", modeId: "default" }),
      undefined,
      expect.objectContaining({ roleId: "peer" }),
    );
  });

  it("materializes an allowed Peer Agent Profile and blocks raw or disallowed overrides", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      provider: "claude",
      config: { model: "claude-haiku-4-5" },
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(
      createManagedAgent({ id: "peer-agent", roleBinding: createTestRoleBinding("peer") }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: {
        get: () =>
          MutableDaemonConfigSchema.parse({
            mcp: { injectIntoAgents: true },
            peerDelegation: {
              enabled: true,
              runMode: "unattended",
              allowedModels: [{ provider: "codex", model: "gpt-5.4" }],
            },
            peerDelegationProfileIds: ["peer-scout"],
            agentProfiles: [
              {
                id: "peer-scout",
                name: "Peer Scout",
                provider: "codex",
                model: "gpt-5.4",
                modeId: "full-access",
                thinkingOptionId: "high",
                featureValues: { fast_mode: true },
                notes: "Use for bounded codebase reconnaissance.",
              },
              {
                id: "peer-reviewer",
                name: "Peer Reviewer",
                provider: "codex",
                model: "gpt-5.4",
              },
            ],
          }),
      },
      callerAgentId: caller.id,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        title: "Raw Peer",
        provider: "codex/gpt-5.4",
        role: "peer",
        initialPrompt: "Do bounded work",
      }),
    ).rejects.toThrow("omit provider and settings");
    await expect(
      tool.handler({
        title: "Disallowed Peer",
        launchProfileId: "peer-reviewer",
        role: "peer",
        initialPrompt: "Do bounded work",
      }),
    ).rejects.toThrow("is not allowed by the Human-configured policy");

    const response = await tool.handler({
      title: "Scout Peer",
      launchProfileId: "peer-scout",
      role: "peer",
      initialPrompt: "Map the bounded implementation path",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledTimes(1);
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.4",
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
      undefined,
      expect.objectContaining({ roleId: "peer", workspaceId: "wks_lead" }),
    );
    expect(response.structuredContent).toEqual(
      expect.objectContaining({
        launchProfile: { id: "peer-scout", name: "Peer Scout" },
      }),
    );
  });

  it("rejects public internal helpers", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "mcp-public-helper-removal-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const agentManager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      logger,
    });
    try {
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage: storage,
        providerSnapshotManager: createOpenCodeManager().manager,
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      const input = { title: "Helper", provider: "codex/gpt-5.4", initialPrompt: "Summarize" };
      await expect(tool.handler({ ...input, internal: true })).rejects.toThrow(/Unrecognized key/);
      // GKG keeps the top-level execution `background` option (run blocking, not visibility).
    } finally {
      await removeAgentStateDir(agentManager, storage, workdir);
    }
  });

  it("rejects an exact Peer profile whose subrole conflicts with the assignment and rolls back its workspace", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      provider: "codex",
      config: { model: "gpt-5.4" },
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    const ensureWorkspace = vi.fn(async () => "wks_rejected_reviewer");
    const rollbackWorkspace = vi.fn(async () => undefined);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: {
        get: () =>
          MutableDaemonConfigSchema.parse({
            mcp: { injectIntoAgents: true },
            peerDelegation: {
              enabled: true,
              runMode: "unattended",
              allowedModels: [{ provider: "codex", model: "gpt-5.4" }],
            },
            peerDelegationProfileIds: ["peer-engineer"],
            agentProfiles: [
              {
                id: "peer-engineer",
                name: "Peer Engineer",
                provider: "codex",
                model: "gpt-5.4",
                modeId: "full-access",
                peerSubrole: "engineer",
              },
            ],
          }),
      },
      callerAgentId: caller.id,
      ensureWorkspaceForCreate: ensureWorkspace,
      rollbackWorkspaceAfterFailedCreate: rollbackWorkspace,
      logger,
    });

    await expect(
      registeredTool(server, "create_agent").handler({
        title: "Reviewer Peer",
        launchProfileId: "peer-engineer",
        role: "peer",
        cwd: existingCwd,
        assignment: {
          version: 1,
          disposition: "independent-review",
          objective: "Review the bounded candidate.",
          effectClass: "read-only",
          mutationBoundary: { mode: "no-write" },
          externalEffectBoundary: { mode: "denied" },
          evidence: "Return exact findings.",
          handbackAndStop: "Stop after the review handback.",
        },
        initialPrompt: "Review the bounded candidate",
      }),
    ).rejects.toThrow("cannot satisfy requested subrole 'reviewer'");

    expect(ensureWorkspace).toHaveBeenCalledTimes(1);
    expect(ensureWorkspace).toHaveBeenCalledWith(
      existingCwd,
      { title: "Reviewer Peer", prompt: "Review the bounded candidate" },
      { callerWorkspaceId: "wks_lead" },
    );
    expect(rollbackWorkspace).toHaveBeenCalledWith("wks_rejected_reviewer");
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("reports an incompatible stored profile mode and rolls back its workspace", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      provider: "claude",
      config: { model: "claude-fable-5" },
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    const ensureWorkspace = vi.fn(async () => "wks_incompatible_mode");
    const rollbackWorkspace = vi.fn(async () => undefined);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: {
        get: () =>
          MutableDaemonConfigSchema.parse({
            mcp: { injectIntoAgents: true },
            peerDelegation: {
              enabled: true,
              runMode: "unattended",
              allowedModels: [{ provider: "claude", model: "claude-fable-5" }],
            },
            peerDelegationProfileIds: ["peer-reviewer"],
            agentProfiles: [
              {
                id: "peer-reviewer",
                name: "Peer Reviewer",
                provider: "claude",
                model: "claude-fable-5",
                modeId: "default",
                peerSubrole: "reviewer",
              },
            ],
          }),
      },
      callerAgentId: caller.id,
      ensureWorkspaceForCreate: ensureWorkspace,
      rollbackWorkspaceAfterFailedCreate: rollbackWorkspace,
      logger,
    });

    await expect(
      registeredTool(server, "create_agent").handler({
        title: "Reviewer Peer",
        launchProfileId: "peer-reviewer",
        role: "peer",
        cwd: existingCwd,
        initialPrompt: "Review the bounded candidate",
      }),
    ).rejects.toThrow("Peer Agent Profile 'Peer Reviewer' (peer-reviewer) uses mode 'default'");

    expect(ensureWorkspace).toHaveBeenCalledTimes(1);
    expect(rollbackWorkspace).toHaveBeenCalledWith("wks_incompatible_mode");
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("lets a no-write Peer assignment override an unattended Agent Profile mode", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      provider: "claude",
      config: { model: "claude-fable-5" },
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(
      createManagedAgent({ id: "peer-agent", roleBinding: createTestRoleBinding("peer") }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: {
        get: () =>
          MutableDaemonConfigSchema.parse({
            mcp: { injectIntoAgents: true },
            peerDelegation: {
              enabled: true,
              runMode: "unattended",
              allowedModels: [{ provider: "claude", model: "claude-fable-5" }],
            },
            peerDelegationProfileIds: ["peer-reviewer-claude"],
            agentProfiles: [
              {
                id: "peer-reviewer-claude",
                name: "Peer Reviewer Claude",
                provider: "claude",
                model: "claude-fable-5",
                modeId: "bypassPermissions",
                peerSubrole: "reviewer",
              },
            ],
          }),
      },
      callerAgentId: caller.id,
      logger,
    });
    const assignment = {
      version: 1,
      disposition: "independent-review",
      objective: "Review the bounded implementation without changing files.",
      effectClass: "read-only",
      mutationBoundary: { mode: "no-write" },
      externalEffectBoundary: { mode: "denied" },
      evidence: "Return exact review evidence.",
      handbackAndStop: "Stop after the review handback.",
    } as const;

    await registeredTool(server, "create_agent").handler({
      title: "Reviewer Peer",
      launchProfileId: "peer-reviewer-claude",
      role: "peer",
      assignment,
      initialPrompt: "Review this bounded change and do not write anything",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude",
        model: "claude-fable-5",
        modeId: "default",
      }),
      undefined,
      expect.objectContaining({
        roleId: "peer",
        assignment,
        launchProfile: {
          id: "peer-reviewer-claude",
          name: "Peer Reviewer Claude",
          peerSubrole: "reviewer",
        },
      }),
    );
  });

  it("resolves a generic Peer through default subrole and provider priority", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      provider: "codex",
      config: { model: "gpt-5.4" },
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(
      createManagedAgent({ id: "peer-agent", roleBinding: createTestRoleBinding("peer") }),
    );
    const profiles: AgentProfile[] = [
      {
        id: "codex-engineer",
        name: "Peer Engineer — Codex",
        provider: "codex",
        model: "gpt-5.4",
        modeId: "full-access",
        peerSubrole: "engineer",
      },
      {
        id: "claude-scout",
        name: "Peer Scout — Claude",
        provider: "claude",
        model: "claude-sonnet-5",
        modeId: "bypassPermissions",
        peerSubrole: "scout",
      },
      {
        id: "claude-engineer",
        name: "Peer Engineer — Claude",
        provider: "claude",
        model: "claude-sonnet-5",
        modeId: "bypassPermissions",
        peerSubrole: "engineer",
      },
    ];
    const config = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: true },
      peerDelegation: {
        enabled: true,
        runMode: "unattended",
        allowedModels: profiles.map((profile) => ({
          provider: profile.provider,
          model: profile.model,
        })),
      },
      peerDelegationProfileIds: profiles.map((profile) => profile.id),
      peerDelegationProviderPriority: ["claude", "codex"],
      peerDelegationDefaultSubrole: "engineer",
      agentProfiles: profiles,
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: { get: () => config },
      callerAgentId: caller.id,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const genericResponse = await tool.handler({
      title: "Generic implementation Peer",
      role: "peer",
      initialPrompt: "Implement the bounded fix",
    });

    expect(spies.agentManager.createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "claude",
        model: "claude-sonnet-5",
        modeId: "bypassPermissions",
      }),
      undefined,
      expect.objectContaining({
        roleId: "peer",
        launchProfile: {
          id: "claude-engineer",
          name: "Peer Engineer — Claude",
          peerSubrole: "engineer",
        },
      }),
    );
    expect(genericResponse.structuredContent).toEqual(
      expect.objectContaining({
        launchProfile: {
          id: "claude-engineer",
          name: "Peer Engineer — Claude",
          peerSubrole: "engineer",
        },
      }),
    );

    await tool.handler({
      title: "Exact implementation Peer",
      launchProfileId: "codex-engineer",
      role: "peer",
      initialPrompt: "Implement with the exact requested route",
    });

    expect(spies.agentManager.createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "codex", model: "gpt-5.4", modeId: "full-access" }),
      undefined,
      expect.objectContaining({
        roleId: "peer",
        launchProfile: {
          id: "codex-engineer",
          name: "Peer Engineer — Codex",
          peerSubrole: "engineer",
        },
      }),
    );
  });

  it("allows a delegation-bound Supervisor to create a role-bound Lead", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const projectCwd = join(existingCwd, "project-a");
    const caller = createManagedAgent({
      id: "supervisor-agent",
      provider: "claude",
      config: { model: "claude-haiku-4-5" },
      cwd: existingCwd,
      workspaceId: "wks_control",
      roleBinding: createTestRoleBinding("supervisor", "delegation"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(
      createManagedAgent({
        id: "lead-agent",
        provider: "claude",
        config: { model: "claude-haiku-4-5" },
        cwd: projectCwd,
        workspaceId: "wks_project_a",
        roleBinding: createTestRoleBinding("lead"),
      }),
    );
    const ensureWorkspace = vi.fn(async () => "wks_project_a");
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: caller.id,
      ensureWorkspaceForCreate: ensureWorkspace,
      logger,
    });

    await registeredTool(server, "create_agent").handler({
      title: "Project Lead",
      role: "lead",
      cwd: projectCwd,
      initialPrompt: "Own the bounded project",
    });

    expect(ensureWorkspace).toHaveBeenCalledWith(
      projectCwd,
      { title: "Project Lead", prompt: "Own the bounded project" },
      { callerWorkspaceId: "wks_control" },
    );
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude", model: "claude-haiku-4-5" }),
      undefined,
      expect.objectContaining({
        labels: expect.objectContaining({ [PARENT_AGENT_ID_LABEL]: caller.id }),
        workspaceId: "wks_project_a",
        roleId: "lead",
      }),
    );
  });

  it("rejects an unavailable explicit role-child model before creating an agent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "supervisor-agent",
      provider: "claude",
      config: { model: "claude-haiku-4-5" },
      cwd: existingCwd,
      workspaceId: "wks_control",
      roleBinding: createTestRoleBinding("supervisor", "delegation"),
    });
    spies.agentManager.getAgent.mockReturnValue(caller);
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.listModels.mockResolvedValue([
      { provider: "codex", id: "gpt-5.4", label: "GPT-5.4" },
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: providerSnapshot.manager,
      callerAgentId: caller.id,
      logger,
    });

    await expect(
      registeredTool(server, "create_agent").handler({
        title: "Invalid route",
        provider: "codex/claude-haiku-4-5",
        role: "lead",
        initialPrompt: "Must not create a ghost agent",
      }),
    ).rejects.toThrow("is not available for provider 'codex'");
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("limits Peer external access grants to the role-bound Lead's exact grant set", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const leadExternalEffects = ["read/write dev database"];
    const leadRoleBinding = {
      ...createTestRoleBinding("lead"),
      assignmentContract: materializeAssignmentContract({
        roleId: "lead",
        assigner: { kind: "human-session" },
        workspaceId: "wks_external_effect_lead",
        cwd: existingCwd,
        createdAt: new Date("2026-08-09T00:00:00.000Z"),
        envelope: {
          version: 1,
          disposition: "lead-direct",
          objective: "Route bounded work.",
          effectClass: "delegation",
          mutationBoundary: { mode: "no-write" },
          externalEffectBoundary: assignmentExternalEffectBoundaryFor(
            "lead",
            "delegation",
            leadExternalEffects,
          ),
          resourceGrants: { externalEffects: leadExternalEffects },
          evidence: "Return exact observed evidence.",
          handbackAndStop: "Stop after the evidence handback.",
        },
      }),
    };
    const caller = createManagedAgent({
      id: "external-effect-lead-agent",
      cwd: existingCwd,
      workspaceId: "wks_external_effect_lead",
      roleBinding: leadRoleBinding,
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: leadRoleBinding,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(
      createManagedAgent({
        id: "external-effect-peer-agent",
        cwd: existingCwd,
        workspaceId: "wks_external_effect_lead",
        roleBinding: createTestRoleBinding("peer"),
      }),
    );
    const providerSnapshot = createOpenCodeManager();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: providerSnapshot.manager,
      callerAgentId: caller.id,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const peerAssignment = (externalEffects: readonly string[]) => ({
      version: 1 as const,
      disposition: "peer-execution" as const,
      objective: "Perform bounded mutation.",
      effectClass: "mutating" as const,
      mutationBoundary: { mode: "bounded-write" as const, scope: existingCwd },
      externalEffectBoundary: assignmentExternalEffectBoundaryFor(
        "peer",
        "mutating",
        externalEffects,
      ),
      resourceGrants: { beadsIssueIds: ["ps-test-external"], externalEffects },
      evidence: "Return exact observed evidence.",
      handbackAndStop: "Stop after the evidence handback.",
    });

    await expect(
      tool.handler({
        title: "Denied Peer",
        provider: "opencode/gpt-5.4",
        role: "peer",
        assignment: peerAssignment(["read/write dev database", "write sandbox API"]),
        initialPrompt: "Must not run",
      }),
    ).rejects.toThrow(
      "A role-bound Lead may grant a Peer only its own external access grants; denied: write sandbox API",
    );
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();

    const allowedAssignment = peerAssignment([" read/write dev database "]);
    await tool.handler({
      title: "Allowed Peer",
      provider: "opencode/gpt-5.4",
      role: "peer",
      assignment: allowedAssignment,
      initialPrompt: "Perform bounded mutation",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        assignment: expect.objectContaining({
          resourceGrants: {
            beadsIssueIds: ["ps-test-external"],
            externalEffects: ["read/write dev database"],
          },
        }),
        roleId: "peer",
      }),
    );
  });

  it("lets only a role-bound Lead select a Council execution specialization", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const lead = createManagedAgent({
      id: "lead-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      roleBinding: createTestRoleBinding("lead"),
    });
    const child = createManagedAgent({
      id: "architect-agent",
      provider: "codex",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      lifecycle: "idle",
      currentModeId: "full-access",
      availableModes: [],
      config: { title: "Council architect" },
    });
    spies.agentManager.getAgent.mockImplementation((id: string) => {
      if (id === lead.id) return lead;
      if (id === child.id) return child;
      return null;
    });
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: lead.id,
        cwd: lead.cwd,
        workspaceId: lead.workspaceId,
        roleBinding: lead.roleBinding,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(child);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: lead.id,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    expect((tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape.executionProfile).toBeDefined();

    await tool.handler({
      title: "Council architect",
      provider: "codex/gpt-5.4",
      role: "peer",
      executionProfile: "solution-architect",
      settings: { modeId: "auto", thinkingOptionId: "medium" },
      initialPrompt: "Inspect the bounded architecture question",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.4",
        modeId: "auto",
        thinkingOptionId: "medium",
      }),
      undefined,
      expect.objectContaining({
        roleId: "peer",
        executionProfileId: "solution-architect",
        workspaceId: "wks_parent",
      }),
    );
  });

  it.each(["peer", "supervisor"] as const)(
    "does not project the execution-specialization field to an ordinary %s",
    async (callerRole) => {
      const { agentManager, agentStorage, spies } = createTestDeps();
      const caller = createManagedAgent({
        id: `${callerRole}-agent`,
        cwd: existingCwd,
        workspaceId: "wks_parent",
        roleBinding: createTestRoleBinding(callerRole),
      });
      spies.agentManager.getAgent.mockReturnValue(caller);
      mockStoredAgentRecordsWithCreatedChildren(spies, [
        createActiveStoredRecord({
          id: caller.id,
          cwd: caller.cwd,
          workspaceId: caller.workspaceId,
          roleBinding: caller.roleBinding,
        }),
      ]);

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        callerAgentId: caller.id,
        logger,
      });
      const tool = registeredTool(server, "create_agent");

      expect(
        (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape.executionProfile,
      ).toBeUndefined();
      await expect(
        tool.handler({
          title: "Council reviewer",
          provider: "codex/gpt-5.4",
          role: "peer",
          executionProfile: "reviewer",
          initialPrompt: "Review the bounded proposition",
        }),
      ).rejects.toThrow(/Unrecognized key/);
      expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
    },
  );

  it.each([
    { callerRole: "lead" as const, requestedRole: "lead" as const },
    { callerRole: "lead" as const, requestedRole: "supervisor" as const },
    { callerRole: "lead" as const, requestedRole: undefined },
    { callerRole: "peer" as const, requestedRole: "peer" as const },
    { callerRole: "supervisor" as const, requestedRole: "peer" as const },
    { callerRole: "supervisor" as const, requestedRole: "lead" as const },
  ])(
    "rejects role-bound $callerRole create_agent role=$requestedRole before partial mutation",
    async ({ callerRole, requestedRole }) => {
      const { agentManager, agentStorage, spies } = createTestDeps();
      const caller = createManagedAgent({
        id: `${callerRole}-agent`,
        cwd: existingCwd,
        workspaceId: "wks_bound",
        roleBinding: createTestRoleBinding(callerRole),
      });
      spies.agentManager.getAgent.mockImplementation((agentId: string) =>
        agentId === caller.id ? caller : null,
      );
      mockStoredAgentRecordsWithCreatedChildren(spies, [
        createActiveStoredRecord({
          id: caller.id,
          cwd: caller.cwd,
          workspaceId: caller.workspaceId,
          roleBinding: caller.roleBinding,
        }),
      ]);
      const ensureWorkspace = vi.fn(async () => "unexpected-workspace");
      const listActiveWorkspaces = vi.fn(async () => []);
      const providerSnapshot = createOpenCodeManager();
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: providerSnapshot.manager,
        callerAgentId: caller.id,
        ensureWorkspaceForCreate: ensureWorkspace,
        listActiveWorkspaces,
        logger,
      });
      const request = {
        title: "Denied child",
        provider: "opencode/gpt-5.4",
        initialPrompt: "Must not run",
        ...(requestedRole ? { role: requestedRole } : {}),
      };

      await expect(registeredTool(server, "create_agent").handler(request)).rejects.toThrow(
        expectedCreateTopologyError(callerRole),
      );

      expect(ensureWorkspace).not.toHaveBeenCalled();
      expect(listActiveWorkspaces).not.toHaveBeenCalled();
      expect(providerSnapshot.stub.resolveCreateConfig).not.toHaveBeenCalled();
      expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
      expect(spies.agentStorage.setTitle).not.toHaveBeenCalled();
      expect(spies.agentStorage.upsert).not.toHaveBeenCalled();
      expect(spies.agentStorage.applySnapshot).not.toHaveBeenCalled();
      expect(spies.agentStorage.remove).not.toHaveBeenCalled();
      expect(spies.agentManager.streamAgent).not.toHaveBeenCalled();
      expect(spies.agentManager.subscribe).not.toHaveBeenCalled();
    },
  );

  it("rejects Peer creation when a Lead has Inspect only authority", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "read-only-lead",
      cwd: existingCwd,
      workspaceId: "wks_bound",
      roleBinding: createTestRoleBinding("lead", "read-only"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: caller.id,
      logger,
    });

    await expect(
      registeredTool(server, "create_agent").handler({
        title: "Denied Peer",
        provider: "codex/gpt-5.4",
        role: "peer",
        initialPrompt: "Must not launch",
      }),
    ).rejects.toThrow(
      "A role-bound Lead needs Work & coordinate or Coordinate only authority to create a Peer",
    );
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("preserves legacy unbound agent-scoped create_agent behavior", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "legacy-agent",
      cwd: existingCwd,
      workspaceId: "wks_legacy",
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue(
      createManagedAgent({ id: "legacy-child", cwd: existingCwd, workspaceId: "wks_legacy" }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: caller.id,
      logger,
    });

    await registeredTool(server, "create_agent").handler({
      title: "Legacy child",
      provider: "opencode/gpt-5.4",
      initialPrompt: "Keep legacy behavior",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledTimes(1);
  });

  it("rejects create_agent when durable caller data is unavailable", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({ id: "missing-caller", cwd: existingCwd, workspaceId: "wks_missing" }),
    );
    const ensureWorkspace = vi.fn(async () => "unexpected-workspace");
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "missing-caller",
      ensureWorkspaceForCreate: ensureWorkspace,
      logger,
    });

    await expect(
      registeredTool(server, "create_agent").handler({
        title: "Unknown caller",
        provider: "opencode/gpt-5.4",
        role: "peer",
        initialPrompt: "Must not run",
      }),
    ).rejects.toThrow("Caller agent missing-caller is unavailable in durable storage");

    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
    expect(spies.agentStorage.setTitle).not.toHaveBeenCalled();
    expect(spies.agentStorage.upsert).not.toHaveBeenCalled();
    expect(spies.agentStorage.applySnapshot).not.toHaveBeenCalled();
    expect(spies.agentStorage.remove).not.toHaveBeenCalled();
    expect(spies.agentManager.streamAgent).not.toHaveBeenCalled();
  });

  it("requires a concise title no longer than 60 characters", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    expect(tool).toBeDefined();

    const missingTitle = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      provider: "codex/gpt-5.4",
      initialPrompt: "test",
    });
    expect(missingTitle.success).toBe(false);
    expect(missingTitle.error.issues[0].path).toEqual(["title"]);

    const tooLong = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      provider: "codex/gpt-5.4",
      title: "x".repeat(61),
      initialPrompt: "test",
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error.issues[0].path).toEqual(["title"]);

    const ok = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      provider: "codex/gpt-5.4",
      title: "Short title",
      initialPrompt: "test",
    });
    expect(ok.success).toBe(true);
  });

  it("requires initialPrompt", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const parsed = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      provider: "codex/gpt-5.4",
      title: "Short title",
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.error.issues.some(
        (issue: { path: Array<string | number> }) => issue.path[0] === "initialPrompt",
      ),
    ).toBe(true);
  });

  it("creates a fresh local workspace for canonical top-level creation", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "top-level-agent",
      provider: "codex",
      cwd: existingCwd,
      workspaceId: "workspace-created",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Top-level agent" },
    } as ManagedAgent);
    const ensureWorkspace = vi.fn(async () => "workspace-created");
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate: ensureWorkspace,
      logger,
    });
    const assignment = {
      version: 1,
      disposition: "peer-execution",
      objective: "Complete the bounded test task.",
      effectClass: "read-only",
      mutationBoundary: { mode: "no-write" },
      externalEffectBoundary: { mode: "denied" },
      evidence: "Return exact observed evidence.",
      handbackAndStop: "Stop after the evidence handback.",
    } as const;

    await registeredTool(server, "create_agent").handler({
      title: "Top-level agent",
      provider: "codex/gpt-5.4",
      role: "peer",
      assignment,
      initialPrompt: "Do work",
      background: true,
    });

    expect(ensureWorkspace).toHaveBeenCalledWith(
      existingCwd,
      { title: "Top-level agent", prompt: "Do work" },
      { callerWorkspaceId: undefined },
    );
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: existingCwd }),
      undefined,
      expect.objectContaining({
        workspaceId: "workspace-created",
        roleId: "peer",
        assignment,
        assignmentAssigner: { kind: "human-session" },
      }),
    );
  });

  it("rejects partial explicit workspace shape", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const parsed = await tool.inputSchema.safeParseAsync({
      relationship: { kind: "detached" },
      title: "Short title",
      provider: "codex/gpt-5.4",
      initialPrompt: "test",
    });

    expect(parsed.success).toBe(true);
    await expect(tool.handler(parsed.data)).rejects.toThrow(
      "relationship and workspace must be provided together",
    );
  });

  it("rejects caller-only relationship and workspace intents without a caller agent", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        ...subagentCurrentWorkspace(),
        title: "Short title",
        provider: "codex/gpt-5.4",
        initialPrompt: "test",
      }),
    ).rejects.toThrow("relationship subagent requires an agent-scoped tool session");

    await expect(
      tool.handler({
        ...detachedCurrentWorkspace(),
        title: "Short title",
        provider: "codex/gpt-5.4",
        initialPrompt: "test",
      }),
    ).rejects.toThrow("workspace current requires an agent-scoped tool session");
  });

  it("requires a caller workspace for current workspace intent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({ id: "parent-agent", cwd: existingCwd }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        ...subagentCurrentWorkspace(),
        title: "Child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow("Caller agent parent-agent has no current workspace");
  });

  it("attaches create_agent to an existing workspace id", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "existing-workspace-agent",
      cwd: existingCwd,
      workspaceId: "wks_existing",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Existing workspace" },
    } as ManagedAgent);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      listActiveWorkspaces: async () => [
        { workspaceId: "wks_existing", cwd: existingCwd, kind: "worktree" },
      ],
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const response = await tool.handler({
      ...detachedExistingWorkspace("wks_existing"),
      title: "Existing workspace",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(response.structuredContent.workspaceId).toBe("wks_existing");
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
      }),
      undefined,
      { workspaceId: "wks_existing" },
    );
  });

  it("accepts provider features and passes them through createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "feature-agent",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Feature test", featureValues: { fast_mode: true } },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const input = {
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Feature test",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",

      settings: { features: { fast_mode: true } },
    };

    const parsed = await tool.inputSchema.safeParseAsync(input);
    expect(parsed.success).toBe(true);

    await tool.handler(input);

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.4",
        featureValues: { fast_mode: true },
      }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("returns create_agent structured content with full provider modes", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "mode-agent",
      provider: "codex",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [
        {
          id: "build",
          label: "Build",
          description: null,
          icon: "hammer",
          colorTier: "dangerous",
        },
      ],
      config: { title: "Mode test" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const response = await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Mode test",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(response.structuredContent).toEqual(
      expect.objectContaining({
        agentId: "mode-agent",
        type: "codex",
        status: "idle",
        cwd: REPO_CWD,
        currentModeId: "build",
        availableModes: [
          {
            id: "build",
            label: "Build",
            description: null,
            icon: "hammer",
            colorTier: "dangerous",
          },
        ],
      }),
    );
  });

  it("requires provider as provider/model and rejects the old model field", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const missingProvider = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      title: "Short title",
      initialPrompt: "test",
    });
    expect(missingProvider.success).toBe(false);
    expect(
      missingProvider.error.issues.some(
        (issue: { path: Array<string | number> }) => issue.path[0] === "provider",
      ),
    ).toBe(true);

    const providerWithoutModel = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      title: "Short title",
      provider: "codex",
      initialPrompt: "test",
    });
    expect(providerWithoutModel.success).toBe(false);

    const providerWithEmptyModel = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      title: "Short title",
      provider: "codex/",
      initialPrompt: "test",
    });
    expect(providerWithEmptyModel.success).toBe(false);

    const providerWithEmptyProvider = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      title: "Short title",
      provider: "/gpt-5.4",
      initialPrompt: "test",
    });
    expect(providerWithEmptyProvider.success).toBe(false);

    await expect(
      tool.handler({
        ...detachedDirectoryWorkspace(existingCwd),
        settings: { modeId: "default" },
        title: "Short title",
        provider: "codex/gpt-5.4",
        model: "gpt-5.4",
        initialPrompt: "test",
      }),
    ).rejects.toThrow("Unrecognized key");
  });

  it("exposes workspace tools instead of worktree tools", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    expect(lookupTool(server, "create_workspace")).toBeDefined();
    expect(lookupTool(server, "list_workspaces")).toBeDefined();
    expect(lookupTool(server, "archive_workspace")).toBeDefined();
    expect(lookupTool(server, "create_worktree")).toBeUndefined();
    expect(lookupTool(server, "list_worktrees")).toBeUndefined();
    expect(lookupTool(server, "archive_worktree")).toBeUndefined();
    expect(lookupTool(server, "detach_agent")).toBeUndefined();
    expect(lookupTool(server, "update_heartbeat")).toBeUndefined();
  });

  it("surfaces createAgent validation failures", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockRejectedValue(
      new Error("Working directory does not exist: /path/that/does/not/exist"),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        ...detachedDirectoryWorkspace("/path/that/does/not/exist"),
        title: "Short title",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow("Working directory does not exist");
  });

  it("passes caller-provided titles directly into createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-123",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Fix auth bug" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "  Fix auth bug  ",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
        title: "Fix auth bug",
      }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("trims caller-provided titles before createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-456",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Fix auth" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "  Fix auth  ",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix auth",
      }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("requires provider/model and passes thinking and labels through createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-789",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Config test", model: "claude-sonnet-4-20250514" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Config test",
      initialPrompt: "Do work",
      provider: "codex/gpt-5.4",
      settings: { modeId: "auto", thinkingOptionId: "think-hard" },
      labels: { source: "mcp" },
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
        title: "Config test",
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "think-hard",
      }),
      undefined,
      {
        labels: { source: "mcp" },
        workspaceId: "workspace-created",
      },
    );
  });

  it("auto-titles an agent-created directory workspace from the initial prompt", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-directory-auto-title-"));
    const workspaceDir = join(tempDir, "workspace");
    const workspaceRecords = new Map<string, PersistedWorkspaceRecord>();
    const broadcasts: string[] = [];
    const workspaceGitService = new WorkspaceGitServiceImpl({
      logger: createTestLogger(),
      paseoHome: join(tempDir, ".paseo"),
      deps: { github: createGitHubServiceStub() },
    });
    const workspaceAutoName = new WorkspaceAutoName({
      agentManager,
      workspaceRegistry: {
        update: async (workspaceId, updater) => {
          const current = workspaceRecords.get(workspaceId);
          if (!current) return null;
          const updated = updater(current);
          workspaceRecords.set(workspaceId, updated);
          return updated;
        },
      },
      workspaceGitService,
      providerSnapshotManager: createOpenCodeManager().manager,
      readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
      gitMutation: createGitMutationService({
        workspaceGitService,
        github: createGitHubServiceStub(),
        logger: createTestLogger(),
      }),
      emitWorkspaceUpdateForCwd: async () => {},
      emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
        broadcasts.push(workspaceId);
      },
      logger: createTestLogger(),
      generateWorkspaceName: async () => ({
        title: "Directory Workspace Title",
        branch: "directory-workspace-title",
      }),
    });

    try {
      await mkdir(workspaceDir, { recursive: true });
      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-directory-auto-title",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Directory agent" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        ensureWorkspaceForCreate: async (cwd, firstAgentContext) => {
          const workspace = createPersistedWorkspaceRecord({
            workspaceId: "workspace-directory-auto-title",
            projectId: "project-directory-auto-title",
            cwd,
            kind: "directory",
            displayName: "workspace",
            title: firstAgentContext?.prompt ?? null,
            createdAt: "2026-07-03T00:00:00.000Z",
            updatedAt: "2026-07-03T00:00:00.000Z",
          });
          workspaceRecords.set(workspace.workspaceId, workspace);
          if (firstAgentContext) {
            workspaceAutoName.scheduleForDirectory({
              workspaceId: workspace.workspaceId,
              cwd: workspace.cwd,
              firstAgentContext,
            });
          }
          return workspace.workspaceId;
        },
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        ...detachedDirectoryWorkspace(workspaceDir),
        title: "Directory agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "Name a directory workspace from the prompt",
      });
      await waitForWorkspaceTitle(
        workspaceRecords,
        "workspace-directory-auto-title",
        "Directory Workspace Title",
      );

      expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: workspaceDir,
          title: "Directory agent",
        }),
        undefined,
        { workspaceId: "workspace-directory-auto-title" },
      );
      expect(workspaceRecords.get("workspace-directory-auto-title")).toMatchObject({
        title: "Directory Workspace Title",
        branch: null,
      });
      expect(broadcasts).toEqual(["workspace-directory-auto-title"]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("creates a worktree-isolated workspace", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-create-worktree-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });
      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => repoDir),
      };

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
        }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
        >,
        logger,
      });
      const tool = registeredTool(server, "create_workspace");
      const response = await tool.handler({
        isolation: "worktree",
        path: repoDir,
        worktreeSlug: "tool-worktree",
        branchName: "feature/tool-worktree",
        baseBranch: "main",
      });

      expect(response.structuredContent.isolation).toBe("worktree");
      expect(response.structuredContent.cwd).toContain("tool-worktree");
      expect(response.structuredContent.workspaceId).toBe(broadcasts[0]);
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatch(/^wks_[0-9a-f]{16}$/);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("creates a worktree workspace from a project root without a path", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const project = createPersistedProjectRecord({
      projectId: "project-source",
      rootPath: REPO_CWD,
      kind: "git",
      displayName: "source",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    const receivedInputs: CreatePaseoWorktreeInput[] = [];
    const createPaseoWorktree: CreatePaseoWorktreeWorkflowFn = async (input) => {
      receivedInputs.push(input);
      return {
        worktree: { branchName: "project-worktree", worktreePath: TARGET_CWD },
        intent: { kind: "branch-off", branchName: "project-worktree", baseBranch: "main" },
        workspace: createPersistedWorkspaceRecord({
          workspaceId: "ws-project-source",
          projectId: project.projectId,
          cwd: TARGET_CWD,
          kind: "worktree",
          displayName: "project-worktree",
          title: input.title ?? null,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        }),
        repoRoot: REPO_CWD,
        created: true,
      };
    };
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      projectRegistry: {
        get: async (projectId) => (projectId === project.projectId ? project : null),
        list: async () => [project],
      },
      createPaseoWorktree,
      logger,
    });

    const response = await invokeToolWithParsedInput(registeredTool(server, "create_workspace"), {
      isolation: "worktree",
      projectId: project.projectId,
      worktreeSlug: "project-worktree",
      title: "Project workspace",
    });

    expect(response.structuredContent.workspaceId).toBe("ws-project-source");
    expect(receivedInputs).toEqual([
      expect.objectContaining({
        cwd: REPO_CWD,
        projectId: project.projectId,
        title: "Project workspace",
      }),
    ]);
  });

  it("preserves branch checkout and pull request checkout workspace modes", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createPaseoWorktree = vi.fn(async (input: CreatePaseoWorktreeInput) => ({
      worktree: {
        branchName: input.refName ?? "pr-42",
        worktreePath: "/tmp/worktrees/selected",
      },
      intent: {
        kind: "checkout-branch" as const,
        branchName: input.refName ?? "pr-42",
      },
      workspace: createPersistedWorkspaceRecord({
        workspaceId: "ws-selected",
        projectId: "project-1",
        cwd: "/tmp/worktrees/selected",
        kind: "worktree",
        displayName: "selected",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      }),
      repoRoot: REPO_CWD,
      created: true,
    }));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      createPaseoWorktree,
      logger,
    });
    const tool = registeredTool(server, "create_workspace");

    await invokeToolWithParsedInput(tool, {
      isolation: "worktree",
      path: REPO_CWD,
      mode: "checkout-branch",
      branch: "existing-work",
      worktreeSlug: "existing-work-copy",
    });
    await invokeToolWithParsedInput(tool, {
      isolation: "worktree",
      path: REPO_CWD,
      mode: "checkout-pr",
      prNumber: 42,
      forge: "gitlab",
    });
    await invokeToolWithParsedInput(tool, {
      isolation: "worktree",
      path: REPO_CWD,
      mode: "checkout-pr",
      prNumber: 43,
    });

    expect(createPaseoWorktree).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "checkout",
        refName: "existing-work",
        worktreeSlug: "existing-work-copy",
      }),
    );
    expect(createPaseoWorktree).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "checkout",
        checkoutSource: {
          kind: "change_request",
          forge: "gitlab",
          number: 42,
        },
      }),
    );
    expect(createPaseoWorktree).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        action: "checkout",
        checkoutSource: {
          kind: "change_request",
          number: 43,
        },
      }),
    );
  });

  it("archives a worktree-isolated workspace by workspace id", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = realpathSync.native(
      await mkdtemp(join(tmpdir(), "paseo-mcp-archive-worktree-")),
    );
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => repoDir),
      };
      const archiveWorkspaceRecord = vi.fn(async () => undefined);
      const emitWorkspaceUpdatesForWorkspaceIds = vi.fn(async () => undefined);
      const markWorkspaceArchiving = vi.fn();
      const clearWorkspaceArchiving = vi.fn();
      const listActiveWorkspaces = vi.fn(async () => []);
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts: [] }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
        >,
        findWorkspaceIdForCwd: vi.fn(async () => "ws-archive-tool-worktree"),
        listActiveWorkspaces,
        archiveWorkspaceRecord,
        emitWorkspaceUpdatesForWorkspaceIds,
        markWorkspaceArchiving,
        clearWorkspaceArchiving,
        github: createGitHubServiceStub(),
        logger,
      });
      const createTool = registeredTool(server, "create_workspace");
      const archiveTool = registeredTool(server, "archive_workspace");
      const created = await createTool.handler({
        isolation: "worktree",
        path: repoDir,
        worktreeSlug: "archive-tool-worktree",
        baseBranch: "main",
      });
      const createdWorktreePath = z.string().parse(created.structuredContent.cwd);
      listActiveWorkspaces.mockImplementation(async () => [
        { workspaceId: "ws-archive-tool-worktree", cwd: createdWorktreePath, kind: "worktree" },
      ]);
      archiveWorkspaceRecord.mockImplementation(async () => {
        listActiveWorkspaces.mockResolvedValueOnce([]);
      });
      workspaceGitService.getSnapshot.mockClear();

      await archiveTool.handler({
        workspaceId: "ws-archive-tool-worktree",
      });

      expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "archive-worktree",
      });
      expect(archiveWorkspaceRecord).toHaveBeenCalledWith("ws-archive-tool-worktree");
      expect(markWorkspaceArchiving).toHaveBeenCalledWith(
        ["ws-archive-tool-worktree"],
        expect.any(String),
      );
      expect(clearWorkspaceArchiving).toHaveBeenCalledWith(["ws-archive-tool-worktree"]);
      expect(Array.from(emitWorkspaceUpdatesForWorkspaceIds.mock.calls[0]?.[0] ?? [])).toEqual([
        "ws-archive-tool-worktree",
      ]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("rejects archiving a missing workspace", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      listActiveWorkspaces: async () => [],
      logger,
    });

    await expect(
      registeredTool(server, "archive_workspace").handler({ workspaceId: "missing-workspace" }),
    ).rejects.toThrow("Workspace not found: missing-workspace");
  });

  it("keeps an owned worktree while another workspace still references it", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = realpathSync.native(
      await mkdtemp(join(tmpdir(), "paseo-mcp-archive-worktree-multi-")),
    );
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => repoDir),
      };
      const archivedWorkspaceIds: string[] = [];
      let activeWorkspaces: Array<{
        workspaceId: string;
        cwd: string;
        kind: "worktree" | "local_checkout" | "directory";
      }> = [];
      const listActiveWorkspaces = vi.fn(async () => activeWorkspaces);
      const archiveWorkspaceRecord = createArchiveWorkspaceRecordMutator(
        activeWorkspaces,
        archivedWorkspaceIds,
      );
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts: [] }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
        >,
        findWorkspaceIdForCwd: vi.fn(async () => "ws-mcp-A"),
        listActiveWorkspaces,
        archiveWorkspaceRecord,
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => undefined),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        github: createGitHubServiceStub(),
        logger,
      });
      const createTool = registeredTool(server, "create_workspace");
      const archiveTool = registeredTool(server, "archive_workspace");
      const created = await createTool.handler({
        isolation: "worktree",
        path: repoDir,
        worktreeSlug: "archive-multi-worktree",
        baseBranch: "main",
      });
      const worktreePath = z.string().parse(created.structuredContent.cwd);

      // Populate the active workspaces with the real created path so archiveByScope
      // matches it against the worktree directory.
      activeWorkspaces = [
        { workspaceId: "ws-mcp-A", cwd: worktreePath, kind: "worktree" as const },
        { workspaceId: "ws-mcp-B", cwd: worktreePath, kind: "worktree" as const },
      ];

      await archiveTool.handler({
        workspaceId: "ws-mcp-A",
      });

      expect(archivedWorkspaceIds).toContain("ws-mcp-A");
      expect(archivedWorkspaceIds).not.toContain("ws-mcp-B");
      await expect(access(worktreePath)).resolves.toBeUndefined();
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("does not expose worktree path or slug operations", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = realpathSync.native(
      await mkdtemp(join(tmpdir(), "paseo-mcp-archive-worktree-slug-")),
    );
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => repoDir),
      };
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts: [] }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
        >,
        findWorkspaceIdForCwd: vi.fn(async () => "ws-archive-mcp"),
        listActiveWorkspaces: vi.fn(async () => []),
        archiveWorkspaceRecord: vi.fn(async () => undefined),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => undefined),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        github: createGitHubServiceStub(),
        logger,
      });
      expect(lookupTool(server, "create_worktree")).toBeUndefined();
      expect(lookupTool(server, "archive_worktree")).toBeUndefined();
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("lists active workspace descriptors", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-feature",
      projectId: "project-1",
      cwd: "/tmp/paseo/worktrees/repo/feature",
      kind: "worktree",
      displayName: "feature",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceRegistry: {
        get: vi.fn(async () => workspace),
        list: vi.fn(async () => [workspace]),
        upsert: vi.fn(async () => undefined),
      },
      logger,
    });
    const tool = registeredTool(server, "list_workspaces");

    const response = await tool.handler({});

    expect(response.structuredContent.workspaces).toEqual([
      expect.objectContaining({ workspaceId: "ws-feature", isolation: "worktree" }),
    ]);
  });

  it("creates an background local workspace and leaves it out of list_workspaces", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createCalls: Array<{ cwd: string; context: { background?: boolean } | undefined }> = [];
    const backgroundWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-background",
      projectId: "project-1",
      cwd: process.cwd(),
      kind: "directory",
      displayName: "helper",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      background: true,
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceRegistry: {
        get: vi.fn(async () => backgroundWorkspace),
        list: vi.fn(async () => [backgroundWorkspace]),
        upsert: vi.fn(async () => undefined),
      },
      createDirectoryWorkspace: async (cwd, _title, _projectId, context) => {
        createCalls.push({ cwd, context });
        return backgroundWorkspace;
      },
      logger,
    });

    const created = await invokeToolWithParsedInput(registeredTool(server, "create_workspace"), {
      isolation: "local",
      path: process.cwd(),
      background: true,
    });
    expect(created.structuredContent.workspaceId).toBe("ws-background");
    expect(createCalls).toEqual([{ cwd: process.cwd(), context: { background: true } }]);

    const listed = await registeredTool(server, "list_workspaces").handler({});
    expect(listed.structuredContent.workspaces).toEqual([]);
  });

  it("accepts custom provider IDs in create_agent input validation", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const parsed = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Custom provider agent",
      settings: { modeId: "default" },
      provider: "zai/custom-model",
      initialPrompt: "Do work",
    });

    expect(parsed.success).toBe(true);
  });

  it("allows caller agents to override cwd and applies caller context labels", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const baseDir = await mkdtemp(join(tmpdir(), "paseo-mcp-test-"));
    const subdir = join(baseDir, "subdir");
    await mkdir(subdir, { recursive: true });
    spies.agentManager.getAgent.mockReturnValue({
      id: "voice-agent",
      config: { title: "Voice" },
      cwd: baseDir,
      workspaceId: "wks_voice",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: subdir,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({ id: "voice-agent", cwd: baseDir, workspaceId: "wks_voice" }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "voice-agent",
      resolveCallerContext: () => ({
        childAgentDefaultLabels: { source: "voice" },
        allowCustomCwd: true,
      }),
      logger,
    });

    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...subagentCurrentWorkspace("subdir"),
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: subdir,
      }),
      undefined,
      {
        labels: {
          [PARENT_AGENT_ID_LABEL]: "voice-agent",
          source: "voice",
        },
        workspaceId: "wks_voice",
      },
    );
    await rm(baseDir, { recursive: true, force: true });
  });

  it("rejects background from caller agents and defaults notify-on-finish on", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: "parent-agent",
        cwd: existingCwd,
        workspaceId: "wks_parent",
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "create_agent");
    await expect(
      tool.handler({
        ...subagentCurrentWorkspace(),
        title: "Child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
        background: false,
      }),
    ).rejects.toThrow(/Unrecognized key/);

    const parsed = await tool.inputSchema.safeParseAsync({
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Expected caller create_agent input to parse");
    }
    expect(parsed.data).toMatchObject({
      relationship: { kind: "subagent" },
      workspace: { kind: "current" },
      notifyOnFinish: true,
    });
  });

  it("returns notify-on-finish guidance for caller-created agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent;
    const childAgent = {
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent;
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === "parent-agent") return parentAgent;
      if (agentId === "child-agent") return childAgent;
      return null;
    });
    spies.agentManager.createAgent.mockResolvedValue(childAgent);
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: "parent-agent",
        cwd: existingCwd,
        workspaceId: "wks_parent",
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "create_agent");
    const response = await tool.handler({
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(response.structuredContent.guidance).toBe(
      "You will get notified when the created agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.",
    );
  });

  it("notifies the caller when a created child finishes its initial turn before the turn start returns", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "mcp-create-fast-child-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const parentClient = new HeldTurnAgentClient("claude", false);
    const childClient = new HeldTurnAgentClient("codex", false, { finishTurnsDuringStart: true });
    const agentManager = new AgentManager({
      clients: { claude: parentClient, codex: childClient },
      registry: storage,
      logger,
    });

    try {
      const parent = await agentManager.createAgent(
        { provider: "claude", cwd: existingCwd },
        undefined,
        { workspaceId: "wks_parent" },
      );
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage: storage,
        callerAgentId: parent.id,
        providerSnapshotManager: createOpenCodeManager().manager,
        logger,
      });

      const response = await invokeToolWithParsedInput(registeredTool(server, "create_agent"), {
        ...subagentCurrentWorkspace(),
        title: "Fast Child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Finish immediately",
      });
      const childId = z.object({ agentId: z.string() }).parse(response.structuredContent).agentId;

      await vi.waitFor(() => {
        const parentPrompts = parentClient.sessions[0]!.prompts;
        expect(parentPrompts).toHaveLength(1);
        expect(parentPrompts[0]).toContain(childId);
        expect(parentPrompts[0]).toContain("finished");
      });
    } finally {
      await removeAgentStateDir(agentManager, storage, workdir);
    }
  });

  it("creates detached caller agents without a parent label", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "detached-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Detached" },
    } as ManagedAgent);
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: "parent-agent",
        cwd: existingCwd,
        workspaceId: "wks_parent",
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedCurrentWorkspace(),
      title: "Detached",
      provider: "codex/gpt-5.4",
      initialPrompt: "Take over",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "spoofed-parent",
        source: "handoff",
      },
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
      }),
      undefined,
      {
        labels: {
          source: "handoff",
        },
        workspaceId: "wks_parent",
      },
    );
  });

  it("accepts provider features from caller agents and passes them through createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child", featureValues: { fast_mode: true } },
    } as ManagedAgent);
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: "parent-agent",
        cwd: existingCwd,
        workspaceId: "wks_parent",
      }),
    ]);
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.resolveCreateConfig.mockImplementation(async (input) => {
      const opts = input as { featureValues: Record<string, unknown> | undefined };
      return { modeId: undefined, featureValues: opts.featureValues };
    });

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      providerSnapshotManager: providerSnapshot.manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const input = {
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
      settings: { features: { fast_mode: true } },
    };

    const parsed = await tool.inputSchema.safeParseAsync(input);
    expect(parsed.success).toBe(true);

    await tool.handler(input);

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.4",
        featureValues: { fast_mode: true },
      }),
      undefined,
      {
        labels: {
          [PARENT_AGENT_ID_LABEL]: "parent-agent",
        },
        workspaceId: "wks_parent",
      },
    );
  });

  it("inherits provider options only when the child uses the caller provider", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: null,
      config: {
        providerOptions: {
          sandbox_mode: "workspace-write",
          sandbox_workspace_write: { writable_roots: ["/tmp/shared"] },
        },
      },
    } as ManagedAgent;
    spies.agentManager.getAgent.mockReturnValue(parentAgent);
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: parentAgent.id,
        cwd: parentAgent.cwd,
        workspaceId: parentAgent.workspaceId,
      }),
    ]);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    await registeredTool(server, "create_agent").handler({
      ...subagentCurrentWorkspace(),
      title: "Codex child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });
    expect(spies.agentManager.createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerOptions: parentAgent.config.providerOptions }),
      undefined,
      expect.any(Object),
    );

    await registeredTool(server, "create_agent").handler({
      ...subagentCurrentWorkspace(),
      title: "Claude child",
      provider: "claude/sonnet",
      initialPrompt: "Do work",
      settings: { modeId: "default" },
    });
    expect(spies.agentManager.createAgent).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ providerOptions: expect.anything() }),
      undefined,
      expect.any(Object),
    );
  });

  it("inherits the parent's workspaceId when an MCP child is created in the parent's working tree", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "mcp-workspace-inherit-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const agentManager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      logger,
    });

    try {
      const parent = await agentManager.createAgent(
        { provider: "codex", cwd: existingCwd },
        undefined,
        { workspaceId: "wks_parent" },
      );

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage: storage,
        callerAgentId: parent.id,
        providerSnapshotManager: createOpenCodeManager().manager,
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      const result = await tool.handler({
        ...subagentCurrentWorkspace(),
        title: "Child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      });

      const childId = z.object({ agentId: z.string() }).parse(result.structuredContent).agentId;
      const storedChild = await storage.get(childId);
      expect(storedChild?.workspaceId).toBe("wks_parent");
      expect(storedChild?.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
    } finally {
      await removeAgentStateDir(agentManager, storage, workdir);
    }
  });

  it("delivers a local child's finish to its parent once, through the durable watch only", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "mcp-local-finish-route-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const agentManager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      logger,
    });
    const registration = { accept: vi.fn(), reject: vi.fn(async () => undefined) };
    const finishSubscriptions = {
      start: vi.fn(async () => undefined),
      register: vi.fn(async () => registration),
      close: vi.fn(async () => undefined),
    };
    const runs = vi.spyOn(agentManager, "startAuthorizedAgentStream");

    try {
      const parent = await agentManager.createAgent(
        { provider: "codex", cwd: existingCwd },
        undefined,
        { workspaceId: "wks_parent" },
      );
      const child = await agentManager.createAgent(
        { provider: "codex", cwd: existingCwd },
        undefined,
        { workspaceId: "wks_parent", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
      );
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage: storage,
        callerAgentId: parent.id,
        finishSubscriptions: () => finishSubscriptions,
        providerSnapshotManager: createOpenCodeManager().manager,
        logger,
      });

      await registeredTool(server, "send_agent_prompt").handler({
        agentId: child.id,
        prompt: "Do the bounded task",
      });

      const parentRuns = () => runs.mock.calls.filter((call) => call[0] === parent.id);
      const expectOneParentRun = () => expect(parentRuns()).toHaveLength(1);
      const expectParentIdle = () =>
        expect(agentManager.getAgent(parent.id)?.lifecycle).toBe("idle");
      await vi.waitFor(expectOneParentRun, { timeout: 10_000 });
      await vi.waitFor(expectParentIdle, { timeout: 10_000 });
      expect(parentRuns()).toHaveLength(1);
      expect(JSON.stringify(parentRuns()[0]?.[1])).toContain(child.id);
      expect(finishSubscriptions.register).not.toHaveBeenCalled();
    } finally {
      await removeAgentStateDir(agentManager, storage, workdir);
    }
  });

  it("routes a remote child's finish to finish subscriptions without a local durable watch", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "mcp-remote-finish-route-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const agentManager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      logger,
    });
    const registration = { accept: vi.fn(), reject: vi.fn(async () => undefined) };
    const finishSubscriptions = {
      start: vi.fn(async () => undefined),
      register: vi.fn(async () => registration),
      close: vi.fn(async () => undefined),
    };
    const remoteUse = vi.fn(async () => ({
      content: [],
      structuredContent: { success: true, status: "running" },
    }));
    const runs = vi.spyOn(agentManager, "startAuthorizedAgentStream");

    try {
      const parent = await agentManager.createAgent(
        { provider: "codex", cwd: existingCwd },
        undefined,
        { workspaceId: "wks_parent" },
      );
      // The same id exists locally, so a misrouted local watch would be observable here.
      const child = await agentManager.createAgent(
        { provider: "codex", cwd: existingCwd },
        undefined,
        { workspaceId: "wks_parent", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
      );
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage: storage,
        callerAgentId: parent.id,
        serverId: "srv_local",
        hosts: () => ({ directory: vi.fn(), use: remoteUse }) as never,
        finishSubscriptions: () => finishSubscriptions as never,
        providerSnapshotManager: createOpenCodeManager().manager,
        logger,
      });

      await registeredTool(server, "send_agent_prompt").handler({
        serverId: "srv_remote",
        agentId: child.id,
        prompt: "Do the remote task",
      });

      expect(remoteUse).toHaveBeenCalledTimes(1);
      expect(finishSubscriptions.register).toHaveBeenCalledWith(
        { childAgentId: child.id, callerAgentId: parent.id, serverId: "srv_remote" },
        true,
      );
      expect(registration.accept).toHaveBeenCalledTimes(1);
      expect(runs.mock.calls.filter((call) => call[0] === child.id)).toHaveLength(0);
      expect((await storage.get(child.id))?.finishNotificationWatches ?? []).toEqual([]);
    } finally {
      await removeAgentStateDir(agentManager, storage, workdir);
    }
  });

  it("delegates MCP injection to AgentManager and passes through an undefined agent ID", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-injected-123",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Injected config test" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Injected config test",
      settings: { modeId: "auto" },
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    const [configArg, agentIdArg, optionsArg] = spies.agentManager.createAgent.mock.calls[0];
    expect(configArg).toMatchObject({
      cwd: existingCwd,
      title: "Injected config test",
    });
    expect(configArg.mcpServers).toBeUndefined();
    expect(agentIdArg).toBeUndefined();
    expect(optionsArg).toEqual({
      workspaceId: "workspace-created",
    });
  });

  it("rejects an explicit mode that is not valid for the target provider", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.resolveCreateConfig.mockImplementation(async () => {
      throw new Error("resolver rejected mode");
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: providerSnapshot.manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        ...detachedDirectoryWorkspace(existingCwd),
        title: "Bad mode",
        provider: "opencode/gpt-5.4",
        settings: { modeId: "bypassPermissions" },
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow("resolver rejected mode");
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("validates create_agent modes against the shared provider snapshot", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "dynamic",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: "parent-agent",
        cwd: existingCwd,
        workspaceId: "wks_parent",
      }),
    ]);
    const dynamicModes: AgentMode[] = [
      { id: "dynamic", label: "Dynamic", description: "Runtime mode" },
    ];
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.listProviders.mockResolvedValue([
      buildSnapshotEntry({ provider: "codex", label: "Codex", modes: dynamicModes }),
    ]);
    provStub.getProvider.mockImplementation(async ({ provider }: { provider: AgentProvider }) =>
      buildSnapshotEntry({ provider, label: "Codex", modes: dynamicModes }),
    );
    provStub.listModes.mockResolvedValue(dynamicModes);
    provStub.resolveCreateConfig.mockImplementation(async (input) => {
      const opts = input as { requestedMode: string | undefined };
      expect(opts.requestedMode).toBe("dynamic");
      return { modeId: "dynamic", featureValues: undefined };
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Dynamic mode",
      provider: "codex/gpt-5.4",
      settings: { modeId: "dynamic" },
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "dynamic" }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("passes resolver-returned mode and features into createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: { title: "Child", featureValues: { auto_accept: true } },
    } as ManagedAgent);
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.resolveCreateConfig.mockResolvedValue({
      modeId: "build",
      featureValues: { auto_accept: true },
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: providerSnapshot.manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Legacy mode",
      provider: "opencode/gpt-5.4",
      settings: { modeId: "full-access" },
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "build", featureValues: { auto_accept: true } }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("passes the real parent agent and explicit unattended intent to the resolver", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent;
    spies.agentManager.getAgent.mockReturnValue(parentAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "resolver-mode",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: "parent-agent",
        cwd: existingCwd,
        workspaceId: "wks_parent",
      }),
    ]);
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.resolveCreateConfig.mockResolvedValue({
      modeId: "resolver-mode",
      featureValues: { resolver_feature: true },
    });

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      providerSnapshotManager: providerSnapshot.manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "claude/claude-sonnet-4-20250514",
      initialPrompt: "Do work",
    });

    expect(providerSnapshot.stub.resolveCreateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ parent: parentAgent, unattended: false }),
    );
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modeId: "resolver-mode",
        featureValues: { resolver_feature: true },
      }),
      undefined,
      expect.any(Object),
    );
  });

  it("accepts an explicit valid mode across providers", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);
    mockStoredAgentRecordsWithCreatedChildren(spies, [
      createActiveStoredRecord({
        id: "parent-agent",
        cwd: existingCwd,
        workspaceId: "wks_parent",
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "opencode/gpt-5.4",
      settings: { modeId: "build" },
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "build" }),
      undefined,
      expect.any(Object),
    );
  });
});

const HELD_TURN_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

interface HeldTurnOptions {
  finishDuringSteer?: boolean;
  rejectSteer?: boolean;
  steerResult?: "accepted" | "unavailable";
  /** Run the whole turn before the turn-start request returns. */
  finishTurnsDuringStart?: boolean;
}

/**
 * Provider session that records every prompt it receives. With `holdTurns`, a started
 * turn stays running until `finishTurn()` so a caller's bounded wait can run out first.
 */
class HeldTurnAgentSession implements AgentSession {
  readonly capabilities = HELD_TURN_CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  readonly steeredPrompts: AgentPromptInput[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly permissions = new Map<string, AgentPermissionRequest>();
  private activeTurnId: string | null = null;
  private turnStartGate: Promise<void> | null = null;
  private nextStartError: Error | null = null;

  constructor(
    readonly provider: AgentProvider,
    private readonly holdTurns: boolean,
    private readonly options: HeldTurnOptions = {},
  ) {}

  /** Hold the next turn's acknowledgment, as a provider awaiting its turn-start request does. */
  holdTurnStart(): () => void {
    let release!: () => void;
    this.turnStartGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  rejectNextTurnStart(error: Error): void {
    this.nextStartError = error;
  }

  tryHandleOutOfBand(prompt: AgentPromptInput) {
    return prompt === "/side-command" ? { run: async () => {} } : null;
  }

  async steerActiveTurn(prompt: AgentPromptInput) {
    const status = this.options.steerResult ?? "unavailable";
    if (status === "accepted") this.steeredPrompts.push(prompt);
    if (status === "accepted" && this.options.finishDuringSteer) this.finishTurn();
    if (this.options.rejectSteer) throw new Error("Steer rejected");
    return { status };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    await this.turnStartGate;
    if (this.nextStartError) {
      const error = this.nextStartError;
      this.nextStartError = null;
      throw error;
    }
    const turnId = randomUUID();
    if (this.options.finishTurnsDuringStart) {
      // The whole turn runs before the turn-start request returns, as a provider whose
      // start acknowledgment arrives together with the turn's completion does.
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      return { turnId };
    }
    this.activeTurnId = turnId;
    this.pushEvent({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: {
        type: "user_message",
        text: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
        messageId: randomUUID(),
      },
    });
    setTimeout(() => {
      if (this.activeTurnId !== turnId) return;
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      if (!this.holdTurns && this.activeTurnId === turnId) {
        this.finishTurn();
      }
    }, 0);
    return { turnId };
  }

  finishTurn(finalText?: string): void {
    const turnId = this.activeTurnId;
    if (!turnId) {
      throw new Error("No held turn to finish");
    }
    this.activeTurnId = null;
    if (finalText)
      this.pushEvent({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: finalText },
      });
    this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
  }

  failTurn(error: string): void {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("No held turn to fail");
    this.activeTurnId = null;
    this.pushEvent({ type: "turn_failed", provider: this.provider, error, turnId });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  requestPermission(id: string): void {
    const request: AgentPermissionRequest = {
      id,
      name: "Write",
      kind: "tool",
      input: { path: id },
    };
    this.permissions.set(id, request);
    this.pushEvent({ type: "permission_requested", provider: this.provider, request });
  }

  getPendingPermissions() {
    return [...this.permissions.values()];
  }

  async respondToPermission(requestId: string): Promise<void> {
    this.permissions.delete(requestId);
    this.pushEvent({ type: "permission_resolved", provider: this.provider, requestId });
  }

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId;
    if (!turnId) {
      return;
    }
    this.activeTurnId = null;
    this.pushEvent({
      type: "turn_canceled",
      provider: this.provider,
      reason: "interrupted",
      turnId,
    });
  }

  async close(): Promise<void> {}
}

class HeldTurnAgentClient implements AgentClient {
  readonly capabilities = HELD_TURN_CAPABILITIES;
  readonly sessions: HeldTurnAgentSession[] = [];

  constructor(
    readonly provider: AgentProvider,
    private readonly holdTurns: boolean,
    private readonly options: HeldTurnOptions = {},
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new HeldTurnAgentSession(this.provider, this.holdTurns, this.options);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

describe("send_agent_prompt MCP tool", () => {
  it.each([
    { agentScoped: true, behavior: undefined, available: true, steered: true },
    { agentScoped: true, behavior: "interrupt", available: true, steered: false },
    { agentScoped: true, behavior: "steer", available: true, steered: true },
    { agentScoped: false, behavior: undefined, available: true, steered: false },
    { agentScoped: false, behavior: "steer", available: true, steered: true },
    { agentScoped: true, behavior: undefined, available: false, steered: false },
  ] as const)(
    "dispatches behavior $behavior for agent-scoped=$agentScoped, steering available=$available",
    async ({ agentScoped, behavior, available, steered }) => {
      const workdir = await mkdtemp(join(tmpdir(), "mcp-send-behavior-"));
      const storage = new AgentStorage(join(workdir, "agents"), logger);
      const client = new HeldTurnAgentClient("codex", true, {
        steerResult: available ? "accepted" : "unavailable",
      });
      const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
      try {
        const parent = await manager.createAgent(
          { provider: "codex", cwd: existingCwd },
          undefined,
          { workspaceId: "wks_parent" },
        );
        const child = await manager.createAgent(
          { provider: "codex", cwd: existingCwd },
          undefined,
          { workspaceId: "wks_parent" },
        );
        const server = await createAgentMcpServer({
          agentManager: manager,
          agentStorage: storage,
          callerAgentId: agentScoped ? parent.id : undefined,
          providerSnapshotManager: createOpenCodeManager().manager,
          logger,
        });
        const tool = registeredTool(server, "send_agent_prompt");
        // Top-level sends block until the turn ends by default; held turns never end here.
        await invokeToolWithParsedInput(tool, {
          agentId: child.id,
          prompt: "Original work",
          notifyOnFinish: false,
          background: true,
        });
        const originalTurn = manager.getAgent(child.id)!.activeTurnId;
        const response = await invokeToolWithParsedInput(tool, {
          agentId: child.id,
          prompt: "New message",
          notifyOnFinish: false,
          background: true,
          ...(behavior ? { activeTurnBehavior: behavior } : {}),
        });
        expect(response.structuredContent).toMatchObject({
          success: true,
          disposition: steered ? "steered" : "turn_started",
        });
        expect(client.sessions[1]!.prompts).toHaveLength(steered ? 1 : 2);
        expect(client.sessions[1]!.steeredPrompts).toHaveLength(steered ? 1 : 0);
        expect(manager.getAgent(child.id)!.activeTurnId === originalTurn).toBe(steered);
      } finally {
        await removeAgentStateDir(manager, storage, workdir);
      }
    },
  );

  const logger = createTestLogger();
  const existingCwd = process.cwd();

  it("allows a role-bound Lead to prompt its own direct child", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    const child = createManagedAgent({
      id: "peer-child",
      cwd: existingCwd,
      workspaceId: "wks_lead",
      labels: { [PARENT_AGENT_ID_LABEL]: caller.id },
      roleBinding: createTestRoleBinding("peer"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === caller.id) return caller;
      if (agentId === child.id) return child;
      return null;
    });
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
      createActiveStoredRecord({
        id: child.id,
        cwd: child.cwd,
        workspaceId: child.workspaceId,
        labels: child.labels,
        roleBinding: child.roleBinding,
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: caller.id,
      logger,
    });

    await invokeToolWithParsedInput(registeredTool(server, "send_agent_prompt"), {
      agentId: child.id,
      prompt: "Continue bounded work",
    });

    expectAgentMessageStreamed(spies.agentManager.streamAgent, {
      targetId: child.id,
      senderId: caller.id,
      text: "Continue bounded work",
    });
    expect(spies.agentManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it("allows a delegation-bound Supervisor to prompt its own direct Lead", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "supervisor-agent",
      cwd: existingCwd,
      workspaceId: "wks_control",
      roleBinding: createTestRoleBinding("supervisor", "delegation"),
    });
    const child = createManagedAgent({
      id: "lead-child",
      cwd: existingCwd,
      workspaceId: "wks_project",
      labels: { [PARENT_AGENT_ID_LABEL]: caller.id },
      roleBinding: createTestRoleBinding("lead"),
    });
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
      createActiveStoredRecord({
        id: child.id,
        cwd: child.cwd,
        workspaceId: child.workspaceId,
        labels: child.labels,
        roleBinding: child.roleBinding,
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: caller.id,
      logger,
    });

    await invokeToolWithParsedInput(registeredTool(server, "send_agent_prompt"), {
      agentId: child.id,
      prompt: "Report project status and blockers",
    });

    expectAgentMessageStreamed(spies.agentManager.streamAgent, {
      targetId: child.id,
      senderId: caller.id,
      text: "Report project status and blockers",
    });
  });

  it.each([
    { callerRole: "peer" as const, targetParentId: "peer-agent" },
    { callerRole: "supervisor" as const, targetParentId: "supervisor-agent" },
    { callerRole: "lead" as const, targetParentId: "different-lead" },
  ])(
    "rejects role-bound $callerRole send_agent_prompt before partial mutation",
    async ({ callerRole, targetParentId }) => {
      const { agentManager, agentStorage, spies } = createTestDeps();
      const caller = createManagedAgent({
        id: `${callerRole}-agent`,
        cwd: existingCwd,
        workspaceId: "wks_bound",
        roleBinding: createTestRoleBinding(callerRole),
      });
      const target = createManagedAgent({
        id: "target-agent",
        cwd: existingCwd,
        workspaceId: "wks_bound",
        labels: { [PARENT_AGENT_ID_LABEL]: targetParentId },
      });
      spies.agentManager.getAgent.mockImplementation((agentId: string) => {
        if (agentId === caller.id) return caller;
        if (agentId === target.id) return target;
        return null;
      });
      mockStoredAgentRecords(spies.agentStorage.get, [
        createActiveStoredRecord({
          id: caller.id,
          cwd: caller.cwd,
          workspaceId: caller.workspaceId,
          roleBinding: caller.roleBinding,
        }),
        createStoredRecord({
          id: target.id,
          cwd: target.cwd,
          workspaceId: target.workspaceId,
          labels: target.labels,
          archivedAt: "2026-08-09T00:00:00.000Z",
        }),
      ]);
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        callerAgentId: caller.id,
        logger,
      });

      await expect(
        invokeToolWithParsedInput(registeredTool(server, "send_agent_prompt"), {
          agentId: target.id,
          prompt: "Must not be delivered",
          sessionMode: "full-access",
        }),
      ).rejects.toThrow(expectedPromptTopologyError(callerRole));

      expect(spies.agentManager.unarchiveSnapshot).not.toHaveBeenCalled();
      expect(spies.agentManager.notifyAgentState).not.toHaveBeenCalled();
      expect(spies.agentManager.resumeAgentFromPersistence).not.toHaveBeenCalled();
      expect(spies.agentManager.setAgentMode).not.toHaveBeenCalled();
      expect(spies.agentManager.tryRunOutOfBand).not.toHaveBeenCalled();
      expect(spies.agentManager.replaceAgentRun).not.toHaveBeenCalled();
      expect(spies.agentManager.streamAgent).not.toHaveBeenCalled();
      expect(spies.agentManager.subscribe).not.toHaveBeenCalled();
      expect(spies.agentStorage.setTitle).not.toHaveBeenCalled();
      expect(spies.agentStorage.upsert).not.toHaveBeenCalled();
      expect(spies.agentStorage.applySnapshot).not.toHaveBeenCalled();
      expect(spies.agentStorage.remove).not.toHaveBeenCalled();
    },
  );

  it("preserves legacy unbound agent-scoped prompt behavior", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "legacy-agent",
      cwd: existingCwd,
      workspaceId: "wks_legacy",
    });
    const target = createManagedAgent({
      id: "unrelated-agent",
      cwd: existingCwd,
      workspaceId: "wks_other",
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === caller.id) return caller;
      if (agentId === target.id) return target;
      return null;
    });
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({ id: caller.id, cwd: caller.cwd }),
      createActiveStoredRecord({ id: target.id, cwd: target.cwd }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: caller.id,
      logger,
    });

    await invokeToolWithParsedInput(registeredTool(server, "send_agent_prompt"), {
      agentId: target.id,
      prompt: "Legacy follow-up",
      notifyOnFinish: false,
    });

    expectAgentMessageStreamed(spies.agentManager.streamAgent, {
      targetId: target.id,
      senderId: caller.id,
      text: "Legacy follow-up",
    });
  });

  it("rejects a role-bound Lead prompt when durable target data is unavailable", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      cwd: existingCwd,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    const target = createManagedAgent({ id: "missing-target", cwd: existingCwd });
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === caller.id) return caller;
      if (agentId === target.id) return target;
      return null;
    });
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: caller.id,
      logger,
    });

    await expect(
      invokeToolWithParsedInput(registeredTool(server, "send_agent_prompt"), {
        agentId: target.id,
        prompt: "Must not be delivered",
        sessionMode: "full-access",
      }),
    ).rejects.toThrow("Target agent missing-target is unavailable in durable storage");

    expect(spies.agentManager.unarchiveSnapshot).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentMode).not.toHaveBeenCalled();
    expect(spies.agentManager.resumeAgentFromPersistence).not.toHaveBeenCalled();
    expect(spies.agentManager.streamAgent).not.toHaveBeenCalled();
    expect(spies.agentManager.subscribe).not.toHaveBeenCalled();
    expect(spies.agentStorage.setTitle).not.toHaveBeenCalled();
    expect(spies.agentStorage.upsert).not.toHaveBeenCalled();
    expect(spies.agentStorage.applySnapshot).not.toHaveBeenCalled();
    expect(spies.agentStorage.remove).not.toHaveBeenCalled();
  });

  it("defaults agent-scoped prompts to background finish notifications", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent;
    const childAgent = {
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "running",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent;
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === "parent-agent") return parentAgent;
      if (agentId === "child-agent") return childAgent;
      return null;
    });
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: parentAgent.id,
        cwd: parentAgent.cwd,
        workspaceId: parentAgent.workspaceId,
      }),
      createActiveStoredRecord({ id: childAgent.id, cwd: childAgent.cwd }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "send_agent_prompt");
    const parsed = await tool.inputSchema.safeParseAsync({
      agentId: "child-agent",
      prompt: "Follow up",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Expected caller send_agent_prompt input to parse");
    }
    expect(parsed.data).toMatchObject({
      background: true,
      notifyOnFinish: true,
    });

    const response = await tool.handler(parsed.data as Record<string, unknown>);

    expect(spies.agentManager.subscribe).toHaveBeenCalledTimes(1);
    expect(spies.agentManager.waitForAgentEvent).not.toHaveBeenCalled();
    expect(response.structuredContent.guidance).toBe(
      "You will get notified when the prompted agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.",
    );
  });

  it("keeps top-level prompts blocking by default", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });

    const tool = registeredTool(server, "send_agent_prompt");
    const parsed = await tool.inputSchema.safeParseAsync({
      agentId: "child-agent",
      prompt: "Follow up",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Expected top-level send_agent_prompt input to parse");
    }
    expect(parsed.data).toMatchObject({
      background: false,
      notifyOnFinish: false,
    });

    await tool.handler(parsed.data as Record<string, unknown>);

    expect(spies.agentManager.subscribe).not.toHaveBeenCalled();
    expect(spies.agentManager.waitForAgentEvent).toHaveBeenCalledWith(
      "child-agent",
      expect.objectContaining({ waitForActive: true }),
    );
  });

  it("does not arm a finish notification for blocking agent-scoped prompts", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent;
    const childAgent = {
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent;
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === "parent-agent") return parentAgent;
      if (agentId === "child-agent") return childAgent;
      return null;
    });
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: parentAgent.id,
        cwd: parentAgent.cwd,
        workspaceId: parentAgent.workspaceId,
      }),
      createActiveStoredRecord({ id: childAgent.id, cwd: childAgent.cwd }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "send_agent_prompt");
    await invokeToolWithParsedInput(tool, {
      agentId: "child-agent",
      prompt: "Follow up",
      background: false,
    });

    expect(spies.agentManager.subscribe).not.toHaveBeenCalled();
    expect(spies.agentManager.waitForAgentEvent).toHaveBeenCalledWith(
      "child-agent",
      expect.objectContaining({ waitForActive: true }),
    );
  });

  it("allows agent-scoped callers to opt out of finish notifications", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      config: {},
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent;
    const childAgent = {
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent;
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === "parent-agent") return parentAgent;
      if (agentId === "child-agent") return childAgent;
      return null;
    });
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: parentAgent.id,
        cwd: parentAgent.cwd,
        workspaceId: parentAgent.workspaceId,
      }),
      createActiveStoredRecord({ id: childAgent.id, cwd: childAgent.cwd }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "send_agent_prompt");
    await invokeToolWithParsedInput(tool, {
      agentId: "child-agent",
      prompt: "Follow up",
      notifyOnFinish: false,
    });

    expect(spies.agentManager.subscribe).not.toHaveBeenCalled();
    expect(spies.agentManager.waitForAgentEvent).not.toHaveBeenCalled();
  });
});

describe("send_agent_prompt MCP tool to an OMP child", () => {
  const logger = createTestLogger();
  const existingCwd = process.cwd();

  async function setupOmpChild() {
    const workdir = await mkdtemp(join(tmpdir(), "mcp-omp-child-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const parentClient = new HeldTurnAgentClient("claude", false);
    const omp = new FakeOmp();
    const agentManager = new AgentManager({
      clients: {
        claude: parentClient,
        omp: new OmpAgentClient({
          logger,
          runtime: omp,
          noTurnScheduler: { waitForSettle: async () => {} },
          runtimeSettings: { command: { mode: "replace", argv: [process.execPath] } },
        }),
      },
      registry: storage,
      logger,
    });
    const parent = await agentManager.createAgent(
      { provider: "claude", cwd: existingCwd },
      undefined,
      { workspaceId: "wks_parent" },
    );
    const child = await agentManager.createAgent(
      { provider: "omp", cwd: existingCwd, title: "OMP child" },
      undefined,
      { workspaceId: "wks_parent" },
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage: storage,
      callerAgentId: parent.id,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    return {
      agentManager,
      storage,
      workdir,
      parentClient,
      ompSession: omp.latestSession(),
      childId: child.id,
      tool: registeredTool(server, "send_agent_prompt"),
    };
  }

  async function expectOneFinishNotification(
    agentManager: AgentManager,
    parentClient: HeldTurnAgentClient,
    childId: string,
  ) {
    await vi.waitFor(() => expect(agentManager.getAgent(childId)?.lifecycle).toBe("idle"));
    await vi.waitFor(() => {
      expect(parentClient.sessions[0]!.prompts).toHaveLength(1);
      expect(parentClient.sessions[0]!.prompts[0]).toContain(
        `Agent ${childId} (OMP child) finished.`,
      );
    });
  }

  // Known gap: an OMP slash command dispatches out_of_band, and the fork's send path cancels the
  // durable finish watch for out_of_band dispatches, so the parent is never notified. Remove
  // `.fails` once the watch follows out_of_band runs that the provider starts itself.
  it.fails.each([
    { command: "follow-up", streamingBehavior: "followUp" },
    { command: "steer", streamingBehavior: "steer" },
  ] as const)(
    "delivers /$command into a turn OMP started on its own, without aborting it",
    async ({ command, streamingBehavior }) => {
      const { agentManager, storage, workdir, parentClient, ompSession, childId, tool } =
        await setupOmpChild();
      try {
        ompSession.beginTurn();
        ompSession.streamAssistantText("background job finished, working on it");
        await vi.waitFor(() => {
          expect(agentManager.getAgent(childId)?.activeTurnId).toMatch(/^autonomous-/);
        });

        const response = await invokeToolWithParsedInput(tool, {
          agentId: childId,
          prompt: `/${command} then summarize the logs`,
        });

        expect(response.structuredContent).toMatchObject({
          success: true,
          status: "running",
        });
        await vi.waitFor(() => {
          expect(ompSession.prompts).toEqual([
            { message: "then summarize the logs", imageCount: 0, streamingBehavior },
          ]);
        });
        expect(ompSession.abortRequested).toBe(false);
        expect(agentManager.getAgent(childId)?.lifecycle).toBe("running");

        ompSession.finishTurn();
        await expectOneFinishNotification(agentManager, parentClient, childId);
      } finally {
        await removeAgentStateDir(agentManager, storage, workdir);
      }
    },
  );

  // Known gap: an OMP slash command dispatches out_of_band, and the fork's send path cancels the
  // durable finish watch for out_of_band dispatches, so the parent is never notified. Remove
  // `.fails` once the watch follows out_of_band runs that the provider starts itself.
  it.fails.each(["before ack", "after ack"])(
    "reports an idle follow-up rejected %s and notifies its parent",
    async (order) => {
      const { agentManager, storage, workdir, parentClient, ompSession, childId, tool } =
        await setupOmpChild();
      try {
        ompSession.promptAck = { requestId: "follow-up-rejected" };
        const rejection = {
          type: "prompt_result",
          id: "follow-up-rejected",
          agentInvoked: false,
          status: "error",
          sessionSettled: true,
          error: { message: "Provider rejected the follow-up", retryable: false },
        } as const;
        const promptStarted = ompSession.nextPrompt();
        const response = invokeToolWithParsedInput(tool, {
          agentId: childId,
          prompt: "/follow-up check the build",
        });
        await promptStarted;
        if (order === "before ack") ompSession.emit(rejection);
        await response;
        if (order === "after ack") ompSession.emit(rejection);
        await vi.waitFor(() => expect(agentManager.getAgent(childId)?.lifecycle).toBe("error"));
        expect(agentManager.getAgent(childId)?.lastError).toContain(
          "Provider rejected the follow-up",
        );
        await vi.waitFor(() => expect(parentClient.sessions[0]!.prompts).toHaveLength(1));
        expect(parentClient.sessions[0]!.prompts[0]).toContain(
          `Agent ${childId} (OMP child) errored.`,
        );
      } finally {
        await removeAgentStateDir(agentManager, storage, workdir);
      }
    },
  );

  // Known gap: an OMP slash command dispatches out_of_band, and the fork's send path cancels the
  // durable finish watch for out_of_band dispatches, so the parent is never notified. Remove
  // `.fails` once the watch follows out_of_band runs that the provider starts itself.
  it.fails("lets an idle child start a run with the follow-up", async () => {
    const { agentManager, storage, workdir, parentClient, ompSession, childId, tool } =
      await setupOmpChild();
    try {
      const response = await invokeToolWithParsedInput(tool, {
        agentId: childId,
        prompt: "/follow-up check the build",
      });

      expect(response.structuredContent).toMatchObject({
        success: true,
      });
      await vi.waitFor(() => {
        expect(ompSession.prompts).toEqual([
          { message: "check the build", imageCount: 0, streamingBehavior: "followUp" },
        ]);
      });

      ompSession.beginTurn();
      ompSession.streamAssistantText("Build is green");
      await vi.waitFor(() => expect(agentManager.getAgent(childId)?.lifecycle).toBe("running"));
      ompSession.finishTurn();
      await expectOneFinishNotification(agentManager, parentClient, childId);
    } finally {
      await removeAgentStateDir(agentManager, storage, workdir);
    }
  });
});

describe("update_agent MCP tool", () => {
  const logger = createTestLogger();

  it("does not register the replaced feature-specific MCP tool", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });

    expect(lookupTool(server, "set_agent_feature")).toBeUndefined();
  });

  it("updates runtime settings before metadata", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "update_agent");
    const input = {
      agentId: "agent-1",
      name: "Updated agent",
      labels: { role: "worker" },
      settings: {
        modeId: "full-access",
        model: "gpt-5.4",
        thinkingOptionId: "high",
        features: { fast_mode: true },
      },
    };

    const parsed = await tool.inputSchema.safeParseAsync(input);
    expect(parsed.success).toBe(true);

    const response = await tool.handler(input);

    expect(spies.agentManager.setAgentMode).toHaveBeenCalledWith("agent-1", "full-access");
    expect(spies.agentManager.setAgentModel).toHaveBeenCalledWith("agent-1", "gpt-5.4");
    expect(spies.agentManager.setAgentThinkingOption).toHaveBeenCalledWith("agent-1", "high");
    expect(spies.agentManager.setAgentFeature).toHaveBeenCalledWith("agent-1", "fast_mode", true);
    expect(spies.agentManager.updateAgentMetadata).toHaveBeenCalledWith("agent-1", {
      title: "Updated agent",
      labels: { role: "worker" },
    });
    expect(response.structuredContent).toEqual({ success: true });
  });

  it("reports success for a no-op update with neither metadata nor settings", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "update_agent");

    const response = await tool.handler({ agentId: "agent-1" });

    expect(response.structuredContent).toEqual({ success: true });
    expect(spies.agentManager.updateAgentMetadata).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentMode).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentModel).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentThinkingOption).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentFeature).not.toHaveBeenCalled();
  });

  it("does not update metadata when runtime settings fail", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.setAgentFeature.mockRejectedValue(new Error("unsupported feature"));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "update_agent");

    await expect(
      tool.handler({
        agentId: "agent-1",
        name: "Should not persist",
        labels: { role: "worker" },
        settings: { features: { fast_mode: true } },
      }),
    ).rejects.toThrow("unsupported feature");

    expect(spies.agentStorage.get).not.toHaveBeenCalled();
    expect(spies.agentManager.updateAgentMetadata).not.toHaveBeenCalled();
  });
});

describe("rename_workspace MCP tool", () => {
  const logger = createTestLogger();

  it("renames the caller workspace when workspaceId is omitted", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_parent",
      projectId: "proj_parent",
      cwd: REPO_CWD,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T09:00:00.000Z",
    });
    const workspaces = new Map([[workspace.workspaceId, workspace]]);
    const upsertedWorkspaces: PersistedWorkspaceRecord[] = [];
    const emittedWorkspaceIds: string[][] = [];
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "parent-agent",
        cwd: REPO_CWD,
        workspaceId: workspace.workspaceId,
      }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceRegistry: {
        get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
        upsert: async (record) => {
          upsertedWorkspaces.push(record);
          workspaces.set(record.workspaceId, record);
        },
      },
      emitWorkspaceUpdatesForWorkspaceIds: async (workspaceIds) => {
        emittedWorkspaceIds.push(Array.from(workspaceIds));
      },
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "rename_workspace");

    const response = await invokeToolWithParsedInput(tool, {
      title: "  Payments flow  ",
    });

    expect(upsertedWorkspaces).toEqual([
      {
        ...workspace,
        title: "Payments flow",
        updatedAt: expect.any(String),
      },
    ]);
    expect(response.structuredContent).toEqual({
      success: true,
      workspaceId: "wks_parent",
      title: "Payments flow",
    });
    expect(emittedWorkspaceIds).toEqual([["wks_parent"]]);
  });

  it("renames an explicit workspace outside the caller workspace", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_parent",
      projectId: "proj_parent",
      cwd: REPO_CWD,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T09:00:00.000Z",
    });
    const otherWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_other",
      projectId: "proj_other",
      cwd: TARGET_CWD,
      kind: "local_checkout",
      displayName: "other",
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T09:00:00.000Z",
    });
    const workspaces = new Map([
      [parentWorkspace.workspaceId, parentWorkspace],
      [otherWorkspace.workspaceId, otherWorkspace],
    ]);
    const upsertedWorkspaces: PersistedWorkspaceRecord[] = [];
    const emittedWorkspaceIds: string[][] = [];
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "parent-agent",
        cwd: REPO_CWD,
        workspaceId: parentWorkspace.workspaceId,
      }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceRegistry: {
        get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
        upsert: async (record) => {
          upsertedWorkspaces.push(record);
          workspaces.set(record.workspaceId, record);
        },
      },
      emitWorkspaceUpdatesForWorkspaceIds: async (workspaceIds) => {
        emittedWorkspaceIds.push(Array.from(workspaceIds));
      },
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "rename_workspace");

    const response = await invokeToolWithParsedInput(tool, {
      workspaceId: "wks_other",
      title: "Payments flow",
    });

    expect(upsertedWorkspaces).toEqual([
      {
        ...otherWorkspace,
        title: "Payments flow",
        updatedAt: expect.any(String),
      },
    ]);
    expect(response.structuredContent).toEqual({
      success: true,
      workspaceId: "wks_other",
      title: "Payments flow",
    });
    expect(emittedWorkspaceIds).toEqual([["wks_other"]]);
  });

  it("rejects archived workspaces", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_archived",
      projectId: "proj_parent",
      cwd: REPO_CWD,
      kind: "local_checkout",
      displayName: "main",
      archivedAt: "2026-07-03T10:00:00.000Z",
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T10:00:00.000Z",
    });
    const workspaces = new Map([[workspace.workspaceId, workspace]]);
    const upsertedWorkspaces: PersistedWorkspaceRecord[] = [];
    const emittedWorkspaceIds: string[][] = [];
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "parent-agent",
        cwd: REPO_CWD,
        workspaceId: workspace.workspaceId,
      }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceRegistry: {
        get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
        upsert: async (record) => {
          upsertedWorkspaces.push(record);
          workspaces.set(record.workspaceId, record);
        },
      },
      emitWorkspaceUpdatesForWorkspaceIds: async (workspaceIds) => {
        emittedWorkspaceIds.push(Array.from(workspaceIds));
      },
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "rename_workspace");

    await expect(
      invokeToolWithParsedInput(tool, {
        title: "Payments flow",
      }),
    ).rejects.toThrow("Workspace wks_archived is archived");
    expect(upsertedWorkspaces).toEqual([]);
    expect(emittedWorkspaceIds).toEqual([]);
  });
});

describe("create_schedule MCP tool", () => {
  const logger = createTestLogger();

  it("requires provider for schedules", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) =>
      createStoredSchedule(input),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await expect(
      tool.handler({
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Default schedule",
      }),
    ).rejects.toThrow("provider");
    expect(createOrReplace).not.toHaveBeenCalled();
  });

  it("keeps provider forms compatible without materializing default schedule isolation", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) =>
      createStoredSchedule(input),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await tool.handler({
      prompt: "say hello",
      cron: "*/5 * * * *",
      provider: "codex",
    });
    await tool.handler({
      prompt: "say hello again",
      cron: "*/10 * * * *",
      provider: "codex/gpt-5.4",
    });
    await tool.handler({
      prompt: "say hello in a worktree",
      cron: "*/15 * * * *",
      provider: "codex",
      isolation: "worktree",
    });

    expect(createOrReplace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: {
          type: "new-agent",
          config: {
            provider: "codex",
            cwd: process.cwd(),
          },
        },
      }),
    );
    expect(createOrReplace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          type: "new-agent",
          config: {
            provider: "codex",
            cwd: process.cwd(),
            model: "gpt-5.4",
          },
        },
      }),
    );
    expect(createOrReplace).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        target: {
          type: "new-agent",
          config: {
            provider: "codex",
            cwd: process.cwd(),
            isolation: "worktree",
          },
        },
      }),
    );
  });

  it("inherits the caller provider, model, and features when provider is omitted", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      provider: "opencode",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: {
        title: "Parent agent",
        model: "openai/gpt-5.5",
        featureValues: { auto_accept: true },
      },
    } as ManagedAgent);
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) =>
      createStoredSchedule(input),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    const response = await tool.handler({
      prompt: "say hello",
      cron: "*/5 * * * *",
    });

    expect(response.structuredContent.target).toEqual({
      type: "new-agent",
      config: {
        provider: "opencode",
        cwd: REPO_CWD,
        modeId: "build",
        model: "openai/gpt-5.5",
        featureValues: { auto_accept: true },
      },
    });
  });

  it("passes timezone through cron create_schedule input", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn(async (scheduleInput: CreateScheduleInput) =>
      createStoredSchedule(scheduleInput),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await invokeToolWithParsedInput(tool, {
      prompt: "say hello",
      cron: "0 9 * * 1-5",
      timezone: "  America/New_York  ",
      provider: "codex",
    });

    expect(createOrReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        cadence: {
          type: "cron",
          expression: "0 9 * * 1-5",
          timezone: "America/New_York",
        },
      }),
    );
  });

  it("rejects removed create_schedule every input", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    const parsed = await tool.inputSchema.safeParseAsync({
      prompt: "say hello",
      every: "10m",
      provider: "codex",
    });
    expect(parsed.success).toBe(false);

    expect(createOrReplace).not.toHaveBeenCalled();
  });

  it("rejects create_schedule without cron", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await expect(
      tool.handler({
        prompt: "say hello",
        provider: "codex",
      }),
    ).rejects.toThrow(/cron/);

    expect(createOrReplace).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("rejects create_schedule blank timezone %#", async (timezone) => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await expect(
      invokeToolWithParsedInput(tool, {
        prompt: "say hello",
        cron: "0 9 * * 1-5",
        timezone,
        provider: "codex",
      }),
    ).rejects.toThrow();

    expect(createOrReplace).not.toHaveBeenCalled();
  });
});

describe("create_heartbeat MCP tool", () => {
  const logger = createTestLogger();

  it("creates a self-targeted cron heartbeat", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      provider: "codex",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: { title: "Parent agent" },
    } as ManagedAgent);
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) =>
      createStoredSchedule(input),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_heartbeat");

    await invokeToolWithParsedInput(tool, {
      prompt: "check status",
      cron: "*/15 * * * *",
      timezone: "America/New_York",
      name: "status heartbeat",
    });

    expect(createOrReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "check status",
        cadence: {
          type: "cron",
          expression: "*/15 * * * *",
          timezone: "America/New_York",
        },
        target: { type: "agent", agentId: "parent-agent" },
        name: "status heartbeat",
      }),
    );
  });

  it("requires an agent-scoped session", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_heartbeat");

    await expect(
      tool.handler({
        prompt: "check status",
        cron: "*/15 * * * *",
      }),
    ).rejects.toThrow("create_heartbeat requires an agent-scoped session");

    expect(createOrReplace).not.toHaveBeenCalled();
  });
});

describe("heartbeat ownership MCP tools", () => {
  const logger = createTestLogger();

  it("deletes the caller's heartbeat", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const heartbeat = createStoredSchedule({
      prompt: "check status",
      cadence: { type: "cron", expression: "*/15 * * * *" },
      target: { type: "agent", agentId: "parent-agent" },
    });
    const inspect = vi.fn(async () => heartbeat);
    const deleteSchedule = vi.fn(async () => undefined);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: {
        inspect,
        delete: deleteSchedule,
      } as unknown as ScheduleService,
      callerAgentId: "parent-agent",
      logger,
    });

    await registeredTool(server, "delete_heartbeat").handler({ id: heartbeat.id });

    expect(deleteSchedule).toHaveBeenCalledWith(heartbeat.id);
  });

  it("rejects another agent's heartbeat", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const foreignHeartbeat = createStoredSchedule({
      prompt: "foreign",
      cadence: { type: "cron", expression: "0 * * * *" },
      target: { type: "agent", agentId: "other-agent" },
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: {
        inspect: vi.fn(async () => foreignHeartbeat),
        delete: vi.fn(),
      } as unknown as ScheduleService,
      callerAgentId: "parent-agent",
      logger,
    });

    await expect(
      registeredTool(server, "delete_heartbeat").handler({ id: foreignHeartbeat.id }),
    ).rejects.toThrow("does not belong to caller");
  });
});

describe("update_schedule MCP tool", () => {
  const logger = createTestLogger();

  function makeStoredSchedule(): StoredSchedule {
    return {
      id: "schedule-1",
      name: "test schedule",
      prompt: "say hello",
      cadence: { type: "every", everyMs: 300000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp" } },
      status: "active",
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      nextRunAt: "2026-04-11T00:05:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    };
  }

  function scheduleServiceWithUpdate(
    update: (input: UpdateScheduleInput) => Promise<StoredSchedule>,
    stored = makeStoredSchedule(),
  ): ScheduleService {
    return {
      update,
      inspect: vi.fn(async () => stored),
    } as unknown as ScheduleService;
  }

  it("calls scheduleService.update with correct input", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => ({
      ...stored,
      name: "updated name",
      prompt: "new prompt",
      updatedAt: "2026-04-11T01:00:00.000Z",
    }));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update, stored),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await tool.handler({
      id: "schedule-1",
      name: "updated name",
      prompt: "new prompt",
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      name: "updated name",
      prompt: "new prompt",
    });
  });

  it("converts every to cadence", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update, stored),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await tool.handler({
      id: "schedule-1",
      every: "10m",
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      cadence: { type: "cron", expression: "*/10 * * * *" },
    });
  });

  it("passes timezone through cron update_schedule input", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update, stored),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await invokeToolWithParsedInput(tool, {
      id: "schedule-1",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Zurich",
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      cadence: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Zurich",
      },
    });
  });

  it("accepts a blank cron field when updating every cadence", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update, stored),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await invokeToolWithParsedInput(tool, {
      id: "schedule-1",
      every: "10m",
      cron: "",
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      cadence: { type: "cron", expression: "*/10 * * * *" },
    });
  });

  it.each([
    {
      label: "whitespace cron field",
      input: { id: "schedule-1", every: "10m", cron: "   " },
      cadence: { type: "cron", expression: "*/10 * * * *" },
    },
    {
      label: "blank every field for cron cadence",
      input: { id: "schedule-1", every: "", cron: "*/10 * * * *" },
      cadence: { type: "cron", expression: "*/10 * * * *" },
    },
    {
      label: "whitespace every field for cron cadence",
      input: { id: "schedule-1", every: "   ", cron: "*/10 * * * *" },
      cadence: { type: "cron", expression: "*/10 * * * *" },
    },
  ])("normalizes update_schedule blank cadence input for $label", async ({ input, cadence }) => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update, stored),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await invokeToolWithParsedInput(tool, input);

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      cadence,
    });
  });

  it("rejects both every and cron", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const update = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await expect(
      tool.handler({
        id: "schedule-1",
        every: "5m",
        cron: "* * * * *",
      }),
    ).rejects.toThrow("Specify at most one of every or cron");
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects update_schedule timezone without cron", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const update = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await expect(
      invokeToolWithParsedInput(tool, {
        id: "schedule-1",
        every: "10m",
        timezone: "Europe/Zurich",
      }),
    ).rejects.toThrow("timezone can only be used with cron");

    expect(update).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("rejects update_schedule blank timezone %#", async (timezone) => {
    const { agentManager, agentStorage } = createTestDeps();
    const update = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await expect(
      invokeToolWithParsedInput(tool, {
        id: "schedule-1",
        cron: "0 9 * * 1-5",
        timezone,
      }),
    ).rejects.toThrow();

    expect(update).not.toHaveBeenCalled();
  });

  it("passes new-agent config and expiry updates", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update, stored),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await tool.handler({
      id: "schedule-1",
      provider: "codex/gpt-5.4",
      mode: "full-access",
      cwd: "/home/user/project",
      expiresIn: "1h",
    });

    const updateInput = update.mock.calls[0]?.[0];
    expect(updateInput).toMatchObject({
      id: "schedule-1",
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5.4",
        modeId: "full-access",
        cwd: "/home/user/project",
      },
    });
    expect(updateInput?.expiresAt).toEqual(expect.any(String));
  });

  it("clears model, mode, max runs, and expiry", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update, stored),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await tool.handler({
      id: "schedule-1",
      model: null,
      mode: null,
      maxRuns: null,
      clearExpires: true,
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      maxRuns: null,
      expiresAt: null,
      newAgentConfig: {
        model: null,
        modeId: null,
      },
    });
  });

  it("rejects conflicting model and expiry inputs", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const update = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: scheduleServiceWithUpdate(update),
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await expect(
      tool.handler({
        id: "schedule-1",
        provider: "codex/gpt-5.4",
        model: "gpt-5.5",
      }),
    ).rejects.toThrow("Conflicting model values provided");
    await expect(
      tool.handler({
        id: "schedule-1",
        expiresIn: "1h",
        clearExpires: true,
      }),
    ).rejects.toThrow("Specify at most one of expiresIn or clearExpires");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("schedule_logs MCP tool", () => {
  const logger = createTestLogger();

  function makeRun(overrides: Partial<{ id: string; status: string }> = {}) {
    return {
      id: overrides.id ?? "run-1",
      scheduledFor: "2026-04-11T00:00:00.000Z",
      startedAt: "2026-04-11T00:00:01.000Z",
      endedAt: "2026-04-11T00:00:05.000Z",
      status: overrides.status ?? "succeeded",
      agentId: null,
      output: "done",
      error: null,
    };
  }

  it("returns runs for a schedule", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const runs = [makeRun({ id: "run-1" }), makeRun({ id: "run-2", status: "failed" })];
    const logs = vi.fn(async (_id: string) => runs);
    const inspect = vi.fn(async () => ({
      id: "schedule-1",
      target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp" } },
    }));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { logs, inspect } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "schedule_logs");

    const result = await tool.handler({ id: "schedule-1" });

    expect(logs).toHaveBeenCalledWith("schedule-1");
    expect(result.structuredContent).toEqual({ runs });
  });

  it("throws when schedule service is not configured", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "schedule_logs");

    await expect(tool.handler({ id: "schedule-1" })).rejects.toThrow(
      "Schedule service is not configured",
    );
  });
});

describe("provider listing MCP tool", () => {
  const logger = createTestLogger();

  it("returns providers from the registry, including custom providers", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["claude", "zai"]);
    provStub.listProviders.mockResolvedValue([
      buildSnapshotEntry({
        provider: "claude",
        label: "Claude",
        description: "Test provider",
        modes: [{ id: "default", label: "Default", description: "Built-in mode" }],
      }),
      buildSnapshotEntry({
        provider: "zai" as AgentProvider,
        label: "ZAI",
        description: "Custom Claude profile",
        defaultModeId: "default",
        modes: [{ id: "default", label: "Default", description: "Custom mode" }],
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "list_providers");
    const response = await tool.handler({});
    const modelVisibleText = String(response.content[0]?.text);

    expect(response.structuredContent).toEqual({
      providers: [
        {
          id: "claude",
          label: "Claude",
          description: "Test provider",
          enabled: true,
          status: "available",
          modes: [{ id: "default", label: "Default", description: "Built-in mode" }],
        },
        {
          id: "zai",
          label: "ZAI",
          status: "available",
          description: "Custom Claude profile",
          enabled: true,
          modes: [{ id: "default", label: "Default", description: "Custom mode" }],
        },
      ],
    });
    expect(modelVisibleText).toContain("providers_count=2");
    expect(modelVisibleText).toContain("providers_ids=claude,zai");
    expect(modelVisibleText).toContain('"providers"');
  });

  it("returns provider modes from the shared snapshot catalog", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.listProviders.mockResolvedValue([
      buildSnapshotEntry({
        provider: "codex",
        label: "Codex",
        modes: [{ id: "dynamic", label: "Dynamic", description: "Runtime mode" }],
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "list_providers");

    const response = await tool.handler({});

    expect(response.structuredContent.providers).toEqual([
      expect.objectContaining({
        id: "codex",
        modes: [{ id: "dynamic", label: "Dynamic", description: "Runtime mode" }],
      }),
    ]);
  });

  it("returns disabled providers with metadata without checking availability", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.listProviders.mockResolvedValue([
      buildSnapshotEntry({
        provider: "codex",
        label: "Codex",
        description: "OpenAI coding agent",
        enabled: false,
        modes: [{ id: "read-only", label: "Read Only", description: "No edits" }],
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "list_providers");
    const response = await tool.handler({});

    expect(response.structuredContent).toEqual({
      providers: [
        {
          id: "codex",
          label: "Codex",
          description: "OpenAI coding agent",
          enabled: false,
          status: "unavailable",
          modes: [],
        },
      ],
    });
  });
});

function daemonConfigStoreStub(agentProfiles?: AgentProfile[]): Pick<DaemonConfigStore, "get"> {
  const config = MutableDaemonConfigSchema.parse({
    relay: { enabled: true },
    mcp: { injectIntoAgents: true },
    ...(agentProfiles !== undefined ? { agentProfiles } : {}),
  });
  return { get: () => config };
}

describe("agent profile listing MCP tool", () => {
  const logger = createTestLogger();

  it("returns configured profiles, including notes", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const profiles: AgentProfile[] = [
      {
        id: "ui-profile",
        name: "UI work",
        provider: "claude",
        model: "claude-test-model",
        modeId: "bypassPermissions",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
        notes: "Use for UI work: components, layout, design tokens. Not for backend.",
        peerSubrole: "engineer",
      },
    ];
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: daemonConfigStoreStub(profiles),
      logger,
    });
    const tool = registeredTool(server, "list_profiles");

    expect(tool.description).toContain("create_agent.launchProfileId");
    expect(tool.description).toContain("peerSubrole");
    expect(tool.description).toContain("defaultSubrole");
    expect(tool.description).toContain("routing guidance only");

    const response = await tool.handler({});

    expect(response.structuredContent).toEqual({ profiles });
  });

  it("returns only Human-approved Peer profiles to a role-bound Lead", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      cwd: REPO_CWD,
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    mockStoredAgentRecords(spies.agentStorage.get, [
      createActiveStoredRecord({
        id: caller.id,
        cwd: caller.cwd,
        workspaceId: caller.workspaceId,
        roleBinding: caller.roleBinding,
      }),
    ]);
    const scout: AgentProfile = {
      id: "peer-scout",
      name: "Peer Scout",
      provider: "codex",
      model: "gpt-5.6-luna",
      notes: "Use for bounded reconnaissance.",
      peerSubrole: "scout",
    };
    const reviewer: AgentProfile = {
      id: "peer-reviewer",
      name: "Peer Reviewer",
      provider: "codex",
      model: "gpt-5.4",
      peerSubrole: "reviewer",
    };
    const architect: AgentProfile = {
      id: "peer-architect-claude",
      name: "Peer Architect — Claude",
      provider: "claude",
      model: "claude-opus-4-1",
      peerSubrole: "architect",
    };
    const engineer: AgentProfile = {
      id: "peer-engineer-cursor",
      name: "Peer Engineer — Cursor",
      provider: "cursor",
      model: "composer-1.5",
      peerSubrole: "engineer",
    };
    const config = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: true },
      peerDelegation: {
        enabled: true,
        allowedModels: [{ provider: "codex", model: "gpt-5.6-luna" }],
        runMode: "unattended",
      },
      peerDelegationProfileIds: [scout.id, architect.id, reviewer.id, engineer.id],
      peerDelegationProviderPriority: ["claude", "codex", "cursor"],
      peerDelegationDefaultSubrole: "engineer",
      agentProfiles: [scout, reviewer, architect, engineer],
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: { get: () => config },
      callerAgentId: caller.id,
      logger,
    });

    const response = await registeredTool(server, "list_profiles").handler({});

    expect(response.structuredContent).toEqual({
      defaultSubrole: "engineer",
      providerPriority: ["claude", "codex", "cursor"],
      profiles: [architect, scout, reviewer, engineer],
    });
  });

  it("returns an empty array when no profiles are configured", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      daemonConfigStore: daemonConfigStoreStub(),
      logger,
    });
    const tool = registeredTool(server, "list_profiles");

    const response = await tool.handler({});

    expect(response.structuredContent).toEqual({ profiles: [] });
  });

  it("returns an empty array when no daemon config store is provided", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "list_profiles");

    const response = await tool.handler({});

    expect(response.structuredContent).toEqual({ profiles: [] });
  });
});

describe("provider MCP tools", () => {
  const logger = createTestLogger();

  it("does not register the replaced feature-specific provider discovery MCP tool", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });

    expect(lookupTool(server, "list_provider_features")).toBeUndefined();
  });

  it("inspects provider features for a draft agent configuration", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.listDraftFeatures.mockResolvedValue([
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast mode",
        value: false,
      },
    ]);
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    const codexEntry = buildSnapshotEntry({
      provider: "codex",
      label: "Codex",
      description: "OpenAI coding agent",
      modes: [{ id: "full-access", label: "Full Access", description: "Can edit files" }],
    });
    provStub.listProviders.mockResolvedValue([codexEntry]);
    provStub.getProvider.mockResolvedValue(codexEntry);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "inspect_provider");
    const input = {
      provider: "codex/gpt-5.4",
      cwd: "~/repo",
      settings: {
        modeId: "full-access",
        thinkingOptionId: "high",
        features: { fast_mode: true },
      },
    };

    const parsed = await tool.inputSchema.safeParseAsync(input);
    expect(parsed.success).toBe(true);

    const response = await tool.handler(input);

    expect(spies.agentManager.listDraftFeatures).toHaveBeenCalledWith({
      provider: "codex",
      cwd: expect.stringContaining("repo"),
      modeId: "full-access",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    });
    expect(response.structuredContent).toEqual({
      provider: "codex",
      label: "Codex",
      description: "OpenAI coding agent",
      enabled: true,
      status: "available",
      modes: [{ id: "full-access", label: "Full Access", description: "Can edit files" }],
      selectedModel: "gpt-5.4",
      features: [
        {
          type: "toggle",
          id: "fast_mode",
          label: "Fast mode",
          value: false,
        },
      ],
    });
  });

  it("offers a Lead only plugin Peer routes whose provider declares the role launch hook", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const caller = createManagedAgent({
      id: "lead-agent",
      workspaceId: "wks_lead",
      roleBinding: createTestRoleBinding("lead"),
    });
    spies.agentManager.getAgent.mockImplementation((agentId: string) =>
      agentId === caller.id ? caller : null,
    );
    const pluginRoleSupport = {
      status: "supported",
      injectionMethod: "plugin-role-launch-hook",
      roleIds: ["peer"],
    } as const;
    spies.agentManager.getProviderRoleBindingSupport.mockImplementation((provider: string) =>
      provider === "plugin-declared" ? pluginRoleSupport : undefined,
    );
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["plugin-declared", "plugin-plain"]);
    provStub.listModels.mockImplementation(async ({ provider }) => [
      { provider, id: "free-model", label: "Free model" },
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      daemonConfigStore: {
        get: () =>
          MutableDaemonConfigSchema.parse({
            mcp: { injectIntoAgents: true },
            peerDelegation: {
              enabled: true,
              runMode: "unattended",
              allowedModels: [
                { provider: "plugin-declared", model: "free-model" },
                { provider: "plugin-plain", model: "free-model" },
              ],
            },
          }),
      },
      callerAgentId: caller.id,
      logger,
    });
    const tool = registeredTool(server, "list_models");

    const declared = await tool.handler({ provider: "plugin-declared" });
    const plain = await tool.handler({ provider: "plugin-plain" });

    expect(declared.structuredContent.models.map((model: { id: string }) => model.id)).toEqual([
      "free-model",
    ]);
    expect(plain.structuredContent.models).toEqual([]);
  });

  it("rejects disabled providers without fetching models", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.listModels.mockRejectedValue(new Error("Provider 'codex' is disabled"));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "list_models");

    await expect(tool.handler({ provider: "codex" })).rejects.toThrow(
      "Provider 'codex' is disabled",
    );
  });

  it("inspect_provider rejects disabled providers without fetching models", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.getProvider.mockResolvedValue(
      buildSnapshotEntry({ provider: "codex", label: "Codex", enabled: false }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "inspect_provider");

    await expect(tool.handler({ provider: "codex", cwd: "~/repo" })).rejects.toThrow(
      "Provider 'codex' is disabled",
    );
  });
});

describe("speak MCP tool", () => {
  const logger = createTestLogger();

  it("invokes registered speak handler for caller agent", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const speak = vi.fn().mockResolvedValue(undefined);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "voice-agent-1",
      enableVoiceTools: true,
      resolveSpeakHandler: () => speak,
      logger,
    });
    const tool = registeredTool(server, "speak");
    expect(tool).toBeDefined();

    await tool.handler({ text: "Hello from voice agent." });
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello from voice agent.",
        callerAgentId: "voice-agent-1",
      }),
    );
  });

  it("fails when no speak handler exists", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "voice-agent-2",
      enableVoiceTools: true,
      resolveSpeakHandler: () => null,
      logger,
    });
    const tool = registeredTool(server, "speak");
    await expect(tool.handler({ text: "Hello." })).rejects.toThrow(
      "No speak handler registered for your session",
    );
  });

  it("does not register speak tool unless voice tools are enabled", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "agent-no-voice",
      logger,
    });
    const tool = lookupTool(server, "speak");
    expect(tool).toBeUndefined();
  });
});

describe("agent snapshot MCP serialization", () => {
  const logger = createTestLogger();

  it("records exact authoritative Paseo MCP receipts for Cursor callers", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({ id: "cursor-caller", provider: "cursor" }),
    );
    spies.agentManager.listAgents.mockReturnValue([]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "cursor-caller",
      logger,
    });
    const response = await registeredTool(server, "list_agents").handler({ cwd: REPO_CWD });

    expect(response.structuredContent).toEqual({ agents: [] });
    expect(spies.agentManager.appendTimelineItem).toHaveBeenCalledTimes(2);
    const [runningAgentId, running] = spies.agentManager.appendTimelineItem.mock.calls[0]!;
    const [completedAgentId, completed] = spies.agentManager.appendTimelineItem.mock.calls[1]!;
    expect(runningAgentId).toBe("cursor-caller");
    expect(completedAgentId).toBe("cursor-caller");
    expect(running).toMatchObject({
      type: "tool_call",
      name: "mcp__paseo__list_agents",
      status: "running",
      detail: { type: "unknown", input: { cwd: REPO_CWD }, output: null },
      metadata: {
        source: "paseo-mcp-server",
        authoritativeToolName: "list_agents",
      },
    });
    expect(completed).toMatchObject({
      type: "tool_call",
      callId: running.callId,
      name: "mcp__paseo__list_agents",
      status: "completed",
      detail: { type: "unknown", input: { cwd: REPO_CWD }, output: { agents: [] } },
    });
  });

  it("does not duplicate native provider MCP receipts", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({ id: "claude-caller", provider: "claude" }),
    );
    spies.agentManager.listAgents.mockReturnValue([]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "claude-caller",
      logger,
    });
    await registeredTool(server, "list_agents").handler({});

    expect(spies.agentManager.appendTimelineItem).not.toHaveBeenCalled();
  });

  it("returns compact list items from list_agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.listAgents = vi.fn().mockReturnValue([
      createManagedAgent({
        id: "agent-compact",
        provider: "codex",
        cwd: REPO_CWD,
        config: { model: "gpt-5.4", thinkingOptionId: "high" },
        runtimeInfo: { provider: "codex", sessionId: "session-123", model: "gpt-5.4" },
        labels: { role: "researcher" },
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});
    const structured = z
      .object({ agents: z.array(z.record(z.string(), z.unknown())) })
      .parse(response.structuredContent);

    expect(structured).toEqual({
      agents: [
        {
          id: "agent-compact",
          shortId: "agent-c",
          title: null,
          provider: "codex",
          model: "gpt-5.4",
          thinkingOptionId: "high",
          effectiveThinkingOptionId: "high",
          status: "idle",
          cwd: REPO_CWD,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          lastUserMessageAt: null,
          archivedAt: null,
          requiresAttention: false,
          attentionReason: null,
          attentionTimestamp: null,
          labels: { role: "researcher" },
        },
      ],
    });
    expect(structured.agents[0]).not.toHaveProperty("features");
    expect(structured.agents[0]).not.toHaveProperty("availableModes");
    expect(structured.agents[0]).not.toHaveProperty("capabilities");
    expect(structured.agents[0]).not.toHaveProperty("runtimeInfo");
    expect(structured.agents[0]).not.toHaveProperty("persistence");
    expect(structured.agents[0]).not.toHaveProperty("pendingPermissions");
  });

  it("returns archived agent snapshots from storage for get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const record = createStoredRecord({
      id: "archived-agent",
      archivedAt: "2026-04-12T00:00:00.000Z",
    });
    spies.agentManager.getAgent.mockReturnValue(null);
    spies.agentStorage.get.mockResolvedValue(record);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_status");
    const response = await tool.handler({ agentId: "archived-agent" });

    expect(response.structuredContent).toEqual({
      status: "closed",
      snapshot: expect.objectContaining({
        id: "archived-agent",
        archivedAt: "2026-04-12T00:00:00.000Z",
        title: "Stored agent",
        status: "closed",
      }),
    });
    expect(spies.agentStorage.get).toHaveBeenCalledWith("archived-agent");
  });

  it("returns full-detail snapshots from get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentStorage.get.mockResolvedValue({ title: "Full detail agent" });
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "full-detail-agent",
        provider: "codex",
        cwd: "/tmp/full-detail",
        config: { model: "gpt-5.4", thinkingOptionId: "high" },
        runtimeInfo: {
          provider: "codex",
          sessionId: "session-full",
          model: "gpt-5.4",
          thinkingOptionId: "xhigh",
          modeId: "auto",
        },
        currentModeId: "auto",
        availableModes: [
          {
            id: "auto",
            label: "Auto",
            description: "Default coding mode",
          },
        ],
        features: [
          {
            type: "toggle",
            id: "web-search",
            label: "Web search",
            value: true,
          },
        ],
        pendingPermissions: new Map(),
        persistence: {
          provider: "codex",
          sessionId: "session-full",
        },
        capabilities: {
          supportsStreaming: false,
          supportsSessionPersistence: false,
          supportsSessionListing: true,
          supportsDynamicModes: false,
          supportsMcpServers: true,
          supportsReasoningStream: false,
          supportsToolInvocations: true,
          supportsNewProviderCapability: true,
        },
      }),
    );

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "get_agent_status");
    const response = await tool.handler({ agentId: "full-detail-agent" });
    const snapshot = z.record(z.string(), z.unknown()).parse(response.structuredContent.snapshot);

    const parsed = AgentSnapshotPayloadSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new Error(
        `get_agent_status response failed AgentSnapshotPayloadSchema: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
    expect(response.structuredContent.status).toBe("idle");
    expect(snapshot).toEqual(
      expect.objectContaining({
        id: "full-detail-agent",
        title: "Full detail agent",
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "high",
        effectiveThinkingOptionId: "xhigh",
        currentModeId: "auto",
        runtimeInfo: {
          provider: "codex",
          sessionId: "session-full",
          model: "gpt-5.4",
          thinkingOptionId: "xhigh",
          modeId: "auto",
        },
        persistence: {
          provider: "codex",
          sessionId: "session-full",
        },
      }),
    );
    expect(snapshot.capabilities).toEqual(
      expect.objectContaining({
        supportsMcpServers: true,
        supportsToolInvocations: true,
      }),
    );
    expect(snapshot.availableModes).toEqual([
      {
        id: "auto",
        label: "Auto",
        description: "Default coding mode",
      },
    ]);
    expect(snapshot.features).toEqual([
      {
        type: "toggle",
        id: "web-search",
        label: "Web search",
        value: true,
      },
    ]);
    expect(snapshot.pendingPermissions).toEqual([]);
  });

  it("returns a live internal agent from get_agent_status by exact id", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "internal-loop-worker",
        internal: true,
        workspaceId: "workspace-loop",
      }),
    );

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_status");
    const response = await tool.handler({ agentId: "internal-loop-worker" });

    expect(response.structuredContent).toEqual({
      status: "idle",
      snapshot: expect.objectContaining({
        id: "internal-loop-worker",
        workspaceId: "workspace-loop",
      }),
    });
    expect(spies.agentManager.getAgent).toHaveBeenCalledWith("internal-loop-worker");
  });

  it("does not expose internal stored agents from get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue(null);
    spies.agentStorage.get.mockResolvedValue(
      createStoredRecord({
        id: "internal-agent",
        internal: true,
      }),
    );

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_status");

    await expect(tool.handler({ agentId: "internal-agent" })).rejects.toThrow(
      "Agent internal-agent not found",
    );
  });

  it("defaults list_agents to caller cwd and excludes archived agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({ id: "caller-agent", cwd: "/tmp/workspace" }),
    );
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({ id: "in-cwd", cwd: "/tmp/workspace" }),
      createManagedAgent({ id: "in-child-cwd", cwd: "/tmp/workspace/packages/server" }),
      createManagedAgent({ id: "other-cwd", cwd: "/tmp/other" }),
    ]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-in-cwd",
        cwd: "/tmp/workspace",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
      }),
      createStoredRecord({
        id: "archived-in-cwd",
        cwd: "/tmp/workspace",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: now,
      }),
      createStoredRecord({ id: "internal-agent", archivedAt: null, internal: true }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
      callerAgentId: "caller-agent",
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});

    const agentIds = agentsOf(response).map((agent) => agent.id);
    expect(agentIds).toHaveLength(3);
    expect(new Set(agentIds)).toEqual(new Set(["in-cwd", "in-child-cwd", "stored-in-cwd"]));
  });

  it("allows explicit cwd, status, archive, time, and limit filters for list_agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    const recent = new Date(now - 60 * 60 * 1000).toISOString();
    const old = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "running-target",
        cwd: TARGET_CWD,
        lifecycle: "running",
        updatedAt: new Date(recent),
      }),
      createManagedAgent({
        id: "idle-target",
        cwd: TARGET_CWD,
        lifecycle: "idle",
        updatedAt: new Date(recent),
      }),
      createManagedAgent({
        id: "old-running-target",
        cwd: TARGET_CWD,
        lifecycle: "running",
        createdAt: new Date(old),
        updatedAt: new Date(old),
      }),
    ]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({ id: "recent-archived", cwd: TARGET_CWD, archivedAt: recent }),
      createStoredRecord({ id: "old-archived", cwd: TARGET_CWD, archivedAt: old }),
      createStoredRecord({
        id: "recent-other-cwd",
        cwd: resolvePath("/tmp/other"),
        archivedAt: recent,
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({
      cwd: TARGET_CWD,
      includeArchived: true,
      sinceHours: 48,
      statuses: ["running", "closed"],
      limit: 3,
    });

    expect(agentsOf(response).map((agent) => agent.id)).toEqual([
      "running-target",
      "old-running-target",
      "recent-archived",
    ]);
  });

  it("bounds includeArchived by default time window and limit", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    const recentArchivedRecords = Array.from({ length: 55 }, (_, index) =>
      createStoredRecord({
        id: `recent-archived-${index.toString().padStart(2, "0")}`,
        archivedAt: new Date(now - index * 60 * 1000).toISOString(),
      }),
    );
    spies.agentStorage.list.mockResolvedValue([
      ...recentArchivedRecords,
      createStoredRecord({
        id: "old-archived",
        archivedAt: new Date(now - 49 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ includeArchived: true });
    const agentIds = agentsOf(response).map((agent) => agent.id);

    expect(agentIds).toHaveLength(50);
    expect(agentIds).toEqual(
      Array.from(
        { length: 50 },
        (_, index) => `recent-archived-${index.toString().padStart(2, "0")}`,
      ),
    );
    expect(agentIds).not.toContain("old-archived");
  });

  it("returns compact list items for stored archived agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-archived-compact",
        cwd: REPO_CWD,
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: now,
        features: [
          {
            type: "toggle",
            id: "danger-zone",
            label: "Danger zone",
            value: false,
          },
        ],
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ cwd: REPO_CWD, includeArchived: true });
    const item = agentsOf(response)[0];

    expect(item).toEqual({
      id: "stored-archived-compact",
      shortId: "stored-",
      title: "Stored agent",
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      status: "closed",
      cwd: REPO_CWD,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: now,
      lastUserMessageAt: null,
      archivedAt: now,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      labels: {},
    });
    expect(item).not.toHaveProperty("features");
    expect(item).not.toHaveProperty("availableModes");
    expect(item).not.toHaveProperty("capabilities");
    expect(item).not.toHaveProperty("runtimeInfo");
    expect(item).not.toHaveProperty("persistence");
    expect(item).not.toHaveProperty("pendingPermissions");
  });

  it("sorts list_agents by attention, status priority, then activity", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "idle-recent",
        lifecycle: "idle",
        updatedAt: new Date(now),
      }),
      createManagedAgent({
        id: "running-older",
        lifecycle: "running",
        updatedAt: new Date(now - 60 * 60 * 1000),
      }),
      createManagedAgent({
        id: "closed-newest",
        lifecycle: "closed",
        updatedAt: new Date(now + 60 * 1000),
      }),
      createManagedAgent({
        id: "initializing-middle",
        lifecycle: "initializing",
        updatedAt: new Date(now - 30 * 60 * 1000),
      }),
      createManagedAgent({
        id: "idle-attention-oldest",
        lifecycle: "idle",
        updatedAt: new Date(now - 2 * 60 * 60 * 1000),
        attention: {
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date(now - 2 * 60 * 60 * 1000),
        },
      }),
      createManagedAgent({
        id: "error-recent",
        lifecycle: "error",
        updatedAt: new Date(now),
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});

    expect(agentsOf(response).map((agent) => agent.id)).toEqual([
      "idle-attention-oldest",
      "running-older",
      "initializing-middle",
      "idle-recent",
      "error-recent",
      "closed-newest",
    ]);
  });

  it("emits list_agents payloads that satisfy the agent list schema", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentManager.listAgents.mockReturnValue([createManagedAgent()]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-non-archived",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
      }),
      createStoredRecord({ id: "stored-archived", archivedAt: now }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ includeArchived: true });

    const parsed = z.array(AgentListItemPayloadSchema).safeParse(response.structuredContent.agents);
    if (!parsed.success) {
      throw new Error(
        `list_agents response failed AgentListItemPayloadSchema: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });

  it("emits list_pending_permissions payloads that satisfy the permission schema", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "agent-with-permission",
        provider: "codex",
        pendingPermissions: new Map([
          [
            "perm-minimal",
            {
              id: "perm-minimal",
              provider: "codex",
              name: "request_user_input",
              kind: "question",
              title: "Need input",
              input: { prompt: "Pick one" },
              detail: undefined,
              metadata: { source: "test" },
            },
          ],
        ]),
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_pending_permissions");
    const response = await tool.handler({});

    const permissions = z
      .array(
        z.object({
          agentId: z.string(),
          status: z.string(),
          request: AgentPermissionRequestPayloadSchema,
        }),
      )
      .parse(response.structuredContent.permissions);
    expect(permissions).toEqual([
      {
        agentId: "agent-with-permission",
        status: "idle",
        request: {
          id: "perm-minimal",
          provider: "codex",
          name: "request_user_input",
          kind: "question",
          title: "Need input",
          input: { prompt: "Pick one" },
          metadata: { source: "test" },
        },
      },
    ]);
  });

  it("loads archived agents before reading get_agent_activity", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const record = createStoredRecord({ id: "archived-activity-agent" });
    const snapshot = {
      id: "archived-activity-agent",
      currentModeId: "default",
    } as ManagedAgent;
    spies.agentManager.getAgent
      .mockReturnValueOnce(null)
      .mockReturnValue(snapshot)
      .mockReturnValue(snapshot);
    spies.agentStorage.get.mockResolvedValue(record);
    spies.agentManager.resumeAgentFromPersistence.mockResolvedValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      {
        kind: "status",
        timestamp: "2026-04-11T00:00:00.000Z",
        text: "Agent resumed",
      },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "archived-activity-agent" });

    expect(response.structuredContent).toEqual(
      expect.objectContaining({
        agentId: "archived-activity-agent",
        updateCount: 1,
        currentModeId: "default",
      }),
    );
    expect(spies.agentManager.resumeAgentFromPersistence).toHaveBeenCalled();
    expect(spies.agentManager.hydrateTimelineFromProvider).toHaveBeenCalledWith(
      "archived-activity-agent",
      { broadcast: expect.any(Function) },
    );
  });

  it("get_agent_activity limit counts projected messages, not raw deltas", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const snapshot = createManagedAgent({ id: "live-activity-agent", currentModeId: "default" });
    spies.agentManager.getAgent.mockReturnValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      { type: "user_message", text: "Say hi" },
      { type: "assistant_message", text: "Hello " },
      { type: "assistant_message", text: "world" },
      { type: "assistant_message", text: "." },
      { type: "assistant_message", text: " How" },
      { type: "assistant_message", text: " are" },
      { type: "assistant_message", text: " you?" },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger: createTestLogger(),
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "live-activity-agent", limit: 1 });

    const content = String(response.structuredContent.content);
    expect(content).toContain("Hello world. How are you?");
  });

  it("get_agent_activity limit=2 returns the last two projected entries whole", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const snapshot = createManagedAgent({ id: "live-activity-agent-2", currentModeId: "default" });
    spies.agentManager.getAgent.mockReturnValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      { type: "user_message", text: "u1" },
      { type: "assistant_message", text: "first " },
      { type: "assistant_message", text: "answer" },
      { type: "user_message", text: "u2" },
      { type: "assistant_message", text: "second " },
      { type: "assistant_message", text: "answer" },
      { type: "user_message", text: "u3" },
      { type: "assistant_message", text: "third " },
      { type: "assistant_message", text: "answer" },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger: createTestLogger(),
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "live-activity-agent-2", limit: 2 });

    const content = String(response.structuredContent.content);
    expect(content).toContain("[User] u3");
    expect(content).toContain("third answer");
    expect(content).not.toContain("[User] u2");
    expect(content).not.toContain("second answer");
    expect(content).not.toContain("first answer");
  });
});

it("rejects hidden agent-worktree placement and directs callers to workspace creation", async () => {
  const { agentManager, agentStorage } = createTestDeps();
  const server = await createAgentMcpServer({
    agentManager,
    agentStorage,
    providerSnapshotManager: createOpenCodeManager().manager,
    logger: createTestLogger(),
  });
  const tool = registeredTool(server, "create_agent");
  await expect(
    tool.handler({
      provider: "codex/gpt-5.4",
      title: "Worktree agent",
      initialPrompt: "test",
      relationship: { kind: "detached" },
      workspace: {
        kind: "create",
        source: {
          kind: "worktree",
          cwd: process.cwd(),
          target: { kind: "branch-off", worktreeSlug: "legacy" },
        },
      },
    }),
  ).rejects.toThrow("create_workspace");
  await expect(
    tool.handler({
      provider: "codex/gpt-5.4",
      title: "Worktree agent",
      initialPrompt: "test",
      cwd: process.cwd(),
      worktreeName: "legacy",
      baseBranch: "main",
    }),
  ).rejects.toThrow("create_workspace");
});
