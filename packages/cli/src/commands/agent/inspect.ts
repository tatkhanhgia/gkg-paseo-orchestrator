import type { Command } from "commander";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { HarnessBindingReceipt } from "@getpaseo/protocol/harness-binding";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { PolicyOwner } from "@getpaseo/protocol/policy-owner";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema, CommandError } from "../../output/index.js";

export function addInspectOptions(cmd: Command): Command {
  return cmd
    .description("Show detailed information about an agent")
    .argument("<id>", "Agent ID (or prefix)");
}

/** Agent inspect data for display (matches CLI spec format) */
interface InspectPolicyOwner {
  Kind: PolicyOwner["kind"];
  PluginId: string | null;
  GenerationDigest: string | null;
  PolicyVersion: string | null;
}

interface InspectSupervisorNotebook {
  NotebookId: string;
  Location: string;
  ProjectScope: string;
  ReportingTarget: string;
  DesignatedWriterId: string | null;
  ExpiresAt: string | null;
}

interface InspectHarnessResource {
  Key: string;
  Path: string;
  Digest: string;
}

interface InspectHarnessBinding {
  SchemaVersion: number;
  Package: string;
  Generation: number;
  ArtifactDigest: string;
  DescriptorPath: string;
  DescriptorDigest: string;
  Resources: InspectHarnessResource[];
  ProjectId: string;
  WorkspaceId: string;
  WorkspaceRoot: string | null;
  ProjectRoot: string;
  Cwd: string;
  SupervisorNotebook: InspectSupervisorNotebook | null;
}

interface InspectNotebookGrant {
  Effect: "notebook-write";
  NotebookId: string;
  Location: string;
  ProjectId: string;
  Scope: string;
  DesignatedWriterId: string;
  ExpiresAt: string;
}

interface AgentInspect {
  Id: string;
  Name: string;
  Provider: string;
  Role: string | null;
  RoleBinding: {
    PolicyOwner: InspectPolicyOwner | null;
    DefinitionVersion: string;
    DefinitionDigest: string;
    BindingDigest: string;
    InjectionMethod: string;
    Qualification: string;
    ProtocolStatus: string;
    ProtocolDigest: string | null;
    HarnessBinding: InspectHarnessBinding | null;
  } | null;
  Assignment: {
    Version: number;
    Digest: string;
    Role: string;
    Disposition: string;
    Assigner: string;
    WorkspaceId: string;
    Cwd: string;
    EffectClass: string;
    MutationBoundary: string;
    ExternalEffectBoundary: string;
    BeadsIssueGrants: string[];
    ProtocolExceptionExpiresAt: string | null;
    CreatedAt: string;
    ExpiresAt: string | null;
    NotebookGrant: InspectNotebookGrant | null;
  } | null;
  LaunchContract: {
    Version: number;
    ContractDigest: string;
    ProviderId: string;
    ProviderFamily: string;
    Model: string;
    RouteKind: string;
    ModelProviderId: string | null;
    AuthMethod: string;
    CredentialConfigured: boolean | null;
  } | null;
  LaunchProfile: {
    Id: string;
    Name: string;
    PeerSubrole: string | null;
  } | null;
  CredentialConfigured: boolean | null;
  Model: string;
  Thinking: string;
  Status: string;
  Archived: boolean;
  ArchivedAt: string | null;
  Mode: string;
  Cwd: string;
  CreatedAt: string;
  UpdatedAt: string;
  LastUsage: {
    InputTokens: number | null;
    OutputTokens: number | null;
    CachedTokens: number | null;
    CostUsd: number | null;
  } | null;
  ContinuityAwareness: AgentSnapshotPayload["continuityAwareness"] | null;
  Capabilities: {
    Streaming: boolean;
    Persistence: boolean;
    DynamicModes: boolean;
    McpServers: boolean;
  } | null;
  AvailableModes: Array<{
    id: string;
    label: string;
  }> | null;
  PendingPermissions: Array<{
    id: string;
    tool: string;
  }>;
  Worktree: string | null;
  ParentAgentId: string | null;
}

