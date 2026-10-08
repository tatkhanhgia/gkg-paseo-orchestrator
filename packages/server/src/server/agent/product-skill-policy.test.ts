import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  claudeProductSkillDenyRules,
  filterProductSkills,
  loadProductSkillPolicy,
  mergeClaudeProductPlugins,
  mergeCodexProductSkillConfig,
} from "./product-skill-policy.js";

const temporaryRoots: string[] = [];

function bundleRoot(manifestOverride?: unknown): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-product-skills-"));
  temporaryRoots.push(root);
  const manifest =
    manifestOverride ??
    ({
      schemaVersion: 1,
      packages: { council: { provenance: "DEMONTHORN_EXACT" } },
      roles: {
        lead: { active: ["council"], explicitOnly: [], packagedDisabled: [] },
        peer: { active: [], explicitOnly: [], packagedDisabled: ["council"] },
        supervisor: { active: [], explicitOnly: [], packagedDisabled: ["council"] },
      },
    } as const);
  const packageNames =
    manifest && typeof manifest === "object" && "packages" in manifest
      ? Object.keys((manifest as { packages: Record<string, unknown> }).packages)
      : ["council"];
  for (const name of packageNames) {
    mkdirSync(path.join(root, name), { recursive: true });
    writeFileSync(path.join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  writeFileSync(path.join(root, "role-admission.json"), `${JSON.stringify(manifest)}\n`);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("product role skill policy", () => {
  test("pins Council to native specialist Peers with separate durable issues", () => {
    const councilSkill = readFileSync(
      path.resolve(import.meta.dirname, "../../../../../skills/council/SKILL.md"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    const admission = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, "../../../../../skills/role-admission.json"),
        "utf8",
      ),
    ) as { packages: { council: { provenance: string } } };

    expect(admission.packages.council.provenance).toBe("PASEO_DERIVATIVE");
    expect(councilSkill).toContain("executionProfile: solution-architect");
    expect(councilSkill).toContain("executionProfile: reviewer");
    expect(councilSkill).toContain("one separate child issue for every seat");
    expect(councilSkill).toContain("using the parent as `discoveredFrom`");
    expect(councilSkill).toContain("disposition: independent-review");
    expect(councilSkill).toContain("effectClass: read-only");
    expect(councilSkill).toContain("mutationBoundary: { mode: no-write }");
    expect(councilSkill).toContain("externalEffectBoundary: { mode: denied }");
    expect(councilSkill).toContain("beadsIssueIds: [<THIS_SEAT_CHILD_ISSUE_ID>]");
    expect(councilSkill).toContain('{"issueId":"<THIS_SEAT_CHILD_ISSUE_ID>","view":"checkpoint"}');
    expect(councilSkill).toContain(
      "Then inspect the exact authorized repository/sources read-only",
    );
    expect(councilSkill).toContain("inspect sibling issues/reports/agents");
    expect(councilSkill).toContain(
      "Do not inspect a Round 1 report until every required Round 1 seat",
    );
    expect(councilSkill).toContain("Omit `workspaceId`");
    expect(councilSkill).toContain("role: peer");
    expect(councilSkill).toContain("at most 60 characters");
    expect(councilSkill).not.toContain('relationship: { kind: "subagent" }');
    expect(councilSkill).not.toContain('workspace: { kind: "current" }');
    expect(councilSkill).toContain("the exact\n`reportMessageId` returned by that Peer");
    expect(councilSkill).toContain("Room author, sentinels, timestamp, and report digest");
    expect(councilSkill).toContain("bare `council.integrity` label alone is not a valid report");
    expect(councilSkill).toContain("at most one targeted challenge and permit one");
    expect(councilSkill).toContain("Lead issues one binding decision packet");
    expect(councilSkill).toContain("exactly three canonical seat identities");
    expect(councilSkill).not.toContain("council.role=verifier");
    expect(councilSkill).not.toContain("council.role=auditor");
    expect(councilSkill).toContain("Do not create a Council\ndaemon, database, queue");
    expect(councilSkill).not.toContain("no file operation is permitted");
    expect(councilSkill).not.toContain("the only tool operations permitted");
  });

  test("mirrors the imported Lead baseline's Council trigger criteria", () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../../../../../");
    const roleSource = JSON.parse(
      readFileSync(
        path.join(repositoryRoot, "foundation/dist/profiles/native/role-definitions.json"),
        "utf8",
      ),
    ) as { roles: { lead: string[] } };
    const trigger = roleSource.roles.lead.find((block) => block.startsWith("Council trigger:"));
    const criteria = [...(trigger ?? "").matchAll(/\([a-d]\) ([^,.—]+)/gu)].map((m) => m[1].trim());
    const skill = readFileSync(path.join(repositoryRoot, "skills/council/SKILL.md"), "utf8");
    const description = /^description: (.*)$/mu.exec(skill)?.[1] ?? "";
    const section = (/^## When to convene\n([\s\S]*?)^## /mu.exec(skill)?.[1] ?? "").replace(
      /\s+/gu,
      " ",
    );

    expect(criteria).toHaveLength(4);
    for (const criterion of criteria) {
      expect(description).toContain(criterion);
      expect(section).toContain(criterion);
    }
  });

  test("admits Council only to Lead from one canonical manifest", () => {
    const root = bundleRoot();
    const lead = loadProductSkillPolicy("lead", root);
    const peer = loadProductSkillPolicy("peer", root);
    const supervisor = loadProductSkillPolicy("supervisor", root);

    expect(lead.status).toBe("bound");
    expect([...lead.enabledNames]).toEqual(["council"]);
    expect(peer.enabledNames.size).toBe(0);
    expect(supervisor.enabledNames.size).toBe(0);
    expect(lead.skillPaths.get("council")).toBe(path.join(root, "council", "SKILL.md"));
  });

  test("keeps the mandatory Beads skill in Foundation instead of duplicating Product source", () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../../../../../");
    const productAdmission = JSON.parse(
      readFileSync(path.join(repositoryRoot, "skills/role-admission.json"), "utf8"),
    ) as { packages: Record<string, unknown> };
    const foundationAdmission = JSON.parse(
      readFileSync(path.join(repositoryRoot, "foundation/dist/skills/role-bundles.json"), "utf8"),
    ) as {
      roles: Record<"lead" | "peer" | "supervisor", { active: string[] }>;
    };

    expect(productAdmission.packages).not.toHaveProperty("beads-issue-tracker");
    expect(existsSync(path.join(repositoryRoot, "skills/beads-issue-tracker"))).toBe(false);
    expect(
      existsSync(path.join(repositoryRoot, "foundation/dist/skills/beads-issue-tracker/SKILL.md")),
    ).toBe(true);
    for (const role of ["lead", "peer", "supervisor"] as const) {
      expect(foundationAdmission.roles[role].active).toContain("beads-issue-tracker");
    }
  });

  test("fails closed when a role does not classify every package exactly once", () => {
    const root = bundleRoot({
      schemaVersion: 1,
      packages: { council: {} },
      roles: {
        lead: { active: ["council"], explicitOnly: ["council"], packagedDisabled: [] },
        peer: { active: [], explicitOnly: [], packagedDisabled: ["council"] },
        supervisor: { active: [], explicitOnly: [], packagedDisabled: ["council"] },
      },
    });

    const policy = loadProductSkillPolicy("lead", root);
    expect(policy.status).toBe("missing-or-invalid");
    expect(policy.enabledNames.size).toBe(0);
    expect(policy.packageNames).toContain("council");
  });

  test("Codex disables stale Council copies and enables only the bundled Lead copy", () => {
    const root = bundleRoot();
    const policy = loadProductSkillPolicy("lead", root);
    const merged = mergeCodexProductSkillConfig(
      [
        { path: "/custom/skills/council/SKILL.md", enabled: true },
        { path: "/custom/skills/local-review/SKILL.md", enabled: true },
      ],
      policy,
      "/home/test/.codex",
    );

    expect(merged).toContainEqual({
      path: "/custom/skills/local-review/SKILL.md",
      enabled: true,
    });
    expect(merged).toContainEqual({
      path: "/custom/skills/council/SKILL.md",
      enabled: false,
    });
    expect(merged).toContainEqual({
      path: path.join(root, "council", "SKILL.md"),
      enabled: true,
    });
  });

  test("Codex keeps Council disabled for Peer even if a caller enabled it", () => {
    const root = bundleRoot();
    const policy = loadProductSkillPolicy("peer", root);
    const merged = mergeCodexProductSkillConfig(
      [{ path: "/home/test/.codex/skills/council/SKILL.md", enabled: true }],
      policy,
      "/home/test/.codex",
    );

    expect(merged.filter((entry) => typeof entry === "object" && entry !== null)).toEqual(
      expect.arrayContaining([
        { path: "/home/test/.codex/skills/council/SKILL.md", enabled: false },
        { path: path.join(root, "council", "SKILL.md"), enabled: false },
      ]),
    );
    expect(merged).not.toContainEqual(expect.objectContaining({ enabled: true }));
  });

  test("Claude projects a session-local Lead plugin and strips it from Peer", () => {
    const root = bundleRoot();
    const existing = [
      { type: "local" as const, path: "/custom/council" },
      { type: "local" as const, path: "/custom/other-plugin" },
    ];

    expect(mergeClaudeProductPlugins(existing, loadProductSkillPolicy("lead", root))).toEqual([
      { type: "local", path: "/custom/other-plugin" },
      { type: "local", path: path.join(root, "council"), skipMcpDiscovery: true },
    ]);
    const peer = loadProductSkillPolicy("peer", root);
    expect(mergeClaudeProductPlugins(existing, peer)).toEqual([
      { type: "local", path: "/custom/other-plugin" },
    ]);
    expect(claudeProductSkillDenyRules(peer)).toEqual(["Skill(council)", "Skill(council:council)"]);
  });

  test("filters plain and namespaced Council commands for non-owning roles", () => {
    const root = bundleRoot();
    const inventory = [{ name: "council" }, { name: "council:council" }, { name: "third-party" }];

    expect(filterProductSkills(inventory, loadProductSkillPolicy("lead", root))).toEqual(inventory);
    expect(filterProductSkills(inventory, loadProductSkillPolicy("peer", root))).toEqual([
      { name: "third-party" },
    ]);
  });
});
