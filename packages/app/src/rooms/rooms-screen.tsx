import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, ChatRoomDetail } from "@getpaseo/protocol/chat/types";
import { router } from "expo-router";
import { MessageSquare, Plus, Reply, Trash2, UserRound, X } from "lucide-react-native";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import {
  MessageInput,
  type AttachmentMenuItem,
  type MessageInputRef,
} from "@/composer/input/input";
import type { MessagePayload } from "@/composer/types";
import type { ComposerAttachment } from "@/attachments/types";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useWorkspace } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import {
  buildHostAgentDetailRoute,
  buildHostRoomRoute,
  buildHostRoomsRoute,
} from "@/utils/host-routes";
import { CreateRoomSheet } from "./create-room-sheet";
import { roomQueryKeys, useRoomLiveMessages, useRoomMessagesQuery, useRoomsQuery } from "./data";
import {
  describeRoomPlacement,
  findActiveRoomMention,
  insertRoomMention,
  mergeChatMessages,
} from "./model";

interface RoomsScreenProps {
  serverId: string;
  selectedRoomId: string | null;
}

interface RoomComposerState {
  text: string;
  cursor: number;
  replyToMessageId: string | null;
  // Bumped on every programmatic (not user-typed) text change, so the shared
  // MessageInput primitive knows to resync its native-owned text.
  inputRevision: number;
}

type RoomComposerAction =
  | { type: "text"; text: string }
  | { type: "cursor"; cursor: number }
  | { type: "mention"; agentId: string }
  | { type: "reply"; messageId: string }
  | { type: "cancelReply" }
  | { type: "sent" };

const EMPTY_COMPOSER: RoomComposerState = {
  text: "",
  cursor: 0,
  replyToMessageId: null,
  inputRevision: 0,
};
const ROOM_ATTACHMENTS: ComposerAttachment[] = [];
const ROOM_ATTACHMENT_MENU_ITEMS: AttachmentMenuItem[] = [];
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedReply = withUnistyles(Reply);
const ThemedUserRound = withUnistyles(UserRound);
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const roomIconMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
});

function reduceRoomComposer(
  state: RoomComposerState,
  action: RoomComposerAction,
): RoomComposerState {
  if (action.type === "text") {
    const lengthDelta = action.text.length - state.text.length;
    const cursor = Math.max(0, Math.min(action.text.length, state.cursor + lengthDelta));
    return { ...state, text: action.text, cursor };
  }
  if (action.type === "cursor") {
    return { ...state, cursor: action.cursor };
  }
  if (action.type === "mention") {
    const inserted = insertRoomMention(state.text, state.cursor, action.agentId);
    return {
      ...state,
      text: inserted.text,
      cursor: inserted.cursor,
      inputRevision: state.inputRevision + 1,
    };
  }
  if (action.type === "reply") {
    return { ...state, replyToMessageId: action.messageId };
  }
  if (action.type === "cancelReply") {
    return { ...state, replyToMessageId: null };
  }
  return { ...EMPTY_COMPOSER, inputRevision: state.inputRevision + 1 };
}

