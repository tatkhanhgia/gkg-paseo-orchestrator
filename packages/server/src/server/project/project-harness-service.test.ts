import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectHarnessService,
  type ProjectHarnessServiceOptions,
} from "./project-harness-service.js";
import {
  loadHarnessPackageDescriptor,
  type HarnessPackageDescriptor,
} from "../policy/bundled/slp/harness-package-policy.js";

const temporaryRoots: string[] = [];

async function makeTarget(suffix = "test"): Promise<{
  root: string;
  projectId: string;
  workspaceId: string;
  target: {
    projectId: string;
    workspaceId: string;
    projectRoot: string;
    workspaceRoot: string;
    cwd: string;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "paseo-project-harness-service-test-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "WORKSPACE_PROTOCOL.md"), "# Workspace Protocol\n");
  const projectId = `prj_harness_${suffix}`;
  const workspaceId = `wks_harness_${suffix}`;
  return {
    root,
    projectId,
    workspaceId,
    target: { projectId, workspaceId, projectRoot: root, workspaceRoot: root, cwd: root },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function makeUpdatedDescriptor(): Promise<HarnessPackageDescriptor> {
  const base = loadHarnessPackageDescriptor();
  const resourceRoot = await mkdtemp(join(tmpdir(), "paseo-project-harness-resource-test-"));
  temporaryRoots.push(resourceRoot);
  const entrypointBlock = join(resourceRoot, "entrypoint-block.md");
  const original = await readFile(base.resourcePaths.entrypointBlock, "utf8");
  await writeFile(entrypointBlock, `${original.trimEnd()}\nR2 descriptor update\n`);
  return {
    ...base,
    generation: base.generation + 1,
    descriptorDigest: "b".repeat(64),
    artifactDigest: "c".repeat(64),
    resourcePaths: { ...base.resourcePaths, entrypointBlock },
    resourceDigests: { ...base.resourceDigests, entrypointBlock: "d".repeat(64) },
  };
}

function updatedServiceOptions(descriptor: HarnessPackageDescriptor): ProjectHarnessServiceOptions {
  return { descriptor };
}

describe("native Project Harness service", () => {
  it("previews five registered projects read-only without cross-root writes", async () => {
    const service = createProjectHarnessService();
    const fixtures = [];
    for (let index = 1; index <= 5; index += 1) {
      fixtures.push(await makeTarget(`preview_${index}`));
    }

    for (const fixture of fixtures) {
      const preview = await service.preview(fixture.target, "bootstrap");
      expect(preview.readyToApply).toBe(true);
      expect(preview.inspection.target).toMatchObject({
        projectId: fixture.projectId,
        workspaceId: fixture.workspaceId,
      });
      await expect(readFile(join(fixture.root, "WORKSPACE_PROTOCOL.md"), "utf8")).resolves.toBe(
        "# Workspace Protocol\n",
      );
      await expect(readFile(join(fixture.root, "AGENTS.md"), "utf8")).rejects.toThrow();
    }
  });

  it("previews and applies a concrete bootstrap, then reads back an idempotent update", async () => {
    const fixture = await makeTarget();
    const service = createProjectHarnessService();

    const preview = await service.preview(fixture.target, "bootstrap");
    expect(preview.readyToApply).toBe(true);
    expect(preview.plan.files.map((file) => file.path)).toEqual([
      "docs/harness/README.md",
      "docs/harness/SUPERVISOR_NOTEBOOK.md",
      "AGENTS.md",
      "CLAUDE.md",
      ".paseo/harness.json",
    ]);
    expect(preview.changes.some((change) => change.diff?.includes("PASEO_HARNESS:BEGIN"))).toBe(
      true,
    );

    const applied = await service.apply(fixture.target, preview.plan);
    expect(applied.changedPaths).toHaveLength(5);
    await expect(readFile(join(fixture.root, "docs/harness/README.md"), "utf8")).resolves.toContain(
      "Project Harness",
    );
    await expect(readFile(join(fixture.root, "AGENTS.md"), "utf8")).resolves.toContain(
      "PASEO_HARNESS:BEGIN",
    );
    await expect(readFile(join(fixture.root, "CLAUDE.md"), "utf8")).resolves.toContain(
      "PASEO_HARNESS:BEGIN",
    );

    const updatePreview = await service.preview(fixture.target, "update");
    expect(updatePreview.readyToApply).toBe(true);
    expect(updatePreview.plan.files).toHaveLength(0);
    const updated = await service.update(fixture.target, updatePreview.plan);
    expect(updated.changedPaths).toEqual([]);
    expect(updated.inspection.recovery.status).toBe("none");
  });

  it("requires the native Workspace Protocol CAS bootstrap before harness rendering", async () => {
    const fixture = await makeTarget();
    await rm(join(fixture.root, "WORKSPACE_PROTOCOL.md"));

    await expect(
      createProjectHarnessService().preview(fixture.target, "bootstrap"),
    ).rejects.toMatchObject({
      code: "workspace_protocol_required",
      paths: ["WORKSPACE_PROTOCOL.md"],
    });
    await expect(
      createProjectHarnessService().preview(fixture.target, "bootstrap"),
    ).rejects.toThrow("foundation.workspaceProtocol.write.request");
  });

  it("updates Foundation generation and managed routing bytes from recorded provenance", async () => {
    const fixture = await makeTarget();
    const initialService = createProjectHarnessService();
    const initialPreview = await initialService.preview(fixture.target, "bootstrap");
    await initialService.apply(fixture.target, initialPreview.plan);

    const updatedDescriptor = await makeUpdatedDescriptor();
    const updatedService = createProjectHarnessService(updatedServiceOptions(updatedDescriptor));
    const preview = await updatedService.preview(fixture.target, "update");

    expect(preview.readyToApply).toBe(true);
    expect(preview.plan.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["AGENTS.md", "CLAUDE.md", ".paseo/harness.json"]),
    );
    expect(preview.plan.files.map((file) => file.path)).not.toContain(
      "docs/harness/SUPERVISOR_NOTEBOOK.md",
    );
    expect(preview.plan.files.map((file) => file.path)).not.toContain("docs/harness/README.md");

    await updatedService.update(fixture.target, preview.plan);
    await expect(readFile(join(fixture.root, "AGENTS.md"), "utf8")).resolves.toContain(
      "R2 descriptor update",
    );
    const metadata = JSON.parse(
      await readFile(join(fixture.root, ".paseo/harness.json"), "utf8"),
    ) as {
      projectHarness: { generation: number; artifactDigest: string };
    };
    expect(metadata.projectHarness).toEqual(
      expect.objectContaining({
        generation: updatedDescriptor.generation,
        artifactDigest: updatedDescriptor.artifactDigest,
      }),
    );
  });

  it("blocks update when a recorded managed block or entry map has local drift", async () => {
    const fixture = await makeTarget();
    const service = createProjectHarnessService();
    const bootstrap = await service.preview(fixture.target, "bootstrap");
    await service.apply(fixture.target, bootstrap.plan);

    const agents = await readFile(join(fixture.root, "AGENTS.md"), "utf8");
    await writeFile(
      join(fixture.root, "AGENTS.md"),
      agents.replace("Project Harness entry map", "local drift"),
    );
    const blockDrift = await service.preview(fixture.target, "update");
    expect(blockDrift.readyToApply).toBe(false);
    expect(blockDrift.changes.find((change) => change.path === "AGENTS.md")?.action).toBe(
      "blocked",
    );

    await writeFile(join(fixture.root, "AGENTS.md"), agents);
    const entryMap = await readFile(join(fixture.root, "docs/harness/README.md"), "utf8");
    await writeFile(
      join(fixture.root, "docs/harness/README.md"),
      `${entryMap}\nlocal entry map delta\n`,
    );
    const entryMapDrift = await service.preview(fixture.target, "update");
    expect(entryMapDrift.readyToApply).toBe(false);
    expect(
      entryMapDrift.changes.find((change) => change.path === "docs/harness/README.md")?.action,
    ).toBe("blocked");
  });

  it("keeps a healthy entrypoint symlink and writes only its regular sibling target", async () => {
    const fixture = await makeTarget();
    await writeFile(join(fixture.root, "CLAUDE.md"), "existing instructions\n");
    await symlink("CLAUDE.md", join(fixture.root, "AGENTS.md"));
    const service = createProjectHarnessService();

    const preview = await service.preview(fixture.target, "bootstrap");
    expect(preview.readyToApply).toBe(true);
    expect(preview.plan.files.map((file) => file.path)).not.toContain("AGENTS.md");
    expect(preview.plan.files.map((file) => file.path)).toContain("CLAUDE.md");
    await service.apply(fixture.target, preview.plan);
    await expect(readlink(join(fixture.root, "AGENTS.md"))).resolves.toBe("CLAUDE.md");
    await expect(readFile(join(fixture.root, "CLAUDE.md"), "utf8")).resolves.toContain(
      "PASEO_HARNESS:BEGIN",
    );
  });

  it("preserves foreign entrypoint ownership while applying independent files", async () => {
    const fixture = await makeTarget();
    await writeFile(join(fixture.root, "AGENTS.md"), "<!-- FOREIGN_HARNESS:BEGIN -->\n");
    const service = createProjectHarnessService();

    const preview = await service.preview(fixture.target, "bootstrap");
    expect(preview.readyToApply).toBe(true);
    expect(preview.changes.find((change) => change.path === "AGENTS.md")?.action).toBe(
      "manual_reconciliation_required",
    );
    expect(preview.plan.files.map((file) => file.path)).not.toContain("AGENTS.md");
    await service.apply(fixture.target, preview.plan);
    await expect(readFile(join(fixture.root, "AGENTS.md"), "utf8")).resolves.toBe(
      "<!-- FOREIGN_HARNESS:BEGIN -->\n",
    );
  });

  it("inventories the foreign object manifest and coexists without owning AGENTS", async () => {
    const fixture = await makeTarget();
    const foreignPaths = [
      "AGENTS.md",
      "docs/WORKFLOW.md",
      "docs/README.md",
      "README.md",
      ".gitignore",
      "package.json",
      "src/index.ts",
      "src/config.ts",
      "scripts/check.mjs",
      "docs/SECURITY.md",
      "docs/CONTRIBUTING.md",
      "LICENSE",
      "CHANGELOG.md",
      "config/default.json",
      ".editorconfig",
      "Makefile",
      "src/main.ts",
      "tests/fixtures/README.md",
      "tools/manifest.ts",
    ];
    await mkdir(join(fixture.root, ".harness-core"), { recursive: true });
    await writeFile(join(fixture.root, "AGENTS.md"), "foreign instructions\n");
    await writeFile(
      join(fixture.root, ".harness-core/manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        core_version: "0.1.7",
        files: foreignPaths.map((path) => ({ path, upstream_sha256: sha256(`upstream:${path}`) })),
      })}\n`,
    );

    const service = createProjectHarnessService();
    const preview = await service.preview(fixture.target, "bootstrap");
    expect(preview.inspection.foreignOwnership.status).toBe("valid");
    expect(preview.inspection.foreignOwnership.ownedPaths).toHaveLength(19);
    expect(preview.inspection.foreignOwnership.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/README.md", status: "missing", drift: "missing" }),
        expect.objectContaining({ path: "AGENTS.md", drift: "local_delta" }),
      ]),
    );
    expect(preview.plan.files.map((file) => file.path)).not.toContain("AGENTS.md");
    expect(preview.plan.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["docs/harness/README.md", "CLAUDE.md"]),
    );

    await service.apply(fixture.target, preview.plan);
    await expect(readFile(join(fixture.root, "AGENTS.md"), "utf8")).resolves.toBe(
      "foreign instructions\n",
    );
    await expect(readFile(join(fixture.root, "CLAUDE.md"), "utf8")).resolves.toContain(
      "PASEO_HARNESS:BEGIN",
    );
  });

  it("preserves a durable custom notebook identity and rejects a changed preview guard", async () => {
    const fixture = await makeTarget();
    await mkdir(join(fixture.root, ".paseo"), { recursive: true });
    const metadata = {
      supervisorNotebookIdentity: { notebookId: "nb_custom", location: "notes/custom.md" },
    };
    await writeFile(join(fixture.root, ".paseo/harness.json"), `${JSON.stringify(metadata)}\n`);
    const service = createProjectHarnessService();
    const preview = await service.preview(fixture.target, "bootstrap");
    expect(preview.plan.files.map((file) => file.path)).toContain("notes/custom.md");
    expect(preview.plan.files.map((file) => file.path)).toContain(".paseo/harness.json");
    await writeFile(join(fixture.root, "WORKSPACE_PROTOCOL.md"), "# changed\n");
    await expect(service.apply(fixture.target, preview.plan)).rejects.toMatchObject({
      code: "stale_plan",
    });
    await expect(readFile(join(fixture.root, ".paseo/harness.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(metadata)}\n`,
    );
  });
});
