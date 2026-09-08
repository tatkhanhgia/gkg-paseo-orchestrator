#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:6767";
const DEFAULT_BEADS_URL = "http://127.0.0.1:6769/health/ready";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const LOOPBACK_REDIRECT_POLICY = "error";

function usage() {
  return `Usage: node scripts/maestro-slp-live-canary.mjs [options]

Read back an installed Paseo daemon, WebUI, Beads health endpoint, and Foundation doctor.
Without --execute this prints a plan and performs no process, network, provider, or file action.
Even with --execute this script never spawns an agent or records a role canary. A doctor run without
--role-canary is preliminary diagnosis; obtain real provider/role execution evidence and validate
the receipt first, then rerun with --role-canary for the final doctor gate.

Options:
  --execute              Perform the read-only localhost/CLI checks
  --daemon-url <url>     Daemon base URL (default: http://127.0.0.1:6767)
  --beads-url <url>      Beads health URL (default: http://127.0.0.1:6769/health/ready)
  --project <path>       Project path passed to paseo-foundation doctor
  --role-canary <path>   Existing role-canary receipt passed to doctor
  --output, -o <path>    Write the readback JSON to a local file
  --help, -h             Show this help
`;
}

export function validateLoopbackHttpUrl(value, name = "URL") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty URL`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw new Error(`${name} is invalid: ${value}`, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${name} must target localhost, 127.0.0.1, or ::1`);
  }
  return parsed.toString().replace(/\/$/u, "");
}

export function parseLiveCanaryArgs(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      execute: { type: "boolean" },
      "daemon-url": { type: "string" },
      "beads-url": { type: "string" },
      project: { type: "string" },
      "role-canary": { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });
}

export function resolveLiveCanaryUrls(values) {
  return {
    daemonUrl: validateLoopbackHttpUrl(values["daemon-url"] ?? DEFAULT_DAEMON_URL, "daemon URL"),
    beadsUrl: validateLoopbackHttpUrl(values["beads-url"] ?? DEFAULT_BEADS_URL, "Beads URL"),
  };
}

function commandRead(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    try {
      return { status: "PASS", value: JSON.parse(stdout) };
    } catch {
      return { status: "UNKNOWN", error: "command returned non-JSON output" };
    }
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? error.stderr : error;
    return {
      status: "UNKNOWN",
      error: String(detail instanceof Error ? detail.message : detail).trim(),
    };
  }
}

async function httpRead(url) {
  try {
    const validatedUrl = validateLoopbackHttpUrl(url, "read URL");
    const response = await fetch(validatedUrl, {
      redirect: LOOPBACK_REDIRECT_POLICY,
      signal: AbortSignal.timeout(5_000),
    });
    return {
      status: response.ok ? "PASS" : "FAIL",
      httpStatus: response.status,
    };
  } catch (error) {
    return { status: "UNKNOWN", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseLiveCanaryArgs(argv);
  if (parsed.values.help) {
    process.stdout.write(usage());
    return;
  }

  const { daemonUrl, beadsUrl } = resolveLiveCanaryUrls(parsed.values);
  if (!parsed.values.execute) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "paseo-maestro-slp-live-canary-plan",
          executeRequired: true,
          effects: { agentSpawn: false, daemonMutation: false, remoteMutation: false },
          checks: [
            `${process.env.PASEO_BIN ?? "paseo"} daemon status --json`,
            `GET ${daemonUrl}/api/health`,
            `GET ${daemonUrl}/`,
            `GET ${beadsUrl}`,
            `${process.env.PASEO_FOUNDATION_BIN ?? "paseo-foundation"} doctor --json`,
          ],
          pending: [
            "Run preliminary Foundation doctor to diagnose prerequisites; it is not acceptance.",
            "Renew exact provider-route receipt and run the required Lead/Peer/Supervisor canaries with bounded IDs and cleanup.",
            "Validate/install the real role-canary receipt, then run paseo-foundation doctor --role-canary <receipt> --project <path>.",
          ],
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const paseo = process.env.PASEO_BIN ?? "paseo";
  const foundation = process.env.PASEO_FOUNDATION_BIN ?? "paseo-foundation";
  const doctorArgs = ["doctor", "--json"];
  if (parsed.values.project) doctorArgs.push("--project", resolve(parsed.values.project));
  if (parsed.values["role-canary"])
    doctorArgs.push("--role-canary", resolve(parsed.values["role-canary"]));
  const [health, webui, beads] = await Promise.all([
    httpRead(`${daemonUrl}/api/health`),
    httpRead(`${daemonUrl}/`),
    httpRead(beadsUrl),
  ]);
  const result = {
    schemaVersion: 1,
    kind: "paseo-maestro-slp-live-canary-readback",
    executedAt: new Date().toISOString(),
    effects: { agentSpawn: false, daemonMutation: false, remoteMutation: false },
    daemonStatus: commandRead(paseo, ["daemon", "status", "--json"]),
    health,
    webui,
    beads,
    foundationDoctor: commandRead(foundation, doctorArgs),
    providerCanaries: "not run by this readback-only script",
    engineeringAcceptance: "Lead review required",
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (parsed.values.output) writeFileSync(resolve(parsed.values.output), serialized, "utf8");
  process.stdout.write(serialized);
  const checks = [
    result.daemonStatus,
    result.health,
    result.webui,
    result.beads,
    result.foundationDoctor,
  ];
  if (checks.some((check) => check.status !== "PASS")) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
