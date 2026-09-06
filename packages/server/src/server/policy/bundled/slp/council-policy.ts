import {
  CouncilSeatRoleSchema,
  CouncilTierSchema,
  type CouncilSeatRole,
  type CouncilTier,
} from "@getpaseo/protocol/council/types";

import type { FoundationExecutionProfileId } from "./execution-profiles.js";

export const SLP_COUNCIL_POLICY_VERSION = "3";

export interface SlpCouncilSeatPlan {
  role: CouncilSeatRole;
  peerSubrole: CouncilSeatRole;
  executionProfile?: FoundationExecutionProfileId;
  reportStartSentinel: string;
  reportEndSentinel: string;
  labels: Record<string, string>;
}

export function councilReportSentinels(role: CouncilSeatRole): {
  startSentinel: string;
  endSentinel: string;
} {
  const prefix = role.toUpperCase();
  return {
    startSentinel: `${prefix}_COUNCIL_REPORT_V1`,
    endSentinel: `${prefix}_COUNCIL_REPORT_END`,
  };
}

export function validateCouncilSeatRoles(roles: readonly CouncilSeatRole[]): CouncilSeatRole[] {
  const validated = CouncilSeatRoleSchema.array().parse(roles);
  if (new Set(validated).size !== validated.length) {
    throw new Error("Council seat roles must be unique");
  }
  return validated;
}

export const DEFAULT_COUNCIL_TIER: CouncilTier = "debate";

// COMPAT(councilRolesOnlyTier): added in v0.7.0-paseo.57; remove after roles-only Council callers
// migrate to an explicit tier and the supported client floor no longer sends that shape.
const HISTORICAL_ROLES_ONLY_TIER: CouncilTier = "debate-with-proof";

/**
 * Canonical seats each tier may use, per skills/council/SKILL.md "Smallest useful topology":
 * lens/debate use Architect+Reviewer only; debate-with-proof/high-risk add Scout.
 */
const COUNCIL_TIER_ALLOWED_ROLES: Record<CouncilTier, readonly CouncilSeatRole[]> = {
  lens: ["architect", "reviewer"],
  debate: ["architect", "reviewer"],
  "debate-with-proof": ["scout", "architect", "reviewer"],
  "high-risk": ["scout", "architect", "reviewer"],
};

/**
 * Skill-appropriate default seats when a tier is chosen but roles are omitted. `lens` reads as
 * "one Architect ... or one Reviewer" with no single method named as the default, so the
 * policy-owned smallest framing default is a single Architect; an explicit `["reviewer"]` remains
 * a fully valid `lens` choice.
 */
const COUNCIL_TIER_DEFAULT_ROLES: Record<CouncilTier, readonly CouncilSeatRole[]> = {
  lens: ["architect"],
  debate: ["architect", "reviewer"],
  "debate-with-proof": ["scout", "architect", "reviewer"],
  "high-risk": ["scout", "architect", "reviewer"],
};

/**
 * Resolves the tier/seat pair for a Council launch against the pinned owning policy:
 * - both omitted: `debate` with Architect+Reviewer.
 * - roles supplied but tier omitted: the historical implicit `debate-with-proof` tier, so a
 *   pre-existing roles-only caller keeps its exact supplied seats (e.g. a lone Scout, or the old
 *   Scout+Architect+Reviewer triple) instead of being silently moved to the new bare-omission
 *   default or having a supplied seat discarded.
 * - explicit tier, omitted (`undefined`) roles: that tier's skill-appropriate default seats.
 * - explicit roles (including an explicit empty list, which is invalid and distinct from
 *   omission): validated for membership in the resolved tier's canonical seat set and, for
 *   `lens`, for the skill-mandated cardinality of exactly one seat. Explicit seat inputs for other
 *   tiers (e.g. a `debate` launch with only `["reviewer"]`, or a `debate-with-proof` launch
 *   missing Scout) are preserved: this resolver validates membership only and does not infer
 *   additional cardinality rules for tiers the skill does not constrain to a fixed count. A
 *   genuine mismatch fails with a clear reason. Parsing a partial role set preserves input
 *   compatibility only; it does not establish required-method coverage or normal-verdict
 *   sufficiency. The canonical Council record and Lead decision packet remain authoritative.
 */
