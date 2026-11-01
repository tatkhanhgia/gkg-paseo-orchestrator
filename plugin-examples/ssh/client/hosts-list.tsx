import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { filterHostEntries, type SshHostEntry } from "../shared/hosts";
import { HostForm } from "./host-form";
import { HostRow, type HostStatus } from "./host-row";
import type { Layout, Theme } from "./types";
import type { HostEntries } from "./use-host-entries";
import {
  FONT_SIZE,
  IconButton,
  MIN_TOUCH_TARGET,
  ROW_HEIGHT,
  SectionHeader,
  SPACE,
} from "./ui-kit";

/** What the form above the list is doing. */
type FormState = { kind: "closed" } | { kind: "add" } | { kind: "edit"; id: string };

const CLOSED: FormState = { kind: "closed" };
const ADDING: FormState = { kind: "add" };

interface HostsListProps {
  theme: Theme;
  layout: Layout;
  hosts: HostEntries;
  /** Keys of hosts that have a running session. */
  connectedKeys: ReadonlySet<string>;
  /** The host a session is being started for. */
  connectingKey: string | null;
  onConnect(entry: SshHostEntry): void;
  onBrowse(entry: SshHostEntry): void;
}

/**
 * The sidebar's Sessions view: a search field and a "+" for a new host above the saved hosts and
 * the hosts from `~/.ssh/config`. A click selects a host, a double-click (or a tap on a phone, or
 * Enter in the search field) connects.
 */
export function HostsList({
  theme,
  layout,
  hosts,
  connectedKeys,
  connectingKey,
  onConnect,
  onBrowse,
}: HostsListProps) {
  const compact = layout.compact;
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(CLOSED);
  const height = compact ? MIN_TOUCH_TARGET : ROW_HEIGHT;
  const styles = useMemo(
    () => ({
      root: { flex: 1, minHeight: 0 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.xs,
        padding: SPACE.sm,
      },
      search: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.sm,
        minHeight: height,
        paddingHorizontal: SPACE.sm + 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      searchInput: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.foreground,
        fontSize: FONT_SIZE.body,
        paddingVertical: 0,
      },
      list: { flex: 1, minHeight: 0 },
      listContent: { paddingHorizontal: SPACE.xs, paddingBottom: SPACE.lg },
      message: {
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.small,
        paddingHorizontal: SPACE.sm,
        paddingVertical: SPACE.sm,
      },
      error: {
        color: theme.colors.statusDanger,
        fontSize: FONT_SIZE.small,
        paddingHorizontal: SPACE.sm,
        paddingVertical: SPACE.xs,
      },
      clear: { padding: SPACE.xs },
    }),
    [theme, height],
  );

  const filtered = useMemo(() => filterHostEntries(query, hosts.entries), [query, hosts.entries]);
  const savedHosts = useMemo(() => filtered.filter((entry) => entry.source === "user"), [filtered]);
  const fromConfig = useMemo(
    () => filtered.filter((entry) => entry.source === "config"),
    [filtered],
  );

  const handleSelect = useCallback((entry: SshHostEntry) => setSelectedKey(entry.key), []);
  const handleConnect = useCallback(
    (entry: SshHostEntry) => {
      setSelectedKey(entry.key);
      onConnect(entry);
    },
    [onConnect],
  );
  const handleBrowse = useCallback(
    (entry: SshHostEntry) => {
      setSelectedKey(entry.key);
      onBrowse(entry);
    },
    [onBrowse],
  );
  const handleEdit = useCallback((entry: SshHostEntry) => {
    setForm({ kind: "edit", id: entry.key.slice("user:".length) });
  }, []);
  const handleSubmitSearch = useCallback(() => {
    const target = filtered.find((entry) => entry.key === selectedKey) ?? filtered[0];
    if (target) handleConnect(target);
  }, [filtered, selectedKey, handleConnect]);
  const clearSearch = useCallback(() => setQuery(""), []);
  const toggleAdd = useCallback(() => {
    setForm((current) => (current.kind === "add" ? CLOSED : ADDING));
  }, []);
  const closeForm = useCallback(() => setForm(CLOSED), []);

  const editing = form.kind === "edit" ? form.id : null;
  const editedHost = editing ? hosts.userHosts.find((host) => host.id === editing) : undefined;
  const { add, update, remove } = hosts;
  const handleAdd = useCallback(
    async (host: Parameters<typeof add>[0]) => {
      const done = await add(host);
      if (done) setForm(CLOSED);
      return done;
    },
    [add],
  );
  const handleUpdate = useCallback(
    async (host: Parameters<typeof add>[0]) => {
      if (!editing) return false;
      const done = await update(editing, host);
      if (done) setForm(CLOSED);
      return done;
    },
    [editing, update],
  );
  const handleDeleteEdited = useCallback(() => {
    const entry = hosts.entries.find((candidate) => candidate.key === `user:${editing}`);
    if (entry) remove(entry);
    setForm(CLOSED);
  }, [hosts.entries, editing, remove]);

  const rowFor = (entry: SshHostEntry) => {
    let status: HostStatus = "idle";
    if (connectedKeys.has(entry.key)) status = "connected";
    if (connectingKey === entry.key) status = "connecting";
    return (
      <HostRow
        key={entry.key}
        entry={entry}
        theme={theme}
        compact={compact}
        busy={hosts.saving}
        selected={entry.key === selectedKey}
        status={status}
        onSelect={handleSelect}
        onConnect={handleConnect}
        onBrowse={handleBrowse}
        onEdit={handleEdit}
        onRemove={remove}
      />
    );
  };

  const searching = query.trim().length > 0;
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.search}>
          <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
          <TextInput
            accessibilityLabel="Search hosts"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Search hosts"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={handleSubmitSearch}
            returnKeyType="go"
            style={styles.searchInput}
          />
          {searching ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={clearSearch}
              style={styles.clear}
            >
              <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
        <IconButton
          theme={theme}
          compact={compact}
          icon="Plus"
          label="Add host"
          active={form.kind === "add"}
          onPress={toggleAdd}
        />
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {form.kind === "add" ? (
          <HostForm
            theme={theme}
            compact={compact}
            disabled={hosts.saving || !hosts.ready}
            onSubmit={handleAdd}
            onCancel={closeForm}
          />
        ) : null}
        {editedHost ? (
          <HostForm
            key={editedHost.id}
            theme={theme}
            compact={compact}
            disabled={hosts.saving || !hosts.ready}
            initial={editedHost}
            onSubmit={handleUpdate}
            onCancel={closeForm}
            onDelete={handleDeleteEdited}
          />
        ) : null}
        {hosts.loading ? <Text style={styles.message}>Loading hosts…</Text> : null}
        {hosts.errors.map((message) => (
          <Text key={message} style={styles.error}>
            {message}
          </Text>
        ))}
        {savedHosts.length > 0 ? (
          <>
            <SectionHeader theme={theme} title="Saved hosts" count={savedHosts.length} />
            {savedHosts.map(rowFor)}
          </>
        ) : null}
        {fromConfig.length > 0 ? (
          <>
            <SectionHeader theme={theme} title="From ~/.ssh/config" count={fromConfig.length} />
            {fromConfig.map(rowFor)}
          </>
        ) : null}
        {hosts.empty ? (
          <Text style={styles.message}>
            No hosts yet. Add one with +, or define Host entries in ~/.ssh/config.
          </Text>
        ) : null}
        {searching && filtered.length === 0 && !hosts.empty ? (
          <Text style={styles.message}>No hosts match “{query.trim()}”.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
