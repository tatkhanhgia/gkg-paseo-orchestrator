import { PASEO_ASSIGNMENT_CONTRACT_VERSION } from "@getpaseo/protocol/assignment-contract";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import { PASEO_ROLE_CONTRACT_VERSION, PASEO_ROLE_IDS } from "@getpaseo/protocol/role-binding";
import type { PolicyOwner } from "@getpaseo/protocol/policy-owner";
import type {
  RoleProfileCatalog,
  RoleProfilePreferencesMap,
} from "@getpaseo/protocol/role-profile";

import {
  FOUNDATION_EXECUTION_PROFILE_IDS,
  getFoundationExecutionProfileDefinition,
  SLP_EXECUTION_PROFILE_POLICY,
  SLP_EXECUTION_PROFILE_POLICY_VERSION,
} from "./slp/execution-profiles.js";
import { getFoundationRoleDefinition } from "./slp/role-definitions.js";
import {
  materializeRoleBindingWithPolicy,
  type MaterializeRoleBindingInput,
  type PersistedRoleBinding,
} from "../../agent/role-binding.js";
import {
  buildRoleProfileCatalog,
  ROLE_DEFAULT_TOOLS,
  ROLE_PROFILE_POLICY_VERSION,
  ROLE_TOOL_CEILINGS,
} from "./slp/role-profiles.js";
import { buildFoundationSkillArtifactDescriptor } from "./slp/skill-policy.js";
import { buildHarnessPackageArtifactDescriptor } from "./slp/harness-package-policy.js";
import {
  BundledPolicyPackRegistry,
  type BundledPolicyPackGeneration,
} from "../bundled-policy-pack.js";
import { SLP_ROLE_BINDING_POLICY } from "./slp/role-binding-policy.js";
import { SLP_COUNCIL_POLICY, SLP_COUNCIL_POLICY_VERSION } from "./slp/council-policy.js";
import {
  SLP_COORDINATION_POLICY,
  SLP_COORDINATION_POLICY_VERSION,
} from "./slp/coordination-policy.js";
import type { RETAINED_SLP_COORDINATION_POLICY_V5 } from "./slp/retained-coordination-policy-v5.js";
import { SLP_CHECKPOINT_POLICY, SLP_CHECKPOINT_POLICY_VERSION } from "./slp/checkpoint-policy.js";
import {
  SLP_ATTENTION_EVENT_POLICY,
  SLP_ATTENTION_POLICY_VERSION,
} from "./slp/attention-policy.js";
import {
  SLP_LIFECYCLE_ATTENTION_EVENT_POLICY,
  SLP_LIFECYCLE_ATTENTION_POLICY_VERSION,
} from "./slp/lifecycle-attention-policy.js";
import { SLP_FINISH_NOTIFICATION_POLICY_VERSION } from "./slp/finish-notification-policy.js";
import { registerRetainedSlpGenerations } from "./slp/retained-generations.js";
import type { AgentEventPolicy } from "../../agent/event-policy-runtime.js";
import type { TrustedPolicyContribution } from "../trusted-policy.js";
import type { RoleBindingPolicyContribution } from "../role-binding-policy.js";

export const SLP_BUNDLED_POLICY_VERSION = "1.4.0";

type PluginPolicyOwner = Extract<PolicyOwner, { kind: "plugin" }>;

export interface SlpBundledPolicyContribution extends TrustedPolicyContribution {
  roleBindingPolicy: RoleBindingPolicyContribution<string>;
  councilPolicy: typeof SLP_COUNCIL_POLICY;
  /**
   * Live current coordination semantics, or a frozen prior-generation fork (see
   * retained-generations.ts) reused verbatim so a pinned old generation keeps its exact
   * qualified authority instead of drifting onto current semantics.
   */
  coordinationPolicy: typeof SLP_COORDINATION_POLICY | typeof RETAINED_SLP_COORDINATION_POLICY_V5;
  checkpointPolicy: typeof SLP_CHECKPOINT_POLICY;
  eventPolicies: readonly AgentEventPolicy[];
  executionProfilePolicy: typeof SLP_EXECUTION_PROFILE_POLICY;
  buildRoleProfileCatalog(preferences: RoleProfilePreferencesMap): RoleProfileCatalog;
  workspaceProtocolReadership(
    roleId: MaterializeRoleBindingInput["roleId"],
  ): "full" | "assignment-only" | "governance-only";
  preflightRoleBinding(input: {
    roleId: MaterializeRoleBindingInput["roleId"];
    executionProfileId?: MaterializeRoleBindingInput["executionProfileId"];
    assignment?: MaterializeRoleBindingInput["assignment"];
  }): AssignmentEnvelope;
  materializeRoleBinding(
    input: MaterializeRoleBindingInput,
    owner: PluginPolicyOwner,
  ): Promise<PersistedRoleBinding>;
}

