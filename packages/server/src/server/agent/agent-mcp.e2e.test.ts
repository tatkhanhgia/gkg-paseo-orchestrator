import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  Client as ModernMcpClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import pino from "pino";

import { withTimeout } from "../../utils/promise-timeout.js";
import { hashDaemonPassword } from "../auth.js";
import {
  createPaseoDaemon as createProductionPaseoDaemon,
  type PaseoDaemonConfig,
} from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { buildWorkspaceProtocolTemplate } from "../../utils/workspace-protocol-file.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";

interface StructuredContent {
  [key: string]: unknown;
}

interface McpToolResult {
  structuredContent?: StructuredContent;
  content?: Array<
    { structuredContent?: StructuredContent; text?: string; type?: string } | StructuredContent
  >;
  isError?: boolean;
}

interface McpClient {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

const createPaseoDaemon = (
  config: PaseoDaemonConfig,
  logger: Parameters<typeof createProductionPaseoDaemon>[1],
) => createProductionPaseoDaemon(config, logger, { trustedSembleRuntime: null });

async function waitForPathExists(options: {
  targetPath: string;
  timeoutMs: number;
}): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (existsSync(options.targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for path: ${options.targetPath}`);
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    if (content.structuredContent) return content.structuredContent;
  }
  if (content && typeof content === "object") {
    return content;
  }
  return null;
}

async function createMcpClient(url: string, authToken?: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : undefined,
  );
  const rawClient = await experimental_createMCPClient({ transport });
  const boundCallTool: McpClient["callTool"] = Reflect.get(rawClient, "callTool").bind(rawClient);
  return { callTool: boundCallTool, close: () => rawClient.close() };
}

async function createModernMcpClient(url: string, authToken?: string): Promise<McpClient> {
  const transport = new ModernStreamableHTTPClientTransport(
    new URL(url),
    authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : undefined,
  );
  const rawClient = new ModernMcpClient(
    { name: "paseo-modern-e2e", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await rawClient.connect(transport);
  return {
    callTool: async ({ name, args }) =>
      (await rawClient.callTool({ name, arguments: args })) as McpToolResult,
    close: () => rawClient.close(),
  };
}

async function expectMcpToolRejection(
  action: () => Promise<McpToolResult>,
  expectedMessage: string,
): Promise<void> {
  let result: McpToolResult | null = null;
  let caught: unknown;
  try {
    result = await action();
  } catch (error) {
    caught = error;
  }
  if (caught !== undefined) {
    expect(caught instanceof Error ? caught.message : String(caught)).toContain(expectedMessage);
    return;
  }
  expect(result?.isError).toBe(true);
  expect(JSON.stringify(result)).toContain(expectedMessage);
}

function requireAgentId(result: McpToolResult): string {
  const agentId = getStructuredContent(result)?.agentId;
  if (typeof agentId !== "string" || !agentId) {
    throw new Error(`MCP create_agent returned no agentId: ${JSON.stringify(result)}`);
  }
  return agentId;
}

function roleAssignment(
  role: "lead" | "peer" | "supervisor",
  cwd = "/tmp/paseo-role-assignment",
): AssignmentEnvelope {
  const disposition = {
    lead: "lead-direct",
    peer: "peer-execution",
    supervisor: "supervision",
  } as const;
  const effectClass = role === "lead" ? "mutating" : "read-only";
  return {
    version: 1,
    disposition: disposition[role],
    objective: `Exercise the ${role} MCP topology contract.`,
    effectClass,
    mutationBoundary:
      effectClass === "mutating" ? { mode: "bounded-write", scope: cwd } : { mode: "no-write" },
    externalEffectBoundary:
      effectClass === "mutating"
        ? {
            mode: "bounded",
            scope:
              "Beads Central issue/work graph for this assignment only; no other external effects",
          }
        : { mode: "denied" },
    ...(role === "peer" ? { resourceGrants: { beadsIssueIds: ["test-peer-issue"] } } : {}),
    evidence: "Return the daemon-issued role and topology receipts.",
    handbackAndStop: "Stop after the topology assertion or a material blocker.",
  };
}

interface OfflineMcpDaemon {
  client: McpClient;
  stop: () => Promise<void>;
}

async function startOfflineMcpDaemon(): Promise<OfflineMcpDaemon> {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
  const removeDirectories = async () => {
    await rm(paseoHome, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  };
  const port = await getAvailablePort();
  const daemon = await createPaseoDaemon(
    {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    },
    pino({ level: "silent" }),
  ).catch(async (error: unknown) => {
    await removeDirectories();
    throw error;
  });
  try {
    await daemon.start();
    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);
    return {
      client,
      stop: async () => {
        await client.close();
        await daemon.stop();
        await removeDirectories();
      },
    };
  } catch (error) {
    await daemon.stop();
    await removeDirectories();
    throw error;
  }
}

type WorkspaceCreation = { workspaceId: unknown } | { error: unknown };

async function createLocalWorkspace(client: McpClient, cwd: string): Promise<WorkspaceCreation> {
  const result = await client.callTool({
    name: "create_workspace",
    args: { isolation: "local", path: cwd },
  });
  if (result.isError) {
    const content = result.content?.[0];
    return { error: content && "text" in content ? content.text : undefined };
  }
  return { workspaceId: getStructuredContent(result)?.workspaceId };
}

async function listWorkspaces(client: McpClient): Promise<WorkspaceCreation[]> {
  const result = await client.callTool({ name: "list_workspaces", args: {} });
  const workspaces = getStructuredContent(result)?.workspaces;
  if (!Array.isArray(workspaces)) return [];
  return workspaces.map((workspace: StructuredContent) => ({ workspaceId: workspace.workspaceId }));
}

interface LaunchRecorder {
  recordedLaunches: AgentSessionConfig[];
}

class RecordingAgentClient implements AgentClient {
  readonly provider: AgentClient["provider"];
  readonly capabilities: AgentClient["capabilities"];

  constructor(
    private readonly inner: AgentClient,
    private readonly recorder: LaunchRecorder,
  ) {
    this.provider = inner.provider;
    this.capabilities = {
      ...inner.capabilities,
      supportsMcpServers: true,
      supportsNativePaseoTools: false,
    };
  }

  async createSession(
    ...args: Parameters<AgentClient["createSession"]>
  ): ReturnType<AgentClient["createSession"]> {
    this.recorder.recordedLaunches.push(args[0]);
    return this.inner.createSession(...args);
  }

  async resumeSession(
    ...args: Parameters<AgentClient["resumeSession"]>
  ): ReturnType<AgentClient["resumeSession"]> {
    return this.inner.resumeSession(...args);
  }

  async fetchCatalog(
    ...args: Parameters<AgentClient["fetchCatalog"]>
  ): ReturnType<AgentClient["fetchCatalog"]> {
    return this.inner.fetchCatalog(...args).then((catalog) => {
      if (this.provider !== "claude") return catalog;
      return {
        ...catalog,
        models: [
          ...catalog.models,
          {
            provider: "claude" as const,
            id: "claude-test-model",
            label: "Claude Test Model",
            isDefault: false,
          },
        ],
      };
    });
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

function createMcpRecordingAgentClients(recorder: LaunchRecorder) {
  const clients = createTestAgentClients();
  const claude = clients.claude;
  if (!claude) {
    throw new Error("Fake Claude client is not configured");
  }

  return {
    ...clients,
    claude: new RecordingAgentClient(claude, recorder),
  };
}

async function assertAgentNotRunning(options: {
  client: McpClient;
  agentId: string;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const statusResult = await options.client.callTool({
      name: "get_agent_status",
      args: { agentId: options.agentId },
    });
    const payload = getStructuredContent(statusResult);
    if (!payload) {
      throw new Error("get_agent_status returned no structured payload");
    }
    const status = payload.status;
    if (status !== "running" && status !== "initializing") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Agent still running after 5000ms");
}

async function waitForAgentFinish(options: { client: McpClient; agentId: string }): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await options.client.callTool({
          name: "get_agent_status",
          args: { agentId: options.agentId },
        });
        return getStructuredContent(result)?.status;
      },
      { timeout: 10000 },
    )
    .toBe("idle");
}

describe("agent MCP end-to-end (offline)", () => {
  test("serves the 2026-07-28 discovery flow and an authenticated tool call", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-modern-mcp-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-modern-mcp-static-"));
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
        auth: { password: hashDaemonPassword("daemon-secret") },
      },
      pino({ level: "silent" }),
    );
    let client: McpClient | null = null;

    try {
      await daemon.start();
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Isolated daemon did not bind a TCP port");
      }
      client = await createModernMcpClient(
        `http://127.0.0.1:${listenTarget.port}/mcp/agents`,
        daemon.agentManager.getMcpAuthToken(),
      );
      const result = await client.callTool({ name: "list_agents", args: {} });
      expect(getStructuredContent(result)?.agents).toEqual([]);
    } finally {
      await client?.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("role-bound agent actions enforce topology before side effects", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-role-actions-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-role-actions-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-role-actions-cwd-"));
    await writeFile(
      path.join(agentCwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(agentCwd),
      "utf8",
    );
    const recorder: LaunchRecorder = { recordedLaunches: [] };
    const daemonConfig: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      peerDelegation: {
        enabled: true,
        runMode: "unattended",
        allowedModels: [{ provider: "claude", model: "claude-test-model" }],
      },
      staticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };
    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    const clients: McpClient[] = [];

    try {
      await daemon.start();
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Isolated daemon did not bind a TCP port");
      }
      const mcpUrl = `http://127.0.0.1:${listenTarget.port}/mcp/agents`;
      const topClient = await createMcpClient(mcpUrl);
      clients.push(topClient);

      const createRoot = async (title: string, role: "lead" | "supervisor") =>
        requireAgentId(
          await topClient.callTool({
            name: "create_agent",
            args: {
              cwd: agentCwd,
              title,
              provider: "claude/claude-test-model",
              role,
              assignment: roleAssignment(role, agentCwd),
              initialPrompt: "Reply done and stop",
              background: false,
            },
          }),
        );
      const leadOneId = await createRoot("Lead one", "lead");
      const leadTwoId = await createRoot("Lead two", "lead");
      const supervisorId = await createRoot("Supervisor", "supervisor");
      const leadOneClient = await createMcpClient(`${mcpUrl}?callerAgentId=${leadOneId}`);
      const leadTwoClient = await createMcpClient(`${mcpUrl}?callerAgentId=${leadTwoId}`);
      const supervisorClient = await createMcpClient(`${mcpUrl}?callerAgentId=${supervisorId}`);
      clients.push(leadOneClient, leadTwoClient, supervisorClient);

      const peerOneId = requireAgentId(
        await leadOneClient.callTool({
          name: "create_agent",
          args: {
            title: "Peer one",
            provider: "claude/claude-test-model",
            role: "peer",
            assignment: roleAssignment("peer"),
            initialPrompt: "Reply done and stop",
            notifyOnFinish: false,
          },
        }),
      );
      const peerTwoId = requireAgentId(
        await leadTwoClient.callTool({
          name: "create_agent",
          args: {
            title: "Peer two",
            provider: "claude/claude-test-model",
            role: "peer",
            assignment: roleAssignment("peer"),
            initialPrompt: "Reply done and stop",
            notifyOnFinish: false,
          },
        }),
      );
      const peerOne = await daemon.agentStorage.get(peerOneId);
      const peerTwo = await daemon.agentStorage.get(peerTwoId);
      await assertAgentNotRunning({ client: topClient, agentId: peerOneId });
      await assertAgentNotRunning({ client: topClient, agentId: peerTwoId });
      expect(peerOne?.roleBinding?.roleId).toBe("peer");
      expect(peerOne?.labels?.["paseo.parent-agent-id"]).toBe(leadOneId);
      expect(peerTwo?.labels?.["paseo.parent-agent-id"]).toBe(leadTwoId);

      for (const deniedRole of ["lead", "supervisor", undefined] as const) {
        const recordCountBefore = (await daemon.agentStorage.list()).length;
        const launchCountBefore = recorder.recordedLaunches.length;
        await expectMcpToolRejection(
          () =>
            leadOneClient.callTool({
              name: "create_agent",
              args: {
                title: "Denied child",
                provider: "claude/claude-test-model",
                initialPrompt: "Must not launch",
                ...(deniedRole ? { role: deniedRole } : {}),
              },
            }),
          "A role-bound Lead may create only a role-bound Peer",
        );
        expect((await daemon.agentStorage.list()).length).toBe(recordCountBefore);
        expect(recorder.recordedLaunches).toHaveLength(launchCountBefore);
      }

      const peerClient = await createMcpClient(`${mcpUrl}?callerAgentId=${peerOneId}`);
      clients.push(peerClient);
      await expectMcpToolRejection(
        () =>
          peerClient.callTool({
            name: "post_room",
            args: { room: "missing-council-room", body: "Bounded Peer response" },
          }),
        "Chat room not found: missing-council-room",
      );
      await expectMcpToolRejection(
        () =>
          peerClient.callTool({
            name: "read_room",
            args: { room: "missing-council-room" },
          }),
        "Tool read_room not found",
      );
      const peerRecordCountBefore = (await daemon.agentStorage.list()).length;
      const peerLaunchCountBefore = recorder.recordedLaunches.length;
      await expectMcpToolRejection(
        () =>
          peerClient.callTool({
            name: "create_agent",
            args: {
              title: "Peer cannot create",
              provider: "claude/claude-test-model",
              role: "peer",
              initialPrompt: "Must not launch",
            },
          }),
        "Tool create_agent not found",
      );
      expect((await daemon.agentStorage.list()).length).toBe(peerRecordCountBefore);
      expect(recorder.recordedLaunches).toHaveLength(peerLaunchCountBefore);

      const supervisorRecordCountBefore = (await daemon.agentStorage.list()).length;
      const supervisorLaunchCountBefore = recorder.recordedLaunches.length;
      await expectMcpToolRejection(
        () =>
          supervisorClient.callTool({
            name: "create_agent",
            args: {
              title: "Supervisor cannot create",
              provider: "claude/claude-test-model",
              role: "peer",
              initialPrompt: "Must not launch",
            },
          }),
        "A role-bound Supervisor may create only a role-bound Lead under a Human-issued delegation assignment",
      );
      expect((await daemon.agentStorage.list()).length).toBe(supervisorRecordCountBefore);
      expect(recorder.recordedLaunches).toHaveLength(supervisorLaunchCountBefore);

      const allowedPrompt = await leadOneClient.callTool({
        name: "send_agent_prompt",
        args: {
          agentId: peerOneId,
          prompt: "Allowed direct-child follow-up",
          notifyOnFinish: false,
        },
      });
      expect(getStructuredContent(allowedPrompt)?.success).toBe(true);

      const peerTwoBefore = await daemon.agentStorage.get(peerTwoId);
      await expectMcpToolRejection(
        () =>
          leadOneClient.callTool({
            name: "send_agent_prompt",
            args: {
              agentId: peerTwoId,
              prompt: "Denied cross-child follow-up",
              sessionMode: "bypassPermissions",
            },
          }),
        "A role-bound Lead may prompt only its own direct Peer child",
      );
      expect(await daemon.agentStorage.get(peerTwoId)).toEqual(peerTwoBefore);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent runs initial prompt and affects filesystem", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const filePath = path.join(agentCwd, "mcp-smoke.txt");
      await writeFile(filePath, "ok", "utf8");

      const initialPrompt = [
        "You must call the Bash command tool with the exact command `rm -f mcp-smoke.txt`.",
        "Run it and reply with done and stop.",
        "Do not respond before the command finishes.",
      ].join("\n");

      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP e2e smoke",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt,
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      await waitForAgentFinish({ client, agentId: agentId! });

      if (existsSync(filePath)) {
        const contents = await readFile(filePath, "utf8");
        throw new Error(
          `Expected mcp-smoke.txt to be removed, but it still exists with contents: ${contents}`,
        );
      }
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_workspace with local isolation adopts only an existing directory", async () => {
    const daemon = await startOfflineMcpDaemon();
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-local-workspace-"));
    const missingPath = path.join(root, "does-not-exist");
    const filePath = path.join(root, "regular-file");
    await writeFile(filePath, "not a directory\n", "utf8");
    try {
      expect(await createLocalWorkspace(daemon.client, missingPath)).toEqual({
        error: expect.stringContaining(`Directory not found: ${missingPath}`),
      });
      expect(await createLocalWorkspace(daemon.client, filePath)).toEqual({
        error: expect.stringContaining(`Directory not found: ${filePath}`),
      });
      const created = await createLocalWorkspace(daemon.client, root);
      expect(await listWorkspaces(daemon.client)).toEqual([created]);
    } finally {
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("password-protected daemon authorizes the agent MCP via the capability token", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      auth: { password: hashDaemonPassword("daemon-secret") },
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const mcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
    const capabilityToken = daemon.agentManager.getMcpAuthToken();
    expect(typeof capabilityToken).toBe("string");

    let agentId: string | null = null;
    let client: McpClient | null = null;
    try {
      // Remote auth is not weakened: a request without credentials is rejected
      // before any MCP processing.
      const unauthorized = await fetch(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      // The injected capability token authenticates the full MCP handshake:
      // creating (and connecting) the client and driving a tool call both go
      // through the password-gated /mcp/agents route. (The exact bearer header
      // injected into a child agent's config is covered by the
      // runtime-mcp-config unit test.)
      client = await createMcpClient(mcpUrl, capabilityToken!);
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Password MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
    } finally {
      if (agentId) {
        await client?.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client?.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent auto-injects paseo MCP by default and can be disabled", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    const disabledPaseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-disabled-"));
    const disabledStaticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-disabled-"));
    const disabledAgentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-disabled-"));
    const disabledPort = await getAvailablePort();
    const disabledRecorder: LaunchRecorder = { recordedLaunches: [] };
    const disabledDaemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${disabledPort}`,
      paseoHome: disabledPaseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      mcpInjectIntoAgents: false,
      staticDir: disabledStaticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(disabledRecorder),
      agentStoragePath: path.join(disabledPaseoHome, "agents"),
    };
    const disabledDaemon = await createPaseoDaemon(disabledDaemonConfig, pino({ level: "silent" }));
    await disabledDaemon.start();

    const disabledClient = await createMcpClient(`http://127.0.0.1:${disabledPort}/mcp/agents`);

    let agentId: string | null = null;
    let disabledAgentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Injected MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: false,
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      const matchingLaunches = recorder.recordedLaunches.filter((launch) => {
        const paseoMcp = launch.mcpServers?.paseo;
        return (
          paseoMcp?.type === "http" &&
          new URL(paseoMcp.url).searchParams.get("callerAgentId") === agentId
        );
      });
      expect(matchingLaunches).toHaveLength(1);
      const injectedMcp = matchingLaunches[0]?.mcpServers?.paseo;
      expect(injectedMcp?.type).toBe("http");
      const injectedUrl = new URL(injectedMcp?.type === "http" ? injectedMcp.url : "");
      expect(`${injectedUrl.origin}${injectedUrl.pathname}`).toBe(
        `http://127.0.0.1:${port}/mcp/agents`,
      );
      expect(injectedUrl.searchParams.get("callerAgentId")).toBe(agentId);
      expect(injectedUrl.searchParams.get("runtimeInstanceId")).toMatch(/^[a-f0-9-]{36}$/u);
      const injectedAgent = daemon.agentManager.getAgent(agentId!);
      expect(injectedAgent?.config.mcpServers?.paseo).toBeUndefined();

      const disabledResult = await disabledClient.callTool({
        name: "create_agent",
        args: {
          cwd: disabledAgentCwd,
          title: "No injected MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: false,
        },
      });
      const disabledPayload = getStructuredContent(disabledResult);
      disabledAgentId =
        typeof disabledPayload?.agentId === "string" ? disabledPayload.agentId : null;
      expect(disabledAgentId).toBeTruthy();

      const disabledLaunches = disabledRecorder.recordedLaunches.filter(
        (launch) => launch.title === "No injected MCP",
      );
      expect(disabledLaunches).toHaveLength(1);
      expect(disabledLaunches[0]?.mcpServers?.paseo).toBeUndefined();
      const disabledAgent = disabledDaemon.agentManager.getAgent(disabledAgentId!);
      expect(disabledAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      if (disabledAgentId) {
        await disabledClient.callTool({
          name: "kill_agent",
          args: { agentId: disabledAgentId },
        });
      }
      await disabledClient.close();
      await disabledDaemon.stop();
      await rm(disabledPaseoHome, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
      await rm(disabledStaticDir, { recursive: true, force: true });
      await rm(disabledAgentCwd, { recursive: true, force: true });
      await client.close();
      await daemon.stop();
      await rm(paseoHome, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("role-bound agents receive scoped Paseo tools when unbound injection is disabled", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-role-bound-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-role-bound-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-role-bound-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        mcpInjectIntoAgents: false,
        staticDir,
        mcpDebug: false,
        agentClients: createMcpRecordingAgentClients(recorder),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    await writeFile(
      path.join(agentCwd, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(agentCwd),
    );

    let agentId: string | null = null;
    try {
      const roleAgent = await daemon.agentManager.createAgent(
        {
          provider: "claude",
          model: "claude-test-model",
          cwd: agentCwd,
        },
        undefined,
        {
          workspaceId: "workspace-role-bound-tools-disabled-global",
          roleId: "lead",
          assignment: roleAssignment("lead", agentCwd),
        },
      );
      agentId = roleAgent.id;
      const roleLaunch = recorder.recordedLaunches.at(-1);
      expect(roleLaunch?.mcpServers?.paseo).toMatchObject({
        type: "http",
        url: expect.stringContaining(`callerAgentId=${roleAgent.id}`),
      });
    } finally {
      if (agentId) {
        await daemon.agentManager.closeAgent(agentId).catch(() => undefined);
      }
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent injects a loopback MCP URL when the daemon listens on all interfaces", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };

    const daemonConfig: PaseoDaemonConfig = {
      listen: `0.0.0.0:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Wildcard MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      const injectedMcp = recorder.recordedLaunches.at(-1)?.mcpServers?.paseo;
      expect(injectedMcp?.type).toBe("http");
      const injectedUrl = new URL(injectedMcp?.type === "http" ? injectedMcp.url : "");
      expect(`${injectedUrl.origin}${injectedUrl.pathname}`).toBe(
        `http://127.0.0.1:${port}/mcp/agents`,
      );
      expect(injectedUrl.searchParams.get("callerAgentId")).toBe(agentId);
      expect(injectedUrl.searchParams.get("runtimeInstanceId")).toMatch(/^[a-f0-9-]{36}$/u);
      const injectedAgent = daemon.agentManager.getAgent(agentId!);
      expect(injectedAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent with background initialPrompt reflects running state once the first turn starts", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP background create",
          provider: "codex/gpt-5.4-mini",
          mode: "full-access",
          initialPrompt: "Run exactly: sleep 30",
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      expect(payload?.status).toBe("running");

      const statusResult = await client.callTool({
        name: "get_agent_status",
        args: { agentId },
      });
      const statusPayload = getStructuredContent(statusResult);
      expect(statusPayload?.status).toBe("running");
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent propagates initial-turn start failure instead of returning success", async () => {
    class StartTurnFailureSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly id = "mcp-start-turn-failure-session";
      readonly capabilities = {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      } as const;

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        throw new Error("Initial turn failed to start");
      }

      subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
        return () => undefined;
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield* [];
      }

      async getRuntimeInfo() {
        return {
          provider: "codex" as const,
          sessionId: this.id,
          model: "gpt-5.4-mini",
          modeId: "full-access",
        };
      }

      async getAvailableModes(): Promise<
        Array<{ id: string; label: string; description: string }>
      > {
        return [
          {
            id: "full-access",
            label: "Full access",
            description: "No prompts",
          },
        ];
      }

      async getCurrentMode(): Promise<string | null> {
        return "full-access";
      }

      async setMode(): Promise<void> {}

      getPendingPermissions() {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence(): AgentPersistenceHandle | null {
        return { provider: "codex", sessionId: this.id };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    class StartTurnFailureClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      } as const;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async fetchCatalog(): Promise<{
        models: Array<{
          provider: "codex";
          id: string;
          label: string;
          isDefault: boolean;
        }>;
        modes: Array<{ id: string; label: string; description: string }>;
      }> {
        return {
          models: [
            {
              provider: "codex",
              id: "gpt-5.4-mini",
              label: "gpt-5.4-mini",
              isDefault: true,
            },
          ],
          modes: [
            {
              id: "full-access",
              label: "Full access",
              description: "No prompts",
            },
          ],
        };
      }

      async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
        return new StartTurnFailureSession();
      }

      async resumeSession(
        _handle: AgentPersistenceHandle,
        _config?: Partial<AgentSessionConfig>,
      ): Promise<AgentSession> {
        return new StartTurnFailureSession();
      }
    }

    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: {
        ...createTestAgentClients(),
        codex: new StartTurnFailureClient(),
      },
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP start failure",
          provider: "codex/gpt-5.4-mini",
          mode: "full-access",
          initialPrompt: "Run exactly: sleep 30",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Initial turn failed to start");
      expect(getStructuredContent(result)?.agentId).toBeUndefined();
    } finally {
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("workspace creation owns async setup and terminal bootstrap before agent attachment", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-worktree-repo-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const { execSync } = await import("node:child_process");
      execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
      execSync("git config user.email 'test@test.com'", {
        cwd: repoRoot,
        stdio: "pipe",
      });
      execSync("git config user.name 'Test'", { cwd: repoRoot, stdio: "pipe" });
      await writeFile(path.join(repoRoot, "file.txt"), "hello\n", "utf8");
      execSync("git add .", { cwd: repoRoot, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'initial'", {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const setupCommand =
        'while [ ! -f "$PASEO_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$PASEO_WORKTREE_PATH/setup-done.txt"';
      await writeFile(
        path.join(repoRoot, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: [setupCommand],
            terminals: [
              {
                name: "Dev Server",
                command: 'echo "dev-server" > dev-terminal.txt; tail -f /dev/null',
              },
            ],
          },
        }),
        "utf8",
      );
      execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'add worktree config'", {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const workspaceResult = await withTimeout({
        promise: client.callTool({
          name: "create_workspace",
          args: {
            isolation: "worktree",
            path: repoRoot,
            worktreeSlug: "mcp-worktree-setup-test",
            baseBranch: "main",
          },
        }),
        timeoutMs: 2500,
        label: "create_workspace should not block on setup",
      });
      const workspace = getStructuredContent(workspaceResult);
      if (typeof workspace?.workspaceId !== "string") throw new Error("Expected created workspace");
      const result = await client.callTool({
        name: "create_agent",
        args: {
          workspaceId: workspace.workspaceId,
          title: "MCP worktree setup terminals",
          provider: "claude/claude-test-model",
          settings: { modeId: "bypassPermissions" },
          initialPrompt: "say done and stop",
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      const worktreePath = typeof payload?.cwd === "string" ? payload.cwd : "";
      expect(worktreePath).toContain(`${path.sep}worktrees${path.sep}`);
      expect(existsSync(path.join(worktreePath, "setup-done.txt"))).toBe(false);
      expect(existsSync(path.join(worktreePath, "dev-terminal.txt"))).toBe(false);

      await writeFile(path.join(worktreePath, "allow-setup"), "ok\n", "utf8");

      await waitForPathExists({
        targetPath: path.join(worktreePath, "setup-done.txt"),
        timeoutMs: 15000,
      });
      await waitForPathExists({
        targetPath: path.join(worktreePath, "dev-terminal.txt"),
        timeoutMs: 30000,
      });
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
