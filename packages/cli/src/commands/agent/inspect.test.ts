import { describe, expect, test } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { toInspectData } from "./inspect.js";

function snapshotWithAssignment(): AgentSnapshotPayload {
  return {
    id: "agent-1",
    provider: "codex",
    cwd: "/repo",
    title: "Inspect receipt",
    status: "idle",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:01:00.000Z",
    archivedAt: null,
    labels: {},
    pendingPermissions: [],
    roleBinding: {
      roleId: "lead",
      definitionVersion: "3.3.0-mandatory-protocol-webui",
      definitionDigest: "a".repeat(64),
      bindingDigest: "b".repeat(64),
      provider: "codex",
      injectionMethod: "codex-developer-instructions",
      qualification: "implementation-supported",
      workspaceProtocol: {
        status: "bound",
        readership: "full",
        path: "/repo/WORKSPACE_PROTOCOL.md",
        digest: "c".repeat(64),
      },
      assignment: {
        version: 1,
        assignmentDigest: "d".repeat(64),
        roleId: "lead",
        disposition: "lead-direct",
        assigner: { kind: "human-session" },
        workspaceId: "workspace-1",
        cwd: "/repo",
        effectClass: "read-only",
        mutationBoundary: { mode: "no-write" },
        externalEffectBoundary: { mode: "denied" },
        resourceGrants: { beadsIssueIds: ["ps123-abc"] },
        createdAt: "2026-08-08T00:00:00.000Z",
      },
      createdAt: "2026-08-08T00:00:00.000Z",
    },
  } as AgentSnapshotPayload;
}

