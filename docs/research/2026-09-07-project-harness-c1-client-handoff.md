# Bàn giao C1 client: qualification visibility và Project Harness onboarding

## Trạng thái, authority và giới hạn

C1 đã nhận SOURCE-GO consumer sau receipt R2 native `handoff9c6569209ba9b99bbd057d92774e73a16585d535d6fbdcde7bd22d1996eaef75` (R2 source/test lease đã release, native idle, 29/29 hash được Lead kiểm tra) và receipt N1 release ABI. N1 signature hiện là frozen candidate cho consumer dependency; điều này không phải engineering ACCEPT hay installed qualification.

Self runtime: `PASEO_AGENT_ID=8ccfe339-d083-4ac0-bd19-f01b27d8eb8c`. Beads Central đã trả `available=true`, version `1.2.0`; issue `psd02596e8eb-oz4` đã được claim và giữ `in_progress`, assignee là self. Assignment digest: `ed80455bc4919defbad633cbc6cf9c016b6414dfeb93995e4f57a8e9a6e0bb86`.

Tại thời điểm viết receipt, candidate này chưa self-accept, chưa close issue, chưa commit, chưa activation/daemon restart/live canary. Lead đã relayed C1 final SOURCE/TEST ACCEPT sau đó: handoff SHA-256 fdabde09d1f900001aa1815104bb91d81090f4273539026011b8491e3b3e14cd, 25/25 manifest verified, Reviewer activity 5513 ACCEPT, focused 2 file/16 test PASS, root build:server và typecheck PASS. Activation, migration và live qualification vẫn thuộc Caller.

## ABI consumer đã pin

C1 chỉ gọi các native method/schema đã được receipt xác nhận, không sửa protocol/client/server:

| Operation                                    | Native consumer                   | Semantics được giữ                                                                                                       |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `foundation.projectHarness.inspect`          | CLI inspect, Project Settings     | read-only inspection; target là `projectId + workspaceId + cwd?`                                                         |
| `foundation.projectHarness.preview`          | CLI preview, UI preview           | `bootstrap / update`; trả inspection, guarded plan, concrete changes và `readyToApply`                                   |
| `foundation.projectHarness.apply/update`     | CLI apply/update, UI apply/update | nhận đúng guarded plan; trả mutation result, transaction, changed paths, inspection và recovery                          |
| `foundation.projectHarness.notebook.release` | CLI release, UI explicit release  | nhận current notebook selectors + full `expectedRevision`; trả release result và `nextStep: fresh_supervisor_role_first` |

Schema release dùng `ProjectHarnessNotebookReleaseRequestSchema`, `ProjectHarnessNotebookReleaseResponseSchema`, `ProjectHarnessNotebookReleaseResultSchema` từ `@getpaseo/protocol/project-harness/rpc-schemas`. Client methods là `DaemonClient.releaseProjectHarnessNotebook` và public `createPaseoApi(...).projects.harness.releaseNotebook`. Bốn bootstrap operations không thay đổi.

Tất cả consumer giữ một gate `server_info.features.projectHarness === true`; host cũ nhận lỗi update-host hiện hữu, không có fallback giả lập feature. Authority release vẫn là authenticated `workspace.manage`; CLI/UI chỉ gửi explicit operator intent với selectors đọc từ inspection hiện tại. Không có direct metadata write, fake grant, callerAgentId-as-authority, auto-release, archive/hot-rebind fallback hoặc tự tuyên bố safe-idle.

## CLI Project Harness

Các lệnh mới nằm dưới `paseo project harness` và luôn yêu cầu workspace đã đăng ký. `--cwd` chỉ là target selector tùy chọn; không tự chọn active workspace/ancestor gần nhất.

```text
paseo project harness inspect <project-id> \
  --workspace <workspace-id> [--cwd <path>]

paseo project harness preview <project-id> bootstrap|update \
  --workspace <workspace-id> [--cwd <path>]

paseo project harness apply <project-id> \
  --workspace <workspace-id> --plan-file <preview.json> [--cwd <path>]

paseo project harness update <project-id> \
  --workspace <workspace-id> --plan-file <preview.json> [--cwd <path>]
```

