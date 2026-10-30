#!/usr/bin/env node
// Launcher migration shared by the macOS, Linux, and Windows portable installers. It ships in the
// artifact next to install.sh/install.ps1 and runs on the bundled Node.
//
// Releases before the 0.13 daemon CLI wrote launchers that run
// `daemon start --foreground --listen X --web-ui --relay`. The current CLI rejects those flags
// (REMOVED_LAUNCH_FLAGS in packages/cli/src/commands/daemon/local-daemon.ts): foreground
// deployment is `daemon run --home <path>` and every other flag became a persisted config key.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export class LauncherError extends Error {}

const BOOLEAN_FLAGS = {
  "--relay": { key: "daemon.relay.enabled", value: true },
  "--no-relay": { key: "daemon.relay.enabled", value: false },
  "--relay-use-tls": { key: "daemon.relay.useTls", value: true },
  "--no-mcp": { key: "daemon.mcp.enabled", value: false },
  "--no-inject-mcp": { key: "daemon.mcp.injectIntoAgents", value: false },
  "--web-ui": { key: "features.webUi.enabled", value: true },
  "--no-web-ui": { key: "features.webUi.enabled", value: false },
  "--foreground": null,
};
const VALUE_FLAGS = new Set(["--listen", "--port", "--hostnames", "--allowed-hosts", "--home"]);

function parseHostnames(raw) {
  if (raw === "true") return true;
  return raw
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function parseLauncherFlags(tokens) {
  const parsed = { config: new Map(), sawRemovedFlag: false };
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (VALUE_FLAGS.has(flag)) {
      const value = equals === -1 ? tokens[(index += 1)] : token.slice(equals + 1);
      if (value === undefined || value === "") {
        throw new LauncherError(`Launcher flag ${flag} has no value.`);
      }
      if (flag === "--home") parsed.home = value;
      else parsed.sawRemovedFlag = true;
      if (flag === "--listen") parsed.listen = value;
      else if (flag === "--port") parsed.port = value;
      else if (flag === "--hostnames" || flag === "--allowed-hosts") {
        parsed.config.set("daemon.hostnames", parseHostnames(value));
      }
    } else if (equals === -1 && Object.hasOwn(BOOLEAN_FLAGS, flag)) {
      parsed.sawRemovedFlag = true;
      const mapped = BOOLEAN_FLAGS[flag];
      if (mapped) parsed.config.set(mapped.key, mapped.value);
    } else {
      throw new LauncherError(
        `Cannot migrate launcher argument ${JSON.stringify(token)}; edit the launcher by hand.`,
      );
    }
  }
  return parsed;
}

/**
 * Plan the migration of one launcher's daemon arguments (the tokens from `daemon` onward).
 * Returns null when the launcher needs no change: already `daemon run`, or a `daemon start`
 * that carries no removed flag.
 */
export function planLaunchMigration(tokens, { home }) {
  if (tokens[0] !== "daemon") {
    throw new LauncherError(`Unrecognized launcher arguments: ${JSON.stringify(tokens)}`);
  }
  if (tokens[1] !== "start") return null;
  const { config, listen, port, home: launcherHome, sawRemovedFlag } = parseLauncherFlags(tokens);
  if (!sawRemovedFlag) return null;
  if (listen !== undefined && port !== undefined) {
    throw new LauncherError("Cannot use --listen and --port together.");
  }
  const effectiveListen = listen ?? (port === undefined ? undefined : `127.0.0.1:${port}`);
  const entries =
    effectiveListen === undefined ? [] : [{ key: "daemon.listen", value: effectiveListen }];
  for (const [key, value] of config) entries.push({ key, value });
  const effectiveHome = launcherHome ?? home;
  return { home: effectiveHome, args: ["daemon", "run", "--home", effectiveHome], config: entries };
}

