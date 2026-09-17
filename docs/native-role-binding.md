# ADR — Native Role Binding trong Paseo

Trạng thái: accepted by Human; durable-instruction implementations và focused static/fake tests hoàn tất; real-provider runtime canary là release evidence riêng và chưa nằm trong default CI
Ngày: `2026-08-06`
Foundation contract: `ROLE_CONTRACTS 3.2.0-topology-recovery`

## Quyết định

`Lead`, `Peer` và `Supervisor` trở thành Foundation roles native của Paseo. Role không còn được biểu diễn bằng ba provider alias hoặc ba bản cấu hình thủ công cho từng provider.

Một agent được tạo từ bốn layer độc lập, sau đó được compose thành một launch contract bất biến:

```text
RoleDefinition + optional ExecutionSpecialization + Provider + Workspace Protocol + Assignment
```

- `RoleDefinition` giữ identity, universal authority boundary và anti-pattern guards.
- `Provider` chỉ giữ transport, credentials, endpoint, model catalog và runtime capability.
- Root `WORKSPACE_PROTOCOL.md` là mandatory repository contract cho material work; Paseo quản lý path,
  digest, byte-validity state và readership. File absent cho phép exact no-write/no-external-effect role
  launch và ghi receipt `missing`, nhưng block delegation, mutation hoặc protected work cho tới khi
  bootstrap baseline hoặc có exact bounded Human exception. File hiện diện nhưng invalid luôn fail
  closed. Reader nhận mọi schema version đã phát hành; version marker không phải admission gate.
- `Assignment` giữ bounded objective, disposition, lease, scope, evidence, handback và stop condition.

Một Lead có thể thêm private execution specialization vào Peer binding khi repository protocol hoặc
bounded routing cần một method lặp lại nhưng không cấp authority mới. Provider-neutral
`solution-architect` và `reviewer` là hai Council/Lead-routing method; `review` là OCR exhaustive-review
method riêng cho [triple-lane review](review-lanes.md). Profile ID chỉ xuất hiện trong Lead-scoped
`create_agent` và private create receipt, không đi vào generic Peer catalog hoặc public role receipt.

## Vì sao không dùng initial prompt

Role phải đi qua provider-native durable instruction channel để còn hiệu lực sau compact, resume và turn mới. Initial user prompt, label hoặc convention không đủ làm standing authority boundary.

Daemon materialize role đã chọn thành một immutable `RoleBinding`. Binding chứa exact instruction bytes và public receipt:

```text
roleId
definitionVersion
definitionDigest
bindingDigest
provider
injectionMethod
qualification (`implementation-supported`; runtime acceptance evidence được record riêng)
createdAt
```

Client gửi `roleId` cùng một caller-authored `AssignmentEnvelope`; client không gửi hoặc sửa
materialized instruction. Daemon validate chéo role/disposition, effect/write boundary, issuer,
workspace, expiry và protocol exception rồi tạo immutable `AssignmentContract` có digest. Receipt
secret-safe được persist cùng `RoleBinding`; exact objective, evidence, handback và stop condition được
chèn vào durable role instruction. Resume/reload dùng exact persisted binding, không resolve lại từ
catalog hiện tại và không nhận role/system-prompt override.

Ngay trước launch, daemon compose `RoleBinding` với exact provider route thành một immutable
`LaunchContract`. Contract pin `roleId`, logical `providerId`, provider family, model,
`model_provider`, auth method, credential readiness và exact internal route bytes. Agent đã bind không đổi
model tại chỗ; muốn đổi role/provider/model phải spawn agent mới. Public snapshot, MCP create result và
`paseo agent inspect` chỉ trả secret-safe receipt cùng `credentialConfigured`, không trả base URL,
`credentialRef`, credential-file path hoặc secret.

Role catalog là một registry provider-neutral do Paseo sở hữu, pin `ROLE_CONTRACTS` version và doctrine precedence `Human → Deep Dive → Role Contract/Workspace Protocol → current evidence`; Giáo Án Herdr là extended historical evidence, không override source hiện hành. Đây là một catalog chung, không phải ba bản role config nhân với từng provider. `definitionDigest` làm drift visible; thay standing bytes phải đi cùng contract/version decision mới.

## Provider capability

Role và provider chỉ ghép được khi adapter có native durable instruction channel đã khai báo rõ:

