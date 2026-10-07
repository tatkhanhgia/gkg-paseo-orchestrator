#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const LOCK_PATH = path.join(REPO_ROOT, "components", "beads-central.lock.json");
const VENDORED_CENTRAL_ROOT = path.join(REPO_ROOT, "components", "beads-central-src");
const ENTRYPOINT = path.join(REPO_ROOT, "scripts", "beads-central-sidecar-entry.py");
const LOCK = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
const CENTRAL_SOURCE_FILES = [
  "LICENSE",
  "README.md",
  "beads_central/__init__.py",
  "beads_central/auth.py",
  "beads_central/beads.py",
  "beads_central/body_limit.py",
  "beads_central/control_store.py",
  "beads_central/instance_lock.py",
  "beads_central/main.py",
  "beads_central/mcp.py",
  "beads_central/models.py",
  "beads_central/projects.py",
  "beads_central/service.py",
  "beads_central/settings.py",
  "constraints.txt",
  "pyproject.toml",
  "third_party/BEADS_SOURCE_SHA256.txt",
  "third_party/NOTICE.md",
  "uv.lock",
];
const MATERIAL_SOURCE_PATHS = [
  ...CENTRAL_SOURCE_FILES,
  "third_party/source-archives/beads-1.1.2.tar.gz",
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    fail(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    fail(`${command} ${args.join(" ")} failed with exit ${String(result.status)}${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function centralSourceSha256(centralRoot) {
  const hash = createHash("sha256");
  for (const relativePath of [...CENTRAL_SOURCE_FILES].sort()) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(path.join(centralRoot, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parseArgs(argv) {
  let output = null;
  let checkToolchain = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      output = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--check-toolchain") {
      checkToolchain = true;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (checkToolchain) return { checkToolchain, output: null };
  if (!output) {
    fail("Usage: build-beads-central-sidecar.mjs --output <directory> | --check-toolchain");
  }
  const resolved = path.resolve(output);
  if (resolved === path.parse(resolved).root || resolved === REPO_ROOT) {
    fail(`Refusing unsafe sidecar output: ${resolved}`);
  }
  return { checkToolchain, output: resolved };
}

function resolveCentralRoot() {
  const configured = process.env.PASEO_BEADS_CENTRAL_SOURCE_ROOT?.trim();
  const candidate = configured || VENDORED_CENTRAL_ROOT;
  if (!existsSync(candidate)) {
    fail(
      `Canonical Beads Central source is missing: ${candidate}. Set PASEO_BEADS_CENTRAL_SOURCE_ROOT.`,
    );
  }
  return realpathSync(candidate);
}

function verifyCentralSource(centralRoot) {
  for (const relativePath of CENTRAL_SOURCE_FILES) {
    const sourcePath = path.join(centralRoot, relativePath);
    if (!existsSync(sourcePath)) fail(`Beads Central source path is missing: ${sourcePath}`);
  }
  const sourceSha = centralSourceSha256(centralRoot);
  if (sourceSha !== LOCK.centralSourceSha256) {
    fail(
      `Beads Central source checksum mismatch: expected ${LOCK.centralSourceSha256}, received ${sourceSha}`,
    );
  }
  if (centralRoot === realpathSync(VENDORED_CENTRAL_ROOT)) {
    const sourceCommitPath = path.join(centralRoot, "SOURCE_COMMIT");
    const sourceCommit = readFileSync(sourceCommitPath, "utf8").trim();
    if (sourceCommit !== LOCK.sourceCommit) {
      fail(
        `Vendored Beads Central source mismatch: expected ${LOCK.sourceCommit}, received ${sourceCommit}`,
      );
    }
    return;
  }
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: centralRoot, capture: true });
  if (commit !== LOCK.sourceCommit) {
    fail(`Beads Central source commit mismatch: expected ${LOCK.sourceCommit}, received ${commit}`);
  }
  const materialStatus = run(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ...MATERIAL_SOURCE_PATHS],
    {
      cwd: centralRoot,
      capture: true,
    },
  );
  if (materialStatus) {
    fail("Beads Central material source paths are dirty; commit or revert them before packaging");
  }
}

function verifyBeadsArchive(archive) {
  const archiveSha = sha256(archive);
  if (archiveSha !== LOCK.beadsSourceSha256) {
    fail(
      `Bundled Beads source checksum mismatch: expected ${LOCK.beadsSourceSha256}, received ${archiveSha}`,
    );
  }
  return archive;
}

async function resolveBeadsArchive(centralRoot, temporaryRoot) {
  const bundledArchive = path.join(
    centralRoot,
    "third_party",
    "source-archives",
    `beads-${LOCK.beadsVersion}.tar.gz`,
  );
  if (existsSync(bundledArchive)) return verifyBeadsArchive(bundledArchive);
  if (typeof LOCK.beadsSourceUrl !== "string" || !LOCK.beadsSourceUrl.startsWith("https://")) {
    fail("Pinned Beads source URL must be HTTPS");
  }
  const response = await fetch(LOCK.beadsSourceUrl, { redirect: "follow" });
  if (!response.ok) {
    fail(`Could not download pinned Beads source: HTTP ${response.status}`);
  }
  const archive = path.join(temporaryRoot, `beads-${LOCK.beadsVersion}.tar.gz`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  return verifyBeadsArchive(archive);
}

// A configured PASEO_BEADS_BD_BIN that does not exist is a typo, not a request to build bd from
// source; falling through to Go would report a missing Go toolchain instead of the real mistake.
function resolvePrebuiltBd(centralRoot) {
  const configured = process.env.PASEO_BEADS_BD_BIN?.trim();
  if (configured) {
    if (!existsSync(configured)) fail(`PASEO_BEADS_BD_BIN points to a missing file: ${configured}`);
    return realpathSync(configured);
  }
  const bundled = path.join(centralRoot, "dist", process.platform === "win32" ? "bd.exe" : "bd");
  return existsSync(bundled) ? realpathSync(bundled) : null;
}

function resolveBdBinary(centralRoot, archive, temporaryRoot) {
  const prebuilt = resolvePrebuiltBd(centralRoot);
  if (prebuilt) return { binary: prebuilt, goRuntime: "prebuilt" };
  const output = path.join(temporaryRoot, process.platform === "win32" ? "bd.exe" : "bd");
  const sourceRoot = path.join(temporaryRoot, "beads-source");
  mkdirSync(sourceRoot, { recursive: true });
  run("tar", ["-xf", archive, "-C", sourceRoot]);
  const extractedRoot = path.join(sourceRoot, `beads-${LOCK.beadsVersion}`);
  if (!existsSync(path.join(extractedRoot, "go.mod"))) {
    fail(`Extracted Beads source is missing go.mod: ${extractedRoot}`);
  }
  const goRuntime = resolveGoRuntime();
  run(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.Build=v${LOCK.beadsVersion}-bundled`,
      "-o",
      output,
      "./cmd/bd",
    ],
    {
      cwd: extractedRoot,
      env: {
        ...process.env,
        CGO_ENABLED: "1",
        GOFLAGS: "-tags=gms_pure_go",
        GOTOOLCHAIN: "local",
      },
    },
  );
  if (!existsSync(output)) {
    fail(`Go build did not produce the bundled Beads binary: ${output}`);
  }
  return { binary: output, goRuntime };
}

