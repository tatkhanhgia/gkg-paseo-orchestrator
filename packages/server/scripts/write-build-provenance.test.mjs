import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(packageRoot, "dist/server/server/policy/bundled/slp/harness");
const descriptorPath = resolve(outputRoot, "harness-package.json");
const provenancePath = resolve(packageRoot, "dist/server/build-provenance.json");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("server build Project Harness packaging", () => {
  it("copies the descriptor/resources and records their immutable provenance", () => {
    assert.ok(existsSync(descriptorPath), "packaged harness descriptor is missing");
    assert.ok(existsSync(provenancePath), "build provenance is missing");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    assert.equal(descriptor.package, "paseo-project-harness");
    assert.equal(provenance.projectHarness.package, descriptor.package);
    assert.equal(provenance.projectHarness.generation, descriptor.generation);
    assert.equal(provenance.projectHarness.descriptorDigest, sha256File(descriptorPath));
    for (const resource of provenance.projectHarness.resources) {
      const resourcePath = resolve(outputRoot, resource.path);
      assert.ok(existsSync(resourcePath), "packaged resource is missing: " + resource.key);
      assert.equal(resource.digest, sha256File(resourcePath));
    }
  });
});
