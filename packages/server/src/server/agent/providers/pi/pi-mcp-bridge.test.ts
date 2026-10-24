import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";

import { PI_MCP_BRIDGE_EXTENSION_SOURCE } from "./pi-mcp-bridge.js";

interface RecordedRequest {
  method?: string;
  authorization?: string;
  protocolVersion?: string;
}

interface MockMcpServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

interface FakeRegisteredTool {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

function createFakePi(options?: { failOnToolName?: string }) {
  const registeredTools: FakeRegisteredTool[] = [];
  const sessionStartHandlers: Array<() => void | Promise<void>> = [];
  const appendedEntries: Array<{ customType?: string; data?: unknown }> = [];
  return {
    registeredTools,
    appendedEntries,
    registerTool(definition: FakeRegisteredTool) {
      if (options?.failOnToolName && definition.name === options.failOnToolName) {
        throw new Error(`Tool ${definition.name} is already registered`);
      }
      registeredTools.push(definition);
    },
    on(event: string, handler: () => void | Promise<void>) {
      if (event === "session_start") {
        sessionStartHandlers.push(handler);
      }
    },
    appendEntry(entry: { customType?: string; data?: unknown }) {
      appendedEntries.push(entry);
    },
    async startSession() {
      for (const handler of sessionStartHandlers) {
        await handler();
      }
    },
  };
}

function writeBridgeModule(caseName: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-pi-bridge-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, `${caseName}.mjs`);
  writeFileSync(filePath, PI_MCP_BRIDGE_EXTENSION_SOURCE.trimStart());
  return filePath;
}

async function importBridge(caseName: string, pi: ReturnType<typeof createFakePi>): Promise<void> {
  const bridgeModule = (await import(
    `${pathToFileURL(writeBridgeModule(caseName)).href}?case=${caseName}`
  )) as { default: (pi: ReturnType<typeof createFakePi>) => void };
  bridgeModule.default(pi);
}

function startMockMcpServer(
  handleRequest: (method: string) => { status: number; body?: unknown } | undefined,
): Promise<MockMcpServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed: { method?: string; id?: number } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      requests.push({
        method: parsed.method,
        authorization: req.headers.authorization,
        protocolVersion: req.headers["mcp-protocol-version"],
      });
      const outcome = handleRequest(parsed.method ?? "");
      if (!outcome) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(outcome.status, { "content-type": "application/json" });
      if (outcome.body === undefined) {
        res.end();
        return;
      }
      res.end(
        JSON.stringify(
          parsed.id === undefined
            ? outcome.body
            : { jsonrpc: "2.0", id: parsed.id, result: outcome.body },
        ),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("mock server did not listen on a port");
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        requests,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

const MOCK_TOOLS = [
  {
    name: "list_profiles",
    description: "List launch profiles",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_agent",
    description: "Create a peer agent",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Agent name" } },
      required: ["name"],
    },
  },
];

function mockMcpHandler(method: string): { status: number; body?: unknown } | undefined {
  if (method === "initialize") {
    return {
      status: 200,
      body: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1.0.0" },
      },
    };
  }
  if (method === "tools/list") {
    return { status: 200, body: { tools: MOCK_TOOLS } };
  }
  if (method === "tools/call") {
    return { status: 200, body: { content: [{ type: "text", text: "created peer-1" }] } };
  }
  return undefined;
}

