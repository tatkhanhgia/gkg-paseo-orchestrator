# E1 bounded episode evidence handoff

Ngày 2026-09-08, E1 (`psd02596e8eb-x3c`) đã hoàn tất correction window theo assignment digest `133479dee9f4e9ebd0b5141b7daf03c114bcf71af013aeadf10d84c586be7f8d`. Lead đã relayed E1 final SOURCE/TEST ACCEPT: handoff SHA-256 `37efdfa8057600962572faa1341a0544ebcffc1935595ffae4cd426031dd61ec`, 6/6 manifest verified, Reviewer activity 5513 F5 ACCEPT và 27 tests/server types/lint/format PASS. Activation/installed qualification vẫn chưa được claim.

Đây là tested-stable candidate để Lead review, không phải Lead acceptance. Report chỉ đọc, không cấp writer, không mutate Beads, không accept và không promote rule.

## Native MCP report recipe

Gọi native MCP `get_agent_checkpoint` với JSON bounded rõ ràng; không dùng private `catalog.executeTool` làm recipe:

```ts
const nativeResult = await get_agent_checkpoint({
  agentId: targetAgentId,
  report: {
    episodeId,
    projectId: exactRegisteredProjectId,
    assignmentDigest: exactPinnedAssignmentDigest,
    issueId: exactGrantedBeadsIssueId,
    objective: exactPinnedObjective,
    window: {
      from: "2026-09-06T11:00:00.000Z",
      to: "2026-09-06T11:10:00.000Z",
      maxActivityItems: 25,
    },
    candidate: {
      ref: candidateRef,
      digest: candidateDigest,
      evidenceRefs: ["timeline:123"],
    },
  },
});
```

Structured MCP result có shape `{ checkpoint, episodeReport }`:

```ts
const { checkpoint, episodeReport } = nativeResult.structuredContent;
```

`report` là request explicit; checkpoint mặc định vẫn là cheap path. Host kiểm tra quan hệ được phép đọc, policy owner, project/workspace/cwd topology, assignment digest/objective và đúng issue grant trước khi fetch activity/notebook/handoff. Activity dùng durable timeline bounded, không load/resume provider session và không crawl provider home.

## F1 — later effect và outcome

`SupervisorNotebookRecord.laterEffect=Observed` cùng dedicated refs vẫn là claim cho tới khi có canonical comparable later-execution join. Trong seam hiện tại không có source đủ assignment/episode-window/comparability/authority để promote, nên later effect và outcome giữ `unknown`; append hiện tại, source fix hoặc test pass hiện tại không đổi kết luận.

Nhiều record trùng episode, record mới hơn cùng scope, record khác episode chỉ chia sẻ scope/ref, và record disproof/contradiction đều được giữ dưới dạng evidence/claim và không bị collapse thành `outcome-supported`.

## F2 — identity-safe read

Project read dùng established workspace-anchored topology (`resolveRegisteredProjectForWorkspaceCwd`) và fail closed khi project/workspace/cwd, `projectRoot`, `workspaceRoot` hoặc persisted binding không còn khớp. Moved same-ID root và registered child dưới parent workspace bị từ chối trước bounded activity/notebook fetch.

Notebook location đọc durable `supervisorNotebookIdentity` độc lập với `supervisorNotebook` writer lease. Sau release writer, custom identity và file còn hợp lệ vẫn đọc được; metadata corrupt, claim/identity conflict hoặc binding stale vẫn fail closed.

## F3 — bounded candidate evidence

Candidate activity chỉ xét rows trong episode window; reasoning text không tham gia matching. Notebook/handoff joins thiếu exact assignment/window lineage được giữ là ambiguous/claim. Successful và failed test commands đều được giữ, không để green command xoá counterevidence.

## F4 — later effect giữ unknown

Notebook missing, không có record match exact episode, hoặc record `laterEffect=Unobserved`/không có dedicated refs đều giữ `laterEffect` và `outcome` ở `unknown`. Record vocabulary và claim `Unobserved` được giữ nguyên; fact rằng record ghi `Unobserved` không phải verdict rằng effect vắng mặt. Record `Observed` với refs vẫn chỉ là claim nếu chưa có canonical comparable later-execution join. Không tạo later episode giả và không sửa notebook protocol.

## F5 — candidate/digest provenance

