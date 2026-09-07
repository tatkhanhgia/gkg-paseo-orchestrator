import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { NotebookGrantReceipt } from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

import type { AgentStorage } from "../agent/agent-storage.js";
import type { PersistedAssignmentContract } from "../agent/assignment-contract.js";
import type { PaseoToolExecutionContext, PaseoToolResult } from "../agent/tools/types.js";
import {
  DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  DEFAULT_SUPERVISOR_NOTEBOOK_PATH,
} from "./harness-bootstrap-defaults.js";
import {
  inspectHarnessProjectMetadata,
  writeHarnessProjectMetadata,
} from "./harness-project-metadata-file.js";
import { registerProjectNotebookTools } from "./project-notebook-tools.js";

/**
 * Realistic fixtures per the 2026-09-07 Lead verdict on H3: authorization is
 * grant-based, not role/mutationBoundary-based, and every append call
 * live-revalidates the caller's durable grant against the project's current
 * `.paseo/harness.json` claim. Fixtures below always establish that on-disk
 * claim explicitly (via `writeHarnessProjectMetadata`, the same primitive
 * `notebook-grant-resolver.ts` uses in production) rather than asserting
 * against a claim that only exists in the assignment receipt.
 */

interface CapturedTool {
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GRANT: NotebookGrantReceipt = {
  effect: "notebook-write",
  notebookId: "nb_fixture",
  location: DEFAULT_SUPERVISOR_NOTEBOOK_PATH,
  projectId: "project-1",
  scope: "H3 coordination notes",
  designatedWriterId: "supervisor-1",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

function notebookRecord(observation: string) {
  const recordId = `test-${observation.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")}`;
  return {
    schemaVersion: 1 as const,
    recordId,
    episode: "project-notebook-tools-test",
    scope: "R1 bounded Supervisor notebook authority",
    observation,
    evidence: ["project-notebook-tools.test.ts"],
    suspectedMechanism: {
      status: "unknown" as const,
      statement: "The focused test does not establish a mechanism.",
    },
    impact: "quality" as const,
    questionForLead: "What should the next bounded review verify?",
    recovery: "Preserve the record and retry only with the returned revision.",
    outcome: observation,
    patternStatus: "one-off" as const,
    recommendation: "Keep the structured record available for the next review.",
    escalation: "no" as const,
    currentEpisode: "Observed" as const,
    laterEffect: "Unobserved" as const,
    laterEffectEvidenceRefs: [],
    observedAt: "2026-09-07T00:00:00.000Z",
  };
}

function assignmentFor(input: {
  notebookGrant?: NotebookGrantReceipt;
  expiresAt?: string;
}): PersistedAssignmentContract {
  return {
    receipt: {
      assignmentDigest: "a".repeat(64),
      roleId: "supervisor",
      expiresAt: input.expiresAt,
      notebookGrant: input.notebookGrant,
    },
    envelope: {
      disposition: "supervision",
      effectClass: "delegation",
      mutationBoundary: { mode: "no-write" },
      externalEffectBoundary: { mode: "denied" },
    },
  } as unknown as PersistedAssignmentContract;
}

function establishClaim(projectRoot: string, grant: NotebookGrantReceipt): void {
  const existing = inspectHarnessProjectMetadata(
    projectRoot,
    DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  );
  const result = writeHarnessProjectMetadata({
    repoRoot: projectRoot,
    relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    metadata: {
      supervisorNotebook: {
        notebookId: grant.notebookId,
        location: grant.location,
        designatedWriterId: grant.designatedWriterId,
        scope: grant.scope,
        expiresAt: grant.expiresAt,
        establishedAt: new Date().toISOString(),
      },
    },
    expectedRevision: existing.status === "valid" ? existing.revision : null,
    writerId: grant.designatedWriterId,
  });
  if (!result.ok) throw new Error(`test fixture failed to establish claim: ${result.error.code}`);
}

function createHarness(options: {
  roleId: PaseoRoleId;
  agentId?: string;
  assignment?: PersistedAssignmentContract;
  establishGrant?: NotebookGrantReceipt | null;
}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "project-notebook-tools-test-"));
  tempDirs.push(projectRoot);

