# Bàn giao izq — transport native của Project Harness

Ngày 2026-09-08. Đây là hồ sơ tích hợp cuối của fix transport native Project Harness
trong Product workspace. Lead đã chấp nhận source/test; Independent Reviewer
ab5d6a87 đã trả SOURCE/TEST-GO cuối, không có finding vật chất P0-P2. Provider
ac281799 đã hoàn tất focused checks, source/test/doc handback và release slot. Các
receipt hiện có được đọc lại, không rerun focused tests.

Source runtime/test của fix đã freeze. Installed/runtime qualification, activation và
recovery vẫn là phần Caller sở hữu; tài liệu này không biến source/test PASS thành
installed/runtime PASS.

## Kết luận kỹ thuật

Lỗi nằm trên public wire path, không nằm ở việc handler thiếu ok:

1. Các session handler của Project Harness tạo response với JSON boolean payload.ok.
2. Session/WebSocket serialize response và public DaemonClient nhận envelope.
3. Client gọi generated validateWSOutboundMessage trước khi hoàn tất correlation của
   request.
4. Với năm response Project Harness, zod-aot đã biến discriminator boolean thành các
   case string "true"/"false". Vì vậy wire value boolean false bị từ chối với
   invalid_union, path message.payload.ok, trước khi caller nhận response.

Sửa nhỏ nhất là đổi đúng năm result payload từ
z.discriminatedUnion("ok", ...) sang z.union(...) trong
packages/protocol/src/project-harness/rpc-schemas.ts. Không sửa generic compiler và
không sửa packages/protocol/scripts/generate-validation-aot.mjs; generated AOT chỉ
được regenerate bằng script hỗ trợ, không hand-edit.

Exact diff không sửa persisted HarnessBindingReceipt, PersistedRoleBinding,
PersistedLaunchContract hoặc AgentStorage schema. Browser Automation là seam cạnh:
BrowserAutomationExecuteResponseSchema ở packages/protocol/src/messages.ts:3358 là
SessionINBOUND, không phải outbound; hai outbound validator đều reject loại message
đó theo thiết kế, nên không có Browser Automation defect được chứng minh.

## Attribution và đường truyền công khai

Caller đã ghi nhận hai CLI native receipts:

- /tmp/paseo-harness-rollout-20260907/native-inspect-failure-58.json
- /tmp/paseo-harness-rollout-20260907/native-preview-failure-58.json

Caller cũng ghi nhận reproduction read-only trên WebUI tại
/settings/hosts/srv_H9FX0QRO_xeb/projects/prj_c9978c5a0d3d50db: cả bốn Product
workspace panels hiển thị "Could not inspect Project Harness" /
"Response validation failed for foundation.projectHarness.inspect.response". Không có
UI mutation. Đây là cùng một public transport correction với CLI; không có app source
patch độc lập.

## Bằng chứng trước sửa: public transport trên schema gốc

Để giữ bằng chứng trước sửa, chỉ schema sở hữu
packages/protocol/src/project-harness/rpc-schemas.ts được restore tạm về năm
z.discriminatedUnion; generated output được tạo lại bằng:

    npm --prefix packages/protocol run generate:validators

Sau đó chạy dependency build tối thiểu:

    npm run build:client

và cùng một real-transport test:

    npx vitest run packages/server/src/server/session/project-harness/project-harness-transport.test.ts --bail=1

Kết quả baseline: exit 1, Test Files 1 failed (1), Tests 1 failed (1), không có
skipped count trong log. Test đã khởi động createTestPaseoDaemon trên OS-assigned
port, kết nối DaemonClient qua WebSocket thật, đăng ký project/workspace tạm, rồi
fail khi response inspect đi qua public validator. Đây không phải fixture/setup
failure:

    invalid_union
    note: No matching discriminator
    discriminator: ok
    options: ["true", "false"]
    path: ["message", "payload", "ok"]
    Response validation failed for foundation.projectHarness.inspect.response

Log baseline:

- /tmp/paseo-harness-rollout-20260907/project-harness-generate-before.log
- /tmp/paseo-harness-rollout-20260907/project-harness-build-before.log
- /tmp/paseo-harness-rollout-20260907/project-harness-transport-before.log

SHA-256 baseline:

    cfa797afce53164f1ec9438da55eb0e8cbeda9b02734541ac23a640ee40a1b83  packages/protocol/src/project-harness/rpc-schemas.ts
    2e7bd7b653181cda46973d43c142f653a6454ef3bb0eb662f83a55d304edb793  packages/protocol/src/generated/validation/ws-outbound.aot.ts

