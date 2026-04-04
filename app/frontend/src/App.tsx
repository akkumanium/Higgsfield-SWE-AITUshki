/// <reference path="./shims.d.ts" />

import type {
  AgentStreamEvent,
  AgentTurnResponse,
  CanvasActionEnvelope,
  CanvasShapeSnapshot,
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

export interface AppOptions {
  roomId?: string;
  sessionId?: string;
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

function parseRoomAndSessionFromUrl(): { roomId: string; sessionId: string } {
  if (typeof window === 'undefined') {
    return {
      roomId: defaultRoomId,
      sessionId: defaultSessionId,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  const sessionFromUrl = params.get('session');
  const sessionFromStorage = window.sessionStorage.getItem('ai-canvas-session-id');

  const roomId = roomFromUrl && roomFromUrl.trim().length > 0 ? roomFromUrl : defaultRoomId;
  const sessionId =
    (sessionFromUrl && sessionFromUrl.trim().length > 0
      ? sessionFromUrl
      : sessionFromStorage && sessionFromStorage.trim().length > 0
        ? sessionFromStorage
        : `${defaultSessionId}-${Math.random().toString(36).slice(2, 10)}`);

  params.set('room', roomId);
  params.set('session', sessionId);
  const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState({}, '', nextUrl);
  window.sessionStorage.setItem('ai-canvas-session-id', sessionId);

  return {
    roomId,
    sessionId,
  };
}

function isShapeRecord(record: unknown): record is TLShape {
  return typeof record === 'object' && record !== null && (record as { typeName?: unknown }).typeName === 'shape';
}

function isTextualShape(shape: TLShape): boolean {
  const typedShape = shape as TLShape & { type?: string; props?: { text?: unknown } };
  return (typedShape.type === 'text' || typedShape.type === 'note') && typeof typedShape.props?.text === 'string';
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

function toShapeSnapshot(shape: TLShape): CanvasShapeSnapshot {
  const typedShape = shape as TLShape & {
    type?: string;
    props?: Record<string, unknown> & { text?: unknown; w?: unknown; h?: unknown };
    x?: number;
    y?: number;
    meta?: { clusterId?: unknown; memberShapeIds?: unknown };
  };

  const width = typeof typedShape.props?.w === 'number' ? typedShape.props.w : 180;
  const height = typeof typedShape.props?.h === 'number' ? typedShape.props.h : 120;
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
      x: typeof typedShape.x === 'number' ? typedShape.x : 0,
      y: typeof typedShape.y === 'number' ? typedShape.y : 0,
      width,
      height,
    },
    updatedAt: new Date().toISOString(),
    text: typeof typedShape.props?.text === 'string' ? typedShape.props.text : undefined,
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
  const backendUrl = options.backendUrl ?? 'http://localhost:3001';
  const sync = createSyncConnection(roomId, sessionId, {
    url: options.syncUrl,
  });

  root.innerHTML = '';
  root.style.position = root.style.position || 'relative';

  const mountNode = document.createElement('div');
  mountNode.style.height = '100%';
  root.appendChild(mountNode);

  const overlay = document.createElement('aside');
  overlay.style.position = 'absolute';
  overlay.style.top = '12px';
  overlay.style.right = '12px';
  overlay.style.width = '320px';
  overlay.style.padding = '12px';
  overlay.style.borderRadius = '10px';
  overlay.style.background = 'rgba(255, 255, 255, 0.94)';
  overlay.style.boxShadow = '0 10px 28px rgba(15, 23, 42, 0.16)';
  overlay.style.fontFamily = 'Segoe UI, sans-serif';
  overlay.style.pointerEvents = 'auto';
  overlay.style.zIndex = '40';

  const title = document.createElement('div');
  title.textContent = 'AI Agent';
  title.style.fontSize = '14px';
  title.style.fontWeight = '700';
  title.style.marginBottom = '8px';

  const roomMeta = document.createElement('div');
  roomMeta.textContent = `room: ${roomId}`;
  roomMeta.style.fontSize = '12px';
  roomMeta.style.color = '#334155';

  const sessionMeta = document.createElement('div');
  sessionMeta.textContent = `session: ${sessionId}`;
  sessionMeta.style.fontSize = '12px';
  sessionMeta.style.color = '#334155';
  sessionMeta.style.marginBottom = '8px';

  const syncBadge = document.createElement('div');
  syncBadge.style.display = 'inline-block';
  syncBadge.style.padding = '4px 8px';
  syncBadge.style.borderRadius = '999px';
  syncBadge.style.fontSize = '12px';
  syncBadge.style.fontWeight = '600';
  syncBadge.style.marginBottom = '10px';

  const input = document.createElement('textarea');
  input.placeholder = 'Ask agent to place notes, draw arrows, cluster, or summarize';
  input.style.width = '100%';
  input.style.minHeight = '72px';
  input.style.resize = 'vertical';
  input.style.boxSizing = 'border-box';
  input.style.padding = '8px';
  input.style.border = '1px solid #cbd5e1';
  input.style.borderRadius = '8px';
  input.style.fontSize = '13px';
  input.style.marginBottom = '8px';

  const triggerButton = document.createElement('button');
  triggerButton.type = 'button';
  triggerButton.textContent = 'Run agent';
  triggerButton.style.width = '100%';
  triggerButton.style.padding = '9px 10px';
  triggerButton.style.border = 'none';
  triggerButton.style.borderRadius = '8px';
  triggerButton.style.background = '#0f766e';
  triggerButton.style.color = '#ffffff';
  triggerButton.style.fontWeight = '600';
  triggerButton.style.cursor = 'pointer';

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

  const errorLine = document.createElement('div');
  errorLine.style.marginTop = '6px';
  errorLine.style.fontSize = '12px';
  errorLine.style.color = '#b91c1c';

  const helper = document.createElement('div');
  helper.textContent = 'Tip: include @agent in a text shape or use this panel.';
  helper.style.marginTop = '8px';
  helper.style.fontSize = '11px';
  helper.style.color = '#64748b';

  const updateSyncBadge = (state: SyncConnectionState) => {
    syncBadge.textContent = syncStateLabel(state);
    syncBadge.style.background = syncStateColor(state);
    syncBadge.style.color = '#ffffff';
  };
  updateSyncBadge(sync);

  const triggerFromPanel = () => {
    const prompt = input.value.trim();
    if (prompt.length === 0) {
      return;
    }

    window.dispatchEvent(
      createAgentTriggerEvent({
        roomId,
        sessionId,
        prompt,
      }),
    );
    input.value = '';
  };

  const onInputKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      triggerFromPanel();
    }
  };

  triggerButton.addEventListener('click', triggerFromPanel);
  input.addEventListener('keydown', onInputKeydown);

  overlay.appendChild(title);
  overlay.appendChild(roomMeta);
  overlay.appendChild(sessionMeta);
  overlay.appendChild(syncBadge);
  overlay.appendChild(input);
  overlay.appendChild(triggerButton);
  overlay.appendChild(cancelButton);
  overlay.appendChild(statusLine);
  overlay.appendChild(errorLine);
  overlay.appendChild(helper);
  root.appendChild(overlay);

  let editor: Editor | null = null;
  let applyingRemoteAction = false;
  let lastTriggerSignature = '';
  let lastTriggerAt = 0;
  let isAgentRequestInFlight = false;
  let inFlightController: AbortController | null = null;
  const appliedRemoteActionIds = new Set<string>();

  const setAgentUiState = (busy: boolean, status: string, error = '') => {
    isAgentRequestInFlight = busy;
    statusLine.textContent = status;
    errorLine.textContent = error;
    triggerButton.disabled = busy;
    triggerButton.style.opacity = busy ? '0.65' : '1';
    triggerButton.style.cursor = busy ? 'default' : 'pointer';
    cancelButton.style.display = busy ? 'block' : 'none';
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
        const match = detectAgentTrigger((addedRecord.props as { text: string }).text);
        if (match.hasTrigger) {
          window.dispatchEvent(
            createAgentTriggerEvent({
              roomId,
              sessionId,
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
        const match = detectAgentTrigger((nextShape.props as { text: string }).text);
        if (match.hasTrigger) {
          window.dispatchEvent(
            createAgentTriggerEvent({
              roomId,
              sessionId,
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
    if (!editor) {
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
    try {
      editor.run(() => {
        for (const operation of plan.operations) {
          if (operation.kind === 'create') {
            const shapeInput = operation.payload.shapeInput;
            if (shapeInput && typeof shapeInput === 'object') {
              editor?.createShapes([shapeInput as never]);
              continue;
            }

            const shape = operation.payload.shape;
            if (isShapeRecord(shape)) {
              editor?.store.put([shape]);
            }
            continue;
          }
          if (operation.kind === 'update') {
            const shapeInput = operation.payload.shapeInput;
            if (shapeInput && typeof shapeInput === 'object') {
              editor?.createShapes([shapeInput as never]);
              continue;
            }

            const metaPatch = operation.payload.metaPatch;
            if (metaPatch && typeof metaPatch === 'object' && operation.targetIds.length > 0) {
              const maybeStore = editor?.store as unknown as {
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
                editor?.store.put(nextShapes);
              }
              continue;
            }

            const shape = operation.payload.shape;
            if (isShapeRecord(shape)) {
              editor?.store.put([shape]);
            }
            continue;
          }
          if (operation.kind === 'delete') {
            editor?.deleteShapes(operation.targetIds);
          }
        }
      });
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

  const onAgentTrigger = async (event: Event) => {
    if (!editor) {
      return;
    }

    const custom = event as CustomEvent<AgentTriggerDetail>;
    const detail = custom.detail;
    if (!detail || detail.roomId !== roomId || detail.sessionId !== sessionId) {
      return;
    }

    const normalizedPrompt = detail.prompt.trim();
    if (normalizedPrompt.length === 0) {
      return;
    }

    if (isAgentRequestInFlight) {
      setAgentUiState(true, 'Agent is already running...', '');
      return;
    }

    const signature = `${detail.sessionId}:${normalizedPrompt}`;
    const now = Date.now();
    if (signature === lastTriggerSignature && now - lastTriggerAt < 800) {
      return;
    }
    lastTriggerSignature = signature;
    lastTriggerAt = now;

    const viewport = getViewport(editor);
    const snapshot = collectShapesFromSnapshot(getCurrentShapeSnapshot(editor));
    const shapeSnapshots = snapshot.map((shape) => toShapeSnapshot(shape));
    const context = buildAgentContext(
      {
        roomId,
        sessionId,
        viewport,
        maxShapes: 120,
      },
      shapeSnapshots,
    );

    const requestPayload = {
      roomId,
      sessionId,
      turnId: createId('turn'),
      prompt: normalizedPrompt,
      context,
    };

    const controller = new AbortController();
    inFlightController = controller;
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
      triggerButton.removeEventListener('click', triggerFromPanel);
      cancelButton.removeEventListener('click', onCancelRequest);
      input.removeEventListener('keydown', onInputKeydown);
      window.removeEventListener(agentTriggerEventName, onAgentTrigger as EventListener);
      removeStateListener();
      removeActionListener();
      sync.disconnect(1000, 'App disposed');
      appRoot.unmount();
      overlay.remove();
      root.innerHTML = '';
    },
  };
}
