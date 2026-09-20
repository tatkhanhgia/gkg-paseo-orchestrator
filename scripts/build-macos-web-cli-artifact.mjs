import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const ARTIFACTS_ROOT = path.join(REPO_ROOT, "artifacts");
const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const VERSION = packageJson.version;
const ARCH = process.arch;
const PLATFORM = process.platform;
const PLATFORM_NAME = { darwin: "macos", linux: "linux", win32: "windows" }[PLATFORM];
const ARCHIVE_EXTENSION = PLATFORM === "win32" ? ".zip" : ".tar.gz";
const BUNDLE_NAME = `paseo-web-cli-${VERSION}-${PLATFORM_NAME}-${ARCH}`;
const STAGING_ROOT = path.join(ARTIFACTS_ROOT, ".staging", BUNDLE_NAME);
const PACK_ROOT = path.join(ARTIFACTS_ROOT, ".staging", "packs");
const OUTPUT_DIR = path.join(ARTIFACTS_ROOT, BUNDLE_NAME);
const OUTPUT_ARCHIVE = path.join(ARTIFACTS_ROOT, `${BUNDLE_NAME}${ARCHIVE_EXTENSION}`);
const OUTPUT_CHECKSUM = `${OUTPUT_ARCHIVE}.sha256`;
const BEADS_CENTRAL_VERSION = "1.2.0";
const INTERNAL_PACKAGES = [
  "@getpaseo/highlight",
  "@getpaseo/plugin",
  "@getpaseo/relay",
  "@getpaseo/protocol",
  "@getpaseo/client",
  "@getpaseo/server",
  "@getpaseo/cli",
  "@getpaseo/foundation-cli",
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    fail(`${command} ${args.join(" ")} failed with exit ${result.status}${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    return run(process.execPath, [npmCli, ...args], options);
  }
  return run(PLATFORM === "win32" ? "npm.cmd" : "npm", args, options);
}

function writeExecutable(target, bytes) {
  writeFileSync(target, bytes, { mode: 0o755 });
  chmodSync(target, 0o755);
}

function resolveBundledNodeRoot() {
  const override = process.env.PASEO_RELEASE_NODE_ROOT;
  const candidates = [
    override,
    path.join(os.homedir(), ".nvm", "versions", "node", "v24.11.0"),
    PLATFORM === "win32"
      ? path.dirname(process.execPath)
      : path.dirname(path.dirname(process.execPath)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const node = nodeExecutable(candidate);
    const license = path.join(candidate, "LICENSE");
    if (existsSync(node) && existsSync(license)) return realpathSync(candidate);
  }
  fail(
    "Could not locate a relocatable Node distribution. Set PASEO_RELEASE_NODE_ROOT to a Node installation containing the Node executable and LICENSE.",
  );
}

function nodeExecutable(nodeRoot) {
  return path.join(nodeRoot, ...(PLATFORM === "win32" ? ["node.exe"] : ["bin", "node"]));
}

function assertReleaseInputs(nodeRoot) {
  if (!PLATFORM_NAME) fail(`Unsupported release platform: ${PLATFORM}`);
  const supportedArchitectures = PLATFORM === "darwin" ? ["arm64", "x64"] : ["x64"];
  if (!supportedArchitectures.includes(ARCH)) {
    fail(`Unsupported ${PLATFORM_NAME} architecture: ${ARCH}`);
  }
  const status = run("git", ["status", "--porcelain"], { capture: true });
  const unstaged = run("git", ["diff", "--no-ext-diff", "--binary"], {
    capture: true,
  });
  const staged = run("git", ["diff", "--cached", "--no-ext-diff", "--binary"], {
    capture: true,
  });
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], {
    capture: true,
  });
  const materialDirty = [unstaged, staged, untracked].filter(Boolean).join("\n");
  if (materialDirty && process.env.PASEO_RELEASE_ALLOW_DIRTY !== "1") {
    fail(
      `Refusing to build a release artifact from material worktree changes:\n${status}\n\n${materialDirty}\nSet PASEO_RELEASE_ALLOW_DIRTY=1 only for a local candidate build.`,
    );
  }
  const bundledArch = run(nodeExecutable(nodeRoot), ["-p", "process.arch"], {
    capture: true,
  });
  if (bundledArch !== ARCH) {
    fail(`Bundled Node architecture ${bundledArch} does not match build architecture ${ARCH}`);
  }
}

function buildProduct() {
  runNpm(["run", "build:server:clean"]);
  runNpm(["run", "build:daemon-web-ui"]);
  run(process.execPath, ["packages/foundation-cli/prepare-assets.mjs"]);
  runNpm(["run", "build", "--workspace=@getpaseo/foundation-cli"]);
}

function packInternalPackages() {
  rmSync(PACK_ROOT, { recursive: true, force: true });
  mkdirSync(PACK_ROOT, { recursive: true });
  const tarballs = [];
  for (const workspace of INTERNAL_PACKAGES) {
    // buildProduct() already built every package in INTERNAL_PACKAGES. Do not let npm pack rerun
    // prepack hooks that clean those shared outputs or rebuild the daemon web UI a second time.
    const output = runNpm(
      [
        "pack",
        "--silent",
        "--json",
        "--ignore-scripts",
        `--workspace=${workspace}`,
        `--pack-destination=${PACK_ROOT}`,
      ],
      { capture: true },
    );
    const packed = parseTrailingJson(output, workspace);
    if (packed.length !== 1 || !packed[0]?.filename)
      fail(`Unexpected npm pack result for ${workspace}`);
    tarballs.push(path.join(PACK_ROOT, packed[0].filename));
  }
  return tarballs;
}

function parseTrailingJson(output, label) {
  for (
    let index = output.lastIndexOf("[");
    index >= 0;
    index = output.lastIndexOf("[", index - 1)
  ) {
    try {
      return JSON.parse(output.slice(index));
    } catch {
      // npm lifecycle scripts may write progress before the final --json payload.
    }
  }
  fail(`Could not parse trailing npm JSON for ${label}`);
}

function installProductionPayload(nodeRoot, tarballs) {
  const appRoot = path.join(STAGING_ROOT, "app");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(
    path.join(appRoot, "package.json"),
    `${JSON.stringify(
      { name: "paseo-web-cli-runtime", private: true, version: VERSION },
      null,
      2,
    )}\n`,
  );
  const npmEnv = {
    ...process.env,
    PATH: [path.dirname(nodeExecutable(nodeRoot)), process.env.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  runNpm(
    ["install", "--omit=dev", "--no-package-lock", "--no-save", `--prefix=${appRoot}`, ...tarballs],
    { env: npmEnv },
  );
}

function copyNodeRuntime(nodeRoot) {
  const runtimeRoot = path.join(STAGING_ROOT, "runtime");
  const runtimeBin = PLATFORM === "win32" ? runtimeRoot : path.join(runtimeRoot, "bin");
  const runtimeNode = path.join(runtimeBin, PLATFORM === "win32" ? "node.exe" : "node");
  mkdirSync(runtimeBin, { recursive: true });
  copyFileSync(nodeExecutable(nodeRoot), runtimeNode);
  if (PLATFORM !== "win32") chmodSync(runtimeNode, 0o755);
  for (const name of ["LICENSE", "README.md"]) {
    const source = path.join(nodeRoot, name);
    if (existsSync(source)) copyFileSync(source, path.join(runtimeRoot, `NODE-${name}`));
  }
}

function buildBeadsCentralComponent() {
  const output = path.join(STAGING_ROOT, "components", "beads-central");
  run(process.execPath, [
    path.join(REPO_ROOT, "scripts", "build-beads-central-sidecar.mjs"),
    "--output",
    output,
  ]);
}

function createLaunchers() {
  const binRoot = path.join(STAGING_ROOT, "bin");
  mkdirSync(binRoot, { recursive: true });
  if (PLATFORM === "win32") {
    for (const [name, packageName] of [
      ["paseo", "@getpaseo/cli"],
      ["paseo-foundation", "@getpaseo/foundation-cli"],
    ]) {
      writeFileSync(
        path.join(binRoot, `${name}.cmd`),
        `@echo off\r\nsetlocal\r\nset "ROOT=%~dp0.."\r\nset "PASEO_BEADS_CENTRAL_SIDECAR=%ROOT%\\components\\beads-central\\beads-central.exe"\r\nset "PASEO_BEADS_CENTRAL_BD_BIN=%ROOT%\\components\\beads-central\\bin\\bd.exe"\r\n"%ROOT%\\runtime\\node.exe" "%ROOT%\\app\\node_modules\\${packageName.replaceAll(
          "/",
          "\\",
        )}\\dist\\index.js" %*\r\n`,
      );
    }
    return;
  }
  writeExecutable(
    path.join(binRoot, "paseo"),
    `#!/bin/sh
set -eu
SOURCE=$0
while [ -L "$SOURCE" ]; do
  SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd -P)
  SOURCE_TARGET=$(readlink "$SOURCE")
  case "$SOURCE_TARGET" in
    /*) SOURCE=$SOURCE_TARGET ;;
    *) SOURCE=$SOURCE_DIR/$SOURCE_TARGET ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd -P)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
export PASEO_BEADS_CENTRAL_SIDECAR="$ROOT/components/beads-central/beads-central"
export PASEO_BEADS_CENTRAL_BD_BIN="$ROOT/components/beads-central/bin/bd"
exec "$ROOT/runtime/bin/node" "$ROOT/app/node_modules/@getpaseo/cli/dist/index.js" "$@"
`,
  );
  writeExecutable(
    path.join(binRoot, "paseo-foundation"),
    `#!/bin/sh
set -eu
SOURCE=$0
while [ -L "$SOURCE" ]; do
  SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd -P)
  SOURCE_TARGET=$(readlink "$SOURCE")
  case "$SOURCE_TARGET" in
    /*) SOURCE=$SOURCE_TARGET ;;
    *) SOURCE=$SOURCE_DIR/$SOURCE_TARGET ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd -P)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
export PASEO_BEADS_CENTRAL_SIDECAR="$ROOT/components/beads-central/beads-central"
export PASEO_BEADS_CENTRAL_BD_BIN="$ROOT/components/beads-central/bin/bd"
exec "$ROOT/runtime/bin/node" "$ROOT/app/node_modules/@getpaseo/foundation-cli/dist/index.js" "$@"
`,
  );
}

