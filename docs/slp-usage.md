# Hướng dẫn sử dụng SLP

Nếu đây là lần đầu dùng downstream, đi theo [Foundation first run](foundation-first-run.md) trước khi
chọn topology hoặc tạo role-bound agent.

SLP là topology `Supervisor — Lead — Peer` của Paseo Foundation. Không phải task nào cũng cần đủ ba
role. Chọn topology nhỏ nhất vẫn giữ được ownership, independent judgment và acceptance boundary.

Đọc [Foundation doctrine](foundation-doctrine.md) trước khi thay đổi role contract hoặc project
protocol. Boundary normative nằm trong
[Canonical Role Contracts](../foundation/dist/docs/ROLE_CONTRACTS.md).

## Trạng thái của guidance

Guidance này vận hành current role/authority contract. Nó không claim Paseo đã tự động hóa toàn bộ SLP:

| Cơ chế                    | Trạng thái hiện tại                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Assignment stop condition | Immutable assignment contract ở role launch; authority holder vẫn định nghĩa exact stop condition                      |
| Handback                  | Manual structured report; chưa có first-class engineering acceptance state                                             |
| Coordination signal       | Candidate, integrated-runtime-qualified; chưa có release activation hoặc multi-day operational effect                  |
| Lead handoff/replacement  | Candidate state machine với frozen packet, ordered receipts và Human gates; chưa có release activation/multi-day proof |

Khi candidate signal unavailable, dùng current Human/Lead communication surface và record decision trong
bounded assignment hoặc handback. Không coi lifecycle status là handback hoặc acceptance.

## Chọn topology

| Tình huống                                               | Topology mặc định                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Exact tiny task, risk thấp, transfer không thêm judgment | Human → Lead                                                         |
| Bounded implementation có material judgment              | Human → Lead → một Peer Owner                                        |
| Stable candidate cần independent falsification           | Human → Lead → Owner, rồi fresh Peer Reviewer                        |
| Architecture-sensitive slice                             | Human → Lead → Architect/Owner theo phase; Reviewer khi risk yêu cầu |
| Nhiều project cần process observation                    | Human → Supervisor quan sát các Lead                                 |
| Lead mất continuity hoặc workflow tạo material risk      | Human cấp exact recovery/replacement lease cho Supervisor            |

Không launch Supervisor để quản lý task thường ngày. Không launch Peer khi Lead có thể hoàn thành exact
tiny task trong lease. Không tạo nhiều writer cho một moving scope.

## Trước khi launch

Human hoặc current authority holder phải chốt:

1. exact project/workspace và human-readable objective;
2. Lead-of-record;
3. decision nào Human giữ lại;
4. mutation và external-effect boundary;
5. evidence, handback và stop condition;
6. provider/model/mode sau current discovery;
7. recovery hoặc replacement authority của Supervisor, nếu có.

Nếu repository có `WORKSPACE_PROTOCOL.md`, Lead đọc full file trước orchestration. Peer không đọc full
protocol; Lead chỉ chuyển relevant constraints trong assignment. Supervisor chỉ đọc full protocol khi
governance mandate yêu cầu create, audit hoặc update file đó.

## Launch role-bound session

Human có thể tạo Lead bằng CLI sau khi đã chọn exact workspace và current provider route:

```bash
paseo run \
  --background \
  --role lead \
  --workspace <workspace-id> \
  --provider <provider>/<model> \
  --title "Lead — <objective>" \
  "<bounded Human assignment>"
```

Tạo Supervisor bằng `--role supervisor` trong một governance assignment riêng. Lead tạo Peer bằng
Paseo `create_agent` với `role=peer`, exact workspace, discovered provider/model và bounded assignment.
Không dùng provider alias hoặc initial prompt để giả lập role.

Agent profile là route shortlist do Human cấu hình, không phải role profile. Lead có thể gọi
`list_profiles`, đọc routing notes, bỏ qua preset thiếu model, rồi verify candidate bằng
`list_providers`/`list_models`/`inspect_provider`. Với customized `create_agent`, Lead ghép
`provider/model` vào `provider` và đặt mode, thinking, features dưới `settings`. Preset không cấp
assignment authority và không được apply lên live role-bound agent; đổi route cần create replacement.

