import { PolicyPluginIdSchema, type PolicyOwner } from "@getpaseo/protocol/policy-owner";

import type { AgentEventPolicy } from "../agent/event-policy-runtime.js";
import {
  materializeRoleBindingWithPolicy,
  type MaterializeRoleBindingInput,
  type PersistedRoleBinding,
} from "../agent/role-binding.js";
import type {
  BundledPolicyPackGeneration,
  BundledPolicyPackRegistry,
} from "./bundled-policy-pack.js";
import type { RoleBindingPolicyContribution } from "./role-binding-policy.js";

type PluginPolicyOwner = Extract<PolicyOwner, { kind: "plugin" }>;

/**
 * The smallest trusted contribution surface consumed by the generic host.
 *
 * A contribution owns role semantics and event meaning. The host still owns
 * provider qualification, assignment/workspace admission, immutable binding
 * persistence, tool intersection, state serialization, and event delivery.
 * This interface is intentionally internal: it is not a public workflow or
 * untrusted plugin ABI.
 */
export interface TrustedPolicyContribution {
  roleBindingPolicy: RoleBindingPolicyContribution<string>;
  eventPolicies: readonly AgentEventPolicy[];
}

export type TrustedPolicyPackGeneration = BundledPolicyPackGeneration<TrustedPolicyContribution>;

export interface TrustedPolicyPackResolver {
  resolveActiveRolePolicy(): TrustedPolicyPackGeneration;
  resolvePinned(owner: PluginPolicyOwner): TrustedPolicyPackGeneration;
  listActive(): readonly TrustedPolicyPackGeneration[];
}

/**
 * Adapt the existing generation registry to the internal host seam. The
 * A single active generation is selected by trusted composition; a deliberately
 * multi-pack test registry may provide an explicit selector. Adding a trusted
 * pack never changes the meaning of an existing SLP owner or silently
 * substitutes SLP for it.
 */
export function createTrustedPolicyPackResolver<
  TContribution extends TrustedPolicyContribution,
>(input: {
  registry: BundledPolicyPackRegistry<TContribution>;
  /** Compatibility selector for deliberately multi-pack test registries. */
  activePluginId?: string;
}): TrustedPolicyPackResolver {
  const activePluginId = input.activePluginId
    ? PolicyPluginIdSchema.parse(input.activePluginId)
    : undefined;
  return {
    resolveActiveRolePolicy: () => {
      if (activePluginId) return input.registry.resolveActive(activePluginId);
      const active = input.registry.listActive();
      if (active.length !== 1) {
        throw new Error(
          `trusted_policy_active_selection_ambiguous: expected exactly one active role-policy generation, found ${active.length}`,
        );
      }
      return active[0]!;
    },
    resolvePinned: (owner) => input.registry.resolvePinned(owner),
    listActive: () => input.registry.listActive(),
  };
}

export async function materializeTrustedRoleBinding(
  generation: TrustedPolicyPackGeneration,
  input: MaterializeRoleBindingInput<string>,
): Promise<PersistedRoleBinding> {
  return materializeRoleBindingWithPolicy(
    {
      ...input,
      policyOwner: generation.owner,
    },
    generation.contribution.roleBindingPolicy,
  );
}