/** Split a command line on unquoted whitespace, keeping each token's offsets in the source. */
export function tokenizeCommandLine(text, { escape }) {
  const tokens = [];
  let current = null;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (current === null) {
      if (/\s/u.test(char)) continue;
      current = { value: "", start: index, end: index };
    }
    if (quote === null && /\s/u.test(char)) {
      tokens.push(current);
      current = null;
    } else if (quote === null && (char === '"' || char === "'")) {
      quote = char;
    } else if (quote === char) {
      quote = null;
    } else if (quote === '"' && char === escape && index + 1 < text.length) {
      index += 1;
      current.value += text[index];
    } else {
      current.value += char;
    }
    if (current) current.end = index + 1;
  }
  if (quote !== null) throw new LauncherError(`Unterminated quote in launcher: ${text}`);
  if (current) tokens.push(current);
  return tokens;
}

function quoteSystemd(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function quotePowerShell(value) {
  return `"${value.replaceAll("`", "``").replaceAll('"', '`"').replaceAll("$", "`$")}"`;
}

function renderArgs(args, quote) {
  // The home path is the only value that can carry spaces or shell metacharacters.
  return args.map((arg, index) => (args[index - 1] === "--home" ? quote(arg) : arg)).join(" ");
}

function locateDaemonToken(tokens) {
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index].value === "daemon" && ["start", "run"].includes(tokens[index + 1].value)) {
      return index;
    }
  }
  return -1;
}

function rewriteSystemdUnit(text, home) {
  const match = /^ExecStart=(.*)$/mu.exec(text);
  if (!match) throw new LauncherError("The systemd unit has no ExecStart line.");
  const tokens = tokenizeCommandLine(match[1], { escape: "\\" });
  const at = locateDaemonToken(tokens);
  if (at === -1) throw new LauncherError(`Unrecognized ExecStart: ${match[0]}`);
  const plan = planLaunchMigration(
    tokens.slice(at).map((token) => token.value),
    { home },
  );
  if (!plan) return { plan, text };
  const line = `ExecStart=${match[1].slice(0, tokens[at].start)}${renderArgs(plan.args, quoteSystemd)}`;
  return { plan, text: text.replace(match[0], () => line) };
}

function rewritePowerShellScript(text, home) {
  for (const match of text.matchAll(/^[^\r\n]*$/gmu)) {
    const line = match[0];
    if (line.trimStart().startsWith("#")) continue;
    const tokens = tokenizeCommandLine(line, { escape: "`" });
    const at = locateDaemonToken(tokens);
    if (at === -1) continue;
    let end = tokens.findIndex(
      (token, index) => index > at && /^(\*|\d)?>/u.test(line.slice(token.start, token.end)),
    );
    if (end === -1) end = tokens.length;
    const plan = planLaunchMigration(
      tokens.slice(at, end).map((token) => token.value),
      { home },
    );
    if (!plan) return { plan, text };
    const suffix = end === tokens.length ? "" : ` ${line.slice(tokens[end].start)}`;
    const next = `${line.slice(0, tokens[at].start)}${renderArgs(plan.args, quotePowerShell)}${suffix}`;
    return { plan, text: text.replace(line, () => next) };
  }
  throw new LauncherError("The PowerShell launcher has no `daemon start|run` line.");
}

function runConfigCli({ node, cli, home }, args) {
  const result = spawnSync(node, [cli, "daemon", "config", ...args, "--home", home, "--json"], {
    encoding: "utf8",
    env: { ...process.env, PASEO_HOST: "" },
  });
  if (result.error) throw result.error;
  return result;
}

