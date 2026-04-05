import type { ChatMessageEnvelope, CanvasActionEnvelope, FailureEnvelope, RoomParticipant, SyncConnectionState as SharedSyncConnectionState } from '@ai-canvas/shared';
export interface SyncConnectionState extends SharedSyncConnectionState {
}
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
export declare function createSyncConnection(roomId: string, sessionId?: string, options?: SyncConnectionOptions): SyncConnection;
export declare function setSyncConnecting(state: SyncConnectionState): SyncConnectionState;
export declare function setSyncConnected(state: SyncConnectionState): SyncConnectionState;
export declare function setSyncDisconnected(state: SyncConnectionState, error?: string | FailureEnvelope): SyncConnectionState;
export {};
//# sourceMappingURL=syncClient.d.ts.map