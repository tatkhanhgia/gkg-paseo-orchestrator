import type {
  NotebookGrantReceipt,
  NotebookGrantRequest,
} from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import {
  createProjectHarnessBindingService,
  type HarnessBindingResolutionInput,
  type HarnessBindingResolver,
} from "./harness-binding-service.js";

/**
 * Compatibility callable retained for the generic assignment seam. The
 * runtime uses the attached prepare/commit lifecycle so a failed provider
 * admission or launch can roll back a pending writer claim.
 */
export interface NotebookGrantResolutionInput {
  agentId: string;
  roleId: PaseoRoleId;
  workspaceId: string;
  request: NotebookGrantRequest;
  cwd?: string;
}

export type NotebookGrantResolver = (
  input: NotebookGrantResolutionInput,
) => Promise<NotebookGrantReceipt>;
export type NotebookGrantLifecycleResolver = NotebookGrantResolver & HarnessBindingResolver;

export interface NotebookGrantResolverDependencies {
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  projectRegistry: Pick<ProjectRegistry, "get" | "list">;
}

function aggregateWithCause(
  errors: readonly unknown[],
  message: string,
  cause: unknown,
): AggregateError {
  const aggregate = new AggregateError(errors, message);
  Object.defineProperty(aggregate, "cause", {
    configurable: true,
    enumerable: false,
    value: cause,
    writable: true,
  });
  return aggregate;
}

export function createNotebookGrantResolver(
  dependencies: NotebookGrantResolverDependencies,
): NotebookGrantLifecycleResolver {
  const service = createProjectHarnessBindingService(dependencies);
  const resolver = (async (input: NotebookGrantResolutionInput): Promise<NotebookGrantReceipt> => {
    const workspace = await dependencies.workspaceRegistry.get(input.workspaceId);
    const cwd = input.cwd ?? workspace?.cwd;
    if (!cwd) {
      throw new Error(`notebook_grant_workspace_cwd_unavailable: ${input.workspaceId}`);
    }
    let prepared;
    try {
      prepared = await service.prepare({
        agentId: input.agentId,
        roleId: input.roleId,
        workspaceId: input.workspaceId,
        cwd,
        request: input.request,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const compatibilityMessage = message
        .replace("harness_binding_workspace_unavailable", "notebook_grant_workspace_unavailable")
        .replace("harness_binding_project_unavailable", "notebook_grant_project_unavailable")
        .replace("harness_binding_metadata_", "notebook_grant_metadata_");
      if (compatibilityMessage !== message) throw new Error(compatibilityMessage, { cause: error });
      throw error;
    }
    if (!prepared.notebookGrant) {
      throw new Error("notebook_grant_resolution_missing_receipt");
    }
    try {
      await prepared.commit();
      return prepared.notebookGrant;
    } catch (error) {
      try {
        await prepared.rollback();
      } catch (rollbackError) {
        throw aggregateWithCause(
          [error, rollbackError],
          "notebook_grant_commit_failed_and_rollback_failed",
          rollbackError,
        );
      }
      throw error;
    }
  }) as NotebookGrantLifecycleResolver;

  Object.assign(resolver, service);
  return resolver;
}

export type { HarnessBindingResolutionInput };
