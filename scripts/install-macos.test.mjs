import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  launcherNeedsMigration,
  migrateLauncher,
  planLaunchMigration,
  resolveLauncherHome,
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

// Installer tests execute the real generated scripts, whose launchctl/systemctl calls address the
// service by the real UID and a well-known name. Every fixture therefore (1) puts fail-closed
// launchctl/systemctl stubs first on PATH, (2) points the installer at a throwaway label and unit via
// PASEO_LAUNCHD_LABEL / PASEO_SYSTEMD_UNIT, and (3) fails the test when a stub refused a call, even if
// the installer swallowed the non-zero exit with `|| true`. A stub refuses any call that is not
// scripted for it or that names a service other than the throwaway one.
function serviceStubSource(body) {
  return `#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$SERVICE_TEST_CALLS"
refuse() {
  printf '%s %s\\n' "$(basename "$0")" "$*" >> "$SERVICE_TEST_REJECTED"
  echo "$(basename "$0") stub refused: $*" >&2
  exit 97
}
[ -n "$SERVICE_TEST_LABEL" ] && [ -n "$SERVICE_TEST_UNIT" ] || refuse "missing isolation env"
for arg in "$@"; do
  case "$arg" in
    gui/*/"$SERVICE_TEST_LABEL") ;;
    gui/*/*) refuse "$@" ;;
    */"$SERVICE_TEST_LABEL".plist) ;;
    *.plist) refuse "$@" ;;
    "$SERVICE_TEST_UNIT") ;;
    *.service) refuse "$@" ;;
  esac
done
${body}
`;
}

const UNSCRIPTED_SERVICE_CALL = 'refuse "$@"';

function writeServiceStub(service, tool, body) {
  writeExecutable(path.join(service.binDir, tool), serviceStubSource(body));
}

function createServiceIsolation(root, binDir) {
  const suffix = randomUUID().slice(0, 8);
  const service = {
    binDir,
    label: `com.paseo.web-cli.test-${suffix}`,
    unit: `paseo-web-cli-test-${suffix}.service`,
    calls: path.join(root, "service-calls.log"),
    rejected: path.join(root, "service-calls-rejected.log"),
  };
  writeServiceStub(service, "launchctl", UNSCRIPTED_SERVICE_CALL);
  writeServiceStub(service, "systemctl", UNSCRIPTED_SERVICE_CALL);
  return service;
}

function serviceEnv(service) {
  return {
    PASEO_LAUNCHD_LABEL: service.label,
    PASEO_SYSTEMD_UNIT: service.unit,
    SERVICE_TEST_LABEL: service.label,
    SERVICE_TEST_UNIT: service.unit,
    SERVICE_TEST_CALLS: service.calls,
    SERVICE_TEST_REJECTED: service.rejected,
  };
}

function serviceCalls(service) {
  return existsSync(service.calls) ? readFileSync(service.calls, "utf8").trim().split("\n") : [];
}

function assertNoRefusedServiceCalls(service) {
  if (existsSync(service.rejected)) {
    throw new Error(
      `installer reached a service manager call the test did not script:\n${readFileSync(service.rejected, "utf8")}`,
    );
  }
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
  const service = createServiceIsolation(root, fakeBin);
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
  return { root, fixtures, fakeBin, archive, service };
}

function runFixture(fixture, args = [], extraEnv = {}, script = installer) {
  const result = spawnSync("/bin/sh", [script, ...args], {
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
      ...serviceEnv(fixture.service),
    },
  });
  assertNoRefusedServiceCalls(fixture.service);
  return result;
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
  const serviceBin = path.join(root, "service-bin");
  mkdirSync(serviceBin);
  const service = createServiceIsolation(root, serviceBin);
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
    service,
    home: path.join(root, "home"),
    prefix: path.join(root, "install"),
    binDir: path.join(root, "installed-bin"),
    marker: path.join(root, "existing-paseo.log"),
    cliLog: path.join(root, "config-cli.log"),
    paseoHome: path.join(root, "home", ".paseo"),
  };
}

