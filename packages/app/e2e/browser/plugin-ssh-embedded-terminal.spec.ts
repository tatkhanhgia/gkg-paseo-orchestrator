import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { composerLocator } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { COMPACT, WIDE } from "../support/helpers/plugin-sidebar-items";
import { getServerId } from "../support/helpers/server-id";
import { getTerminalBufferText } from "../support/helpers/terminal-perf";
import { expectNoTerminalTabs } from "../support/helpers/workspace-tabs";

// CI has no ssh server. A stand-in `ssh` asks for a password with echo off, then echoes each line.
const fakeSshBin = mkdtempSync(path.join(tmpdir(), "paseo-fake-ssh-"));
writeFileSync(
  path.join(fakeSshBin, "ssh"),
  `#!/bin/sh
printf 'fake-ssh password: '
stty -echo
IFS= read -r secret
stty echo
printf '\\r\\nauthenticated (%s chars)\\r\\n' "\${#secret}"
while IFS= read -r line; do printf 'echo:%s\\r\\n' "$line"; done
`,
);
chmodSync(path.join(fakeSshBin, "ssh"), 0o755);

test.use({
  e2eDaemonEnvironment: { PATH: `${fakeSshBin}${path.delimiter}${process.env.PATH ?? ""}` },
});
test.afterAll(() => rmSync(fakeSshBin, { recursive: true, force: true }));

/** Set PASEO_QA_SCREENSHOT_DIR to keep a screenshot of each state. */
async function qaScreenshot(page: Page, name: string) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

function terminalSurface(page: Page) {
  return page.getByTestId("terminal-surface").filter({ visible: true });
}

async function expectTerminalText(page: Page, text: string) {
  await expect.poll(() => getTerminalBufferText(page), { timeout: 30_000 }).toContain(text);
}

function sessionChips(page: Page) {
  return page.getByRole("button", { name: "ssh e2e box", exact: true }).filter({ visible: true });
}

/** Types the password (echo is off), then a line, and expects ssh to answer both. */
async function driveSession(page: Page, input: { password: string; line: string }) {
  await expectTerminalText(page, "fake-ssh password:");
  await terminalSurface(page).locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(`${input.password}\n`);
  await expectTerminalText(page, `authenticated (${input.password.length} chars)`);
  await page.keyboard.type(`${input.line}\n`);
  await expectTerminalText(page, `echo:${input.line}`);
}

/** Runs `/ssh e2e box` from the agent's composer in the workspace. */
async function runSshSlashCommand(page: Page, agentId: string) {
  await page
    .getByTestId(`workspace-tab-agent_${agentId}`)
    .filter({ visible: true })
    .first()
    .click();
  const composer = composerLocator(page);
  await expect(composer).toBeEditable({ timeout: 30_000 });
  await composer.fill("/ssh e2e box");
  await composer.press("Enter");
}

