import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repositoryRoot = realpathSync(resolve(packageRoot, "../.."));
const outputPath = resolve(packageRoot, "dist/server/build-provenance.json");
const roleSourcePath = resolve(
  repositoryRoot,
  "foundation/dist/profiles/native/role-definitions.json",
);
const roleOutputPath = resolve(
  packageRoot,
  "dist/server/server/policy/bundled/slp/role-definitions.json",
);
const executionSpecializationSourcePath = resolve(
  repositoryRoot,
  "foundation/dist/profiles/native/execution-specializations.json",
);
const executionSpecializationOutputPath = resolve(
  packageRoot,
  "dist/server/server/policy/bundled/slp/execution-specializations.json",
);
const foundationHarnessSourceRoot = resolve(repositoryRoot, "foundation/dist/templates/harness");
const harnessOutputRoot = resolve(packageRoot, "dist/server/server/policy/bundled/slp/harness");
const foundationSkillsSourceRoot = resolve(repositoryRoot, "foundation/dist/skills");
const foundationSkillAdmissionSourcePath = resolve(foundationSkillsSourceRoot, "role-bundles.json");
const foundationSkillsOutputRoot = resolve(
  packageRoot,
  "dist/server/server/policy/bundled/slp/skills",
);
const productSkillsSourceRoot = resolve(repositoryRoot, "skills");
const productSkillAdmissionSourcePath = resolve(productSkillsSourceRoot, "role-admission.json");
const productSkillsOutputRoot = resolve(packageRoot, "dist/server/server/agent/product-skills");
const workspaceProtocolContractSourcePath = resolve(
  repositoryRoot,
  "foundation/dist/templates/workspace-protocol-contract.json",
);
const workspaceProtocolFixturesSourcePath = resolve(
  repositoryRoot,
  "foundation/dist/templates/workspace-protocol-fixtures.json",
);
const workspaceProtocolContractOutputPath = resolve(
  packageRoot,
  "dist/server/utils/foundation-workspace-protocol-contract.json",
);
const workspaceProtocolFixturesOutputPath = resolve(
  packageRoot,
  "dist/server/utils/foundation-workspace-protocol-fixtures.json",
);

