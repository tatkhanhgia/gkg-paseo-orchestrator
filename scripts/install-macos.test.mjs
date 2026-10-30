import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  installerScript as renderArtifactInstaller,
  linuxInstallerScript,
  windowsInstallerScript,
} from "./build-macos-web-cli-artifact.mjs";
import {
  LauncherError,
  migrateLauncher,
  planLaunchMigration,
  seedConfig,
  tokenizeCommandLine,
} from "./installer-launcher.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(scriptDir, "install-macos.sh");
const portableInstaller = path.join(scriptDir, "install.sh");
const windowsInstaller = path.join(scriptDir, "install-windows.ps1");
const artifactSmoke = path.join(scriptDir, "smoke-macos-web-cli-artifact.sh");
const packageLock = path.join(scriptDir, "..", "package-lock.json");

function writeExecutable(file, source) {
  writeFileSync(file, source, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-bootstrap-test-"));
  const fixtures = path.join(root, "fixtures");
  const fakeBin = path.join(root, "bin");
  const bundleName = "paseo-web-cli-9.9.9-macos-arm64";
  const bundle = path.join(root, bundleName);
  mkdirSync(fixtures);
  mkdirSync(fakeBin);
  mkdirSync(bundle);
  writeExecutable(
    path.join(bundle, "install.sh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" > "$INSTALL_RESULT"\n`,
  );
  writeFileSync(
    path.join(bundle, "manifest.json"),
    `${JSON.stringify(
      { product: "Paseo WebUI + CLI", platform: "darwin", arch: "arm64" },
      null,
      2,
    )}\n`,
  );
  const archive = `${bundleName}.tar.gz`;
  execFileSync("/usr/bin/tar", ["-czf", path.join(fixtures, archive), "-C", root, bundleName]);
  const digest = execFileSync("/usr/bin/shasum", ["-a", "256", path.join(fixtures, archive)], {
    encoding: "utf8",
  }).split(/\s+/)[0];
  writeFileSync(path.join(fixtures, `${archive}.sha256`), `${digest}  ${archive}\n`);
  writeFileSync(
    path.join(fixtures, "releases.json"),
    `${JSON.stringify([{ tag_name: "paseo-v9.9.9", prerelease: true }])}\n`,
  );
  writeExecutable(
    path.join(fakeBin, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) exit 2 ;; esac\n`,
  );
  writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *'/releases?per_page=1') source="$FIXTURE_ROOT/releases.json" ;;
  *) source="$FIXTURE_ROOT/\${url##*/}" ;;
esac
if [ -n "$output" ]; then cp "$source" "$output"; else cat "$source"; fi
`,
  );
  return { root, fixtures, fakeBin, archive };
}

function runFixture(fixture, args = [], extraEnv = {}, script = installer) {
  return spawnSync("/bin/sh", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:/usr/bin:/bin`,
      FIXTURE_ROOT: fixture.fixtures,
      INSTALL_RESULT: path.join(fixture.root, "installed.txt"),
      PASEO_DOWNSTREAM_API_ROOT: "https://fixture.invalid/api",
      PASEO_DOWNSTREAM_DOWNLOAD_ROOT: "https://fixture.invalid/download",
      TMPDIR: fixture.root,
      ...extraEnv,
    },
  });
}

// Stands in for `paseo daemon config get|set` of the bundled CLI. Like the real CLI, `get --json`
// reports `set` for a key present in <home>/config.json, and the first `set` against a home without
// config.json materializes the defaults. Every invocation is appended to $FAKE_CLI_LOG.
const FAKE_CONFIG_CLI = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const [group, subgroup, action, key] = argv;
const home = argv[argv.indexOf("--home") + 1];
const file = path.join(home, "config.json");
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, argv.join(" ") + "\\n");
if (group !== "daemon" || subgroup !== "config") process.exit(2);
const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
if (action === "get") {
  const value = key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), read());
  console.log(JSON.stringify({ source: "configured", path: key, set: value !== undefined, ...(value === undefined ? {} : { value }) }));
} else if (action === "set") {
  const config = existsSync(file) ? read() : { version: 1, daemon: { listen: "127.0.0.1:6767", relay: { enabled: false } } };
  const parts = key.split(".");
  let target = config;
  for (const part of parts.slice(0, -1)) target = target[part] ??= {};
  target[parts.at(-1)] = JSON.parse(argv[4]);
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\\n");
  console.log(JSON.stringify({ action: "saved", applied: false }));
} else {
  process.exit(2);
}
`;

function createArtifactFixture(existingPaseoSource) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-artifact-installer-test-"));
  const bundle = path.join(root, "bundle");
  const oldBin = path.join(root, "old-bin");
  mkdirSync(path.join(bundle, "bin"), { recursive: true });
  mkdirSync(path.join(bundle, "runtime", "bin"), { recursive: true });
  mkdirSync(oldBin);
  writeExecutable(path.join(bundle, "install.sh"), renderArtifactInstaller());
  writeExecutable(path.join(bundle, "uninstall.sh"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    path.join(bundle, "bin", "paseo"),
    `#!/bin/sh
