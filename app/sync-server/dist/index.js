function getEnv(name) {
    const maybeProcess = globalThis.process;
    return maybeProcess?.env?.[name];
}
export const syncServerPort = (() => {
    const configured = Number(getEnv('PORT') ?? getEnv('SYNC_SERVER_PORT') ?? 3002);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3002;
})();
const maxRoomActionHistory = 500;
const maxRoomChatHistory = 200;
const syncRooms = new Map();
const socketMembership = new Map();
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function createId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
function sanitizeDisplayName(value, sessionId) {
    if (typeof value !== 'string') {
        return `User-${sessionId.slice(-4)}`;
    }
    const normalized = value.trim().replace(/\s{2,}/g, ' ');
    if (normalized.length === 0) {
        return `User-${sessionId.slice(-4)}`;
    }
    return normalized.slice(0, 48);
}
function parseClientMessage(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.type !== 'string') {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function serializeServerMessage(message) {
    return JSON.stringify(message);
}
function getOrCreateRoom(roomId) {
    const existing = syncRooms.get(roomId);
    if (existing) {
        return existing;
    }
    const now = new Date().toISOString();
    const createdRoom = {
        record: {
            roomId,
            connectedClients: 0,
            connected: false,
            createdAt: now,
            updatedAt: now,
        },
        clients: new Set(),
        actions: [],
        chats: [],
        participants: new Map(),
        seenActionIds: new Set(),
    };
    syncRooms.set(roomId, createdRoom);
    return createdRoom;
}
function listParticipants(room) {
    return Array.from(room.participants.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
function roomPresenceMessage(room) {
    return {
        type: 'room.presence',
        roomId: room.record.roomId,
        connectedClients: room.record.connectedClients,
        participants: listParticipants(room),
    };
}
function broadcastToRoom(room, message, exceptSocket) {
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
function updateRoomConnectedClients(room) {
    room.record.connectedClients = room.clients.size;
    room.record.connected = room.clients.size > 0;
    room.record.updatedAt = new Date().toISOString();
}
function joinRoom(socket, joinMessage) {
    const room = getOrCreateRoom(joinMessage.roomId);
    const now = new Date().toISOString();
    const participant = {
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
    const snapshot = {
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
function leaveRoom(socket) {
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
function handlePresencePing(pingMessage) {
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
function handleAction(socket, actionMessage) {
    const room = syncRooms.get(actionMessage.roomId);
    if (!room) {
        const failure = {
            code: 'invalid_request',
            message: `Room not found: ${actionMessage.roomId}`,
            retryable: false,
        };
        const errorMessage = {
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
    const ackMessage = {
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
    const serverAction = {
        type: 'room.action',
        messageId: createId('room-action'),
        roomId: actionMessage.roomId,
        metadata: actionMessage.metadata,
        action: actionMessage.action,
    };
    broadcastToRoom(room, serverAction, socket);
}
function handleChat(socket, chatMessage) {
    const room = syncRooms.get(chatMessage.roomId);
    if (!room) {
        const failure = {
            code: 'invalid_request',
            message: `Room not found: ${chatMessage.roomId}`,
            retryable: false,
        };
        const errorMessage = {
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
    const participant = {
        roomId: chatMessage.roomId,
        sessionId: chatMessage.sessionId,
        displayName: sanitizeDisplayName(chatMessage.displayName, chatMessage.sessionId),
        joinedAt: room.participants.get(chatMessage.sessionId)?.joinedAt ?? now,
        lastSeenAt: now,
    };
    room.participants.set(chatMessage.sessionId, participant);
    const chat = {
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
    const payload = {
        type: 'room.chat',
        roomId: chatMessage.roomId,
        chat,
    };
    broadcastToRoom(room, payload);
    broadcastToRoom(room, roomPresenceMessage(room));
}
function isLikelyJoinMessage(message) {
    return message.type === 'join' && typeof message.roomId === 'string' && typeof message.sessionId === 'string';
}
function isLikelyActionMessage(message) {
    return (message.type === 'action' &&
        typeof message.roomId === 'string' &&
        typeof message.sessionId === 'string' &&
        isObject(message.action));
}
function isLikelyPresencePingMessage(message) {
    return (message.type === 'presence.ping' &&
        typeof message.roomId === 'string' &&
        typeof message.sessionId === 'string');
}
function isLikelyChatMessage(message) {
    return (message.type === 'chat.send' &&
        typeof message.roomId === 'string' &&
        typeof message.sessionId === 'string' &&
        typeof message.text === 'string');
}
async function loadRuntimeModules() {
    const httpSpecifier = 'node:http';
    const urlSpecifier = 'node:url';
    const wsSpecifier = 'ws';
    const httpModule = (await import(httpSpecifier));
    const urlModule = (await import(urlSpecifier));
    const wsModule = (await import(wsSpecifier));
    const argv = typeof globalThis === 'object' &&
        'process' in globalThis &&
        Array.isArray(globalThis.process?.argv)
        ? (globalThis.process.argv)
        : [];
    return {
        createServer: httpModule.createServer,
        createWebSocketServer(server) {
            return new wsModule.WebSocketServer({ server });
        },
        pathToFileHref(path) {
            return urlModule.pathToFileURL(path).href;
        },
        argv,
    };
}
export function createSyncRoom(roomId) {
    return getOrCreateRoom(roomId).record;
}
export function connectSyncRoom(roomId) {
    const room = getOrCreateRoom(roomId);
    room.record.connectedClients += 1;
    room.record.connected = room.record.connectedClients > 0;
    room.record.updatedAt = new Date().toISOString();
    return room.record;
}
export function disconnectSyncRoom(roomId) {
    const room = getOrCreateRoom(roomId);
    room.record.connectedClients = Math.max(0, room.record.connectedClients - 1);
    room.record.connected = room.record.connectedClients > 0;
    room.record.updatedAt = new Date().toISOString();
    return room.record;
}
export function listSyncRooms() {
    return Array.from(syncRooms.values()).map((room) => room.record);
}
export async function startSyncServer(port = syncServerPort) {
    const runtime = await loadRuntimeModules();
    const server = runtime.createServer();
    const wsServer = runtime.createWebSocketServer(server);
    wsServer.on('connection', (socket) => {
        socket.on('message', (rawData) => {
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
    await new Promise((resolve) => {
        server.listen(port, () => resolve());
    });
    return {
        port,
        close() {
            return new Promise((resolve, reject) => {
                wsServer.close((wsError) => {
                    if (wsError) {
                        reject(wsError);
                        return;
                    }
                    server.close((httpError) => {
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
    const isEntrypoint = runtime.argv.length > 1 &&
        import.meta.url === runtime.pathToFileHref(runtime.argv[1]);
    if (!isEntrypoint) {
        return;
    }
    const started = await startSyncServer(syncServerPort);
    // eslint-disable-next-line no-console
    console.log(`sync-server listening on ws://localhost:${started.port}`);
}
void runSyncServerCli();
//# sourceMappingURL=index.js.map