  const agentId = options.agentId ?? "supervisor-1";
  const grant = options.establishGrant === undefined ? GRANT : options.establishGrant;
  if (grant) establishClaim(projectRoot, grant);

  const assignment = options.assignment ?? assignmentFor({ notebookGrant: grant ?? undefined });
  const agent = {
    id: agentId,
    cwd: projectRoot,
    workspaceId: "workspace-1",
    roleBinding: {
      roleId: options.roleId,
      assignmentContract: assignment,
      ...(options.roleId === "supervisor"
        ? {
            harnessBinding: {
              schemaVersion: 1,
              package: "paseo-project-harness",
              generation: 1,
              artifactDigest: "a".repeat(64),
              descriptorPath: "/tmp/harness-package.json",
              descriptorDigest: "b".repeat(64),
              resources: [
                {
                  key: "entryMap",
                  path: "/tmp/README.md",
                  digest: "c".repeat(64),
                },
              ],
              projectId: "project-1",
              workspaceId: "workspace-1",
              workspaceRoot: projectRoot,
              projectRoot,
              cwd: projectRoot,
              notebook: {
                notebookId: grant?.notebookId ?? "nb_fixture",
                location: grant?.location ?? DEFAULT_SUPERVISOR_NOTEBOOK_PATH,
                projectScope: "project:project-1",
                reportingTarget: "project:project-1:supervisor-notebook",
                designatedWriterId: grant?.designatedWriterId ?? null,
                expiresAt: grant?.expiresAt ?? null,
              },
            },
          }
        : {}),
    },
  };

  const tools = new Map<string, CapturedTool>();
  const workspaceGet = vi.fn().mockResolvedValue({
    workspaceId: "workspace-1",
    projectId: "project-1",
    cwd: projectRoot,
    archivedAt: null,
  });
  const projectGet = vi.fn().mockResolvedValue({
    projectId: "project-1",
    rootPath: projectRoot,
    archivedAt: null,
  });
  const projectList = vi
    .fn()
    .mockResolvedValue([{ projectId: "project-1", rootPath: projectRoot, archivedAt: null }]);
  registerProjectNotebookTools({
    registerTool: (name, _config, handler) => tools.set(name, { handler }),
    agentStorage: { get: vi.fn().mockResolvedValue(agent) } as unknown as AgentStorage,
    workspaceRegistry: { get: workspaceGet },
    projectRegistry: {
      get: projectGet,
      list: projectList,
    },
    callerAgentId: agentId,
    roleId: options.roleId,
  });

