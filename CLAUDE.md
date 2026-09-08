<!-- PASEO_HARNESS:BEGIN -->

Đọc [Project Harness entry map](docs/harness/README.md) để tìm repository authority, validation và
hướng dẫn theo role. Với Paseo SLP, dùng role/assignment binding do daemon cung cấp. Lead đọc
[Workspace Protocol](WORKSPACE_PROTOCOL.md) trước orchestration; Peer chỉ nhận relevant
constraints trong assignment; Supervisor đọc protocol khi có governance mandate. Notebook location và
Beads project lấy từ binding, không tự suy từ cwd hoặc tên thư mục.

<!-- PASEO_HARNESS:END -->

# CLAUDE.md

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket. Connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, Cursor, Antigravity, and Codex-derived custom providers.
Compatibility adapters for other providers remain source-only and are disabled in the shipped runtime.

## Repository map

This is an npm workspace monorepo:

- `packages/server` — Daemon: agent lifecycle, WebSocket API, MCP server
- `packages/app` — Mobile + web client (Expo)
- `packages/cli` — Docker-style CLI (`paseo run/ls/logs/wait`)
- `packages/foundation-cli` — macOS Foundation installer and diagnostics
- `packages/relay` — E2E encrypted relay for remote access
- `packages/desktop` — Electron desktop wrapper
- `packages/website` — Marketing site (paseo.sh)

## Docs

`docs/` is the source of truth for system-level and process-level knowledge. **"The docs",
"check the docs", or "check the X docs" always mean this directory — not the web.** Look here before fetching anything online. At the start of
non-trivial work, list `docs/` and skim anything relevant to the task.

The full index, the doc-writing rules, and the doc voice live in [docs/README.md](docs/README.md).
The rules that bite most often: integrate, don't append; one fact, one doc — every other mention is
a link; delete obsolete sections. When you add a doc, add its row to the index in
[docs/README.md](docs/README.md).

This file is byte-budgeted: `scripts/agent-instructions.test.mjs` fails when `CLAUDE.md` grows past
20 KiB or `AGENTS.md` stops being a symlink to it. Agent runtimes truncate oversized instruction
files silently, so a rule pushed past the cap simply stops existing. Keep standing instructions
cache-stable: no timestamps, counters, or generated content in this file, `WORKSPACE_PROTOCOL.md`,
or bundled skills.

## Quick start

```bash
npm run dev                          # Start the dev daemon
npm run dev:app                      # Start Expo against the dev daemon
npm run dev:desktop                  # Start Electron desktop dev
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
./scripts/local-stack.sh             # Is the running daemon this tree? (exit 1 = stale)
./scripts/local-stack.sh --apply     # Import Foundation, build, install, restart
npm run typecheck                    # Always run after changes
npm run lint                         # Always run after changes
npm run format                       # Auto-format with Biome
npm run format:check                 # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `PASEO_HOME` resolves to `.dev/paseo-home`, and `npm run cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.paseo` on port `6767`.

See [docs/development.md](docs/development.md) for full setup, build sync requirements, and debugging.

## Critical rules

- **After daemon/runtime-facing changes, run the [Local completion gate](#local-completion-gate) without asking again.** `./scripts/local-stack.sh --apply` imports Foundation if the lock is behind, builds, refuses to restart unless fresh readback shows no agent running or starting, installs, and restarts. Preserve the existing home/listen/relay/WebUI settings unless the Human requests a change. If work is active or live state cannot be determined, it stops — report the blocker instead of forcing it.
  - **Verify with `./scripts/local-stack.sh` (no flag). Exit 0 means the daemon is running your tree.** It compares build provenance, not version strings. An installed daemon can carry the same version as the source with different bytes; that happened on 2026-08-13 and blocked every repository whose Workspace Protocol was newer than the stale build. A dev tree is normally dirty, so the commit alone cannot answer "is the daemon running my code" — only `sourceFingerprint` can.
  - **Two things go stale, not one.** `foundation/dist` is imported from a tagged `paseo-foundation` commit and pinned in `foundation/sources.lock.json`; the daemon is built from this checkout. Rebuilding without re-importing ships old doctrine with new code. Tag Foundation first — the importer refuses a dirty or untagged source, and counts untracked files as dirty.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Before changing app routes, startup routing, remembered workspace restore, or active workspace selection, read [docs/expo-router.md](docs/expo-router.md).**
- **NEVER run the full test suite locally.** The test suites are heavy and will freeze the machine, especially if multiple agents run them in parallel. Rules:
  - Run only the specific test file you changed: `npx vitest run <file> --bail=1`
  - Never run `npm run test` for an entire workspace unless explicitly asked.
  - If you must run a broad suite, pipe output to a file and read it afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1` then read the file.
  - Never re-run a test suite that another agent already ran and reported green — trust the result.
  - For full suite verification, push to CI and check GitHub Actions instead.
