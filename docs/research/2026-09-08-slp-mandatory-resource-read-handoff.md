# Bàn giao: đọc tài nguyên bắt buộc của SLP trên Claude

Ngày: 2026-09-08  
Phạm vi sở hữu: Product provider/launch-context Peer  
Trạng thái: focused checks PASS; SOURCE/TEST-GO và review cuối không có P0-P2;
source/test/doc đã release; live native .59 canary vẫn chờ Caller

## Kết luận

Claude no-write hiện chỉ tự cho phép native Read khi input.file_path khớp
chính xác với một receipt trong toàn bộ slice
roleBinding.harnessBinding.resources do daemon đã revalidate. AgentManager
không chọn `entryMap`, không đọc caller instructions/config, không suy ra thư mục,
không cấp glob và không dùng bypassPermissions.

Receipt gồm key, path, digest; việc kiểm tra path/digest hiện tại vẫn thuộc
admission của role binding trước create/resume. Claude chỉ dùng path đã được
projection tin cậy truyền xuống để xử lý callback; digest không biến thành một
filesystem grant mới ở provider.

SLP hiện tình cờ projection receipt `entryMap`, nhưng generic manager và Claude
adapter không mã hóa lựa chọn policy đó. Các native tool khác, path khác, write,
session không có binding và identity/resource stale vẫn đi qua permission path
bình thường hoặc fail closed.

## Bằng chứng callback trước/sau

Regression gọi trực tiếp callback `canUseTool` thật của Claude session:

- Baseline replay: tạm vô hiệu đúng nhánh exact-resource mới, giữ nguyên mọi byte
  khác; cùng test kết thúc `1 failed | 19 passed` do exact `Read` để lại pending
  permission và timeout 5000ms. Log: `/tmp/paseo-slp-claude-before-fix-20260908.log`.
- Fixed source: exact pinned path trả `{ behavior: "allow", updatedInput }`
  ngay lập tức, không tạo pending permission; path khác và `Glob` vẫn tạo request
  để test deny. Log: `/tmp/paseo-slp-claude-after-fix-20260908.log`.

Nhánh baseline chỉ là replay tạm thời trong đúng file sở hữu và đã được khôi phục;
hash cuối cùng bên dưới là của source fixed. Không có byte baseline nào còn lại.

## Regression và kiểm tra

Tất cả lệnh dưới đây chạy tại:

`/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-foundation/.worktrees/paseo-product-upstream-v0.7`

### Kiểm tra Vitest tập trung

```text
npx vitest run packages/server/src/server/agent/providers/claude/agent.test.ts --bail=1
```

PASS, `1 file / 81 tests`; log cuối: `/tmp/paseo-slp-claude-after-fix-20260908.log`.

```text
npx vitest run packages/server/src/server/agent/agent-manager-harness-binding.test.ts --bail=1
```

PASS, `1 file / 8 tests`; bao phủ propagation fresh/resume cho Lead, Peer,
Supervisor và stale resource rejection. Log: `/tmp/paseo-slp-manager-binding-focused-final-20260908.log`.

### Định dạng và lint

```text
npm run format:files -- packages/server/src/server/agent/agent-sdk-types.ts packages/server/src/server/agent/agent-manager.ts packages/server/src/server/agent/agent-manager-harness-binding.test.ts packages/server/src/server/agent/providers/claude/agent.ts packages/server/src/server/agent/providers/claude/agent.test.ts
```

PASS, 5 files; log cuối: `/tmp/paseo-slp-format-owned-ts-rerun-20260908.log`.

```text
npm run lint -- packages/server/src/server/agent/agent-sdk-types.ts packages/server/src/server/agent/agent-manager.ts packages/server/src/server/agent/agent-manager-harness-binding.test.ts packages/server/src/server/agent/providers/claude/agent.ts packages/server/src/server/agent/providers/claude/agent.test.ts
```

PASS, 0 warnings / 0 errors; log cuối: `/tmp/paseo-slp-lint-owned-ts-rerun-20260908.log`.

Lần lint đầu phát hiện hai lỗi chỉ trong test harness: nested ternary và object
spread trong `map`; đã sửa bằng lookup disposition và object receipt tường minh.
Đây là semantic test-fixture cleanup, không thay đổi production behavior.
Các lần chạy oxfmt là format-only theo file được chỉ định.

```text
npm run format:files -- docs/research/2026-09-08-slp-mandatory-resource-read-handoff.md
```

PASS, 1 file; log: `/tmp/paseo-slp-format-vietnamese-handoff-20260908.log`.

### Kiểm tra kiểu trong phạm vi

```text
npm run typecheck --workspace=@getpaseo/server
```

PASS, `tsgo -p tsconfig.server.typecheck.json --noEmit`; log:
`/tmp/paseo-slp-server-typecheck-20260908.log`. Không cần build dependency.

```text
git diff --check
```

PASS. Không chạy build toàn workspace, global artifact/root checks, daemon,
activation, restart, version, commit hoặc live provider canary.

## Hash SHA-256 của manifest

```text
packages/server/src/server/agent/agent-sdk-types.ts
b5ff4e2800e4fdd44882315bf0c428ad6ced6166f756d14acd13fee684e2dab6

packages/server/src/server/agent/agent-manager.ts
02b1095280afc1bb8845b660ee9dbc735f52759aebebdebaf009880a3b03fe8f

packages/server/src/server/agent/agent-manager-harness-binding.test.ts
5ee0daab52fec4977f158711e3ce0a21a3cae07e5a79623f9399afa94eebe594

packages/server/src/server/agent/providers/claude/agent.ts
1de907bf86f797250b01f4d8c8e5c53391c0cb2e92a57612d2a10dc0327569bc

packages/server/src/server/agent/providers/claude/agent.test.ts
a2ce9ba25ae3b47f97b594e7026d80bbba6aa62f7f6bb34e0c830ecf1a56712a
```

Handoff file được hash lại sau khi ghi bản tiếng Việt cuối cùng và gửi cùng
Beads handback. Docs index và mọi file RPC/transport do owner khác quản lý;
không chỉnh sửa.

## Giới hạn và bàn giao

Live provider Read canary trên Caller .59 vẫn PENDING; focused unit callback
không thay thế canary đó. AGY route-capability, Beads/identity và qualification
observations khác nằm ngoài correction này.

Sau khi ghi nhận evidence, source/test/doc scope được freeze và slot được release.
Lead đã chấp nhận source/test, Independent Reviewer không có finding P0-P2; live
native .59 canary và installed/runtime qualification vẫn chờ Caller.
