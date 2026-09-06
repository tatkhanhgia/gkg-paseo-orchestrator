# Tích hợp upstream Paseo v0.7.2 stable

## Kết luận

- Quyết định: `MERGE WITH ADAPTATION` exact annotated tag `v0.7.2`, peeled commit
  `9400a49af670fdb5db4af58e73f8df98588dbea9`.
- `v0.7.2` đã chứa toàn bộ `v0.7.1` tại commit
  `bbb2b40855caf991453e7b8a810a6ec3964da943`; downstream merge một upstream head, không merge hai tag
  tuần tự.
- Baseline downstream là `0.7.0-paseo.56`, commit
  `223142274ce2687e1e87b994b28a6fd0c0a6bbbc`. Merge commit
  `4f5a72de01971c7b3566367d88fbbc5a0bf84b95` có đúng hai parent là baseline đó và upstream `v0.7.2`.
- Version activation đích là `0.7.2-paseo.57`; version/changelog/lockfile release được giữ ở commit
  riêng theo downstream release contract.

## Upstream delta

Boundary từ upstream `v0.7.0` tới `v0.7.2` gồm Fable 5.1 và toàn bộ functional fixes công bố trong
hai stable release:

| Surface                | Quyết định              | Nội dung nhận                                                                                                                           |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Claude catalog         | `MERGE`                 | Fable 5.1 và thứ tự catalog newest-first.                                                                                               |
| Pi                     | `MERGE`                 | Active-turn steering gửi message mới vào turn đang chạy mà không interrupt.                                                             |
| Codex                  | `MERGE`                 | Rewind đọc hết paginated thread trước khi rollback.                                                                                     |
| Plugin Git source      | `MERGE WITH ADAPTATION` | Monorepo source path, declared build commands và trust disclosure; build được bọc timeout/process-tree cleanup downstream.              |
| Mobile retained panels | `MERGE`                 | Canonical revision/settlement giữ panel đúng vị trí qua JS stall và rotation.                                                           |
| Diff rendering         | `MERGE`                 | Giảm measurement/paint work cho large và many-file diffs.                                                                               |
| Timeline/UI            | `MERGE`                 | Cap oversized assistant render, Escape/lightbox ownership và completion time khi prompt ẩn.                                             |
| Daemon lifecycle       | `MERGE WITH ADAPTATION` | Windows graceful IPC shutdown; supervisor grace tăng lên 25 giây để worker có đủ downstream cleanup budget 20 giây cho daemon và Beads. |
| Explorer               | `MERGE`                 | Rename collision fail closed khi thiếu file identity metadata.                                                                          |

Primary sources:

- [Release v0.7.1](https://github.com/getpaseo/paseo/releases/tag/v0.7.1)
- [Release v0.7.2](https://github.com/getpaseo/paseo/releases/tag/v0.7.2)

## Semantic ownership

Merge simulation có 19 textual conflicts. Resolution không chọn wholesale `ours` hoặc `theirs` cho
các vùng authority/lifecycle:

- Giữ exact shipped provider set Claude, Codex, Cursor, Antigravity và Codex-derived custom providers;
  OpenCode compatibility không được đưa trở lại shipped route qua E2E fixture.
- Giữ Human-only plugin lifecycle guard cho `init`, `install`, `update`, `reload`, `enable`, `disable`
  và `remove`; read-only `ls`, `logs`, `status` vẫn dùng được trong agent context.
- Nhận upstream plugin source-reference parser và build manifest, nhưng mỗi build command có budget
  5 phút, output giữ tối đa 64 KiB, rồi graceful/force process-tree termination nếu quá hạn.
- Giữ Foundation import, SLP Attention, role/no-write contracts, Beads Central sidecar và portable
  downstream updater. `foundation/sources.lock.json` chỉ đổi upstream provenance sang exact `v0.7.2`.
- Protocol `pluginPath` cũ vẫn optional và có dated compatibility shim; client mới canonicalize về
  source suffix trước khi gọi service.
- Package publication policy, AGPL downstream metadata và internal workspace links không nhận upstream
  npm publication semantics.

## Source receipts

- Zero unmerged path và zero conflict marker sau resolution.
- `926` focused assertions pass trên plugin/protocol, supervisor, Claude/Codex/OMP/Pi, Explorer,
  mobile panels, timeline, diff rendering, client transport và downstream provider/role/SLP/Beads
  contracts.
- Full workspace typecheck, repository lint và format check pass trên merge commit qua pre-commit gate.
- `npm ci` và postinstall patches pass; `scripts/fix-lockfile.mjs --check` xác nhận lockfile đầy đủ.
- Nix fetcher version `2` tính từ merged lockfile ra
  `sha256-o4TSPdubPE4Ras2x4JV3V0Y22nXmwbd8sWk6HcoCFAk=`; không reuse hash stale của `.56` hoặc hash từ
  upstream-only lockfile.

## Gates còn lại

Merge commit là source receipt, chưa phải installed/live acceptance. Trước handback cần release commit
`0.7.2-paseo.57`, CI của exact commits, portable prerelease qualification khi scope yêu cầu, fresh
idle readback, `./scripts/local-stack.sh --apply`, exact source fingerprint, daemon/WebUI/Beads health
và live canary cho changed behavior. Desktop/mobile store và upstream npm publishing không được suy ra
từ source tests.
