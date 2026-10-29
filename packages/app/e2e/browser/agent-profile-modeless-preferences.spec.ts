import { expect, test, type Page } from "../support/fixtures";
import path from "node:path";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import {
  applyProfileFromPicker,
  openModelPicker,
  seedAgentProfiles,
  seedModelProvider,
} from "../support/helpers/agent-profiles";
import { gotoAppShell } from "../support/helpers/app";
import { captureWorkspaceAgentRequest } from "../support/helpers/creation";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";
const MODELESS_PROVIDER = "modeless-profile-e2e";
const MODELESS_MODEL = "pi-profile-model";

async function seedPoisonedModelessPreference(page: Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, provider, model }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          provider,
          providerPreferences: {
            [provider]: { model, mode: "full-access" },
            mock: { model: "ten-second-stream", mode: "load-test" },
          },
        } satisfies FormPreferences),
      );
    },
    {
      preferencesKey: CREATE_AGENT_PREFERENCES_KEY,
      provider: MODELESS_PROVIDER,
      model: MODELESS_MODEL,
    },
  );
}

async function readProviderFeaturePreferences(page: Page, provider: string): Promise<unknown> {
  return page.evaluate(
    ({ preferencesKey, providerId }) => {
      const raw = localStorage.getItem(preferencesKey);
      if (!raw) return null;
      const preferences = JSON.parse(raw) as FormPreferences;
      return preferences.providerPreferences?.[providerId]?.featureValues ?? null;
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY, providerId: provider },
  );
}

test.describe("Agent profiles repair modeless preferences within provider policy", () => {
  test.describe.configure({ timeout: 240_000 });

  test("a stale preference cannot expose an unsupported Pi provider", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "profile-modeless-preferences-" });
    const provider = await seedModelProvider({
      id: MODELESS_PROVIDER,
      label: "Pi profile test",
      extends: "pi",
      command: [process.execPath, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")],
      models: [
        {
          id: MODELESS_MODEL,
          label: "Pi profile model",
          description: "Modeless profile regression model",
        },
      ],
    });
    await seedPoisonedModelessPreference(page);

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });
      await openModelPicker(page);
      await expect(page.getByTestId(`model-provider-${MODELESS_PROVIDER}`)).toHaveCount(0);
      await expect(page.getByText("Pi profile model", { exact: true })).toHaveCount(0);
    } finally {
      await workspace.cleanup();
      await provider.restore();
    }
  });

  test("a custom Codex profile survives immediate workspace creation", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "profile-feature-transition-" });
    const featureProviderId = "profile-feature-e2e";
    const featureModelId = "gpt-5.4-mini";
    const profiles = await seedAgentProfiles([
      {
        id: "agent_profile_feature_transition",
        name: "Fast profile",
        provider: featureProviderId,
        model: featureModelId,
        modeId: "full-access",
        featureValues: { fast_mode: true },
      },
    ]);
    const provider = await seedModelProvider({
      id: featureProviderId,
      label: "Profile feature test",
      models: [
        {
          id: featureModelId,
          label: "Profile feature model",
          description: "Cross-provider feature regression model",
        },
      ],
    });
    const createAgentRecorder = await captureWorkspaceAgentRequest(page, { block: true });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });

      await openModelPicker(page);
      await expect(page.getByTestId(`model-provider-${featureProviderId}`)).toBeVisible({
        timeout: 30_000,
      });
      await applyProfileFromPicker(page, "Fast profile");
      await expect
        .poll(() => readProviderFeaturePreferences(page, featureProviderId), { timeout: 10_000 })
        .toEqual({ fast_mode: true });
      await submitNewWorkspacePrompt(page, "Create an agent with profile features.");

      const createAgentRequest = await createAgentRecorder.waitForRequest();
      expect(createAgentRequest).toMatchObject({
        config: {
          provider: featureProviderId,
          model: featureModelId,
          modeId: "full-access",
          featureValues: { fast_mode: true },
        },
      });
    } finally {
      await workspace.cleanup();
      await provider.restore();
      await profiles.restore();
    }
  });
});
