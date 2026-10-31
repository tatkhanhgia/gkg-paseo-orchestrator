/** The fields of a daemon workspace the picker needs. A subset of the client's workspace type. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  projectDisplayName: string;
  workspaceDirectory?: string;
  /** Set while the workspace is being archived; such a workspace is not a valid target. */
  archivingAt?: string | null;
}

export interface WorkspaceOption {
  id: string;
  /** What the picker shows: the workspace, qualified by its project when they differ. */
  label: string;
  /** The workspace directory on the daemon host, or `""` when the daemon did not report one. */
  directory: string;
}

function labelFor(workspace: WorkspaceSummary): string {
  const name = workspace.name.trim() || workspace.id;
  const project = workspace.projectDisplayName.trim();
  return project && project !== name ? `${project} / ${name}` : name;
}

/** Picker options for the workspaces that can still receive a terminal or a file, sorted by label. */
export function toWorkspaceOptions(workspaces: readonly WorkspaceSummary[]): WorkspaceOption[] {
  return workspaces
    .filter((workspace) => !workspace.archivingAt)
    .map((workspace) => ({
      id: workspace.id,
      label: labelFor(workspace),
      directory: workspace.workspaceDirectory ?? "",
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * The workspace to use: the remembered one while it still exists, else the only one there is.
 * `null` means the user has to choose, which also covers a remembered workspace that was removed.
 */
export function resolveWorkspaceId(
  remembered: string | undefined,
  options: readonly WorkspaceOption[],
): string | null {
  if (remembered && options.some((option) => option.id === remembered)) return remembered;
  return options.length === 1 ? options[0].id : null;
}
