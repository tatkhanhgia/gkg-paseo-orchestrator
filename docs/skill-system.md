# Hệ thống skill của Paseo

Paseo có hai nhóm skill khác nhau: product workflow skills giúp user điều khiển Paseo, và Foundation
role skills được admit theo SLP role. Skill là instruction package cho một loại attention/workflow; nó
không phải role, provider, tool permission hoặc authority lease.

## Product workflow skills

Các package dưới [`skills/`](../skills/) phục vụ client hoặc coding agent đang điều khiển Paseo:

| Skill             | Dùng khi                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| `paseo`           | Quản lý workspace, agent, script, provider, schedule và heartbeat         |
| `paseo-advisor`   | Lấy một second opinion mà không giao ownership của task                   |
| `paseo-committee` | Dùng hai advisor cho hard planning/root-cause question                    |
| `council`         | Lead chạy sealed evidence review và tự ra binding verdict, không vote     |
| `paseo-handoff`   | Chuẩn bị briefing và launch receiving agent; không transfer SLP authority |

Đây là product capabilities. Việc một package được install hoặc visible không cho agent quyền tạo
workspace, launch agent, mutate repository hoặc accept engineering. Current role, exact lease và exposed
tool catalog vẫn quyết định action hợp lệ.

Product package không đồng nghĩa với global package. Canonical admission cho product skill nhạy role nằm
tại [`skills/role-admission.json`](../skills/role-admission.json). `council` được admit `active` cho Lead và
`packaged-disabled` cho Peer/Supervisor. Daemon-owned host controller loại các package trong manifest này khỏi
catalog selectable, nhưng vẫn quản lý tên của chúng để phát hiện và gỡ bản global cũ. Daemon bundle exact
bytes rồi project vào từng role-bound session, nên một Lead có thể gọi Council trong bất kỳ workspace nào
mà không phụ thuộc `~/.agents/skills`, `~/.claude/skills` hay `~/.codex/skills`.

`council` khác `paseo-committee`: Committee là hai advisor hỗ trợ planning/root-cause; Council là
protocol Lead-only cho quyết định material, giữ Round 1 sealed, chỉ verify claim có thể đổi verdict và
không dùng vote. Default difficult Council tạo một Peer `solution-architect` và một Peer `reviewer` với
native provider-neutral execution specialization, distinct mandates và separate child issues. WebUI
project case từ `council.*` labels và lifecycle agent; nó là Human control/view surface, không phải
seat-to-seat transport. Report cùng binding verdict vẫn nằm trong timeline của seat và Lead. Council bind
một parent Beads case issue; mỗi Peer seat nhận exact child issue trong
`assignment.resourceGrants.beadsIssueIds`, phải chạy ordered `beads_status` +
`beads_get {view:"checkpoint"}` trước read-only source inspection, và chỉ được Lead đánh dấu integrity valid
sau khi mọi required seat đã terminal và activity audit xác nhận checkpoint, snapshot và
no-write/no-orchestration boundary. Checkpoint chỉ trả label count/narrative digests; source evidence đến
từ exact repository/snapshot đã authorize trong neutral brief.

`paseo-handoff` là workflow skill cho context briefing và agent creation. Nó không tạo adjacent-Lead
handoff packet/state machine, không revoke predecessor, không activate successor Lead và không chuyển
Human/Lead authority.

## Foundation role skills

Immutable Foundation packages nằm dưới [`foundation/dist/skills`](../foundation/dist/skills/). Canonical
admission map là
[`role-bundles.json`](../foundation/dist/skills/role-bundles.json):

| Role       | Active                                                                                           | Explicit-only                   | Packaged-disabled |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------------------------- | ----------------- |
| Lead       | `beads-issue-tracker`                                                                            | `repo-refresh`, `triple-review` | —                 |
| Peer       | `beads-issue-tracker`, `frontend-design`                                                         | —                               | `triple-review`   |
| Supervisor | `beads-issue-tracker`, `paseo-supervisor`, `architecture-premise-audit`, `test-proof-debt-audit` | —                               | `triple-review`   |

Ý nghĩa admission:

- `active`: role có thể dùng khi task khớp trigger và lease;
- `explicit-only`: chỉ dùng khi Human gọi exact skill;
- `packaged-disabled`: bytes được ship để provenance/review nhưng không eligible ở runtime;
- package không thuộc bundle của role phải bị hide hoặc disable cho role đó.

`beads-issue-tracker` là package mandatory duy nhất được daemon embed nguyên bytes vào durable role
instructions của cả ba role. Agent áp dụng package đã load này trực tiếp; không phụ thuộc global skill
discovery hoặc một copy cũ trong provider home. Thiếu/invalid package block role materialization.

