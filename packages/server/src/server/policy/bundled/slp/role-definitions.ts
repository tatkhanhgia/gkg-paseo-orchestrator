import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PASEO_ROLE_CONTRACT_VERSION, type PaseoRoleId } from "@getpaseo/protocol/role-binding";

export interface FoundationRoleDefinition {
  id: PaseoRoleId;
  label: string;
  description: string;
  protocolReadership: "full" | "assignment-only" | "governance-only";
  version: string;
  instructions: string;
}

interface CanonicalRoleSource {
  schemaVersion: 1;
  contractVersion: string;
  universalBlocks: string[];
  roles: Record<PaseoRoleId, string[]>;
}

const ROLE_IDS: PaseoRoleId[] = ["lead", "peer", "supervisor"];

const ROLE_DESCRIPTORS = {
  lead: {
    label: "Lead",
    description:
      "Owns routing, integration, engineering decisions, and acceptance. Reads the full Workspace Protocol.",
    protocolReadership: "full",
  },
  peer: {
    label: "Peer",
    description:
      "Owns independent technical judgment inside one bounded assignment. Receives only relevant protocol constraints.",
    protocolReadership: "assignment-only",
  },
  supervisor: {
    label: "Supervisor",
    description:
      "Observes orchestration and advises Human without becoming a super-Lead. Reads protocol only under a governance mandate.",
    protocolReadership: "governance-only",
  },
} as const satisfies Record<
  PaseoRoleId,
  Pick<FoundationRoleDefinition, "label" | "description" | "protocolReadership">
>;

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function loadCanonicalRoleSource(): CanonicalRoleSource {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "role-definitions.json"),
    resolve(
      moduleDirectory,
      "../../../../../../../foundation/dist/profiles/native/role-definitions.json",
    ),
  ];
  let lastError: unknown;

  for (const candidatePath of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidatePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("root must be an object");
      const source = parsed as Partial<CanonicalRoleSource>;
      if (source.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
      if (source.contractVersion !== PASEO_ROLE_CONTRACT_VERSION) {
        throw new Error(
          `contractVersion ${String(source.contractVersion)} does not match ${PASEO_ROLE_CONTRACT_VERSION}`,
        );
      }
      if (!isNonEmptyStringArray(source.universalBlocks)) {
        throw new Error("universalBlocks must be a non-empty string array");
      }
      if (typeof source.roles !== "object" || source.roles === null) {
        throw new Error("roles must be an object");
      }
      for (const roleId of ROLE_IDS) {
        if (!isNonEmptyStringArray(source.roles[roleId])) {
          throw new Error(`roles.${roleId} must be a non-empty string array`);
        }
      }
      return source as CanonicalRoleSource;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to load canonical Foundation role definitions: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Lead block added by Foundation 0.1.0-dev.25-gkg.1 (the self-convened Council trigger). */
const LEAD_COUNCIL_TRIGGER_BLOCK_PREFIX = "Council trigger:";

type RoleDefinitionTable = Record<PaseoRoleId, FoundationRoleDefinition>;

function buildDefinitions(
  source: CanonicalRoleSource,
  keepBlock: (roleId: PaseoRoleId, block: string) => boolean,
): RoleDefinitionTable {
  const universalInstructions = source.universalBlocks.join("\n\n");
  return Object.fromEntries(
    ROLE_IDS.map((roleId) => [
      roleId,
      {
        id: roleId,
        ...ROLE_DESCRIPTORS[roleId],
        version: source.contractVersion,
        instructions: `${universalInstructions}\n\n${source.roles[roleId]
          .filter((block) => keepBlock(roleId, block))
          .join("\n\n")}`,
      },
    ]),
  ) as RoleDefinitionTable;
}

let cachedDefinitions: RoleDefinitionTable | null = null;
let cachedPreCouncilTriggerDefinitions: RoleDefinitionTable | null = null;

function definitions(): RoleDefinitionTable {
  cachedDefinitions ??= buildDefinitions(loadCanonicalRoleSource(), () => true);
  return cachedDefinitions;
}

export function getFoundationRoleDefinition(roleId: PaseoRoleId): FoundationRoleDefinition {
  return definitions()[roleId];
}

/**
 * COMPAT(slpPreCouncilTriggerGeneration): added after v0.8.0-paseo.4, remove together with the
 * last retained generation that uses it (see `RETAINED_SLP_GENERATIONS`).
 *
 * Current source with the Lead Council trigger block removed: the role definitions every
 * generation recorded before Foundation 0.1.0-dev.25-gkg.1 was built from.
 */
export function getPreCouncilTriggerFoundationRoleDefinition(
  roleId: PaseoRoleId,
): FoundationRoleDefinition {
  cachedPreCouncilTriggerDefinitions ??= buildDefinitions(
    loadCanonicalRoleSource(),
    (blockRoleId, block) =>
      !(blockRoleId === "lead" && block.startsWith(LEAD_COUNCIL_TRIGGER_BLOCK_PREFIX)),
  );
  return cachedPreCouncilTriggerDefinitions[roleId];
}