- Codex: `developerInstructions` trên thread start/resume và từng turn; đồng thời khóa native delegation bằng `multi_agent=false`, `multi_agent_v2=false`, `agents.enabled=false`.
- Claude: Agent SDK `systemPrompt` append; đồng thời deny native delegation tools sau khi merge provider extras.
- Pi append exact binding bằng generated `before_agent_start` extension trên create/resume.
- OMP append exact binding bằng native `--append-system-prompt` trên create/resume.
- Cursor ACP materialize một stable private role capsule dưới Paseo state và ghi exact binding vào `.cursor/rules/paseo-role.mdc` với `alwaysApply: true`. Assignment có write lease dùng unattended route hiện hành; assignment `no-write` bị pin sang `--mode plan --sandbox enabled`, bỏ `--force`, bỏ `--approve-mcps` và đặt ACP `auto_accept=false`. Cả hai route dùng private `--workspace <capsule>` và `--add-dir <repo>` trước `acp`. Caller-supplied workspace, mode hoặc permission-policy flag bị reject để route không có hai nguồn policy. Không dùng `--plugin-dir`: installed runtime đã chứng minh local plugin có thể bị silent-ignore.
- Grok ACP materialize exact binding vào `session/new` và `session/load` `_meta.rules` trên official `grok agent stdio`. Role-bound process pin `GROK_SUBAGENTS=0` và `--no-leader`. Caller-supplied `--plugin-dir`, `--agent-profile` hoặc extra flag bị reject. Isolated spike ngày 2026-08-17 trên `grok 1.0.4` / `grok-4.6` đã chứng minh model đọc sentinel từ `_meta.rules` lúc create, resume process mới không gửi lại rules vẫn đọc đúng, session không có rules không thấy sentinel, và `GROK_SUBAGENTS=0` ẩn `spawn_subagent`. Assignment `no-write` fail closed: Grok ACP không expose session mode `plan`.
- Antigravity chỉ admit role `Peer`. Native adapter gọi official `agy` print-mode `stream-json`, materialize unique exact custom-agent profile với `run_command`, `inheritMcp: false`, `subagent: false`, persist native `conversation_id` và resume bằng `--conversation`. Paseo tools đi qua private loopback command gateway dùng caller-scoped catalog; gateway token chỉ tồn tại trong environment của exact AGY process và Beads Central credential không được project vào model. Route này không phụ thuộc ACP hoặc native AGY MCP converter. Isolated canary ngày 2026-08-13 trên `agy 1.1.12` và Beads Central `1.2.0` đã chứng minh model tự gọi `beads_status` + granted `beads_get`, rồi daemon restart và resume cùng agent để gọi lại thành công. Lead/Supervisor vẫn fail closed.
- Generic ACP không có standardized system-instruction field nên mặc định `unsupported`. Paseo auto-detect exact Cursor `cursor-agent … acp` và exact Grok `grok agent stdio`; Antigravity đi qua built-in native provider riêng. Custom ACP khác phải có provider-native driver riêng và qualification evidence trước khi được chọn cho role-bound spawn.

Capability có hai trạng thái: `supported` nghĩa adapter có implementation method mà role-first picker có thể dùng; `unsupported` nghĩa không có native durable channel hoặc launch shape hợp lệ. Supported receipt có thể mang allowlist `roleIds`; absence giữ compatibility với daemon cũ và nghĩa là mọi role. `supported` không tự chứng minh current-host runtime qualification hoặc mandatory tool transport; evidence đó phải đến từ fresh canary/readback riêng. Không fallback sang initial prompt hoặc generic ACP. Cursor và Grok là implementation-supported cho ba role; Antigravity native là implementation-supported riêng cho Peer; Grok no-write chưa qualify; legacy `cursor-plugin` fail closed với migration notice.

Technical role support không thay user-account policy; qualification dùng official `agy` cùng account đã được Human cấu hình và Paseo không đọc hoặc trả AGY token.

Không có silent fallback. Provider có model phù hợp nhưng thiếu native role channel vẫn không tương thích với Foundation role.