function canonicalSlpArtifactBytes(overrides: { coordinationPolicyVersion?: string } = {}): string {
  return JSON.stringify({
    manifest: { id: "slp", abiVersion: 1, policyVersion: SLP_BUNDLED_POLICY_VERSION },
    roleContractVersion: PASEO_ROLE_CONTRACT_VERSION,
    assignmentContractVersion: PASEO_ASSIGNMENT_CONTRACT_VERSION,
    roles: PASEO_ROLE_IDS.map((roleId) => getFoundationRoleDefinition(roleId)),
    executionProfiles: FOUNDATION_EXECUTION_PROFILE_IDS.map((profileId) =>
      getFoundationExecutionProfileDefinition(profileId),
    ),
    roleToolCeilings: ROLE_TOOL_CEILINGS,
    roleDefaultTools: ROLE_DEFAULT_TOOLS,
    roleProfilePolicyVersion: ROLE_PROFILE_POLICY_VERSION,
    executionProfilePolicyVersion: SLP_EXECUTION_PROFILE_POLICY_VERSION,
    councilPolicyVersion: SLP_COUNCIL_POLICY_VERSION,
    coordinationPolicyVersion:
      overrides.coordinationPolicyVersion ?? SLP_COORDINATION_POLICY_VERSION,
    attentionPolicyVersion: SLP_ATTENTION_POLICY_VERSION,
    checkpointPolicyVersion: SLP_CHECKPOINT_POLICY_VERSION,
    lifecycleAttentionPolicyVersion: SLP_LIFECYCLE_ATTENTION_POLICY_VERSION,
    finishNotificationPolicyVersion: SLP_FINISH_NOTIFICATION_POLICY_VERSION,
    skills: buildFoundationSkillArtifactDescriptor(),
    harness: buildHarnessPackageArtifactDescriptor(),
  });
}

/**
 * Drift guard for retained-generations.ts: recomputes the canonical artifact bytes from
 * *current* source with only `coordinationPolicyVersion` swapped to a historical value. A
 * retained generation reuses live imports (roles, execution profiles, tool ceilings, skill and
 * harness descriptors) for every field except coordinationPolicy, on the proven-today premise
 * that those fields are still byte-identical to what the retained generation's frozen fixture
 * recorded. If a later source change (e.g. role-definitions content) invalidates that premise,
 * this function's output silently stops matching the frozen fixture bytes; the caller in
 * retained-generations.ts compares the two and fails that one retained owner closed instead of
 * serving drifted (current) behavior mislabeled under the old owner digest.
 */
export function buildCanonicalSlpArtifactBytesForCoordinationVersion(
  coordinationPolicyVersion: string,
): string {
  return canonicalSlpArtifactBytes({ coordinationPolicyVersion });
}

export interface CreateSlpBundledPolicyRegistryOptions {
  registry?: BundledPolicyPackRegistry<SlpBundledPolicyContribution>;
}

export function createDefaultSlpBundledPolicyRegistry(
  options: CreateSlpBundledPolicyRegistryOptions = {},
): BundledPolicyPackRegistry<SlpBundledPolicyContribution> {
  return populateSlpBundledPolicyRegistry(options, false);
}

/**
 * Shared contribution builder reused by both the current (active) generation and any
 * generation-pinned override (see retained-generations.ts) that must swap in a frozen
 * historical policy piece for exactly one field while keeping the rest identical.
 */
