import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const releaseToolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(process.env.PASEO_RELEASE_ARTIFACT_ROOT ?? releaseToolingRoot);
const version = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const platformName = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];
const extension = process.platform === "win32" ? ".zip" : ".tar.gz";
const bundleName = `paseo-web-cli-${version}-${platformName}-${process.arch}`;
const archive = path.join(repoRoot, "artifacts", `${bundleName}${extension}`);
const checksum = `${archive}.sha256`;
const smokeRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-release-smoke-"));
const terminalRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-release-terminal-"));
const home = path.join(smokeRoot, "home");
const prefix = path.join(smokeRoot, "install");
const binDir = path.join(smokeRoot, "bin");
const port = process.env.PASEO_RELEASE_SMOKE_PORT ?? "17677";
const listen = `127.0.0.1:${port}`;
const degradedPort = process.env.PASEO_RELEASE_SMOKE_DEGRADED_PORT ?? "17678";
const degradedListen = `127.0.0.1:${degradedPort}`;
const beadsCentralPort = process.env.PASEO_RELEASE_SMOKE_BEADS_PORT ?? "17679";
const beadsCentralEndpoint = `http://127.0.0.1:${beadsCentralPort}`;
const installedBeadsCentralRoot = path.join(prefix, "current", "components", "beads-central");
const installedBeadsCentralSidecar = path.join(
  installedBeadsCentralRoot,
  process.platform === "win32" ? "beads-central.exe" : "beads-central",
);
const installedBd = path.join(
  installedBeadsCentralRoot,
  "bin",
  process.platform === "win32" ? "bd.exe" : "bd",
);
const windowsBundleIoTimeoutMs = 10 * 60_000;
const healthPollIntervalMs = 500;
const healthTimeoutMs = Number(process.env.PASEO_RELEASE_SMOKE_HEALTH_TIMEOUT_MS ?? 120_000);
if (!Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < healthPollIntervalMs) {
  throw new Error(
    `PASEO_RELEASE_SMOKE_HEALTH_TIMEOUT_MS must be an integer >= ${healthPollIntervalMs}`,
  );
}
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: path.join(home, "AppData", "Local"),
  APPDATA: path.join(home, "AppData", "Roaming"),
  PASEO_HOME: path.join(home, ".paseo"),
  // The smoke runs the generated installer; it must never address the machine's live service.
  PASEO_LAUNCHD_LABEL: `com.paseo.web-cli.smoke-${process.pid}`,
  PASEO_SYSTEMD_UNIT: `paseo-web-cli-smoke-${process.pid}.service`,
  PASEO_LISTEN: listen,
  PASEO_RELAY_ENABLED: "false",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
  PASEO_BEADS_CENTRAL_SIDECAR: installedBeadsCentralSidecar,
  PASEO_BEADS_CENTRAL_BD_BIN: installedBd,
  PASEO_RELEASE_SMOKE: "1",
  PASEO_BEADS_CENTRAL_SMOKE_ENDPOINT: beadsCentralEndpoint,
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const timeout = options.timeoutMs ?? 120_000;
  process.stdout.write(
    `SMOKE_COMMAND start=${command} args=${JSON.stringify(args)} timeout_ms=${timeout}\n`,
  );
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout,
  });
  if (result.error) {
    fail(
      `${command} ${args.join(" ")} failed (${
        result.error.code ?? result.error.message
      })\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function cliCommand(name) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      prefix: ["/d", "/s", "/c", path.join(binDir, `${name}.cmd`)],
    };
  }
  return { command: path.join(binDir, name), prefix: [] };
}

function runCli(name, args, options) {
  const cli = cliCommand(name);
  return run(cli.command, [...cli.prefix, ...args], options);
}

function daemonDiagnostics(child, logPath) {
  if (!child && !logPath) return "";
  let logTail = "";
  if (logPath && existsSync(logPath)) {
    logTail = readFileSync(logPath, "utf8").trim().slice(-16_384);
  }
  const state = child
    ? ` pid=${child.pid ?? "unknown"} exitCode=${child.exitCode ?? "null"} signal=${
        child.signalCode ?? "null"
      }`
    : "";
  return `${state}${logTail ? `\n--- daemon log tail ---\n${logTail}` : ""}`;
}

async function waitForHealth(target = listen, { child, logPath } = {}) {
  const attempts = Math.ceil(healthTimeoutMs / healthPollIntervalMs);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      fail(`daemon exited before health became ready${daemonDiagnostics(child, logPath)}`);
    }
    try {
      const response = await fetch(`http://${target}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // The daemon is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, healthPollIntervalMs));
  }
  fail(
    `daemon health endpoint did not become ready within ${healthTimeoutMs}ms${daemonDiagnostics(
      child,
      logPath,
    )}`,
  );
}