`apply` và `update` chỉ nhận plan đã được schema guard; `--plan-file` có thể là raw plan hoặc JSON preview envelope `{ok:true,plan}`. Sau mutation thành công, CLI bắt buộc fresh inspect readback và hiển thị inspection mới, không gọi marker `READY` thay cho evidence.

Native roundtrip tạo file thật (JSON lỗi đi ra stderr và exit `1`):

```text
paseo project harness inspect <project-id> --workspace <workspace-id> --json > inspect.json
paseo project harness preview <project-id> bootstrap --workspace <workspace-id> --json > preview.json
paseo project harness apply <project-id> --workspace <workspace-id> \
  --plan-file preview.json --json > apply.json
```

`inspect.json` là input hợp lệ cho `--expected-revision-file`; `preview.json` là input hợp lệ cho `--plan-file`. Mỗi lệnh dùng đúng registered project/workspace target và không tự tạo file harness.

### Native project/workspace onboarding và Supervisor target

Đăng ký project và tạo workspace bằng các lệnh native; lấy đúng các ID từ JSON trả về, không suy ra workspace từ path hoặc active workspace:

```text
paseo project create /path/to/project --json > project.json
PROJECT_ID="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).projectId)' project.json)"

paseo workspace create --isolation local --path /path/to/project \
  --project "$PROJECT_ID" --json > workspace.json
WORKSPACE_ID="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).workspaceId)' workspace.json)"
```

Mọi lệnh harness và role tiếp theo phải dùng `--workspace "$WORKSPACE_ID"` (ID vừa trả về). Ví dụ Supervisor mới, có grant append được daemon cấp theo role và expiry ISO tương lai được tạo động, là:

```text
GRANT_EXPIRES_AT="$(node -e 'process.stdout.write(new Date(Date.now()+3600000).toISOString())')"
paseo agent run --workspace "$WORKSPACE_ID" --role supervisor --assignment-effect read-only \
  --notebook-grant-scope "append evidence" \
  --notebook-grant-expires-at "$GRANT_EXPIRES_AT" \
  --provider codex "Observe the assigned project and record bounded evidence"
```

`--workspace` ở đây là exact registered workspace ID, không phải project path; Node tạo timestamp ISO bằng cùng recipe trên mọi nền tảng có Node. Server tự derive notebook identity/location/writer, nên caller không truyền hoặc giả lập các receipt field đó.

### Release/handback recipe

Lệnh release nhỏ nhất dùng đúng receipt N1:

```text
paseo project harness release <project-id> \
  --workspace <workspace-id> [--cwd <path>] \
  --notebook-id <notebook-id> \
  --location <notebook-location> \
  --designated-writer-id <agent-id> \
  --expected-revision-file <revision-or-inspect.json>
```

Ba identity selector phải được copy từ fresh Project Harness inspection. `--expected-revision-file` nhận `ProjectHarnessFileRevision` nguyên vẹn hoặc inspect JSON có `inspection.metadata.revision`; CLI không phát minh revision. Daemon trả `releasedWriterId`, `metadataRevision` và `nextStep`, sau đó CLI thực hiện fresh inspect readback và hiển thị lỗi readback nếu có. Nếu inspection không có supervisor notebook hiện tại, recipe không tự release và UI báo unavailable.

Successor recipe là role-first: dùng CLI Supervisor grant/create hiện hữu với assignment notebook grant hợp lệ, rồi dùng native notebook read/CAS/append thực tế. Receipt cũ không được sửa, tái sử dụng hoặc seed vào runtime; C1 không tạo host RPC để impersonate agent đọc/append.

Ví dụ grant expiry phải được tạo động trong tương lai, không dùng timestamp đã hết hạn:

```text
GRANT_EXPIRES_AT="$(node -e 'process.stdout.write(new Date(Date.now()+3600000).toISOString())')"
paseo agent run --workspace <exact-workspace-id> --role supervisor --assignment-effect read-only \
  --notebook-grant-scope "append evidence" \
  --notebook-grant-expires-at "$GRANT_EXPIRES_AT" \
  --provider codex "Observe the assigned project and record bounded evidence"
```

