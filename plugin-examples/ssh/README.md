# SSH session manager

A MobaXterm-style screen: a sidebar of hosts or files beside session tabs and a terminal. Connecting
runs `ssh` and shows an interactive terminal inside the plugin's own screen, and the SFTP view
browses the host's file tree, downloads files to the phone or
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

- **Screen layout.** On wide layouts a sidebar (about 280 points) has a **Sessions | SFTP**
  switch. **Sessions** lists the hosts, grouped as _Saved hosts_ and _From ~/.ssh/config_, with a
  search field and a **+** to add a host. **SFTP** browses the files of the active session's host.
  Beside the sidebar are the open sessions as tabs (icon, label, ×, and a **+** that returns to the
  host list) over the terminal, or **Pick a host to connect** with quick-connect hosts when no
  session is open. Running transfers dock at the bottom of the sidebar, and a status bar under the
  screen shows the active host, its connection state, and a transfer summary. On compact layouts
  (phones) a **Sessions | Terminal | SFTP** switch across the top shows one full-width view at a
  time; rows are 44 points tall and their buttons are always visible. The panel and the sidebar
  screen are the same component.
- **Hosts.** Both screens list user-added hosts and the hosts in the daemon user's `~/.ssh/config`.
  A click selects a host; a double-click, a tap on a phone, or Enter in the search field connects.
  Hover or select a row for its buttons: connect, browse files, and (for saved hosts) edit and
  remove. Connecting asks the daemon to start `ssh` in a terminal named `ssh <label>` that the plugin owns,
  starting in the daemon user's home directory, and shows it in the pane. Typing, a password or
  passphrase, resize, colors, copy and paste, find, and the mobile key bar all work there.
  Connecting stays on the screen.
- **Sessions.** Every screen lists the same running sessions (all of this plugin's terminals on the
  host) and shows the newest, so reopening the screen reattaches to ssh that is still running. Pick
  a tab to switch sessions; × ends one. When ssh exits, its tab goes away. Closing the screen
  keeps ssh running, and so does archiving any workspace. Reloading, disabling, or removing the
  plugin, or restarting the daemon, ends every session.
- **Slash command.** `/ssh <host>` in a workspace composer connects to the host whose label (user
  hosts, ignoring case) or alias (config hosts, exact) matches, then opens the **SSH hosts** panel,
  which shows the newest session.
- **Files.** The folder button on a host (or the **SFTP** view, which follows the active session's
  host) opens a remote file tree that starts at the remote home, with **Up**, **Home**, and
  **Refresh** buttons and a clickable breadcrumb, and shows each entry's name, size, and modified
  time. Press a folder to enter it and a file to select it. **Download** (the arrow icon on a file,
  or **Download selected**) copies the remote file to a
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
- **Add or remove.** User-added hosts store a label, host, optional user, port, identity file
  _path_, and optional VPN profile name in the plugin settings (shared by every client of the host).
  Config hosts are read-only.
- **VPN.** A saved host can name a VPN profile; the plugin then opens that VPN on demand and does not
  touch it otherwise. See [On-demand VPN](#on-demand-vpn).

## On-demand VPN

Some hosts are only reachable through a VPN. Rather than starting and stopping the VPN by hand, mark
the host as needing one: the plugin opens the shared on-demand VPN when a session or file operation
starts, and releases it when that ends. The VPN itself is owned by a shared script (`vpn_session.sh`,
from the GoPaperless-Workflow-API database skill) that keeps one OpenVPN tunnel for every user and
closes it about 2 minutes after the last one. This plugin only calls the script's
`exec` subcommand and never starts or stops OpenVPN itself.

**Set up.** In the sidebar's **Sessions** view, under **VPN profiles**, press **+** and fill in a
name and four absolute paths on the daemon host: the script, the `openvpn` binary, the `.ovpn`
config, and the OpenVPN management socket. Then add or edit a saved host and pick the profile under
VPN. The host row shows a **VPN** badge. The profiles live in the plugin settings
(`vpnProfiles`, shared by every client of the host); nothing in the plugin is tied to one machine's
paths. Renaming a profile renames it on the hosts that use it; removing one leaves those hosts
naming it, and connecting to them fails with a message that the profile is not defined.

**Lifecycle.**

- **Terminal session.** Connect first runs `bash <script> exec ... -- true` (a _preflight_, up to 45
  seconds) so a cold VPN start is paid before any terminal exists. If it fails, **Connect** reports
  the script's `gkg-vpn:` message and no terminal is created. If it succeeds the terminal runs
  `bash <script> exec <openvpn> <config> <socket> <host> <port> -- ssh ...`: the script takes a lease
  for its own process, finds the tunnel open, and `exec`s `ssh`, so ssh itself holds the lease. Close
  the tab, or let ssh exit, and the lease ends with the process. The plugin keeps no up/down record
  and never uses its own process as the holder.
- **Files.** Each listing or transfer runs the same preflight (30 seconds for a listing, 45 for a
  transfer, before the operation's own time limit starts), then runs `ssh -s sftp` behind `exec`.
  stdout stays the SFTP channel because the script writes nothing to it. A failure before ssh starts
  shows as "Could not open the VPN: ..." with the script's message.
- **Closing.** About 2 minutes after the last lease ends, the script closes the VPN. An idle ssh
  session is **not** disconnected: a session that stays open keeps its lease and the VPN stays up.
  Reloading or disabling the plugin, or restarting the daemon, ends every session and transfer, so
  their leases end and the VPN closes after the grace period.
- **Already reachable.** If the host already answers (another VPN is up), the script just runs the
  command and holds no tunnel.

**The probe.** The script waits until the host's own address and port answer (port 22 when the host
has none), so set the port on the host if its ssh server listens elsewhere.

**Limits.**

- Hosts from `~/.ssh/config` cannot use a VPN in this version: they connect by alias, and finding
  the address `ssh` would really use needs `ProxyJump`, `Include`, and `%h` handling. Add the host
  as a saved host to use a VPN with it.
- The plugin needs the script's `exec` subcommand. With an older `vpn_session.sh` the preflight
  fails with the script's own message.
- `bash`, the script, and passwordless `sudo` for `openvpn` (as the script already requires) must
  work for the daemon's user.

## Security

- Passwords, passphrases, and key contents are never stored. `ssh` prompts for them in the session.
- The session is a terminal the plugin owns: the daemon creates it for the plugin's own session as
  `plugin:ssh`, with no workspace, so no workspace lists, archives, or reports it, and the daemon
  ends it with the plugin. That ownership is hygiene, not a security boundary, because plugins are
  trusted local code that can reach the daemon.
- **Any signed-in client can reach a session.** Like every terminal under Paseo's operator model,
  any client signed in to the host can list the plugin's sessions, attach to one, type into it, and
  end it by id. Attach cannot be limited to the plugin, because the Paseo app itself renders the
  plugin's terminal. Treat access to the host as access to every open ssh session.
- `ssh` runs from an argv array, never through a shell, with `--` before the destination. Behind a
  VPN the whole command is `bash <script> exec ... -- ssh ...`, also an argv array. A client sends
  only a profile _name_; the daemon looks up the script and paths in the plugin settings, so a screen
  cannot make the daemon run another file. Profile paths must be absolute, with no control
  characters, and a profile name uses letters, digits, `.`, `_`, and `-`. A host,
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

## Upgrade note

Sessions now belong to the plugin, not a workspace. Sessions started by the previous version in a
workspace (owned terminals named `ssh <label>`) also end when the plugin is reloaded, disabled, or
removed, which includes the reload that installs this version.

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