async function waitForBeadsHealthStatus(target, status) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const health = await waitForHealth(target);
    if (health.components?.beads?.status === status) return health;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`daemon Beads health did not reach ${status}`);
}

async function smokeDegradedBeadsLifecycle(runtimeNode, cliEntry) {
  const degradedLogPath = path.join(smokeRoot, "daemon-degraded.log");
  const degradedLog = openSync(degradedLogPath, "w");
  const degradedEnv = {
    ...env,
    PASEO_HOME: path.join(home, ".paseo-degraded"),
    PASEO_LISTEN: degradedListen,
    PASEO_BEADS_CENTRAL_SIDECAR: path.join(smokeRoot, "missing-beads-central-sidecar"),
  };
  const daemon = spawn(
    runtimeNode,
    [
      cliEntry,
      "daemon",
      "start",
      "--foreground",
      "--listen",
      degradedListen,
      "--web-ui",
      "--no-relay",
    ],
    { env: degradedEnv, stdio: ["ignore", degradedLog, degradedLog] },
  );
  try {
    const health = await waitForHealth(degradedListen, {
      child: daemon,
      logPath: degradedLogPath,
    });
    if (health.status !== "ok" || health.components?.beads?.status !== "degraded") {
      fail(`Daemon did not isolate Beads startup failure: ${JSON.stringify(health)}`);
    }
    const index = await (await fetch(`http://${degradedListen}/`)).text();
    if (!index.includes("<title>Paseo</title>")) {
      fail("Degraded daemon did not serve the WebUI");
    }
    return health;
  } finally {
    await terminateChild(daemon);
    closeSync(degradedLog);
  }
}

