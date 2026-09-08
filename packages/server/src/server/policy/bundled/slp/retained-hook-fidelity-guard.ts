import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static byte-fingerprint drift guard for the modules `buildDefaultSlpBundledPolicyContribution()`
 * (slp.ts) references DIRECTLY when building the contribution object the retained .60 owner
 * reuses live: `SLP_COUNCIL_POLICY` (council-policy.ts), `SLP_CHECKPOINT_POLICY`
 * (checkpoint-policy.ts), `SLP_EXECUTION_PROFILE_POLICY` (execution-profiles.ts),
 * `SLP_ROLE_BINDING_POLICY` (role-binding-policy.ts), `eventPolicies`
 * (attention-policy.ts / lifecycle-attention-policy.ts), `buildRoleProfileCatalog`
 * (role-profiles.ts), and the `materializeRoleBindingWithPolicy` engine
 * (`../../agent/role-binding.ts`) — plus slp.ts itself, the adapter that wires all of the above
 * together and additionally implements the retained-generation machinery — plus the frozen
 * `retained-coordination-policy-v5.ts` fork that `registerRetainedSlpGenerations` swaps in as the
 * retained `.60` owner's `coordinationPolicy`.
 *
 * Why this exists in addition to `buildCanonicalSlpArtifactBytesForCoordinationVersion`: that
 * guard's `canonicalSlpArtifactBytes()` is a `JSON.stringify` of DATA (role/execution-profile
 * definitions, tool ceilings, version strings, skill/harness descriptors) — `JSON.stringify`
 * silently drops function VALUES, so a function-body-only change to any reused hook module that
 * leaves every version string unchanged is completely invisible to that guard. This module closes
 * that gap with a plain byte fingerprint of each checked module's own source file. It is
 * intentionally NOT a behavioral probe: nothing here imports or calls into any policy function, so
 * registering the retained generation never executes any checked module's logic — only reads
 * already-shipped adjacent source files from disk, the same read-only pattern already used by
 * `skill-policy.ts` and `harness-package-policy.ts` at this same registry-population call site.
 *
 * Three different `kind`s of frozen expectation, not one uniform claim:
 * - `"old-equal"`: council-policy, checkpoint-policy, execution-profiles, role-binding-policy,
 *   attention-policy, lifecycle-attention-policy, role-profiles, and `agent/role-binding.ts`.
 *   The `.60` equivalence claim is proven at the COMPILED level only: this candidate's current
 *   checked-out `*.ts` source, run through a fresh `tsc` build, produces `*.js` output that is
 *   byte-identical to the real installed `0.7.0-paseo.60` release's compiled dist today.
 *   `sourceDigest` is a fingerprint of CURRENT `*.ts` source —
 *   it is NOT a claim that this candidate's `.ts` bytes equal some original `.60` `.ts` source;
 *   no original `.60` TypeScript source was read or is being claimed equal, only the installed
 *   `.60` compiled JS was diffed against a fresh build of current TS. `sourceDigest` exists purely
 *   to freeze the dev/test-mode (`.ts`-via-tsx/vitest) form going forward from today, so any future
 *   edit to this candidate's own source is caught even before the next `tsc` build.
 * - `"reviewed-adapter"`: slp.ts. This file is NOT byte-identical to the real .60 slp.js — it is
 *   the modified bridge that implements the retained-generation feature itself (this candidate's
 *   own change). Its frozen digest is a forward-only "reviewed, don't silently drift further from
 *   this point" baseline, not a claim that it still equals .60's slp.js. Read-and-fingerprint only
 *   — this guard never edits slp.ts.
 * - `"retained-fork"`: retained-coordination-policy-v5.ts. NOT an `"old-equal"` raw-JS-identity
 *   claim — this file is an AST-qualified fork of `.60`'s coordination-policy (same policy
 *   semantics/contribution, but export names/module shape were deliberately adapted for the
 *   `retained-coordination-policy-v5` module rather than kept as a literal byte copy of the real
 *   `.60` coordination-policy.js — see the frozen-fork provenance already established for this
 *   fixture elsewhere in this candidate). This guard's own claim for this `kind` is narrower and
 *   purely mechanical: byte-for-byte immutability of the fork FILE ITSELF going forward from
 *   today, both in source and freshly-compiled form — i.e. it catches any further edit
 *   (intentional or accidental) to this already-qualified fixture, the same function-body-drift
 *   gap this whole guard exists to close for the other nine files.
 * `agent/role-binding.ts` and `retained-coordination-policy-v5.ts` are read-and-fingerprinted as
 * evidence only; this guard has no permission to edit either file and does not.
 *
 * Bounded coverage, not a universal transitive graph freeze: nine of the ten checked modules above
 * are each one `buildDefaultSlpBundledPolicyContribution()` references DIRECTLY; the tenth
 * (`retained-coordination-policy-v5.ts`, `"retained-fork"`) is the one fixture
 * `registerRetainedSlpGenerations` swaps in as the retained owner's `coordinationPolicy`. Their own
 * further imports (e.g. role-binding-policy.ts's own imports of assignment-policy.ts,
 * harness-package-policy.ts, role-definitions.ts, skill-policy.ts) are intentionally NOT separately
 * walked and fingerprinted — that would be exactly the open-ended transitive expansion this guard
 * is scoped to avoid. harness-package-policy.ts and skill-policy.ts are partially mitigated
 * regardless: they already embed content digests of the real skill/harness files they read into the
 * DATA descriptor the other guard checks. `role-definitions.ts`'s DATA is likewise already covered
 * that same indirect way (its content flows into `role-definitions.json`, which the other guard's
 * DATA descriptor digest-checks) — only its IMPLEMENTATION logic is not separately fingerprinted by
 * either guard, and that is the actual residual gap for this module, narrower than "uncovered
 * entirely". `assignment-policy.ts` has no such mitigation: the other guard's DATA descriptor
 * carries only a version label for it, not a content digest, so it remains a fully named,
 * unmitigated residual gap, not a silent claim of coverage.
 *
 * Source vs compiled: the daemon runs from compiled `dist/*.js` in production and from `*.ts` via
 * tsx/vitest in dev/test. Both forms are frozen below, captured once at candidate authorship time
 * by (a) hashing the current `*.ts` source files directly, and (b) running `tsc` to build this
 * exact source and hashing the resulting `*.js` output. At runtime this module derives which form
 * it is itself executing as (`.ts` vs `.js`, from its own `import.meta.url`) and hashes ONLY the
 * checked module's sibling in that exact same form — never the other one. A compiled `.js` guard
 * never falls back to hashing an adjacent `.ts` source file, and vice versa: hashing the wrong
 * form would validate bytes that are not the ones actually running. If the exact expected form is
 * not readable, that is treated as a guarded-module read failure and fails closed identically to a
 * hash mismatch.
 */

