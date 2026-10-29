import { router, usePathname, type Href } from "expo-router";
import {
  BriefcaseBusiness,
  CalendarClock,
  History,
  MessagesSquare,
  Network,
  Plus,
  Scale,
  Search,
  type LucideIcon,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useHosts } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildHostCouncilsRoute,
  buildHostPortfoliosRoute,
  buildHostRoomsRoute,
  buildHostTopologyRoute,
  buildNewWorkspaceRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /** Sits to the right of the first row, which shrinks to make room. */
  firstRowTrailing?: ReactNode;
}

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Renders nothing — not even the bordered group
 * wrapper — when every item is hidden and there is no `firstRowTrailing`.
 */
export function SidebarNavRows({ style, onBeforeNavigate, firstRowTrailing }: SidebarNavRowsProps) {
  const { items } = useSidebarNavItems("header");
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const groupRef = useRef<View | null>(null);

  if (visibleItems.length === 0 && !firstRowTrailing) return null;

  const [firstRow, ...restRows] = visibleItems.map((item) => {
    if (item.kind === "plugin") {
      return (
        <PluginSidebarItem
          key={item.key}
          group={item.group}
          section="header"
          fallbackAnchorRef={groupRef}
          onBeforeNavigate={onBeforeNavigate}
        />
      );
    }
    const Row = BUILTIN_ROWS[item.id];
    return <Row key={item.key} onBeforeNavigate={onBeforeNavigate} />;
  });

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {firstRowTrailing ? (
        <View style={styles.firstRow}>
          <View style={styles.firstRowItem}>{firstRow}</View>
          {firstRowTrailing}
        </View>
      ) : (
        firstRow
      )}
      {restRows}
    </View>
  );
}

const SidebarNewWorkspaceRow = memo(function SidebarNewWorkspaceRow({
  onBeforeNavigate,
}: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeWorkspaceServerId = activeWorkspaceSelection?.serverId ?? null;
  const activeWorkspaceId = activeWorkspaceSelection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(activeWorkspaceServerId, activeWorkspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(
    activeWorkspaceServerId,
    "workspaceMultiplicity",
  );
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      activeWorkspaceServerId
        ? buildNewWorkspaceRoute(
            activeWorkspace && canUseActiveWorkspaceContext
              ? {
                  serverId: activeWorkspaceServerId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId: activeWorkspaceServerId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, activeWorkspaceServerId, canUseActiveWorkspaceContext, onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={Plus}
      label={t(builtinSidebarNavLabelKey("new-workspace"))}
      onPress={handlePress}
      testID="sidebar-global-new-workspace"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarHistoryRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={pathname.includes("/sessions")}
      testID="sidebar-sessions"
      variant="compact"
    />
  );
}

function SidebarSearchRow() {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    setCommandCenterOpen(true);
  }, [setCommandCenterOpen]);

  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="compact"
    />
  );
}

/**
 * Foundation coordination surfaces are host-scoped. They target the last
 * navigated workspace's host, falling back to the first known host.
 */
function createHostCoordinationRow(input: {
  id: "topology" | "portfolios" | "rooms" | "councils";
  icon: LucideIcon;
  segment: string;
  buildRoute: (serverId: string) => Href;
}): ComponentType<SidebarNavRowProps> {
  function SidebarHostCoordinationRow({ onBeforeNavigate }: SidebarNavRowProps) {
    const { t } = useTranslation();
    const pathname = usePathname();
    const hosts = useHosts();
    const lastWorkspaceSelection = useLastWorkspaceSelection();
    const serverId = lastWorkspaceSelection?.serverId ?? hosts[0]?.serverId ?? null;
    const handlePress = useCallback(() => {
      if (!serverId) return;
      onBeforeNavigate?.();
      router.push(input.buildRoute(serverId));
    }, [onBeforeNavigate, serverId]);

    return (
      <SidebarHeaderRow
        icon={input.icon}
        label={t(builtinSidebarNavLabelKey(input.id))}
        onPress={handlePress}
        isActive={pathname.includes(`/${input.segment}`)}
        testID={`sidebar-${input.id}`}
        variant="compact"
      />
    );
  }
  return SidebarHostCoordinationRow;
}

const BUILTIN_ROWS: Record<BuiltinSidebarNavId, ComponentType<SidebarNavRowProps>> = {
  "new-workspace": SidebarNewWorkspaceRow,
  history: SidebarHistoryRow,
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
  topology: createHostCoordinationRow({
    id: "topology",
    icon: Network,
    segment: "topology",
    buildRoute: buildHostTopologyRoute,
  }),
  portfolios: createHostCoordinationRow({
    id: "portfolios",
    icon: BriefcaseBusiness,
    segment: "portfolios",
    buildRoute: buildHostPortfoliosRoute,
  }),
  rooms: createHostCoordinationRow({
    id: "rooms",
    icon: MessagesSquare,
    segment: "rooms",
    buildRoute: buildHostRoomsRoute,
  }),
  councils: createHostCoordinationRow({
    id: "councils",
    icon: Scale,
    segment: "councils",
    buildRoute: buildHostCouncilsRoute,
  }),
};

const styles = StyleSheet.create({
  firstRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  firstRowItem: {
    flex: 1,
    minWidth: 0,
  },
});
