# Supervisor Notebook

Trạng thái: bootstrap template rỗng từ `paseo-project-harness` package, `generation: 1`. File này được
dùng **một lần** khi project bootstrap tạo notebook mới tại location project tự bind; sau đó bản thật
sống ở location đó, không phải file template này. Supervisor không reread template này thay cho notebook
đã bound. Nội dung dưới đây tự chứa (self-contained) — không phụ thuộc link tới bất kỳ file nào khác,
vì file này được materialize ở nhiều vị trí khác nhau tuỳ project.

## Contract

Notebook là durable organizational memory về coordination failure, recurring anti-pattern, recovery và
protocol experiment — không phải transcript, task tracker, product bug backlog hay acceptance authority.
Chỉ thêm record khi episode novel/material hoặc cung cấp evidence mạnh hơn cho pattern đã có; aggregate
occurrence lặp lại. `Observation` tách khỏi `Suspected mechanism`; mechanism chưa chứng minh giữ
`unknown`/hypothesis. Notebook không lưu secret, credential hay raw chain-of-thought.

## Record tối thiểu

```text
Pattern / episode:
Scope + date:
Observation:
Evidence:
Suspected mechanism: <hypothesis | unknown>
Impact/cost: <momentum | ownership | attention | quality | authority>
Question for Lead:
Recovery/intervention: <what happened; who held authority>
Outcome:
Pattern status: <one-off | repeated | durable | disproved>
Recommendation/protocol candidate: <smallest correction | none>
Escalation needed: <no | exact Human/Lead decision>
```

## Rule promotion — owner/authority/review-removal trigger trước khi promote

Một `Recommendation/protocol candidate` chỉ được đề xuất promote thành `WORKSPACE_PROTOCOL.md` hoặc
standing role profile khi record nêu đủ: reproduced failure (không phải một lần suy đoán), owning layer
đúng, lý do vì sao convention/deletion đơn giản chưa đủ, đúng owner có authority approve, và một
**review/removal trigger** cụ thể (điều kiện hoặc evidence sẽ khiến rule này bị revisit/gỡ bỏ). Chỉ một
comparable later episode mới hỗ trợ claim "cải thiện"; nếu chưa có, giữ `Unobserved`/hypothesis. Khi
evidence mới bác một hypothesis cũ, preserve correction/disproof trong record — không rewrite như thể
hypothesis cũ chưa từng tồn tại. Supervisor không tự apply promotion; chỉ đúng authority (Human/Lead theo
binding) mới approve.

## Binding và grant

Notebook identity/location/scope/reporting-target/designated-writer do project binding gắn khi tạo
notebook từ template này — không nằm trong file template, không tạo per-session copy, không tạo notebook
mới chỉ vì đổi worktree trong cùng project. Ghi vào notebook chỉ khi có một **explicit grant** (scope +
expiry) từ binding hiện tại; grant đó là một bounded capability do runtime cấp có kiểm soát, **không phải
provider filesystem write** — Supervisor filesystem vẫn no-write kể cả khi có grant. Không có grant nghĩa
là `observe + propose only`: ghi đề xuất record vào handback text cho Lead, không tự ý ghi vào notebook.
