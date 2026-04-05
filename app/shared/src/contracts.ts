export type RoomId = string;
export type SessionId = string;
export type AgentTurnId = string;
export type DisplayName = string;

export type CanvasShapeId = string;
export type CanvasActionId = string;
export type MessageId = string;
export type IdempotencyKey = string;

export type FailureCode =
  | 'invalid_request'
  | 'malformed_tool_call'
  | 'tool_validation_failed'
  | 'sync_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'provider_error'
  | 'internal_error';

export interface FailureEnvelope {
  code: FailureCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface RetryMetadata {
  attempt: number;
  maxAttempts: number;
}

export interface RequestMetadata extends RetryMetadata {
  requestId: MessageId;
  idempotencyKey: IdempotencyKey;
  sentAt: string;
}

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

export interface RoomParticipant {
  roomId: RoomId;
  sessionId: SessionId;
  displayName: DisplayName;
  joinedAt: string;
  lastSeenAt: string;
}

export interface ChatMessageEnvelope {
  id: MessageId;
  roomId: RoomId;
  sessionId: SessionId;
  displayName: DisplayName;
  text: string;
  mentionsAgent: boolean;
  createdAt: string;
}

export interface SyncClientJoinMessage {
  type: 'join';
  messageId: MessageId;
  roomId: RoomId;
  sessionId: SessionId;
  displayName?: DisplayName;
}

export interface SyncClientActionMessage {
  type: 'action';
  messageId: MessageId;
  metadata: RequestMetadata;
  roomId: RoomId;
  sessionId: SessionId;
  action: CanvasActionEnvelope;
}

export interface SyncClientPresencePingMessage {
  type: 'presence.ping';
  messageId: MessageId;
  roomId: RoomId;
  sessionId: SessionId;
  displayName?: DisplayName;
  at: string;
}

export interface SyncClientChatMessage {
  type: 'chat.send';
  messageId: MessageId;
  roomId: RoomId;
  sessionId: SessionId;
  displayName?: DisplayName;
  text: string;
  mentionsAgent: boolean;
  at: string;
}

export type SyncClientMessage =
  | SyncClientJoinMessage
  | SyncClientActionMessage
  | SyncClientPresencePingMessage
  | SyncClientChatMessage;

export interface SyncServerSnapshotMessage {
  type: 'room.snapshot';
  roomId: RoomId;
  actions: CanvasActionEnvelope[];
  recentChats: ChatMessageEnvelope[];
  participants: RoomParticipant[];
  connectedClients: number;
}

export interface SyncServerActionMessage {
  type: 'room.action';
  messageId: MessageId;
  roomId: RoomId;
  metadata?: RequestMetadata;
  action: CanvasActionEnvelope;
}

export interface SyncServerActionAckMessage {
  type: 'room.ack';
  messageId: MessageId;
  roomId: RoomId;
  actionId: CanvasActionId;
  accepted: boolean;
  duplicate: boolean;
  failure?: FailureEnvelope;
}

export interface SyncServerPresenceMessage {
  type: 'room.presence';
  roomId: RoomId;
  connectedClients: number;
  participants: RoomParticipant[];
}

export interface SyncServerChatMessage {
  type: 'room.chat';
  roomId: RoomId;
  chat: ChatMessageEnvelope;
}

export interface SyncServerErrorMessage {
  type: 'error';
  messageId: MessageId;
  roomId: RoomId;
  message: string;
  failure?: FailureEnvelope;
}

export type SyncServerMessage =
  | SyncServerSnapshotMessage
  | SyncServerActionMessage
  | SyncServerActionAckMessage
  | SyncServerPresenceMessage
  | SyncServerChatMessage
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
  type?: string;
  bounds: CanvasShapeBounds;
  updatedAt: string;
  text?: string;
  props?: Record<string, unknown>;
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
  | 'place_geo'
  | 'place_text'
  | 'draw_arrow'
  | 'update_shape'
  | 'delete_shape'
  | 'cluster_shapes'
  | 'summarize_region'
  | 'generate_image'
  | 'generate_video';

export interface ToolCallEnvelope {
  id: CanvasActionId;
  turnId: AgentTurnId;
  toolName: ToolName;
  arguments: Record<string, unknown>;
}

export interface ToolCallDeltaEnvelope {
  id: CanvasActionId;
  turnId: AgentTurnId;
  toolName?: ToolName;
  fragment: string;
  completed: boolean;
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
  invocation?: {
    source: 'chat' | 'canvas' | 'panel';
    displayName?: DisplayName;
    rawPrompt?: string;
    requireExplicitMention?: boolean;
    mentionDetected?: boolean;
  };
  metadata?: RequestMetadata;
}

export interface AgentStreamStartedEvent {
  type: 'agent.stream.started';
  turnId: AgentTurnId;
  at: string;
}

export interface AgentStreamTextDeltaEvent {
  type: 'agent.stream.delta';
  turnId: AgentTurnId;
  delta: string;
  at: string;
}

export interface AgentStreamToolCallDeltaEvent {
  type: 'agent.stream.tool_call.delta';
  turnId: AgentTurnId;
  toolCall: ToolCallDeltaEnvelope;
  at: string;
}

export interface AgentStreamToolCallCompletedEvent {
  type: 'agent.stream.tool_call.completed';
  turnId: AgentTurnId;
  toolCall: ToolCallEnvelope;
  at: string;
}

export interface AgentStreamActionEvent {
  type: 'agent.stream.action';
  turnId: AgentTurnId;
  action: CanvasActionEnvelope;
  at: string;
}

export interface AgentStreamCompletedEvent {
  type: 'agent.stream.completed';
  turnId: AgentTurnId;
  at: string;
}

export interface AgentStreamFailedEvent {
  type: 'agent.stream.failed';
  turnId: AgentTurnId;
  at: string;
  failure: FailureEnvelope;
}

export type AgentStreamEvent =
  | AgentStreamStartedEvent
  | AgentStreamTextDeltaEvent
  | AgentStreamToolCallDeltaEvent
  | AgentStreamToolCallCompletedEvent
  | AgentStreamActionEvent
  | AgentStreamCompletedEvent
  | AgentStreamFailedEvent;

export type AgentTurnStatus = 'accepted' | 'completed' | 'failed' | 'fallback';

export interface AgentTurnResponse {
  turnId: AgentTurnId;
  accepted: boolean;
  status: AgentTurnStatus;
  actions: CanvasActionEnvelope[];
  events?: AgentStreamEvent[];
  suggestedActions?: CanvasActionEnvelope[];
  failure?: FailureEnvelope;
  error?: string;
}

export interface ToolValidationResult {
  valid: boolean;
  missingKeys: string[];
}
