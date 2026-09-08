/**
 * Bootstrap default project targets for the Project Harness (per the
 * 2026-09-07 pinned Lead decision on tm5). These are the paths a project
 * gets when no other authorized durable project location has been selected
 * for it — never derived from cwd or nearest-artifact discovery.
 */
export const DEFAULT_HARNESS_ENTRY_MAP_PATH = "docs/harness/README.md";
export const DEFAULT_HARNESS_PROJECT_METADATA_PATH = ".paseo/harness.json";
export const DEFAULT_SUPERVISOR_NOTEBOOK_PATH = "docs/harness/SUPERVISOR_NOTEBOOK.md";
