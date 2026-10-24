import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "../../agent-sdk-types.js";

export interface PiMcpBridgeTempFile {
  path: string;
  cleanup: () => void;
}

/**
 * Self-contained pi extension that exposes injected MCP servers as pi tools.
 *
 * pi itself has no built-in MCP (documented in pi 0.86), so Paseo launches it
 * with this extension plus a `PASEO_MCP_CONFIG` env var pointing at a temp
 * mcp.json. The bridge connects to each streamable-HTTP server, lists its
 * tools, and registers them directly with `pi.registerTool`. stdio servers are
 * reported loudly instead of being served; users who need them should install
 * the community `pi-mcp-adapter` extension, which Paseo does not manage.
 *
 * The source runs inside the pi child process, so it must stay dependency-free:
 * no imports from this package, node builtins and fetch only. It is embedded as
 * a template literal, so the source may not contain backticks or `${`; escape
 * every backslash (`\n` becomes `\\n` here).
 */
export const PI_MCP_BRIDGE_EXTENSION_SOURCE = `
import { readFileSync } from "node:fs";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const STARTUP_TIMEOUT_MS = 15000;
const BRIDGE_LOG_PREFIX = "[paseo-mcp-bridge]";

let nextRequestId = 1;

function logInfo(message) {
  console.error(BRIDGE_LOG_PREFIX + " " + message);
}

function logError(message, error) {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  console.error(BRIDGE_LOG_PREFIX + " " + message + (detail ? ": " + detail : ""));
}

function readMcpServers() {
  const configPath = typeof process.env.PASEO_MCP_CONFIG === "string" ? process.env.PASEO_MCP_CONFIG.trim() : "";
  if (!configPath) {
    logError("no PASEO_MCP_CONFIG env var; Paseo MCP tools are unavailable in this session");
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    logError("failed to read MCP config " + configPath, error);
    return [];
  }
  const servers = parsed && typeof parsed === "object" ? parsed.mcpServers : undefined;
  if (!servers || typeof servers !== "object") {
    return [];
  }
  return Object.entries(servers).filter(([, entry]) => entry && typeof entry === "object");
}

function isHttpUrl(value) {
  return typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"));
}

function normalizeHeaders(entry) {
  const headers = {};
  if (entry.headers && typeof entry.headers === "object") {
    for (const [name, value] of Object.entries(entry.headers)) {
      if (typeof value === "string") {
        headers[name] = value;
      }
    }
  }
  return headers;
}

async function postJsonRpc(server, method, params, options) {
  const isNotification = options?.isNotification === true;
  const frame = {
    jsonrpc: "2.0",
    method,
    ...(params !== undefined ? { params } : {}),
  };
  if (!isNotification) {
    frame.id = nextRequestId;
    nextRequestId += 1;
  }
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...(server.sessionId ? { "mcp-session-id": server.sessionId } : {}),
      ...server.headers,
    },
    body: JSON.stringify(frame),
    signal: options?.signal,
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId && !server.sessionId) {
    server.sessionId = sessionId;
  }
  if (isNotification) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error("HTTP " + response.status + " for " + method);
  }
  const contentType = String(response.headers.get("content-type") ?? "");
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\\n")) {
      if (!line.startsWith("data:")) {
        continue;
      }
      try {
        const message = JSON.parse(line.slice(5).trim());
        if (message && message.id === frame.id) {
          return message;
        }
      } catch {
        // Ignore unparsable SSE frames.
      }
    }
    throw new Error("No JSON-RPC response for " + method + " in SSE stream");
  }
  if (!text) {
    throw new Error("Empty response for " + method);
  }
  const message = JSON.parse(text);
  if (!message || typeof message !== "object") {
    throw new Error("Malformed JSON-RPC response for " + method);
  }
  return message;
}

async function initializeServer(server, signal) {
  const response = await postJsonRpc(
    server,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "paseo-mcp-bridge", version: "1.0.0" },
    },
    { signal },
  );
  if (response.error) {
    throw new Error("initialize rejected: " + (response.error.message ?? "unknown error"));
  }
  try {
    await postJsonRpc(server, "notifications/initialized", undefined, {
      signal,
      isNotification: true,
    });
  } catch (error) {
    logError("initialized notification failed for server " + server.name, error);
  }
}

async function listServerTools(server, signal) {
  const response = await postJsonRpc(server, "tools/list", {}, { signal });
  if (response.error) {
    throw new Error("tools/list failed: " + (response.error.message ?? "unknown error"));
  }
  const tools = response.result && Array.isArray(response.result.tools) ? response.result.tools : [];
  return tools.filter((tool) => tool && typeof tool === "object" && typeof tool.name === "string");
}

async function callServerTool(server, toolName, args, signal) {
  const response = await postJsonRpc(
    server,
    "tools/call",
    { name: toolName, arguments: args ?? {} },
    { signal },
  );
  if (response.error) {
    throw new Error(response.error.message ?? "tools/call " + toolName + " failed");
  }
  return response.result ?? {};
}

function normalizeParameters(schema) {
  if (schema && typeof schema === "object" && schema.type === "object") {
    return schema;
  }
  return { type: "object", properties: {} };
}

function textBlocks(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((block) => block && typeof block === "object" && typeof block.type === "string");
}

function errorText(content) {
  return textBlocks(content)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\\n\\n");
}

const loadedServers = [];
for (const [name, entry] of readMcpServers()) {
  if (!isHttpUrl(entry.url)) {
    logError(
      "server " +
        name +
        ' has no http url; the bridge only serves streamable-HTTP MCP servers. Install pi-mcp-adapter for stdio servers.',
    );
    continue;
  }
  const server = { name, url: entry.url, headers: normalizeHeaders(entry), sessionId: undefined };
  try {
    const signal = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
    await initializeServer(server, signal);
    server.tools = await listServerTools(server, signal);
    loadedServers.push(server);
  } catch (error) {
    logError("failed to load MCP server " + name, error);
  }
}

export default function mcpBridge(pi) {
  let registeredCount = 0;
  for (const server of loadedServers) {
    for (const tool of server.tools ?? []) {
      const remoteName = tool.name;
      const serverRef = server;
      const buildDefinition = (toolName) => ({
        name: toolName,
        description: typeof tool.description === "string" ? tool.description : remoteName,
        parameters: normalizeParameters(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          const result = await callServerTool(serverRef, remoteName, params, signal ?? undefined);
          if (result && result.isError === true) {
            throw new Error(errorText(result.content) || "MCP tool " + remoteName + " failed");
          }
          return {
            content: textBlocks(result.content),
            ...(result && result.structuredContent !== undefined
              ? { details: { structuredContent: result.structuredContent } }
              : {}),
          };
        },
      });

      let registered = false;
      try {
        pi.registerTool(buildDefinition(remoteName));
        registered = true;
      } catch {
        try {
          pi.registerTool(buildDefinition(server.name + "__" + remoteName));
          registered = true;
        } catch (error) {
          logError("skipping MCP tool " + server.name + "/" + remoteName, error);
        }
      }
      if (registered) {
        registeredCount += 1;
      }
    }
  }

  pi.on?.("session_start", () => {
    if (registeredCount > 0) {
      logInfo("registered " + registeredCount + " MCP tool(s) from " + loadedServers.length + " server(s)");
    } else {
      logError("no MCP tools registered; Paseo coordination tools are unavailable in this session");
    }
    try {
      if (typeof pi.appendEntry === "function") {
        pi.appendEntry({
          customType: "paseo-mcp-bridge-status",
          data: { registeredTools: registeredCount, servers: loadedServers.length },
        });
      }
    } catch {
      // Entry recording is best-effort.
    }
  });
}
`;

export function createPiMcpBridgeExtensionFile(): PiMcpBridgeTempFile {
  const dir = mkdtempSync(join(tmpdir(), "paseo-pi-mcp-bridge-"));
  const filePath = join(dir, "paseo-mcp-bridge.mjs");
  writeFileSync(filePath, `${PI_MCP_BRIDGE_EXTENSION_SOURCE.trimStart()}\n`, { encoding: "utf8" });
  return {
    path: filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Names of injected servers the bridge cannot serve (no streamable-HTTP transport). */
export function listStdioMcpServerNames(servers: Record<string, McpServerConfig>): string[] {
  return Object.entries(servers)
    .filter(([, serverConfig]) => serverConfig.type === "stdio")
    .map(([name]) => name);
}
