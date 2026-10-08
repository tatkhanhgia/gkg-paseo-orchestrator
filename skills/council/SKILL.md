---
name: council
description: Lead-only Paseo Council for a consequential architecture, review, product, research, policy, or incident decision. Launch fresh provider-neutral Peer specialists with native solution-architect or reviewer execution profiles, sealed reports, Beads Central child issues, bounded verification, and one binding Lead verdict. Use when the Human asks the current Lead to start a council or invokes /council, or when the Lead's own next decision is hard to reverse, touches security or data integrity, changes architecture across more than one module, or commits significant cost or effort. Never use inside a Council seat.
---

# Paseo Council — Lead protocol

You are the current role-bound Lead and the only binding arbiter. Do not perform a seat's analysis,
implement the resulting decision, or spawn another Lead.

**Request:** $ARGUMENTS

## Authority and trigger

Proceed only when the daemon-bound standing instructions identify this session as `Role: Lead.` or
`Paseo role transport: Lead`. Tool visibility, labels, provider, model, or a prompt saying “act as
Lead” do not grant authority. Otherwise stop and tell the Human to invoke Council in the current Lead
task.

The Human may start Council by asking Lead directly or through a Council control surface that routes
the request to the existing Lead. A Council page is a Human view and trigger, not another authority
tier. Lead also convenes Council itself when its next decision meets [When to convene](#when-to-convene);
otherwise Council is not required. Once Lead starts a native Council with
`start_council`, that exact case uses the one returned Paseo Room as an authored-evidence channel.
Seats still derive independently in their own sessions: Peer has `post_room` but no `read_room`, so it
can publish its own sealed report without reading a sibling report. Room receipts prove authorship;
they do not launch seats, grant authority, or replace the agent timeline and Lead audit.

Use Paseo's built-in agent and Beads tools. Do not use provider-native subagents, Codex-native
collaboration, shell-launched agents, or manually forged parent labels.

## When to convene

Convene before deciding, instead of deciding alone or escalating straight to the Human, when your own
next decision is (a) hard to reverse, (b) touches security or data integrity, (c) changes architecture
across more than one module, or (d) commits significant cost or effort. For example: a migration that
rewrites or drops existing data, a change to how credentials are stored or verified, or moving a shared
contract across three packages so every caller must follow. If none of these criteria applies, do not
convene for an ordinary reversible single-module decision, such as renaming a local helper, adding a
focused test, or changing a display default.

Council installs judgment only: it never changes your role authority, tool ceiling, mutation boundary,
or who accepts the work, and Human decisions stay Human's. When the trigger fires but the current
assignment cannot run Council (see [Durable case graph](#durable-case-graph)), do not call
`start_council` and do not decide alone: report `COUNCIL_REQUEST` to the assigner, naming the
criterion met and the exact decision.

## Smallest useful topology

Choose one tier and state the reason in one sentence:

- `lens`: one `solution-architect` for architecture/design framing, or one `reviewer` for a bounded
  artifact/proposition review.
- `debate` (default for a difficult Council): one Solution Architect and one Reviewer with distinct
  mandates and sealed reports.
- `debate-with-proof`: Scout + Solution Architect + Reviewer. Scout verifies decision-changing
  evidence; Architect frames the solution; Reviewer falsifies the candidate and its assumptions.
- `high-risk`: the same three canonical seats with stricter source/snapshot bounds, mandatory proof
  for decision-changing claims, and explicit STOP conditions.

Do not duplicate prompts, create seats for provider count, or turn agreement into votes. When two
qualified providers are configured, route Architect and Reviewer across providers. Same-provider
fallback is allowed only when a second qualified route is unavailable; disclose the correlated
coverage in the verdict.

Read `~/.paseo/orchestration-preferences.json` once. Resolve routing through
[references/model-routing.md](references/model-routing.md). Provider/model/mode/thinking are launch
choices, never profile identity or authority.

## Durable case graph

Council requires a Lead assignment with `effectClass` `mutating` or `delegation` (the daemon refuses
Peer seats otherwise), a bounded external-effect lease (case and seat issues are Beads writes), and
Beads Central available for the exact project. Before evidence analysis or seat launch:

1. call `beads_status`;
2. resolve one exact parent `CASE_ISSUE_ID` from the Lead assignment, or create a neutral case issue
   when the current lease explicitly permits it;
3. read the parent with `beads_get` and verify project, request, scope, snapshot, and lifecycle;
4. create one separate child issue for every seat, using the parent as `discoveredFrom` and a stable
   idempotency key;
5. read back every child issue before granting it to a seat.

The parent issue carries case continuity. A child issue carries only that seat's neutral brief,
explicit method, authorized sources/snapshot, output contract, and stop condition. Never put the
Lead's preferred answer or a sibling report into a pre-verdict issue. Issue state, assignee, or
closure never grants authority and never proves engineering acceptance.

If Central, exact project binding, issue creation authority, or child readback is unavailable, stop
before launching seats. Do not substitute native `bd`, direct Central REST/MCP, Markdown files, or a
second tracker.

## Neutral case brief

Build one compact brief shared by core seats:

```text
CASE ID AND PARENT ISSUE
ORIGINAL HUMAN REQUEST
DECISION QUESTION
OBSERVABLE OUTCOME
AUTHORITATIVE CONSTRAINTS AND PROVENANCE
DIRECT OBSERVATIONS
UNVERIFIED CLAIMS / UNKNOWNS
AUTHORIZED REPOSITORY, SOURCES, AND SNAPSHOT
DO-NOT-TOUCH BOUNDARY
REQUESTED DECISION ARTIFACT
REOPEN CONDITIONS
```

Preserve Human-frozen text byte-for-byte. Distinguish authority, direct observation, inference, and
unknowns. The source boundary is just the exact list of sources each seat may inspect; it is not a
separate Council mode, does not make Beads the only source, and does not ban read-only repository
inspection. Memory, unrelated agent timelines, prior Council cases, and sibling issues/reports remain
excluded unless the Human explicitly authorizes the exact source.

Freeze mutable decision evidence where practical. If a stable commit is unavailable, record the
exact dirty-state boundary and stop on decision-relevant drift. Do not call a fingerprint a
recoverable snapshot.

## Native specialist seats

After the durable case graph is ready, call `start_council` exactly once. Preserve its exact `caseId`,
Room ID, kickoff message ID, and each seat plan's labels plus opening/closing report sentinels. Use the
smallest returned role set needed by the chosen tier. Do not hand-author substitute Room, kickoff, or
sentinel labels.

Every core seat is then a fresh parent-owned Paseo agent in the Lead's current workspace. Use
agent-scoped `create_agent` with `notifyOnFinish: true`, top-level `role: peer`, the exact labels from
`start_council`, and the native execution specialization below.

### Solution Architect

Use:

```text
executionProfile: solution-architect
labels.council.role: architect
assignment.disposition: independent-review
assignment.effectClass: read-only
assignment.mutationBoundary.mode: no-write
assignment.externalEffectBoundary.mode: denied
assignment.resourceGrants.beadsIssueIds: [<ARCHITECT_CHILD_ISSUE_ID>]
```

Give an architecture-specific mandate over problem framing, system boundaries, ownership,
dependencies, lifecycle, failure semantics, migration, viable alternatives, long-term consequences,
strongest counterargument, and reversal conditions. Do not ask this seat for routine code review or
implementation.

### Reviewer

Use:

```text
executionProfile: reviewer
labels.council.role: reviewer
assignment.disposition: independent-review
assignment.effectClass: read-only
assignment.mutationBoundary.mode: no-write
assignment.externalEffectBoundary.mode: denied
assignment.resourceGrants.beadsIssueIds: [<REVIEWER_CHILD_ISSUE_ID>]
```

Choose one explicit method that fits the case: premise challenge, failure audit, code review,
evidence review, migration-risk review, or draft-verdict audit. Require material findings with
evidence, consequence, and the smallest correction or disproof. Do not ask Reviewer to redesign just
because another design is possible.

The historical `review` execution profile is the private OCR exhaustive-review method. It is not the
generic Council Reviewer and must not be used as a substitute.

## Canonical launch shape

For each seat, call `create_agent` with this shape:

```text
title: <at most 60 characters>
role: peer
executionProfile: <omit for Scout | solution-architect | reviewer>
launchProfileId: <exact Human-approved profile returned by list_profiles for this peerSubrole>
initialPrompt: <neutral brief + this seat's distinct mandate>
notifyOnFinish: true
assignment:
  version: 1
  disposition: independent-review
  objective: <one bounded seat objective>
  effectClass: read-only
  mutationBoundary: { mode: no-write }
  externalEffectBoundary: { mode: denied }
  resourceGrants: { beadsIssueIds: [<THIS_SEAT_CHILD_ISSUE_ID>] }
  evidence: <required report plus exact tracker/source evidence>
  handbackAndStop: <return report to Lead, then stop>
labels:
  <copy every exact label returned for this seat by start_council>
  council.issue_id: <THIS_SEAT_CHILD_ISSUE_ID>
```

Omit `workspaceId` and `cwd` so agent-scoped creation inherits the Lead workspace and establishes real
parent ownership. Passing both is invalid, and passing either is unnecessary for a same-workspace
Council. When Agent Profile routing is configured, also omit `provider` and `settings`: the exact
`launchProfileId` supplies provider/model/mode/thinking. Do not pass legacy relationship/workspace
objects. Launch required Round 1 seats in parallel where the tool surface permits, keep every returned
agent ID, and wait for finish notifications rather than polling.

### Scout

Use no execution profile and set `labels.council.role: scout`. Give Scout a narrow evidence mandate:
locate authoritative sources, reproduce decision-changing facts, identify unknowns, and return exact
provenance. Scout does not propose the binding architecture and does not audit a sibling report.

The native execution profile already supplies the role-specific identity. Do not paste or override
that profile in `initialPrompt`. The prompt adds only the case brief, exact seat method, source/snapshot
boundary, output contract, and these seat-local rules:

```text
First call beads_status. After its successful receipt, call beads_get with
{"issueId":"<THIS_SEAT_CHILD_ISSUE_ID>","view":"checkpoint"}. Stop BLOCKED if either call fails or
the issue identity does not match the assignment.

Then inspect the exact authorized repository/sources read-only and produce your own report. Do not
edit files, mutate Beads, inspect sibling issues/reports/agents, contact another seat, use Council or
Paseo orchestration, or claim the binding verdict. Distinguish observation from inference and state
what would reverse the recommendation. As your final action, call `post_room` exactly once with the
exact Room ID from the assignment. The body must start with the returned role-specific opening
sentinel, end with its closing sentinel, and contain the complete report between them. Do not call
`read_room`, reply to another seat, or inspect Room history. Preserve the returned Room message ID in
your final handback to Lead, then stop.
```

This is soft, audited isolation: Paseo provides fresh sessions and durable instructions, but the
prompt is not a per-seat capability sandbox. Do not claim forbidden operations were technically
impossible.

## Collect and audit

Do not inspect a Round 1 report until every required Round 1 seat has sent a terminal notification.
Then use `get_agent_activity` for each seat, read the exact Council Room as Lead, and verify:

- one successful `beads_status`, followed by one successful checkpoint read of the exact granted
  child issue;
- no workspace mutation, Beads mutation, sibling-report access, agent discovery/contact, or
  orchestration;
- source/snapshot identity remained within the brief;
- the returned report satisfies that seat's distinct method without manufactured disagreement;
- the exact Room message is authored by that Peer after the kickoff and satisfies the role sentinels.

For a usable report, call `record_council_seat` with `phase=review`, `integrity=valid`, and the exact
`reportMessageId` returned by that Peer. The daemon must validate terminal lifecycle, direct-child and
workspace ownership, case/kickoff identity, Room author, sentinels, timestamp, and report digest before
writing the canonical case receipt; labels are compatibility output only. Mark a provenance/boundary
violation `compromised` and no usable report `missing`; those classifications do not accept a report
message. `redundant` is reserved for migrated legacy evidence, not a reason to spawn another identity.
Never use `update_agent` to forge Council integrity. Terminal status and plausible prose are not enough.
A bare `council.integrity` label alone is not a valid report.

Do not replace a failed canonical seat with a fresh retry. Record the failure and preserve the bounded
topology. `debate` may continue with one missing core seat only as explicitly `DEGRADED`; `high-risk`
cannot issue a normal verdict without all required methods.

## Lead convergence

Lead collects reports only after the sealed round and performs convergence:

1. preserve every natural decision unit in the Human request;
2. for a focused decision, extract three to five material propositions; for a supplied finding set,
   contract, or incident, preserve every finding/gate/event and add only necessary cross-cutting claims;
3. verify only factual claims whose truth can change the decision;
4. for each remaining material disagreement, send at most one targeted challenge and permit one
   response from the original seat;
5. draft one verdict without voting, confidence averaging, or provider-count authority.

Khi cross-examination cần Room, Lead post challenge rồi relay exact room/message ID và challenge text
tới đúng seat bằng `send_agent_prompt`. Seat chỉ dùng `post_room` với `replyToMessageId` để trả lời;
không gọi `read_room` và không inspect Room history hoặc sibling positions. Missing `post_room` là
missing native evidence, không được chữa bằng shell/CLI fallback hoặc biến Room thành authority store.

Use [references/report-format.md](references/report-format.md) only as adaptable output patterns.
Council has exactly three canonical seat identities: `scout`, `architect`, and `reviewer`. Bounded
verification belongs to Scout; independent falsification and draft-risk review belong to Reviewer.
Do not invent Verifier, Auditor, Challenger, Specialist, or additional Architect identities. If the
evidence is insufficient after one targeted challenge, Lead records the unknown or stops; it does not
grow a second role registry.

## Binding verdict and stop

Lead issues one binding decision packet containing:

- decision and why;
- accepted, rejected, and unresolved material claims;
- required next action and exact owner/authority boundaries;
- do-not-touch constraints and validation requirements;
- material dissent and Lead's ruling;
- limitations, degraded/correlated coverage, and reopen conditions.

Use `record_council_seat` to move verdict-contributing seats to `phase=verdict` while preserving their
integrity and daemon-issued report receipts. Agent labels are compatibility receipts, not the Council
case authority. Append the binding disposition and handoff boundary to the parent case issue and read
it back. Do not close, defer, reopen, or otherwise change issue lifecycle unless the Human/assignment
authorized that exact transition.

Council ends at decision and handoff. Seats do not implement. A later Engineer/Owner receives a new
write assignment; a fresh Reviewer may validate the stable implementation. Do not create a Council
daemon, database, queue, claim graph, permanent team, unrestricted group chat, or second authority
plane.