export function RoomsScreen({ serverId, selectedRoomId }: RoomsScreenProps) {
  const isCompact = useIsCompactFormFactor();
  const queryClient = useQueryClient();
  const [isCreateSheetVisible, setCreateSheetVisible] = useState(false);
  const roomsQuery = useRoomsQuery(serverId);
  const rooms = roomsQuery.data ?? [];
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;

  const openCreateSheet = useCallback(() => setCreateSheetVisible(true), []);
  const closeCreateSheet = useCallback(() => setCreateSheetVisible(false), []);
  const handleCreated = useCallback(
    (room: ChatRoomDetail) => {
      setCreateSheetVisible(false);
      void queryClient.invalidateQueries({ queryKey: roomQueryKeys.list(serverId) });
      router.replace(buildHostRoomRoute(serverId, room.id));
    },
    [queryClient, serverId],
  );
  const handleRoomsRetry = useCallback(() => void roomsQuery.refetch(), [roomsQuery]);
  const newRoomButton = useMemo(
    () => (
      <Button
        variant="secondary"
        size="sm"
        leftIcon={Plus}
        onPress={openCreateSheet}
        disabled={!roomsQuery.client || !roomsQuery.isConnected || !roomsQuery.supportsRooms}
        testID="rooms-create"
      >
        New room
      </Button>
    ),
    [openCreateSheet, roomsQuery.client, roomsQuery.isConnected, roomsQuery.supportsRooms],
  );

  let content: ReactNode;
  if (!roomsQuery.supportsRooms) {
    content = (
      <RoomUnavailable
        title="Rooms require a newer host"
        description="Update this Paseo host to use room coordination in the WebUI."
      />
    );
  } else if (!roomsQuery.isConnected) {
    content = (
      <RoomUnavailable title="Host offline" description="Reconnect the host to use rooms." />
    );
  } else if (roomsQuery.isPending) {
    content = <RoomLoading />;
  } else if (roomsQuery.isError) {
    content = (
      <RoomUnavailable
        title="Unable to load rooms"
        description={toErrorMessage(roomsQuery.error)}
        onRetry={handleRoomsRetry}
      />
    );
  } else if (isCompact) {
    content = selectedRoomId ? (
      <RoomDetail
        serverId={serverId}
        room={selectedRoom}
        requestedRoomId={selectedRoomId}
        compact
      />
    ) : (
      <RoomList serverId={serverId} rooms={rooms} selectedRoomId={null} />
    );
  } else {
    content = (
      <View style={styles.desktopBody}>
        <View style={styles.desktopListPane}>
          <RoomList serverId={serverId} rooms={rooms} selectedRoomId={selectedRoomId} />
        </View>
        <View style={styles.desktopDetailPane}>
          {selectedRoomId ? (
            <RoomDetail
              serverId={serverId}
              room={selectedRoom}
              requestedRoomId={selectedRoomId}
              compact={false}
            />
          ) : (
            <RoomEmpty text={rooms.length === 0 ? "No rooms yet" : "Select a room"} />
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="rooms-screen">
      {isCompact && selectedRoomId ? null : (
        <MenuHeader title="Rooms" rightContent={newRoomButton} />
      )}
      {content}
      <CreateRoomSheet
        client={roomsQuery.client}
        serverId={serverId}
        visible={isCreateSheetVisible}
        onClose={closeCreateSheet}
        onCreated={handleCreated}
      />
    </View>
  );
}

function RoomUnavailable({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.unavailable}>
      <Alert title={title} description={description} variant="warning">
        {onRetry ? (
          <Button variant="outline" size="sm" onPress={onRetry}>
            Try again
          </Button>
        ) : null}
      </Alert>
    </View>
  );
}

function RoomLoading() {
  return (
    <View style={styles.centered}>
      <ThemedLoadingSpinner size="large" uniProps={foregroundMutedMapping} />
    </View>
  );
}

function RoomEmpty({ text }: { text: string }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function RoomList({
  serverId,
  rooms,
  selectedRoomId,
}: {
  serverId: string;
  rooms: ChatRoomDetail[];
  selectedRoomId: string | null;
}) {
  if (rooms.length === 0) {
    return <RoomEmpty text="No rooms yet" />;
  }

  return (
    <ScrollView contentContainerStyle={styles.roomList} testID="rooms-list">
      {rooms.map((room) => (
        <RoomRow
          key={room.id}
          serverId={serverId}
          room={room}
          selected={room.id === selectedRoomId}
        />
      ))}
    </ScrollView>
  );
}

function RoomRow({
  serverId,
  room,
  selected,
}: {
  serverId: string;
  room: ChatRoomDetail;
  selected: boolean;
}) {
  const workspace = useWorkspace(serverId, room.workspaceId ?? null);
  const placement = useMemo(() => describeRoomPlacement(room, workspace), [room, workspace]);
  const handlePress = useCallback(() => {
    router.push(buildHostRoomRoute(serverId, room.id));
  }, [room.id, serverId]);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.roomRow,
      selected && styles.roomRowSelected,
      (hovered || pressed) && styles.roomRowHovered,
    ],
    [selected],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={`${room.name}, ${room.messageCount} messages`}
      testID={`room-row-${room.id}`}
    >
      <ThemedMessageSquare uniProps={roomIconMapping} />
      <View style={styles.roomRowBody}>
        <Text style={styles.roomName} numberOfLines={1}>
          {room.name}
        </Text>
        <Text
          style={[styles.roomMeta, placement.legacy && styles.roomMetaLegacy]}
          numberOfLines={1}
          testID={`room-row-placement-${room.id}`}
        >
          {placement.text}
        </Text>
        <Text style={styles.roomMeta} numberOfLines={1}>
          {room.purpose || `${room.messageCount} messages`}
        </Text>
      </View>
      <Text style={styles.roomCount}>{room.messageCount}</Text>
    </Pressable>
  );
}

function RoomDetail({
  serverId,
  room,
  requestedRoomId,
  compact,
}: {
  serverId: string;
  room: ChatRoomDetail | null;
  requestedRoomId: string;
  compact: boolean;
}) {
  const queryClient = useQueryClient();
  const [composerState, composerDispatch] = useReducer(reduceRoomComposer, EMPTY_COMPOSER);
  const workspace = useWorkspace(serverId, room?.workspaceId ?? null);
  const placement = useMemo(
    () => (room ? describeRoomPlacement(room, workspace) : null),
    [room, workspace],
  );
  const messagesQuery = useRoomMessagesQuery(serverId, room?.id ?? null);
  const messages = messagesQuery.data ?? [];
  const liveMessages = useRoomLiveMessages({
    serverId,
    roomId: room?.id ?? null,
    enabled: messagesQuery.isSuccess,
  });
  const roomsQuery = useRoomsQuery(serverId);
  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!roomsQuery.client || !room) {
        throw new Error("Room client unavailable");
      }
      const confirmed = await confirmDialog({
        title: `Delete ${room.name}?`,
        message: "This removes the room and all of its messages.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) {
        return false;
      }
      const response = await roomsQuery.client.deleteChatRoom({ room: room.id });
      if (response.error || !response.room) {
        throw new Error(response.error ?? "Unable to delete room");
      }
      return true;
    },
    onSuccess: (deleted) => {
      if (!deleted) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: roomQueryKeys.list(serverId) });
      queryClient.removeQueries({ queryKey: roomQueryKeys.messages(serverId, requestedRoomId) });
      router.replace(buildHostRoomsRoute(serverId));
    },
  });
  const handleDelete = useCallback(() => {
    deleteMutation.reset();
    deleteMutation.mutate();
  }, [deleteMutation]);
  const handleBack = useCallback(() => {
    router.replace(buildHostRoomsRoute(serverId));
  }, [serverId]);
  const handleMessagesRetry = useCallback(() => void messagesQuery.refetch(), [messagesQuery]);
  const handleReply = useCallback(
    (messageId: string) => composerDispatch({ type: "reply", messageId }),
    [composerDispatch],
  );
  const deleteButton = useMemo(
    () => (
      <Button
        variant="outline"
        size="xs"
        leftIcon={Trash2}
        onPress={handleDelete}
        loading={deleteMutation.isPending}
        testID="room-delete"
      >
        Delete
      </Button>
    ),
    [deleteMutation.isPending, handleDelete],
  );
  const detailTitle = useMemo(
    () => <ScreenTitle>{room?.name ?? "Room"}</ScreenTitle>,
    [room?.name],
  );

  if (!room) {
    return (
      <View style={styles.detail}>
        {compact ? <BackHeader title="Room not found" onBack={handleBack} /> : null}
        <RoomEmpty text="Room not found" />
      </View>
    );
  }

  return (
    <View style={styles.detail} testID={`room-detail-${room.id}`}>
      {compact ? (
        <BackHeader title={room.name} onBack={handleBack} rightContent={deleteButton} />
      ) : (
        <ScreenHeader left={detailTitle} right={deleteButton} />
      )}
      {placement ? (
        <Text
          style={[styles.placement, placement.legacy && styles.roomMetaLegacy]}
          testID="room-detail-placement"
        >
          {placement.text}
        </Text>
      ) : null}
      {room.purpose ? <Text style={styles.purpose}>{room.purpose}</Text> : null}
      {deleteMutation.error ? (
        <View style={styles.inlineAlert}>
          <Alert
            title="Unable to delete room"
            description={toErrorMessage(deleteMutation.error)}
            variant="error"
          />
        </View>
      ) : null}
      {messagesQuery.isPending ? <RoomLoading /> : null}
      {messagesQuery.isError ? (
        <View style={styles.inlineAlert}>
          <Alert
            title="Unable to load messages"
            description={toErrorMessage(messagesQuery.error)}
            variant="error"
          >
            <Button variant="outline" size="sm" onPress={handleMessagesRetry}>
              Try again
            </Button>
          </Alert>
        </View>
      ) : null}
      {messagesQuery.isSuccess ? (
        <RoomMessageList serverId={serverId} messages={messages} onReply={handleReply} />
      ) : null}
      {liveMessages.error ? (
        <View style={styles.liveAlert}>
          <Alert title="Live updates paused" description={liveMessages.error} variant="warning">
            <Button variant="outline" size="sm" onPress={liveMessages.retry}>
              Resume
            </Button>
          </Alert>
        </View>
      ) : null}
      <RoomComposer
        serverId={serverId}
        room={room}
        messages={messages}
        state={composerState}
        dispatch={composerDispatch}
      />
    </View>
  );
}