- **Always run typecheck and lint after every change.**
- **Build workspace packages before diagnosing cross-package type errors.** This repo consumes generated declarations across workspaces. If typecheck fails in a package that depends on another workspace, rebuild the owning stack first so `dist` declarations are current:
  - `npm run build:client` — rebuild protocol and client declarations.
  - `npm run build:server` — rebuild highlight, relay, protocol, client, server, and CLI when server/CLI types may be stale.
  - Do not patch inferred callback parameters or add local duplicate types just to silence stale declaration errors.
- **Run `npm run format` before committing.** This repo uses Biome for formatting. Do not manually fix formatting — let the formatter handle it.
- **Always use npm scripts for linting and formatting.** Do not run tools directly with `npx eslint`, `npx oxfmt`, `npx oxlint`, or package-local binaries. For targeted checks, pass file paths through the npm script:
  - `npm run lint -- packages/app/src/components/message.tsx`
  - `npm run format:files -- CLAUDE.md packages/app/src/components/message.tsx`
- **The protocol stays backward-compatible. Features don't have to.** Read [docs/protocol-compatibility.md](docs/protocol-compatibility.md) before touching `packages/protocol`. The short version:
  - **Protocol contract (always):** an old client parses messages from a new daemon, and a new daemon parses messages from an old client. New fields are optional; never narrow, never remove, never require. Wire schemas stay pure — no `.transform()`, `.catch()`, or `.preprocess()`.
  - **Feature contract (per-feature):** gate the capability once on `server_info.features.*`, then run the feature or tell the user to update the host. No fallback paths, no defensive branches.
  - **Every shim is tagged.** `// COMPAT(name): added in vX, remove after <date>` at the site that has to be deleted. `rg "COMPAT\("` is the cleanup backlog; untagged back-compat is permanent by accident.
  - **New RPCs use dotted namespaces with direction suffixes.** Follow [docs/rpc-namespacing.md](docs/rpc-namespacing.md): `domain.provider.operation.request` pairs with `domain.provider.operation.response`. Existing flat RPC names will migrate over time; don't add new ones.

## Platform gating

The app runs on iOS, Android, web (browser), and web (Electron desktop). Code is cross-platform by
default; gate only when you must. Import `isWeb`/`isNative` from `@/constants/platform` — never
write `const isWeb = Platform.OS === "web"` locally. The four gates (`isWeb`, `isNative`,
`getIsElectron()`, `useIsCompactFormFactor()`), the decision matrix, and the Metro
`.web.ts`/`.native.ts`/`.electron.ts` file-extension rules are in
[docs/platform-gating.md](docs/platform-gating.md) — read it before adding any platform branch.
Two rules crash or silently break when missed: never touch DOM APIs outside an `isWeb` guard, and
never use `onPointerEnter`/`onPointerLeave` (hover never fires on native iOS — use
`isHovered || isNative || isCompact` for hover-to-show UI).

## Debugging

Find the complete daemon logs and traces in the $PASEO_HOME/daemon.log

## Local completion gate

For every runtime-facing change, source edits and tests are not completion. Before handback:

1. Bump `version`, run `npm run version:sync-internal`; never rebuild over the same version string — the previous release under `~/.local/share/paseo-web-cli/releases/` stays a one-symlink rollback.
2. Run the focused tests, typecheck, and lint required by the changed scope.
3. When no agent or workspace script is active, run `./scripts/local-stack.sh --apply` to build, install, and restart the local stack.
4. Read back the installed CLI and daemon versions, source fingerprint, daemon health, WebUI at `http://127.0.0.1:6767`, and the Beads Central endpoint.
5. Run a fresh live canary for the changed behavior. Source bytes, static checks, and an artifact build do not replace live evidence.

If the idle gate, build, install, restart, or readback cannot complete safely, report `BLOCKED` with the exact reason instead of claiming the change is active locally. Preserve dirty-worktree changes outside the current task.