export function installerScript() {
  return `#!/bin/sh
set -eu

VERSION=${shellQuote(VERSION)}
DEFAULT_LABEL="com.paseo.web-cli"
PREFIX="\${PASEO_INSTALL_PREFIX:-$HOME/.local/share/paseo-web-cli}"
BIN_DIR="\${PASEO_INSTALL_BIN_DIR:-$HOME/.local/bin}"
LISTEN="127.0.0.1:6767"
LABEL="$DEFAULT_LABEL"
START=1
INSTALL_FOUNDATION=1

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Install the Paseo WebUI + CLI macOS release for the current user.

Options:
  --prefix PATH          Release root (default: ~/.local/share/paseo-web-cli)
  --bin-dir PATH         CLI symlink directory (default: ~/.local/bin)
  --listen HOST:PORT     Daemon listen address (default: 127.0.0.1:6767)
  --label LABEL          launchd label (default: com.paseo.web-cli)
  --no-start             Install files and plist without loading launchd
  --skip-foundation      Do not install/update the bundled Foundation distribution
  -h, --help             Show this help without changing the machine
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --listen) LISTEN="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --skip-foundation) INSTALL_FOUNDATION=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PREFIX:$BIN_DIR" in
  /*:/*) ;;
  *) echo "--prefix and --bin-dir must be absolute paths" >&2; exit 2 ;;
esac
if [ "$PREFIX" = "/" ] || [ "$BIN_DIR" = "/" ]; then
  echo "Refusing to install into /" >&2
  exit 2
fi
case "$LABEL" in
  *[!A-Za-z0-9._-]*|"") echo "Invalid launchd label: $LABEL" >&2; exit 2 ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SOURCE_ROOT="$SCRIPT_DIR"
RELEASES_DIR="$PREFIX/releases"
RELEASE_DIR="$RELEASES_DIR/$VERSION"
CURRENT_LINK="$PREFIX/current"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
USER_ID=$(id -u)
PLIST_EXISTED=0
if [ -f "$PLIST" ]; then PLIST_EXISTED=1; fi
INSTALL_CONFIG="$PREFIX/install-config.json"
INSTALL_CONFIG_EXISTED=0
if [ -f "$INSTALL_CONFIG" ]; then INSTALL_CONFIG_EXISTED=1; fi
UPDATE_STATUS_DIR="\${PASEO_HOME:-$HOME/.paseo}/updates"
write_update_status() {
  mkdir -p "$UPDATE_STATUS_DIR" || return 1
  updated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  if [ "$1" = "idle" ]; then
    printf '{"phase":"idle","version":null,"message":null,"updatedAt":"%s","preparedBundlePath":null}\n' "$updated_at" > "$UPDATE_STATUS_DIR/status.json.tmp"
  else
    printf '{"phase":"failed","version":"%s","message":"Update failed and the previous release was restored.","updatedAt":"%s","preparedBundlePath":null}\n' "$VERSION" "$updated_at" > "$UPDATE_STATUS_DIR/status.json.tmp"
  fi
  mv "$UPDATE_STATUS_DIR/status.json.tmp" "$UPDATE_STATUS_DIR/status.json"
}
PREVIOUS_RELEASE=""
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_RELEASE=$(readlink "$CURRENT_LINK")
fi
if [ "$PREVIOUS_RELEASE" = "$RELEASE_DIR" ]; then
  echo "Paseo $VERSION is already the active portable release." >&2
  exit 1
fi
PREFLIGHT_ROOT=""
preflight_cleanup() {
  exit_code=$?
  trap - EXIT INT TERM
  [ -z "$PREFLIGHT_ROOT" ] || rm -rf "$PREFLIGHT_ROOT"
  if [ "$exit_code" -ne 0 ]; then write_update_status failed || true; fi
  exit "$exit_code"
}

EXISTING_PASEO=$(command -v paseo 2>/dev/null || true)
if [ -z "$EXISTING_PASEO" ]; then
  for candidate in "$HOME/.local/bin/paseo" "$PREFIX/current/bin/paseo" /opt/homebrew/bin/paseo /usr/local/bin/paseo; do
    if [ -x "$candidate" ]; then
      EXISTING_PASEO="$candidate"
      break
    fi
  done
fi
if [ "$START" -eq 1 ] && [ -n "$EXISTING_PASEO" ]; then
  PREFLIGHT_ROOT=$(mktemp -d "\${TMPDIR:-/tmp}/paseo-downstream-preflight.XXXXXX")
  trap 'preflight_cleanup' EXIT
  trap 'exit 130' INT TERM
  LAUNCHD_LOADED=0
  if launchctl print "gui/$USER_ID/$LABEL" >/dev/null 2>&1; then
    LAUNCHD_LOADED=1
  fi
  if ! PASEO_HOST= "$EXISTING_PASEO" daemon status --json > "$PREFLIGHT_ROOT/status.json"; then
    echo "Refusing to replace the existing Paseo installation because daemon status could not be read." >&2
    exit 1
  fi
  if grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"(running|unresponsive)"' "$PREFLIGHT_ROOT/status.json"; then
    if ! PASEO_HOST= "$EXISTING_PASEO" ls --global --json > "$PREFLIGHT_ROOT/agents.json"; then
      echo "Refusing to stop the existing daemon because agent state could not be read." >&2
      exit 1
    fi
    if grep -Eq '"status"[[:space:]]*:[[:space:]]*"(running|starting|initializing)"' "$PREFLIGHT_ROOT/agents.json"; then
      echo "Refusing to replace Paseo while an agent is running or starting." >&2
      exit 1
    fi

    if ! PASEO_HOST= "$EXISTING_PASEO" workspace ls --json > "$PREFLIGHT_ROOT/workspaces.json"; then
      echo "Refusing to stop the existing daemon because workspace state could not be read." >&2
      exit 1
    fi
    awk -F '"' '/"workspaceId"[[:space:]]*:/ { print $4 }' "$PREFLIGHT_ROOT/workspaces.json" |
      while IFS= read -r workspace_id; do
        [ -n "$workspace_id" ] || continue
        scripts_file="$PREFLIGHT_ROOT/scripts-$workspace_id.json"
        if ! PASEO_HOST= "$EXISTING_PASEO" script ls --workspace "$workspace_id" --json > "$scripts_file"; then
          echo "Refusing to stop the existing daemon because scripts for workspace $workspace_id could not be read." >&2
          exit 1
        fi
        if grep -Eq '"lifecycle"[[:space:]]*:[[:space:]]*"(running|starting)"' "$scripts_file"; then
          echo "Refusing to replace Paseo while workspace $workspace_id has a running script." >&2
          exit 1
        fi
      done

    if [ "$LAUNCHD_LOADED" -eq 1 ]; then
      # The launchd job owns the supervisor process and KeepAlive will respawn it if only the
      # worker receives the daemon shutdown RPC. Remove the owner first, then wait for Paseo's
      # authoritative stopped readback before replacing the installed release.
      printf 'Existing idle launchd-managed Paseo detected at %s; unloading it before activation.\n' "$EXISTING_PASEO"
      if ! launchctl bootout "gui/$USER_ID/$LABEL"; then
        echo "Existing Paseo launchd service could not be unloaded; installation aborted." >&2
        exit 1
      fi
    else
      printf 'Existing idle unmanaged Paseo detected at %s; stopping it before activation.\n' "$EXISTING_PASEO"
      PASEO_HOST= "$EXISTING_PASEO" daemon stop --json >/dev/null
    fi

    STOPPED=0
    for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      if PASEO_HOST= "$EXISTING_PASEO" daemon status --json > "$PREFLIGHT_ROOT/stopped.json" 2>/dev/null &&
         grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"stopped"' "$PREFLIGHT_ROOT/stopped.json"; then
        STOPPED=1
        break
      fi
      sleep 1
    done
    if [ "$STOPPED" -ne 1 ]; then
      echo "Existing Paseo daemon did not report a stopped readback; installation aborted." >&2
      exit 1
    fi
  elif [ "$LAUNCHD_LOADED" -eq 1 ]; then
    echo "Refusing to replace a loaded Paseo launchd service whose daemon is not authoritatively running." >&2
    exit 1
  fi
  rm -rf "$PREFLIGHT_ROOT"
  PREFLIGHT_ROOT=""
  trap - EXIT INT TERM
fi

STAGING=""
ROLLBACK_ARMED=0
rollback_install() {
  exit_code=$?
  trap - EXIT INT TERM
  [ -z "$STAGING" ] || rm -rf "$STAGING"
  if [ "$ROLLBACK_ARMED" -eq 1 ] && [ "$exit_code" -ne 0 ]; then
    echo "Update failed; restoring the previous Paseo release." >&2
    launchctl bootout "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true
    if [ -n "$PREVIOUS_RELEASE" ]; then
      ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
      if [ "$START" -eq 1 ] && [ -f "$PLIST" ]; then
        launchctl bootstrap "gui/$USER_ID" "$PLIST" >/dev/null 2>&1 || true
        launchctl kickstart -k "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true
      fi
    else
      rm -f "$CURRENT_LINK"
    fi
    if [ "$PLIST_EXISTED" -eq 0 ]; then rm -f "$PLIST"; fi
    if [ "$INSTALL_CONFIG_EXISTED" -eq 0 ]; then rm -f "$INSTALL_CONFIG"; fi
    rm -rf "$RELEASE_DIR"
  fi
  if [ "$exit_code" -ne 0 ]; then write_update_status failed || true; fi
  exit "$exit_code"
}
trap 'rollback_install' EXIT
trap 'exit 130' INT TERM

mkdir -p "$RELEASES_DIR" "$BIN_DIR" "$HOME/Library/LaunchAgents"
STAGING="$RELEASES_DIR/.install-$VERSION-$$"
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$SOURCE_ROOT/." "$STAGING/"
rm -rf "$RELEASE_DIR"
mv "$STAGING" "$RELEASE_DIR"
STAGING=""
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
ROLLBACK_ARMED=1
ln -sfn "$CURRENT_LINK/bin/paseo" "$BIN_DIR/paseo"
ln -sfn "$CURRENT_LINK/bin/paseo-foundation" "$BIN_DIR/paseo-foundation"

escape_xml() {
  printf '%s' "$1" | sed -e 's/&/\\&amp;/g' -e 's/</\\&lt;/g' -e 's/>/\\&gt;/g' -e 's/"/\\&quot;/g' -e "s/'/\\&apos;/g"
}

DAEMON_NODE="$CURRENT_LINK/runtime/bin/node"
HOST_NODE=$(command -v node 2>/dev/null || true)
if [ -n "$HOST_NODE" ] && [ -x "$HOST_NODE" ] &&
   "$HOST_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  # A compatible user-installed Node retains macOS privacy grants that may not
  # carry over to the relocated bundled binary when launchd opens Desktop or Documents workspaces.
  DAEMON_NODE="$HOST_NODE"
fi
DAEMON_ENTRY="$CURRENT_LINK/app/node_modules/@getpaseo/cli/dist/index.js"
DAEMON_NODE_XML=$(escape_xml "$DAEMON_NODE")
DAEMON_ENTRY_XML=$(escape_xml "$DAEMON_ENTRY")
BEADS_CENTRAL_SIDECAR_XML=$(escape_xml "$CURRENT_LINK/components/beads-central/beads-central")
BEADS_CENTRAL_BD_XML=$(escape_xml "$CURRENT_LINK/components/beads-central/bin/bd")
LISTEN_XML=$(escape_xml "$LISTEN")
PATH_XML=$(escape_xml "$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
LOG_DIR="$HOME/Library/Logs/Paseo"
mkdir -p "$LOG_DIR"
LOG_XML=$(escape_xml "$LOG_DIR/daemon.log")
if [ ! -f "$PLIST" ]; then
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$DAEMON_NODE_XML</string><string>$DAEMON_ENTRY_XML</string>
    <string>daemon</string><string>start</string>
    <string>--foreground</string><string>--listen</string><string>$LISTEN_XML</string>
    <string>--web-ui</string><string>--no-relay</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$(escape_xml "$HOME")</string>
    <key>PATH</key><string>$PATH_XML</string>
    <key>PASEO_BEADS_CENTRAL_SIDECAR</key><string>$BEADS_CENTRAL_SIDECAR_XML</string>
    <key>PASEO_BEADS_CENTRAL_BD_BIN</key><string>$BEADS_CENTRAL_BD_XML</string>
    <key>PASEO_DICTATION_ENABLED</key><string>0</string>
    <key>PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD</key><string>0</string>
    <key>PASEO_VOICE_MODE_ENABLED</key><string>0</string>
  </dict>
  <key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_XML</string>
  <key>StandardErrorPath</key><string>$LOG_XML</string>
</dict></plist>
PLIST
  plutil -lint "$PLIST" >/dev/null
else
  # An existing plist keeps the operator's --listen, --relay/--no-relay, node, and PATH choices.
  # Releases that predate the bundled Beads Central sidecar wrote a plist without these two
  # variables, so patch them in; the daemon refuses to start its tracker without them.
  plutil -extract EnvironmentVariables xml1 -o /dev/null "$PLIST" >/dev/null 2>&1 ||
    plutil -insert EnvironmentVariables -dictionary "$PLIST"
  plutil -replace EnvironmentVariables.PASEO_BEADS_CENTRAL_SIDECAR -string "$CURRENT_LINK/components/beads-central/beads-central" "$PLIST"
  plutil -replace EnvironmentVariables.PASEO_BEADS_CENTRAL_BD_BIN -string "$CURRENT_LINK/components/beads-central/bin/bd" "$PLIST"
  plutil -lint "$PLIST" >/dev/null
fi

if [ "$START" -eq 1 ]; then
  launchctl bootout "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true
  BOOTSTRAPPED=0
  BOOTSTRAP_ERROR=""
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    if BOOTSTRAP_ERROR=$(launchctl bootstrap "gui/$USER_ID" "$PLIST" 2>&1); then
      BOOTSTRAPPED=1
      break
    fi
    sleep 1
  done
  if [ "$BOOTSTRAPPED" -ne 1 ]; then
    [ -z "$BOOTSTRAP_ERROR" ] || printf '%s\n' "$BOOTSTRAP_ERROR" >&2
    echo "Installed the release, but launchd activation remained unavailable after retries." >&2
    exit 1
  fi
  launchctl kickstart -k "gui/$USER_ID/$LABEL"
  READY=0
  for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if PASEO_HOST= "$CURRENT_LINK/bin/paseo" daemon status --json > "$PREFIX/daemon-readback.json" 2>/dev/null &&
       grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"running"' "$PREFIX/daemon-readback.json" &&
       grep -Eq '"connectedDaemon"[[:space:]]*:[[:space:]]*"reachable"' "$PREFIX/daemon-readback.json"; then
      READY=1
      break
    fi
    sleep 1
  done
  if [ "$READY" -ne 1 ]; then
    echo "Installed the release, but the downstream daemon failed authoritative startup readback." >&2
    echo "Inspect $LOG_DIR/daemon.log before retrying." >&2
    exit 1
  fi
  READBACK_LISTEN=$("$CURRENT_LINK/runtime/bin/node" -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof value.listen!=="string")process.exit(1);process.stdout.write(value.listen)' "$PREFIX/daemon-readback.json")
  rm -f "$PREFIX/daemon-readback.json"
  HEALTHY=0
  for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if PASEO_UPDATE_BASE_URL="http://$READBACK_LISTEN" "$CURRENT_LINK/runtime/bin/node" -e 'const base=process.env.PASEO_UPDATE_BASE_URL;Promise.all([fetch(base+"/api/health"),fetch(base+"/"),fetch("http://127.0.0.1:6769/health/ready")]).then((responses)=>{if(responses.some((response)=>!response.ok))process.exit(1)}).catch(()=>process.exit(1))'; then
      HEALTHY=1
      break
    fi
    sleep 1
  done
  if [ "$HEALTHY" -ne 1 ]; then
    echo "Installed release failed health, WebUI, or Beads Central readback." >&2
    exit 1
  fi
fi

cp "$RELEASE_DIR/uninstall.sh" "$PREFIX/uninstall.sh"
chmod 755 "$PREFIX/uninstall.sh"
if [ "$INSTALL_CONFIG_EXISTED" -eq 0 ]; then
  PASEO_INSTALL_CONFIG="$INSTALL_CONFIG" PASEO_INSTALL_PREFIX_VALUE="$PREFIX" PASEO_INSTALL_BIN_VALUE="$BIN_DIR" "$CURRENT_LINK/runtime/bin/node" -e 'const fs=require("fs");const value={schemaVersion:1,prefix:process.env.PASEO_INSTALL_PREFIX_VALUE,binDir:process.env.PASEO_INSTALL_BIN_VALUE};fs.writeFileSync(process.env.PASEO_INSTALL_CONFIG+".tmp",JSON.stringify(value,null,2)+"\\n");fs.renameSync(process.env.PASEO_INSTALL_CONFIG+".tmp",process.env.PASEO_INSTALL_CONFIG)'
fi

if [ "$INSTALL_FOUNDATION" -eq 1 ]; then
  PLAN="$PREFIX/foundation-install-plan.json"
  MODE="clean-empty"
  if "$CURRENT_LINK/bin/paseo-foundation" inspect --json 2>/dev/null | grep -q '"status": "active"'; then
    MODE="update"
  fi
  "$CURRENT_LINK/bin/paseo-foundation" plan --mode "$MODE" --output "$PLAN"
  "$CURRENT_LINK/bin/paseo-foundation" install --plan "$PLAN"
fi

ROLLBACK_ARMED=0
write_update_status idle || true
printf 'Installed Paseo WebUI + CLI %s at %s\\n' "$VERSION" "$RELEASE_DIR"
printf 'CLI: %s\\n' "$BIN_DIR/paseo"
printf 'WebUI: http://%s\\n' "$LISTEN"
ACTIVE_PASEO=$(command -v paseo 2>/dev/null || true)
if [ "$ACTIVE_PASEO" != "$BIN_DIR/paseo" ]; then
  printf 'PATH notice: add %s to PATH before any other Paseo installation.\\n' "$BIN_DIR" >&2
fi
`;
}

