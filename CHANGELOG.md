# Changelog

## 0.7.0-paseo.59 - 2026-09-08

Bản sửa transport và admission đã được Lead chấp nhận ở source/test; qualification
installed/runtime và activation vẫn do Caller thực hiện.

### Đã sửa

- Sửa public Project Harness WebSocket responses để boolean payload.ok đi qua generated
  validator và giữ correlation cho inspect, preview, apply, update và notebook.release.
  Bằng chứng chi tiết: [handoff transport izq](docs/research/2026-09-08-project-harness-native-transport-handoff.md).
- Cho phép Claude no-write đọc đúng pinned harness resource sau admission path/digest
  validation; path khác, write và resource stale vẫn fail closed. Bằng chứng:
  [handoff resource Claude](docs/research/2026-09-08-slp-mandatory-resource-read-handoff.md).

### Giới hạn qualification

- Live native .59 Claude Read canary và installed/runtime qualification còn chờ Caller.
- Client WebUI .58 đã cache cần reload hoặc mở new tab sau activation để nạp validator
  mới; update daemon một mình không thay đổi client đã load.
- Không có qualification rollback/resume .57; backup archive được Caller authorize và
  giữ bền vững theo receipt, còn .57 downgrade vẫn BLOCKED.

## 0.7.0-paseo.57 - 2026-09-06

Bản phát hành ứng viên cục bộ cho tranche G1–G5. Mục này chỉ mô tả source candidate; chưa khẳng định
artifact đã cài đặt, daemon đang chạy, tuyến provider hoặc engineering acceptance.

### Đã thêm

- Các seam contribution/resolver policy nội bộ trusted cho generic host, gồm real non-SLP catalog path qua
  cơ chế admission của `AgentManager`, native instruction/tool intersection, persisted state và event
  delivery.
- Entrypoint read-only `get_agent_checkpoint` qua production tool catalog với relationship/owner binding,
  role ceiling, canonical Council receipt và exact target-bound Beads evidence.
- Event subscription được khai báo, owner/run evidence được capture trước closure và policy teardown
  được quiesce.

### Đã sửa

- Durable finish-notification watch kiểm tra lại assignment expiry thêm một lần tại shared provider-start
  boundary sau load/mode preparation; expiry tại boundary này tạo explicit nonretry drop, phân biệt
  terminal delivery với permission-only record, và biến observed-run persistence không đổi thành no-op
  để state notification không đệ quy vô hạn.
- Omission/default semantics của Council và compatibility của roles-only vẫn do policy sở hữu; partial
  role input vẫn giữ parsing compatibility mà không hàm ý required-method completeness.
- Semantic-friction matching của attention vẫn giữ live admission phía sau một quoted fixture trước đó,
  gồm bounded English/Vietnamese corpus.

### Tương thích

- Policy owner hiện có tiếp tục được pin bằng generation digest; nếu historical generation không khả dụng
  thì fail closed và SLP không bao giờ được thay cho trusted owner khác.
- Closed agent snapshot tiếp tục giữ active-turn field ở `null`. Lifecycle loss attention yêu cầu
  started-run evidence đã capture và không phân loại close/cancel thông thường là lost run.

### Xác minh

- Các regression focused hiện tại và static check được ghi trong
  [handoff triển khai `.57`](docs/research/2026-09-06-maestro-slp-implementation-handoff.md).
- Local release vẫn yêu cầu hai local commit sạch, artifact provenance, activation có idle gate,
  daemon/WebUI/Beads readback, provider và role canary mới, cùng Foundation doctor. Các gate này vẫn
  đang chờ đối với source candidate này.

## 0.7.0-paseo.56 - 2026-09-05

Bản follow-up này sửa hai release qualification regression lộ ra khi chạy full CI trên promoted
release line.

### Fixed

- Relay E2E resolve Wrangler qua public package export thay vì private subpath
  `wrangler/bin/wrangler.js`, vốn không còn được package export.
- Giữ nguyên runtime behavior của relay; thay đổi chỉ sửa cách test harness khởi động Wrangler CLI.
- Role-profile regression kiểm tra exact 16-tool Peer ceiling, gồm năm read-only browser tools, thay vì
  giữ count `11` đã cũ và không mô tả authority boundary.

### Verification

- Relay suite pass với `FORCE_RELAY_E2E=1` (`50 passed`, `1 skipped`) và focused role-profile suite
  pass (`4 passed`); release candidate vẫn phải qua full CI và portable qualification trước khi tạo
  stable tag.

## 0.7.0-paseo.55 - 2026-09-04

Bản này hoàn tất tranche usability của doctrine audit: đưa coordination signal đã persist vào agent
detail, bổ sung disposition controls có capability gate, và sửa structural parser để version/path có
dấu chấm không còn bị hiểu nhầm là câu thứ hai.

### Added

- Agent detail hiển thị đầy đủ `reason`, `observation`, `question`, evidence refs, structured evidence,
  occurrence metadata và status của coordination signal.
- Mọi signal `pending` luôn hiện trước; history đã resolve được giới hạn ở năm mục gần nhất và có
  hidden-count, tránh lịch sử không giới hạn chiếm toàn bộ composer area.
- Human có thể ghi disposition `acknowledged`, `deferred`, `declined` hoặc `completed` qua additive
  coordination RPC. Controls chỉ hiện với daemon quảng bá `coordinationSignalResolution`, chỉ áp dụng
  cho signal `pending`, serialize mutation và có accessible loading/error feedback.

### Fixed

- Snapshot/directory/timeline projection giữ `coordinationSignals` từ persisted agent record, nên app
  không còn làm mất field này trên compact update.
- Attention-question structural parser chấp nhận numeric dotted versions và slash-containing paths,
  gồm absolute path, `.worktrees` và các compound suffix repo dùng, nhưng vẫn reject multi-sentence
  payload nối liền bằng dấu chấm, kể cả các bypass chữ thường như `.risk` và `.gaps`.

### Verification

- 510 focused protocol/client/server/app tests pass; repo format-check, lint và toàn bộ workspace
  typecheck đều sạch ở source candidate. Installed daemon, WebUI interaction và live Supervisor→Lead
  journey được qualification riêng sau release activation; multi-day effectiveness vẫn `UNKNOWN`.

## 0.7.0-paseo.54 - 2026-09-04

Bản này xử lý tranche tự động của doctrine audit: gỡ coupling prose khỏi attention question và bỏ
compatibility generation SLP lịch sử không còn removal window, đồng thời làm rõ đường báo Human khi
Lead thất bại lặp lại mà không có Supervisor duy nhất.

### Fixed

- `ask_attention_question` dùng structural bounds và deterministic denylist tiếng Anh/Việt thay cho
  positive grammar allowlist; câu hỏi proposition-specific tự nhiên được phép, còn action, verdict,
  ownership, handoff và external-effect request vẫn fail closed.
- Semantic-friction chỉ buffer/classify khi workspace có đúng một role-bound Supervisor. Fragment lúc
  Supervisor thiếu hoặc ambiguous không được giữ lại để ghép vào signal sau đó.
- Lead đạt ngưỡng ba `turn_failed` mà không có Supervisor duy nhất nay phát một typed coordination
  notification tới Human cho mỗi failure episode; ordinary error notification vẫn bị suppress như cũ.
- Xóa frozen SLP v1.0 generation và các module compatibility `.45`; exact historical owner không còn
  được alias sang policy hiện hành mà fail closed với `bundled_policy_pack_missing`.

### Foundation và compatibility

- Import Foundation `0.1.0-dev.24` từ `906f48c`; sách doctrine không còn là runtime fixture trong
  `foundation/dist`, còn `templates/attention-question-examples.json` vẫn là example data độc lập.
- `AgentAttentionReason` không đổi. Optional `notification.data.category="coordination"` giữ protocol
  tương thích; startup chỉ queue coordination alert trong một bound cố định, không replay lifecycle
  notification cũ.
- `foundation/sources.lock.json` pin upstream `v0.7.0` đúng commit
  `c56638ea8c2852d722a87e700abf3c966ded617e`.

### Verification

- Focused policy/protocol/server/app regressions, formatter, lint và workspace typecheck đều pass ở
  source candidate. Installed/live daemon, WebSocket journey và multi-day effectiveness vẫn cần
  qualification riêng; không suy diễn các lớp đó từ unit tests.

## 0.7.0-paseo.53 - 2026-09-04

Bản này ngừng buộc Foundation doctor vào một audit provider đã được retire.

### Fixed

- `providers.audit` nay là qualification route optional. Operator có thể bỏ field khi không còn audit
  provider đã qualify; `ORCHESTRATION_READY` giữ `UNKNOWN` rõ ràng thay vì `FAIL` vì route cũ không còn
  trong live catalog.
- Doctor không tự fallback sang provider/model khác và không nâng trạng thái thiếu route thành `PASS`.
  Route vẫn được cấu hình tiếp tục phải qua exact live-catalog, model, credential fingerprint và
  connection-receipt checks như trước.

### Configuration

- Local orchestration preference không còn trỏ tới `codex-zetscan/gpt-5.6-sol`; các Supervisor
  capability preferences khác được giữ nguyên.

## 0.7.0-paseo.52 - 2026-09-04

Bản follow-up này sửa hai nhãn topology còn có thể làm Human đọc sai trạng thái và role.

### Fixed

- Host topology không còn gọi toàn bộ agent chưa archive là `active agents`; agent `closed` vẫn được
  giữ trong lịch sử nhưng summary chỉ ghi `agents`.
- Agent cũ chưa có launch-profile receipt nay dùng role thật (`Lead`, `Supervisor`, `Peer`) cạnh
  assignment disposition, thay vì mặc định sai thành `Peer`.

### Verification

- Bổ sung regression coverage cho historical Lead/Supervisor và giữ exact Peer subrole khi receipt
  có mặt.

## 0.7.0-paseo.51 - 2026-09-04

Bản follow-up này giữ pane lịch sử đọc được sau khi SLP generation đổi trong `.50`.

### Fixed

- `logs`, timeline pagination và prompt index của agent đã đóng nay đọc durable timeline khi exact
  pinned SLP generation không còn trong daemon mới, thay vì cố resume provider rồi trả
  `bundled_policy_pack_missing`.
- Read-only fallback không áp dụng cho send, reload, mode change hoặc action khác có thể resume/mutate;
  các action đó vẫn fail closed nếu exact historical policy generation không khả dụng.

### Compatibility

- Không đổi snapshot/storage schema. Existing `.49` Lead/Peer panes đọc lại được trên `.51`; receipt
  policy cũ vẫn không được nâng cấp ngầm thành current policy.

## 0.7.0-paseo.50 - 2026-09-04

Bản này sửa cách Product biểu diễn và thực thi topology role-bound: quan hệ ownership, exact Agent
Profile/Peer subrole và tên pane nay khớp với assignment mà Human và Lead đã chọn.

### Added

- Persist exact `launchProfile` receipt gồm profile ID, tên và Peer subrole qua snapshot, storage,
  reload, CLI inspect và Topology inspector; mỗi node cũng hiển thị provider/model, mode và assignment
  disposition.
- Cấp cho Lead/Peer/Supervisor các browser tool read-only để inspect tab, snapshot, wait, screenshot và
  logs; các thao tác mở tab, navigate, click, type, upload hoặc evaluate vẫn không được role mặc định
  cấp quyền.

### Fixed

- Xếp các Peer cùng Lead theo sibling lanes ngang và ghi rõ `Delegated by`/`Supervised by`, tránh layout
  làm một Peer trông như parent của Peer còn lại.
- `create_agent` giữ exact Agent Profile và Peer subrole: profile sai subrole, thiếu subrole hoặc mode
  không tương thích nay fail closed thay vì bị hiểu như một route khác.
- Roll back directory workspace/worktree được tạo dở khi authority, profile, provider, mode hoặc agent
  admission thất bại trước khi agent tồn tại, không để lại pane rác sau tool-call failure.
- Dùng `create_agent.title` làm tên workspace/pane đầu tiên; prompt dài chỉ còn phục vụ branch metadata,
  không còn biến thành nhãn khó đọc cho Human.

### Compatibility

- `launchProfile` là field optional, nên snapshot/storage cũ vẫn đọc được; agent đã tồn tại trước `.50`
  có thể không có receipt này, còn agent tạo mới sẽ có exact route evidence.
- Import Paseo Foundation `0.1.0-dev.23` để Lead không fallback sang subrole/provider/mode khác khi exact
  Peer route không launch được. Daemon/Foundation fingerprint mới làm receipt/canary runtime cũ stale
  và cần qualification lại sau activation.

## 0.7.0-paseo.49 - 2026-09-02

Bản này xử lý debt dependency còn lại sau merge upstream `v0.7.0`, giữ nguyên protocol,
persistence, authority và continuity-attention contracts của `.48`.

### Fixed

- Nâng các dependency nằm trên shipped paths của WebSocket daemon/CLI/Desktop/Relay, desktop updater,
  YAML, MCP HTTP, URI/IP parsing và Markdown parser lên fixed versions trong supported range.
- Nâng Cloudflare Vite plugin, Wrangler, Miniflare, Sharp và Vite tới fixed floor tương thích Node.js 22;
  website client/SSR tiếp tục build từ cùng cấu hình hiện tại.
- Giữ `react-native-markdown-display` ở contract Markdown-It 10 của upstream, đồng thời inject parser
  Markdown-It 14 đã vá cho mọi Product surface và kiểm tra compatibility qua native AST adapter.
- Pin các transitive build dependencies có safe same-major fix, gồm `tar`, `shell-quote`, `ws`,
  `undici`, `brace-expansion`, `picomatch`, `node-forge`, `nanoid`, `xmldom` 0.8 và PostCSS của Vite.

### Security

- Loại bỏ cả hai production critical findings ở `.48` và các high findings trên shipped runtime paths.
- Các high còn lại thuộc Expo 54/Metro build graph quanh `image-size` và Expo-pinned PostCSS; npm chỉ
  đề xuất Expo 57 major nên lane này được giữ lại để migrate cùng native stack thay vì override vượt
  support range.

### Compatibility

- Không đổi database, workspace-layout, coordination-signal hoặc updater ownership schema.
- Attention policy `slp.attention` generation 4 và Human-only lifecycle boundaries giữ nguyên.

## 0.7.0-paseo.48 - 2026-09-01

Bản này tích hợp upstream `v0.7.0` sau hop bắt buộc `0.6.1-paseo.47`, đồng thời giữ nguyên
authority, provider, updater và continuity-attention contracts của Paseo Product/Foundation.

### Added

- Nhận plugin Git sources, plugin timeline/composer-pill/host UI, SSH daemon connections, workspace
  Command Center actions, row-based replica cache, smooth text reveal, image zoom/pan, Astro
  highlighting và forge status improvements từ upstream.
- Áp exhaustive inbound/outbound permission map cho cả downstream Beads, Council, Foundation
  credentials/provider connection/Workspace Protocol, role profiles, distribution updater và
  coordination signal operations.

### Changed

- Attention fanout chỉ tính client có matching agent/terminal directory subscription và
  `workspace.read`; session không có authority không nhận event và không được tính vào presence plan.
- OpenCode helper bridge giữ dormant trong shipped Product vì OpenCode không thuộc provider allowlist;
  chỉ custom provider ID thực sự derived từ Codex mới được support.
- Test daemon inject explicit no-Semble runtime; production bootstrap vẫn prepare pinned trusted Semble
  runtime như trước, tránh cold-download làm broad bootstrap tests timeout giả.

### Fixed

- Giữ downstream Human-only lifecycle cho plugin và Hub permission mutation; read-only catalog/status/
  logs dùng `daemon.read` thay vì đòi mutation authority.
- Giữ Claude/Codex no-write enforcement, role/assignment/Beads/Topology semantics và active bundled SLP
  Attention policy khi compose provider runtime, selective timeline replacement và authorization mới.
- Desktop App updater mới của upstream tiếp tục ẩn/dormant; portable distribution updater vẫn là owner
  duy nhất của install/apply/rollback trong downstream.
- Nix dependency hash và cả Mattermost, React Native, OpenCode SDK patch sets được regenerate/verify từ
  clean npm install thay vì nhận lock/hash hoặc `node_modules` cũ.

### Compatibility

- Client replica cache chuyển từ legacy blob sang row store rồi xoá cache cũ. Rollback về `.47` có thể
  cần refetch timeline/directory cache, nhưng không xoá daemon agents, workspaces hoặc source checkout.
- Persisted workspace layout version 2 từ `.47` giữ nguyên; Attention policy `slp.attention` generation
  4 và downstream AGPL-3.0-or-later distribution không đổi.
- Production npm audit có cùng `65` advisory và cùng hai critical transitive packages như `.47`; merge
  không thêm production advisory, nhưng debt `shell-quote`/`tar` vẫn cần lane remediation riêng.

## Upstream 0.7.0 - 2026-08-31

### Changed