Lead-to-Peer routing có Human-configured allowlist, provider priority và optional global default subrole.
Agent Profile có thể mang `peerSubrole=scout|engineer|reviewer|architect` như routing metadata; field này
không phải ExecutionSpecialization và không cấp role, instruction, lease hoặc acceptance authority.
WebUI không đưa profile có `peerSubrole` vào Human model picker. Khi draft đã chọn một native role,
toàn bộ Agent Profiles surface trong model picker bị tắt và Human chọn provider/model trực tiếp; Human
vẫn quản lý inventory trong Settings, còn Lead dùng `list_profiles` rồi pin exact `launchProfileId` khi
gọi `create_agent`. Đây là downstream role boundary có chủ ý, khác reusable-profile UX của upstream.
`list_profiles` trả exact profiles, priority và default hiện hành. Exact `launchProfileId` luôn thắng. Khi
Lead bỏ field đó, daemon dùng specialization/disposition đã explicit nếu nó map được sang Reviewer hoặc
Architect; nếu không thì dùng global default. Resolver chỉ chọn profile cùng subrole từ provider sớm nhất,
materialize exact profile vào create receipt và fail closed khi không có match. Global default `null` giữ
hành vi bắt chọn exact profile. Sau khi một route đã được chọn, preflight hoặc launch failure không tự
failover sang provider khác; retry vẫn là create request mới để không che runtime failure.

Assignment `no-write` có thêm capability gate độc lập với durable instruction channel. Daemon pin Codex
vào `read-only`, Claude vào guarded `default`, Cursor/Antigravity vào `plan`, khóa mode switch và từ chối permission response
`allow` cho tool escalation; câu trả lời `AskUserQuestion` không cấp capability nên vẫn hợp lệ. Với
Claude, guarded `default` đi kèm built-in tool allowlist chỉ đọc và deny rõ `Bash`, các tool
edit/write notebook, worktree/cron mutation và `ExitPlanMode`; vì `allowedTools` chỉ pre-approve chứ
không thu hẹp tool surface, adapter dùng SDK `tools` làm strict allowlist. Exact Paseo MCP grants trong
immutable role tool policy còn được `canUseTool` auto-allow trực tiếp. Không dùng Claude `plan` vì Plan
workflow tự yêu cầu model tránh cả native Room coordination dù tool đã pre-approved; guarded `default`
loại variance đó mà strict tool surface vẫn giữ technical no-write. Tool ngoài receipt vẫn đi qua
permission gate bình thường. Pi và OMP vẫn có durable role channel nhưng chưa có no-write mode đã
qualify, nên no-write launch của hai route này fail closed.
Assignment boundary luôn thắng global Peer run mode và mode lưu trong Agent Profile: `no-write` ép
qualified read-only/guarded/plan mode với `unattended=false`; global `unattended` chỉ áp cho assignment có write
lease. Write-authorized assignment không bị gate này mở rộng scope: provider mode chỉ là capability,
assignment vẫn là authority.

### Hai Codex route độc lập với role

- Built-in `codex` là Codex native subscription. Preflight gọi app-server `account/read`, chỉ nhận
  `account.type=chatgpt`, pin `model_provider=openai`, giữ Codex auth store mặc định (`auth.json` hoặc OS
  keyring) và scrub ambient OpenAI API-key/base-URL variables khỏi role-bound process.
- Custom OpenAI-compatible Codex là một logical provider `extends: "codex"` có exact model catalog,
  `OPENAI_BASE_URL` non-secret và `credentialRef`. Daemon materialize exact custom `model_provider`, HTTPS
  `/v1` base URL và Codex command-backed auth đọc private credential projection. Thiếu explicit model, URL,
  credential ref hoặc configured key đều fail trước provider launch.

Custom route không fallback sang subscription khi preflight hoặc launch lỗi. Catalog custom cũng không kế
thừa model catalog của subscription. Hai route dùng chung Codex binary nhưng không dùng chung credential:
subscription giữ Codex auth store; custom dùng private Paseo credential store. Không tạo provider-specific
`CODEX_HOME` chỉ để tách API key; chỉ cần `CODEX_HOME` riêng nếu Human thật sự muốn hai Codex login store độc
lập.