export function linuxInstallerScript() {
  return `#!/bin/sh
set -eu

VERSION=${shellQuote(VERSION)}
PREFIX="\${PASEO_INSTALL_PREFIX:-\${XDG_DATA_HOME:-$HOME/.local/share}/paseo-web-cli}"
BIN_DIR="\${PASEO_INSTALL_BIN_DIR:-$HOME/.local/bin}"
SERVICE_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="paseo-web-cli.service"
LISTEN="127.0.0.1:6767"
START=1
INSTALL_FOUNDATION=1

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Install the Paseo WebUI + CLI Linux release for the current user.

Options:
  --prefix PATH          Release root (default: ~/.local/share/paseo-web-cli)
  --bin-dir PATH         CLI symlink directory (default: ~/.local/bin)
  --listen HOST:PORT     Daemon listen address (default: 127.0.0.1:6767)
  --no-start             Install files without enabling the user systemd service
  --skip-foundation      Do not install/update the bundled Foundation distribution
  -h, --help             Show this help without changing the machine
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --listen) LISTEN="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --skip-foundation) INSTALL_FOUNDATION=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PREFIX:$BIN_DIR" in
  /*:/*) ;;
  *) echo "--prefix and --bin-dir must be absolute paths" >&2; exit 2 ;;
esac
if [ "$PREFIX" = "/" ] || [ "$BIN_DIR" = "/" ]; then
  echo "Refusing to install into /" >&2
  exit 2
fi
if [ "$START" -eq 1 ] && ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "A working user systemd session is required; use --no-start for a files-only install." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SOURCE_ROOT="$SCRIPT_DIR"
RELEASES_DIR="$PREFIX/releases"
RELEASE_DIR="$RELEASES_DIR/$VERSION"
CURRENT_LINK="$PREFIX/current"
UNIT="$SERVICE_DIR/$SERVICE_NAME"
UNIT_EXISTED=0
if [ -f "$UNIT" ]; then UNIT_EXISTED=1; fi
INSTALL_CONFIG="$PREFIX/install-config.json"
INSTALL_CONFIG_EXISTED=0
if [ -f "$INSTALL_CONFIG" ]; then INSTALL_CONFIG_EXISTED=1; fi
UPDATE_STATUS_DIR="\${PASEO_HOME:-$HOME/.paseo}/updates"
write_update_status() {
  mkdir -p "$UPDATE_STATUS_DIR" || return 1
  updated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  if [ "$1" = "idle" ]; then
    printf '{"phase":"idle","version":null,"message":null,"updatedAt":"%s","preparedBundlePath":null}\n' "$updated_at" > "$UPDATE_STATUS_DIR/status.json.tmp"
  else
    printf '{"phase":"failed","version":"%s","message":"Update failed and the previous release was restored.","updatedAt":"%s","preparedBundlePath":null}\n' "$VERSION" "$updated_at" > "$UPDATE_STATUS_DIR/status.json.tmp"
  fi
  mv "$UPDATE_STATUS_DIR/status.json.tmp" "$UPDATE_STATUS_DIR/status.json"
}
PREVIOUS_RELEASE=""
if [ -L "$CURRENT_LINK" ]; then PREVIOUS_RELEASE=$(readlink "$CURRENT_LINK"); fi
if [ "$PREVIOUS_RELEASE" = "$RELEASE_DIR" ]; then
  echo "Paseo $VERSION is already the active portable release." >&2
  exit 1
fi
PREFLIGHT_ROOT=""
preflight_cleanup() {
  exit_code=$?
  trap - EXIT INT TERM
  [ -z "$PREFLIGHT_ROOT" ] || rm -rf "$PREFLIGHT_ROOT"
  if [ "$exit_code" -ne 0 ]; then write_update_status failed || true; fi
  exit "$exit_code"
}

EXISTING_PASEO=$(command -v paseo 2>/dev/null || true)
if [ -z "$EXISTING_PASEO" ]; then
  for candidate in "$HOME/.local/bin/paseo" "$PREFIX/current/bin/paseo" /usr/local/bin/paseo; do
    if [ -x "$candidate" ]; then EXISTING_PASEO="$candidate"; break; fi
  done
fi
if [ "$START" -eq 1 ] && [ -n "$EXISTING_PASEO" ]; then
  PREFLIGHT_ROOT=$(mktemp -d "\${TMPDIR:-/tmp}/paseo-downstream-preflight.XXXXXX")
  trap 'preflight_cleanup' EXIT
  trap 'exit 130' INT TERM
  if ! PASEO_HOST= "$EXISTING_PASEO" daemon status --json > "$PREFLIGHT_ROOT/status.json"; then
    echo "Refusing to replace the existing Paseo installation because daemon status could not be read." >&2
    exit 1
  fi
  if grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"(running|unresponsive)"' "$PREFLIGHT_ROOT/status.json"; then
    if ! PASEO_HOST= "$EXISTING_PASEO" ls --global --json > "$PREFLIGHT_ROOT/agents.json"; then
      echo "Refusing to stop the existing daemon because agent state could not be read." >&2
      exit 1
    fi
    if grep -Eq '"status"[[:space:]]*:[[:space:]]*"(running|starting|initializing)"' "$PREFLIGHT_ROOT/agents.json"; then
      echo "Refusing to replace Paseo while an agent is running or starting." >&2
      exit 1
    fi
    if ! PASEO_HOST= "$EXISTING_PASEO" workspace ls --json > "$PREFLIGHT_ROOT/workspaces.json"; then
      echo "Refusing to stop the existing daemon because workspace state could not be read." >&2
      exit 1
    fi
    awk -F '"' '/"workspaceId"[[:space:]]*:/ { print $4 }' "$PREFLIGHT_ROOT/workspaces.json" |
      while IFS= read -r workspace_id; do
        [ -n "$workspace_id" ] || continue
        scripts_file="$PREFLIGHT_ROOT/scripts-$workspace_id.json"
        if ! PASEO_HOST= "$EXISTING_PASEO" script ls --workspace "$workspace_id" --json > "$scripts_file"; then
          echo "Refusing to stop the existing daemon because scripts for workspace $workspace_id could not be read." >&2
          exit 1
        fi
        if grep -Eq '"lifecycle"[[:space:]]*:[[:space:]]*"(running|starting)"' "$scripts_file"; then
          echo "Refusing to replace Paseo while workspace $workspace_id has a running script." >&2
          exit 1
        fi
      done
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    PASEO_HOST= "$EXISTING_PASEO" daemon stop --json >/dev/null 2>&1 || true
    STOPPED=0
    for _attempt in $(seq 1 15); do
      if PASEO_HOST= "$EXISTING_PASEO" daemon status --json > "$PREFLIGHT_ROOT/stopped.json" 2>/dev/null &&
         grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"stopped"' "$PREFLIGHT_ROOT/stopped.json"; then
        STOPPED=1; break
      fi
      sleep 1
    done
    if [ "$STOPPED" -ne 1 ]; then
      echo "Existing Paseo daemon did not report a stopped readback; installation aborted." >&2
      exit 1
    fi
  fi
  rm -rf "$PREFLIGHT_ROOT"
  PREFLIGHT_ROOT=""
  trap - EXIT INT TERM
fi

STAGING=""
ROLLBACK_ARMED=0
rollback_install() {
  exit_code=$?
  trap - EXIT INT TERM
  [ -z "$STAGING" ] || rm -rf "$STAGING"
  if [ "$ROLLBACK_ARMED" -eq 1 ] && [ "$exit_code" -ne 0 ]; then
    echo "Update failed; restoring the previous Paseo release." >&2
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if [ -n "$PREVIOUS_RELEASE" ]; then
      ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
      if [ "$START" -eq 1 ]; then systemctl --user start "$SERVICE_NAME" >/dev/null 2>&1 || true; fi
    else
      rm -f "$CURRENT_LINK"
    fi
    if [ "$UNIT_EXISTED" -eq 0 ]; then
      rm -f "$UNIT"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if [ "$INSTALL_CONFIG_EXISTED" -eq 0 ]; then rm -f "$INSTALL_CONFIG"; fi
    rm -rf "$RELEASE_DIR"
  fi
  if [ "$exit_code" -ne 0 ]; then write_update_status failed || true; fi
  exit "$exit_code"
}
trap 'rollback_install' EXIT
trap 'exit 130' INT TERM

mkdir -p "$RELEASES_DIR" "$BIN_DIR" "$SERVICE_DIR"
STAGING="$RELEASES_DIR/.install-$VERSION-$$"
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$SOURCE_ROOT/." "$STAGING/"
rm -rf "$RELEASE_DIR"
mv "$STAGING" "$RELEASE_DIR"
STAGING=""
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
ROLLBACK_ARMED=1
ln -sfn "$CURRENT_LINK/bin/paseo" "$BIN_DIR/paseo"
ln -sfn "$CURRENT_LINK/bin/paseo-foundation" "$BIN_DIR/paseo-foundation"

if [ ! -f "$UNIT" ]; then
cat > "$UNIT" <<UNIT
[Unit]
Description=Paseo Foundation Downstream WebUI and CLI
After=network.target

[Service]
Type=simple
ExecStart="$CURRENT_LINK/runtime/bin/node" "$CURRENT_LINK/app/node_modules/@getpaseo/cli/dist/index.js" daemon start --foreground --listen "$LISTEN" --web-ui --no-relay
Restart=on-failure
RestartSec=3
Environment="HOME=$HOME"
Environment="PATH=$BIN_DIR:/usr/local/bin:/usr/bin:/bin"
Environment=PASEO_DICTATION_ENABLED=0
Environment=PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=0
Environment=PASEO_VOICE_MODE_ENABLED=0

[Install]
WantedBy=default.target
UNIT
fi

if [ "$START" -eq 1 ]; then
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  READY=0
  for _attempt in $(seq 1 30); do
    if PASEO_HOST= "$CURRENT_LINK/bin/paseo" daemon status --json > "$PREFIX/daemon-readback.json" 2>/dev/null &&
       grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"running"' "$PREFIX/daemon-readback.json" &&
       grep -Eq '"connectedDaemon"[[:space:]]*:[[:space:]]*"reachable"' "$PREFIX/daemon-readback.json"; then
      READY=1; break
    fi
    sleep 1
  done
  if [ "$READY" -ne 1 ]; then
    echo "Installed the release, but the downstream daemon failed authoritative startup readback." >&2
    echo "Inspect: journalctl --user -u $SERVICE_NAME" >&2
    exit 1
  fi
  READBACK_LISTEN=$("$CURRENT_LINK/runtime/bin/node" -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof value.listen!=="string")process.exit(1);process.stdout.write(value.listen)' "$PREFIX/daemon-readback.json")
  rm -f "$PREFIX/daemon-readback.json"
  HEALTHY=0
  for _attempt in $(seq 1 30); do
    if PASEO_UPDATE_BASE_URL="http://$READBACK_LISTEN" "$CURRENT_LINK/runtime/bin/node" -e 'const base=process.env.PASEO_UPDATE_BASE_URL;Promise.all([fetch(base+"/api/health"),fetch(base+"/"),fetch("http://127.0.0.1:6769/health/ready")]).then((responses)=>{if(responses.some((response)=>!response.ok))process.exit(1)}).catch(()=>process.exit(1))'; then
      HEALTHY=1
      break
    fi
    sleep 1
  done
  if [ "$HEALTHY" -ne 1 ]; then
    echo "Installed release failed health, WebUI, or Beads Central readback." >&2
    exit 1
  fi
fi

cp "$RELEASE_DIR/uninstall.sh" "$PREFIX/uninstall.sh"
chmod 755 "$PREFIX/uninstall.sh"
if [ "$INSTALL_CONFIG_EXISTED" -eq 0 ]; then
  PASEO_INSTALL_CONFIG="$INSTALL_CONFIG" PASEO_INSTALL_PREFIX_VALUE="$PREFIX" PASEO_INSTALL_BIN_VALUE="$BIN_DIR" "$CURRENT_LINK/runtime/bin/node" -e 'const fs=require("fs");const value={schemaVersion:1,prefix:process.env.PASEO_INSTALL_PREFIX_VALUE,binDir:process.env.PASEO_INSTALL_BIN_VALUE};fs.writeFileSync(process.env.PASEO_INSTALL_CONFIG+".tmp",JSON.stringify(value,null,2)+"\\n");fs.renameSync(process.env.PASEO_INSTALL_CONFIG+".tmp",process.env.PASEO_INSTALL_CONFIG)'
fi

if [ "$INSTALL_FOUNDATION" -eq 1 ]; then
  PLAN="$PREFIX/foundation-install-plan.json"
  MODE="clean-empty"
  if "$CURRENT_LINK/bin/paseo-foundation" inspect --json 2>/dev/null | grep -q '"status": "active"'; then MODE="update"; fi
  "$CURRENT_LINK/bin/paseo-foundation" plan --mode "$MODE" --output "$PLAN"
  "$CURRENT_LINK/bin/paseo-foundation" install --plan "$PLAN"
fi

ROLLBACK_ARMED=0
write_update_status idle || true
printf 'Installed Paseo WebUI + CLI %s at %s\n' "$VERSION" "$RELEASE_DIR"
printf 'CLI: %s\nWebUI: http://%s\n' "$BIN_DIR/paseo" "$LISTEN"
`;
}