case "$1 $2" in
  'daemon status') echo '{"localDaemon":"running","connectedDaemon":"reachable"}' ;;
esac
exit 0
`,
  );
  writeExecutable(
    path.join(bundle, "bin", "paseo-foundation"),
    '#!/bin/sh\n[ "${1:-}" != inspect ] || echo \'{"status":"inactive"}\'\nexit 0\n',
  );
  // Inline `-e` probes stay no-ops; script arguments (the launcher helper) run on real Node.
  writeExecutable(
    path.join(bundle, "runtime", "bin", "node"),
    `#!/bin/sh\ncase "$1" in -e) case "$*" in *process.stdout.write*) printf "127.0.0.1:6767" ;; esac; exit 0 ;; esac\nexec "${process.execPath}" "$@"\n`,
  );
  copyFileSync(
    path.join(scriptDir, "installer-launcher.mjs"),
    path.join(bundle, "installer-launcher.mjs"),
  );
  const cliPackage = path.join(bundle, "app", "node_modules", "@getpaseo", "cli");
  mkdirSync(path.join(cliPackage, "dist"), { recursive: true });
  writeFileSync(path.join(cliPackage, "package.json"), '{"type":"module"}\n');
  writeFileSync(path.join(cliPackage, "dist", "index.js"), FAKE_CONFIG_CLI);
  writeExecutable(path.join(oldBin, "paseo"), existingPaseoSource);
  return {
    root,
    bundle,
    oldBin,
    home: path.join(root, "home"),
    prefix: path.join(root, "install"),
    binDir: path.join(root, "installed-bin"),
    marker: path.join(root, "existing-paseo.log"),
    cliLog: path.join(root, "config-cli.log"),
    paseoHome: path.join(root, "home", ".paseo"),
  };
}

function runArtifactFixture(fixture, args, extraEnv = {}) {
  mkdirSync(fixture.home, { recursive: true });
  return spawnSync("/bin/sh", [path.join(fixture.bundle, "install.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      PASEO_HOME: fixture.paseoHome,
      FAKE_CLI_LOG: fixture.cliLog,
      PATH: `${fixture.oldBin}:/usr/bin:/bin`,
      EXISTING_PASEO_MARKER: fixture.marker,
      ...extraEnv,
    },
  });
}

