# Supervisor Notebook — contract và template

- Trạng thái: current Foundation contract/template
- Owner: Human/project owner
- Phạm vi: durable learning về orchestration behavior qua các Paseo workspace; không phải product truth

## Provenance

| Nhãn | Nguồn | Phần được giữ |
|---|---|---|
| `DIRECT_ARTIFACT` | [Demonthorn Supervisor profile](../references/demonthorn-profiles-refs/supervisor.config.toml) | durable cross-workspace record; chỉ thêm evidence novel/materially stronger; aggregate theo pattern; Supervisor không tự patch protocol khi chỉ monitoring |
| `CURRENT_DOCTRINE_SYNTHESIS` | [Deep Dive — Supervisor notebook](../references/demonthorn-agent-orchestration-deep-dive.md#supervisor-notebook) | causal context, evidence, open question, recovery và protocol candidate |
| `CURRENT_HUMAN_DECISION` | Human instruction ngày `2026-08-03` | record schema, lifecycle, authority boundary và yêu cầu giữ unsupported mechanism là `unknown`/hypothesis |
| `HISTORICAL` | `/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-workflow-project/SUPERVISOR_NOTEBOOK.md` | lineage only; không copy project-decision/task-tracker shape thành current contract |

Catalog provenance rộng hơn nằm tại [Demonthorn supplied materials catalog](../references/demonthorn-supplied-materials-catalog.md#supervisor-notebook-và-continuous-optimization). `DIRECT_ARTIFACT`, `CURRENT_DOCTRINE_SYNTHESIS` và current Human decision không phải ba authority ngang nhau; source precedence vẫn theo `AGENTS.md`.

## Contract

Supervisor Notebook là durable organizational memory về coordination failure, recurring anti-pattern, recovery và protocol experiment. Nó giống lab notebook có causal context, không phải:

- transcript hoặc telemetry dump;
- task tracker, product bug backlog hay project decision log;
- repository evidence, engineering acceptance hoặc authority source;
- nơi lưu secret, credential, raw chain-of-thought hoặc suy đoán được viết như fact.

Chỉ thêm record khi episode novel, material hoặc cung cấp evidence mạnh hơn cho một pattern đã có. Nhiều occurrence giống nhau được aggregate vào cùng pattern; không tạo một entry cho mỗi symptom hoặc mỗi healthy task. Observation tách khỏi `Suspected mechanism`; mechanism chưa được chứng minh phải giữ là `unknown` hoặc hypothesis.

## Record tối thiểu

```text
Pattern / episode:
Scope + date:
Observation:
Evidence:
Suspected mechanism: <hypothesis | unknown>
Impact/cost: <momentum | ownership | attention | quality | authority>
Question for Lead:
Recovery/intervention: <what happened; who held authority>
Outcome:
Pattern status: <one-off | repeated | durable | disproved>
Recommendation/protocol candidate: <smallest correction | none>
Escalation needed: <no | exact Human/Lead decision>
```

`Pattern status` chỉ là mô tả judgment hiện tại, không phải workflow state machine. Khi evidence mới bác hypothesis, preserve correction/disproof thay vì rewrite record như hypothesis cũ chưa từng tồn tại.

## Lifecycle

```text
concrete episode
  → Supervisor thu bounded evidence
  → hình thành causal hypothesis
  → hỏi Lead bằng open evidence-backed question
  → ghi recovery và outcome
  → aggregate nếu pattern tái diễn
  → đề xuất smallest profile/Workspace Protocol change
  → Human hoặc đúng authority approve/apply
  → đánh giá trên comparable workstream tiếp theo
```

Supervisor được observe, hỏi, ghi learning record và propose. Notebook không tự cho phép Supervisor direct Peer, sửa/review product, tự apply proposal, tự replace Lead hoặc accept engineering work. Một separate exact Human recovery lease có thể cho phép bounded `STOP`/`FREEZE` hoặc decision relay theo Role Contracts; authority đó đến từ Human binding, không đến từ notebook. Accepted project decision vẫn vào project decision source; rule đã được duyệt mới vào `WORKSPACE_PROTOCOL.md` hoặc standing role profile.

## Location và binding

Foundation không hard-code historical path `/root/.config/room-workflow/SUPERVISOR_NOTEBOOK.md`. Mỗi Supervisor binding phải chỉ ra một durable notebook location, scope và reporting target; không tạo per-session copy. File này là canonical contract/template, không phải database hoặc live cross-project ledger engine.

## Grant và write semantics

Ghi vào notebook chỉ hợp lệ khi binding hiện tại cấp một **explicit grant** (`scope` + `expiry`); grant đó
là một bounded capability do runtime cấp có kiểm soát, không phải provider filesystem write — Supervisor
filesystem vẫn no-write kể cả khi có grant. Thiếu grant nghĩa là `observe + propose only`: Supervisor ghi
đề xuất record vào handback text cho Lead/Human thay vì tự ghi vào notebook. Ghi phải revision-safe
(expected-revision write) và không tạo notebook mới chỉ vì đổi worktree trong cùng project;
`notebookId`/`location`/`projectScope`/`reportingTarget`/`designatedWriter` do project binding gắn khi tạo
notebook, không tự suy từ cwd hoặc tên thư mục.

## Rule promotion — owner/authority/review-removal trigger

Một `Recommendation/protocol candidate` chỉ được đề xuất promote thành `WORKSPACE_PROTOCOL.md` hoặc
standing role profile khi record nêu đủ: reproduced failure (không phải một lần suy đoán), owning layer
đúng, lý do vì sao convention/deletion đơn giản chưa đủ, đúng owner có authority approve, và một
**review/removal trigger** cụ thể (điều kiện hoặc evidence sẽ khiến rule này bị revisit/gỡ bỏ). Chỉ một
comparable later episode mới hỗ trợ claim "cải thiện"; nếu chưa có, giữ `Unobserved`/hypothesis. Khi
evidence mới bác một hypothesis cũ, preserve correction/disproof trong record — không rewrite như thể
hypothesis cũ chưa từng tồn tại. Supervisor không tự apply promotion; chỉ đúng authority (Human/Lead theo
binding) mới approve.

## Material records

### `P-001` — Protocol admission và mechanism hardening trước later-effect proof

**Scope + date:** Paseo Foundation doctrine, protocol bootstrap, role profiles, validator và product
roadmap; audit ngày `2026-08-06` theo current Human instruction. Không có project Lead đang được bind
cho một engineering change; Human chỉ authorize audit và record gap, không authorize policy repair.

**Observation:** Foundation giữ đúng ba instruction layer và đã làm `AGENTS.md`, provider role profiles
cùng root protocol khá mỏng. Friction nằm ở semantic coupling và lifecycle quanh chúng: active root
`WORKSPACE_PROTOCOL.md` đang là điều kiện admission cho ordinary Lead → Peer; zero-delta repository và
zero-Peer tiny task chưa có đường current rõ; byte gate không đánh giá semantic adequacy nhưng nằm trên
critical path của routing. Song song, current decision/roadmap surfaces đã freeze nhiều runtime hoặc
future mechanism trước khi single-project learning loop có comparable later-effect proof.

**Evidence:**

- [Deep Dive §2.4](../references/demonthorn-agent-orchestration-deep-dive.md#24-provider-và-model-phải-được-discover)
  nói role policy không nên hard-code model ID dễ lỗi thời; [§4.3](../references/demonthorn-agent-orchestration-deep-dive.md#khi-nào-lead-tự-làm)
  cho phép Lead làm tiny tightly-coupled task khi protocol cho phép; profile mẫu đọc protocol `when
  present`; [§6.4](../references/demonthorn-agent-orchestration-deep-dive.md#64-protocol-không-nên-chứa-gì)
  cấm ceremony bắt buộc cho mọi task.
- [First edition Bài 11](../references/giao-an-herdr-first-edition.md#bài-11-herdr-phải-cùng-tồn-tại-với-harness)
  yêu cầu inspect existing Harness trước khi thêm workflow và coi component chưa chứng minh giá trị là
  ceremony; task nhỏ, rõ và có transfer cost lớn hơn lợi ích thì không fan-out; multi-project chỉ mở
  rộng sau khi workflow một project ổn định.
- `D-016`, `ROLE_INSTRUCTION_BINDING.md` và `PORTABLE_BOOTSTRAP_AND_ROUTING.md` cùng encode absent
  protocol → ordinary route `BLOCKED`; `D-025` làm protocol mỏng nhưng giữ fail-closed admission.
- Live A/B disposable workspace `wks_8ba3426128684199` dùng cùng repository, task và provider:
  no-protocol Lead trả đúng `41` mà không thiếu technical information; protocol phase tạo một Scout và
  vẫn trả `41`. Phase A khoảng `58.7s`/`23,071` input tokens; Phase B Lead khoảng
  `96.8s`/`47,135` cộng Peer `19,986`. Experiment cố ý tiny và Phase B yêu cầu Scout, nên nó chỉ chứng
  minh protocol hoạt động như topology/admission token trong case này, không chứng minh mọi protocol
  hoặc delegation đều vô ích. Runtime inspect còn trả role-binding metadata `null`; behavioral marker
  và parentage đã thấy nhưng metadata-level binding vẫn `UNKNOWN`.
- `CURRENT_DECISIONS.md` hiện có 27 decisions/277 dòng, gồm durable authority invariants lẫn local
  path/hash, exact model pin, provider canary state, downstream projection và future installer/secret
  RPC. `ROADMAP.md`, `PASEO_CONTROL_WORKSPACE.md` và `FOUNDATION_ALIGNMENT_AUDIT.md` thêm 888 dòng trong
  cùng commit `b2e3832` trong khi audit tự ghi learning loop chưa outcome-supported.
- Validator 1,066 dòng mechanically require exact `gpt-5.6-sol`, D-021, D-022, D-026, D-027 và
  protocol-absence failure. Vì vậy một số candidate mechanism đã trở thành source-validity requirement,
  làm reversal tốn hơn prose đơn lẻ.

**Gap set cần qualification/close sau:**

1. `G-01 PROTOCOL_AS_ADMISSION_PROXY` — tách authority từ Human/assignment khỏi sự tồn tại của
   repo-specific tactics file; định nghĩa zero-delta repository trước khi giữ hoặc bỏ D-016.
2. `G-02 ZERO_PEER_PATH_AMBIGUOUS` — chốt Lead-direct tiny path có phải current supported topology hay
   không; không dùng mandatory Peer để biểu diễn “smallest useful set”.
3. `G-03 BYTE_GATE_CLAIM_MISMATCH` — byte validity không được suy thành semantic adequacy, authority
   correctness hoặc project readiness; không chữa bằng semantic policy engine trước khi có need.
4. `G-04 LATER_EFFECT_EVIDENCE_MISSING` — bootstrap/reviewer pilots đã proof local mechanics, chưa proof
   quality/safety/coordination gain so với no-protocol/default route trên comparable tasks.
5. `G-05 DURABLE_AND_OPERATIONAL_STATE_MIXED` — tách invariant agent không được phá khỏi machine-local
   activation, provider inventory/canary và temporary candidate mechanism; current decision repetition
   không phải independent evidence.
6. `G-06 EXACT_MODEL_HARDENING` — reconcile standing exact model + validator pin với doctrine
   discover-and-route; nếu giữ pin, cần current Human reason, scope, expiry/review trigger thay vì coi là
   durable role law.
7. `G-07 STAGE_INVERSION` — requalify detailed repository-admission state machine, Better Harness
   adapter, evidence index, Control Workspace slices và installer/credential mechanisms trước khi build;
   product direction không tự chứng minh từng mechanism.
8. `G-08 GAP_REGISTER_SOLUTION_BIAS` — `F-01`, `F-03`, `F-05`, `F-11` và `F-12` đang có nguy cơ coi
   missing state machine/taxonomy/adapter/index là product gap. Mỗi mục phải quay lại reproduced problem,
   frequency, simpler/deletion route và decision-changing later evidence trước khi được close bằng
   machinery.
9. `G-09 NAVIGATION_EFFECT_UNKNOWN` — instruction/profile bytes hiện khá mỏng, nhưng chưa có test chứng
   minh toàn current documentation surface giúp agent tìm owning code/contract nhanh hơn. Không kết luận
   doc count tự nó là lỗi; đo time-to-owner, repeated reread và wrong-owner rate trước khi giữ/xóa.

**Suspected mechanism:** `HYPOTHESIS — local-excellence trap + stage inversion`. Development nhanh gom
policy, provider transport, validator và product roadmap vào các batch lớn; reviewer tối ưu internal
coherence và fail-closed behavior của candidate đã chọn, nhưng counterfactual/deletion test đến sau.
Điều này có thể biến current observation thành durable law và khiến Foundation giải quyết uncertainty
bằng thêm artifact/state thay vì để Lead dùng bounded judgment.

**Impact/cost:** admission latency, token/context amplification, Human activation work, khó rollback
mechanism, stale provider/model policy, và agent phải phân biệt durable authority với runtime history.
Safety benefit ngoài exact tested lanes còn `UNKNOWN`; không được suy rằng bỏ gate sẽ an toàn cho
high-risk work.

**Question for Lead/Human:** Repo/task class nào có reproduced failure mà standing role + existing
Harness + bounded assignment không ngăn được? Constraint nào thật sự cần durable repo protocol, và
constraint nào chỉ cần task brief, current config/readback hoặc một plan sống tới handoff?

**Recovery/intervention:** không sửa D-016, role profile, validator, roadmap hoặc runtime trong audit
này. Preserve current bytes và current authority; record gap để một future exact Human/Lead lease
requalify premise trước implementation.

**Outcome:** gap được ghi durable; chưa gap nào `closed`, chưa mechanism nào bị reject toàn cục.
`AGENTS.md`, root protocol và role profiles được exonerate về độ dài tại checkpoint này; nội dung exact
pin/admission và surrounding documentation lifecycle mới là phần cần falsify.

**Pattern status:** `repeated / material hypothesis`; supported bởi protocol bootstrap history, live A/B,
model/validator pin và pre-pilot productization surfaces. Causal attribution “do phát triển nóng” vẫn là
hypothesis, không phải fact.

**Recommendation/protocol candidate:** trước prose/schema/validator mới, chạy bounded counterfactual
trên ít nhất tiny read-only, bounded write và high-risk/policy-sensitive task; freeze exact intervention
identity, đo outcome/violation/Human work/context cost, rồi giữ, thu hẹp hoặc rollback từng mechanism.
Không tạo state mới hoặc adapter chỉ để close tên gap.

**Escalation needed:** exact Human decision để reopen D-014/D-016/D-021–D-027 hoặc đổi normative
surfaces. Notebook record này không supersede current decisions và không cấp quyền apply.

#### Closure update — `2026-08-06`

Human sau đó authorize close `P-001` với yêu cầu mechanism phải work và có logic, không tối ưu việc
điền đủ gap. Intervention giữ outcome boundary và xóa prerequisite chưa được proof:

- `G-01/G-02`: D-011 chốt protocol là optional repo delta; true absence là zero-delta path. Lead-direct
  tiny write chỉ hợp lệ khi applicable Human/repository/protocol binding cho phép và transfer không thêm
  independent judgment. D-006/D-011/D-019 ghi exact Human reconciliation với wording hẹp hơn của Deep
  Dive; protocol vẫn được dùng khi material recurring tactics thật sự cần sống qua task.
- `G-03`: checker chỉ claim structural/byte integrity. True absence pass; blank/conflicted/unresolved,
  directory hoặc broken-symlink artifact fail closed. Không thêm semantic admission engine.
- `G-05/G-06`: standing decisions/profile source bỏ machine-local history và exact model pin; model/
  effort là task route. README tách canonical source khỏi current runtime readback. Installed runtime có
  thể còn lag source và không được mutate/restart trong lease này.
- `G-07/G-08`: admission state machine, Control Workspace slices, installer/credential RPC, adapter,
  evidence index và multi-project mechanism bị hạ thành deferred hypothesis; thiếu chúng không tự là
  product gap.
- `G-04/G-09` không được giả close: later-effect, protocol value theo task class và navigation effect
  còn ở `O-01/O-02/O-04`; portability còn `O-05`, route qualification theo need còn `O-03`.

**Verification:** `python3 -m py_compile scripts/validate_foundation.py scripts/codex-profile.py`,
`scripts/validate-foundation` và `git diff --check` pass. CLI counterfactual pass cho target absent và
current present-valid; malformed present file fail đúng identity guard. Validator tự chạy directory và
broken-symlink adversarial probes.

Live disposable workspace `wks_8773382e819f0244` không có `WORKSPACE_PROTOCOL.md`: baseline có một
failing exact-stock test; Lead `14e7b7b0-bcb8-4e12-b449-831009ee812e` nhận exact Human direct-write
binding, không tạo Peer, đổi một boundary trong `inventory.py`, và independent rerun pass `3/3`. Một
attempt trước đó `14640eab-12b9-4d90-9e99-3133edadbabf` fail `401` vì test harness trỏ
`CODEX_HOME` vào source-profile directory và làm mất auth; đây là harness failure trước task, không
phải protocol result. Retry dùng disposable home với auth/profile symlink và không mutate global
activation.

Independent observe-only Supervisor `8b210892-0235-4c53-960b-7c07daa95df4` trước hết phát hiện bốn
gap nhỏ còn lại: doctrine reconciliation thiếu, tiny-direct authority quá rộng, non-regular protocol
artifact false-pass và semantic overclaim. Sau correction, agent re-read frozen 15-path diff SHA-256
`3d6725f2e5299dbd26e25ad9d755c0862db74fa9089b0dfdc873e790f0852d1d`, xác nhận đủ bốn correction và
không thấy contradiction material mới; agent không issue acceptance.

**Outcome:** `G-01/G-02/G-03/G-05/G-06(source)/G-07/G-08` closed ở current source. `G-04/G-09` và
behavioral qualification được retain thành outcome experiments, không còn là architecture
prerequisite. Current runtime activation/readback của model-neutral source vẫn `UNKNOWN` cho tới một
separate Human-authorized activation; static/source close không được báo thành runtime close.

**Pattern status:** structural over-hardening đã được corrected; causal hypothesis “phát triển nóng”
chưa được chứng minh. Comparable later episodes mới quyết định correction này có giảm ceremony mà
không tăng policy/ownership violation hay không.