export type RetainedHookFidelityModuleKey =
  | "council-policy"
  | "checkpoint-policy"
  | "execution-profiles"
  | "role-binding-policy"
  | "attention-policy"
  | "lifecycle-attention-policy"
  | "role-profiles"
  | "agent-role-binding"
  | "slp-adapter"
  | "retained-coordination-policy-v5";

export interface RetainedHookFidelityCheckedModule {
  key: RetainedHookFidelityModuleKey;
  /**
   * "old-equal": proven byte-identical to real installed .60 (raw JS identity). "reviewed-adapter":
   * frozen-from-now only, no .60-equivalence claim. "retained-fork": an already AST-qualified fork
   * of .60 semantics (not raw-JS-identical — export names/shape deliberately differ); this guard's
   * claim for that kind is narrower: byte-for-byte immutability of the fork file itself.
   */
  kind: "old-equal" | "reviewed-adapter" | "retained-fork";
  /** Path with no extension, resolved relative to this guard module's own directory. */
  relativePathNoExt: string;
  /** sha256 of the current `*.ts` source file. */
  sourceDigest: string;
  /** sha256 of the `tsc`-compiled `*.js` output for the same source. */
  distDigest: string;
}

export const RETAINED_HOOK_FIDELITY_CHECKED_MODULES: readonly RetainedHookFidelityCheckedModule[] =
  [
    {
      key: "council-policy",
      kind: "old-equal",
      relativePathNoExt: "council-policy",
      sourceDigest: "efa7847d38626322cce24dd1dbfb1aff7d666e927f57ea34690e5bf4d4c20b95",
      distDigest: "35f5b14614149070fa3784f4f4927e781c3eec5e27630b8e8a2bb851f14c4418",
    },
    {
      key: "checkpoint-policy",
      kind: "old-equal",
      relativePathNoExt: "checkpoint-policy",
      sourceDigest: "425f62819d11a177b0014ee4265554548e0336c31ee9825663d04e7eb39a281d",
      distDigest: "4d22bb384a87ead6d8fd33d11bef34e2aa22edf478c5589fa1b8a30d0c3314e4",
    },
    {
      key: "execution-profiles",
      kind: "old-equal",
      relativePathNoExt: "execution-profiles",
      sourceDigest: "ac847d85baca6338838b65a7b51da82f4e14f39508c4b5fddeb6dc3b915bae26",
      distDigest: "5f3c481e127c48d06bc3f0a9964655b4ca2a12fdcf7c34285344e789339f9492",
    },
    {
      key: "role-binding-policy",
      kind: "old-equal",
      relativePathNoExt: "role-binding-policy",
      sourceDigest: "032e7023416697b85bf3773313a60eb384c66a06044de02bc04442002cecaccf",
      distDigest: "6d36d30d59896e3cd6357cbac9093e723e2235d3d95d5e85c6f124f687f12a50",
    },
    {
      key: "attention-policy",
      kind: "old-equal",
      relativePathNoExt: "attention-policy",
      sourceDigest: "9d7ab9545cd441c56e2368bb7d735709ba4142b125ae93e757621ac9a8e8415b",
      distDigest: "327e40bc7fbd4ced1f0f6c134e239621ee875b4dd9542c31fbb5e3ddf56f6160",
    },
    {
      key: "lifecycle-attention-policy",
      kind: "old-equal",
      relativePathNoExt: "lifecycle-attention-policy",
      sourceDigest: "a77be86218b6f649f6b8716b50017ac4957cbc630c8b01f2352be53ac807d287",
      distDigest: "4dfa95fe950c8b3b033b4b360a4aea7203330b642bc6c795558cce9fab2a0c61",
    },
    {
      key: "role-profiles",
      kind: "old-equal",
      relativePathNoExt: "role-profiles",
      sourceDigest: "a17042566e6f5bed2c77d430be9880a00bdcabff0f2a8e07b7b379b67a506f3a",
      distDigest: "781b71b98368844cebde0fa186105c7070a79edc80dbdc9e4768b04099b40d43",
    },
    {
      key: "agent-role-binding",
      kind: "old-equal",
      relativePathNoExt: "../../../agent/role-binding",
      sourceDigest: "cbf5db16ead7fe48c5828e8591c7c619751b2e61456c006abac7b4c5016b0936",
      distDigest: "bcb1c3871aebfbbe07421ac4cd1dd0f5c98824cb037e0d530177b1904d4bf082",
    },
    {
      key: "slp-adapter",
      kind: "reviewed-adapter",
      relativePathNoExt: "../slp",
      sourceDigest: "a3d2d933c4d2f758c79c07e697d9ec2066743a8ac940e8d252f250c01d584b99",
      distDigest: "a6c6d62de708356f88515d637db398515c5e2d221fc0db2ebf4184983ad166fb",
    },
    {
      key: "retained-coordination-policy-v5",
      kind: "retained-fork",
      relativePathNoExt: "retained-coordination-policy-v5",
      sourceDigest: "373603907803b1ab038d703dd2c20ce8f3631b6d12a4e2f08fd812c9d020d376",
      distDigest: "c47934ce0b84101cd99ef9804e98c0d7e73446f25408ea5b01c2abf9358741ad",
    },
  ];

