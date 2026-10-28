# SSH session manager

A minimal MobaXterm-style host list. **Connect** opens `ssh` in a Paseo workspace terminal.

Install with `paseo plugin install /absolute/path/to/plugin-examples/ssh`, then reload after edits
with `paseo plugin reload ssh`.

## Use it

- **Panel.** Command Center → **SSH: Open hosts**. The panel lists user-added hosts and the hosts in the daemon user's `~/.ssh/config`.
  **Connect** opens a terminal tab named `ssh <label>` in the current workspace.
- **Slash command.** `/ssh <host>` in a workspace composer connects to the host whose label (user
  hosts, ignoring case) or alias (config hosts, exact) matches.
- **Add or remove.** User-added hosts store a label, host, optional user, port, and identity file
  _path_ in the plugin settings (shared by every client of the host). Config hosts are read-only.

## Security

- Passwords, passphrases, and key contents are never stored. `ssh` prompts for them in the terminal.
- `ssh` runs from an argv array, never through a shell, with `--` before the destination. A host,
  alias, or user that is empty, starts with `-`, or contains whitespace or control characters is
  rejected, as is an identity file path that starts with `-` or contains control characters.
- Config hosts connect by alias (`ssh -- <alias>`), so `ssh` applies its own config.

## Limits

- Paseo plugins cannot focus a terminal tab (the client navigation API only opens agents and
  workspaces), so the panel shows a toast pointing at the new tab and `/ssh` shows nothing on success.
- `Host` patterns containing `*`, `?`, or `!` are skipped. `Include` is followed with `*`/`?` only in the
  last path segment, up to five levels, and is treated as unconditional; a file's own hosts are listed
  before the hosts it includes. `Match` blocks are ignored.
- The panel is workspace-scoped rather than a global sidebar surface because a surface has no
  workspace to open the terminal in.
- SFTP and per-host Command Center items are not included.
