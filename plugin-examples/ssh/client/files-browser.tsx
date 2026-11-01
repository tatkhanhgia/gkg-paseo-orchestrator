import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { listRemoteFilesRpc, type FileEntry, type FileFailure } from "../shared/contracts";
import type { SshHostEntry } from "../shared/hosts";
import { remoteJoin, remoteParent } from "../shared/remote-path";
import { FileRow } from "./file-row";
import { REMOTE_KEY, UPDATE_APP_MESSAGE, type Transfers } from "./transfers";
import type { Layout, Theme } from "./types";
import { FONT_SIZE, IconButton, SPACE } from "./ui-kit";

function failureText(
  result: { ok: true } | FileFailure | undefined,
  error: unknown,
): string | null {
  if (error) return error instanceof Error ? error.message : String(error);
  if (result && !result.ok) return result.message;
  return null;
}

/** Why a toolbar button is disabled, or `null` when none is. */
function remoteHint(canTransfer: boolean, hasListing: boolean, loading: boolean): string | null {
  if (!canTransfer) return UPDATE_APP_MESSAGE;
  return hasListing ? null : uploadHint(loading);
}

/** Why Upload is disabled while the remote folder has no listing. */
function uploadHint(loading: boolean): string {
  return loading
    ? "Upload is available once the remote folder has loaded."
    : "Upload needs a remote folder that loaded. Press Refresh, or go Up.";
}

function parentOfPath(path: string | undefined): string | null {
  return path === undefined ? null : remoteParent(path);
}