function linuxUninstallerScript() {
  return `#!/bin/sh
set -eu
PREFIX="\${PASEO_INSTALL_PREFIX:-\${XDG_DATA_HOME:-$HOME/.local/share}/paseo-web-cli}"
BIN_DIR="\${PASEO_INSTALL_BIN_DIR:-$HOME/.local/bin}"
SERVICE_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="paseo-web-cli.service"
PURGE_FOUNDATION=0
case "\${1:-}" in
  "") ;;
  --purge-foundation) PURGE_FOUNDATION=1 ;;
  -h|--help) echo 'Usage: uninstall.sh [--purge-foundation]'; exit 0 ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
rm -f "$SERVICE_DIR/$SERVICE_NAME"
systemctl --user daemon-reload >/dev/null 2>&1 || true
if [ "$PURGE_FOUNDATION" -eq 1 ] && [ -x "$PREFIX/current/bin/paseo-foundation" ]; then
  "$PREFIX/current/bin/paseo-foundation" uninstall
fi
for name in paseo paseo-foundation; do
  target="$BIN_DIR/$name"
  if [ -L "$target" ]; then
    resolved=$(readlink "$target")
    case "$resolved" in "$PREFIX"/*) rm -f "$target" ;; esac
  fi
done
rm -rf "$PREFIX/releases" "$PREFIX/current" "$PREFIX/foundation-install-plan.json"
rm -f "$PREFIX/install-config.json"
rm -f "$PREFIX/uninstall.sh"
printf 'Removed Paseo WebUI + CLI. Preserved ~/.paseo and user workspaces.\n'
`;
}

