export const syncServerPort = 3002;

export interface SyncRoomRecord {
  roomId: string;
  connectedClients: number;
  connected: boolean;
  createdAt: string;
  updatedAt: string;
}

const syncRooms = new Map<string, SyncRoomRecord>();

export function createSyncRoom(roomId: string): SyncRoomRecord {
  const now = new Date().toISOString();
  const room = syncRooms.get(roomId);
  if (room) {
    return room;
  }

  const createdRoom: SyncRoomRecord = {
    roomId,
    connectedClients: 0,
    connected: false,
    createdAt: now,
    updatedAt: now,
  };
  syncRooms.set(roomId, createdRoom);
  return createdRoom;
}

export function connectSyncRoom(roomId: string): SyncRoomRecord {
  const room = createSyncRoom(roomId);
  const nextRoom: SyncRoomRecord = {
    ...room,
    connectedClients: room.connectedClients + 1,
    connected: true,
    updatedAt: new Date().toISOString(),
  };
  syncRooms.set(roomId, nextRoom);
  return nextRoom;
}

export function disconnectSyncRoom(roomId: string): SyncRoomRecord {
  const room = createSyncRoom(roomId);
  const connectedClients = Math.max(0, room.connectedClients - 1);
  const nextRoom: SyncRoomRecord = {
    ...room,
    connectedClients,
    connected: connectedClients > 0,
    updatedAt: new Date().toISOString(),
  };
  syncRooms.set(roomId, nextRoom);
  return nextRoom;
}

export function listSyncRooms() {
  return Array.from(syncRooms.values());
}