async function waitForBeadsCentral() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${beadsCentralEndpoint}/health/ready`);
      if (response.ok) return await response.json();
    } catch {
      // The daemon-owned native sidecar is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail("bundled Beads Central sidecar did not become ready");
}

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function terminateChild(child) {
  if (await waitForExit(child, 0)) return;
  child.kill();
  if (await waitForExit(child)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child))) fail(`spawned process ${child.pid ?? "unknown"} did not exit`);
}

async function smokeTerminal() {
  const marker = `paseo-portable-terminal-${process.pid}`;
  const created = JSON.parse(
    runCli(
      "paseo",
      ["terminal", "create", "--cwd", terminalRoot, "--name", "release-smoke", "--json"],
      {
        capture: true,
      },
    ),
  );
  if (typeof created.id !== "string" || created.id.length === 0) {
    fail(`terminal create returned an invalid payload: ${JSON.stringify(created)}`);
  }
  try {
    runCli("paseo", ["terminal", "send-keys", created.id, `echo ${marker}`, "Enter", "--json"], {
      capture: true,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const capture = JSON.parse(
        runCli("paseo", ["terminal", "capture", created.id, "--scrollback", "--json"], {
          capture: true,
        }),
      );
      if (Array.isArray(capture.lines) && capture.lines.join("\n").includes(marker)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    fail(`terminal output did not contain ${marker}`);
  } finally {
    runCli("paseo", ["terminal", "kill", created.id, "--json"], {
      capture: true,
    });
  }
}

function uninstallWindowsArtifact(bundle) {
  if (process.platform !== "win32") return;
  run(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(bundle, "uninstall.ps1"),
      "-Prefix",
      prefix,
      "-BinDir",
      binDir,
      "-TaskName",
      `Paseo Release Smoke ${process.pid}`,
      "-PurgeFoundation",
    ],
    { timeoutMs: windowsBundleIoTimeoutMs },
  );
}

function validateArtifactManifest(manifest) {
  if (
    manifest.product !== "Paseo WebUI + CLI" ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.beadsBackend !== "central" ||
    manifest.bundledBeadsBinary !== true ||
    manifest.internalPackages?.["@getpaseo/plugin"] !== manifest.version
  ) {
    fail("artifact manifest does not match the smoke host");
  }
}

function validateInstalledBeadsComponent() {
  const legacyRuntimeBd = path.join(
    prefix,
    "current",
    "runtime",
    ...(process.platform === "win32" ? ["bd.exe"] : ["bin", "bd"]),
  );
  if (existsSync(legacyRuntimeBd)) {
    fail("Artifact unexpectedly contains a legacy runtime bd binary");
  }
  if (!existsSync(installedBeadsCentralSidecar) || !existsSync(installedBd)) {
    fail("Installed artifact is missing the native Beads Central component");
  }
  const componentManifest = JSON.parse(
    readFileSync(path.join(installedBeadsCentralRoot, "component-manifest.json"), "utf8"),
  );
  if (
    componentManifest.component !== "beads-central" ||
    componentManifest.platform !== process.platform ||
    componentManifest.arch !== process.arch ||
    componentManifest.sidecarBinarySha256 !== sha256(installedBeadsCentralSidecar) ||
    componentManifest.beadsBinarySha256 !== sha256(installedBd)
  ) {
    fail("Installed Beads Central component manifest does not match its native binaries");
  }
  run(installedBeadsCentralSidecar, ["--help"], { capture: true });
  const bdVersion = run(installedBd, ["version"], { capture: true }).trim();
  if (!bdVersion.startsWith(`bd version ${componentManifest.beadsVersion}`)) {
    fail(`Installed bd version does not match component manifest: ${bdVersion}`);
  }
  return componentManifest;
}

async function main() {
  if (!platformName) fail(`unsupported smoke platform: ${process.platform}`);
  if (!existsSync(archive) || !existsSync(checksum)) fail(`missing artifact: ${archive}`);
  const expected = readFileSync(checksum, "utf8").trim().split(/\s+/u)[0];
  if (!/^[0-9a-f]{64}$/u.test(expected) || sha256(archive) !== expected) {
    fail(`SHA-256 verification failed for ${archive}`);
  }

  if (process.platform === "win32") {
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archive.replaceAll(
          "'",
          "''",
        )}' -DestinationPath '${smokeRoot.replaceAll("'", "''")}' -Force`,
      ],
      { timeoutMs: windowsBundleIoTimeoutMs },
    );
  } else {
    run("tar", ["-xzf", archive, "-C", smokeRoot]);
  }
  const bundle = path.join(smokeRoot, bundleName);
  const manifest = JSON.parse(readFileSync(path.join(bundle, "manifest.json"), "utf8"));
  validateArtifactManifest(manifest);

  if (process.platform === "win32") {
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(bundle, "install.ps1"),
        "-Prefix",
        prefix,
        "-BinDir",
        binDir,
        "-Listen",
        listen,
        "-NoStart",
      ],
      { timeoutMs: windowsBundleIoTimeoutMs },
    );
  } else {
    run(path.join(bundle, "install.sh"), [
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--listen",
      listen,
      "--no-start",
    ]);
  }

  runCli("paseo", ["--version"]);
  runCli("paseo-foundation", ["--version"]);
  runCli("paseo-foundation", ["doctor", "--json"], { capture: true });

  const runtimeNode = path.join(
    prefix,
    "current",
    "runtime",
    ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]),
  );
  const componentManifest = validateInstalledBeadsComponent();
  const cliEntry = path.join(
    prefix,
    "current",
    "app",
    "node_modules",
    "@getpaseo",
    "cli",
    "dist",
    "index.js",
  );
  const daemonLogPath = path.join(smokeRoot, "daemon.log");
  const log = openSync(daemonLogPath, "w");
  const daemon = spawn(
    runtimeNode,
    [cliEntry, "daemon", "start", "--foreground", "--listen", listen, "--web-ui", "--no-relay"],
    { env, stdio: ["ignore", log, log] },
  );
  let success;
  try {
    await waitForHealth(listen, { child: daemon, logPath: daemonLogPath });
    const beadsReady = await waitForBeadsCentral();
    if (
      beadsReady.central !== componentManifest.version ||
      !String(beadsReady.bd).includes(componentManifest.beadsVersion)
    ) {
      fail(`Bundled Beads readiness mismatch: ${JSON.stringify(beadsReady)}`);
    }
    const health = await waitForBeadsHealthStatus(listen, "ready");
    const index = await (await fetch(`http://${listen}/`)).text();
    if (!index.includes("<title>Paseo</title>")) fail("WebUI title was not served");
    await smokeTerminal();
    const degradedHealth = await smokeDegradedBeadsLifecycle(runtimeNode, cliEntry);
    runCli("paseo", ["daemon", "stop"]);
    if (!(await waitForExit(daemon))) {
      fail(`daemon process ${daemon.pid ?? "unknown"} remained after a graceful stop`);
    }
    success = `SMOKE_OK platform=${process.platform} arch=${
      process.arch
    } cli=ok foundation=ok terminal=ok daemon=ok webui=ok beads_central=${
      beadsReady.central
    } bd=${componentManifest.beadsVersion} degraded_beads=${
      degradedHealth.components.beads.status
    } health=${JSON.stringify(health)}\n`;
  } finally {
    await terminateChild(daemon);
    closeSync(log);
  }
  uninstallWindowsArtifact(bundle);
  return success;
}