function uninstallerScript() {
  return `#!/bin/sh
set -eu

PREFIX="\${PASEO_INSTALL_PREFIX:-$HOME/.local/share/paseo-web-cli}"
BIN_DIR="\${PASEO_INSTALL_BIN_DIR:-$HOME/.local/bin}"
LABEL="\${PASEO_LAUNCHD_LABEL:-com.paseo.web-cli}"
PURGE_FOUNDATION=0

usage() {
  cat <<'USAGE'
Usage: uninstall.sh [--purge-foundation]

Removes the Paseo WebUI + CLI release and launchd service. User data in ~/.paseo
is always preserved. The bundled Foundation installation is preserved unless
--purge-foundation is explicitly supplied.
USAGE
}

case "\${1:-}" in
  "") ;;
  --purge-foundation) PURGE_FOUNDATION=1 ;;
  -h|--help) usage; exit 0 ;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

case "$PREFIX:$BIN_DIR" in
  /*:/*) ;;
  *) echo "PASEO_INSTALL_PREFIX and PASEO_INSTALL_BIN_DIR must be absolute paths" >&2; exit 2 ;;
esac
if [ "$PREFIX" = "/" ] || [ "$BIN_DIR" = "/" ]; then
  echo "Refusing to uninstall from /" >&2
  exit 2
fi
case "$LABEL" in
  *[!A-Za-z0-9._-]*|"") echo "Invalid launchd label: $LABEL" >&2; exit 2 ;;
esac

USER_ID=$(id -u)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$USER_ID/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

if [ "$PURGE_FOUNDATION" -eq 1 ] && [ -x "$PREFIX/current/bin/paseo-foundation" ]; then
  "$PREFIX/current/bin/paseo-foundation" uninstall
fi

for name in paseo paseo-foundation; do
  target="$BIN_DIR/$name"
  if [ -L "$target" ]; then
    resolved=$(readlink "$target")
    case "$resolved" in
      "$PREFIX"/*) rm -f "$target" ;;
    esac
  fi
done

rm -rf "$PREFIX/releases" "$PREFIX/current" "$PREFIX/foundation-install-plan.json"
rm -f "$PREFIX/install-config.json"
rm -f "$PREFIX/uninstall.sh"
printf 'Removed Paseo WebUI + CLI. Preserved ~/.paseo and user workspaces.\\n'
`;
}