## Bằng chứng sau sửa: transport, parity và correlation

Sau khi restore source z.union, generated output được regenerate và client/protocol
declarations được build lại. Real transport test cuối cùng:

    Test Files 1 passed (1)
    Tests 1 passed (1)
    skipped: 0 reported

Test đi qua public WebSocket và cover các đường success/error sau, với requestId
correlation được assert:

| Operation        | Success/error coverage                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| inspect          | success; missing workspace structured error                                 |
| preview          | missing WORKSPACE_PROTOCOL error; bootstrap success; update preview success |
| apply            | stale-plan error; bootstrap success                                         |
| update           | stale-plan error; update success                                            |
| notebook.release | release success; claim-missing error                                        |

Release success dùng metadata claim trong disposable project và chỉ stub test-local
AgentManager.getAgent thành writer idle. Request/response, validation, CAS/revision và
authority checks vẫn đi qua public Session/WebSocket thật. Vì vậy provider/agent
lifecycle không được chứng minh là live canary; limitation này không phải failure của
transport.

Focused protocol parity:

    Test Files 1 passed (1)
    Tests 15 passed (15)
    skipped: 0 reported

Changed schema test:

    Test Files 1 passed (1)
    Tests 3 passed (3)
    skipped: 0 reported

Logs:

- /tmp/paseo-harness-rollout-20260907/project-harness-generate-after.log
- /tmp/paseo-harness-rollout-20260907/project-harness-build-after.log
- /tmp/paseo-harness-rollout-20260907/project-harness-transport-after-final.log
- /tmp/paseo-harness-rollout-20260907/project-harness-protocol-validator.log
- /tmp/paseo-harness-rollout-20260907/project-harness-rpc-schemas.log

Có một lần chạy sau sửa ban đầu dừng ở test-only fixture shape, không phải transport:
expectedRevision.status thiếu trong notebook-release request
(/tmp/paseo-harness-rollout-20260907/project-harness-transport-after.log). Fixture
được sửa trong path sở hữu để thêm status: "regular" theo protocol type, rồi chạy lại
trên cùng public path và pass 1/1. Không có heavy check nào bị abort.

## Review, hỗ trợ và mức qualification

Receipt đã được chấp nhận mà không rerun:

- RPC transport: 1 public transport test, 15 protocol parity tests, 3 schema tests.
- Claude provider: 81 focused agent tests và 8 manager-binding tests; source/test/doc
  đã release.
- Lead engineering acceptance và Independent Reviewer ab5d6a87 SOURCE/TEST-GO đều
  hoàn tất; reviewer không có finding vật chất P0-P2.

| Route/provider               | Source/admission                                                                                                                                             | Đã exercise hoặc qualify                                 | Trạng thái            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------- |
| Caller Codex Peer navigation | source và admission đã được chấp nhận                                                                                                                        | Caller PASS hiện tại                                     | PASS                  |
| Claude                       | source/test focused PASS                                                                                                                                     | live native .59 Read còn chờ                             | PENDING               |
| AGY                          | advertised/admitted plan; native file Read và Beads gateway không có trong catalog được phép; read_resource đã được gọi nhưng server trả no allowed resource | chưa exercise thành công; chờ exact Caller retry receipt | BLOCKED / UNEXERCISED |

Không suy diễn thành all-providers claim. Existing old Lead missing policy generation
là fail-closed riêng, không thuộc fix transport này.

## Phục hồi .57, phân loại .58 và giới hạn .59

Receipt Caller cung cấp:

/tmp/paseo-harness-rollout-20260907/rollback/old-schema-harness-binding-compatibility.json

chứng minh .57 RoleBindingReceiptSchema.safeParse chấp nhận actual .58 Supervisor
public binding nhưng làm rơi harnessBinding. Vì vậy không được boot .57 đè lên state mới
và không được sửa historical artifact. Archive backup đã được Caller authorize và báo
đã được giữ bền vững, trạng thái VALID; đây không phải independent full-hash
verification của Engineer. Caller chỉ cung cấp hash rút gọn 3c2c65d...fcd, không cung
cấp full path/full hash trong receipt này, nên không suy đoán thêm. Actual downgrade
chưa được chạy và vẫn UNQUALIFIED/BLOCKED.

Foundation dev24 update-plan READY không phải bằng chứng agent-store được bảo toàn.
Final review xác nhận persisted schema không đổi; vì vậy exact source diff cho phép
phân loại .58 là previous-schema runtime target ở mức source. Đây là
schema-preservation classification, không phải qualification cho actual resume/rollback
boot; qualification đó chưa chạy. .58 vẫn giữ các usability bug RPC và Claude đã biết.

