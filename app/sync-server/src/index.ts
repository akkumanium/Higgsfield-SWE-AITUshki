import {
  type ChatMessageEnvelope,
  type CanvasActionEnvelope,
  type FailureEnvelope,
  type RoomParticipant,
  type SyncClientActionMessage,
  type SyncClientChatMessage,
  type SyncClientJoinMessage,
  type SyncClientMessage,
  type SyncClientPresencePingMessage,
  type SyncServerActionAckMessage,
  type SyncServerActionMessage,
  type SyncServerChatMessage,
  type SyncServerErrorMessage,
  type SyncServerMessage,
  type SyncServerPresenceMessage,
  type SyncServerSnapshotMessage,
} from '@ai-canvas/shared';

function getEnv(name: string): string | undefined {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return maybeProcess?.env?.[name];
}

export const syncServerPort = (() => {
  const configured = Number(getEnv('PORT') ?? getEnv('SYNC_SERVER_PORT') ?? 3002);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3002;
})();

const maxRoomActionHistory = 500;
const maxRoomChatHistory = 200;

type RuntimeSocket = {
  readonly OPEN: number;
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (
    event: 'message' | 'close',
    listener: ((data: { toString: () => string }) => void) | (() => void),
  ) => void;
};

type RuntimeServer = {
  listen: (port: number, callback?: () => void) => void;
  close: (callback: (error?: Error) => void) => void;
};

type RuntimeWebSocketServer = {
  on: (event: 'connection', listener: (socket: RuntimeSocket) => void) => void;
  close: (callback: (error?: Error) => void) => void;
};

export interface SyncRoomRecord {
  roomId: string;
  connectedClients: number;
  connected: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RoomState {
  record: SyncRoomRecord;
  clients: Set<RuntimeSocket>;
  actions: CanvasActionEnvelope[];
  chats: ChatMessageEnvelope[];
  participants: Map<string, RoomParticipant>;
  seenActionIds: Set<string>;
}

export interface StartedSyncServer {
  port: number;
  close: () => Promise<void>;
}

interface RuntimeModules {
  createServer: () => RuntimeServer;
  createWebSocketServer: (server: RuntimeServer) => RuntimeWebSocketServer;
  pathToFileHref: (path: string) => string;
  argv: string[];
}

const syncRooms = new Map<string, RoomState>();
const socketMembership = new Map<RuntimeSocket, { roomId: string; sessionId: string }>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeDisplayName(value: unknown, sessionId: string): string {
  if (typeof value !== 'string') {
    return `User-${sessionId.slice(-4)}`;
  }
  const normalized = value.trim().replace(/\s{2,}/g, ' ');
  if (normalized.length === 0) {
    return `User-${sessionId.slice(-4)}`;
  }
  return normalized.slice(0, 48);
}

function parseClientMessage(raw: string): SyncClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string };
    if (!parsed || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as SyncClientMessage;
  } catch {
    return null;
  }
}

function serializeServerMessage(message: SyncServerMessage): string {
  return JSON.stringify(message);
}

function getOrCreateRoom(roomId: string): RoomState {
  const existing = syncRooms.get(roomId);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const createdRoom: RoomState = {
    record: {
      roomId,
      connectedClients: 0,
      connected: false,
      createdAt: now,
      updatedAt: now,
    },
    clients: new Set<RuntimeSocket>(),
    actions: [],
    chats: [],
    participants: new Map<string, RoomParticipant>(),
    seenActionIds: new Set<string>(),
  };
  syncRooms.set(roomId, createdRoom);
  return createdRoom;
}

