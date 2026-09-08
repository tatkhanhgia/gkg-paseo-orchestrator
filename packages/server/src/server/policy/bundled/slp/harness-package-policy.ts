import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PASEO_ROLE_IDS, type PaseoRoleId } from "@getpaseo/protocol/role-binding";
import {
  HARNESS_TEMPLATE_TOKEN_NAMES,
  type HarnessTemplateTokenName,
} from "../../../../utils/harness-template-render.js";

/**
 * Loader and role projection for the Foundation-authored Project Harness
 * package descriptor (`templates/harness/harness-package.json` in the
 * Foundation source tree, imported by `scripts/import-foundation.mjs` under
 * the existing `templates` allowlist directory — no new vendor subtree).
 *
 * The descriptor is imported from the pinned Foundation generation. This
 * loader validates its structure and bytes; it never invents resource content
 * and never treats an unreadable/invalid descriptor as an empty-but-valid one.
 */

export const HARNESS_PACKAGE_ID = "paseo-project-harness";

export const HARNESS_PACKAGE_RESOURCE_KEYS = [
  "entryMap",
  "entrypointBlock",
  "supervisorNotebookTemplate",
] as const;
export type HarnessPackageResourceKey = (typeof HARNESS_PACKAGE_RESOURCE_KEYS)[number];

export interface HarnessPackageDescriptor {
  schemaVersion: 1;
  package: string;
  generation: number;
  /** Every path here is resolved relative to the descriptor's own directory. */
  resourcePaths: Record<HarnessPackageResourceKey, string>;
  roleMinimum: Record<PaseoRoleId, readonly HarnessPackageResourceKey[]>;
  /** Token names Foundation's entrypoint block expects Product's renderer to support. */
  entrypointPlaceholders: readonly HarnessTemplateTokenName[];
  descriptorDigest: string;
  artifactDigest: string;
  resourceDigests: Record<HarnessPackageResourceKey, string>;
  resourceRelativePaths: Record<HarnessPackageResourceKey, string>;
  descriptorPath: string;
}

