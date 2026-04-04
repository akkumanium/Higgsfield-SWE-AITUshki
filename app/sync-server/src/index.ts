import {
  type CanvasActionEnvelope,
  type FailureEnvelope,
  type SyncClientActionMessage,
  type SyncClientJoinMessage,
  type SyncClientMessage,
  type SyncServerActionAckMessage,
  type SyncServerActionMessage,
  type SyncServerErrorMessage,
  type SyncServerMessage,
  type SyncServerPresenceMessage,
  type SyncServerSnapshotMessage,
} from '@ai-canvas/shared';

export const syncServerPort = 3002;

const maxRoomActionHistory = 500;

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
const roomBySocket = new Map<RuntimeSocket, string>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
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
    seenActionIds: new Set<string>(),
  };
  syncRooms.set(roomId, createdRoom);
  return createdRoom;
}

function roomPresenceMessage(room: RoomState): SyncServerPresenceMessage {
  return {
    type: 'room.presence',
    roomId: room.record.roomId,
    connectedClients: room.record.connectedClients,
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

  room.clients.add(socket);
  roomBySocket.set(socket, joinMessage.roomId);
  updateRoomConnectedClients(room);

  const snapshot: SyncServerSnapshotMessage = {
    type: 'room.snapshot',
    roomId: room.record.roomId,
    actions: room.actions,
    connectedClients: room.record.connectedClients,
  };
  socket.send(serializeServerMessage(snapshot));
  broadcastToRoom(room, roomPresenceMessage(room));
}

function leaveRoom(socket: RuntimeSocket) {
  const roomId = roomBySocket.get(socket);
  if (!roomId) {
    return;
  }

  const room = syncRooms.get(roomId);
  roomBySocket.delete(socket);
  if (!room) {
    return;
  }

  room.clients.delete(socket);
  updateRoomConnectedClients(room);
  broadcastToRoom(room, roomPresenceMessage(room));
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
