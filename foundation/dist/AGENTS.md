# Paseo Foundation — Operating Rules

## Ngôn ngữ

Documentation mới hoặc chỉnh material viết bằng tiếng Việt. Giữ commands, identifiers, paths, hashes, provider/model names, URLs và exact error text bằng English khi dịch làm giảm độ chính xác.

## Nguồn và thứ tự áp dụng

1. Current Human instruction/lease.
2. [`references/demonthorn-agent-orchestration-deep-dive.md`](references/demonthorn-agent-orchestration-deep-dive.md) — current orchestration doctrine.
3. [`docs/ROLE_CONTRACTS.md`](docs/ROLE_CONTRACTS.md) và [`WORKSPACE_PROTOCOL.md`](WORKSPACE_PROTOCOL.md).
4. Current repository bytes và reproduced evidence.
5. [`references/giao-an-herdr-first-edition.md`](references/giao-an-herdr-first-edition.md),
   [PDF First edition](references/Gi%C3%A1o%20%C3%81n%20Herdr%20-%20First%20edition.pdf)
   và historical records trong old workspace — extended evidence để audit, không override
   current Human decision, Deep Dive hoặc current source.

Khi conflict material, đọc exact source. Memory, status, provider ID, runtime capability hoặc historical plan không tự cấp authority.

## Instruction và authority

- **Role profile:** identity và universal role invariants.
- **Workspace Protocol:** mandatory repository contract; luôn giữ fixed Beads Central clause và chỉ thêm thin repo-specific tactics delta.
- **Assignment:** bounded objective với exact lease, scope, handback và stop condition.

Workspace Protocol giữ khoảng mười semantic clauses, không lặp universal role invariants, `AGENTS.md`
hay one-task details. Mọi repository role-bound phải có root file với issue-tracker clause bắt buộc; repo
không có tactics riêng dùng `baseline` form. Contract bind ở project onboarding: absent thì sinh baseline,
invalid thì fail closed tới correction path. Absence không block ordinary role launch — gate chỉ áp trước
new material delegation hoặc protected/mutating work. Schema version không bao giờ là gate; reader nhận
mọi version đã phát hành. Provider/model/effort được discover rồi pin trong bounded assignment, không
mutate standing role profile.

Lead là execution reader duy nhất và đọc file bắt buộc trước orchestration. Supervisor chỉ inspect/create/audit/update khi có governance mandate; Peer không đọc full file mà nhận relevant constraints, gồm mandatory issue-tracker checkpoint, trong assignment.

Paseo là delegation/lifecycle plane duy nhất; Codex-native và Claude-native agents bị disable. Runtime `full-access` chỉ là capability, không mở rộng lease, ownership, external effects hoặc acceptance authority. Assignment `no-write` phải được daemon pin vào provider/OS no-write mode đã qualify; thiếu enforcement thì launch fail closed, không fallback sang `full-access`, mode switch hoặc permission escalation. Base/generated Codex profiles phải giữ `multi_agent=false`, `multi_agent_v2=false`; role profiles còn có `agents.enabled=false`.

Engineering đi theo Human → Lead; Lead có thể làm trực tiếp exact tiny task khi applicable Human/repo
binding cho phép và transfer không thêm independent judgment; work có material uncertainty/risk hoặc
thật sự cần independent judgment mới route qua Peer. Supervisor đứng ngoài để
quan sát orchestration và không bypass Lead trong ordinary work; exact Human recovery lease chỉ cho
phép bounded stop/freeze hoặc decision relay theo [`docs/ROLE_CONTRACTS.md`](docs/ROLE_CONTRACTS.md).
Mỗi moving/coupled scope chỉ có một write Owner.

Daemon/runtime restart theo universal idle-readback rule tại
[`docs/ROLE_CONTRACTS.md`](docs/ROLE_CONTRACTS.md). Rule đó là role invariant nên chỉ sống ở role profile
và role contract; file này tham chiếu chứ không giữ bản sao.

## Simplicity và evidence

Chọn smallest useful topology. Trước abstraction, service, patch hoặc ceremony mới, nêu reproduced problem, owning layer và vì sao deletion, native Paseo, config, convention hoặc smaller prototype chưa đủ.

Evidence phải proportional: Git identity/diff và focused checks thường đủ; hash chỉ dùng khi Git không đủ hoặc risk cụ thể cần. Status, notification, silence và test pass không tự là acceptance.

<!-- PASEO_HARNESS:BEGIN -->
Đọc [Project Harness entry map](templates/harness/README.md) để tìm repository authority, validation
và hướng dẫn theo role. Với Paseo SLP, dùng role/assignment binding do daemon cung cấp. Lead đọc
[Workspace Protocol](WORKSPACE_PROTOCOL.md) trước orchestration; Peer chỉ nhận relevant constraints
trong assignment; Supervisor đọc protocol khi có governance mandate. Notebook location và Beads project
lấy từ binding, không tự suy từ cwd hoặc tên thư mục.
<!-- PASEO_HARNESS:END -->