function resolveUvRuntime() {
  const uv = process.env.PASEO_UV_BIN?.trim() || "uv";
  const version = run(uv, ["--version"], { capture: true });
  if (!version.startsWith(`uv ${LOCK.uvVersion}`)) {
    fail(`uv version mismatch: expected ${LOCK.uvVersion}, received ${version}`);
  }
  return { uv, version };
}

function resolveGoRuntime() {
  const version = run("go", ["version"], { capture: true });
  const compatibleSeries = LOCK.goVersion.split(".").slice(0, 2).join(".");
  if (!version.includes(`go${compatibleSeries}.`)) {
    fail(`Go version mismatch: expected ${compatibleSeries}.x, received ${version}`);
  }
  return version;
}

function resolvePythonRuntime() {
  const python = process.env.PASEO_PYTHON_BIN?.trim() || "python";
  const version = run(python, ["--version"], { capture: true });
  const compatibleSeries = LOCK.pythonVersion.split(".").slice(0, 2).join(".");
  if (!version.startsWith(`Python ${compatibleSeries}.`)) {
    fail(`Python version mismatch: expected ${compatibleSeries}.x, received ${version}`);
  }
  return { python, version };
}

// Checks every external tool the sidecar build needs and reports all problems at once, so a
// release build fails in seconds instead of after the Node product build has already run.
function assertToolchainReady(centralRoot) {
  const problems = [];
  const check = (hint, probe) => {
    try {
      return probe();
    } catch (error) {
      problems.push(`${error instanceof Error ? error.message : String(error)}\n    -> ${hint}`);
      return null;
    }
  };
  const uv = check(`set PASEO_UV_BIN to a uv ${LOCK.uvVersion} binary`, resolveUvRuntime);
  const python = check(
    `set PASEO_PYTHON_BIN to a Python ${LOCK.pythonVersion.split(".").slice(0, 2).join(".")} interpreter`,
    resolvePythonRuntime,
  );
  const bd = check(
    `set PASEO_BEADS_BD_BIN to a prebuilt bd ${LOCK.beadsVersion}, or install Go ${LOCK.goVersion.split(".").slice(0, 2).join(".")}.x to build it`,
    () => {
      const prebuilt = resolvePrebuiltBd(centralRoot);
      return prebuilt ? verifyBdBinary(prebuilt) : `built from source with ${resolveGoRuntime()}`;
    },
  );
  if (problems.length > 0) {
    fail(
      `Beads Central sidecar toolchain is not ready (see docs/release.md#local-release-build):\n  ${problems.join("\n  ")}`,
    );
  }
  process.stdout.write(
    `Beads Central sidecar toolchain ready: ${uv.version}; ${python.version}; ${bd}\n`,
  );
}

