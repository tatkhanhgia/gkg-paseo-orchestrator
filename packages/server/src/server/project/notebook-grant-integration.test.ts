import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";

import type { AgentStorage } from "../agent/agent-storage.js";
import {
  assertPersistedRoleAdmissionCurrent,
  type PersistedRoleBinding,
} from "../agent/role-binding.js";
import { createDefaultSlpBundledPolicyRegistry } from "../policy/bundled/slp.js";
import { materializeTrustedRoleBinding } from "../policy/trusted-policy.js";
import { buildWorkspaceProtocolTemplate } from "../../utils/workspace-protocol-file.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { createNotebookGrantResolver } from "./notebook-grant-resolver.js";
import { registerProjectNotebookTools } from "./project-notebook-tools.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";

/**
 * Proves the real SLP ROLE-ADMISSION path only: `materializeTrustedRoleBinding`
 * (the exact production entrypoint every launched agent's role binding goes
 * through) resolving a durable `notebookGrant` through the real
 * `createNotebookGrantResolver`, against a real `PersistedRoleBinding` (not a
 * hand-built fixture). Every assertion below reads a value that admission
 * path actually computed — no forged success receipts.
 *
 * NOT proven here: provider MCP transport. `registerToolsFor` below calls
 * `registerProjectNotebookTools` directly and invokes the captured handler
 * functions — it does NOT go through `createPaseoToolCatalog`, provider tool
 * intersection (`applyRolePaseoToolPolicy`), or an actual MCP request/response
 * round trip. That remains a real, separate gap (tracked on tm5), not
 * something this file's "real"/"native" language should be read to cover.
 * Likewise "resume" here means calling `materializeTrustedRoleBinding` twice
 * with the same `agentId` — it is not an `AgentManager` session-resume flow.
 */

const BINDING_CWD = mkdtempSync(join(tmpdir(), "notebook-grant-integration-binding-"));
writeFileSync(
  join(BINDING_CWD, "WORKSPACE_PROTOCOL.md"),
  buildWorkspaceProtocolTemplate(BINDING_CWD),
  "utf8",
);
afterAll(() => rmSync(BINDING_CWD, { recursive: true, force: true }));

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRegistries(projectRoot: string): {
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  projectRegistry: Pick<ProjectRegistry, "get" | "list">;
} {
  return {
    workspaceRegistry: {
      get: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        projectId: "project-1",
        cwd: BINDING_CWD,
        archivedAt: null,
      }),
    },
    projectRegistry: {
      get: vi.fn().mockResolvedValue({
        projectId: "project-1",
        rootPath: projectRoot,
        archivedAt: null,
      }),
      list: vi.fn().mockResolvedValue([
        {
          projectId: "project-1",
          rootPath: projectRoot,
          archivedAt: null,
        },
      ]),
    },
  };
}

function supervisorEnvelope(
  notebookGrant?: AssignmentEnvelope["notebookGrant"],
): AssignmentEnvelope {
  return {
    version: 1,
    disposition: "supervision",
    objective: "Coordinate Peer work and preserve durable Beads/notebook evidence.",
    effectClass: "delegation",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    evidence: "Return exact coordination evidence.",
    handbackAndStop: "Stop at the bounded coordination handback.",
    ...(notebookGrant ? { notebookGrant } : {}),
  };
}

async function materializeSupervisor(input: {
  agentId: string;
  projectRoot: string;
  notebookGrant?: AssignmentEnvelope["notebookGrant"];
  roleProfilePreferences?: { allowedTools?: readonly string[]; allowedSkills?: readonly string[] };
}): Promise<PersistedRoleBinding> {
  const registry = createDefaultSlpBundledPolicyRegistry();
  const generation = registry.resolveActive("slp");
  const notebookResolver = createNotebookGrantResolver(makeRegistries(input.projectRoot));
  return materializeTrustedRoleBinding(generation, {
    roleId: "supervisor",
    provider: "codex",
    providerSupport: { status: "supported", injectionMethod: "mock-launch-context" },
    cwd: BINDING_CWD,
    workspaceId: "workspace-1",
    assignment: supervisorEnvelope(input.notebookGrant),
    assignmentAssigner: { kind: "human-session" },
    agentId: input.agentId,
    resolveNotebookGrant: notebookResolver,
    resolveHarnessBinding: notebookResolver,
    roleProfilePreferences: input.roleProfilePreferences,
  });
}

