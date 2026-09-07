import type pino from "pino";
import type {
  ProjectHarnessApplyRequest,
  ProjectHarnessApplyResponse,
  ProjectHarnessInspectRequest,
  ProjectHarnessInspectResponse,
  ProjectHarnessPreviewRequest,
  ProjectHarnessPreviewResponse,
  ProjectHarnessUpdateRequest,
  ProjectHarnessUpdateResponse,
  ProjectHarnessRpcError,
  ProjectHarnessNotebookReleaseRequest,
  ProjectHarnessNotebookReleaseResponse,
} from "@getpaseo/protocol/project-harness/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { WorkspaceProvisioningService } from "../workspace-provisioning/workspace-provisioning-service.js";
import {
  ProjectHarnessServiceError,
  type ProjectHarnessService,
} from "../../project/project-harness-service.js";
import type { HarnessBindingResolver } from "../../project/harness-binding-service.js";
import type { AgentManager } from "../../agent/agent-manager.js";

interface ProjectHarnessSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export class ProjectHarnessSession {
  constructor(
    private readonly options: {
      host: ProjectHarnessSessionHost;
      workspaceProvisioning: WorkspaceProvisioningService;
      service: ProjectHarnessService | null;
      bindingResolver?: HarnessBindingResolver | null;
      agentManager?: Pick<AgentManager, "getAgent" | "isAgentCloseInFlight" | "hasInFlightRun">;
      logger: pino.Logger;
    },
  ) {}

  async handleInspectRequest(
    message: Extract<SessionInboundMessage, { type: "foundation.projectHarness.inspect.request" }>,
  ): Promise<void> {
    const request = message as ProjectHarnessInspectRequest;
    try {
      const inspection = await this.requireService().inspect(await this.resolveTarget(request));
      const response: ProjectHarnessInspectResponse = {
        type: "foundation.projectHarness.inspect.response",
        payload: { requestId: request.requestId, ok: true, inspection },
      };
      this.options.host.emit(response);
    } catch (error) {
      this.emitError("foundation.projectHarness.inspect.response", request.requestId, error);
    }
  }

  async handlePreviewRequest(
    message: Extract<SessionInboundMessage, { type: "foundation.projectHarness.preview.request" }>,
  ): Promise<void> {
    const request = message as ProjectHarnessPreviewRequest;
    try {
      const preview = await this.requireService().preview(
        await this.resolveTarget(request),
        request.operation,
      );
      const response: ProjectHarnessPreviewResponse = {
        type: "foundation.projectHarness.preview.response",
        payload: { requestId: request.requestId, ok: true, ...preview },
      };
      this.options.host.emit(response);
    } catch (error) {
      this.emitError("foundation.projectHarness.preview.response", request.requestId, error);
    }
  }

  async handleApplyRequest(
    message: Extract<SessionInboundMessage, { type: "foundation.projectHarness.apply.request" }>,
  ): Promise<void> {
    const request = message as ProjectHarnessApplyRequest;
    try {
      const result = await this.requireService().apply(
        await this.resolveTarget(request),
        request.plan,
      );
      const response: ProjectHarnessApplyResponse = {
        type: "foundation.projectHarness.apply.response",
        payload: { requestId: request.requestId, ok: true, result },
      };
      this.options.host.emit(response);
    } catch (error) {
      this.emitError("foundation.projectHarness.apply.response", request.requestId, error);
    }
  }

  async handleUpdateRequest(
    message: Extract<SessionInboundMessage, { type: "foundation.projectHarness.update.request" }>,
  ): Promise<void> {
    const request = message as ProjectHarnessUpdateRequest;
    try {
      const result = await this.requireService().update(
        await this.resolveTarget(request),
        request.plan,
      );
      const response: ProjectHarnessUpdateResponse = {
        type: "foundation.projectHarness.update.response",
        payload: { requestId: request.requestId, ok: true, result },
      };
      this.options.host.emit(response);
    } catch (error) {
      this.emitError("foundation.projectHarness.update.response", request.requestId, error);
    }
  }

