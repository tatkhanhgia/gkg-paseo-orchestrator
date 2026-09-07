import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildHarnessEntrypointMigrationPreview,
  buildManagedHarnessBlock,
  inspectHarnessEntrypoints,
} from "./harness-entrypoint-inspect.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-entrypoint-inspect-test-"));
  tempDirs.push(root);
  return root;
}

describe("inspectHarnessEntrypoints", () => {
  // Product's own inventory: AGENTS.md -> CLAUDE.md (this repository's actual layout).
  test("classifies the Product direction: AGENTS.md symlinks to CLAUDE.md", () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# entry\n", "utf8");
    symlinkSync("CLAUDE.md", join(repoRoot, "AGENTS.md"));

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "agents_symlinks_to_claude" });
    expect(snapshot.agents.status).toBe("symlink");
    expect(snapshot.agents.symlinkReachable).toBe(true);
    expect(snapshot.claude.status).toBe("regular");
  });

  // Foundation's own inventory: CLAUDE.md -> AGENTS.md.
  test("classifies the Foundation direction: CLAUDE.md symlinks to AGENTS.md", () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "AGENTS.md"), "# entry\n", "utf8");
    symlinkSync("AGENTS.md", join(repoRoot, "CLAUDE.md"));

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "claude_symlinks_to_agents" });
    expect(snapshot.claude.symlinkReachable).toBe(true);
  });

  test("classifies an absolute-path sibling symlink as healthy, not broken", () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# entry\n", "utf8");
    symlinkSync(join(repoRoot, "CLAUDE.md"), join(repoRoot, "AGENTS.md"));

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "agents_symlinks_to_claude" });
  });

  test("classifies a symlink whose literal target name matches the sibling but is unreachable as broken, not healthy", () => {
    const repoRoot = makeRoot();
    // No CLAUDE.md is ever created: the target name matches the sibling filename
    // but nothing exists there.
    symlinkSync("CLAUDE.md", join(repoRoot, "AGENTS.md"));

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "broken_symlink", which: "AGENTS.md" });
    expect(snapshot.agents.symlinkReachable).toBe(false);
  });

  test("classifies a two-node symlink cycle distinctly from a healthy or a broken link", () => {
    const repoRoot = makeRoot();
    symlinkSync("CLAUDE.md", join(repoRoot, "AGENTS.md"));
    symlinkSync("AGENTS.md", join(repoRoot, "CLAUDE.md"));

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "circular_symlinks" });
  });

  test("classifies a reachable symlink pointing at neither sibling as elsewhere, not broken", () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "OTHER.md"), "# other\n", "utf8");
    symlinkSync("OTHER.md", join(repoRoot, "AGENTS.md"));

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toMatchObject({
      kind: "symlink_points_elsewhere",
      which: "AGENTS.md",
    });
  });

  test("classifies two independent regular files", () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "AGENTS.md"), "# agents\n", "utf8");
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# claude\n", "utf8");

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "independent_regular_files" });
  });

  test("classifies both missing", () => {
    const repoRoot = makeRoot();
    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "both_missing" });
    expect(snapshot.agents.status).toBe("missing");
    expect(snapshot.claude.status).toBe("missing");
  });

  test("classifies a single regular file with the other missing", () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "AGENTS.md"), "# agents only\n", "utf8");

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "single_regular_file", which: "AGENTS.md" });
  });

  test("classifies a broken symlink with a nonexistent target name as broken", () => {
    const repoRoot = makeRoot();
    symlinkSync("does-not-exist.md", join(repoRoot, "AGENTS.md"));

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.relationship).toEqual({ kind: "broken_symlink", which: "AGENTS.md" });
  });

  test("rejects a non-regular node (directory in place of the file) without throwing", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "AGENTS.md"));
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# claude\n", "utf8");

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.agents.status).toBe("unreadable");
  });

  test("detects a foreign, non-Paseo HARNESS:BEGIN marker without matching it as managed", () => {
    const repoRoot = makeRoot();
    writeFileSync(
      join(repoRoot, "AGENTS.md"),
      "# agents\n\n<!-- HARNESS:BEGIN -->\nlegacy owner content\n<!-- HARNESS:END -->\n",
      "utf8",
    );
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# claude\n", "utf8");

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.agents.hasForeignHarnessMarker).toBe(true);
    expect(snapshot.agents.hasManagedHarnessBlock).toBe(false);
  });

  test("recognizes an already-inserted managed Paseo block", () => {
    const repoRoot = makeRoot();
    const block = buildManagedHarnessBlock("Read the harness index.");
    writeFileSync(join(repoRoot, "AGENTS.md"), `# agents\n\n${block}\n`, "utf8");
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# claude\n", "utf8");

    const snapshot = inspectHarnessEntrypoints(repoRoot);
    expect(snapshot.agents.hasManagedHarnessBlock).toBe(true);
    expect(snapshot.agents.hasForeignHarnessMarker).toBe(false);
  });
});

