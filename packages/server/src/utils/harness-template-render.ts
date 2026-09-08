import { lstatSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

/**
 * Renders a Foundation-authored harness template (`entrypoint-block.md`,
 * etc.) against the actual path of the entrypoint file the rendered content
 * will be written to. Foundation owns the prose and the token names (via the
 * descriptor's `entrypointPlaceholders` map); Product owns resolving every
 * path token relative to where that prose actually lands, because the same
 * template can materialize at repo root (`AGENTS.md`/`CLAUDE.md`) or nested,
 * and a source-relative literal path in the template would be correct in
 * neither case reliably.
 *
 * Tokens are `{{HARNESS:TOKEN_NAME}}`. Every token in a template must
 * resolve to a supplied, actually-reachable target path; an unknown token
 * name, a known token with no supplied target, or a target that does not
 * exist on disk all fail the render rather than emit a broken or invented
 * link. `outputFilePath` is used exactly as given (not realpath-resolved),
 * so relative paths are computed from the actual entrypoint file identity
 * (preserving symlink direction) rather than its resolved target.
 */

export const HARNESS_TEMPLATE_TOKEN_NAMES = [
  "HARNESS:ENTRY_MAP_PATH",
  "HARNESS:WORKSPACE_PROTOCOL_PATH",
] as const;
export type HarnessTemplateTokenName = (typeof HARNESS_TEMPLATE_TOKEN_NAMES)[number];

export interface HarnessTemplateRenderTargets {
  /** Path (as addressed by the caller, e.g. `AGENTS.md` or a symlink to it) that the rendered content will be written to. */
  outputFilePath: string;
  /** Absolute path to the project harness entry map (descriptor resource `entryMap`). */
  entryMapPath?: string;
  /** Absolute path to `WORKSPACE_PROTOCOL.md`. */
  workspaceProtocolPath?: string;
}

// Matches ANY `{{...}}` shape, not only the well-formed uppercase token
// grammar — a malformed or lowercase placeholder must still fail the render
// instead of silently passing through unresolved into shipped instructions.
const TOKEN_PATTERN = /\{\{([^{}]*)\}\}/gu;

function isKnownToken(name: string): name is HarnessTemplateTokenName {
  return (HARNESS_TEMPLATE_TOKEN_NAMES as readonly string[]).includes(name);
}

/** A relative, `/`-separated path from `fromFile`'s directory to `toFile`, portable across OSes. */
function toPortableRelativePath(fromFile: string, toFile: string): string {
  const relativePath = relative(dirname(fromFile), toFile).split(sep).join("/");
  return relativePath.length === 0 ? "." : relativePath;
}

/** Percent-encodes characters that would otherwise break a Markdown `[text](target)` link — spaces and the parens that terminate the link target. */
function encodeMarkdownLinkPath(path: string): string {
  return path.replace(/[ ()]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function isReachableRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function renderHarnessTemplate(
  template: string,
  targets: HarnessTemplateRenderTargets,
): string {
  const targetPathByToken: Partial<Record<HarnessTemplateTokenName, string>> = {
    "HARNESS:ENTRY_MAP_PATH": targets.entryMapPath,
    "HARNESS:WORKSPACE_PROTOCOL_PATH": targets.workspaceProtocolPath,
  };

  return template.replace(TOKEN_PATTERN, (match, tokenName: string) => {
    if (!isKnownToken(tokenName)) {
      throw new Error(`unknown harness template token: ${match}`);
    }
    const targetPath = targetPathByToken[tokenName];
    if (targetPath === undefined) {
      throw new Error(`harness template token ${match} used but no target path was supplied`);
    }
    // A resource file is expected to already exist by render time: harness
    // bootstrap must write every referenced resource before rendering any
    // link to it. This intentionally cannot validate paths that are not yet
    // materialized — see the H3 staged-apply design note in the caller.
    if (!isReachableRegularFile(targetPath)) {
      throw new Error(
        `harness template token ${match} target is not a reachable regular file: ${targetPath}`,
      );
    }
    return encodeMarkdownLinkPath(toPortableRelativePath(targets.outputFilePath, targetPath));
  });
}
