import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  computeRetainedHookFidelity,
  RETAINED_HOOK_FIDELITY_CHECKED_MODULES,
  type RetainedHookFidelityCheckedModule,
} from "./retained-hook-fidelity-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("computeRetainedHookFidelity against the real checked-out source tree", () => {
  test("all ten checked modules match their frozen source-form digest today", () => {
    const result = computeRetainedHookFidelity();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("checks exactly the ten modules referenced directly by buildDefaultSlpBundledPolicyContribution plus the retained-fork fixture registerRetainedSlpGenerations swaps in", () => {
    expect(RETAINED_HOOK_FIDELITY_CHECKED_MODULES.map((module_) => module_.key)).toEqual([
      "council-policy",
      "checkpoint-policy",
      "execution-profiles",
      "role-binding-policy",
      "attention-policy",
      "lifecycle-attention-policy",
      "role-profiles",
      "agent-role-binding",
      "slp-adapter",
      "retained-coordination-policy-v5",
    ]);
  });

  test("eight modules are old-equal (proven byte-identical to real installed .60); slp-adapter is reviewed-adapter; retained-coordination-policy-v5 is retained-fork", () => {
    const byKey = new Map(
      RETAINED_HOOK_FIDELITY_CHECKED_MODULES.map((module_) => [module_.key, module_.kind]),
    );
    expect(byKey.get("slp-adapter")).toBe("reviewed-adapter");
    expect(byKey.get("retained-coordination-policy-v5")).toBe("retained-fork");
    for (const module_ of RETAINED_HOOK_FIDELITY_CHECKED_MODULES) {
      if (module_.key === "slp-adapter" || module_.key === "retained-coordination-policy-v5") {
        continue;
      }
      expect(module_.kind).toBe("old-equal");
    }
  });
});