describe("buildHarnessEntrypointMigrationPreview", () => {
  test("skips both files when routed through a healthy symlink", () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# entry\n", "utf8");
    symlinkSync("CLAUDE.md", join(repoRoot, "AGENTS.md"));
    const snapshot = inspectHarnessEntrypoints(repoRoot);

    const preview = buildHarnessEntrypointMigrationPreview(snapshot);

    expect(preview.actions).toEqual([
      { fileName: "AGENTS.md", action: "none_routes_via_symlink" },
      { fileName: "CLAUDE.md", action: "insert_managed_block" },
    ]);
  });

  test("does not silently route through a symlink that only names the sibling but is unreachable", () => {
    const repoRoot = makeRoot();
    symlinkSync("CLAUDE.md", join(repoRoot, "AGENTS.md"));
    const snapshot = inspectHarnessEntrypoints(repoRoot);

    const preview = buildHarnessEntrypointMigrationPreview(snapshot);

    expect(preview.actions[0]).toMatchObject({
      fileName: "AGENTS.md",
      action: "manual_reconciliation_required",
    });
  });

  test("proposes inserting a managed block into two independent regular files", () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "AGENTS.md"), "# agents\n", "utf8");
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# claude\n", "utf8");
    const snapshot = inspectHarnessEntrypoints(repoRoot);

    const preview = buildHarnessEntrypointMigrationPreview(snapshot);

    expect(preview.actions).toEqual([
      { fileName: "AGENTS.md", action: "insert_managed_block" },
      { fileName: "CLAUDE.md", action: "insert_managed_block" },
    ]);
  });

  test("proposes creating missing files with only the managed block", () => {
    const repoRoot = makeRoot();
    const snapshot = inspectHarnessEntrypoints(repoRoot);

    const preview = buildHarnessEntrypointMigrationPreview(snapshot);

    expect(preview.actions).toEqual([
      { fileName: "AGENTS.md", action: "create_with_managed_block_only" },
      { fileName: "CLAUDE.md", action: "create_with_managed_block_only" },
    ]);
  });

  test("requires manual reconciliation for a foreign harness marker instead of inserting a block", () => {
    const repoRoot = makeRoot();
    writeFileSync(
      join(repoRoot, "AGENTS.md"),
      "# agents\n\n<!-- HARNESS:BEGIN -->\nlegacy owner content\n<!-- HARNESS:END -->\n",
      "utf8",
    );
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# claude\n", "utf8");
    const snapshot = inspectHarnessEntrypoints(repoRoot);

    const preview = buildHarnessEntrypointMigrationPreview(snapshot);

    expect(preview.actions[0]).toMatchObject({
      fileName: "AGENTS.md",
      action: "manual_reconciliation_required",
    });
    expect(preview.actions[1]).toEqual({ fileName: "CLAUDE.md", action: "insert_managed_block" });
  });

  test("requires manual reconciliation for a caller-supplied foreign manifest claim even without a marker", () => {
    const repoRoot = makeRoot();
    // No HARNESS:BEGIN marker anywhere in the file: ownership comes only from an
    // external manifest (e.g. `.harness-core/manifest.json`) that the caller reads
    // separately and passes in.
    writeFileSync(join(repoRoot, "AGENTS.md"), "# agents, silently owned elsewhere\n", "utf8");
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# claude\n", "utf8");
    const snapshot = inspectHarnessEntrypoints(repoRoot);

    const preview = buildHarnessEntrypointMigrationPreview(snapshot, {
      foreignOwnership: new Map([["AGENTS.md", "declared in .harness-core/manifest.json"]]),
    });

    expect(preview.actions[0]).toEqual({
      fileName: "AGENTS.md",
      action: "manual_reconciliation_required",
      reason: "declared in .harness-core/manifest.json",
    });
    expect(preview.actions[1]).toEqual({ fileName: "CLAUDE.md", action: "insert_managed_block" });
  });

  test("leaves an already-managed block alone (idempotent re-inspection)", () => {
    const repoRoot = makeRoot();
    const block = buildManagedHarnessBlock("Read the harness index.");
    writeFileSync(join(repoRoot, "AGENTS.md"), `# agents\n\n${block}\n`, "utf8");
    writeFileSync(join(repoRoot, "CLAUDE.md"), `# claude\n\n${block}\n`, "utf8");
    const snapshot = inspectHarnessEntrypoints(repoRoot);

    const preview = buildHarnessEntrypointMigrationPreview(snapshot);

    expect(preview.actions).toEqual([
      { fileName: "AGENTS.md", action: "none_already_managed" },
      { fileName: "CLAUDE.md", action: "none_already_managed" },
    ]);
  });
});

describe("buildManagedHarnessBlock", () => {
  test("wraps caller-supplied body verbatim without inventing routing prose", () => {
    const block = buildManagedHarnessBlock("  exact Foundation-authored body  ");
    expect(block).toBe(
      "<!-- PASEO_HARNESS:BEGIN -->\nexact Foundation-authored body\n<!-- PASEO_HARNESS:END -->",
    );
  });
});
