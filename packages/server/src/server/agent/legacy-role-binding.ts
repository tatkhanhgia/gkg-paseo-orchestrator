import { LEGACY_CORE_POLICY_OWNER } from "@getpaseo/protocol/policy-owner";

import { SLP_ROLE_BINDING_POLICY } from "../policy/bundled/slp/role-binding-policy.js";
import { SLP_COUNCIL_POLICY } from "../policy/bundled/slp/council-policy.js";
import { SLP_COORDINATION_POLICY } from "../policy/bundled/slp/coordination-policy.js";
import { SLP_CHECKPOINT_POLICY } from "../policy/bundled/slp/checkpoint-policy.js";
import { SLP_EXECUTION_PROFILE_POLICY } from "../policy/bundled/slp/execution-profiles.js";
import {
  materializeRoleBindingWithPolicy,
  type MaterializeRoleBindingInput,
  type PersistedRoleBinding,
} from "./role-binding.js";

/**
 * COMPAT(legacyCoreOperationalPolicy): persisted legacy-core agents keep the
 * release-frozen Council and coordination semantics they were created under.
 * They never borrow the currently active plugin generation.
 */
export const LEGACY_CORE_OPERATIONAL_POLICY = Object.freeze({
  councilPolicy: SLP_COUNCIL_POLICY,
  coordinationPolicy: SLP_COORDINATION_POLICY,
  checkpointPolicy: SLP_CHECKPOINT_POLICY,
  executionProfilePolicy: SLP_EXECUTION_PROFILE_POLICY,
});

/**
 * COMPAT(legacyCoreRoleBinding): historical tests and persisted migration paths
 * may still materialize the pre-plugin owner. New product launches must resolve
 * an active bundled generation and must never call this wrapper.
 */
export function materializeRoleBinding(
  input: MaterializeRoleBindingInput,
): Promise<PersistedRoleBinding> {
  const legacyPolicy = {
    ...SLP_ROLE_BINDING_POLICY,
    materializeHarnessBinding: undefined,
    assertHarnessBindingCurrent: undefined,
  };
  return materializeRoleBindingWithPolicy(
    { ...input, policyOwner: LEGACY_CORE_POLICY_OWNER },
    legacyPolicy,
  );
}