Release readback dùng revision vừa đọc từ đúng target:

```text
paseo project harness inspect <project-id> --workspace <workspace-id> --json > release-inspect.json
paseo project harness release <project-id> --workspace <workspace-id> \
  --notebook-id <notebook-id> --location <notebook-location> \
  --designated-writer-id <agent-id> \
  --expected-revision-file release-inspect.json --json > release.json
```

`release.json` giữ release result cùng fresh inspection readback; nếu release đã commit nhưng readback lỗi, CLI exit `1` và JSON stderr giữ completed receipt cùng hướng dẫn inspect/reload.

CLI inspect trước đó vẫn project receipt hiện hữu: policy owner/generation, harness package/generation/artifact/descriptor/resources, project/workspace roots/cwd, Supervisor notebook identity và assignment `notebookGrant` riêng biệt. Legacy absence giữ `null`, không đoán generation hiện tại; binding delivery không được trình bày như provider policy đã exercised. CLI run vẫn dùng cặp `--notebook-grant-scope` + `--notebook-grant-expires-at`, server derive mọi identity và không mở rộng provider filesystem/external-effect boundary.

## Project Settings và material admission

`ProjectHarnessSettings` được compose ngay sau `WorkspaceProtocolSettings` trong existing Project Settings flow, không thêm route/startup routing. UI lặp qua từng `selectedHost.workspaces` đã đăng ký bằng exact workspace id; không active-workspace guess, nearest-ancestor lookup hay second filesystem inspector.

Mỗi workspace hiển thị:

- inspection relationship, provenance package/generation/artifact, metadata và recovery;
- foreign ownership, local delta, unresolved entries, instruction coverage và `unknown` coverage;
- preview concrete changes/diff và đúng `readyToApply` từ daemon;
- apply/update theo guarded plan rồi fresh inspect readback;
- explicit `Release current writer` chỉ khi inspection có notebook id/location/designated writer/revision, sau đó hiển thị release result và fresh readback.

Host không có capability chỉ hiển thị hướng dẫn update. UI không tự suy ra readiness từ marker, không edit metadata trực tiếp, không quản lý repo-owned `AGENTS` foreign delta và không auto bootstrap/release. Existing WP editor/CAS remains the material setup surface; foreign/local conflict và recovery vẫn do native daemon receipt quyết định.

Role-create admission giữ countercase đã pin: role read-only (`no-write` + `denied`, không notebook grant) được đi tiếp khi WP thiếu; assignment material/protected mutation vẫn route tới native WP setup/Project Settings. Hai caller hiện hữu `workspace-setup-dialog.tsx` và `composer/draft/workspace-tab.tsx` truyền assignment intent; không có universal bootstrap-ready gate và không có repo write trong admission/inspect.

Onboarding production recipe: `paseo project create <path>`/existing project registration tạo target; role read-only không tự bị chặn bởi WP thiếu. Với material assignment, admission tự route operator tới Project Settings; existing Workspace Protocol editor/CAS là bước operator để đặt baseline, không phải automatic repo write. Sau baseline, operator chạy `inspect` rồi `preview bootstrap`; chỉ khi diff/guards được xem xét mới chạy `apply` với plan hiện tại. Không có universal read-only gate và không gọi `apply` ngầm từ create/register.

## C1-F1/F2 correction boundary

CLI inspect/preview/apply/update/release không còn trả `ok:false` như `SingleResult` thành công. Payload RPC lỗi được chuyển thành existing `CommandError`: server `code` giữ ở top-level, message/paths/recovery giữ trong structured `details.rpc`; `withOutput` sẽ ghi JSON lỗi ra stderr và exit `1`.

Sau mutation/release `ok:true`, fresh inspect được xem là readback riêng. Nếu readback trả RPC error hoặc transport throw, CLI exit `1` nhưng structured stderr vẫn chứa `completed` receipt, target/transaction hoặc release result, readback failure và hướng dẫn inspect/reload; transport object được serialize, không rơi thành `[object Object]`.