interface CapturedTool {
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

function registerToolsFor(
  agentId: string,
  binding: PersistedRoleBinding,
  projectRoot: string,
): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  registerProjectNotebookTools({
    registerTool: (name: string, _config: PaseoToolConfig, handler) => tools.set(name, { handler }),
    agentStorage: {
      get: vi.fn().mockResolvedValue({
        id: agentId,
        cwd: BINDING_CWD,
        workspaceId: "workspace-1",
        roleBinding: binding,
      }),
    } as unknown as AgentStorage,
    ...makeRegistries(projectRoot),
    callerAgentId: agentId,
    roleId: "supervisor",
  });
  return tools;
}

async function call(
  tools: Map<string, CapturedTool>,
  name: string,
  input: unknown = {},
): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  const result = await tool.handler(input, { signal: new AbortController().signal });
  return result.structuredContent as Record<string, unknown>;
}

const REQUEST = { scope: "H3 coordination notes", expiresAt: "2027-01-01T00:00:00.000Z" };

function notebookRecord(observation: string) {
  const recordId = `integration-${observation.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")}`;
  return {
    schemaVersion: 1 as const,
    recordId,
    episode: "notebook-grant-integration-test",
    scope: REQUEST.scope,
    observation,
    evidence: ["notebook-grant-integration.test.ts"],
    suspectedMechanism: {
      status: "supported" as const,
      statement: "The real role admission carried the bounded record authority.",
    },
    impact: "authority" as const,
    questionForLead: "Does the next review preserve the pinned grant?",
    recovery: "Retry only with the revision returned by the prior read.",
    outcome: observation,
    patternStatus: "one-off" as const,
    recommendation: "Preserve the structured record and pinned identity.",
    escalation: "lead" as const,
    currentEpisode: "Observed" as const,
    laterEffect: "Unobserved" as const,
    laterEffectEvidenceRefs: [],
    observedAt: "2026-09-07T00:00:00.000Z",
  };
}

