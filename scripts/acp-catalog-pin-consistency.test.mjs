import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const checkerPath = new URL("check-acp-catalog-version-drift.mjs", import.meta.url);
const catalogPath = new URL("packages/app/src/data/acp-provider-catalog.ts", repoRoot);

test("downstream hard gate checks exact pin consistency without registry freshness", () => {
  const output = execFileSync(
    process.execPath,
    [checkerPath.pathname, "--no-network", "--fail-on-drift"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(output, /drift:\s+0/);
});

test("downstream hard gate rejects catalog and command pin mismatch", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-acp-pin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixturePath = path.join(directory, "acp-provider-catalog.ts");
  const source = readFileSync(catalogPath, "utf8");
  // Bump only the command selector's patch so it no longer matches the entry's version field.
  const mismatched = source.replace(
    /@qwen-code\/qwen-code@(\d+\.\d+\.)(\d+)/,
    (_match, prefix, patch) => `@qwen-code/qwen-code@${prefix}${Number(patch) + 1}`,
  );
  assert.notEqual(mismatched, source);
  writeFileSync(fixturePath, mismatched);

  const result = spawnSync(
    process.execPath,
    [checkerPath.pathname, "--no-network", "--fail-on-drift"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PASEO_ACP_CATALOG_PATH: fixturePath },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /catalog version does not match command selector/);
});
