import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { renderHarnessTemplate } from "./harness-template-render.js";

let repoRoot: string;

afterEach(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

function makeRepo(): string {
  repoRoot = mkdtempSync(join(tmpdir(), "harness-template-render-test-"));
  mkdirSync(join(repoRoot, "docs", "harness"), { recursive: true });
  writeFileSync(join(repoRoot, "docs", "harness", "README.md"), "entry map\n");
  writeFileSync(join(repoRoot, "WORKSPACE_PROTOCOL.md"), "protocol\n");
  return repoRoot;
}

describe("renderHarnessTemplate", () => {
  test("resolves the entry map path relative to a repo-root entrypoint (AGENTS.md)", () => {
    const root = makeRepo();
    const rendered = renderHarnessTemplate("Read [Project Harness]({{HARNESS:ENTRY_MAP_PATH}}).", {
      outputFilePath: join(root, "AGENTS.md"),
      entryMapPath: join(root, "docs", "harness", "README.md"),
    });
    expect(rendered).toBe("Read [Project Harness](docs/harness/README.md).");
  });

  test("resolves the same token differently when materialized at a nested index file", () => {
    const root = makeRepo();
    const rendered = renderHarnessTemplate("See {{HARNESS:WORKSPACE_PROTOCOL_PATH}} for tactics.", {
      outputFilePath: join(root, "docs", "harness", "README.md"),
      workspaceProtocolPath: join(root, "WORKSPACE_PROTOCOL.md"),
    });
    expect(rendered).toBe("See ../../WORKSPACE_PROTOCOL.md for tactics.");
  });

  test("rejects an unknown token name instead of leaving it in the output", () => {
    const root = makeRepo();
    expect(() =>
      renderHarnessTemplate("{{NOT_A_REAL_TOKEN}}", {
        outputFilePath: join(root, "AGENTS.md"),
      }),
    ).toThrow(/unknown harness template token/u);
  });

  test("rejects a known token when the caller supplied no target for it", () => {
    const root = makeRepo();
    expect(() =>
      renderHarnessTemplate("{{HARNESS:WORKSPACE_PROTOCOL_PATH}}", {
        outputFilePath: join(root, "AGENTS.md"),
      }),
    ).toThrow(/no target path was supplied/u);
  });

  test("rejects a known token whose supplied target does not actually exist on disk", () => {
    const root = makeRepo();
    expect(() =>
      renderHarnessTemplate("{{HARNESS:ENTRY_MAP_PATH}}", {
        outputFilePath: join(root, "AGENTS.md"),
        entryMapPath: join(root, "docs", "harness", "MISSING.md"),
      }),
    ).toThrow(/not a reachable regular file/u);
  });

  test("renders multiple distinct tokens in one template", () => {
    const root = makeRepo();
    const rendered = renderHarnessTemplate(
      "{{HARNESS:ENTRY_MAP_PATH}} | {{HARNESS:WORKSPACE_PROTOCOL_PATH}}",
      {
        outputFilePath: join(root, "AGENTS.md"),
        entryMapPath: join(root, "docs", "harness", "README.md"),
        workspaceProtocolPath: join(root, "WORKSPACE_PROTOCOL.md"),
      },
    );
    expect(rendered).toBe("docs/harness/README.md | WORKSPACE_PROTOCOL.md");
  });

  test("leaves plain text with no tokens untouched", () => {
    const root = makeRepo();
    expect(
      renderHarnessTemplate("no tokens here", { outputFilePath: join(root, "AGENTS.md") }),
    ).toBe("no tokens here");
  });

  test("rejects a lowercase or malformed placeholder instead of leaving it unresolved in the output", () => {
    const root = makeRepo();
    expect(() =>
      renderHarnessTemplate("{{harness:entry_map_path}}", {
        outputFilePath: join(root, "AGENTS.md"),
        entryMapPath: join(root, "docs", "harness", "README.md"),
      }),
    ).toThrow(/unknown harness template token/u);
  });

  test("rejects a target path that is a directory, not a regular file", () => {
    const root = makeRepo();
    expect(() =>
      renderHarnessTemplate("{{HARNESS:ENTRY_MAP_PATH}}", {
        outputFilePath: join(root, "AGENTS.md"),
        entryMapPath: join(root, "docs", "harness"),
      }),
    ).toThrow(/not a reachable regular file/u);
  });

  test("percent-encodes spaces and parentheses so the rendered Markdown link target stays valid", () => {
    const root = makeRepo();
    mkdirSync(join(root, "docs (drafts)"), { recursive: true });
    writeFileSync(join(root, "docs (drafts)", "entry map.md"), "entry map\n");

    const rendered = renderHarnessTemplate("[link]({{HARNESS:ENTRY_MAP_PATH}})", {
      outputFilePath: join(root, "AGENTS.md"),
      entryMapPath: join(root, "docs (drafts)", "entry map.md"),
    });

    expect(rendered).toBe("[link](docs%20%28drafts%29/entry%20map.md)");
  });

  test("computes the relative path from a symlink entrypoint's own location, not its resolved target", () => {
    const root = makeRepo();
    const targetDir = join(root, "elsewhere");
    mkdirSync(targetDir, { recursive: true });
    // CLAUDE.md lives at repo root and AGENTS.md would symlink to it; the
    // render must use the addressed path (AGENTS.md at repo root), not any
    // resolved realpath, so relative distances stay correct in either
    // direction of the symlink.
    const rendered = renderHarnessTemplate("{{HARNESS:ENTRY_MAP_PATH}}", {
      outputFilePath: join(root, "AGENTS.md"),
      entryMapPath: join(root, "docs", "harness", "README.md"),
    });
    expect(rendered).toBe("docs/harness/README.md");
  });
});
