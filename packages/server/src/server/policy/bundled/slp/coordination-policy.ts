import { createHash } from "node:crypto";
import type { LeadHandoffTransition } from "@getpaseo/protocol/lead-handoff";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

export const SLP_COORDINATION_POLICY_VERSION = "5";

export const SLP_COORDINATION_TOOL_DESCRIPTIONS = {
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

const MAX_ATTENTION_TEXT_LENGTH = 1000;
// `;`, `:`, and newlines always separate clauses/sentences.
const CLAUSE_SEPARATOR = /[;:\r\n]/u;
// A sentence boundary is `[.!?]` followed (with or without whitespace) by more content.
// This is checked against the string AFTER dotted version/path tokens are masked out, so
// a real extra sentence is rejected whether or not it has a leading space, while an
// internal dot inside a token like `0.7.0-paseo.54` or `packages/app/file.test.ts` is not
// mistaken for one.
const SENTENCE_BOUNDARY = /[.!?]\s*\S/u;
// The mask only recognizes two narrow, structurally distinct token shapes — never an
// arbitrary "word.word" pair, which would also mask a real no-space second sentence like
// "differs.proceed":
//   - a numeric dotted version, e.g. `0.7.0` with an optional bounded prerelease suffix
//     (`-paseo.54`);
//   - a slash-containing path, relative or absolute, with ordinary upper/lowercase/digit/
//     `_`/`-` segments, dot-prefixed segments (`.worktrees`), and a trailing multi-dot
//     filename (`file.test.ts`) — e.g. `packages/server/src/session.test.ts` or
//     `/Users/name/repo/.worktrees/tree/packages/app/file.test.ts` (the slash is what makes
//     it structurally a path, not prose).
// Both require a digit or a slash to qualify, so a plain lowercase "word.word" run is never
// masked. Both stop the instant they would need to swallow more than the reproduced token
// shape (the start of a real second sentence): `0.7.0-paseo.54.Proceed` masks only
// `0.7.0-paseo.54`; `.../file.test.ts.Continue` masks only `.../file.test.ts` (the
// compound-suffix alternative is consumed whole, see PATH_COMPOUND_EXTENSION); and
// `.../file.ts.risk remains uncertain` masks only `.../file.ts` (a path gets at most one
// extension segment — a real second dotted word is never eligible for a second bite, no
// matter how short it is, so it stays visible to the sentence-boundary check below).
// Residual ambiguity: a lone absolute single-segment path (`/etc`, no further slash) is
// not recognized — only multi-segment paths are, matching every reproduced case; a bare
// numeric fraction such as `50/50` is indistinguishable from a one-segment numeric path
// and is masked; and a real filename with 2+ dot-extensions that is not one of the
// enumerated compound suffixes (e.g. `archive.tar.gz`) only has its first extension
// masked, leaving `.gz` visible — this matches the "at most one extension" invariant by
// design, not as an unresolved bypass. None of these are exercised or reported as a
// concern beyond what is documented here.
const VERSION_TOKEN = "\\d+(?:\\.\\d+)+(?:-[a-z0-9]+(?:\\.\\d+)*)?";
// A path component between slashes: real directory/file names are mixed-case
// (`Users`, `Desktop`) and some start with a literal dot (`.worktrees`), so the
// component class allows upper/lowercase letters, digits, `_`, `-`, and one optional
// leading dot. It never includes an internal literal dot, so it always stops at a
// `.` and never itself spans a sentence boundary.
const PATH_COMPONENT = "\\.?[A-Za-z0-9_-]+";
// The small, closed set of two-part suffixes this repository's file naming convention
// actually produces. Listed longest-conflicting-prefix first within each pair (`test.tsx`
// before `test.ts`, `spec.tsx` before `spec.ts`) so the alternation cannot stop one
// literal short of the real suffix (e.g. matching only `.test.ts` out of `.test.tsx` and
// leaving a stray `x`). This is a closed enumeration, not a length heuristic — it never
// matches a suffix outside this exact list, however short.
const PATH_COMPOUND_EXTENSION = "\\.(?:test\\.tsx|test\\.ts|spec\\.tsx|spec\\.ts|d\\.ts)";
// A single arbitrary extension segment, unbounded length — this is deliberately not
// length-capped: a short real word (`.risk`, `.gaps`, 4 characters) is structurally
// indistinguishable from a short real extension (`.ts`, `.d`), so length can never be the
// signal. What makes this safe is that a path token allows at most one of these (see
// PATH_TOKEN below, no repetition): a real second sentence starting with a dotted word
// never gets a second bite at being masked, so it stays visible to SENTENCE_BOUNDARY
// regardless of its length.
const PATH_EXTENSION_SINGLE = "\\.[a-z0-9_-]+";
// Requires at least one `/`, so a bare lowercase `word.word` run (no slash) never
// qualifies as a path and is never masked. The trailing extension group matches at most
// once: either one of the enumerated compound suffixes (tried first, so it is consumed as
// a whole unit) or a single arbitrary extension segment — never both, and never a second
// arbitrary segment. This is what leaves `.risk`/`.gaps` after a real single-extension
// path (`file.ts.risk`) visible to the sentence-boundary check instead of being absorbed
// as a fabricated second extension.
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
// A modal immediately adjacent to "you" ("what would you do", "could you also...") is directed
// at the recipient regardless of sentence position, unlike a bare modal elsewhere in the clause
// (e.g. "what assumption would invalidate..."), which stays a third-person analytical question.
// This is narrower than a blanket modal-word check: it requires the "you" adjacency that is the
// actual signal of a directed request, so it does not reintroduce a bare-modal false positive.
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

// Unicode-aware word boundaries: `\b` treats Vietnamese diacritic letters as
// non-word characters, so a plain `\b` can fail to anchor at the edge of a
// word ending in a combining/precomposed vowel (e.g. "xoá"). These lookarounds
// anchor on any Unicode letter/number instead.
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
// "hãy"/"vui lòng" are imperative-forming particles ("please do X") and are a directive
// regardless of who the sentence names, so they ban unconditionally. "có thể"/"nên"/"phải"/
// "cần" are ordinary analytical modals ("could"/"should"/"must"/"need") that only become a
// directed request when paired with an addressee pronoun in the same clause (mirrors the
// English MODAL_YOU_REQUEST distinction above) — a third-person modal question with no
// addressee, e.g. "Giả định nào có thể làm sai lệch kết luận hiện tại?", stays analytical.
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

export function attentionQuestionCoalescingKey(input: {
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

function assertAuthorityNeutralObservation(observation: string): void {
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

function assertAuthorityNeutralClarificationQuestion(question: string): void {
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

export function assertPrepareLeadHandoffAuthority(input: {
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

export function assertLeadHandoffTransitionAuthority(input: {
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

export function assertSignalAgentAuthority(input: {
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

export function assertAttentionQuestionAuthority(input: {
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
  assertAuthorityNeutralObservation(input.observation);
  assertAuthorityNeutralClarificationQuestion(input.question);
  if (input.evidenceRefs.length === 0) {
    throw new Error("attention_question requires at least one evidence reference");
  }
}

export function assertResolveAgentSignalAuthority(input: {
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

export const SLP_COORDINATION_POLICY = {
  supportsAttentionQuestions: true as const,
  descriptions: SLP_COORDINATION_TOOL_DESCRIPTIONS,
  assertPrepareLeadHandoffAuthority,
  assertLeadHandoffTransitionAuthority,
  assertSignalAgentAuthority,
  assertAttentionQuestionAuthority,
  attentionQuestionCoalescingKey,
  assertResolveAgentSignalAuthority,
};