function RoomMessageList({
  serverId,
  messages,
  onReply,
}: {
  serverId: string;
  messages: ChatMessage[];
  onReply: (messageId: string) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const { agents } = useAggregatedAgents();
  const agentsById = useMemo(
    () =>
      new Map(
        agents.filter((agent) => agent.serverId === serverId).map((agent) => [agent.id, agent]),
      ),
    [agents, serverId],
  );
  const handleContentSizeChange = useCallback(
    () => scrollRef.current?.scrollToEnd({ animated: false }),
    [],
  );

  if (messages.length === 0) {
    return <RoomEmpty text="No messages yet" />;
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.messages}
      contentContainerStyle={styles.messageList}
      onContentSizeChange={handleContentSizeChange}
      testID="room-messages"
    >
      {messages.map((message) => (
        <RoomMessageRow
          key={message.id}
          serverId={serverId}
          message={message}
          replyTarget={
            messages.find((candidate) => candidate.id === message.replyToMessageId) ?? null
          }
          agentsById={agentsById}
          onReply={onReply}
        />
      ))}
    </ScrollView>
  );
}

function RoomMessageRow({
  serverId,
  message,
  replyTarget,
  agentsById,
  onReply,
}: {
  serverId: string;
  message: ChatMessage;
  replyTarget: ChatMessage | null;
  agentsById: ReadonlyMap<string, AggregatedAgent>;
  onReply: (messageId: string) => void;
}) {
  const isManual = message.authorAgentId === "manual";
  const authorLabel = resolveAuthorLabel(message.authorAgentId, agentsById);
  const handleAuthorPress = useCallback(() => {
    if (!isManual) {
      router.push(buildHostAgentDetailRoute(serverId, message.authorAgentId));
    }
  }, [isManual, message.authorAgentId, serverId]);
  const handleReply = useCallback(() => onReply(message.id), [message.id, onReply]);

  return (
    <View style={styles.message} testID={`room-message-${message.id}`}>
      {replyTarget ? (
        <Text style={styles.replyPreview} numberOfLines={1}>
          Reply to {resolveAuthorLabel(replyTarget.authorAgentId, agentsById)}: {replyTarget.body}
        </Text>
      ) : null}
      {isManual ? (
        <View style={styles.manualMessageContainer}>
          <View style={styles.manualMessageContent}>
            <View style={styles.manualBubble}>
              <Text selectable style={styles.manualMessageText}>
                {message.body}
              </Text>
            </View>
            <View style={styles.manualTrailingRow}>
              <Text style={styles.messageTime}>{formatMessageTime(message.createdAt)}</Text>
              <Button
                variant="ghost"
                size="xs"
                leftIcon={Reply}
                onPress={handleReply}
                style={styles.replyButton}
              >
                Reply
              </Button>
            </View>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.messageHeader}>
            <Pressable onPress={handleAuthorPress} accessibilityRole="button">
              <Text style={styles.messageAuthor}>{authorLabel}</Text>
            </Pressable>
            <Text style={styles.messageTime}>{formatMessageTime(message.createdAt)}</Text>
          </View>
          <Text selectable style={styles.messageBody}>
            {message.body}
          </Text>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={Reply}
            onPress={handleReply}
            style={styles.replyButton}
          >
            Reply
          </Button>
        </>
      )}
    </View>
  );
}

