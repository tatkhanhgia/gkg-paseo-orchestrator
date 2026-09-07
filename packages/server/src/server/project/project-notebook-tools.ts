import { z } from "zod";

import type { NotebookGrantReceipt } from "@getpaseo/protocol/assignment-contract";
import type {
  HarnessBindingReceipt,
  SupervisorNotebookBinding,
} from "@getpaseo/protocol/harness-binding";
import {
  serializeSupervisorNotebookRecord,
  SupervisorNotebookRecordSchema,
} from "@getpaseo/protocol/notebook-record";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

import type { AgentStorage } from "../agent/agent-storage.js";
import type { PersistedAssignmentContract } from "../agent/assignment-contract.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import { ensureValidJson } from "../json-utils.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { resolveRegisteredProjectForWorkspaceCwd } from "./harness-binding-scope.js";
import {
  appendProjectNotebookRecord,
  inspectProjectNotebook,
  type ProjectNotebookRevision,
} from "../../utils/project-notebook-file.js";
import { DEFAULT_HARNESS_PROJECT_METADATA_PATH } from "./harness-bootstrap-defaults.js";
import {
  inspectHarnessProjectMetadata,
  type SupervisorNotebookClaim,
} from "./harness-project-metadata-file.js";

/**
 * Agent-invokable notebook tools (`read_project_notebook`,
 * `append_project_notebook_record`), per the 2026-09-07 pinned Lead decision
 * on tm5, REVISED per the 2026-09-07 Lead verdict on H3: write authority
 * comes from the durable `notebookGrant` receipt resolved at role-binding
 * materialize time (see `notebook-grant-resolver.ts`), not from a caller's
 * role or mutation boundary alone. Every append call ALSO live-revalidates
 * that durable identity against the project's current `.paseo/harness.json`
 * claim — the persisted receipt on this agent's own binding is necessary but
 * not sufficient: a claim can be reassigned to a different Supervisor
 * between this agent's launch and any given call, and that reassignment
 * must be observed, not trusted from a stale in-memory snapshot.
 */

export interface RegisterProjectNotebookToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inputs are parsed by the catalog schema boundary.
      input: any,
      context: PaseoToolExecutionContext,
    ) => Promise<PaseoToolResult>,
  ) => void;
  agentStorage: AgentStorage;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  projectRegistry: Pick<ProjectRegistry, "get" | "list">;
  callerAgentId: string;
  roleId: PaseoRoleId;
}

interface NotebookCaller {
  agentId: string;
  roleId: PaseoRoleId;
  assignment: PersistedAssignmentContract;
  repoRoot: string;
  projectId: string;
  grant: NotebookGrantReceipt | undefined;
  harnessBinding: HarnessBindingReceipt | undefined;
  notebookBinding: SupervisorNotebookBinding | undefined;
}

function toolResult(payload: Record<string, unknown>): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(payload) };
}

function assignmentHasExpired(assignment: PersistedAssignmentContract): boolean {
  const expiresAt = assignment.receipt.expiresAt;
  if (expiresAt === undefined) return false;
  const parsed = Date.parse(expiresAt);
  return !Number.isFinite(parsed) || parsed <= Date.now();
}

/** Fallback read-only location when no durable notebook claim has ever been established. */
const UNGRANTED_READ_LOCATION = "docs/harness/SUPERVISOR_NOTEBOOK.md";

/**
 * Reads the project's current durable notebook claim directly from
 * `.paseo/harness.json`, independent of anything cached on the caller's own
 * assignment receipt. `null` means no claim has ever been established (a
 * legitimate, common state); `unreadable`/`corrupt` fail closed instead of
 * being treated as "no claim" — a caller must never read/act on a fixed
 * default location while the project's actual durable claim is unknown.
 */
function resolveLiveClaim(repoRoot: string): SupervisorNotebookClaim | null {
  const metadata = inspectHarnessProjectMetadata(repoRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH);
  if (metadata.status === "missing") return null;
  if (metadata.status !== "valid") {
    throw new Error(
      `notebook_grant_metadata_${metadata.status}: cannot safely determine the current durable notebook claim for this project`,
    );
  }
  return metadata.metadata.supervisorNotebook ?? null;
}

