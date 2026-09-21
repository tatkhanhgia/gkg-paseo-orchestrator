import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../messages.js";
import {
  DAEMON_PERMISSIONS,
  OWNER_PERMISSIONS,
  SessionAuthorization,
  permissionsForLegacyHubScopes,
  parseDaemonPermissions,
} from "./index.js";

function operationTypes(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) {
    throw new TypeError("Expected an operation schema");
  }
  const candidate = schema as {
    shape?: { type?: { value?: unknown } };
    options?: readonly unknown[];
  };
  if (typeof candidate.shape?.type?.value === "string") {
    return [candidate.shape.type.value];
  }
  if (candidate.options) {
    return candidate.options.flatMap(operationTypes);
  }
  throw new TypeError("Operation schema has neither a type literal nor nested options");
}

function inboundOperationTypes(): SessionInboundMessage["type"][] {
  return operationTypes(SessionInboundMessageSchema) as SessionInboundMessage["type"][];
}

function outboundOperationTypes(): SessionOutboundMessage["type"][] {
  return operationTypes(SessionOutboundMessageSchema) as SessionOutboundMessage["type"][];
}

function inboundMessage(type: SessionInboundMessage["type"]): SessionInboundMessage {
  return { type } as SessionInboundMessage;
}

function outboundMessage(type: SessionOutboundMessage["type"]): SessionOutboundMessage {
  if (type === "status")
    return {
      type,
      payload: { status: "agent_create_failed", error: "test", requestId: "test" },
    } as SessionOutboundMessage;
  return { type } as SessionOutboundMessage;
}

