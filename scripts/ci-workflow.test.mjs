import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
// The GKG fork parks upstream workflows it cannot run in .github/workflows-disabled/
// (see its README). The contract stays pinned wherever the file lives, so re-enabling
// a parked workflow by moving it back does not drop its protection.
function workflowUrl(name) {
  const active = new URL(`.github/workflows/${name}`, repoRoot);
  return existsSync(active) ? active : new URL(`.github/workflows-disabled/${name}`, repoRoot);
}
const dockerWorkflowPath = workflowUrl("docker.yml");
const nixWorkflowPath = workflowUrl("nix.yml");
const nixUpdateHashWorkflowPath = workflowUrl("nix-update-hash.yml");
const websiteWorkflowPath = workflowUrl("deploy-website.yml");
const portableReleaseCoreWorkflowPath = new URL(
  ".github/workflows/downstream-portable-release-core.yml",
  repoRoot,
);
const portablePrereleaseWorkflowPath = workflowUrl("downstream-macos-release.yml");
const stableReleaseWorkflowPath = new URL(
  ".github/workflows/downstream-stable-release.yml",
  repoRoot,
);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["quality", { name: "quality", contracts: ["format", "quality", "relay", "sdk"] }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  [
    "server-integration-windows",
    { name: "server-integration (windows-latest)", contract: "server" },
  ],
  ["server-tests-macos", { name: "server-tests (macos-14, file observation)", contract: "server" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["foundation-cli-macos", { name: "foundation-cli-macos", contract: "foundation_cli" }],
  [
    "release-qualification",
    { name: "release-qualification", contracts: ["workspace", "app", "ci"] },
  ],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

// Jobs the GKG fork switched off in 1803a2f1c ("disable upstream deploy workflows and heavy
// CI jobs") because their runners, credentials or release toolchains are not configured.
// Pinned here rather than read from the YAML marker, so disabling another job is a
// deliberate edit to this list, not a comment in ci.yml.
const gkgDisabledCiJobs = new Set([
  "server-tests-windows",
  "server-integration-windows",
  "server-tests-macos",
  "foundation-cli-macos",
  "release-qualification",
  "cli-tests-1",
  "cli-tests-2",
  "cli-tests-3",
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  const disabledJobs = [...jobs]
    .filter(([, lines]) => lines.some((line) => /^    if:\s*false\b/.test(line)))
    .map(([jobId]) => jobId)
    .sort();
  assert.deepEqual(disabledJobs, [...gkgDisabledCiJobs].sort());

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    if (gkgDisabledCiJobs.has(jobId)) {
      assert.match(job, /^    if: false # GKG: disabled — \S/m);
      continue;
    }
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("pull-request checks run for every base branch, including stacked PRs", () => {
  for (const workflowPath of [ciWorkflowPath, workflowUrl("desktop-packages.yml")]) {
    const trigger = readFileSync(workflowPath, "utf8").split("jobs:", 1)[0];
    const pullRequest = trigger.match(/^  pull_request:\n((?:    .*\n)*)/m);
    assert.ok(pullRequest, `${workflowPath.pathname} runs on pull requests`);
    assert.doesNotMatch(pullRequest[1], /branches/);
  }
});
test("change gating allows superseded workflow runs to cancel", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m,
    "a newer push to any ref, main included, cancels the superseded run",
  );
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const foundationCli = jobs.get("foundation-cli-macos")?.join("\n") ?? "";
  const releaseQualification = jobs.get("release-qualification")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.match(changes, /scripts\/downstream-publish-guard\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  for (const jobId of [
    "desktop-tests-ubuntu",
    "desktop-tests-windows",
    "playwright-1",
    "playwright-2",
    "playwright-3",
    "playwright-4",
  ]) {
    assert.ok(!jobs.has(jobId), `${jobId} is validated locally`);
  }

  assert.match(foundationCli, /runs-on: macos-14/);
  assert.match(foundationCli, /test --workspace=@getpaseo\/foundation-cli/);
  for (const nodeVersion of ["20", "22", "24", "26"]) {
    assert.match(foundationCli, new RegExp(`node-version: "${nodeVersion}"`));
  }
  assert.match(foundationCli, /test:package-lifecycle --workspace=@getpaseo\/foundation-cli/);
  assert.match(foundationCli, /npm pack --dry-run --workspace=@getpaseo\/foundation-cli/);

  assert.match(releaseQualification, /npm install --global npm@11\.17\.0/);
  assert.match(releaseQualification, /npm ci/);
  assert.match(releaseQualification, /npm run release:toolchain:check/);
  assert.match(releaseQualification, /npm run acp:pin-consistency:check/);
  assert.doesNotMatch(releaseQualification, /npm run acp:version-drift:check/);
  assert.match(releaseQualification, /git diff --exit-code/);
});

test("portable release gates the downstream distribution instead of upstream release surfaces", () => {
  const source = readFileSync(portableReleaseCoreWorkflowPath, "utf8");

  assert.match(source, /^  workflow_call:\s*$/m);
  assert.match(source, /name: downstream-release-contracts/);
  assert.match(source, /npm run acp:pin-consistency:check/);
  assert.doesNotMatch(source, /npm run acp:version-drift:check/);
  assert.match(source, /npm run build:web-cli-artifact/);
  assert.match(source, /tooling_ref:/);
  assert.match(source, /TOOLING_REF: \$\{\{ inputs\.tooling_ref \}\}/);
  assert.equal(source.match(/path: \.downstream-release-tooling/gu)?.length, 2);
  assert.match(
    source,
    /node --test \.downstream-release-tooling\/scripts\/smoke-web-cli-artifact\.test\.mjs/,
  );
  assert.match(source, /node \.downstream-release-tooling\/scripts\/smoke-web-cli-artifact\.mjs/);
  assert.match(source, /PASEO_RELEASE_ARTIFACT_ROOT: \$\{\{ github\.workspace \}\}/);
  assert.match(
    source,
    /PASEO_RELEASE_SMOKE_HEALTH_TIMEOUT_MS: \$\{\{ matrix\.health_timeout_ms \}\}/,
  );
  assert.equal(source.match(/health_timeout_ms: 120000/gu)?.length, 4);
  assert.match(source, /npm run test --workspace=@getpaseo\/app --/);
  assert.doesNotMatch(source, /npx vitest run/);
  assert.match(source, /src\/composer\/draft\/create-flow\.test\.ts/);
  assert.match(source, /src\/composer\/draft\/input-draft\.live\.test\.tsx/);
  assert.match(source, /src\/utils\/agent-snapshots\.test\.ts/);
  assert.ok(
    source.indexOf("Build shared server dependencies") <
      source.indexOf("Verify downstream role-bound workspace creation"),
  );
  assert.match(source, /macos-14/);
  assert.match(source, /macos-15-intel/);
  assert.match(source, /ubuntu-22\.04/);
  assert.match(source, /windows-2025/);
  assert.match(source, /actions\/setup-python@v5/);
  assert.match(source, /python-version: "3\.13\.15"/);
  assert.match(source, /actions\/setup-go@v5/);
  assert.match(source, /go-version: "1\.26\.2"/);
  assert.match(source, /beads-central\.lock\.json'\)\.uvVersion/);
  assert.match(source, /needs: \[qualification, create-release\]/);
  assert.match(source, /needs\.qualification\.result == 'success'/);
  assert.match(source, /^  qualify-release:\s*$/m);
  assert.match(source, /name: downstream-qualified-update-manifest/);
  assert.match(source, /needs: \[qualification, build\]/);
  assert.match(source, /scripts\/create-paseo-update-manifest\.mjs/);
  assert.match(source, /GITHUB_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(source, /artifacts\/paseo-update-manifest\.json/);
  assert.match(source, /gh release delete-asset "\$RELEASE_TAG" paseo-update-manifest\.json/);
  assert.ok(
    source.indexOf('gh release delete-asset "$RELEASE_TAG" paseo-update-manifest.json') <
      source.indexOf("Upload verified release assets"),
  );
  assert.ok(
    source.indexOf("Create final qualified update manifest") <
      source.indexOf("Publish final update qualification sentinel"),
  );
  assert.ok(
    source.indexOf("Publish final update qualification sentinel") <
      source.indexOf("Publish qualified GitHub Release"),
  );
  assert.doesNotMatch(source, /build:desktop|android:release|release:publish|npm publish/);
});

test("stable and prerelease entrypoints pin separate modes on one portable core", () => {
  const core = readFileSync(portableReleaseCoreWorkflowPath, "utf8");
  const prerelease = readFileSync(portablePrereleaseWorkflowPath, "utf8");
  const stable = readFileSync(stableReleaseWorkflowPath, "utf8");

  assert.doesNotMatch(core, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(core, /^  push:\s*$/m);
  assert.match(core, /RELEASE_PRERELEASE: \$\{\{ inputs\.prerelease \}\}/);
  assert.match(core, /git cat-file -t "\$RELEASE_TAG"/);
  assert.match(core, /Existing release mode mismatch/);
  assert.match(core, /--draft/);
  assert.match(core, /release_args\+=\(--prerelease --latest=false\)/);
  assert.match(core, /Publish qualified GitHub Release/);
  assert.match(core, /--draft=false/);
  assert.match(core, /--prerelease=false/);
  assert.match(core, /--latest/);

  assert.match(prerelease, /^name: Downstream Portable Qualification \/ Prerelease$/m);
  assert.match(prerelease, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(prerelease, /^  push:\s*$/m);
  assert.match(prerelease, /uses: \.\/\.github\/workflows\/downstream-portable-release-core\.yml/);
  assert.match(prerelease, /tooling_ref: \$\{\{ github\.sha \}\}/);
  assert.match(prerelease, /publish: \$\{\{ inputs\.publish \}\}/);
  assert.match(prerelease, /prerelease: true/);

  assert.match(stable, /^name: Downstream Stable Release$/m);
  assert.match(stable, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(stable, /^  push:\s*$/m);
  assert.match(stable, /validate-stable-tag/);
  assert.match(stable, /Expected an exact 40-character source commit/);
  assert.match(stable, /git merge-base --is-ancestor/);
  assert.match(stable, /must exist before stable dispatch/);
  assert.doesNotMatch(stable, /git tag -a|tag -a "\$RELEASE_TAG"/);
  assert.doesNotMatch(stable, /git push origin "refs\/tags\/\$RELEASE_TAG"/);
  assert.match(stable, /needs: validate-tag/);
  assert.match(stable, /uses: \.\/\.github\/workflows\/downstream-portable-release-core\.yml/);
  assert.match(stable, /tooling_ref: \$\{\{ github\.sha \}\}/);
  assert.match(stable, /publish: true/);
  assert.match(stable, /prerelease: false/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["plugins/**", "packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/app/src/**/*.electron.{ts,tsx}",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    foundation_cli: [
      "packages/foundation-cli/**",
      "foundation/**",
      "control-workspace/**",
      "docs/foundation-product.md",
      "scripts/import-foundation.mjs",
    ],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("server build provenance check runs in CI after the build that produces it", () => {
  // The check is a node:test file that reads dist/, so the server vitest suite excludes it;
  // this pins the CI step that keeps it a gate.
  const serverPackage = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  );
  assert.equal(
    serverPackage.scripts["test:build-provenance"],
    "node --test scripts/write-build-provenance.test.mjs",
  );
  const job = jobBlocks(readFileSync(ciWorkflowPath, "utf8")).get("typecheck");
  const jobHeader = job.slice(0, job.indexOf("    steps:"));
  assert.ok(
    jobHeader.some((line) => line.startsWith("    if: ${{ !cancelled() && (")),
    "typecheck job must keep its change gating, not be disabled",
  );
  assert.ok(!job.some((line) => /continue-on-error/.test(line)), "typecheck must fail the run");

  // One entry per step: the lines from its `- ` marker up to the next step.
  const steps = [];
  for (const line of job.slice(job.indexOf("    steps:") + 1)) {
    if (line.startsWith("      - ")) steps.push([]);
    steps.at(-1)?.push(line.trim().replace(/^- /, ""));
  }
  const stepIndex = (run) => steps.findIndex((step) => step.includes(`run: ${run}`));
  const build = stepIndex("npm run build:server");
  const provenance = stepIndex("npm run test:build-provenance --workspace=@getpaseo/server");
  assert.ok(build >= 0, "typecheck job no longer builds the server");
  assert.ok(provenance > build, "build provenance check must run after npm run build:server");
  assert.ok(
    !steps[provenance].some((line) => line.startsWith("if:")),
    "build provenance step must not carry its own if",
  );
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/app/src/**/*.electron.{ts,tsx}",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("packaging runs on main without allocating pull-request runners", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(trigger, /pull_request/);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

test("Nix hash updates remain verifiable without upstream bot credentials", () => {
  const source = readFileSync(nixUpdateHashWorkflowPath, "utf8");

  assert.match(
    source,
    /PASEO_BOT_CONFIGURED: \$\{\{ secrets\.PASEO_BOT_APP_ID != '' && secrets\.PASEO_BOT_APP_PRIVATE_KEY != '' \}\}/,
  );
  assert.match(source, /if: env\.PASEO_BOT_CONFIGURED == 'true'/);
  assert.match(source, /app-id: \$\{\{ secrets\.PASEO_BOT_APP_ID \}\}/);
  assert.match(source, /private-key: \$\{\{ secrets\.PASEO_BOT_APP_PRIVATE_KEY \}\}/);
  assert.match(source, /token: \$\{\{ steps\.app-token\.outputs\.token \|\| github\.token \}\}/);
  assert.match(
    source,
    /if: steps\.app-token\.outputs\.token == ''\s+run: git diff --exit-code package-lock\.json nix\/npm-deps\.hash/,
  );
  assert.match(
    source,
    /if: steps\.app-token\.outputs\.token != ''\s+run: \|\s+git diff --quiet package-lock\.json nix\/npm-deps\.hash/,
  );
});

test("website builds remain verifiable without Cloudflare credentials", () => {
  const source = readFileSync(websiteWorkflowPath, "utf8");
  const build = "run: npm run build --workspace=@getpaseo/website";
  const deploy = "run: cd packages/website && npx wrangler deploy";

  assert.match(
    source,
    /CLOUDFLARE_DEPLOY_CONFIGURED: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN != '' \}\}/,
  );
  assert.match(source, /if: env\.CLOUDFLARE_DEPLOY_CONFIGURED == 'true'/);
  assert.match(source, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.ok(source.includes(build));
  assert.ok(source.includes(deploy));
  assert.ok(source.indexOf(build) < source.indexOf(deploy));
  assert.doesNotMatch(source, /run: npm run deploy --workspace=@getpaseo\/website/);
});

test("desktop packaging smokes main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(workflowUrl("desktop-packages.yml"), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

test("stable iOS releases upload once and distribute to external testers before App Store review", () => {
  const source = readFileSync(
    new URL("packages/app/.eas/workflows/release-mobile.yml", repoRoot),
    "utf8",
  );
  const jobs = jobBlocks(source);
  const uploads = [...jobs.entries()].filter(
    ([, lines]) =>
      lines.some((line) => /^    type: (submit|testflight)$/.test(line)) &&
      lines.some((line) => line.includes("needs.build_ios.outputs.build_id")),
  );
  assert.equal(uploads.length, 1, "the iOS binary must be uploaded exactly once");
  const [distributionId, distributionLines] = uploads[0];
  const distribution = distributionLines.join("\n");
  assert.match(distribution, /^    type: testflight$/m);
  assert.match(distribution, /external_groups:\s*\n\s+- Paseo Beta/);
  assert.match(distribution, /^      submit_beta_review: true$/m);

  const review = jobs.get("submit_ios_for_review").join("\n");
  assert.match(review, new RegExp(`needs: \\[build_ios, ${distributionId}\\]`));
  assert.match(review, /APP_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_version \}\}"/);
  assert.match(
    review,
    /APP_BUILD_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_build_version \}\}"/,
  );
  assert.match(review, /bundle exec fastlane ios submit_review/);
});

test("quality preserves commands and routes each domain independently after failures", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quality = jobs.get("quality").join("\n");
  assert.doesNotMatch(quality, /^\s+continue-on-error:/m);
  const commands = {
    format: ["npm run format:check"],
    quality: [
      "npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
      "npm audit signatures",
      "npm run lint",
      "node --test scripts/oxlint/paseo-plugin.test.mjs",
    ],
    relay: ["npm run build:relay", "npm run test --workspace=@getpaseo/relay"],
    sdk: [
      "npm run build:relay && npm run build:client",
      "npm run build:plugin",
      "npm run test --workspace=@getpaseo/plugin",
      "npm run test --workspace=@getpaseo/protocol",
      "npm run test --workspace=@getpaseo/client",
      "npm run test --workspace=@getpaseo/highlight",
      "npm run typecheck:examples --workspace=@getpaseo/client",
    ],
  };
  const checks = [...quality.matchAll(/        if: \$\{\{ (.+) \}\}\n        run: (.+)/g)];
  assert.deepEqual(
    checks.map(([, , command]) => command),
    Object.values(commands).flat(),
  );
  const domains = Object.keys(commands);
  function accepts(expression, outputs, { cancelled = false, installed = true } = {}) {
    // Prior checks have failed: success() is false. Explicit !cancelled() must
    // override Actions' default success condition so later domains still run.
    assert.match(expression, /!cancelled\(\)/);
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      steps: { install: { outcome: installed ? "success" : "failure" } },
      cancelled: () => cancelled,
      success: () => false,
    });
  }
  const disabled = { full: "false", ...Object.fromEntries(domains.map((key) => [key, "false"])) };
  const jobCondition = /    if: \$\{\{ (.+) \}\}/.exec(quality)[1];
  assert.equal(accepts(jobCondition, disabled), false);
  for (const selected of domains) {
    const outputs = { ...disabled, [selected]: "true" };
    assert.equal(accepts(jobCondition, outputs), true);
    for (const [, expression, command] of checks) {
      assert.equal(accepts(expression, outputs), commands[selected].includes(command), command);
    }
  }
  for (const [, expression] of checks) {
    assert.equal(accepts(expression, { ...disabled, full: "true" }), true);
    assert.equal(accepts(expression, {}), true, "missing routing outputs fail open");
    assert.equal(accepts(expression, {}, { cancelled: true }), false);
    assert.equal(accepts(expression, {}, { installed: false }), false);
  }
  assert.equal(accepts(jobCondition, {}, { cancelled: true }), false);
});

test("Windows units and integration run independently with complete routed coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const ubuntu = jobs.get("server-tests-ubuntu").join("\n");
  const windows = jobs.get("server-tests-windows").join("\n");
  const integration = jobs.get("server-integration-windows").join("\n");
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/server/);
  assert.match(windows, /run: npm run test:unit --workspace=@getpaseo\/server/);
  assert.doesNotMatch(windows, /run: npm run test(?: |:integration)/);
  assert.match(integration, /run: npm run test:integration --workspace=@getpaseo\/server/);
  assert.doesNotMatch(integration, /test:unit|server_plugin_tests|server_hub_contract/);
  for (const job of [windows, integration]) {
    assert.match(job, /^    needs: changes$/m, "both phases become eligible independently");
    assert.match(job, /^    runs-on: windows-latest$/m);
    assert.doesNotMatch(job, /continue-on-error|maxWorkers|--exclude/);
    for (const step of [
      "server_capacity",
      "server_checkout",
      "server_node",
      "server_fetch",
      "server_install",
      "server_agent_clis",
      "server_build",
    ]) {
      assert.match(ubuntu, new RegExp(`&${step}\\b`));
      assert.match(job, new RegExp(`- \\*${step}\\b`));
    }
    assert.match(job, /env: \*server_test_env/);
  }
  assert.match(windows, /- \*server_plugin_tests/);
  assert.match(windows, /- \*server_hub_contract/);
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/builtin-plugins/);
  assert.match(ubuntu, /run: npm run test:hub-cli-contract --workspace=@getpaseo\/server/);

  const scripts = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  ).scripts;
  assert.equal(scripts.test, "npm run test:unit && npm run test:integration");
  assert.equal(scripts["test:unit"], 'vitest run --fileParallelism --exclude "**/*.e2e.test.ts"');
  const invocations = scripts["test:integration"].split(" && ");
  // Each vitest start costs about half a minute on Windows, so the four
  // name-filtered files share one invocation and one combined filter.
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((command) => command.startsWith("vitest run --maxWorkers=1 ")));
  assert.doesNotMatch(invocations[0], / -t /);
  assert.equal(
    invocations[1],
    'vitest run --maxWorkers=1 src/server/daemon-e2e/git-operations.e2e.test.ts src/server/session.create-agent-worktree-autoarchive.e2e.test.ts src/server/agent/providers/opencode-bridge.local.e2e.test.ts src/server/daemon-e2e/relay-transport.e2e.test.ts -t "merges into|creates a worktree and auto-archives both|versioned runtime|oversized attachments|connected hosts|password-protected daemon refuses"',
  );
  const serverConfig = readFileSync(new URL("packages/server/vitest.config.ts", repoRoot), "utf8");
  assert.doesNotMatch(serverConfig, /maxWorkers/);

  function condition(job) {
    return /    if: \$\{\{ (.+) \}\}/.exec(job)[1];
  }
  function selected(expression, outputs, cancelled = false) {
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      cancelled: () => cancelled,
    });
  }
  // GKG gates both Windows jobs off with `if: false`; the gated-checks test owns that
  // contract, so only enabled jobs carry a routing condition to evaluate here.
  const unitCondition = gkgDisabledCiJobs.has("server-tests-windows") ? null : condition(windows);
  const integrationCondition = gkgDisabledCiJobs.has("server-integration-windows")
    ? null
    : condition(integration);
  const unitStep = /      - name: Run server unit tests\n        if: \$\{\{ (.+) \}\}/.exec(
    windows,
  )[1];
  const hubStep =
    /      - &server_hub_contract\n        name: Run Hub CLI\/daemon contract\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  const pluginStep =
    /      - &server_plugin_tests\n        name: Run built-in plugin tests\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  for (const [outputs, units, integrations, hub] of [
    [{ full: "true", server: "false", hub: "false" }, true, true, false],
    [{ full: "false", server: "true", hub: "false" }, true, true, false],
    [{ full: "false", server: "false", hub: "true" }, true, false, true],
    [{ full: "false", server: "false", hub: "false" }, false, false, false],
    [{}, true, true, false],
  ]) {
    if (unitCondition) assert.equal(selected(unitCondition, outputs), units);
    if (integrationCondition) assert.equal(selected(integrationCondition, outputs), integrations);
    assert.equal(selected(unitStep, outputs), integrations);
    assert.equal(selected(pluginStep, outputs), integrations);
    assert.equal(selected(hubStep, outputs), hub);
    if (unitCondition) assert.equal(selected(unitCondition, outputs, true), false);
    if (integrationCondition) assert.equal(selected(integrationCondition, outputs, true), false);
  }
});
