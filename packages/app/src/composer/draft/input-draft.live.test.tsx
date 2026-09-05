import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "@/stores/draft-store";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";
import { buildAssignmentEnvelope } from "@/workspace-protocol/assignment-envelope";

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async () => undefined,
}));

vi.mock("@/hooks/use-role-profiles", () => ({
  useRoleProfiles: () => ({
    catalog: {
      profiles: [
        {
          roleId: "lead",
          label: "Lead",
          description: "Lead policy from the pinned SLP catalog.",
          preferences: {},
        },
        {
          roleId: "peer",
          label: "Peer",
          description: "Peer policy from the pinned SLP catalog.",
          preferences: {
            defaults: {
              provider: "gemini-antigravity",
              model: "gemini-3-pro",
              modeId: "plan",
            },
          },
        },
        {
          roleId: "supervisor",
          label: "Supervisor",
          description: "Supervisor policy from the pinned SLP catalog.",
          preferences: {},
        },
      ],
    },
    isLoading: false,
    error: null,
    supported: true,
    refetch: async () => null,
  }),
}));

vi.mock("@/hooks/use-agent-form-state", () => ({
  useAgentFormState: () => ({
    selectedServerId: "host-1",
    setSelectedServerId: () => undefined,
    setSelectedServerIdFromUser: () => undefined,
    selectedProvider: "codex",
    selectedMode: "auto",
    setModeFromUser: () => undefined,
    selectedModel: "",
    setModelFromUser: () => undefined,
    selectedThinkingOptionId: "",
    setThinkingOptionFromUser: () => undefined,
    workingDir: "/repo",
    setWorkingDir: () => undefined,
    setWorkingDirFromUser: () => undefined,
    allProviderEntries: [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        roleBinding: {
          status: "supported",
          injectionMethod: "codex-developer-instructions",
        },
      },
      {
        provider: "gemini-antigravity",
        status: "ready",
        enabled: true,
        roleBinding: {
          status: "supported",
          injectionMethod: "antigravity-custom-agent",
          roleIds: ["peer"],
        },
      },
      {
        provider: "mock",
        status: "ready",
        enabled: true,
        roleBinding: {
          status: "unsupported",
        },
      },
    ],
    providerDefinitions: [
      { id: "codex", label: "Codex", modes: [{ id: "auto", label: "Auto" }] },
      {
        id: "gemini-antigravity",
        label: "Gemini Antigravity",
        modes: [{ id: "plan", label: "Plan" }],
      },
      { id: "mock", label: "Mock", modes: [{ id: "auto", label: "Auto" }] },
    ],
    providerDefinitionMap: new Map(),
    agentDefinition: undefined,
    modeOptions: [{ id: "auto", label: "Auto" }],
    availableModels: [
      {
        provider: "codex",
        id: "gpt-5.4",
        label: "gpt-5.4",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ],
    allProviderModels: new Map([
      [
        "codex",
        [
          {
            provider: "codex",
            id: "gpt-5.4",
            label: "gpt-5.4",
            isDefault: true,
            defaultThinkingOptionId: "high",
            thinkingOptions: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
            ],
          },
        ],
      ],
    ]),
    modelSelectorProviders: [
      {
        id: "codex",
        label: "Codex",
        modelSelection: {
          kind: "models",
          rows: [
            {
              favoriteKey: "codex:gpt-5.4",
              provider: "codex",
              providerLabel: "Codex",
              modelId: "gpt-5.4",
              modelLabel: "gpt-5.4",
              isDefault: true,
            },
          ],
        },
      },
    ],
    isAllModelsLoading: false,
    isProviderModelsRefreshing: false,
    availableThinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High", isDefault: true },
    ],
    isModelLoading: false,
    modelError: null,
    refreshProviderModels: () => undefined,
    setProviderAndModelFromUser: () => undefined,
    setProviderAndModelForRole: () => undefined,
    workingDirIsEmpty: false,
    persistFormPreferences: async () => undefined,
  }),
}));