/** Key-value row for table display */
interface InspectRow {
  key: string;
  value: string;
}

/** Schema for key-value display with custom serialization for JSON/YAML */
function createInspectSchema(agent: AgentInspect): OutputSchema<InspectRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key" },
      {
        header: "VALUE",
        field: "value",
        color: (_, item) => {
          if (item.key === "Status") {
            if (item.value === "running") return "green";
            if (item.value === "idle") return "yellow";
            if (item.value === "error") return "red";
          }
          return undefined;
        },
      },
    ],
    // For JSON/YAML, return the structured agent object
    serialize: (_item) => agent,
  };
}

/** Shorten home directory in path */
function shortenPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/** Format cost in USD */
function formatCost(costUsd: number): string {
  if (costUsd === 0) return "$0.00";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

function normalizeModelId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "default") return null;
  return normalized;
}

function resolveModel(snapshot: AgentSnapshotPayload): string | null {
  return normalizeModelId(snapshot.runtimeInfo?.model) ?? normalizeModelId(snapshot.model);
}

function buildLastUsage(snapshot: AgentSnapshotPayload): AgentInspect["LastUsage"] {
  if (!snapshot.lastUsage) return null;
  return {
    InputTokens: snapshot.lastUsage.inputTokens ?? null,
    OutputTokens: snapshot.lastUsage.outputTokens ?? null,
    CachedTokens: snapshot.lastUsage.cachedInputTokens ?? null,
    CostUsd: snapshot.lastUsage.totalCostUsd ?? null,
  };
}

function buildContinuityAwareness(
  snapshot: AgentSnapshotPayload,
): AgentInspect["ContinuityAwareness"] {
  return snapshot.continuityAwareness ?? null;
}

function buildAvailableModes(snapshot: AgentSnapshotPayload): AgentInspect["AvailableModes"] {
  if (!snapshot.availableModes) return null;
  return snapshot.availableModes.map((mode) => ({ id: mode.id, label: mode.label }));
}

function buildCapabilities(snapshot: AgentSnapshotPayload): AgentInspect["Capabilities"] {
  if (!snapshot.capabilities) return null;
  return {
    Streaming: snapshot.capabilities.supportsStreaming ?? false,
    Persistence: snapshot.capabilities.supportsSessionPersistence ?? false,
    DynamicModes: snapshot.capabilities.supportsDynamicModes ?? false,
    McpServers: snapshot.capabilities.supportsMcpServers ?? false,
  };
}

function buildPolicyOwner(owner: PolicyOwner | undefined): InspectPolicyOwner | null {
  if (!owner) return null;
  if (owner.kind === "legacy-core") {
    return {
      Kind: owner.kind,
      PluginId: null,
      GenerationDigest: null,
      PolicyVersion: null,
    };
  }
  return {
    Kind: owner.kind,
    PluginId: owner.pluginId,
    GenerationDigest: owner.generationDigest,
    PolicyVersion: owner.policyVersion,
  };
}

function buildSupervisorNotebook(
  notebook: NonNullable<HarnessBindingReceipt["notebook"]> | undefined,
): InspectSupervisorNotebook | null {
  if (!notebook) return null;
  return {
    NotebookId: notebook.notebookId,
    Location: notebook.location,
    ProjectScope: notebook.projectScope,
    ReportingTarget: notebook.reportingTarget,
    DesignatedWriterId: notebook.designatedWriterId,
    ExpiresAt: notebook.expiresAt,
  };
}

function buildHarnessBinding(
  binding: HarnessBindingReceipt | undefined,
): InspectHarnessBinding | null {
  if (!binding) return null;
  return {
    SchemaVersion: binding.schemaVersion,
    Package: binding.package,
    Generation: binding.generation,
    ArtifactDigest: binding.artifactDigest,
    DescriptorPath: binding.descriptorPath,
    DescriptorDigest: binding.descriptorDigest,
    Resources: binding.resources.map((resource) => ({
      Key: resource.key,
      Path: resource.path,
      Digest: resource.digest,
    })),
    ProjectId: binding.projectId,
    WorkspaceId: binding.workspaceId,
    WorkspaceRoot: binding.workspaceRoot ?? null,
    ProjectRoot: binding.projectRoot,
    Cwd: binding.cwd,
    SupervisorNotebook: buildSupervisorNotebook(binding.notebook),
  };
}