function RoomComposer({
  serverId,
  room,
  messages,
  state,
  dispatch,
}: {
  serverId: string;
  room: ChatRoomDetail;
  messages: ChatMessage[];
  state: RoomComposerState;
  dispatch: Dispatch<RoomComposerAction>;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<MessageInputRef>(null);
  const restoreInputFocusRef = useRef(false);
  const roomsQuery = useRoomsQuery(serverId);
  const { agents } = useAggregatedAgents();
  const eligibleAgents = useMemo(
    () =>
      agents.filter(
        (agent) => agent.serverId === serverId && !agent.archivedAt && agent.status !== "error",
      ),
    [agents, serverId],
  );
  const activeMention = useMemo(
    () => findActiveRoomMention(state.text, state.cursor),
    [state.cursor, state.text],
  );
  const mentionOptions = useMemo(
    () => buildMentionOptions(eligibleAgents, activeMention?.query ?? ""),
    [activeMention?.query, eligibleAgents],
  );
  const replyTarget = messages.find((message) => message.id === state.replyToMessageId) ?? null;
  const agentsById = useMemo(
    () => new Map(eligibleAgents.map((agent) => [agent.id, agent])),
    [eligibleAgents],
  );
  const textReplacement = useMemo(
    () => ({ kind: "replace" as const, key: String(state.inputRevision), text: state.text }),
    [state.inputRevision, state.text],
  );

  const postMutation = useMutation({
    mutationFn: async (body: string) => {
      if (!roomsQuery.client) {
        throw new Error("Room client unavailable");
      }
      const response = await roomsQuery.client.postChatMessage({
        room: room.id,
        body,
        authorAgentId: "manual",
        replyToMessageId: state.replyToMessageId ?? undefined,
      });
      if (response.error || !response.message) {
        throw new Error(response.error ?? "Unable to send message");
      }
      return response.message;
    },
    onSuccess: (message) => {
      queryClient.setQueryData<ChatMessage[]>(
        roomQueryKeys.messages(serverId, room.id),
        (current = []) => mergeChatMessages(current, [message]),
      );
      void queryClient.invalidateQueries({ queryKey: roomQueryKeys.list(serverId) });
      dispatch({ type: "sent" });
    },
  });
  const handleSubmit = useCallback(
    (payload: MessagePayload) => {
      if (!payload.text.trim()) {
        return;
      }
      postMutation.reset();
      postMutation.mutate(payload.text);
    },
    [postMutation],
  );
  const handleTextChange = useCallback(
    (text: string) => dispatch({ type: "text", text }),
    [dispatch],
  );
  const handleSelectionChange = useCallback(
    (selection: { start: number; end: number }) => {
      dispatch({ type: "cursor", cursor: selection.start });
    },
    [dispatch],
  );
  const handleCancelReply = useCallback(() => dispatch({ type: "cancelReply" }), [dispatch]);
  const handleMentionSelect = useCallback(
    (agentId: string) => {
      restoreInputFocusRef.current = true;
      const inserted = insertRoomMention(state.text, state.cursor, agentId);
      inputRef.current?.replaceText(inserted.text, {
        start: inserted.cursor,
        end: inserted.cursor,
      });
      dispatch({ type: "mention", agentId });
    },
    [dispatch, state.cursor, state.text],
  );
  useEffect(() => {
    if (!restoreInputFocusRef.current) {
      return;
    }
    restoreInputFocusRef.current = false;
    const node = inputRef.current;
    if (!node) {
      return;
    }
    node.focus();
  }, [state.cursor]);

  return (
    <View style={styles.composer}>
      {replyTarget ? (
        <View style={styles.composerReply}>
          <ThemedReply uniProps={roomIconMapping} />
          <Text style={styles.composerReplyText} numberOfLines={1}>
            Replying to {resolveAuthorLabel(replyTarget.authorAgentId, agentsById)}
          </Text>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={X}
            onPress={handleCancelReply}
            accessibilityLabel="Cancel reply"
          />
        </View>
      ) : null}
      {activeMention && mentionOptions.length > 0 ? (
        <View style={styles.mentionOptions} testID="room-mention-options">
          {mentionOptions.map((option) => (
            <MentionOptionRow key={option.id} option={option} onSelect={handleMentionSelect} />
          ))}
        </View>
      ) : null}
      {postMutation.error ? (
        <Text style={styles.composerError} testID="room-post-error">
          {toErrorMessage(postMutation.error)}
        </Text>
      ) : null}
      <View style={styles.composerRow}>
        <MessageInput
          ref={inputRef}
          value={state.text}
          onChangeText={handleTextChange}
          onSelectionChange={handleSelectionChange}
          onSubmit={handleSubmit}
          placeholder="Message room. Type @ to mention an agent"
          disabled={postMutation.isPending}
          isSubmitLoading={postMutation.isPending}
          attachments={ROOM_ATTACHMENTS}
          attachmentMenuItems={ROOM_ATTACHMENT_MENU_ITEMS}
          client={roomsQuery.client}
          cwd=""
          defaultSendBehavior="interrupt"
          isAgentRunning={false}
          inputMode="room"
          textReplacement={textReplacement}
          submitButtonTestID="room-send"
          inputTestID="room-composer-input"
        />
      </View>
    </View>
  );
}

interface MentionOption {
  id: string;
  title: string;
}

function buildMentionOptions(agents: AggregatedAgent[], query: string): MentionOption[] {
  const normalizedQuery = query.toLocaleLowerCase();
  const everyone: MentionOption = { id: "everyone", title: "Everyone in this room" };
  const options = [
    everyone,
    ...agents.map((agent) => ({ id: agent.id, title: agent.title?.trim() || agent.id })),
  ];
  return options
    .filter((option) => {
      const idMatches = option.id.toLocaleLowerCase().includes(normalizedQuery);
      const titleMatches = option.title.toLocaleLowerCase().includes(normalizedQuery);
      return idMatches || titleMatches;
    })
    .slice(0, 6);
}

function MentionOptionRow({
  option,
  onSelect,
}: {
  option: MentionOption;
  onSelect: (agentId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.mentionOption,
      (hovered || pressed) && styles.mentionOptionHovered,
    ],
    [],
  );
  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      testID={`room-mention-${option.id}`}
    >
      <ThemedUserRound size={14} uniProps={foregroundMutedMapping} />
      <View style={styles.mentionOptionBody}>
        <Text style={styles.mentionTitle}>{option.title}</Text>
        <Text style={styles.mentionId}>@{option.id}</Text>
      </View>
    </Pressable>
  );
}