export function resolveCouncilTierAndRoles(input: {
  tier?: CouncilTier;
  roles?: readonly CouncilSeatRole[];
}): { tier: CouncilTier; roles: CouncilSeatRole[] } {
  const impliedTier =
    input.tier ?? (input.roles !== undefined ? HISTORICAL_ROLES_ONLY_TIER : DEFAULT_COUNCIL_TIER);
  const tier = CouncilTierSchema.parse(impliedTier);

  if (input.roles === undefined) {
    return { tier, roles: [...COUNCIL_TIER_DEFAULT_ROLES[tier]] };
  }

  if (input.roles.length === 0) {
    throw new Error(
      `Council tier '${tier}' requires at least one explicit seat role; omit 'roles' entirely to use the tier's default seats instead of passing an empty list`,
    );
  }

  const roles = validateCouncilSeatRoles(input.roles);
  const allowed = COUNCIL_TIER_ALLOWED_ROLES[tier];
  for (const role of roles) {
    if (!allowed.includes(role)) {
      throw new Error(
        `Council tier '${tier}' does not use seat role '${role}'; allowed roles are ${allowed.join(", ")}`,
      );
    }
  }
  if (tier === "lens" && roles.length !== 1) {
    throw new Error(
      `Council tier 'lens' seats exactly one role (architect or reviewer); received ${roles.length}`,
    );
  }
  return { tier, roles };
}

export function buildCouncilKickoffBody(input: {
  caseId: string;
  title: string;
  question: string;
  tier: CouncilTier;
  roles: readonly CouncilSeatRole[];
}): string {
  return [
    `Council ${input.caseId}: ${input.title}`,
    `Question: ${input.question}`,
    `Tier: ${input.tier}. Sealed seats: ${input.roles.join(", ")}.`,
    "Each seat must report independently in this Room before the Lead records integrity.",
    "Starting seats preserve compatibility only; debate normal verdict requires Architect+Reviewer handbacks, and debate-with-proof/high-risk requires Scout+Architect+Reviewer handbacks. Missing returned handbacks are DEGRADED; the canonical Lead review decision remains authoritative.",
  ].join("\n");
}

export function assertCouncilKickoffBody(input: { body: string; caseId: string }): void {
  if (!input.body.includes(`Council ${input.caseId}:`)) {
    throw new Error(`Council '${input.caseId}' kickoff body does not match the pinned SLP policy`);
  }
}

export function buildCouncilSeatPlans(input: {
  caseId: string;
  title: string;
  tier: CouncilTier;
  roomId: string;
  kickoffMessageId: string;
  roles: readonly CouncilSeatRole[];
}): SlpCouncilSeatPlan[] {
  return input.roles.map((role) => {
    let executionProfile: FoundationExecutionProfileId | undefined;
    if (role === "architect") executionProfile = "solution-architect";
    if (role === "reviewer") executionProfile = "reviewer";
    const { startSentinel: reportStartSentinel, endSentinel: reportEndSentinel } =
      councilReportSentinels(role);
    return {
      role,
      peerSubrole: role,
      ...(executionProfile ? { executionProfile } : {}),
      reportStartSentinel,
      reportEndSentinel,
      labels: {
        "council.case_id": input.caseId,
        "council.title": input.title,
        "council.tier": input.tier,
        "council.phase": "sealed",
        "council.role": role,
        "council.round": "1",
        "council.integrity": "unspecified",
        "council.room_id": input.roomId,
        "council.kickoff_message_id": input.kickoffMessageId,
        "council.report_start_sentinel": reportStartSentinel,
        "council.report_end_sentinel": reportEndSentinel,
      },
    };
  });
}

export const SLP_COUNCIL_POLICY = {
  reportSentinels: councilReportSentinels,
  validateSeatRoles: validateCouncilSeatRoles,
  resolveTierAndRoles: resolveCouncilTierAndRoles,
  buildKickoffBody: buildCouncilKickoffBody,
  assertKickoffBody: assertCouncilKickoffBody,
  buildSeatPlans: buildCouncilSeatPlans,
};
