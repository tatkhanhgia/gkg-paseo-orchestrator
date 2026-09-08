import type { AssignmentEffectClass } from "@getpaseo/protocol/assignment-contract";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { noWriteModeForRoleBindingInjectionMethod } from "@getpaseo/protocol/provider-manifest";
import type {
  ProviderRoleBindingSupport,
  RoleBindingReceipt,
} from "@getpaseo/protocol/role-binding";

// Mirrors the daemon's authoritative no-write mode pin (assignment-capability-boundary.ts)
// via the shared protocol projection, so the draft mode picker never offers a mode the
// daemon is certain to reject once the agent launches.
export function requiredNoWriteModeId(
  roleBinding: ProviderRoleBindingSupport | undefined,
): string | null {
  if (roleBinding?.status !== "supported") return null;
  return noWriteModeForRoleBindingInjectionMethod(roleBinding.injectionMethod);
}

// Matches the server's mutationBoundaryForEffect (assignment-envelope.ts): every ordinary
// ostensibly UI-selectable effect except "mutating" resolves to a no-write mutation
// boundary, including "delegation" (Lead "Coordinate only", Supervisor "Coordinate Leads").
export function isNoWriteAssignmentEffect(effectClass: AssignmentEffectClass): boolean {
  return effectClass !== "mutating";
}

// Role selection only makes sense once at least one provider entry has a
// role binding and the role catalog itself has options to offer.
export function isRoleSelectionAvailable(
  allProviderEntries: ReadonlyArray<{ roleBinding?: unknown }> | undefined,
  roleOptionsCount: number,
): boolean {
  return (
    Boolean(allProviderEntries?.some((entry) => entry.roleBinding !== undefined)) &&
    roleOptionsCount > 0
  );
}

// Collapses the repeated "only enforce the pin for a no-write assignment
// effect" pattern into a single call, so callers never need their own
// conditional around requiredNoWriteModeId.
export function resolveRequiredModeIdForRoleBinding(
  effectClass: AssignmentEffectClass,
  roleBinding: ProviderRoleBindingSupport | undefined,
): string | null {
  if (!isNoWriteAssignmentEffect(effectClass)) return null;
  return requiredNoWriteModeId(roleBinding);
}

// The provider's declared mode catalog may not literally include the pinned no-write
// mode id (e.g. a provider snapshot that has not loaded it yet). Falling back to the
// full unfiltered mode list would silently re-offer modes the daemon is certain to
// reject; a single explicit "locked" entry keeps the picker visible and honest without
// ever presenting a contradictory, selectable alternative.
export function buildLockedNoWriteModeOption(
  modeId: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): AgentMode {
  return {
    id: modeId,
    label: t("agentControls.mode.lockedOption", { mode: modeId }),
    description: t("agentControls.mode.lockedHint"),
  };
}

// Mirrors the daemon's authoritative no-write mode pin so a live agent's mode
// picker never offers a mode the daemon is certain to reject (UX-03). Unlike
// the draft form's ProviderRoleBindingSupport (a provider's declared
// capability), a live agent's roleBinding is the RoleBindingReceipt actually
// issued for that agent, which carries the resolved assignment envelope.
export function computeRequiredNoWriteModeId(
  roleBinding: RoleBindingReceipt | undefined,
): string | null {
  if (roleBinding?.assignment?.mutationBoundary.mode !== "no-write") return null;
  return noWriteModeForRoleBindingInjectionMethod(roleBinding.injectionMethod);
}

// A pinned mode not present in the provider's current mode catalog still
// must not fall back to the full unfiltered list (which would silently
// re-offer modes the daemon is certain to reject); synthesize a single
// explicit locked entry instead so the picker stays honest.
export function resolveLockedModeOptions(
  availableModes: readonly AgentMode[],
  pinnedModeId: string | null,
  buildLocked: (modeId: string) => AgentMode,
): AgentMode[] | null {
  if (!pinnedModeId) return null;
  const matched = availableModes.filter((mode) => mode.id === pinnedModeId);
  return matched.length > 0 ? matched : [buildLocked(pinnedModeId)];
}

// Client-side mirror of the daemon's rejection: never even attempt to call
// setAgentMode for a mode that contradicts the pinned no-write mode (UX-03
// defense in depth; the daemon remains the authoritative enforcer).
export function canAttemptModeSelection(modeId: string, pinnedModeId: string | null): boolean {
  return !pinnedModeId || modeId === pinnedModeId;
}

// Only a defined effective mode from a fresh post-write readback counts as
// confirmation; a rejected or still-pending mode change must never be
// persisted as if it had taken effect (UX-04).
export function resolveConfirmedModeId(effectiveModeId: string | null | undefined): string | null {
  return effectiveModeId ?? null;
}

// The actual set-mode transaction (UX-04): a rejected `setAgentMode` call
// must reject this promise before any persistence is attempted, and a
// successful call must still only persist the mode a fresh readback
// confirms as effective, never the optimistically requested one.
export async function persistConfirmedAgentMode<TNotice>(params: {
  agentId: string;
  modeId: string;
  setAgentMode: (agentId: string, modeId: string) => Promise<TNotice>;
  onNotice: (notice: TNotice) => void;
  fetchAgent: (
    agentId: string,
  ) => Promise<{ agent: { currentModeId?: string | null } } | null | undefined>;
  persist: (effectiveModeId: string) => Promise<unknown>;
}): Promise<void> {
  const notice = await params.setAgentMode(params.agentId, params.modeId);
  params.onNotice(notice);
  const fresh = await params.fetchAgent(params.agentId);
  const effectiveModeId = resolveConfirmedModeId(fresh?.agent.currentModeId);
  if (!effectiveModeId) return;
  await params.persist(effectiveModeId);
}

export interface PinnedModeSelection {
  modeOptions: AgentMode[];
  selectedMode: string;
  lockReason: string;
}

// Narrows the offered draft modes to what the daemon will actually allow once a
// no-write role binding launches (UX-03), and surfaces why the picker is locked
// (visible even when the pinned mode matches an existing provider option).
export function resolvePinnedModeSelection(
  modeOptions: readonly AgentMode[],
  pinnedModeId: string | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): PinnedModeSelection | null {
  if (!pinnedModeId) return null;
  const buildLocked = (modeId: string) => buildLockedNoWriteModeOption(modeId, t);
  return {
    modeOptions: resolveLockedModeOptions(modeOptions, pinnedModeId, buildLocked) ?? [
      buildLocked(pinnedModeId),
    ],
    selectedMode: pinnedModeId,
    lockReason: t("agentControls.mode.lockedHint"),
  };
}
