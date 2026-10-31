# SSH session manager

A minimal MobaXterm-style screen. **Connect** opens `ssh` in a Paseo workspace terminal, and
**Files** browses the host's file tree with download and upload.

Install with `paseo plugin install /absolute/path/to/plugin-examples/ssh`, then reload after edits
with `paseo plugin reload ssh`.

## Where to find it

- **Sidebar → SSH.** The main screen. It is global, so it has a **Target workspace** picker
  (below).
- **Command Center (⌘K) → SSH.** Opens the same screen from anywhere.
- **Workspace panel.** Command Center → **SSH: Open hosts** in a workspace opens the panel as a
  tab. The workspace it sits in is the target, so it has no picker.
- **`/ssh <host>`** in a workspace composer connects without opening a screen.

## Use it

- **Screen layout.** Hosts on the left and the remote file browser on the right on wide layouts;
  on compact layouts (phones) the host list is replaced by the browser while a host is open, and
  **Hosts** goes back. The panel and the sidebar screen are the same component.
- **Target workspace.** The sidebar screen lists the workspaces of the selected host by project and
  name. **Connect**, **Download**, and **Upload** need one: the terminal opens in it, downloads
  land in its directory, and uploads read from it. The choice is saved in the plugin settings (per
  host) and restored next time. If the saved workspace no longer exists you are asked to choose
  again; if only one workspace exists it is used. After **Connect** the screen opens that workspace
  when the client supports it (`navigation.openWorkspace`); older clients only show the toast.
- **Hosts.** Both screens list user-added hosts and the hosts in the daemon user's `~/.ssh/config`.
  **Connect** opens a terminal tab named `ssh <label>` in the target workspace.
- **Slash command.** `/ssh <host>` in a workspace composer connects to the host whose label (user
  hosts, ignoring case) or alias (config hosts, exact) matches.
- **Files.** **Files** on a host opens a remote file tree that starts at the remote home, with
  **Up**, **Home**, and **Refresh**, and shows each entry's name, type, size, and modified time.
  Tap a folder to enter it. **Download** (the arrow icon on a file) copies a remote file into the current
  target workspace's directory on the daemon host. Open Paseo's file explorer to get it onto a phone or
  browser. **Upload…** lists the workspace directory (also server-side) and copies the chosen file
  to the remote folder you are viewing. Folders are not downloaded or uploaded, only single files,
  up to 2 GiB each.
- **Transfers run on the daemon.** A plugin RPC times out on the client after 60 seconds, so a copy
  is never run inside one: starting a transfer returns an id at once and the screen polls its status
  (bytes done, total, state) every second. **Cancel** stops it and tries to remove its partial file; if
  that fails, the screen says where the leftover file is. A
  transfer keeps running if you close the screen, but its progress and **Cancel** are only shown
  while the screen is open. At most four transfers run at once, and the daemon remembers at most 20
  finished ones (for up to an hour) in memory.
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
  Every local path from the screen is relative to it, is resolved with `realpath`, and must still be
  inside it: `..`, absolute paths, and symlinks that leave the directory are refused. Uploads open
  the file without following a final symlink. Downloads create the file with `O_EXCL`.
- **Nothing is overwritten.** A download fails when the workspace already has that name, and an
  upload fails when the remote folder already has it. Rename or delete the old file and retry.
- Each file operation starts its own `ssh` with a time limit and stops only that process. There are
  two separate caps: at most four directory listings and at most four transfers run at once.
- A transfer can be read or cancelled only with the workspace id that started it; any other workspace
  gets "not found". When the plugin is reloaded, disabled, removed, or the daemon shuts down, it
  cancels every running transfer and waits up to 15 seconds for each to remove its partial file.
- If the screen loses contact with the daemon three status polls in a row, it stops polling and offers
  **Retry** and **Dismiss**; the transfer may still be running.
- `ssh` still reads the user's config, so `ProxyCommand`, `ProxyJump`, and `IdentityFile` entries for
  a host apply to file browsing too (an alias that needs a password or a prompting proxy fails
  under `BatchMode`). The plugin overrides forwarding, TTY, `RemoteCommand`, local commands, control
  sockets, host-key updates, and password prompts. A host value that passes the validation above is
  still handed to `ssh`, so a `%h` in a `ProxyCommand` of yours deserves the usual care.
- Filesystem errors are reported in plain words (disk full, name too long, permission denied, file
  exists, no longer exists). If a failed upload cannot remove its partial file, the message gives the
  remote path to delete by hand.

## Limits

- Paseo plugins cannot focus a terminal tab (the client navigation API only opens agents and
  workspaces). **Connect** opens the workspace but not the new tab, so a toast names the tab
  (`ssh <label>`) and the workspace and you select the tab yourself. `/ssh` shows nothing on
  success.
- The workspace picker lists at most 1000 workspaces (five pages of 200) and hides ones being
  archived.
- `Host` patterns containing `*`, `?`, or `!` are skipped. `Include` is followed with `*`/`?` only in the
  last path segment, up to five levels, and is treated as unconditional; a file's own hosts are listed
  before the hosts it includes. `Match` blocks are ignored.
- A global surface has no workspace of its own, which is why the sidebar screen asks for a target
  workspace. Transfers started for one workspace are visible only through that workspace's id.
- Per-host Command Center items are not included. Every file operation opens a new `ssh` connection
  (no `ControlMaster`), so each listing takes a moment. Remote names that are not valid UTF-8 and
  names with control characters or backslashes cannot be downloaded.

### Known limits (accepted)

- A hard link inside the workspace directory to a file outside it can still be uploaded: it is a
  regular file inside the directory by every check the plugin can make. Refusing files with more
  than one link would also block legitimate files, and creating the link already needs the same
  user's access to the daemon host.
- A directory listing shows at most 2000 entries and says so when it cuts the list off. The list is
  not virtualized, so a very large folder renders slowly on a phone.
- Cleaning up a failed or cancelled download removes the partial file by its path. A process
  running as the same user could swap that path in the moment between the failure and the cleanup.
- A download is created directly in the workspace directory, so a remote file named `.envrc`,
  `.npmrc`, or similar creates a new dotfile there (an existing file is never overwritten). Review
  new files in a repository before trusting them.
- Names with backslashes are refused, because they would be a path separator on Windows.