interface RawHarnessPackageDescriptor {
  schemaVersion: 1;
  package: string;
  generation: number;
  resources: Record<HarnessPackageResourceKey, string>;
  roleMinimum: Record<PaseoRoleId, HarnessPackageResourceKey[]>;
  entrypointPlaceholders: Record<string, string>;
  notebook?: {
    bindingRequiredFields: string[];
    grantFields: string[];
    writeSemantics: string;
    wireRepresentation: string;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativeResourcePath(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (isAbsolute(value)) return false;
  return !value.split(/[\\/]/u).includes("..");
}

function isKnownResourceKey(value: unknown): value is HarnessPackageResourceKey {
  return (
    typeof value === "string" &&
    (HARNESS_PACKAGE_RESOURCE_KEYS as readonly string[]).includes(value)
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateRawResources(parsed: Record<string, unknown>, descriptorPath: string): void {
  if (!isPlainObject(parsed.resources)) {
    throw new Error(`harness package descriptor missing resources map: ${descriptorPath}`);
  }
  for (const key of HARNESS_PACKAGE_RESOURCE_KEYS) {
    if (!isSafeRelativeResourcePath(parsed.resources[key])) {
      throw new Error(
        `harness package descriptor resources.${key} must be a safe relative path: ${descriptorPath}`,
      );
    }
  }
}

function validateRawRoleMinimum(parsed: Record<string, unknown>, descriptorPath: string): void {
  if (!isPlainObject(parsed.roleMinimum)) {
    throw new Error(`harness package descriptor missing roleMinimum map: ${descriptorPath}`);
  }
  for (const roleId of PASEO_ROLE_IDS) {
    const minimum = parsed.roleMinimum[roleId];
    if (!Array.isArray(minimum) || minimum.length === 0 || !minimum.every(isKnownResourceKey)) {
      throw new Error(
        `harness package descriptor roleMinimum.${roleId} must be a non-empty list of known resource keys: ${descriptorPath}`,
      );
    }
  }
}

function validateRawPlaceholders(parsed: Record<string, unknown>, descriptorPath: string): void {
  if (!isPlainObject(parsed.entrypointPlaceholders)) {
    throw new Error(
      `harness package descriptor missing entrypointPlaceholders map: ${descriptorPath}`,
    );
  }
  // Cross-validates Foundation's declared token names against the tokens
  // Product's renderer actually supports, so a drift between the two sides
  // fails descriptor validation instead of silently leaving a token
  // unrendered or unresolved when the entrypoint block is later materialized.
  for (const tokenName of Object.keys(parsed.entrypointPlaceholders)) {
    if (!(HARNESS_TEMPLATE_TOKEN_NAMES as readonly string[]).includes(tokenName)) {
      throw new Error(
        `harness package descriptor entrypointPlaceholders declares an unsupported token ${tokenName}: ${descriptorPath}`,
      );
    }
  }
}

function validateRawNotebook(parsed: Record<string, unknown>, descriptorPath: string): void {
  if (parsed.notebook === undefined) return;
  if (!isPlainObject(parsed.notebook)) {
    throw new Error(
      `harness package descriptor notebook section must be an object: ${descriptorPath}`,
    );
  }
  for (const field of ["bindingRequiredFields", "grantFields"]) {
    const values = parsed.notebook[field];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
      throw new Error(
        `harness package descriptor notebook.${field} must be a string list: ${descriptorPath}`,
      );
    }
  }
  for (const field of ["writeSemantics", "wireRepresentation"]) {
    if (typeof parsed.notebook[field] !== "string" || parsed.notebook[field].trim().length === 0) {
      throw new Error(
        `harness package descriptor notebook.${field} must be a non-empty string: ${descriptorPath}`,
      );
    }
  }
}

function parseRawDescriptor(descriptorPath: string, content: string): RawHarnessPackageDescriptor {
  const parsed: unknown = JSON.parse(content);
  if (!isPlainObject(parsed)) {
    throw new Error(`harness package descriptor root must be an object: ${descriptorPath}`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `unsupported harness package descriptor schemaVersion ${String(parsed.schemaVersion)}: ${descriptorPath}`,
    );
  }
  if (typeof parsed.package !== "string" || parsed.package.trim().length === 0) {
    throw new Error(`harness package descriptor missing package identity: ${descriptorPath}`);
  }
  if (!Number.isInteger(parsed.generation) || (parsed.generation as number) < 1) {
    throw new Error(
      `harness package descriptor generation must be a positive integer: ${descriptorPath}`,
    );
  }
  validateRawResources(parsed, descriptorPath);
  validateRawRoleMinimum(parsed, descriptorPath);
  validateRawPlaceholders(parsed, descriptorPath);
  validateRawNotebook(parsed, descriptorPath);
  return parsed as unknown as RawHarnessPackageDescriptor;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function descriptorCandidates(): string[] {
  const packaged = resolve(moduleDirectory, "harness/harness-package.json");
  // A compiled server must load only the copied package. Falling back from an
  // isolated artifact to a source checkout would make a stale/missing package
  // look valid and would defeat the pinned-generation receipt.
  if (moduleDirectory.split(sep).includes("dist")) return [packaged];
  return [
    packaged,
    resolve(
      moduleDirectory,
      "../../../../../../../foundation/dist/templates/harness/harness-package.json",
    ),
  ];
}

/** Overridable only for tests; production callers always resolve from the imported bundle. */
export function loadHarnessPackageDescriptor(
  explicitDescriptorPath?: string,
): HarnessPackageDescriptor {
  const candidates = explicitDescriptorPath ? [explicitDescriptorPath] : descriptorCandidates();
  let lastError: unknown;
  for (const descriptorPath of candidates) {
    if (!existsSync(descriptorPath)) {
      lastError = new Error(`no such file: ${descriptorPath}`);
      continue;
    }
    // Once a candidate file exists, it is the authoritative source for this
    // load — a corrupt or invalid descriptor here must fail loudly, never
    // silently fall through to a different candidate path/generation. That
    // fallback-on-corruption would let a broken imported descriptor resolve
    // to a stale or unrelated source without any signal.
    const raw = parseRawDescriptor(descriptorPath, readFileSync(descriptorPath, "utf8"));
    if (raw.package !== HARNESS_PACKAGE_ID) {
      throw new Error(
        `harness package descriptor identity mismatch: expected ${HARNESS_PACKAGE_ID}, got ${raw.package}`,
      );
    }
    {
      const descriptorDirectory = dirname(descriptorPath);
      const realDescriptorDirectory = realpathSync(descriptorDirectory);
      const resourcePaths = Object.fromEntries(
        HARNESS_PACKAGE_RESOURCE_KEYS.map((key) => {
          const lexicalPath = resolve(descriptorDirectory, raw.resources[key]);
          // Lexical containment (no `..` segments) was already checked in
          // parseRawDescriptor, but a resource itself — or a directory in its
          // path — could still be a symlink that escapes the descriptor's
          // real directory. Resolve the real path and re-check containment
          // there so an imported symlinked resource can never point outside
          // the Foundation-controlled harness package directory.
          let realPath: string;
          try {
            realPath = realpathSync(lexicalPath);
          } catch (error) {
            throw new Error(
              `harness package descriptor resources.${key} does not exist on disk: ${lexicalPath}`,
              { cause: error },
            );
          }
          if (
            realPath !== realDescriptorDirectory &&
            !realPath.startsWith(realDescriptorDirectory + sep)
          ) {
            throw new Error(
              `harness package descriptor resources.${key} resolves outside its descriptor directory via a symlink: ${lexicalPath}`,
            );
          }
          return [key, realPath];
        }),
      ) as Record<HarnessPackageResourceKey, string>;
      const resourceRelativePaths = Object.fromEntries(
        HARNESS_PACKAGE_RESOURCE_KEYS.map((key) => [key, raw.resources[key]]),
      ) as Record<HarnessPackageResourceKey, string>;
      const resourceDigests = Object.fromEntries(
        HARNESS_PACKAGE_RESOURCE_KEYS.map((key) => [key, sha256(readFileSync(resourcePaths[key]))]),
      ) as Record<HarnessPackageResourceKey, string>;
      const descriptorDigest = sha256(readFileSync(descriptorPath));
      const artifactDigest = sha256(
        JSON.stringify({
          package: raw.package,
          generation: raw.generation,
          descriptorDigest,
          resources: HARNESS_PACKAGE_RESOURCE_KEYS.map((key) => ({
            key,
            path: raw.resources[key],
            digest: resourceDigests[key],
          })),
        }),
      );
      return {
        schemaVersion: raw.schemaVersion,
        package: raw.package,
        generation: raw.generation,
        resourcePaths,
        roleMinimum: raw.roleMinimum,
        entrypointPlaceholders: Object.keys(
          raw.entrypointPlaceholders,
        ) as HarnessTemplateTokenName[],
        descriptorDigest,
        artifactDigest,
        resourceDigests,
        resourceRelativePaths,
        descriptorPath,
      };
    }
  }
  throw new Error(
    `Unable to load Foundation Project Harness package descriptor: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export interface RoleHarnessResourceProjection {
  roleId: PaseoRoleId;
  resourceKeys: readonly HarnessPackageResourceKey[];
  resourcePaths: Record<HarnessPackageResourceKey, string>;
}

/** Exact immutable package identity used by the SLP generation digest. */
export function buildHarnessPackageArtifactDescriptor(
  descriptor = loadHarnessPackageDescriptor(),
): {
  package: string;
  generation: number;
  artifactDigest: string;
  descriptorDigest: string;
  resources: Array<{ key: HarnessPackageResourceKey; path: string; digest: string }>;
} {
  const projection = HARNESS_PACKAGE_RESOURCE_KEYS.map((key) => ({
    key,
    path: descriptor.resourceRelativePaths[key],
    digest: descriptor.resourceDigests[key],
  }));
  return {
    package: descriptor.package,
    generation: descriptor.generation,
    artifactDigest: descriptor.artifactDigest,
    descriptorDigest: descriptor.descriptorDigest,
    resources: projection,
  };
}

/** Resolves only the resource paths a given role's mandatory minimum actually needs. */
export function projectRoleHarnessResources(
  descriptor: HarnessPackageDescriptor,
  roleId: PaseoRoleId,
): RoleHarnessResourceProjection {
  const resourceKeys = descriptor.roleMinimum[roleId];
  const resourcePaths = Object.fromEntries(
    resourceKeys.map((key) => [key, descriptor.resourcePaths[key]]),
  ) as Record<HarnessPackageResourceKey, string>;
  return { roleId, resourceKeys, resourcePaths };
}