// The installer keeps its launcher under the throwaway label, so fixtures and assertions must too.
function launcherPlistPath(fixture) {
  return path.join(fixture.home, "Library", "LaunchAgents", `${fixture.service.label}.plist`);
}

function runArtifactFixture(fixture, args, extraEnv = {}) {
  mkdirSync(fixture.home, { recursive: true });
  const result = spawnSync("/bin/sh", [path.join(fixture.bundle, "install.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      PASEO_HOME: fixture.paseoHome,
      FAKE_CLI_LOG: fixture.cliLog,
      PATH: `${fixture.service.binDir}:${fixture.oldBin}:/usr/bin:/bin`,
      EXISTING_PASEO_MARKER: fixture.marker,
      ...extraEnv,
      ...serviceEnv(fixture.service),
    },
  });
  assertNoRefusedServiceCalls(fixture.service);
  return result;
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
  // The preflight asks launchd whether the service is loaded before it reads agent state.
  writeServiceStub(
    fixture.service,
    "launchctl",
    `case "$1" in print) exit 1 ;; *) ${UNSCRIPTED_SERVICE_CALL} ;; esac`,
  );
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
    assert.deepEqual(serviceCalls(fixture.service), [
      `launchctl print gui/${process.getuid()}/${fixture.service.label}`,
    ]);
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
  // Rollback unloads the launchd job even for a --no-start install; it must hit the throwaway label.
  writeServiceStub(
    fixture.service,
    "launchctl",
    `case "$1" in bootout) exit 0 ;; *) ${UNSCRIPTED_SERVICE_CALL} ;; esac`,
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
    assert.deepEqual(serviceCalls(fixture.service), [
      `launchctl bootout gui/${process.getuid()}/${fixture.service.label}`,
    ]);
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
  const plistPath = launcherPlistPath(fixture);
  mkdirSync(path.dirname(plistPath), { recursive: true });
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
  // Each bootstrap copies the launcher it loads and the daemon config next to it, so a test can see
  // what the service manager was handed at that moment, not only that the call happened.
  const snapshots = path.join(fixture.root, "bootstrap-snapshots");
  mkdirSync(snapshots);
  writeServiceStub(
    fixture.service,
    "launchctl",
    `printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"
case "$1" in
  print) exit 0 ;;
  bootout) : > "$LAUNCHD_BOOTED_OUT"; exit 0 ;;
  bootstrap)
    n=$(($(cat "$BOOTSTRAP_SNAPSHOTS/count" 2>/dev/null || echo 0) + 1))
    echo "$n" > "$BOOTSTRAP_SNAPSHOTS/count"
    cp "$3" "$BOOTSTRAP_SNAPSHOTS/$n.plist"
    cp "$PASEO_HOME/config.json" "$BOOTSTRAP_SNAPSHOTS/$n.config.json" 2>/dev/null
    exit 0 ;;
  kickstart) exit 0 ;;
  *) ${UNSCRIPTED_SERVICE_CALL} ;;
esac
`,
  );
  // A fast sleep keeps the fail-loud readback loop from waiting real seconds.
  writeExecutable(path.join(fixture.oldBin, "sleep"), "#!/bin/sh\nexit 0\n");
  return {
    fixture,
    previous,
    plistPath,
    rollbackMarker,
    launchctlLog,
    snapshots,
    env: { LAUNCHD_BOOTED_OUT: bootedOut, BOOTSTRAP_SNAPSHOTS: snapshots },
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
  // Service names come from env with the production defaults, so tests can target a throwaway one.
  assert.match(macos, /LABEL="\$\{PASEO_LAUNCHD_LABEL:-\$DEFAULT_LABEL\}"/);
  assert.match(macos, /DEFAULT_LABEL="com\.paseo\.web-cli"/);
  assert.match(linux, /SERVICE_NAME="\$\{PASEO_SYSTEMD_UNIT:-paseo-web-cli\.service\}"/);
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
    const plist = readFileSync(launcherPlistPath(fixture), "utf8");
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

// The version directory the installer wrote under launcher-backups, next to the one-time
// `pre-daemon-run` directory.
function installedVersion(fixture) {
  const versions = readdirSync(path.join(fixture.prefix, "launcher-backups"));
  assert.equal(versions.includes("pre-daemon-run") ? versions.length - 1 : versions.length, 1);
  return versions.find((name) => name !== "pre-daemon-run");
}

const LEGACY_INSTALL_ARGS = (fixture) => [
  "--prefix",
  fixture.prefix,
  "--bin-dir",
  fixture.binDir,
  "--no-start",
  "--skip-foundation",
];

function installOverLegacyPlist(fixture, legacyPlist) {
  const plistPath = launcherPlistPath(fixture);
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, legacyPlist);
  const result = runArtifactFixture(fixture, LEGACY_INSTALL_ARGS(fixture));
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
  writeServiceStub(
    fixture.service,
    "launchctl",
    `printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"
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
  *) ${UNSCRIPTED_SERVICE_CALL} ;;
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
  writeServiceStub(
    fixture.service,
    "launchctl",
    `printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"
case "$1" in
  print) exit 1 ;;
  bootout|bootstrap|kickstart) exit 0 ;;
  *) ${UNSCRIPTED_SERVICE_CALL} ;;
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
    const backup = readFileSync(
      path.join(
        fixture.prefix,
        "launcher-backups",
        installedVersion(fixture),
        `${fixture.service.label}.plist`,
      ),
      "utf8",
    );
    assert.equal(backup, LEGACY_RELAY_PLIST);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

const RUNNING_STATUS = '{"localDaemon":"running","connectedDaemon":"reachable"}';
const ROLLBACK_ARGS = (fixture) => ["--prefix", fixture.prefix, "--bin-dir", fixture.binDir];

test("a failed install hands the previous release its original launcher and config before restarting it", () => {
  const originalConfig = '{\n    "version": 1,\n    "daemon": { "listen": "127.0.0.1:9999" }\n}';
  const { fixture, plistPath, snapshots, rollbackMarker, launchctlLog, env } =
    setupRollbackRestartFixture(RUNNING_STATUS);
  const configPath = path.join(fixture.paseoHome, "config.json");
  mkdirSync(fixture.paseoHome, { recursive: true });
  writeFileSync(configPath, originalConfig);
  try {
    const result = runArtifactFixture(fixture, ROLLBACK_ARGS(fixture), {
      ROLLBACK_PASEO_MARKER: rollbackMarker,
      LAUNCHCTL_LOG: launchctlLog,
      ...env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring the previous Paseo release/);
    // The migration ran against the operator's config before the install failed.
    assert.match(
      readFileSync(fixture.cliLog, "utf8"),
      /^daemon config set daemon\.relay\.enabled true /mu,
    );

    const snapshot = (n, name) => readFileSync(path.join(snapshots, `${n}.${name}`), "utf8");
    const bootstraps = Number(readFileSync(path.join(snapshots, "count"), "utf8"));
    assert.equal(bootstraps, 2);
    // First bootstrap: the migrated launcher and the config the migration wrote.
    assert.match(snapshot(1, "plist"), /<string>run<\/string>/u);
    assert.notEqual(snapshot(1, "config.json"), originalConfig);
    // Second bootstrap restarts the previous release: it must already see the original bytes.
    assert.equal(snapshot(2, "plist"), LEGACY_RELAY_PLIST);
    assert.equal(snapshot(2, "config.json"), originalConfig);
    assert.equal(readFileSync(plistPath, "utf8"), LEGACY_RELAY_PLIST);
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("migration writes config to the home the launcher exports and a failed install restores that config", () => {
  const { fixture, plistPath, rollbackMarker, launchctlLog, env } =
    setupRollbackRestartFixture(RUNNING_STATUS);
  const launcherHome = path.join(fixture.root, "launcher-home");
  const launcherConfig = path.join(launcherHome, "config.json");
  const originalConfig = '{"version":1,"daemon":{"listen":"127.0.0.1:9999"}}';
  mkdirSync(launcherHome);
  writeFileSync(launcherConfig, originalConfig);
  writeFileSync(
    plistPath,
    LEGACY_RELAY_PLIST.replace(
      "<key>HOME</key>",
      `<key>PASEO_HOME</key><string>${launcherHome}</string>\n    <key>HOME</key>`,
    ),
  );
  try {
    const result = runArtifactFixture(fixture, ROLLBACK_ARGS(fixture), {
      ROLLBACK_PASEO_MARKER: rollbackMarker,
      LAUNCHCTL_LOG: launchctlLog,
      ...env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring the previous Paseo release/);
    const cliCalls = readFileSync(fixture.cliLog, "utf8");
    assert.match(
      cliCalls,
      new RegExp(`^daemon config set daemon\\.relay\\.enabled true --home ${launcherHome} `, "mu"),
    );
    assert.equal(cliCalls.includes(`--home ${fixture.paseoHome}`), false);
    // The config the migration rewrote is the launcher's, and it is the one handed back.
    assert.equal(readFileSync(launcherConfig, "utf8"), originalConfig);
    assert.equal(
      readFileSync(
        path.join(fixture.prefix, "launcher-backups", installedVersion(fixture), "config.json"),
        "utf8",
      ),
      originalConfig,
    );
    assert.equal(existsSync(path.join(fixture.paseoHome, "config.json")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a rollback never restarts the previous release from a launcher this install wrote", () => {
  const { fixture, plistPath, previous, rollbackMarker, launchctlLog, env } =
    setupRollbackRestartFixture(RUNNING_STATUS);
  // No launcher existed before this install, and persisting its config fails after it is written.
  rmSync(plistPath);
  writeFileSync(
    path.join(fixture.bundle, "app", "node_modules", "@getpaseo", "cli", "dist", "index.js"),
    "process.exit(1);\n",
  );
  try {
    const result = runArtifactFixture(fixture, ROLLBACK_ARGS(fixture), {
      ROLLBACK_PASEO_MARKER: rollbackMarker,
      LAUNCHCTL_LOG: launchctlLog,
      ...env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring the previous Paseo release/);
    assert.equal(readlinkSync(path.join(fixture.prefix, "current")), previous);
    assert.equal(existsSync(plistPath), false);
    const launchctlCalls = readFileSync(launchctlLog, "utf8").trim().split("\n");
    assert.deepEqual(
      launchctlCalls.filter((line) => /^(bootstrap|kickstart) /u.test(line)),
      [],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the first launcher that needs migrating is kept once and later reinstalls never replace it", () => {
  const fixture = createArtifactFixture("#!/bin/sh\nexit 99\n");
  const backups = path.join(fixture.prefix, "launcher-backups");
  const preMigration = path.join(backups, "pre-daemon-run", `${fixture.service.label}.plist`);
  const reinstall = () => {
    rmSync(path.join(fixture.prefix, "current"), { force: true });
    rmSync(path.join(fixture.prefix, "releases"), { recursive: true, force: true });
    return runArtifactFixture(fixture, LEGACY_INSTALL_ARGS(fixture));
  };
  try {
    const first = installOverLegacyPlist(fixture, LEGACY_RELAY_PLIST);
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(readFileSync(preMigration, "utf8"), LEGACY_RELAY_PLIST);

    const second = reinstall();
    assert.equal(second.status, 0, second.stderr);
    // The per-version backup is rewritten with the launcher the reinstall found, which is already
    // migrated; the one-time copy keeps the launcher an older release can run.
    assert.match(
      readFileSync(
        path.join(backups, installedVersion(fixture), `${fixture.service.label}.plist`),
        "utf8",
      ),
      /<string>run<\/string>/u,
    );
    assert.equal(readFileSync(preMigration, "utf8"), LEGACY_RELAY_PLIST);

    // A launcher that is already `daemon run` is not a pre-migration launcher: it is never saved as one.
    rmSync(path.join(backups, "pre-daemon-run"), { recursive: true });
    const third = reinstall();
    assert.equal(third.status, 0, third.stderr);
    assert.equal(existsSync(preMigration), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a launcher's own daemon home wins over the installer's, per launcher format", () => {
  const fixture = createLauncherFixture();
  const installerHome = fixture.home;
  const legacyExec = '"/n/node" /c/index.js daemon start --foreground --listen 127.0.0.1:7777';
  try {
    const systemd = path.join(fixture.root, "paseo.service");
    const writeUnit = (exec, environment) =>
      writeFileSync(systemd, `[Service]\nExecStart=${exec}\n${environment}\n`);
    const resolveSystemd = () =>
      resolveLauncherHome({ kind: "systemd", file: systemd, home: installerHome });
    writeUnit(legacyExec, 'Environment="PASEO_HOME=/srv/paseo 100%%"');
    assert.equal(resolveSystemd(), "/srv/paseo 100%");
    writeUnit(`${legacyExec} --home /explicit/home`, 'Environment="PASEO_HOME=/srv/paseo"');
    assert.equal(resolveSystemd(), "/explicit/home");
    writeUnit(legacyExec, "Environment=PASEO_DICTATION_ENABLED=0");
    assert.equal(resolveSystemd(), installerHome);

    const powershell = path.join(fixture.root, "run-daemon.ps1");
    writeFileSync(
      powershell,
      `$env:PASEO_HOME = "C:\\paseo home"\n& "C:\\n\\node.exe" "C:\\c\\index.js" daemon start --foreground --listen 127.0.0.1:7777 *>> "C:\\log"\n`,
    );
    assert.equal(
      resolveLauncherHome({ kind: "powershell", file: powershell, home: installerHome }),
      "C:\\paseo home",
    );

    const plist = path.join(fixture.root, "launcher.plist");
    writeFileSync(
      plist,
      LEGACY_RELAY_PLIST.replace(
        "<key>HOME</key>",
        "<key>PASEO_HOME</key><string>/plist/home</string>\n    <key>HOME</key>",
      ),
    );
    assert.equal(
      resolveLauncherHome({ kind: "plist", file: plist, home: installerHome }),
      "/plist/home",
    );
    writeFileSync(plist, LEGACY_RELAY_PLIST);
    assert.equal(
      resolveLauncherHome({ kind: "plist", file: plist, home: installerHome }),
      installerHome,
    );

    // The migration itself writes to that home and leaves the installer's alone.
    const unitHome = path.join(fixture.root, "unit-home");
    writeUnit(legacyExec, `Environment="PASEO_HOME=${unitHome}"`);
    const migrated = migrateLauncher({ kind: "systemd", file: systemd, ...fixture });
    assert.deepEqual(migrated.written, ["daemon.listen"]);
    assert.equal(
      JSON.parse(readFileSync(path.join(unitHome, "config.json"), "utf8")).daemon.listen,
      "127.0.0.1:7777",
    );
    assert.equal(existsSync(path.join(installerHome, "config.json")), false);
    assert.match(readFileSync(systemd, "utf8"), new RegExp(`daemon run --home "${unitHome}"`, "u"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a launcher needs migration only while it still passes removed launch flags", () => {
  const fixture = createLauncherFixture();
  try {
    const plist = path.join(fixture.root, "launcher.plist");
    const needs = () => launcherNeedsMigration({ kind: "plist", file: plist, home: fixture.home });
    writeFileSync(plist, LEGACY_RELAY_PLIST);
    assert.equal(needs(), true);
    migrateLauncher({ kind: "plist", file: plist, ...fixture });
    assert.equal(needs(), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
