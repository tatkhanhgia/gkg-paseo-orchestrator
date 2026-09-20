import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  installerScript,
  linuxInstallerScript,
  windowsInstallerScript,
} from "./build-macos-web-cli-artifact.mjs";

const repoRoot = join(import.meta.dirname, "..");

function assertNoDirectWorkerLaunch(label, command) {
  for (const workerEntrypoint of [
    "src/server/index.ts",
    "dist/server/server/index.js",
    "src/server/daemon-worker.ts",
    "dist/server/server/daemon-worker.js",
  ]) {
    assert.ok(
      !command.includes(workerEntrypoint),
      `${label} must not launch ${workerEntrypoint} directly: ${command}`,
    );
  }
}

function assertNoSpawnedWorkerEntrypoint(label, source) {
  assertNoDirectWorkerLaunch(label, source);
  assert.doesNotMatch(
    source,
    /spawn\([^)]*["'`][^"'`]*\.\.\/index\.ts["'`]/s,
    `${label} must not spawn ../index.ts directly`,
  );
}

function wrapperBlock(source, wrapperName) {
  const marker = `$out/bin/${wrapperName} \\\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Nix package must define the ${wrapperName} wrapper`);
  const end = source.indexOf("\n    makeWrapper ", start + marker.length);
  return source.slice(start, end === -1 ? source.length : end);
}

test("every executable daemon entrypoint enters the supervisor", async () => {
  const [
    serverPackageSource,
    appIsolatedHostDaemon,
    serverConnectionOfferE2e,
    desktopRuntimePaths,
    nixPackage,
    nixModule,
    nixFlake,
    nixBeadsCentral,
  ] = await Promise.all([
    readFile(join(repoRoot, "packages/server/package.json"), "utf8"),
    readFile(join(repoRoot, "packages/app/e2e/support/helpers/isolated-host-daemon.ts"), "utf8"),
    readFile(
      join(repoRoot, "packages/server/src/server/daemon-e2e/connection-offer.e2e.test.ts"),
      "utf8",
    ),
    readFile(join(repoRoot, "packages/desktop/src/daemon/runtime-paths.ts"), "utf8"),
    readFile(join(repoRoot, "nix/package.nix"), "utf8"),
    readFile(join(repoRoot, "nix/module.nix"), "utf8"),
    readFile(join(repoRoot, "flake.nix"), "utf8"),
    readFile(join(repoRoot, "nix/beads-central.nix"), "utf8"),
  ]);

  const serverPackage = JSON.parse(serverPackageSource);
  const startScript = serverPackage.scripts?.start ?? "";
  const devScript = serverPackage.scripts?.dev ?? "";
  const devTsxScript = serverPackage.scripts?.["dev:tsx"] ?? "";

  assert.match(startScript, /dist\/scripts\/supervisor-entrypoint\.js/);
  assertNoDirectWorkerLaunch("server start script", startScript);
  assert.match(devScript, /scripts\/dev-runner\.ts/);
  assertNoDirectWorkerLaunch("server dev script", devScript);
  assert.match(devTsxScript, /scripts\/dev-runner\.ts/);
  assertNoDirectWorkerLaunch("server dev:tsx script", devTsxScript);

  assert.match(
    appIsolatedHostDaemon,
    /spawnTsx\("scripts\/supervisor-entrypoint\.ts", \["--dev"\]/,
  );
  assertNoSpawnedWorkerEntrypoint("app e2e isolated host daemon", appIsolatedHostDaemon);

  assert.match(serverConnectionOfferE2e, /scripts\/supervisor-entrypoint\.ts/);
  assertNoSpawnedWorkerEntrypoint("server daemon e2e process launch", serverConnectionOfferE2e);

  assert.match(desktopRuntimePaths, /"dist", "scripts", "supervisor-entrypoint\.js"/);
  assert.match(desktopRuntimePaths, /"scripts", "supervisor-entrypoint\.ts"/);
  assertNoDirectWorkerLaunch("desktop runtime paths", desktopRuntimePaths);

  assert.match(nixPackage, /dist\/scripts\/supervisor-entrypoint\.js/);
  assertNoDirectWorkerLaunch("Nix package wrapper", nixPackage);
  assert.match(wrapperBlock(nixPackage, "paseo-server"), /--set PASEO_NODE_ENV production/);
  for (const wrapperName of ["paseo-server", "paseo"]) {
    const block = wrapperBlock(nixPackage, wrapperName);
    assert.match(
      block,
      /--set PASEO_BEADS_CENTRAL_SIDECAR "\$\{beadsCentral\}\/bin\/beads-central"/,
      `${wrapperName} must configure the bundled Beads Central sidecar`,
    );
    assert.match(
      block,
      /--set PASEO_BEADS_CENTRAL_BD_BIN "\$\{beadsCentral\}\/bin\/bd"/,
      `${wrapperName} must configure the bundled bd binary`,
    );
  }
  assert.doesNotMatch(nixPackage, /--set(-default)?\s+NODE_ENV\b/);
  assert.doesNotMatch(nixModule, /\bNODE_ENV\b\s*=/);
  assert.doesNotMatch(nixModule, /\bPASEO_NODE_ENV\b/);
  assert.match(nixFlake, /nix\/beads-central\.nix/);
  assert.match(nixFlake, /inherit beadsCentral/);
  assert.match(nixBeadsCentral, /buildGo126Module/);
  assert.match(nixBeadsCentral, /go_1_26\.overrideAttrs/);
});

test("macOS installer patches the Beads Central sidecar env into an existing plist", () => {
  const source = installerScript();
  const freshWrite = source.indexOf('if [ ! -f "$PLIST" ]; then');
  const upgradePatch = source.indexOf("\nelse\n", freshWrite);
  const upgradeEnd = source.indexOf("\nfi\n", upgradePatch);
  assert.notEqual(freshWrite, -1, "installer must keep the fresh-plist write branch");
  assert.notEqual(upgradePatch, -1, "installer must handle an existing plist in an else branch");
  const freshBranch = source.slice(freshWrite, upgradePatch);
  const upgradeBranch = source
    .slice(upgradePatch, upgradeEnd)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  for (const key of ["PASEO_BEADS_CENTRAL_SIDECAR", "PASEO_BEADS_CENTRAL_BD_BIN"]) {
    assert.match(freshBranch, new RegExp(`<key>${key}</key>`), `fresh plist must set ${key}`);
    assert.match(
      upgradeBranch,
      new RegExp(
        `plutil -replace EnvironmentVariables\\.${key} -string "\\$CURRENT_LINK/components/beads-central/`,
      ),
      `existing plist must be patched with ${key}`,
    );
  }
  assert.match(upgradeBranch, /plutil -insert EnvironmentVariables -dictionary/);
  // The upgrade branch must never rewrite the operator's relay or listen choice.
  assert.doesNotMatch(
    upgradeBranch,
    /--relay|--no-relay|--listen|ProgramArguments|cat > "\$PLIST"/,
  );
});

