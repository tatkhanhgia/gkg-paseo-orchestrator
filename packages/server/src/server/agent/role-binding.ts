import { createHash } from "node:crypto";
import {
  isProviderRoleBindingSupportedForRole,
  PaseoRoleIdSchema,
  RoleBindingReceiptSchema,
  type PaseoRoleId,
  type ProviderNativeRoleBindingConfig,
  type ProviderRoleBindingSupport,
  type RoleBindingInjectionMethod,
  type RoleBindingReceipt,
  type WorkspaceProtocolBindingReceipt,
} from "@getpaseo/protocol/role-binding";
import type { RoleProfilePreferences } from "@getpaseo/protocol/role-profile";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type {
  AssignmentAssignerReceipt,
  AssignmentEffectClass,
  AssignmentEnvelope,
} from "@getpaseo/protocol/assignment-contract";
import {
  LEGACY_CORE_POLICY_OWNER,
  PolicyOwnerSchema,
  type PolicyOwner,
} from "@getpaseo/protocol/policy-owner";
import { z } from "zod";

import { ROLE_DEFAULT_TOOLS } from "./role-profiles.js";
import { inspectWorkspaceProtocol } from "../../utils/workspace-protocol-file.js";
import {
  materializeAssignmentContract,
  PersistedAssignmentContractSchema,
} from "./assignment-contract.js";
import type { RoleBindingPolicyContribution } from "../policy/role-binding-policy.js";

export const WORKSPACE_PROTOCOL_ADMISSION_ERROR = "workspace_protocol_admission_required";
export const ASSIGNMENT_CONTRACT_EXPIRED_ERROR = "assignment_contract_expired";

const ExecutionProfileBindingReceiptSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const PersistedRoleBindingSchema = RoleBindingReceiptSchema.extend({
  instructions: z.string().min(1),
  executionProfile: ExecutionProfileBindingReceiptSchema.optional(),
  assignmentContract: PersistedAssignmentContractSchema.optional(),
});

export type PersistedRoleBinding = z.infer<typeof PersistedRoleBindingSchema>;

export function policyOwnerForRoleBinding(
  binding: Pick<PersistedRoleBinding, "policyOwner">,
): PolicyOwner {
  return PolicyOwnerSchema.parse(binding.policyOwner ?? LEGACY_CORE_POLICY_OWNER);
}

