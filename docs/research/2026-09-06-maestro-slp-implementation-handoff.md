# Bàn giao triển khai Maestro SLP — `0.7.0-paseo.57`

Đây là sổ bằng chứng và bản chuẩn bị kích hoạt cho correction wave V3 của Product, kế thừa evidence V2;
nó không phải
engineering acceptance và cũng không phải receipt của bản phát hành đã cài.

## Ranh giới candidate

- Phiên bản Product: `0.7.0-paseo.57`.
- Worktree trong bản bàn giao này là source candidate. Không có release commit, tag, publish, install,
  daemon restart, remote mutation hoặc live canary nào được tuyên bố.
- Local release sau cùng phải dùng hai local commit sạch: commit feature/tests/docs/scripts/policy,
  sau đó là commit `CHANGELOG.md` + versions/locks đã đồng bộ + Nix metadata bị ảnh hưởng. Chỉ stage
  các path đã được duyệt; không dùng `git add -A` trên các path chưa xác định.
- Sau independent review và explicit commit grant của Lead, caller sở hữu `./scripts/local-stack.sh --apply`
  từ đúng clean release commit. Khả năng dirty-build không miễn trừ invariant clean commit.

## Các lớp bằng chứng

| Lớp                             | Trạng thái hiện tại                                                           | Điều được chứng minh                                                         |
| ------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Source và focused tests         | Các correction V2 và V3 bên dưới đã được tự quan sát; không chạy full suite   | Các path source được thực thi hoạt động trong checkout này                   |
| Build/typecheck/lint/format     | Build, typecheck, lint và targeted format đã chạy sạch; không chạy full suite | Workspace declarations và static checks sau khi rebuild owning packages      |
| Release artifact                | Đang chờ; chưa có clean commit                                                | Artifact bytes và provenance từ đúng release commit                          |
| Installed daemon/WebUI/Beads    | Không chạy trong wave này; review trước xác định daemon hiện hành là `.56`    | Không chứng minh điều gì về local runtime hiện tại                           |
| Provider route và role canaries | Đang chờ                                                                      | Receipt route mới, boundary Lead/Peer/Supervisor và Foundation qualification |
| Engineering acceptance          | Lead sở hữu và đang chờ                                                       | Acceptance cấp project, tách biệt với source/test evidence                   |

## Receipt focused V2

Các check được serialize từ `packages/server`, dùng `vitest.config.ts` hiện có và `--bail=1`.
Những failure đầu tiên chỉ nằm ở fixture đã được sửa rồi chạy lại; chúng không phải green receipt.

| Target của command                                        | Kết quả                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/server/policy/bundled/slp/role-profiles.test.ts`     | 2 passed, 0 failed/skipped, 193 ms                                                                     |
| `src/server/agent/tools/paseo-tools-checkpoint.test.ts`   | Initial UUID/temp-protocol fixture failures; final structural rerun 5 passed, 0 failed/skipped, 799 ms |
| `src/server/agent/tools/paseo-tools-non-slp.test.ts`      | Initial Beads ACL/UUID fixture failures; final rerun 2 passed, 0 failed/skipped, 934 ms                |
| `src/server/agent/agent-manager.lifecycle-policy.test.ts` | Initial launch-receipt/assertion fixture failures; corrected run 1 passed, 0 failed/skipped, 882 ms    |
| `src/server/agent/event-policy-runtime.test.ts`           | Final rerun 4 passed, 0 failed/skipped, 220 ms                                                         |
| `src/server/agent/finish-notification.test.ts`            | Final rerun 21 passed, 0 failed/skipped, 2.39 s                                                        |
| `src/server/policy/bundled-policy-pack.test.ts`           | Final authoritative rerun 11 passed, 0 failed/skipped, 570 ms                                          |
| `src/server/policy/bundled/slp/attention-policy.test.ts`  | 22 passed, 0 failed/skipped, 2.07 s                                                                    |
| `src/server/agent/tools/paseo-tools-room.test.ts`         | 17 passed, 0 failed/skipped, 974 ms                                                                    |
| `scripts/maestro-slp-live-canary.test.mjs`                | 3 passed, 0 failed/cancelled/skips, 34.1 ms                                                            |

## Receipt focused V3

V3 chỉ chạy các file bị ảnh hưởng trực tiếp, tuần tự từ `packages/server`, dùng `vitest.config.ts`
hiện có và `--bail=1`; không rerun các file xanh không bị thay đổi.

| Target của command                                         | Kết quả                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/agent/agent-manager.assignment-expiry.test.ts` | 1 passed, 0 failed/skipped, 835 ms; resume thực, mode preparation thực, provider start count = 0                                                                                                                                                                         |
| `src/server/agent/finish-notification.test.ts`             | Initial V3 run: 22 passed, 0 failed, 0 skipped, 2.60 s; after complexity-only dispatch-classifier refactor, rerun: 22 passed, 0 failed, 0 skipped, exit 0, 2.47 s; late-boundary expiry được ghi drop, không retry                                                       |
| `src/server/agent/agent-prompt.test.ts`                    | 6 passed, 0 failed/skipped, 702 ms                                                                                                                                                                                                                                       |
| `src/server/agent/role-binding.test.ts`                    | First run: 22 passed, 1 failed, 0 skipped, exit 1, 427 ms; direct current-feature mismatch: the test expected 34 Lead tools while G3 adds `get_agent_checkpoint`, making the exact default inventory 35. Corrected rerun: 23 passed, 0 failed, 0 skipped, exit 0, 312 ms |