UI dùng commit state gắn với `server/project/workspace` target key. Khi commit đã biết, plan preview bị consume/ẩn và release button bị disable; receipt vẫn hiển thị trước readback failure. Payload-false vẫn là RPC error chưa commit nên không được đánh dấu consumed. Target key trong React key và production-used state adapter loại delayed response của target cũ; readback lỗi chỉ invalidate query, không báo toàn mutation thất bại.

## Focused evidence và queued checks

Đã chạy các check nhẹ được phép:

```text
npm run format:files -- \
  packages/cli/src/commands/project/harness.ts \
  packages/cli/src/commands/project/harness.test.ts \
  packages/cli/src/commands/project/index.ts \
  packages/cli/src/commands/project/project.test.ts \
  packages/app/src/components/project-harness-settings.tsx \
  packages/app/src/components/project-harness-settings-model.ts \
  packages/app/src/components/project-harness-settings-model.test.ts \
  packages/app/src/screens/project-settings-screen.tsx \
  packages/app/src/i18n/resources/en.ts \
  packages/app/src/i18n/resources/ar.ts \
  packages/app/src/i18n/resources/es.ts \
  packages/app/src/i18n/resources/fr.ts \
  packages/app/src/i18n/resources/ja.ts \
  packages/app/src/i18n/resources/ko.ts \
  packages/app/src/i18n/resources/pt-BR.ts \
  packages/app/src/i18n/resources/ru.ts \
  packages/app/src/i18n/resources/zh-CN.ts

npm run lint -- \
  packages/cli/src/commands/project/harness.ts \
  packages/cli/src/commands/project/harness.test.ts \
  packages/cli/src/commands/project/index.ts \
  packages/cli/src/commands/project/project.test.ts \
  packages/app/src/components/project-harness-settings.tsx \
  packages/app/src/components/project-harness-settings-model.ts \
  packages/app/src/components/project-harness-settings-model.test.ts \
  packages/app/src/screens/project-settings-screen.tsx \
  packages/app/src/i18n/resources/en.ts \
  packages/app/src/i18n/resources/ar.ts \
  packages/app/src/i18n/resources/es.ts \
  packages/app/src/i18n/resources/fr.ts \
  packages/app/src/i18n/resources/ja.ts \
  packages/app/src/i18n/resources/ko.ts \
  packages/app/src/i18n/resources/pt-BR.ts \
  packages/app/src/i18n/resources/ru.ts \
  packages/app/src/i18n/resources/zh-CN.ts
```

Hai lệnh trên pass, lần lượt formatter `17 files` và lint `0 warnings and 0 errors`. Evidence R1 trước khi mở Project Harness consumer:

Correction source-only queue vừa chạy:

```text
npm run format:files -- \
  packages/cli/src/commands/project/harness.ts \
  packages/cli/src/commands/project/harness.test.ts \
  packages/app/src/components/project-harness-settings.tsx \
  packages/app/src/components/project-harness-settings-model.ts \
  packages/app/src/components/project-harness-settings-model.test.ts \
  packages/app/src/i18n/resources/en.ts \
  packages/app/src/i18n/resources/ar.ts \
  packages/app/src/i18n/resources/es.ts \
  packages/app/src/i18n/resources/fr.ts \
  packages/app/src/i18n/resources/ja.ts \
  packages/app/src/i18n/resources/ko.ts \
  packages/app/src/i18n/resources/pt-BR.ts \
  packages/app/src/i18n/resources/ru.ts \
  packages/app/src/i18n/resources/zh-CN.ts \
  docs/research/2026-09-07-project-harness-c1-client-handoff.md

npm run lint -- \
  packages/cli/src/commands/project/harness.ts \
  packages/cli/src/commands/project/harness.test.ts \
  packages/app/src/components/project-harness-settings.tsx \
  packages/app/src/components/project-harness-settings-model.ts \
  packages/app/src/components/project-harness-settings-model.test.ts \
  packages/app/src/i18n/resources/en.ts \
  packages/app/src/i18n/resources/ar.ts \
  packages/app/src/i18n/resources/es.ts \
  packages/app/src/i18n/resources/fr.ts \
  packages/app/src/i18n/resources/ja.ts \
  packages/app/src/i18n/resources/ko.ts \
  packages/app/src/i18n/resources/pt-BR.ts \
  packages/app/src/i18n/resources/ru.ts \
  packages/app/src/i18n/resources/zh-CN.ts
```