- Changed the upstream project license to Apache-2.0; the downstream distribution remains AGPL-3.0-or-later ([#3944](https://github.com/getpaseo/paseo/pull/3944))
- Changed Cmd/Ctrl+E to toggle Explorer visibility without selecting a view ([#3896](https://github.com/getpaseo/paseo/pull/3896))
- Changed the default mobile content text size from 15px to 16px ([#4111](https://github.com/getpaseo/paseo/pull/4111))

### Added

- Added plugin installation and updates directly from Git repositories ([#3920](https://github.com/getpaseo/paseo/pull/3920))
- Added plugin-defined timeline transformations and rendering ([#3940](https://github.com/getpaseo/paseo/pull/3940))
- Added SSH connections to existing remote daemons from Desktop and CLI ([#3989](https://github.com/getpaseo/paseo/pull/3989) by [@reidlevesque](https://github.com/reidlevesque))
- Added workspace management and layout actions to the Command Center ([#3013](https://github.com/getpaseo/paseo/pull/3013) by [@cleiter](https://github.com/cleiter))
- Added contextual composer-pill contributions for plugins ([#3956](https://github.com/getpaseo/paseo/pull/3956))
- Added host UI primitives for client plugins ([#3967](https://github.com/getpaseo/paseo/pull/3967))
- Added readable prompts, details, and results for Paseo tool calls ([#4066](https://github.com/getpaseo/paseo/pull/4066))
- Added zoom and pan to workspace images and assistant timeline previews ([#4032](https://github.com/getpaseo/paseo/pull/4032), [#4049](https://github.com/getpaseo/paseo/pull/4049), [#4064](https://github.com/getpaseo/paseo/pull/4064))
- Added opening child folders directly in the preferred desktop editor ([#3615](https://github.com/getpaseo/paseo/pull/3615) by [@caikovsky](https://github.com/caikovsky))
- Added host navigation from plugin surfaces to agents and workspaces ([#3901](https://github.com/getpaseo/paseo/pull/3901) by [@omercnet](https://github.com/omercnet))
- Added host-rendered icons to plugin client surfaces ([#3903](https://github.com/getpaseo/paseo/pull/3903) by [@omercnet](https://github.com/omercnet))
- Added semantic surface, border, success, and warning colors to plugin themes ([#3898](https://github.com/getpaseo/paseo/pull/3898) by [@omercnet](https://github.com/omercnet))
- Added registered project listing to the public plugin SDK ([#3899](https://github.com/getpaseo/paseo/pull/3899) by [@omercnet](https://github.com/omercnet))
- Added PR and MR number search to the Command Center ([#3008](https://github.com/getpaseo/paseo/pull/3008) by [@cleiter](https://github.com/cleiter))
- Added session commands to agent SDK handles ([#3719](https://github.com/getpaseo/paseo/pull/3719) by [@gpambrozio](https://github.com/gpambrozio), [@marvin-ambrozio](https://github.com/marvin-ambrozio))
- Added F-Droid release metadata and stable changelog generation ([#2501](https://github.com/getpaseo/paseo/pull/2501) by [@antonok-edm](https://github.com/antonok-edm))
- Added Astro syntax highlighting to files, the editor, and diffs ([#3997](https://github.com/getpaseo/paseo/pull/3997))

### Improved

- Streamed assistant text at a steady visual rate instead of in arrival lumps ([#3612](https://github.com/getpaseo/paseo/pull/3612) by [@Tommypop2](https://github.com/Tommypop2))
- Painted cached conversations before unrelated cache restoration and network loading ([#3907](https://github.com/getpaseo/paseo/pull/3907))
- Reused one OpenCode helper across ordinary agent sessions instead of spawning one per agent ([#4009](https://github.com/getpaseo/paseo/pull/4009))
- Batched GitHub pull request polling within the reserved API budget ([#3825](https://github.com/getpaseo/paseo/pull/3825) by [@dezchai](https://github.com/dezchai))
- Added manual, action-required, and warning states to GitLab and Gitea checks ([#2337](https://github.com/getpaseo/paseo/pull/2337) by [@nllptrx](https://github.com/nllptrx))
- Kept cold-start pull request status checks on the shared GitHub batch path ([#4025](https://github.com/getpaseo/paseo/pull/4025))

### Fixed

- Fixed the daemon crashing when a Claude or OMP JSONL process closes during a write ([#4048](https://github.com/getpaseo/paseo/pull/4048))
- Fixed Android first-message submissions crashing when the keyboard restarted during composer teardown ([#4044](https://github.com/getpaseo/paseo/pull/4044))
- Fixed long mobile drafts hiding composer controls behind the keyboard ([#4051](https://github.com/getpaseo/paseo/pull/4051))
- Fixed Android timelines shifting when tapping selectable text ([#4090](https://github.com/getpaseo/paseo/pull/4090))
- Fixed web and Electron composers losing focus after submission ([#4067](https://github.com/getpaseo/paseo/pull/4067))
- Fixed Android dictation leaving Bluetooth audio in call-quality routing after capture stopped ([#4069](https://github.com/getpaseo/paseo/pull/4069))
- Fixed dictation retries timing out after an abandoned partial transcript ([#4065](https://github.com/getpaseo/paseo/pull/4065))
- Fixed immediate dictation submissions omitting the newest speech segment ([#3968](https://github.com/getpaseo/paseo/pull/3968))
- Fixed the model selector crashing in iPad desktop layouts ([#3992](https://github.com/getpaseo/paseo/pull/3992) by [@yzim](https://github.com/yzim))
- Fixed OpenCode child-session prompts missing from provider subagent timelines ([#4055](https://github.com/getpaseo/paseo/pull/4055) by [@mcowger](https://github.com/mcowger))
- Fixed archived agents disappearing when opened from History ([#4033](https://github.com/getpaseo/paseo/pull/4033))
- Fixed restored workspace tabs entering reconciliation loops ([#3987](https://github.com/getpaseo/paseo/pull/3987))
- Fixed archived workspaces returning from durable cache ([#3975](https://github.com/getpaseo/paseo/pull/3975))
- Fixed Grok unified-billing accounts showing zero credits instead of weekly usage ([#4029](https://github.com/getpaseo/paseo/pull/4029) by [@Lite-G](https://github.com/Lite-G), [@claude](https://github.com/claude))
- Fixed daemon reconnects stalling while Git processes were queued ([#3945](https://github.com/getpaseo/paseo/pull/3945))
- Fixed slow Pi and OMP startup requests timing out after 30 seconds ([#4008](https://github.com/getpaseo/paseo/pull/4008))
- Fixed commits and squash merges bypassing configured Git signing ([#3976](https://github.com/getpaseo/paseo/pull/3976))
- Fixed Android system navigation covering the Commits controls ([#4005](https://github.com/getpaseo/paseo/pull/4005))
- Fixed new agent work appearing as reopened tasks ([#4068](https://github.com/getpaseo/paseo/pull/4068))
- Fixed Markdown literal characters being replaced by typographic symbols ([#3253](https://github.com/getpaseo/paseo/pull/3253) by [@cleiter](https://github.com/cleiter))
- Fixed rewinding long conversations replaying the complete rebuilt timeline ([#3642](https://github.com/getpaseo/paseo/pull/3642))
- Fixed rewound prompts remaining blank in the mounted iOS composer ([#3946](https://github.com/getpaseo/paseo/pull/3946))
- Fixed native plugin setup and async client callbacks failing on iOS ([#3942](https://github.com/getpaseo/paseo/pull/3942))
- Fixed ACP agents reporting the terminal capability as unavailable ([#3910](https://github.com/getpaseo/paseo/pull/3910) by [@pmilanez](https://github.com/pmilanez))
- Fixed canceled Claude permission requests leaving stale permission cards ([#3792](https://github.com/getpaseo/paseo/pull/3792))
- Fixed plugin daemon sessions hiding agents from non-legacy providers ([#3902](https://github.com/getpaseo/paseo/pull/3902) by [@omercnet](https://github.com/omercnet))
- Fixed manually admitted desktop updates disappearing during readiness checks ([#3865](https://github.com/getpaseo/paseo/pull/3865))
- Fixed mobile Changes and pull-request actions opening outside Explorer ([#3867](https://github.com/getpaseo/paseo/pull/3867))
- Fixed older desktop builds deleting settings written by newer builds ([#3909](https://github.com/getpaseo/paseo/pull/3909) by [@cleiter](https://github.com/cleiter))
- Fixed composer height flashing after returning from Settings ([#3943](https://github.com/getpaseo/paseo/pull/3943))
- Fixed selected workspaces having no visible highlight in the Light theme ([#3922](https://github.com/getpaseo/paseo/pull/3922) by [@wdaubney](https://github.com/wdaubney))
- Fixed the scrolling diff order disagreeing with the Changes tree ([#3913](https://github.com/getpaseo/paseo/pull/3913) by [@cleiter](https://github.com/cleiter))
- Fixed incorrect Spanish translations for Close actions ([#3934](https://github.com/getpaseo/paseo/pull/3934) by [@antonio](https://github.com/antonio))

## 0.6.1-paseo.47 - 2026-09-01

Bản này tích hợp tuần tự upstream `v0.6.1` trước lane `v0.7.0`, đồng thời đưa source-test baseline
của continuity attention trở lại trạng thái qualified.

### Improved

- Nhận upstream Command Center token matching/ranking, Settings Escape, pull-request auto-archive
  safety và one-time workspace layout v1-to-v2 migration.
- Giữ downstream provider support policy trong model/profile E2E.

### Fixed

- Protocol compatibility tests không còn giả định mọi top-level message option là một object schema;
  nested coordination-signal union tiếp tục giữ nguyên wire shape.
- Role/tool and bundled-policy assertions pin current `resolve_agent_signal` inventory và active SLP
  generation thay vì stale literals.
- Session/wire test doubles implement continuity timeline contract thay vì để `getTimeline` fail rồi
  bị handler che thành empty/error response.
- Agent profile đổi provider không còn làm cleanup race xoá `featureValues` trước
  `create_agent_request`; unsupported provider và feature-query error vẫn fail closed.

### Compatibility

- Persisted workspace layout được nâng lên version 2; rollback về `.46` có thể reset local layout or
  draft-tab state, nhưng không xoá daemon agents hoặc workspaces.
- Frozen `.45` SLP generation và active `.46` Attention generation không đổi trong hop này.

## Upstream 0.6.1 - 2026-08-25

### Improved

- Command Center matches partial multi-word queries in any order and ranks visible results by
  relevance ([#2971](https://github.com/getpaseo/paseo/pull/2971)).

### Fixed

- Persisted Side panel tabs migrate into an ordinary side pane instead of Explorer
  ([#3861](https://github.com/getpaseo/paseo/pull/3861)).
- Escape closes Settings on desktop and web
  ([#2828](https://github.com/getpaseo/paseo/pull/2828)).
- Branch switches no longer hide the current pull request or arm auto-archive from an already merged
  pull request ([#3799](https://github.com/getpaseo/paseo/pull/3799)).

## 0.6.0-paseo.46 - 2026-08-31

Bản này hoàn thiện continuity attention theo Foundation doctrine: kernel chỉ giữ event/state,
persistence và safe-boundary delivery dùng chung; bundled SLP sở hữu classifier, routing, threshold,
question grammar và policy version.

### Added

- Event-driven SLP attention policy mặc định bật, đánh thức đúng một role-bound Supervisor khi có
  repeated failure, context pressure, compaction pressure hoặc semantic friction có evidence; emergency
  rollback dùng `PASEO_DISABLE_SLP_ATTENTION_POLICY=1`.
- Supervisor có surface `ask_attention_question` để hỏi đúng một câu authority-neutral, evidence-backed
  tới Lead hoặc Peer cùng workspace; command, verdict, acceptance, ownership transfer, handoff, write và
  recovery language đều bị fail closed.
- Agent inspect/projection công bố continuity metadata runtime thực sự biết: context/tokens/cache khi có,
  compaction count, idle timestamp/duration, task snapshot và held locks; dữ liệu provider không hỗ trợ
  tiếp tục là optional/UNKNOWN.
- Foundation `0.1.0-dev.22` được import với hai orchestration-doctrine books và canonical production
  attention-question corpus; runtime test validate toàn bộ marker qua chính production grammar.

### Changed

- Native hard-coded coordination policy được thay bằng generic event-policy runtime; persisted state,
  coalescing, retry và restart delivery được namespace theo exact pinned policy generation.
- Automatic attention chuyển từ opt-in native switch sang normal bundled SLP path mặc định bật; role
  tool defaults/ceilings cho phép recipient resolve signal và Supervisor chỉ có minimum question tool.
- Client/CLI dùng feature negotiation trước attention question; wire format `.45` tiếp tục chấp nhận
  `relatedAgentId` optional và chỉ enforce yêu cầu mới sau parse.

### Fixed

- `.45`, legacy, missing hoặc corrupt generation không còn nhận nhầm `.46` attention; cả Human ingress
  và agent-tool ingress kiểm tra exact target generation trước khi persist.
- Consecutive failures tích luỹ qua realistic `turn_started -> turn_failed`; terminal dispositions và
  distinct semantic episodes re-arm hợp lệ mà không replay/polling hoặc prompt storm.
- Pending signals merge bounded occurrence evidence theo explicit requester/target/content identity;
  trigger khác nhau không nuốt nhau, invalid `used > maximum` telemetry giữ UNKNOWN thay vì clamp.
- Frozen-generation parse/digest/registration failure không làm mất active `.46`; partial registration
  vẫn fail closed cho exact `.45` owner cho tới khi một registration hoàn chỉnh xoá failure.
- Portable release artifact build pin bounded Node old-space `4096 MiB`, tránh Metro worker bị OOM ở
  khoảng `2 GiB` trên cả macOS arm64 và x64 runners khi bundle WebUI.

### Compatibility

- Frozen SLP `1.0.0` của `.45` giữ nguyên exact digest
  `569c7f4633b7ffacb2e63c0ee3dda1ea882bc050bc456fdc8ac0c466f4f483f0`, default-off automatic policy
  và generation-local role/tool semantics.
- Active SLP `1.1.0` sau Foundation import có digest
  `02607618aea9fee766b468c7063ad17dc270ca7a7bba868d0ed8b436821ec172`; Foundation provenance bind tag
  `foundation-v0.1.0-dev.22`, commit `b91c43e528658f7f82029173f4d06146ca2db77e`.
- Legacy non-SLP agents và ordinary Paseo tiếp tục hoạt động; unsupported or corrupt pinned owners fail
  closed, không silently map sang active generation.

### Qualified

- Independent Codex `gpt-5.6-sol` Peer review APPROVE, không còn actionable P0/P1/P2.
- Focused portability/grammar suite pass `102/102`; full touched 18-file matrix pass `692/692` với
  diagnostic test ceiling 30 giây.
- Server/CLI build, all 12 workspace typechecks, lint `4,034` files, format `4,329` files, Product diff
  check và clean detached Foundation validator `26/26` đều pass trên feature commit `2d4236ac5`.
- Counterevidence được giữ nguyên: default 5-second broad matrix timeout ở pre-existing MCP worktree
  broadcast test sau 583 assertions; exact test hoàn tất khoảng 6.2 giây với diagnostic ceiling, không
  có unrelated patch để che timing này.

## 0.6.0-paseo.45 - 2026-08-27

Bản này tách SLP khỏi semantic ownership của Product kernel thành first-party bundled policy plugin,
trong khi giữ provider transport, persistence và technical enforcement ở đúng owning layer.

### Added

- Bundled `slp` policy generation sở hữu Lead/Peer/Supervisor definitions, execution profiles,
  Assignment/Workspace Protocol composition, tool/skill ceilings, Council và coordination policy.
- Mỗi role-bound agent persist đúng một owner receipt: `legacy-core` hoặc
  `plugin:slp@<generation-digest>`; WebUI/CLI hiển thị owner và daemon cung cấp dynamic role/profile
  catalog từ active bundled generation.
- Bundled lifecycle có reserved plugin ID, immutable generation retention và fail-closed resolution;
  không bật global local-plugin switch hoặc cho local plugin shadow first-party `slp`.

### Changed

- Kernel chỉ materialize, validate, persist và inject exact role/profile/assignment bytes qua native
  provider channels; resume và hot reload resolve generation đã pin thay vì rematerialize từ active
  policy mới.
- Execution-profile, Council seat/kickoff và Lead handoff/coordination semantics resolve qua bundled
  contribution; Room/Beads identity, durable lifecycle và no-write enforcement vẫn do kernel giữ.
- Room messages persist trusted `agent`/`client` provenance. Human CLI post dùng unprivileged `manual`
  author; CLI JSON/transcript expose `authorKind`, còn agent phải dùng trusted `post_room` tool.

### Fixed

- Duplicate owner, missing/unsupported bundled generation và local-plugin collision fail closed thay
  vì silent fallback về legacy core hoặc dual injection.
- Create preflight/rollback không để orphan directory workspace hoặc worktree khi SLP admission fail
  sau provisioning; persisted tool ceiling tiếp tục được enforce trên daemon restart và native resume.
- Council report chỉ hợp lệ khi exact Peer-authored Room message có trusted provenance và generation-
  pinned policy validation.

### Compatibility

- Persisted legacy agents tiếp tục dùng frozen `legacy-core` policy; compatibility imports và static
  role labels chỉ phục vụ daemon cũ, không được active SLP mượn ngược hoặc dùng khi daemon mới báo lỗi.
- Codex developer instructions, Claude system append, Pi/OMP native hooks, Cursor capsule và
  Antigravity custom-agent injection vẫn ở provider adapters; không thay bằng initial user prompt.
- Ordinary non-SLP Paseo tiếp tục hoạt động khi bundled SLP unavailable, nhưng mọi launch yêu cầu SLP
  đều fail closed.

### Qualified

- Focused protocol/server/app/CLI/provider suites, all-workspace format/lint/typecheck, clean
  Server/CLI build và bundled daemon WebUI build đều pass trên feature bytes.
- Exact CLI Room integration pass Human post/read/wait, forged-agent rejection và `client` provenance
  readback; năm regression files bị sandbox `EPERM`/`EMFILE` đã rerun serial ngoài sandbox và pass
  `50/50`.
- Exact source SHA `554a519a0da56537082bdfc2728597c1199e0438` pass toàn bộ GitHub CI run
  `33010105304`; Docker/distribution run `33010105258` của cùng SHA cũng pass.
- Bundled owner digest là
  `569c7f4633b7ffacb2e63c0ee3dda1ea882bc050bc456fdc8ac0c466f4f483f0`; canonical role và execution
  artifact SHA-256 lần lượt là `8d0f521248b2713b38fdcd8f13502e0f22cc6951da568aefd78447c010506e74`
  và `22a49ef57d7ca26ce1540a5ab28e911015d7aa3f568c05b94a5d627e7b372ec6`.

## 0.6.0-paseo.44 - 2026-08-25

Bản này đưa Product downstream lên cùng stable base `v0.6.0` của upstream bằng exact two-parent merge,
đồng thời giữ nguyên authority và orchestration contracts của Foundation.

### Added

- Dedicated Explorer dock có Files/Changes, ordinary closable side pane và per-source main/side
  placement; file, diff, agent, terminal, pull request và plugin panel có thể mở thành tab độc lập.
- Tablet có Explorer dock resizable; Windows/Linux dùng shared custom window chrome contract mới.

### Fixed

- OpenCode initial SSE stream được retry có giới hạn và readiness chờ authoritative
  `server.connected`, tránh nhận prompt khi provider chưa thật sự sẵn sàng.
- Multiline composer tiếp tục resize đúng sau workspace/agent transition; Android tablet/foldable
  không crash và settings persistence chịu được app revision khác nhau.

### Compatibility

- Topology, Project Issues, role-bound workspace admission, Room/Council, Beads Central, trusted
  Semble và portable updater tiếp tục do downstream sở hữu; chúng được thích nghi sang pane host mới
  thay vì bị thay wholesale bởi upstream.
- Merge parent upstream là `6da9fa43fa97629af365c280b2ad7d0e7692c025`; post-tag
  `upstream/main` không thuộc release input.

### Qualified

- Focused App/Server/Protocol/Desktop suites pass `677` unique assertions; isolated Playwright cho
  Explorer placement, Explorer lifecycle và workspace restart pass `3/3`.
- All-workspace typecheck, full lint/format, Server/CLI build, daemon WebUI bundle và local macOS
  Desktop ZIP/DMG build đều pass.
- `package-lock.json` pass completeness check; official `prefetch-npm-deps` từ exact pinned nixpkgs
  tính lại `npmDepsHash` thành `sha256-43VSgJglb7fbyZmjeNdRM4WVV9i/JM7BKRk4ZloLThc=`.

## 0.5.0-paseo.43 - 2026-08-25

Bản follow-up này sửa boundary giữa assignment authority và provider execution: `read-only` tiếp tục
được enforce bằng provider no-write mode, trong khi exact read tools do Paseo quản lý không còn rơi vào
approval deadlock hoặc mutation ACL không liên quan.

### Added

- Role-bound provider có trusted Semble MCP manifest cho đúng `search` và `find_related`, với exact
  per-tool auto-approval thay vì blanket approval.
- Paseo-owned Semble proxy pin `semble[mcp]==0.5.4` và uv-managed Python 3.12; canonical workspace root,
  remote URL, symlink escape và toàn bộ Python/index/model/uv/temp cache đều có explicit boundary.
- Daemon prepare pinned Semble package/model trước role launch; assignment-side proxy chạy offline để
  cold bootstrap không làm timeout Codex MCP inventory.

### Fixed

- Peer `read-only` có thể gọi `beads_get` mà không cần issue mutation grant, đúng assignment contract;
  Peer `mutating` vẫn bắt buộc exact daemon-verified Beads issue grant.
- Effective Peer tool projection loại `beads_create`, `beads_claim`, `beads_update` và
  `beads_add_dependency` khỏi read-only launch thay vì chỉ chờ handler từ chối mutation.

### Compatibility

- Trusted Semble chỉ được inject khi provider hỗ trợ MCP và exact per-tool preapproval, đồng thời host
  có `uvx`; thiếu runtime thì giữ assignment mode hiện tại, không fallback sang `full-access`.
- Caller-supplied MCP server tên `semble` không được nhận trusted status hoặc auto-approval; namespace
  này được reserve khi Product inject trusted runtime.

## 0.5.0-paseo.38 - 2026-08-25

Bản follow-up này tiếp tục giữ exact upstream `v0.5.0` và gỡ các đường ownership bị phân mảnh khi
đưa Deep Dive/Foundation vào Product: Council có một aggregate chuẩn; Central chỉ sở hữu nghiệp vụ
issue, không sở hữu availability của daemon/WebUI.

### Added

- Council có canonical file-backed `CouncilCase` aggregate, correlated list RPC và push event riêng;
  đúng ba seat identity `Scout`, `Architect`, `Reviewer` cùng receipt-bound report state.
- `/api/health` công bố Beads Central là component `ready` hoặc `degraded`; artifact smoke xác nhận
  daemon/WebUI vẫn healthy khi sidecar thiếu hoặc không trả lời.

### Changed

- WebUI đọc Council từ canonical RPC/cache/event, không poll hoặc reconstruct case từ agent labels;
  report readiness và Lead-owned verdict giữ canonical record làm authority, còn agent directory chỉ
  phục vụ live status và navigation.
- Seat assignment được commit trước initial prompt; store enforce same-workspace launch, unique role,
  monotonic phase và report receipt khớp Room/kickoff/author.
- Lead mặc định không nhận signal/handoff tools; Supervisor mặc định không nhận create/prompt/signal
  tools. Human-configured role profile vẫn có thể opt in trong Foundation ceiling.
- Beads sidecar startup chạy độc lập với daemon startup; Central operations tiếp tục fail closed khi
  component degraded.

### Compatibility

- Legacy Council labels được migrate một lần theo canonical role/scope; duplicate role giữ bản mới
  nhất, malformed case bị skip và legacy `valid` thiếu canonical receipt bị hạ về `unspecified`.
- Agent labels chỉ còn compatibility receipt; không tạo thêm service, process, database hoặc polling
  loop cho Council/Central.
- Release vẫn có upstream base đúng `b8a31034ca36301067edadc2d622f42f4a4f7a37` (`v0.5.0`), không
  nhận `v0.5.1`, `v0.5.2` hoặc upstream `main`.

### Qualified

- Focused Protocol/Client/Server/App suites, full Server unit `5,518/5,518`, full App unit
  `4,817/4,817`, Council Playwright `3/3`, all-workspace typecheck, lint, format và server/WebUI builds
  đều pass trên feature bytes.
- Exact feature commit `646e70c005de37dcdd928af92587a836fbabf300` pass toàn bộ downstream CI
  run `32813251618`, gồm Server/App/SDK/CLI/Desktop và bốn Playwright shards.
- Clean release-commit activation và bốn host-native portable preflight leg vẫn là release gates riêng
  trước annotated tag `paseo-v0.5.0-paseo.38`.

## 0.5.0-paseo.37 - 2026-08-25

Bản follow-up này đóng gap placement của Room/Council sau stable `v0.5.0`: coordination surface giờ
giữ authoritative project/workspace scope thay vì chỉ tồn tại ở host level, đồng thời Room chat dùng
cùng visual language với workspace chat.

### Added

- Room record persist `workspaceId` và `projectId`; Room tạo từ UI bắt buộc chọn một workspace đang
  available, còn `create_room` và `start_council` của Lead tự bind vào workspace/project của caller.
- Protocol quảng bá optional capability `chatRoomWorkspaceScoping` để app mới fail closed khi kết nối
  daemon cũ chưa hỗ trợ scoped Room creation.

### Changed

- Rooms và Councils list/detail hiển thị human-readable `Project / Workspace`; unresolved placement
  giữ exact IDs để operator audit thay vì che mất provenance.
- Room transcript dùng workspace composer surface: Human message là bubble bên phải, agent message giữ
  authored metadata/reply rail bên trái; Room mode không mở attachment, voice hoặc agent autocomplete.
- UI không cho chọn workspace unavailable/archiving và không tạo Room khi scope thiếu hoặc daemon
  không quảng bá capability tương ứng.

### Compatibility

- Existing Room chưa có placement vẫn đọc được dưới nhãn `Host-level (legacy)`; wire fields mới là
  optional để app/daemon mixed-version tiếp tục parse dữ liệu cũ.
- Room/Council vẫn dùng host routes hiện tại; placement là record data, không tạo route hierarchy hoặc
  authority/membership semantics mới.
- Council giữ đúng ba specialist seats `Scout`, `Architect`, `Reviewer`; generic Engineer tiếp tục là
  Room participant, không phải Council seat.

### Qualified

- Focused protocol/client/server/app suites pass `194/194`; feature commit pre-commit hook pass format,
  lint và all-workspace typecheck.
- Local candidate activation và in-app Browser canary trên cùng feature bytes đã xác nhận workspace
  selector, readable placement, Human bubble và shared composer; canary Room được cleanup sau journey.
- Clean release-commit activation, exact-commit CI và bốn host-native portable preflight leg vẫn là
  release gates riêng trước annotated tag `paseo-v0.5.0-paseo.37`.

## 0.5.0-paseo.35 - 2026-08-24

Bản follow-up này không nhận thêm upstream bytes. Nó close một read-only governance gap do Browser
Supervisor audit tìm thấy sau khi Council `.34` đã pass toàn bộ receipt route.

### Fixed

- Supervisor role ceiling có `read_room` để exact Human governance mandate audit trực tiếp authored
  Lead ↔ Peer evidence và verdict supersession, thay vì chỉ suy ra từ truncated agent activity.
- `list_profiles` vẫn Lead-only; Supervisor không nhận `post_room`, `record_council_seat`, generic
  `update_agent`, mutation hoặc acceptance authority.

### Compatibility

- Existing Supervisor preferences vẫn bị daemon intersect với Foundation ceiling; capability mới chỉ
  mở đường đọc Room và không đổi recovery/replacement lease.
- Stable merge parent, Foundation `0.1.0-dev.21`, beta exclusion, `v0.5.1` exclusion và toàn bộ deferred
  upstream/post-tag ledger không đổi.

### Qualified

- Browser trên installed `.34` pass Lead → ba profile-routed Peer → Room → Council, operator-lane
  forged-label rejection và ba daemon-issued receipt markers; fresh Supervisor audit reproduce đúng
  `read_room` absence trước source correction này.
- Focused role-profile/binding suites pass `25/25`; exact isolated Claude suite pass `78/78` khi dùng
  installed path; full Server unit với authoritative PATH pass `5,502/5,502` và skip `45`.
- Installed `.35` requalification pass CLI/daemon/health/WebUI và Browser: fresh Supervisor có
  `24 tools / 4 skills`, gọi `read_room` đúng một lần, audit trực tiếp đủ sáu authored Room messages,
  ba daemon-issued Council receipt markers và no-mutation boundary. Councils UI giữ `.34` ở `3/3`
  ready và fail closed `.33` ở `0/3`.
- Durable Beads closeout vẫn `BLOCKED` không mutation: native `beads_update` có thể append notes và
  đổi labels nhưng không thể replace stale notes/`close_reason` trên closed issues. Guided Hub starter
  cũng tiếp tục `DEFER` fail-closed vì stable Hub chưa mang revision-scoped authority receipt qua
  daemon admission.

## 0.5.0-paseo.34 - 2026-08-24

Bản follow-up này vẫn không nhận thêm upstream bytes. Nó close đường forge còn lại mà Browser Council
`.33` adversarial journey tìm thấy sau khi route `record_council_seat` chuẩn đã pass.

### Fixed

- Council `Report ready` giờ cần exact `council.report_receipt_version=1` do
  `record_council_seat` ghi cùng authored Room receipt; bare caller labels không còn đủ để tạo ready
  state.
- `create_agent` chỉ nhận sealed Council bootstrap labels cho role-bound Peer do role-bound Lead tạo;
  generic `update_agent`, WebSocket metadata update và provider-session import đều reject mọi attempt
  tự ghi Council lifecycle/receipt labels trước mutation.
- Settings-only `update_agent` giữ nguyên behavior; Council label preflight chạy trước mode/model/feature
  mutation nên forged request không để lại partial side effect.

### Compatibility

- Receipt `.33` hoặc cũ hơn thiếu version marker vẫn được giữ để audit nhưng fail closed về not-ready;
  Lead phải audit Room và record lại qua dedicated tool nếu muốn promote.
- Stable merge parent, Foundation `0.1.0-dev.21`, beta exclusion, `v0.5.1` exclusion và toàn bộ deferred
  upstream/post-tag ledger không đổi.

### Qualified

- Focused six-suite regression pass `66/66`; Protocol pass `640/640`, App pass `4,813/4,813`, Server
  unit pass `5,502` với `45` skip, Server integration pass `10/10` và `1/1` focused worktree case.
- Full workspace typecheck, changed-file format/lint, official pinned-Nix `prefetch-npm-deps` và macOS
  desktop release build pass. Installed runtime và Browser requalification là activation gate riêng,
  không được suy ra từ source/build receipts này.

## 0.5.0-paseo.33 - 2026-08-24

Bản follow-up này không nhận thêm upstream bytes. Nó giữ nguyên exact stable `v0.5.0` merge boundary,
import Foundation `0.1.0-dev.21`, và close hai evidence gap mà Browser Council adversarial journey trên
`.32` đã reproduce.

### Fixed

- `record_council_seat(integrity=valid)` giờ bắt buộc exact terminal Peer, Council Room/kickoff labels,
  Peer-authored post-kickoff `reportMessageId`, role sentinels và SHA-256 report receipt; app không còn
  tính bare `valid` label + idle lifecycle là `Report ready`.
- Role-bound create/resume revalidate assignment/exception expiry cùng current Workspace Protocol path,
  validity và digest trước provider launch. Protocol xuất hiện, biến mất, invalid hoặc đổi bytes đều
  fail closed tới fresh role binding.
- Native Council skill/first-run guide dùng `start_council` → exact `list_profiles` route →
  same-workspace `create_agent` không truyền đồng thời `workspaceId`/`cwd` → sealed `post_room` →
  receipt-bound `record_council_seat`; tier `lens` được dùng đúng một seat.

### Compatibility

- Council record cũ thiếu Room/kickoff/report receipt vẫn được giữ để audit nhưng không còn được gọi là
  ready; không backfill authority bằng suy đoán từ labels.
- Không merge beta refs, `v0.5.1`, upstream `main`, 13 post-tag ACP registry drifts hoặc bất kỳ Hub
  starter writer nào đã defer trong `.32` ledger.

### Qualified

- Focused Council, role binding/resume, Agent Manager, app projection và tool-manifest suites pass
  `240/240`; full workspace typecheck, staged lint và format gates pass trên source correction.
- Foundation validator pass trên tagged source `foundation-v0.1.0-dev.21`; downstream import giữ exact
  source commit và manifest SHA-256 receipts.

## 0.5.0-paseo.32 - 2026-08-24

Bản này tích hợp semantic exact stable upstream `v0.5.0` tại
`b8a31034ca36301067edadc2d622f42f4a4f7a37`, không dùng beta refs làm input, đồng thời giữ nguyên
Foundation authority, durable evidence và các component downstream đã build.

### Added

- Nhận stable panes, workspace tabs, sidebar/project labels, profile editor, tracks, plugin themes/RPC,
  file/diff/terminal improvements và daemon-owned orchestration skill controller.
- Thêm guided first-run downstream cho Workspace Protocol admission, Agent Profile so với Role Profile,
  Lead, Peer, Supervisor, Room, Council, checkpoint và handback.
- Giữ stable Hub provider/connection/resource discovery làm dormant input cho một starter governed sau
  này, nhưng chưa cho nó tạo unbound agent hoặc ghi workflow.

### Changed

- Canonical plugin SDK là private `@getpaseo/plugin`; release/build/smoke paths không còn dùng scope cũ,
  còn `@paseo/plugin` chỉ tồn tại như compatibility alias có test.
- Chuyển skill lifecycle về daemon host controller, migrate selection cũ và không giữ desktop-owned
  global installer hoặc Nix top-level skill copy trùng owner.
- Union protocol/server/app stable với role binding, assignment grants, Workspace Protocol revision,
  Beads Central, Room/Council, Topology và workspace admission thay vì replace downstream owner bytes.
- `hub init` và automatic guided continuation fail closed trước filesystem/login/daemon/deploy cho tới
  khi Hub wire có role, assignment, admission revision và file-scoped ownership receipts.

### Fixed

- Giữ durable timeline snapshot/reconciliation qua restart; không nhận destructive startup cleanup của
  upstream #3647.
- Inject Agent MCP chỉ khi cả MCP và `injectIntoAgents` được bật, giữ credential debug redaction và
  namespace `paseo` fail closed.
- Giữ role config và runtime MCP khi unarchive/resume Codex, đồng thời bỏ native `thread/resume` thừa
  trong role-tool admission.
- Giữ downstream `xs` typography tier, Agent/Role Profile fields, pane contribution identity và natural
  Room composer behavior khi nhận stable UI refactors.

### Deferred / not merged

- Không merge `v0.5.0-beta.*`, `v0.5.1` hoặc commit sau stable boundary.
- Reject as-is destructive timeline cleanup và whole-directory `.paseo/` Hub writer; defer automatic
  unbound Hub starter tới cross-repo admission protocol đầy đủ.
- Giữ raw ACP metadata nhưng defer Product UI/install qualification cho MiniMax Code, fast-agent,
  Hermes và các provider ngoài downstream allowlist.
- Không nhận 13 package-runner updates xuất hiện trên npm/PyPI sau stable tag; exact stable pins và
  commands được giữ, còn registry-latest drift được record như maintenance advisory riêng.
- Không merge upstream npm publication, upstream changelog prose hoặc bất kỳ thay đổi nào thay thế
  Foundation doctrine, Supervisor/Lead/Peer, Room/Council hay downstream release authority.

### Qualified

- Merge commit có đúng hai parent: downstream `65402d53132748b1815a74d52d8b47d0a0bdfde2` và stable
  `b8a31034ca36301067edadc2d622f42f4a4f7a37`; zero unmerged path.
- App unit/browser Vitest, protocol/client/plugin/highlight/relay, CLI E2E 41/41, Foundation CLI,
  focused Foundation authority, agent manager, bootstrap/session/skill controller, format, lint,
  typecheck và server/CLI build đều pass trước release closeout.
- Lockfile và Nix dependency hash được regenerate từ downstream graph; clean install, installed artifact,
  live role canaries và in-app Browser E2E được ghi vào closeout ledger của exact release commit.

## 0.4.0-paseo.30 - 2026-08-21

Bản này đưa Peer routing theo subrole/profile vào Product, thêm Council/Room native và giữ exact
assignment/launch receipts xuyên suốt Topology sau khi agent đã idle.

### Added

- Thêm 16 Peer Agent Profile theo bốn subrole `Scout`, `Engineer`, `Reviewer`, `Architect` và bốn
  provider `Claude`, `Codex`, `Cursor`, `Antigravity`; Lead route theo provider priority, còn generic
  Peer dùng `Engineer` làm fallback mặc định.
- Thêm Lead tools `start_council` và `record_council_seat`, Council seat receipts cùng Room evidence
  native thay vì mô phỏng bằng Peer hoặc text.

### Changed

- Agent Settings dùng profile routing, runtime mode, default subrole và provider priority thay cho các
  model enable switch trùng lặp; priority mặc định là Claude → Codex → Cursor → Antigravity.
- Claude Peer no-write chạy guarded default workflow với technical allowlist/denylist chính xác, giữ
  các Paseo MCP tools đã preapprove trong unattended mà không mở quyền mutation.

### Fixed

- Giữ `RoleBinding` và `LaunchContract` qua agent directory delta/fetch để Topology vẫn hiện đúng
  Lead → Peer profile/subrole/provider sau khi agent kết thúc.
- Cho phép no-write Peer trả lời câu hỏi mà không tạo permission escalation; loại bỏ approval deadlock
  trong Council orchestration.

### Qualified

- Browser E2E trên WebUI local với role-bound workspace, Lead, bốn Peer subrole, generic Engineer
  fallback, provider selection, Council, Room và final Topology receipts.
- Focused unit tests, format, lint, typecheck và full downstream CI đa nền tảng trên exact feature
  commit trước release qualification.

## 0.4.0-paseo.24 - 2026-08-18

### Removed

- Gỡ lại agent-loop surface mà merge upstream 0.4 vô tình khôi phục: lệnh `paseo loop`, `LoopService`
  cùng wiring bootstrap/WebSocket/Session, loop RPC methods phía client và bundled skill `paseo-loop`
  (giờ nằm trong `LEGACY_SKILL_NAMES` để upgrade dọn bản đã cài). Wire schemas `loop/*` giữ lại theo
  `COMPAT(agentLoops)` tới 2027-02-09 cho mixed-version peers. Entry `.23` về việc giữ `paseo loop`
  downstream hết hiệu lực từ bản này.

### Changed

- `CLAUDE.md` rút từ 24,6KiB xuống ~9,7KiB: docs catalog chuyển sang `docs/README.md`, platform gating
  sang `docs/platform-gating.md`, luật activation trùng lặp gom về một Local completion gate;
  `scripts/agent-instructions.test.mjs` enforce byte budget 20KiB và symlink `AGENTS.md` trong CI.
- Council `model-routing.md` bổ sung rationale correlation/high-risk/core-law trên schema canonical
  hiện hành; legacy keys đánh dấu compatibility fallback với điều kiện gỡ.
- Skill `paseo-handoff` giữ workflow và gates; cơ chế daemon (locks, pending intent, repair drains)
  thuộc về `docs/slp-coordination-handoff.md`, không còn restate trong skill.

## 0.4.0-paseo.23 - 2026-08-18

Bản canonical này thay thế các candidate `.8` và `.22` đã dừng, làm gọn bề mặt orchestration theo
provider được support, giữ quyền đã chọn xuyên suốt vòng đời agent, đưa topology lên mức project và
bundle Beads Central thành component native trên mọi release host.

### Added

- Thêm project topology theo trục X, hợp nhất agent từ mọi workspace trong project và giữ exact
  delegation binding khi Lead tạo Peer thay vì gắn nhãn `UNBOUND` theo suy đoán.
- Thêm peer-model policy end-to-end: Lead chỉ được route Peer tới provider/model Human đã chọn từ
  catalog Provider Settings; daemon fail closed khi route nằm ngoài allowlist.
- Bundle host-native Beads Central `1.2.0` và `bd` `1.1.2` trong WebUI + CLI + Foundation artifacts
  cho macOS arm64/x64, Linux x64 và Windows x64, kèm checksum, readiness và installed-artifact smoke.

### Changed

- Chỉ hiển thị và cho launch Claude, Codex, Cursor, Antigravity cùng custom Codex; ẩn hoặc fail closed
  OpenCode, Devin CLI và các provider chưa được support khỏi settings, catalog và create flow.
- Giữ mode Human đã chọn, gồm `Bypass`, trong launch contract và continuation; assignment authority
  không tự đổi hoặc biến mất sau khi agent bắt đầu chạy.
- Provider toggles giờ cập nhật catalog/create flow thật, nên provider bị tắt không còn tiếp tục xuất
  hiện như route khả dụng.
- Pin Foundation `0.1.0-dev.17`, đồng bộ doctrine với daemon-owned bundled Central sidecar thay vì
  Docker hoặc service do Human vận hành riêng.

### Fixed

- Không xóa archived agent khỏi WebUI khi active-directory watcher chỉ báo agent đã chuyển sang archive;
  protocol giờ phân biệt `archived`, `filtered` và `deleted`.
- Nhớ mode Human đã chọn theo từng provider khi lease read-only tạm pin provider vào `Plan mode` hoặc
  `Read only`, rồi phục hồi chính xác mode đó khi quay lại `Work & coordinate`.
- Đồng bộ CI desktop packaging với release toolchain pinned Python, Go và `uv`, để build Central binary
  thật thay vì phụ thuộc host state hoặc fixture giả.
- Giữ symlink Python framework portable trong macOS artifacts và giữ exact vendored Central bytes trên
  Windows checkout, tránh broken sidecar hoặc checksum drift do line-ending conversion.

### Qualified

- Qualify focused unit/typecheck/format/lint, project topology, provider/model policy, role/mode
  persistence, archived-agent restore và browser journeys trên source commit.
- Qualify native Central/`bd`, CLI, Foundation, daemon và WebUI từ installed portable artifact; release
  chỉ publish sau native macOS arm64/x64, Linux x64 và Windows x64 smoke cùng full GitHub CI.

## 0.4.0-paseo.7 - 2026-08-17

Bản downstream này sửa đường tạo workspace role-bound trên WebUI và bổ sung release gate trực tiếp cho
contract đó.

### Fixed

- Giữ nguyên role, assignment effect và Beads issue grants khi New Workspace handoff sang draft tab trước khi tạo agent.
- Kiểm tra create receipt phải trả đúng `RoleBinding` và `LaunchContract` đã yêu cầu thay vì tiếp tục với agent unbound.
- Chặn concurrent submit và continuation trùng `clientMessageId`, tránh một thao tác chat tạo nhiều agent hoặc request.

### Qualified

- Thêm focused role-handoff, duplicate-submit và snapshot receipt tests vào downstream release qualification.
- Tiếp tục qualify WebUI + CLI + Foundation artifact trên native macOS arm64/x64, Linux x64 và Windows x64; không dùng Electron, mobile hoặc npm publish gates của upstream.

## 0.4.0-paseo.6 - 2026-08-17

Bản downstream này mở rộng WebUI + CLI + Foundation distribution thành artifact host-native cho macOS,
Linux và Windows, đồng thời sửa các gate durability và release reproducibility đã làm CI cũ fail.

### Added

- Thêm artifact và checksum riêng cho macOS arm64/x64, Linux x64 và Windows x64; mỗi leg được build và smoke trên native GitHub runner trước khi publish.
- Thêm bootstrap installer dùng user `launchd` trên macOS, user `systemd` trên Linux và user Scheduled Task trên Windows, với versioned release, active pointer và authoritative daemon readback.
- Thêm Foundation CLI lifecycle qualification trên Linux và Windows, gồm Windows junction, `PATHEXT` command discovery và `.cmd`/`.bat` invocation.
- Giữ nguyên byte canonical của imported Foundation payload trên Windows checkout để manifest checksum có cùng ý nghĩa trên cả ba operating system.
- Cập nhật README với requirements, install, verify, upgrade và uninstall riêng cho từng operating system.

### Fixed

- Giữ nguyên durable agent timeline epoch khi daemon hydrate provider history sau restart và làm concurrent flush test phản ánh đúng batch coalescing.
- Đưa WebUI build lock ra ngoài shared `server/dist` để clean build không tự xóa lock rồi chạy producer song song.
- Refresh Nix npm dependency hash và Qwen Code ACP package-runner pin theo live registry catalog.
- Tách ACP registry-latest drift thành maintenance advisory; downstream hard gate chỉ enforce exact pin và catalog/command consistency.
- Giữ artifact build fail closed khi source dirty nhưng in exact dirty paths để chẩn đoán runner mutation mà không cần bypass provenance gate.
- Bound Windows archive/install smoke theo I/O timeout riêng và chỉ report success sau cleanup retry hữu hạn hoàn tất.
- Chờ PTY process thoát trước khi `terminal kill` trả success để không để lại process hoặc filesystem handle trên Windows.

### Qualified

- Qualify focused unit/typecheck/format/lint và installed-artifact smoke gồm CLI, Foundation doctor, daemon, WebUI và real PTY terminal.
- Pin release qualification vào đúng WebUI + CLI + Foundation distribution; upstream-only desktop/mobile/npm publishing không còn được dùng làm portable release proxy.
- Qualify cùng release commit trên native macOS arm64/x64, Linux x64 và Windows x64 runners trước khi gắn tag.

## 0.4.0-paseo.3 - 2026-08-16

Bản downstream này làm cho Foundation doctor phản ánh đúng qualification của live daemon và biến việc
activate local development stack thành điều kiện hoàn tất bắt buộc sau mọi thay đổi runtime.

### Added

- Thêm gate `ORCHESTRATION_READY`, kiểm tra exact provider/model route, provider fingerprint và connection receipt còn hiệu lực với live daemon.
- Thêm role-boundary canary receipt gắn với daemon identity, source fingerprint, Foundation manifest và exact RoleBinding digests của Lead, Peer, Supervisor.

### Fixed

- Không còn để `paseo-foundation doctor` báo orchestration sẵn sàng dựa trên provider ID hoặc receipt cũ sau khi daemon đã đổi version, restart hoặc thay source bytes.
- Buộc release handback kiểm tra source, artifact, installed CLI, Foundation CLI và live daemon cùng một downstream version/commit; provider và role receipts phải được qualify lại sau runtime identity change.

### Qualified

- Qualify clean macOS Web/CLI artifact, local-stack install/restart, provider connection và ba role read-only canary trên exact downstream release commit.

## 0.4.0-paseo.2 - 2026-08-16

Bản downstream này hoàn tất lớp tương thích giữa upstream Agent Profiles và contract Foundation SLP, đồng thời tái qualification toàn bộ bề mặt customization sau merge Paseo 0.4.

### Added

- Cho Lead đọc host-wide agent launch presets qua `list_profiles` và chuyển preset sang đúng shape `create_agent` downstream; Peer và Supervisor không nhận tool này.
- Tự migrate legacy role launch defaults sang Agent Profiles mà vẫn giữ nguyên standing tool/skill policy.
- Cập nhật package-runner ACP pins cho `glm-acp-agent` và Qoder lên registry versions hiện hành.

### Improved

- Tách route preset khỏi authority: profile notes chỉ là routing guidance, profile không cấp write, delegation, plugin hoặc acceptance authority.
- Chỉ cho áp dụng Agent Profile trong draft/create flow; live role-bound agents phải respawn qua role-first flow khi đổi provider/model route.
- Giữ progress messages trong ACP timeline nhưng trả `finalText` theo message boundary cuối, tránh dính progress của Cursor vào exact handback.

### Fixed

- Preapprove đúng tập Paseo MCP tools trong role ceiling cho provider hỗ trợ exact MCP policy, tránh prompt permission không thể duyệt ở assignment `no-write`; assignment và Beads guards vẫn fail closed và không bị nới quyền.
- Giữ native Antigravity fail closed trên Windows và làm các assertion skill/path/newline cùng Git-observer waits độc lập với POSIX formatting hoặc runner contention; Windows không nằm trong release qualification scope của bản downstream này.
- Giữ app subagent archive test deterministic bằng descriptor identity, không còn phụ thuộc hai lần đọc wall-clock cách nhau vài mili giây trên CI.
- Cho Mermaid streaming E2E đủ ngân sách dưới CI load và dung sai iframe remount ngắn, trong khi vẫn fail nếu diagram biến mất quá một giây.

### Qualified

- Re-qualify Foundation packaging, role binding, Workspace Protocol v3, no-write leases, provider adapters, MCP parity, Rooms, Council, Issues/topology, CLI chat/loop/schedule, downstream installer, macOS artifact lifecycle và Linux Docker/Nix builds.

## 0.4.0-paseo.1 - 2026-08-15

Bản downstream này tích hợp upstream Paseo 0.4.0 và các commit mới trên `upstream/main`, đồng thời giữ các contract Foundation.

### Added

- Tích hợp agent profiles, managed local plugins, workspace file search/actions, Mermaid rendering và task progress từ upstream.
- Tích hợp daemon config reload, provider refresh diagnostics, sortable workspace pins và các sửa lỗi worktree/subagent mới nhất.

### Preserved

- Giữ native Foundation role binding, immutable assignment contract, Workspace Protocol admission, Beads Central, Rooms/Councils và provider qualification.
- Giữ downstream macOS Web/CLI artifact, Foundation CLI, provenance và clean installer lifecycle.
- Giữ `paseo chat` và `paseo loop` trong downstream; breaking removal của upstream 0.4.0 không áp dụng cho distribution này.

## 0.3.1-paseo.3 - 2026-08-11

This downstream patch is based on upstream Paseo 0.3.1.

### Added

- Add a native, project-scoped Beads work graph with WebUI create, inspect, and close flows plus role-scoped agent tools.
- Import Foundation 0.1.0-dev.10 with explicit optional Beads issue-tracker and independent-review specializations.

### Improved

- Keep Council as a workspace-portable projection over existing agents while isolating cases by daemon, workspace, and accountable parent Lead.
- Show Council report readiness, seat integrity, disposition, and Lead-linked verdict provenance without introducing a second lifecycle engine or vote.
- Preserve native provider identity and immutable role-binding receipts across Codex, Claude, Cursor ACP, native Antigravity CLI, and custom Codex routes.
- Report provider modes and model labels from discovered runtime metadata instead of inventing fallback values.

### Fixed

- Enforce Beads project scope, idempotent issue mutations, close receipts, and Peer write boundaries at the daemon service layer.
- Keep compromised, missing, redundant, and claim-mismatched Council evidence out of report-ready counts.
- Keep platform-specific launch and package probes honest when tests run on a different host OS.
- Retry launchd activation during idle-daemon upgrades, retain existing macOS privacy grants for protected user workspaces when a compatible host Node is available, and keep bundled Beads discovery pinned in that daemon environment.

## 0.3.1-paseo.2 - 2026-08-10

This downstream patch is based on upstream Paseo 0.3.1.

### Improved

- Keep Foundation as an optional role, skill, and policy overlay instead of a parallel orchestration plane, and remove private review/OCR execution profiles.
- Treat a missing Workspace Protocol as zero repository-specific policy while continuing to fail closed when a present protocol is unreadable or invalid.
- Keep ordinary workspace creation provider-neutral until a Foundation role is explicitly selected.
- Keep Council as a Lead-governed projection over existing agent and lifecycle primitives, available from any workspace without introducing a second state engine.
- Describe SLP by its demonstrated candidate qualification instead of claiming production completeness.

### Fixed

- Route blocked role-bound workspace creation to Project Settings and reject unsupported or unverified admission results.
- Preserve truthful build provenance when source archives do not include Git metadata.
- Keep Docker, Nix, macOS packaging, provider-browser tests, and release qualification portable across supported environments.
- Verify downstream Nix hashes and website builds without upstream-only bot or deployment credentials while retaining the configured publishing paths.
- Restore the supported macOS and Linux Tailwind native bindings omitted by npm optional-dependency lock generation.
- Refresh the Factory Droid ACP package-runner pin.

## 0.3.1-paseo.1 - 2026-08-10

This downstream release is based on upstream Paseo 0.3.1.

### Added

- Run a role-governed Council from any workspace, with independent seats, sealed review rounds, material-proposition verification, and a binding Lead verdict.
- Inspect Council progress and reports through a dedicated WebUI experience.
- Admit repositories through graduated Workspace Protocol checks in the WebUI and record the effective assignment contract.
- Hand work between agents through durable SLP handoffs and native coordination signals.
- Install and update the downstream macOS Web/CLI distribution with architecture-specific, checksum-verified release artifacts.

### Improved

- Foundation role profiles, topology, provider routing, and execution receipts now stay aligned across WebUI, CLI, MCP, and runtime admission.
- Release builds preserve the downstream Foundation overlay while incorporating upstream Paseo 0.3.1.
- Package-runner ACP catalog entries are refreshed to their current exact registry versions at release time.

### Fixed

- New-agent drafts wait for model defaults to finish loading before accepting a submission.
- Downstream macOS release smoke tests run on stock GitHub runners, and both architecture builds retain the required native Lightning CSS binary.

## 0.4.0 - 2026-08-13

### Breaking

- Removed `paseo chat` and `paseo loop` ([#3053](https://github.com/getpaseo/paseo/pull/3053))

### Added

- Added host-wide agent profiles for reusable provider, model, mode, thinking, and feature settings ([#3208](https://github.com/getpaseo/paseo/pull/3208))
- Added workspace file search to Cmd/Ctrl+P ([#3059](https://github.com/getpaseo/paseo/pull/3059))
- Added file and folder actions to Files and Changes ([#3027](https://github.com/getpaseo/paseo/pull/3027) by [@nikuscs](https://github.com/nikuscs))
- Added interactive Mermaid diagrams to chats and Markdown previews ([#2306](https://github.com/getpaseo/paseo/pull/2306) by [@dmeledon](https://github.com/dmeledon))
- Added live task progress above the composer and in the timeline ([#3227](https://github.com/getpaseo/paseo/pull/3227))
- Added a model setting for generated workspace titles, branch names, commits, and pull request drafts ([#3215](https://github.com/getpaseo/paseo/pull/3215))
- Added the supported `@getpaseo/client` TypeScript SDK ([#3141](https://github.com/getpaseo/paseo/pull/3141))
- Added provider installation diagnostics to the CLI ([#3243](https://github.com/getpaseo/paseo/pull/3243))
- Added workspace rename to the CLI ([#3209](https://github.com/getpaseo/paseo/pull/3209) by [@martinhanzik](https://github.com/martinhanzik))

### Improved

- Added a centered reading layout and formatted YAML front matter to Markdown previews ([#3240](https://github.com/getpaseo/paseo/pull/3240))
- Added sidebar grouping to the Command Center ([#3063](https://github.com/getpaseo/paseo/pull/3063) by [@cleiter](https://github.com/cleiter))
- Added every built-in theme to theme shortcuts ([#3214](https://github.com/getpaseo/paseo/pull/3214))
- Removed periodic Git polling for idle workspaces ([#3323](https://github.com/getpaseo/paseo/pull/3323))
- Set provider catalog refreshes to a configurable two-minute deadline ([#3322](https://github.com/getpaseo/paseo/pull/3322))

### Fixed

- Fixed terminal sessions being lost after host sleep or daemon worker stalls ([#3235](https://github.com/getpaseo/paseo/pull/3235), [#3263](https://github.com/getpaseo/paseo/pull/3263))
- Fixed daemon hang when archiving a workspace ([#3107](https://github.com/getpaseo/paseo/pull/3107))
- Fixed New Workspace crash on Android when projects span multiple hosts ([#3241](https://github.com/getpaseo/paseo/pull/3241))
- Fixed provider cache exhausting Android local storage ([#3234](https://github.com/getpaseo/paseo/pull/3234))
- Fixed dictation recordings being lost during connection interruptions ([#3159](https://github.com/getpaseo/paseo/pull/3159))
- Fixed new workspaces reusing an existing worktree ([#3224](https://github.com/getpaseo/paseo/pull/3224))
- Fixed new worktrees ignoring the setup command saved in Project Settings ([#3233](https://github.com/getpaseo/paseo/pull/3233))
- Fixed new worktrees becoming dirty when the selected base contained a different `paseo.json` ([#3311](https://github.com/getpaseo/paseo/pull/3311))
- Fixed removed hosts continuing to receive push notifications ([#3176](https://github.com/getpaseo/paseo/pull/3176))
- Fixed delegated-agent notifications stopping after permission prompts or workspace closure ([#3177](https://github.com/getpaseo/paseo/pull/3177), [#3192](https://github.com/getpaseo/paseo/pull/3192) by [@thomasvan](https://github.com/thomasvan), [@wilgon456](https://github.com/wilgon456))
- Fixed OMP agent startup when model catalogs exceed the protocol-v1 frame limit ([#3184](https://github.com/getpaseo/paseo/pull/3184) by [@pi3123](https://github.com/pi3123))
- Fixed OpenCode models being unable to return to their default variant ([#3281](https://github.com/getpaseo/paseo/pull/3281))
- Fixed completed Codex subagents remaining marked active ([#3188](https://github.com/getpaseo/paseo/pull/3188) by [@Strainy](https://github.com/Strainy))
- Fixed Codex compaction leaving turns marked as working ([#3211](https://github.com/getpaseo/paseo/pull/3211) by [@edihasaj](https://github.com/edihasaj))
- Fixed Cursor usage with current Cursor logins ([#2704](https://github.com/getpaseo/paseo/pull/2704) by [@QuteSaltyFish](https://github.com/QuteSaltyFish))
- Fixed SVG project icons rendering as blank on mobile ([#2579](https://github.com/getpaseo/paseo/pull/2579) by [@colonelpanic8](https://github.com/colonelpanic8))
- Fixed crash when persisted cache was incompatible ([#3289](https://github.com/getpaseo/paseo/pull/3289))
- Fixed open delegated agents being archived with their parent ([#3279](https://github.com/getpaseo/paseo/pull/3279))
- Fixed agent creation when profiles carried modes unsupported by the selected provider ([#3331](https://github.com/getpaseo/paseo/pull/3331))
- Fixed Claude agents waiting on Paseo's ten-minute MCP timeout ([#3315](https://github.com/getpaseo/paseo/pull/3315))
- Fixed Copy resume command for Hermes agents ([#3300](https://github.com/getpaseo/paseo/pull/3300) by [@desmond-rai](https://github.com/desmond-rai))

## 0.3.1 - 2026-08-09

### Added

- Unassign keyboard shortcuts and see the effective bindings in shortcut help ([#2510](https://github.com/getpaseo/paseo/pull/2510) by [@cleiter](https://github.com/cleiter), [#2985](https://github.com/getpaseo/paseo/pull/2985) by [@cleiter](https://github.com/cleiter))
- Choose a Pure black theme ([#3012](https://github.com/getpaseo/paseo/pull/3012) by [@shrimpwtf](https://github.com/shrimpwtf))

### Improved

- Running agents use a clearer animated status ring ([c0daf8e](https://github.com/getpaseo/paseo/commit/c0daf8e066e0d7379723a2a6ddea20afc71ead20) by [@cleiter](https://github.com/cleiter))
- Workspace Git updates stay responsive under file-watcher failures, heavy Git activity, and large shared-worktree repositories ([#3056](https://github.com/getpaseo/paseo/pull/3056), [#3033](https://github.com/getpaseo/paseo/pull/3033) by [@dwyanewang](https://github.com/dwyanewang), [#3078](https://github.com/getpaseo/paseo/pull/3078))
- Kimi usage refreshes correctly and shows five-hour limits and reasoning levels ([#2743](https://github.com/getpaseo/paseo/pull/2743) by [@UnbrokenHunter](https://github.com/UnbrokenHunter))
- Resize the desktop sidebar with touch ([#2953](https://github.com/getpaseo/paseo/pull/2953) by [@colonelpanic8](https://github.com/colonelpanic8))

### Fixed

- Direct LAN connections work again on macOS ([#3071](https://github.com/getpaseo/paseo/pull/3071))
- Desktop update checks no longer report an error while platform downloads are still publishing ([#3076](https://github.com/getpaseo/paseo/pull/3076))
- Copied lists keep their markers across selection boundaries ([#3055](https://github.com/getpaseo/paseo/pull/3055))
- Switching hosts keeps the active project selected ([#3051](https://github.com/getpaseo/paseo/pull/3051))
- New Workspace keeps project and isolation controls inside the composer ([#3050](https://github.com/getpaseo/paseo/pull/3050))
- Session rename is reachable from the mobile sessions menu ([#2924](https://github.com/getpaseo/paseo/pull/2924) by [@kaspesi](https://github.com/kaspesi))
- Desktop notification sounds play again ([#2582](https://github.com/getpaseo/paseo/pull/2582) by [@gstamp](https://github.com/gstamp))
- Codex slash commands omit disabled skills ([#2759](https://github.com/getpaseo/paseo/pull/2759) by [@jasonhnd](https://github.com/jasonhnd))
- Exact ignored file paths resolve correctly ([#3042](https://github.com/getpaseo/paseo/pull/3042) by [@cleiter](https://github.com/cleiter))
- Claude question notifications summarize the requested input ([#2925](https://github.com/getpaseo/paseo/pull/2925) by [@SihyeonJeon](https://github.com/SihyeonJeon))
- The crash screen stays readable and keeps its retry action reachable ([#3043](https://github.com/getpaseo/paseo/pull/3043))

## 0.3.0 - 2026-08-08

### Added

- New mobile terminal with text selection, copy, paste, and faster rendering ([#1607](https://github.com/getpaseo/paseo/pull/1607), [#2830](https://github.com/getpaseo/paseo/pull/2830))
- Redesigned sidebar with clearer status colours and rows that are quicker to scan ([#2340](https://github.com/getpaseo/paseo/pull/2340) by [@kaspesi](https://github.com/kaspesi), [#2335](https://github.com/getpaseo/paseo/pull/2335), [#2416](https://github.com/getpaseo/paseo/pull/2416) by [@nikuscs](https://github.com/nikuscs), [#2711](https://github.com/getpaseo/paseo/pull/2711))
  - Choose what a sidebar workspace row shows: host, pull request, checks, and scripts
  - Name each host and give it a colour ([#2790](https://github.com/getpaseo/paseo/pull/2790))
- Search your history by workspace, agent, and branch ([#2995](https://github.com/getpaseo/paseo/pull/2995))
- Use Paseo in Korean ([#2895](https://github.com/getpaseo/paseo/pull/2895) by [@himomohi](https://github.com/himomohi), [@Kesta-bos](https://github.com/Kesta-bos))
- Run git and workspace actions from the Command Center ([#2749](https://github.com/getpaseo/paseo/pull/2749))
- Change model, reasoning, mode, plan, and fast from the Command Center ([#2274](https://github.com/getpaseo/paseo/pull/2274) by [@kedrzu](https://github.com/kedrzu))
- Fork an agent while it's running ([#2638](https://github.com/getpaseo/paseo/pull/2638) by [@kaspesi](https://github.com/kaspesi))
- Launch a terminal directly from New Workspace ([#2941](https://github.com/getpaseo/paseo/pull/2941))
- Jump between prompts in a chat ([#2792](https://github.com/getpaseo/paseo/pull/2792))
- Preview HTML files ([#2712](https://github.com/getpaseo/paseo/pull/2712) by [@nicholas-salgueiro-britecore](https://github.com/nicholas-salgueiro-britecore), [@nickmaglowsch](https://github.com/nickmaglowsch))
- See Claude workflows in the subagent track ([#2933](https://github.com/getpaseo/paseo/pull/2933))
- Choose which orchestration skills Paseo installs ([#2680](https://github.com/getpaseo/paseo/pull/2680))
- Approve all ACP tool calls with one setting ([#2752](https://github.com/getpaseo/paseo/pull/2752))
- Add custom HTTP headers to direct host connections ([#2922](https://github.com/getpaseo/paseo/pull/2922))
- Pick a local branch or its origin counterpart as the base for a new worktree ([#2328](https://github.com/getpaseo/paseo/pull/2328) by [@mcowger](https://github.com/mcowger))
- Paste images from the clipboard on mobile ([#2793](https://github.com/getpaseo/paseo/pull/2793))

### Improved

- Provider data is cached in the client for a faster startup
- Recent chats stay live in the background, so switching back shows current messages right away ([#2842](https://github.com/getpaseo/paseo/pull/2842))
- Coming back to a workspace from Settings is faster ([#2791](https://github.com/getpaseo/paseo/pull/2791))
- Workspace Git status stays responsive in large repositories ([#2979](https://github.com/getpaseo/paseo/pull/2979))
- Paseo runs fewer git processes on busy machines ([#2797](https://github.com/getpaseo/paseo/pull/2797))
- Copying part of an assistant response keeps its lists, links, and formatting ([#2808](https://github.com/getpaseo/paseo/pull/2808), [#2930](https://github.com/getpaseo/paseo/pull/2930), [#2935](https://github.com/getpaseo/paseo/pull/2935) by [@cleiter](https://github.com/cleiter))
- See the full conversation from a native Claude subagent ([#2498](https://github.com/getpaseo/paseo/pull/2498) by [@ebg1223](https://github.com/ebg1223), [#2760](https://github.com/getpaseo/paseo/pull/2760))
- OpenCode subagents show their task, type, model, and token usage ([#2909](https://github.com/getpaseo/paseo/pull/2909) by [@BrianAguilarWasco](https://github.com/BrianAguilarWasco))
- Pi delegated tasks show their lifecycle status ([#2891](https://github.com/getpaseo/paseo/pull/2891))
- Claude remembers model and thinking choices for new workspaces ([#2912](https://github.com/getpaseo/paseo/pull/2912))
- OMP context usage updates while a turn is running ([#2503](https://github.com/getpaseo/paseo/pull/2503) by [@theslava](https://github.com/theslava))
- OpenCode reports background activity from its own busy status ([#2696](https://github.com/getpaseo/paseo/pull/2696) by [@desflynn](https://github.com/desflynn))
- Desktop browser tabs keep their state through focus changes and automation ([#2907](https://github.com/getpaseo/paseo/pull/2907))
- New worktrees start from the tracked upstream branch ([#2848](https://github.com/getpaseo/paseo/pull/2848))
- Generated workspace titles describe the task ([#2755](https://github.com/getpaseo/paseo/pull/2755))
- Relay access is opt-in when you pair a device ([#2706](https://github.com/getpaseo/paseo/pull/2706))
- Voice mode releases the audio session when recording and playback stop ([#2866](https://github.com/getpaseo/paseo/pull/2866) by [@kaspesi](https://github.com/kaspesi))
- Workspace suggestions skip Git-ignored data ([#2902](https://github.com/getpaseo/paseo/pull/2902))
- Reconnect messages distinguish daemon restarts from network interruptions ([#2931](https://github.com/getpaseo/paseo/pull/2931))
- The file viewer shows one accurate status when a file changes or is deleted ([#2670](https://github.com/getpaseo/paseo/pull/2670), [#2694](https://github.com/getpaseo/paseo/pull/2694))
- The Nix desktop package is smaller ([#2550](https://github.com/getpaseo/paseo/pull/2550) by [@colonelpanic8](https://github.com/colonelpanic8))
- The Nix desktop app uses the right icon on Linux and macOS ([#2506](https://github.com/getpaseo/paseo/pull/2506), [#2783](https://github.com/getpaseo/paseo/pull/2783) by [@colonelpanic8](https://github.com/colonelpanic8))
- Paseo Desktop builds from the Nix flake on macOS ([#2556](https://github.com/getpaseo/paseo/pull/2556) by [@colonelpanic8](https://github.com/colonelpanic8))

### Fixed

- Pi 0.84 agents no longer crash-loop on every prompt ([#2978](https://github.com/getpaseo/paseo/pull/2978) by [@dundunHa](https://github.com/dundunHa))
- Workspace file watching no longer stalls the daemon ([#2858](https://github.com/getpaseo/paseo/pull/2858))
- Messages no longer duplicate or arrive out of order after a reconnect or resume ([#2789](https://github.com/getpaseo/paseo/pull/2789), [#2718](https://github.com/getpaseo/paseo/pull/2718))
- Git status and diffs pick up changes in nested folders on every desktop OS ([#2775](https://github.com/getpaseo/paseo/pull/2775))
- Claude runtime failures report an error instead of leaving the workspace idle ([#2910](https://github.com/getpaseo/paseo/pull/2910) by [@nickmaglowsch](https://github.com/nickmaglowsch))
- Claude replay no longer leaves stale running subagents ([#2876](https://github.com/getpaseo/paseo/pull/2876) by [@cleiter](https://github.com/cleiter))
- The Fast toggle appears for Claude Opus 5 ([#2939](https://github.com/getpaseo/paseo/pull/2939) by [@cleiter](https://github.com/cleiter))
- Agents stop with an error when their provider process exits ([#2757](https://github.com/getpaseo/paseo/pull/2757))
- Cancelling an OpenCode turn no longer breaks the next one ([#2662](https://github.com/getpaseo/paseo/pull/2662))
- ACP permission prompts no longer disappear mid-turn ([#2762](https://github.com/getpaseo/paseo/pull/2762))
- A workspace no longer looks idle while its native subagents run ([#2777](https://github.com/getpaseo/paseo/pull/2777))
- Terminal activity stops after an interrupted turn ([#2942](https://github.com/getpaseo/paseo/pull/2942))
- Windows terminals handle deferred startup failures without crashing
- Recreated workspace folders no longer remain incorrectly archived ([#2987](https://github.com/getpaseo/paseo/pull/2987))
- Restoring a merged workspace no longer leaves it inactive ([#2714](https://github.com/getpaseo/paseo/pull/2714))
- Switching workspaces no longer scrolls a chat away from where you were reading ([#2838](https://github.com/getpaseo/paseo/pull/2838))
- Images stay anchored while a conversation reloads
- Swipe and drag gestures work in the mobile sidebar ([#2709](https://github.com/getpaseo/paseo/pull/2709))
- Dictated prompts no longer disappear when you submit them ([#2745](https://github.com/getpaseo/paseo/pull/2745))
- The composer stays above the keyboard on Android
- Typing with an IME on mobile no longer loses composed text
- The composer toolbar no longer flickers when switching tabs ([#2937](https://github.com/getpaseo/paseo/pull/2937))
- Your selected project stays selected when you switch hosts ([#2700](https://github.com/getpaseo/paseo/pull/2700))
- Host connection choices stay selected through Settings and desktop refreshes ([#2905](https://github.com/getpaseo/paseo/pull/2905))
- The pull request panel updates after you switch branches ([#2699](https://github.com/getpaseo/paseo/pull/2699))
- New Workspace shows its isolation controls right away ([#2702](https://github.com/getpaseo/paseo/pull/2702))
- Sidebar shortcuts leave focus mode ([#2717](https://github.com/getpaseo/paseo/pull/2717))
- Agents started by the NixOS service no longer run in production mode ([#2697](https://github.com/getpaseo/paseo/pull/2697) by [@shin-sakata](https://github.com/shin-sakata))

## 0.2.5 - 2026-07-30

### Fixed

- Fixed the Linux Debian package ([#2654](https://github.com/getpaseo/paseo/pull/2654) by [@Neumannzc](https://github.com/Neumannzc))

## 0.2.4 - 2026-07-30

### Added

- Set an agent's thinking level from the CLI ([#2533](https://github.com/getpaseo/paseo/pull/2533))
- Switch projects while creating a workspace with ⌘P / Ctrl+P ([#2110](https://github.com/getpaseo/paseo/pull/2110) by [@turtleDev](https://github.com/turtleDev))
- Open a project or workspace folder from the sidebar ([#2491](https://github.com/getpaseo/paseo/pull/2491) by [@PTK030](https://github.com/PTK030))
- Flick up on the chat to dismiss the keyboard ([#2417](https://github.com/getpaseo/paseo/pull/2417) by [@nllptrx](https://github.com/nllptrx))
- Custom providers can read the agent's working directory ([#2563](https://github.com/getpaseo/paseo/pull/2563))

### Fixed

- The same repository added on more than one machine appears as one project in the sidebar ([#2565](https://github.com/getpaseo/paseo/pull/2565))
- Idle agents keep their background work instead of shutting down when unused ([#2590](https://github.com/getpaseo/paseo/pull/2590))
- Desktop no longer crashes at startup while restoring your file tree ([#2595](https://github.com/getpaseo/paseo/pull/2595))
- Plan approval only shows the latest proposal ([#2534](https://github.com/getpaseo/paseo/pull/2534))
- Opus 5 appears once in the model list, with its full 1M context ([#2497](https://github.com/getpaseo/paseo/pull/2497))
- The context meter no longer blanks out partway through a conversation ([#2494](https://github.com/getpaseo/paseo/pull/2494) by [@theslava](https://github.com/theslava))
- A very large working diff no longer drops your session ([#2488](https://github.com/getpaseo/paseo/pull/2488) by [@nikuscs](https://github.com/nikuscs))
- Interrupting Pi no longer surfaces a stream error ([#2311](https://github.com/getpaseo/paseo/pull/2311) by [@mcowger](https://github.com/mcowger))
- Grok usage shows again in Settings ([#2353](https://github.com/getpaseo/paseo/pull/2353) by [@jasonhnd](https://github.com/jasonhnd))
- OMP models that report no context window now load ([#2406](https://github.com/getpaseo/paseo/pull/2406) by [@astartsky](https://github.com/astartsky))
- Paseo's own tools are available directly in OMP ([#2418](https://github.com/getpaseo/paseo/pull/2418) by [@perezd](https://github.com/perezd))
- Codex finds the skills defined in your project ([#2423](https://github.com/getpaseo/paseo/pull/2423) by [@dwyanewang](https://github.com/dwyanewang))
- Pull request comments containing HTML render correctly ([#2432](https://github.com/getpaseo/paseo/pull/2432) by [@mcowger](https://github.com/mcowger))
- Self-hosted forge links keep their port ([#2478](https://github.com/getpaseo/paseo/pull/2478) by [@muzhi1991](https://github.com/muzhi1991))
- The Linux AppImage launches when opened from your desktop ([#2439](https://github.com/getpaseo/paseo/pull/2439) by [@stonegray](https://github.com/stonegray))
- Repository search works with older versions of the GitHub CLI ([#2611](https://github.com/getpaseo/paseo/pull/2611))

## 0.2.3 - 2026-07-27

### Added

- Manage workspace scripts from the CLI and agent MCP tools ([#1992](https://github.com/getpaseo/paseo/pull/1992) by [@mcowger](https://github.com/mcowger))
- Copy terminal IDs from terminal tab menus ([#2371](https://github.com/getpaseo/paseo/pull/2371))
- Long Markdown lines wrap by default in the file editor ([#2459](https://github.com/getpaseo/paseo/pull/2459))

### Improved

- Desktop stops its managed daemon when you quit unless “Keep daemon running after quit” is enabled ([#2454](https://github.com/getpaseo/paseo/pull/2454))
- Remote terminal and file traffic uses less bandwidth over encrypted connections ([#2480](https://github.com/getpaseo/paseo/pull/2480))
- Workspace search now shows and matches project names ([#2345](https://github.com/getpaseo/paseo/pull/2345) by [@cleiter](https://github.com/cleiter))
- Claude usage shows model-specific weekly limits ([#2303](https://github.com/getpaseo/paseo/pull/2303) by [@cleiter](https://github.com/cleiter))
- OMP models show only the thinking levels they support ([#2171](https://github.com/getpaseo/paseo/pull/2171) by [@bendavid](https://github.com/bendavid))

### Fixed

- Image uploads preserve the correct image format ([#2380](https://github.com/getpaseo/paseo/pull/2380))
- Large file views no longer disconnect the session ([#2482](https://github.com/getpaseo/paseo/pull/2482))
- Reaching the top of a chat loads the complete older history ([#2481](https://github.com/getpaseo/paseo/pull/2481))
- Parent agents stay available while child agents are working ([#2458](https://github.com/getpaseo/paseo/pull/2458))
- Stale client connections no longer exhaust daemon memory ([#2169](https://github.com/getpaseo/paseo/pull/2169))
- Pin and unpin shortcuts work when sidebar sections are collapsed ([#2299](https://github.com/getpaseo/paseo/pull/2299) by [@cleiter](https://github.com/cleiter))
- `Shift+Tab` no longer changes a background agent’s permission mode ([#1848](https://github.com/getpaseo/paseo/pull/1848) by [@cleiter](https://github.com/cleiter))
- Proxied services preserve ports in redirects ([#2288](https://github.com/getpaseo/paseo/pull/2288) by [@cleiter](https://github.com/cleiter))
- Provider settings open correctly above the model selector ([#2476](https://github.com/getpaseo/paseo/pull/2476))
- Clicking the file editor correctly focuses its pane ([#2457](https://github.com/getpaseo/paseo/pull/2457))

## 0.2.2 - 2026-07-25

### Fixed

- Claude 5 models now use the correct context windows.

## 0.2.1 - 2026-07-24

### Added

- Claude Opus 5 is available

## 0.2.0 - 2026-07-24

### Added

- Work with pull requests and merge requests from GitLab, Gitea, Forgejo, and Codeberg ([#1913](https://github.com/getpaseo/paseo/pull/1913) by [@nllptrx](https://github.com/nllptrx))
- Edit files directly in the web and desktop apps ([#2270](https://github.com/getpaseo/paseo/pull/2270), [#2309](https://github.com/getpaseo/paseo/pull/2309), [#2277](https://github.com/getpaseo/paseo/pull/2277), [#2382](https://github.com/getpaseo/paseo/pull/2382) by [@dwyanewang](https://github.com/dwyanewang))
- Oh My Pi (OMP) as a native agent provider ([#2067](https://github.com/getpaseo/paseo/pull/2067) by [@ebg1223](https://github.com/ebg1223))
- Open the complete Changes view as a workspace tab ([#2298](https://github.com/getpaseo/paseo/pull/2298) by [@nikuscs](https://github.com/nikuscs))
- Add files to chat directly from Files and Changes ([#2275](https://github.com/getpaseo/paseo/pull/2275) by [@nikuscs](https://github.com/nikuscs))
- Browse workspace commit history and open individual commit diffs from Changes ([#1534](https://github.com/getpaseo/paseo/pull/1534), [#2146](https://github.com/getpaseo/paseo/pull/2146), [#2312](https://github.com/getpaseo/paseo/pull/2312) by [@adradr](https://github.com/adradr))
- Switch models from the Command Center for active agents and new drafts ([#2147](https://github.com/getpaseo/paseo/pull/2147) by [@kedrzu](https://github.com/kedrzu))
- Open existing agents from Paseo links or the CLI ([#2324](https://github.com/getpaseo/paseo/pull/2324))
- Configure workspace service ports with a fixed range or external allocator ([#2165](https://github.com/getpaseo/paseo/pull/2165) by [@mcowger](https://github.com/mcowger))
- Search keyboard shortcuts by action, note, or key combination ([#2160](https://github.com/getpaseo/paseo/pull/2160))
- Turn thinking off for supported Claude models ([#2257](https://github.com/getpaseo/paseo/pull/2257))
- Allow Pi's Max thinking level ([#2267](https://github.com/getpaseo/paseo/pull/2267) by [@ByteTrue](https://github.com/ByteTrue))
- Open workspace files in more installed editors and file managers ([#2119](https://github.com/getpaseo/paseo/pull/2119))
- Remove individual custom providers from Settings ([#1951](https://github.com/getpaseo/paseo/pull/1951))

### Improved

- Improved model selection on mobile ([#2361](https://github.com/getpaseo/paseo/pull/2361))
- Selector popovers stay readable on iPad ([#2360](https://github.com/getpaseo/paseo/pull/2360) by [@yzim](https://github.com/yzim))
- Projects, workspaces and chat syncing is more efficient ([#2028](https://github.com/getpaseo/paseo/pull/2028), [#2185](https://github.com/getpaseo/paseo/pull/2185), [#2196](https://github.com/getpaseo/paseo/pull/2196), [#2206](https://github.com/getpaseo/paseo/pull/2206), [#2259](https://github.com/getpaseo/paseo/pull/2259), [#2263](https://github.com/getpaseo/paseo/pull/2263))
- CLI and MCP tools manage workspaces, agents, and schedules more consistently ([#2186](https://github.com/getpaseo/paseo/pull/2186))
- Pasted PR/MR links in the composer become auto-selected as a checkout option ([#2290](https://github.com/getpaseo/paseo/pull/2290))
- Make project creation more explicit ([#2098](https://github.com/getpaseo/paseo/pull/2098), [#2187](https://github.com/getpaseo/paseo/pull/2187))
- Idle agents release processes automatically and resume when needed ([#2203](https://github.com/getpaseo/paseo/pull/2203), [#2209](https://github.com/getpaseo/paseo/pull/2209))
- New Claude and Codex agents default to safer automatic approval modes when supported ([#2213](https://github.com/getpaseo/paseo/pull/2213))
- Permission and thinking changes made during a turn now show when they take effect ([#2201](https://github.com/getpaseo/paseo/pull/2201))
- Usage bars now warn as provider limits approach ([#2322](https://github.com/getpaseo/paseo/pull/2322) by [@cleiter](https://github.com/cleiter))
- Workspace focus mode stays confined to the active workspace with a visible exit control ([#2151](https://github.com/getpaseo/paseo/pull/2151))
- Desktop installs the newest available update instead of a cached older release ([#2149](https://github.com/getpaseo/paseo/pull/2149))
- Remote daemon update failures now show specific recovery steps ([#2120](https://github.com/getpaseo/paseo/pull/2120))
- Agent history errors now appear immediately instead of after a timeout ([#2124](https://github.com/getpaseo/paseo/pull/2124))

### Fixed

- Terminal pairing QR codes remain scannable in narrow terminals ([#2381](https://github.com/getpaseo/paseo/pull/2381))
- Workspace creation stays responsive even with many active or archived workspaces ([#2355](https://github.com/getpaseo/paseo/pull/2355), [#2379](https://github.com/getpaseo/paseo/pull/2379))
- Failed agent starts no longer leave provider processes running ([#2348](https://github.com/getpaseo/paseo/pull/2348) by [@dwyanewang](https://github.com/dwyanewang))
- Completed OpenCode turns stay idle when late metadata updates arrive ([#2336](https://github.com/getpaseo/paseo/pull/2336) by [@mcowger](https://github.com/mcowger))
- ACP image prompts no longer appear twice ([#2363](https://github.com/getpaseo/paseo/pull/2363))
- Web chats stay pinned to the latest message at non-default browser zoom ([#2368](https://github.com/getpaseo/paseo/pull/2368))
- Grouped tool-call loading animations display correctly ([#2369](https://github.com/getpaseo/paseo/pull/2369))
- Notifications now open the correct workspace and agent ([#2331](https://github.com/getpaseo/paseo/pull/2331))
- Archived agents can be restored directly from History ([#2316](https://github.com/getpaseo/paseo/pull/2316))
- CLI agent runs stay in the current workspace unless a new workspace is requested ([#2315](https://github.com/getpaseo/paseo/pull/2315))
- Reused branches no longer attach an unrelated merged or closed pull request ([#2172](https://github.com/getpaseo/paseo/pull/2172) by [@nllptrx](https://github.com/nllptrx))
- Pi compaction waits for long summaries instead of reporting a false timeout ([#2181](https://github.com/getpaseo/paseo/pull/2181) by [@jasonhnd](https://github.com/jasonhnd))
- Pi chats keep new messages aligned with the correct history after an idle agent resumes ([#2313](https://github.com/getpaseo/paseo/pull/2313))
- OpenCode follow-ups triggered by completed background work now remain visible ([#2258](https://github.com/getpaseo/paseo/pull/2258))
- Codex no longer shows the parent agent as a phantom subagent ([#2214](https://github.com/getpaseo/paseo/pull/2214))
- Oh My Pi background notices appear as task notifications instead of raw system text ([#2218](https://github.com/getpaseo/paseo/pull/2218) by [@ebg1223](https://github.com/ebg1223))
- Local dictation now works in Nix-packaged installations ([#1587](https://github.com/getpaseo/paseo/pull/1587) by [@yhori991](https://github.com/yhori991))
- The composer remains visible after submitting dictated text and returning to the app ([#2194](https://github.com/getpaseo/paseo/pull/2194))
- Desktop's dictation shortcut remains responsive after finishing a recording ([#2268](https://github.com/getpaseo/paseo/pull/2268))
- Projects can be renamed before their first workspace ([#2252](https://github.com/getpaseo/paseo/pull/2252) by [@albertodeago](https://github.com/albertodeago))
- Settings keep showing a connected remote host when the local daemon is stopped ([#1749](https://github.com/getpaseo/paseo/pull/1749) by [@dwyanewang](https://github.com/dwyanewang))
- Pinned workspaces no longer disappear briefly when reopening the compact sidebar ([#2210](https://github.com/getpaseo/paseo/pull/2210))
- Terminal panes no longer remain at 80x24 after focus or visibility changes ([#2059](https://github.com/getpaseo/paseo/pull/2059), [#2154](https://github.com/getpaseo/paseo/pull/2154) by [@cleiter](https://github.com/cleiter))
- Sign-in popups in the desktop browser now complete successfully ([#2137](https://github.com/getpaseo/paseo/pull/2137))
- Browser typing and shortcuts no longer submit the active Paseo prompt ([#1982](https://github.com/getpaseo/paseo/pull/1982))
- Agent browser tabs remain controllable after switching workspaces ([#2156](https://github.com/getpaseo/paseo/pull/2156))
- Archived workspaces now show the correct Unarchive or Restore action ([#2002](https://github.com/getpaseo/paseo/pull/2002))
- Archived sessions can be reimported into the current workspace ([#2123](https://github.com/getpaseo/paseo/pull/2123), [#2265](https://github.com/getpaseo/paseo/pull/2265) by [@nikuscs](https://github.com/nikuscs))
- Browser shortcuts no longer appear where browser tabs are unavailable ([#2116](https://github.com/getpaseo/paseo/pull/2116) by [@jasonhnd](https://github.com/jasonhnd))

## 0.1.110 - 2026-07-16

### Fixed

- Kimi and other ACP agents now stay marked as running while a response is actively streaming ([#2148](https://github.com/getpaseo/paseo/pull/2148))

## 0.1.109 - 2026-07-16

> **Important update notice**
>
> If you installed Paseo Desktop 0.1.108, you need to [download and reinstall Paseo manually](https://paseo.sh/download) to get this fix. The bug in 0.1.108 prevents its automatic updater from installing 0.1.109. Users on 0.1.107 or earlier can update normally.

### Fixed

- Paseo Desktop no longer gets stuck connecting or loses native window controls after updating ([#2111](https://github.com/getpaseo/paseo/pull/2111) by [@cleiter](https://github.com/cleiter))

## 0.1.108 - 2026-07-16

### Added

- Create a new project folder or clone a GitHub repository from Add Project ([#1331](https://github.com/getpaseo/paseo/pull/1331), [#2045](https://github.com/getpaseo/paseo/pull/2045), [#2097](https://github.com/getpaseo/paseo/pull/2097) by [@mcowger](https://github.com/mcowger))
- Search for and open workspaces from the search menu ([#2096](https://github.com/getpaseo/paseo/pull/2096))
- Pin workspaces to the top of the sidebar ([#1981](https://github.com/getpaseo/paseo/pull/1981) by [@half144](https://github.com/half144))
- Summarize tool calls in a single collapsed item with a new appearance setting ([#2031](https://github.com/getpaseo/paseo/pull/2031), [#2069](https://github.com/getpaseo/paseo/pull/2069), [#2090](https://github.com/getpaseo/paseo/pull/2090) by [@mcowger](https://github.com/mcowger))
- Save browser cookies and site data across tabs and restarts ([#2089](https://github.com/getpaseo/paseo/pull/2089))
- Claude and Codex subagents now show their actual names, with a new option to archive finished Claude Code, Codex, and OpenCode subagents ([#2073](https://github.com/getpaseo/paseo/pull/2073))
- Fork chats from failed turns ([#2063](https://github.com/getpaseo/paseo/pull/2063))

### Improved

- Permission modes have clearer icons ([#1980](https://github.com/getpaseo/paseo/pull/1980) by [@cleiter](https://github.com/cleiter))
- Desktop stays usable in narrower windows ([#1983](https://github.com/getpaseo/paseo/pull/1983))
- Sidebar controls stay in place when desktop panels open and close ([#2078](https://github.com/getpaseo/paseo/pull/2078))
- Typing in long drafts is smoother ([#2086](https://github.com/getpaseo/paseo/pull/2086))
- Codex terminal commands always appear in chat, even when they have no output ([#2037](https://github.com/getpaseo/paseo/pull/2037))

### Fixed

- New Workspace keeps your prompt and attachments when you switch projects or hosts ([#2030](https://github.com/getpaseo/paseo/pull/2030), [#2036](https://github.com/getpaseo/paseo/pull/2036))
- OpenCode sessions close without crashing Paseo ([#2027](https://github.com/getpaseo/paseo/pull/2027) by [@mcowger](https://github.com/mcowger))
- Pi slash commands no longer leave chats stuck as running ([#2066](https://github.com/getpaseo/paseo/pull/2066) by [@ebg1223](https://github.com/ebg1223))
- Background-agent updates now appear after the main reply ([#2058](https://github.com/getpaseo/paseo/pull/2058) by [@1254087415](https://github.com/1254087415))
- Codex subagents no longer disappear from the Subagents track ([#2068](https://github.com/getpaseo/paseo/pull/2068))
- Forked chats open ready to edit in their new tab ([#2038](https://github.com/getpaseo/paseo/pull/2038))
- Paseo Desktop opens normally after an interrupted shutdown ([#1962](https://github.com/getpaseo/paseo/pull/1962))
- Keyboard shortcuts now work with `-`, `=`, `;`, and `'` ([#2047](https://github.com/getpaseo/paseo/pull/2047) by [@OnCloud125252](https://github.com/OnCloud125252))
- Codebuddy Code models now appear in the model picker ([#1979](https://github.com/getpaseo/paseo/pull/1979) by [@park0er](https://github.com/park0er))
- Workspace search now includes OpenCode commands and workflows ([#2049](https://github.com/getpaseo/paseo/pull/2049))
- Nix installations now include the Paseo web app ([#1978](https://github.com/getpaseo/paseo/pull/1978) by [@liamdiprose](https://github.com/liamdiprose))

## 0.1.107 - 2026-07-13

### Added

- Inspect provider-created subagents and their live conversations from the Subagents track ([#2013](https://github.com/getpaseo/paseo/pull/2013) by [@omercnet](https://github.com/omercnet))
- Fork chats with every supported agent provider ([#2022](https://github.com/getpaseo/paseo/pull/2022))

### Improved

- Add projects directly from New Workspace when none are configured ([#2026](https://github.com/getpaseo/paseo/pull/2026))
- New terminals open at the correct size immediately ([#2023](https://github.com/getpaseo/paseo/pull/2023) by [@cleiter](https://github.com/cleiter))
- Sidebar footer actions now explain themselves with tooltips ([#2025](https://github.com/getpaseo/paseo/pull/2025))
- Codex shell tool calls show only the command being run ([#2029](https://github.com/getpaseo/paseo/pull/2029))
- Custom ACP providers keep file and terminal work in the agent environment by default ([#2024](https://github.com/getpaseo/paseo/pull/2024))
- ACP provider catalog updated to the latest registry versions

### Fixed

- Large tables no longer make iOS chats unresponsive
- Chat controls remain clickable near the scroll-to-bottom button ([#2007](https://github.com/getpaseo/paseo/pull/2007))
- Oversized tool output no longer slows or floods chat timelines ([#2020](https://github.com/getpaseo/paseo/pull/2020))
- Cross-provider subagents can use providers without mode settings ([#2000](https://github.com/getpaseo/paseo/pull/2000) by [@githubbzxs](https://github.com/githubbzxs))
- Pi's internal metadata tasks no longer clutter normal session history ([#1999](https://github.com/getpaseo/paseo/pull/1999) by [@githubbzxs](https://github.com/githubbzxs))
- Pi chats remain usable after canceling extension commands ([#2019](https://github.com/getpaseo/paseo/pull/2019))

## 0.1.106 - 2026-07-12

### Added

- Approve Codex MCP permission requests in Paseo ([#2001](https://github.com/getpaseo/paseo/pull/2001))

### Improved

- ACP provider catalog updated to the latest registry versions

### Fixed

- Reduced mobile chat freezes and blank screens when switching workspaces while agents are streaming ([#1989](https://github.com/getpaseo/paseo/pull/1989))
- OpenCode sessions start reliably instead of occasionally losing the first turn ([#2015](https://github.com/getpaseo/paseo/pull/2015) by [@mcowger](https://github.com/mcowger))
- Switching between workspaces no longer flashes a white screen
- Pi keeps your existing MCP tools and settings when Paseo adds its own ([#1990](https://github.com/getpaseo/paseo/pull/1990) by [@mcowger](https://github.com/mcowger))

## 0.1.105 - 2026-07-10

### Added

- Browse changed files as a collapsible folder tree or flat list ([#1918](https://github.com/getpaseo/paseo/pull/1918), [#1945](https://github.com/getpaseo/paseo/pull/1945) by [@cleiter](https://github.com/cleiter))
- Always expand agent reasoning with a new appearance setting ([#1943](https://github.com/getpaseo/paseo/pull/1943) by [@mcowger](https://github.com/mcowger))

### Improved

- Project picker finds folders with fuzzy search and native desktop browsing ([#1968](https://github.com/getpaseo/paseo/pull/1968))
- Large workspace sidebars stay responsive ([#1966](https://github.com/getpaseo/paseo/pull/1966))
- Generated workspace names and Git text can use MiniMax M3 ([#1955](https://github.com/getpaseo/paseo/pull/1955) by [@octo-patch](https://github.com/octo-patch))
- Cursor now exposes thinking and fast mode ([#1952](https://github.com/getpaseo/paseo/pull/1952))

### Fixed

- Codex stays active and streams correctly while subagents run ([#1967](https://github.com/getpaseo/paseo/pull/1967))
- Android audio interruptions no longer crash voice mode or leave dictation stuck ([#1941](https://github.com/getpaseo/paseo/pull/1941))
- Mobile sidebars stay in sync and retain swipe-to-open gestures ([#1953](https://github.com/getpaseo/paseo/pull/1953), [#1976](https://github.com/getpaseo/paseo/pull/1976))
- Pi text-only models accept image prompts without breaking the session ([#1960](https://github.com/getpaseo/paseo/pull/1960))
- App render failures show a retryable recovery screen instead of a blank screen ([#1924](https://github.com/getpaseo/paseo/pull/1924))
- Pi context usage remains visible with older Oh My Pi versions ([#1886](https://github.com/getpaseo/paseo/pull/1886) by [@theslava](https://github.com/theslava))
- Provider usage popovers no longer error when opened and closed quickly ([#1885](https://github.com/getpaseo/paseo/pull/1885) by [@theslava](https://github.com/theslava))
- Mobile workspace menus hide desktop-only shortcut badges ([#1964](https://github.com/getpaseo/paseo/pull/1964))

## 0.1.104 - 2026-07-08

### Added

- Agents can drive the in-app browser with page snapshots, trusted input, dialogs, and tab controls ([#1881](https://github.com/getpaseo/paseo/pull/1881))
- Inspect, annotate, and send page elements from a browser tab to the agent ([#1708](https://github.com/getpaseo/paseo/pull/1708) by [@huiliaoning](https://github.com/huiliaoning))
- Schedules screen to create and manage recurring agents ([#1246](https://github.com/getpaseo/paseo/pull/1246))
- Open a project from anywhere with Cmd+O ([#1849](https://github.com/getpaseo/paseo/pull/1849))
- Agents can rename workspaces after they understand the task ([#1876](https://github.com/getpaseo/paseo/pull/1876))
- Claude Ultra Code is available for supported Claude models ([#1872](https://github.com/getpaseo/paseo/pull/1872))
- ByteDance TRAE CLI available as an agent provider ([#1831](https://github.com/getpaseo/paseo/pull/1831), [#1896](https://github.com/getpaseo/paseo/pull/1896) by [@park0er](https://github.com/park0er))

### Improved

- Manage the built-in daemon from one place in desktop settings ([#1938](https://github.com/getpaseo/paseo/pull/1938))
- Scheduled and loop runs each get their own workspace in the sidebar ([#1909](https://github.com/getpaseo/paseo/pull/1909), [#1934](https://github.com/getpaseo/paseo/pull/1934))
- Large provider and model refreshes load faster in the app ([#1895](https://github.com/getpaseo/paseo/pull/1895))
- Workspaces created by agents now get readable generated names ([#1887](https://github.com/getpaseo/paseo/pull/1887))
- Browser tabs opened by agents stay in the background until you switch to them ([#1875](https://github.com/getpaseo/paseo/pull/1875))
- Clearer cards when an agent asks a question ([#1643](https://github.com/getpaseo/paseo/pull/1643) by [@cleiter](https://github.com/cleiter))
- Diagnostic reports include desktop app logs ([#1914](https://github.com/getpaseo/paseo/pull/1914))
- Paseo's built-in tools take less context ([#1939](https://github.com/getpaseo/paseo/pull/1939))

### Fixed

- Renamed hosts keep their name after reconnecting ([#1940](https://github.com/getpaseo/paseo/pull/1940))
- Desktop finds your installed CLIs even when your shell is slow to start ([#1916](https://github.com/getpaseo/paseo/pull/1916))
- Restarting the daemon from desktop settings works reliably ([#1915](https://github.com/getpaseo/paseo/pull/1915))
- Restarting the daemon from the bundled CLI keeps it managed by the desktop app ([#1919](https://github.com/getpaseo/paseo/pull/1919))
- Web UI loads when the daemon is started from the bundled CLI ([#1899](https://github.com/getpaseo/paseo/pull/1899) by [@yzim](https://github.com/yzim))
- Worktree setup scripts keep your PATH ([#1908](https://github.com/getpaseo/paseo/pull/1908))
- Docker images keep running during provider cleanup and diagnostics ([#1877](https://github.com/getpaseo/paseo/pull/1877))
- New Workspace drafts survive archiving a workspace ([#1838](https://github.com/getpaseo/paseo/pull/1838))
- Composer autocomplete stays open after switching screens ([#1851](https://github.com/getpaseo/paseo/pull/1851))
- Claude usage appears when a quota window has no scheduled reset ([#1855](https://github.com/getpaseo/paseo/pull/1855))
- New workspace action shows for non-git projects in the sidebar ([#1857](https://github.com/getpaseo/paseo/pull/1857) by [@cleiter](https://github.com/cleiter))

## 0.1.103 - 2026-07-01

### Added

- Claude Sonnet 5 is available in the Claude model picker ([#1850](https://github.com/getpaseo/paseo/pull/1850))

## 0.1.102 - 2026-06-30

### Added

- Fork chats into a new tab or new worktree ([#1788](https://github.com/getpaseo/paseo/pull/1788))
- See workspaces from all connected hosts ([#1538](https://github.com/getpaseo/paseo/pull/1538), [#1775](https://github.com/getpaseo/paseo/pull/1775), [#1825](https://github.com/getpaseo/paseo/pull/1825))
- Daemon can now serve the web UI ([#1635](https://github.com/getpaseo/paseo/pull/1635), [#1739](https://github.com/getpaseo/paseo/pull/1739))
- Run Paseo from an official Docker image ([#1740](https://github.com/getpaseo/paseo/pull/1740) by [@Herbrant](https://github.com/Herbrant))
- Update a daemon remotely from the app ([#1513](https://github.com/getpaseo/paseo/pull/1513) by [@thedavidweng](https://github.com/thedavidweng))
- Configure separate OpenAI endpoints for speech-to-text and text-to-speech ([#1823](https://github.com/getpaseo/paseo/pull/1823))
- Drop files into any composer ([#1750](https://github.com/getpaseo/paseo/pull/1750), [#1801](https://github.com/getpaseo/paseo/pull/1801))
- Show MiniMax usage in quota views ([#1662](https://github.com/getpaseo/paseo/pull/1662) by [@ilteoood](https://github.com/ilteoood))
- Highlight C# code blocks ([#1651](https://github.com/getpaseo/paseo/pull/1651) by [@dev693](https://github.com/dev693))

### Improved

- New Workspace opens from anywhere ([#1746](https://github.com/getpaseo/paseo/pull/1746), [#1806](https://github.com/getpaseo/paseo/pull/1806))
- Project search shows loading progress ([#1762](https://github.com/getpaseo/paseo/pull/1762))
- Desktop update checks show clearer status ([#1808](https://github.com/getpaseo/paseo/pull/1808), [#1815](https://github.com/getpaseo/paseo/pull/1815))
- Slow remote hosts time out less aggressively ([#1789](https://github.com/getpaseo/paseo/pull/1789))
- Pi waits longer for extension results ([#1732](https://github.com/getpaseo/paseo/pull/1732) by [@theslava](https://github.com/theslava))
- Open file tabs refresh when you revisit them ([#1699](https://github.com/getpaseo/paseo/pull/1699) by [@cleiter](https://github.com/cleiter))
- Web terminals scroll more smoothly ([#1622](https://github.com/getpaseo/paseo/pull/1622) by [@TommyLike](https://github.com/TommyLike))

### Fixed

- Freshly added projects can be edited without restarting ([#1761](https://github.com/getpaseo/paseo/pull/1761) by [@huiliaoning](https://github.com/huiliaoning))
- Large repos open more reliably ([#1620](https://github.com/getpaseo/paseo/pull/1620) by [@jms830](https://github.com/jms830))
- Mobile restores the saved workspace on launch ([#1777](https://github.com/getpaseo/paseo/pull/1777))
- Agent prompts no longer rename workspaces ([#1779](https://github.com/getpaseo/paseo/pull/1779))
- Chat stays put when delayed history arrives ([#1776](https://github.com/getpaseo/paseo/pull/1776))
- Streamed chat images stay in order ([#1805](https://github.com/getpaseo/paseo/pull/1805))
- Chat actions stay below tool output ([#1827](https://github.com/getpaseo/paseo/pull/1827))
- Claude subagent narration stays out of chat ([#1807](https://github.com/getpaseo/paseo/pull/1807))
- Kiro slash commands and skills appear in Paseo ([#1792](https://github.com/getpaseo/paseo/pull/1792) by [@park0er](https://github.com/park0er))
- Agent lists survive stale project records ([#1812](https://github.com/getpaseo/paseo/pull/1812))
- Windows image previews handle drive-letter paths ([#1811](https://github.com/getpaseo/paseo/pull/1811))
- OpenCode closes cleanly on Windows ([#1771](https://github.com/getpaseo/paseo/pull/1771) by [@agamotto](https://github.com/agamotto))
- Desktop file uploads keep their extensions ([#1741](https://github.com/getpaseo/paseo/pull/1741))
- Claude Code cleanup kills child processes ([#1540](https://github.com/getpaseo/paseo/pull/1540) by [@TommyLike](https://github.com/TommyLike))
- OpenCode no longer indexes your home directory ([#1704](https://github.com/getpaseo/paseo/pull/1704) by [@rex-chang](https://github.com/rex-chang))
- Packaged macOS CLI daemon no longer shows extra Dock icons ([#1759](https://github.com/getpaseo/paseo/pull/1759) by [@yzim](https://github.com/yzim))
- `paseo daemon status` works without loading agents ([#1810](https://github.com/getpaseo/paseo/pull/1810))
- PR worktrees show pushed state correctly ([#1804](https://github.com/getpaseo/paseo/pull/1804))

## 0.1.101 - 2026-06-26

### Added

- Copy a troubleshooting report from Settings when support needs host, daemon, provider, and log details ([#1728](https://github.com/getpaseo/paseo/pull/1728))
- Claude image tool results now render as images in chat ([#1717](https://github.com/getpaseo/paseo/pull/1717))
- Added Japanese ([#1694](https://github.com/getpaseo/paseo/pull/1694) by [@sysCat64](https://github.com/sysCat64))
- Added Brazilian Portuguese ([#1653](https://github.com/getpaseo/paseo/pull/1653) by [@Alcimerio](https://github.com/Alcimerio))

### Improved

- Provider diagnostics stay useful even when model discovery is slow ([#1724](https://github.com/getpaseo/paseo/pull/1724))
- Slow provider requests no longer make the app look disconnected ([#1723](https://github.com/getpaseo/paseo/pull/1723))
- Worktrees linked to differently named tracked branches find their PRs correctly ([#1718](https://github.com/getpaseo/paseo/pull/1718))
- Workspaces started from slash-command prompts get clearer names ([#1709](https://github.com/getpaseo/paseo/pull/1709))
- ACP provider catalog updated to the latest registry versions

### Fixed

- Pi no longer creates empty sessions while loading new-agent options ([#1727](https://github.com/getpaseo/paseo/pull/1727))
- Windows daemon status finds the daemon process more reliably ([#1725](https://github.com/getpaseo/paseo/pull/1725))
- OpenAI voice credentials no longer affect other OpenAI-backed tools
- Provider model lists no longer disappear during refresh

## 0.1.100 - 2026-06-24

### Added

- Cycle agent modes with Shift+Tab
- Select a custom Copilot agent when starting or mid-session ([#1700](https://github.com/getpaseo/paseo/pull/1700))

### Improved

- ACP provider catalog updated to the latest registry versions

### Fixed

- Claude no longer sends an extra API request after each message ([#1701](https://github.com/getpaseo/paseo/pull/1701))
- OpenCode no longer leaves stray background servers running after sessions end ([#1697](https://github.com/getpaseo/paseo/pull/1697))
- Slash commands and skills now load in OMP agents ([#1698](https://github.com/getpaseo/paseo/pull/1698))

## 0.1.99 - 2026-06-23

### Improved

- The PR panel now has a refresh button and clearer loading states ([#1664](https://github.com/getpaseo/paseo/pull/1664))
- Provider diagnostics and model lists now stay in sync ([#1660](https://github.com/getpaseo/paseo/pull/1660))

### Fixed

- ACP providers like Grok no longer show duplicate user messages
- Saved composer modes no longer reset while provider data is loading ([#1658](https://github.com/getpaseo/paseo/pull/1658))
- The right sidebar no longer gets stuck on mobile ([#1661](https://github.com/getpaseo/paseo/pull/1661))

## 0.1.98 - 2026-06-21

### Added

- See plan usage in-app for Claude, Codex, Copilot, Cursor, Z.AI, Grok, and Kimi ([#1278](https://github.com/getpaseo/paseo/pull/1278) by [@ABorakati](https://github.com/ABorakati))
- Added Ultracode for Claude ([#1625](https://github.com/getpaseo/paseo/pull/1625))
- Detach a subagent to run it on its own ([#1612](https://github.com/getpaseo/paseo/pull/1612))
- Add a project without creating a workspace
- Add a setting to show branch names instead of titles in the sidebar

### Improved

- Mid-turn thinking and mode changes now say they apply next turn
- PR merge options name their method: squash, merge, or rebase ([#1608](https://github.com/getpaseo/paseo/pull/1608) by [@mcowger](https://github.com/mcowger))
- A running agent's mode change is remembered for new agents
- Copy a provider's launch diagnostic in one tap ([#1611](https://github.com/getpaseo/paseo/pull/1611))

### Fixed

- OpenCode no longer scans your whole disk on macOS desktop ([#1626](https://github.com/getpaseo/paseo/pull/1626))
- Daemon no longer crashes when OpenAI speech has no API key ([#1368](https://github.com/getpaseo/paseo/pull/1368) by [@mcowger](https://github.com/mcowger))
- Reopening an archived Codex agent no longer hangs
- Claude's context meter no longer jumps to subagent usage
- Claude's context meter fills from the first message in a new session
- OpenCode's mode picker now respects your disabled modes ([#1366](https://github.com/getpaseo/paseo/pull/1366) by [@mcowger](https://github.com/mcowger))
- File links and @-mentions find files in dot-folders and deep paths ([#1609](https://github.com/getpaseo/paseo/pull/1609))
- Archiving a project's last workspace no longer makes it vanish ([#1631](https://github.com/getpaseo/paseo/pull/1631))
- Collapsed sidebar projects stay collapsed

## 0.1.97 - 2026-06-18

### Added

- **Simplify workspace model** — run multiple workspaces on the same code without a worktree, each with its own agents, terminals, and status ([#1539](https://github.com/getpaseo/paseo/pull/1539))
- **Reopen archived workspaces from History** — restore a past workspace even after its worktree was removed
- **Terminals show when their agent is working, idle, or waiting for input** ([#1507](https://github.com/getpaseo/paseo/pull/1507))
- **Attach files to agents on mobile** ([#1501](https://github.com/getpaseo/paseo/pull/1501))
- **Hide dotfiles in the file explorer** ([#1516](https://github.com/getpaseo/paseo/pull/1516) by [@yuruiz](https://github.com/yuruiz))
- **Pin terminal, browser, and new-tab buttons to the tab row and sidebar**
- **Create a new workspace with a keyboard shortcut**

### Improved

- Workspace titles come from your first prompt and are shorter ([#1563](https://github.com/getpaseo/paseo/pull/1563))
- Copy a workspace's branch or path from its hover card
- Terminals stay smooth under heavy output ([#1500](https://github.com/getpaseo/paseo/pull/1500))
- Worktrees are removed when their last workspace is archived ([#1562](https://github.com/getpaseo/paseo/pull/1562))
- Finish notifications include subagent results ([#1558](https://github.com/getpaseo/paseo/pull/1558))
- Cursor lists only models you can select ([#1556](https://github.com/getpaseo/paseo/pull/1556))
- ACP provider catalog updated to the latest registry versions

### Fixed

- Brief daemon slowdowns no longer drop your connection
- Linux AppImage updates no longer hang on quit or delete the app ([#1485](https://github.com/getpaseo/paseo/pull/1485) by [@xpufx](https://github.com/xpufx))
- Opening Providers settings no longer crashes on Android ([#1537](https://github.com/getpaseo/paseo/pull/1537))
- Coding-agent terminal shortcuts work on Windows ([#1509](https://github.com/getpaseo/paseo/pull/1509))
- ACP and Kimi sessions can be imported again ([#1510](https://github.com/getpaseo/paseo/pull/1510) by [@wbxl2000](https://github.com/wbxl2000))
- ACP agents shut down without leaving orphaned processes ([#1460](https://github.com/getpaseo/paseo/pull/1460) by [@yeshan333](https://github.com/yeshan333))
- Imported session previews show clean prompts ([#1502](https://github.com/getpaseo/paseo/pull/1502))
- Local pairing offers use the correct app URL ([#1187](https://github.com/getpaseo/paseo/pull/1187) by [@aibaiiqpl](https://github.com/aibaiiqpl))
- The app no longer freezes from repeated provider re-probes
- Removing a project from the sidebar now removes the project itself instead of leaving it behind
- Workspace shortcut numbers no longer appear for the wrong key ([#1580](https://github.com/getpaseo/paseo/pull/1580) by [@cleiter](https://github.com/cleiter))
- Chats no longer hang when a message contains unmatched backticks ([#1585](https://github.com/getpaseo/paseo/pull/1585) by [@thaning0](https://github.com/thaning0))

## 0.1.96 - 2026-06-13

_This release only fixes an Android issue — desktop users don't need to update._

### Fixed

- On Android, the sidebar no longer reappears and gets stuck after you open a chat

## 0.1.95 - 2026-06-13

### Added

- **Attach any file to agents on desktop** ([#1474](https://github.com/getpaseo/paseo/pull/1474))

### Improved

- The git push button shows before merge actions when your branch is ahead ([#1488](https://github.com/getpaseo/paseo/pull/1488))
- SVG attachments are uploaded to disk
- Switching workspaces feels smoother

### Fixed

- Fixed cases where outdated GitHub data could be shown ([#1491](https://github.com/getpaseo/paseo/pull/1491))
- Uploaded images in PR comments and review threads now load in the PR panel ([#1486](https://github.com/getpaseo/paseo/pull/1486))
- Opening a project whose folder is missing shows a clear error ([#1490](https://github.com/getpaseo/paseo/pull/1490))
- The new workspace title moves out of the way of the keyboard ([#1489](https://github.com/getpaseo/paseo/pull/1489))
- Sidebars no longer open on their own on Android

## 0.1.94 - 2026-06-12

### Added

- **Attach pull request comments, reviews, threads, and failed check logs to chat from the PR panel** ([#1400](https://github.com/getpaseo/paseo/pull/1400))
- **Use Paseo in Arabic, Chinese, English, French, Russian, and Spanish** ([#1282](https://github.com/getpaseo/paseo/pull/1282), [#1478](https://github.com/getpaseo/paseo/pull/1478) by [@chyendongnhanh338](https://github.com/chyendongnhanh338), [@dwyanewang](https://github.com/dwyanewang))
- **Create reusable terminal profiles from Host settings**
- **Open workspaces in Antigravity** ([#1424](https://github.com/getpaseo/paseo/pull/1424) by [@krumpyzoid](https://github.com/krumpyzoid))

### Improved

- Claude skills appear in prompt autocomplete as you type ([#1464](https://github.com/getpaseo/paseo/pull/1464))
- Copy file paths directly from file preview tab menus ([#1473](https://github.com/getpaseo/paseo/pull/1473))
- PR status stays current after an agent merges a branch ([#1455](https://github.com/getpaseo/paseo/pull/1455))
- Workspace tabs stay fast by retaining only the active workspace screens ([#1472](https://github.com/getpaseo/paseo/pull/1472))

### Fixed

- Composer send shortcuts no longer conflict with other keyboard shortcuts
- Multi-question prompts advance one answer at a time ([#1462](https://github.com/getpaseo/paseo/pull/1462))
- Imported Pi sessions keep their original model and thinking settings ([#1441](https://github.com/getpaseo/paseo/pull/1441) by [@thomasaull](https://github.com/thomasaull))
- Reconnecting to a desktop host keeps the saved shell and workspace route
- Worktree terminals no longer appear in parent workspaces
- Mobile reconnects show the welcome screen correctly

## 0.1.93 - 2026-06-10

### Added

- **Claude Fable 5 is available in the Claude model picker** ([#1443](https://github.com/getpaseo/paseo/pull/1443) by [@0-Captain](https://github.com/0-Captain))

## 0.1.92 - 2026-06-10

### Added

- **Skills autocomplete inside prompts**

### Improved

- Provider catalog is inline in Host settings ([#1423](https://github.com/getpaseo/paseo/pull/1423))
- Manual update checks skip staged rollout delays
- CodeWhale replaces DeepSeek TUI in the provider catalog
- ACP provider catalog entries are updated for Cline, Codebuddy Code, DimCode, Factory Droid, Gemini, Nova, and Qoder
- OMP has its own icon and website page
- Model selector descriptions are clearer
- ACP provider errors show the provider's real failure message

### Fixed

- New Paseo worktree branches can push their first commits
- Imported sessions no longer open blank or in the wrong workspace
- Windows Explorer opens the selected workspace instead of Documents ([#1412](https://github.com/getpaseo/paseo/pull/1412) by [@bjspi](https://github.com/bjspi))
- Windows editor shortcuts installed as command shims launch correctly ([#1387](https://github.com/getpaseo/paseo/pull/1387) by [@Peter7896](https://github.com/Peter7896))
- ACP providers that cannot use MCP servers can start correctly
- Removed hosts no longer leave host pages stuck connecting
- File preview links open in your external browser
- Chat stays pinned to the latest message while output streams
- The mobile composer send button no longer shifts while typing

## 0.1.91 - 2026-06-08

### Added

- **Open multiple desktop windows** ([#1355](https://github.com/getpaseo/paseo/pull/1355) by [@arieel-ost](https://github.com/arieel-ost))
- **Open browser pop-ups and links inside workspace tabs** ([#1375](https://github.com/getpaseo/paseo/pull/1375))
- **Use the command center from mobile**
- **Add OMP as a provider** ([#1388](https://github.com/getpaseo/paseo/pull/1388))

### Improved

- New workspaces remember your last provider, mode, and thinking choices
- Git controls now default ready branches to pull requests and hide unavailable pull or push actions
- Desktop-managed hosts recover more reliably after stale daemon state
- Daemon status now explains authentication failures
- Project search skips Python virtual environments ([#1356](https://github.com/getpaseo/paseo/pull/1356))
- Config files can include `$schema` for editor help
- Claude MCP servers preserve always-load tool settings ([#1333](https://github.com/getpaseo/paseo/pull/1333) by [@nodomain](https://github.com/nodomain))
- Claude profiles keep their configured models ([#1311](https://github.com/getpaseo/paseo/pull/1311) by [@ilteoood](https://github.com/ilteoood))
- Provider loading can wait longer on slow machines ([#1346](https://github.com/getpaseo/paseo/pull/1346) by [@nodomain](https://github.com/nodomain))
- The Kimi catalog entry now points to Kimi Code CLI ([#1403](https://github.com/getpaseo/paseo/pull/1403) by [@wbxl2000](https://github.com/wbxl2000))
- ACP provider catalog entries are updated for Auggie, Claude Agent, Cline, Codebuddy Code, DimCode, Factory Droid, fast-agent, Gemini, GitHub Copilot, and Nova
- Local dictation crash reports show more useful details ([#1379](https://github.com/getpaseo/paseo/pull/1379))
- Daemon logs show why managed workers exit

### Fixed

- Pi compaction slash commands run correctly ([#1338](https://github.com/getpaseo/paseo/pull/1338) by [@chyendongnhanh338](https://github.com/chyendongnhanh338))
- Auto-archiving still works after a merged PR branch is deleted ([#1378](https://github.com/getpaseo/paseo/pull/1378))
- Worktrees can check out existing branch refs correctly ([#1358](https://github.com/getpaseo/paseo/pull/1358) by [@dixonl90](https://github.com/dixonl90))
- File downloads work when daemon password protection is enabled ([#1351](https://github.com/getpaseo/paseo/pull/1351) by [@nodomain](https://github.com/nodomain))
- iOS markdown links are tappable again ([#1334](https://github.com/getpaseo/paseo/pull/1334) by [@kaspesi](https://github.com/kaspesi))
- iOS markdown images render correctly
- Windows workspaces load their providers correctly ([#1329](https://github.com/getpaseo/paseo/pull/1329))
- Removing a localhost host stops its local daemon ([#1297](https://github.com/getpaseo/paseo/pull/1297) by [@mcowger](https://github.com/mcowger))
- Provider settings sheets stack correctly
- The new workspace screen no longer opens behind the mobile sidebar
- Global agent listing works again ([#1420](https://github.com/getpaseo/paseo/pull/1420))
- OpenCode compaction summaries stay out of chat
- OpenCode agents sharing a workspace keep their own Paseo tools

## 0.1.90 - 2026-06-04

### Added

- **Group the sidebar by status so workspaces waiting on you, ready to review, working, and done are visible at a glance** ([#1317](https://github.com/getpaseo/paseo/pull/1317))
- **Start a new workspace from the global sidebar button without choosing a project first** ([#1324](https://github.com/getpaseo/paseo/pull/1324))
- **Open the active file directly in your editor, file manager, or GitHub instead of only opening the workspace root** ([#1285](https://github.com/getpaseo/paseo/pull/1285) by [@aaronzhongg](https://github.com/aaronzhongg))
- **Automatically archive clean PR workspaces after the PR is merged from host settings** ([#1313](https://github.com/getpaseo/paseo/pull/1313))
- **Desktop-managed Paseo skills stay current after installing a newer desktop build** ([#1309](https://github.com/getpaseo/paseo/pull/1309))
- **Dart files and Dart code blocks are now syntax-highlighted** ([#1326](https://github.com/getpaseo/paseo/pull/1326))

### Improved

- Sidebar workspaces can be marked as read when they are ready to review or failed ([#1317](https://github.com/getpaseo/paseo/pull/1317))
- Child agents keep unattended permissions when delegated across providers ([#1315](https://github.com/getpaseo/paseo/pull/1315))
- Scheduled agents open with the real prompt and title instead of looking empty ([#1316](https://github.com/getpaseo/paseo/pull/1316))
- Git controls prioritize the action that gets a ready branch shipped ([#1316](https://github.com/getpaseo/paseo/pull/1316))
- Multiple agent questions are shown one at a time
- OpenCode questions with free-write answers show the typed response in Paseo
- Delegated agent activity is visible on the parent workspace
- Sessions are ordered by latest activity
- ACP provider catalog entries are updated for Claude Agent, Cline, Codebuddy Code, Factory Droid, and Qoder

### Fixed

- Timeline catch-up no longer leaves older messages unloaded
- Markdown code in file previews renders correctly
- Long dictation retries no longer stall new audio
- Settings host picker navigation works from host settings pages
- Diff gutter rows stay aligned with changed code
- Mobile sidebar gestures stay responsive under load
- Compact sheets keep their footer and bottom spacing visible

## 0.1.89 - 2026-06-02

### Added

- **Open workspace services through public service proxy links** ([#1280](https://github.com/getpaseo/paseo/pull/1280) by [@mcowger](https://github.com/mcowger))
- **Choose where new worktrees are created** ([#1230](https://github.com/getpaseo/paseo/pull/1230) by [@mcowger](https://github.com/mcowger))
- **Desktop windows reopen at the same size and position** ([#1224](https://github.com/getpaseo/paseo/pull/1224) by [@everton-dgn](https://github.com/everton-dgn))
- **Delegated agents can run independently and send recurring heartbeat updates**

### Improved

- Composer controls fit better in narrow panes
- Fork pull request badges stay visible in worktrees
- Cline in the ACP catalog is updated to v3

### Fixed

- Archiving a worktree finishes even if teardown hits an error ([#1260](https://github.com/getpaseo/paseo/pull/1260) by [@mcowger](https://github.com/mcowger))
- iOS chat messages render bold, italics, strikethrough, and line breaks correctly ([#1254](https://github.com/getpaseo/paseo/pull/1254) by [@outofrange-consulting](https://github.com/outofrange-consulting))
- Right-edge split pane resizing no longer clips ([#1261](https://github.com/getpaseo/paseo/pull/1261) by [@everton-dgn](https://github.com/everton-dgn))
- Pi extension command output no longer hangs
- Delegated agents no longer appear in workspace alert counts

## 0.1.88 - 2026-06-01

### Added

- **Choose an app theme from the new Appearance settings**
- **Set a custom interface font**
- **Set a custom code font**
- **Adjust the interface text size**
- **Adjust the code text size**
- **Choose a syntax highlighting theme**
- **Keep cron schedules aligned to a chosen time zone** ([#1232](https://github.com/getpaseo/paseo/pull/1232) by [@damselem](https://github.com/damselem))

### Improved

- Settings now has a flatter sidebar with a host picker
- Workspace tab switching is faster
- Compact composers now show context usage as a percentage
- Agent terminals opened in workspace subdirectories now appear with the rest of the workspace terminals
- macOS displays can idle normally while the desktop app is open ([#1242](https://github.com/getpaseo/paseo/pull/1242) by [@fireblue](https://github.com/fireblue))
- Large generated diffs now show a clear too-large placeholder instead of trying to render the whole file

### Fixed

- Chat history catches up correctly around long-running tool updates
- Terminal panes keep the right size after splitting or resizing panes
- Restored terminal snapshots reflow correctly after the pane size changes
- Workspace scripts menus keep the right size after launching a service
- iOS chat messages no longer hide inline links, URLs, or linked file paths ([#1257](https://github.com/getpaseo/paseo/pull/1257) by [@outofrange-consulting](https://github.com/outofrange-consulting))

## 0.1.87 - 2026-05-30

### Added

- Permission prompts from OpenCode subagents now surface in Paseo so you can approve or deny them

### Fixed

- Fixed an intermittent Android crash while animated views were drawing
- Fixed mobile bottom sheets not reopening after being dismissed

## 0.1.86 - 2026-05-29

### Added

- **Launch Grok (xAI) as a coding agent**
- **Fast mode for Claude Opus**
- **Multilingual local dictation with the new Parakeet v3 speech model**

### Improved

- Edit, Write, and Read tool calls are now syntax-highlighted
- The model selector shows the error when a provider fails to load
- The About page shows the versions of connected host daemons
- Refresh git diffs on demand with a new refresh button
- Previews can open readable files outside the current workspace
- Projects without an icon now show a colored icon instead of a grey placeholder
- Auto-generated agent titles and worktree branch names now use your configured provider fallbacks ([#1219](https://github.com/getpaseo/paseo/pull/1219) by [@mcowger](https://github.com/mcowger))
- Local dictation keeps its speech models out of the daemon, lowering its memory use

### Fixed

- On mobile, the whole composer now stays above the keyboard so the subagents track and draft pills no longer hide behind it
- The mobile agent timeline now catches up fully after reconnecting, so no messages go missing
- The slash command menu no longer shows /clear twice

## 0.1.85 - 2026-05-29

### Added

- **Opus 4.8 in the Claude model picker**, with a 1M-context variant

### Improved

- Archiving a worktree now keeps its agents under the archived list instead of removing them
- Archiving an agent cleans up any schedules targeting it

## 0.1.84 - 2026-05-28

### Added

- **Auto-accept tool calls for OpenCode agents**

### Improved

- Copy an OpenCode resume command to continue the session outside Paseo
- Model selector lists every enabled provider, with a Retry button when one fails to load
- Provider settings are easier to search and manage
- Other agents connecting to Paseo via MCP see the same providers, models, and modes as the app ([#1198](https://github.com/getpaseo/paseo/pull/1198))
- OpenCode Edit tool calls render as inline diffs
- Typing a slash command shows the best match first
- Daemon starts faster on workspaces with many git folders
- Markdown lists have tighter spacing
- Less jank when streaming agent responses
- User message footer controls align with the rest of the chat
- Agent mode controls use a cleaner monochrome treatment
- Compact layouts move the context ring to the footer right edge

### Fixed

- Allow selecting text in the chat on mobile ([#1153](https://github.com/getpaseo/paseo/pull/1153) by [@muzhi1991](https://github.com/muzhi1991))
- Submitting a Pi question no longer looks like a second prompt opened ([#1188](https://github.com/getpaseo/paseo/pull/1188) by [@yuruiz](https://github.com/yuruiz))
- Daemon memory leak from unbounded workspace git caches ([#1200](https://github.com/getpaseo/paseo/pull/1200))
- Provider diagnostics include the command override binary path ([#1191](https://github.com/getpaseo/paseo/pull/1191))
- OpenCode MCP servers connect correctly when the daemon binds to wildcard addresses
- Tool calls from MCP servers that return non-spec output no longer fail validation

## 0.1.83 - 2026-05-26

### Fixed

- Creating an agent via MCP now waits for it to actually start, so failures surface as a clear create error
- Scheduling an agent via MCP no longer rejects blank cadence placeholders
- Draft messages show the agent mode chip again on models without thinking options

## 0.1.82 - 2026-05-26

### Added

- **Rewind chat or files from any user message** ([#1154](https://github.com/getpaseo/paseo/pull/1154))
- **See the cumulative cost of an agent session** ([#1163](https://github.com/getpaseo/paseo/pull/1163))
- **Drop files onto the terminal to insert their paths** ([#1173](https://github.com/getpaseo/paseo/pull/1173))
- **Tap a file path in the terminal to open it in the workspace preview** ([#1174](https://github.com/getpaseo/paseo/pull/1174))
- **Approve OpenCode permissions for the whole session** ([#1168](https://github.com/getpaseo/paseo/pull/1168))
- **Workspace scripts now appear on the mobile header** ([#1093](https://github.com/getpaseo/paseo/pull/1093) by [@ayhanmalkoc](https://github.com/ayhanmalkoc))
- Devin CLI in the ACP provider catalog (by [@Alcimerio](https://github.com/Alcimerio))
- OpenCode agents show their mode colors

### Improved

- Mobile terminal keyboard hides when you open a sidebar
- Tool activity for read, write, and OpenCode tools renders more consistently ([#1171](https://github.com/getpaseo/paseo/pull/1171))
- Compact workspace header actions are tidier
- Settings latency readouts are easier to scan ([#1170](https://github.com/getpaseo/paseo/pull/1170))
- Pull request merge is available as soon as GitHub reports the PR is ready ([#1172](https://github.com/getpaseo/paseo/pull/1172))

### Fixed

- Mobile slash command autocomplete no longer flickers or mis-layers
- Interrupting an OpenCode agent returns it to idle instead of showing an error ([#1169](https://github.com/getpaseo/paseo/pull/1169))
- Provider model selection per workspace is honored ([#1167](https://github.com/getpaseo/paseo/pull/1167))
- Draft composer keeps the permission mode you selected ([#1175](https://github.com/getpaseo/paseo/pull/1175))
- Terminal color queries no longer return malformed replies
- File links in chat no longer crash when a message contains a bare '%' (by [@Elliotwu-7](https://github.com/Elliotwu-7))

## 0.1.81 - 2026-05-24

### Added

- **Paseo can now be installed as a web app from supported browsers** ([#1144](https://github.com/getpaseo/paseo/pull/1144))
- **Pi extension dialogs now appear as Paseo permission prompts** ([#1134](https://github.com/getpaseo/paseo/pull/1134) by [@yuruiz](https://github.com/yuruiz))
- Added community links and a home button to the sidebar

### Improved

- **Mobile terminals load faster and restore existing output more smoothly** ([#1147](https://github.com/getpaseo/paseo/pull/1147))
- Copying assistant messages preserves formatting
- Agent metadata fallback failures now log each provider attempt for easier debugging

### Fixed

- Android: slash command suggestions stay interactive when opened from the composer
- macOS: Alt+letter shortcuts work again
- Terminal panes no longer flicker during resize
- OpenCode MCP servers are injected once instead of being connected twice
- Import session no longer shows empty sessions
- Worktree archive status no longer reports false unpushed commits ([#1158](https://github.com/getpaseo/paseo/pull/1158))
- The `/exit`, `/quit`, and `/q` slash command aliases now show as one row
- Shortcut chord badges are readable in light mode
- Segmented controls show their track under every segment
- Sheet header search text is readable in dark mode

## 0.1.80 - 2026-05-21

### Fixed

- Opening dropdown menus no longer crashes on mobile

## 0.1.79 - 2026-05-21

### Added

- **Pi has been revamped with first-class support**
  - Runs through your installed Pi CLI, so your Pi extensions and configuration carry over
  - Pi agents can call Paseo tools when you have the Pi MCP extension installed
  - Import a Pi session you started in the terminal
  - Copy Pi's resume command from any agent to continue the session in your terminal
  - Windows: Pi sessions match correctly across symlinked and junctioned workspace paths
- **New home screen with quick tiles for adding a project, importing a session, setting up providers, and pairing a device**
- **Create an agent directly into a fresh worktree that auto-archives when the run finishes**
- **Set a custom system prompt that applies to every agent you start**
- **Rename workspaces, terminals, and agent tabs** ([#531](https://github.com/getpaseo/paseo/pull/531))
- **DeepSeek TUI in the ACP provider catalog** ([#1096](https://github.com/getpaseo/paseo/pull/1096))
- **Kiro CLI in the ACP provider catalog** (by [@huhusmang](https://github.com/huhusmang))
- Catalog providers show their icons in the model picker ([#1098](https://github.com/getpaseo/paseo/pull/1098))
- Custom environment variables passed when creating an agent now reach the agent process ([#1112](https://github.com/getpaseo/paseo/pull/1112))
- NixOS module supports the public TLS option for self-hosted relays ([#1106](https://github.com/getpaseo/paseo/pull/1106) by [@yzx9](https://github.com/yzx9))

### Improved

- **Stale host connections recover automatically without a manual refresh**
- Paseo opens to the workspace you were on last time you used it ([#1101](https://github.com/getpaseo/paseo/pull/1101))
- Workspaces remember which editor you opened them in
- Outdated daemons now suggest an upgrade when they receive a command they don't understand
- Voice mode is hidden while an agent is running
- Agent file-link tooltips show the full resolved file path ([#1088](https://github.com/getpaseo/paseo/pull/1088))
- Workspace git status refreshes less aggressively in the background ([#1102](https://github.com/getpaseo/paseo/pull/1102))

### Fixed

- macOS desktop no longer freezes after the display wakes from sleep ([#745](https://github.com/getpaseo/paseo/pull/745))
- Windows: Codex picks up the Microsoft Store install correctly ([#1020](https://github.com/getpaseo/paseo/pull/1020) by [@32r4](https://github.com/32r4))
- Workspace selection survives a daemon restart ([#1111](https://github.com/getpaseo/paseo/pull/1111))
- Cursor agents wait for slash commands to load before listing them ([#1099](https://github.com/getpaseo/paseo/pull/1099) by [@chrisbanes](https://github.com/chrisbanes))
- Codex sub-agents keep running through transient child process errors (by [@xy-plus](https://github.com/xy-plus))
- iPad terminals send Ctrl+C correctly from a hardware keyboard (by [@samatar26](https://github.com/samatar26))
- Git filenames with non-ASCII characters render correctly (by [@samatar26](https://github.com/samatar26))
- Paste shortcuts work on Dvorak keyboard layouts (by [@qin-nz](https://github.com/qin-nz))
- Claude file links resolve correctly for projects whose paths need SDK encoding
- Duplicate Claude result text no longer appears in chat ([#1095](https://github.com/getpaseo/paseo/pull/1095))
- Dynamic UI styles no longer leak CSS rules across the page ([#1103](https://github.com/getpaseo/paseo/pull/1103))
- Relay handshakes reject sessions that try to change encryption keys mid-flight ([#1037](https://github.com/getpaseo/paseo/pull/1037) by [@joaosa](https://github.com/joaosa))

## 0.1.78 - 2026-05-18

### Improved

- **Mobile model selector is faster and more straightforward** Picking a model, mode, or thinking option takes fewer taps

### Fixed

- Splitting a pane no longer loses your scroll position
- Typing in mobile sheets no longer flickers
- Sheets on mobile web no longer crash when swiped to dismiss

## 0.1.77 - 2026-05-18

### Added

- **Slash commands to end and restart an agent**
- **Syntax highlighting for code blocks in chat**
- **Copy button on code blocks in chat**
- **Configurable terminal scrollback** ([#1021](https://github.com/getpaseo/paseo/pull/1021) by [@32r4](https://github.com/32r4))
- Assistant file links open at a specific line range when one is included
- Mode icons appear in the agent status menu ([#1059](https://github.com/getpaseo/paseo/pull/1059) by [@32r4](https://github.com/32r4))
- MCP exposes schedule update, logs, and run-once tools ([#1032](https://github.com/getpaseo/paseo/pull/1032) by [@skevetter](https://github.com/skevetter))
- Self-hosted relays can use a different TLS setting for the public endpoint ([#1045](https://github.com/getpaseo/paseo/pull/1045) by [@yzx9](https://github.com/yzx9))

### Improved

- User messages now have a distinct bubble fill for clearer chat hierarchy
- Closing a tab returns to its parent tab
- Diff rows show the full file path on hover ([#1061](https://github.com/getpaseo/paseo/pull/1061) by [@Myriad-Dreamin](https://github.com/Myriad-Dreamin))
- The CLI shows the remote daemon host when `ls` cannot connect ([#1043](https://github.com/getpaseo/paseo/pull/1043) by [@mturac](https://github.com/mturac))
- Nix install of the daemon is smaller ([#966](https://github.com/getpaseo/paseo/pull/966) by [@ixxie](https://github.com/ixxie))
- Nix install honors home-manager profile paths when inheriting the user PATH ([#1040](https://github.com/getpaseo/paseo/pull/1040) by [@ixxie](https://github.com/ixxie))

### Fixed

- OpenCode probes no longer create empty sessions
- OpenCode custom commands no longer hang
- OpenCode session imports succeed across more environments
- Native diff rows expand correctly ([#940](https://github.com/getpaseo/paseo/pull/940) by [@bolasblack](https://github.com/bolasblack))
- Mobile sidebar interactions work correctly on web ([#900](https://github.com/getpaseo/paseo/pull/900) by [@nikuscs](https://github.com/nikuscs))
- Mobile web drag gestures fire reliably ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Mobile web drag-and-drop activates correctly ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- iOS Safari no longer zooms when focusing the composer ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Enter behavior in the mobile web composer is consistent ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Composer no longer flickers when resizing with long prompts
- Inline code links in assistant messages open the correct file
- Host switcher popover is wide enough to show host names ([#981](https://github.com/getpaseo/paseo/pull/981) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))
- Windows: importing existing sessions matches paths correctly ([#1012](https://github.com/getpaseo/paseo/pull/1012) by [@kj1534](https://github.com/kj1534))

## 0.1.76 - 2026-05-15

### Added

- **Chat timestamps and turn durations** Every message shows when it was sent, and each turn surfaces how long the agent took
- **Auto Review permission mode for Claude Code and Codex** Agents stop after each assistant turn for review instead of running unattended ([#928](https://github.com/getpaseo/paseo/pull/928), [#963](https://github.com/getpaseo/paseo/pull/963) by [@bolasblack](https://github.com/bolasblack))
- Surface Codex's context compaction events and the `/compact` command in chat
- Optional auto-archive for worktrees once their PR merges
- Paste a GitHub PR or issue URL into the composer to attach it as context
- Surface GitHub auto-merge actions in the PR hover card
- Show all PR check counts in the PR hover card
- Rename a project to disambiguate duplicates that share a folder name
- Confirm before archiving a worktree with uncommitted or unpushed work
- Claude Code now picks up models from `~/.claude/settings.json` so custom model lists show up in the model picker
- Local Claude Code settings (`.claude/settings.local.json`) apply per workspace
- Diagnostics for generic ACP providers surface in the model picker
- Allow setting fast mode for Paseo subagents ([#909](https://github.com/getpaseo/paseo/pull/909), [#910](https://github.com/getpaseo/paseo/pull/910) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

### Improved

- Surface Claude error messages in chat instead of ending the turn silently
- Workspace checkout picker auto-selects when a single PR is attached
- New workspace flow honors the currently checked-out branch when branching off ([#909](https://github.com/getpaseo/paseo/pull/908) by [@sbtobb](https://github.com/sbtobb))
- OpenCode models from console subscription providers now appear in the model picker ([#917](https://github.com/getpaseo/paseo/pull/917) by [@t2o2](https://github.com/t2o2))
- Cursor model picker reflects the models advertised by the Cursor ACP client ([#958](https://github.com/getpaseo/paseo/pull/958) by [@chrisbanes](https://github.com/chrisbanes))

### Fixed

- iPad hardware Enter submits the composer ([#919](https://github.com/getpaseo/paseo/pull/919) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))
- PR status falls back to a non-checks query for fine-grained GitHub tokens ([#932](https://github.com/getpaseo/paseo/pull/932) by [@32r4](https://github.com/32r4))
- ACP errors display as readable text instead of `[object Object]`
- OpenCode no longer hangs on retry when the upstream provider stalls
- Worktree ahead count is correct when the upstream branch has been deleted
- Branch-off worktrees track the correct upstream
- File changes view works on empty repositories with no commits yet
- Assistant message file links open the correct file
- Default thinking option matches the selected model's capabilities
- Shift+Enter works again in terminal input modes
- Duplicate project entries no longer appear after reopening a project
- Pi-backed sessions recover after a Copilot 413 instead of staying stuck
- Skip probing unrelated executable candidates when launching agents
- Relay E2EE reconnects cleanly under racing connect/disconnect
- Workspace kind stays in sync with project kind after reconfiguration
- zsh integration files install with usable runtime modes
- MCP worktree cache refreshes after create and archive ([#911](https://github.com/getpaseo/paseo/pull/911) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

## 0.1.75 - 2026-05-12

### Added

- Set the speech-to-text language used by dictation and voice mode from settings ([#941](https://github.com/getpaseo/paseo/pull/941))

### Fixed

- Codex resume failures now surface as explicit errors instead of leaving the agent silently stuck ([#947](https://github.com/getpaseo/paseo/pull/947))
- Custom providers extending Codex now route correctly when they set a custom `OPENAI_BASE_URL` ([#915](https://github.com/getpaseo/paseo/pull/915))
- Fixed Copilot's **Allow All** mode (renamed from Autopilot) ([#935](https://github.com/getpaseo/paseo/pull/935))
- Desktop: daemon startup no longer fails when a stale PID file is left next to a still-running daemon ([#913](https://github.com/getpaseo/paseo/pull/913) by [@biaoma-ty](https://github.com/biaoma-ty))
- iPhone HEIC photos now attach correctly from the image picker ([#934](https://github.com/getpaseo/paseo/pull/934))
- Scheduled agents now archive automatically after each run ([#945](https://github.com/getpaseo/paseo/pull/945))
- Windows: Codex command summaries trim `pwsh`, `powershell`, or `cmd` wrappers ([#931](https://github.com/getpaseo/paseo/pull/931) by [@32r4](https://github.com/32r4))
- iPad: settings sidebar and main sidebar respect the top safe area in wide layouts ([#922](https://github.com/getpaseo/paseo/pull/922), [#937](https://github.com/getpaseo/paseo/pull/937) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

## 0.1.74 - 2026-05-11

### Fixed

- **OpenCode agent turns no longer stall** Paseo now follows OpenCode's global event stream, so turns stream reliably without falling back to fragile recovery paths ([#916](https://github.com/getpaseo/paseo/pull/916))

## 0.1.73 - 2026-05-10

### Fixed

- **OpenCode agents work again on OpenCode 1.14.42+** ([#895](https://github.com/getpaseo/paseo/pull/895), [#902](https://github.com/getpaseo/paseo/pull/902), [#904](https://github.com/getpaseo/paseo/pull/904) by [@atomlink-ye](https://github.com/atomlink-ye), [@plutofog](https://github.com/plutofog))
- Web: opening a workspace no longer hangs in browsers without `crypto.randomUUID` ([#858](https://github.com/getpaseo/paseo/pull/858) by [@cokekitten](https://github.com/cokekitten))
- Codex sub-agent child tool calls now report a final failure state instead of staying as "running" ([#899](https://github.com/getpaseo/paseo/pull/899))
- Old relay pairing URLs without an explicit TLS flag work again ([#896](https://github.com/getpaseo/paseo/pull/896))
- macOS: the tab-jump shortcut no longer collides with system shortcuts ([#859](https://github.com/getpaseo/paseo/pull/859) by [@nikuscs](https://github.com/nikuscs))
- Web: the composer no longer triggers a bottom-sheet keyboard on desktop browsers ([#898](https://github.com/getpaseo/paseo/pull/898) by [@nikuscs](https://github.com/nikuscs))
- Windows: git operations no longer flash a console window on each invocation ([#897](https://github.com/getpaseo/paseo/pull/897))
- File explorer no longer follows symlinks outside the workspace root ([#847](https://github.com/getpaseo/paseo/pull/847) by [@joaosa](https://github.com/joaosa))
- Desktop only opens external URLs via http(s) and mailto schemes ([#845](https://github.com/getpaseo/paseo/pull/845) by [@joaosa](https://github.com/joaosa))
- MCP debug request logs now redact request bodies ([#842](https://github.com/getpaseo/paseo/pull/842) by [@joaosa](https://github.com/joaosa))

## 0.1.72 - 2026-05-10

### Fixed

- **Codex approval prompts no longer hang** Fixes a regression introduced in 0.1.70 where Codex agents would wait forever on command and file approvals — the prompt never reached the app and the agent stayed stuck in "running" ([#866](https://github.com/getpaseo/paseo/pull/866), [#869](https://github.com/getpaseo/paseo/pull/869))
- **Windows: daemon no longer crashes when Codex emits non-JSON output** Localized stdout lines from the Codex CLI are now ignored instead of taking down the daemon worker ([#866](https://github.com/getpaseo/paseo/pull/866))
- Drag-and-drop images onto the new workspace screen now works ([#850](https://github.com/getpaseo/paseo/pull/850))
- Archiving a worktree from the toolbar redirects you immediately instead of leaving you on the dead screen for a beat ([#852](https://github.com/getpaseo/paseo/pull/852))
- Pi-backed sessions now shut down cleanly when you close them, releasing extension resources on the Pi side ([#863](https://github.com/getpaseo/paseo/pull/863))

## 0.1.71 - 2026-05-09

### Added

- **Import existing Claude, Codex, and OpenCode sessions** into Paseo — pick up a conversation you started in the terminal and keep going from the app, with the full timeline ([#766](https://github.com/getpaseo/paseo/pull/766), [#833](https://github.com/getpaseo/paseo/pull/833))
- **Subagents now appear in a collapsible section above the composer** so you can jump into agents your main agent spawned ([#532](https://github.com/getpaseo/paseo/pull/532))
- Merge a pull request directly from the checkout pane ([#814](https://github.com/getpaseo/paseo/pull/814))
- Customize the per-project prompts Paseo uses to auto-generate agent titles, branch names, commit messages, and pull request descriptions ([#836](https://github.com/getpaseo/paseo/pull/836))
- Open an empty workspace without typing a prompt first ([#834](https://github.com/getpaseo/paseo/pull/834))
- Project settings are now grouped with inline links to the relevant docs ([#837](https://github.com/getpaseo/paseo/pull/837))
- Rich context menu on desktop — copy link, copy image, and spellcheck suggestions
- Archiving a Codex-backed agent now archives the underlying native Codex thread too ([#827](https://github.com/getpaseo/paseo/pull/827) by [@32r4](https://github.com/32r4))

### Improved

- Opening a workspace auto-focuses the agent that needs your attention ([#828](https://github.com/getpaseo/paseo/pull/828))
- An unattended agent that spawns a sub-agent on a different provider via MCP now starts the sub-agent in unattended mode too

### Fixed

- iOS project picker now submits the typed path ([#831](https://github.com/getpaseo/paseo/pull/831))
- System messages and chat mentions routed to multiple agents now reach every recipient consistently ([#830](https://github.com/getpaseo/paseo/pull/830))
- Clicking a Markdown link in agent output no longer reloads the desktop app on top of opening the link
- macOS desktop tab-jump shortcuts now use Cmd+Option+1-9, avoiding conflicts with Option-based international keyboard characters such as `@`

### Security

- Local state files (daemon keypair, stored credentials, persisted config) are now readable only by the owning user ([#825](https://github.com/getpaseo/paseo/pull/825) by [@joaosa](https://github.com/joaosa))

## 0.1.70 - 2026-05-08

### Breaking

- **Claude agents now require `claude` on your PATH** Install Claude Code globally (`npm install -g @anthropic-ai/claude-code`) before running a Claude agent — Paseo no longer ships a bundled fallback binary. Same posture as Codex and OpenCode, and shrinks the desktop install by ~210 MB per platform

### Added

- **One-click ACP providers** — add Cursor, Hermes, Qwen Coder, Kimi Code, and other ACP agents from a built-in catalog instead of writing config by hand
- Codex `/goal` slash command — set or update the goal mid-turn while a Codex agent is running
- Claude's Sonnet 4.6 1M context model is now selectable in the model picker
- Detect GitHub issue and PR URLs pasted into the composer search
- `paseo worktree create` CLI command, with parity to the MCP `create_worktree` tool
- `paseo schedule update` to edit a schedule in place without recreating it
- `paseo schedule run-once` for cron-style triggers, plus `--mode` on `schedule` and `loop`. Background runs now default to unattended mode
- Projects settings now lists workspaces from any remote — GitLab, Gitea, Bitbucket, self-hosted, and SSH-style URLs, not just GitHub ([#681](https://github.com/getpaseo/paseo/pull/681) by [@krumpyzoid](https://github.com/krumpyzoid))

### Improved

- Skills now install, update, and uninstall on demand instead of silently auto-syncing on every desktop launch
- Self-hosted relays can opt into `wss://` for TLS connections
- Workspace open targets only show options reachable from the current daemon
- Combobox search matches model descriptions, not just names
- Codex image attachments render inline as path markdown
- Subagent task notifications no longer clutter the parent agent's timeline
- Voice mode: quieter thinking tone and small UI polish
- Settings sidebar order: Projects now appears after General
- Electron upgraded to 41.2.0 for the desktop app

### Fixed

- **Claude agent: daemon no longer crashes mid-turn** when the underlying SDK fires a stray control message after the connection has been torn down
- **Windows:** Terminals start reliably and shut down cleanly without leaving stuck processes behind
- **Linux:** Workspace file watchers no longer storm with events on busy working trees, fixing CPU spikes on large repos ([#794](https://github.com/getpaseo/paseo/pull/794) by [@312223105](https://github.com/312223105))
- ACP-based agents launch terminal shell commands reliably ([#793](https://github.com/getpaseo/paseo/pull/793) by [@ebg1223](https://github.com/ebg1223))
- Checkout shortstat now counts untracked files ([#608](https://github.com/getpaseo/paseo/issues/608), [#762](https://github.com/getpaseo/paseo/pull/762) by [@somus](https://github.com/somus))
- Relay endpoints on port 443 use TLS automatically ([#774](https://github.com/getpaseo/paseo/pull/774) by [@caoer](https://github.com/caoer))
- Desktop CLI passthrough TTY handling — interactive commands now behave correctly when launched from the desktop app
- The CLI honors the `PASEO_PASSWORD` environment variable for password-protected daemons
- Daemon shutdown terminates all child processes cleanly using tree-kill
- Agent spawn paths handle missing executables and unusual install layouts more reliably
- OpenCode now forwards provider retry errors instead of silently swallowing them
- Codex import no longer reverts to the wrong default mode
- Pane keyboard shortcuts no longer fire while you're typing in an editable field
- Cold workspace URL navigation now lands in the correct sidebar entry on web
- Workspace navigation regression on web fixed
- Duplicate workspace shell navigation eliminated
- The 'Update installed' callout no longer flashes incorrectly
- Browser pane reload focus and devtools handling
- MCP terminal capture now includes scrollback
- Worktree branches no longer get renamed when an agent is created against an existing worktree from MCP
- Creating an agent in a subdirectory of a registered workspace now runs in that subdirectory instead of jumping up to the parent ([#551](https://github.com/getpaseo/paseo/issues/551))
- Non-GitHub project display names are derived from the remote owner/repo instead of the local path
- Desktop IPC wrapped in shared mutation/query hooks, fixing stale state and intermittent failures ([#761](https://github.com/getpaseo/paseo/issues/761))
- `paseo schedule create --host` now requires `--cwd` to avoid running schedules in the wrong directory
- `paseo schedule create --every` runs once immediately by default, then on the configured interval
- MCP `create_agent` validates the requested mode and refuses silent cross-provider inheritance

## 0.1.69 - 2026-05-05

### Fixed

- Paseo now recovers automatically when an internal daemon process crashes — your agents stay connected instead of getting stuck and you don't have to restart anything
- Answering an interactive question from a Claude agent now reaches Claude correctly instead of being dropped ([#760](https://github.com/getpaseo/paseo/pull/760) by [@somus](https://github.com/somus))

## 0.1.68 - 2026-05-05

### Fixed

- The desktop app no longer fails on first launch after a fresh install

## 0.1.67 - 2026-05-03

### Fixed

- Archiving a worktree or workspace feels instant instead of waiting on the daemon, with automatic rollback if it fails
- The built-in daemon toggle in desktop settings now actually takes effect
- Desktop settings no longer reset on app launch after a legacy migration
- Desktop daemon startup failures now surface on the splash screen and respond to retry, instead of leaving the app silently stuck
- Internal LLM calls (branch names, commit messages, PR text) no longer leave behind ephemeral agent sessions in your provider history

## 0.1.66 - 2026-05-03

### Fixed

- Streaming markdown preserves trailing newlines so paragraph spacing stays correct while the agent is still typing
- Agent initialization failures surface within 30 seconds instead of 5 minutes
- Terminals reply to ANSI cursor-position queries, so tools that ask for cursor location no longer hang

## 0.1.65 - 2026-05-03

### Added

- **In-app browser** — open a real web browser in any workspace to test your app ([#670](https://github.com/getpaseo/paseo/pull/670) by [@jasonkneen](https://github.com/jasonkneen))
- Inline review comments in the git diff pane. Tap a line number to start a comment ([#530](https://github.com/getpaseo/paseo/pull/530))
- Sub-agent activity is now shown for Codex, OpenCode, and Claude ([#672](https://github.com/getpaseo/paseo/pull/672), [#658](https://github.com/getpaseo/paseo/pull/658) by [@thisisryanswift](https://github.com/thisisryanswift))
- Pull and push your branch in one step from the git actions menu in the changes pane
- Resume existing agent sessions with `paseo import --provider <name> <id>` ([#632](https://github.com/getpaseo/paseo/pull/632))
- Password authentication and SSL support for daemon connections ([#635](https://github.com/getpaseo/paseo/pull/635))
- Connect to a daemon via relay using a pairing offer URL from the CLI ([#639](https://github.com/getpaseo/paseo/pull/639))
- **Windows:** Native ARM64 builds are now available
- Bundled Paseo skills now refresh automatically on desktop app launch

### Improved

- Codex streaming feels more responsive — message boundaries are preserved and output arrives sooner
- Terminal sessions run in a dedicated worker process for better stability
- New worktree branch names are derived from your prompt and attachments instead of a generic placeholder
- Review comment UI is cleaner and easier to scan
- The daemon's `/api/status` endpoint is now protected by password auth when one is configured

### Fixed

- **Apple Silicon Mac:** The desktop update pipeline now publishes manifests atomically, closing a race that could install the Intel build on Apple Silicon Macs and cause 100%+ renderer CPU usage. Affected users will self-heal — electron-updater's Rosetta detection migrates back to arm64 on the next update poll ([#555](https://github.com/getpaseo/paseo/issues/555))
- **Linux:** `.deb` and `.rpm` packages now show as `Paseo` in the dock and process list instead of `Paseo.bin`. `--no-sandbox` is now scoped to AppImage only, matching VS Code's sandbox handling ([#602](https://github.com/getpaseo/paseo/issues/602))
- **Windows:** Git diff commands no longer break on paths with special characters ([#629](https://github.com/getpaseo/paseo/pull/629))
- Cursor CLI and other ACP custom providers launch reliably ([#628](https://github.com/getpaseo/paseo/pull/628))
- Daemon stays up when WebSocket clients disconnect mid-stream, and crashes now write a fatal log entry instead of disappearing silently ([#613](https://github.com/getpaseo/paseo/pull/613) by [@yuruiz](https://github.com/yuruiz))
- Long agent timelines reconnect cleanly over the relay instead of looping through disconnects while catching up ([#657](https://github.com/getpaseo/paseo/pull/657) by [@fireblue](https://github.com/fireblue))
- Agent timelines refresh with smaller catch-up requests when you reopen an agent
- Terminal snapshots flush reliably before clients reconnect
- Workspace reconnects avoid unnecessary refresh work when the focused workspace is already current
- Voice dictation keeps recording when the agent tab loses focus
- OpenCode mode picker now lists agents available in every mode ([#606](https://github.com/getpaseo/paseo/pull/606) by [@thisisryanswift](https://github.com/thisisryanswift))
- Codex plan approval panels no longer duplicate
- Imported agents display the correct title immediately
- OpenCode surfaces invalid mode/model errors instead of hanging
- Archived worktrees stay hidden without flashing back into the list ([#640](https://github.com/getpaseo/paseo/pull/640))
- Web dropdown menus no longer resize unexpectedly
- The visible changes pane keeps in sync with the working tree diff
- Tool detail rows on the timeline are selectable again
- `paseo.json` parse errors in setup, teardown, and terminal actions now surface a clear error instead of failing silently
- Diff gutter line numbers were shifted one row out of alignment in some cases on web
- Streamed agent output reconciles cleanly when the timeline hydrates mid-turn ([#663](https://github.com/getpaseo/paseo/pull/663))
- Images in assistant messages show a loading spinner while they load and an "Image unavailable" fallback if they fail, instead of a blank space
- Isolated bottom sheet modals close and re-open without getting stuck

## 0.1.64 - 2026-04-28

### Added

- OpenCode now has a Full Access mode that auto-approves tool calls ([#595](https://github.com/getpaseo/paseo/pull/595) by [@tmih06](https://github.com/tmih06))
- OpenCode supports executable slash commands ([#597](https://github.com/getpaseo/paseo/pull/597) by [@tmih06](https://github.com/tmih06))

### Improved

- `@`-mention stays responsive on very large projects ([#600](https://github.com/getpaseo/paseo/pull/600) by [@yuruiz](https://github.com/yuruiz))

### Fixed

- Workspaces still load when `paseo.json` has a parse error

## 0.1.63 - 2026-04-28

### Added

- Project settings page with a built-in `paseo.json` editor
- Cold start restores your last open workspace
- Tool call badges have a button to open the referenced file directly
- Open the current branch on GitHub from a workspace's open menu ([#583](https://github.com/getpaseo/paseo/pull/583) by [@Myriad-Dreamin](https://github.com/Myriad-Dreamin))
- Enable or disable providers from Settings without editing config files
- Paseo prompts you to configure a worktree setup script when one is missing
- Choose whether the daemon shuts down when you close the desktop app

### Improved

- Provider settings and model selection have been redesigned
- Voice mode transcription endpoint is configurable for OpenAI-compatible providers ([#570](https://github.com/getpaseo/paseo/pull/570) by [@yuruiz](https://github.com/yuruiz))
- Adding a project no longer waits for GitHub PR status to load
- Startup splash screen is cleaner — just the logo with a subtle shimmer
- `paseo.json` setup and teardown accept a single command string, not just an array
- Archiving a worktree is instant instead of waiting for the backend to confirm
- Agent timelines and git diff lists no longer jump around while loading or streaming

### Fixed

- `paseo loop run` and `paseo run` now respect the `--provider` and `--model` flags ([#594](https://github.com/getpaseo/paseo/pull/594) by [@VincenzoRocchi](https://github.com/VincenzoRocchi))
- Pi provider shows up when only DeepSeek or other non-OpenAI/Anthropic/OpenRouter API keys are set
- Custom models from `additionalModels` and `profileModels` are honored when picking a default for new agents
- File preview line numbers stay on one line past line 99
- Cmd+Q on macOS quits the desktop app instead of leaving it running in the background
- Terminal sessions recover cleanly after rendering hiccups, including the initial resize for nvim
- Terminal protocol query responses no longer leak into the browser
- Assistant link color matches the theme again
- File links with line numbers (like `foo.ts:42`) open correctly from assistant messages
- Claude's Grep results show up in the search detail body
- Reopening a worktree lands under the right project
- Agents from disabled or unavailable providers stay visible in history
- New CLI agents now require a provider instead of failing silently
- Git diff headers no longer truncate
- Provider diagnostic modal scrolls on short screens
- Provider diagnostics show the real error and underlying child-process output instead of a generic message
- Archived workspaces no longer interfere with working-directory resolution
- Triple-click on a message no longer extends the selection into adjacent bubbles
- The packaged desktop app preserves your zsh prompt

## 0.1.62 - 2026-04-23

### Added

- Sidebar warning when your app and daemon versions drift apart, with a shortcut to settings

### Improved

- Workspaces appear in the sidebar immediately on startup instead of waiting for git registration

### Fixed

- Pull request status resolves correctly for PRs opened from forks
- Installing the paseo CLI from the macOS desktop app now works in packaged builds
- Agents launched from the desktop app no longer inherit Electron-only environment variables

## 0.1.61 - 2026-04-23

### Added

- `additionalModels` option in provider config lets you add or relabel models without replacing the full list — entries merge with runtime-discovered models (ACP) or your static `models` list. See the [Providers docs](https://paseo.sh/docs/providers)
- New [Providers docs page](https://paseo.sh/docs/providers) covering first-class providers and every custom provider config pattern in one place

### Improved

- Pi loads your installed extensions on startup so their models show up in the model picker
- Resizing the explorer sidebar no longer rerenders the rest of the workspace
- Images in assistant messages (both file paths and inline data URLs) persist as local attachments and open in the file pane

## 0.1.60 - 2026-04-22

### Added

- Scripts and services per worktree — define named commands in `paseo.json`, and long-running services get supervised with their own ports and nice proxy URLs like `http://web.my-app.localhost:6767`. See the [worktrees guide](https://paseo.sh/docs/worktrees)
- Launch scripts and services for a worktree directly from the workspace header
- New Setup tab in every workspace showing setup, teardown, and script progress live
- GitHub checks and PR reviews in the explorer sidebar, with a hover card for the full breakdown
- New worktree creation flow lets you pick a base branch or check out an existing GitHub pull request
- Attach GitHub issues and pull requests to an agent as part of its prompt context
- Pull request pane in the workspace sidebar
- Redesigned Settings screen with modular section navigation
- Per-host provider configuration — set providers, models, and credentials independently on each remote host
- Direct Pi integration replaces the ACP bridge, with faster streaming and fewer hiccups
- Beta release channel — opt in from Settings to receive beta desktop builds before they are promoted to stable
- New-workspace picker ranks branches by recency with fast search

### Improved

- Workspace and tab switching are dramatically faster on desktop and mobile — you can keep many workspaces open in parallel without lag
- Agent streams render more smoothly during heavy tool output
- App startup routes through a stable connection and lands on the right screen without flicker
- Provider refresh is reliable and no longer stalls on transient failures
- Git and GitHub state stay in sync with local changes like commits, branch switches, and pushes
- Composer attachments redesigned with a cleaner pill layout and an image lightbox
- In-app notifications route to whichever surface you're actually looking at
- Keyboard shortcuts keep working while Settings is open
- Escape reliably interrupts the active agent
- Checking out a pull request from a fork lands on an owner-prefixed branch so multiple forks don't collide
- `paseo ls` defaults to active agents; pass `-a` to include archived
- GitHub branch and PR picker loads faster — queries are deferred until the picker opens

### Fixed

- Composer textarea shrinks back down after sending on web
- New workspace drafts clear after submit instead of sticking around
- Replacing a running agent cleans up the previous one without leaving it behind
- Agent notifications no longer get swallowed by a backgrounded focused client
- Removed workspace folders disappear from the workspace list again
- Codex keeps fast mode after you approve a plan ([#526](https://github.com/getpaseo/paseo/pull/526) by [@therainisme](https://github.com/therainisme))
- Workspace tab focus is preserved across page refreshes
- Settings screen no longer pushes its header down with extra spacing
- Branch switcher title no longer overflows on narrow rows
- iOS image picker no longer leaves the screen unresponsive after cancelling
- Archiving a worktree recovers cleanly if a previous attempt was interrupted
- Images in agent messages with `~`-prefixed paths load instead of spinning forever
- Tool call blocks expand correctly on mobile while an agent is still streaming
- Timeline no longer stutters when catch-up and projected ranges overlap
- Codex no longer flashes idle when a replacement turn is in progress
- Branch state recovers correctly when a rebase is in progress
- Workspace hover card no longer clips near screen edges

## 0.1.59 - 2026-04-16

### Added

- Opus 4.7 in the Claude model picker, with a 1M-context variant
- Extra High reasoning effort for Opus 4.7, between High and Max

## 0.1.58 - 2026-04-16

### Added

- Markdown files render as formatted markdown in the file pane ([#427](https://github.com/getpaseo/paseo/pull/427) by [@aaronflorey](https://github.com/aaronflorey))
- Cmd+L (Ctrl+L on Windows/Linux) focuses the agent message input
- Provider models refresh on a freshness TTL; Settings shows last-updated time and any fetch errors ([#426](https://github.com/getpaseo/paseo/pull/426))
- `disallowedTools` option in provider config to block specific tools from an agent

### Improved

- Windows: agents launch reliably from npm `.cmd` shims, paths with spaces, and JSON config args — fixes `spawn EINVAL` startup errors ([#454](https://github.com/getpaseo/paseo/pull/454))
- OpenCode permission prompts include the requesting tool's context ([#398](https://github.com/getpaseo/paseo/pull/398) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode todo and compaction events render in the timeline ([#429](https://github.com/getpaseo/paseo/pull/429) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode sessions archive cleanly when closed ([#408](https://github.com/getpaseo/paseo/pull/408) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode slash commands recover from SSE timeouts ([#407](https://github.com/getpaseo/paseo/pull/407) by [@aaronflorey](https://github.com/aaronflorey))
- Paseo MCP tools work against archived agents, matching the CLI ([#423](https://github.com/getpaseo/paseo/pull/423))
- Native scrollbars match the active theme across all web views ([#399](https://github.com/getpaseo/paseo/pull/399) by [@ethersh](https://github.com/ethersh))

### Fixed

- Code file previews can be selected and copied on iOS ([#447](https://github.com/getpaseo/paseo/pull/447) by [@muzhi1991](https://github.com/muzhi1991))
- File preview no longer shows stale content when reopening the same file ([#411](https://github.com/getpaseo/paseo/pull/411) by [@muzhi1991](https://github.com/muzhi1991))
- File explorer reinitialises when the client reconnects after a page refresh ([#442](https://github.com/getpaseo/paseo/pull/442) by [@1996fanrui](https://github.com/1996fanrui))
- Generic ACP providers no longer receive duplicated command arguments ([#444](https://github.com/getpaseo/paseo/pull/444) by [@edvardchen](https://github.com/edvardchen))
- Workspace headers no longer show a branch icon for non-git workspaces
- Branch switcher layout is stable on mobile
- Model names no longer truncate mid-word in the picker rows
- Messages appear in the correct order after reconnecting on mobile
- Clearing agent attention no longer throws on timeout

## 0.1.56 - 2026-04-14

### Fixed

- Projects with empty git repositories (no commits yet) no longer crash the app on startup
- A single problematic project can no longer prevent the rest of your workspaces from loading

## 0.1.55 - 2026-04-14

### Added

- Provider profiles — define custom providers in your Paseo config that appear alongside built-ins. Override a built-in's binary, env, or models, or create entirely new providers. See the [configuration guide](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)
- ACP agent support — add any ACP-compatible agent to Paseo with `extends: "acp"` in your provider config. No code changes needed
- Choose provider and model when creating scheduled agents
- Max reasoning effort option for Opus 4.6 models
- Cmd+, (Ctrl+, on Windows/Linux) opens settings

### Improved

- Git operations are dramatically faster — workspace status, PR checks, and branch data all use a shared cached snapshot service instead of shelling out to git on every request. Running 20+ workspaces simultaneously is now smooth
- Windows support — the daemon and CLI run natively on Windows with proper shell quoting, executable resolution, and path handling
- iPad and tablet layouts work correctly across all screen sizes
- IME composition (Chinese, Japanese, Korean input) no longer submits prematurely when pressing Enter

### Fixed

- Creating a worktree no longer briefly flashes it as a standalone project before placing it under the correct repository
- Worktree creation spinner stays visible throughout the process instead of disappearing on mouse-out
- Workspace navigation updates correctly when switching between workspaces in the same project
- Desktop workspace header alignment and model selector no longer overflow on narrow windows
- Loading indicators are visible in light mode

## 0.1.54 - 2026-04-12

### Added

- Inline image previews in agent messages — screenshots and images generated by agents render directly in the conversation instead of showing as raw markdown links

### Improved

- Paseo tools are no longer injected into agents by default — opt in from Settings when you need agent-to-agent orchestration
- Agent provider and mode are now resolved server-side, so CLI commands like `paseo run` use consistent defaults without client-side lookups

### Fixed

- Shift+Enter now correctly inserts a newline in agent terminal input instead of submitting
- Windows: MCP configuration is no longer mangled when spawning Claude agents
- Branch ahead/behind count no longer errors for branches with no remote tracking branch

## 0.1.53 - 2026-04-12

### Added

- Agents get Paseo tools automatically — every new agent gets access to terminals, schedules, worktrees, and other agents through MCP. Toggle it off in Settings under "Inject Paseo tools"
- Git pull — pull remote changes directly from the workspace header. Promoted to the primary action when your branch is behind origin
- Child agent notifications — parent agents are automatically notified when a child agent finishes, errors, or needs permission approval
- Agent reload — `paseo agent reload` restarts an agent's underlying process from the CLI
- Middle-click to close tabs on desktop
- Keyboard shortcut to cycle themes

### Improved

- Unavailable git actions now explain why in a toast instead of being silently greyed out
- Streaming markdown on mobile renders significantly faster
- Sidebar, branch switcher, and agent panel no longer re-render unnecessarily — noticeable on large workspaces
- Paseo tool calls in agent timelines show the Paseo logo and human-readable names
- Relay and pairing URLs are stripped from daemon logs

### Fixed

- Closed agent tabs no longer reappear after reconnecting
- Desktop notification badge counts match across all workspaces
- Host switcher status syncs correctly when switching between hosts

## 0.1.52 - 2026-04-10

### Added

- Theme selector — choose from six themes including Midnight, Claude, and Ghostty dark variants
- Branch switching — switch git branches directly from the workspace header, with automatic stash and restore for uncommitted changes
- Auto-download updates — desktop updates download silently in the background so they're ready to install when you are

### Fixed

- Layout now responds correctly when resizing the window or rotating a tablet — previously the app could get stuck in mobile layout on a large screen
- Terminal no longer causes massive memory spikes from snapshot thrashing during heavy output
- Typing in the terminal works reliably — special keys, Ctrl combos, and paste are handled natively by the terminal emulator
- Initializing agents no longer show a loading spinner as if they're running
- Reconnecting to a running agent now works even when session persistence is unavailable
- Error screens on desktop are now scrollable
- Model list refreshes in the background when you open the model selector
- Draft agent feature preferences (like thinking mode) are remembered across sessions

## 0.1.51 - 2026-04-09

### Added

- Image attachments for OpenCode — attach screenshots and images to OpenCode agent prompts
- WebStorm — added to the "Open in editor" list alongside Cursor, VS Code, and Zed
- Send behavior setting — choose whether pressing Enter while an agent is running interrupts immediately or queues your message

### Fixed

- Model selector no longer crashes on iPad
- Pairing now uses the correct hostname, fixing connection failures on some network setups
- OpenCode agents show the correct terminal state and refresh models reliably
- Follow-up messages to agents that just finished a turn now work correctly
- Commands now load properly for Pi agents
- Internal debug output no longer appears in Claude agent timelines
- QR scan screen cleaned up with simpler visuals

## 0.1.50 - 2026-04-07

### Added

- Context window meter — see how much of the context window your agent has used, with color thresholds at 70% and 90%. Works with Claude Code, Codex, and OpenCode
- Open in editor — jump from any workspace straight into Cursor, VS Code, Zed, or your file manager. Paseo remembers your choice
- Side-by-side diffs — toggle between unified and split-column diff views, with a whitespace visibility option
- Spoken messages — when using voice mode, agent speech now appears as regular messages in the conversation instead of raw tool output
- Plan actions — plan cards now show the actions your agent supports (e.g. "Implement", "Deny") instead of generic accept/reject buttons
- Background git fetch — ahead/behind counts in the Changes pane stay up to date automatically

### Improved

- Workspaces load instantly on connect instead of waiting for a full sync
- File explorer and diff pane remember which folders are expanded when you switch tabs
- Closing a workspace tab is now instant
- Settings shows a Refresh button for providers and displays error details inline
- Reload agent moved away from the close button to prevent accidental taps

### Fixed

- Voice mode no longer drifts into false speech detection during long sessions
- Garbled overlapping text on plan cards
- Changes pane could show stale diffs when working with git worktrees
- Restarting an agent quickly could crash the session
- Copilot no longer pauses for permission prompts in autopilot mode
- Connection and pairing dialogs now display correctly on tablets
- Orchestration errors from agents are now surfaced instead of silently lost
- Diff stats no longer reset to zero when reconnecting

## 0.1.49 - 2026-04-07

### Fixed

- Models and providers now load reliably on first connect instead of requiring a manual refresh
- Model picker only shows models from the agent's own provider, not every provider on the server
- Model lists stay consistent regardless of which screen you open first

## 0.1.48 - 2026-04-05

### Added

- Provider diagnostics — tap a provider in Settings to see binary path, version, model count, and status at a glance. Helps troubleshoot why an agent type isn't available
- Provider snapshot system — daemon now pushes real-time provider availability and model lists to the app, replacing the old poll-based approach. Models and modes update live as providers come online or go offline
- Codex question handling — Codex agents can now ask the user questions mid-session (e.g. "which file?") and receive answers inline, matching the Claude Code question flow
- Reload tab action — right-click a workspace tab to reload its agent list without restarting the app

### Improved

- Model selector redesigned — grouped by provider with status badges, search, and better touch targets on mobile
- Enter key now submits question card answers and confirms dictation, matching the expected keyboard flow
- Removed noisy agent lifecycle toasts that fired on every state change

### Fixed

- Desktop app now resolves the user's full login shell environment at startup, fixing tools like `codex`, `node`, `bun`, and `direnv` not being found when Paseo is launched from Finder or Dock. Terminals spawned by Paseo now inherit the same PATH and environment variables as a normal terminal session. Approach adapted from VS Code's battle-tested shell environment resolution
- Input field on running agent screens now correctly receives keyboard focus
- Mobile model selector alignment and sizing

## 0.1.47 - 2026-04-05

### Fixed

- Voice TTS in Electron — sherpa now requests copied buffers and the voice MCP bridge sets `ELECTRON_RUN_AS_NODE`, preventing "external buffers not allowed" crashes
- QR pairing in desktop — CLI JSON output parsing now tolerates Node deprecation warnings in stdout
- STT segment race condition — segment ID and audio buffer are snapshotted before the async transcription call, so rapid commits no longer interleave
- Per-host "Add connection" button removed — it blocked multi-host setups by scoping new connections to a single server

## 0.1.46 - 2026-04-04

### Fixed

- Voice activation in packaged builds — Silero VAD model is now copied out of the Electron asar archive so native code can read it
- App version sent in probe client hello so the daemon's version gate no longer hides Pi/Copilot from reconnected sessions
- `worktreeRoot` schema made backward-compatible for old clients and daemons that don't send the field
- Punycode deprecation warning (DEP0040) suppressed in CLI and desktop daemon entrypoints

## 0.1.45 - 2026-04-04

### Added

- Pi (pi.dev) agent provider — connect Pi as a new agent type with thinking levels and tool call support
- Copilot agent provider re-enabled after ACP compatibility fixes
- `paseo .` and `paseo <path>` open the desktop app with the given project, similar to `code .`
- Provider-declared features system — providers can expose dynamic toggles and selects that the app renders automatically. First consumer: Codex fast mode
- Codex plan mode — start agents in plan-only mode with a dedicated plan card UI for reviewing proposed changes before execution
- OpenCode custom agents and slash commands — user-defined agents from opencode.json now appear in the mode picker, and slash commands accept optional arguments
- Desktop Integrations settings — install the Paseo CLI and orchestration skills directly from the app without touching the terminal
- Daemon status dialog in desktop settings for quick health checks
- Auto-restart daemon on version mismatch — the desktop app detects when the running daemon is outdated and restarts it automatically
- Setup hint and paseo.sh link on the mobile welcome screen so new App Store users know what to do next

### Improved

- Desktop startup is faster — existing daemon connections are raced against bootstrap so the app is usable sooner
- Settings sections reordered for better grouping (integrations and daemon together)
- Sidebar projects and workspaces now persist across sessions, with a context menu to remove projects

### Fixed

- Sidebar crash when switching iOS theme (Unistyles/Reanimated interaction)
- Silero VAD crash caused by external buffer mode in CircularBuffer
- Bulk close now correctly archives stored agents instead of leaving orphans
- Pinned archived agents are no longer pruned when closing tabs
- OpenCode event stream starvation during slash command execution
- Duplicate workspaces when multiple git worktrees share the same root
- `gh` executable resolution for desktop users whose login shell sets a different PATH
- Agent creation timeout increased to 60s to handle slow first-launch scenarios
- Forward-compatible provider handling so older app clients don't break on new provider types
- Input event listener race condition in the web scrollbar hook
- Open-project screen content now vertically centered
- Website download page fetches the release version at runtime with asset validation, fixing stale links

## 0.1.44 - 2026-04-03

### Fixed

- Desktop app now stops the daemon cleanly before auto-update restarts
- Disabled claude-acp and copilot providers from the agent registry
- Keyboard focus scope resolution now checks multiple candidates for broader compatibility
- OpenCode interrupt now reaches correct terminal state parity with tool-call flows
- Shell injection, symlink escape, and pairing endpoint security hardening

## 0.1.43 - 2026-04-02

### Added

- Copilot agent support via ACP base provider — connect GitHub Copilot as a new agent type
- Searchable model favorites — quickly find and pin preferred models
- Slash command support for OpenCode agents

### Improved

- Refined model selector UX with better mobile sheet behavior
- Workspace status now uses amber alert styling for "needs input" state
- Themed scrollbar on message input for consistent styling

### Fixed

- Ctrl+C/V copy and paste now works correctly in the terminal on Windows and Linux
- Shell arguments with spaces are now properly quoted on Windows
- Claude models with 1M context support are now correctly reported

## 0.1.42 - 2026-04-01

### Fixed

- Fixed Claude Code failing to launch on Windows when installed to a path with spaces (e.g. `C:\Program Files\...`)

## 0.1.41 - 2026-04-01

### Fixed

- Fixed agent spawning on Windows — all providers (Claude, Codex, OpenCode) now use shell mode so npm shims and `.cmd` wrappers resolve correctly
- Fixed terminal creation on Windows defaulting to a Unix shell instead of `cmd.exe`
- Fixed path handling across the app to support Windows drive-letter paths (`C:\...`) and UNC paths (`\\...`)
- Fixed executable resolution on Windows to work with `nvm4w` and similar Node version managers
- Eliminated white flash on window resize in dark mode by setting the native window background color to match the theme
- Fixed titlebar drag region — replaced the fragile pointer-event approach with VS Code's proven static CSS `app-region: drag` pattern
- Fixed context menu for copy/paste across the desktop app
- Fixed shortcut rebinding UI to show held modifier keys and recognize additional keys (Tab, Delete, Home, End, Page Up/Down, Insert, F1–F12)
- Removed the 40-item cap on activity timeline output so long agent sessions display their full history

### Improved

- Improved light mode theming with dedicated workspace background, scrollbar handle colors, and lighter shadows
- Window controls overlay on Windows/Linux reduced from 48px to 29px height for a more compact titlebar

## 0.1.40 - 2026-04-01

### Added

- Workspace tabs can now be closed in batches

### Improved

- Provider model lists are now cached per server and provider, reducing redundant model lookups in the UI

### Fixed

- OpenCode reasoning content no longer appears duplicated as assistant text
- Daemon no longer crashes when a Codex binary is missing or fails to spawn
- Archive tab now correctly reconciles agent visibility after archiving
- File diff tracking in workspaces now works correctly on Linux
- iPad layout now renders correctly in desktop mode
- macOS auto-updater now correctly delivers both arm64 and x64 binaries — previously whichever architecture finished building last would overwrite the other's update manifest

## 0.1.39 - 2026-03-30

### Added

- **Terminal management from the CLI** — new `paseo terminal` command group lets you list, create, and interact with workspace terminals without leaving your terminal
- **Material file icons in the explorer** — the file explorer tree now shows language-specific icons (TypeScript, JSON, Markdown, etc.) so you can spot files at a glance

### Fixed

- Fixed iOS sidebar scroll flicker caused by redundant overflow clipping
- Centralized window controls padding into a shared hook, eliminating layout inconsistencies across platforms

## 0.1.38 - 2026-03-30

### Fixed

- Fixed daemon startup race where the app could time out connecting on first launch because the PID file advertised a listen address before the server was ready
- Fixed daemon log rotation losing startup traces — trace-level WebSocket logs no longer include full message payloads

## 0.1.37 - 2026-03-29

### Added

- Custom window controls on Windows and Linux — the native titlebar is replaced with overlay controls that match the app's design
- Desktop file logging with electron-log for easier debugging of daemon and app issues

### Fixed

- Fixed broken PATH propagation and Claude binary resolution on Windows
- Dictation errors now show a visible toast instead of failing silently

## 0.1.36 - 2026-03-27

### Fixed

- Fixed Windows drive-letter path handling across the codebase
- Fixed stale Nix hash with automatic lockfile-change detection

### Added

- Added metrics collection and terminal performance tests

## 0.1.35 - 2026-03-26

### Improved

- Faster app startup by redirecting to the welcome screen immediately and showing host connection status inline
- Codex file deletions now display correctly as removed lines in diffs
- OpenCode questions are now surfaced in the permission UI

### Fixed

- Fixed queued prompt dispatch after idle transition
- Replaced bash-only `mapfile` with a portable `while-read` loop in the chat script

### Added

- Added support for Nix and NixOS installation

## 0.1.34 - 2026-03-25

### Added

- Added `paseo archive` as a top-level alias for `paseo agent archive`
- Added the `PASEO_AGENT_ID` environment variable for Claude and Codex agents
- Added a redesigned command autocomplete with a detail card and dropdown styling
- Linked Android download surfaces to the Google Play Store

### Improved

- Autonomous turns now complete gracefully on interrupt instead of being canceled
- Thinking/model selection now always resolves to a real option instead of showing a generic Default choice
- Restored per-provider form preferences and removed the Auto model fallback
- Improved Codex activity logs with clearer tool-call summaries
- Reduced unnecessary re-renders in the agent panel and input area for smoother interaction
- Improved chat transcript readability

### Fixed

- Fixed `paseo send --no-wait` not taking effect
- Fixed stale abort results contaminating replacement turns after an interrupt
- Fixed Claude interrupt handling and autonomous wake reliability
- Fixed nested Claude Code session detection and provider availability checks
- Fixed agent input focus scoping across panels
- Fixed terminal snapshot ordering when subscribing
- Fixed `chat read --since` to accept message IDs
- Fixed keyboard pane focus syncing with the active panel
- Fixed assistant text selection on web
- Fixed archived-agent notifications still appearing in chat rooms
- Fixed the attach-images button interaction in the message composer
- Pruned wrong-platform native binaries from Electron desktop builds

## 0.1.33 - 2026-03-23

### Fixed

- Fixed the desktop app failing to reopen after closing on macOS — the daemon and agent processes were registering with Launch Services as instances of the main app, blocking subsequent launches
- Fixed dictation not working in the packaged desktop app — the microphone entitlement was missing from the hardened runtime configuration
- Fixed leaked Claude Code child processes when agents were closed — the SDK query stream was not being properly shut down
- The notification test button now surfaces errors instead of failing silently

## 0.1.32 - 2026-03-23

### Added

- Fully rebindable keyboard shortcuts with chord support — all shortcuts are now declarative with proper Cmd (Mac) vs Ctrl (Windows/Linux) separation
- Migrated the desktop app from Tauri to Electron, with macOS notarization, code signing, and Linux Wayland support
- Added line numbers and word-wrap toggle to file previews
- Added an archived agent callout with an unarchive button so you can restore agents directly from the chat view
- Added workspace kind indicators in the sidebar (e.g. worktree vs standalone)
- Expanded diff syntax highlighting to cover more languages
- Added status bar tooltips for project and agent status

### Improved

- Redesigned the mobile tab switcher as a compact header row with quick access to new agents and terminals
- Streamlined workspace creation — worktrees are now created inline with a single action instead of a multi-step flow
- Agent history now streams from disk on reconnect, so you see past messages immediately instead of a blank screen
- Automatic cleanup of stale workspaces: deleted worktree directories and fully-archived workspaces are pruned automatically
- After archiving a workspace, the app now redirects to the next available workspace instead of leaving you on a dead screen
- Reopening an archived agent tab now keeps it open instead of collapsing back to archived state
- Reduced unnecessary re-renders across the workspace screen, sidebar, and agent list for smoother scrolling and interaction
- Agent list no longer refreshes in the background when the screen is unfocused, saving resources
- Desktop key repeat now works correctly on macOS
- Desktop notifications on macOS are more reliable
- Daemon startup no longer blocks on model downloads
- Better error messages from the daemon — RPC errors now include the actual underlying details

### Fixed

- Fixed user messages appearing as assistant output in the timeline when messages contained structured content blocks
- Fixed archived workspace routing so navigating to an archived session no longer breaks the app
- Fixed Linux AppImage failing to launch on Wayland-only desktops
- Fixed desktop window drag coordinates being applied when they shouldn't be

## 0.1.30 - 2026-03-19

### Added

- Added terminal tabs, split pane controls, and drop previews for workspace layouts
- Added a combined model selector and agent mode visuals across key UI surfaces
- Added Open Graph metadata improvements for richer website sharing previews

### Improved

- Improved workspace navigation with better active-workspace tracking and keyboard-driven pane interactions
- Improved terminal scrollbar behavior, pane focus handling, and status bar/message input spacing
- Improved project picker path display and general workspace UI polish

### Fixed

- Fixed agent startup reliability by tightening PATH resolution and surfacing missing provider binaries in status
- Fixed workspace route syncing, drag hit areas, and git diff panel header styling regressions
- Fixed website mobile horizontal scrolling and ensured the workspace audio module builds during EAS installs

## 0.1.28 - 2026-03-15

### Added

- Added OpenCode build and plan modes
- Added website landing pages for Claude Code, Codex, and OpenCode

### Improved

- Improved the git action menu for more reliable repository actions
- Improved the mobile settings screen, workspace header actions, and welcome screen presentation
- Updated the website hero copy and added a sponsor callout section

### Fixed

- Fixed assistant file links so they open the correct workspace files from chat

## 0.1.27 - 2026-03-13

### Added

- Added voice runtime with new audio engine architecture for voice interactions
- Added Grep tool support in Claude tool-call mapping
- Added ability to open workspace files directly from agent chat messages
- Added desktop notifications via a custom native bridge

### Improved

- Improved image picker, markdown rendering, and UI interactions
- Improved shell environment detection using shell-env

### Fixed

- Fixed platform-specific markdown link rendering
- Fixed Linux AppImage CLI resource paths
- Fixed Codex replacement stream being killed by stale turn notifications

## 0.1.26 - 2026-03-12

### Added

- Added single-instance desktop behavior, Android APK download access, and refreshed splash screen styling
- Added bundled Codex and OpenCode binaries in the server so setup no longer depends on global installs
- Added Windows support with improved cross-platform shell execution

### Improved

- Improved desktop runtime behavior on Windows by suppressing console windows and defaulting app data to `~/.paseo`
- Added a Discord link to the website navigation

### Fixed

- Fixed desktop Claude agent startup from the managed runtime and rotated logs correctly on restart
- Fixed the home route to hide browser chrome when appropriate
- Fixed Expo Metro compatibility by updating the `exclusionList` import
- Fixed noisy shell output interfering with executable lookup
- Fixed Windows resource-path handling by stripping the extended-length path prefix

## 0.1.25 - 2026-03-11

### Fixed

- Fixed desktop app failing to start the built-in daemon on fresh macOS installs. The DMG was not notarized and code-signing stripped entitlements from the bundled Node runtime, causing Gatekeeper to block execution
- Fixed Linux AppImage build by restoring the AppImage bundle format and stripping CUDA dependencies from onnxruntime

## 0.1.24 - 2026-03-10

### Improved

- Improved command center keyboard navigation and new tab shortcut
- Simplified desktop release pipeline for faster and more reliable builds

## 0.1.21 - 2026-03-10

### Improved

- Improved desktop release reliability by fixing the Windows managed-runtime build path during GitHub Actions releases

### Fixed

- Fixed a desktop release CI failure caused by a Unix-only server build script on Windows runners
- Fixed server CI to build the relay dependency before running tests, restoring relay E2EE test coverage on clean runners
- Fixed a Claude redesign test that depended on the local Claude CLI being installed

## 0.1.20 - 2026-03-10

### Added

- Added workspace sidebar git actions with quick diff stats and archive controls
- Added refreshed website downloads and homepage presentation for desktop installs

### Improved

- Desktop release packaging now rebuilds and validates the bundled managed runtime during CI, improving installer reliability for macOS users
- Improved desktop and web stream rendering, settings polish, and React 19.1.4 compatibility

### Fixed

- Fixed Claude interrupt/restart regressions and strengthened managed-daemon smoke coverage for desktop releases

## 0.1.19 - 2026-03-09

### Added

- Added a draft GitHub release flow so maintainers can upload and review desktop and Android release assets before publishing the final release

## 0.1.18 - 2026-03-06

### Added

- Added a desktop `Mod+W` shortcut to close the current tab

### Improved

- New and newly selected terminals now take focus automatically so you can type immediately
- Kept newly created workspaces and projects in a more stable order in the sidebar
- Improved project naming for GitHub remotes and expanded project icon discovery to Phoenix `priv/static` assets
- Updated the website desktop download link to use the universal macOS DMG

### Fixed

- Restored automatic agent metadata generation for Claude runs

## 0.1.17 - 2026-03-06

### Added

- New workspace-first navigation model with workspace tabs, file tabs, and sortable tab groups
- Keyboard shortcuts for workspace and tab navigation, with shortcut badges in the sidebar
- Workspace-level archive actions with improved worktree archiving flow and context menu support
- In-chat task notifications rendered as synthetic tool-call events for clearer status tracking

### Improved

- Desktop builds now ship as a universal macOS binary (Apple Silicon + Intel)
- More reliable workspace routing and tab identity handling across refreshes and deep links
- Better sidebar drag-and-drop behavior with explicit drag handles and nested list interactions
- Smoother terminal/file rendering and WebGL-backed terminal performance improvements
- Stronger provider error surfacing and updated Claude model/runtime handling

### Fixed

- Fixed orphan workspace runs caused by non-canonical tab routes
- Fixed mobile terminal tab remount/routing restore issues
- Fixed agent metadata title/branch update reliability
- Fixed stream/timeline ordering and cursor synchronization issues in the app
- Fixed reversed edge-wheel scroll behavior in chat/tool stream views

## 0.1.16 - 2026-02-22

### Added

- Update the Paseo desktop app and local daemon directly from Settings
- Microphone and notification permission controls in Settings
- Thinking/reasoning mode — agents can use extended thinking when the provider supports it
- Autonomous run mode — let agents keep working without manual approval at each step
- `paseo wait` now shows a snapshot of recent agent activity while you wait

### Improved

- Smoother streaming with less UI flicker and scroll jumping during long agent runs
- Faster agent sidebar list rendering
- Archiving an agent now stops it first instead of archiving a half-running session
- Agent titles no longer reset when refreshing
- More reliable relay connections

### Fixed

- Fixed Claude background tasks desyncing the chat
- Fixed duplicate user messages appearing in the timeline
- Fixed a startup crash caused by an OpenCode SDK update
- Fixed spurious "needs attention" notifications from background agent activity

## 0.1.15 - 2026-02-19

### Added

- Added a public changelog page on the website so users can browse release notes

### Improved

- Redesigned the website get-started experience into a clearer two-step flow
- Simplified website GitHub navigation and changelog headings
- Improved app draft/new-agent UX with clearer working directory placeholder and empty-state messaging
- Enabled drag interactions in previously unhandled areas on the desktop draft screen
- Hid empty filter groups in the left sidebar

### Fixed

- Fixed archived-agent navigation by redirecting archived agent routes to draft
- Fixed duplicate `/rewind` user-message behavior

## 0.1.14 - 2026-02-19

### Added

- Added Claude `/rewind` command support
- Added slash command access in the draft agent composer
- Added `@` workspace file autocomplete in chat prompts
- Added support for pasting images directly into prompt attachments
- Added optimistic image previews for pending user message attachments
- Added shared desktop/web overlay scroll handles, including file preview panes

### Improved

- Improved worktree flow after shipping, including better merged PR detection
- Improved draft workflow by enabling the explorer sidebar immediately after CWD selection
- Improved new worktree-agent defaults by prefilling CWD to the main repository
- Improved desktop command autocomplete behavior to match combobox interactions
- Improved git sync UX by simplifying sync labels and only showing Sync when a branch diverges from origin
- Improved desktop settings and permissions UX on desktop
- Improved scrollbar visibility, drag interactions, tracking, and animation timing on web/desktop

### Fixed

- Fixed worktree archive/setup lifecycle issues, including terminal cleanup and archive timing
- Fixed worktree path collisions by hashing CWD for collision-safe worktree roots
- Fixed terminal sizing when switching back to an agent session
- Fixed accidental terminal closure risk by adding confirmation for running shell commands
- Fixed archive loading-state consistency across the sidebar and agent screen
- Fixed autocomplete popover stability and workspace suggestion ranking
- Fixed dictation timeouts caused by dangling non-final segments
- Fixed server lock ownership when spawned as a child process by using parent PID ownership
- Fixed hidden directory leakage in server CWD suggestions
- Fixed agent attention notification payload consistency across providers
- Fixed daemon version badge visibility in settings when daemon version data is unavailable

## 0.1.9 - 2026-02-17

### Improved

- Unified structured-output generation through a single shared schema-validation and retry pipeline
- Reused provider availability checks for structured generation fallback selection
- Added structured generation waterfall ordering for internal metadata and git text generation: Claude Haiku, then Codex, then OpenCode

### Fixed

- Fixed CLI `run --output-schema` to use the shared structured-output path instead of ad-hoc JSON parsing
- Fixed `run --output-schema` failures where providers returned empty `lastMessage` by recovering from timeline assistant output
- Fixed internal commit message, pull request text, and agent metadata generation to follow one consistent structured pipeline

## 0.1.8 - 2026-02-17

### Added

- Added a cross-platform confirm dialog flow for daemon restarts

### Improved

- Simplified local speech bootstrap and daemon startup locking behavior
- Updated website hero copy to emphasize local execution

### Fixed

- Fixed stuck "send while running" recovery across app and server session handling
- Fixed Claude session identity preservation when reloading existing agents
- Fixed combobox option behavior and related interactions
- Fixed desktop file-drop listener cleanup to avoid uncaught unlisten errors
- Fixed web tool-detail wheel event routing at scroll edges

## 0.1.7 - 2026-02-16

### Added

- Improved agent workspace flows with better directory suggestions
- Added iOS TestFlight and Android app access request forms on the website

### Improved

- Unified daemon startup behavior between dev and CLI paths for more predictable local runs
- Improved website app download and update guidance

### Fixed

- Prevented an initial desktop combobox `0,0` position flash
- Fixed CLI version output issues
- Hardened server runtime loading for local speech dependencies

## 0.1.6 - 2026-02-16

### Notes

- No major visible product changes in this patch release

## 0.1.5 - 2026-02-16

### Added

- Added terminal reattach support and better worktree terminal handling
- Added global keyboard shortcut help in the app
- Added sidebar host filtering and improved agent workflow controls

### Improved

- Improved worktree setup visibility by streaming setup progress
- Improved terminal streaming reliability and lifecycle handling
- Preserved explorer tab state so context survives navigation better

## 0.1.4 - 2026-02-14

### Added

- Added voice capability status reporting in the client
- Added background local speech model downloads with runtime gating
- Added adaptive dictation finish timing based on server-provided budgets
- Added relay reconnect behavior with grace periods and branch suggestions

### Improved

- Improved connection selection and agent hydration reliability
- Improved timeline loading with cursor-based fetch behavior
- Improved first-run experience by bootstrapping a default localhost connection
- Improved inline code rendering by auto-linkifying URLs

### Fixed

- Fixed Linux checkout diff watch behavior to avoid recursive watches
- Fixed stale relay client timer behavior
- Fixed unnecessary git diff header auto-scroll on collapse

## 0.1.3 - 2026-02-12

### Added

- Added CLI onboarding command
- Added CLI `--output-schema` support for structured agent output
- Added CLI agent metadata update support for names and labels
- Added provider availability detection with normalization of legacy default model IDs

### Improved

- Improved file explorer refresh feedback and unresolved checkout fallback handling
- Added better voice interrupt handling with a speech-start grace period
- Improved CLI defaults to list all non-archived agents by default
- Improved website UX with clearer install CTA and privacy policy access

### Fixed

- Fixed dev runner entry issues and sherpa TTS initialization behavior

## 0.1.2 - 2026-02-11

### Notes

- No major visible product changes in this patch release

## 0.1.1 - 2026-02-11

### Added

- Initial `0.1.x` release line
