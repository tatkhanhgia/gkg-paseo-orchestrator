import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { PersistedProjectRecord } from "../workspace-registry.js";
import {
  resolveAuthoritativeHarnessBindingProject,
  resolveRegisteredProjectForCwd,
  resolveRegisteredProjectForWorkspaceCwd,
  resolveHarnessBindingProject,
} from "./harness-binding-scope.js";

/**
 * Mirrors the real registered topology reported for acceptance: a `non_git`
 * parent umbrella directory with two independently registered child
 * projects nested underneath it on disk. Built under a temp root instead of
 * the literal machine paths so the test is hermetic. Fixtures use the real
 * `PersistedProjectRecord` shape (see `workspace-registry.ts`), not a
 * parallel type.
 */
const NOW = "2026-09-07T00:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProject(projectId: string, rootPath: string): PersistedProjectRecord {
  return {
    projectId,
    rootPath,
    kind: "non_git",
    displayName: projectId,
    customName: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
}

function makeSleekTopology(): {
  parent: PersistedProjectRecord;
  radar: PersistedProjectRecord;
  securecore: PersistedProjectRecord;
  registry: PersistedProjectRecord[];
} {
  const parentRoot = mkdtempSync(join(tmpdir(), "harness-binding-scope-test-SLEEK-"));
  tempDirs.push(parentRoot);
  const radarRoot = join(parentRoot, "Sleek-Radar");
  const securecoreRoot = join(parentRoot, "sleek-securecore");
  mkdirSync(radarRoot, { recursive: true });
  mkdirSync(securecoreRoot, { recursive: true });

  const parent = makeProject("prj_3c9e06b9d2aba40a", parentRoot);
  const radar = makeProject("prj_2300e8aab5f680c7", radarRoot);
  const securecore = makeProject("prj_432b5c4d699a4fcb", securecoreRoot);
  return { parent, radar, securecore, registry: [parent, radar, securecore] };
}

describe("resolveHarnessBindingProject", () => {
  test("binds by exact projectId regardless of physical nesting under the parent", () => {
    const { securecore, registry } = makeSleekTopology();
    const result = resolveHarnessBindingProject({ projectId: securecore.projectId }, registry);
    expect(result).toEqual({ status: "resolved", project: securecore });
  });

  test("binds the child project when its cwd exactly equals its own registered root", () => {
    const { securecore, registry } = makeSleekTopology();
    const result = resolveHarnessBindingProject({ cwd: securecore.rootPath }, registry);
    expect(result).toEqual({ status: "resolved", project: securecore });
  });

  test("binds the parent when its own cwd is requested, never a child's", () => {
    const { parent, registry } = makeSleekTopology();
    const result = resolveHarnessBindingProject({ cwd: parent.rootPath }, registry);
    expect(result).toEqual({ status: "resolved", project: parent });
  });

  test("never silently adopts the parent when the requested cwd is a nested, unregistered subdirectory of a child", () => {
    const { securecore, registry } = makeSleekTopology();
    const nestedCwd = join(securecore.rootPath, "docs", "deep", "nested");
    mkdirSync(nestedCwd, { recursive: true });

    const result = resolveHarnessBindingProject({ cwd: nestedCwd }, registry);

    // Fails closed rather than climbing up to bind the parent's identity.
    expect(result).toEqual({ status: "unresolved", reason: "cwd_not_registered_root" });
  });

  test("never binds a sibling child's cwd to another child's identity", () => {
    const { radar, securecore, registry } = makeSleekTopology();
    const result = resolveHarnessBindingProject({ cwd: radar.rootPath }, registry);
    expect(result).toEqual({ status: "resolved", project: radar });
    expect(result.status === "resolved" && result.project.projectId).not.toBe(securecore.projectId);
  });

  test("a worktree cwd outside every registered root still binds by projectId (same-project worktree sharing)", () => {
    const { securecore, registry } = makeSleekTopology();
    const worktreeCwd = mkdtempSync(join(tmpdir(), "harness-binding-scope-test-worktree-"));
    tempDirs.push(worktreeCwd);

    const result = resolveHarnessBindingProject(
      { projectId: securecore.projectId, cwd: worktreeCwd },
      registry,
    );

    expect(result).toEqual({ status: "resolved", project: securecore });
  });

  test("rejects an unregistered projectId (cross-project grant deny)", () => {
    const { registry } = makeSleekTopology();
    const result = resolveHarnessBindingProject({ projectId: "prj_does_not_exist" }, registry);
    expect(result).toEqual({ status: "unresolved", reason: "project_not_found" });
  });

  test("rejects a request naming an archived project even by exact id", () => {
    const { securecore, registry } = makeSleekTopology();
    const archived = registry.map((project) => {
      if (project.projectId !== securecore.projectId) return project;
      return Object.assign({}, project, { archivedAt: "2026-01-01T00:00:00Z" });
    });
    const result = resolveHarnessBindingProject({ projectId: securecore.projectId }, archived);
    expect(result).toEqual({ status: "unresolved", reason: "project_archived" });
  });

  test("rejects a request with neither projectId nor cwd", () => {
    const { registry } = makeSleekTopology();
    const result = resolveHarnessBindingProject({}, registry);
    expect(result).toEqual({ status: "unresolved", reason: "no_project_id_or_cwd" });
  });
});

