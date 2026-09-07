import { z } from "zod";

const PROJECT_HARNESS_MAX_TEXT = 200_000;

export const ProjectHarnessOperationSchema = z.enum(["bootstrap", "update"]);
export type ProjectHarnessOperation = z.infer<typeof ProjectHarnessOperationSchema>;

export const ProjectHarnessTargetSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  projectRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  cwd: z.string().min(1),
});
export type ProjectHarnessTarget = z.infer<typeof ProjectHarnessTargetSchema>;

export const ProjectHarnessFileRevisionSchema = z.object({
  status: z.enum(["missing", "regular", "symlink", "unreadable"]),
  mtimeMs: z.number().nullable(),
  size: z.number().int().nonnegative().nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  symlinkTarget: z.string().optional(),
});
export type ProjectHarnessFileRevision = z.infer<typeof ProjectHarnessFileRevisionSchema>;

export const ProjectHarnessFileSnapshotSchema = z.object({
  path: z.string().min(1),
  revision: ProjectHarnessFileRevisionSchema,
  content: z.string().max(PROJECT_HARNESS_MAX_TEXT).optional(),
});
export type ProjectHarnessFileSnapshot = z.infer<typeof ProjectHarnessFileSnapshotSchema>;

const ProjectHarnessEntrypointNameSchema = z.enum(["AGENTS.md", "CLAUDE.md"]);

export const ProjectHarnessEntrypointSnapshotSchema = z.object({
  fileName: ProjectHarnessEntrypointNameSchema,
  path: z.string().min(1),
  revision: ProjectHarnessFileRevisionSchema,
  status: z.enum(["missing", "regular", "symlink", "unreadable"]),
  symlinkTarget: z.string().optional(),
  symlinkResolvedPath: z.string().optional(),
  symlinkReachable: z.boolean().optional(),
  content: z.string().max(PROJECT_HARNESS_MAX_TEXT).optional(),
  hasManagedHarnessBlock: z.boolean(),
  hasForeignHarnessMarker: z.boolean(),
});
export type ProjectHarnessEntrypointSnapshot = z.infer<
  typeof ProjectHarnessEntrypointSnapshotSchema
>;

export const ProjectHarnessEntrypointRelationshipSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agents_symlinks_to_claude") }),
  z.object({ kind: z.literal("claude_symlinks_to_agents") }),
  z.object({ kind: z.literal("circular_symlinks") }),
  z.object({ kind: z.literal("independent_regular_files") }),
  z.object({ kind: z.literal("single_regular_file"), which: ProjectHarnessEntrypointNameSchema }),
  z.object({ kind: z.literal("both_missing") }),
  z.object({ kind: z.literal("broken_symlink"), which: ProjectHarnessEntrypointNameSchema }),
  z.object({
    kind: z.literal("symlink_points_elsewhere"),
    which: ProjectHarnessEntrypointNameSchema,
    resolvedTarget: z.string(),
  }),
  z.object({ kind: z.literal("unresolved") }),
]);
export type ProjectHarnessEntrypointRelationship = z.infer<
  typeof ProjectHarnessEntrypointRelationshipSchema
>;

export const ProjectHarnessMetadataSnapshotSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["missing", "valid", "corrupt", "unreadable"]),
  revision: ProjectHarnessFileRevisionSchema,
  supervisorNotebookIdentity: z
    .object({ notebookId: z.string().min(1), location: z.string().min(1) })
    .optional(),
  supervisorNotebook: z
    .object({
      notebookId: z.string().min(1),
      location: z.string().min(1),
      designatedWriterId: z.string().min(1),
      scope: z.string().min(1),
      expiresAt: z.string().min(1),
    })
    .optional(),
  projectHarness: z
    .object({
      package: z.string().min(1),
      generation: z.number().int().positive(),
      artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      entryMapSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      entryMapManaged: z.boolean(),
      managedEntrypoints: z
        .object({
          "AGENTS.md": z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
          "CLAUDE.md": z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
        })
        .strict(),
    })
    .optional(),
});
export type ProjectHarnessMetadataSnapshot = z.infer<typeof ProjectHarnessMetadataSnapshotSchema>;

