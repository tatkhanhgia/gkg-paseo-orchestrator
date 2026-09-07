import { z } from "zod";

import {
  inspectProjectNotebook,
  writeProjectNotebook,
  type ProjectNotebookRevision,
} from "../../utils/project-notebook-file.js";

/**
 * Durable per-project harness metadata (`.paseo/harness.json`), reusing the
 * already-hardened repo-contained, expected-revision CAS text primitive from
 * `project-notebook-file.ts` (path-safety and atomic-write concerns are
 * identical for any repo-scoped managed file; only the content shape and the
 * meaning of "designated writer" differ here).
 *
 * Content is schema-validated, not merely `JSON.parse`d as `unknown` cast to
 * the expected shape: `null`, an array, or a wrong-shaped object must be
 * treated as `corrupt` (fail closed), never silently accepted as an empty or
 * partially-valid claim.
 */

export const SupervisorNotebookClaimSchema = z
  .object({
    notebookId: z.string().min(1),
    location: z.string().min(1),
    designatedWriterId: z.string().min(1),
    scope: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }),
    establishedAt: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * Durable notebook identity is project state; writer/scope/expiry are only a
 * replaceable lease over that identity. Keeping the two shapes separate lets
 * release revoke authority without silently moving readers to a new notebook.
 */
export const SupervisorNotebookIdentitySchema = z
  .object({
    notebookId: z.string().min(1),
    location: z.string().min(1),
  })
  .strict();

const ProjectHarnessDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ProjectHarnessInstallationSchema = z
  .object({
    package: z.string().min(1),
    generation: z.number().int().positive(),
    artifactDigest: ProjectHarnessDigestSchema,
    descriptorDigest: ProjectHarnessDigestSchema,
    entryMapSha256: ProjectHarnessDigestSchema,
    entryMapManaged: z.boolean(),
    managedEntrypoints: z
      .object({
        "AGENTS.md": ProjectHarnessDigestSchema.optional(),
        "CLAUDE.md": ProjectHarnessDigestSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const HarnessProjectMetadataSchema = z
  .object({
    supervisorNotebookIdentity: SupervisorNotebookIdentitySchema.optional(),
    supervisorNotebook: SupervisorNotebookClaimSchema.optional(),
    projectHarness: ProjectHarnessInstallationSchema.optional(),
  })
  .strict();

export type SupervisorNotebookClaim = z.infer<typeof SupervisorNotebookClaimSchema>;
export type SupervisorNotebookIdentity = z.infer<typeof SupervisorNotebookIdentitySchema>;
export type ProjectHarnessInstallation = z.infer<typeof ProjectHarnessInstallationSchema>;
export type HarnessProjectMetadata = z.infer<typeof HarnessProjectMetadataSchema>;

export type HarnessProjectMetadataSnapshot =
  | { status: "missing"; revision: null; metadata: null }
  | { status: "valid"; revision: ProjectNotebookRevision; metadata: HarnessProjectMetadata }
  | { status: "unreadable" | "corrupt"; revision: null; metadata: null };

export type HarnessProjectMetadataWriteResult =
  | { ok: true; snapshot: HarnessProjectMetadataSnapshot & { status: "valid" } }
  | {
      ok: false;
      error:
        | { code: "invalid_path"; reason: string }
        | { code: "stale_metadata"; current: HarnessProjectMetadataSnapshot }
        | { code: "write_failed" };
    };

function parseMetadataSnapshot(
  status: "missing" | "valid" | "unreadable",
  content: string | undefined,
  revision: ProjectNotebookRevision | null,
): HarnessProjectMetadataSnapshot {
  if (status === "missing" || status === "unreadable") {
    return { status, revision: null, metadata: null };
  }
  if (content === undefined || revision === null) {
    return { status: "unreadable", revision: null, metadata: null };
  }
  const parsed = HarnessProjectMetadataSchema.safeParse(safeJsonParse(content));
  if (!parsed.success) return { status: "corrupt", revision: null, metadata: null };
  return { status: "valid", revision, metadata: parsed.data };
}

const JSON_PARSE_FAILURE = Symbol("json_parse_failure");

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return JSON_PARSE_FAILURE;
  }
}

export function inspectHarnessProjectMetadata(
  repoRoot: string,
  relativePath: string,
): HarnessProjectMetadataSnapshot {
  const snapshot = inspectProjectNotebook(repoRoot, relativePath);
  return parseMetadataSnapshot(
    snapshot.status,
    snapshot.status === "valid" ? snapshot.content : undefined,
    snapshot.status === "valid" ? snapshot.revision : null,
  );
}

/**
 * `writerId` plays the same role as `callerId`/`designatedWriterId` in
 * `writeProjectNotebook`: this file is always written by the trusted
 * resolver on behalf of one exact agent identity, never from arbitrary
 * caller input.
 */
export function writeHarnessProjectMetadata(input: {
  repoRoot: string;
  relativePath: string;
  metadata: HarnessProjectMetadata;
  expectedRevision: ProjectNotebookRevision | null;
  writerId: string;
}): HarnessProjectMetadataWriteResult {
  const parsedMetadata = HarnessProjectMetadataSchema.safeParse(input.metadata);
  if (!parsedMetadata.success) return { ok: false, error: { code: "write_failed" } };
  const result = writeProjectNotebook({
    repoRoot: input.repoRoot,
    relativePath: input.relativePath,
    content: JSON.stringify(parsedMetadata.data, null, 2),
    expectedRevision: input.expectedRevision,
    callerId: input.writerId,
    designatedWriterId: input.writerId,
  });
  if (!result.ok) {
    if (result.error.code === "stale_notebook") {
      const current = result.error.current;
      return {
        ok: false,
        error: {
          code: "stale_metadata",
          current: parseMetadataSnapshot(
            current.status,
            current.status === "valid" ? current.content : undefined,
            current.status === "valid" ? current.revision : null,
          ),
        },
      };
    }
    if (result.error.code === "invalid_path") {
      return { ok: false, error: { code: "invalid_path", reason: result.error.reason } };
    }
    return { ok: false, error: { code: "write_failed" } };
  }
  const snapshot = parseMetadataSnapshot(
    result.snapshot.status,
    result.snapshot.content,
    result.snapshot.revision,
  );
  if (snapshot.status !== "valid") return { ok: false, error: { code: "write_failed" } };
  return { ok: true, snapshot };
}
