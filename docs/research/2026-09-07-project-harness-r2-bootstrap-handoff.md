# Bàn giao R2: native Project Harness bootstrap và transaction

Ngày 2026-09-07. Đây là historical tested-stable R2 C3 correction receipt cho Product workspace "wks_fe1f3cd9363bbd4e", project "prj_c9978c5a0d3d50db". Lead đã relayed R2 SOURCE/SCOPED-TEST ACCEPT sau receipt này: handoff final SHA-256 702448b18d58b52c51f41816b3b93e554242d9e1623860db4cf015e689161f44, 30-path manifest verified, Reviewer activity 4785 và source/check lease RELEASED. Beads issue/receipt ID lịch sử không phải grant của H5; activation và commit vẫn thuộc boundary Lead/Caller.

## Biên ownership

R2 sở hữu native server Project Harness, transaction/recovery utility, session dispatch, permission/feature wiring, protocol schema/message/export, provisioning target hook và correlated client transport/API. E1 vẫn sở hữu checkpoint/episode/catalog; C1 vẫn sở hữu CLI/app. Không có R2 edit trong các file E1, không có CLI/app reader trong các check dưới đây. R1 handoff là input frozen, SHA "90778796857fb136797976aeda07132c32d5af2212b48a9e7073690416fedd22".

Không commit, version, restart, activation, live canary hay migration vào project thật trong lease này. Foundation descriptor/resources dev25 vẫn là immutable source.

## ABI bốn operation đã pin cho C1

Các cặp wire name hiện hữu không đổi shape hoặc semantics trong N1:

- foundation.projectHarness.inspect.request / .response
- foundation.projectHarness.preview.request / .response
- foundation.projectHarness.apply.request / .response
- foundation.projectHarness.update.request / .response

Module public là @getpaseo/protocol/project-harness/rpc-schemas, với các schema ProjectHarnessInspectRequestSchema, ProjectHarnessInspectResponseSchema, ProjectHarnessPreviewRequestSchema, ProjectHarnessPreviewResponseSchema, ProjectHarnessApplyRequestSchema, ProjectHarnessApplyResponseSchema, ProjectHarnessUpdateRequestSchema, ProjectHarnessUpdateResponseSchema. Response payload dùng z.discriminatedUnion("ok", ...); relationship dùng z.discriminatedUnion("kind", ...), giữ nguyên wire shape.

Request dùng projectId, workspaceId và cwd tùy chọn. inspect trả inspection authoritative. preview nhận operation: bootstrap | update, trả inspection, guarded plan, changes và readyToApply. apply và update nhận plan có revision guards, trả operation, transactionId, changedPaths, inspection và recovery; lỗi là typed RPC error. Mỗi target được resolve từ registered project/workspace identity, không dùng filesystem artifact gần nhất.

Client thin paths:

- DaemonClient.inspectProjectHarness, .previewProjectHarness, .applyProjectHarness, .updateProjectHarness
- createPaseoApi(daemonClient).projects.harness.inspect, .preview, .apply, .update

Gate duy nhất là server_info.features.projectHarness === true; host thiếu capability nhận lỗi yêu cầu update. C1 có thể freeze và consume bốn operation này. N1 notebook RELEASE là surface additive được mô tả ở dưới; nó không đổi bốn bootstrap ABI và không cho phép direct metadata/grant bypass.

## Native contract cho C1/H5

Fresh hoặc brownfield onboarding compose native Workspace Protocol trước: nếu WORKSPACE_PROTOCOL.md thiếu, C1 dùng existing foundation.workspaceProtocol.write.request với registered project root và expected missing revision, read back regular revision, rồi mới gọi Project Harness inspect/preview. R2 không tạo template WP mới và không biến helper bootstrap thành onboarding completion.

preview(bootstrap) tạo diff cụ thể cho docs/harness/README.md, notebook mặc định hoặc custom identity, hai entrypoint khi hợp lệ, và .paseo/harness.json. Symlink hai chiều, regular file độc lập, bytes ngoài managed block, notebook history, custom supervisorNotebookIdentity, foreign marker/base/manifest và local delta đều được giữ theo inspection/guard. update chỉ quản lý payload/provenance đã ghi nhận; generation, descriptor/resource digest, entry-map hoặc managed block drift trở thành diff/conflict cần caller xử lý, không overwrite im lặng.