function buildNotebookGrant(snapshot: AgentSnapshotPayload): InspectNotebookGrant | null {
  const grant = snapshot.roleBinding?.assignment?.notebookGrant;
  if (!grant) return null;
  return {
    Effect: grant.effect,
    NotebookId: grant.notebookId,
    Location: grant.location,
    ProjectId: grant.projectId,
    Scope: grant.scope,
    DesignatedWriterId: grant.designatedWriterId,
    ExpiresAt: grant.expiresAt,
  };
}

function buildRoleBinding(snapshot: AgentSnapshotPayload): AgentInspect["RoleBinding"] {
  if (!snapshot.roleBinding) return null;
  return {
    PolicyOwner: buildPolicyOwner(snapshot.roleBinding.policyOwner),
    DefinitionVersion: snapshot.roleBinding.definitionVersion,
    DefinitionDigest: snapshot.roleBinding.definitionDigest,
    BindingDigest: snapshot.roleBinding.bindingDigest,
    InjectionMethod: snapshot.roleBinding.injectionMethod,
    Qualification: snapshot.roleBinding.qualification,
    ProtocolStatus: snapshot.roleBinding.workspaceProtocol.status,
    ProtocolDigest: snapshot.roleBinding.workspaceProtocol.digest ?? null,
    HarnessBinding: buildHarnessBinding(snapshot.roleBinding.harnessBinding),
  };
}

function formatBoundary(
  boundary: { mode: "no-write" | "denied" } | { mode: "bounded-write" | "bounded"; scope: string },
): string {
  return "scope" in boundary ? `${boundary.mode}: ${boundary.scope}` : boundary.mode;
}

function buildAssignment(snapshot: AgentSnapshotPayload): AgentInspect["Assignment"] {
  const assignment = snapshot.roleBinding?.assignment;
  if (!assignment) return null;
  return {
    Version: assignment.version,
    Digest: assignment.assignmentDigest,
    Role: assignment.roleId,
    Disposition: assignment.disposition,
    Assigner:
      assignment.assigner.kind === "agent"
        ? `agent:${assignment.assigner.agentId}`
        : "human-session",
    WorkspaceId: assignment.workspaceId,
    Cwd: assignment.cwd,
    EffectClass: assignment.effectClass,
    MutationBoundary: formatBoundary(assignment.mutationBoundary),
    ExternalEffectBoundary: formatBoundary(assignment.externalEffectBoundary),
    BeadsIssueGrants: assignment.resourceGrants?.beadsIssueIds ?? [],
    ProtocolExceptionExpiresAt: assignment.protocolExceptionExpiresAt ?? null,
    CreatedAt: assignment.createdAt,
    ExpiresAt: assignment.expiresAt ?? null,
    NotebookGrant: buildNotebookGrant(snapshot),
  };
}

function buildLaunchContract(snapshot: AgentSnapshotPayload): AgentInspect["LaunchContract"] {
  if (!snapshot.launchContract) return null;
  return {
    Version: snapshot.launchContract.version,
    ContractDigest: snapshot.launchContract.contractDigest,
    ProviderId: snapshot.launchContract.providerId,
    ProviderFamily: snapshot.launchContract.providerFamily,
    Model: snapshot.launchContract.model,
    RouteKind: snapshot.launchContract.routeKind,
    ModelProviderId: snapshot.launchContract.modelProviderId,
    AuthMethod: snapshot.launchContract.authMethod,
    CredentialConfigured: snapshot.launchContract.credentialConfigured,
  };
}

function buildLaunchProfile(snapshot: AgentSnapshotPayload): AgentInspect["LaunchProfile"] {
  if (!snapshot.launchProfile) return null;
  return {
    Id: snapshot.launchProfile.id,
    Name: snapshot.launchProfile.name,
    PeerSubrole: snapshot.launchProfile.peerSubrole ?? null,
  };
}