describe("SessionAuthorization", () => {
  test("owner authority covers every session operation", () => {
    const authorization = new SessionAuthorization(OWNER_PERMISSIONS);

    expect(
      inboundOperationTypes().every((type) => authorization.allowsInbound(inboundMessage(type))),
    ).toBe(true);
    expect(
      outboundOperationTypes().every((type) => authorization.allowsOutbound(outboundMessage(type))),
    ).toBe(true);
  });

  test("semantic permissions authorize operations instead of RPC namespaces", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);

    expect(authorization.allowsInbound(inboundMessage("hub.execution.agent.create.request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("hub.execution.agent.update"))).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsInbound(inboundMessage("refresh_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("get_providers_snapshot_response"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("providers_snapshot_update"))).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("refresh_providers_snapshot_response")),
    ).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_daemon_config_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("provider_diagnostic_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("ping"))).toBe(false);
    expect(
      authorization.allowsInbound(inboundMessage("hub.management.daemon.get_status.request")),
    ).toBe(false);
  });

  test("keeps coordination writes and plugin observations on distinct permissions", () => {
    const workspaceWriter = new SessionAuthorization(["workspace.write"]);
    const daemonReader = new SessionAuthorization(["daemon.read"]);

    expect(workspaceWriter.allowsInbound(inboundMessage("agent.coordination_signal.request"))).toBe(
      true,
    );
    expect(
      workspaceWriter.allowsOutbound(outboundMessage("agent.coordination_signal.response")),
    ).toBe(true);
    expect(daemonReader.allowsInbound(inboundMessage("agent.coordination_signal.request"))).toBe(
      false,
    );

    for (const operation of [
      "plugin.catalog.get.request",
      "plugin.directory.inspect.request",
      "plugin.list.request",
      "plugin.logs.get.request",
      "plugin.source.status.request",
    ] as const) {
      expect(daemonReader.allowsInbound(inboundMessage(operation))).toBe(true);
    }
    expect(daemonReader.allowsInbound(inboundMessage("plugin.source.update.request"))).toBe(false);
  });

  test("classifies downstream Foundation, Beads, Council, and portable update operations", () => {
    const daemonReader = new SessionAuthorization(["daemon.read"]);
    const daemonManager = new SessionAuthorization(["daemon.manage"]);
    const workspaceReader = new SessionAuthorization(["workspace.read"]);
    const workspaceWriter = new SessionAuthorization(["workspace.write"]);
    const workspaceManager = new SessionAuthorization(["workspace.manage"]);

    for (const operation of [
      "role_profiles.get.request",
      "foundation.credentials.get_status.request",
      "foundation.provider_connection.get_status.request",
      "foundation.provider_connection.test.request",
      "distribution.update.check.request",
      "distribution.update.get_status.request",
    ] as const) {
      expect(daemonReader.allowsInbound(inboundMessage(operation))).toBe(true);
      expect(daemonManager.allowsInbound(inboundMessage(operation))).toBe(false);
    }

    for (const operation of [
      "foundation.credentials.set.request",
      "foundation.credentials.delete.request",
      "distribution.update.prepare.request",
      "distribution.update.apply.request",
      "distribution.update.rollback.request",
    ] as const) {
      expect(daemonManager.allowsInbound(inboundMessage(operation))).toBe(true);
      expect(daemonReader.allowsInbound(inboundMessage(operation))).toBe(false);
    }

    for (const operation of [
      "beads.issues.list.request",
      "beads.issue.get.request",
      "council.case.list.request",
      "foundation.workspaceProtocol.inspect.request",
    ] as const) {
      expect(workspaceReader.allowsInbound(inboundMessage(operation))).toBe(true);
    }
    for (const operation of ["beads.issue.create.request", "beads.issue.close.request"] as const) {
      expect(workspaceWriter.allowsInbound(inboundMessage(operation))).toBe(true);
      expect(workspaceReader.allowsInbound(inboundMessage(operation))).toBe(false);
    }

    expect(
      workspaceManager.allowsInbound(inboundMessage("foundation.workspaceProtocol.write.request")),
    ).toBe(true);
    expect(
      workspaceWriter.allowsInbound(inboundMessage("foundation.workspaceProtocol.write.request")),
    ).toBe(false);
    expect(workspaceReader.allowsOutbound(outboundMessage("council.case.updated"))).toBe(true);
    expect(daemonManager.allowsOutbound(outboundMessage("distribution.update.progress"))).toBe(
      true,
    );
  });

  test("Hub can operate ordinary agents and recover workspaces without daemon administration", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);
    for (const type of [
      "create_agent_request",
      "send_agent_message_request",
      "fetch_agent_request",
      "agent.timeline.set_subscription.request",
      "workspace.recovery.inspect.request",
      "workspace.recovery.restore.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(true);
    }
    for (const type of [
      "status",
      "agent_update",
      "agent_stream",
      "send_agent_message_response",
      "workspace.recovery.restore.response",
    ] as const) {
      expect(authorization.allowsOutbound(outboundMessage(type))).toBe(true);
    }
    for (const type of [
      "restart_server_request",
      "terminal_input",
      "hub.management.daemon.permissions.update.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(false);
    }
    expect(
      authorization.allowsOutbound({
        type: "status",
        payload: { status: "shutdown_requested", clientId: "owner", requestId: "shutdown" },
      }),
    ).toBe(false);
    authorization.replacePermissions([]);
    expect(authorization.allowsInbound(inboundMessage("send_agent_message_request"))).toBe(false);
    expect(authorization.allowsOutbound(outboundMessage("agent_update"))).toBe(false);
  });

  test("correlated authorization errors can always be emitted", () => {
    const authorization = new SessionAuthorization([]);

    expect(authorization.allowsOutbound(outboundMessage("rpc_error"))).toBe(true);
  });

  test("legacy Hub authority is translated at one compatibility boundary", () => {
    expect(permissionsForLegacyHubScopes(["hub.execution.*"])).toEqual(["hub.execute"]);
    expect(permissionsForLegacyHubScopes(["*"])).toEqual([]);
  });

  test("permission names are semantic", () => {
    expect(
      DAEMON_PERMISSIONS.every(
        (permission) => !permission.includes("*") && !permission.includes("request"),
      ),
    ).toBe(true);
  });

  test("permission parsing validates against the shared registry and removes duplicates", () => {
    expect(parseDaemonPermissions(["hub.execute", "hub.execute"])).toEqual(["hub.execute"]);
    expect(() => parseDaemonPermissions(["hub.execution.*"])).toThrow("Invalid daemon permission");
  });
});