export const ProjectHarnessResourceSnapshotSchema = z.object({
  key: z.enum(["entryMap", "entrypointBlock", "supervisorNotebookTemplate"]),
  path: z.string().min(1),
  status: z.enum(["missing", "regular", "unreadable"]),
  revision: ProjectHarnessFileRevisionSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ProjectHarnessResourceSnapshot = z.infer<typeof ProjectHarnessResourceSnapshotSchema>;

export const ProjectHarnessForeignOwnershipSchema = z.object({
  status: z.enum(["absent", "valid", "corrupt", "unreadable"]),
  manifestPath: z.string().min(1),
  ownedPaths: z.array(z.string()).max(128),
  protectedPaths: z.array(z.string()).max(32),
  entries: z
    .array(
      z.object({
        path: z.string().min(1),
        upstreamSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        status: z.enum(["missing", "regular", "symlink", "unreadable"]),
        currentSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        drift: z.enum(["unchanged", "local_delta", "missing", "unreadable"]),
      }),
    )
    .max(128),
  reason: z.string().max(2_000).optional(),
});
export type ProjectHarnessForeignOwnership = z.infer<typeof ProjectHarnessForeignOwnershipSchema>;

export const ProjectHarnessInstructionVisibilitySchema = z.object({
  path: z.string().min(1),
  scope: z.enum(["ancestor", "root", "nested", "override"]),
  status: z.enum(["missing", "regular", "symlink", "unreadable", "not_scanned"]),
  readable: z.boolean(),
  ownedBy: z.enum(["paseo", "foreign", "outside-project", "unknown"]),
  reason: z.string().max(1_000).optional(),
});
export type ProjectHarnessInstructionVisibility = z.infer<
  typeof ProjectHarnessInstructionVisibilitySchema
>;

export const ProjectHarnessRecoverySchema = z.object({
  status: z.enum(["none", "pending", "recovered", "blocked"]),
  transactionIds: z.array(z.string()).max(32),
  reason: z.string().max(2_000).optional(),
});
export type ProjectHarnessRecovery = z.infer<typeof ProjectHarnessRecoverySchema>;

export const ProjectHarnessProvenanceSchema = z.object({
  package: z.string().min(1),
  generation: z.number().int().positive(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  resources: z.array(
    z.object({
      key: z.enum(["entryMap", "entrypointBlock", "supervisorNotebookTemplate"]),
      path: z.string().min(1),
      digest: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  ),
});
export type ProjectHarnessProvenance = z.infer<typeof ProjectHarnessProvenanceSchema>;

export const ProjectHarnessInspectionSchema = z.object({
  target: ProjectHarnessTargetSchema,
  relationship: ProjectHarnessEntrypointRelationshipSchema,
  entrypoints: z.array(ProjectHarnessEntrypointSnapshotSchema).max(2),
  metadata: ProjectHarnessMetadataSnapshotSchema,
  notebook: ProjectHarnessFileSnapshotSchema.extend({
    source: z.enum(["default", "custom"]),
  }),
  resources: z.array(ProjectHarnessResourceSnapshotSchema).max(3),
  workspaceProtocol: ProjectHarnessFileSnapshotSchema,
  foreignOwnership: ProjectHarnessForeignOwnershipSchema,
  instructionVisibility: z.array(ProjectHarnessInstructionVisibilitySchema).max(64),
  recovery: ProjectHarnessRecoverySchema,
  provenance: ProjectHarnessProvenanceSchema,
});
export type ProjectHarnessInspection = z.infer<typeof ProjectHarnessInspectionSchema>;

export const ProjectHarnessChangeSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["create", "update", "preserve", "manual_reconciliation_required", "blocked"]),
  before: ProjectHarnessFileSnapshotSchema.nullable(),
  after: ProjectHarnessFileSnapshotSchema.nullable(),
  diff: z.string().max(400_000).optional(),
  reason: z.string().max(2_000).optional(),
});
export type ProjectHarnessChange = z.infer<typeof ProjectHarnessChangeSchema>;

export const ProjectHarnessPlanGuardSchema = z.object({
  path: z.string().min(1),
  expected: ProjectHarnessFileRevisionSchema,
});
export type ProjectHarnessPlanGuard = z.infer<typeof ProjectHarnessPlanGuardSchema>;

export const ProjectHarnessPlanFileSchema = z.object({
  path: z.string().min(1),
  expected: ProjectHarnessFileRevisionSchema,
  content: z.string().max(PROJECT_HARNESS_MAX_TEXT),
});
export type ProjectHarnessPlanFile = z.infer<typeof ProjectHarnessPlanFileSchema>;

export const ProjectHarnessPlanSchema = z.object({
  operation: ProjectHarnessOperationSchema,
  target: ProjectHarnessTargetSchema,
  provenance: ProjectHarnessProvenanceSchema,
  guards: z.array(ProjectHarnessPlanGuardSchema).max(32),
  files: z.array(ProjectHarnessPlanFileSchema).max(16),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ProjectHarnessPlan = z.infer<typeof ProjectHarnessPlanSchema>;

const ProjectHarnessTargetRequestFields = {
  requestId: z.string(),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1).optional(),
} as const;

export const ProjectHarnessInspectRequestSchema = z.object({
  type: z.literal("foundation.projectHarness.inspect.request"),
  ...ProjectHarnessTargetRequestFields,
});

export const ProjectHarnessPreviewRequestSchema = z.object({
  type: z.literal("foundation.projectHarness.preview.request"),
  ...ProjectHarnessTargetRequestFields,
  operation: ProjectHarnessOperationSchema,
});

export const ProjectHarnessApplyRequestSchema = z.object({
  type: z.literal("foundation.projectHarness.apply.request"),
  ...ProjectHarnessTargetRequestFields,
  plan: ProjectHarnessPlanSchema,
});

export const ProjectHarnessUpdateRequestSchema = z.object({
  type: z.literal("foundation.projectHarness.update.request"),
  ...ProjectHarnessTargetRequestFields,
  plan: ProjectHarnessPlanSchema,
});

/**
 * Explicitly releases the current durable notebook writer. The writer id and
 * notebook identity are expected-current selectors; authority comes from the
 * authenticated workspace.manage session and the daemon's live claim/CAS,
 * never from a caller-agent id supplied in this request.
 */
export const ProjectHarnessNotebookReleaseRequestSchema = z
  .object({
    type: z.literal("foundation.projectHarness.notebook.release.request"),
    ...ProjectHarnessTargetRequestFields,
    notebookId: z.string().min(1),
    location: z.string().min(1),
    designatedWriterId: z.string().min(1),
    expectedRevision: ProjectHarnessFileRevisionSchema,
  })
  .strict();

export type ProjectHarnessInspectRequest = z.infer<typeof ProjectHarnessInspectRequestSchema>;
export type ProjectHarnessPreviewRequest = z.infer<typeof ProjectHarnessPreviewRequestSchema>;
export type ProjectHarnessApplyRequest = z.infer<typeof ProjectHarnessApplyRequestSchema>;
export type ProjectHarnessUpdateRequest = z.infer<typeof ProjectHarnessUpdateRequestSchema>;
export type ProjectHarnessNotebookReleaseRequest = z.infer<
  typeof ProjectHarnessNotebookReleaseRequestSchema
>;

export const ProjectHarnessRpcErrorSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().max(2_000).optional(),
  paths: z.array(z.string()).max(32).optional(),
  recovery: ProjectHarnessRecoverySchema.optional(),
});
export type ProjectHarnessRpcError = z.infer<typeof ProjectHarnessRpcErrorSchema>;

export const ProjectHarnessInspectResponseSchema = z.object({
  type: z.literal("foundation.projectHarness.inspect.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string(),
      ok: z.literal(true),
      inspection: ProjectHarnessInspectionSchema,
    }),
    z.object({ requestId: z.string(), ok: z.literal(false), error: ProjectHarnessRpcErrorSchema }),
  ]),
});

