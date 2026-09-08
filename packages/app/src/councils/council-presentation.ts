import { COUNCIL_ROLES, type CouncilCase, type CouncilSeat, councilRoleLabel } from "./model";

/**
 * Adaptive Council hero subtitle reflecting the roles actually present in the
 * case's seats, instead of an assumed fixed Architect + Reviewer composition.
 */
export function councilHeroSubtitle(council: Pick<CouncilCase, "seats">): string {
  const presentRoles = new Set(
    council.seats.filter((seat) => seat.integrity !== "redundant").map((seat) => seat.role),
  );
  const roleLabels = COUNCIL_ROLES.filter((role) => presentRoles.has(role)).map(councilRoleLabel);
  const rolesText = roleLabels.length > 0 ? roleLabels.join(" + ") : "No seats assigned";
  return `One accountable Lead. ${rolesText}. No vote.`;
}

/**
 * Seat model/agent label distinguishing a seat that was never launched
 * (no agentId) from a seat whose agentId is present but whose agent
 * projection is unavailable (archived, unloaded, or otherwise missing).
 */
export function councilSeatModelLabel(seat: CouncilSeat): string {
  if (seat.agent) {
    return seat.agent.model?.trim() || seat.agent.provider;
  }
  return seat.agentId ? "Agent unavailable" : "Not launched";
}
