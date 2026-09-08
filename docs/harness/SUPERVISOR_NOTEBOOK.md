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

<!-- paseo-supervisor-notebook-record-v1 -->

{"schemaVersion":1,"recordId":"R1-20260907-workspace-topology-and-closure","episode":"Product Project Harness R1 — binding/runtime/notebook; Beads psd02596e8eb-fj2","scope":"Quan sát chất lượng evidence và project/workspace identity trong R1 của Paseo Product. Record này không cấp quyền sửa Product, Workspace Protocol hay role profile.","observation":"Handoff C2 đã khẳng định F1/F2 đóng nhưng Lead và Reviewer đọc source vẫn thấy parent workspace có thể bind child cwd, và release writer làm mất custom notebook identity. C3 sửa hai property đó; sau đó Caller nêu countercase Product worktree hợp lệ nằm dưới registered Foundation container. Reviewer xác nhận resolver C3 lại lấy registered ancestor theo path để phủ lên workspace owner. C4 đã neo guard vào trusted workspaceRoot/projectId, giữ child isolation và cho phép worktree hợp lệ. Đây là quan sát trong cùng episode R1, chưa phải bằng chứng hiệu quả ở episode sau.","evidence":["Beads Central psd02596e8eb-fj2 — Engineer failing-before/passing-after, Lead verdict R1 ACCEPT source/test","Beads Central psd02596e8eb-36h — independent C2/C3/C4 review; C4 technical ACCEPT","/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-foundation/.worktrees/paseo-product-upstream-v0.7/docs/research/2026-09-07-project-harness-r1-runtime-handoff.md","Beads closure pins historical R1 C4 handoff SHA-256 90778796857fb136797976aeda07132c32d5af2212b48a9e7073690416fedd22, corrected from pre-final-manifest a94391db44d385e601e52b81994cd409020bb74c1f40d79bc7da3da7f3921037; current checked-out evidence file readback SHA-256 b886dfcf8ca70f2c5ce4f24f4341d4d3e63aee629331c95212d04448d8fc4c99","Independent Reviewer 79cdb70d-6c2d-4b33-b70b-b1ddfd5c17f7 C4 readback: create/materialization, persisted resume and catalog share workspace-root-aware guard"],"suspectedMechanism":{"status":"hypothesis","statement":"Fixture/helper coverage chưa phân biệt đầy đủ ownership logic trong workspace registry với hai hướng filesystem containment; handoff đã khái quát closure rộng hơn các property được chứng minh. Review source và countercase cụ thể mới làm rõ khoảng trống này; chưa quy kết nguyên nhân nhận thức của agent."},"impact":"quality","questionForLead":"Ở lần thay đổi project/workspace identity kế tiếp, evidence có giữ cả valid worktree và foreign child negative trên production path trước khi chốt closure không?","recovery":"Lead mở correction window hẹp, giữ một Owner cho các file coupled. Engineer tái hiện lỗi trước sửa, bổ sung positive/negative qua AgentManager và actual notebook catalog, rồi build/typecheck/lint có scope. Independent Reviewer đối chiếu source/test bytes; Lead giữ F2 ACCEPT và chỉ sửa F1 regression còn lại. Không dùng số test pass thay cho verdict.","outcome":"R1 đã được Lead ACCEPT ở mức source/test trên snapshot C4 nêu trong evidence. Các kết quả test là evidence do Engineer báo cáo; Reviewer không chạy lại tests và ACCEPT dựa trên source/test bytes. Record này không khẳng định toàn bộ Product đã activation, mọi migration/canary đã pass, hoặc harness đã tiết kiệm thời gian/tokens.","patternStatus":"repeated","recommendation":"Với thay đổi identity/topology có risk đã tái hiện, giữ một tập countercase nhỏ đi qua đúng production entry point và buộc closure trỏ tới property/evidence của candidate. Không biến thành audit bắt buộc cho mọi task và không tự promote thành WP/role rule. Ở comparable later episode, kiểm tra còn false closure/rework cùng cơ chế hay không; nếu không có evidence so sánh thì tiếp tục để later effect Unobserved.","escalation":"no","currentEpisode":"Observed","laterEffect":"Unobserved","laterEffectEvidenceRefs":[],"observedAt":"2026-09-07T14:06:55.150034+00:00"}
