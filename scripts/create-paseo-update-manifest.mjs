import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const REQUIRED_TARGETS = [
  ["macos-arm64", ".tar.gz"],
  ["macos-x64", ".tar.gz"],
  ["linux-x64", ".tar.gz"],
  ["windows-x64", ".zip"],
];

function parseArgs(argv) {
  const result = {
    target: null,
    artifacts: path.join(REPO_ROOT, "artifacts"),
    output: path.join(REPO_ROOT, "artifacts", "paseo-update-manifest.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target") {
      const target = argv[++index];
      if (!REQUIRED_TARGETS.some(([name]) => name === target)) {
        throw new Error(`Unsupported release target: ${target}`);
      }
      if (result.target) throw new Error("Specify --target only once");
      result.target = target;
    } else if (value === "--artifacts") result.artifacts = path.resolve(argv[++index]);
    else if (value === "--output") result.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

async function walk(root) {
  const entries = await fs.readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function parseChecksum(value, assetName) {
  const match = /^([0-9a-f]{64})(?:\s|$)/u.exec(value.trim());
  if (!match) throw new Error(`Invalid SHA-256 checksum for ${assetName}`);
  return match[1];
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const version = packageJson.version;
  const tag = `paseo-v${version}`;
  const files = await walk(options.artifacts);
  const assets = {};

  const targets = options.target
    ? REQUIRED_TARGETS.filter(([target]) => target === options.target)
    : REQUIRED_TARGETS;
  for (const [target, extension] of targets) {
    const name = `paseo-web-cli-${version}-${target}${extension}`;
    const archiveMatches = files.filter((file) => path.basename(file) === name);
    const checksumMatches = files.filter((file) => path.basename(file) === `${name}.sha256`);
    if (archiveMatches.length !== 1 || checksumMatches.length !== 1) {
      throw new Error(
        `Expected exactly one archive and checksum for ${target}; found ${archiveMatches.length}/${checksumMatches.length}`,
      );
    }
    const qualifiedSha = parseChecksum(await fs.readFile(checksumMatches[0], "utf8"), name);
    const actualSha = await sha256File(archiveMatches[0]);
    if (qualifiedSha !== actualSha) {
      throw new Error(`Archive SHA-256 does not match its checksum for ${name}`);
    }
    assets[target] = {
      name,
      sha256: qualifiedSha,
    };
  }

  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error(`Expected exact checked-out source commit, got ${sourceCommit}`);
  }
  const manifest = {
    schemaVersion: 1,
    version,
    tag,
    sourceCommit,
    qualifiedAt: new Date().toISOString(),
    minimumUpdaterVersion: "0.5.0-paseo.41",
    assets,
  };
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${options.output}\n`);
}

await main();