Correction formatter pass `15 files`; correction lint pass `0 warnings and 0 errors` on `14` source files. No correction Vitest/build/typecheck was run.

```text
npx vitest run packages/cli/src/commands/agent/inspect.test.ts packages/cli/src/commands/agent/run.test.ts packages/app/src/workspace-protocol/create-admission.test.ts --bail=1
```

Receipt cũ là `3 files, 34 tests passed`; không rerun test unchanged theo scheduling receipt.

Các test mới của CLI harness và app model đã được viết để cover plan/revision parsing, operation boundary, coverage unknown, foreign local delta, release selector absence/presence, nhưng đang queued vì mọi Vitest C1 hiện HOLD. C1 không chạy Vitest mới, build, typecheck hoặc full suite; không claim installed/live qualification. Lead sẽ serialize check queue sau handback.

Correction boundary sources mở rộng coverage với actual `createProjectCommand().parseAsync()` + `withOutput` capture cho positive `inspect/preview --json` roundtrip, RPC `ok:false` exit/stderr, positive release output giữ riêng release/fresh-inspect `requestId`, post-commit apply readback RPC failure và release readback transport failure; app model test dùng state adapter thật cho committed receipt/readback failure và delayed old-target rejection. Các test này chưa được chạy vì C1 Vitest vẫn HOLD.

## Final compiler-boundary correction

R2 C3 executed handoff `702448b18d58b52c51f41816b3b93e554242d9e1623860db4cf015e689161f44` ghi nhận protocol/client/server stages đã pass; receipt compiler cũ dừng ở CLI C1 với TS2345 tại `harness.ts:62,68,74,80,86` và `project/index.ts:61,73,84,95`. Đây là receipt lịch sử sau owning builds, không phải trạng thái final sau correction.

C1 đã sửa cục bộ tại CLI command boundary: success payload `ok:true` được narrow trước khi tạo `SingleResult`, human renderer nhận đúng `AnyCommandResult` single/list, còn payload `ok:false` vẫn giữ F1 `CommandError`/structured stderr/exit `1`. Fresh release inspection giữ `requestId` do chính inspect trả về; không còn gắn synthetic release request id. Thêm positive command-output test kiểm tra hai ID khác nhau và exact target/readback call. Không sửa global output machinery, protocol, client, server hoặc F1/F2 UI semantics.

Formatter/lint sau correction đã pass: `npm run format:files --` trên `harness.ts`, `harness.test.ts`, handoff này; `npm run lint --` trên hai CLI files trả `0 warnings and 0 errors`. Receipt “chưa rerun” là trạng thái của C1 window cũ; Lead đã relayed focused 2 file/16 test, build:server và root typecheck PASS trong C1 final, vì vậy không giữ UNKNOWN/PENDING cho source/test verdict hiện tại. Installed qualification và live canary vẫn chưa được claim.

## Exact source manifest

Hash là bytes sau formatter. Handoff file này không tự hash để tránh self-reference.