describe("agent inspect assignment receipt", () => {
  test("projects the immutable secret-safe assignment receipt", () => {
    expect(toInspectData(snapshotWithAssignment()).Assignment).toEqual({
      Version: 1,
      Digest: "d".repeat(64),
      Role: "lead",
      Disposition: "lead-direct",
      Assigner: "human-session",
      WorkspaceId: "workspace-1",
      Cwd: "/repo",
      EffectClass: "read-only",
      MutationBoundary: "no-write",
      ExternalEffectBoundary: "denied",
      BeadsIssueGrants: ["ps123-abc"],
      ProtocolExceptionExpiresAt: null,
      CreatedAt: "2026-08-08T00:00:00.000Z",
      ExpiresAt: null,
      NotebookGrant: null,
    });
  });

  test("projects actual policy, harness, Supervisor notebook, and grant receipts separately", () => {
    const snapshot = snapshotWithAssignment();
    snapshot.roleBinding = {
      ...snapshot.roleBinding!,
      roleId: "supervisor",
      policyOwner: {
        kind: "plugin",
        pluginId: "slp",
        generationDigest: "e".repeat(64),
        policyVersion: "1.0.0",
      },
      harnessBinding: {
        schemaVersion: 1,
        package: "paseo-project-harness",
        generation: 7,
        artifactDigest: "f".repeat(64),
        descriptorPath: "/foundation/harness/harness-package.json",
        descriptorDigest: "1".repeat(64),
        resources: [
          { key: "entryMap", path: "/foundation/harness/README.md", digest: "2".repeat(64) },
        ],
        projectId: "project-1",
        workspaceId: "workspace-1",
        workspaceRoot: "/repo",
        projectRoot: "/repo",
        cwd: "/repo",
        notebook: {
          notebookId: "notebook-1",
          location: "/repo/.paseo/SUPERVISOR_NOTEBOOK.md",
          projectScope: "project-1",
          reportingTarget: "supervisor-report",
          designatedWriterId: "agent-supervisor",
          expiresAt: "2026-08-08T01:00:00.000Z",
        },
      },
      assignment: {
        ...snapshot.roleBinding!.assignment!,
        roleId: "supervisor",
        disposition: "supervision",
        notebookGrant: {
          effect: "notebook-write",
          notebookId: "notebook-1",
          location: "/repo/.paseo/SUPERVISOR_NOTEBOOK.md",
          projectId: "project-1",
          scope: "append evidence",
          designatedWriterId: "agent-supervisor",
          expiresAt: "2026-08-08T01:00:00.000Z",
        },
      },
    };

    const projected = toInspectData(snapshot);
    expect(projected.RoleBinding).toMatchObject({
      PolicyOwner: {
        Kind: "plugin",
        PluginId: "slp",
        GenerationDigest: "e".repeat(64),
        PolicyVersion: "1.0.0",
      },
      HarnessBinding: {
        Package: "paseo-project-harness",
        Generation: 7,
        ArtifactDigest: "f".repeat(64),
        DescriptorPath: "/foundation/harness/harness-package.json",
        DescriptorDigest: "1".repeat(64),
        Resources: [
          { Key: "entryMap", Path: "/foundation/harness/README.md", Digest: "2".repeat(64) },
        ],
        ProjectId: "project-1",
        WorkspaceId: "workspace-1",
        WorkspaceRoot: "/repo",
        ProjectRoot: "/repo",
        Cwd: "/repo",
        SupervisorNotebook: {
          NotebookId: "notebook-1",
          Location: "/repo/.paseo/SUPERVISOR_NOTEBOOK.md",
          ProjectScope: "project-1",
          ReportingTarget: "supervisor-report",
          DesignatedWriterId: "agent-supervisor",
          ExpiresAt: "2026-08-08T01:00:00.000Z",
        },
      },
    });
    expect(projected.Assignment?.NotebookGrant).toEqual({
      Effect: "notebook-write",
      NotebookId: "notebook-1",
      Location: "/repo/.paseo/SUPERVISOR_NOTEBOOK.md",
      ProjectId: "project-1",
      Scope: "append evidence",
      DesignatedWriterId: "agent-supervisor",
      ExpiresAt: "2026-08-08T01:00:00.000Z",
    });
  });

  test("keeps absent policy and harness receipts explicitly unknown for legacy agents", () => {
    const projected = toInspectData(snapshotWithAssignment());
    expect(projected.RoleBinding).toMatchObject({
      PolicyOwner: null,
      HarnessBinding: null,
    });
    expect(projected.Assignment?.NotebookGrant).toBeNull();
  });

  test("keeps legacy snapshots without assignments compatible", () => {
    const snapshot = snapshotWithAssignment();
    if (snapshot.roleBinding) delete snapshot.roleBinding.assignment;
    expect(toInspectData(snapshot).Assignment).toBeNull();
  });

  test("shows the exact Agent Profile selected for a Peer launch", () => {
    const snapshot = snapshotWithAssignment();
    snapshot.launchProfile = {
      id: "peer-reviewer",
      name: "Peer Reviewer",
      peerSubrole: "reviewer",
    };

    expect(toInspectData(snapshot).LaunchProfile).toEqual({
      Id: "peer-reviewer",
      Name: "Peer Reviewer",
      PeerSubrole: "reviewer",
    });
  });

  test("keeps unsupported counters unknown and projects raw continuity awareness", () => {
    const snapshot = snapshotWithAssignment();
    snapshot.lastUsage = { inputTokens: 12 };
    snapshot.continuityAwareness = {
      remainingContextTokens: null,
      remainingContextRatio: null,
      contextWindowUsedTokens: null,
      contextWindowMaxTokens: null,
      inputTokens: 12,
      cachedInputTokens: null,
      outputTokens: null,
      compactionCount: 2,
      compactionCountScope: "loaded_timeline",
      idleSince: "2026-08-08T00:01:00.000Z",
      idleSinceBasis: "agent_updated_at",
      idleDurationMs: 30_000,
      currentTaskSnapshot: null,
      currentTaskSnapshotScope: "loaded_timeline",
      heldLocks: null,
    };

    const projected = toInspectData(snapshot);
    expect(projected.LastUsage).toEqual({
      InputTokens: 12,
      OutputTokens: null,
      CachedTokens: null,
      CostUsd: null,
    });
    expect(projected.ContinuityAwareness).toEqual(snapshot.continuityAwareness);
  });
});
