import {
  areEquivalentPaths,
  isRealpathInsideRoot,
  normalizePathForIdentity,
} from "../../utils/path.js";
import type { PersistedProjectRecord } from "../workspace-registry.js";

/**
 * Resolves exactly which registered project a harness/notebook/Beads binding
 * belongs to. This mirrors the existing exact-match convention already used
 * by Workspace Protocol resolution (`resolveKnownProjectRoot` in
 * `project-config-session.ts` / `workspace-protocol-session.ts`): a request
 * binds to a registered project only by its own id, or by its `cwd` being
 * literally equal to that project's registered root — never by walking up
 * to the nearest ancestor directory that happens to contain a harness
 * artifact. Registered projects that are physically nested under another
 * registered project's directory (e.g. a `non_git` parent umbrella with
 * independently registered children) must never have their identity
 * conflated by filesystem proximity.
 *
 * This operates on `PersistedProjectRecord`, the real `ProjectRegistry`
 * record type (see `workspace-registry.ts`) — it is a pure projection over
 * data the caller already fetched from that registry (`list()`), never an
 * independent registry or control plane. Root comparison reuses
 * `areEquivalentPaths`, the same lexical comparator `ProjectRegistry` itself
 * uses in `getOrCreateActiveByRoot`, so this resolver never diverges from
 * how the real registry decides two paths name the same project.
 */

export interface HarnessBindingRequest {
  /** Preferred: the caller's own session/workspace already knows its projectId. */
  projectId?: string;
  /** Fallback only for path-addressed callers (e.g. WP inspect by repoRoot). */
  cwd?: string;
}

export type HarnessBindingResolution =
  | { status: "resolved"; project: PersistedProjectRecord }
  | {
      status: "unresolved";
      reason:
        | "no_project_id_or_cwd"
        | "project_not_found"
        | "project_archived"
        | "cwd_not_registered_root"
        | "project_id_mismatch";
    };

export type RegisteredProjectCwdResolution =
  | { status: "resolved"; project: PersistedProjectRecord }
  | {
      status: "unresolved";
      reason: "cwd_not_registered_root" | "ambiguous_registered_roots";
    };

export type RegisteredWorkspaceCwdResolution =
  | { status: "allowed" }
  | {
      status: "unresolved";
      reason: "registered_project_mismatch" | "ambiguous_registered_roots";
    };

/**
 * Resolves an actual runtime cwd against registered project roots only. A
 * nested registered project wins over its registered ancestor; a tie is
 * ambiguous and fails closed. This deliberately does not inspect files on
 * disk or walk toward a harness artifact, so an unregistered directory can
 * never borrow an ancestor's project identity through proximity.
 */
export function resolveRegisteredProjectForCwd(
  cwd: string,
  registeredProjects: readonly PersistedProjectRecord[],
): RegisteredProjectCwdResolution {
  const matches = registeredProjects
    .filter((project) => project.archivedAt === null && isRealpathInsideRoot(project.rootPath, cwd))
    .map((project) => ({
      project,
      rootLength: normalizePathForIdentity(project.rootPath).length,
    }))
    .sort((left, right) => right.rootLength - left.rootLength);
  const best = matches[0];
  if (!best) return { status: "unresolved", reason: "cwd_not_registered_root" };
  const tied = matches.filter((candidate) => candidate.rootLength === best.rootLength);
  if (tied.some((candidate) => candidate.project.projectId !== best.project.projectId)) {
    return { status: "unresolved", reason: "ambiguous_registered_roots" };
  }
  return { status: "resolved", project: best.project };
}

/**
 * Checks a runtime cwd against the caller's already-authoritative workspace
 * ownership. A registered project that merely contains the whole workspace
 * (for example a Foundation container containing a Product worktree) is not
 * allowed to override the workspace's explicit projectId. A different
 * registered project at or below that workspace root is a real topology
 * conflict and fails closed before materialization or tool effects.
 */
export function resolveRegisteredProjectForWorkspaceCwd(input: {
  cwd: string;
  workspaceRoot: string;
  projectId: string;
  registeredProjects: readonly PersistedProjectRecord[];
}): RegisteredWorkspaceCwdResolution {
  const containingRoots = input.registeredProjects.filter(
    (project) =>
      project.archivedAt === null &&
      isRealpathInsideRoot(project.rootPath, input.cwd) &&
      isRealpathInsideRoot(input.workspaceRoot, project.rootPath),
  );

  const rootsByIdentity = new Map<string, Set<string>>();
  for (const project of containingRoots) {
    const rootIdentity = normalizePathForIdentity(project.rootPath);
    const projectIds = rootsByIdentity.get(rootIdentity) ?? new Set<string>();
    projectIds.add(project.projectId);
    rootsByIdentity.set(rootIdentity, projectIds);
  }
  if (Array.from(rootsByIdentity.values()).some((projectIds) => projectIds.size > 1)) {
    return { status: "unresolved", reason: "ambiguous_registered_roots" };
  }

  for (const project of containingRoots) {
    if (project.projectId === input.projectId) continue;
    if (areEquivalentPaths(project.rootPath, input.workspaceRoot)) {
      return { status: "unresolved", reason: "ambiguous_registered_roots" };
    }
    return { status: "unresolved", reason: "registered_project_mismatch" };
  }
  return { status: "allowed" };
}

/**
 * NOT an authorization check: this only tells you which registered project a
 * `projectId` or `cwd` names, given a list the caller already trusts. Do not
 * call this at an RPC/session boundary with a caller-supplied `projectId`
 * taken at face value — that lets any caller name an arbitrary project it
 * has no relationship to. Use `resolveAuthoritativeHarnessBindingProject`
 * there instead, anchored to the session's own actual cwd.
 */
export function resolveHarnessBindingProject(
  request: HarnessBindingRequest,
  registeredProjects: readonly PersistedProjectRecord[],
): HarnessBindingResolution {
  if (request.projectId) {
    const project = registeredProjects.find(
      (candidate) => candidate.projectId === request.projectId,
    );
    if (!project) return { status: "unresolved", reason: "project_not_found" };
    if (project.archivedAt !== null) return { status: "unresolved", reason: "project_archived" };
    return { status: "resolved", project };
  }
  if (!request.cwd) return { status: "unresolved", reason: "no_project_id_or_cwd" };

  const match = registeredProjects.find(
    (candidate) =>
      candidate.archivedAt === null && areEquivalentPaths(candidate.rootPath, request.cwd ?? ""),
  );
  return match
    ? { status: "resolved", project: match }
    : { status: "unresolved", reason: "cwd_not_registered_root" };
}

/**
 * The authorization-safe entry point for any real session/RPC boundary.
 * `cwd` must be the session's/agent's own actual working directory (never a
 * client-supplied string chosen independently of that session's identity) —
 * this is what makes the resolution authoritative rather than a bare lookup.
 * If the caller also claims a `projectId` (e.g. an already-bound session),
 * it is verified against the cwd-derived project rather than trusted on its
 * own; a mismatch fails closed instead of silently preferring one input.
 */
export function resolveAuthoritativeHarnessBindingProject(
  input: { cwd: string; claimedProjectId?: string },
  registeredProjects: readonly PersistedProjectRecord[],
): HarnessBindingResolution {
  const byCwd = resolveHarnessBindingProject({ cwd: input.cwd }, registeredProjects);
  if (byCwd.status !== "resolved") return byCwd;
  if (input.claimedProjectId && input.claimedProjectId !== byCwd.project.projectId) {
    return { status: "unresolved", reason: "project_id_mismatch" };
  }
  return byCwd;
}
