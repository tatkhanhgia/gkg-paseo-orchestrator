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