function resolveAuthorLabel(
  authorAgentId: string,
  agentsById: ReadonlyMap<string, AggregatedAgent>,
): string {
  if (authorAgentId === "manual") {
    return "Human";
  }
  return agentsById.get(authorAgentId)?.title?.trim() || authorAgentId;
}

function formatMessageTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  desktopBody: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  desktopListPane: {
    width: 320,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  desktopDetailPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  unavailable: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    padding: theme.spacing[6],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  roomList: {
    padding: theme.spacing[2],
    gap: theme.spacing[1],
  },
  roomRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  roomRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  roomRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  roomRowBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  roomName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  roomMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  roomMetaLegacy: {
    fontStyle: "italic",
  },
  roomCount: {
    minWidth: 18,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  detail: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  placement: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  purpose: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  inlineAlert: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  liveAlert: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  messages: {
    flex: 1,
    minHeight: 0,
  },
  messageList: {
    width: "100%",
    maxWidth: DEFAULT_CONTENT_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[4],
  },
  message: {
    gap: theme.spacing[1],
  },
  messageHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  messageAuthor: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  messageTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  messageBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: 22,
  },
  replyPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.borderAccent,
  },
  replyButton: {
    alignSelf: "flex-start",
  },
  manualMessageContainer: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  manualMessageContent: {
    alignItems: "flex-end",
    maxWidth: "100%",
  },
  manualBubble: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    minWidth: 0,
    flexShrink: 1,
  },
  manualMessageText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
  },
  manualTrailingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  composer: {
    width: "100%",
    maxWidth: DEFAULT_CONTENT_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  composerRow: {
    width: "100%",
  },
  composerReply: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  composerReplyText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  composerError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
  mentionOptions: {
    maxHeight: 264,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  mentionOption: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  mentionOptionHovered: {
    backgroundColor: theme.colors.surface2,
  },
  mentionOptionBody: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  mentionTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  mentionId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
