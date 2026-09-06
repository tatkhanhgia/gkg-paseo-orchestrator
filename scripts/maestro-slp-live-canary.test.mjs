import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReplayPlan,
  parseReplayArgs,
  validateLoopbackHttpUrl as validateReplayUrl,
} from "./maestro-slp-replay.mjs";
import {
  LOOPBACK_REDIRECT_POLICY,
  parseLiveCanaryArgs,
  resolveLiveCanaryUrls,
  validateLoopbackHttpUrl as validateLiveUrl,
} from "./maestro-slp-live-canary.mjs";

test("advertised dashed replay flags parse through the imported pure API", () => {
  const parsed = parseReplayArgs([
    "--case",
    "/tmp/replay-case.json",
    "--source-commit",
    "abc123",
    "--daemon-url",
    "https://localhost:7443",
    "--output",
    "/tmp/replay-plan.json",
  ]);

  assert.equal(parsed.values.case, "/tmp/replay-case.json");
  assert.equal(parsed.values["source-commit"], "abc123");
  assert.equal(parsed.values["daemon-url"], "https://localhost:7443");
  assert.equal(parsed.values.output, "/tmp/replay-plan.json");
});

test("advertised dashed live-canary flags parse and resolve without execution", () => {
  const parsed = parseLiveCanaryArgs([
    "--daemon-url",
    "https://localhost:7443",
    "--beads-url",
    "http://[::1]:6769/health/ready",
    "--project",
    "/tmp/project",
    "--role-canary",
    "/tmp/role-canary.json",
    "--output",
    "/tmp/readback.json",
  ]);

  assert.equal(parsed.values["daemon-url"], "https://localhost:7443");
  assert.equal(parsed.values["beads-url"], "http://[::1]:6769/health/ready");
  assert.equal(parsed.values.project, "/tmp/project");
  assert.equal(parsed.values["role-canary"], "/tmp/role-canary.json");
  assert.deepEqual(resolveLiveCanaryUrls(parsed.values), {
    daemonUrl: "https://localhost:7443",
    beadsUrl: "http://[::1]:6769/health/ready",
  });

  const plan = buildReplayPlan({ "daemon-url": "http://127.0.0.1:6767" }, "0.7.0-paseo.57");
  assert.equal(plan.candidateVersion, "0.7.0-paseo.57");
  assert.equal(plan.daemonUrl, "http://127.0.0.1:6767");
});

test("URL overrides are loopback-only, credential-free, and redirect-blocked", () => {
  for (const value of [
    "http://127.0.0.1:6767",
    "https://localhost:7443",
    "http://[::1]:6769/health/ready",
  ]) {
    assert.equal(validateLiveUrl(value), value.replace(/\/$/u, ""));
    assert.equal(validateReplayUrl(value), value.replace(/\/$/u, ""));
  }

  for (const value of [
    "https://example.com",
    "http://127.0.0.1.evil.test:6767",
    "ftp://127.0.0.1:6767",
    "http://user:pass@127.0.0.1:6767",
  ]) {
    assert.throws(() => validateLiveUrl(value));
    assert.throws(() => validateReplayUrl(value));
  }

  assert.equal(LOOPBACK_REDIRECT_POLICY, "error");
});