describe("computeRetainedHookFidelity against an isolated fixture directory", () => {
  async function fixtureDirectoryWith(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "paseo-hook-fidelity-"));
    temporaryDirectories.push(directory);
    await Promise.all(
      Object.entries(files).map(([name, content]) =>
        writeFile(join(directory, name), content, "utf8"),
      ),
    );
    return directory;
  }

  function moduleFor(
    relativePathNoExt: string,
    sourceDigest: string,
    distDigest: string = "0".repeat(64),
  ): RetainedHookFidelityCheckedModule {
    return {
      key: "council-policy",
      kind: "old-equal",
      relativePathNoExt,
      sourceDigest,
      distDigest,
    };
  }

  test("passes when the fixture .ts file's bytes hash to the recorded expected source digest", async () => {
    const originalBody = "export function reportSentinels(role) { return role.toUpperCase(); }\n";
    const directory = await fixtureDirectoryWith({ "fixture-module.ts": originalBody });
    const checked = [moduleFor("fixture-module", sha256(originalBody))];

    const result = computeRetainedHookFidelity(checked, directory, "source");

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("implementation-changed-with-recorded-version-unchanged counterexample: a real behavior edit to the same file is caught even though nothing in the digest LOOKS like a version field", async () => {
    // Simulates exactly the gap this guard closes: a hook module's version constant never
    // changes here, but the function body genuinely does (lowercase instead of uppercase). A
    // JSON-descriptor-only guard comparing serialized data would see nothing; this guard compares
    // the file's actual bytes, so it must fail.
    const originalBody = "export function reportSentinels(role) { return role.toUpperCase(); }\n";
    const driftedBody = "export function reportSentinels(role) { return role.toLowerCase(); }\n";
    const expectedDigest = sha256(originalBody);
    const directory = await fixtureDirectoryWith({ "fixture-module.ts": driftedBody });
    const checked = [moduleFor("fixture-module", expectedDigest)];

    const result = computeRetainedHookFidelity(checked, directory, "source");

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("council-policy: source byte fingerprint drift");
    expect(result.failures[0]).toContain(expectedDigest);
    expect(result.failures[0]).toContain(sha256(driftedBody));
  });

  test("a byte-identical no-op edit (whitespace-only) still changes the digest, proving this is a literal byte check, not a semantic/AST one", async () => {
    const originalBody = "export const X = 1;\n";
    const whitespaceOnlyDrift = "export const X = 1;\n\n";
    const directory = await fixtureDirectoryWith({ "fixture-module.ts": whitespaceOnlyDrift });
    const checked = [moduleFor("fixture-module", sha256(originalBody))];

    const result = computeRetainedHookFidelity(checked, directory, "source");

    expect(result.ok).toBe(false);
  });

  test("fails closed with a named reason when the expected form's sibling does not exist", async () => {
    const directory = await fixtureDirectoryWith({});
    const checked = [moduleFor("missing-module", "f".repeat(64))];

    const result = computeRetainedHookFidelity(checked, directory, "source");

    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain(
      "council-policy: no readable .ts sibling found next to the guard module (executing form: source)",
    );
  });

  test("checks the .ts sibling against sourceDigest when form is 'source', ignoring a co-located .js dist form entirely", async () => {
    const sourceBody = "export const FORM = 'ts';\n";
    const distBody = "export const FORM = 'js';\n";
    const directory = await fixtureDirectoryWith({
      "fixture-module.ts": sourceBody,
      "fixture-module.js": distBody,
    });
    const checked: RetainedHookFidelityCheckedModule[] = [
      moduleFor("fixture-module", sha256(sourceBody), sha256(distBody)),
    ];

    const result = computeRetainedHookFidelity(checked, directory, "source");

    expect(result.ok).toBe(true);
  });

  test("checks the .js sibling against distDigest when form is 'dist', ignoring a co-located .ts source form entirely", async () => {
    const sourceBody = "export const FORM = 'ts';\n";
    const distBody = "export const FORM = 'js';\n";
    const directory = await fixtureDirectoryWith({
      "fixture-module.ts": sourceBody,
      "fixture-module.js": distBody,
    });
    const checked: RetainedHookFidelityCheckedModule[] = [
      moduleFor("fixture-module", sha256(sourceBody), sha256(distBody)),
    ];

    const result = computeRetainedHookFidelity(checked, directory, "dist");

    expect(result.ok).toBe(true);
  });

  test("root-bug regression: mixed .ts+.js fixture where ONLY the .js compiled body drifted must fail when checked as 'dist', proving the guard never silently falls back to hashing the untouched .ts sibling instead", async () => {
    // The .ts source is byte-identical to what the frozen sourceDigest expects (an honest
    // developer edited nothing in source); the compiled .js output alone drifted (e.g. a stale
    // or hand-edited dist artifact). A guard that resolved ".ts first regardless of executing
    // form" would silently hash the untouched .ts file, see it match, and report ok — masking
    // the exact compiled-runtime drift this guard exists to catch.
    const sourceBody = "export function reportSentinels(role) { return role.toUpperCase(); }\n";
    const originalDistBody =
      "export function reportSentinels(role) { return role.toUpperCase(); }\n";
    const driftedDistBody =
      "export function reportSentinels(role) { return role.toLowerCase(); }\n";
    const directory = await fixtureDirectoryWith({
      "fixture-module.ts": sourceBody,
      "fixture-module.js": driftedDistBody,
    });
    const checked: RetainedHookFidelityCheckedModule[] = [
      moduleFor("fixture-module", sha256(sourceBody), sha256(originalDistBody)),
    ];

    const result = computeRetainedHookFidelity(checked, directory, "dist");

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("council-policy: dist byte fingerprint drift");
    expect(result.failures[0]).toContain(sha256(originalDistBody));
    expect(result.failures[0]).toContain(sha256(driftedDistBody));
  });

  test("retained-fork counterexample: a body edit to the frozen retained-coordination-policy-v5 fixture is caught even though it is a fork, not a raw .60 byte copy", async () => {
    // The "retained-fork" kind's claim is narrower than "old-equal" (it is NOT a raw-JS-identity
    // claim against real .60 coordination-policy.js — export names/shape were deliberately
    // adapted for this fixture). But it still must catch any further edit to the fixture FILE
    // ITSELF from this point forward — the same function-body-drift gap this guard closes for
    // every other checked module.
    const originalBody =
      "export const RETAINED_SLP_COORDINATION_POLICY_V5 = { denylist: [], structuralBounds: {} };\n";
    const driftedBody =
      'export const RETAINED_SLP_COORDINATION_POLICY_V5 = { denylist: ["x"], structuralBounds: {} };\n';
    const expectedDigest = sha256(originalBody);
    const directory = await fixtureDirectoryWith({
      "retained-coordination-policy-v5.ts": driftedBody,
    });
    const checked: RetainedHookFidelityCheckedModule[] = [
      {
        key: "retained-coordination-policy-v5",
        kind: "retained-fork",
        relativePathNoExt: "retained-coordination-policy-v5",
        sourceDigest: expectedDigest,
        distDigest: "0".repeat(64),
      },
    ];

    const result = computeRetainedHookFidelity(checked, directory, "source");

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(
      "retained-coordination-policy-v5: source byte fingerprint drift",
    );
    expect(result.failures[0]).toContain(expectedDigest);
    expect(result.failures[0]).toContain(sha256(driftedBody));
  });

  test("reports every failing module, not just the first", async () => {
    const directory = await fixtureDirectoryWith({ "present.ts": "export const A = 1;\n" });
    const checked: RetainedHookFidelityCheckedModule[] = [
      moduleFor("present", "0".repeat(64)),
      {
        key: "checkpoint-policy",
        kind: "old-equal",
        relativePathNoExt: "absent",
        sourceDigest: "0".repeat(64),
        distDigest: "0".repeat(64),
      },
    ];

    const result = computeRetainedHookFidelity(checked, directory, "source");

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
  });
});