Reproduced failure cũ trên custom `openai-compatible` Codex resume đến từ route selector không được pin
lại trên `thread/resume`, không phải vì custom API provider vốn không thể thấy Paseo tools. Adapter hiện
gửi lại exact persisted `modelProvider`, `model`, bound inner config, durable role instructions và required
Paseo MCP config trên interactive resume; admission vẫn đợi mandatory tool inventory. Ngoài source/fake
contract tests, isolated qualification ngày 2026-08-13 đã create một
`codex-zetscan/gpt-5.6-luna` Supervisor, để model tự gọi đúng `beads_status` và `beads_get` trên Beads
Central `1.2.0`, restart daemon, rồi resume chính persisted agent để lặp lại hai model tool calls thành
công. Đây là model-visible create/restart/resume receipt, không chỉ app-server `mcpServerStatus/list` hay
adapter-side preflight.

## Tool policy và authority

Role-bound session lấy tool enablement từ role; `paseoTools.enabled` chỉ là default cho session không
bind role. Provider `allowedTools` hoặc `disabledTools` vẫn có thể thu hẹp catalog của Lead và
Supervisor nhưng không thể mở rộng role authority. Global `daemon.mcp.injectIntoAgents=false` vẫn tắt
toàn bộ projection.

Paseo chỉ auto-approve exact MCP tools do Product quản lý, không blanket-approve global MCP config.
Runtime hiện inject `paseo` theo role/assignment tool projection và `semble.search` cùng
`semble.find_related` theo trusted manifest. Semble được pin `semble[mcp]==0.5.4`, chạy qua
Paseo-owned stdio proxy với uv-managed Python 3.12: `repo` phải canonical-equal assignment workspace
root, remote URL và symlink escape bị từ chối, còn Python/index/model/uv/temp cache nằm dưới
`$PASEO_HOME/tool-cache/semble/`. Daemon prepare exact Python/package/model trước khi nhận role-bound
session; injected proxy sau đó chạy `uvx` và Hugging Face ở offline mode để cold bootstrap không chặn
Codex MCP inventory hoặc tạo network effect từ assignment. Nếu `uvx`
hoặc packaged proxy thiếu thì trusted Semble không được inject; daemon không đổi assignment sang
`full-access` và không auto-approve một Semble server cùng tên do caller cung cấp.

Role ceiling và default projection là hai khái niệm khác nhau. Candidate SLP tools
`signal_agent`, `resolve_agent_signal`, `prepare_lead_handoff`, `transition_lead_handoff` nằm trong
ceiling để Human có thể bật explicit, nhưng không nằm trong default Lead profile. Supervisor cũng không
nhận mặc định `create_agent`, `send_agent_prompt` hoặc coordination-signal tools; exact governance
profile phải enable chúng có chủ đích. Provider policy không thể tự bật capability đã default-off.

- Cả ba role phải có `beads_status` và `beads_get`; thiếu MCP/native Paseo-tool transport là launch
  blocker, không phải lý do bỏ checkpoint hoặc dùng direct Central.
- Một successful `beads_status` receipt được bind với exact assignment digest; mọi Beads operation khác
  bị runtime từ chối cho tới khi receipt đó tồn tại. Final prose không chữa được checkpoint sai thứ tự.
- Lead có Paseo delegation/lifecycle và Beads mutation tools trong Human lease.
- Lead có `start_council` để tạo một Room thật và nhận canonical seat plan cho các Peer
  `scout|architect|reviewer`; Lead vẫn phải gọi `list_profiles` rồi `create_agent` cho từng seat, nên
  Council không sinh orchestration runtime thứ hai. Daemon persist một canonical `CouncilCase` dưới
  `$PASEO_HOME/councils/`; WebUI đọc record đó qua RPC thay vì dựng state từ labels.
  `record_council_seat` chỉ cho Lead cập nhật phase, integrity và disposition của direct Peer child
  thuộc đúng case/workspace; agent labels chỉ là compatibility receipt và tool không mở generic
  `update_agent`.
- Peer không có orchestration tools. Assignment `read-only` chỉ project Beads read tools và có thể
  `beads_get` issue liên quan mà không cần mutation grant; assignment `mutating` mới project mutation
  tools và vẫn bắt buộc exact daemon-verified issue grant.
  Peer có `post_room` như một communication capability để trả lời exact Lead-relayed Council challenge;
  Peer không có `read_room`, nên sealed seat không tự đọc Room history hoặc sibling positions.
- Supervisor chỉ có observation/governance và Beads read-only subset. Exact governance mandate cho
  phép `read_room` để audit trực tiếp Lead ↔ Peer evidence, nhưng không cấp `post_room`,
  `record_council_seat`, `list_profiles`, mutation hoặc acceptance authority; recovery/replacement vẫn
  cần exact Human lease.