/** Convert agent snapshot to inspection data. Exported for focused receipt projection tests. */
export function toInspectData(snapshot: AgentSnapshotPayload): AgentInspect {
  return {
    Id: snapshot.id,
    Name: snapshot.title ?? "-",
    Provider: snapshot.provider,
    Role: snapshot.launchContract?.roleId ?? snapshot.roleBinding?.roleId ?? null,
    RoleBinding: buildRoleBinding(snapshot),
    Assignment: buildAssignment(snapshot),
    LaunchContract: buildLaunchContract(snapshot),
    LaunchProfile: buildLaunchProfile(snapshot),
    CredentialConfigured: snapshot.launchContract?.credentialConfigured ?? null,
    Model: snapshot.launchContract?.model ?? resolveModel(snapshot) ?? "-",
    Thinking: snapshot.effectiveThinkingOptionId ?? "auto",
    Status: snapshot.status,
    Archived: snapshot.archivedAt != null,
    ArchivedAt: snapshot.archivedAt ?? null,
    Mode: snapshot.currentModeId ?? "default",
    Cwd: snapshot.cwd,
    CreatedAt: snapshot.createdAt,
    UpdatedAt: snapshot.updatedAt,
    LastUsage: buildLastUsage(snapshot),
    ContinuityAwareness: buildContinuityAwareness(snapshot),
    Capabilities: buildCapabilities(snapshot),
    AvailableModes: buildAvailableModes(snapshot),
    PendingPermissions: (snapshot.pendingPermissions ?? []).map((p) => ({
      id: p.id,
      tool: p.name ?? "unknown",
    })),
    Worktree: snapshot.labels?.["paseo.worktree"] ?? null,
    ParentAgentId: snapshot.labels?.[PARENT_AGENT_ID_LABEL] ?? null,
  };
}

function formatLastUsage(usage: NonNullable<AgentInspect["LastUsage"]>): string {
  const cost = usage.CostUsd === null ? "unknown" : formatCost(usage.CostUsd);
  return `InputTokens: ${usage.InputTokens ?? "unknown"}, OutputTokens: ${usage.OutputTokens ?? "unknown"}, CachedTokens: ${usage.CachedTokens ?? "unknown"}, CostUsd: ${cost}`;
}

function appendContinuityAwarenessRow(
  rows: InspectRow[],
  awareness: AgentInspect["ContinuityAwareness"],
): void {
  if (!awareness) return;
  const compactionScope = awareness.compactionCountScope
    ? ` (${awareness.compactionCountScope})`
    : "";
  const currentTasks =
    awareness.currentTaskSnapshot === null ? "unknown" : awareness.currentTaskSnapshot.length;
  const heldLocks =
    awareness.heldLocks === null ? "unknown" : awareness.heldLocks.join(", ") || "none";
  rows.push({
    key: "ContinuityAwareness",
    value: `RemainingContextTokens: ${awareness.remainingContextTokens ?? "unknown"}, RemainingContextRatio: ${awareness.remainingContextRatio ?? "unknown"}, Compactions: ${awareness.compactionCount ?? "unknown"}${compactionScope}, IdleSince: ${awareness.idleSince ?? "null"}${awareness.idleSinceBasis ? ` (${awareness.idleSinceBasis})` : ""}, IdleDurationMs: ${awareness.idleDurationMs ?? "null"}, CurrentTasks: ${currentTasks}${awareness.currentTaskSnapshotScope ? ` (${awareness.currentTaskSnapshotScope})` : ""}, HeldLocks: ${heldLocks}`,
  });
}

function appendLaunchProfileRow(
  rows: InspectRow[],
  launchProfile: AgentInspect["LaunchProfile"],
): void {
  if (!launchProfile) return;
  rows.push({
    key: "LaunchProfile",
    value: `Id: ${launchProfile.Id}, Name: ${launchProfile.Name}, PeerSubrole: ${launchProfile.PeerSubrole ?? "none"}`,
  });
}