Installed .58 cached WebUI client cần reload hoặc mở new tab sau khi .59 activation để
nạp validator mới; chỉ update daemon không sửa được client cũ đã load trong memory.
Activation, recovery và mọi rollback qualification vẫn do Caller sở hữu.

## Manifest source/test cuối

Tám runtime/test source hashes được chấp nhận và giữ nguyên:

    66a41895bc5188c5a65c4ef927e3d8cd4025e95b14a57093684d5a98748fbd31  packages/protocol/src/project-harness/rpc-schemas.ts
    24188107e4b7959d7caf0aa9f93c46f2b15709b4cde99c99d1de2c23c8f8a59e  packages/protocol/tests/validation/ws-outbound.test.ts
    212a5bcaabae3d34c08c9309a99f1d76e04be4bc9ff8251bc6bf9716a83d0555  packages/server/src/server/session/project-harness/project-harness-transport.test.ts
    b5ff4e2800e4fdd44882315bf0c428ad6ced6166f756d14acd13fee684e2dab6  packages/server/src/server/agent/agent-sdk-types.ts
    02b1095280afc1bb8845b660ee9dbc735f52759aebebdebaf009880a3b03fe8f  packages/server/src/server/agent/agent-manager.ts
    5ee0daab52fec4977f158711e3ce0a21a3cae07e5a79623f9399afa94eebe594  packages/server/src/server/agent/agent-manager-harness-binding.test.ts
    1de907bf86f797250b01f4d8c8e5c53391c0cb2e92a57612d2a10dc0327569bc  packages/server/src/server/agent/providers/claude/agent.ts
    a2ce9ba25ae3b47f97b594e7026d80bbba6aa62f7f6bb34e0c830ecf1a56712a  packages/server/src/server/agent/providers/claude/agent.test.ts

Generated output chỉ được tạo bằng generator được hỗ trợ và không hand-edit:

    642a025f40b5d70b7b3b72935d6155758597f5db4bc07cd8da275186db7b6dba  packages/protocol/src/generated/validation/ws-outbound.aot.ts

Bộ path của fix commit là đúng 11 path đã được chấp nhận và ghi trong Beads final
receipt. Fix commit thực tế là
6458769ce4c005931fd4189a085a0fd1cd188687 (parent
535df5b1fc04a925075d331afdcbedc667237a0b). Release commit .59 thực tế là
791f2c0b0546952cf85a21310e8014f0558aacdb (parent
6458769ce4c005931fd4189a085a0fd1cd188687), chỉ chứa 16 path metadata/CHANGELOG đã
được Lead cấp phép.

## Receipt tích hợp release và provenance

Candidate artifact .59 có SHA-256
47a598889fd14750342b4fd15657ecc259b5e0d4d4233138bf84a323d2cb2830. Top manifest
chỉ ghi gitCommit 535df5b1fc04a925075d331afdcbedc667237a0b và gitDirty true; file
provenance được đọc trực tiếp trong archive tại

    paseo-web-cli-0.7.0-paseo.59-macos-arm64/app/node_modules/@getpaseo/server/dist/server/build-provenance.json

ghi sourceCommit 535df5b1fc04a925075d331afdcbedc667237a0b, sourceDirty true,
sourceFingerprint c47dea2a123220d000141e6c281607bb186a2cdf5f6e59c13da0aab0515a66ca,
builtAt 2026-09-07T19:49:48.513Z, cùng harnessArtifact
e4dd814cd1bcfd780c014cf5d49fed1204051e4f6ef7f0a621f02ff34bca6ad1 và entryMap
adb98be153f76fc0fd1c3ca7d72dda861d6ac45822294abec546746a236ab17e. Đây vẫn là
validation artifact dirty-precommit, chưa install và không phải provenance của clean
HEAD/runtime; Caller sẽ build/apply từ clean HEAD.

## Kiểm tra tĩnh, ranh giới và bàn giao

Các focused checks được nêu ở trên không được rerun sau khi đã được independent review
đọc. Integrated release checks dùng root lint, root format check, root typecheck và
supported candidate artifact build theo release handback order. Candidate artifact
không phải clean final installed provenance; Caller sẽ build/apply từ clean HEAD sau
fresh global idle readback.

Không có main daemon/local-stack --apply, activation/install/restart, provider canary,
Caller fixture hoặc production data mutation, external push/publish/tag/CI/network
download. Pre-existing dev PID 24406 được giữ nguyên. Các lease source/test/doc/index
đã release; Lead giữ final RELEASE-READY ACCEPT sau khi đọc Beads artifact/commit
receipts.
