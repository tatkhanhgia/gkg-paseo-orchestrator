import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

import type { RoleBindingPolicyContribution } from "../../role-binding-policy.js";

/** Role-keyed standing instructions appended after the composed role instructions. */
export type SlpRoleInstructionMandates = Readonly<Partial<Record<PaseoRoleId, string>>>;

const TEST_VALUE_MANDATE =
  "Test proof mandate: when writing, changing, or reviewing tests, load the `test-value` skill first and follow it. The handback includes the skill's five gate answers for every added or changed test. Do not delete, merge, or demote tests outside the assigned scope. When delegating work that touches tests, carry this requirement into the delegate's assignment. If `test-value` is unavailable in this runtime, say so in the handback instead of substituting another rubric.";

/**
 * Standing test-proof mandate for the two roles that write and review tests. The skill itself stays
 * user-global (single source of truth outside the Foundation bundle), so this names it without
 * embedding its bytes. Supervisor is excluded: its Foundation bundle already carries
 * `test-proof-debt-audit`, and a second proof rubric would give it two verdict vocabularies.
 *
 * This table is part of the canonical SLP artifact (see `canonicalSlpArtifactBytes` in slp.ts), so
 * editing any entry changes the generation identity instead of changing composition under an old one.
 */
export const SLP_ROLE_INSTRUCTION_MANDATES: SlpRoleInstructionMandates = {
  lead: TEST_VALUE_MANDATE,
  peer: TEST_VALUE_MANDATE,
};

/**
 * Wraps a role-binding policy so each role's mandate follows its composed instructions. The wrapped
 * policy module stays byte-identical to what retained generations were qualified against; only the
 * active generation uses the wrapper.
 */
export function withRoleInstructionMandates(
  policy: RoleBindingPolicyContribution<string>,
  mandates: SlpRoleInstructionMandates,
): RoleBindingPolicyContribution<string> {
  return {
    ...policy,
    composeInstructions(input) {
      const composed = policy.composeInstructions(input);
      const mandate = mandates[input.definition.id];
      return mandate ? `${composed}\n\n${mandate}` : composed;
    },
  };
}