export function windowsInstallerScript() {
  return `#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Prefix = $(if ($env:PASEO_INSTALL_PREFIX) { $env:PASEO_INSTALL_PREFIX } else { Join-Path $env:LOCALAPPDATA "PaseoWebCli" }),
  [string]$BinDir = $(if ($env:PASEO_INSTALL_BIN_DIR) { $env:PASEO_INSTALL_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Paseo\\bin" }),
  [string]$Listen = "127.0.0.1:6767",
  [string]$TaskName = "Paseo WebUI CLI",
  [switch]$NoStart,
  [switch]$SkipFoundation,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($Help) {
  Write-Output "Usage: .\\install.ps1 [-Prefix PATH] [-BinDir PATH] [-Listen HOST:PORT] [-NoStart] [-SkipFoundation]"
  exit 0
}
if (-not [IO.Path]::IsPathRooted($Prefix) -or -not [IO.Path]::IsPathRooted($BinDir)) {
  throw "Prefix and BinDir must be absolute paths"
}

$Version = ${shellQuote(VERSION).replaceAll("'", '"')}
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReleasesDir = Join-Path $Prefix "releases"
$ReleaseDir = Join-Path $ReleasesDir $Version
$Current = Join-Path $Prefix "current"
$PreviousRelease = $null
if (Test-Path $Current) {
  $CurrentItem = Get-Item -Force $Current
  if (-not ($CurrentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing to replace a non-junction current path: $Current"
  }
  $PreviousRelease = [string]@($CurrentItem.Target)[0]
  if ([IO.Path]::GetFullPath($PreviousRelease) -eq [IO.Path]::GetFullPath($ReleaseDir)) {
    throw "Paseo $Version is already the active portable release."
  }
}
$RunDaemon = Join-Path $Prefix "run-daemon.ps1"
$RunDaemonExisted = Test-Path $RunDaemon
$InstallConfig = Join-Path $Prefix "install-config.json"
$InstallConfigExisted = Test-Path $InstallConfig
$UpdateHome = if ($env:PASEO_HOME) { $env:PASEO_HOME } else { Join-Path $env:USERPROFILE ".paseo" }
$UpdateStatusDir = Join-Path $UpdateHome "updates"
function Write-UpdateStatus([string]$Phase) {
  New-Item -ItemType Directory -Force -Path $UpdateStatusDir | Out-Null
  $Status = if ($Phase -eq "idle") {
    @{ phase = "idle"; version = $null; message = $null; updatedAt = [DateTime]::UtcNow.ToString("o"); preparedBundlePath = $null }
  } else {
    @{ phase = "failed"; version = $Version; message = "Update failed and the previous release was restored."; updatedAt = [DateTime]::UtcNow.ToString("o"); preparedBundlePath = $null }
  }
  $StatusPath = Join-Path $UpdateStatusDir "status.json"
  $StatusTemp = "$StatusPath.tmp"
  $Utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($StatusTemp, (($Status | ConvertTo-Json -Compress) + "\`n"), $Utf8)
  Move-Item -Force $StatusTemp $StatusPath
}
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$TaskExisted = $null -ne $ExistingTask
$PaseoCmd = Join-Path $BinDir "paseo.cmd"
$FoundationCmd = Join-Path $BinDir "paseo-foundation.cmd"
$PaseoCmdExisted = Test-Path $PaseoCmd
$FoundationCmdExisted = Test-Path $FoundationCmd
$Staging = Join-Path $ReleasesDir ".install-$Version-$PID"
$Switched = $false
try {
$ExistingPaseo = Get-Command paseo -ErrorAction SilentlyContinue
if (-not $NoStart -and $ExistingPaseo) {
  $status = & $ExistingPaseo.Source daemon status --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Refusing replacement because daemon status could not be read." }
  if ($status.localDaemon -in @("running", "unresponsive")) {
    $agents = @(& $ExistingPaseo.Source ls --global --json | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw "Refusing replacement because agent state could not be read." }
    if ($agents | Where-Object { $_.status -in @("running", "starting", "initializing") }) {
      throw "Refusing to replace Paseo while an agent is running or starting."
    }
    $workspaces = @(& $ExistingPaseo.Source workspace ls --json | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw "Refusing replacement because workspace state could not be read." }
    foreach ($workspace in $workspaces) {
      $scripts = @(& $ExistingPaseo.Source script ls --workspace $workspace.workspaceId --json | ConvertFrom-Json)
      if ($LASTEXITCODE -ne 0) { throw "Refusing replacement because workspace script state could not be read." }
      if ($scripts | Where-Object { $_.lifecycle -in @("running", "starting") }) {
        throw "Refusing to replace Paseo while workspace $($workspace.workspaceId) has a running script."
      }
    }
    if ($TaskExisted) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    & $ExistingPaseo.Source daemon stop --json | Out-Null
    $Stopped = $false
    foreach ($attempt in 1..15) {
      try {
        $stoppedReadback = & $ExistingPaseo.Source daemon status --json | ConvertFrom-Json
        if ($stoppedReadback.localDaemon -eq "stopped") { $Stopped = $true; break }
      } catch {}
      Start-Sleep -Seconds 1
    }
    if (-not $Stopped) { throw "Existing Paseo daemon did not report a stopped readback; installation aborted." }
  }
}

New-Item -ItemType Directory -Force -Path $ReleasesDir, $BinDir | Out-Null
Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Staging | Out-Null
Copy-Item -Recurse -Force (Join-Path $SourceRoot "*") $Staging
Remove-Item -Recurse -Force $ReleaseDir -ErrorAction SilentlyContinue
Move-Item $Staging $ReleaseDir
if (Test-Path $Current) {
  [IO.Directory]::Delete($Current)
}
New-Item -ItemType Junction -Path $Current -Target $ReleaseDir | Out-Null
$Switched = $true

$PaseoEntry = Join-Path $Current "app\\node_modules\\@getpaseo\\cli\\dist\\index.js"
$FoundationEntry = Join-Path $Current "app\\node_modules\\@getpaseo\\foundation-cli\\dist\\index.js"
$Node = Join-Path $Current "runtime\\node.exe"
Set-Content -Encoding Ascii -Path $PaseoCmd -Value "@echo off\`r\`n\`"$Node\`" \`"$PaseoEntry\`" %*"
Set-Content -Encoding Ascii -Path $FoundationCmd -Value "@echo off\`r\`n\`"$Node\`" \`"$FoundationEntry\`" %*"

$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
$PathParts = @($CurrentPath -split ";" | Where-Object { $_ })
if ($BinDir -notin $PathParts) {
  [Environment]::SetEnvironmentVariable("Path", (($PathParts + $BinDir) -join ";"), "User")
}
$env:Path = "$BinDir;$env:Path"

$LogDir = Join-Path $env:LOCALAPPDATA "Paseo\\Logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$DaemonLog = Join-Path $LogDir "daemon.log"
if (-not $RunDaemonExisted) {
  $DaemonScript = @(
    '$env:PASEO_DICTATION_ENABLED = "0"'
    '$env:PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD = "0"'
    '$env:PASEO_VOICE_MODE_ENABLED = "0"'
    "& \`"$Node\`" \`"$PaseoEntry\`" daemon start --foreground --listen \`"$Listen\`" --web-ui --no-relay *>> \`"$DaemonLog\`""
    'exit $LASTEXITCODE'
  )
  Set-Content -Encoding UTF8 -Path $RunDaemon -Value $DaemonScript
}

if (-not $NoStart) {
  if (-not $TaskExisted) {
    $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File \`"$RunDaemon\`""
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
    $Settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Paseo Foundation Downstream WebUI and CLI" | Out-Null
  }
  Start-ScheduledTask -TaskName $TaskName
  $Ready = $false
  foreach ($attempt in 1..30) {
    Start-Sleep -Seconds 1
    try {
      $readback = & $PaseoCmd daemon status --json | ConvertFrom-Json
      if ($readback.localDaemon -eq "running" -and $readback.connectedDaemon -eq "reachable") { $Ready = $true; break }
    } catch {}
  }
  if (-not $Ready) { throw "Installed the release, but the downstream daemon failed authoritative startup readback. Inspect $DaemonLog." }
  $BaseUrl = "http://$($readback.listen)"
  $Healthy = $false
  foreach ($attempt in 1..30) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/health" | Out-Null
      Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/" | Out-Null
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:6769/health/ready" | Out-Null
      $Healthy = $true
      break
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $Healthy) { throw "Installed release failed health, WebUI, or Beads Central readback." }
}

Copy-Item -Force (Join-Path $ReleaseDir "uninstall.ps1") (Join-Path $Prefix "uninstall.ps1")
if (-not $InstallConfigExisted) {
  $InstallConfigValue = @{ schemaVersion = 1; prefix = $Prefix; binDir = $BinDir }
  $InstallConfigTemp = "$InstallConfig.tmp"
  $Utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($InstallConfigTemp, (($InstallConfigValue | ConvertTo-Json -Compress) + "\`n"), $Utf8)
  Move-Item -Force $InstallConfigTemp $InstallConfig
}

$Foundation = $FoundationCmd
if (-not $SkipFoundation) {
  $Mode = "clean-empty"
  try {
    $inspection = & $Foundation inspect --json | ConvertFrom-Json
    if ($inspection.status -eq "active") { $Mode = "update" }
  } catch {}
  $Plan = Join-Path $Prefix "foundation-install-plan.json"
  & $Foundation plan --mode $Mode --output $Plan
  if ($LASTEXITCODE -ne 0) { throw "Foundation planning failed." }
  & $Foundation install --plan $Plan
  if ($LASTEXITCODE -ne 0) { throw "Foundation installation failed." }
}

try { Write-UpdateStatus "idle" } catch {}
Write-Output "Installed Paseo WebUI + CLI $Version at $ReleaseDir"
Write-Output "CLI: $PaseoCmd"
Write-Output "WebUI: http://$Listen"
} catch {
  Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue
  try { Write-UpdateStatus "failed" } catch {}
  if ($Switched) {
    Write-Warning "Update failed; restoring the previous Paseo release."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (Test-Path $Current) { [IO.Directory]::Delete($Current) }
    if ($PreviousRelease) {
      New-Item -ItemType Junction -Path $Current -Target $PreviousRelease | Out-Null
      if (-not $NoStart -and $TaskExisted) { Start-ScheduledTask -TaskName $TaskName }
    }
    if (-not $TaskExisted) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    if (-not $RunDaemonExisted) { Remove-Item -Force $RunDaemon -ErrorAction SilentlyContinue }
    if (-not $InstallConfigExisted) { Remove-Item -Force $InstallConfig -ErrorAction SilentlyContinue }
    if (-not $PaseoCmdExisted) { Remove-Item -Force $PaseoCmd -ErrorAction SilentlyContinue }
    if (-not $FoundationCmdExisted) { Remove-Item -Force $FoundationCmd -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $ReleaseDir -ErrorAction SilentlyContinue
  }
  throw
}
`;
}