test("Connect and /ssh show interactive SSH terminals inside the plugin, owned by no workspace", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "ssh-embedded-",
    title: "ssh embedded",
    initialPrompt: "Prepare an ssh embedded terminal test agent.",
  });
  const example = await copyPluginExample("ssh");
  const daemon = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await daemon.getDaemonConfig();
  // The daemon's owned terminals of the ssh plugin, in the seeded workspace and on the whole host.
  async function ownedTerminalCounts() {
    const inWorkspace = await daemon.listTerminals(undefined, undefined, {
      workspaceId: workspace.workspaceId,
      owner: "plugin:ssh",
    });
    const onHost = await daemon.listTerminals(undefined, undefined, { owner: "plugin:ssh" });
    return { inWorkspace: inWorkspace.terminals.length, onHost: onHost.terminals.length };
  }
  try {
    await daemon.patchDaemonConfig({ pluginsEnabled: true });
    await daemon.installDirectoryPlugin(example.directory);

    await test.step("Connect opens the session inside the SSH screen without choosing a workspace", async () => {
      await page.setViewportSize(WIDE);
      await page.goto(`/h/${encodeURIComponent(getServerId())}/plugin/ssh/sidebar/ssh`);
      await page.getByRole("button", { name: "Add host", exact: true }).click();
      await page.getByLabel("Label (e.g. build server)").fill("e2e box");
      await page.getByLabel("Host or address").fill("e2e.example");
      await page.getByRole("button", { name: "Save host", exact: true }).click();
      await page.getByRole("button", { name: "Connect to e2e box", exact: true }).click();

      await expect(terminalSurface(page)).toBeVisible({ timeout: 30_000 });
      // The screen has rendered, and it never asked for a workspace.
      await expect(page.getByText("Target workspace", { exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/plugin\/ssh\/sidebar\/ssh/);
      await expectTerminalText(page, "fake-ssh password:");
      await qaScreenshot(page, "ssh-embedded-wide-prompt");
    });

    await test.step("typed input reaches ssh and its output renders there", async () => {
      await driveSession(page, { password: "s3cret", line: "hello" });
      // The password was typed with echo off, so it never reached the screen.
      expect(await getTerminalBufferText(page)).not.toContain("s3cret");
      await qaScreenshot(page, "ssh-embedded-wide-session");
    });

    await test.step("the session is one terminal the plugin owns, in no workspace", async () => {
      expect(await ownedTerminalCounts()).toEqual({ inWorkspace: 0, onHost: 1 });
      const unowned = await daemon.listTerminals(undefined, undefined, {
        workspaceId: workspace.workspaceId,
      });
      expect(unowned.terminals).toEqual([]);
      await openAgentRoute(page, workspace);
      await expectNoTerminalTabs(page);
    });

    await test.step("/ssh opens the SSH hosts panel on its new session and reattaches the running one", async () => {
      await runSshSlashCommand(page, workspace.agentId);
      await expect(sessionChips(page)).toHaveCount(2, { timeout: 30_000 });
      // The new session is the one shown: a fresh prompt, none of the first session's output.
      await driveSession(page, { password: "pw2", line: "second" });
      expect(await getTerminalBufferText(page)).not.toContain("echo:hello");
      expect(await ownedTerminalCounts()).toEqual({ inWorkspace: 0, onHost: 2 });
      await expectNoTerminalTabs(page);
      await qaScreenshot(page, "ssh-embedded-wide-panel");
    });

    await test.step("/ssh while the panel is open adds and shows the next session", async () => {
      await runSshSlashCommand(page, workspace.agentId);
      await expect(sessionChips(page)).toHaveCount(3, { timeout: 30_000 });
      await driveSession(page, { password: "pw33", line: "third" });
      expect(await getTerminalBufferText(page)).not.toContain("echo:second");
      expect(await ownedTerminalCounts()).toEqual({ inWorkspace: 0, onHost: 3 });
    });

    await test.step("a chip switches back to the first, still running, session", async () => {
      await sessionChips(page).first().click();
      await expectTerminalText(page, "echo:hello");
    });

    await test.step("a compact layout shows the newest running session", async () => {
      await page.setViewportSize(COMPACT);
      await expect(terminalSurface(page)).toBeVisible({ timeout: 30_000 });
      await expectTerminalText(page, "echo:third");
      await qaScreenshot(page, "ssh-embedded-compact-panel");
    });

    await test.step("the session list drops a session when ssh exits", async () => {
      await terminalSurface(page).locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+d");
      await expect(sessionChips(page)).toHaveCount(2, { timeout: 30_000 });
      await expectNoTerminalTabs(page);
    });

    await test.step("archiving the workspace leaves the sessions running in the SSH screen", async () => {
      expect((await daemon.archiveWorkspace(workspace.workspaceId)).error).toBeNull();
      expect(await ownedTerminalCounts()).toEqual({ inWorkspace: 0, onHost: 2 });
      await page.setViewportSize(WIDE);
      await page.goto(`/h/${encodeURIComponent(getServerId())}/plugin/ssh/sidebar/ssh`);
      await expect(sessionChips(page)).toHaveCount(2, { timeout: 30_000 });
      await sessionChips(page).first().click();
      await expectTerminalText(page, "echo:hello");
    });

    await test.step("removing the plugin ends its sessions", async () => {
      await daemon.removePlugin("ssh");
      await expect.poll(ownedTerminalCounts, { timeout: 30_000 }).toEqual({
        inWorkspace: 0,
        onHost: 0,
      });
    });
  } finally {
    await daemon.removePlugin("ssh").catch(() => undefined);
    await daemon.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
    await daemon.close();
    await example.cleanup();
    await workspace.cleanup();
  }
});
