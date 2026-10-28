import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SshConfigHost } from "../shared/contracts";
import { describeUnsafeValue } from "../shared/ssh-args";

export interface ParsedSshConfig {
  hosts: SshConfigHost[];
  includes: string[];
}

const MAX_INCLUDE_DEPTH = 5;

/** Splits on whitespace, keeps "quoted words" together, and drops a trailing `# comment`. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else if (!quoted && char === "#" && !started) {
      break;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

function isConcreteAlias(pattern: string): boolean {
  return !/[*?!]/.test(pattern) && describeUnsafeValue(pattern) === null;
}

/**
 * Reads `Host` blocks from ssh config text. Wildcard and negated patterns are skipped. As in ssh,
 * the first value of an option within a block wins. `Match` ends the current block, and `Include`
 * paths are returned unresolved for the caller.
 */
export function parseSshConfig(text: string): ParsedSshConfig {
  const hosts: SshConfigHost[] = [];
  const includes: string[] = [];
  let block: SshConfigHost[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const values = tokenize(match[2]);
    if (keyword === "host") {
      block = values.filter(isConcreteAlias).map((alias) => ({ alias }));
      hosts.push(...block);
    } else if (keyword === "match") {
      block = [];
    } else if (keyword === "include") {
      includes.push(...values);
    } else if (values[0] !== undefined) {
      applyOption(block, keyword, values[0]);
    }
  }
  return { hosts, includes };
}

function applyOption(block: SshConfigHost[], keyword: string, value: string): void {
  for (const host of block) {
    if (keyword === "hostname" && host.hostName === undefined) host.hostName = value;
    else if (keyword === "user" && host.user === undefined) host.user = value;
    else if (keyword === "identityfile" && host.identityFile === undefined) {
      host.identityFile = value;
    } else if (keyword === "port" && host.port === undefined && /^\d+$/.test(value)) {
      host.port = Number(value);
    }
  }
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  return value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value;
}

/** Expands `*` and `?` in the last path segment only. Other segments must be literal. */
async function expandIncludePath(pattern: string): Promise<string[]> {
  if (!/[*?]/.test(pattern)) return [pattern];
  const directory = path.dirname(pattern);
  const base = path.basename(pattern);
  const regex = new RegExp(
    `^${base
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  try {
    const names = (await readdir(directory)).filter((name) => regex.test(name)).sort();
    return names.map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function collectHosts(
  file: string,
  homeDir: string,
  visited: Set<string>,
  depth: number,
  hosts: SshConfigHost[],
): Promise<void> {
  if (visited.has(file) || depth > MAX_INCLUDE_DEPTH) return;
  visited.add(file);
  const text = await readIfPresent(file);
  if (text === null) return;
  const parsed = parseSshConfig(text);
  hosts.push(...parsed.hosts);
  for (const include of parsed.includes) {
    const resolved = path.resolve(path.join(homeDir, ".ssh"), expandHome(include, homeDir));
    for (const included of await expandIncludePath(resolved)) {
      await collectHosts(included, homeDir, visited, depth + 1, hosts);
    }
  }
}

export interface LoadedSshConfig {
  hosts: SshConfigHost[];
  configPath: string;
  error?: string;
}

/**
 * Loads concrete hosts from `~/.ssh/config`, following `Include`. Includes are treated as
 * unconditional even when written inside a `Host` or `Match` block, and a file's own hosts are
 * listed before the hosts it includes. A missing file is not an error.
 */
export async function loadSshConfigHosts(
  options: { homeDir?: string } = {},
): Promise<LoadedSshConfig> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = path.join(homeDir, ".ssh", "config");
  const found: SshConfigHost[] = [];
  try {
    await collectHosts(configPath, homeDir, new Set(), 0, found);
  } catch (error) {
    return { hosts: [], configPath, error: error instanceof Error ? error.message : String(error) };
  }
  const seen = new Set<string>();
  const hosts = found.filter((host) => !seen.has(host.alias) && seen.add(host.alias));
  return { hosts, configPath };
}
