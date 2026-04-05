import type {
  ChatMessageEnvelope,
  CanvasActionEnvelope,
  FailureEnvelope,
  RoomParticipant,
  SyncClientActionMessage,
  SyncClientChatMessage,
  SyncClientJoinMessage,
  SyncClientMessage,
  SyncClientPresencePingMessage,
  SyncConnectionState as SharedSyncConnectionState,
  SyncServerActionAckMessage,
  SyncServerMessage,
} from '@ai-canvas/shared';

export interface SyncConnectionState extends SharedSyncConnectionState {}

type SyncStateListener = (state: SyncConnectionState) => void;
type SyncActionListener = (action: CanvasActionEnvelope) => void;
type SyncChatListener = (chat: ChatMessageEnvelope) => void;
type SyncPresenceListener = (participants: RoomParticipant[]) => void;

export interface SyncConnectionOptions {
  url?: string;
  displayName?: string;
  pingIntervalMs?: number;
  maxQueuedActions?: number;
  maxRetryAttempts?: number;
}

export interface SyncConnection extends SyncConnectionState {
  connect: () => void;
  disconnect: (code?: number, reason?: string) => void;
  sendAction: (action: CanvasActionEnvelope) => boolean;
  sendChatMessage: (text: string, mentionsAgent: boolean) => boolean;
  onStateChange: (listener: SyncStateListener) => () => void;
  onAction: (listener: SyncActionListener) => () => void;
  onChat: (listener: SyncChatListener) => () => void;
  onPresence: (listener: SyncPresenceListener) => () => void;
}

const defaultSyncUrl = 'ws://localhost:3002';
const defaultPingIntervalMs = 15_000;
const defaultMaxQueuedActions = 250;
const defaultMaxRetryAttempts = 3;
const maxReconnectDelayMs = 8_000;

