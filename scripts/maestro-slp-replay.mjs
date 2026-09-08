#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:6767";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function usage() {
  return `Usage: node scripts/maestro-slp-replay.mjs [options]

Build a bounded, read-only replay plan for the Maestro/SLP integration.
The default invocation prints a plan and performs no daemon, provider, or network action.

Options:
  --case <path>          JSON fixture containing caseId and an events array
  --source-commit <sha>  Expected clean release commit (recorded, not checked out)
  --daemon-url <url>     Expected daemon URL (default: http://127.0.0.1:6767)
  --output, -o <path>    Write the plan JSON to a local file as well as stdout
  --help, -h             Show this help
`;
}

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
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

function readFixture(filePath) {
  const absolutePath = resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read replay fixture ${absolutePath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("replay fixture must be a JSON object");
  }
  const caseId = nonEmpty(parsed.caseId, "fixture.caseId");
  if (!Array.isArray(parsed.events)) throw new Error("fixture.events must be an array");
  const events = parsed.events.map((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`fixture.events[${index}] must be an object`);
    }
    const type = nonEmpty(event.type, `fixture.events[${index}].type`);
    if (type !== "agent_stream" && type !== "agent_closure") {
      throw new Error(`fixture.events[${index}].type must be agent_stream or agent_closure`);
    }
    return Object.assign({}, event, {
      type,
      agentId: nonEmpty(event.agentId, `fixture.events[${index}].agentId`),
    });
  });
  return { path: absolutePath, caseId, events };
}

export function buildReplayPlan(options, candidateVersion = "unknown") {
  const fixture = options.case ? readFixture(options.case) : null;
  const parsedDaemonUrl = validateLoopbackHttpUrl(
    options["daemon-url"] ?? DEFAULT_DAEMON_URL,
    "daemon URL",
  );
  return {
    schemaVersion: 1,
    kind: "paseo-maestro-slp-replay-plan",
    candidateVersion,
    expectedSourceCommit: options["source-commit"] ?? null,
    daemonUrl: parsedDaemonUrl,
    fixture: fixture
      ? { path: fixture.path, caseId: fixture.caseId, events: fixture.events }
      : { path: null, caseId: "REQUIRED_CASE_ID", events: [] },
    effects: {
      providerExecution: false,
      agentSpawn: false,
      daemonMutation: false,
      network: false,
      remoteMutation: false,
    },
    invariants: [
      "Resolve the exact clean release commit and source fingerprint before replay.",
      "Resolve each event against its captured policy owner; never substitute active SLP for another owner.",
      "A closed snapshot keeps active turn fields null; closure evidence must carry the captured run receipt.",
      "Ordinary close/cancel without a captured started run produces no lost-run assertion.",
      "UNKNOWN remains UNKNOWN when Council, Beads, assignment, or lifecycle evidence is unavailable.",
    ],
    operatorSteps: [
      "Obtain a fresh idle readback before any later activation or provider canary.",
      "Run this plan against the already-installed candidate using a separate, explicitly approved harness.",
      "Record provider execution/read/acceptance separately from dispatch and replay receipts.",
      "Attach the resulting receipt to the handoff and run paseo-foundation doctor with the renewed role canary.",
    ],
  };
}

export function parseReplayArgs(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      case: { type: "string" },
      "source-commit": { type: "string" },
      "daemon-url": { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function readPackageVersion() {
  const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  return JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")).version;
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseReplayArgs(argv);
  if (parsed.values.help) {
    process.stdout.write(usage());
    return;
  }
  const plan = buildReplayPlan(parsed.values, readPackageVersion());
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  if (parsed.values.output) writeFileSync(resolve(parsed.values.output), serialized, "utf8");
  process.stdout.write(serialized);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