| Path                                                                 | SHA-256                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/cli/src/commands/agent/inspect.ts`                         | `9269b11ff523e3de3773d218f23ff9dcbbabe385174babf5057edd100819812c` |
| `packages/cli/src/commands/agent/inspect.test.ts`                    | `1741b617e1642a5652c3681e2a75c8924618e7f8cf1eb98a01e8949b4d1211f5` |
| `packages/cli/src/commands/agent/run.ts`                             | `d4b97b4281f95cc1b6e877790a84db37027d64ff19b514354ae1241be73e57bb` |
| `packages/cli/src/commands/agent/run.test.ts`                        | `7ff84be6dbd56b3793ebf69e93ac7ea76d4a6a00e331179ac8c752afb166b53e` |
| `packages/app/src/workspace-protocol/create-admission.ts`            | `5e6f6a5d63094945fb9412591cdfbeb62f39a4a6deaba9d61531b25e021ea813` |
| `packages/app/src/workspace-protocol/create-admission.test.ts`       | `834d94b3dfbdddadf60983bffc96701c314ee32e2e1b87379e1bb8eb1250b2d2` |
| `packages/app/src/components/workspace-setup-dialog.tsx`             | `22242e77812bf0c371580cbac1c5d9b48c008113c635f03bf5d77cadf357d68d` |
| `packages/app/src/composer/draft/workspace-tab.tsx`                  | `36e116a93d72fe3d9c6371da7083bc6c1cc7dc90fbfe7aa9d466e8fddf0ef509` |
| `packages/cli/src/commands/project/harness.ts`                       | `e9d236bbd5c26481a0583c3061378bc221b3fd14b2caf01b632f83225769b17a` |
| `packages/cli/src/commands/project/harness.test.ts`                  | `9b9a120d8cd3721defc36b3184c1341f05947f2104e784c20510bd149843fb5b` |
| `packages/cli/src/commands/project/index.ts`                         | `02db9bdac2559a79c620817a5ce0d9aaad95c102c81d4c47e97347b2730b0016` |
| `packages/cli/src/commands/project/project.test.ts`                  | `59edb454e837a7732e51201ff6dea37e1ce96a4a38a4d0f493c256d5fa03925e` |
| `packages/app/src/components/project-harness-settings.tsx`           | `abecd04ee3ba285eb8d9d99b903e881237b7e4f8f5bae4e7f4a97919aa8e7afa` |
| `packages/app/src/components/project-harness-settings-model.ts`      | `3e03dc8504734f377cd762a9ba9e9b6f49e436a3c52c1e862596f1cfdf3e1e19` |
| `packages/app/src/components/project-harness-settings-model.test.ts` | `55d9c60321b64f1e994e43c702e61651d742d589a1ce37042082ac0d901358be` |
| `packages/app/src/screens/project-settings-screen.tsx`               | `5eb85e3f062e6f8a5af1dd9ed82b1df9ec9067b6352bba33b6ed2e5a1a03cbc7` |
| `packages/app/src/i18n/resources/en.ts`                              | `840c6d655b8ae2f120441c36879e8957adfd102230bd35ac8125030359f19d8a` |
| `packages/app/src/i18n/resources/ar.ts`                              | `d75575bdd5c43876a928158ec4f361ed9b780d55d3a759e0471d0f6a5a353e6a` |
| `packages/app/src/i18n/resources/es.ts`                              | `e855fd98751370bb61659ee4ebd640bd4f580954d4e46b992bdde9d6019401f4` |
| `packages/app/src/i18n/resources/fr.ts`                              | `d9e5d424e8a09bbb70d1a32778f722659923dbc150ce5383486b91d4296d9b1d` |
| `packages/app/src/i18n/resources/ja.ts`                              | `922088f745236224beee1001157cfb21c4abcb0daba201d051431909ab45a9e3` |
| `packages/app/src/i18n/resources/ko.ts`                              | `b0d0611c5a2f74e6d4b2e9ac300f1912b919c9e54df1aab2d15979cd069f466d` |
| `packages/app/src/i18n/resources/pt-BR.ts`                           | `69defddc414374b1696b0a1dd46c1636a98df16f97b599c41a5ed79365c5625f` |
| `packages/app/src/i18n/resources/ru.ts`                              | `7834278a39ad59436e113f0727d201984117cd179e0d4a423a5930c43d5da954` |
| `packages/app/src/i18n/resources/zh-CN.ts`                           | `cfb690a17ce5531f926d18fbe07e78f94c02b6d9c0d2803b14b7d04861f93d27` |

Lead nên kiểm tra manifest một lần nữa khi nhận handback cùng queued tests. Không có dependency blocking workaround; R2/N1 native ABI đã có receipt và C1 không mở rộng sang server/protocol/client ownership.