export interface MaterializeRoleBindingInput<TExecutionProfileId extends string = string> {
  /** Kernel-owned compatibility callers omit this and remain legacy-core. */
  policyOwner?: PolicyOwner;
  roleId: PaseoRoleId;
  executionProfileId?: TExecutionProfileId;
  provider: string;
  providerBaseId?: string | null;
  providerSupport?: ProviderRoleBindingSupport;
  cwd: string;
  workspaceId: string;
  assignment?: AssignmentEnvelope;
  assignmentAssigner: AssignmentAssignerReceipt;
  roleProfilePreferences?: RoleProfilePreferences;
  createdAt?: Date;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveProviderFamily(provider: string, providerBaseId?: string | null): string {
  return providerBaseId ?? provider;
}

function commandBasename(command: string): string {
  return command.split(/[\\/]/u).at(-1) ?? command;
}

function resolveBuiltInRoleBindingSupport(family: string): ProviderRoleBindingSupport | null {
  if (family === "mock") {
    return {
      status: "supported",
      injectionMethod: "mock-launch-context",
      notice: "Development-only synthetic provider; role instructions are bound at session launch.",
    };
  }
  const injectionMethods: Partial<Record<string, RoleBindingInjectionMethod>> = {
    codex: "codex-developer-instructions",
    claude: "claude-system-prompt",
    pi: "pi-before-agent-start",
    omp: "omp-append-system-prompt",
  };
  const injectionMethod = injectionMethods[family];
  return injectionMethod ? { status: "supported", injectionMethod } : null;
}

function commandMatchesExecutable(
  command: readonly string[] | undefined,
  names: readonly string[],
): boolean {
  const executable = command?.[0] ? commandBasename(command[0]) : null;
  return executable !== null && names.includes(executable);
}

function resolveCursorACPRoleBindingSupport(
  command: readonly string[] | undefined,
): ProviderRoleBindingSupport {
  const acpCommandCount = command?.filter((argument) => argument === "acp").length ?? 0;
  const hasCallerWorkspace =
    command?.some(
      (argument) => argument === "--workspace" || argument.startsWith("--workspace="),
    ) ?? false;
  const hasCallerPermissionPolicy =
    command?.some(
      (argument) =>
        argument === "-f" ||
        argument === "--force" ||
        argument === "--yolo" ||
        argument === "--auto-review" ||
        argument === "--approve-mcps" ||
        argument === "--trust" ||
        argument === "--mode" ||
        argument.startsWith("--mode=") ||
        argument === "--sandbox" ||
        argument.startsWith("--sandbox="),
    ) ?? false;
  if (
    !commandMatchesExecutable(command, ["cursor-agent", "cursor-agent.exe"]) ||
    acpCommandCount !== 1 ||
    hasCallerWorkspace ||
    hasCallerPermissionPolicy
  ) {
    return {
      status: "unsupported",
      reason:
        "Cursor native role binding requires exact 'cursor-agent ... acp' launch without caller-supplied workspace or permission-policy flags",
    };
  }
  return {
    status: "supported",
    injectionMethod: "cursor-project-rule-capsule",
  };
}

function resolveAntigravityNativeRoleBindingSupport(
  command: readonly string[] | undefined,
  hasPaseoToolTransport?: boolean,
): ProviderRoleBindingSupport {
  if (process.platform === "win32") {
    return {
      status: "unsupported",
      reason: "Antigravity native role binding is not implemented on Windows",
      roleIds: ["peer"],
    };
  }
  const isNativeCommand =
    commandMatchesExecutable(command, ["agy", "agy.exe"]) && command?.length === 1;
  if (!isNativeCommand) {
    return {
      status: "unsupported",
      reason: "Antigravity native role binding requires the exact command ['agy']",
      roleIds: ["peer"],
    };
  }
  if (hasPaseoToolTransport === false) {
    return {
      status: "unsupported",
      reason:
        "The current Antigravity runtime has no qualified native Paseo-tool transport for the mandatory Beads checkpoint",
      roleIds: ["peer"],
    };
  }
  return {
    status: "supported",
    injectionMethod: "antigravity-custom-agent",
    roleIds: ["peer"],
    notice:
      "Antigravity uses the official native AGY CLI with a caller-scoped Paseo command gateway and has a Peer-only eligibility ceiling.",
  };
}

function resolveConfiguredACPRoleBindingSupport(
  nativeRoleBinding: ProviderNativeRoleBindingConfig | undefined,
  command: readonly string[] | undefined,
): ProviderRoleBindingSupport | null {
  if (nativeRoleBinding?.driver === "cursor-plugin") {
    return {
      status: "unsupported",
      reason:
        "The cursor-plugin role driver is retired because Cursor may silently ignore local plugins. Remove it or use cursor-workspace-rule.",
    };
  }
  if (nativeRoleBinding?.driver === "cursor-workspace-rule") {
    return resolveCursorACPRoleBindingSupport(command);
  }
  if (commandMatchesExecutable(command, ["cursor-agent", "cursor-agent.exe"])) {
    return resolveCursorACPRoleBindingSupport(command);
  }
  return null;
}

// COMPAT(legacyProviderRoleDetection): fail-closed migration guard only. Delete after
// 2026-09-30 together with Foundation legacy role-link inventory; no installer creates these.
export const LEGACY_PROVIDER_ROLE_DETECTION_EXPIRES_AT = "2026-09-30";

export function detectLegacyProviderRole(
  command: readonly string[] | undefined,
): PaseoRoleId | null {
  if (!command || command.length < 2) return null;

  const executable = commandBasename(command[0]);
  if (
    [
      "codex-profile",
      "codex-profile.py",
      "codex-cliproxy-profile",
      "codex-cliproxy-profile.py",
      "omp-role",
    ].includes(executable)
  ) {
    const parsed = PaseoRoleIdSchema.safeParse(command[1]);
    return parsed.success ? parsed.data : null;
  }

  if (executable === "claude" || executable === "claude.exe") {
    const agentFlag = command.indexOf("--agent");
    const agentName = agentFlag >= 0 ? command[agentFlag + 1] : undefined;
    const match = agentName?.match(/^paseo-(lead|peer|supervisor)$/u);
    if (match) {
      return PaseoRoleIdSchema.parse(match[1]);
    }
  }

  return null;
}

export function resolveProviderRoleBindingSupport(
  provider: string,
  providerBaseId?: string | null,
  legacyRoleId?: PaseoRoleId | null,
  nativeRoleBinding?: ProviderNativeRoleBindingConfig,
  command?: readonly string[],
  hasPaseoToolTransport?: boolean,
): ProviderRoleBindingSupport {
  if (legacyRoleId) {
    return {
      status: "unsupported",
      reason:
        `Legacy provider transport is already pinned to Paseo role '${legacyRoleId}'. ` +
        "Use a transport-only provider in the native role-first flow.",
    };
  }
  const family = resolveProviderFamily(provider, providerBaseId);
  if (family === "gemini-antigravity") {
    return resolveAntigravityNativeRoleBindingSupport(command ?? ["agy"], hasPaseoToolTransport);
  }
  const builtInSupport = resolveBuiltInRoleBindingSupport(family);
  if (builtInSupport) return builtInSupport;
  const configuredSupport = resolveConfiguredACPRoleBindingSupport(nativeRoleBinding, command);
  if (configuredSupport) return configuredSupport;
  return {
    status: "unsupported",
    reason: `Provider family '${family}' has no qualified native durable role-instruction channel`,
  };
}

function requireWorkspaceProtocol(
  cwd: string,
  readership: WorkspaceProtocolBindingReceipt["readership"],
  allowMissing: boolean,
): WorkspaceProtocolBindingReceipt {
  const snapshot = inspectWorkspaceProtocol(cwd);
  if (snapshot.status === "missing") {
    if (!allowMissing) {
      throw new Error(`${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: missing: ${snapshot.path}`);
    }
    return {
      status: "missing",
      readership,
      path: snapshot.path,
    };
  }
  if (snapshot.status !== "valid") {
    const details =
      snapshot.status === "invalid" && snapshot.issues.length > 0
        ? `; issues=${snapshot.issues.join(",")}`
        : "";
    throw new Error(
      `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: ${snapshot.status}: ${snapshot.path}${details}`,
    );
  }
  return {
    status: "bound",
    readership,
    path: snapshot.path,
    digest: snapshot.revision.sha256,
  };
}

/** Kernel-owned, read-only admission check used before workspace provisioning. */
export function preflightWorkspaceProtocolAdmission(input: {
  cwd: string;
  readership: WorkspaceProtocolBindingReceipt["readership"];
  assignment: AssignmentEnvelope;
}): void {
  const performsMaterialWork =
    input.assignment.mutationBoundary.mode !== "no-write" ||
    input.assignment.externalEffectBoundary.mode !== "denied";
  requireWorkspaceProtocol(
    input.cwd,
    input.readership,
    input.assignment.protocolException !== undefined || !performsMaterialWork,
  );
}

export async function materializeRoleBindingWithPolicy<TExecutionProfileId extends string>(
  input: MaterializeRoleBindingInput<TExecutionProfileId>,
  policy: RoleBindingPolicyContribution<TExecutionProfileId>,
): Promise<PersistedRoleBinding> {
  const support =
    input.providerSupport ??
    resolveProviderRoleBindingSupport(input.provider, input.providerBaseId);
  if (support.roleIds && !support.roleIds.includes(input.roleId)) {
    throw new Error(
      `Provider '${input.provider}' cannot bind Paseo role '${input.roleId}': provider eligibility is limited to role(s): ${support.roleIds.join(", ")}`,
    );
  }
  if (support.status === "unsupported") {
    throw new Error(
      `Provider '${input.provider}' cannot bind Paseo role '${input.roleId}': ${support.reason}`,
    );
  }
  if (!isProviderRoleBindingSupportedForRole(support, input.roleId)) {
    throw new Error(
      `Provider '${input.provider}' cannot bind Paseo role '${input.roleId}': provider eligibility is limited to role(s): ${support.roleIds?.join(", ") ?? "none"}`,
    );
  }

  const createdAt = input.createdAt ?? new Date();
  const validatedAssignment = policy.preflight({
    roleId: input.roleId,
    executionProfileId: input.executionProfileId,
    assignment: input.assignment,
    createdAt,
  });
  const assignmentContract = materializeAssignmentContract({
    roleId: input.roleId,
    assigner: input.assignmentAssigner,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    envelope: validatedAssignment,
    createdAt,
  });
  const definition = policy.getRoleDefinition(input.roleId);
  const roleProfile = policy.materializeRoleProfile(
    input.roleId,
    input.roleProfilePreferences,
    assignmentContract.envelope.effectClass,
  );
  const executionProfile = input.executionProfileId
    ? policy.getExecutionProfile(input.executionProfileId)
    : null;
  if (executionProfile && executionProfile.authorityRoleId !== input.roleId) {
    throw new Error(
      `Execution profile '${executionProfile.id}' requires role '${executionProfile.authorityRoleId}'`,
    );
  }
  // Graduated admission: a missing protocol blocks material work, not every role launch.
  // Read-only work with no external effects proceeds and reports that bootstrap is owed;
  // any write scope or external effect requires a bound protocol or an exact Human exception.
  // An invalid protocol always fails closed, because absence is a gap while corruption is a
  // contradiction we must not silently reinterpret.
  const envelope = assignmentContract.envelope;
  const hasProtocolException = envelope.protocolException !== undefined;
  const performsMaterialWork =
    envelope.mutationBoundary.mode !== "no-write" ||
    envelope.externalEffectBoundary.mode !== "denied";
  const workspaceProtocol = requireWorkspaceProtocol(
    input.cwd,
    policy.workspaceProtocolReadership(input.roleId),
    hasProtocolException || !performsMaterialWork,
  );
  const instructions = policy.composeInstructions({
    definition,
    executionProfile,
    workspaceProtocol,
    hasProtocolException,
    assignmentContract,
    roleProfile,
  });

  return {
    policyOwner: PolicyOwnerSchema.parse(input.policyOwner ?? LEGACY_CORE_POLICY_OWNER),
    roleId: input.roleId,
    definitionVersion: definition.version,
    definitionDigest: sha256(definition.instructions),
    bindingDigest: sha256(instructions),
    provider: input.provider,
    injectionMethod: support.injectionMethod,
    qualification: "implementation-supported",
    workspaceProtocol,
    assignment: assignmentContract.receipt,
    roleProfile,
    assignmentContract,
    createdAt: createdAt.toISOString(),
    instructions,
    ...(executionProfile
      ? {
          executionProfile: {
            id: executionProfile.id,
            version: executionProfile.version,
            definitionDigest: policy.executionProfileDefinitionDigest(executionProfile),
          },
        }
      : {}),
  };
}

export function toRoleBindingReceipt(binding: PersistedRoleBinding): RoleBindingReceipt {
  return RoleBindingReceiptSchema.parse(binding);
}

function assertAdmissionTimestampCurrent(
  value: string | undefined,
  now: Date,
  field: "expiresAt" | "protocolExceptionExpiresAt",
): void {
  if (value !== undefined && Date.parse(value) <= now.getTime()) {
    throw new Error(`${ASSIGNMENT_CONTRACT_EXPIRED_ERROR}: ${field}=${value}`);
  }
}

/** Revalidate only the persisted assignment timestamps at a late dispatch boundary. */
export function assertPersistedAssignmentCurrent(
  binding: Pick<PersistedRoleBinding, "assignment">,
  now = new Date(),
): void {
  assertAdmissionTimestampCurrent(binding.assignment?.expiresAt, now, "expiresAt");
  assertAdmissionTimestampCurrent(
    binding.assignment?.protocolExceptionExpiresAt,
    now,
    "protocolExceptionExpiresAt",
  );
}

/** Revalidate drift-prone authority receipts before every role-bound create or resume. */
export function assertPersistedRoleAdmissionCurrent(
  binding: PersistedRoleBinding,
  cwd: string,
  now = new Date(),
): void {
  assertPersistedAssignmentCurrent(binding, now);

  const current = inspectWorkspaceProtocol(cwd);
  if (binding.workspaceProtocol.path !== current.path) {
    throw new Error(
      `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: path_changed: bound=${binding.workspaceProtocol.path}; current=${current.path}`,
    );
  }

  if (binding.workspaceProtocol.status === "bound") {
    if (current.status !== "valid") {
      const issues = current.status === "invalid" ? `; issues=${current.issues.join(",")}` : "";
      throw new Error(
        `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: ${current.status}: ${current.path}${issues}`,
      );
    }
    if (
      !binding.workspaceProtocol.digest ||
      binding.workspaceProtocol.digest !== current.revision.sha256
    ) {
      throw new Error(
        `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: stale_digest: ${current.path}; bound=${binding.workspaceProtocol.digest ?? "missing"}; current=${current.revision.sha256}`,
      );
    }
    return;
  }

  if (current.status !== "missing") {
    let details: string = current.status;
    if (current.status === "valid") {
      details = "protocol_now_present";
    } else if (current.status === "invalid" && current.issues.length > 0) {
      details = `${current.status}; issues=${current.issues.join(",")}`;
    }
    throw new Error(`${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: ${details}: ${current.path}`);
  }

  const assignment = binding.assignment;
  if (!assignment) {
    throw new Error(
      `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: missing_protocol_requires_current_assignment: ${current.path}`,
    );
  }
  const performsMaterialWork =
    assignment.mutationBoundary.mode !== "no-write" ||
    assignment.externalEffectBoundary.mode !== "denied";
  if (performsMaterialWork && !assignment.protocolExceptionExpiresAt) {
    throw new Error(
      `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: missing_protocol_blocks_material_assignment: ${current.path}`,
    );
  }
}

function intersectRoleTools(
  tools: readonly string[],
  providerPolicy: ProviderPaseoToolsPolicy | undefined,
): string[] {
  let roleTools = [...tools];
  if (providerPolicy?.allowedTools) {
    const providerAllowed = new Set(providerPolicy.allowedTools);
    roleTools = roleTools.filter((tool) => providerAllowed.has(tool));
  }
  if (providerPolicy?.disabledTools) {
    const providerDisabled = new Set(providerPolicy.disabledTools);
    roleTools = roleTools.filter((tool) => !providerDisabled.has(tool));
  }
  return roleTools;
}

const PEER_MUTATING_BEADS_TOOLS = new Set([
  "beads_create",
  "beads_claim",
  "beads_update",
  "beads_add_dependency",
]);

function projectRoleToolsForAssignment(
  roleId: PaseoRoleId,
  tools: readonly string[],
  assignmentEffectClass: AssignmentEffectClass | undefined,
): string[] {
  if (roleId !== "peer" || assignmentEffectClass !== "read-only") {
    return [...tools];
  }
  return tools.filter((tool) => !PEER_MUTATING_BEADS_TOOLS.has(tool));
}

export function applyRolePaseoToolPolicy(
  roleId: PaseoRoleId | undefined,
  providerPolicy: ProviderPaseoToolsPolicy | undefined,
  roleAllowedTools?: readonly string[],
  assignmentEffectClass?: AssignmentEffectClass,
): ProviderPaseoToolsPolicy | undefined {
  if (!roleId) {
    return providerPolicy;
  }
  // Plugin-owned bindings already carry their immutable selected tools. Do not
  // reinterpret them through the currently active generation: reload must not
  // drift an existing agent. The default is compatibility-only for old records.
  const selected = roleAllowedTools ? [...roleAllowedTools] : ROLE_DEFAULT_TOOLS[roleId];
  return {
    enabled: true,
    allowedTools: intersectRoleTools(
      projectRoleToolsForAssignment(roleId, selected, assignmentEffectClass),
      providerPolicy,
    ),
  };
}

export function assertPersistedRoleBindingMatches(
  binding: PersistedRoleBinding,
  provider: string,
): void {
  if (binding.provider !== provider) {
    throw new Error(
      `Persisted role binding provider '${binding.provider}' does not match session provider '${provider}'`,
    );
  }
}

export function expectedInjectionMethod(
  provider: string,
  providerBaseId?: string | null,
): RoleBindingInjectionMethod | null {
  const support = resolveProviderRoleBindingSupport(provider, providerBaseId);
  return support.status === "supported" ? support.injectionMethod : null;
}
