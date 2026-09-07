import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProjectHarnessFileTransaction,
  inspectProjectHarnessFile,
  recoverProjectHarnessTransactions,
} from "./project-harness-file-transaction.js";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paseo-project-harness-transaction-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project harness file transaction", () => {
  it("applies multiple files only when every expected revision still matches", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "AGENTS.md"), "old agents\n");
    await writeFile(join(root, "CLAUDE.md"), "old claude\n");
    const agents = inspectProjectHarnessFile(root, "AGENTS.md");
    const claude = inspectProjectHarnessFile(root, "CLAUDE.md");

    const result = await applyProjectHarnessFileTransaction({
      rootPath: root,
      guards: [
        { path: "AGENTS.md", expected: agents.revision },
        { path: "CLAUDE.md", expected: claude.revision },
      ],
      writes: [
        { path: "AGENTS.md", expected: agents.revision, content: "new agents\n" },
        { path: "CLAUDE.md", expected: claude.revision, content: "new claude\n" },
      ],
    });

    expect(result).toMatchObject({ ok: true, changedPaths: ["AGENTS.md", "CLAUDE.md"] });
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toBe("new agents\n");
    await expect(readFile(join(root, "CLAUDE.md"), "utf8")).resolves.toBe("new claude\n");
  });

  it("refuses a stale guard without touching another file in the transaction", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "AGENTS.md"), "old agents\n");
    await writeFile(join(root, "CLAUDE.md"), "old claude\n");
    const agents = inspectProjectHarnessFile(root, "AGENTS.md");
    const claude = inspectProjectHarnessFile(root, "CLAUDE.md");
    await writeFile(join(root, "AGENTS.md"), "changed elsewhere\n");

    const result = await applyProjectHarnessFileTransaction({
      rootPath: root,
      guards: [
        { path: "AGENTS.md", expected: agents.revision },
        { path: "CLAUDE.md", expected: claude.revision },
      ],
      writes: [
        { path: "AGENTS.md", expected: agents.revision, content: "new agents\n" },
        { path: "CLAUDE.md", expected: claude.revision, content: "new claude\n" },
      ],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "conflict", paths: ["AGENTS.md"] } });
    await expect(readFile(join(root, "CLAUDE.md"), "utf8")).resolves.toBe("old claude\n");
  });

  it("leaves an interrupted transaction recoverable and restores original bytes", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "AGENTS.md"), "old agents\n");
    await writeFile(join(root, "CLAUDE.md"), "old claude\n");
    const agents = inspectProjectHarnessFile(root, "AGENTS.md");
    const claude = inspectProjectHarnessFile(root, "CLAUDE.md");

    const interrupted = await applyProjectHarnessFileTransaction({
      rootPath: root,
      guards: [
        { path: "AGENTS.md", expected: agents.revision },
        { path: "CLAUDE.md", expected: claude.revision },
      ],
      writes: [
        { path: "AGENTS.md", expected: agents.revision, content: "new agents\n" },
        { path: "CLAUDE.md", expected: claude.revision, content: "new claude\n" },
      ],
      testing: { interruptAfterCommit: 0 },
    });
    expect(interrupted).toMatchObject({ ok: false, error: { code: "recovery_required" } });
    await writeFile(join(root, "unrelated.txt"), "latest unrelated bytes\n");
    expect((await recoverProjectHarnessTransactions(root)).status).toBe("recovered");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toBe("old agents\n");
    await expect(readFile(join(root, "CLAUDE.md"), "utf8")).resolves.toBe("old claude\n");
    await expect(readFile(join(root, "unrelated.txt"), "utf8")).resolves.toBe(
      "latest unrelated bytes\n",
    );
  });

  it("serializes concurrent apply and recovery on one project root", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "AGENTS.md"), "old agents\n");
    const expected = inspectProjectHarnessFile(root, "AGENTS.md").revision;

    const [interrupted, second] = await Promise.all([
      applyProjectHarnessFileTransaction({
        rootPath: root,
        guards: [{ path: "AGENTS.md", expected }],
        writes: [{ path: "AGENTS.md", expected, content: "first transaction\n" }],
        testing: { interruptAfterCommit: 0 },
      }),
      applyProjectHarnessFileTransaction({
        rootPath: root,
        guards: [{ path: "AGENTS.md", expected }],
        writes: [{ path: "AGENTS.md", expected, content: "second transaction\n" }],
      }),
    ]);

    expect(interrupted).toMatchObject({ ok: false, error: { code: "recovery_required" } });
    expect(second).toMatchObject({ ok: true, recoveredTransactionIds: [expect.any(String)] });
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toBe("second transaction\n");
    expect((await recoverProjectHarnessTransactions(root)).status).toBe("none");
  });

  it("fails closed and preserves a caller edit when an interrupted original backup is missing", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "AGENTS.md"), "old agents\n");
    const expected = inspectProjectHarnessFile(root, "AGENTS.md").revision;
    const interrupted = await applyProjectHarnessFileTransaction({
      rootPath: root,
      guards: [{ path: "AGENTS.md", expected }],
      writes: [{ path: "AGENTS.md", expected, content: "installed agents\n" }],
      testing: { interruptAfterCommit: 0 },
    });
    if (interrupted.ok) throw new Error("expected an interrupted transaction");
    const transactionId = interrupted.error.transactionId;
    if (!transactionId) throw new Error("interrupted transaction did not return its id");
    await rm(join(root, ".paseo/.project-harness-transactions", transactionId, "backup-0.bak"));

    const recovery = await recoverProjectHarnessTransactions(root);
    expect(recovery).toMatchObject({ status: "blocked", transactionIds: [transactionId] });
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toBe("installed agents\n");
  });

  it("fails closed on an unsafe persisted journal before touching project bytes", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "AGENTS.md"), "caller bytes\n");
    const transactionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const transactionRoot = join(root, ".paseo/.project-harness-transactions", transactionId);
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(
      join(transactionRoot, "manifest.json"),
      JSON.stringify({
        version: 1,
        transactionId,
        phase: "needs_recovery",
        files: [{ path: "../escape", committed: true }],
      }),
    );

    expect(await recoverProjectHarnessTransactions(root)).toMatchObject({
      status: "blocked",
      transactionIds: [transactionId],
    });
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toBe("caller bytes\n");
  });

  it("fails closed when a managed ancestor path is a symlink outside the project", async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), "paseo-project-harness-outside-"));
    temporaryRoots.push(outside);
    await symlink(outside, join(root, "docs"));

    const missing = inspectProjectHarnessFile(root, "docs/harness/README.md");
    const result = await applyProjectHarnessFileTransaction({
      rootPath: root,
      guards: [{ path: "docs/harness/README.md", expected: missing.revision }],
      writes: [{ path: "docs/harness/README.md", expected: missing.revision, content: "x\n" }],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_target" } });
    await expect(readFile(join(outside, "harness", "README.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