Lead và Peer còn nhận một standing test-proof mandate do SLP policy compose
(`policy/bundled/slp/role-instruction-mandates.ts`): viết, sửa hoặc review test thì load user-global skill
`test-value` trước, ghi năm câu gate vào handback, không xoá/gộp/hạ test ngoài scope, và mang yêu cầu
này vào assignment khi delegate việc có test. Daemon chỉ gọi tên skill, không bundle bytes — source of
truth của `test-value` nằm ngoài Foundation. Supervisor không nhận mandate này vì đã có
`test-proof-debt-audit` trong bundle; hai rubric song song sẽ cho hai bộ verdict khác nhau. Mandate
nằm trong composed instructions nên chỉ binding tạo sau khi daemon chạy build mới nhận. Binding đã
persist là immutable: agent resume replay exact instructions cũ dưới owner cũ, kể cả khi rollback
executable. Bảng mandate thuộc canonical SLP artifact nên đổi mandate là đổi generation identity; xem
[retained pre-mandate generation](slp-bundled-policy-pack-audit.md#retained-pre-mandate-generation-080-paseo2-resume).

## Tại sao bundle theo role

Skill topology đi theo attention:

- Lead giữ integration attention, nên broad cleanup chỉ được mở bằng explicit Human intent.
- Peer giữ bounded implementation attention, nên `frontend-design` chỉ xuất hiện cho rendered UI work.
- Supervisor giữ process và proof attention, nên có causal supervision và hai audit lens read-only.

Expose mọi package cho mọi role tạo skill pollution: agent dễ trượt từ task sang orchestration,
architecture audit hoặc repository-wide cleanup mà assignment không yêu cầu.

## Trigger không cấp authority

Một skill chỉ được chạy khi cả ba điều kiện đều đúng:

1. package được admit cho current role;
2. user request hoặc task semantics khớp trigger của skill;
3. current lease cho phép các read, write, delegation hoặc external effect mà workflow cần.

Nếu skill yêu cầu action ngoài lease, dừng ở boundary và xin authority. Runtime `full-access`, skill
visibility hoặc lời gọi `$skill-name` không tự mở rộng project scope. Repository instruction và current
Human instruction có thể thu hẹp skill thêm.

## Progressive disclosure

Agent đọc toàn bộ `SKILL.md` sau khi chọn skill. Reference hoặc catalog lớn chỉ được load khi routing
instruction của skill yêu cầu. Ví dụ:

- `paseo-supervisor` dùng ordinary anti-pattern guards trước; chỉ mở broad structural catalog khi có
  reproduced workaround, architecture fog hoặc avoidable tax;
- `test-proof-debt-audit` bắt đầu từ một named behavioral claim và cited proof, không biến test yếu thành
  repository-wide audit;
- `architecture-premise-audit` chỉ dùng khi Human explicit yêu cầu broad premise audit;
- `repo-refresh` không bao giờ được implicit invoke.

Progressive disclosure giảm context pollution nhưng không cho phép đọc một phần `SKILL.md` rồi đoán phần
còn lại.

## Projection vào provider

Role bundle là canonical admission source; provider adapter chỉ là transport:

- Codex nhận exact `skills.config` với Foundation package ngoài bundle bị disable;
- daemon đồng thời embed exact active `beads-issue-tracker` package vào immutable RoleBinding cho mọi
  provider, nên mandatory checkpoint không phụ thuộc provider-native skill loader;
- Council dùng product role-admission manifest riêng nhưng cùng nguyên tắc: Codex command inventory lấy
  từ daemon bundle và inject exact `SKILL.md` vào đúng invocation `/council`; `skills.config` đồng thời
  disable stale/caller-supplied Council path. Package mang provenance `PASEO_DERIVATIVE`: giữ lineage
  Demonthorn nhưng có Paseo role/assignment guard, nên không được gọi là `DEMONTHORN_EXACT`. Cách này
  không phụ thuộc global discovery của Codex;
- Claude nhận Council như session-local single-skill plugin chỉ ở Lead; Peer/Supervisor vừa strip local
  plugin path, deny `Skill(council)` và hide plain/namespaced command khỏi inventory;
- Codex, Claude, Cursor và Zetscan có fresh bounded checkpoint canary trong current development
  candidate. Qualification vẫn là evidence của exact build/run, không phải universal reliability;
- global package link hoặc user-global install không được biến thành eligibility cho non-owning role.

Nếu Foundation `role-bundles.json` hoặc product `role-admission.json` missing, invalid hoặc trỏ tới package
không tồn tại, projection phải fail closed và không enable skill thuộc manifest đó. Static file presence
không chứng minh skill visible đúng role; release gate cần fresh Lead-positive và non-owning-role-negative
canary trên từng provider được claim.

## Thêm hoặc đổi Foundation skill

Không sửa [`foundation/dist`](../foundation/README.md) trực tiếp. Thực hiện thay đổi trong canonical
Foundation repository, rồi:

1. xác định provenance: `DEMONTHORN_EXACT`, `FOUNDATION_DERIVATIVE` hoặc `FOUNDATION_AUTHORED`;
2. viết narrow trigger và explicit non-trigger;
3. chọn role owner cùng admission state;
4. xác minh package không cấp authority hoặc native delegation ngoài Paseo;
5. cập nhật `skills/role-bundles.json` tại Foundation source;
6. tag một clean Foundation commit và import bằng `scripts/import-foundation.mjs`;
7. kiểm manifest/checksum, provider projection và fresh role-visible canary.

Exact Demonthorn package giữ exact bytes. Derivative phải ghi rõ thay đổi và lineage. Product workflow
skill dưới root [`skills/`](../skills/) có lifecycle riêng, dùng provenance `PASEO_DERIVATIVE` hoặc
`PASEO_NATIVE` tương ứng, và không được thêm vào Foundation role bundle chỉ vì tên hoặc chức năng gần
nhau.

## Checklist sử dụng

- Xác nhận current role và exact lease.
- Chọn một skill nhỏ nhất khớp task; không load skill theo curiosity.
- Đọc full `SKILL.md` và required references trước action.
- Giữ write/delegation/external effects trong assignment boundary.
- Report skill-caused pause hoặc material judgment trong manual handback.
- Không claim admission, activation hoặc qualification chỉ từ package presence.