Mention trong user/assistant text, authored shell command, search query, todo hoặc error chỉ tạo timeline source fact và candidate claim; không tạo verified candidate/digest. Trong checkpoint evidence, chỉ `kind=assignment` với structured `pointer` là SHA-256 assignment digest và khớp candidate ref (cùng optional requested digest) mới tạo source fact; mọi summary đều là advisory narrative. Coordination signal reason, Council seat disposition và permission narrative chỉ là claims/unknown. Nếu canonical join không đủ, lineage là `unknown`; không thêm artifact/audit service/store.

H5 notebook claim đã chuẩn bị với `laterEffect=Unobserved` vẫn hợp lệ như claim/fact về record. Report chỉ có một Beads issue grant đúng assignment; policy generation cũ/không khả dụng là unsupported và fail closed, không fallback. Installed `.57` chưa qualified/live; activation và provider canary vẫn thuộc caller, chưa được thực hiện trong E1.

## Verification receipt

Working directory cho mọi lệnh: `/Users/iznogoud/Desktop/Projects-AI/Paseo/paseo-foundation/.worktrees/paseo-product-upstream-v0.7`.

Đã chạy tuần tự, mỗi lần một lệnh:

1. `npx vitest run packages/server/src/server/agent/agent-episode-report.test.ts packages/server/src/server/agent/tools/paseo-tools-checkpoint.test.ts --bail=1` — PASS, 2 files / 27 tests.
2. `npm run typecheck --workspace packages/server` — PASS.
3. `npm run lint -- packages/server/src/server/agent/agent-checkpoint.ts packages/server/src/server/agent/agent-episode-report.ts packages/server/src/server/agent/agent-episode-report.test.ts packages/server/src/server/agent/tools/paseo-tools.ts packages/server/src/server/agent/tools/paseo-tools-checkpoint.test.ts packages/server/src/server/policy/bundled/slp/checkpoint-policy.ts` — PASS, 0 warnings / 0 errors.
4. `npm run format:files -- packages/server/src/server/agent/agent-checkpoint.ts packages/server/src/server/agent/agent-episode-report.ts packages/server/src/server/agent/agent-episode-report.test.ts packages/server/src/server/agent/tools/paseo-tools.ts packages/server/src/server/agent/tools/paseo-tools-checkpoint.test.ts packages/server/src/server/policy/bundled/slp/checkpoint-policy.ts` — PASS.
5. `git diff --check -- packages/server/src/server/agent/agent-checkpoint.ts packages/server/src/server/agent/agent-episode-report.ts packages/server/src/server/agent/agent-episode-report.test.ts packages/server/src/server/agent/tools/paseo-tools.ts packages/server/src/server/agent/tools/paseo-tools-checkpoint.test.ts packages/server/src/server/policy/bundled/slp/checkpoint-policy.ts docs/research/2026-09-07-project-harness-e1-evidence-handoff.md` — PASS.

Final process snapshot observed no E1 Vitest/typecheck/lint/format/build process in flight. The report remains read-only and does not imply lifecycle completion or Lead acceptance.

Không chạy `build:server`, root typecheck, full suite, CLI/app readers, global formatter, activation, restart, commit hoặc version; các bước đó vẫn thuộc coordination sequence bên ngoài E1.

## Frozen manifest

| File                                                                    | SHA-256                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/server/src/server/agent/agent-checkpoint.ts`                  | `ee65e2aa9fd14ac389f621d855cb03e58d331a994f87aeda76c7d023b752aba9` |
| `packages/server/src/server/agent/agent-episode-report.ts`              | `21465dcaf53110bb17a2848ecd875cebe3b0f7298ce3365d1085a830d46c3df4` |
| `packages/server/src/server/agent/agent-episode-report.test.ts`         | `c63f039238abd94e9b339c0751029b03e748da24b3fd5912d580b234178d21be` |
| `packages/server/src/server/agent/tools/paseo-tools.ts`                 | `12061368d0ccf74994f7347f35e4e700fdf6b606155bded659d77a9ee8867ddd` |
| `packages/server/src/server/agent/tools/paseo-tools-checkpoint.test.ts` | `135ede91e15eee1a88ff90a8b16bb12a56ed9c3dd518b041e87e77d20bf9d789` |
| `packages/server/src/server/policy/bundled/slp/checkpoint-policy.ts`    | `425f62819d11a177b0014ee4265554548e0336c31ee9825663d04e7eb39a281d` |

`agent-checkpoint-adapter.ts` được reuse, không thay đổi. Đề nghị index row cho Lead chuyển qua sole index owner trong release window: `2026-09-07-project-harness-e1-evidence-handoff.md` — E1 bounded native episode evidence/report, C2/F4 and C3/F5 corrected, focused correction tests + server typecheck + targeted lint/format green.
