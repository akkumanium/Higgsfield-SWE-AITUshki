/// <reference path="./shims.d.ts" />

import type {
  AgentStreamEvent,
  AgentTurnResponse,
  ChatMessageEnvelope,
  CanvasActionEnvelope,
  CanvasShapeSnapshot,
  RoomParticipant,
} from '@ai-canvas/shared';
import { createRoot, type Root } from 'react-dom/client';
import {
  Tldraw,
  type Editor,
  type TLRecord,
  type TLShape,
  type TLStoreSnapshot,
} from 'tldraw';
import {
  agentTriggerEventName,
  createAgentTriggerEvent,
  detectAgentTrigger,
  type AgentTriggerDetail,
} from './features/agent/AgentTrigger.js';
import { buildAgentContext } from './features/agent/contextBuilder.js';
import { applyCanvasAction } from './features/canvas/mutationAdapter.js';
import { createSyncConnection, type SyncConnectionState } from './features/sync/syncClient.js';

export const defaultRoomId = 'demo-room';
export const defaultSessionId = 'demo-session';
const maxCreateOperationsPerAgentTurn = 50;
const maxAppliedRemoteActionIds = 2_000;
const DEFAULT_NOTE_W = 200;
const DEFAULT_NOTE_H = 120;
const DEFAULT_GEO_W = 160;
const DEFAULT_GEO_H = 80;
const MEDIA_POLL_INTERVAL_MS = 3_500;
const MEDIA_POLL_MAX_RETRIES = 120;
const OVERLAY_MARGIN_PX = 12;
const OVERLAY_WIDTH_PX = 360;

type MediaStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw';

interface MediaRequestPayload {
  requestId: string;
  shapeId: string;
  mediaType: 'image' | 'video';
  status?: string;
}

interface MediaStatusResponse {
  requestId: string;
  status: MediaStatus;
  imageUrl?: string;
  videoUrl?: string;
  error?: string;
}

interface VoiceSessionResponse {
  provider: 'daily';
  roomUrl: string;
  token?: string;
  expiresAt?: string;
}

interface DailyCallObjectLike {
  join: (options: { url: string; token?: string }) => Promise<void>;
  leave: () => Promise<void>;
  setLocalAudio: (enabled: boolean) => void;
  destroy?: () => void;
}

export interface AppOptions {
  roomId?: string;
  sessionId?: string;
  displayName?: string;
  syncUrl?: string;
  backendUrl?: string;
}

