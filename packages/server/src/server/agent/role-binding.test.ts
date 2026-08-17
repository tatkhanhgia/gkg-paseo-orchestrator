import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  applyRolePaseoToolPolicy,
  assertPersistedRoleAdmissionCurrent,
  ASSIGNMENT_CONTRACT_EXPIRED_ERROR,
  detectLegacyProviderRole,
  LEGACY_PROVIDER_ROLE_DETECTION_EXPIRES_AT,
  policyOwnerForRoleBinding,
  preflightWorkspaceProtocolAdmission,
  resolveProviderRoleBindingSupport,
  toRoleBindingReceipt,
  WORKSPACE_PROTOCOL_ADMISSION_ERROR,
} from "./role-binding.js";
import { materializeRoleBinding } from "./legacy-role-binding.js";
import { buildWorkspaceProtocolTemplate } from "../../utils/workspace-protocol-file.js";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import { MANDATORY_ROLE_TOOLS } from "./role-profiles.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-role-binding-"));
  temporaryDirectories.push(directory);
  return directory;
}

function assignmentFor(
  roleId: "lead" | "peer" | "supervisor",
  effectClass: AssignmentEnvelope["effectClass"] = "read-only",
): AssignmentEnvelope {
  let disposition: AssignmentEnvelope["disposition"] = "supervision";
  if (roleId === "lead") disposition = "lead-direct";
  if (roleId === "peer") disposition = "peer-execution";
  return {
    version: 1,
    disposition,
    objective: "Inspect the bounded target and hand back evidence.",
    effectClass,
    mutationBoundary:
      effectClass === "mutating"
        ? { mode: "bounded-write", scope: "src/**" }
        : { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    ...(roleId === "peer" ? { resourceGrants: { beadsIssueIds: ["ps-role-binding-test"] } } : {}),
    evidence: "Report exact inspected paths and observed checks.",
    handbackAndStop: "Stop after evidence handback or a material blocker.",
  };
}

function assignmentBinding(roleId: "lead" | "peer" | "supervisor", cwd: string) {
  return {
    workspaceId: `workspace:${cwd}`,
    assignment: assignmentFor(roleId),
    assignmentAssigner: { kind: "human-session" as const },
  };
}

describe("native Foundation role materialization", () => {
  test("detects only exact legacy role transport commands", () => {
    expect(LEGACY_PROVIDER_ROLE_DETECTION_EXPIRES_AT).toBe("2026-09-30");
    expect(detectLegacyProviderRole(["/opt/paseo/codex-profile", "lead"])).toBe("lead");
    expect(detectLegacyProviderRole(["claude", "--agent", "paseo-supervisor"])).toBe("supervisor");
    expect(detectLegacyProviderRole(["custom-provider", "peer"])).toBeNull();
    expect(detectLegacyProviderRole(["claude", "--agent", "unrelated-peer"])).toBeNull();
  });

  test("binds Lead to Codex with protocol provenance and a redacted receipt", async () => {
    const cwd = await createWorkspace();
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );

    const binding = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex-custom",
      providerBaseId: "codex",
      cwd,
      ...assignmentBinding("lead", cwd),
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
    });

    expect(binding.injectionMethod).toBe("codex-developer-instructions");
    expect(binding.policyOwner).toEqual({ kind: "legacy-core" });
    expect(policyOwnerForRoleBinding(binding)).toEqual({ kind: "legacy-core" });
    expect(binding.workspaceProtocol).toMatchObject({
      status: "bound",
      readership: "full",
      path: join(cwd, "WORKSPACE_PROTOCOL.md"),
    });
    expect(binding.workspaceProtocol.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(binding.roleProfile).toMatchObject({
      schemaVersion: 1,
      allowedTools: expect.arrayContaining(["create_agent", "beads_status"]),
      allowedSkills: expect.arrayContaining(["beads-issue-tracker"]),
    });
    expect(binding.instructions).toContain("Role: Lead");
    expect(binding.instructions).not.toContain("Council compatibility marker");
    expect(binding.instructions).toContain("Demonthorn Agent Orchestration Deep Dive");
    expect(binding.instructions).toContain("Giáo Án Herdr");
    expect(binding.instructions).toContain("runtime-issued PASEO_AGENT_ID");
    expect(binding.instructions).toContain("Broad agent lists may omit internal loop workers");
    expect(binding.instructions).toContain(binding.workspaceProtocol.digest);
    expect(binding.instructions).toContain("Mutation boundary: no-write");
    expect(binding.instructions).toContain("Role skill admission: `beads-issue-tracker`");
    expect(binding.instructions).not.toContain('<paseo-role-skill name="beads-issue-tracker">');
    expect(binding.instructions).toContain("Mandatory Beads Central checkpoint");
    expect(binding.assignment).toMatchObject({ effectClass: "read-only" });
    const receipt = toRoleBindingReceipt(binding);
    expect(receipt.policyOwner).toEqual({ kind: "legacy-core" });
    expect(receipt).not.toHaveProperty("instructions");
    expect(receipt).not.toHaveProperty("assignmentContract");
    expect(JSON.stringify(receipt)).not.toContain("Inspect the bounded target");
    expect(JSON.stringify(receipt)).not.toContain("Report exact inspected paths");
    expect(JSON.stringify(receipt)).not.toContain("Stop after evidence handback");
  });

  test("reads bindings created before policy ownership as legacy-core", async () => {
    const cwd = await createWorkspace();
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );
    const binding = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      cwd,
      ...assignmentBinding("lead", cwd),
    });
    const { policyOwner: _policyOwner, ...legacyBinding } = binding;

    expect(policyOwnerForRoleBinding(legacyBinding)).toEqual({ kind: "legacy-core" });
  });

  test("keeps Peer protocol readership assignment-only", async () => {
    const cwd = await createWorkspace();
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );
    const binding = await materializeRoleBinding({
      roleId: "peer",
      provider: "claude",
      cwd,
      ...assignmentBinding("peer", cwd),
    });

    expect(binding.injectionMethod).toBe("claude-system-prompt");
    expect(binding.workspaceProtocol).toMatchObject({
      status: "bound",
      readership: "assignment-only",
      path: join(cwd, "WORKSPACE_PROTOCOL.md"),
    });
    expect(binding.instructions).toContain("Do not load");
    expect(binding.instructions).toContain("beads-issue-tracker");
    expect(binding.instructions).not.toContain("Room role: Root");
  });

  test.each([
    [
      "solution-architect",
      "You are the Tech Team Solution Architect.",
      "architecture, not implementation or routine code review",
    ],
    ["reviewer", "You are the Tech Team Reviewer.", "You are not the Solution Architect"],
  ] as const)(
    "materializes %s privately on Peer and redacts it from public receipts",
    async (executionProfileId, identityMarker, boundaryMarker) => {
      const cwd = await createWorkspace();
      await writeFile(
        join(cwd, "WORKSPACE_PROTOCOL.md"),
        buildWorkspaceProtocolTemplate(cwd),
        "utf8",
      );
      const binding = await materializeRoleBinding({
        roleId: "peer",
        executionProfileId,
        provider: "codex",
        cwd,
        ...assignmentBinding("peer", cwd),
      });

      expect(binding.executionProfile).toMatchObject({
        id: executionProfileId,
        version: "1.0.0-foundation",
      });
      expect(binding.instructions).toContain(identityMarker);
      expect(binding.instructions).toContain(boundaryMarker);
      expect(binding.instructions).not.toContain("Claude Opus");
      expect(toRoleBindingReceipt(binding)).not.toHaveProperty("executionProfile");
    },
  );

  test("rejects a Peer execution specialization under a non-Peer authority role", async () => {
    const cwd = await createWorkspace();
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );

    await expect(
      materializeRoleBinding({
        roleId: "lead",
        executionProfileId: "solution-architect",
        provider: "codex",
        cwd,
        ...assignmentBinding("lead", cwd),
      }),
    ).rejects.toThrow("requires role 'peer'");
  });

  test("composes Council specializations through every SLP-supported Peer channel", async () => {
    const providers = [
      ["codex", "codex-developer-instructions", undefined],
      ["claude", "claude-system-prompt", undefined],
      ["pi", "pi-before-agent-start", undefined],
      ["omp", "omp-append-system-prompt", undefined],
      [
        "cursor-acp",
        "cursor-project-rule-capsule",
        { status: "supported", injectionMethod: "cursor-project-rule-capsule" },
      ],
      [
        "antigravity-native",
        "antigravity-custom-agent",
        {
          status: "supported",
          injectionMethod: "antigravity-custom-agent",
          roleIds: ["peer"],
        },
      ],
      [
        "grok",
        "grok-acp-session-rules",
        { status: "supported", injectionMethod: "grok-acp-session-rules" },
      ],
    ] as const;

    for (const executionProfileId of ["solution-architect", "reviewer"] as const) {
      for (const [provider, injectionMethod, providerSupport] of providers) {
        const cwd = await createWorkspace();
        await writeFile(
          join(cwd, "WORKSPACE_PROTOCOL.md"),
          buildWorkspaceProtocolTemplate(cwd),
          "utf8",
        );
        const binding = await materializeRoleBinding({
          roleId: "peer",
          executionProfileId,
          provider,
          providerSupport,
          cwd,
          ...assignmentBinding("peer", cwd),
        });

        expect(binding.injectionMethod).toBe(injectionMethod);
        expect(binding.instructions).toContain("Role: Peer");
        expect(binding.executionProfile?.id).toBe(executionProfileId);
      }
    }
  });

  test("rejects a missing or invalid mandatory protocol", async () => {
    const missing = await createWorkspace();
    const invalid = await createWorkspace();
    await writeFile(join(invalid, "WORKSPACE_PROTOCOL.md"), "# Workspace Protocol\n", "utf8");

    await expect(
      materializeRoleBinding({
        roleId: "lead",
        provider: "codex",
        cwd: missing,
        ...assignmentBinding("lead", missing),
        assignment: assignmentFor("lead", "mutating"),
      }),
    ).rejects.toThrow(`${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: missing`);
    await expect(
      materializeRoleBinding({
        roleId: "peer",
        provider: "claude",
        cwd: invalid,
        ...assignmentBinding("peer", invalid),
      }),
    ).rejects.toThrow(`${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: invalid`);
  });

  test("admits read-only work when the protocol has not been bootstrapped yet", async () => {
    const cwd = await createWorkspace();
    const binding = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      cwd,
      ...assignmentBinding("lead", cwd),
      assignment: assignmentFor("lead", "read-only"),
    });

    expect(binding.workspaceProtocol.status).toBe("missing");
    expect(binding.instructions).toContain("not yet bootstrapped");
    expect(binding.instructions).toContain("stay non-mutating");
    // Absence is a gap to report, never a licence to assume the repository has no tactics.
    expect(binding.instructions).toContain("unknown rather than absent");
    expect(binding.instructions).not.toContain("bootstrap exception");
    expect(() => assertPersistedRoleAdmissionCurrent(binding, cwd)).not.toThrow();
  });

  test("still blocks external effects when the protocol has not been bootstrapped", async () => {
    const cwd = await createWorkspace();
    await expect(
      materializeRoleBinding({
        roleId: "lead",
        provider: "codex",
        cwd,
        ...assignmentBinding("lead", cwd),
        assignment: {
          ...assignmentFor("lead", "delegation"),
          externalEffectBoundary: { mode: "bounded", scope: "publish release notes" },
        },
      }),
    ).rejects.toThrow(`${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: missing`);
  });

  test("treats a notebook grant as material work in preflight and role admission", async () => {
    const cwd = await createWorkspace();
    const assignment = {
      ...assignmentFor("supervisor", "delegation"),
      notebookGrant: {
        scope: "bounded Supervisor notebook authority",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    };

    expect(() =>
      preflightWorkspaceProtocolAdmission({
        cwd,
        readership: "full",
        assignment,
      }),
    ).toThrow(`${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: missing`);
    await expect(
      materializeRoleBinding({
        roleId: "supervisor",
        provider: "codex",
        cwd,
        ...assignmentBinding("supervisor", cwd),
        assignment,
      }),
    ).rejects.toThrow(`${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: missing`);
  });

  test("treats a persisted notebook grant as material during late admission", async () => {
    const cwd = await createWorkspace();
    const binding = await materializeRoleBinding({
      roleId: "supervisor",
      provider: "codex",
      cwd,
      ...assignmentBinding("supervisor", cwd),
      assignment: assignmentFor("supervisor", "read-only"),
    });
    const withNotebookGrant = {
      ...binding,
      assignment: {
        ...binding.assignment,
        notebookGrant: {
          effect: "notebook-write" as const,
          notebookId: "nb_late-admission",
          location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
          projectId: "project-1",
          scope: "late admission",
          designatedWriterId: "supervisor-1",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
      },
    };

    expect(() => assertPersistedRoleAdmissionCurrent(withNotebookGrant, cwd)).toThrow(
      `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: missing_protocol_blocks_material_assignment`,
    );
  });

  test("allows a Human-bound read-only exception for a missing protocol", async () => {
    const cwd = await createWorkspace();
    const binding = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      cwd,
      workspaceId: `workspace:${cwd}`,
      assignmentAssigner: { kind: "human-session" },
      assignment: {
        ...assignmentFor("lead"),
        protocolException: {
          reason: "Inspect repository facts needed for bootstrap.",
          scope: cwd,
          expiresAt: "2026-08-05T01:00:00.000Z",
        },
      },
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
    });

    expect(binding.workspaceProtocol.status).toBe("missing");
    expect(binding.instructions).toContain(
      "temporarily missing under an exact Human bootstrap exception",
    );
    expect(binding.assignment?.protocolExceptionExpiresAt).toBe("2026-08-05T01:00:00.000Z");
    const receiptJson = JSON.stringify(toRoleBindingReceipt(binding));
    expect(receiptJson).not.toContain("Inspect repository facts needed for bootstrap");
    expect(receiptJson).not.toContain("assignmentContract");
  });

  test("rejects resume when a bound Workspace Protocol digest has changed", async () => {
    const cwd = await createWorkspace();
    const protocolPath = join(cwd, "WORKSPACE_PROTOCOL.md");
    await writeFile(protocolPath, buildWorkspaceProtocolTemplate(cwd), "utf8");
    const binding = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      cwd,
      ...assignmentBinding("lead", cwd),
    });

    await writeFile(
      protocolPath,
      `${buildWorkspaceProtocolTemplate(cwd)}\n- local revision: changed after binding\n`,
      "utf8",
    );

    expect(() => assertPersistedRoleAdmissionCurrent(binding, cwd)).toThrow(
      `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: stale_digest`,
    );
  });

  test.each(["missing", "invalid"] as const)(
    "rejects resume when a bound Workspace Protocol becomes %s",
    async (nextStatus) => {
      const cwd = await createWorkspace();
      const protocolPath = join(cwd, "WORKSPACE_PROTOCOL.md");
      await writeFile(protocolPath, buildWorkspaceProtocolTemplate(cwd), "utf8");
      const binding = await materializeRoleBinding({
        roleId: "lead",
        provider: "codex",
        cwd,
        ...assignmentBinding("lead", cwd),
      });

      if (nextStatus === "missing") {
        await rm(protocolPath);
      } else {
        await writeFile(protocolPath, "# Workspace Protocol\n", "utf8");
      }

      expect(() => assertPersistedRoleAdmissionCurrent(binding, cwd)).toThrow(
        `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: ${nextStatus}`,
      );
    },
  );

  test("requires a fresh binding when a previously missing protocol now exists", async () => {
    const cwd = await createWorkspace();
    const binding = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      cwd,
      ...assignmentBinding("lead", cwd),
    });
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );

    expect(() => assertPersistedRoleAdmissionCurrent(binding, cwd)).toThrow(
      `${WORKSPACE_PROTOCOL_ADMISSION_ERROR}: protocol_now_present`,
    );
  });

  test("rejects expired assignment and protocol-exception leases on resume", async () => {
    const assignmentExpiresAt = "2026-08-05T01:00:00.000Z";
    const assignmentWorkspace = await createWorkspace();
    const expiringAssignment = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      cwd: assignmentWorkspace,
      workspaceId: `workspace:${assignmentWorkspace}`,
      assignmentAssigner: { kind: "human-session" },
      assignment: { ...assignmentFor("lead"), expiresAt: assignmentExpiresAt },
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(() =>
      assertPersistedRoleAdmissionCurrent(
        expiringAssignment,
        assignmentWorkspace,
        new Date("2026-08-05T02:00:00.000Z"),
      ),
    ).toThrow(`${ASSIGNMENT_CONTRACT_EXPIRED_ERROR}: expiresAt=${assignmentExpiresAt}`);

    const exceptionExpiresAt = "2026-08-05T01:30:00.000Z";
    const exceptionWorkspace = await createWorkspace();
    const expiringException = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      cwd: exceptionWorkspace,
      workspaceId: `workspace:${exceptionWorkspace}`,
      assignmentAssigner: { kind: "human-session" },
      assignment: {
        ...assignmentFor("lead"),
        protocolException: {
          reason: "Inspect exact bytes during bootstrap.",
          scope: exceptionWorkspace,
          expiresAt: exceptionExpiresAt,
        },
      },
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(() =>
      assertPersistedRoleAdmissionCurrent(
        expiringException,
        exceptionWorkspace,
        new Date("2026-08-05T02:00:00.000Z"),
      ),
    ).toThrow(
      `${ASSIGNMENT_CONTRACT_EXPIRED_ERROR}: protocolExceptionExpiresAt=${exceptionExpiresAt}`,
    );

    const malformedAssignment = {
      ...expiringAssignment,
      assignment: { ...expiringAssignment.assignment, expiresAt: "not-a-date" },
    };
    expect(() =>
      assertPersistedRoleAdmissionCurrent(malformedAssignment, assignmentWorkspace),
    ).toThrow(`${ASSIGNMENT_CONTRACT_EXPIRED_ERROR}: expiresAt=not-a-date`);
  });
  test("fails closed for a provider without a native durable role channel", async () => {
    const cwd = await createWorkspace();
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );

    expect(resolveProviderRoleBindingSupport("generic-acp")).toMatchObject({
      status: "unsupported",
    });
    await expect(
      materializeRoleBinding({
        roleId: "lead",
        provider: "generic-acp",
        cwd,
        ...assignmentBinding("lead", cwd),
      }),
    ).rejects.toThrow("no qualified native durable role-instruction channel");
  });

  test("supports Pi and OMP through their native durable instruction channels", () => {
    expect(resolveProviderRoleBindingSupport("mock")).toEqual({
      status: "supported",
      injectionMethod: "mock-launch-context",
      notice: "Development-only synthetic provider; role instructions are bound at session launch.",
    });
    expect(resolveProviderRoleBindingSupport("pi")).toEqual({
      status: "supported",
      injectionMethod: "pi-before-agent-start",
    });
    expect(resolveProviderRoleBindingSupport("custom-omp", "omp")).toEqual({
      status: "supported",
      injectionMethod: "omp-append-system-prompt",
    });
  });

  test("auto-detects qualified provider-native drivers and retires plugin projection", () => {
    expect(
      resolveProviderRoleBindingSupport("cursor", null, null, undefined, ["cursor-agent", "acp"]),
    ).toMatchObject({
      status: "supported",
      injectionMethod: "cursor-project-rule-capsule",
    });
    expect(
      resolveProviderRoleBindingSupport("gemini-antigravity", null, null, undefined, ["agy"]),
    ).toMatchObject(
      process.platform === "win32"
        ? { status: "unsupported" }
        : {
            status: "supported",
            injectionMethod: "antigravity-custom-agent",
            roleIds: ["peer"],
          },
    );
    expect(
      resolveProviderRoleBindingSupport(
        "gemini-antigravity",
        null,
        null,
        undefined,
        ["agy"],
        false,
      ),
    ).toMatchObject(
      process.platform === "win32"
        ? {
            status: "unsupported",
            reason: expect.stringContaining("not implemented on Windows"),
            roleIds: ["peer"],
          }
        : {
            status: "unsupported",
            reason: expect.stringContaining("mandatory Beads checkpoint"),
            roleIds: ["peer"],
          },
    );
    expect(
      resolveProviderRoleBindingSupport("gemini-antigravity", null, null, undefined, [
        "agy",
        "--agent",
        "default",
      ]),
    ).toMatchObject({ status: "unsupported" });
    expect(
      resolveProviderRoleBindingSupport("cursor", null, null, { driver: "cursor-plugin" }, [
        "cursor-agent",
        "acp",
      ]),
    ).toMatchObject({ status: "unsupported", reason: expect.stringContaining("retired") });
    expect(
      resolveProviderRoleBindingSupport("cursor", null, null, undefined, [
        "cursor-agent",
        "--auto-review",
        "acp",
      ]),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("permission-policy flags"),
    });
    expect(
      resolveProviderRoleBindingSupport("grok", null, null, undefined, ["grok", "agent", "stdio"]),
    ).toMatchObject({
      status: "supported",
      injectionMethod: "grok-acp-session-rules",
    });
    expect(
      resolveProviderRoleBindingSupport("custom-grok", "acp", null, undefined, [
        "grok",
        "agent",
        "--no-leader",
        "stdio",
      ]),
    ).toMatchObject({
      status: "supported",
      injectionMethod: "grok-acp-session-rules",
    });
    expect(
      resolveProviderRoleBindingSupport("grok", null, null, undefined, [
        "grok",
        "agent",
        "--plugin-dir",
        "/tmp/plugin",
        "stdio",
      ]),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("exact 'grok agent stdio'"),
    });
    expect(
      resolveProviderRoleBindingSupport(
        "grok",
        null,
        null,
        undefined,
        ["grok", "agent", "stdio"],
        false,
      ),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("mandatory Beads checkpoint"),
    });
  });

  test("limits Antigravity eligibility to Peer role materialization", async () => {
    if (process.platform === "win32") return;
    const cwd = await createWorkspace();
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );
    const support = resolveProviderRoleBindingSupport("gemini-antigravity", null, null, undefined, [
      "agy",
    ]);

    await expect(
      materializeRoleBinding({
        roleId: "lead",
        provider: "gemini-antigravity",
        providerSupport: support,
        cwd,
        ...assignmentBinding("lead", cwd),
      }),
    ).rejects.toThrow("provider eligibility is limited to role(s): peer");
    await expect(
      materializeRoleBinding({
        roleId: "peer",
        provider: "gemini-antigravity",
        providerSupport: support,
        cwd,
        ...assignmentBinding("peer", cwd),
      }),
    ).resolves.toMatchObject({
      roleId: "peer",
      injectionMethod: "antigravity-custom-agent",
    });
  });

  test("separates Antigravity role denial from the Peer transport blocker", async () => {
    if (process.platform === "win32") return;
    const cwd = await createWorkspace();
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );
    const unavailable = resolveProviderRoleBindingSupport(
      "gemini-antigravity",
      null,
      null,
      undefined,
      ["agy"],
      false,
    );

    for (const roleId of ["lead", "supervisor"] as const) {
      await expect(
        materializeRoleBinding({
          roleId,
          provider: "gemini-antigravity",
          providerSupport: unavailable,
          cwd,
          ...assignmentBinding(roleId, cwd),
        }),
      ).rejects.toThrow("provider eligibility is limited to role(s): peer");
    }
    await expect(
      materializeRoleBinding({
        roleId: "peer",
        provider: "gemini-antigravity",
        providerSupport: unavailable,
        cwd,
        ...assignmentBinding("peer", cwd),
      }),
    ).rejects.toThrow("current Antigravity runtime has no qualified native Paseo-tool transport");
  });

  test("role-bound tool policy owns enablement while provider filters can narrow it", () => {
    expect(applyRolePaseoToolPolicy(undefined, { enabled: false })).toEqual({ enabled: false });
    const leadPolicy = applyRolePaseoToolPolicy("lead", { enabled: false });
    expect(leadPolicy).toEqual({
      enabled: true,
      allowedTools: expect.arrayContaining([
        "create_agent",
        "get_agent_status",
        "beads_status",
        "beads_close",
        "list_providers",
        "list_profiles",
        "start_council",
        "record_council_seat",
      ]),
    });
    expect(leadPolicy?.allowedTools).toEqual([
      "list_workspaces",
      "list_workspace_scripts",
      "list_profiles",
      "create_agent",
      "send_agent_prompt",
      "resolve_agent_signal",
      "get_agent_status",
      "get_agent_checkpoint",
      "list_agents",
      "cancel_agent",
      "archive_agent",
      "get_agent_activity",
      "create_room",
      "start_council",
      "record_council_seat",
      "read_room",
      "post_room",
      "beads_status",
      "beads_ready",
      "beads_list",
      "beads_get",
      "beads_create",
      "beads_claim",
      "beads_update",
      "beads_close",
      "beads_add_dependency",
      "beads_prime",
      "read_project_notebook",
      "list_providers",
      "list_models",
      "inspect_provider",
      "browser_list_tabs",
      "browser_snapshot",
      "browser_wait",
      "browser_screenshot",
      "browser_logs",
    ]);
    expect(leadPolicy?.allowedTools).toHaveLength(36);
    expect(leadPolicy?.allowedTools).toEqual(
      expect.not.arrayContaining([
        "signal_agent",
        "prepare_lead_handoff",
        "transition_lead_handoff",
      ]),
    );
    expect(leadPolicy?.allowedTools).toContain("resolve_agent_signal");
    expect(leadPolicy?.allowedTools).toEqual(
      expect.arrayContaining([
        "browser_list_tabs",
        "browser_snapshot",
        "browser_wait",
        "browser_screenshot",
        "browser_logs",
      ]),
    );
    expect(
      applyRolePaseoToolPolicy("lead", undefined, ["beads_status", "beads_get", "beads_prime"]),
    ).toEqual({
      enabled: true,
      allowedTools: ["beads_status", "beads_get", "beads_prime"],
    });
    expect(leadPolicy?.allowedTools).not.toEqual(
      expect.arrayContaining([
        "browser_new_tab",
        "browser_click",
        "create_terminal",
        "create_schedule",
        "respond_to_permission",
        "create_workspace",
      ]),
    );
    expect(
      applyRolePaseoToolPolicy("lead", {
        enabled: false,
        disabledTools: ["list_agents"],
      }),
    ).toEqual({
      enabled: true,
      allowedTools: expect.not.arrayContaining(["list_agents"]),
    });
    expect(applyRolePaseoToolPolicy("peer", { enabled: false })).toEqual({
      enabled: true,
      allowedTools: expect.arrayContaining([
        "post_room",
        "beads_get",
        "beads_claim",
        "beads_update",
        "beads_add_dependency",
        "browser_list_tabs",
        "browser_snapshot",
        "browser_wait",
        "browser_screenshot",
        "browser_logs",
      ]),
    });
    expect(applyRolePaseoToolPolicy("peer", { enabled: false }, undefined, "read-only")).toEqual({
      enabled: true,
      allowedTools: expect.arrayContaining([
        "post_room",
        "beads_status",
        "beads_ready",
        "beads_list",
        "beads_get",
        "beads_prime",
      ]),
    });
    expect(
      applyRolePaseoToolPolicy("peer", { enabled: false }, undefined, "read-only")?.allowedTools,
    ).not.toEqual(
      expect.arrayContaining([
        "beads_create",
        "beads_claim",
        "beads_update",
        "beads_add_dependency",
      ]),
    );
    expect(applyRolePaseoToolPolicy("peer", { enabled: false })).toEqual({
      enabled: true,
      allowedTools: expect.not.arrayContaining(["read_room", "create_agent"]),
    });
    expect(
      applyRolePaseoToolPolicy("peer", {
        enabled: true,
        allowedTools: ["post_room", "read_room", "beads_get", "beads_close", "create_agent"],
      }),
    ).toEqual({ enabled: true, allowedTools: ["post_room", "beads_get"] });
    expect(applyRolePaseoToolPolicy("supervisor", { enabled: false })).toEqual({
      enabled: true,
      allowedTools: expect.arrayContaining([
        "get_agent_status",
        "list_agents",
        "beads_get",
        "browser_list_tabs",
        "browser_snapshot",
        "browser_wait",
        "browser_screenshot",
        "browser_logs",
      ]),
    });
    expect(
      applyRolePaseoToolPolicy("supervisor", {
        enabled: true,
        allowedTools: ["list_agents", "create_agent"],
      }),
    ).toEqual({ enabled: true, allowedTools: ["list_agents"] });
    expect(
      applyRolePaseoToolPolicy(
        "supervisor",
        { enabled: true, allowedTools: ["list_agents", "create_agent"] },
        ["create_agent", "list_agents", ...MANDATORY_ROLE_TOOLS],
      ),
    ).toEqual({ enabled: true, allowedTools: ["create_agent", "list_agents"] });
    expect(
      applyRolePaseoToolPolicy("supervisor", {
        enabled: true,
        allowedTools: ["list_agents", "get_agent_status"],
        disabledTools: ["list_agents"],
      }),
    ).toEqual({ enabled: true, allowedTools: ["get_agent_status"] });
  });
});
