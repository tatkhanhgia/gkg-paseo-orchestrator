import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PASEO_TOOL_MANIFEST } from "@getpaseo/protocol/paseo-tool-manifest";

import { buildWorkspaceProtocolTemplate } from "../../utils/workspace-protocol-file.js";
import { loadFoundationSkillPolicy } from "./foundation-skill-policy.js";
import { loadProductSkillPolicy } from "./product-skill-policy.js";
import { applyRolePaseoToolPolicy } from "./role-binding.js";
import { materializeRoleBinding } from "./legacy-role-binding.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("E1 role-overlay counterfactual", () => {
  test("keeps the mandatory checkpoint while reducing Lead context and tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-e1-role-overlay-"));
    temporaryDirectories.push(cwd);
    await writeFile(
      join(cwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(cwd),
      "utf8",
    );
    const binding = await materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      cwd,
      workspaceId: "workspace-e1",
      assignmentAssigner: { kind: "human-session" },
      assignment: {
        version: 1,
        disposition: "lead-direct",
        objective: "Inspect the bounded counterfactual fixture.",
        effectClass: "read-only",
        mutationBoundary: { mode: "no-write" },
        externalEffectBoundary: { mode: "denied" },
        evidence: "Return exact inspected evidence.",
        handbackAndStop: "Stop after the bounded handback.",
      },
    });
    const policy = loadFoundationSkillPolicy("lead");
    const skillPath = policy.skillPaths.get("beads-issue-tracker");
    if (!skillPath) throw new Error("E1 requires the canonical beads-issue-tracker package");
    const skillBytes = Buffer.byteLength(readFileSync(skillPath, "utf8"), "utf8");
    const compactAdmission = binding.instructions
      .split("\n\n")
      .find((part) => part.startsWith("Role skill admission:"));
    if (!compactAdmission) throw new Error("E1 compact skill admission is missing");
    const currentInstructionBytes = Buffer.byteLength(binding.instructions, "utf8");
    const legacyInlineBytes =
      currentInstructionBytes -
      Buffer.byteLength(compactAdmission, "utf8") +
      skillBytes +
      Buffer.byteLength(
        'Mandatory role-projected skill package:\n\n<paseo-role-skill name="beads-issue-tracker">\n\n\n\n</paseo-role-skill>',
        "utf8",
      );

    const leadTools = applyRolePaseoToolPolicy("lead", undefined)?.allowedTools ?? [];
    const readOnlyBrowserTools = new Set([
      "browser_list_tabs",
      "browser_snapshot",
      "browser_wait",
      "browser_screenshot",
      "browser_logs",
    ]);
    const forbiddenGroups = new Set(["Browser", "Terminals", "Schedules"]);
    const forbiddenToolIds = new Set(
      PASEO_TOOL_MANIFEST.filter(
        (tool) => forbiddenGroups.has(tool.group) && !readOnlyBrowserTools.has(tool.id),
      ).map((tool) => tool.id),
    );

    expect(binding.instructions).toContain("Mandatory Beads Central checkpoint");
    expect(binding.instructions).not.toContain("<paseo-role-skill");
    expect(legacyInlineBytes - currentInstructionBytes).toBeGreaterThan(3_000);
    expect(leadTools.length).toBeLessThan(38);
    expect(leadTools).toHaveLength(36);
    expect(leadTools).toContain("list_profiles");
    expect(leadTools).toEqual(
      expect.arrayContaining([
        "resolve_agent_signal",
        "start_council",
        "record_council_seat",
        "get_agent_checkpoint",
        "read_project_notebook",
      ]),
    );
    expect(leadTools).toEqual(expect.arrayContaining([...readOnlyBrowserTools]));
    expect(leadTools.some((tool) => forbiddenToolIds.has(tool))).toBe(false);

    const roleBundle = JSON.parse(
      readFileSync(join(dirname(policy.manifestPath), "role-bundles.json"), "utf8"),
    ) as {
      roles: Record<string, { active: string[]; explicitOnly: string[] }>;
    };
    for (const role of ["lead", "peer", "supervisor"]) {
      const foundationAdmitted = [
        ...roleBundle.roles[role]!.active,
        ...roleBundle.roles[role]!.explicitOnly,
      ];
      const productPolicy = loadProductSkillPolicy(role as "lead" | "peer" | "supervisor");
      const admitted = new Set([...foundationAdmitted, ...productPolicy.enabledNames]);
      expect(admitted.size, `${role} skill admission`).toBeLessThan(10);
    }

    process.stdout.write(
      `${JSON.stringify({
        catalogTools: PASEO_TOOL_MANIFEST.length,
        leadTools: leadTools.length,
        skillBytes,
        legacyInlineBytes,
        currentInstructionBytes,
        savedInstructionBytes: legacyInlineBytes - currentInstructionBytes,
      })}\n`,
    );
  });
});