function readFoundationSkillAdmission() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(foundationSkillAdmissionSourcePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read imported Foundation role-skill admission at ${foundationSkillAdmissionSourcePath}`,
      { cause: error },
    );
  }
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.packages ||
    typeof manifest.packages !== "object" ||
    !manifest.roles ||
    typeof manifest.roles !== "object"
  ) {
    throw new Error("Imported Foundation role-skill admission manifest is invalid");
  }
  const packageNames = Object.keys(manifest.packages);
  const packageSet = new Set(packageNames);
  if (packageNames.length === 0 || packageNames.some((name) => !/^[a-z0-9-]+$/u.test(name))) {
    throw new Error("Imported Foundation role-skill admission package names are invalid");
  }
  for (const name of packageNames) {
    if (!existsSync(resolve(foundationSkillsSourceRoot, name, "SKILL.md"))) {
      throw new Error(`Imported Foundation role-skill package '${name}' has no SKILL.md`);
    }
  }
  for (const role of ["lead", "peer", "supervisor"]) {
    const admission = manifest.roles[role];
    const states = admission
      ? [admission.active, admission.explicitOnly, admission.packagedDisabled]
      : [];
    if (
      states.length !== 3 ||
      states.some(
        (entries) => !Array.isArray(entries) || entries.some((name) => typeof name !== "string"),
      ) ||
      states.flat().some((name) => !packageSet.has(name))
    ) {
      throw new Error(`Imported Foundation role-skill admission for '${role}' is invalid`);
    }
  }
  return packageNames.sort();
}

function readProductSkillAdmission() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(productSkillAdmissionSourcePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read product role-skill admission at ${productSkillAdmissionSourcePath}`,
      { cause: error },
    );
  }
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.packages ||
    typeof manifest.packages !== "object" ||
    !manifest.roles ||
    typeof manifest.roles !== "object"
  ) {
    throw new Error("Product role-skill admission manifest is invalid");
  }
  const packageNames = Object.keys(manifest.packages);
  if (packageNames.length === 0 || packageNames.some((name) => !/^[a-z0-9-]+$/u.test(name))) {
    throw new Error("Product role-skill admission package names are invalid");
  }
  const packageSet = new Set(packageNames);
  for (const name of packageNames) {
    if (!existsSync(resolve(productSkillsSourceRoot, name, "SKILL.md"))) {
      throw new Error(`Product role-skill package '${name}' has no SKILL.md`);
    }
  }
  for (const role of ["lead", "peer", "supervisor"]) {
    const admission = manifest.roles[role];
    const states = admission
      ? [admission.active, admission.explicitOnly, admission.packagedDisabled]
      : [];
    if (
      states.length !== 3 ||
      states.some(
        (entries) => !Array.isArray(entries) || entries.some((name) => typeof name !== "string"),
      )
    ) {
      throw new Error(`Product role-skill admission for '${role}' is invalid`);
    }
    const names = states.flat();
    if (
      names.length !== packageNames.length ||
      new Set(names).size !== names.length ||
      names.some((name) => !packageSet.has(name))
    ) {
      throw new Error(`Product role-skill admission for '${role}' is not a full partition`);
    }
  }
  return packageNames.sort();
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function sourceFingerprint(sourceCommit, trackedDiff, untrackedPaths) {
  const fingerprint = createHash("sha256");
  fingerprint.update("paseo-source-fingerprint-v1\0");
  fingerprint.update(sourceCommit);
  fingerprint.update("\0tracked-diff\0");
  fingerprint.update(trackedDiff);
  for (const relativePath of untrackedPaths) {
    const absolutePath = resolve(repositoryRoot, relativePath);
    const stat = lstatSync(absolutePath);
    fingerprint.update("\0untracked\0");
    fingerprint.update(relativePath);
    fingerprint.update("\0");
    if (stat.isSymbolicLink()) {
      fingerprint.update(`symlink:${readlinkSync(absolutePath)}`);
    } else {
      fingerprint.update(readFileSync(absolutePath));
    }
  }
  return fingerprint.digest("hex");
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readSourceState() {
  if (existsSync(resolve(repositoryRoot, ".git"))) {
    const sourceCommit = git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const trackedDiff = git(["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
    const untrackedOutput = git(["ls-files", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    });
    const untrackedPaths = untrackedOutput.split("\0").filter(Boolean).sort();
    return {
      sourceCommit,
      sourceDirty: trackedDiff.length > 0 || untrackedPaths.length > 0,
      sourceFingerprint: sourceFingerprint(sourceCommit, trackedDiff, untrackedPaths),
    };
  }

  const sourceCommit = process.env.PASEO_BUILD_SOURCE_COMMIT?.trim() || null;
  if (sourceCommit && !/^[a-f0-9]{40,64}$/u.test(sourceCommit)) {
    throw new Error("PASEO_BUILD_SOURCE_COMMIT must be a 40-64 character lowercase hex digest");
  }
  if (!sourceCommit) {
    process.stderr.write(
      "Paseo build provenance: source archive has no Git metadata or PASEO_BUILD_SOURCE_COMMIT; recording source identity as unknown.\n",
    );
    return { sourceCommit: null, sourceDirty: null, sourceFingerprint: null };
  }
  process.stderr.write(
    "Paseo build provenance: source archive commit is asserted without Git metadata; recording cleanliness and fingerprint as unknown.\n",
  );
  return {
    sourceCommit,
    sourceDirty: null,
    sourceFingerprint: null,
  };
}

const sourceState = readSourceState();

const provenance = {
  schemaVersion: 1,
  sourceRoot: repositoryRoot,
  ...sourceState,
  builtAt: new Date().toISOString(),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
mkdirSync(dirname(roleOutputPath), { recursive: true });
copyFileSync(roleSourcePath, roleOutputPath);
copyFileSync(executionSpecializationSourcePath, executionSpecializationOutputPath);
mkdirSync(dirname(workspaceProtocolContractOutputPath), { recursive: true });
copyFileSync(workspaceProtocolContractSourcePath, workspaceProtocolContractOutputPath);
copyFileSync(workspaceProtocolFixturesSourcePath, workspaceProtocolFixturesOutputPath);

const harnessDescriptorSourcePath = resolve(foundationHarnessSourceRoot, "harness-package.json");
let harnessDescriptor;
try {
  harnessDescriptor = JSON.parse(readFileSync(harnessDescriptorSourcePath, "utf8"));
} catch (error) {
  throw new Error(
    `Cannot read imported Foundation Project Harness descriptor at ${harnessDescriptorSourcePath}`,
    { cause: error },
  );
}
if (
  harnessDescriptor?.schemaVersion !== 1 ||
  harnessDescriptor?.package !== "paseo-project-harness" ||
  !Number.isInteger(harnessDescriptor?.generation) ||
  !harnessDescriptor?.resources ||
  typeof harnessDescriptor.resources !== "object"
) {
  throw new Error("Imported Foundation Project Harness descriptor is invalid");
}
for (const [key, relativePath] of Object.entries(harnessDescriptor.resources)) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.split(/[\\/]/u).includes("..") ||
    !existsSync(resolve(foundationHarnessSourceRoot, relativePath))
  ) {
    throw new Error(`Imported Foundation Project Harness resource '${key}' is invalid or missing`);
  }
}
rmSync(harnessOutputRoot, { recursive: true, force: true });
cpSync(foundationHarnessSourceRoot, harnessOutputRoot, { recursive: true });
const harnessResources = Object.entries(harnessDescriptor.resources).map(([key, relativePath]) => ({
  key,
  path: relativePath,
  digest: sha256File(resolve(harnessOutputRoot, relativePath)),
}));
const harnessDescriptorDigest = sha256File(resolve(harnessOutputRoot, "harness-package.json"));
provenance.projectHarness = {
  package: harnessDescriptor.package,
  generation: harnessDescriptor.generation,
  descriptorDigest: harnessDescriptorDigest,
  artifactDigest: createHash("sha256")
    .update(
      JSON.stringify({
        package: harnessDescriptor.package,
        generation: harnessDescriptor.generation,
        descriptorDigest: harnessDescriptorDigest,
        resources: harnessResources,
      }),
    )
    .digest("hex"),
  resources: harnessResources,
};
writeFileSync(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

const foundationRoleSkillPackages = readFoundationSkillAdmission();
rmSync(foundationSkillsOutputRoot, { recursive: true, force: true });
mkdirSync(foundationSkillsOutputRoot, { recursive: true });
copyFileSync(
  foundationSkillAdmissionSourcePath,
  resolve(foundationSkillsOutputRoot, "role-bundles.json"),
);
for (const packageName of foundationRoleSkillPackages) {
  cpSync(
    resolve(foundationSkillsSourceRoot, packageName),
    resolve(foundationSkillsOutputRoot, packageName),
    { recursive: true },
  );
}

const productRoleSkillPackages = readProductSkillAdmission();
rmSync(productSkillsOutputRoot, { recursive: true, force: true });
mkdirSync(productSkillsOutputRoot, { recursive: true });
copyFileSync(
  productSkillAdmissionSourcePath,
  resolve(productSkillsOutputRoot, "role-admission.json"),
);
for (const packageName of productRoleSkillPackages) {
  cpSync(
    resolve(productSkillsSourceRoot, packageName),
    resolve(productSkillsOutputRoot, packageName),
    { recursive: true },
  );
}