Ở agent-scoped action boundary, Lead đã bind role chỉ được tạo `role=peer` và chỉ được
`send_agent_prompt` tới direct child có `paseo.parent-agent-id` trỏ về chính Lead. Peer hoặc Supervisor
đã bind role bị từ chối nếu tool bị expose nhầm; session cũ không có `RoleBinding` giữ behavior hiện tại.

Sau create, đọc effective binding từ daemon:

```bash
paseo agent inspect <agent-id> --json
```

Kiểm `Role`, `ProviderId`, `Model`, `BindingDigest`, `ProtocolStatus` và credential readiness khi route
dùng private credential. Agent tự khai role hoặc provider catalog không thay authoritative readback.

## Assignment tối thiểu

```text
Objective: <observable outcome, không pre-solve solution>
Authority: <exact write Owner và scope | no-write; external effects>
Evidence: <behavior/checks cần quan sát>
Handback/stop: <stable artifact, completion hoặc blocker condition>
```

Chỉ thêm disposition, excluded scope, stable review input, escalation trigger hoặc bounded routing
override khi chúng làm thay đổi execution. Routing override cần exact reason, `applies_to` và expiry; nó
hết hiệu lực ở handback/stop.

## Cách vận hành từng role

### Lead

- bind exact identity, workspace, Human objective và Lead lease;
- dùng `list_profiles` như advisory shortlist khi route Peer, không coi notes là authority hoặc qualification;
- chọn topology nhỏ nhất và một Owner cho mỗi moving scope;
- giao neutral outcome brief, không giao conclusion cần xác nhận;
- nhận counterevidence và issue concrete ruling;
- review stable candidate bằng proportional evidence;
- giữ integration và engineering acceptance;
- preserve objective, accepted decisions, ownership, unknowns và next action khi handoff.

Lead chỉ sửa product trong exact tiny-task lease được Human/repository/protocol cho phép. Material work
không được vừa implement vừa self-accept.

### Peer

- nhận đúng một disposition như `Engineer/Owner`, `Architect`, `Reviewer`, `Scout` hoặc `Shadow`;
- giữ independent technical judgment trong bounded assignment;
- không mutate nếu thiếu exact write lease;
- không create, coordinate, stop, replace hoặc accept agent khác;
- preserve unrelated state và tự verify writes;
- dùng `REOPEN_REQUEST`, `DEPENDENCY_REQUEST`, `BLOCKED` hoặc `COUNCIL_REQUEST` khi conflict material.

Reviewer nhận stable candidate và falsification mandate. Reviewer không patch finding trong cùng review
lease.

### Supervisor

- bind exact workspace, current Lead, Human objective, decision source và reporting target;
- quan sát causal episode, không đọc rộng theo curiosity;
- tách observation, evidence, suspected mechanism, impact và unknown;
- gửi smallest correction cho Lead hoặc Human;
- không plan/staff product work, direct Peer, review product như Peer hoặc accept engineering.

Thiếu recovery/replacement lease nghĩa là `observe + advise only`. Exact recovery lease chỉ cho phép
bounded `STOP`/`FREEZE` hoặc relay Human decision trong stated condition. Lead replacement là flow riêng:
checkpoint, handoff, revoke old Lead, activate new Lead, rồi reconcile/ACK.

## Completion và manual handback

Peer hoặc Lead gửi handback thủ công theo shape:

```text
Outcome: <complete | partial | blocked | reopen requested>
Snapshot/candidate: <Git identity hoặc exact bounded identity>
Changed/inspected scope: <paths>
Verification/skips: <personally observed results và truthful omissions>
Unknowns/risks/Human decisions: <material only>
Ownership/lease: <released | retained with reason>
```