describe("resolveAuthoritativeHarnessBindingProject", () => {
  test("derives the project strictly from the session's own actual cwd", () => {
    const { securecore, registry } = makeSleekTopology();
    const result = resolveAuthoritativeHarnessBindingProject(
      { cwd: securecore.rootPath },
      registry,
    );
    expect(result).toEqual({ status: "resolved", project: securecore });
  });

  test("rejects a claimed projectId that does not match the project actually derived from cwd", () => {
    const { radar, securecore, registry } = makeSleekTopology();
    const result = resolveAuthoritativeHarnessBindingProject(
      { cwd: securecore.rootPath, claimedProjectId: radar.projectId },
      registry,
    );
    // An arbitrary caller-supplied projectId can never override the identity
    // actually derived from the caller's own real working directory.
    expect(result).toEqual({ status: "unresolved", reason: "project_id_mismatch" });
  });

  test("accepts a claimed projectId that matches the cwd-derived project", () => {
    const { securecore, registry } = makeSleekTopology();
    const result = resolveAuthoritativeHarnessBindingProject(
      { cwd: securecore.rootPath, claimedProjectId: securecore.projectId },
      registry,
    );
    expect(result).toEqual({ status: "resolved", project: securecore });
  });

  test("never resolves a project purely from a claimed projectId when cwd itself is unregistered", () => {
    const { securecore, registry } = makeSleekTopology();
    const unregisteredCwd = mkdtempSync(join(tmpdir(), "harness-binding-scope-test-stray-"));
    tempDirs.push(unregisteredCwd);

    const result = resolveAuthoritativeHarnessBindingProject(
      { cwd: unregisteredCwd, claimedProjectId: securecore.projectId },
      registry,
    );

    expect(result).toEqual({ status: "unresolved", reason: "cwd_not_registered_root" });
  });
});

describe("resolveRegisteredProjectForCwd", () => {
  test("selects a registered child over its parent for an actual child cwd", () => {
    const { parent, securecore, registry } = makeSleekTopology();
    const result = resolveRegisteredProjectForCwd(
      join(securecore.rootPath, "nested", "cwd"),
      registry,
    );
    expect(result).toEqual({ status: "resolved", project: securecore });
    expect(result.status === "resolved" && result.project.projectId).not.toBe(parent.projectId);
  });

  test("keeps a same-project worktree outside registered roots unresolved for the caller to verify", () => {
    const { registry } = makeSleekTopology();
    const worktreeCwd = mkdtempSync(join(tmpdir(), "harness-binding-scope-test-worktree-cwd-"));
    tempDirs.push(worktreeCwd);
    expect(resolveRegisteredProjectForCwd(worktreeCwd, registry)).toEqual({
      status: "unresolved",
      reason: "cwd_not_registered_root",
    });
  });
});

describe("resolveRegisteredProjectForWorkspaceCwd", () => {
  test("preserves explicit Product ownership under a registered Foundation container", () => {
    const foundationRoot = mkdtempSync(join(tmpdir(), "harness-binding-scope-foundation-"));
    const productRoot = mkdtempSync(join(tmpdir(), "harness-binding-scope-product-"));
    tempDirs.push(foundationRoot, productRoot);
    const worktreeRoot = join(foundationRoot, ".worktrees", "product");
    const cwd = join(worktreeRoot, "nested");
    mkdirSync(cwd, { recursive: true });
    const foundation = makeProject("project-foundation", foundationRoot);
    const product = makeProject("project-product", productRoot);

    expect(
      resolveRegisteredProjectForWorkspaceCwd({
        cwd,
        workspaceRoot: worktreeRoot,
        projectId: product.projectId,
        registeredProjects: [foundation, product],
      }),
    ).toEqual({ status: "allowed" });
  });

  test("rejects an independently registered child inside the owning workspace", () => {
    const { parent, securecore, registry } = makeSleekTopology();
    const cwd = join(securecore.rootPath, "nested");
    mkdirSync(cwd, { recursive: true });

    expect(
      resolveRegisteredProjectForWorkspaceCwd({
        cwd,
        workspaceRoot: parent.rootPath,
        projectId: parent.projectId,
        registeredProjects: registry,
      }),
    ).toEqual({ status: "unresolved", reason: "registered_project_mismatch" });
  });

  test("rejects ambiguous equal registered roots", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-binding-scope-equal-root-"));
    tempDirs.push(root);
    const first = makeProject("project-first", root);
    const second = makeProject("project-second", root);
    const cwd = join(root, "nested");
    mkdirSync(cwd, { recursive: true });

    expect(
      resolveRegisteredProjectForWorkspaceCwd({
        cwd,
        workspaceRoot: root,
        projectId: "project-owner",
        registeredProjects: [first, second],
      }),
    ).toEqual({ status: "unresolved", reason: "ambiguous_registered_roots" });
  });
});
