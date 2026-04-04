import type {
  CanvasActionEnvelope,
  SyncClientActionMessage,
  SyncClientJoinMessage,
  SyncClientMessage,
  SyncClientPresencePingMessage,
  SyncConnectionState as SharedSyncConnectionState,
  SyncServerMessage,
} from '@ai-canvas/shared';

export interface SyncConnectionState extends SharedSyncConnectionState {}

type SyncStateListener = (state: SyncConnectionState) => void;
type SyncActionListener = (action: CanvasActionEnvelope) => void;

export interface SyncConnectionOptions {
  url?: string;
  pingIntervalMs?: number;
}

export interface SyncConnection extends SyncConnectionState {
  connect: () => void;
  disconnect: (code?: number, reason?: string) => void;
  sendAction: (action: CanvasActionEnvelope) => boolean;
  onStateChange: (listener: SyncStateListener) => () => void;
  onAction: (listener: SyncActionListener) => () => void;
}

const defaultSyncUrl = 'ws://localhost:3002';
const defaultPingIntervalMs = 15_000;

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

  let socket: WebSocket | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const syncUrl = options.url ?? defaultSyncUrl;
  const pingIntervalMs = options.pingIntervalMs ?? defaultPingIntervalMs;

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
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onAction(listener) {
      actionListeners.add(listener);
      return () => actionListeners.delete(listener);
    },
  };

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

  function startPingLoop() {
    stopPingLoop();
    pingInterval = setInterval(() => {
      const pingMessage: SyncClientPresencePingMessage = {
        type: 'presence.ping',
        roomId,
        sessionId,
        at: new Date().toISOString(),
      };
      if (isBrowserWebSocketReady(socket)) {
        socket.send(toClientMessageString(pingMessage));
      }
    }, pingIntervalMs);
  }

  function handleServerMessage(message: SyncServerMessage) {
    if (message.type === 'room.action' && message.roomId === roomId) {
      for (const listener of actionListeners) {
        listener(message.action);
      }
      return;
    }

    if (message.type === 'error' && message.roomId === roomId) {
      publishState(setSyncDisconnected(state, message.message));
    }
  }

  function connect() {
    disconnect(1000, 'Reconnecting');
    publishState(setSyncConnecting(state));

    socket = new WebSocket(syncUrl);

    socket.addEventListener('open', () => {
      const joinMessage: SyncClientJoinMessage = {
        type: 'join',
        roomId,
        sessionId,
      };

      publishState(setSyncConnected(state));
      socket?.send(toClientMessageString(joinMessage));
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
    });

    socket.addEventListener('error', () => {
      stopPingLoop();
      publishState(setSyncDisconnected(state, 'Sync transport error'));
    });
  }

  function disconnect(code = 1000, reason = 'Client disconnect') {
    stopPingLoop();
    if (socket) {
      socket.close(code, reason);
      socket = null;
    }
    publishState(setSyncDisconnected(state));
  }

  function sendAction(action: CanvasActionEnvelope): boolean {
    if (!isBrowserWebSocketReady(socket)) {
      return false;
    }

    const actionMessage: SyncClientActionMessage = {
      type: 'action',
      roomId,
      sessionId,
      action,
    };

    socket.send(toClientMessageString(actionMessage));
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

export function setSyncDisconnected(state: SyncConnectionState, error?: string): SyncConnectionState {
  return {
    ...state,
    status: error ? 'error' : 'disconnected',
    connected: false,
    retryCount: state.retryCount + 1,
    error,
    lastUpdatedAt: new Date().toISOString(),
  };
}