test("linux installer injects the Beads Central sidecar env into an existing systemd unit", () => {
  const source = linuxInstallerScript();
  const freshWrite = source.indexOf('if [ ! -f "$UNIT" ]; then');
  assert.notEqual(freshWrite, -1, "installer must keep the fresh-unit write branch");
  const upgradePatch = source.indexOf("\nelse\n", freshWrite);
  const upgradeEnd = source.indexOf("\nfi\n", upgradePatch);
  assert.notEqual(upgradePatch, -1, "installer must handle an existing unit in an else branch");
  const freshBranch = source.slice(freshWrite, upgradePatch);
  const upgradeBranch = source
    .slice(upgradePatch, upgradeEnd)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  for (const key of ["PASEO_BEADS_CENTRAL_SIDECAR", "PASEO_BEADS_CENTRAL_BD_BIN"]) {
    assert.match(
      freshBranch,
      new RegExp(`Environment="${key}=\\$CURRENT_LINK/components/beads-central/`),
      `fresh unit must set ${key}`,
    );
    assert.match(
      upgradeBranch,
      new RegExp(`Environment="${key}=\\$CURRENT_LINK/components/beads-central/`),
      `drop-in must set ${key}`,
    );
  }
  // The drop-in only injects env; it must never rewrite the operator's ExecStart/listen/relay.
  assert.match(upgradeBranch, /cat > "\$DROPIN" <<DROPIN/);
  assert.doesNotMatch(upgradeBranch, /ExecStart|--listen|--relay|--no-relay|cat > "\$UNIT"/);
});

test("windows installer splices the Beads Central sidecar env into an existing run-daemon.ps1", () => {
  const source = windowsInstallerScript();
  const freshWrite = source.indexOf("if (-not $RunDaemonExisted) {");
  assert.notEqual(freshWrite, -1, "installer must keep the fresh run-daemon write branch");
  const upgradePatch = source.indexOf("} else {", freshWrite);
  assert.notEqual(
    upgradePatch,
    -1,
    "installer must handle an existing run-daemon in an else branch",
  );
  const upgradeBranch = source
    .slice(upgradePatch, source.indexOf("\nif (-not $NoStart)", upgradePatch))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  assert.match(upgradeBranch, /\$RunDaemonContent -notmatch "PASEO_BEADS_CENTRAL_SIDECAR"/);
  assert.match(upgradeBranch, /PASEO_BEADS_CENTRAL_SIDECAR = `"\$BeadsSidecar`"/);
  assert.match(upgradeBranch, /PASEO_BEADS_CENTRAL_BD_BIN = `"\$BeadsBd`"/);
  // The splice prepends env only; it must not rewrite the operator's launch line or listen choice.
  assert.doesNotMatch(upgradeBranch, /daemon start|--listen|--relay|--no-relay/);
});

test("trace-daemon closure lists both Foundation workspace-protocol JSON assets", async () => {
  const traceDaemonSource = await readFile(join(repoRoot, "scripts/trace-daemon.mjs"), "utf8");

  for (const assetPath of [
    "packages/server/dist/server/utils/foundation-workspace-protocol-contract.json",
    "packages/server/dist/server/utils/foundation-workspace-protocol-fixtures.json",
  ]) {
    assert.ok(
      traceDaemonSource.includes(assetPath),
      `trace-daemon.mjs additionalInputs must list ${assetPath}`,
    );
  }
});
