import { describe, expect, it } from "vitest";
import { classifySshFailure } from "./ssh-transport";

// The stderr lines below are what OpenSSH prints, not text this module produced.
describe("classifySshFailure", () => {
  it("tells the user a password-only host needs a key or ssh-agent", () => {
    expect(classifySshFailure("deploy@10.0.0.5: Permission denied (publickey,password).")).toEqual({
      code: "auth",
      message: "This host needs a key or ssh-agent for file browsing; the terminal still works.",
    });
  });

  it("tells the user to connect once in the terminal for an unknown host key", () => {
    const failure = classifySshFailure(
      "No ED25519 host key is known for build.example.com and you have requested strict checking.\nHost key verification failed.\n",
    );
    expect(failure.code).toBe("host-key");
    expect(failure.message).toContain("Connect once with the terminal");
  });

  it("does not advise accepting a changed host key", () => {
    const failure = classifySshFailure(
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n",
    );
    expect(failure.code).toBe("host-key");
    expect(failure.message).toContain("changed");
    expect(failure.message).not.toContain("accept it");
  });

  it("reports a missing SFTP subsystem", () => {
    expect(classifySshFailure("subsystem request failed on channel 0\n").code).toBe("subsystem");
  });

  it("keeps the reason for an unreachable host, without control characters", () => {
    const failure = classifySshFailure(
      "ssh: connect to host 10.0.0.9 port 22: Connection refused\u001b[31m\n",
    );
    expect(failure.code).toBe("connect");
    expect(failure.message).toBe(
      "Could not connect: ssh: connect to host 10.0.0.9 port 22: Connection refused [31m",
    );
  });

  it("falls back to a bounded generic message", () => {
    const failure = classifySshFailure(`odd: ${"x".repeat(1000)}`);
    expect(failure.code).toBe("failed");
    expect(failure.message.length).toBeLessThan(330);
  });
});