let useAgentInputDraft: typeof import("./input-draft").useAgentInputDraft;
let resolveRolePinnedModeTransition: typeof import("./input-draft").resolveRolePinnedModeTransition;
type DraftRecordForTest = ReturnType<typeof useDraftStore.getState>["drafts"][string];

beforeAll(async () => {
  const storage = new Map<string, string>();

  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });

  ({ useAgentInputDraft, resolveRolePinnedModeTransition } = await import("./input-draft"));
});

describe("useAgentInputDraft live contract", () => {
  beforeEach(() => {
    asyncStorage.clear();
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://localhost",
    });

    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: dom.window.navigator,
      configurable: true,
    });

    useDraftStore.setState({
      drafts: {},
      createModalDraft: null,
      attachmentFocusRequestByDraftKey: {},
    });
  });

  it("restores the Human-selected mode after a temporary read-only role pin", () => {
    const pinned = resolveRolePinnedModeTransition({
      selectedMode: "bypassPermissions",
      requiredModeId: "plan",
      rememberedModeId: undefined,
      modeOptionIds: ["plan", "bypassPermissions"],
    });
    expect(pinned).toEqual({
      rememberModeId: "bypassPermissions",
      applyModeId: "plan",
      clearRememberedMode: false,
    });

    const restored = resolveRolePinnedModeTransition({
      selectedMode: "plan",
      requiredModeId: null,
      rememberedModeId: pinned.rememberModeId,
      modeOptionIds: ["plan", "bypassPermissions"],
    });
    expect(restored).toEqual({
      applyModeId: "bypassPermissions",
      clearRememberedMode: true,
    });
  });

  it("shows and clears external access grants with the derived assignment boundary", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;

    function getComposerState() {
      const composerState = latest?.composerState;
      if (!composerState) {
        throw new Error("Expected composer state");
      }
      return composerState;
    }

    function Probe() {
      latest = useAgentInputDraft({
        draftKey: "draft:external-access",
        composer: {
          initialServerId: "host-1",
          initialValues: { workingDir: "/repo" },
          isVisible: true,
          onlineServerIds: ["host-1"],
          lockedWorkingDir: "/repo",
          beadsIssueOptions: [{ id: "ps123-abc", label: "ps123-abc — Fix tracker" }],
        },
      });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => getComposerState().setRoleFromUser("lead"));
    expect(getComposerState().agentControls.draftTextFeatures).toEqual([
      expect.objectContaining({ id: "foundation_external_effects_grant" }),
    ]);

    // Doctrine's authority model defaults a Peer to "mutating", which permits a
    // bounded external boundary, so the grant field is offered immediately. Forcing
    // the Peer to read-only denies external effects and hides the field.
    await act(async () => getComposerState().setRoleFromUser("peer"));
    expect(getComposerState().agentControls.draftTextFeatures).toEqual([
      expect.objectContaining({ id: "foundation_external_effects_grant" }),
    ]);
    await act(async () =>
      getComposerState().agentControls.onSetFeature?.("foundation_assignment_effect", "read-only"),
    );
    expect(getComposerState().agentControls.draftTextFeatures).toBeUndefined();
    await act(async () => {
      getComposerState().agentControls.onSetFeature?.("foundation_beads_issue_grant", "ps123-abc");
      getComposerState().agentControls.onSetFeature?.("foundation_assignment_effect", "mutating");
    });
    expect(getComposerState().agentControls.draftTextFeatures).toEqual([
      expect.objectContaining({
        type: "text",
        label: "External access",
        description:
          "Outside-workspace resources this assignment may touch (DB, API, service). One per line.",
      }),
    ]);

    await act(async () => {
      getComposerState().agentControls.onSetFeature?.(
        "foundation_external_effects_grant",
        " read/write dev Postgres \n\n staging API\nread/write dev Postgres ",
      );
    });
    expect(getComposerState().selectedExternalEffects).toEqual([
      "read/write dev Postgres",
      "staging API",
    ]);
    expect(
      buildAssignmentEnvelope({
        roleId: "peer",
        effectClass: "mutating",
        objective: "Fix tracker",
        cwd: "/repo",
        beadsIssueIds: getComposerState().selectedBeadsIssueIds,
        externalEffects: getComposerState().selectedExternalEffects,
      }),
    ).toEqual(
      expect.objectContaining({
        externalEffectBoundary: {
          mode: "bounded",
          scope:
            "Beads Central issue/work graph for this assignment only; plus Human-leased external access: read/write dev Postgres; staging API",
        },
        resourceGrants: {
          beadsIssueIds: ["ps123-abc"],
          externalEffects: ["read/write dev Postgres", "staging API"],
        },
      }),
    );

    await act(async () => getComposerState().setRoleFromUser("supervisor"));
    expect(getComposerState().agentControls.draftTextFeatures).toBeUndefined();
    expect(getComposerState().selectedExternalEffects).toEqual([]);

    await act(async () => root.unmount());
  });

  it("hydrates persisted text and attachments and returns draft-mode composer state for a caller-provided key", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "attachment-1",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/1",
      createdAt: 1,
      fileName: "image.png",
      byteSize: 128,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe({ draftKey }: { draftKey: string }) {
      latest = useAgentInputDraft({
        draftKey,
        composer: {
          initialServerId: "host-1",
          initialValues: { workingDir: "/repo" },
          isVisible: true,
          onlineServerIds: ["host-1"],
          lockedWorkingDir: "/repo",
          beadsIssueOptions: [{ id: "ps123-abc", label: "ps123-abc — Fix tracker" }],
        },
      });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    let root: Root | null = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Probe draftKey="draft:setup" />
        </QueryClientProvider>,
      );
    });

    expect(getLatest().composerState?.agentControls.selectedProvider).toBe("codex");
    expect(getLatest().composerState?.selectedRole).toBeNull();
    expect(getLatest().composerState?.selectedAssignmentEffect).toBe("read-only");
    expect(
      getLatest().composerState?.agentControls.providerDefinitions.map(({ id }) => id),
    ).toEqual(["codex", "gemini-antigravity", "mock"]);
    expect(getLatest().composerState?.agentControls.features).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "foundation_assignment_effect" })]),
    );
    expect(getLatest().composerState?.agentControls.roleOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "lead", label: "Lead" }),
        expect.objectContaining({ id: "peer", label: "Peer" }),
        expect.objectContaining({ id: "supervisor", label: "Supervisor" }),
      ]),
    );
    await act(async () => {
      getLatest().composerState?.setRoleFromUser("peer");
    });
    expect(getLatest().composerState?.agentControls.selectedProvider).toBe("codex");
    expect(
      getLatest().composerState?.agentControls.providerDefinitions.map(({ id }) => id),
    ).toEqual(["codex", "gemini-antigravity"]);
    expect(getLatest().composerState?.agentControls.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "foundation_assignment_effect", value: "mutating" }),
        expect.objectContaining({
          id: "foundation_beads_issue_grant",
          value: null,
          options: [expect.objectContaining({ id: "ps123-abc" })],
        }),
      ]),
    );
    await act(async () => {
      getLatest().composerState?.agentControls.onSetFeature?.(
        "foundation_beads_issue_grant",
        "ps123-abc",
      );
    });
    expect(getLatest().composerState?.selectedBeadsIssueIds).toEqual(["ps123-abc"]);
    await act(async () => {
      getLatest().composerState?.agentControls.onSetFeature?.(
        "foundation_assignment_effect",
        "mutating",
      );
    });
    expect(getLatest().composerState?.selectedRole).toBe("peer");
    expect(getLatest().composerState?.selectedAssignmentEffect).toBe("mutating");
    await act(async () => {
      getLatest().composerState?.setRoleFromUser("lead");
    });
    expect(
      getLatest().composerState?.agentControls.providerDefinitions.map(({ id }) => id),
    ).toEqual(["codex"]);
    await act(async () => {
      getLatest().composerState?.agentControls.onSetFeature?.(
        "foundation_assignment_effect",
        "bootstrap",
      );
    });
    expect(getLatest().composerState?.selectedAssignmentEffect).toBe("mutating");
    await act(async () => {
      getLatest().composerState?.setRoleFromUser("peer");
    });
    expect(getLatest().composerState?.selectedAssignmentEffect).toBe("mutating");
    expect(getLatest().composerState?.agentControls.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "foundation_assignment_effect",
          options: [
            expect.objectContaining({ id: "mutating" }),
            expect.objectContaining({ id: "read-only" }),
          ],
        }),
      ]),
    );
    expect(getLatest().composerState?.commandDraftConfig).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: "auto",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });

    const hydratedTextReplacement = getLatest().textReplacement;

    await act(async () => {
      getLatest().editText("hello world");
      getLatest().setAttachments([{ kind: "image", metadata: image }]);
    });

    expect(getLatest().textReplacement).toBe(hydratedTextReplacement);

    await act(async () => {
      getLatest().replaceText("replacement text");
    });

    expect(getLatest().textReplacement).not.toBe(hydratedTextReplacement);
    expect(getLatest().textReplacement.text).toBe("replacement text");

    await act(async () => {
      getLatest().editText("hello world");
    });

    await act(async () => {
      root!.unmount();
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Probe draftKey="draft:setup" />
        </QueryClientProvider>,
      );
    });

    expect(getLatest().text).toBe("hello world");
    expect(getLatest().attachments).toEqual([{ kind: "image", metadata: image }]);
  });

  it("restores role authority and grants from a workspace draft handoff", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    function Probe() {
      latest = useAgentInputDraft({
        draftKey: "draft:role-handoff",
        composer: {
          initialServerId: "host-1",
          initialValues: { workingDir: "/repo" },
          isVisible: true,
          onlineServerIds: ["host-1"],
          lockedWorkingDir: "/repo",
          beadsIssueOptions: [{ id: "ps123-abc", label: "ps123-abc — Fix tracker" }],
          initialRoleId: "peer",
          initialAssignmentEffect: "mutating",
          initialBeadsIssueIds: ["ps123-abc"],
        },
      });
      return null;
    }
    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing root container");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    const composerState = (latest as ReturnType<typeof useAgentInputDraft> | null)?.composerState;
    expect(composerState?.selectedRole).toBe("peer");
    expect(composerState?.selectedAssignmentEffect).toBe("mutating");
    expect(composerState?.selectedBeadsIssueIds).toEqual(["ps123-abc"]);
    await act(async () => root.unmount());
  });

  it("migrates legacy image drafts to image attachments on hydration", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "legacy-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/legacy-image",
      createdAt: 10,
      fileName: "legacy.png",
      byteSize: 512,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    useDraftStore.setState({
      drafts: {
        "draft:legacy": {
          input: {
            text: "legacy text",
            images: [image],
          },
          lifecycle: "active",
          updatedAt: Date.now(),
          version: 1,
        } as unknown as DraftRecordForTest,
      },
      createModalDraft: null,
    });

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:legacy" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    expect(getLatest().text).toBe("legacy text");
    expect(getLatest().attachments).toEqual([{ kind: "image", metadata: image }]);
    expect(useDraftStore.getState().drafts["draft:legacy"]?.input).toEqual({
      text: "legacy text",
      attachments: [{ kind: "image", metadata: image }],
    });
  });

  it("hydrates drafts saved by old builds with cwd", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const githubIssue: ComposerAttachment = {
      kind: "github_issue",
      item: {
        kind: "issue",
        number: 42,
        title: "Unify attachments",
        url: "https://github.com/paseo/paseo/issues/42",
        state: "open",
        body: "body",
        labels: ["composer"],
      },
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    useDraftStore.setState({
      drafts: {
        "draft:new-shape": {
          input: {
            text: "new text",
            attachments: [githubIssue],
            cwd: "/persisted",
          },
          lifecycle: "active",
          updatedAt: Date.now(),
          version: 1,
        } as unknown as DraftRecordForTest,
      },
      createModalDraft: null,
    });

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:new-shape" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    expect(getLatest().text).toBe("new text");
    expect(getLatest().attachments).toEqual([githubIssue]);

    await act(async () => {
      root.unmount();
    });

    expect(useDraftStore.getState().drafts["draft:new-shape"]?.input).toEqual({
      text: "new text",
      attachments: [githubIssue],
      cwd: "/persisted",
    });
  });

  it("updates and persists attachments through setAttachments", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "next-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/next-image",
      createdAt: 11,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:attachments" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      getLatest().editText("with attachment");
      getLatest().setAttachments([{ kind: "image", metadata: image }]);
    });

    expect(getLatest().attachments).toEqual([{ kind: "image", metadata: image }]);
    expect(useDraftStore.getState().drafts["draft:attachments"]?.input).toEqual({
      text: "with attachment",
      attachments: [{ kind: "image", metadata: image }],
    });
  });

  it("attaches to an unmounted legacy draft without losing its input", async () => {
    const image: AttachmentMetadata = {
      id: "legacy-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/legacy-image",
      createdAt: 10,
    };
    useDraftStore.setState({
      drafts: {
        "draft:legacy-workspace-file": {
          input: { text: "legacy text", images: [image] },
          lifecycle: "active",
          updatedAt: Date.now(),
          version: 1,
        } as unknown as DraftRecordForTest,
      },
    });

    await useDraftStore.getState().attachWorkspaceFile({
      draftKey: "draft:legacy-workspace-file",
      attachment: createWorkspaceFileAttachment({ path: "src/app.ts" }),
    });

    expect(useDraftStore.getState().getDraftInput("draft:legacy-workspace-file")).toEqual({
      text: "legacy text",
      attachments: [
        { kind: "image", metadata: image },
        createWorkspaceFileAttachment({ path: "src/app.ts" }),
      ],
    });
  });

  it("clear resets text and attachments", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "clear-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/clear-image",
      createdAt: 12,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:clear" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      getLatest().editText("queued message");
      getLatest().setAttachments([{ kind: "image", metadata: image }]);
    });

    await act(async () => {
      getLatest().clear("sent");
    });

    expect(getLatest().text).toBe("");
    expect(getLatest().attachments).toEqual([]);
    expect(useDraftStore.getState().drafts["draft:clear"]?.input).toEqual({
      text: "",
      attachments: [],
    });
  });

  it("clears drafts with sent and abandoned lifecycle tombstones", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const sentImage: AttachmentMetadata = {
      id: "attachment-sent",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/sent",
      createdAt: 2,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:lifecycle" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      getLatest().editText("queued message");
      getLatest().setAttachments([{ kind: "image", metadata: sentImage }]);
    });

    await act(async () => {
      getLatest().clear("sent");
    });

    expect(getLatest().text).toBe("");
    expect(getLatest().attachments).toEqual([]);
    expect(useDraftStore.getState().drafts["draft:lifecycle"]).toMatchObject({
      lifecycle: "sent",
      input: { text: "", attachments: [] },
    });

    await act(async () => {
      getLatest().editText("draft again");
    });

    await act(async () => {
      getLatest().clear("abandoned");
    });

    expect(useDraftStore.getState().drafts["draft:lifecycle"]).toMatchObject({
      lifecycle: "abandoned",
      input: { text: "", attachments: [] },
    });
  });
});
