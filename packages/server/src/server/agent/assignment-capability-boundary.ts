import type { RoleBindingInjectionMethod } from "@getpaseo/protocol/role-binding";
import { noWriteModeForRoleBindingInjectionMethod } from "@getpaseo/protocol/provider-manifest";

import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import type { PersistedRoleBinding } from "./role-binding.js";
import { ROLE_TOOL_CEILINGS } from "../policy/bundled/slp/role-profiles.js";

export const ASSIGNMENT_CAPABILITY_BOUNDARY_ERROR = "assignment_capability_boundary_required";

// Claude plan mode injects a planning workflow that tells the model to avoid
// every state-changing call, including exact daemon-preapproved Paseo Room
// coordination. The adapter enforces no-write independently with a strict
// built-in tools allowlist plus explicit write-tool denies, so pin the
// guarded default mode and keep the model out of the Plan workflow. This
// mapping is the enforcement source of truth; it is projected verbatim from
// `@getpaseo/protocol/provider-manifest` so client draft/live mode UI cannot
// silently disagree with it.
export function noWriteModeForInjectionMethod(
  injectionMethod: RoleBindingInjectionMethod,
): string | null {
  return noWriteModeForRoleBindingInjectionMethod(injectionMethod);
}

function requiresTechnicalNoWrite(roleBinding: PersistedRoleBinding | undefined): boolean {
  return roleBinding?.assignment?.mutationBoundary.mode === "no-write";
}

export function requiredNoWriteMode(roleBinding: PersistedRoleBinding | undefined): string | null {
  if (!roleBinding || !requiresTechnicalNoWrite(roleBinding)) {
    return null;
  }
  const modeId = noWriteModeForInjectionMethod(roleBinding.injectionMethod);
  if (!modeId) {
    throw new Error(
      `${ASSIGNMENT_CAPABILITY_BOUNDARY_ERROR}: provider injection '${roleBinding.injectionMethod}' has no qualified no-write mode for ${roleBinding.roleId} assignment`,
    );
  }
  return modeId;
}

export function enforceRoleAssignmentCapability(
  config: AgentSessionConfig,
  roleBinding: PersistedRoleBinding | undefined,
): AgentSessionConfig {
  const modeId = requiredNoWriteMode(roleBinding);
  if (!modeId) {
    return config;
  }
  const disablesAutoAccept =
    roleBinding?.injectionMethod === "cursor-project-rule-capsule" ||
    roleBinding?.injectionMethod === "cursor-always-apply-plugin";
  return {
    ...config,
    modeId,
    ...(disablesAutoAccept
      ? {
          featureValues: {
            ...config.featureValues,
            auto_accept: false,
          },
        }
      : {}),
  };
}

export function assertRoleAssignmentModeAllowed(
  roleBinding: PersistedRoleBinding | undefined,
  requestedModeId: string,
): void {
  const requiredModeId = requiredNoWriteMode(roleBinding);
  if (requiredModeId && requestedModeId !== requiredModeId) {
    throw new Error(
      `${ASSIGNMENT_CAPABILITY_BOUNDARY_ERROR}: no-write ${roleBinding?.roleId ?? "role"} assignment is pinned to provider mode '${requiredModeId}'`,
    );
  }
}

export function assertRoleAssignmentPermissionResponseAllowed(
  roleBinding: PersistedRoleBinding | undefined,
  response: AgentPermissionResponse,
  request?: AgentPermissionRequest,
  context: { onlyRuntimePaseoMcp?: boolean } = {},
): void {
  const isExactCursorPaseoToolConsent = (() => {
    if (
      roleBinding?.injectionMethod !== "cursor-project-rule-capsule" &&
      roleBinding?.injectionMethod !== "cursor-always-apply-plugin"
    ) {
      return false;
    }
    if (request?.kind !== "tool") return false;
    const admittedTools =
      roleBinding.roleProfile?.allowedTools ?? ROLE_TOOL_CEILINGS[roleBinding.roleId];
    return admittedTools.some((toolName) => {
      const exactTransportName = `paseo-${toolName}`;
      return request.name === exactTransportName || request.title === exactTransportName;
    });
  })();
  const isRoleScopedOpaqueCursorPaseoConsent =
    (roleBinding?.injectionMethod === "cursor-project-rule-capsule" ||
      roleBinding?.injectionMethod === "cursor-always-apply-plugin") &&
    request?.kind === "tool" &&
    request.metadata?.transportShadow === "cursor-opaque-mcp" &&
    context.onlyRuntimePaseoMcp === true;
  const isQuestionResponse = request?.kind === "question";
  if (
    requiresTechnicalNoWrite(roleBinding) &&
    response.behavior === "allow" &&
    !isQuestionResponse &&
    !isExactCursorPaseoToolConsent &&
    !isRoleScopedOpaqueCursorPaseoConsent
  ) {
    throw new Error(
      `${ASSIGNMENT_CAPABILITY_BOUNDARY_ERROR}: no-write ${roleBinding?.roleId ?? "role"} assignment cannot approve a permission escalation`,
    );
  }
}