function assertRuntimeHarnessIdentity(input: {
  agent: { cwd: string; workspaceId?: string };
  workspace: { workspaceId: string; cwd: string };
  project: { projectId: string; rootPath: string };
  binding: HarnessBindingReceipt;
}): void {
  if (!input.binding.workspaceRoot) {
    throw new Error("harness_binding_workspace_root_missing");
  }
  if (
    input.agent.workspaceId !== input.binding.workspaceId ||
    input.workspace.workspaceId !== input.binding.workspaceId ||
    input.workspace.cwd !== input.binding.workspaceRoot ||
    input.project.projectId !== input.binding.projectId ||
    input.project.rootPath !== input.binding.projectRoot ||
    input.agent.cwd !== input.binding.cwd
  ) {
    throw new Error("harness_binding_runtime_identity_stale");
  }
}

async function resolveCaller(
  options: RegisterProjectNotebookToolsOptions,
): Promise<NotebookCaller> {
  const agent = await options.agentStorage.get(options.callerAgentId);
  if (!agent) throw new Error(`Caller agent ${options.callerAgentId} is unavailable`);
  const binding = agent.roleBinding;
  if (!binding) throw new Error("Project notebook tools require a durable Paseo role binding");
  if (binding.roleId !== options.roleId) {
    throw new Error("The caller role changed after its tool catalog was created");
  }
  const assignment = binding.assignmentContract;
  if (!assignment) throw new Error("Project notebook tools require a durable assignment contract");
  if (assignmentHasExpired(assignment)) throw new Error("The caller assignment has expired");
  if (!agent.workspaceId) throw new Error("Project notebook tools require a current workspace");
  const workspace = await options.workspaceRegistry.get(agent.workspaceId);
  if (!workspace || workspace.archivedAt) {
    throw new Error(`Workspace ${agent.workspaceId} is unavailable or archived`);
  }
  const project = await options.projectRegistry.get(workspace.projectId);
  if (!project || project.archivedAt) {
    throw new Error(`Project ${workspace.projectId} is unavailable or archived`);
  }
  const registeredProject = resolveRegisteredProjectForWorkspaceCwd({
    cwd: agent.cwd,
    workspaceRoot: workspace.cwd ?? project.rootPath,
    projectId: project.projectId,
    registeredProjects: await options.projectRegistry.list(),
  });
  if (registeredProject.status === "unresolved") {
    if (registeredProject.reason === "ambiguous_registered_roots") {
      throw new Error("harness_binding_registered_project_ambiguous");
    }
    throw new Error(
      `harness_binding_registered_project_mismatch: cwd '${agent.cwd}' conflicts with the registered topology for project '${project.projectId}'`,
    );
  }
  const harnessBinding = binding.harnessBinding;
  if (harnessBinding) {
    assertRuntimeHarnessIdentity({ agent, workspace, project, binding: harnessBinding });
  }
  const notebookBinding = harnessBinding?.notebook;
  if (binding.roleId === "supervisor" && !notebookBinding) {
    throw new Error(
      "Project notebook tools require a durable Supervisor notebook binding; persisted role binding is incomplete",
    );
  }
  return {
    agentId: options.callerAgentId,
    roleId: binding.roleId,
    assignment,
    repoRoot: project.rootPath,
    projectId: project.projectId,
    grant: assignment.receipt.notebookGrant,
    harnessBinding,
    notebookBinding,
  };
}

/**
 * Every role-bound caller — including one with no durable write grant of its
 * own — reads against the project's actual live claim (identity, location,
 * scope, current designated writer) when one exists, never a fixed default
 * location that could silently diverge from where the real notebook lives.
 */