function buildPythonSidecar(centralRoot, temporaryRoot, uv, python) {
  const distRoot = path.join(temporaryRoot, "dist");
  const workRoot = path.join(temporaryRoot, "work");
  const specRoot = path.join(temporaryRoot, "spec");
  run(
    uv,
    [
      "run",
      "--locked",
      "--project",
      centralRoot,
      "--with",
      `pyinstaller==${LOCK.pyinstallerVersion}`,
      "pyinstaller",
      "--noconfirm",
      "--clean",
      "--onedir",
      "--name",
      "beads-central",
      "--distpath",
      distRoot,
      "--workpath",
      workRoot,
      "--specpath",
      specRoot,
      "--paths",
      centralRoot,
      "--collect-all",
      "uvicorn",
      "--collect-all",
      "fastapi",
      "--collect-all",
      "pydantic",
      "--collect-all",
      "yaml",
      ENTRYPOINT,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: path.join(temporaryRoot, "venv"),
        UV_PYTHON: python,
        UV_NO_MANAGED_PYTHON: "1",
      },
    },
  );
  const bundleRoot = path.join(distRoot, "beads-central");
  const executable = path.join(
    bundleRoot,
    process.platform === "win32" ? "beads-central.exe" : "beads-central",
  );
  if (!existsSync(executable)) fail(`PyInstaller output is missing: ${executable}`);
  return bundleRoot;
}

function verifyBdBinary(bdBinary) {
  const version = run(bdBinary, ["version"], { capture: true });
  if (!version.startsWith(`bd version ${LOCK.beadsVersion}`)) {
    fail(`Bundled bd version mismatch: ${version}`);
  }
  return version;
}

function extractBeadsLicense(archive, target) {
  const result = spawnSync("tar", ["-xOf", archive, `beads-${LOCK.beadsVersion}/LICENSE`], {
    encoding: null,
  });
  if (result.status !== 0 || !result.stdout) {
    fail("Could not extract the bundled Beads license from the pinned source archive");
  }
  writeFileSync(target, result.stdout);
}

