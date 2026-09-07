import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendProjectNotebookRecord,
  inspectProjectNotebook,
  writeProjectNotebook,
} from "./project-notebook-file.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "project-notebook-file-test-"));
  tempDirs.push(root);
  return root;
}

const NOTEBOOK_RELATIVE_PATH = "docs/harness/SUPERVISOR_NOTEBOOK.md";

describe("inspectProjectNotebook", () => {
  test("reports missing when the notebook does not exist yet", () => {
    const repoRoot = makeRoot();
    expect(inspectProjectNotebook(repoRoot, NOTEBOOK_RELATIVE_PATH)).toEqual({
      status: "missing",
      repoRoot,
      path: join(repoRoot, NOTEBOOK_RELATIVE_PATH),
      revision: null,
    });
  });

  test("reads back exact content and a stable revision for unchanged bytes", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });
    writeFileSync(join(repoRoot, NOTEBOOK_RELATIVE_PATH), "# Notebook\n", "utf8");

    const snapshot = inspectProjectNotebook(repoRoot, NOTEBOOK_RELATIVE_PATH);
    expect(snapshot.status).toBe("valid");
    if (snapshot.status !== "valid") throw new Error("expected valid snapshot");
    expect(snapshot.content).toBe("# Notebook\n");

    const again = inspectProjectNotebook(repoRoot, NOTEBOOK_RELATIVE_PATH);
    expect(again).toEqual(snapshot);
  });
});

describe("writeProjectNotebook — positive", () => {
  test("creates a missing notebook when caller matches the designated writer", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });

    const result = writeProjectNotebook({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "# Notebook\n\nFirst record.",
      expectedRevision: null,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok write");
    expect(result.snapshot.content).toBe("# Notebook\n\nFirst record.\n");

    const readback = inspectProjectNotebook(repoRoot, NOTEBOOK_RELATIVE_PATH);
    expect(readback).toEqual(result.snapshot);
  });

  test("performs a revision-safe update when expectedRevision matches current state", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });
    const created = writeProjectNotebook({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "# Notebook\n\nFirst record.",
      expectedRevision: null,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });
    if (!created.ok) throw new Error("expected ok create");

    const updated = writeProjectNotebook({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "# Notebook\n\nFirst record.\n\nSecond record.",
      expectedRevision: created.snapshot.revision,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("expected ok update");
    expect(updated.snapshot.content).toContain("Second record.");
    expect(updated.snapshot.revision).not.toEqual(created.snapshot.revision);
  });
});