test("selects the newest downstream release, verifies it, and forwards options", () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, ["--no-start"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(fixture.root, "installed.txt"), "utf8"), "--no-start\n");
    assert.match(result.stdout, /Paseo Foundation Downstream 9\.9\.9/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("portable Unix installer selects and verifies the matching macOS artifact", () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, ["--no-start"], {}, portableInstaller);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(fixture.root, "installed.txt"), "utf8"), "--no-start\n");
    assert.match(result.stdout, /for macos arm64/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("does not invoke the artifact installer after checksum failure", () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      path.join(fixture.fixtures, `${fixture.archive}.sha256`),
      `bad  ${fixture.archive}\n`,
    );
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(path.join(fixture.root, "installed.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("help is side-effect free and does not require macOS or curl", () => {
  const fixture = createFixture();
  try {
    rmSync(path.join(fixture.fakeBin, "curl"));
    writeExecutable(path.join(fixture.fakeBin, "uname"), "#!/bin/sh\necho Linux\n");
    const before = new Set(readFileNames(fixture.root));
    const result = runFixture(fixture, ["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: install-macos\.sh/);
    assert.deepEqual(new Set(readFileNames(fixture.root)), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact smoke uses stock macOS inspection commands", () => {
  const source = readFileSync(artifactSmoke, "utf8");
  assert.equal(source.includes("\nrg "), false);
  assert.equal(source.includes("\njq "), false);
  assert.match(source, /\/usr\/bin\/grep -Fq/);
});

test("artifact smoke normalizes Intel uname output to the x64 artifact name", () => {
  const source = readFileSync(artifactSmoke, "utf8");
  assert.match(source, /x86_64\) ARCH="x64"/);
  assert.match(source, /macos-\$ARCH/);
});

test("portable installers declare Linux and Windows host checks explicitly", () => {
  const unixSource = readFileSync(portableInstaller, "utf8");
  const windowsSource = readFileSync(windowsInstaller, "utf8");
  assert.match(unixSource, /Linux\) PLATFORM_NAME="linux"/);
  assert.match(unixSource, /sha256sum/);
  assert.match(windowsSource, /OSArchitecture/);
  assert.match(windowsSource, /Get-FileHash -Algorithm SHA256/);
  assert.match(windowsSource, /Manifest\.platform -ne "win32"/);
});

test("release lock retains Lightning CSS binaries for both macOS architectures", () => {
  const lock = JSON.parse(readFileSync(packageLock, "utf8"));
  for (const arch of ["arm64", "x64"]) {
    const entry = lock.packages[`node_modules/lightningcss-darwin-${arch}`];
    assert.equal(entry.version, "1.30.1");
    assert.deepEqual(entry.os, ["darwin"]);
    assert.deepEqual(entry.cpu, [arch]);
    assert.equal(entry.optional, true);
  }
});

test("artifact installer refuses takeover while an existing agent is running", () => {
  const fixture = createArtifactFixture(`#!/bin/sh
printf '%s\\n' "$*" >> "$EXISTING_PASEO_MARKER"
case "$1 $2" in
  'daemon status') echo '{"localDaemon":"running"}' ;;
  'ls --global') echo '[{"status":"running"}]' ;;
  *) exit 2 ;;
esac
`);
  try {
    const result = runArtifactFixture(fixture, [
      "--prefix",
      fixture.prefix,
      "--bin-dir",
      fixture.binDir,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /agent is running or starting/);
    assert.equal(existsSync(fixture.prefix), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact --no-start stages the downstream without inspecting or stopping Paseo", () => {
  const fixture = createArtifactFixture(`#!/bin/sh
printf '%s\\n' "$*" >> "$EXISTING_PASEO_MARKER"
exit 99
`);
  const bundledNode = path.join(fixture.bundle, "runtime", "bin", "node");
  rmSync(bundledNode);
  symlinkSync(process.execPath, bundledNode);
  try {
    const result = runArtifactFixture(fixture, [
      "--prefix",
      fixture.prefix,
      "--bin-dir",
      fixture.binDir,
      "--no-start",
      "--skip-foundation",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(fixture.marker), false);
    assert.equal(existsSync(path.join(fixture.prefix, "current", "bin", "paseo")), true);
    assert.equal(existsSync(path.join(fixture.prefix, "current", "install.sh")), true);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(fixture.prefix, "install-config.json"), "utf8")),
      { schemaVersion: 1, prefix: fixture.prefix, binDir: fixture.binDir },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact installer restores the previous release when a post-switch gate fails", () => {
  const fixture = createArtifactFixture("#!/bin/sh\nexit 99\n");
  const previous = path.join(fixture.prefix, "releases", "0.5.0-paseo.37");
  mkdirSync(previous, { recursive: true });
  writeExecutable(path.join(previous, "install.sh"), "#!/bin/sh\nexit 0\n");
  symlinkSync(previous, path.join(fixture.prefix, "current"));
  writeExecutable(
    path.join(fixture.bundle, "bin", "paseo-foundation"),
    `#!/bin/sh
case "\${1:-}" in
  inspect) echo '{"status": "inactive"}' ;;
  install) exit 17 ;;
esac
exit 0
`,
  );
  try {
    const result = runArtifactFixture(fixture, [
      "--prefix",
      fixture.prefix,
      "--bin-dir",
      fixture.binDir,
      "--no-start",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring the previous Paseo release/);
    assert.equal(readlinkSync(path.join(fixture.prefix, "current")), previous);
    assert.equal(existsSync(path.join(fixture.prefix, "releases", "0.5.0-paseo.41")), false);
    assert.equal(existsSync(path.join(previous, "install.sh")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function setupRollbackRestartFixture(previousDaemonStatusJson) {
  // A post-switch failure with the daemon running: the forward path activates the new release, then
  // Foundation install fails, so rollback must repoint the symlink AND bring the daemon back up on
  // the restored release. The existing plist keeps PLIST_EXISTED=1 so the fresh-write branch is not
  // exercised here.
  const fixture = createArtifactFixture(
    `#!/bin/sh
case "$1 $2" in
  'daemon status')
    if [ -f "$LAUNCHD_BOOTED_OUT" ]; then echo '{"localDaemon":"stopped"}'; else echo '{"localDaemon":"running"}'; fi ;;
  'ls --global') echo '[]' ;;
  'workspace ls') echo '[]' ;;
  *) exit 2 ;;
esac
exit 0
`,
  );
  const bundledNode = path.join(fixture.bundle, "runtime", "bin", "node");
  rmSync(bundledNode);
  symlinkSync(process.execPath, bundledNode);
  // Foundation install fails after the switch to trigger rollback.
  writeExecutable(
    path.join(fixture.bundle, "bin", "paseo-foundation"),
    '#!/bin/sh\ncase "${1:-}" in inspect) echo \'{"status":"inactive"}\' ;; install) exit 17 ;; esac\nexit 0\n',
  );
  const launchAgents = path.join(fixture.home, "Library", "LaunchAgents");
  mkdirSync(launchAgents, { recursive: true });
  const plistPath = path.join(launchAgents, "com.paseo.web-cli.plist");
  writeFileSync(plistPath, LEGACY_RELAY_PLIST);
  // The restored release carries its own working CLI so the rollback readback can probe it.
  const previous = path.join(fixture.prefix, "releases", "0.5.0-paseo.37");
  mkdirSync(path.join(previous, "bin"), { recursive: true });
  const rollbackMarker = path.join(fixture.root, "rollback-paseo.log");
  writeExecutable(
    path.join(previous, "bin", "paseo"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ROLLBACK_PASEO_MARKER"\necho '${previousDaemonStatusJson}'\nexit 0\n`,
  );
  mkdirSync(path.join(fixture.prefix, "releases"), { recursive: true });
  symlinkSync(previous, path.join(fixture.prefix, "current"));
  const launchctlLog = path.join(fixture.root, "launchctl.log");
  const bootedOut = path.join(fixture.root, "launchd-booted-out");
  writeExecutable(
    path.join(fixture.oldBin, "launchctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\ncase "$1" in print) exit 0 ;; bootout) : > "$LAUNCHD_BOOTED_OUT"; exit 0 ;; bootstrap|kickstart) exit 0 ;; *) exit 2 ;; esac\n`,
  );
  // A fast sleep keeps the fail-loud readback loop from waiting real seconds.
  writeExecutable(path.join(fixture.oldBin, "sleep"), "#!/bin/sh\nexit 0\n");
  return {
    fixture,
    previous,
    plistPath,
    rollbackMarker,
    launchctlLog,
    env: { LAUNCHD_BOOTED_OUT: bootedOut },
  };
}

test("artifact installer restarts the daemon on the restored release after a rollback", () => {
  const { fixture, previous, rollbackMarker, launchctlLog, env } = setupRollbackRestartFixture(
    '{"localDaemon":"running","connectedDaemon":"reachable"}',
  );
  try {
    const result = runArtifactFixture(
      fixture,
      ["--prefix", fixture.prefix, "--bin-dir", fixture.binDir],
      { ROLLBACK_PASEO_MARKER: rollbackMarker, LAUNCHCTL_LOG: launchctlLog, ...env },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring the previous Paseo release/);
    assert.doesNotMatch(result.stderr, /did not report a running readback/);
    assert.equal(readlinkSync(path.join(fixture.prefix, "current")), previous);
    // The rollback probed the restored release's CLI and it reported running.
    assert.match(readFileSync(rollbackMarker, "utf8"), /daemon status/);
    const launchctlCalls = readFileSync(launchctlLog, "utf8").trim().split("\n");
    assert.equal(launchctlCalls.filter((line) => line.startsWith("bootstrap ")).length >= 2, true);
    assert.equal(
      launchctlCalls.some((line) => line.startsWith("kickstart -k ")),
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact installer fails loud when the rolled-back daemon never reports running", () => {
  const { fixture, previous, rollbackMarker, launchctlLog, env } = setupRollbackRestartFixture(
    '{"localDaemon":"stopped","connectedDaemon":"unreachable"}',
  );
  try {
    const result = runArtifactFixture(
      fixture,
      ["--prefix", fixture.prefix, "--bin-dir", fixture.binDir],
      { ROLLBACK_PASEO_MARKER: rollbackMarker, LAUNCHCTL_LOG: launchctlLog, ...env },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring the previous Paseo release/);
    // The daemon never came back, so the operator gets a loud manual-restart instruction.
    assert.match(result.stderr, /did not report a running readback/);
    assert.match(result.stderr, /launchctl kickstart -k/);
    assert.equal(readlinkSync(path.join(fixture.prefix, "current")), previous);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("all generated platform installers preserve service config and gate the transaction", () => {
  const macos = renderArtifactInstaller();
  const linux = linuxInstallerScript();
  const windows = windowsInstallerScript();

  assert.match(macos, /if \[ ! -f "\$PLIST" \]/);
  assert.match(linux, /if \[ ! -f "\$UNIT" \]/);
  assert.match(windows, /if \(-not \$RunDaemonExisted\)/);
  assert.match(windows, /if \(-not \$TaskExisted\)/);
  for (const source of [macos, linux, windows]) {
    assert.match(source, /api\/health/);
    assert.match(source, /6769\/health\/ready/);
    assert.match(source, /restoring the previous Paseo release/i);
  }
  for (const source of [macos, linux]) {
    assert.match(source, /HEALTHY=0[\s\S]*6769\/health\/ready[\s\S]*sleep 1/);
    assert.match(source, /if \[ "\$HEALTHY" -ne 1 \]/);
  }
  assert.match(windows, /\$Healthy = \$false[\s\S]*foreach \(\$attempt in 1\.\.30\)/);
  assert.match(
    windows,
    /if \(-not \$Healthy\) \{ throw "Installed release failed health, WebUI, or Beads Central readback\." \}/,
  );

  // Defect 2: every platform injects the Beads Central sidecar env on a fresh install AND into an
  // existing service on upgrade, mirroring the macOS plist patch.
  for (const source of [macos, linux, windows]) {
    assert.match(source, /PASEO_BEADS_CENTRAL_SIDECAR/);
    assert.match(source, /PASEO_BEADS_CENTRAL_BD_BIN/);
  }
  // Linux fresh unit sets the env directly; an existing unit gets a systemd drop-in.
  assert.match(
    linux,
    /Environment="PASEO_BEADS_CENTRAL_SIDECAR=\$CURRENT_LINK\/components\/beads-central\/beads-central"/,
  );
  assert.match(linux, /\$SERVICE_NAME\.d/);
  assert.match(linux, /cat > "\$DROPIN" <<DROPIN[\s\S]*PASEO_BEADS_CENTRAL_SIDECAR/);
  // Windows fresh run-daemon.ps1 sets the env; an existing one is spliced in ahead of the launch.
  assert.match(
    windows,
    /\$BeadsSidecar = Join-Path \$Current "components\\beads-central\\beads-central\.exe"/,
  );
  assert.match(windows, /\$RunDaemonContent -notmatch "PASEO_BEADS_CENTRAL_SIDECAR"/);

  // Defect 1: rollback restarts the restored release with a readback and fails loud, not a bare
  // best-effort restart, on every platform.
  for (const source of [macos, linux]) {
    assert.match(source, /ROLLBACK_READY=0[\s\S]*"connectedDaemon"[\s\S]*ROLLBACK_READY=1/);
    assert.match(
      source,
      /Rollback restored the previous release but the daemon did not report a running readback/,
    );
  }
  assert.match(windows, /\$RollbackReady = \$false[\s\S]*connectedDaemon -eq "reachable"/);
  assert.match(
    windows,
    /Rollback restored the previous release but the daemon did not report a running readback/,
  );
});

test("artifact installer prefers a compatible host Node for the launchd daemon", () => {
  const fixture = createArtifactFixture("#!/bin/sh\nexit 99\n");
  const hostNode = path.join(fixture.oldBin, "node");
  writeExecutable(
    hostNode,
    `#!/bin/sh
case "$1" in
  -e) exit 0 ;;
  *) exit 2 ;;
esac
`,
  );
  try {
    const result = runArtifactFixture(fixture, [
      "--prefix",
      fixture.prefix,
      "--bin-dir",
      fixture.binDir,
      "--no-start",
      "--skip-foundation",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const plist = readFileSync(
      path.join(fixture.home, "Library", "LaunchAgents", "com.paseo.web-cli.plist"),
      "utf8",
    );
    assert.match(plist, new RegExp(`<string>${hostNode}</string>`));
    assert.match(
      plist,
      new RegExp(
        `<string>${fixture.prefix}/current/app/node_modules/@getpaseo/cli/dist/index.js</string>`,
      ),
    );
    assert.match(
      plist,
      new RegExp(
        `<key>PASEO_BEADS_CENTRAL_SIDECAR</key><string>${fixture.prefix}/current/components/beads-central/beads-central</string>`,
      ),
    );
    assert.match(
      plist,
      new RegExp(
        `<key>PASEO_BEADS_CENTRAL_BD_BIN</key><string>${fixture.prefix}/current/components/beads-central/bin/bd</string>`,
      ),
    );
    assert.doesNotMatch(plist, /PASEO_BEADS_BINARY/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

const LEGACY_RELAY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.paseo.web-cli</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string><string>/legacy/current/app/node_modules/@getpaseo/cli/dist/index.js</string>
    <string>daemon</string><string>start</string>
    <string>--foreground</string><string>--listen</string><string>127.0.0.1:7777</string>
    <string>--web-ui</string><string>--relay</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>/legacy/home</string>
    <key>PATH</key><string>/legacy/bin:/usr/bin</string>
    <key>PASEO_DICTATION_ENABLED</key><string>0</string>
  </dict>
  <key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
</dict></plist>
`;

function installOverLegacyPlist(fixture, legacyPlist) {
  const launchAgents = path.join(fixture.home, "Library", "LaunchAgents");
  mkdirSync(launchAgents, { recursive: true });
  const plistPath = path.join(launchAgents, "com.paseo.web-cli.plist");
  writeFileSync(plistPath, legacyPlist);
  const result = runArtifactFixture(fixture, [
    "--prefix",
    fixture.prefix,
    "--bin-dir",
    fixture.binDir,
    "--no-start",
    "--skip-foundation",
  ]);
  return { result, plistPath };
}

test("artifact installer adds Beads Central sidecar env to a legacy plist and moves relay and listen into config", () => {
  const fixture = createArtifactFixture("#!/bin/sh\nexit 99\n");
  const bundledNode = path.join(fixture.bundle, "runtime", "bin", "node");
  rmSync(bundledNode);
  symlinkSync(process.execPath, bundledNode);
  try {
    const { result, plistPath } = installOverLegacyPlist(fixture, LEGACY_RELAY_PLIST);
    assert.equal(result.status, 0, result.stderr);
    const plist = readFileSync(plistPath, "utf8");
    assert.match(plist, /<string>run<\/string>/);
    assert.doesNotMatch(plist, /--relay|--no-relay|--listen/);
    const config = JSON.parse(readFileSync(path.join(fixture.paseoHome, "config.json"), "utf8"));
    assert.equal(config.daemon.relay.enabled, true);
    assert.equal(config.daemon.listen, "127.0.0.1:7777");
    assert.match(plist, /<string>\/legacy\/current\/app\/node_modules/);
    assert.match(plist, /<string>\/legacy\/bin:\/usr\/bin<\/string>/);
    const sidecarDir = `${fixture.prefix}/current/components/beads-central`;
    const values = JSON.parse(
      execFileSync(
        "/usr/bin/plutil",
        ["-extract", "EnvironmentVariables", "json", "-o", "-", plistPath],
        {
          encoding: "utf8",
        },
      ),
    );
    assert.equal(values.PASEO_BEADS_CENTRAL_SIDECAR, `${sidecarDir}/beads-central`);
    assert.equal(values.PASEO_BEADS_CENTRAL_BD_BIN, `${sidecarDir}/bin/bd`);
    assert.equal(values.HOME, "/legacy/home");
    assert.equal(values.PASEO_DICTATION_ENABLED, "0");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact installer repoints stale sidecar env and creates a missing env dict in an existing plist", () => {
  const fixture = createArtifactFixture("#!/bin/sh\nexit 99\n");
  const bundledNode = path.join(fixture.bundle, "runtime", "bin", "node");
  rmSync(bundledNode);
  symlinkSync(process.execPath, bundledNode);
  try {
    const stale = LEGACY_RELAY_PLIST.replace(
      "<key>PASEO_DICTATION_ENABLED</key>",
      "<key>PASEO_BEADS_CENTRAL_SIDECAR</key><string>/old/release/beads-central</string>\n    <key>PASEO_DICTATION_ENABLED</key>",
    );
    const first = installOverLegacyPlist(fixture, stale);
    assert.equal(first.result.status, 0, first.result.stderr);
    const repointed = readFileSync(first.plistPath, "utf8");
    assert.doesNotMatch(repointed, /\/old\/release/);
    assert.equal((repointed.match(/PASEO_BEADS_CENTRAL_SIDECAR/g) ?? []).length, 1);

    const noEnv = LEGACY_RELAY_PLIST.replace(
      /<key>EnvironmentVariables<\/key><dict>[\s\S]*?<\/dict>\n/,
      "",
    );
    assert.doesNotMatch(noEnv, /EnvironmentVariables/);
    rmSync(path.join(fixture.prefix, "current"), { force: true });
    rmSync(path.join(fixture.prefix, "releases"), { recursive: true, force: true });
    const second = installOverLegacyPlist(fixture, noEnv);
    assert.equal(second.result.status, 0, second.result.stderr);
    const rebuilt = readFileSync(second.plistPath, "utf8");
    assert.match(rebuilt, /PASEO_BEADS_CENTRAL_SIDECAR/);
    assert.match(rebuilt, /PASEO_BEADS_CENTRAL_BD_BIN/);
    assert.match(rebuilt, /<string>run<\/string>/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact installer unloads a KeepAlive launchd owner before replacing an idle daemon", () => {
  const fixture = createArtifactFixture(`#!/bin/sh
printf '%s\\n' "$*" >> "$EXISTING_PASEO_MARKER"
case "$1 $2" in
  'daemon status')
    if [ -f "$LAUNCHD_BOOTED_OUT" ]; then
      echo '{"localDaemon":"stopped"}'
    else
      echo '{"localDaemon":"running"}'
    fi
    ;;
  'ls --global') echo '[]' ;;
  'workspace ls') echo '[]' ;;
  'daemon stop') exit 88 ;;
  *) exit 2 ;;
esac
`);
  const launchctlLog = path.join(fixture.root, "launchctl.log");
  const bootstrapFailed = path.join(fixture.root, "bootstrap-failed");
  const launchdBootedOut = path.join(fixture.root, "launchd-booted-out");
  writeExecutable(
    path.join(fixture.oldBin, "launchctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"
case "$1" in
  print) exit 0 ;;
  bootout) : > "$LAUNCHD_BOOTED_OUT"; exit 0 ;;
  kickstart) exit 0 ;;
  bootstrap)
    if [ ! -f "$LAUNCHCTL_BOOTSTRAP_FAILED" ]; then
      : > "$LAUNCHCTL_BOOTSTRAP_FAILED"
      exit 5
    fi
    exit 0
    ;;
  *) exit 2 ;;
esac
`,
  );
  try {
    const result = runArtifactFixture(
      fixture,
      ["--prefix", fixture.prefix, "--bin-dir", fixture.binDir, "--skip-foundation"],
      {
        LAUNCHCTL_LOG: launchctlLog,
        LAUNCHCTL_BOOTSTRAP_FAILED: bootstrapFailed,
        LAUNCHD_BOOTED_OUT: launchdBootedOut,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const paseoCalls = readFileSync(fixture.marker, "utf8").trim().split("\n");
    assert.equal(
      paseoCalls.some((line) => line.startsWith("daemon stop")),
      false,
    );
    const launchctlCalls = readFileSync(launchctlLog, "utf8").trim().split("\n");
    const firstBootout = launchctlCalls.findIndex((line) => line.startsWith("bootout "));
    const firstBootstrap = launchctlCalls.findIndex((line) => line.startsWith("bootstrap "));
    assert.notEqual(firstBootout, -1);
    assert.equal(firstBootout < firstBootstrap, true);
    assert.equal(launchctlCalls.filter((line) => line.startsWith("bootstrap ")).length, 2);
    assert.equal(
      launchctlCalls.some((line) => line.startsWith("kickstart -k ")),
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact installer stops an idle unmanaged daemon through the CLI", () => {
  const fixture = createArtifactFixture(`#!/bin/sh
printf '%s\\n' "$*" >> "$EXISTING_PASEO_MARKER"
case "$1 $2" in
  'daemon status')
    if [ -f "$EXISTING_PASEO_STOPPED" ]; then
      echo '{"localDaemon":"stopped"}'
    else
      echo '{"localDaemon":"running"}'
    fi
    ;;
  'ls --global') echo '[]' ;;
  'workspace ls') echo '[]' ;;
  'daemon stop') : > "$EXISTING_PASEO_STOPPED"; echo '{}' ;;
  *) exit 2 ;;
esac
`);
  const launchctlLog = path.join(fixture.root, "launchctl.log");
  writeExecutable(
    path.join(fixture.oldBin, "launchctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"
case "$1" in
  print) exit 1 ;;
  bootout|bootstrap|kickstart) exit 0 ;;
  *) exit 2 ;;
esac
`,
  );
  try {
    const result = runArtifactFixture(
      fixture,
      ["--prefix", fixture.prefix, "--bin-dir", fixture.binDir, "--skip-foundation"],
      {
        EXISTING_PASEO_STOPPED: path.join(fixture.root, "existing-paseo-stopped"),
        LAUNCHCTL_LOG: launchctlLog,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const paseoCalls = readFileSync(fixture.marker, "utf8").trim().split("\n");
    assert.equal(
      paseoCalls.some((line) => line.startsWith("daemon stop")),
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function readFileNames(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      output.push(path.relative(root, fullPath));
      if (entry.isDirectory()) visit(fullPath);
    }
  };
  visit(root);
  return output.sort();
}

const LEGACY_ARGS = [
  "daemon",
  "start",
  "--foreground",
  "--listen",
  "127.0.0.1:7777",
  "--web-ui",
  "--relay",
];

test("launcher plan moves removed launch flags to config keys and daemon run", () => {
  const plan = planLaunchMigration(LEGACY_ARGS, { home: "/h/.paseo" });
  assert.deepEqual(plan.args, ["daemon", "run", "--home", "/h/.paseo"]);
  assert.deepEqual(plan.config, [
    { key: "daemon.listen", value: "127.0.0.1:7777" },
    { key: "features.webUi.enabled", value: true },
    { key: "daemon.relay.enabled", value: true },
  ]);

  const noRelay = planLaunchMigration(
    ["daemon", "start", "--foreground", "--port=7000", "--no-relay", "--home", "/other"],
    { home: "/h/.paseo" },
  );
  assert.equal(noRelay.home, "/other");
  assert.deepEqual(noRelay.config, [
    { key: "daemon.listen", value: "127.0.0.1:7000" },
    { key: "daemon.relay.enabled", value: false },
  ]);
});

test("launcher plan leaves a current launcher alone and refuses what it cannot translate", () => {
  assert.equal(planLaunchMigration(["daemon", "run", "--home", "/h"], { home: "/h" }), null);
  assert.equal(planLaunchMigration(["daemon", "start", "--home", "/h"], { home: "/h" }), null);
  assert.throws(
    () => planLaunchMigration(["daemon", "start", "--mystery"], { home: "/h" }),
    LauncherError,
  );
  assert.throws(
    () =>
      planLaunchMigration(["daemon", "start", "--listen", "a:1", "--port", "2"], { home: "/h" }),
    /--listen and --port together/u,
  );
  assert.throws(
    () => planLaunchMigration(["daemon", "start", "--listen"], { home: "/h" }),
    /no value/u,
  );
});

test("command-line tokenizer keeps quoted values whole with source offsets", () => {
  const line = `ExecStart="/opt/my node" cli.js daemon start --home "/a b"`;
  const tokens = tokenizeCommandLine(line.slice("ExecStart=".length), { escape: "\\" });
  assert.deepEqual(
    tokens.map((token) => token.value),
    ["/opt/my node", "cli.js", "daemon", "start", "--home", "/a b"],
  );
  assert.equal(tokens[2].start, line.slice("ExecStart=".length).indexOf("daemon"));
  assert.throws(() => tokenizeCommandLine('a "b', { escape: "\\" }), LauncherError);
});

function createLauncherFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-launcher-test-"));
  const cli = path.join(root, "cli.mjs");
  writeFileSync(cli, FAKE_CONFIG_CLI);
  return { root, cli, home: path.join(root, ".paseo"), node: process.execPath };
}

test("seeding writes install defaults only where the operator has not set the key", () => {
  const fixture = createLauncherFixture();
  try {
    mkdirSync(fixture.home, { recursive: true });
    writeFileSync(
      path.join(fixture.home, "config.json"),
      `${JSON.stringify({ version: 1, daemon: { relay: { enabled: true } } })}\n`,
    );
    const seeded = seedConfig({ ...fixture, listen: "127.0.0.1:6767" });
    assert.deepEqual(seeded.kept, ["daemon.relay.enabled"]);
    assert.deepEqual(seeded.written, ["daemon.listen", "features.webUi.enabled"]);
    const config = JSON.parse(readFileSync(path.join(fixture.home, "config.json"), "utf8"));
    assert.equal(config.daemon.relay.enabled, true);
    assert.equal(config.daemon.listen, "127.0.0.1:6767");
    assert.equal(config.features.webUi.enabled, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("seeding a fresh home keeps every default despite the first write materializing config", () => {
  const fixture = createLauncherFixture();
  try {
    const seeded = seedConfig({ ...fixture, listen: "127.0.0.1:7777" });
    assert.deepEqual(seeded.kept, []);
    assert.equal(seeded.written.length, 3);
    const config = JSON.parse(readFileSync(path.join(fixture.home, "config.json"), "utf8"));
    assert.equal(config.daemon.listen, "127.0.0.1:7777");
    assert.equal(config.daemon.relay.enabled, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("migrating a plist keeps the operator's configured keys and rewrites only the arguments", () => {
  const fixture = createLauncherFixture();
  try {
    const plist = path.join(fixture.root, "launcher.plist");
    writeFileSync(plist, LEGACY_RELAY_PLIST);
    mkdirSync(fixture.home, { recursive: true });
    writeFileSync(
      path.join(fixture.home, "config.json"),
      `${JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:9999" } })}\n`,
    );
    const migrated = migrateLauncher({ kind: "plist", file: plist, ...fixture });
    assert.equal(migrated.status, "migrated");
    assert.deepEqual(migrated.kept, ["daemon.listen"]);
    const args = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(args.slice(2), ["daemon", "run", "--home", fixture.home]);
    const config = JSON.parse(readFileSync(path.join(fixture.home, "config.json"), "utf8"));
    assert.equal(config.daemon.listen, "127.0.0.1:9999");
    assert.equal(config.daemon.relay.enabled, true);
    assert.equal(migrateLauncher({ kind: "plist", file: plist, ...fixture }).status, "current");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a failed config write leaves the launcher untouched", () => {
  const fixture = createLauncherFixture();
  try {
    const plist = path.join(fixture.root, "launcher.plist");
    writeFileSync(plist, LEGACY_RELAY_PLIST);
    writeFileSync(fixture.cli, "process.exit(1);\n");
    assert.throws(() => migrateLauncher({ kind: "plist", file: plist, ...fixture }), LauncherError);
    assert.equal(readFileSync(plist, "utf8"), LEGACY_RELAY_PLIST);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact installer migrates a legacy plist to daemon run and keeps a restorable backup", () => {
  const fixture = createArtifactFixture("#!/bin/sh\nexit 99\n");
  try {
    const { result, plistPath } = installOverLegacyPlist(fixture, LEGACY_RELAY_PLIST);
    assert.equal(result.status, 0, result.stderr);
    const plist = readFileSync(plistPath, "utf8");
    assert.doesNotMatch(plist, /--relay|--foreground|--listen/u);
    assert.match(plist, /<string>run<\/string>/u);
    assert.match(plist, new RegExp(`<string>${fixture.paseoHome}</string>`, "u"));
    const config = JSON.parse(readFileSync(path.join(fixture.paseoHome, "config.json"), "utf8"));
    assert.equal(config.daemon.listen, "127.0.0.1:7777");
    assert.equal(config.daemon.relay.enabled, true);
    const [version] = readdirSync(path.join(fixture.prefix, "launcher-backups"));
    const backup = readFileSync(
      path.join(fixture.prefix, "launcher-backups", version, "com.paseo.web-cli.plist"),
      "utf8",
    );
    assert.equal(backup, LEGACY_RELAY_PLIST);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
