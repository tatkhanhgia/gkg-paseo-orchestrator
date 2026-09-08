import { createHash } from "node:crypto";
import type { LeadHandoffTransition } from "@getpaseo/protocol/lead-handoff";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

/**
 * Frozen fork of coordination-policy.ts as it shipped in release 0.7.0-paseo.60
 * (generation owner `plugin:slp@d19918d93ff78dab8a89652a82e5647a86e1503cad752f4aa6a256ab3f30770c`,
 * `coordinationPolicyVersion` "5"). Byte-reproduced from the installed .60 artifact at
 * `~/.local/share/paseo-web-cli/releases/0.7.0-paseo.60/app/node_modules/@getpaseo/server/dist/server/server/policy/bundled/slp/coordination-policy.js`.
 *
 * Retention scope: this exists only so `resolvePinned` can restore the exact qualified
 * generation identity/behavior for an agent bound before the "5" -> "6" coordination-policy
 * change (attention_question directive-shape detection rewrite), not to keep an indefinite
 * historical chain. It is registered but never activated (see retained-generations.ts) — new
 * launches always resolve the current generation. Unlike the removed v1.0 compat modules
 * (docs/slp-bundled-policy-pack-audit.md F-04), this fork is tagged with its exact source
 * version/release/digest above and is scoped to exactly one immediately-preceding generation;
 * it should be deleted once no archived/live agent still resolves this owner.
 */
export const RETAINED_SLP_COORDINATION_POLICY_VERSION_V5 = "5";

const MAX_ATTENTION_TEXT_LENGTH = 1000;
const CLAUSE_SEPARATOR = /[;:\r\n]/u;
const SENTENCE_BOUNDARY = /[.!?]\s*\S/u;
const VERSION_TOKEN = "\\d+(?:\\.\\d+)+(?:-[a-z0-9]+(?:\\.\\d+)*)?";
const PATH_COMPONENT = "\\.?[A-Za-z0-9_-]+";
const PATH_COMPOUND_EXTENSION = "\\.(?:test\\.tsx|test\\.ts|spec\\.tsx|spec\\.ts|d\\.ts)";
const PATH_EXTENSION_SINGLE = "\\.[a-z0-9_-]+";
const PATH_TOKEN = `/?${PATH_COMPONENT}(?:/${PATH_COMPONENT})+(?:${PATH_COMPOUND_EXTENSION}|${PATH_EXTENSION_SINGLE})?`;
const DOTTED_TOKEN = new RegExp(`${VERSION_TOKEN}|${PATH_TOKEN}`, "gu");

function maskDottedTokens(value: string): string {
  return value.replace(DOTTED_TOKEN, (match) => "0".repeat(match.length));
}

function containsClauseSeparatorOrExtraSentence(value: string): boolean {
  return CLAUSE_SEPARATOR.test(value) || SENTENCE_BOUNDARY.test(maskDottedTokens(value));
}

const MODAL_OR_REQUEST_PREFIX =
  /^(?:(?:can|could|would|will|should|may|might|do|does|did|please|kindly)\b|is\s+it\s+possible\b)/iu;
const SECOND_PERSON_REQUEST_LANGUAGE =
  /\b(?:for\s+you\s+to|you\s+(?:must|shall|should|need\s+to|have\s+to|will|are\s+to)|prevents?\s+you\s+from|requires?\s+you\s+to|asks?\s+you\s+to)\b/iu;
const MODAL_YOU_REQUEST = /\b(?:can|could|would|will|should|may|might|must|shall)\s+you\b/iu;
const AUTHORITY_MODAL_LANGUAGE = /\b(?:must|shall|should|need(?:s)?\s+to|have\s+to|has\s+to)\b/iu;
const OBSERVATION_IMPERATIVE_PREFIX =
  /^(?:delete|remove|merge|squash|land|ship|apply|run|execute|assign|take|transfer|handoff|hand\s+off|detach|write|edit|commit|push|release|deploy|restart|stop|start|approve|accept|reject|decide|recover|override|escalate|close)\b/iu;
