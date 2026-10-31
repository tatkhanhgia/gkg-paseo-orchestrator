import type { TerminalViewProps } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TerminalPane } from "@/components/terminal-pane";
import { usePluginServerId } from "../installation-provider";

/** A plugin's interactive terminal: the workspace terminal pane without its workspace behavior. */
export function TerminalView({ terminal, style, onExit }: TerminalViewProps) {
  const serverId = usePluginServerId();
  return (
    <View style={[styles.container, style]}>
      <TerminalPane
        embedded
        serverId={serverId}
        cwd={terminal.cwd}
        terminalId={terminal.id}
        isWorkspaceFocused
        isPaneFocused
        onExit={onExit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
});