export const ProjectHarnessPreviewResponseSchema = z.object({
  type: z.literal("foundation.projectHarness.preview.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string(),
      ok: z.literal(true),
      inspection: ProjectHarnessInspectionSchema,
      plan: ProjectHarnessPlanSchema,
      changes: z.array(ProjectHarnessChangeSchema).max(16),
      readyToApply: z.boolean(),
    }),
    z.object({ requestId: z.string(), ok: z.literal(false), error: ProjectHarnessRpcErrorSchema }),
  ]),
});

export const ProjectHarnessMutationResultSchema = z.object({
  operation: ProjectHarnessOperationSchema,
  transactionId: z.string().min(1),
  changedPaths: z.array(z.string()).max(16),
  inspection: ProjectHarnessInspectionSchema,
  recovery: ProjectHarnessRecoverySchema,
});
export type ProjectHarnessMutationResult = z.infer<typeof ProjectHarnessMutationResultSchema>;

export const ProjectHarnessApplyResponseSchema = z.object({
  type: z.literal("foundation.projectHarness.apply.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string(),
      ok: z.literal(true),
      result: ProjectHarnessMutationResultSchema,
    }),
    z.object({ requestId: z.string(), ok: z.literal(false), error: ProjectHarnessRpcErrorSchema }),
  ]),
});

