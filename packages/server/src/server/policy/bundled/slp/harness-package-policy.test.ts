import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  HARNESS_PACKAGE_ID,
  loadHarnessPackageDescriptor,
  projectRoleHarnessResources,
} from "./harness-package-policy.js";

/**
 * Structural fixture for the loader. Production reads the imported Foundation
 * package through the descriptor-relative path; this fixture keeps the loader
 * invariants independent of the machine's imported bundle.
 */
const DRAFT_DESCRIPTOR = {
  schemaVersion: 1,
  package: HARNESS_PACKAGE_ID,
  generation: 1,
  resources: {
    entryMap: "README.md",
    entrypointBlock: "entrypoint-block.md",
    supervisorNotebookTemplate: "SUPERVISOR_NOTEBOOK.EMPTY.md",
  },
  roleMinimum: {
    lead: ["entryMap"],
    peer: ["entryMap"],
    supervisor: ["entryMap"],
  },
  entrypointPlaceholders: {
    "HARNESS:ENTRY_MAP_PATH": "entry-map path, relative to the entrypoint file being written",
    "HARNESS:WORKSPACE_PROTOCOL_PATH":
      "WORKSPACE_PROTOCOL.md path, relative to the entrypoint file being written",
  },
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeDescriptor(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-package-policy-test-"));
  tempDirs.push(dir);
  // The loader now requires every resource to actually exist (real-path
  // containment check), so the fixture must materialize the real files a
  // genuine Foundation import would have placed alongside the descriptor —
  // not just the descriptor JSON.
  for (const resourceFileName of Object.values(DRAFT_DESCRIPTOR.resources)) {
    writeFileSync(join(dir, resourceFileName), "draft fixture content\n", "utf8");
  }
  const descriptorPath = join(dir, "harness-package.json");
  writeFileSync(
    descriptorPath,
    JSON.stringify({ ...DRAFT_DESCRIPTOR, ...overrides }, null, 2),
    "utf8",
  );
  return descriptorPath;
}

describe("loadHarnessPackageDescriptor", () => {
  test("loads the draft descriptor and resolves resource paths relative to its own directory", () => {
    const descriptorPath = writeDescriptor();
    const descriptor = loadHarnessPackageDescriptor(descriptorPath);

    expect(descriptor.package).toBe(HARNESS_PACKAGE_ID);
    expect(descriptor.generation).toBe(1);
    expect(descriptor.resourcePaths.entryMap).toBe(
      realpathSync(join(descriptorPath, "..", "README.md")),
    );
    expect(descriptor.resourcePaths.entrypointBlock).toBe(
      realpathSync(join(descriptorPath, "..", "entrypoint-block.md")),
    );
    expect(descriptor.resourcePaths.supervisorNotebookTemplate).toBe(
      realpathSync(join(descriptorPath, "..", "SUPERVISOR_NOTEBOOK.EMPTY.md")),
    );
  });

  test("rejects a resource declared in the descriptor that does not actually exist on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-package-policy-test-"));
    tempDirs.push(dir);
    // Only two of three declared resources are materialized.
    writeFileSync(join(dir, "README.md"), "x", "utf8");
    writeFileSync(join(dir, "entrypoint-block.md"), "x", "utf8");
    const descriptorPath = join(dir, "harness-package.json");
    writeFileSync(descriptorPath, JSON.stringify(DRAFT_DESCRIPTOR, null, 2), "utf8");

    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(
      /resources\.supervisorNotebookTemplate does not exist on disk/u,
    );
  });

  test("rejects a package identity mismatch", () => {
    const descriptorPath = writeDescriptor({ package: "some-other-package" });
    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(/identity mismatch/u);
  });

  test("rejects an unsupported schemaVersion", () => {
    const descriptorPath = writeDescriptor({ schemaVersion: 2 });
    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(/schemaVersion/u);
  });

  test("rejects a non-integer or non-positive generation", () => {
    expect(() => loadHarnessPackageDescriptor(writeDescriptor({ generation: 0 }))).toThrow(
      /generation/u,
    );
    expect(() => loadHarnessPackageDescriptor(writeDescriptor({ generation: 1.5 }))).toThrow(
      /generation/u,
    );
  });

  test("rejects an absolute resource path", () => {
    const descriptorPath = writeDescriptor({
      resources: { ...DRAFT_DESCRIPTOR.resources, entryMap: "/etc/passwd" },
    });
    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(/resources\.entryMap/u);
  });

  test("rejects a resource path that escapes the descriptor directory via ..", () => {
    const descriptorPath = writeDescriptor({
      resources: { ...DRAFT_DESCRIPTOR.resources, entryMap: "../../../etc/passwd" },
    });
    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(/resources\.entryMap/u);
  });

  test("rejects a missing roleMinimum entry for a mandatory role", () => {
    const { supervisor: _supervisor, ...partialRoleMinimum } = DRAFT_DESCRIPTOR.roleMinimum;
    const descriptorPath = writeDescriptor({ roleMinimum: partialRoleMinimum });
    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(/roleMinimum\.supervisor/u);
  });

  test("rejects a roleMinimum entry naming an unknown resource key", () => {
    const descriptorPath = writeDescriptor({
      roleMinimum: { ...DRAFT_DESCRIPTOR.roleMinimum, peer: ["not-a-real-resource"] },
    });
    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(/roleMinimum\.peer/u);
  });

  test("rejects a resource that is a symlink escaping the descriptor's real directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-package-policy-test-"));
    tempDirs.push(dir);
    const outsideDir = mkdtempSync(join(tmpdir(), "harness-package-policy-test-outside-"));
    tempDirs.push(outsideDir);
    const outsideFile = join(outsideDir, "escaped.md");
    writeFileSync(outsideFile, "outside content", "utf8");

    writeFileSync(join(dir, "entrypoint-block.md"), "x", "utf8");
    writeFileSync(join(dir, "SUPERVISOR_NOTEBOOK.EMPTY.md"), "x", "utf8");
    symlinkSync(outsideFile, join(dir, "README.md"));

    const descriptorPath = join(dir, "harness-package.json");
    writeFileSync(descriptorPath, JSON.stringify(DRAFT_DESCRIPTOR, null, 2), "utf8");

    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(
      /resources\.entryMap resolves outside its descriptor directory via a symlink/u,
    );
  });

  test("throws the corruption error itself for a present-but-corrupt descriptor, not a generic not-found error", () => {
    // Guards the fix for silent fallback-on-corruption: a descriptor that
    // exists but fails to parse must surface its own parse failure, never
    // get masked by a subsequent "no such file" candidate message.
    const dir = mkdtempSync(join(tmpdir(), "harness-package-policy-test-"));
    tempDirs.push(dir);
    const descriptorPath = join(dir, "harness-package.json");
    writeFileSync(descriptorPath, "{ not valid json", "utf8");

    let caught: unknown;
    try {
      loadHarnessPackageDescriptor(descriptorPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(/no such file/u);
    expect((caught as Error).message).not.toMatch(/Unable to load/u);
  });

  test("rejects a nonexistent descriptor path", () => {
    expect(() => loadHarnessPackageDescriptor("/nonexistent/harness-package.json")).toThrow();
  });

  test("rejects an entrypointPlaceholders token name Product's renderer does not support", () => {
    const descriptorPath = writeDescriptor({
      entrypointPlaceholders: {
        ...DRAFT_DESCRIPTOR.entrypointPlaceholders,
        "HARNESS:NOT_A_REAL_TOKEN": "unsupported",
      },
    });
    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(
      /entrypointPlaceholders declares an unsupported token/u,
    );
  });

  test("rejects a descriptor missing entrypointPlaceholders entirely", () => {
    const { entrypointPlaceholders: _placeholders, ...withoutPlaceholders } = DRAFT_DESCRIPTOR;
    const descriptorPath = writeDescriptor(withoutPlaceholders);
    // writeDescriptor spreads overrides onto DRAFT_DESCRIPTOR, so omitting the
    // key here has no effect; delete it explicitly on the written file instead.
    const raw = JSON.parse(readFileSync(descriptorPath, "utf8"));
    delete raw.entrypointPlaceholders;
    writeFileSync(descriptorPath, JSON.stringify(raw, null, 2), "utf8");
    expect(() => loadHarnessPackageDescriptor(descriptorPath)).toThrow(
      /missing entrypointPlaceholders map/u,
    );
  });
});

