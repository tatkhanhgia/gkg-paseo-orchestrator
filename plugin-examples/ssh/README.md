# SSH session manager

A minimal MobaXterm-style screen. **Connect** runs `ssh` and shows an interactive terminal inside
the plugin's own screen, and **Files** browses the host's file tree, downloads files to the phone or
browser you are using, and uploads files from it. Nothing here uses or touches a workspace.

Install with `paseo plugin install /absolute/path/to/plugin-examples/ssh`, then reload after edits
with `paseo plugin reload ssh`.

## Where to find it

- **Sidebar → SSH.** The main screen.
- **Command Center (⌘K) → SSH.** Opens the same screen from anywhere.
- **Workspace panel.** Command Center → **SSH: Open hosts** in a workspace opens the same screen as
  a tab. The workspace it sits in plays no part.
- **`/ssh <host>`** in a workspace composer starts the session and opens the **SSH hosts** panel
  showing it. The session still belongs to no workspace.

## Use it

- **Screen layout.** Hosts on the left on wide layouts, and on the right a pane that switches
  between **Files** and the running sessions (one chip each, with an × to close it). On compact
  layouts (phones) the session or the file browser replaces the host list while it is open, and
  the back arrow or **Hosts** returns. The panel and the sidebar screen are the same component.
- **Hosts.** Both screens list user-added hosts and the hosts in the daemon user's `~/.ssh/config`.
  **Connect** asks the daemon to start `ssh` in a terminal named `ssh <label>` that the plugin owns,
  starting in the daemon user's home directory, and shows it in the pane. Typing, a password or
  passphrase, resize, colors, copy and paste, find, and the mobile key bar all work there.
  **Connect** stays on the screen.
- **Sessions.** Every screen lists the same running sessions (all of this plugin's terminals on the
  host) and shows the newest, so reopening the screen reattaches to ssh that is still running. Pick
  a chip to switch sessions; × ends one. When ssh exits, its chip goes away. Closing the screen
  keeps ssh running, and so does archiving any workspace. Reloading, disabling, or removing the
  plugin, or restarting the daemon, ends every session.
- **Slash command.** `/ssh <host>` in a workspace composer connects to the host whose label (user
  hosts, ignoring case) or alias (config hosts, exact) matches, then opens the **SSH hosts** panel,
  which shows the newest session.
- **Files.** **Files** on a host opens a remote file tree that starts at the remote home, with
  **Up**, **Home**, and **Refresh**, and shows each entry's name, type, size, and modified time.
  Tap a folder to enter it. **Download** (the arrow icon on a file) copies the remote file to a
  private staging folder on the daemon host, then saves it to this device: the browser's download on
  web and desktop, the share sheet on iOS and Android. The staged copy is deleted 90 seconds after
  the save, or 15 minutes after the copy if the screen was closed before it could save. **Upload from
  device…** opens this device's file picker, sends the chosen file to the daemon host, and copies it
  to the remote folder you are viewing; the copy on the daemon host is deleted when the transfer
  ends. Folders are not downloaded or uploaded, only single files.
- **Transfers run on the daemon.** A plugin RPC times out on the client after 60 seconds, so a copy
  is never run inside one: starting a transfer returns an id at once and the screen polls its status
  (bytes done, total, state) every second. **Cancel** stops it and tries to remove its partial file; if
  that fails, the screen says where the leftover file is. A transfer keeps running if you close the
  screen, but its progress, **Cancel**, and the save to this device only happen while the screen is
  open. At most four transfers run at once, and the daemon remembers at most 20 finished ones (for
  up to an hour) in memory.
- **Add or remove.** User-added hosts store a label, host, optional user, port, and identity file
  _path_ in the plugin settings (shared by every client of the host). Config hosts are read-only.

## Security

- Passwords, passphrases, and key contents are never stored. `ssh` prompts for them in the session.
- The session is a terminal the plugin owns: the daemon creates it for the plugin's own session as
  `plugin:ssh`, with no workspace, so no workspace lists, archives, or reports it, and the daemon
  ends it with the plugin. That ownership is hygiene, not a security boundary, because plugins are
  trusted local code that can reach the daemon.
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
- **No local path comes from the screen.** A download lands in a new private (`0700`) folder under
  the OS temp directory (`paseo-ssh-*`), created with `O_EXCL`, and the screen only gets that folder
  back to save it. An upload is named by the handle Paseo returned for the picked file; the daemon
  resolves it inside its own upload folder and refuses anything else, so the screen cannot make the
  plugin send another file from the daemon host. The plugin then opens it without following a final
  symlink and checks it is still the same file.
- **Nothing is overwritten.** Each download gets its own folder, and an upload fails when the remote
  folder already has that name. Rename or delete the old file and retry.
- Each file operation starts its own `ssh` with a time limit and stops only that process. There are
  two separate caps: at most four directory listings and at most four transfers run at once.
- A transfer is read, cancelled, or released by its id, a random UUID returned only to the screen
  that started it. When the plugin is reloaded, disabled, removed, or the daemon shuts down, it
  cancels every running transfer, waits up to 15 seconds for each to remove its partial file, and
  deletes every staged download. Staging folders left by a plugin process that crashed are deleted
  the next time the plugin starts.
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

- Sessions need a daemon that runs plugin terminals outside a workspace and an app whose plugin UI has
  `TerminalView`. On an older daemon **Connect** says "Update the host to run SSH sessions outside a
  workspace."; on an older app it says to update the Paseo app. Download and upload need an app with
  `useDeviceFiles` and, for upload, a daemon with `resolveDeviceUpload`; otherwise the screen asks you
  to update. The manifest cannot block any of these, so the rest of the plugin keeps working.
- **Size limits on the device.** Upload reads the picked file into memory, so it is capped at 50 MB.
  Download has no cap over a direct connection (the 2 GiB transfer limit applies); over a relay or
  other indirect connection Paseo reads the file through the session, up to 64 MB.
- Owned terminals send no push events, so the session list refreshes when you open the screen,
  connect, close a session, or ssh exits in a visible session. An ssh that ends while its screen is
  closed disappears the next time the list is read.
- The terminal is verified in a desktop browser (wide and compact layouts). It and the device save and
  pick are not yet verified on a device (iOS or Android).
- `Host` patterns containing `*`, `?`, or `!` are skipped. `Include` is followed with `*`/`?` only in the
  last path segment, up to five levels, and is treated as unconditional; a file's own hosts are listed
  before the hosts it includes. `Match` blocks are ignored.
- Per-host Command Center items are not included. Every file operation opens a new `ssh` connection
  (no `ControlMaster`), so each listing takes a moment. Remote names that are not valid UTF-8 and
  names with control characters or backslashes cannot be downloaded.

### Known limits (accepted)

- A directory listing shows at most 2000 entries and says so when it cuts the list off. The list is
  not virtualized, so a very large folder renders slowly on a phone.
- Cleaning up a failed or cancelled download removes the partial file by its path. A process
  running as the same user could swap that path in the moment between the failure and the cleanup.
- A staged download stays on the daemon host for up to 15 minutes if the screen closes before
  saving it. If the daemon is killed without a clean shutdown, staged downloads stay in the temp
  folder until the plugin starts again.
- Names with backslashes are refused, because they would be a path separator on Windows.