function resolveReadContext(caller: NotebookCaller): {
  location: string;
  claim: SupervisorNotebookClaim | null;
} {
  const claim = resolveLiveClaim(caller.repoRoot);
  if (caller.notebookBinding) {
    if (!claim) {
      if (caller.notebookBinding.designatedWriterId !== null) {
        throw new Error("harness_binding_notebook_revoked");
      }
      return { location: caller.notebookBinding.location, claim: null };
    }
    if (
      claim.notebookId !== caller.notebookBinding.notebookId ||
      claim.location !== caller.notebookBinding.location
    ) {
      throw new Error("harness_binding_notebook_stale");
    }
    return { location: caller.notebookBinding.location, claim };
  }
  return { location: claim?.location ?? UNGRANTED_READ_LOCATION, claim };
}

/**
 * Authorizes an append using the durable grant only — never role identity or
 * mutation boundary alone — then live-revalidates it against the project's
 * current durable claim in `.paseo/harness.json`. Any drift (no claim, a
 * different notebookId, a different current designated writer, a relocated
 * or rescoped claim, or a claim that has itself been live-expired/revoked)
 * denies, even though the caller's own persisted grant snapshot looks valid.
 */
function requireLiveWriteAuthority(caller: NotebookCaller): NotebookGrantReceipt {
  const grant = caller.grant;
  if (!grant) {
    throw new Error(
      "append_project_notebook_record requires a durable notebookGrant on the caller's own assignment; none is present",
    );
  }
  if (grant.projectId !== caller.projectId) {
    throw new Error(
      "notebook_grant_project_mismatch: the caller's durable grant no longer matches its currently resolved project",
    );
  }
  const grantExpiry = Date.parse(grant.expiresAt);
  if (!Number.isFinite(grantExpiry) || grantExpiry <= Date.now()) {
    throw new Error("notebook_grant_expired: the caller's durable notebook grant has expired");
  }
  const currentClaim = resolveLiveClaim(caller.repoRoot);
  if (!currentClaim) {
    throw new Error(
      "notebook_grant_revoked: no durable notebook claim currently exists for this project",
    );
  }
  if (currentClaim.notebookId !== grant.notebookId) {
    throw new Error("notebook_grant_stale: the project's durable notebook identity has changed");
  }
  if (currentClaim.designatedWriterId !== caller.agentId) {
    throw new Error(
      "notebook_grant_writer_conflict: this project's notebook is currently durably bound to a different Supervisor identity",
    );
  }
  if (currentClaim.location !== grant.location) {
    throw new Error(
      "notebook_grant_relocated: the project's durable notebook location has changed since this grant was issued",
    );
  }
  if (currentClaim.scope !== grant.scope) {
    throw new Error(
      "notebook_grant_scope_narrowed: the project's durable notebook scope has changed since this grant was issued",
    );
  }
  const currentExpiry = Date.parse(currentClaim.expiresAt);
  if (!Number.isFinite(currentExpiry) || currentExpiry <= Date.now()) {
    throw new Error(
      "notebook_grant_revoked: the project's live durable notebook claim has expired",
    );
  }
  if (
    caller.notebookBinding &&
    (caller.notebookBinding.notebookId !== grant.notebookId ||
      caller.notebookBinding.location !== grant.location ||
      caller.notebookBinding.designatedWriterId !== grant.designatedWriterId ||
      caller.notebookBinding.expiresAt !== grant.expiresAt)
  ) {
    throw new Error("harness_binding_notebook_stale");
  }
  return grant;
}

const RevisionSchema = z
  .object({
    mtimeMs: z.number(),
    size: z.number(),
    sha256: z.string(),
  })
  .strict();

const AppendNotebookRecordInputSchema = z
  .object({
    record: SupervisorNotebookRecordSchema,
    expectedRevision: RevisionSchema.nullable(),
  })
  .strict();

function serializeRevision(revision: ProjectNotebookRevision | null): unknown {
  return revision;
}

function resolveNotebookId(
  caller: NotebookCaller,
  claim: SupervisorNotebookClaim | null,
): string | null {
  if (claim) return claim.notebookId;
  if (caller.notebookBinding) return caller.notebookBinding.notebookId;
  if (caller.grant) return caller.grant.notebookId;
  return null;
}