Foreign securecore manifest được đọc theo schema schema_version: 1, core_version: "0.1.7", files: [{path, upstream_sha256}]; toàn bộ 19 path, kể cả docs/README.md absent, được inventory và không nằm trong write plan. Không có foreign updater, ownership transfer hay restore đoán mò. AGENTS và communication section foreign được preserve; CLAUDE/payload độc lập có thể được quản lý khi route hợp lệ.

Transaction dùng lock theo real project root trong daemon process, persisted journal, stage/revision verification, expected-revision guards, changed-preserved checks và recovery fail-closed với journal corrupt/unsafe. Recovery không xóa bytes mới hơn hoặc file ngoài affected set. Giới hạn còn lại: cross-process lock ngoài một daemon process chưa có evidence trong lease này.

## N1: RELEASE → fresh role-first successor

Surface additive:

- foundation.projectHarness.notebook.release.request / .response
- schema ProjectHarnessNotebookReleaseRequestSchema, ProjectHarnessNotebookReleaseResponseSchema, ProjectHarnessNotebookReleaseResultSchema
- client low-level DaemonClient.releaseProjectHarnessNotebook
- public createPaseoApi(...).projects.harness.releaseNotebook

Session permission map yêu cầu authenticated workspace.manage; request chỉ mang expected selectors projectId, workspaceId, cwd, notebookId, location, designatedWriterId, expectedRevision. Không có callerAgentId để giả authority. Daemon resolve registered project/workspace/root, kiểm tra claim và configured identity, rồi dùng cùng metadata CAS transaction.

P1 C3 retracts admission-time-only safe-idle claim. Handler vẫn kiểm tra lifecycle ban đầu, nhưng truyền một server-internal synchronous `revalidate` vào cùng resolver/transaction. Sau async staging của mọi file/manifest, tạo parent directories và final file-CAS preflight, transaction gọi authoritative lifecycle/close-in-flight/`hasInFlightRun` guard ngay trước destructive rename đầu tiên. Giữa guard và mutation initiation không còn `await`; agent không tồn tại/unknown, close-in-flight, pending/in-flight run, initializing hoặc running đều làm RELEASE fail closed. Guard rejection giữ structured lifecycle error, chỉ cleanup staged transaction, và giữ nguyên claim/project bytes; không có lock/store/control plane mới. Positive queued wait khi agent vẫn idle và không có in-flight run vẫn RELEASE thành công.

RELEASE không tạo grant successor và không hot-swap rebind. Caller dùng native role-first create flow hiện có với role supervisor và notebook-grant request; role-binding path tự resolve immutable grant từ registered project/notebook. Focused native joined proof trong `agent-manager-harness-binding.test.ts` đi qua public `ProjectHarnessSession` release, real `AgentManager`, real resolver và captured catalogs: old writer bị từ chối `assertCurrent`/append sau RELEASE; fresh role-first successor giữ custom notebook identity, đọc catalog và append record; reader cũ đọc được history mới; writer conflict tiếp theo bị từ chối. Grantless reader vẫn đọc được. Internal legacy rebind không được expose thành public RPC.

Custom declarative repository config supervisorNotebookIdentity: { notebookId, location } là fixture input được hỗ trợ. Không seed writer/grant/receipt/runtime state vào fixture. Actual post-install release, fresh successor, catalog read/append và custom-config qualification thuộc Caller.

## RF4 visibility boundary

Native inspection hiện inventory bounded các root entrypoint, root AGENTS.override.md/CLAUDE.override.md, root và tối đa sáu ancestor CLAUDE.local.md, bounded nested CLAUDE.local.md, và project path .claude/CLAUDE.md; nested directory scan tối đa 16 directory. Mỗi path trả missing, regular, symlink hoặc unreadable, cùng readable và ownership unknown, foreign khi có foreign manifest evidence, hoặc outside-project cho ancestor. Tối đa 64 entries; phần bị cắt trả not_scanned sentinel với coverage unknown.

