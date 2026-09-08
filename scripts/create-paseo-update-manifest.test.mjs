import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);

test("creates the final manifest only from all four exact downstream checksums", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-update-manifest-"));
  try {
    const artifacts = path.join(root, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const version = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")).version;
    const targets = [
      ["macos-arm64", ".tar.gz"],
      ["macos-x64", ".tar.gz"],
      ["linux-x64", ".tar.gz"],
      ["windows-x64", ".zip"],
    ];
    for (const [target, extension] of targets) {
      const directory = path.join(artifacts, target);
      mkdirSync(directory, { recursive: true });
      const name = `paseo-web-cli-${version}-${target}${extension}`;
      const bytes = `fixture-${target}`;
      const digest = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(path.join(directory, name), bytes);
      writeFileSync(path.join(directory, `${name}.sha256`), `${digest}  ${name}\n`);
    }
    const output = path.join(root, "paseo-update-manifest.json");
    execFileSync(
      process.execPath,
      [
        new URL("scripts/create-paseo-update-manifest.mjs", repoRoot).pathname,
        "--artifacts",
        artifacts,
        "--output",
        output,
      ],
      {
        cwd: new URL(".", repoRoot).pathname,
        env: { ...process.env, GITHUB_SHA: "f".repeat(40) },
      },
    );
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.version, version);
    assert.equal(manifest.tag, `paseo-v${version}`);
    assert.equal(
      manifest.sourceCommit,
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: new URL(".", repoRoot).pathname,
        encoding: "utf8",
      }).trim(),
    );
    assert.notEqual(manifest.sourceCommit, "f".repeat(40));
    assert.deepEqual(
      Object.keys(manifest.assets),
      targets.map(([target]) => target),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when any platform artifact is missing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-update-manifest-missing-"));
  try {
    const artifacts = path.join(root, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          new URL("scripts/create-paseo-update-manifest.mjs", repoRoot).pathname,
          "--artifacts",
          artifacts,
          "--output",
          path.join(root, "manifest.json"),
        ],
        { cwd: new URL(".", repoRoot).pathname, stdio: "pipe" },
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-target release qualifies only ARM64 and rejects corrupt bytes or unknown targets", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-arm64-manifest-"));
  try {
    const version = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")).version;
    const name = `paseo-web-cli-${version}-macos-arm64.tar.gz`;
    const archive = path.join(root, name);
    const bytes = "qualified ARM64 fixture";
    writeFileSync(archive, bytes);
    writeFileSync(
      `${archive}.sha256`,
      `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`,
    );
    const output = path.join(root, "manifest.json");
    const run = (target) =>
      execFileSync(
        process.execPath,
        [
          new URL("scripts/create-paseo-update-manifest.mjs", repoRoot).pathname,
          "--target",
          target,
          "--artifacts",
          root,
          "--output",
          output,
        ],
        { cwd: new URL(".", repoRoot).pathname, stdio: "pipe" },
      );
    run("macos-arm64");
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(Object.keys(manifest.assets), ["macos-arm64"]);
    assert.equal(manifest.assets["macos-arm64"].name, name);
    assert.throws(() => run("linux-x64"));
    assert.throws(() => run("unknown"));
    writeFileSync(archive, "corrupt");
    assert.throws(() => run("macos-arm64"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