function formatPolicyOwner(owner: InspectPolicyOwner | null): string {
  if (!owner) return "null";
  if (owner.Kind === "legacy-core") return owner.Kind;
  return `plugin:${owner.PluginId}@sha256:${owner.GenerationDigest} · ${owner.PolicyVersion}`;
}

function formatSupervisorNotebook(notebook: InspectSupervisorNotebook | null): string {
  if (!notebook) return "null";
  return `NotebookId: ${notebook.NotebookId}, Location: ${notebook.Location}, ProjectScope: ${notebook.ProjectScope}, ReportingTarget: ${notebook.ReportingTarget}, DesignatedWriterId: ${notebook.DesignatedWriterId ?? "null"}, ExpiresAt: ${notebook.ExpiresAt ?? "null"}`;
}

function formatHarnessBinding(binding: InspectHarnessBinding | null): string {
  if (!binding) return "null";
  const resources = binding.Resources.map(
    (resource) => `${resource.Key}=${resource.Path}@sha256:${resource.Digest}`,
  ).join("; ");
  return `SchemaVersion: ${binding.SchemaVersion}, Package: ${binding.Package}, Generation: ${binding.Generation}, ArtifactDigest: ${binding.ArtifactDigest}, DescriptorPath: ${binding.DescriptorPath}, DescriptorDigest: ${binding.DescriptorDigest}, Resources: ${resources || "none"}, ProjectId: ${binding.ProjectId}, WorkspaceId: ${binding.WorkspaceId}, WorkspaceRoot: ${binding.WorkspaceRoot ?? "null"}, ProjectRoot: ${binding.ProjectRoot}, Cwd: ${binding.Cwd}, SupervisorNotebook: ${formatSupervisorNotebook(binding.SupervisorNotebook)}`;
}

function formatNotebookGrant(grant: InspectNotebookGrant | null): string {
  if (!grant) return "null";
  return `Effect: ${grant.Effect}, NotebookId: ${grant.NotebookId}, Location: ${grant.Location}, ProjectId: ${grant.ProjectId}, Scope: ${grant.Scope}, DesignatedWriterId: ${grant.DesignatedWriterId}, ExpiresAt: ${grant.ExpiresAt}`;
}

