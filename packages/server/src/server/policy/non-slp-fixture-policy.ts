import { createHash } from "node:crypto";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import type { RoleProfileBindingReceipt } from "@getpaseo/protocol/role-binding";

import {
  updateEventPolicyState,
  type EventPolicyStateSpec,
} from "../agent/coordination-signals.js";
import type { AgentEventPolicy } from "../agent/event-policy-runtime.js";
import type { RoleBindingPolicyContribution } from "./role-binding-policy.js";
import {
  BundledPolicyPackRegistry,
  type BundledPolicyPackGeneration,
} from "./bundled-policy-pack.js";
import type { TrustedPolicyContribution } from "./trusted-policy.js";

export const NON_SLP_FIXTURE_PLUGIN_ID = "fixture-policy";
export const NON_SLP_FIXTURE_POLICY_VERSION = "0.1.0";
export const NON_SLP_FIXTURE_EVENT_POLICY_ID = "fixture.trusted-event";

const FIXTURE_ALLOWED_TOOLS = ["beads_status", "beads_get", "beads_prime"];
const FIXTURE_ALLOWED_SKILLS = ["beads-issue-tracker"];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureAssignment(): AssignmentEnvelope {
  return {
    version: 1,
    disposition: "peer-execution",
    objective: "Exercise a trusted non-SLP contribution through the shared host.",
    effectClass: "read-only",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    evidence: "Return the shared admission/materialization/event receipt.",
    handbackAndStop: "Stop after the bounded fixture receipt.",
  };
}

const fixtureRoleBindingPolicy: RoleBindingPolicyContribution<string> = {
  getRoleDefinition(roleId) {
    return {
      id: roleId,
      version: "fixture-role-1",
      instructions: `Trusted fixture instructions for ${roleId}; this is not SLP doctrine.`,
    };
  },
  getExecutionProfile(profileId) {
    throw new Error(`fixture_policy_execution_profile_unsupported: ${profileId}`);
  },
  executionProfileDefinitionDigest(profile) {
    return sha256(JSON.stringify(profile));
  },
  materializeRoleProfile(roleId, preferences, _assignmentEffectClass): RoleProfileBindingReceipt {
    const selectedTools = preferences?.allowedTools
      ? FIXTURE_ALLOWED_TOOLS.filter((tool) => preferences.allowedTools?.includes(tool))
      : [...FIXTURE_ALLOWED_TOOLS];
    const selectedSkills = preferences?.allowedSkills
      ? FIXTURE_ALLOWED_SKILLS.filter((skill) => preferences.allowedSkills?.includes(skill))
      : [...FIXTURE_ALLOWED_SKILLS];
    const canonical = JSON.stringify({ roleId, selectedTools, selectedSkills });
    return {
      schemaVersion: 1,
      profileDigest: sha256(canonical),
      defaults: {},
      allowedTools: selectedTools,
      allowedSkills: selectedSkills,
    };
  },
  workspaceProtocolReadership: () => "assignment-only",
  composeInstructions(input) {
    return [
      input.definition.instructions,
      `Fixture assignment objective: ${input.assignmentContract.envelope.objective}`,
      `Fixture workspace protocol readership: ${input.workspaceProtocol.readership}`,
    ].join("\n\n");
  },
  preflight(input) {
    return input.assignment ?? fixtureAssignment();
  },
};

interface FixtureEventPolicyState extends Record<string, unknown> {
  streamEvents: number;
}

const FIXTURE_EVENT_STATE: EventPolicyStateSpec<FixtureEventPolicyState> = {
  policyId: NON_SLP_FIXTURE_EVENT_POLICY_ID,
  version: 1,
  initialState: { streamEvents: 0 },
  parseState: (value) => ({
    streamEvents:
      value &&
      typeof value === "object" &&
      typeof (value as { streamEvents?: unknown }).streamEvents === "number"
        ? (value as { streamEvents: number }).streamEvents
        : 0,
  }),
};

export const NON_SLP_FIXTURE_EVENT_POLICY: AgentEventPolicy = {
  id: NON_SLP_FIXTURE_EVENT_POLICY_ID,
  version: "1",
  subscriptions: ["agent_stream"],
  enabled: () => true,
  createProcessor(dependencies) {
    return {
      async handleEvent(event, owner) {
        if (event.type !== "agent_stream") return;
        await updateEventPolicyState(
          dependencies,
          event.agentId,
          owner,
          FIXTURE_EVENT_STATE,
          (state) => ({
            state: { streamEvents: state.streamEvents + 1 },
            result: undefined,
          }),
        );
      },
    };
  },
};

export const NON_SLP_FIXTURE_POLICY_CONTRIBUTION: TrustedPolicyContribution = {
  roleBindingPolicy: fixtureRoleBindingPolicy,
  eventPolicies: [NON_SLP_FIXTURE_EVENT_POLICY],
};

export function createNonSlpFixtureRegistry(): BundledPolicyPackRegistry<TrustedPolicyContribution> {
  const registry = new BundledPolicyPackRegistry<TrustedPolicyContribution>();
  const generation: BundledPolicyPackGeneration<TrustedPolicyContribution> =
    registry.registerGeneration({
      manifest: {
        id: NON_SLP_FIXTURE_PLUGIN_ID,
        abiVersion: 1,
        policyVersion: NON_SLP_FIXTURE_POLICY_VERSION,
      },
      artifactBytes: "trusted non-SLP fixture generation 1",
      contribution: NON_SLP_FIXTURE_POLICY_CONTRIBUTION,
    });
  registry.activate(generation.owner);
  return registry;
}