function useRemoteListing(entry: SshHostEntry) {
  const listRemote = useRpc(listRemoteFilesRpc);
  const [path, setPath] = useState<string | undefined>(undefined);
  const query = useQuery({
    queryKey: [...REMOTE_KEY, entry.key, path ?? ""],
    queryFn: () => listRemote({ target: entry.target, path }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const listing = query.data?.ok ? query.data : null;
  // After a failed listing there is no listing to ask for a parent, so work it out from the path.
  const parent = listing ? listing.parent : parentOfPath(path);
  const open = useCallback(
    (item: FileEntry) => {
      if (listing) setPath(remoteJoin(listing.path, item.name));
    },
    [listing],
  );
  const up = useCallback(() => {
    if (parent) setPath(parent);
  }, [parent]);
  const home = useCallback(() => setPath(undefined), []);
  const goTo = useCallback((target: string) => setPath(target), []);
  const refresh = useCallback(() => void query.refetch(), [query]);
  return { query, listing, parent, open, up, home, goTo, refresh };
}

interface CrumbProps {
  theme: Theme;
  label: string;
  path: string;
  last: boolean;
  onGo(path: string): void;
}

function Crumb({ theme, label, path, last, onGo }: CrumbProps) {
  const styles = useMemo(
    () => ({
      crumb: { flexDirection: "row" as const, alignItems: "center" as const },
      press: { paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xs },
      text: {
        color: last ? theme.colors.foreground : theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.small,
        fontWeight: last ? ("600" as const) : ("400" as const),
      },
    }),
    [theme, last],
  );
  const handlePress = useCallback(() => onGo(path), [onGo, path]);
  return (
    <View style={styles.crumb}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Go to ${path}`}
        onPress={handlePress}
        style={styles.press}
      >
        <Text style={styles.text}>{label}</Text>
      </Pressable>
      {last ? null : <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />}
    </View>
  );
}

interface BreadcrumbProps {
  theme: Theme;
  path: string | null;
  onGo(path: string): void;
}

/** The remote folder as clickable segments, the root first. */
function Breadcrumb({ theme, path, onGo }: BreadcrumbProps) {
  const styles = useMemo(
    () => ({
      bar: {
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        flexGrow: 0,
      },
      content: {
        alignItems: "center" as const,
        paddingHorizontal: SPACE.sm,
        paddingVertical: SPACE.xs,
      },
      home: {
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.small,
        paddingHorizontal: SPACE.sm,
        paddingVertical: SPACE.xs,
      },
    }),
    [theme],
  );
  if (path === null) {
    return (
      <View style={styles.bar}>
        <Text style={styles.home}>Remote home</Text>
      </View>
    );
  }
  const names = path.split("/").filter(Boolean);
  const crumbs = [
    { label: "/", path: "/" },
    ...names.map((name, index) => ({
      label: name,
      path: `/${names.slice(0, index + 1).join("/")}`,
    })),
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
      contentContainerStyle={styles.content}
    >
      {crumbs.map((crumb, index) => (
        <Crumb
          key={crumb.path}
          theme={theme}
          label={crumb.label}
          path={crumb.path}
          last={index === crumbs.length - 1}
          onGo={onGo}
        />
      ))}
    </ScrollView>
  );
}

const TRANSFER_NOTE =
  "Download saves a file to this device; Upload from device sends a file from this device to the folder shown. Existing remote files are never overwritten. Transfers keep running on the daemon if you close this screen, but progress, cancel, and the save to this device happen only while it is open. Browsing needs a key or ssh-agent; the terminal still works for password logins.";

interface NoticesProps {
  theme: Theme;
  note: string | null;
  hint: string | null;
  failure: string | null;
  loading: boolean;
}

/** The short messages above the entries: the transfer note, why a button is off, an error. */
function Notices({ theme, note, hint, failure, loading }: NoticesProps) {
  const styles = useMemo(
    () => ({
      message: {
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.small,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.xs,
      },
      error: {
        color: theme.colors.statusDanger,
        fontSize: FONT_SIZE.small,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.xs,
      },
    }),
    [theme],
  );
  return (
    <>
      {note ? <Text style={styles.message}>{note}</Text> : null}
      {hint ? <Text style={styles.message}>{hint}</Text> : null}
      {failure ? <Text style={styles.error}>{failure}</Text> : null}
      {loading ? <Text style={styles.message}>Loading…</Text> : null}
    </>
  );
}

interface ListFooterProps {
  theme: Theme;
  empty: boolean;
  truncated: boolean;
}

function ListFooter({ theme, empty, truncated }: ListFooterProps) {
  const style = useMemo(
    () => ({
      color: theme.colors.foregroundMuted,
      fontSize: FONT_SIZE.small,
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.xs,
    }),
    [theme],
  );
  return (
    <>
      {empty ? <Text style={style}>This folder is empty.</Text> : null}
      {truncated ? <Text style={style}>Only the first entries are shown.</Text> : null}
    </>
  );
}

interface FilesBrowserProps {
  entry: SshHostEntry;
  theme: Theme;
  layout: Layout;
  transfers: Transfers;
}

/** The SFTP view of one host: toolbar, breadcrumb, and the folder's entries. */
export function FilesBrowser({ entry, theme, layout, transfers }: FilesBrowserProps) {
  const compact = layout.compact;
  const remote = useRemoteListing(entry);
  const listing = remote.listing;
  const { download, uploadFromDevice, canTransfer } = transfers;
  const busy = transfers.starting;
  const [picked, setPicked] = useState<{ path: string; name: string } | null>(null);
  const [showNote, setShowNote] = useState(false);

  const selected =
    listing && picked?.path === listing.path
      ? (listing.entries.find((item) => item.name === picked.name && item.kind === "file") ?? null)
      : null;

  const handleSelect = useCallback(
    (item: FileEntry) => {
      if (listing) setPicked({ path: listing.path, name: item.name });
    },
    [listing],
  );
  const handleDownload = useCallback(
    (item: FileEntry) => {
      if (!listing) return;
      download({ target: entry.target, remotePath: remoteJoin(listing.path, item.name) });
    },
    [listing, entry.target, download],
  );
  const handleDownloadSelected = useCallback(() => {
    if (selected) handleDownload(selected);
  }, [selected, handleDownload]);
  const handleUpload = useCallback(() => {
    if (!listing) return;
    uploadFromDevice({ target: entry.target, remoteDirectory: listing.path });
  }, [listing, entry.target, uploadFromDevice]);
  const toggleNote = useCallback(() => setShowNote((current) => !current), []);

  const styles = useMemo(
    () => ({
      panel: { flex: 1, minHeight: 0 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.sm,
        paddingHorizontal: SPACE.md,
        paddingTop: SPACE.xs,
        paddingBottom: SPACE.sm,
      },
      headerText: { flex: 1, minWidth: 0 },
      title: {
        color: theme.colors.foreground,
        fontSize: FONT_SIZE.body,
        fontWeight: "600" as const,
      },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.xs,
        paddingHorizontal: SPACE.sm,
        paddingBottom: SPACE.xs,
      },
      spacer: { flex: 1 },
      list: { flex: 1, minHeight: 0 },
      listContent: { padding: SPACE.xs, paddingBottom: SPACE.lg },
    }),
    [theme],
  );

  const failure = failureText(remote.query.data, remote.query.error);
  const hint = remoteHint(canTransfer, listing !== null, remote.query.isFetching);
  const loading = remote.query.isFetching && !remote.query.data;
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Icon name="FolderTree" size={16} color={theme.colors.foregroundMuted} />
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {entry.label}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {entry.detail}
          </Text>
        </View>
      </View>
      <View style={styles.toolbar}>
        <IconButton
          theme={theme}
          compact={compact}
          icon="ArrowUp"
          label="Up"
          disabled={!remote.parent}
          onPress={remote.up}
        />
        <IconButton
          theme={theme}
          compact={compact}
          icon="Home"
          label="Home"
          onPress={remote.home}
        />
        <IconButton
          theme={theme}
          compact={compact}
          icon="RefreshCw"
          label="Refresh"
          onPress={remote.refresh}
        />
        <View style={styles.spacer} />
        <IconButton
          theme={theme}
          compact={compact}
          icon="Upload"
          label="Upload from device…"
          disabled={!listing || !canTransfer || busy}
          onPress={handleUpload}
        />
        <IconButton
          theme={theme}
          compact={compact}
          icon="Download"
          label="Download selected"
          disabled={!selected || !canTransfer || busy}
          onPress={handleDownloadSelected}
        />
        <IconButton
          theme={theme}
          compact={compact}
          icon="Info"
          label="About file transfers"
          active={showNote}
          onPress={toggleNote}
        />
      </View>
      <Breadcrumb theme={theme} path={listing?.path ?? null} onGo={remote.goTo} />
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        <Notices
          theme={theme}
          note={showNote ? TRANSFER_NOTE : null}
          hint={hint}
          failure={failure}
          loading={loading}
        />
        {listing?.entries.map((item) => (
          <FileRow
            key={item.name}
            entry={item}
            theme={theme}
            compact={compact}
            selected={selected?.name === item.name}
            disabled={busy || !canTransfer}
            onSelect={handleSelect}
            onOpenDirectory={remote.open}
            onDownload={handleDownload}
          />
        ))}
        <ListFooter
          theme={theme}
          empty={listing?.entries.length === 0}
          truncated={listing?.truncated === true}
        />
      </ScrollView>
    </View>
  );
}
