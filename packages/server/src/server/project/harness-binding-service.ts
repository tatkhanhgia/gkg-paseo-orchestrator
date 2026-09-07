import { createHash } from "node:crypto";

import type {
  HarnessBindingContext,
  HarnessBindingReceipt,
  SupervisorNotebookBinding,
} from "@getpaseo/protocol/harness-binding";
import {
  NotebookGrantRequestSchema,
  type NotebookGrantReceipt,
  type NotebookGrantRequest,
} from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";
import type {
  ProjectHarnessFileRevision,
  ProjectHarnessNotebookReleaseResult,
} from "@getpaseo/protocol/project-harness/rpc-schemas";

import { isRealpathInsideRoot } from "../../utils/path.js";
import { inspectProjectNotebook } from "../../utils/project-notebook-file.js";
import {
  applyProjectHarnessFileTransaction,
  inspectProjectHarnessFile,
} from "../../utils/project-harness-file-transaction.js";
import type {
  PersistedProjectRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import { resolveRegisteredProjectForWorkspaceCwd } from "./harness-binding-scope.js";
import {
  DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  DEFAULT_SUPERVISOR_NOTEBOOK_PATH,
} from "./harness-bootstrap-defaults.js";
import {
  inspectHarnessProjectMetadata,
  writeHarnessProjectMetadata,
  type HarnessProjectMetadata,
  type SupervisorNotebookClaim,
  type SupervisorNotebookIdentity,
} from "./harness-project-metadata-file.js";

export interface HarnessBindingResolutionInput {
  agentId: string;
  roleId: PaseoRoleId;
  workspaceId: string;
  cwd: string;
  request?: NotebookGrantRequest;
}

export interface PreparedHarnessBinding {
  context: HarnessBindingContext;
  notebookGrant?: NotebookGrantReceipt;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface HarnessBindingCurrentInput {
  binding: HarnessBindingReceipt;
}

export interface NotebookReleaseInput {
  projectId: string;
  workspaceId: string;
  cwd: string;
  notebookId: string;
  location: string;
  designatedWriterId: string;
  expectedRevision: ProjectHarnessFileRevision;
  /** Server-internal synchronous revalidation run while the project transaction queue is held. */
  revalidate?: () => void;
}

export interface NotebookRebindInput {
  workspaceId: string;
  currentWriterId: string;
  newWriterId: string;
  scope: string;
  expiresAt: string;
}

export interface HarnessBindingResolver {
  prepare(input: HarnessBindingResolutionInput): Promise<PreparedHarnessBinding>;
  assertCurrent(input: HarnessBindingCurrentInput): Promise<void>;
  release(input: NotebookReleaseInput): Promise<ProjectHarnessNotebookReleaseResult>;
  rebind(input: NotebookRebindInput): Promise<NotebookGrantReceipt>;
}

export interface HarnessBindingServiceDependencies {
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  projectRegistry: Pick<ProjectRegistry, "get" | "list">;
  /** Test-only transaction pause; production callers leave this unset. */
  testing?: { beforeFirstRename?: () => void | Promise<void> };
}

function notebookIdFor(projectId: string, location: string): string {
  return `nb_${createHash("sha256").update(`${projectId}:${location}`).digest("hex").slice(0, 24)}`;
}

function reportingTargetFor(projectId: string): string {
  return `project:${projectId}:supervisor-notebook`;
}

function projectScopeFor(projectId: string): string {
  return `project:${projectId}`;
}

function identityFromClaim(claim: SupervisorNotebookClaim): SupervisorNotebookIdentity {
  return { notebookId: claim.notebookId, location: claim.location };
}

function claimToNotebookBinding(
  projectId: string,
  claim: SupervisorNotebookClaim | undefined,
  identity: SupervisorNotebookIdentity | undefined,
  includeWriterLease: boolean,
): SupervisorNotebookBinding {
  const notebookIdentity = identity ?? (claim ? identityFromClaim(claim) : undefined);
  const location = notebookIdentity?.location ?? DEFAULT_SUPERVISOR_NOTEBOOK_PATH;
  return {
    notebookId: notebookIdentity?.notebookId ?? notebookIdFor(projectId, location),
    location,
    projectScope: projectScopeFor(projectId),
    reportingTarget: reportingTargetFor(projectId),
    designatedWriterId: includeWriterLease ? (claim?.designatedWriterId ?? null) : null,
    expiresAt: includeWriterLease ? (claim?.expiresAt ?? null) : null,
  };
}

function assertFutureNotebookExpiry(expiresAt: string): void {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) {
    throw new Error("notebook_grant_expiry_not_future");
  }
}

function grantFromClaim(input: {
  projectId: string;
  claim: SupervisorNotebookClaim;
  request: NotebookGrantRequest;
}): NotebookGrantReceipt {
  return {
    effect: "notebook-write",
    notebookId: input.claim.notebookId,
    location: input.claim.location,
    projectId: input.projectId,
    scope: input.request.scope,
    designatedWriterId: input.claim.designatedWriterId,
    expiresAt: input.request.expiresAt,
  };
}

function claimForRequest(input: {
  projectId: string;
  agentId: string;
  request: NotebookGrantRequest;
  existing?: SupervisorNotebookClaim;
  identity?: SupervisorNotebookIdentity;
}): SupervisorNotebookClaim {
  const location =
    input.existing?.location ?? input.identity?.location ?? DEFAULT_SUPERVISOR_NOTEBOOK_PATH;
  return {
    notebookId:
      input.existing?.notebookId ??
      input.identity?.notebookId ??
      notebookIdFor(input.projectId, location),
    location,
    designatedWriterId: input.agentId,
    scope: input.request.scope,
    expiresAt: input.request.expiresAt,
    establishedAt: input.existing?.establishedAt ?? new Date().toISOString(),
  };
}

function sameClaim(
  left: SupervisorNotebookClaim | undefined,
  right: SupervisorNotebookClaim,
): boolean {
  return (
    left?.notebookId === right.notebookId &&
    left.location === right.location &&
    left.designatedWriterId === right.designatedWriterId &&
    left.scope === right.scope &&
    left.expiresAt === right.expiresAt &&
    left.establishedAt === right.establishedAt
  );
}

function sameFileRevision(
  left: ProjectHarnessFileRevision,
  right: ProjectHarnessFileRevision,
): boolean {
  return (
    left.status === right.status &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.symlinkTarget === right.symlinkTarget
  );
}

function serializeMetadata(metadata: HarnessProjectMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function metadataWithClaim(
  snapshot: ReturnType<typeof inspectHarnessProjectMetadata>,
  claim: SupervisorNotebookClaim | undefined,
  identity?: SupervisorNotebookIdentity,
): HarnessProjectMetadata {
  const base = snapshot.status === "valid" ? snapshot.metadata : {};
  const durableIdentity =
    identity ?? base.supervisorNotebookIdentity ?? (claim ? identityFromClaim(claim) : undefined);
  return {
    ...base,
    ...(durableIdentity ? { supervisorNotebookIdentity: durableIdentity } : {}),
    ...(claim ? { supervisorNotebook: claim } : { supervisorNotebook: undefined }),
  };
}

function assertWorkspaceCwd(input: {
  workspaceCwd: string | undefined;
  projectRoot: string;
  cwd: string;
  workspaceId: string;
}): void {
  const authorityRoot = input.workspaceCwd ?? input.projectRoot;
  if (!isRealpathInsideRoot(authorityRoot, input.cwd)) {
    throw new Error(
      `harness_binding_cwd_mismatch: cwd '${input.cwd}' is outside registered workspace '${input.workspaceId}'`,
    );
  }
}

function assertRegisteredProjectForWorkspaceCwd(input: {
  cwd: string;
  workspaceRoot: string;
  projectId: string;
  registeredProjects: readonly PersistedProjectRecord[];
}): void {
  const resolution = resolveRegisteredProjectForWorkspaceCwd(input);
  if (resolution.status === "unresolved") {
    if (resolution.reason === "ambiguous_registered_roots") {
      throw new Error("harness_binding_registered_project_ambiguous");
    }
    throw new Error(
      `harness_binding_registered_project_mismatch: cwd '${input.cwd}' conflicts with the registered topology for project '${input.projectId}'`,
    );
  }
}

function assertNotebookLocationSafe(projectRoot: string, location: string): void {
  if (inspectProjectNotebook(projectRoot, location).status === "unreadable") {
    throw new Error("harness_binding_notebook_location_unsafe");
  }
}

type ValidHarnessProjectMetadata = Extract<
  ReturnType<typeof inspectHarnessProjectMetadata>,
  { status: "valid" }
>;

async function resolveNotebookReleaseTarget(
  dependencies: HarnessBindingServiceDependencies,
  input: NotebookReleaseInput,
) {
  const workspace = await dependencies.workspaceRegistry.get(input.workspaceId);
  if (!workspace || workspace.archivedAt) {
    throw new Error(`notebook_release_workspace_unavailable: ${input.workspaceId}`);
  }
  if (workspace.projectId !== input.projectId) {
    throw new Error("notebook_release_project_mismatch");
  }
  const project = await dependencies.projectRegistry.get(workspace.projectId);
  if (!project || project.archivedAt) throw new Error("notebook_release_project_unavailable");
  assertRegisteredProjectForWorkspaceCwd({
    cwd: input.cwd,
    workspaceRoot: workspace.cwd ?? project.rootPath,
    projectId: project.projectId,
    registeredProjects: await dependencies.projectRegistry.list(),
  });
  assertWorkspaceCwd({
    workspaceCwd: workspace.cwd,
    projectRoot: project.rootPath,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
  });
  return { workspace, project };
}

function assertReleaseMetadataRevision(
  metadataFile: ReturnType<typeof inspectProjectHarnessFile>,
  input: NotebookReleaseInput,
): void {
  if (
    metadataFile.revision.status !== "regular" ||
    metadataFile.content === undefined ||
    input.expectedRevision.status !== "regular" ||
    !sameFileRevision(metadataFile.revision, input.expectedRevision)
  ) {
    throw new Error("notebook_release_stale_metadata");
  }
}

function resolveNotebookReleaseClaim(
  metadata: ValidHarnessProjectMetadata,
  input: NotebookReleaseInput,
  projectRoot: string,
): SupervisorNotebookClaim {
  const claim = metadata.metadata.supervisorNotebook;
  if (!claim) throw new Error("notebook_release_claim_missing");
  if (claim.notebookId !== input.notebookId || claim.location !== input.location) {
    throw new Error("notebook_release_notebook_identity_mismatch");
  }
  if (claim.designatedWriterId !== input.designatedWriterId) {
    throw new Error("notebook_release_writer_conflict");
  }
  const configuredIdentity = metadata.metadata.supervisorNotebookIdentity;
  if (
    configuredIdentity &&
    (configuredIdentity.notebookId !== claim.notebookId ||
      configuredIdentity.location !== claim.location)
  ) {
    throw new Error("notebook_release_notebook_identity_mismatch");
  }
  assertNotebookLocationSafe(projectRoot, claim.location);
  return claim;
}

function assertReleaseMetadata(
  projectRoot: string,
  input: NotebookReleaseInput,
): {
  metadata: ValidHarnessProjectMetadata;
  metadataFile: ReturnType<typeof inspectProjectHarnessFile>;
  claim: SupervisorNotebookClaim;
} {
  const metadata = inspectHarnessProjectMetadata(
    projectRoot,
    DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  );
  if (metadata.status === "missing") throw new Error("notebook_release_claim_missing");
  if (metadata.status !== "valid") throw new Error("notebook_release_metadata_unreadable");
  const metadataFile = inspectProjectHarnessFile(
    projectRoot,
    DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  );
  assertReleaseMetadataRevision(metadataFile, input);
  const claim = resolveNotebookReleaseClaim(metadata, input, projectRoot);
  return { metadata, metadataFile, claim };
}

async function commitNotebookRelease(input: {
  projectRoot: string;
  metadata: ValidHarnessProjectMetadata;
  metadataFile: ReturnType<typeof inspectProjectHarnessFile>;
  claim: SupervisorNotebookClaim;
  revalidate?: () => void;
  testing?: HarnessBindingServiceDependencies["testing"];
}): Promise<ProjectHarnessFileRevision> {
  const transaction = await applyProjectHarnessFileTransaction({
    rootPath: input.projectRoot,
    guards: [
      { path: DEFAULT_HARNESS_PROJECT_METADATA_PATH, expected: input.metadataFile.revision },
    ],
    writes: [
      {
        path: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
        expected: input.metadataFile.revision,
        content: serializeMetadata(
          metadataWithClaim(input.metadata, undefined, identityFromClaim(input.claim)),
        ),
      },
    ],
    beforeCommit: input.revalidate,
    beforeFirstRename: input.revalidate,
    testing: input.testing,
  });
  if (!transaction.ok) {
    if (transaction.error.code === "conflict") {
      throw new Error("notebook_release_stale_metadata");
    }
    if (transaction.error.code === "recovery_required") {
      throw new Error("notebook_release_recovery_required");
    }
    throw new Error("notebook_release_failed");
  }
  const readbackFile = inspectProjectHarnessFile(
    input.projectRoot,
    DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  );
  const readback = inspectHarnessProjectMetadata(
    input.projectRoot,
    DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  );
  if (
    readbackFile.revision.status !== "regular" ||
    readback.status !== "valid" ||
    readback.metadata.supervisorNotebook !== undefined ||
    readback.metadata.supervisorNotebookIdentity?.notebookId !== input.claim.notebookId ||
    readback.metadata.supervisorNotebookIdentity?.location !== input.claim.location
  ) {
    throw new Error("notebook_release_readback_failed");
  }
  return readbackFile.revision;
}

function assertMetadataReadable(
  metadataSnapshot: ReturnType<typeof inspectHarnessProjectMetadata>,
  projectId: string,
): void {
  if (metadataSnapshot.status === "unreadable" || metadataSnapshot.status === "corrupt") {
    throw new Error(
      `harness_binding_metadata_${metadataSnapshot.status}: cannot safely determine the current durable notebook claim for project ${projectId}`,
    );
  }
}

interface NotebookClaimPreparation {
  existingClaim?: SupervisorNotebookClaim;
  durableIdentity?: SupervisorNotebookIdentity;
  nextClaim?: SupervisorNotebookClaim;
  notebook?: SupervisorNotebookBinding;
  notebookGrant?: NotebookGrantReceipt;
  mustCommit: boolean;
}

function resolveDurableNotebookIdentity(
  metadataSnapshot: ReturnType<typeof inspectHarnessProjectMetadata>,
  existingClaim: SupervisorNotebookClaim | undefined,
): SupervisorNotebookIdentity | undefined {
  if (metadataSnapshot.status !== "valid") return undefined;
  return (
    metadataSnapshot.metadata.supervisorNotebookIdentity ??
    (existingClaim ? identityFromClaim(existingClaim) : undefined)
  );
}

function assertNotebookRequestAllowed(input: {
  agentId: string;
  roleId: PaseoRoleId;
  projectId: string;
  request?: NotebookGrantRequest;
  existingClaim?: SupervisorNotebookClaim;
}): void {
  if (!input.request) return;
  if (input.agentId.trim().length === 0) {
    throw new Error("notebook_grant_writer_identity_missing");
  }
  if (input.roleId !== "supervisor") {
    throw new Error("notebook_grant_requires_supervisor_role");
  }
  if (input.existingClaim && input.existingClaim.designatedWriterId !== input.agentId) {
    throw new Error(
      `notebook_grant_writer_conflict: project ${input.projectId} notebook is already durably bound to a different Supervisor identity`,
    );
  }
}

function resolveNextNotebookClaim(input: {
  projectId: string;
  agentId: string;
  request?: NotebookGrantRequest;
  existingClaim?: SupervisorNotebookClaim;
  durableIdentity?: SupervisorNotebookIdentity;
}): SupervisorNotebookClaim | undefined {
  if (!input.request) return undefined;
  return claimForRequest({
    projectId: input.projectId,
    agentId: input.agentId,
    request: input.request,
    existing: input.existingClaim,
    identity: input.durableIdentity,
  });
}

function resolveNotebookLocation(input: {
  nextClaim?: SupervisorNotebookClaim;
  existingClaim?: SupervisorNotebookClaim;
  durableIdentity?: SupervisorNotebookIdentity;
}): string {
  return (
    input.nextClaim?.location ??
    input.existingClaim?.location ??
    input.durableIdentity?.location ??
    DEFAULT_SUPERVISOR_NOTEBOOK_PATH
  );
}

function resolveNotebookBinding(input: {
  roleId: PaseoRoleId;
  projectId: string;
  nextClaim?: SupervisorNotebookClaim;
  existingClaim?: SupervisorNotebookClaim;
  durableIdentity?: SupervisorNotebookIdentity;
  hasWriterRequest: boolean;
}): SupervisorNotebookBinding | undefined {
  if (input.roleId !== "supervisor") return undefined;
  return claimToNotebookBinding(
    input.projectId,
    input.nextClaim ?? input.existingClaim,
    input.durableIdentity,
    input.hasWriterRequest,
  );
}

function resolveNotebookGrant(input: {
  projectId: string;
  request?: NotebookGrantRequest;
  nextClaim?: SupervisorNotebookClaim;
}): NotebookGrantReceipt | undefined {
  if (!input.request || !input.nextClaim) return undefined;
  return grantFromClaim({
    projectId: input.projectId,
    claim: input.nextClaim,
    request: input.request,
  });
}

function prepareNotebookClaim(input: {
  agentId: string;
  roleId: PaseoRoleId;
  projectId: string;
  projectRoot: string;
  request?: NotebookGrantRequest;
  metadataSnapshot: ReturnType<typeof inspectHarnessProjectMetadata>;
}): NotebookClaimPreparation {
  const { metadataSnapshot, request } = input;
  assertMetadataReadable(metadataSnapshot, input.projectId);

  const existingClaim =
    metadataSnapshot.status === "valid" ? metadataSnapshot.metadata.supervisorNotebook : undefined;
  const durableIdentity = resolveDurableNotebookIdentity(metadataSnapshot, existingClaim);
  assertNotebookRequestAllowed({
    agentId: input.agentId,
    roleId: input.roleId,
    projectId: input.projectId,
    request,
    existingClaim,
  });
  const nextClaim = resolveNextNotebookClaim({
    projectId: input.projectId,
    agentId: input.agentId,
    request,
    existingClaim,
    durableIdentity,
  });
  assertNotebookLocationSafe(
    input.projectRoot,
    resolveNotebookLocation({
      nextClaim,
      existingClaim,
      durableIdentity,
    }),
  );
  const notebook = resolveNotebookBinding({
    roleId: input.roleId,
    projectId: input.projectId,
    nextClaim,
    existingClaim,
    durableIdentity,
    hasWriterRequest: Boolean(request),
  });
  const notebookGrant = resolveNotebookGrant({ projectId: input.projectId, request, nextClaim });
  return {
    existingClaim,
    durableIdentity,
    nextClaim,
    notebook,
    notebookGrant,
    mustCommit: Boolean(nextClaim && !sameClaim(existingClaim, nextClaim)),
  };
}

function assertProjectIdentity(input: {
  binding: HarnessBindingReceipt;
  workspace: { projectId: string; archivedAt: string | null };
  project: { projectId: string; rootPath: string; archivedAt: string | null };
}): void {
  if (
    input.workspace.archivedAt ||
    input.workspace.projectId !== input.binding.projectId ||
    input.project.archivedAt ||
    input.project.rootPath !== input.binding.projectRoot
  ) {
    throw new Error("harness_binding_project_identity_stale");
  }
}

function assertNotebookIdentity(binding: SupervisorNotebookBinding, projectId: string): void {
  if (
    binding.projectScope !== projectScopeFor(projectId) ||
    binding.reportingTarget !== reportingTargetFor(projectId)
  ) {
    throw new Error("harness_binding_notebook_identity_stale");
  }
}

function assertLiveNotebookClaim(
  binding: SupervisorNotebookBinding,
  liveClaim: SupervisorNotebookClaim | undefined,
): void {
  if (!liveClaim) {
    if (binding.designatedWriterId !== null || binding.expiresAt !== null) {
      throw new Error("harness_binding_notebook_revoked");
    }
    return;
  }
  if (liveClaim.notebookId !== binding.notebookId || liveClaim.location !== binding.location) {
    throw new Error("harness_binding_notebook_stale");
  }
  if (binding.designatedWriterId === null && binding.expiresAt === null) return;
  if (
    liveClaim.designatedWriterId !== binding.designatedWriterId ||
    liveClaim.expiresAt !== binding.expiresAt
  ) {
    throw new Error("harness_binding_notebook_stale");
  }
  const expiry = Date.parse(liveClaim.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error("harness_binding_notebook_expired");
  }
}

export function createProjectHarnessBindingService(
  dependencies: HarnessBindingServiceDependencies,
): HarnessBindingResolver {
  async function resolveProject(input: HarnessBindingResolutionInput) {
    const workspace = await dependencies.workspaceRegistry.get(input.workspaceId);
    if (!workspace || workspace.archivedAt) {
      throw new Error(`harness_binding_workspace_unavailable: ${input.workspaceId}`);
    }
    const project = await dependencies.projectRegistry.get(workspace.projectId);
    if (!project || project.archivedAt) {
      throw new Error(`harness_binding_project_unavailable: ${workspace.projectId}`);
    }
    assertRegisteredProjectForWorkspaceCwd({
      cwd: input.cwd,
      workspaceRoot: workspace.cwd ?? project.rootPath,
      projectId: project.projectId,
      registeredProjects: await dependencies.projectRegistry.list(),
    });
    assertWorkspaceCwd({
      workspaceCwd: workspace.cwd,
      projectRoot: project.rootPath,
      cwd: input.cwd,
      workspaceId: input.workspaceId,
    });
    return { workspace, project };
  }

  async function prepare(input: HarnessBindingResolutionInput): Promise<PreparedHarnessBinding> {
    const request = input.request ? NotebookGrantRequestSchema.parse(input.request) : undefined;
    if (request) assertFutureNotebookExpiry(request.expiresAt);
    const { project, workspace } = await resolveProject(input);
    const metadataSnapshot = inspectHarnessProjectMetadata(
      project.rootPath,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    const { existingClaim, durableIdentity, nextClaim, notebook, notebookGrant, mustCommit } =
      prepareNotebookClaim({
        agentId: input.agentId,
        roleId: input.roleId,
        projectId: project.projectId,
        projectRoot: project.rootPath,
        request,
        metadataSnapshot,
      });
    const context: HarnessBindingContext = {
      projectId: project.projectId,
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.cwd ?? project.rootPath,
      projectRoot: project.rootPath,
      cwd: input.cwd,
      ...(notebook ? { notebook } : {}),
    };
    let committedSnapshot: Extract<
      ReturnType<typeof inspectHarnessProjectMetadata>,
      { status: "valid" }
    > | null = null;
    let committed = false;

    return {
      context,
      ...(notebookGrant ? { notebookGrant } : {}),
      async commit() {
        if (!mustCommit || committed) return;
        const result = writeHarnessProjectMetadata({
          repoRoot: project.rootPath,
          relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
          metadata: metadataWithClaim(metadataSnapshot, nextClaim, durableIdentity),
          expectedRevision: metadataSnapshot.status === "valid" ? metadataSnapshot.revision : null,
          writerId: input.agentId,
        });
        if (!result.ok) {
          throw new Error(`notebook_grant_commit_failed: ${result.error.code}`);
        }
        committedSnapshot = result.snapshot;
        committed = true;
      },
      async rollback() {
        if (!committed || !committedSnapshot) return;
        const current = inspectHarnessProjectMetadata(
          project.rootPath,
          DEFAULT_HARNESS_PROJECT_METADATA_PATH,
        );
        if (
          current.status !== "valid" ||
          current.revision.sha256 !== committedSnapshot.revision.sha256 ||
          current.revision.size !== committedSnapshot.revision.size
        ) {
          throw new Error(
            "notebook_grant_rollback_conflict: durable metadata changed after commit",
          );
        }
        const restored = writeHarnessProjectMetadata({
          repoRoot: project.rootPath,
          relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
          metadata: metadataWithClaim(metadataSnapshot, existingClaim, durableIdentity),
          expectedRevision: current.revision,
          writerId: input.agentId,
        });
        if (!restored.ok) {
          throw new Error(`notebook_grant_rollback_failed: ${restored.error.code}`);
        }
        committed = false;
      },
    };
  }

  async function assertCurrent(input: HarnessBindingCurrentInput): Promise<void> {
    const workspace = await dependencies.workspaceRegistry.get(input.binding.workspaceId);
    if (!workspace) {
      throw new Error("harness_binding_project_identity_stale");
    }
    const project = await dependencies.projectRegistry.get(input.binding.projectId);
    if (!project) {
      throw new Error("harness_binding_project_identity_stale");
    }
    assertRegisteredProjectForWorkspaceCwd({
      cwd: input.binding.cwd,
      workspaceRoot: workspace.cwd ?? project.rootPath,
      projectId: project.projectId,
      registeredProjects: await dependencies.projectRegistry.list(),
    });
    assertProjectIdentity({ binding: input.binding, workspace, project });
    const workspaceRoot = workspace.cwd ?? project.rootPath;
    if (!input.binding.workspaceRoot) {
      throw new Error("harness_binding_workspace_root_missing");
    }
    if (input.binding.workspaceRoot !== workspaceRoot) {
      throw new Error("harness_binding_workspace_root_stale");
    }
    if (!isRealpathInsideRoot(input.binding.workspaceRoot, input.binding.cwd)) {
      throw new Error("harness_binding_cwd_stale");
    }
    if (!input.binding.notebook) return;
    assertNotebookIdentity(input.binding.notebook, project.projectId);
    const metadata = inspectHarnessProjectMetadata(
      project.rootPath,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    if (metadata.status === "unreadable" || metadata.status === "corrupt") {
      throw new Error(`harness_binding_metadata_${metadata.status}`);
    }
    const liveClaim =
      metadata.status === "valid" ? metadata.metadata.supervisorNotebook : undefined;
    assertLiveNotebookClaim(input.binding.notebook, liveClaim);
  }

  async function release(
    input: NotebookReleaseInput,
  ): Promise<ProjectHarnessNotebookReleaseResult> {
    const { workspace, project } = await resolveNotebookReleaseTarget(dependencies, input);
    const { metadata, metadataFile, claim } = assertReleaseMetadata(project.rootPath, input);
    const metadataRevision = await commitNotebookRelease({
      projectRoot: project.rootPath,
      metadata,
      metadataFile,
      claim,
      revalidate: input.revalidate,
      testing: dependencies.testing,
    });
    return {
      projectId: project.projectId,
      workspaceId: workspace.workspaceId,
      notebookId: claim.notebookId,
      location: claim.location,
      releasedWriterId: claim.designatedWriterId,
      metadataRevision,
      nextStep: "fresh_supervisor_role_first",
    };
  }

  async function rebind(input: NotebookRebindInput): Promise<NotebookGrantReceipt> {
    if (input.currentWriterId.trim().length === 0 || input.newWriterId.trim().length === 0) {
      throw new Error("notebook_rebind_writer_identity_missing");
    }
    const request = NotebookGrantRequestSchema.parse({
      scope: input.scope,
      expiresAt: input.expiresAt,
    });
    assertFutureNotebookExpiry(request.expiresAt);
    const workspace = await dependencies.workspaceRegistry.get(input.workspaceId);
    if (!workspace || workspace.archivedAt)
      throw new Error("notebook_rebind_workspace_unavailable");
    const project = await dependencies.projectRegistry.get(workspace.projectId);
    if (!project || project.archivedAt) throw new Error("notebook_rebind_project_unavailable");
    const metadata = inspectHarnessProjectMetadata(
      project.rootPath,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    if (metadata.status !== "valid" || !metadata.metadata.supervisorNotebook) {
      throw new Error("notebook_rebind_claim_missing");
    }
    const current = metadata.metadata.supervisorNotebook;
    if (current.designatedWriterId !== input.currentWriterId) {
      throw new Error("notebook_rebind_writer_conflict");
    }
    const next = {
      ...current,
      designatedWriterId: input.newWriterId,
      scope: request.scope,
      expiresAt: request.expiresAt,
    };
    const result = writeHarnessProjectMetadata({
      repoRoot: project.rootPath,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: {
        ...metadata.metadata,
        supervisorNotebookIdentity:
          metadata.metadata.supervisorNotebookIdentity ?? identityFromClaim(current),
        supervisorNotebook: next,
      },
      expectedRevision: metadata.revision,
      writerId: input.currentWriterId,
    });
    if (!result.ok) throw new Error(`notebook_rebind_failed: ${result.error.code}`);
    return {
      effect: "notebook-write",
      notebookId: next.notebookId,
      location: next.location,
      projectId: project.projectId,
      scope: next.scope,
      designatedWriterId: next.designatedWriterId,
      expiresAt: next.expiresAt,
    };
  }

  return { prepare, assertCurrent, release, rebind };
}
