# Project Harness — entry map

Trạng thái: `paseo-project-harness` package, `generation: 1` (xem `harness-package.json`). File này là
navigation index, không phải authority layer thứ tư: ba instruction layer vẫn là role profile → universal
invariants, Workspace Protocol → repository tactics, assignment → bounded objective/lease. File này chỉ
giúp route đúng chỗ đọc theo role và theo repository hiện tại.

Nguồn thật cho package identity/generation/resource path là **runtime binding hiện tại** (assignment/
role-binding receipt do daemon cấp), không phải giả định rằng descriptor này nằm cạnh (sibling) file entry
map đã materialize trong một project — sau khi Product import/bootstrap, các file này có thể sống ở path
khác path gốc `templates/harness/` của Foundation. Khi cần path cụ thể của `harness-package.json` hay một
resource khác, đọc runtime binding trước; dùng path literal trong tài liệu này chỉ như ví dụ minh hoạ, không
phải path đảm bảo đúng cho mọi vị trí materialize.

## Navigation pattern — tìm authority/validation của repository hiện tại

Đây là **thuật toán tra cứu**, không phải danh sách file cố định — repository nào cũng khác nhau, và
"chưa khảo sát" là câu trả lời trung thực hơn giả định:

1. **Entrypoint**: tìm `AGENTS.md` và `CLAUDE.md` ở project root. Một trong hai (hoặc cả hai) thường là
   symlink sang cái còn lại; nếu cả hai là regular file độc lập, đọc cả hai — chúng có thể khác nội dung.
   Nếu thiếu cả hai, ghi `unknown: no entrypoint found`, không tự viết instructions thay repository.
2. **Workspace Protocol**: tìm `WORKSPACE_PROTOCOL.md` ở project root. Đây là repository tactics
   layer — Lead đọc full file trước orchestration; Peer/Supervisor theo readership contract riêng của
   role đó (xem role profile, không lặp ở đây). Nếu thiếu, đó là `bootstrap owed`, không phải lỗi chặn
   mọi việc — ordinary read-only/no-external-effect work vẫn tiếp tục, material delegation/protected work
   cần binding hoặc exception rõ.
3. **Harness binding**: nguồn thật là runtime binding/receipt (assignment hoặc role-binding do daemon
   cấp) — nếu binding đó ghi package/generation/resource path, dùng trực tiếp, không cần một local file
   trung gian. Một local binding-record file (nếu project có) là evidence **bổ sung**, không phải nguồn
   duy nhất: **thiếu file đó không chứng minh project chưa bootstrap** khi runtime receipt vẫn có thể đang
   bind — kiểm runtime binding trước khi kết luận `unknown`/chưa bootstrap.
4. **Existing harness khác** (không phải package này): một số repository đã có harness riêng trước khi
   gặp package này (vd. `HARNESS:BEGIN/END` block, `.harness-core/manifest.json`, hoặc tương đương). Khi
   gặp, không chèn block mới đè lên, không chạy updater khác cùng quản lý file — cần reconcile ownership
   trước, đây là quyết định của owner hiện tại, không phải mặc định của entry map này.
5. **Issue tracker**: Beads Central là work graph bắt buộc cho mọi role theo contract hiện có ở role
   profile; đây không phải thứ project tự cấu hình qua harness.

Nếu bất kỳ bước nào không tìm thấy (cả file lẫn runtime binding), ghi `unknown` cho đúng bước đó thay vì
suy đoán hoặc generate policy giả.

## Route theo role

- **Lead**: đọc full `WORKSPACE_PROTOCOL.md` của repository (bước 2) trước orchestration, dùng
  `harness-package.json` (qua runtime binding, bước 3) để biết resource nào tồn tại trong package này, và
  trích relevant constraints cho Peer. Mandatory resource của package này: `entryMap` (file này).
- **Peer**: không đọc full `WORKSPACE_PROTOCOL.md`. Dùng đúng resource slice do Lead assign trong
  assignment; mandatory resource duy nhất của package này là `entryMap` (file này), không tự mở rộng
  sang resource khác ngoài assignment.
- **Supervisor**: đọc `WORKSPACE_PROTOCOL.md` chỉ khi có governance mandate (create/audit/update).
  Mandatory resource của package này cũng là `entryMap`; `entrypointBlock` và
  `supervisorNotebookTemplate` là bootstrap-only resource (không phải thứ đọc lại mỗi turn) — dùng
  `supervisorNotebookTemplate` (`SUPERVISOR_NOTEBOOK.EMPTY.md`) đúng một lần khi tạo notebook mới cho
  project; notebook thật sau đó nằm ở location project tự chỉ định, không phải file template.

## Notebook binding — semantic, không phải wire schema

Notebook grant cần các field ngữ nghĩa sau trước khi Supervisor có notebook write context (tên field
JSON/wire cụ thể do runtime sở hữu, xem `harness-package.json` → `notebook`):

- `notebookId` — durable identity riêng cho notebook, không suy từ workspace/worktree hiện tại;
- `location` — nơi notebook thật sự sống (durable, không phải per-session copy);
- `projectScope` — project mà notebook thuộc về;
- `reportingTarget` — ai nhận report từ notebook này;
- `designatedWriter` — đúng một writer tại một thời điểm;
- `grant` — `scope` + `expiry` tường minh, không suy ngầm từ bootstrap/recovery lease. Grant là bounded
  Product capability, không phải provider filesystem write.

Ghi phải revision-safe (expected-revision write), preserve disproof/history, và không tự tạo notebook
mới chỉ vì đổi worktree trong cùng project.

## Foundation-origin references (không phải phần portable của package này)

Foundation's own dogfood navigation biết chính xác các doc chỉ tồn tại trong chính repository Foundation:
`docs/ROLE_CONTRACTS.md`, `docs/SUPERVISOR_NOTEBOOK.md`, root `WORKSPACE_PROTOCOL.md`, và
`docs/PROJECT_HARNESS_INTAKE_AND_EXECPLANS.md`. Các path này **không đảm bảo tồn tại** ở một project
khác materialize package này — chúng là Foundation-origin, không phải resource của package
(`paseo-project-harness`) portable. Một project khác dùng đúng navigation pattern ở trên (bước 1–5) để
tìm tương đương của chính nó, không giả định các path cụ thể này.

## Optional recipes

Full audit, improve, three-lane review là skill-level (`triple-review`, `test-proof-debt-audit`,
`architecture-premise-audit`), không phải resource của package này và không tự chạy. Role chọn dùng
theo risk/mandate hiện có của skill đó, không phải vì harness package tồn tại.