/** Convert agent to key-value rows for table display */
function toInspectRows(agent: AgentInspect): InspectRow[] {
  const rows: InspectRow[] = [
    { key: "Id", value: agent.Id },
    { key: "Name", value: agent.Name },
    { key: "Provider", value: agent.Provider },
    { key: "Role", value: agent.Role ?? "null" },
    {
      key: "CredentialConfigured",
      value: agent.CredentialConfigured === null ? "unknown" : String(agent.CredentialConfigured),
    },
    { key: "Model", value: agent.Model },
    { key: "Thinking", value: agent.Thinking },
    { key: "Status", value: agent.Status },
    { key: "Archived", value: String(agent.Archived) },
    { key: "ArchivedAt", value: agent.ArchivedAt ?? "null" },
    { key: "Mode", value: agent.Mode },
    { key: "Cwd", value: shortenPath(agent.Cwd) },
    { key: "CreatedAt", value: agent.CreatedAt },
    { key: "UpdatedAt", value: agent.UpdatedAt },
  ];

  if (agent.RoleBinding) {
    rows.push({
      key: "PolicyOwner",
      value: formatPolicyOwner(agent.RoleBinding.PolicyOwner),
    });
    rows.push({
      key: "RoleBinding",
      value: `Version: ${agent.RoleBinding.DefinitionVersion}, Definition: ${agent.RoleBinding.DefinitionDigest}, Binding: ${agent.RoleBinding.BindingDigest}, Injection: ${agent.RoleBinding.InjectionMethod}, Qualification: ${agent.RoleBinding.Qualification}, Protocol: ${agent.RoleBinding.ProtocolStatus}${agent.RoleBinding.ProtocolDigest ? ` (${agent.RoleBinding.ProtocolDigest})` : ""}`,
    });
    rows.push({
      key: "HarnessBinding",
      value: formatHarnessBinding(agent.RoleBinding.HarnessBinding),
    });
  }

  if (agent.Assignment) {
    rows.push({
      key: "Assignment",
      value: `Version: ${agent.Assignment.Version}, Digest: ${agent.Assignment.Digest}, Role: ${agent.Assignment.Role}, Disposition: ${agent.Assignment.Disposition}, Assigner: ${agent.Assignment.Assigner}, WorkspaceId: ${agent.Assignment.WorkspaceId}, Cwd: ${agent.Assignment.Cwd}, Effect: ${agent.Assignment.EffectClass}, Mutation: ${agent.Assignment.MutationBoundary}, External: ${agent.Assignment.ExternalEffectBoundary}, BeadsIssueGrants: ${agent.Assignment.BeadsIssueGrants.join(", ") || "none"}, ProtocolExceptionExpiresAt: ${agent.Assignment.ProtocolExceptionExpiresAt ?? "null"}, CreatedAt: ${agent.Assignment.CreatedAt}, ExpiresAt: ${agent.Assignment.ExpiresAt ?? "null"}, NotebookGrant: ${formatNotebookGrant(agent.Assignment.NotebookGrant)}`,
    });
  }

  if (agent.LaunchContract) {
    rows.push({
      key: "LaunchContract",
      value: `Version: ${agent.LaunchContract.Version}, Digest: ${agent.LaunchContract.ContractDigest}, ProviderId: ${agent.LaunchContract.ProviderId}, Family: ${agent.LaunchContract.ProviderFamily}, Model: ${agent.LaunchContract.Model}, Route: ${agent.LaunchContract.RouteKind}, ModelProviderId: ${agent.LaunchContract.ModelProviderId ?? "null"}, Auth: ${agent.LaunchContract.AuthMethod}`,
    });
  }

  appendLaunchProfileRow(rows, agent.LaunchProfile);

  if (agent.LastUsage) {
    rows.push({
      key: "LastUsage",
      value: formatLastUsage(agent.LastUsage),
    });
  }

  appendContinuityAwarenessRow(rows, agent.ContinuityAwareness);

  if (agent.Capabilities) {
    rows.push({
      key: "Capabilities",
      value: `Streaming: ${agent.Capabilities.Streaming}, Persistence: ${agent.Capabilities.Persistence}, DynamicModes: ${agent.Capabilities.DynamicModes}, McpServers: ${agent.Capabilities.McpServers}`,
    });
  }

  if (agent.AvailableModes && agent.AvailableModes.length > 0) {
    rows.push({
      key: "AvailableModes",
      value: agent.AvailableModes.map((m) => `${m.id} (${m.label})`).join(", "),
    });
  }

  rows.push({
    key: "PendingPermissions",
    value:
      agent.PendingPermissions.length > 0
        ? agent.PendingPermissions.map((p) => `${p.id} (${p.tool})`).join(", ")
        : "[]",
  });

  rows.push({ key: "Worktree", value: agent.Worktree ?? "null" });
  rows.push({ key: "ParentAgentId", value: agent.ParentAgentId ?? "null" });

  return rows;
}

export type AgentInspectResult = ListResult<InspectRow>;

export interface AgentInspectOptions extends CommandOptions {
  host?: string;
}

export async function runInspectCommand(
  agentIdArg: string,
  options: AgentInspectOptions,
  _command: Command,
): Promise<AgentInspectResult> {
  const host = getDaemonHost({ host: options.host });

  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent inspect <id>",
    };
    throw error;
  }

  let client;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }

  try {
    const fetchResult = await client.fetchAgent({ agentId: agentIdArg });
    if (!fetchResult) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }

    await client.close();

    const inspectData = toInspectData(fetchResult.agent);

    return {
      type: "list",
      data: toInspectRows(inspectData),
      schema: createInspectSchema(inspectData),
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "INSPECT_FAILED",
      message: `Failed to inspect agent: ${message}`,
    };
    throw error;
  }
}