function resolveClaimOrGrantField<T>(input: {
  claim: SupervisorNotebookClaim | null;
  claimValue: (claim: SupervisorNotebookClaim) => T;
  grant: NotebookGrantReceipt | undefined;
  grantValue: (grant: NotebookGrantReceipt) => T;
}): T | null {
  if (input.claim) return input.claimValue(input.claim);
  if (input.grant) return input.grantValue(input.grant);
  return null;
}

function notebookAuthorityFields(
  caller: NotebookCaller,
  claim: SupervisorNotebookClaim | null,
): Record<string, unknown> {
  const binding = caller.notebookBinding;
  return {
    notebookId: resolveNotebookId(caller, claim),
    projectScope: binding ? binding.projectScope : null,
    reportingTarget: binding ? binding.reportingTarget : null,
    scope: resolveClaimOrGrantField({
      claim,
      claimValue: (value) => value.scope,
      grant: caller.grant,
      grantValue: (value) => value.scope,
    }),
    designatedWriterId: claim ? claim.designatedWriterId : null,
    expiresAt: resolveClaimOrGrantField({
      claim,
      claimValue: (value) => value.expiresAt,
      grant: caller.grant,
      grantValue: (value) => value.expiresAt,
    }),
  };
}

function readNotebookToolPayload(input: {
  caller: NotebookCaller;
  location: string;
  claim: SupervisorNotebookClaim | null;
  snapshot: ReturnType<typeof inspectProjectNotebook>;
}): Record<string, unknown> {
  const { caller, location, claim, snapshot } = input;
  return {
    projectId: caller.projectId,
    location,
    ...notebookAuthorityFields(caller, claim),
    status: snapshot.status,
    content: snapshot.status === "valid" ? snapshot.content : null,
    revision: snapshot.status === "valid" ? serializeRevision(snapshot.revision) : null,
  };
}

export function registerProjectNotebookTools(options: RegisterProjectNotebookToolsOptions): void {
  options.registerTool(
    "read_project_notebook",
    {
      title: "Read project notebook",
      description:
        "Read the current content and revision of the durable Supervisor coordination notebook for the caller's registered project. Pass the returned revision back into append_project_notebook_record as expectedRevision.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const caller = await resolveCaller(options);
      const { location, claim } = resolveReadContext(caller);
      const snapshot = inspectProjectNotebook(caller.repoRoot, location);
      return toolResult(readNotebookToolPayload({ caller, location, claim, snapshot }));
    },
  );

  options.registerTool(
    "append_project_notebook_record",
    {
      title: "Append project notebook record",
      description:
        "Append one schema-valid structured record to the caller's registered project's Supervisor notebook. Requires the exact expectedRevision from the most recent read_project_notebook call (or null if it read as missing) so a stale append is rejected instead of silently racing. History-preserving: never overwrites or drops an existing record.",
      inputSchema: AppendNotebookRecordInputSchema,
    },
    async ({ record, expectedRevision }) => {
      const caller = await resolveCaller(options);
      const grant = requireLiveWriteAuthority(caller);
      const result = appendProjectNotebookRecord({
        repoRoot: caller.repoRoot,
        relativePath: grant.location,
        recordContent: serializeSupervisorNotebookRecord(record),
        callerId: caller.agentId,
        designatedWriterId: grant.designatedWriterId,
        expectedRevision,
      });
      if (!result.ok) {
        if (result.error.code === "stale_notebook") {
          throw new Error(
            "append_project_notebook_record failed: stale_notebook — re-read the notebook and retry with its current revision",
          );
        }
        throw new Error(`append_project_notebook_record failed: ${result.error.code}`);
      }
      return toolResult({
        projectId: caller.projectId,
        notebookId: grant.notebookId,
        location: grant.location,
        projectScope: caller.notebookBinding?.projectScope ?? null,
        reportingTarget: caller.notebookBinding?.reportingTarget ?? null,
        recordId: record.recordId,
        status: result.snapshot.status,
        content: result.snapshot.content,
        revision: serializeRevision(result.snapshot.revision),
      });
    },
  );
}