Regression manager dùng `AgentManager` production với role-bound launch, đóng agent rồi resume qua
loader thật, giữ `setMode` trước khi provider entry, đưa clock qua `expiresAt`, rồi release. Boundary
đọc persisted launch binding mới nhất và chặn trước `session.startTurn`; finish delivery chờ cùng
boundary và chuyển lỗi `assignment_contract_expired` thành `caller-assignment-expired-at-start` với
`attempts = 0`. The first role-binding failure is not classified as unrelated or pre-existing: it is a
direct current-feature expectation mismatch caused by G3 adding `get_agent_checkpoint` to the Lead
ceiling. The permitted correction pins the exact 35-tool Lead inventory and retains all narrowing and
negative-boundary assertions; the first failed run remains failure evidence, not a pass.

V3 static receipts: `npm run build:server` passed after regenerating protocol validators and rebuilding
the owning client/dependency, server, and CLI stack. `npm run typecheck:server` passed; after the final
server-only complexity refactor, `npm run typecheck --workspace=@getpaseo/server` also passed. The first
targeted `npm run lint --` command failed only on `deliverPendingFinishNotifications` complexity `21`
versus the limit `20`; extracting the dispatch-drop classifier fixed that concrete issue. The affected
`finish-notification.test.ts` rerun then passed `22/22`, and the final targeted lint pass reported `0`
warnings and `0` errors across `7` files. Targeted `npm run format:files` runs completed successfully;
`git diff --check` is clean. No full suite or unchanged green suite was rerun.

## Receipt focused V4

V4 sửa classification expiry trong finish-notification delivery. Tiền tố
`assignment_contract_expired` không còn là bằng chứng thẩm quyền: nó nhiều nhất chỉ kích hoạt một lần
đọc mới record canon của caller. Nếu assignment canon vẫn còn hiệu lực, không khả dụng, không đọc được
hoặc bị thu hồi, lỗi sẽ theo đường đi thông thường `markFailed`/retry; nó không bao giờ trở thành drop.
Chỉ một lần đọc mới cho thấy caller đang hoạt động và assignment thực sự đã hết hạn mới cho phép drop
`caller-assignment-expired-at-start` với `attempts = 0`.

| Đích của lệnh                                  | Kết quả                                        |
| ---------------------------------------------- | ---------------------------------------------- |
| `src/server/agent/finish-notification.test.ts` | 23 passed, 0 failed, 0 skipped, exit 0, 2.51 s |

Regression âm giữ `expiresAt=2099-01-01T00:00:00.000Z` và cùng prefix lỗi provider: record canon vẫn
còn hiệu lực, delivery vẫn pending với một lần thử thất bại, không nhận `attempts = 0` hoặc `droppedAt`.
Regression dương làm record canon hết hạn sau lần đọc pre-send nhưng trước start failure; lần đọc mới
tạo drop tường minh với `attempts = 0`. Regression AgentManager load/mode/start thực của V3 được giữ
nguyên và không rerun.

Receipt kiểm tra tĩnh V4: `npm run build --workspace=@getpaseo/server`,
`npm run typecheck --workspace=@getpaseo/server`, `npm run lint --` có mục tiêu cho hai file server đã
đổi, `npm run format:files` có mục tiêu và `git diff --check` đều pass. Không chạy full suite hoặc test
V3 không đổi.

V2 có hai loại failure đã được sửa và ghi riêng: build đầu tiên dừng ở `TS2339` vì chưa narrow
`PolicyOwner` cho `legacy-core`; build tiếp theo hoàn tất owning stack. Full lint đầu tiên phát hiện
12 lỗi cụ thể (promise return, nested ternary, complexity, unused imports và map spread); sau refactor
bounded, full lint cuối cùng là 0 warning/0 error. `./scripts/update-nix.sh --check` không tạo receipt
pass: nó dừng ở prefetch vì môi trường thiếu executable `nix` (`nix: command not found`), nên
`nix/npm-deps.hash` không được sửa.