const BOUNDED_AUTHORITY_OR_EFFECT_LANGUAGE =
  /\b(?:delet(?:e|es|ed|ing|ion)|remov(?:e|es|ed|ing|al)|merg(?:e|es|ed|ing)|squash(?:es|ed|ing)?|land(?:s|ed|ing)?|ship(?:s|ped|ping)?|appl(?:y|ies|ied|ying|ication|ications)|run|runs|ran|running|execut(?:e|es|ed|ing|ion|ions)|assign(?:s|ed|ing|ment|ments)?|tak(?:e|es|ing)\s+(?:over|ownership)|took\s+(?:over|ownership)|ownership\s+transfer|transfer(?:s|red|ring)?|hand(?:off|\s+off|s\s+off|ed\s+off|ing\s+off)|detach(?:es|ed|ing|ment)?|writ(?:e|es|ing|ten)|edit(?:s|ed|ing)?|commit(?:s|ted|ting)?|push(?:es|ed|ing)?|releas(?:e|es|ed|ing)|deploy(?:s|ed|ing|ment|ments)?|restart(?:s|ed|ing)?|stop(?:s|ped|ping)?|start(?:s|ed|ing)?|approv(?:e|es|ed|ing|al)|accept(?:s|ed|ing|ance)?|reject(?:s|ed|ing|ion)?|decid(?:e|es|ed|ing)|decision(?:s)?|verdict(?:s)?|recover(?:s|ed|ing|y|ies)?|override(?:s|d|ing)?|escalat(?:e|es|ed|ing|ion)|clos(?:e|es|ed|ing)|activat(?:e|es|ed|ing|ion)|reassign(?:s|ed|ing|ment)?|replac(?:e|es|ed|ing|ement)|implement(?:s|ed|ing|ation)?|modif(?:y|ies|ied|ying|ication)|tag(?:s|ged|ging)?)\b/iu;
const OBSERVATION_REQUEST_SHAPE = new RegExp(
  `(?:^(?:please|kindly|do|make|go|proceed|change|freeze)\\b|\\b(?:requests?|proposes?|instructs?|asks?)\\s+(?:you\\s+)?(?:to\\s+)?${BOUNDED_AUTHORITY_OR_EFFECT_LANGUAGE.source})`,
  "iu",
);
const ROLE_TOKEN = "(?:lead|peer|supervisor|human)";
const ROUTING_OR_HANDOFF_LANGUAGE = new RegExp(
  `\\b(?:back\\s+to\\s+the\\s+${ROLE_TOKEN}\\b|go(?:es)?\\s+back\\s+to\\b|return(?:s|ed|ing)?\\s+to\\s+the\\s+${ROLE_TOKEN}\\b|hand(?:ed|ing)?\\s+(?:back\\s+)?to\\s+the\\s+${ROLE_TOKEN}\\b|rout(?:e|es|ed|ing)\\s+to\\s+the\\s+${ROLE_TOKEN}\\b|escalat(?:e|es|ed|ing)\\s+to\\s+the\\s+${ROLE_TOKEN}\\b|về\\s+${ROLE_TOKEN}\\b|đưa\\s+về\\b)`,
  "iu",
);

const UWB_START = "(?<![\\p{L}\\p{N}_])";
const UWB_END = "(?![\\p{L}\\p{N}_])";
const VI_ACTION_OR_EFFECT_TERMS = [
  "xóa",
  "xoá",
  "chuyển quyền sở hữu",
  "bàn giao",
  "phê duyệt",
  "chấp nhận",
  "khởi động lại",
  "triển khai",
];
const VI_ACTION_OR_EFFECT_LANGUAGE = new RegExp(
  `${UWB_START}(?:${VI_ACTION_OR_EFFECT_TERMS.join("|")})${UWB_END}`,
  "iu",
);
const VI_IMPERATIVE_REQUEST_TERMS = ["hãy", "vui lòng"];
const VI_IMPERATIVE_REQUEST_LANGUAGE = new RegExp(
  `${UWB_START}(?:${VI_IMPERATIVE_REQUEST_TERMS.join("|")})${UWB_END}`,
  "iu",
);
const VI_CONDITIONAL_MODAL_TERMS = ["có thể", "nên", "phải", "cần"];
const VI_CONDITIONAL_MODAL_LANGUAGE = new RegExp(
  `${UWB_START}(?:${VI_CONDITIONAL_MODAL_TERMS.join("|")})${UWB_END}`,
  "iu",
);
const VI_ADDRESSEE_PRONOUN_TERMS = [
  "bạn",
  "các bạn",
  "chúng ta",
  "chúng tôi",
  "tôi",
  "mình",
  "anh",
  "chị",
  "em",
];
const VI_ADDRESSEE_PRONOUN = new RegExp(
  `${UWB_START}(?:${VI_ADDRESSEE_PRONOUN_TERMS.join("|")})${UWB_END}`,
  "iu",
);

function matchesViModalOrRequestLanguage(value: string): boolean {
  return (
    VI_IMPERATIVE_REQUEST_LANGUAGE.test(value) ||
    (VI_CONDITIONAL_MODAL_LANGUAGE.test(value) && VI_ADDRESSEE_PRONOUN.test(value))
  );
}