interface PendingActionRecord {
  action: CanvasActionEnvelope;
  attempt: number;
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function isBrowserWebSocketReady(socket: WebSocket | null): socket is WebSocket {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

function parseServerMessage(rawMessage: string): SyncServerMessage | null {
  try {
    const parsed = JSON.parse(rawMessage) as { type?: string };
    if (typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as SyncServerMessage;
  } catch {
    return null;
  }
}

function toClientMessageString(message: SyncClientMessage): string {
  return JSON.stringify(message);
}

export function createSyncConnection(
  roomId: string,
  sessionId = 'local-session',
  options: SyncConnectionOptions = {},
): SyncConnection {
  const stateListeners = new Set<SyncStateListener>();
  const actionListeners = new Set<SyncActionListener>();
  const chatListeners = new Set<SyncChatListener>();
  const presenceListeners = new Set<SyncPresenceListener>();

  let socket: WebSocket | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldReconnect = true;

  const syncUrl = options.url ?? defaultSyncUrl;
  const displayName = options.displayName?.trim() || `User-${sessionId.slice(-4)}`;
  const pingIntervalMs = options.pingIntervalMs ?? defaultPingIntervalMs;
  const maxQueuedActions = options.maxQueuedActions ?? defaultMaxQueuedActions;
  const maxRetryAttempts = options.maxRetryAttempts ?? defaultMaxRetryAttempts;

  const pendingActions = new Map<string, PendingActionRecord>();
  const seenIncomingActionIds = new Set<string>();
  const seenIncomingChatIds = new Set<string>();

  const state: SyncConnectionState = {
    roomId,
    sessionId,
    status: 'idle',
    connected: false,
    retryCount: 0,
    lastUpdatedAt: new Date().toISOString(),
  };

  const connection: SyncConnection = {
    ...state,
    connect,
    disconnect,
    sendAction,
    sendChatMessage,
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onAction(listener) {
      actionListeners.add(listener);
      return () => actionListeners.delete(listener);
    },
    onChat(listener) {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    },
    onPresence(listener) {
      presenceListeners.add(listener);
      return () => presenceListeners.delete(listener);
    },
  };

  function emitChat(chat: ChatMessageEnvelope) {
    if (seenIncomingChatIds.has(chat.id)) {
      return;
    }
    seenIncomingChatIds.add(chat.id);
    if (seenIncomingChatIds.size > maxQueuedActions * 4) {
      seenIncomingChatIds.clear();
    }
    for (const listener of chatListeners) {
      listener(chat);
    }
  }

  function emitPresence(participants: RoomParticipant[]) {
    for (const listener of presenceListeners) {
      listener(participants);
    }
  }

  function emitAction(action: CanvasActionEnvelope) {
    if (seenIncomingActionIds.has(action.id)) {
      return;
    }
    seenIncomingActionIds.add(action.id);
    if (seenIncomingActionIds.size > maxQueuedActions * 4) {
      seenIncomingActionIds.clear();
    }
    for (const listener of actionListeners) {
      listener(action);
    }
  }

  function publishState(nextState: SyncConnectionState) {
    Object.assign(state, nextState);
    Object.assign(connection, nextState);
    for (const listener of stateListeners) {
      listener({ ...state });
    }
  }

  function stopPingLoop() {
    if (pingInterval !== null) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (!shouldReconnect || reconnectTimer !== null) {
      return;
    }

    const attempt = Math.max(1, state.retryCount);
    const baseDelay = Math.min(maxReconnectDelayMs, 200 * Math.pow(2, attempt - 1));
    const jitter = Math.floor(Math.random() * 120);
    const delay = baseDelay + jitter;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function startPingLoop() {
    stopPingLoop();
    pingInterval = setInterval(() => {
      const pingMessage: SyncClientPresencePingMessage = {
        type: 'presence.ping',
        messageId: createId('ping'),
        roomId,
        sessionId,
        displayName,
        at: new Date().toISOString(),
      };
      if (isBrowserWebSocketReady(socket)) {
        socket.send(toClientMessageString(pingMessage));
      }
    }, pingIntervalMs);
  }

  function handleServerMessage(message: SyncServerMessage) {
    if (message.type === 'room.snapshot' && message.roomId === roomId) {
      for (const action of message.actions) {
        emitAction(action);
      }
      for (const chat of message.recentChats) {
        emitChat(chat);
      }
      emitPresence(message.participants);
      return;
    }

    if (message.type === 'room.action' && message.roomId === roomId) {
      emitAction(message.action);
      return;
    }

    if (message.type === 'room.chat' && message.roomId === roomId) {
      emitChat(message.chat);
      return;
    }

    if (message.type === 'room.presence' && message.roomId === roomId) {
      emitPresence(message.participants);
      return;
    }

    if (isActionAckMessage(message) && message.roomId === roomId) {
      pendingActions.delete(message.actionId);
      if (!message.accepted && message.failure) {
        publishState(setSyncDisconnected(state, message.failure));
      }
      return;
    }

    if (message.type === 'error' && message.roomId === roomId) {
      publishState(setSyncDisconnected(state, message.failure ?? message.message));
    }
  }

  function isActionAckMessage(message: SyncServerMessage): message is SyncServerActionAckMessage {
    return message.type === 'room.ack';
  }

  function flushPendingActions() {
    for (const actionId of pendingActions.keys()) {
      dispatchPendingAction(actionId);
    }
  }

  function dispatchPendingAction(actionId: string): boolean {
    if (!isBrowserWebSocketReady(socket)) {
      return false;
    }

    const pending = pendingActions.get(actionId);
    if (!pending) {
      return false;
    }

    if (pending.attempt >= maxRetryAttempts) {
      pendingActions.delete(actionId);
      publishState(setSyncDisconnected(state, {
        code: 'timeout',
        message: `Exceeded retry budget for action ${actionId}`,
        retryable: false,
      }));
      return false;
    }

    pending.attempt += 1;
    const sentAt = new Date().toISOString();
    const requestId = createId('action-msg');
    const actionMessage: SyncClientActionMessage = {
      type: 'action',
      messageId: requestId,
      roomId,
      sessionId,
      metadata: {
        requestId,
        idempotencyKey: `action:${pending.action.id}`,
        sentAt,
        attempt: pending.attempt,
        maxAttempts: maxRetryAttempts,
      },
      action: pending.action,
    };

    socket.send(toClientMessageString(actionMessage));
    return true;
  }

  function connect() {
    shouldReconnect = true;
    clearReconnectTimer();
    stopPingLoop();
    if (socket) {
      socket.close(1000, 'Reconnecting');
      socket = null;
    }
    publishState(setSyncConnecting(state));

    socket = new WebSocket(syncUrl);

    socket.addEventListener('open', () => {
      const joinMessage: SyncClientJoinMessage = {
        type: 'join',
        messageId: createId('join'),
        roomId,
        sessionId,
        displayName,
      };

      publishState(setSyncConnected(state));
      socket?.send(toClientMessageString(joinMessage));
      flushPendingActions();
      startPingLoop();
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return;
      }
      const parsed = parseServerMessage(event.data);
      if (!parsed) {
        return;
      }
      handleServerMessage(parsed);
    });

    socket.addEventListener('close', () => {
      stopPingLoop();
      publishState(setSyncDisconnected(state));
      socket = null;
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      stopPingLoop();
      publishState(setSyncDisconnected(state, 'Sync transport error'));
      scheduleReconnect();
    });
  }

  function disconnect(code = 1000, reason = 'Client disconnect') {
    shouldReconnect = false;
    clearReconnectTimer();
    stopPingLoop();
    if (socket) {
      socket.close(code, reason);
      socket = null;
    }
    publishState(setSyncDisconnected(state));
  }

  function sendAction(action: CanvasActionEnvelope): boolean {
    if (!pendingActions.has(action.id)) {
      if (pendingActions.size >= maxQueuedActions) {
        const oldestActionId = pendingActions.keys().next().value;
        if (typeof oldestActionId === 'string') {
          pendingActions.delete(oldestActionId);
        }
      }
      pendingActions.set(action.id, {
        action,
        attempt: 0,
      });
    }

    return dispatchPendingAction(action.id) || !isBrowserWebSocketReady(socket);
  }

  function sendChatMessage(text: string, mentionsAgent: boolean): boolean {
    const normalizedText = text.trim();
    if (normalizedText.length === 0 || !isBrowserWebSocketReady(socket)) {
      return false;
    }

    const message: SyncClientChatMessage = {
      type: 'chat.send',
      messageId: createId('chat-msg'),
      roomId,
      sessionId,
      displayName,
      text: normalizedText,
      mentionsAgent,
      at: new Date().toISOString(),
    };

    socket.send(toClientMessageString(message));
    return true;
  }

  return connection;
}

export function setSyncConnecting(state: SyncConnectionState): SyncConnectionState {
  return {
    ...state,
    status: 'connecting',
    connected: false,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function setSyncConnected(state: SyncConnectionState): SyncConnectionState {
  return {
    ...state,
    status: 'connected',
    connected: true,
    error: undefined,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function setSyncDisconnected(
  state: SyncConnectionState,
  error?: string | FailureEnvelope,
): SyncConnectionState {
  const errorMessage =
    typeof error === 'string'
      ? error
      : error?.message;

  return {
    ...state,
    status: errorMessage ? 'error' : 'disconnected',
    connected: false,
    retryCount: state.retryCount + 1,
    error: errorMessage,
    lastUpdatedAt: new Date().toISOString(),
  };
}
