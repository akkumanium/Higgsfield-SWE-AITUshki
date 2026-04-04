import type { SyncConnectionState as SharedSyncConnectionState } from '@ai-canvas/shared';

export interface SyncConnectionState extends SharedSyncConnectionState {}

export function createSyncConnection(roomId: string, sessionId = 'local-session'): SyncConnectionState {
  return {
    roomId,
    sessionId,
    status: 'idle',
    connected: false,
    retryCount: 0,
    lastUpdatedAt: new Date().toISOString(),
  };
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