function windowsUninstallerScript() {
  return `#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Prefix = $(if ($env:PASEO_INSTALL_PREFIX) { $env:PASEO_INSTALL_PREFIX } else { Join-Path $env:LOCALAPPDATA "PaseoWebCli" }),
  [string]$BinDir = $(if ($env:PASEO_INSTALL_BIN_DIR) { $env:PASEO_INSTALL_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Paseo\\bin" }),
  [string]$TaskName = "Paseo WebUI CLI",
  [switch]$PurgeFoundation
)
$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$Foundation = Join-Path $BinDir "paseo-foundation.cmd"
if ($PurgeFoundation -and (Test-Path $Foundation)) { & $Foundation uninstall }
Remove-Item -Force (Join-Path $BinDir "paseo.cmd"), (Join-Path $BinDir "paseo-foundation.cmd") -ErrorAction SilentlyContinue
$Current = Join-Path $Prefix "current"
if (Test-Path $Current) { [IO.Directory]::Delete($Current) }
Remove-Item -Recurse -Force (Join-Path $Prefix "releases") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $Prefix "foundation-install-plan.json"), (Join-Path $Prefix "install-config.json"), (Join-Path $Prefix "run-daemon.ps1"), (Join-Path $Prefix "uninstall.ps1") -ErrorAction SilentlyContinue
Write-Output "Removed Paseo WebUI + CLI. Preserved ~/.paseo and user workspaces."
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function createInstallScripts() {
  if (PLATFORM === "win32") {
    writeFileSync(path.join(STAGING_ROOT, "install.ps1"), windowsInstallerScript());
    writeFileSync(path.join(STAGING_ROOT, "uninstall.ps1"), windowsUninstallerScript());
    return;
  }
  writeExecutable(
    path.join(STAGING_ROOT, "install.sh"),
    PLATFORM === "darwin" ? installerScript() : linuxInstallerScript(),
  );
  writeExecutable(
    path.join(STAGING_ROOT, "uninstall.sh"),
    PLATFORM === "darwin" ? uninstallerScript() : linuxUninstallerScript(),
  );
}

function walkFiles(root, relative = "") {
  const output = [];
  for (const entry of readdirSync(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(root, child));
    else if (entry.isFile()) output.push(child);
  }
  return output.sort();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function createManifest(nodeRoot) {
  const commit = run("git", ["rev-parse", "HEAD"], { capture: true });
  const gitDirty = Boolean(run("git", ["status", "--porcelain"], { capture: true }));
  const nodeVersion = run(nodeExecutable(nodeRoot), ["--version"], {
    capture: true,
  });
  const webUiRoot = path.join(STAGING_ROOT, "app/node_modules/@getpaseo/server/dist/server/web-ui");
  if (!statSync(webUiRoot).isDirectory())
    fail("Packaged server is missing the daemon WebUI bundle");
  const manifest = {
    schemaVersion: 1,
    product: "Paseo WebUI + CLI",
    version: VERSION,
    platform: PLATFORM,
    platformName: PLATFORM_NAME,
    arch: ARCH,
    gitCommit: commit,
    gitDirty,
    nodeVersion,
    electronIncluded: false,
    webUiIncluded: true,
    cliIncluded: true,
    foundationIncluded: true,
    beadsBackend: "central",
    beadsCentralClientIncluded: true,
    beadsCentralRequiredVersion: BEADS_CENTRAL_VERSION,
    beadsCentralSidecarIncluded: true,
    bundledBeadsBinary: true,
    internalPackages: Object.fromEntries(
      INTERNAL_PACKAGES.map((name) => [
        name,
        JSON.parse(
          readFileSync(
            path.join(STAGING_ROOT, "app/node_modules", ...name.split("/"), "package.json"),
          ),
        ).version,
      ]),
    ),
  };
  writeFileSync(path.join(STAGING_ROOT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = walkFiles(STAGING_ROOT)
    .filter((name) => name !== "SHA256SUMS")
    .map((name) => `${sha256(path.join(STAGING_ROOT, name))}  ${name}`)
    .join("\n");
  writeFileSync(path.join(STAGING_ROOT, "SHA256SUMS"), `${checksums}\n`);
}

function validateArtifactManifest(manifest) {
  if (
    manifest.version !== VERSION ||
    manifest.platform !== PLATFORM ||
    manifest.platformName !== PLATFORM_NAME ||
    manifest.arch !== ARCH ||
    manifest.electronIncluded !== false ||
    manifest.webUiIncluded !== true ||
    manifest.cliIncluded !== true ||
    manifest.beadsBackend !== "central" ||
    manifest.beadsCentralClientIncluded !== true ||
    manifest.beadsCentralRequiredVersion !== BEADS_CENTRAL_VERSION ||
    manifest.beadsCentralSidecarIncluded !== true ||
    manifest.bundledBeadsBinary !== true
  ) {
    fail("Artifact manifest validation failed");
  }
}

function validateStaging(nodeRoot) {
  const launcherSuffix = PLATFORM === "win32" ? ".cmd" : "";
  if (PLATFORM === "win32") {
    const stagedNode = path.join(STAGING_ROOT, "runtime", "node.exe");
    run(stagedNode, [
      path.join(STAGING_ROOT, "app/node_modules/@getpaseo/cli/dist/index.js"),
      "--version",
    ]);
    run(stagedNode, [
      path.join(STAGING_ROOT, "app/node_modules/@getpaseo/foundation-cli/dist/index.js"),
      "--version",
    ]);
  } else {
    run(path.join(STAGING_ROOT, "bin", `paseo${launcherSuffix}`), ["--version"]);
    run(path.join(STAGING_ROOT, "bin", `paseo-foundation${launcherSuffix}`), ["--version"]);
  }
  const manifest = JSON.parse(readFileSync(path.join(STAGING_ROOT, "manifest.json"), "utf8"));
  validateArtifactManifest(manifest);
  const stagedNode = path.join(
    STAGING_ROOT,
    "runtime",
    ...(PLATFORM === "win32" ? ["node.exe"] : ["bin", "node"]),
  );
  const bundledNodeVersion = run(stagedNode, ["--version"], { capture: true });
  const sourceNodeVersion = run(nodeExecutable(nodeRoot), ["--version"], {
    capture: true,
  });
  if (bundledNodeVersion !== sourceNodeVersion) fail("Bundled Node validation failed");
  const componentRoot = path.join(STAGING_ROOT, "components", "beads-central");
  const sidecarExecutable = path.join(
    componentRoot,
    PLATFORM === "win32" ? "beads-central.exe" : "beads-central",
  );
  const beadsExecutable = path.join(componentRoot, "bin", PLATFORM === "win32" ? "bd.exe" : "bd");
  if (!existsSync(sidecarExecutable) || !existsSync(beadsExecutable)) {
    fail("Artifact is missing the bundled Beads Central sidecar component");
  }
}

function emitArtifact() {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  rmSync(OUTPUT_ARCHIVE, { force: true });
  rmSync(OUTPUT_CHECKSUM, { force: true });
  mkdirSync(ARTIFACTS_ROOT, { recursive: true });
  cpSync(STAGING_ROOT, OUTPUT_DIR, { recursive: true });
  if (PLATFORM === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${OUTPUT_DIR.replaceAll(
        "'",
        "''",
      )}' -DestinationPath '${OUTPUT_ARCHIVE.replaceAll("'", "''")}' -Force`,
    ]);
  } else {
    run("tar", ["-czf", OUTPUT_ARCHIVE, "-C", ARTIFACTS_ROOT, BUNDLE_NAME], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
  }
  writeFileSync(OUTPUT_CHECKSUM, `${sha256(OUTPUT_ARCHIVE)}  ${path.basename(OUTPUT_ARCHIVE)}\n`);
  const sizeMiB = (statSync(OUTPUT_ARCHIVE).size / 1024 / 1024).toFixed(2);
  process.stdout.write(
    `\nArtifact: ${OUTPUT_ARCHIVE}\nSHA-256: ${sha256(OUTPUT_ARCHIVE)}\nSize: ${sizeMiB} MiB\n`,
  );
}