  async handleNotebookReleaseRequest(
    message: Extract<
      SessionInboundMessage,
      { type: "foundation.projectHarness.notebook.release.request" }
    >,
  ): Promise<void> {
    const request = message as ProjectHarnessNotebookReleaseRequest;
    try {
      this.requireService();
      const target = await this.resolveTarget(request);
      this.assertReleaseLifecycle(request.designatedWriterId);
      const result = await this.requireBindingResolver().release({
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        cwd: target.cwd,
        notebookId: request.notebookId,
        location: request.location,
        designatedWriterId: request.designatedWriterId,
        expectedRevision: request.expectedRevision,
        revalidate: () => this.assertReleaseLifecycle(request.designatedWriterId),
      });
      const response: ProjectHarnessNotebookReleaseResponse = {
        type: "foundation.projectHarness.notebook.release.response",
        payload: { requestId: request.requestId, ok: true, result },
      };
      this.options.host.emit(response);
    } catch (error) {
      this.emitError(
        "foundation.projectHarness.notebook.release.response",
        request.requestId,
        error,
      );
    }
  }

  private async resolveTarget(message: { projectId: string; workspaceId: string; cwd?: string }) {
    return this.options.workspaceProvisioning.resolveProjectHarnessTarget({
      projectId: message.projectId,
      workspaceId: message.workspaceId,
      ...(message.cwd ? { cwd: message.cwd } : {}),
    });
  }

  private requireService(): ProjectHarnessService {
    if (!this.options.service) {
      throw new ProjectHarnessServiceError(
        "feature_unavailable",
        "Project Harness is unavailable because the pinned SLP package is not installed or enabled on this host",
      );
    }
    return this.options.service;
  }

  private requireBindingResolver(): HarnessBindingResolver {
    if (!this.options.bindingResolver) {
      throw new ProjectHarnessServiceError(
        "feature_unavailable",
        "Project Harness notebook release is unavailable on this host",
      );
    }
    return this.options.bindingResolver;
  }

  private assertReleaseLifecycle(writerId: string): void {
    const agent = this.options.agentManager?.getAgent(writerId);
    if (!agent) {
      throw new ProjectHarnessServiceError(
        "notebook_release_lifecycle_unknown",
        "The designated writer lifecycle is not present in the authoritative daemon runtime",
        [writerId],
      );
    }
    if (
      this.options.agentManager?.isAgentCloseInFlight(writerId) === true ||
      this.options.agentManager?.hasInFlightRun(writerId) === true ||
      agent.lifecycle === "initializing" ||
      agent.lifecycle === "running"
    ) {
      throw new ProjectHarnessServiceError(
        "notebook_release_lifecycle_active",
        `The designated writer '${writerId}' is active; release requires a safe idle lifecycle`,
        [writerId],
      );
    }
    if (agent.lifecycle !== "idle" && agent.lifecycle !== "closed") {
      throw new ProjectHarnessServiceError(
        "notebook_release_lifecycle_not_safe_idle",
        `The designated writer '${writerId}' is not in a safe idle lifecycle`,
        [writerId],
      );
    }
  }

  private emitError(
    type:
      | "foundation.projectHarness.inspect.response"
      | "foundation.projectHarness.preview.response"
      | "foundation.projectHarness.apply.response"
      | "foundation.projectHarness.update.response"
      | "foundation.projectHarness.notebook.release.response",
    requestId: string,
    error: unknown,
  ): void {
    const rpcError = toRpcError(error);
    this.options.logger.warn({ requestId, code: rpcError.code }, "Project Harness RPC failed");
    this.options.host.emit({
      type,
      payload: { requestId, ok: false, error: rpcError },
    } as SessionOutboundMessage);
  }
}

function toRpcError(error: unknown): ProjectHarnessRpcError {
  if (error instanceof ProjectHarnessServiceError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.paths.length > 0 ? { paths: error.paths } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const [code] = message.split(":", 1);
  return {
    code: code.trim().length > 0 ? code.trim() : "handler_error",
    message,
  };
}