function normalizeAttentionQuestionPart(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function retainedAttentionQuestionCoalescingKeyV5(input: {
  requester: { kind: "human" } | { kind: "agent"; agentId: string };
  targetAgentId: string;
  observation: string;
  question: string;
}): string {
  if (!input.targetAgentId.trim()) {
    throw new Error("attention_question coalescing requires a target agent identity");
  }
  if (input.requester.kind === "agent" && !input.requester.agentId.trim()) {
    throw new Error("attention_question coalescing requires a source agent identity");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        requester: input.requester,
        targetAgentId: input.targetAgentId,
        observation: normalizeAttentionQuestionPart(input.observation),
        question: normalizeAttentionQuestionPart(input.question),
      }),
    )
    .digest("hex");
  return `slp.attention-question:${digest}`;
}

function assertAuthorityNeutralObservationV5(observation: string): void {
  const normalized = observation
    .normalize("NFKC")
    .trim()
    .replace(/[\t ]+/gu, " ");
  if (!normalized) {
    throw new Error("attention_question requires a concrete observation");
  }
  if (normalized.length > MAX_ATTENTION_TEXT_LENGTH) {
    throw new Error(
      `attention_question observation must be at most ${MAX_ATTENTION_TEXT_LENGTH} characters`,
    );
  }
  if (
    containsClauseSeparatorOrExtraSentence(normalized) ||
    SECOND_PERSON_REQUEST_LANGUAGE.test(normalized) ||
    MODAL_YOU_REQUEST.test(normalized) ||
    AUTHORITY_MODAL_LANGUAGE.test(normalized) ||
    MODAL_OR_REQUEST_PREFIX.test(normalized) ||
    OBSERVATION_IMPERATIVE_PREFIX.test(normalized) ||
    OBSERVATION_REQUEST_SHAPE.test(normalized) ||
    BOUNDED_AUTHORITY_OR_EFFECT_LANGUAGE.test(normalized) ||
    ROUTING_OR_HANDOFF_LANGUAGE.test(normalized) ||
    VI_ACTION_OR_EFFECT_LANGUAGE.test(normalized) ||
    matchesViModalOrRequestLanguage(normalized)
  ) {
    throw new Error("attention_question observation must be authority-neutral factual prose");
  }
}

function assertAuthorityNeutralClarificationQuestionV5(question: string): void {
  const normalized = question
    .normalize("NFKC")
    .trim()
    .replace(/[\t ]+/gu, " ");
  if (!normalized.endsWith("?") || (normalized.match(/\?/gu)?.length ?? 0) !== 1) {
    throw new Error("attention_question requires one open question ending in '?'");
  }
  if (normalized.length > MAX_ATTENTION_TEXT_LENGTH) {
    throw new Error(`attention_question must be at most ${MAX_ATTENTION_TEXT_LENGTH} characters`);
  }
  if (containsClauseSeparatorOrExtraSentence(normalized)) {
    throw new Error("attention_question must be a single bounded clarification clause");
  }
  if (
    MODAL_OR_REQUEST_PREFIX.test(normalized) ||
    SECOND_PERSON_REQUEST_LANGUAGE.test(normalized) ||
    MODAL_YOU_REQUEST.test(normalized) ||
    BOUNDED_AUTHORITY_OR_EFFECT_LANGUAGE.test(normalized) ||
    ROUTING_OR_HANDOFF_LANGUAGE.test(normalized) ||
    VI_ACTION_OR_EFFECT_LANGUAGE.test(normalized) ||
    matchesViModalOrRequestLanguage(normalized)
  ) {
    throw new Error(
      "attention_question cannot request action, authority, verdict, or external effect",
    );
  }
}

function retainedAssertPrepareLeadHandoffAuthorityV5(input: {
  callerAgentId: string | undefined;
  callerRoleId: PaseoRoleId | undefined;
}): string {
  if (!input.callerAgentId) {
    throw new Error("prepare_lead_handoff requires an agent-scoped predecessor Lead");
  }
  if (input.callerRoleId !== "lead") {
    throw new Error("prepare_lead_handoff requires a role-bound predecessor Lead");
  }
  return input.callerAgentId;
}

function retainedAssertLeadHandoffTransitionAuthorityV5(input: {
  callerAgentId: string | undefined;
  transition: LeadHandoffTransition;
}): void {
  if (
    input.callerAgentId &&
    input.transition !== "successor_acknowledged" &&
    input.transition !== "rejected"
  ) {
    throw new Error("Only a Human-facing caller can authorize or release a Lead handoff");
  }
}