SLP artifact receipt từ server build: bundled policy version `1.4.0`; canonical generation digest
`c678356acbce903191473e46d4f9a7fe575d84ebb50c72008548c0d20a5ca826`. Các component semantic hiện pin
`ROLE_PROFILE_POLICY_VERSION=2`, `SLP_COUNCIL_POLICY_VERSION=3`, `SLP_COORDINATION_POLICY_VERSION=5`,
`SLP_ATTENTION_POLICY_VERSION=6`, `SLP_CHECKPOINT_POLICY_VERSION=3`,
`SLP_LIFECYCLE_ATTENTION_POLICY_VERSION=2` và `SLP_FINISH_NOTIFICATION_POLICY_VERSION=2`; artifact
identity này khác các digest lịch sử và không thay thế pinned-generation fail-closed behavior.

V1 CPU-bound finish-notification loop vẫn là một lần thử ABORTED, không bao giờ là pass: source review
của caller Codex/Astra đã chỉ ra non-terminating path; Lead safe-stop ruling mới cho phép dừng đúng process
đó. Exact execution session là `13299`, PID chain `5759 -> 5778 -> 5780`, process do Owner quản lý thoát
với `130` sau Ctrl-C. Không có broad kill hoặc daemon restart. Caller Codex/Astra là nguồn chẩn đoán;
Lead safe-stop ruling là nguồn cấp quyền dừng; đây không phải Human source diagnosis. Corrected bounded
re-entry regression thuộc V1 receipt trước đó; process history của nó không biến lần ABORTED thành green evidence.

## Ma trận G1–G5

| Mục tiêu                  | Ranh giới source đã triển khai                                                                                                                                                                                                                                                                                                                                                                                                                      | Giới hạn còn lại                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 durable delivery       | Watch intent được persist trước dispatch; observed run identity được capture; caller ledger tách terminal delivery khỏi permission-only records; expiry được kiểm tra lại tại shared provider-start boundary sau load/mode preparation; expiry tại boundary tạo explicit nonretry drop; canonical Council projection được truyền ở các call site create, prompt và bootstrap recovery; observed-run write không đổi không phát notification đệ quy. | Crash window vẫn có thể để execution/read/acceptance ở trạng thái không biết hoặc cho phép duplicate sau provider acceptance nhưng trước durable mark; không tuyên bố exactly-once. Provider route live và restart receipt vẫn chờ. |
| G2 Council                | Omitted tier/roles, explicit tier defaults và roles-only compatibility thuộc policy. Partial role input vẫn parse-compatible nhưng không tạo required-method coverage; khi required returned handback bị thiếu, Lead phải ghi explicit `DEGRADED` disposition; runtime không tự phân loại, và canonical Lead decision packet mới có authority.                                                                                                      | Maximum phase của Council case store không phải sufficiency gate. Source acceptance và saved-case compatibility vẫn cần Lead review; không thêm Council acceptance gate mới.                                                        |
| G3 checkpoint             | `get_agent_checkpoint` là production catalog entrypoint. Nó ground caller/target records, relationship và pinned owner, role tool ceiling, current Beads status checkpoint, canonical Council seats, exact target-bound issue grants và pure SLP checkpoint policy. Evidence thiếu/unavailable trả `UNKNOWN` hoặc fail-closed; không suy diễn idle-done/taskgraph/acceptance.                                                                       | Không tuyên bố live RPC/provider journey hoặc project acceptance. Full dependency counts vẫn `UNKNOWN` nếu không có complete target-bound dependency read.                                                                          |
| G4 lifecycle attention    | Generic runtime dùng declared subscriptions và stopped-generation queue guards; teardown chờ held lanes. AgentManager phát closure evidence trước khi xóa, kèm owner/run đã capture; closed snapshot giữ null turn fields. Có positive manager thực và negative ordinary close/cancel.                                                                                                                                                              | Installed/live behavior sau activation và observation window vận hành vẫn chờ. Policy không được suy lost run chỉ từ lifecycle.                                                                                                     |
| G5 trusted replaceability | Generic host nhận trusted internal contributions. SLP selection là trusted composition, không phải hard-coded active plugin default hoặc test-only fallback. Non-SLP fixture đi qua real AgentManager launch/catalog admission, native instruction/tool path, state và event delivery. Historical/pinned SLP generation unavailable thì fail closed.                                                                                                | Không sửa Foundation hoặc generated Foundation bytes. Provider-native canary và post-activation fingerprint readback vẫn chờ.                                                                                                       |

## Giới hạn vận hành G4

Pending permission không có timer/watchdog độc lập. Ngưỡng 120 giây của lifecycle attention chỉ được
đánh giá lại khi có stream event tiếp theo; permission hoàn toàn im lặng vì vậy không tự escalation.
Enqueue failure và delivery retry không phải timer-backed guarantee cho policy attention. Đây là giới hạn
vận hành đã biết, không phải cam kết phát hiện stall.