export function buildDefaultSlpBundledPolicyContribution(): SlpBundledPolicyContribution {
  return {
    roleBindingPolicy: SLP_ROLE_BINDING_POLICY,
    councilPolicy: SLP_COUNCIL_POLICY,
    coordinationPolicy: SLP_COORDINATION_POLICY,
    checkpointPolicy: SLP_CHECKPOINT_POLICY,
    eventPolicies: [SLP_ATTENTION_EVENT_POLICY, SLP_LIFECYCLE_ATTENTION_EVENT_POLICY],
    executionProfilePolicy: SLP_EXECUTION_PROFILE_POLICY,
    buildRoleProfileCatalog,
    workspaceProtocolReadership: (roleId) =>
      SLP_ROLE_BINDING_POLICY.workspaceProtocolReadership(roleId),
    preflightRoleBinding: (input) => {
      const executionProfileId = input.executionProfileId
        ? SLP_EXECUTION_PROFILE_POLICY.parseId(input.executionProfileId)
        : undefined;
      return SLP_ROLE_BINDING_POLICY.preflight({
        roleId: input.roleId,
        assignment: input.assignment,
        ...(executionProfileId ? { executionProfileId } : {}),
      });
    },
    materializeRoleBinding: (input, owner) =>
      materializeRoleBindingWithPolicy(
        {
          ...input,
          policyOwner: owner,
          ...(input.executionProfileId
            ? {
                executionProfileId: SLP_EXECUTION_PROFILE_POLICY.parseId(input.executionProfileId),
              }
            : {}),
        },
        SLP_ROLE_BINDING_POLICY,
      ),
  };
}

function registerDefaultSlpGeneration(
  registry: BundledPolicyPackRegistry<SlpBundledPolicyContribution>,
): BundledPolicyPackGeneration<SlpBundledPolicyContribution> {
  const generation: BundledPolicyPackGeneration<SlpBundledPolicyContribution> =
    registry.registerGeneration({
      manifest: {
        id: "slp",
        abiVersion: 1,
        policyVersion: SLP_BUNDLED_POLICY_VERSION,
      },
      artifactBytes: canonicalSlpArtifactBytes(),
      contribution: buildDefaultSlpBundledPolicyContribution(),
    });
  return generation;
}

function populateSlpBundledPolicyRegistry(
  options: CreateSlpBundledPolicyRegistryOptions,
  failClosedActive: boolean,
): BundledPolicyPackRegistry<SlpBundledPolicyContribution> {
  const registry =
    options.registry ?? new BundledPolicyPackRegistry<SlpBundledPolicyContribution>();
  let activeGeneration: BundledPolicyPackGeneration<SlpBundledPolicyContribution> | undefined;
  try {
    activeGeneration = registerDefaultSlpGeneration(registry);
  } catch (error) {
    registry.recordLoadFailure("slp", error);
    if (!failClosedActive) throw error;
  }
  if (activeGeneration) {
    try {
      registry.activate(activeGeneration.owner);
    } catch (error) {
      registry.recordLoadFailure("slp", error);
      if (!failClosedActive) throw error;
    }
  }
  // Register (never activate) exactly the immediately-preceding qualified generation so a
  // resume bound to it can still resolvePinned. Failure here must never block or replace
  // current-generation activation above; a retained-generation failure only means that one
  // specific old owner keeps failing closed, which is the pre-existing behavior for any
  // generation this module does not retain.
  registerRetainedSlpGenerations(registry, {
    policyVersion: SLP_BUNDLED_POLICY_VERSION,
    buildDefaultContribution: buildDefaultSlpBundledPolicyContribution,
    buildArtifactBytesForCoordinationVersion: buildCanonicalSlpArtifactBytesForCoordinationVersion,
  });
  return registry;
}

/** Ordinary non-SLP Paseo remains available while active SLP admission fails closed. */
export function createFailClosedSlpBundledPolicyRegistry(
  options: CreateSlpBundledPolicyRegistryOptions = {},
): BundledPolicyPackRegistry<SlpBundledPolicyContribution> {
  return populateSlpBundledPolicyRegistry(options, true);
}