Theo Claude Code memory documentation (https://code.claude.com/docs/en/memory), CLAUDE.local.md là local instruction file và ./CLAUDE.md/./.claude/CLAUDE.md là project paths. CLAUDE.override.md và các .paseo/\* observation trong inspection chỉ là generic read-only additional-instruction observations; chúng không được trình bày như provider-supported override. Inventory không chứng minh provider loading, không nhận ownership updater và không ghi instruction file.

Caller calibration /tmp/paseo-harness-rollout-20260907/root-provider-instruction-presence.json (SHA 27329af0e184508584544c6cf720c5f4b0c516548c854b2f67eea0d241737313) là lstat-only, không content/mutation/provider-loading proof: 15 root paths của 5 registered projects đều missing. Test R2 dùng disposable fixtures để chứng minh choreography, không suy ra 5 project thật có override.

## Executed evidence

Các lệnh Vitest chạy tuần tự từ cwd `/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-foundation/.worktrees/paseo-product-upstream-v0.7/packages/server`:

- C3 failing-before counterexample: `npx vitest run --config vitest.config.ts src/server/session/project-harness/project-harness-session.test.ts --bail=1 -t "rejects a lifecycle change observed after staging and before the first rename"` — exit 1; 1 failed, 7 skipped. Release trả `ok:true` thay vì structured `notebook_release_lifecycle_active` khi lifecycle đổi trong staged window.
- C3 passing-after focused session: `npx vitest run --config vitest.config.ts src/server/session/project-harness/project-harness-session.test.ts --bail=1` — exit 0; 1 file, 8 tests PASS.
- C3 affected R2 group: `npx vitest run --config vitest.config.ts src/utils/project-harness-file-transaction.test.ts src/server/project/harness-binding-service.test.ts src/server/session/project-harness/project-harness-session.test.ts --bail=1` — exit 0; 3 files, 24 tests PASS. Bao gồm first-rename race fail-closed với claim/metadata byte preservation, idle positive và existing queued-wait negative cùng transaction/recovery/binding coverage.
- Historical C2 receipt giữ nguyên, không rerun: `npx vitest run --config vitest.config.ts src/utils/project-harness-file-transaction.test.ts src/server/project/harness-binding-service.test.ts src/server/session/project-harness/project-harness-session.test.ts src/server/agent/agent-manager-harness-binding.test.ts --bail=1` — 4 files, 30 tests PASS; joined public RELEASE → fresh role-first successor → catalog read/append và P2 permission evidence vẫn là reviewed input.
- Historical selected permission receipt, không rerun: `npx vitest run --config vitest.config.ts src/server/session.test.ts --bail=1 -t "project harness notebook release uses the authenticated permission boundary"` — 1 selected test PASS, 156 skipped.
- Các receipt cũ `3`, `9`, `83`, `14` và C2 `4 files/30 tests` là historical protocol-schema/binding-service/pre-C2 R2/session subsets; current C3 affected receipt là 3 files/24 tests, không dùng receipt cũ để thay thế counterexample mới.

Các lệnh npm/build chạy tuần tự từ cwd `/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-foundation/.worktrees/paseo-product-upstream-v0.7`:

- `npm run format:files -- packages/server/src/utils/project-harness-file-transaction.ts packages/server/src/server/project/harness-binding-service.ts packages/server/src/server/session/project-harness/project-harness-session.test.ts` — exit 0, 3 owned files formatted.
- `npm run lint -- packages/server/src/utils/project-harness-file-transaction.ts packages/server/src/server/project/harness-binding-service.ts packages/server/src/server/session/project-harness/project-harness-session.test.ts` — exit 0, 0 warnings/0 errors.
- `npm run typecheck --workspace=@getpaseo/server` — exit 0.
- Historical unchanged receipts, không rerun: `npm run build:client`, `npm run typecheck --workspace=@getpaseo/protocol`, `npm run typecheck --workspace=@getpaseo/client` — PASS; protocol/client declarations và AOT output đã rebuild trước đó.
- `npm run build:server` — exit 2 sau khi server build/lib/scripts PASS; lỗi chỉ tại frozen C1 CLI. Exact diagnostics: `packages/cli/src/commands/project/harness.ts:62:51, 68:51, 74:52, 80:52, 86:50` TS2345 (array/union output không assignable vào single result, gồm `ProjectHarnessReleaseOutput[] | ProjectHarnessReleaseOutput`), và `packages/cli/src/commands/project/index.ts:61:23, 73:23, 84:23, 95:23` TS2345 (handler/result mismatch, gồm unrelated duplicate `SingleResult`/`ListResult` declarations). R2 không sửa CLI.
- `npm run typecheck` — exit 2 tại cùng frozen C1 CLI diagnostics: package-relative `src/commands/project/harness.ts:62:51, 68:51, 74:52, 80:52, 86:50` và `src/commands/project/index.ts:61:23, 73:23, 84:23, 95:23`, TS2345; server và các workspace trước CLI PASS. Không rerun sau receipt này.

Không chạy full suite, không rerun unchanged green suites, không chạy thêm build:server/root typecheck/global CLI-app readers sau coordination boundary, không daemon restart/activation/live canary/real-project migration. Tại final readback không còn R2 check process hoặc child process.

## Final source manifest

SHA-256 dưới đây là manifest của 30 R2 source/test paths sau RF4 và C3 correction:

3fca31a3f991340ea66962081b95d01e4af1022f6d6f9e2236d541d547bbe786 packages/client/src/daemon-client.ts
f1e1483f2b8701d3367481d39a5e5e79ddf2e2b06177ed26b90d9f6f96e3735b packages/client/src/index.ts
7fca4bacf7e1f969eef805c711cb8370aceea26147ccfb5a0597cd031e3448ec packages/protocol/src/messages.ts
cfa797afce53164f1ec9438da55eb0e8cbeda9b02734541ac23a640ee40a1b83 packages/protocol/src/project-harness/rpc-schemas.ts
32fee43da67116b070d5b2e5188412acc15720e98cca0c39bd8b4fa6c09433fe packages/protocol/src/project-harness/rpc-schemas.test.ts
bc6714f5c5f66a09ca0159477a67e01311480fc775dd21178127600f751f5297 packages/server/src/server/agent/agent-manager-harness-binding.test.ts
4812fc9392688259ac2e0dafd2ab003d9a569cbcbc4a55221e5c3f712ef1f936 packages/server/src/server/authorization/operation-permissions.ts
2b1fa75d894fe3dc08969d75639dd24cc6152b61542eca2df8854bc5ea0c5567 packages/server/src/server/bootstrap.ts
df03a04c22e2eed13d6e969b168755c6f97215e6a69428f25874ee4519cce50c packages/server/src/server/policy/bundled/slp.ts
784a00b11b81f7d4c959c046ac78cdfc944a89448dbca9e9b07d0ddd4d1bbfc9 packages/server/src/server/policy/bundled/slp/harness-package-policy.ts
35f7979c32a548d0fd6f702fa09d833876bc9b78682039ed5373dde3770142af packages/server/src/server/policy/bundled/slp/harness-package-policy.test.ts
b5fc46797d0eecb656ae4fb14356692e1e826e867e46db9c1d7c63a53e4231b8 packages/server/src/server/project/harness-binding-service.ts
77f20deb1ff2e237612251bc094554b01bdbfea4c8a70b3f46bbe1a7aaa434d4 packages/server/src/server/project/harness-binding-service.test.ts
e34fcb090750b1785a32bad24af4807f3a163dba0c586eb748a4250f32b3f09a packages/server/src/server/project/harness-bootstrap-defaults.ts
f9d7222f029bb0c4e4dfffc195f35056d0a968644acf3b9a1275c063e3f80b83 packages/server/src/server/project/harness-project-metadata-file.ts
66bd5b36d959543deb79dd1b7891ad0cb187cadd2b173f16c4f24bee08d6492f packages/server/src/server/project/project-harness-service.ts
63d7ae30a6e95255d0e589b4bd63da3b713949c6020ce177b3067b1f8b4ca26a packages/server/src/server/project/project-harness-service.test.ts
5b504a63eadae64beff68ed56eef228fea1dab5d53121cc6ebef1671e75f40f3 packages/server/src/server/session.ts
a4f8adcea9f77c275ae83944531ae5fc74010f611e07fc954527d671dede4754 packages/server/src/server/session/project-harness/project-harness-session.ts
5fca7841e0157114676b5f8a420256ccf11813979393c4b7189447ad13d80359 packages/server/src/server/session/project-harness/project-harness-session.test.ts
9b2c3eeb7784b673156a37fb65fcc763e082422485d6c81b1662975bd11a82f1 packages/server/src/server/session/workspace-provisioning/workspace-provisioning-service.ts
99a451bfcec8d1b6deda18bec1e9af8c19bc7a6d921643b3d66edf4b855d4a77 packages/server/src/server/session/workspace-provisioning/workspace-provisioning-service.test.ts
45dacfed9ed40f198f8f73e4d52bcf7c39e810c7d2c57371d9a3364c39ac63a7 packages/server/src/server/session.test.ts
3d62cbec9c6044028857068ba257d0f41e7b67dc5bf2a5c7789131d61d5bde92 packages/server/src/server/websocket-server.ts
0a1173be541c149b34d338fd488bc9cd264307c606b7faa607e9136e72672c54 packages/server/src/utils/harness-entrypoint-inspect.ts
131d017f2cb6ee1a04a2a067b703f577b08392013a9d6095a0ed5849a1538478 packages/server/src/utils/harness-entrypoint-inspect.test.ts
1d3e4bfb39b0003b95045d4dafc8d747b38407601dd831f8df29b49287f0ca70 packages/server/src/utils/harness-template-render.ts
35e095a1253ee67bfd5b1e4dc484c98dde04b37c7c8392a83f642e67c20e2ff0 packages/server/src/utils/harness-template-render.test.ts
e0ed88ea43a8629eb86c284d7d7164c1b5088c24e66d16de505e3253d9bc7684 packages/server/src/utils/project-harness-file-transaction.ts
4e3c6284d0cc87e2c8957d5d21874576fb3856b24ede6edacd42ac9e6fbb6934 packages/server/src/utils/project-harness-file-transaction.test.ts

Manifest excludes inherited R1/E1/CLI/app bytes, Foundation imported bytes, root instruction files and this handoff doc itself. docs/README.md only receives the index row below.

## Remaining limits và handback state

- `npm run build:server` và root `npm run typecheck` trong C3 là receipt lịch sử; lúc đó exit 2 chỉ tại frozen C1 CLI diagnostics nêu trên, còn server build/typecheck PASS. Lead đã relayed C1 final coherent root build/typecheck PASS sau đó; không dùng receipt lịch sử này để phủ nhận verdict mới.
- Live daemon remains old .57, chưa restart/activation/canary. Source/test evidence không phải installed-runtime evidence.
- Five-project evidence trong test là disposable read-only fixtures; five actual migration previews và all outside-project writes thuộc Caller.
- Provider loading cho bounded instruction paths, CLAUDE.override.md và .paseo/\* vẫn UNKNOWN; ancestry sau sáu levels, nested coverage sau 16 directories hoặc 64 entries là UNKNOWN sentinel.
- Cross-process transaction exclusion chưa có evidence; current focused source evidence đã chứng minh public in-process RELEASE → fresh role-first successor → catalog read/append chain và C3 first-rename lifecycle guard, nhưng chưa phải post-install/live-daemon proof.
- Release owner cần reconcile COMPAT version floor với .57 live release trước final release.
- Native checkpoint hiện tại của agent `af1c8c72` trả `disposition=unknown` vì không có disposition source; do đó RELEASED ở đây là scoped source/test handback receipt đã ghi trên Beads, không phải runtime lifecycle hoặc acceptance claim. Lead-owned activity 2551 vẫn là idle evidence riêng cần re-read theo quy trình của Lead.

Sau Beads evidence update và process readback, R2 source/test lease được RELEASED với không có process in-flight. Lead review/acceptance/commit; C1 dùng bốn ABI đã pin và N1 additive release recipe ở trên. Self disposition vẫn UNKNOWN, không phải acceptance hay live-runtime claim.