  return {
    tools,
    projectRoot,
    agent,
    workspaceGet,
    projectGet,
    projectList,
    call: async (name: string, input: unknown = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} was not registered`);
      const result = await tool.handler(input, { signal: new AbortController().signal });
      return result.structuredContent as Record<string, unknown>;
    },
  };
}

describe("registerProjectNotebookTools", () => {
  test("registers both notebook tools for a role-bound Supervisor", () => {
    const { tools } = createHarness({ roleId: "supervisor" });
    expect(tools.has("read_project_notebook")).toBe(true);
    expect(tools.has("append_project_notebook_record")).toBe(true);
  });

  test("read_project_notebook reports missing before any write and returns a null revision", async () => {
    const { call } = createHarness({ roleId: "supervisor" });
    const result = await call("read_project_notebook");
    expect(result.status).toBe("missing");
    expect(result.content).toBeNull();
    expect(result.revision).toBeNull();
  });

  test("a durably granted Supervisor can append using the revision from its own prior read", async () => {
    const { call, projectRoot } = createHarness({ roleId: "supervisor" });
    const before = await call("read_project_notebook");
    const result = await call("append_project_notebook_record", {
      record: notebookRecord("first record"),
      expectedRevision: before.revision,
    });
    expect(result.status).toBe("valid");
    expect(result.content).toContain("first record");
    expect(result.revision).toBeTruthy();

    const onDisk = readFileSync(join(projectRoot, DEFAULT_SUPERVISOR_NOTEBOOK_PATH), "utf8");
    expect(onDisk).toContain("first record");
  });

  test("append_project_notebook_record preserves prior records across calls (never a whole-content overwrite)", async () => {
    const { call } = createHarness({ roleId: "supervisor" });
    const first = await call("append_project_notebook_record", {
      record: notebookRecord("record one"),
      expectedRevision: null,
    });
    const second = await call("append_project_notebook_record", {
      record: notebookRecord("record two"),
      expectedRevision: first.revision,
    });
    expect(second.content).toContain("record one");
    expect(second.content).toContain("record two");
  });

  test("rejects a stale expectedRevision instead of racing against a concurrent writer", async () => {
    const { call } = createHarness({ roleId: "supervisor" });
    const staleRead = await call("read_project_notebook");
    await call("append_project_notebook_record", {
      record: notebookRecord("concurrent writer"),
      expectedRevision: staleRead.revision,
    });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("stale retry"),
        expectedRevision: staleRead.revision,
      }),
    ).rejects.toThrow(/stale_notebook/u);
  });

  test("rejects append_project_notebook_record from a caller with no durable notebookGrant at all", async () => {
    const { call } = createHarness({ roleId: "supervisor", establishGrant: null });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/requires a durable notebookGrant/u);
  });

  test("rejects append_project_notebook_record from a role-bound Peer (no notebookGrant is ever issued to a Peer)", async () => {
    const { call } = createHarness({
      roleId: "peer",
      assignment: assignmentFor({}),
      establishGrant: null,
    });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/requires a durable notebookGrant/u);
  });

  test("a Peer can still read the project notebook", async () => {
    const { call } = createHarness({
      roleId: "peer",
      assignment: assignmentFor({}),
      establishGrant: null,
    });
    const result = await call("read_project_notebook");
    expect(result.status).toBe("missing");
  });

  test("denies append when the caller's own grant has expired", async () => {
    const { call } = createHarness({
      roleId: "supervisor",
      assignment: assignmentFor({
        notebookGrant: { ...GRANT, expiresAt: "2000-01-01T00:00:00.000Z" },
      }),
    });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/notebook_grant_expired/u);
  });

  test("denies append when the live project claim now names a different designated writer (revoked/reassigned)", async () => {
    const { call, projectRoot } = createHarness({ roleId: "supervisor" });
    establishClaim(projectRoot, { ...GRANT, designatedWriterId: "supervisor-2" });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/notebook_grant_writer_conflict/u);
  });

  test("denies append when the live claim's location has been relocated since the grant was issued, even with the same notebookId/writer", async () => {
    const { call, projectRoot } = createHarness({ roleId: "supervisor" });
    establishClaim(projectRoot, { ...GRANT, location: "docs/harness/RELOCATED_NOTEBOOK.md" });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/notebook_grant_relocated/u);
  });

  test("denies append when the live claim's scope has been narrowed since the grant was issued", async () => {
    const { call, projectRoot } = createHarness({ roleId: "supervisor" });
    establishClaim(projectRoot, { ...GRANT, scope: "a narrower re-scoped grant" });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/notebook_grant_scope_narrowed/u);
  });

  test("denies append when the live claim itself has expired, even though the caller's own cached grant has not", async () => {
    const { call, projectRoot } = createHarness({ roleId: "supervisor" });
    establishClaim(projectRoot, { ...GRANT, expiresAt: "2000-01-01T00:00:00.000Z" });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/notebook_grant_revoked/u);
  });

  test("a grantless caller reads against the project's live claim location, not a hardcoded default, when a claim exists", async () => {
    const { call, projectRoot } = createHarness({
      roleId: "peer",
      assignment: assignmentFor({}),
      establishGrant: null,
    });
    establishClaim(projectRoot, { ...GRANT, location: "docs/harness/CUSTOM_LOCATION.md" });
    const result = await call("read_project_notebook");
    expect(result.status).toBe("missing");
    expect(result.designatedWriterId).toBe("supervisor-1");
  });

  test("a grantless pinned reader keeps notebook identity across writer transition and release", async () => {
    const { call, projectRoot } = createHarness({
      roleId: "supervisor",
      assignment: assignmentFor({}),
      establishGrant: null,
    });
    establishClaim(projectRoot, GRANT);
    const first = await call("read_project_notebook");
    expect(first.notebookId).toBe("nb_fixture");
    expect(first.designatedWriterId).toBe("supervisor-1");

    establishClaim(projectRoot, { ...GRANT, designatedWriterId: "supervisor-2" });
    const transitioned = await call("read_project_notebook");
    expect(transitioned.notebookId).toBe(first.notebookId);
    expect(transitioned.designatedWriterId).toBe("supervisor-2");

    const existing = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    const released = writeHarnessProjectMetadata({
      repoRoot: projectRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: {},
      expectedRevision: existing.status === "valid" ? existing.revision : null,
      writerId: "supervisor-2",
    });
    expect(released.ok).toBe(true);
    const afterRelease = await call("read_project_notebook");
    expect(afterRelease.notebookId).toBe(first.notebookId);
    expect(afterRelease.location).toBe(DEFAULT_SUPERVISOR_NOTEBOOK_PATH);
    expect(afterRelease.designatedWriterId).toBeNull();
  });

  test("rejects tool-time use after the registered project root moves", async () => {
    const { call, projectRoot, projectGet } = createHarness({ roleId: "supervisor" });
    const movedRoot = mkdtempSync(join(tmpdir(), "project-notebook-tools-moved-root-"));
    tempDirs.push(movedRoot);
    projectGet.mockResolvedValue({
      projectId: "project-1",
      rootPath: movedRoot,
      archivedAt: null,
    });
    await expect(call("read_project_notebook")).rejects.toThrow(
      /harness_binding_runtime_identity_stale/u,
    );
    expect(projectRoot).not.toBe(movedRoot);
  });

  test("rejects a stale parent binding when tool-time cwd belongs to a registered child project", async () => {
    const harness = createHarness({ roleId: "supervisor" });
    const childRoot = join(harness.projectRoot, "registered-child");
    mkdirSync(childRoot, { recursive: true });
    harness.agent.cwd = childRoot;
    const binding = harness.agent.roleBinding?.harnessBinding;
    if (!binding) throw new Error("test setup did not create a harness binding");
    binding.cwd = childRoot;
    harness.projectList.mockResolvedValue([
      { projectId: "project-1", rootPath: harness.projectRoot, archivedAt: null },
      { projectId: "project-child", rootPath: childRoot, archivedAt: null },
    ]);

    await expect(harness.call("read_project_notebook")).rejects.toThrow(
      /harness_binding_registered_project_mismatch/u,
    );
  });

  test("denies append when the live project claim no longer exists (revoked)", async () => {
    const { call, projectRoot } = createHarness({ roleId: "supervisor" });
    const existing = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    const result = writeHarnessProjectMetadata({
      repoRoot: projectRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: {},
      expectedRevision: existing.status === "valid" ? existing.revision : null,
      writerId: "supervisor-1",
    });
    expect(result.ok).toBe(true);
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/notebook_grant_revoked/u);
  });

  test("denies append when the caller's durable grant no longer matches its currently resolved project", async () => {
    const { call } = createHarness({
      roleId: "supervisor",
      assignment: assignmentFor({ notebookGrant: { ...GRANT, projectId: "some-other-project" } }),
    });
    await expect(
      call("append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/notebook_grant_project_mismatch/u);
  });

  test("expired assignment blocks every notebook tool call", async () => {
    const { call } = createHarness({
      roleId: "supervisor",
      assignment: assignmentFor({ notebookGrant: GRANT, expiresAt: "2000-01-01T00:00:00.000Z" }),
    });
    await expect(call("read_project_notebook")).rejects.toThrow(/expired/u);
  });
});