function readConfigKey(target, key) {
  const result = runConfigCli(target, ["get", key]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  if (result.status !== 0 || typeof parsed?.set !== "boolean") {
    throw new LauncherError(
      `Could not read config key ${key}: ${result.stdout}${result.stderr}`.trim(),
    );
  }
  return parsed;
}

/**
 * Write each entry to the persisted config through the bundled CLI, but only when the operator
 * has not already set that key. Presence is snapshotted for every key before the first write,
 * because the first `config set` on a home without config.json materializes the defaults and
 * would make later keys look configured.
 */
export function applyConfigIfAbsent(entries, target) {
  const snapshot = entries.map((entry) => ({
    ...entry,
    existing: readConfigKey(target, entry.key),
  }));
  const written = [];
  const kept = [];
  for (const { key, value, existing } of snapshot) {
    if (existing.set) {
      kept.push(key);
      continue;
    }
    const result = runConfigCli(target, ["set", key, JSON.stringify(value)]);
    // `config set` saves first and then asks a running daemon to reload; only the readback says
    // whether the value landed.
    const after = readConfigKey(target, key);
    if (!after.set || JSON.stringify(after.value) !== JSON.stringify(value)) {
      throw new LauncherError(
        `Could not write config key ${key}: ${result.stdout}${result.stderr}`.trim(),
      );
    }
    written.push(key);
  }
  return { written, kept };
}

function migratePlist(file, home, plutil) {
  const args = JSON.parse(
    execFileSync(plutil, ["-extract", "ProgramArguments", "json", "-o", "-", file], {
      encoding: "utf8",
    }),
  );
  const at = args.indexOf("daemon", 1);
  if (at === -1) throw new LauncherError(`Unrecognized ProgramArguments in ${file}.`);
  const plan = planLaunchMigration(args.slice(at), { home });
  const commit = () =>
    execFileSync(
      plutil,
      [
        "-replace",
        "ProgramArguments",
        "-json",
        JSON.stringify([...args.slice(0, at), ...plan.args]),
        file,
      ],
      { stdio: "pipe" },
    );
  return { plan, commit };
}

function migrateTextLauncher(kind, file, home) {
  const original = readFileSync(file, "utf8");
  const rewrite = kind === "systemd" ? rewriteSystemdUnit : rewritePowerShellScript;
  const { plan, text } = rewrite(original, home);
  return { plan, commit: () => writeFileSync(file, text) };
}

/**
 * Migrate one launcher file to `daemon run --home <home>`, persisting the flags it carried as
 * config keys that are still absent. The launcher is rewritten only after the config landed, so a
 * failure leaves the launcher untouched.
 */
export function migrateLauncher({ kind, file, home, node, cli, plutil = "/usr/bin/plutil" }) {
  if (!["plist", "systemd", "powershell"].includes(kind)) {
    throw new LauncherError(`Unknown launcher kind: ${kind}`);
  }
  const { plan, commit } =
    kind === "plist" ? migratePlist(file, home, plutil) : migrateTextLauncher(kind, file, home);
  if (!plan) return { status: "current", written: [], kept: [] };
  const applied = applyConfigIfAbsent(plan.config, { node, cli, home: plan.home });
  commit();
  return { status: "migrated", ...applied };
}

/** Persist the defaults a fresh install used to pass as launch flags, where still absent. */
export function seedConfig({ home, node, cli, listen }) {
  const entries = [
    { key: "daemon.listen", value: listen },
    { key: "features.webUi.enabled", value: true },
    { key: "daemon.relay.enabled", value: false },
  ];
  return { status: "seeded", ...applyConfigIfAbsent(entries, { node, cli, home }) };
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || argv[index + 1] === undefined) {
      throw new LauncherError(`Unexpected argument: ${flag}`);
    }
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

function main(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  for (const required of ["home", "node", "cli", command === "seed" ? "listen" : "file"]) {
    if (!options[required]) throw new LauncherError(`Missing --${required}`);
  }
  const run = { seed: seedConfig, migrate: migrateLauncher }[command];
  const result = run ? run(options) : null;
  if (!result) throw new LauncherError("Usage: installer-launcher.mjs <migrate|seed> [options]");
  const summary = [`launcher ${result.status}`];
  if (result.written.length) summary.push(`config written: ${result.written.join(", ")}`);
  if (result.kept.length) summary.push(`config kept: ${result.kept.join(", ")}`);
  process.stdout.write(`${summary.join("; ")}\n`);
}

// The installer reaches this file through the `current` symlink, and the module URL is the resolved
// path while argv[1] keeps the symlink, so compare real paths or main() silently never runs.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