// Every step below mutates shared, unversioned output: packages/*/dist, packages/app/dist,
// packages/foundation-cli/assets and artifacts/.staging. Two artifact builds at once therefore
// clean directories the other is compiling against, and the loser fails somewhere unrelated to
// the real cause. mkdir is atomic, so it doubles as the lock.
const BUILD_LOCK_DIR = path.join(ARTIFACTS_ROOT, ".build-lock");

function acquireArtifactLock() {
  mkdirSync(ARTIFACTS_ROOT, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(BUILD_LOCK_DIR);
      writeFileSync(path.join(BUILD_LOCK_DIR, "pid"), String(process.pid), "utf8");
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number.parseInt(readFileSync(path.join(BUILD_LOCK_DIR, "pid"), "utf8"), 10);
      } catch {
        owner = Number.NaN;
      }
      if (Number.isInteger(owner) && isProcessAlive(owner)) {
        fail(
          `Another artifact build is running (pid ${owner}). Wait for it, or remove ${BUILD_LOCK_DIR} if that process is gone.`,
        );
      }
      rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
    }
  }
  fail(`Could not acquire ${BUILD_LOCK_DIR}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function main() {
  acquireArtifactLock();
  try {
    const nodeRoot = resolveBundledNodeRoot();
    assertReleaseInputs(nodeRoot);
    rmSync(STAGING_ROOT, { recursive: true, force: true });
    mkdirSync(STAGING_ROOT, { recursive: true });
    buildProduct();
    const tarballs = packInternalPackages();
    installProductionPayload(nodeRoot, tarballs);
    copyNodeRuntime(nodeRoot);
    buildBeadsCentralComponent();
    createLaunchers();
    createInstallScripts();
    createManifest(nodeRoot);
    validateStaging(nodeRoot);
    emitArtifact();
  } finally {
    rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