function removeOwnedRoot(ownedRoot) {
  if (!existsSync(ownedRoot)) return;
  if (process.platform === "win32") {
    const target = ownedRoot.replaceAll("'", "''");
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$target = '${target}'
for ($attempt = 1; $attempt -le 40; $attempt++) {
  try {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $target) { throw "cleanup target still exists: $target" }
    exit 0
  } catch {
    if ($attempt -eq 40) { throw }
    Write-Output "SMOKE_CLEANUP_RETRY root=$target attempt=$attempt error=$($_.Exception.GetType().Name)"
    Start-Sleep -Milliseconds 250
  }
}`,
      ],
      { timeoutMs: 30_000 },
    );
  } else {
    rmSync(ownedRoot, {
      recursive: true,
      force: true,
      maxRetries: 40,
      retryDelay: 250,
    });
  }
  if (existsSync(ownedRoot)) fail(`cleanup target still exists: ${ownedRoot}`);
}

function cleanupSmokeRoots() {
  if (process.env.PASEO_KEEP_RELEASE_SMOKE === "1") {
    process.stdout.write(`SMOKE_ROOT=${smokeRoot}\nTERMINAL_ROOT=${terminalRoot}\n`);
    return;
  }
  for (const ownedRoot of [terminalRoot, smokeRoot]) {
    removeOwnedRoot(ownedRoot);
  }
}

main()
  .then((success) => {
    cleanupSmokeRoots();
    return process.stdout.write(success);
  })
  .catch((error) => {
    try {
      cleanupSmokeRoots();
    } catch (cleanupError) {
      process.stderr.write(
        `SMOKE_CLEANUP_FAILED ${
          cleanupError instanceof Error ? cleanupError.stack : String(cleanupError)
        }\n`,
      );
    }
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