`completed`, notification hoặc test pass chỉ đánh thức authority holder. Lead inspect current stable
artifact và issue `ACCEPT`, `REOPEN`, `REJECT` hoặc `UNKNOWN` trong engineering boundary của mình.

## Candidate coordination signal

Current product code có durable advisory signal. Interface không interrupt active run và không chuyển
authority:

```bash
paseo agent signal <lead-id> \
  --kind handoff \
  --reason "Context dilution across repeated reopen"
```

Role-bound Lead là manual target và delivery đợi idle boundary. Slice có protocol, persistence,
CLI/client/tool, idle-boundary delivery và paid-provider integrated-runtime canary. Exact release chưa
được activate và chưa có multi-day operational proof, nên không dùng command trên như standing
production dependency.

Automatic attention hiện là source candidate trong bundled SLP policy path và mặc định bật. SLP sở hữu
threshold, routing, semantic-friction classifier, custom-event meaning và policy version; kernel chỉ giữ
generic declared subscriptions, versioned state, persistence, safe-boundary delivery, coalescing và
isolation. Lifecycle policy nhận closure event có owner/run receipt được capture trước khi agent bị xóa;
closed snapshot vẫn giữ active-turn fields là `null`, và close/cancel thường không tự tạo lost-run claim.
Emergency rollback đặt `PASEO_DISABLE_SLP_ATTENTION_POLICY=1`. Missing telemetry hoặc missing/ambiguous
role target fail closed.

F-06 Phase 2B chỉ có bằng chứng source/test: semantic-friction được gate trước khi buffer/classify,
Lead failure không có Supervisor duy nhất phát một coordination attention bounded, và protocol validator
được regenerate đồng bộ. Các receipt này không chứng minh release artifact, daemon đã cài, WebSocket live
hay multi-day operational effect; những lớp đó vẫn `UNPROVEN` cho tới khi có readback riêng.

Role-bound Supervisor có thể dùng bounded `ask_attention_question`, hoặc Human dùng CLI `--kind
question`, để hỏi Lead/Peer tại safe boundary. Request bắt buộc tách observation, open question và
evidence references. Nó không command, decide, accept hoặc transfer ownership; Peer không nhờ vậy có
signal/orchestration authority. Agent-scoped caller/target phải cùng exact workspace; imperative trá
hình hoặc wording command/acceptance/ownership/handoff/write/recovery bị reject. Attention đã
resolve/defer/decline/complete có thể re-arm ở episode/fingerprint mới, trong khi pending duplicate cùng
rule/fingerprint merge occurrence evidence thay vì phát prompt mới.

## Bounded checkpoint

Role-bound caller có thể dùng `get_agent_checkpoint` để đọc một projection bounded cho đúng target.
Host kiểm tra relationship, persisted assignment, pinned policy owner và exact tool ceiling trước khi
giao nguồn cho policy. Council chỉ dùng canonical seat/report/disposition records; case phase cao nhất
không phải collection barrier. Beads evidence chỉ đọc qua exact issue grant/target binding sau current
`beads_status` checkpoint; assignee hoặc dependency count thiếu binding không trở thành disposition.

Idle không phải bằng chứng hoàn thành. Thiếu lifecycle, Council, Beads hoặc disposition evidence trả
`UNKNOWN`, không tạo quyền accept, restart, replace hoặc taskgraph action. Những semantics này là source
candidate của `.57`; installed/live qualification và Lead engineering acceptance vẫn theo
[implementation handoff](research/2026-09-06-maestro-slp-implementation-handoff.md).

## Manual stop conditions

Stop condition là assignment contract, không phải daemon rule engine. Agent và authority holder phải dừng
và hand back thay vì improvise khi:

- identity, workspace hoặc Lead-of-record không resolve được;
- assignment thiếu mutation boundary hoặc có hai write Owner;
- provider không bind được exact role hoặc route muốn silent fallback;
- current bytes khác stable candidate được giao review;
- required evidence không thể reproduce;
- external effect, recovery hoặc replacement cần authority chưa được cấp;
- continued action có thể làm mất dữ liệu, phá lease hoặc tăng irreversibility.