## Continuity của research Foundation chỉ đọc

Xia report được giữ có chủ ý trong Foundation checkout và không copy vào Product:

`/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-foundation/docs/research/2026-09-06-maestro-slp-adoption-xia-deep.md`

Các probe kề bên:

- `/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-foundation/docs/research/2026-09-06-maestro-slp-probes.mjs`
- `/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-foundation/docs/research/2026-09-06-maestro-slp-probes.json`

Các file này vẫn là read-only continuity evidence. Product source không khẳng định report bị thiếu.

## Bàn giao local release và activation

Sau independent V2 review và explicit commit grant của Lead:

1. Stage đúng các path feature/tests/docs/scripts/policy đã review và tạo feature commit.
2. Chỉ chạy `npm run version:sync-internal` cho release metadata `.57` đã được duyệt; stage
   `CHANGELOG.md`, package manifests/lockfiles và `nix/npm-deps.hash` nếu
   `./scripts/update-nix.sh --check` chứng minh hash đã stale; sau đó tạo release commit riêng.
3. Xác minh release commit chính xác là clean trước khi build artifact:

   ```bash
   git status --porcelain=v1
   git rev-parse HEAD
   git show --format=fuller --stat --summary HEAD
   ./scripts/local-stack.sh
   ```

   `git status` phải rỗng. `local-stack.sh` báo daemon/source identity và scoped runtime fingerprint;
   không dùng semver thay cho fingerprint.

4. Chỉ caller thực hiện activation có idle gate từ clean commit đó:

   ```bash
   ./scripts/local-stack.sh --apply
   ./scripts/local-stack.sh
   paseo --version
   paseo-foundation --version
   paseo daemon status --json
   curl -fsS http://127.0.0.1:6767/api/health
   curl -fsS http://127.0.0.1:6767/
   curl -fsS http://127.0.0.1:6769/health/ready
   paseo-foundation doctor --json --project /absolute/path/to/project
   paseo-foundation doctor --json --role-canary /absolute/path/to/role-boundary-canary.json --project /absolute/path/to/project
   ```

   Readback phải nhận diện exact release source commit, clean source/runtime fingerprint, các version
   Product/CLI/Foundation khớp nhau, artifact provenance, daemon healthy, WebUI thành công và Beads Central
   reachable. Sau daemon identity hoặc source change, provider và role receipt cũ đều stale. Native canary
   không thay thế custom audit-route qualification. Trước tiên chạy preliminary Foundation doctor để chẩn
   đoán prerequisite; doctor này không tạo acceptance hay PASS giả. Sau đó caller dùng lease mới để lấy
   provider-route và Lead/Peer/Supervisor execution evidence thật, validate/install receipt đó, rồi chạy
   final Foundation doctor với `--role-canary` để kiểm tra receipt. Không script nào được tự tạo hoặc ghi
   role canary để thỏa mãn gate của chính nó. Doctor exit 0 cũng không có nghĩa mọi gate đều PASS; phải báo
   từng gate thực tế. Audit-route qualification hiện vẫn `UNKNOWN` và mọi thay đổi configuration/qualifier
   cần một quyết định Human mới.

Replay và readback scripts là inert nếu không được gọi rõ ràng như sau:

```bash
node scripts/maestro-slp-replay.mjs --help
node scripts/maestro-slp-replay.mjs --case /absolute/path/to/replay-case.json --output /absolute/path/to/replay-plan.json
node scripts/maestro-slp-live-canary.mjs --help
node scripts/maestro-slp-live-canary.mjs --execute --project /absolute/path/to/project --role-canary /absolute/path/to/role-boundary-canary.json --output /absolute/path/to/live-readback.json
```

Replay command chỉ validate fixture và phát no-network plan; live-canary command chỉ là localhost/CLI
readback khi có `--execute`, không chạy provider/role và không ghi role receipt. Các URL override bị giới
hạn ở `http`/`https` loopback không credential, và redirect bị từ chối. Provider execution/read/acceptance
và engineering acceptance vẫn là các receipt riêng biệt. Preliminary doctor chỉ chẩn đoán; role canary thật
phải được lấy trước khi dùng `--role-canary` cho final doctor.

Nix là một distribution channel riêng: môi trường thiếu `nix` khiến `./scripts/update-nix.sh --check`
không có pass receipt nhưng không tự là blocker của local macOS artifact path; candidate này không tuyên
bố Nix distribution. `.57` vẫn chưa được cài và các provider/live canary, artifact provenance từ clean
commit, activation readback cùng engineering acceptance vẫn đang chờ caller/Lead.
