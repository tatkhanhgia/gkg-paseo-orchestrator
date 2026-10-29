import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CoordinationSignal } from "@getpaseo/protocol/coordination-signal";

import { connectToDaemon, getDaemonHost, resolveAgentId } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface AgentSignalOptions extends CommandOptions {
  kind: string;
  reason?: string;
  observation?: string;
  question?: string;
  relatedAgent?: string;
  evidence?: string[];
}

interface AgentSignalResult {
  signalId: string;
  agentId: string;
  kind: CoordinationSignal["kind"];
  status: CoordinationSignal["status"];
  delivered: boolean;
}

type AgentSignalKind = "handoff" | "detach" | "question";

const signalSchema: OutputSchema<AgentSignalResult> = {
  idField: "signalId",
  columns: [
    { header: "SIGNAL ID", field: "signalId" },
    { header: "AGENT ID", field: "agentId" },
    { header: "KIND", field: "kind" },
    { header: "STATUS", field: "status" },
    { header: "DELIVERED", field: "delivered" },
  ],
};

function parseSignalKind(kind: string): AgentSignalKind {
  if (kind === "handoff" || kind === "detach" || kind === "question") return kind;
  throw {
    code: "INVALID_SIGNAL_KIND",
    message: `Invalid signal kind: ${kind}. Use handoff, detach, or question.`,
  } satisfies CommandError;
}

function validateRelatedAgent(
  kind: AgentSignalKind,
  requestedRelatedAgent: string | undefined,
  relatedAgentId: string | undefined,
): void {
  if (requestedRelatedAgent && !relatedAgentId) {
    throw {
      code: "RELATED_AGENT_NOT_FOUND",
      message: `Related agent not found: ${requestedRelatedAgent}`,
    } satisfies CommandError;
  }
  if (kind === "detach" && !relatedAgentId) {
    throw {
      code: "RELATED_AGENT_REQUIRED",
      message: "--related-agent is required for detach recommendations",
    } satisfies CommandError;
  }
}

async function requestSignal(
  client: DaemonClient,
  agentId: string,
  relatedAgentId: string | undefined,
  kind: AgentSignalKind,
  options: AgentSignalOptions,
): Promise<CoordinationSignal> {
  if (kind === "question") {
    if (!options.observation?.trim() || !options.question?.trim().endsWith("?")) {
      throw {
        code: "INVALID_ATTENTION_QUESTION",
        message: "Question signals require --observation and an open --question ending in '?'.",
      } satisfies CommandError;
    }
    if (!options.evidence || options.evidence.length === 0) {
      throw {
        code: "ATTENTION_EVIDENCE_REQUIRED",
        message: "Question signals require at least one --evidence reference.",
      } satisfies CommandError;
    }
    return client.askAttentionQuestion({
      agentId,
      observation: options.observation,
      question: options.question,
      evidenceRefs: options.evidence,
    });
  }
  if (!options.reason?.trim()) {
    throw {
      code: "SIGNAL_REASON_REQUIRED",
      message: "Handoff and detach recommendations require --reason.",
    } satisfies CommandError;
  }
  return client.signalAgent({
    agentId,
    kind: kind === "handoff" ? "handoff_recommended" : "detach_recommended",
    reason: options.reason,
    relatedAgentId,
    evidenceRefs: options.evidence,
  });
}

export async function runSignalCommand(
  agentIdArg: string,
  commandOptions: CommandOptions,
  _command: Command,
): Promise<SingleResult<AgentSignalResult>> {
  const options = commandOptions as AgentSignalOptions;
  const host = getDaemonHost({ target: options.daemonTarget });
  let client: DaemonClient;
  try {
    client = await connectToDaemon({ target: options.daemonTarget });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  }

  try {
    const kind = parseSignalKind(options.kind);
    const payload = await client.fetchAgents({ filter: { includeArchived: true } });
    const agents = payload.entries.map((entry) => entry.agent);
    const agentId = resolveAgentId(agentIdArg, agents);
    if (!agentId) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
      } satisfies CommandError;
    }
    const relatedAgentId = options.relatedAgent
      ? (resolveAgentId(options.relatedAgent, agents) ?? undefined)
      : undefined;
    validateRelatedAgent(kind, options.relatedAgent, relatedAgentId);
    const signal = await requestSignal(client, agentId, relatedAgentId, kind, options);
    return {
      type: "single",
      data: {
        signalId: signal.id,
        agentId,
        kind: signal.kind,
        status: signal.status,
        delivered: signal.deliveredAt !== null,
      },
      schema: signalSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