describe("real materialize -> durable notebookGrant -> real tool wiring", () => {
  test("a Supervisor's real materialized binding is provider no-write AND carries an explicit resolved notebook grant", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "notebook-grant-integration-project-"));
    tempDirs.push(projectRoot);

    const binding = await materializeSupervisor({
      agentId: "supervisor-real-1",
      projectRoot,
      notebookGrant: REQUEST,
    });

    expect(binding.assignment?.mutationBoundary.mode).toBe("no-write");
    expect(binding.assignment?.externalEffectBoundary.mode).toBe("denied");
    expect(binding.assignmentContract.receipt.notebookGrant).toMatchObject({
      effect: "notebook-write",
      projectId: "project-1",
      designatedWriterId: "supervisor-real-1",
      scope: REQUEST.scope,
      expiresAt: REQUEST.expiresAt,
    });
    expect(binding.instructions).toContain("Notebook grant: durable write access");
    expect(binding.roleProfile.allowedTools).toContain("append_project_notebook_record");
    expect(binding.roleProfile.allowedTools).toContain("read_project_notebook");
  });

  test("the registered tool handlers (not the provider MCP transport) write to disk under the registered project root using the durably resolved identity", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "notebook-grant-integration-project-"));
    tempDirs.push(projectRoot);

    const binding = await materializeSupervisor({
      agentId: "supervisor-real-2",
      projectRoot,
      notebookGrant: REQUEST,
    });
    const tools = registerToolsFor("supervisor-real-2", binding, projectRoot);

    const readBefore = await call(tools, "read_project_notebook");
    expect(readBefore.status).toBe("missing");

    const appended = await call(tools, "append_project_notebook_record", {
      record: notebookRecord("first durable record"),
      expectedRevision: readBefore.revision,
    });
    expect(appended.status).toBe("valid");
    expect(appended.content).toContain("first durable record");
    expect(appended.revision).toBeTruthy();
  });

  test("a stale expectedRevision is rejected instead of silently racing", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "notebook-grant-integration-project-"));
    tempDirs.push(projectRoot);

    const binding = await materializeSupervisor({
      agentId: "supervisor-real-3",
      projectRoot,
      notebookGrant: REQUEST,
    });
    const tools = registerToolsFor("supervisor-real-3", binding, projectRoot);

    const staleRead = await call(tools, "read_project_notebook");
    await call(tools, "append_project_notebook_record", {
      record: notebookRecord("concurrent writer got here first"),
      expectedRevision: staleRead.revision,
    });

    await expect(
      call(tools, "append_project_notebook_record", {
        record: notebookRecord("stale writer retries blindly"),
        expectedRevision: staleRead.revision,
      }),
    ).rejects.toThrow(/stale_notebook/u);
  });

  test("a second Supervisor for the same project cannot even materialize a conflicting durable grant", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "notebook-grant-integration-project-"));
    tempDirs.push(projectRoot);

    await materializeSupervisor({
      agentId: "supervisor-real-first",
      projectRoot,
      notebookGrant: REQUEST,
    });

    await expect(
      materializeSupervisor({
        agentId: "supervisor-real-second",
        projectRoot,
        notebookGrant: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_writer_conflict/u);
  });

  test("append is denied when the caller's own real binding has no notebookGrant at all", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "notebook-grant-integration-project-"));
    tempDirs.push(projectRoot);

    const binding = await materializeSupervisor({ agentId: "supervisor-real-4", projectRoot });
    expect(binding.assignmentContract.receipt.notebookGrant).toBeUndefined();
    const tools = registerToolsFor("supervisor-real-4", binding, projectRoot);

    await expect(
      call(tools, "append_project_notebook_record", {
        record: notebookRecord("x"),
        expectedRevision: null,
      }),
    ).rejects.toThrow(/requires a durable notebookGrant/u);
  });

  test("a resumed Supervisor with the same agent identity is re-admitted with the same durable grant, and an append does not invalidate the role binding", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "notebook-grant-integration-project-"));
    tempDirs.push(projectRoot);

    const first = await materializeSupervisor({
      agentId: "supervisor-real-resume",
      projectRoot,
      notebookGrant: REQUEST,
    });
    const resumed = await materializeSupervisor({
      agentId: "supervisor-real-resume",
      projectRoot,
      notebookGrant: REQUEST,
    });
    expect(resumed.assignmentContract.receipt.notebookGrant?.notebookId).toBe(
      first.assignmentContract.receipt.notebookGrant?.notebookId,
    );
    expect(resumed.assignmentContract.receipt.notebookGrant?.designatedWriterId).toBe(
      "supervisor-real-resume",
    );

    const tools = registerToolsFor("supervisor-real-resume", resumed, projectRoot);
    await call(tools, "append_project_notebook_record", {
      record: notebookRecord("resume survives"),
      expectedRevision: null,
    });

    expect(() => assertPersistedRoleAdmissionCurrent(resumed, BINDING_CWD)).not.toThrow();
  });

  test("a materialize call that requests a notebookGrant but fails a LATER admission check (invalid role profile) never durably writes a claim", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "notebook-grant-integration-project-"));
    tempDirs.push(projectRoot);

    await expect(
      materializeSupervisor({
        agentId: "supervisor-real-never-launches",
        projectRoot,
        notebookGrant: REQUEST,
        // Outside the Foundation ceiling: role-profile materialization throws,
        // and it runs AFTER notebook grant resolution used to run. If the
        // grant were still resolved first, this rejected launch would have
        // already left a permanent writer claim on disk.
        roleProfilePreferences: { allowedTools: ["not_a_real_tool"] },
      }),
    ).rejects.toThrow(/outside the Foundation ceiling/u);

    const { inspectHarnessProjectMetadata } = await import("./harness-project-metadata-file.js");
    const { DEFAULT_HARNESS_PROJECT_METADATA_PATH } =
      await import("./harness-bootstrap-defaults.js");
    const metadata = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(metadata.status).toBe("missing");

    // The SAME agent can now materialize successfully with a valid profile,
    // proving the earlier rejection left no stale/partial claim behind to
    // conflict with a real subsequent launch.
    const succeeded = await materializeSupervisor({
      agentId: "supervisor-real-never-launches",
      projectRoot,
      notebookGrant: REQUEST,
    });
    expect(succeeded.assignmentContract.receipt.notebookGrant?.designatedWriterId).toBe(
      "supervisor-real-never-launches",
    );
  });
});
