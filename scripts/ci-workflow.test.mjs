import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { relative as relativePath } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const nixUpdateHashWorkflowPath = new URL(".github/workflows/nix-update-hash.yml", repoRoot);
const websiteWorkflowPath = new URL(".github/workflows/deploy-website.yml", repoRoot);
const portableReleaseCoreWorkflowPath = new URL(
  ".github/workflows/downstream-portable-release-core.yml",
  repoRoot,
);
const portablePrereleaseWorkflowPath = new URL(
  ".github/workflows/downstream-macos-release.yml",
  repoRoot,
);
const stableReleaseWorkflowPath = new URL(
  ".github/workflows/downstream-stable-release.yml",
  repoRoot,
);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["relay-tests", { name: "relay-tests", contract: "relay" }],
  ["foundation-cli-macos", { name: "foundation-cli-macos", contract: "foundation_cli" }],
  [
    "release-qualification",
    { name: "release-qualification", contracts: ["workspace", "app", "ci"] },
  ],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of source.split("\n")) {
    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
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

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});
test("change gating allows superseded workflow runs to cancel", () => {
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
    server: ["packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/v0.8/**",
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

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
  assert.ok(electronModules.every((path) => path.startsWith("packages/app/src/desktop/")));

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

test("non-required Docker and Nix workflows avoid runners with workflow path filters", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /^\s+paths:\s*$/m);
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
