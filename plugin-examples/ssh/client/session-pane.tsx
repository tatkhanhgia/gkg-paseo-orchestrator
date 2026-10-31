import { TerminalView as HostTerminalView } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { Theme } from "./types";

// An older app's ui module has no TerminalView. The import is a property read, so it is undefined
// there rather than a crash; widen the type so the check below is honest.
const TerminalView: typeof HostTerminalView | undefined = HostTerminalView;

/** False on an app too old to render terminals inside plugins. */
export const canShowSessions = TerminalView !== undefined;

interface SessionPaneProps {
  theme: Theme;
  session: { id: string; cwd: string };
  onExit(): void;
}

/** The live terminal of one ssh session, filling the space it is given. */
export function SessionPane({ theme, session, onExit }: SessionPaneProps) {
  const styles = useMemo(
    () => ({
      pane: { flex: 1, minHeight: 0 },
      muted: { color: theme.colors.foregroundMuted, padding: 16 },
    }),
    [theme],
  );
  if (!TerminalView) {
    return <Text style={styles.muted}>Update the Paseo app to use SSH sessions here.</Text>;
  }
  return (
    <View style={styles.pane}>
      <TerminalView key={session.id} terminal={session} onExit={onExit} />
    </View>
  );
}