`full-access` là runtime capability, không phải write lease, ownership, external-effect hoặc acceptance authority; đồng thời nó không được dùng làm fallback cho mutation boundary `no-write`.

## Workspace Protocol

Paseo không copy protocol vào global config. Repository tiếp tục sở hữu exact root
`WORKSPACE_PROTOCOL.md` v3. File thiếu, blank, unresolved, conflict, thiếu fixed Beads Central clause,
malformed identity hoặc unreadable đều fail closed trước ordinary role launch. Chỉ exact Human-issued
bounded bootstrap exception mới cho phép tạo file v3; exception không mở ordinary work. Paseo ghi nhận:

- resolved path;
- content digest và binding state (`bound|missing`) sau byte-validity gate;
- role-specific readership;
- receipt của lần bind.

Human quản lý file từ WebUI Project Settings. UI đọc trạng thái `missing|valid|invalid|unreadable`,
preview một baseline repository-specific khi thiếu, rồi chỉ bootstrap sau explicit Human action. Edit/save
dùng revision gồm digest để không overwrite thay đổi ngoài Paseo; content invalid, stale hoặc unreadable
đều fail closed và giữ current bytes. CLI/MCP không phải setup path dành cho Human.

Admission kiểm exact active project/workspace root, kể cả Paseo-owned worktree. Role-bound create
preflight trên WebUI và daemon kiểm lại trước provider launch hoặc state mutation. `invalid|unreadable`
luôn fail closed. `missing` fail closed cho ordinary work; chỉ exact Human-issued
`read-only|bootstrap|recovery` bootstrap/governance assignment mới được mang exception có reason,
exact cwd scope và expiry.
Bootstrap từ WebUI chỉ nhận bounded write scope tại root `WORKSPACE_PROTOCOL.md`; recovery chỉ có write
khi caller nêu exact scope. Exception không hợp thức hóa protocol invalid, không mở external effects và
không biến runtime `full-access` thành authority. Bootstrap mới sinh v3 với fixed issue-tracker clause.

Lead được bind full protocol trước orchestration. Peer không đọc full protocol và chỉ nhận relevant constraints trong assignment. Supervisor chỉ được bind full protocol khi governance assignment yêu cầu create/audit/update.

## UX hiện có và target UX

Current create flow đã có workspace, role-first picker, provider tương thích, model/mode và assignment. Sau spawn, public receipt được đọc bằng `paseo agent inspect`; provider detail có native method hoặc policy notice khi adapter cung cấp.

Target flow dưới đây **chưa ship đầy đủ**:

1. tạo/chọn workspace;
2. chọn role;
3. dùng assignment effect mặc định theo role (`Lead -> mutating`, `Peer|Supervisor -> read-only`),
   vẫn cho chọn các effect khác được role cho phép và hiển thị authority summary/protocol requirement; khi external-effect boundary là `bounded`, tick các preset trong danh mục host (`externalEffectCatalog` trong daemon config, sửa ở Host Settings) hoặc nhập mỗi external access grant trên một dòng, và Lead chỉ được truyền xuống các grant mà assignment của Lead đang giữ. Danh mục chỉ là nguồn gợi ý cho composer: daemon không đọc nó khi validate contract, và grant vẫn chỉ là chữ trong contract — không có sandbox nào chặn agent, nên credential phải tự nó đã bị giới hạn scope;
4. chọn một provider tương thích;
5. chọn model/mode và preview binding receipt;
6. nhập assignment rồi spawn.

Nếu protocol hiện diện nhưng invalid/unreadable, create flow đưa Human về Project Settings để correct
trên WebUI. Nếu protocol không tồn tại, ordinary role launch dừng trước side effect và đưa Human về
Project Settings; chỉ exact bounded bootstrap/governance exception mới được tạo để repair. CLI role create bắt buộc
`--assignment-effect`; write scope chỉ hợp lệ cho `mutating|bootstrap|recovery`.