function retainedAssertSignalAgentAuthorityV5(input: {
  targetAgentId: string;
  targetRoleId: PaseoRoleId | undefined;
  callerRoleId: PaseoRoleId | undefined;
  callerAgentId: string | undefined;
  kind: "handoff_recommended" | "detach_recommended";
  relatedAgentId: string | undefined;
}): void {
  if (input.targetRoleId !== "lead") {
    throw new Error(
      `Coordination signals require a role-bound Lead target; ${input.targetAgentId} is not one`,
    );
  }
  if (input.kind === "detach_recommended" && !input.relatedAgentId) {
    throw new Error("detach_recommended requires relatedAgentId");
  }
  if (input.callerAgentId && input.callerRoleId !== "lead" && input.callerRoleId !== "supervisor") {
    throw new Error("Only a role-bound Lead or Supervisor can signal another Lead");
  }
}

function retainedAssertAttentionQuestionAuthorityV5(input: {
  targetAgentId: string;
  targetRoleId: PaseoRoleId | undefined;
  callerRoleId: PaseoRoleId | undefined;
  callerAgentId: string | undefined;
  callerWorkspaceId: string | undefined;
  targetWorkspaceId: string | undefined;
  observation: string;
  question: string;
  evidenceRefs: readonly string[];
}): void {
  if (input.targetRoleId !== "lead" && input.targetRoleId !== "peer") {
    throw new Error(
      `Attention questions require a role-bound Lead or Peer target; ${input.targetAgentId} is not one`,
    );
  }
  if (input.callerAgentId && input.callerRoleId !== "supervisor") {
    throw new Error("Only a role-bound Supervisor can ask an agent-scoped attention question");
  }
  if (
    input.callerAgentId &&
    (!input.callerWorkspaceId ||
      !input.targetWorkspaceId ||
      input.callerWorkspaceId !== input.targetWorkspaceId)
  ) {
    throw new Error("Agent-scoped attention questions require caller and target in one workspace");
  }
  assertAuthorityNeutralObservationV5(input.observation);
  assertAuthorityNeutralClarificationQuestionV5(input.question);
  if (input.evidenceRefs.length === 0) {
    throw new Error("attention_question requires at least one evidence reference");
  }
}

function retainedAssertResolveAgentSignalAuthorityV5(input: {
  callerAgentId: string | undefined;
  requestedAgentId: string | undefined;
}): string {
  const targetAgentId = input.callerAgentId ?? input.requestedAgentId;
  if (!targetAgentId) {
    throw new Error("agentId is required outside an agent-scoped session");
  }
  if (
    input.callerAgentId &&
    input.requestedAgentId &&
    input.requestedAgentId !== input.callerAgentId
  ) {
    throw new Error("An agent may resolve only its own coordination signals");
  }
  return targetAgentId;
}

/** Tool descriptions were byte-identical between "5" and "6"; kept as a literal copy so this module has no import dependency on the live coordination-policy.ts. */
const RETAINED_SLP_COORDINATION_TOOL_DESCRIPTIONS_V5 = {
  prepareLeadHandoff:
    "Persist an immutable adjacent-Lead handoff packet. The predecessor remains write Owner; this does not authorize or release either Lead.",
  transitionLeadHandoff:
    "Record explicit Human authorization/release or the designated successor's acknowledgement/rejection. Final release requires an idle predecessor, closes its runtime while retaining the durable record, transfers current write ownership, and blocks later predecessor prompts without detaching, archiving, or changing role binding.",
  signalAgent:
    "Send a durable advisory handoff or detach recommendation to a role-bound Lead. Delivery waits for an idle boundary and never replaces an active run.",
  askAttentionQuestion:
    "Ask a role-bound Lead or Peer one evidence-backed attention question at a safe boundary. The question cannot command, decide, accept, transfer ownership, or change authority.",
  resolveAgentSignal:
    "Record the receiving role's autonomous disposition of a coordination signal. This does not report to or transfer authority to the sender.",
} as const;

export const RETAINED_SLP_COORDINATION_POLICY_V5 = {
  supportsAttentionQuestions: true as const,
  descriptions: RETAINED_SLP_COORDINATION_TOOL_DESCRIPTIONS_V5,
  assertPrepareLeadHandoffAuthority: retainedAssertPrepareLeadHandoffAuthorityV5,
  assertLeadHandoffTransitionAuthority: retainedAssertLeadHandoffTransitionAuthorityV5,
  assertSignalAgentAuthority: retainedAssertSignalAgentAuthorityV5,
  assertAttentionQuestionAuthority: retainedAssertAttentionQuestionAuthorityV5,
  attentionQuestionCoalescingKey: retainedAttentionQuestionCoalescingKeyV5,
  assertResolveAgentSignalAuthority: retainedAssertResolveAgentSignalAuthorityV5,
};