export interface RetainedHookFidelityCheckResult {
  ok: boolean;
  failures: string[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function moduleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Derives which form this guard module itself is executing as: `.ts` under tsx/vitest,
 * `.js` from compiled dist. The checked modules MUST be hashed in that same form — a
 * `.js` runtime that fell back to hashing an adjacent `.ts` source file (or vice versa)
 * would silently validate bytes that are not the ones actually running.
 */
function executingGuardForm(): "source" | "dist" {
  const ownPath = fileURLToPath(import.meta.url);
  if (ownPath.endsWith(".ts")) return "source";
  if (ownPath.endsWith(".js")) return "dist";
  throw new Error(
    `retained-hook-fidelity-guard: cannot derive executing form from own module path ${ownPath}`,
  );
}

/**
 * Resolves the checked module's sibling file in exactly the given `form` — never the other
 * form. No `.ts`-first/`.js`-fallback behavior: if the exact form this guard is executing as
 * is not present next to it, that is a guarded-module read failure, not a reason to hash a
 * different (possibly stale or possibly ahead) sibling file under the wrong expected digest.
 */
function resolveCheckedModuleFile(
  directory: string,
  relativePathNoExt: string,
  form: "source" | "dist",
): { path: string; form: "source" | "dist" } | undefined {
  const extension = form === "source" ? ".ts" : ".js";
  const path = resolve(directory, `${relativePathNoExt}${extension}`);
  if (existsSync(path)) return { path, form };
  return undefined;
}

/**
 * Recomputes byte fingerprints for every checked module against whichever form is present next
 * to this guard's own running file, and compares against the frozen expected digest for that
 * form. Never throws: a missing file, a read error, or a hash mismatch is reported as a failure
 * entry rather than an exception, so the caller (`registerRetainedSlpGenerations`) decides how to
 * fail closed.
 *
 * `baseDirectory` defaults to this guard module's own directory (production behavior) and exists
 * as a parameter only so tests can point the exact same resolution/hash/compare logic at an
 * isolated fixture directory instead of monkeypatching `fs` or writing into the real source tree.
 *
 * `form` defaults to whatever this guard module is itself executing as (production behavior:
 * `.ts` under tsx/vitest, `.js` from compiled dist) and exists as a parameter only so tests can
 * force a specific form against a fixture directory without needing two separate running copies
 * of this guard module. There is no runtime auto-fallback between forms — see
 * `resolveCheckedModuleFile`.
 */
export function computeRetainedHookFidelity(
  checkedModules: readonly RetainedHookFidelityCheckedModule[] = RETAINED_HOOK_FIDELITY_CHECKED_MODULES,
  baseDirectory: string = moduleDirectory(),
  form: "source" | "dist" = executingGuardForm(),
): RetainedHookFidelityCheckResult {
  const failures: string[] = [];
  for (const checked of checkedModules) {
    const resolved = resolveCheckedModuleFile(baseDirectory, checked.relativePathNoExt, form);
    if (!resolved) {
      failures.push(
        `${checked.key}: no readable ${form === "source" ? ".ts" : ".js"} sibling found next to the guard module (executing form: ${form})`,
      );
      continue;
    }
    let actualDigest: string;
    try {
      actualDigest = sha256(readFileSync(resolved.path));
    } catch (error) {
      failures.push(
        `${checked.key}: unreadable at ${resolved.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const expectedDigest = resolved.form === "source" ? checked.sourceDigest : checked.distDigest;
    if (actualDigest !== expectedDigest) {
      failures.push(
        `${checked.key}: ${resolved.form} byte fingerprint drift at ${resolved.path} (expected ${expectedDigest}, computed ${actualDigest})`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}