function listParticipants(room: RoomState): RoomParticipant[] {
  return Array.from(room.participants.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function roomPresenceMessage(room: RoomState): SyncServerPresenceMessage {
  return {
    type: 'room.presence',
    roomId: room.record.roomId,
    connectedClients: room.record.connectedClients,
    participants: listParticipants(room),
  };
}

function broadcastToRoom(room: RoomState, message: SyncServerMessage, exceptSocket?: RuntimeSocket) {
  const payload = serializeServerMessage(message);
  for (const client of room.clients) {
    if (exceptSocket && client === exceptSocket) {
      continue;
    }
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function updateRoomConnectedClients(room: RoomState) {
  room.record.connectedClients = room.clients.size;
  room.record.connected = room.clients.size > 0;
  room.record.updatedAt = new Date().toISOString();
}

function joinRoom(socket: RuntimeSocket, joinMessage: SyncClientJoinMessage) {
  const room = getOrCreateRoom(joinMessage.roomId);
  const now = new Date().toISOString();
  const participant: RoomParticipant = {
    roomId: joinMessage.roomId,
    sessionId: joinMessage.sessionId,
    displayName: sanitizeDisplayName(joinMessage.displayName, joinMessage.sessionId),
    joinedAt: room.participants.get(joinMessage.sessionId)?.joinedAt ?? now,
    lastSeenAt: now,
  };
  room.participants.set(joinMessage.sessionId, participant);

  room.clients.add(socket);
  socketMembership.set(socket, {
    roomId: joinMessage.roomId,
    sessionId: joinMessage.sessionId,
  });
  updateRoomConnectedClients(room);

  const snapshot: SyncServerSnapshotMessage = {
    type: 'room.snapshot',
    roomId: room.record.roomId,
    actions: room.actions,
    recentChats: room.chats,
    participants: listParticipants(room),
    connectedClients: room.record.connectedClients,
  };
  socket.send(serializeServerMessage(snapshot));
  broadcastToRoom(room, roomPresenceMessage(room));
}

function leaveRoom(socket: RuntimeSocket) {
  const membership = socketMembership.get(socket);
  if (!membership) {
    return;
  }

  const room = syncRooms.get(membership.roomId);
  socketMembership.delete(socket);
  if (!room) {
    return;
  }

  room.clients.delete(socket);
  let sessionStillConnected = false;
  for (const entry of socketMembership.values()) {
    if (entry.roomId === membership.roomId && entry.sessionId === membership.sessionId) {
      sessionStillConnected = true;
      break;
    }
  }
  if (!sessionStillConnected) {
    room.participants.delete(membership.sessionId);
  }
  updateRoomConnectedClients(room);
  broadcastToRoom(room, roomPresenceMessage(room));
}

function handlePresencePing(pingMessage: SyncClientPresencePingMessage) {
  const room = syncRooms.get(pingMessage.roomId);
  if (!room) {
    return;
  }

  const existing = room.participants.get(pingMessage.sessionId);
  if (!existing) {
    return;
  }

  room.participants.set(pingMessage.sessionId, {
    ...existing,
    displayName: sanitizeDisplayName(pingMessage.displayName ?? existing.displayName, pingMessage.sessionId),
    lastSeenAt: typeof pingMessage.at === 'string' ? pingMessage.at : new Date().toISOString(),
  });
}

function handleAction(socket: RuntimeSocket, actionMessage: SyncClientActionMessage) {
  const room = syncRooms.get(actionMessage.roomId);
  if (!room) {
    const failure: FailureEnvelope = {
      code: 'invalid_request',
      message: `Room not found: ${actionMessage.roomId}`,
      retryable: false,
    };
    const errorMessage: SyncServerErrorMessage = {
      type: 'error',
      messageId: createId('error'),
      roomId: actionMessage.roomId,
      message: failure.message,
      failure,
    };
    socket.send(serializeServerMessage(errorMessage));
    return;
  }

  const duplicate = room.seenActionIds.has(actionMessage.action.id);
  const ackMessage: SyncServerActionAckMessage = {
    type: 'room.ack',
    messageId: createId('ack'),
    roomId: actionMessage.roomId,
    actionId: actionMessage.action.id,
    accepted: true,
    duplicate,
  };
  socket.send(serializeServerMessage(ackMessage));

  if (duplicate) {
    return;
  }

  room.actions.push(actionMessage.action);
  room.seenActionIds.add(actionMessage.action.id);
  if (room.actions.length > maxRoomActionHistory) {
    room.actions.splice(0, room.actions.length - maxRoomActionHistory);
    room.seenActionIds = new Set(room.actions.map((action) => action.id));
  }

  const serverAction: SyncServerActionMessage = {
    type: 'room.action',
    messageId: createId('room-action'),
    roomId: actionMessage.roomId,
    metadata: actionMessage.metadata,
    action: actionMessage.action,
  };
  broadcastToRoom(room, serverAction, socket);
}

function handleChat(socket: RuntimeSocket, chatMessage: SyncClientChatMessage) {
  const room = syncRooms.get(chatMessage.roomId);
  if (!room) {
    const failure: FailureEnvelope = {
      code: 'invalid_request',
      message: `Room not found: ${chatMessage.roomId}`,
      retryable: false,
    };
    const errorMessage: SyncServerErrorMessage = {
      type: 'error',
      messageId: createId('error'),
      roomId: chatMessage.roomId,
      message: failure.message,
      failure,
    };
    socket.send(serializeServerMessage(errorMessage));
    return;
  }

  const normalizedText = chatMessage.text.trim().slice(0, 2_000);
  if (normalizedText.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  const participant: RoomParticipant = {
    roomId: chatMessage.roomId,
    sessionId: chatMessage.sessionId,
    displayName: sanitizeDisplayName(chatMessage.displayName, chatMessage.sessionId),
    joinedAt: room.participants.get(chatMessage.sessionId)?.joinedAt ?? now,
    lastSeenAt: now,
  };
  room.participants.set(chatMessage.sessionId, participant);

  const chat: ChatMessageEnvelope = {
    id: createId('chat'),
    roomId: chatMessage.roomId,
    sessionId: chatMessage.sessionId,
    displayName: participant.displayName,
    text: normalizedText,
    mentionsAgent: Boolean(chatMessage.mentionsAgent),
    createdAt: now,
  };

  room.chats.push(chat);
  if (room.chats.length > maxRoomChatHistory) {
    room.chats.splice(0, room.chats.length - maxRoomChatHistory);
  }

  const payload: SyncServerChatMessage = {
    type: 'room.chat',
    roomId: chatMessage.roomId,
    chat,
  };
  broadcastToRoom(room, payload);
  broadcastToRoom(room, roomPresenceMessage(room));
}

function isLikelyJoinMessage(message: SyncClientMessage): message is SyncClientJoinMessage {
  return message.type === 'join' && typeof message.roomId === 'string' && typeof message.sessionId === 'string';
}

function isLikelyActionMessage(message: SyncClientMessage): message is SyncClientActionMessage {
  return (
    message.type === 'action' &&
    typeof message.roomId === 'string' &&
    typeof message.sessionId === 'string' &&
    isObject(message.action)
  );
}

function isLikelyPresencePingMessage(message: SyncClientMessage): message is SyncClientPresencePingMessage {
  return (
    message.type === 'presence.ping' &&
    typeof message.roomId === 'string' &&
    typeof message.sessionId === 'string'
  );
}

function isLikelyChatMessage(message: SyncClientMessage): message is SyncClientChatMessage {
  return (
    message.type === 'chat.send' &&
    typeof message.roomId === 'string' &&
    typeof message.sessionId === 'string' &&
    typeof message.text === 'string'
  );
}

async function loadRuntimeModules(): Promise<RuntimeModules> {
  const httpSpecifier = 'node:http';
  const urlSpecifier = 'node:url';
  const wsSpecifier = 'ws';

  const httpModule = (await import(httpSpecifier)) as {
    createServer: () => RuntimeServer;
  };
  const urlModule = (await import(urlSpecifier)) as {
    pathToFileURL: (path: string) => { href: string };
  };
  const wsModule = (await import(wsSpecifier)) as {
    WebSocketServer: new (options: { server: RuntimeServer }) => RuntimeWebSocketServer;
  };

  const argv =
    typeof globalThis === 'object' &&
    'process' in globalThis &&
    Array.isArray((globalThis as { process?: { argv?: unknown } }).process?.argv)
      ? ((globalThis as unknown as { process: { argv: string[] } }).process.argv)
      : [];

  return {
    createServer: httpModule.createServer,
    createWebSocketServer(server) {
      return new wsModule.WebSocketServer({ server });
    },
    pathToFileHref(path: string) {
      return urlModule.pathToFileURL(path).href;
    },
    argv,
  };
}

export function createSyncRoom(roomId: string): SyncRoomRecord {
  return getOrCreateRoom(roomId).record;
}

export function connectSyncRoom(roomId: string): SyncRoomRecord {
  const room = getOrCreateRoom(roomId);
  room.record.connectedClients += 1;
  room.record.connected = room.record.connectedClients > 0;
  room.record.updatedAt = new Date().toISOString();
  return room.record;
}

export function disconnectSyncRoom(roomId: string): SyncRoomRecord {
  const room = getOrCreateRoom(roomId);
  room.record.connectedClients = Math.max(0, room.record.connectedClients - 1);
  room.record.connected = room.record.connectedClients > 0;
  room.record.updatedAt = new Date().toISOString();
  return room.record;
}

export function listSyncRooms() {
  return Array.from(syncRooms.values()).map((room) => room.record);
}

export async function startSyncServer(port = syncServerPort): Promise<StartedSyncServer> {
  const runtime = await loadRuntimeModules();
  const server = runtime.createServer();
  const wsServer = runtime.createWebSocketServer(server);

  wsServer.on('connection', (socket: RuntimeSocket) => {
    socket.on('message', (rawData: { toString: () => string }) => {
      const text = rawData.toString();
      const message = parseClientMessage(text);
      if (!message) {
        return;
      }

      if (isLikelyJoinMessage(message)) {
        joinRoom(socket, message);
        return;
      }

      if (isLikelyActionMessage(message)) {
        handleAction(socket, message);
        return;
      }

      if (isLikelyPresencePingMessage(message)) {
        handlePresencePing(message);
        return;
      }

      if (isLikelyChatMessage(message)) {
        handleChat(socket, message);
      }
    });

    socket.on('close', () => {
      leaveRoom(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });

  return {
    port,
    close() {
      return new Promise<void>((resolve, reject) => {
        wsServer.close((wsError?: Error) => {
          if (wsError) {
            reject(wsError);
            return;
          }
          server.close((httpError?: Error) => {
            if (httpError) {
              reject(httpError);
              return;
            }
            resolve();
          });
        });
      });
    },
  };
}

export async function runSyncServerCli() {
  const runtime = await loadRuntimeModules();
  const isEntrypoint =
    runtime.argv.length > 1 &&
    import.meta.url === runtime.pathToFileHref(runtime.argv[1]);

  if (!isEntrypoint) {
    return;
  }

  const started = await startSyncServer(syncServerPort);
  // eslint-disable-next-line no-console
  console.log(`sync-server listening on ws://localhost:${started.port}`);
}

void runSyncServerCli();