export interface MountedApp {
  root: HTMLElement;
  dispose: () => void;
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function toShapeId(value: unknown, fallbackPrefix: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    const raw = value.trim();
    if (raw.startsWith('shape:')) {
      return raw;
    }
    return `shape:${raw.replace(/[^a-zA-Z0-9:_-]/g, '-')}`;
  }
  return `shape:${fallbackPrefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseRoomAndSessionFromUrl(): { roomId: string; sessionId: string; displayName: string } {
  if (typeof window === 'undefined') {
    return {
      roomId: defaultRoomId,
      sessionId: defaultSessionId,
      displayName: 'User',
    };
  }

  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  const sessionFromUrl = params.get('session');
  const nameFromUrl = params.get('name');
  const sessionFromStorage = window.sessionStorage.getItem('ai-canvas-session-id');
  const nameFromStorage = window.localStorage.getItem('ai-canvas-display-name');

  const roomId = roomFromUrl && roomFromUrl.trim().length > 0 ? roomFromUrl : defaultRoomId;
  const sessionId =
    (sessionFromUrl && sessionFromUrl.trim().length > 0
      ? sessionFromUrl
      : sessionFromStorage && sessionFromStorage.trim().length > 0
        ? sessionFromStorage
        : `${defaultSessionId}-${Math.random().toString(36).slice(2, 10)}`);
  const fallbackName = `User-${sessionId.slice(-4)}`;
  const displayName =
    (nameFromUrl && nameFromUrl.trim().length > 0
      ? nameFromUrl.trim()
      : nameFromStorage && nameFromStorage.trim().length > 0
        ? nameFromStorage.trim()
        : fallbackName).slice(0, 48);

  params.set('room', roomId);
  params.set('session', sessionId);
  params.set('name', displayName);
  const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState({}, '', nextUrl);
  window.sessionStorage.setItem('ai-canvas-session-id', sessionId);
  window.localStorage.setItem('ai-canvas-display-name', displayName);

  return {
    roomId,
    sessionId,
    displayName,
  };
}

function isShapeRecord(record: unknown): record is TLShape {
  return typeof record === 'object' && record !== null && (record as { typeName?: unknown }).typeName === 'shape';
}

function isTextualShape(shape: TLShape): boolean {
  const typedShape = shape as TLShape & { type?: string; props?: { text?: unknown } };
  return (typedShape.type === 'text' || typedShape.type === 'note') && typeof typedShape.props?.text === 'string';
}

type RichTextNode = {
  type: 'text';
  text: string;
};

type RichTextParagraph = {
  type: 'paragraph';
  content?: RichTextNode[];
};

type RichTextDocument = {
  type: 'doc';
  content: RichTextParagraph[];
};

function toRichText(text: string): RichTextDocument {
  const trimmed = text.trim();
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: trimmed.length > 0 ? [{ type: 'text', text }] : undefined,
      },
    ],
  };
}

function extractRichText(richText: unknown): string {
  if (typeof richText !== 'object' || richText === null) {
    return '';
  }

  const root = richText as Record<string, unknown>;
  const doc = root.doc ?? root;

  const walk = (node: unknown): string => {
    if (typeof node !== 'object' || node === null) return '';
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (!Array.isArray(record.content)) return '';
    return record.content.map(walk).join('');
  };

  return walk(doc).replace(/\s+/g, ' ').trim();
}

function estimateTextBounds(text: string): { w: number; h: number } {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return { w: 80, h: 28 };
  }

  const lines = normalized.split(/\r?\n/);
  const maxChars = lines.reduce((max, line) => Math.max(max, line.length), 1);
  // Rough fit for default tldraw text at size "xl".
  const estimatedWidth = Math.min(1200, Math.max(40, Math.round(maxChars * 11)));
  const estimatedHeight = Math.max(28, Math.round(lines.length * 28));
  return { w: estimatedWidth, h: estimatedHeight };
}

function getShapeDimensionsForCentering(editor: Editor, shape: TLShape): { w: number; h: number } {
  const bounds = getEditorShapePageBounds(editor, shape.id);
  if (bounds && bounds.w > 0 && bounds.h > 0) {
    return { w: bounds.w, h: bounds.h };
  }

  const typed = shape as TLShape & {
    type?: string;
    props?: Record<string, unknown> & { w?: unknown; h?: unknown; richText?: unknown; text?: unknown };
  };

  if (typed.type === 'note') {
    return { w: DEFAULT_NOTE_W, h: DEFAULT_NOTE_H };
  }

  if (typed.type === 'geo') {
    const w = typeof typed.props?.w === 'number' && typed.props.w > 0 ? typed.props.w : DEFAULT_GEO_W;
    const h = typeof typed.props?.h === 'number' && typed.props.h > 0 ? typed.props.h : DEFAULT_GEO_H;
    return { w, h };
  }

  if (typed.type === 'text') {
    const richText = typed.props?.richText;
    const plainText =
      typeof typed.props?.text === 'string'
        ? typed.props.text
        : richText !== undefined
          ? extractRichText(richText)
          : '';
    return estimateTextBounds(plainText);
  }

  const w = typeof typed.props?.w === 'number' && typed.props.w > 0 ? typed.props.w : 160;
  const h = typeof typed.props?.h === 'number' && typed.props.h > 0 ? typed.props.h : 100;
  return { w, h };
}

function createShapeAction(
  roomId: string,
  turnId: string,
  source: CanvasActionEnvelope['source'],
  kind: CanvasActionEnvelope['kind'],
  payload: Record<string, unknown>,
): CanvasActionEnvelope {
  return {
    id: createId('action'),
    roomId,
    turnId,
    source,
    kind,
    payload,
    createdAt: new Date().toISOString(),
  };
}

function getCurrentShapeSnapshot(editor: Editor): TLStoreSnapshot {
  return editor.store.getStoreSnapshot();
}

function collectShapesFromSnapshot(snapshot: TLStoreSnapshot): TLShape[] {
  const records = Object.values(snapshot.store as Record<string, TLRecord>);
  return records.filter((record): record is TLShape => isShapeRecord(record));
}

function getUpdatedShapeRecord(changeValue: unknown): TLShape | null {
  if (!changeValue || typeof changeValue !== 'object') {
    return null;
  }
  const candidate = changeValue as { to?: unknown; [index: number]: unknown };
  if (isShapeRecord(candidate.to)) {
    return candidate.to;
  }
  if (isShapeRecord(candidate[1])) {
    return candidate[1];
  }
  return null;
}

function getViewport(editor: Editor) {
  const maybe = editor as unknown as {
    getViewportPageBounds?: () => { x: number; y: number; w?: number; h?: number; width?: number; height?: number };
  };

  const viewport = maybe.getViewportPageBounds?.();
  return {
    x: viewport?.x ?? 0,
    y: viewport?.y ?? 0,
    width: viewport?.width ?? viewport?.w ?? 1200,
    height: viewport?.height ?? viewport?.h ?? 800,
  };
}

type PageBounds = { x: number; y: number; w: number; h: number };

function getEditorShape(editor: Editor, shapeId: string): TLShape | undefined {
  const maybe = editor as unknown as {
    getShape?: (id: string) => TLShape | undefined;
  };
  return maybe.getShape?.(shapeId);
}

function getEditorShapePageBounds(editor: Editor, shapeId: string): PageBounds | undefined {
  const maybe = editor as unknown as {
    getShapePageBounds?: (id: string) => { x: number; y: number; w: number; h: number } | undefined;
  };
  return maybe.getShapePageBounds?.(shapeId);
}

function getEditorShapesPageBounds(editor: Editor, shapeIds: string[]): PageBounds | undefined {
  const maybe = editor as unknown as {
    getShapesPageBounds?: (ids: string[]) => { x: number; y: number; w: number; h: number } | null | undefined;
  };
  const bounds = maybe.getShapesPageBounds?.(shapeIds);
  return bounds ?? undefined;
}

function createEditorAssets(editor: Editor, assets: unknown[]) {
  const maybe = editor as unknown as {
    createAssets?: (records: unknown[]) => void;
  };
  maybe.createAssets?.(assets);
}

function updateEditorShapes(editor: Editor, updates: Array<Record<string, unknown>>) {
  const maybe = editor as unknown as {
    updateShapes?: (partials: unknown[]) => void;
  };
  maybe.updateShapes?.(updates);
}

function createEditorBindings(editor: Editor, bindings: unknown[]) {
  const maybe = editor as unknown as {
    createBindings?: (partials: unknown[]) => void;
  };
  maybe.createBindings?.(bindings);
}

function groupEditorShapes(editor: Editor, shapeIds: string[], options?: { groupId?: string; select?: boolean }) {
  const maybe = editor as unknown as {
    groupShapes?: (ids: string[], opts?: { groupId?: string; select?: boolean }) => void;
  };
  maybe.groupShapes?.(shapeIds, options);
}

function normalizeMediaStatus(value: unknown): MediaStatus {
  if (typeof value !== 'string') {
    return 'failed';
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'queued' ||
    normalized === 'in_progress' ||
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'nsfw'
  ) {
    return normalized;
  }
  return 'failed';
}

function isTerminalMediaStatus(status: MediaStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'nsfw';
}

function parseMediaRequestPayload(payload: unknown): MediaRequestPayload | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const requestId = typeof record.requestId === 'string' ? record.requestId.trim() : '';
  const shapeId = typeof record.shapeId === 'string' ? record.shapeId.trim() : '';
  const mediaType = record.mediaType === 'video' ? 'video' : record.mediaType === 'image' ? 'image' : null;

  if (!requestId || !shapeId || !mediaType) {
    return null;
  }

  return {
    requestId,
    shapeId,
    mediaType,
    status: typeof record.status === 'string' ? record.status : undefined,
  };
}

function tryReplaceNoteWithImageShape(editor: Editor, shapeId: string, requestId: string, imageUrl: string): boolean {
  const sourceShape = getEditorShape(editor, shapeId);
  if (!sourceShape) {
    return false;
  }

  const bounds = getEditorShapePageBounds(editor, shapeId);
  const width = Math.max(120, Math.round(bounds?.w ?? 640));
  const height = Math.max(80, Math.round(bounds?.h ?? 360));
  const x = bounds?.x ?? (typeof sourceShape.x === 'number' ? sourceShape.x : 0);
  const y = bounds?.y ?? (typeof sourceShape.y === 'number' ? sourceShape.y : 0);
  const assetId = `asset:media-${requestId}-${Math.random().toString(36).slice(2, 8)}`;
  const imageShapeId = toShapeId(`media-image-${requestId}`, 'media-image');

  try {
    createEditorAssets(editor, [
      {
        id: assetId,
        typeName: 'asset',
        type: 'image',
        props: {
          name: `higgsfield-${requestId}.jpg`,
          src: imageUrl,
          w: width,
          h: height,
          mimeType: 'image/jpeg',
          isAnimated: false,
        },
        meta: {
          requestId,
          provider: 'higgsfield',
        },
      },
    ]);

    editor.createShapes([
      {
        id: imageShapeId,
        type: 'image',
        x,
        y,
        props: {
          assetId,
          w: width,
          h: height,
        },
        meta: {
          requestId,
          provider: 'higgsfield',
          source: 'agent-media',
        },
      } as never,
    ]);
    editor.deleteShapes([shapeId]);
    return true;
  } catch {
    return false;
  }
}

function toShapeSnapshot(editor: Editor, shape: TLShape): CanvasShapeSnapshot {
  const typedShape = shape as TLShape & {
    type?: string;
    props?: Record<string, unknown> & { text?: unknown; w?: unknown; h?: unknown };
    x?: number;
    y?: number;
    meta?: { clusterId?: unknown; memberShapeIds?: unknown };
  };

  const pageBounds = getEditorShapePageBounds(editor, shape.id);
  const width = pageBounds?.w ?? (typeof typedShape.props?.w === 'number' ? typedShape.props.w : 180);
  const height = pageBounds?.h ?? (typeof typedShape.props?.h === 'number' ? typedShape.props.h : 120);
  const textFromProps =
    typeof typedShape.props?.text === 'string'
      ? typedShape.props.text
      : typedShape.props?.richText !== undefined
        ? extractRichText(typedShape.props.richText)
        : undefined;
  const kind: CanvasShapeSnapshot['kind'] =
    typedShape.type === 'text'
      ? 'text'
      : typedShape.type === 'note'
        ? 'sticky'
        : typedShape.type === 'arrow'
          ? 'arrow'
          : typedShape.type === 'image'
            ? 'image'
            : typedShape.type === 'group'
              ? 'cluster'
              : 'unknown';

  return {
    id: shape.id,
    kind,
    type: typeof typedShape.type === 'string' ? typedShape.type : undefined,
    bounds: {
      x: pageBounds?.x ?? (typeof typedShape.x === 'number' ? typedShape.x : 0),
      y: pageBounds?.y ?? (typeof typedShape.y === 'number' ? typedShape.y : 0),
      width,
      height,
    },
    updatedAt: new Date().toISOString(),
    text: textFromProps,
    props: typeof typedShape.props === 'object' && typedShape.props !== null ? typedShape.props : undefined,
    clusterId:
      typeof typedShape.meta?.clusterId === 'string'
        ? typedShape.meta.clusterId
        : undefined,
    memberShapeIds: Array.isArray(typedShape.meta?.memberShapeIds)
      ? (typedShape.meta.memberShapeIds as string[])
      : undefined,
  };
}

function syncStateLabel(state: SyncConnectionState): string {
  if (state.status === 'connected') {
    return 'Sync connected';
  }
  if (state.status === 'connecting') {
    return 'Sync connecting';
  }
  if (state.status === 'error') {
    return state.error ? `Sync error: ${state.error}` : 'Sync error';
  }
  return 'Sync disconnected';
}

function syncStateColor(state: SyncConnectionState): string {
  if (state.status === 'connected') {
    return '#0f766e';
  }
  if (state.status === 'connecting') {
    return '#b45309';
  }
  if (state.status === 'error') {
    return '#b91c1c';
  }
  return '#475569';
}

async function parseSseResponse(response: Response): Promise<{ events: AgentStreamEvent[]; result: AgentTurnResponse | null }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      events: [],
      result: null,
    };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const events: AgentStreamEvent[] = [];
  let result: AgentTurnResponse | null = null;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) {
        continue;
      }

      const eventName = eventLine.replace('event: ', '').trim();
      try {
        const payload = JSON.parse(dataLine.replace('data: ', '')) as unknown;
        if (eventName === 'agent.turn.result') {
          result = payload as AgentTurnResponse;
          continue;
        }
        events.push(payload as AgentStreamEvent);
      } catch {
        continue;
      }
    }
  }

  return {
    events,
    result,
  };
}

export function App(root: HTMLElement, options: AppOptions = {}): MountedApp {
  const urlResolved = parseRoomAndSessionFromUrl();
  const roomId = options.roomId ?? urlResolved.roomId;
  const sessionId = options.sessionId ?? urlResolved.sessionId;
  const displayName = options.displayName ?? urlResolved.displayName;
  const backendUrl = options.backendUrl ?? 'http://localhost:3001';
  const sync = createSyncConnection(roomId, sessionId, {
    url: options.syncUrl,
    displayName,
  });

  root.innerHTML = '';
  root.style.position = root.style.position || 'relative';

  const mountNode = document.createElement('div');
  mountNode.style.height = '100%';
  root.appendChild(mountNode);

  const overlay = document.createElement('aside');
  overlay.style.position = 'absolute';
  overlay.style.top = `${OVERLAY_MARGIN_PX}px`;
  overlay.style.right = `${OVERLAY_MARGIN_PX}px`;
  overlay.style.width = `${OVERLAY_WIDTH_PX}px`;
  overlay.style.maxWidth = `calc(100vw - ${OVERLAY_MARGIN_PX * 2}px)`;
  overlay.style.padding = '12px';
  overlay.style.borderRadius = '12px';
  overlay.style.border = '1px solid #dbe3ed';
  overlay.style.background = 'linear-gradient(180deg, rgba(255, 255, 255, 0.97) 0%, rgba(248, 250, 252, 0.97) 100%)';
  overlay.style.boxShadow = '0 12px 32px rgba(15, 23, 42, 0.18)';
  overlay.style.fontFamily = 'Segoe UI, sans-serif';
  overlay.style.pointerEvents = 'auto';
  overlay.style.zIndex = '40';

  const dragHeader = document.createElement('div');
  dragHeader.style.display = 'flex';
  dragHeader.style.alignItems = 'center';
  dragHeader.style.justifyContent = 'space-between';
  dragHeader.style.marginBottom = '8px';
  dragHeader.style.padding = '2px 2px 6px 2px';
  dragHeader.style.borderBottom = '1px solid #e2e8f0';
  dragHeader.style.cursor = 'grab';
  dragHeader.style.userSelect = 'none';
  dragHeader.style.touchAction = 'none';

  const title = document.createElement('div');
  title.textContent = 'Room Chat + AI';
  title.style.fontSize = '14px';
  title.style.fontWeight = '700';

  const dragHint = document.createElement('div');
  dragHint.textContent = 'drag';
  dragHint.style.fontSize = '11px';
  dragHint.style.fontWeight = '600';
  dragHint.style.textTransform = 'uppercase';
  dragHint.style.letterSpacing = '0.08em';
  dragHint.style.color = '#64748b';

  dragHeader.appendChild(title);
  dragHeader.appendChild(dragHint);

  const metaCard = document.createElement('div');
  metaCard.style.display = 'grid';
  metaCard.style.gap = '4px';
  metaCard.style.marginBottom = '8px';
  metaCard.style.padding = '8px 10px';
  metaCard.style.border = '1px solid #dbe2ea';
  metaCard.style.borderRadius = '8px';
  metaCard.style.background = 'rgba(248, 250, 252, 0.9)';

  const roomMeta = document.createElement('div');
  roomMeta.textContent = `room: ${roomId}`;
  roomMeta.style.fontSize = '11px';
  roomMeta.style.fontWeight = '600';
  roomMeta.style.color = '#334155';

  const sessionMeta = document.createElement('div');
  sessionMeta.textContent = `session: ${sessionId}`;
  sessionMeta.style.fontSize = '11px';
  sessionMeta.style.color = '#334155';

  const userMeta = document.createElement('div');
  userMeta.textContent = `you: ${displayName}`;
  userMeta.style.fontSize = '11px';
  userMeta.style.color = '#334155';

  const participantsMeta = document.createElement('div');
  participantsMeta.textContent = 'participants: 1';
  participantsMeta.style.fontSize = '11px';
  participantsMeta.style.color = '#334155';

  metaCard.appendChild(roomMeta);
  metaCard.appendChild(sessionMeta);
  metaCard.appendChild(userMeta);
  metaCard.appendChild(participantsMeta);

  const syncBadge = document.createElement('div');
  syncBadge.style.display = 'inline-block';
  syncBadge.style.padding = '5px 9px';
  syncBadge.style.borderRadius = '999px';
  syncBadge.style.fontSize = '11px';
  syncBadge.style.fontWeight = '600';
  syncBadge.style.marginBottom = '9px';

  const input = document.createElement('textarea');
  input.placeholder = 'Chat with the room. Use @agent to run AI commands.';
  input.style.width = '100%';
  input.style.minHeight = '72px';
  input.style.resize = 'vertical';
  input.style.boxSizing = 'border-box';
  input.style.padding = '9px 10px';
  input.style.border = '1px solid #bfccd9';
  input.style.borderRadius = '8px';
  input.style.fontSize = '13px';
  input.style.background = '#ffffff';
  input.style.color = '#0f172a';
  input.style.marginBottom = '8px';

  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.textContent = 'Send message';
  sendButton.style.width = '100%';
  sendButton.style.padding = '10px 10px';
  sendButton.style.border = 'none';
  sendButton.style.borderRadius = '8px';
  sendButton.style.background = 'linear-gradient(180deg, #0f766e 0%, #115e59 100%)';
  sendButton.style.color = '#ffffff';
  sendButton.style.fontWeight = '600';
  sendButton.style.cursor = 'pointer';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel request';
  cancelButton.style.width = '100%';
  cancelButton.style.padding = '8px 10px';
  cancelButton.style.marginTop = '6px';
  cancelButton.style.border = '1px solid #94a3b8';
  cancelButton.style.borderRadius = '8px';
  cancelButton.style.background = '#ffffff';
  cancelButton.style.color = '#0f172a';
  cancelButton.style.fontWeight = '600';
  cancelButton.style.cursor = 'pointer';
  cancelButton.style.display = 'none';

  const statusLine = document.createElement('div');
  statusLine.style.marginTop = '8px';
  statusLine.style.fontSize = '12px';
  statusLine.style.color = '#475569';

  const chatOutput = document.createElement('div');
  chatOutput.style.marginTop = '8px';
  chatOutput.style.maxHeight = '220px';
  chatOutput.style.overflowY = 'auto';
  chatOutput.style.display = 'flex';
  chatOutput.style.flexDirection = 'column';
  chatOutput.style.gap = '6px';
  chatOutput.style.padding = '8px';
  chatOutput.style.border = '1px solid #d4dde7';
  chatOutput.style.borderRadius = '10px';
  chatOutput.style.background = 'linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)';
  chatOutput.style.fontSize = '12px';
  chatOutput.style.color = '#0f172a';
  chatOutput.style.wordBreak = 'break-word';

  const errorLine = document.createElement('div');
  errorLine.style.marginTop = '6px';
  errorLine.style.fontSize = '12px';
  errorLine.style.color = '#b91c1c';

  const helper = document.createElement('div');
  helper.textContent = 'Tip: users always receive messages; AI only runs when @agent is included.';
  helper.style.marginTop = '8px';
  helper.style.fontSize = '11px';
  helper.style.color = '#5b6778';

  const voiceTitle = document.createElement('div');
  voiceTitle.textContent = 'Voice room (Daily)';
  voiceTitle.style.marginTop = '10px';
  voiceTitle.style.fontSize = '12px';
  voiceTitle.style.fontWeight = '700';
  voiceTitle.style.color = '#0f172a';

  const voiceControls = document.createElement('div');
  voiceControls.style.display = 'grid';
  voiceControls.style.gridTemplateColumns = '1fr 1fr 1fr';
  voiceControls.style.gap = '6px';
  voiceControls.style.marginTop = '6px';

  const voiceJoinButton = document.createElement('button');
  voiceJoinButton.type = 'button';
  voiceJoinButton.textContent = 'Join';
  voiceJoinButton.style.padding = '7px 8px';
  voiceJoinButton.style.border = '1px solid #94a3b8';
  voiceJoinButton.style.borderRadius = '8px';
  voiceJoinButton.style.background = '#ffffff';
  voiceJoinButton.style.cursor = 'pointer';

  const voiceMuteButton = document.createElement('button');
  voiceMuteButton.type = 'button';
  voiceMuteButton.textContent = 'Mute';
  voiceMuteButton.style.padding = '7px 8px';
  voiceMuteButton.style.border = '1px solid #94a3b8';
  voiceMuteButton.style.borderRadius = '8px';
  voiceMuteButton.style.background = '#ffffff';
  voiceMuteButton.style.cursor = 'pointer';
  voiceMuteButton.disabled = true;

  const voiceLeaveButton = document.createElement('button');
  voiceLeaveButton.type = 'button';
  voiceLeaveButton.textContent = 'Leave';
  voiceLeaveButton.style.padding = '7px 8px';
  voiceLeaveButton.style.border = '1px solid #94a3b8';
  voiceLeaveButton.style.borderRadius = '8px';
  voiceLeaveButton.style.background = '#ffffff';
  voiceLeaveButton.style.cursor = 'pointer';
  voiceLeaveButton.disabled = true;

  const voiceStatus = document.createElement('div');
  voiceStatus.textContent = 'Voice disconnected';
  voiceStatus.style.marginTop = '6px';
  voiceStatus.style.fontSize = '11px';
  voiceStatus.style.color = '#475569';

  voiceControls.appendChild(voiceJoinButton);
  voiceControls.appendChild(voiceMuteButton);
  voiceControls.appendChild(voiceLeaveButton);

  const updateSyncBadge = (state: SyncConnectionState) => {
    syncBadge.textContent = syncStateLabel(state);
    syncBadge.style.background = syncStateColor(state);
    syncBadge.style.color = '#ffffff';
  };
  updateSyncBadge(sync);

  overlay.appendChild(dragHeader);
  overlay.appendChild(metaCard);
  overlay.appendChild(syncBadge);
  overlay.appendChild(input);
  overlay.appendChild(sendButton);
  overlay.appendChild(cancelButton);
  overlay.appendChild(statusLine);
  overlay.appendChild(chatOutput);
  overlay.appendChild(errorLine);
  overlay.appendChild(helper);
  overlay.appendChild(voiceTitle);
  overlay.appendChild(voiceControls);
  overlay.appendChild(voiceStatus);
  root.appendChild(overlay);

  let dragPointerId: number | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const getClampedOverlayPosition = (left: number, top: number) => {
    const maxLeft = Math.max(OVERLAY_MARGIN_PX, root.clientWidth - overlay.offsetWidth - OVERLAY_MARGIN_PX);
    const maxTop = Math.max(OVERLAY_MARGIN_PX, root.clientHeight - overlay.offsetHeight - OVERLAY_MARGIN_PX);
    return {
      left: clamp(left, OVERLAY_MARGIN_PX, maxLeft),
      top: clamp(top, OVERLAY_MARGIN_PX, maxTop),
    };
  };

  const moveOverlay = (left: number, top: number) => {
    const next = getClampedOverlayPosition(left, top);
    overlay.style.right = 'auto';
    overlay.style.left = `${next.left}px`;
    overlay.style.top = `${next.top}px`;
  };

  const ensureOverlayUsesLeftTop = () => {
    if (overlay.style.right === 'auto') {
      return;
    }
    const overlayRect = overlay.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    moveOverlay(overlayRect.left - rootRect.left, overlayRect.top - rootRect.top);
  };

  const onOverlayDragStart = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    ensureOverlayUsesLeftTop();
    const overlayRect = overlay.getBoundingClientRect();
    dragOffsetX = event.clientX - overlayRect.left;
    dragOffsetY = event.clientY - overlayRect.top;
    dragPointerId = event.pointerId;
    dragHeader.style.cursor = 'grabbing';
    dragHeader.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onOverlayDragMove = (event: PointerEvent) => {
    if (dragPointerId === null || event.pointerId !== dragPointerId) {
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const left = event.clientX - rootRect.left - dragOffsetX;
    const top = event.clientY - rootRect.top - dragOffsetY;
    moveOverlay(left, top);
  };

  const onOverlayDragEnd = (event: PointerEvent) => {
    if (dragPointerId === null || event.pointerId !== dragPointerId) {
      return;
    }
    dragHeader.releasePointerCapture(event.pointerId);
    dragPointerId = null;
    dragHeader.style.cursor = 'grab';
  };

  const onWindowResize = () => {
    ensureOverlayUsesLeftTop();
    const left = Number.parseFloat(overlay.style.left);
    const top = Number.parseFloat(overlay.style.top);
    moveOverlay(Number.isFinite(left) ? left : OVERLAY_MARGIN_PX, Number.isFinite(top) ? top : OVERLAY_MARGIN_PX);
  };

  dragHeader.addEventListener('pointerdown', onOverlayDragStart);
  dragHeader.addEventListener('pointermove', onOverlayDragMove);
  dragHeader.addEventListener('pointerup', onOverlayDragEnd);
  dragHeader.addEventListener('pointercancel', onOverlayDragEnd);
  onWindowResize();
  window.addEventListener('resize', onWindowResize);

  let editor: Editor | null = null;
  let applyingRemoteAction = false;
  let lastTriggerSignature = '';
  let lastTriggerAt = 0;
  let isAgentRequestInFlight = false;
  let inFlightController: AbortController | null = null;
  let activeAgentChatMessageId: string | null = null;
  let voiceCall: DailyCallObjectLike | null = null;
  let voiceConnected = false;
  let voiceMuted = false;
  const appliedRemoteActionIds = new Set<string>();
  const chatMessages: ChatMessageEnvelope[] = [];
  let isDisposed = false;
  const mediaPollTimers = new Map<string, number>();
  const mediaPollAttempts = new Map<string, number>();
  const mediaShapeByRequestId = new Map<string, string>();

  const formatChatTimestamp = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '--:--';
    }
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const renderChatMessages = () => {
    chatOutput.replaceChildren();

    if (chatMessages.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.textContent = 'Messages from this room will appear here.';
      emptyState.style.padding = '8px';
      emptyState.style.fontSize = '11px';
      emptyState.style.color = '#64748b';
      emptyState.style.border = '1px dashed #cbd5e1';
      emptyState.style.borderRadius = '8px';
      emptyState.style.textAlign = 'center';
      chatOutput.appendChild(emptyState);
      return;
    }

    for (const message of chatMessages) {
      const isAgentMessage = message.displayName.toLowerCase() === 'agent' || message.mentionsAgent;

      const messageCard = document.createElement('div');
      messageCard.style.border = isAgentMessage ? '1px solid #bae6fd' : '1px solid #dbe3ed';
      messageCard.style.background = isAgentMessage ? '#f0f9ff' : '#ffffff';
      messageCard.style.borderRadius = '8px';
      messageCard.style.padding = '7px 8px';

      const messageMeta = document.createElement('div');
      messageMeta.textContent = `${message.displayName}${message.mentionsAgent ? ' • @agent' : ''} • ${formatChatTimestamp(message.createdAt)}`;
      messageMeta.style.fontSize = '10px';
      messageMeta.style.fontWeight = '700';
      messageMeta.style.color = '#1e293b';
      messageMeta.style.marginBottom = '3px';

      const messageBody = document.createElement('div');
      messageBody.textContent = message.text.length > 0 ? message.text : '...';
      messageBody.style.fontSize = '12px';
      messageBody.style.lineHeight = '1.35';
      messageBody.style.color = '#0f172a';
      messageBody.style.whiteSpace = 'pre-wrap';

      messageCard.appendChild(messageMeta);
      messageCard.appendChild(messageBody);
      chatOutput.appendChild(messageCard);
    }

    chatOutput.scrollTop = chatOutput.scrollHeight;
  };
  renderChatMessages();

  const pushChatMessage = (message: ChatMessageEnvelope) => {
    const existingIndex = chatMessages.findIndex((entry) => entry.id === message.id);
    if (existingIndex >= 0) {
      chatMessages[existingIndex] = message;
    } else {
      chatMessages.push(message);
      if (chatMessages.length > 140) {
        chatMessages.splice(0, chatMessages.length - 140);
      }
    }
    renderChatMessages();
  };

  const updateParticipantsMeta = (participants: RoomParticipant[]) => {
    const names = participants.map((participant) => participant.displayName).slice(0, 6);
    const extraCount = participants.length > names.length ? ` +${participants.length - names.length}` : '';
    participantsMeta.textContent = `participants (${participants.length}): ${names.join(', ')}${extraCount}`;
  };
  updateParticipantsMeta([
    {
      roomId,
      sessionId,
      displayName,
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
  ]);

  const updateVoiceButtons = () => {
    voiceJoinButton.disabled = voiceConnected;
    voiceMuteButton.disabled = !voiceConnected;
    voiceLeaveButton.disabled = !voiceConnected;
    voiceMuteButton.textContent = voiceMuted ? 'Unmute' : 'Mute';
    voiceStatus.textContent = voiceConnected
      ? `Voice connected (${voiceMuted ? 'muted' : 'live'})`
      : 'Voice disconnected';
  };
  updateVoiceButtons();

  const dispatchAgentTrigger = (rawText: string, source: AgentTriggerDetail['source']) => {
    const match = detectAgentTrigger(rawText);
    if (!match.hasTrigger) {
      return false;
    }

    window.dispatchEvent(
      createAgentTriggerEvent({
        roomId,
        sessionId,
        source,
        displayName,
        rawPrompt: rawText,
        mentionDetected: true,
        prompt: match.cleanedText,
      }),
    );
    return true;
  };

  const triggerFromPanel = () => {
    const message = input.value.trim();
    if (message.length === 0) {
      return;
    }

    const triggerMatch = detectAgentTrigger(message);
    const sent = sync.sendChatMessage(message, triggerMatch.hasTrigger);
    if (!sent) {
      errorLine.textContent = 'Unable to send message while sync is disconnected.';
      return;
    }

    errorLine.textContent = '';
    input.value = '';
    if (triggerMatch.hasTrigger) {
      dispatchAgentTrigger(message, 'chat');
    }
  };

  const onInputKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      triggerFromPanel();
    }
  };

  sendButton.addEventListener('click', triggerFromPanel);
  input.addEventListener('keydown', onInputKeydown);

  const setAgentUiState = (busy: boolean, status: string, error = '') => {
    isAgentRequestInFlight = busy;
    statusLine.textContent = status;
    errorLine.textContent = error;
    sendButton.disabled = busy;
    sendButton.style.opacity = busy ? '0.75' : '1';
    sendButton.style.cursor = busy ? 'default' : 'pointer';
    cancelButton.style.display = busy ? 'block' : 'none';
  };

  const resetAgentChatText = (turnId: string) => {
    activeAgentChatMessageId = `agent-${turnId}`;
    pushChatMessage({
      id: activeAgentChatMessageId,
      roomId,
      sessionId,
      displayName: 'Agent',
      text: '',
      mentionsAgent: true,
      createdAt: new Date().toISOString(),
    });
  };

  const appendAgentChatText = (delta: string) => {
    if (delta.length === 0) {
      return;
    }

    const messageId = activeAgentChatMessageId ?? `agent-${createId('stream')}`;
    activeAgentChatMessageId = messageId;
    const existing = chatMessages.find((entry) => entry.id === messageId);
    pushChatMessage({
      id: messageId,
      roomId,
      sessionId,
      displayName: 'Agent',
      text: `${existing?.text ?? ''}${delta}`,
      mentionsAgent: true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  };

  const clearMediaPoll = (requestId: string, clearShapeMapping = false) => {
    const timerId = mediaPollTimers.get(requestId);
    if (typeof timerId === 'number') {
      window.clearTimeout(timerId);
    }
    mediaPollTimers.delete(requestId);
    mediaPollAttempts.delete(requestId);
    if (clearShapeMapping) {
      mediaShapeByRequestId.delete(requestId);
    }
  };

  const clearAllMediaPolls = () => {
    for (const timerId of mediaPollTimers.values()) {
      window.clearTimeout(timerId);
    }
    mediaPollTimers.clear();
    mediaPollAttempts.clear();
    mediaShapeByRequestId.clear();
  };

  const queueNextMediaPoll = (requestId: string, delayMs = MEDIA_POLL_INTERVAL_MS) => {
    if (isDisposed) {
      return;
    }
    const previousTimer = mediaPollTimers.get(requestId);
    if (typeof previousTimer === 'number') {
      window.clearTimeout(previousTimer);
    }
    const timer = window.setTimeout(() => {
      void pollMediaRequest(requestId);
    }, delayMs);
    mediaPollTimers.set(requestId, timer);
  };

  const updateShapeMediaMeta = (
    activeEditor: Editor,
    shapeId: string,
    patch: Record<string, unknown>,
  ) => {
    const maybeStore = activeEditor.store as unknown as {
      get?: (id: string) => unknown;
    };
    const existing = maybeStore.get?.(shapeId);
    if (!isShapeRecord(existing)) {
      return;
    }

    const typed = existing as TLShape & { meta?: Record<string, unknown> };
    const existingAgentMedia =
      typeof typed.meta?.agentMedia === 'object' && typed.meta.agentMedia !== null
        ? (typed.meta.agentMedia as Record<string, unknown>)
        : {};

    activeEditor.store.put([
      {
        ...typed,
        meta: {
          ...(typed.meta ?? {}),
          agentMedia: {
            ...existingAgentMedia,
            ...patch,
          },
        },
      },
    ]);
  };

  const applyMediaStatusToShape = (statusPayload: MediaStatusResponse) => {
    const activeEditor = editor;
    if (!activeEditor) {
      return;
    }

    const shapeId = mediaShapeByRequestId.get(statusPayload.requestId);
    if (!shapeId) {
      return;
    }

    const existing = getEditorShape(activeEditor, shapeId);
    if (!existing) {
      clearMediaPoll(statusPayload.requestId, true);
      return;
    }

    const typed = existing as TLShape & { meta?: Record<string, unknown> };
    const agentMediaMeta =
      typeof typed.meta?.agentMedia === 'object' && typed.meta.agentMedia !== null
        ? (typed.meta.agentMedia as Record<string, unknown>)
        : {};
    const mediaType = agentMediaMeta.mediaType === 'video' ? 'video' : 'image';

    if (statusPayload.status === 'completed' && mediaType === 'image' && statusPayload.imageUrl) {
      const replaced = tryReplaceNoteWithImageShape(activeEditor, shapeId, statusPayload.requestId, statusPayload.imageUrl);
      if (replaced) {
        clearMediaPoll(statusPayload.requestId, true);
        return;
      }
    }

    const mediaUrl = mediaType === 'video' ? statusPayload.videoUrl : statusPayload.imageUrl;
    const statusText =
      statusPayload.status === 'completed'
        ? 'completed'
        : statusPayload.status === 'failed'
          ? 'failed'
          : statusPayload.status === 'nsfw'
            ? 'blocked (nsfw)'
            : 'in progress';
    const cardTitle = mediaType === 'video' ? 'Video job' : 'Image job';
    const message = `${cardTitle} ${statusText}\n${mediaUrl ? `URL: ${mediaUrl}` : ''}${statusPayload.error ? `\nError: ${statusPayload.error}` : ''}`.trim();

    updateEditorShapes(activeEditor, [
      {
        id: existing.id,
        type: existing.type,
        props:
          existing.type === 'arrow'
            ? { text: message }
            : {
                richText: toRichText(message),
              },
      },
    ]);

    updateShapeMediaMeta(activeEditor, shapeId, {
      status: statusPayload.status,
      imageUrl: statusPayload.imageUrl,
      videoUrl: statusPayload.videoUrl,
      errorMessage: statusPayload.error,
      completedAt: statusPayload.status === 'completed' ? new Date().toISOString() : undefined,
    });

    if (isTerminalMediaStatus(statusPayload.status)) {
      clearMediaPoll(statusPayload.requestId, true);
    }
  };

  const pollMediaRequest = async (requestId: string) => {
    if (isDisposed) {
      return;
    }

    mediaPollTimers.delete(requestId);
    if (!mediaShapeByRequestId.has(requestId)) {
      clearMediaPoll(requestId, true);
      return;
    }

    try {
      const response = await fetch(`${backendUrl}/media/requests/${encodeURIComponent(requestId)}/status`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });
      const body = (await response.json()) as Record<string, unknown>;

      const statusPayload: MediaStatusResponse = {
        requestId,
        status: normalizeMediaStatus(body.status),
        imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : undefined,
        videoUrl: typeof body.videoUrl === 'string' ? body.videoUrl : undefined,
        error: typeof body.error === 'string' ? body.error : undefined,
      };

      applyMediaStatusToShape(statusPayload);
      if (!isTerminalMediaStatus(statusPayload.status)) {
        queueNextMediaPoll(requestId);
      }
    } catch {
      const attempts = (mediaPollAttempts.get(requestId) ?? 0) + 1;
      mediaPollAttempts.set(requestId, attempts);
      if (attempts >= MEDIA_POLL_MAX_RETRIES) {
        applyMediaStatusToShape({
          requestId,
          status: 'failed',
          error: 'Polling timed out while waiting for media generation.',
        });
        clearMediaPoll(requestId, true);
        return;
      }
      queueNextMediaPoll(requestId);
    }
  };

  const registerMediaRequest = (mediaRequest: MediaRequestPayload | null) => {
    if (!mediaRequest) {
      return;
    }

    mediaShapeByRequestId.set(mediaRequest.requestId, mediaRequest.shapeId);
    const normalizedStatus = normalizeMediaStatus(mediaRequest.status);
    if (isTerminalMediaStatus(normalizedStatus)) {
      void pollMediaRequest(mediaRequest.requestId);
      return;
    }

    if (!mediaPollTimers.has(mediaRequest.requestId)) {
      queueNextMediaPoll(mediaRequest.requestId, 900);
    }
  };

  const registerMediaRequestsFromSnapshot = (activeEditor: Editor) => {
    const shapes = collectShapesFromSnapshot(getCurrentShapeSnapshot(activeEditor));
    for (const shape of shapes) {
      const typed = shape as TLShape & { meta?: Record<string, unknown> };
      const agentMedia =
        typeof typed.meta?.agentMedia === 'object' && typed.meta.agentMedia !== null
          ? (typed.meta.agentMedia as Record<string, unknown>)
          : null;
      if (!agentMedia) {
        continue;
      }

      const requestId = typeof agentMedia.requestId === 'string' ? agentMedia.requestId.trim() : '';
      if (!requestId) {
        continue;
      }

      registerMediaRequest({
        requestId,
        shapeId: shape.id,
        mediaType: agentMedia.mediaType === 'video' ? 'video' : 'image',
        status: typeof agentMedia.status === 'string' ? agentMedia.status : undefined,
      });
    }
  };

  setAgentUiState(false, 'Ready', '');

  const appRoot: Root = createRoot(mountNode);

  const onStoreChange = (entry: unknown) => {
    if (!editor || applyingRemoteAction) {
      return;
    }

    const parsed = entry as {
      changes?: {
        added?: Record<string, unknown>;
        updated?: Record<string, unknown>;
        removed?: Record<string, unknown>;
      };
    };

    const turnId = createId('turn');

    for (const addedRecord of Object.values(parsed.changes?.added ?? {})) {
      if (!isShapeRecord(addedRecord)) {
        continue;
      }
      const createAction = createShapeAction(roomId, turnId, 'local', 'shape.create', {
        shapeId: addedRecord.id,
        shape: addedRecord,
        sessionId,
      });
      sync.sendAction(createAction);

      if (isTextualShape(addedRecord)) {
        const rawText = (addedRecord.props as { text: string }).text;
        const match = detectAgentTrigger(rawText);
        if (match.hasTrigger) {
          window.dispatchEvent(
            createAgentTriggerEvent({
              roomId,
              sessionId,
              source: 'canvas',
              displayName,
              rawPrompt: rawText,
              mentionDetected: true,
              prompt: match.cleanedText,
            }),
          );
        }
      }
    }

    for (const updatedRecord of Object.values(parsed.changes?.updated ?? {})) {
      const nextShape = getUpdatedShapeRecord(updatedRecord);
      if (!nextShape) {
        continue;
      }
      const updateAction = createShapeAction(roomId, turnId, 'local', 'shape.update', {
        shapeId: nextShape.id,
        shape: nextShape,
        sessionId,
      });
      sync.sendAction(updateAction);

      if (isTextualShape(nextShape)) {
        const rawText = (nextShape.props as { text: string }).text;
        const match = detectAgentTrigger(rawText);
        if (match.hasTrigger) {
          window.dispatchEvent(
            createAgentTriggerEvent({
              roomId,
              sessionId,
              source: 'canvas',
              displayName,
              rawPrompt: rawText,
              mentionDetected: true,
              prompt: match.cleanedText,
            }),
          );
        }
      }
    }

    const removedShapeIds: string[] = [];
    for (const removedRecord of Object.values(parsed.changes?.removed ?? {})) {
      if (isShapeRecord(removedRecord)) {
        removedShapeIds.push(removedRecord.id);
      }
    }
    if (removedShapeIds.length > 0) {
      const deleteAction = createShapeAction(roomId, turnId, 'local', 'shape.delete', {
        shapeIds: removedShapeIds,
        sessionId,
      });
      sync.sendAction(deleteAction);
    }
  };

  const applyRemote = (action: CanvasActionEnvelope) => {
    const activeEditor = editor;
    if (!activeEditor) {
      return;
    }
    if (appliedRemoteActionIds.has(action.id)) {
      return;
    }

    appliedRemoteActionIds.add(action.id);
    if (appliedRemoteActionIds.size > maxAppliedRemoteActionIds) {
      const oldestActionId = appliedRemoteActionIds.values().next().value;
      if (typeof oldestActionId === 'string') {
        appliedRemoteActionIds.delete(oldestActionId);
      }
    }

    const plan = applyCanvasAction(action);
    if (action.source === 'agent' && plan.operations.length === 0) {
      setAgentUiState(false, 'Ready', 'Agent produced an unsupported or empty mutation.');
      return;
    }

    const createOperationCount = plan.operations.filter((operation) => operation.kind === 'create').length;
    if (action.source === 'agent' && createOperationCount > maxCreateOperationsPerAgentTurn) {
      setAgentUiState(
        false,
        'Ready',
        `Blocked oversized mutation batch (${createOperationCount} creates, limit ${maxCreateOperationsPerAgentTurn}).`,
      );
      return;
    }

    applyingRemoteAction = true;
    const mediaRequestsToRegister: MediaRequestPayload[] = [];
    try {
      activeEditor.run(() => {
        for (const operation of plan.operations) {
          if (operation.kind === 'create') {
            const shapeInput = operation.payload.shapeInput;
            if (shapeInput && typeof shapeInput === 'object') {
              activeEditor.createShapes([shapeInput as never]);

              const mediaRequest = parseMediaRequestPayload(operation.payload.mediaRequest);
              if (mediaRequest) {
                mediaRequestsToRegister.push(mediaRequest);
              }

              const center =
                typeof operation.payload.center === 'object' && operation.payload.center !== null
                  ? (operation.payload.center as Record<string, unknown>)
                  : null;
              const centerX =
                center && typeof center.x === 'number' && Number.isFinite(center.x) ? center.x : undefined;
              const centerY =
                center && typeof center.y === 'number' && Number.isFinite(center.y) ? center.y : undefined;

              if (centerX !== undefined && centerY !== undefined && operation.targetIds.length > 0) {
                const createRecord = shapeInput as Record<string, unknown>;
                const maybeProps =
                  typeof createRecord.props === 'object' && createRecord.props !== null
                    ? (createRecord.props as Record<string, unknown>)
                    : null;
                const richText = maybeProps?.richText;
                const estimated = estimateTextBounds(extractRichText(richText));

                const centerUpdates: Array<Record<string, unknown>> = [];
                for (const shapeId of operation.targetIds) {
                  const createdShape = getEditorShape(activeEditor, shapeId);
                  if (!createdShape) {
                    continue;
                  }

                  const measuredBounds = getEditorShapePageBounds(activeEditor, shapeId);
                  const width = measuredBounds?.w ?? estimated.w;
                  const height = measuredBounds?.h ?? estimated.h;

                  centerUpdates.push({
                    id: createdShape.id,
                    type: createdShape.type,
                    x: centerX - width / 2,
                    y: centerY - height / 2,
                  });
                }

                if (centerUpdates.length > 0) {
                  updateEditorShapes(activeEditor, centerUpdates);
                }
              }

              const bindings = operation.payload.bindings;
              if (Array.isArray(bindings) && bindings.length > 0) {
                const validBindings = bindings.filter((binding) => {
                  if (typeof binding !== 'object' || binding === null) return false;
                  const record = binding as Record<string, unknown>;
                  const fromId = typeof record.fromId === 'string' ? record.fromId : '';
                  const toId = typeof record.toId === 'string' ? record.toId : '';
                  const type = typeof record.type === 'string' ? record.type : '';
                  return (
                    type.length > 0 &&
                    fromId.length > 0 &&
                    toId.length > 0 &&
                    getEditorShape(activeEditor, fromId) !== undefined &&
                    getEditorShape(activeEditor, toId) !== undefined
                  );
                });
                if (validBindings.length > 0) {
                  createEditorBindings(activeEditor, validBindings);
                }
              }
              continue;
            }

            const shape = operation.payload.shape;
            if (isShapeRecord(shape)) {
              activeEditor.store.put([shape]);
            }
            continue;
          }
          if (operation.kind === 'update') {
            const shapeInput = operation.payload.shapeInput;
            if (shapeInput && typeof shapeInput === 'object') {
              activeEditor.createShapes([shapeInput as never]);
              continue;
            }

            const shapePatch =
              typeof operation.payload.shapePatch === 'object' && operation.payload.shapePatch !== null
                ? (operation.payload.shapePatch as Record<string, unknown>)
                : null;
            if (shapePatch && operation.targetIds.length > 0) {
              const updates: Array<Record<string, unknown>> = [];
              const textPatch = typeof shapePatch.text === 'string' ? shapePatch.text : undefined;
              const xPatch = typeof shapePatch.x === 'number' && Number.isFinite(shapePatch.x) ? shapePatch.x : undefined;
              const yPatch = typeof shapePatch.y === 'number' && Number.isFinite(shapePatch.y) ? shapePatch.y : undefined;

              for (const shapeId of operation.targetIds) {
                const existing = getEditorShape(activeEditor, shapeId);
                if (!existing) {
                  continue;
                }

                const patch: Record<string, unknown> = {
                  id: existing.id,
                  type: existing.type,
                };

                if (textPatch !== undefined) {
                  patch.props =
                    existing.type === 'arrow'
                      ? {
                          text: textPatch,
                        }
                      : {
                          richText: toRichText(textPatch),
                        };
                }

                if (xPatch !== undefined || yPatch !== undefined) {
                  const { w: width, h: height } = getShapeDimensionsForCentering(activeEditor, existing);
                  const currentCenterX = (typeof existing.x === 'number' ? existing.x : 0) + width / 2;
                  const currentCenterY = (typeof existing.y === 'number' ? existing.y : 0) + height / 2;
                  const nextCenterX = xPatch ?? currentCenterX;
                  const nextCenterY = yPatch ?? currentCenterY;
                  patch.x = nextCenterX - width / 2;
                  patch.y = nextCenterY - height / 2;
                }

                updates.push(patch);
              }

              if (updates.length > 0) {
                updateEditorShapes(activeEditor, updates);
              }
              continue;
            }

            const metaPatch = operation.payload.metaPatch;
            if (metaPatch && typeof metaPatch === 'object' && operation.targetIds.length > 0) {
              const maybeStore = activeEditor.store as unknown as {
                get?: (id: string) => unknown;
              };
              const nextShapes: TLShape[] = [];
              for (const shapeId of operation.targetIds) {
                const existing = maybeStore.get?.(shapeId);
                if (!isShapeRecord(existing)) {
                  continue;
                }
                const withMeta = {
                  ...existing,
                  meta: {
                    ...((existing as TLShape & { meta?: Record<string, unknown> }).meta ?? {}),
                    ...(metaPatch as Record<string, unknown>),
                  },
                } as TLShape;
                nextShapes.push(withMeta);
              }
              if (nextShapes.length > 0) {
                activeEditor.store.put(nextShapes);
              }
              continue;
            }

            const shape = operation.payload.shape;
            if (isShapeRecord(shape)) {
              activeEditor.store.put([shape]);
            }
            continue;
          }
          if (operation.kind === 'delete') {
            activeEditor.deleteShapes(operation.targetIds);
            continue;
          }

          if (operation.kind === 'batch') {
            const groupShapeIds = Array.isArray(operation.payload.groupShapeIds)
              ? (operation.payload.groupShapeIds as unknown[])
                  .filter((id): id is string => typeof id === 'string')
                  .map((id) => toShapeId(id, 'group-target'))
              : [];
            const validGroupShapeIds = [...new Set(groupShapeIds)].filter((id) => getEditorShape(activeEditor, id) !== undefined);

            if (validGroupShapeIds.length >= 2) {
              const groupId =
                typeof operation.payload.groupId === 'string' && operation.payload.groupId.trim().length > 0
                  ? toShapeId(operation.payload.groupId, 'agent-group')
                  : undefined;

              if (groupId) {
                groupEditorShapes(activeEditor, validGroupShapeIds, { groupId, select: false });
              } else {
                groupEditorShapes(activeEditor, validGroupShapeIds, { select: false });
              }

              const label =
                typeof operation.payload.label === 'string' && operation.payload.label.trim().length > 0
                  ? operation.payload.label.trim()
                  : '';
              if (label.length > 0) {
                const bounds = getEditorShapesPageBounds(activeEditor, validGroupShapeIds);
                if (bounds) {
                  activeEditor.createShapes([
                    {
                      id: toShapeId(undefined, 'group-label'),
                      type: 'text',
                      x: bounds.x + bounds.w / 2,
                      y: bounds.y - 36,
                      props: {
                        richText: toRichText(label),
                        color: 'grey',
                        size: 's',
                        font: 'draw',
                        autoSize: true,
                      },
                    } as never,
                  ]);
                }
              }
            }
          }
        }
      });

      for (const mediaRequest of mediaRequestsToRegister) {
        registerMediaRequest(mediaRequest);
      }
    } finally {
      applyingRemoteAction = false;
    }
  };

  const removeStateListener = sync.onStateChange((state: SyncConnectionState) => {
    updateSyncBadge(state);
    window.dispatchEvent(new CustomEvent('ai-canvas.sync-state', { detail: state }));
  });

  const removeActionListener = sync.onAction((action) => {
    applyRemote(action);
  });

  const removeChatListener = sync.onChat((chat) => {
    pushChatMessage(chat);
  });

  const removePresenceListener = sync.onPresence((participants) => {
    updateParticipantsMeta(participants);
  });

  const createDailyCallObject = async (): Promise<DailyCallObjectLike> => {
    const dailyModule = await import('@daily-co/daily-js');
    const candidate = dailyModule as {
      createCallObject?: () => DailyCallObjectLike;
      default?: { createCallObject?: () => DailyCallObjectLike };
    };
    const factory = candidate.createCallObject ?? candidate.default?.createCallObject;
    if (typeof factory !== 'function') {
      throw new Error('Daily SDK failed to initialize.');
    }
    return factory();
  };

  const joinVoiceRoom = async () => {
    if (voiceConnected) {
      return;
    }

    voiceStatus.textContent = 'Connecting voice...';
    try {
      const response = await fetch(`${backendUrl}/voice/room`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          roomId,
          sessionId,
          displayName,
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string; failure?: { message?: string } };
        throw new Error(body.failure?.message ?? body.error ?? `Voice setup failed (${response.status})`);
      }

      const payload = (await response.json()) as VoiceSessionResponse;
      if (payload.provider !== 'daily' || typeof payload.roomUrl !== 'string') {
        throw new Error('Voice provider returned invalid room data.');
      }

      voiceCall = voiceCall ?? (await createDailyCallObject());
      await voiceCall.join({
        url: payload.roomUrl,
        token: payload.token,
      });
      voiceCall.setLocalAudio(true);
      voiceConnected = true;
      voiceMuted = false;
      updateVoiceButtons();
    } catch (error) {
      voiceConnected = false;
      voiceMuted = false;
      updateVoiceButtons();
      voiceStatus.textContent = error instanceof Error ? error.message : 'Failed to connect voice.';
    }
  };

  const leaveVoiceRoom = async () => {
    if (!voiceCall || !voiceConnected) {
      return;
    }
    try {
      await voiceCall.leave();
    } finally {
      voiceConnected = false;
      voiceMuted = false;
      updateVoiceButtons();
    }
  };

  const toggleVoiceMute = () => {
    if (!voiceCall || !voiceConnected) {
      return;
    }
    voiceMuted = !voiceMuted;
    voiceCall.setLocalAudio(!voiceMuted);
    updateVoiceButtons();
  };

  const onVoiceJoinClick = () => {
    void joinVoiceRoom();
  };

  const onVoiceLeaveClick = () => {
    void leaveVoiceRoom();
  };

  voiceJoinButton.addEventListener('click', onVoiceJoinClick);
  voiceMuteButton.addEventListener('click', toggleVoiceMute);
  voiceLeaveButton.addEventListener('click', onVoiceLeaveClick);

  const onAgentTrigger = async (event: Event) => {
    if (!editor) {
      return;
    }

    const custom = event as CustomEvent<AgentTriggerDetail>;
    const detail = custom.detail;
    if (!detail || detail.roomId !== roomId || detail.sessionId !== sessionId) {
      return;
    }

    if (!detail.mentionDetected) {
      setAgentUiState(false, 'Ready', 'AI commands require @agent mention.');
      return;
    }

    const normalizedPrompt = detail.prompt.trim();
    if (normalizedPrompt.length === 0) {
      setAgentUiState(false, 'Ready', 'Provide text after @agent to run AI.');
      return;
    }

    if (isAgentRequestInFlight) {
      setAgentUiState(true, 'Agent is already running...', '');
      return;
    }

    const signature = `${detail.sessionId}:${detail.source}:${normalizedPrompt}`;
    const now = Date.now();
    if (signature === lastTriggerSignature && now - lastTriggerAt < 800) {
      return;
    }
    lastTriggerSignature = signature;
    lastTriggerAt = now;

    const activeEditor = editor;
    if (!activeEditor) {
      return;
    }

    const viewport = getViewport(activeEditor);
    const snapshot = collectShapesFromSnapshot(getCurrentShapeSnapshot(activeEditor));
    const shapeSnapshots = snapshot.map((shape) => toShapeSnapshot(activeEditor, shape));
    const context = buildAgentContext(
      {
        roomId,
        sessionId,
        viewport,
        maxShapes: 120,
      },
      shapeSnapshots,
    );

    const turnId = createId('turn');
    const requestPayload = {
      roomId,
      sessionId,
      turnId,
      prompt: normalizedPrompt,
      context,
      invocation: {
        source: detail.source,
        displayName: detail.displayName ?? displayName,
        rawPrompt: detail.rawPrompt,
        requireExplicitMention: true,
        mentionDetected: detail.mentionDetected,
      },
    };

    const controller = new AbortController();
    inFlightController = controller;
    resetAgentChatText(turnId);
    setAgentUiState(true, 'Agent running...', '');

    try {
      const response = await fetch(`${backendUrl}/agent/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        setAgentUiState(false, 'Idle', `Agent request failed (${response.status}).`);
        return;
      }

      const parsed = await parseSseResponse(response);
      for (const streamEvent of parsed.events) {
        if (streamEvent.type === 'agent.stream.delta') {
          appendAgentChatText(streamEvent.delta);
          continue;
        }
        if (streamEvent.type !== 'agent.stream.action') {
          continue;
        }
        applyRemote(streamEvent.action);
        sync.sendAction(streamEvent.action);
      }

      for (const action of parsed.result?.actions ?? []) {
        applyRemote(action);
        sync.sendAction(action);
      }

      if (parsed.result?.status === 'fallback') {
        const fallbackActions = parsed.result.actions ?? [];
        if (parsed.result.failure?.details) {
          // eslint-disable-next-line no-console
          console.warn('[agent] fallback diagnostics', parsed.result.failure.details);
        }
        setAgentUiState(
          false,
          `Fallback applied (${fallbackActions.length} action(s))`,
          parsed.result.error ?? parsed.result.failure?.message ?? '',
        );
        return;
      }
      if (parsed.result?.status === 'failed') {
        setAgentUiState(false, 'Idle', parsed.result.error ?? parsed.result.failure?.message ?? 'Agent failed to produce actions.');
        return;
      }

      setAgentUiState(false, 'Ready', '');
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        setAgentUiState(false, 'Ready', 'Agent request cancelled.');
        return;
      }
      setAgentUiState(false, 'Ready', 'Agent request failed due to a network error.');
    } finally {
      activeAgentChatMessageId = null;
      inFlightController = null;
      if (isAgentRequestInFlight) {
        setAgentUiState(false, 'Ready', errorLine.textContent ?? '');
      }
    }
  };

  const onCancelRequest = () => {
    inFlightController?.abort();
  };

  cancelButton.addEventListener('click', onCancelRequest);

  window.addEventListener(agentTriggerEventName, onAgentTrigger as EventListener);

  appRoot.render(
    <Tldraw
      persistenceKey={`room:${roomId}`}
      onMount={(mountedEditor: Editor) => {
        editor = mountedEditor;
        const snapshot = getCurrentShapeSnapshot(mountedEditor);
        void collectShapesFromSnapshot(snapshot);
        registerMediaRequestsFromSnapshot(mountedEditor);
        mountedEditor.store.listen(onStoreChange, {
          scope: 'document',
          source: 'user',
        });
      }}
    />,
  );

  sync.connect();

  return {
    root,
    dispose() {
      isDisposed = true;
      clearAllMediaPolls();
      dragHeader.removeEventListener('pointerdown', onOverlayDragStart);
      dragHeader.removeEventListener('pointermove', onOverlayDragMove);
      dragHeader.removeEventListener('pointerup', onOverlayDragEnd);
      dragHeader.removeEventListener('pointercancel', onOverlayDragEnd);
      window.removeEventListener('resize', onWindowResize);
      sendButton.removeEventListener('click', triggerFromPanel);
      cancelButton.removeEventListener('click', onCancelRequest);
      input.removeEventListener('keydown', onInputKeydown);
      voiceJoinButton.removeEventListener('click', onVoiceJoinClick);
      voiceMuteButton.removeEventListener('click', toggleVoiceMute);
      voiceLeaveButton.removeEventListener('click', onVoiceLeaveClick);
      window.removeEventListener(agentTriggerEventName, onAgentTrigger as EventListener);
      removeStateListener();
      removeActionListener();
      removeChatListener();
      removePresenceListener();
      void leaveVoiceRoom();
      voiceCall?.destroy?.();
      voiceCall = null;
      sync.disconnect(1000, 'App disposed');
      appRoot.unmount();
      overlay.remove();
      root.innerHTML = '';
    },
  };
}
