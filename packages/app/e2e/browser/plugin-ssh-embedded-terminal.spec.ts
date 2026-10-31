import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { COMPACT, WIDE, runCommand } from "../support/helpers/plugin-sidebar-items";
import { seedWorkspace } from "../support/helpers/seed-client";
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

test("Connect shows an interactive SSH terminal inside the plugin, not in the workspace tabs", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ repoPrefix: "ssh-embedded-" });
  const example = await copyPluginExample("ssh");
  const daemon = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await daemon.getDaemonConfig();
  try {
    await daemon.patchDaemonConfig({ pluginsEnabled: true });
    await daemon.installDirectoryPlugin(example.directory);

    await test.step("Connect opens the session inside the SSH screen", async () => {
      await page.setViewportSize(WIDE);
      await page.goto(`/h/${encodeURIComponent(getServerId())}/plugin/ssh/sidebar/ssh`);
      await page.getByRole("button", { name: "Add host", exact: true }).click();
      await page.getByLabel("Label (e.g. build server)").fill("e2e box");
      await page.getByLabel("Host or address").fill("e2e.example");
      await page.getByRole("button", { name: "Save host", exact: true }).click();
      await page.getByRole("button", { name: "Connect to e2e box", exact: true }).click();

      await expect(terminalSurface(page)).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(/\/plugin\/ssh\/sidebar\/ssh/);
      await expectTerminalText(page, "fake-ssh password:");
      await qaScreenshot(page, "ssh-embedded-wide-prompt");
    });

    await test.step("typed input reaches ssh and its output renders there", async () => {
      await terminalSurface(page).locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("s3cret\n");
      await expectTerminalText(page, "authenticated (6 chars)");
      await page.keyboard.type("hello\n");
      await expectTerminalText(page, "echo:hello");
      // The password was typed with echo off, so it never reached the screen.
      expect(await getTerminalBufferText(page)).not.toContain("s3cret");
      await qaScreenshot(page, "ssh-embedded-wide-session");
    });

    await test.step("the session creates no workspace terminal", async () => {
      const unowned = await daemon.listTerminals(undefined, undefined, {
        workspaceId: workspace.workspaceId,
      });
      expect(unowned.terminals).toEqual([]);
      await gotoWorkspace(page, workspace.workspaceId);
      await expectNoTerminalTabs(page);
    });

    await test.step("the SSH hosts panel reattaches to the running session", async () => {
      await runCommand(page, "SSH: Open hosts");
      await expect(page.getByRole("button", { name: "ssh e2e box", exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(terminalSurface(page)).toBeVisible();
      await expectTerminalText(page, "echo:hello");
      await expectNoTerminalTabs(page);
      await qaScreenshot(page, "ssh-embedded-wide-panel");
    });

    await test.step("a compact layout shows the same session", async () => {
      await page.setViewportSize(COMPACT);
      await expect(terminalSurface(page)).toBeVisible({ timeout: 30_000 });
      await expectTerminalText(page, "echo:hello");
      await qaScreenshot(page, "ssh-embedded-compact-panel");
    });

    await test.step("the session list drops a session when ssh exits", async () => {
      await terminalSurface(page).locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+d");
      await expect(page.getByRole("button", { name: "ssh e2e box", exact: true })).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(terminalSurface(page)).toHaveCount(0);
    });
  } finally {
    await daemon.removePlugin("ssh").catch(() => undefined);
    await daemon.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
    await daemon.close();
    await example.cleanup();
    await workspace.cleanup();
  }
});
