# SSH session manager

A minimal MobaXterm-style host list. **Connect** opens `ssh` in a Paseo workspace terminal, and
**Files** browses the host's file tree with download and upload.

Install with `paseo plugin install /absolute/path/to/plugin-examples/ssh`, then reload after edits
with `paseo plugin reload ssh`.

## Use it

- **Panel.** Command Center → **SSH: Open hosts**. The panel lists user-added hosts and the hosts in the daemon user's `~/.ssh/config`.
  **Connect** opens a terminal tab named `ssh <label>` in the current workspace.
- **Slash command.** `/ssh <host>` in a workspace composer connects to the host whose label (user
  hosts, ignoring case) or alias (config hosts, exact) matches.
- **Files.** **Files** on a host opens a remote file tree that starts at the remote home, with
  **Up**, **Home**, and **Refresh**, and shows each entry's name, type, size, and modified time.
  Tap a folder to enter it. **Download** (the arrow icon on a file) copies a remote file into the current
  workspace's directory on the daemon host. Open Paseo's file explorer to get it onto a phone or
  browser. **Upload…** lists the workspace directory (also server-side) and copies the chosen file
  to the remote folder you are viewing. Folders are not downloaded or uploaded, only single files,
  up to 2 GiB each.
- **Add or remove.** User-added hosts store a label, host, optional user, port, and identity file
  _path_ in the plugin settings (shared by every client of the host). Config hosts are read-only.

## Security

- Passwords, passphrases, and key contents are never stored. `ssh` prompts for them in the terminal.
- `ssh` runs from an argv array, never through a shell, with `--` before the destination. A host,
  alias, or user that is empty, starts with `-`, or contains whitespace or control characters is
  rejected, as is an identity file path that starts with `-` or contains control characters.
- Config hosts connect by alias (`ssh -- <alias>`), so `ssh` applies its own config.
- **File browsing uses keys or ssh-agent only.** It runs `ssh -o BatchMode=yes ... -s -- <host> sftp`,
  so a password or passphrase prompt fails at once with "this host needs a key or ssh-agent for file
  browsing; the terminal still works". It forces `StrictHostKeyChecking=yes`, so an unknown or changed
  host key is refused and never added to `known_hosts`; connect once with the terminal to trust it.
  It sets `ControlMaster=no` and `ControlPath=none`, so no connection is shared or left running.
- **No remote shell, no quoting.** The plugin speaks the SFTP protocol itself over the `sftp`
  subsystem of the system `ssh`. A remote path is a length-prefixed byte string, never part of a
  shell command or an `sftp -b` batch line, so quotes, newlines, `$()`, a leading `-` or `!` are
  just characters in a name.
- **Local paths are confined.** The daemon resolves the workspace directory from the workspace id.
  Every local path from the panel is relative to it, is resolved with `realpath`, and must still be
  inside it: `..`, absolute paths, and symlinks that leave the directory are refused. Uploads open
  the file without following a final symlink. Downloads create the file with `O_EXCL`.
- **Nothing is overwritten.** A download fails when the workspace already has that name, and an
  upload fails when the remote folder already has it. Rename or delete the old file and retry.
- Each file operation starts its own `ssh` with a time limit, stops only that process, and at most
  four run at once.

## Limits

- Paseo plugins cannot focus a terminal tab (the client navigation API only opens agents and
  workspaces), so the panel shows a toast pointing at the new tab and `/ssh` shows nothing on success.
- `Host` patterns containing `*`, `?`, or `!` are skipped. `Include` is followed with `*`/`?` only in the
  last path segment, up to five levels, and is treated as unconditional; a file's own hosts are listed
  before the hosts it includes. `Match` blocks are ignored.
- The panel is workspace-scoped rather than a global sidebar surface because a surface has no
  workspace to open the terminal in.
- Per-host Command Center items are not included. Every file operation opens a new `ssh` connection
  (no `ControlMaster`), so each listing takes a moment. Remote names that are not valid UTF-8 and
  names with control characters or backslashes cannot be downloaded.