describe("projectRoleHarnessResources", () => {
  test("projects exactly the mandatory minimum for peer: entryMap only", () => {
    const descriptor = loadHarnessPackageDescriptor(writeDescriptor());
    const projection = projectRoleHarnessResources(descriptor, "peer");

    expect(projection.resourceKeys).toEqual(["entryMap"]);
    expect(Object.keys(projection.resourcePaths)).toEqual(["entryMap"]);
    expect(projection.resourcePaths.entryMap).toBe(descriptor.resourcePaths.entryMap);
  });

  test("projects entryMap-only minimum for supervisor in this generation (entrypointBlock/notebook template stay bootstrap-only, not per-assignment resources)", () => {
    const descriptor = loadHarnessPackageDescriptor(writeDescriptor());
    const projection = projectRoleHarnessResources(descriptor, "supervisor");

    expect(projection.resourceKeys).toEqual(["entryMap"]);
  });

  test("peer's mandatory minimum never exceeds lead's for this draft generation", () => {
    const descriptor = loadHarnessPackageDescriptor(writeDescriptor());
    const peerKeys = new Set(projectRoleHarnessResources(descriptor, "peer").resourceKeys);
    const leadKeys = new Set(projectRoleHarnessResources(descriptor, "lead").resourceKeys);
    for (const key of peerKeys) expect(leadKeys.has(key)).toBe(true);
  });
});