export const ProjectHarnessUpdateResponseSchema = z.object({
  type: z.literal("foundation.projectHarness.update.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string(),
      ok: z.literal(true),
      result: ProjectHarnessMutationResultSchema,
    }),
    z.object({ requestId: z.string(), ok: z.literal(false), error: ProjectHarnessRpcErrorSchema }),
  ]),
});

export const ProjectHarnessNotebookReleaseResultSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  notebookId: z.string().min(1),
  location: z.string().min(1),
  releasedWriterId: z.string().min(1),
  metadataRevision: ProjectHarnessFileRevisionSchema,
  nextStep: z.literal("fresh_supervisor_role_first"),
});
export type ProjectHarnessNotebookReleaseResult = z.infer<
  typeof ProjectHarnessNotebookReleaseResultSchema
>;

export const ProjectHarnessNotebookReleaseResponseSchema = z.object({
  type: z.literal("foundation.projectHarness.notebook.release.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string(),
      ok: z.literal(true),
      result: ProjectHarnessNotebookReleaseResultSchema,
    }),
    z.object({ requestId: z.string(), ok: z.literal(false), error: ProjectHarnessRpcErrorSchema }),
  ]),
});

export type ProjectHarnessInspectResponse = z.infer<typeof ProjectHarnessInspectResponseSchema>;
export type ProjectHarnessPreviewResponse = z.infer<typeof ProjectHarnessPreviewResponseSchema>;
export type ProjectHarnessApplyResponse = z.infer<typeof ProjectHarnessApplyResponseSchema>;
export type ProjectHarnessUpdateResponse = z.infer<typeof ProjectHarnessUpdateResponseSchema>;
export type ProjectHarnessNotebookReleaseResponse = z.infer<
  typeof ProjectHarnessNotebookReleaseResponseSchema
>;
export type ProjectHarnessInspectPayload = ProjectHarnessInspectResponse["payload"];
export type ProjectHarnessPreviewPayload = ProjectHarnessPreviewResponse["payload"];
export type ProjectHarnessApplyPayload = ProjectHarnessApplyResponse["payload"];
export type ProjectHarnessUpdatePayload = ProjectHarnessUpdateResponse["payload"];
export type ProjectHarnessNotebookReleasePayload = ProjectHarnessNotebookReleaseResponse["payload"];
