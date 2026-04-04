export type RoomId = string;
export type SessionId = string;
export type AgentTurnId = string;

export type CanvasShapeId = string;
export type CanvasActionId = string;

export type SyncConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface SyncConnectionState {
  roomId: RoomId;
  sessionId: SessionId;
  status: SyncConnectionStatus;
  connected: boolean;
  retryCount: number;
  lastUpdatedAt: string;
  error?: string;
}

export interface SyncClientJoinMessage {
  type: 'join';
  roomId: RoomId;
  sessionId: SessionId;
}

export interface SyncClientActionMessage {
  type: 'action';
  roomId: RoomId;
  sessionId: SessionId;
  action: CanvasActionEnvelope;
}

export interface SyncClientPresencePingMessage {
  type: 'presence.ping';
  roomId: RoomId;
  sessionId: SessionId;
  at: string;
}

export type SyncClientMessage =
  | SyncClientJoinMessage
  | SyncClientActionMessage
  | SyncClientPresencePingMessage;

export interface SyncServerSnapshotMessage {
  type: 'room.snapshot';
  roomId: RoomId;
  actions: CanvasActionEnvelope[];
  connectedClients: number;
}

export interface SyncServerActionMessage {
  type: 'room.action';
  roomId: RoomId;
  action: CanvasActionEnvelope;
}

export interface SyncServerPresenceMessage {
  type: 'room.presence';
  roomId: RoomId;
  connectedClients: number;
}

export interface SyncServerErrorMessage {
  type: 'error';
  roomId: RoomId;
  message: string;
}

export type SyncServerMessage =
  | SyncServerSnapshotMessage
  | SyncServerActionMessage
  | SyncServerPresenceMessage
  | SyncServerErrorMessage;

export type CanvasShapeKind = 'text' | 'sticky' | 'arrow' | 'cluster' | 'image' | 'unknown';

export interface CanvasShapeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasShapeSnapshot {
  id: CanvasShapeId;
  kind: CanvasShapeKind;
  bounds: CanvasShapeBounds;
  updatedAt: string;
  text?: string;
  clusterId?: string;
  memberShapeIds?: CanvasShapeId[];
}

export interface AgentContextShape extends CanvasShapeSnapshot {
  distanceFromViewportCenter: number;
  viewportOverlap: number;
}

export interface AgentContextResponse extends AgentContextRequest {
  shapes: AgentContextShape[];
  tokenBudget: number;
  compressedShapeCount: number;
  totalShapeCount: number;
}

export type ToolName =
  | 'place_sticky'
  | 'draw_arrow'
  | 'cluster_shapes'
  | 'summarize_region'
  | 'generate_image';

export interface ToolCallEnvelope {
  id: CanvasActionId;
  turnId: AgentTurnId;
  toolName: ToolName;
  arguments: Record<string, unknown>;
}

export interface CanvasActionEnvelope {
  id: CanvasActionId;
  roomId: RoomId;
  turnId: AgentTurnId;
  source: 'local' | 'remote' | 'agent';
  kind: 'shape.create' | 'shape.update' | 'shape.delete' | 'shape.batch';
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentContextRequest {
  roomId: RoomId;
  sessionId: SessionId;
  viewport: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  maxShapes: number;
}

export interface AgentTurnRequest {
  roomId: RoomId;
  sessionId: SessionId;
  turnId: AgentTurnId;
  prompt: string;
  context: AgentContextRequest;
}

export interface AgentTurnResponse {
  turnId: AgentTurnId;
  accepted: boolean;
  actions: CanvasActionEnvelope[];
  suggestedActions?: CanvasActionEnvelope[];
  error?: string;
}

export interface ToolValidationResult {
  valid: boolean;
  missingKeys: string[];
}