Provider Settings chỉ cấu hình connection/credentials/model. Foundation Roles hiển thị role contract version, compatible providers, injection method và qualification state. Provider detail hiển thị native method, policy notice hoặc candidate blocker; role-first picker chỉ liệt kê `supported`. Cursor được nhận diện từ exact `cursor-agent … acp`; Grok từ exact `grok agent stdio`; Antigravity là built-in `gemini-antigravity`, mặc định gọi exact `agy`, nên catalog/config không cần ghi `roleBinding` thủ công. Antigravity receipt giữ `roleIds: ["peer"]` để non-Peer bị từ chối trước provider launch. Các provider alias như `codex-lead` là migration input, không phải product model mới.

Trong migration window, daemon nhận diện **exact legacy wrapper command** như `codex-profile <role>`, `codex-cliproxy-profile <role>` hoặc `claude --agent paseo-<role>`. Các route này bị loại khỏi native role-first picker và bị reject trước state mutation/session launch; Paseo không suy role từ provider ID tùy ý. Transport-only alias kế thừa Codex/Claude vẫn tương thích.

## Migration

Rollout theo vertical slices:

1. protocol schema, daemon registry, immutable receipt và inspect/readback;
2. Codex + Claude native injection và adversarial resume/reload tests;
3. role-first WebUI và CLI `--role`;
4. compose và persist immutable role/provider/model launch contract;
5. compatibility mapping cho legacy aliases với warning, không infer role từ arbitrary provider name;
6. Pi/OMP/Cursor/Antigravity native driver, exact qualification và transport-policy notice;
7. xóa generated per-role provider aliases sau migration window.

Không restart daemon hoặc mutate user credentials/provider activation trong implementation. Focused direct/ACP canary dùng installed native CLIs nhưng không đổi daemon activation; fresh daemon readback vẫn là release/activation gate riêng.

## Acceptance gates

- Raw create request không thể materialize hoặc override role instruction.
- Role-bound create thiếu assignment contract bị reject; effect/write contradiction, agent-issued
  protocol exception, scope mismatch và expired exception đều fail closed.
- Missing/invalid/unreadable protocol đều fail closed trước side effect; chỉ exact unexpired
  Human-issued bootstrap/governance exception được bind cho bounded repair.
- Role-bound session không nhận `systemPrompt` từ caller.
- Mỗi admitted resume/reload route giữ exact role bytes và digest đã persist; route chưa chứng minh
  model-visible mandatory Paseo tools phải fail closed trước interactive model turn.
- Execution specialization chỉ được role-bound Lead chọn cho fresh Peer, giữ exact profile receipt/bytes
  qua LaunchContract và resume, và bị redacted khỏi generic role receipt.
- Resume/reload giữ exact provider route và model; model mutation trên role-bound agent bị reject.
- Assignment `no-write` phải persist và launch bằng exact qualified no-write mode; provider thiếu mode
  đó bị reject trước session launch.
- Role-bound no-write session từ chối mode switch ra khỏi pinned mode và permission response `allow`
  có thể mở capability; `deny` và câu trả lời `AskUserQuestion` vẫn hợp lệ.
- Codex/Claude provider extras không thể ghi đè role instruction hoặc native-delegation guards.
- Built-in Codex chỉ launch khi native account readback là ChatGPT subscription.
- Custom Codex thiếu model/URL/key hoặc launch lỗi không fallback sang built-in subscription.
- Snapshot, MCP create result và `paseo agent inspect` hiển thị effective `roleId`, `providerId`, `model` và
  `credentialConfigured` nhưng không expose instruction hoặc secret-bearing route bytes.
- Agent role control trên WebUI mở redacted binding receipt gồm contract version, binding digest,
  protocol digest/readership, injection method và creation time; không hiển thị instruction bytes.
- Incompatible provider bị reject trước session launch.
- Protocol hiện diện nhưng invalid bị reject trước state mutation hoặc provider launch.
- Cursor capsule phải giữ exact role marker qua ACP create/resume mà không ghi `.cursor/rules` vào target repository.
- Antigravity native adapter phải pin exact materialized profile trên create/resume, chỉ cấp `run_command`, cleanup only exact owned profile, giữ gateway loopback/token private, persist exact conversation handle, và fail closed ngoài role Peer hoặc khi caller-scoped catalog không materialize được.
- Legacy no-role sessions tiếp tục chạy như trước.
- Workspace Protocol bootstrap không overwrite file vừa xuất hiện hoặc vừa đổi ngoài WebUI, và invalid
  preview không tạo partial file.