describe("writeProjectNotebook — negative", () => {
  test("rejects a stale expectedRevision without mutating the file", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });
    const created = writeProjectNotebook({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "# Notebook\n\nFirst record.",
      expectedRevision: null,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });
    if (!created.ok) throw new Error("expected ok create");

    const staleAttempt = writeProjectNotebook({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "# Notebook\n\nConcurrent overwrite attempt.",
      expectedRevision: null, // stale: notebook is no longer missing
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(staleAttempt.ok).toBe(false);
    if (staleAttempt.ok) throw new Error("expected stale rejection");
    expect(staleAttempt.error.code).toBe("stale_notebook");

    const unchanged = inspectProjectNotebook(repoRoot, NOTEBOOK_RELATIVE_PATH);
    expect(unchanged).toEqual(created.snapshot);
  });

  test("rejects a caller that is not the designated writer, without mutating the file", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });

    const result = writeProjectNotebook({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "# Notebook\n\nUnauthorized attempt.",
      expectedRevision: null,
      callerId: "supervisor-agent-2",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result).toEqual({ ok: false, error: { code: "not_designated_writer" } });
    expect(inspectProjectNotebook(repoRoot, NOTEBOOK_RELATIVE_PATH).status).toBe("missing");
  });

  test("rejects an absolute relativePath", () => {
    const repoRoot = makeRoot();
    const result = writeProjectNotebook({
      repoRoot,
      relativePath: "/etc/passwd",
      content: "malicious",
      expectedRevision: null,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error.code).toBe("invalid_path");
  });

  test("rejects a relativePath that traverses outside repoRoot", () => {
    const repoRoot = makeRoot();
    const result = writeProjectNotebook({
      repoRoot,
      relativePath: "../../../etc/passwd",
      content: "malicious",
      expectedRevision: null,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error.code).toBe("invalid_path");
  });

  test("refuses to write through an existing symlink at the notebook path", () => {
    const repoRoot = makeRoot();
    const outsideRoot = makeRoot();
    writeFileSync(join(outsideRoot, "escape-target.md"), "# not this project's notebook\n", "utf8");
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });
    symlinkSync(join(outsideRoot, "escape-target.md"), join(repoRoot, NOTEBOOK_RELATIVE_PATH));

    const result = writeProjectNotebook({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "attempted overwrite via symlink",
      expectedRevision: null,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error.code).toBe("write_failed");
  });

  test("cross-project identity: a notebook write bound to project A's repoRoot cannot target project B's tree by relativePath alone", () => {
    const projectA = makeRoot();
    const projectB = makeRoot();
    mkdirSync(join(projectB, "docs", "harness"), { recursive: true });
    writeFileSync(join(projectB, NOTEBOOK_RELATIVE_PATH), "# project B notebook\n", "utf8");

    // A caller bound to project A's repoRoot writes; it must land under project A,
    // never touch project B's file, even though the relativePath string is identical.
    mkdirSync(join(projectA, "docs", "harness"), { recursive: true });
    const result = writeProjectNotebook({
      repoRoot: projectA,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "# project A notebook",
      expectedRevision: null,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result.ok).toBe(true);
    const projectBSnapshot = inspectProjectNotebook(projectB, NOTEBOOK_RELATIVE_PATH);
    expect(projectBSnapshot.status).toBe("valid");
    if (projectBSnapshot.status !== "valid") throw new Error("expected valid snapshot");
    expect(projectBSnapshot.content).toBe("# project B notebook\n");
  });

  test("refuses to write when an ancestor directory of the notebook path is a symlink escaping repoRoot", () => {
    const repoRoot = makeRoot();
    const outsideRoot = makeRoot();
    const outsideHarnessDir = join(outsideRoot, "harness");
    mkdirSync(outsideHarnessDir, { recursive: true });
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    // `docs/harness` itself is a symlink pointing outside repoRoot, rather
    // than the notebook leaf file — the earlier lexical-only containment
    // check could not detect this class of escape.
    symlinkSync(outsideHarnessDir, join(repoRoot, "docs", "harness"));

    const result = writeProjectNotebook({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      content: "attempted write through symlinked ancestor",
      expectedRevision: null,
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error.code).toBe("invalid_path");
    expect(existsSync(join(outsideHarnessDir, "SUPERVISOR_NOTEBOOK.md"))).toBe(false);
  });
});

describe("appendProjectNotebookRecord", () => {
  test("creates the notebook from empty when it does not exist yet", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });

    const result = appendProjectNotebookRecord({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      recordContent: "Pattern / episode: first record",
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok append");
    expect(result.snapshot.content).toBe("Pattern / episode: first record\n");
  });

  test("preserves every prior record: the new content always contains the old content as a prefix", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });

    const first = appendProjectNotebookRecord({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      recordContent: "Pattern / episode: first record",
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });
    if (!first.ok) throw new Error("expected ok append");

    const second = appendProjectNotebookRecord({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      recordContent: "Pattern / episode: second record",
      callerId: "supervisor-agent-1",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok append");
    expect(second.snapshot.content.startsWith(first.snapshot.content)).toBe(true);
    expect(second.snapshot.content).toContain("first record");
    expect(second.snapshot.content).toContain("second record");
  });

  test("still enforces the designated-writer check, refusing to append for any other caller", () => {
    const repoRoot = makeRoot();
    mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });

    const result = appendProjectNotebookRecord({
      repoRoot,
      relativePath: NOTEBOOK_RELATIVE_PATH,
      recordContent: "Pattern / episode: unauthorized",
      callerId: "supervisor-agent-2",
      designatedWriterId: "supervisor-agent-1",
    });

    expect(result).toEqual({ ok: false, error: { code: "not_designated_writer" } });
    expect(inspectProjectNotebook(repoRoot, NOTEBOOK_RELATIVE_PATH).status).toBe("missing");
  });
});