async function importBridgeWithConfig(
  caseName: string,
  config: Record<string, unknown> | null,
): ReturnType<typeof createFakePi> {
  if (config === null) {
    delete process.env.PASEO_MCP_CONFIG;
  } else {
    const dir = mkdtempSync(path.join(tmpdir(), "paseo-pi-bridge-config-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify(config));
    process.env.PASEO_MCP_CONFIG = configPath;
  }
  const pi = createFakePi();
  await importBridge(caseName, pi);
  return pi;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PASEO_MCP_CONFIG;
});

describe("Paseo MCP bridge extension", () => {
  test("registers streamable-HTTP MCP tools and forwards tool calls", async () => {
    const server = await startMockMcpServer(mockMcpHandler);
    const pi = await importBridgeWithConfig("forward", {
      mcpServers: { paseo: { url: server.url, auth: false, oauth: false } },
    });

    expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["list_profiles", "create_agent"]);
    expect(pi.registeredTools[0]?.description).toBe("List launch profiles");
    expect(pi.registeredTools[1]?.parameters).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });

    const result = await pi.registeredTools[1]!.execute("tool-call-1", { name: "peer-1" });
    expect(result.content).toEqual([{ type: "text", text: "created peer-1" }]);

    expect(server.requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    await server.close();
  });

  test("sends the MCP protocol version and configured auth headers", async () => {
    const server = await startMockMcpServer(mockMcpHandler);
    const pi = await importBridgeWithConfig("headers", {
      mcpServers: {
        paseo: { url: server.url, headers: { Authorization: "Bearer test-token" } },
      },
    });

    expect(pi.registeredTools).toHaveLength(2);
    expect(server.requests[0]?.protocolVersion).toBe("2025-06-18");
    expect(server.requests.every((request) => request.authorization === "Bearer test-token")).toBe(
      true,
    );
    await server.close();
  });

  test("throws with the MCP error text when a tool result is an error", async () => {
    const server = await startMockMcpServer((method) => {
      if (method === "tools/call") {
        return {
          status: 200,
          body: { isError: true, content: [{ type: "text", text: "permission denied by policy" }] },
        };
      }
      return mockMcpHandler(method);
    });
    const pi = await importBridgeWithConfig("error-result", {
      mcpServers: { paseo: { url: server.url } },
    });

    await expect(pi.registeredTools[0]!.execute("tool-call-1", {})).rejects.toThrow(
      "permission denied by policy",
    );
    await server.close();
  });

  test("falls back to a server-prefixed tool name when the plain name is taken", async () => {
    const server = await startMockMcpServer(mockMcpHandler);
    const pi = createFakePi({ failOnToolName: "list_profiles" });
    const dir = mkdtempSync(path.join(tmpdir(), "paseo-pi-bridge-config-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { paseo: { url: server.url } } }));
    process.env.PASEO_MCP_CONFIG = configPath;

    await importBridge("conflict", pi);

    expect(pi.registeredTools.map((tool) => tool.name)).toEqual([
      "paseo__list_profiles",
      "create_agent",
    ]);
    await server.close();
  });

  test("skips stdio servers with a loud warning and serves the http ones", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startMockMcpServer(mockMcpHandler);
    const pi = await importBridgeWithConfig("stdio-skip", {
      mcpServers: {
        "local-secret": { type: "stdio", command: "node", args: ["secret-server.js"] },
        paseo: { url: server.url },
      },
    });

    expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["list_profiles", "create_agent"]);
    expect(
      consoleError.mock.calls.some((call) =>
        String(call[0]).includes("server local-secret has no http url"),
      ),
    ).toBe(true);
    await server.close();
  });

  test("reports loudly when PASEO_MCP_CONFIG is missing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const pi = await importBridgeWithConfig("missing-config", null);

    expect(pi.registeredTools).toHaveLength(0);
    expect(
      consoleError.mock.calls.some((call) =>
        String(call[0]).includes("no PASEO_MCP_CONFIG env var"),
      ),
    ).toBe(true);

    await pi.startSession();
    expect(
      consoleError.mock.calls.some((call) => String(call[0]).includes("no MCP tools registered")),
    ).toBe(true);
  });

  test("reports loudly when the MCP server cannot be reached", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startMockMcpServer(mockMcpHandler);
    const deadPortUrl = server.url.replace(/\/mcp$/, "/unreachable");
    await server.close();

    const pi = await importBridgeWithConfig("unreachable", {
      mcpServers: { paseo: { url: deadPortUrl } },
    });

    expect(pi.registeredTools).toHaveLength(0);
    expect(
      consoleError.mock.calls.some((call) =>
        String(call[0]).includes("failed to load MCP server paseo"),
      ),
    ).toBe(true);

    await pi.startSession();
    expect(pi.appendedEntries).toEqual([
      { customType: "paseo-mcp-bridge-status", data: { registeredTools: 0, servers: 0 } },
    ]);
  });
});
