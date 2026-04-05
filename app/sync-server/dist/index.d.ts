export declare const syncServerPort: number;
export interface SyncRoomRecord {
    roomId: string;
    connectedClients: number;
    connected: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface StartedSyncServer {
    port: number;
    close: () => Promise<void>;
}
export declare function createSyncRoom(roomId: string): SyncRoomRecord;
export declare function connectSyncRoom(roomId: string): SyncRoomRecord;
export declare function disconnectSyncRoom(roomId: string): SyncRoomRecord;
export declare function listSyncRooms(): SyncRoomRecord[];
export declare function startSyncServer(port?: number): Promise<StartedSyncServer>;
export declare function runSyncServerCli(): Promise<void>;
//# sourceMappingURL=index.d.ts.map