function assertPortableSymlinks(root, current = root) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      assertPortableSymlinks(root, entryPath);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;

    let resolved;
    try {
      resolved = realpathSync(entryPath);
    } catch {
      fail(`PyInstaller output contains a broken symlink: ${entryPath}`);
    }
    const relativeTarget = path.relative(root, resolved);
    if (
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      fail(`PyInstaller output contains a non-portable external symlink: ${entryPath}`);
    }
  }
}

function assemble(
  output,
  centralRoot,
  archive,
  pythonBundle,
  bdBinary,
  bdVersion,
  goRuntime,
  uvRuntime,
  pythonRuntime,
) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.dirname(output), { recursive: true });
  // PyInstaller's macOS framework build uses relative links inside the bundle.
  // Node resolves copied links against the temporary source unless verbatim copy
  // is requested, leaving `_internal/Python` pointed at a directory we delete.
  cpSync(pythonBundle, output, { recursive: true, verbatimSymlinks: true });
  assertPortableSymlinks(output);
  const binRoot = path.join(output, "bin");
  const licensesRoot = path.join(output, "licenses");
  mkdirSync(binRoot, { recursive: true });
  mkdirSync(licensesRoot, { recursive: true });
  const bundledBd = path.join(binRoot, process.platform === "win32" ? "bd.exe" : "bd");
  copyFileSync(bdBinary, bundledBd);
  copyFileSync(path.join(centralRoot, "LICENSE"), path.join(licensesRoot, "beads-central-LICENSE"));
  copyFileSync(
    path.join(centralRoot, "third_party", "NOTICE.md"),
    path.join(licensesRoot, "NOTICE.md"),
  );
  extractBeadsLicense(archive, path.join(licensesRoot, "beads-LICENSE"));
  if (process.platform !== "win32") {
    chmodSync(path.join(output, "beads-central"), 0o755);
    chmodSync(bundledBd, 0o755);
  }
  const manifest = {
    schemaVersion: 1,
    component: "beads-central",
    version: LOCK.version,
    sourceCommit: LOCK.sourceCommit,
    centralSourceSha256: LOCK.centralSourceSha256,
    platform: process.platform,
    arch: process.arch,
    pyinstallerVersion: LOCK.pyinstallerVersion,
    uvRuntime,
    goRuntime,
    pythonRuntime,
    beadsVersion: LOCK.beadsVersion,
    beadsSourceSha256: LOCK.beadsSourceSha256,
    sidecarBinarySha256: sha256(
      path.join(output, process.platform === "win32" ? "beads-central.exe" : "beads-central"),
    ),
    beadsBinarySha256: sha256(bundledBd),
    beadsRuntime: bdVersion,
  };
  writeFileSync(
    path.join(output, "component-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function main() {
  const { checkToolchain, output } = parseArgs(process.argv.slice(2));
  const centralRoot = resolveCentralRoot();
  if (checkToolchain) {
    assertToolchainReady(centralRoot);
    return;
  }
  verifyCentralSource(centralRoot);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-beads-sidecar-build."));
  try {
    const archive = await resolveBeadsArchive(centralRoot, temporaryRoot);
    const { uv, version: uvRuntime } = resolveUvRuntime();
    const { python, version: pythonRuntime } = resolvePythonRuntime();
    const { binary: bdBinary, goRuntime } = resolveBdBinary(centralRoot, archive, temporaryRoot);
    const bdVersion = verifyBdBinary(bdBinary);
    const pythonBundle = buildPythonSidecar(centralRoot, temporaryRoot, uv, python);
    assemble(
      output,
      centralRoot,
      archive,
      pythonBundle,
      bdBinary,
      bdVersion,
      goRuntime,
      uvRuntime,
      pythonRuntime,
    );
    process.stdout.write(`Bundled Beads Central ${LOCK.version} sidecar at ${output}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `build-beads-central-sidecar: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
