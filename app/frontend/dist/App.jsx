/// <reference path="./shims.d.ts" />
import { createRoot } from 'react-dom/client';
import { Tldraw, } from 'tldraw';
import { agentTriggerEventName, createAgentTriggerEvent, detectAgentTrigger, } from './features/agent/AgentTrigger.js';
import { buildAgentContext } from './features/agent/contextBuilder.js';
import { applyCanvasAction } from './features/canvas/mutationAdapter.js';
import { createSyncConnection } from './features/sync/syncClient.js';
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
function createId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
function toShapeId(value, fallbackPrefix) {
    if (typeof value === 'string' && value.trim().length > 0) {
        const raw = value.trim();
        if (raw.startsWith('shape:')) {
            return raw;
        }
        return `shape:${raw.replace(/[^a-zA-Z0-9:_-]/g, '-')}`;
    }
    return `shape:${fallbackPrefix}-${Math.random().toString(36).slice(2, 10)}`;
}
function parseRoomAndSessionFromUrl() {
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
    const sessionId = (sessionFromUrl && sessionFromUrl.trim().length > 0
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
function isShapeRecord(record) {
    return typeof record === 'object' && record !== null && record.typeName === 'shape';
}
function isTextualShape(shape) {
    const typedShape = shape;
    return (typedShape.type === 'text' || typedShape.type === 'note') && typeof typedShape.props?.text === 'string';
}
function toRichText(text) {
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
function extractRichText(richText) {
    if (typeof richText !== 'object' || richText === null) {
        return '';
    }
    const root = richText;
    const doc = root.doc ?? root;
    const walk = (node) => {
        if (typeof node !== 'object' || node === null)
            return '';
        const record = node;
        if (typeof record.text === 'string')
            return record.text;
        if (!Array.isArray(record.content))
            return '';
        return record.content.map(walk).join('');
    };
    return walk(doc).replace(/\s+/g, ' ').trim();
}
function estimateTextBounds(text) {
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
function getShapeDimensionsForCentering(editor, shape) {
    const bounds = getEditorShapePageBounds(editor, shape.id);
    if (bounds && bounds.w > 0 && bounds.h > 0) {
        return { w: bounds.w, h: bounds.h };
    }
    const typed = shape;
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
        const plainText = typeof typed.props?.text === 'string'
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
function createShapeAction(roomId, turnId, source, kind, payload) {
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
function getCurrentShapeSnapshot(editor) {
    return editor.store.getStoreSnapshot();
}
function collectShapesFromSnapshot(snapshot) {
    const records = Object.values(snapshot.store);
    return records.filter((record) => isShapeRecord(record));
}
function getUpdatedShapeRecord(changeValue) {
    if (!changeValue || typeof changeValue !== 'object') {
        return null;
    }
    const candidate = changeValue;
    if (isShapeRecord(candidate.to)) {
        return candidate.to;
    }
    if (isShapeRecord(candidate[1])) {
        return candidate[1];
    }
    return null;
}
function getViewport(editor) {
    const maybe = editor;
    const viewport = maybe.getViewportPageBounds?.();
    return {
        x: viewport?.x ?? 0,
        y: viewport?.y ?? 0,
        width: viewport?.width ?? viewport?.w ?? 1200,
        height: viewport?.height ?? viewport?.h ?? 800,
    };
}
function getEditorShape(editor, shapeId) {
    const maybe = editor;
    return maybe.getShape?.(shapeId);
}
function getEditorShapePageBounds(editor, shapeId) {
    const maybe = editor;
    return maybe.getShapePageBounds?.(shapeId);
}
function getEditorShapesPageBounds(editor, shapeIds) {
    const maybe = editor;
    const bounds = maybe.getShapesPageBounds?.(shapeIds);
    return bounds ?? undefined;
}
function createEditorAssets(editor, assets) {
    const maybe = editor;
    maybe.createAssets?.(assets);
}
function updateEditorShapes(editor, updates) {
    const maybe = editor;
    maybe.updateShapes?.(updates);
}
function createEditorBindings(editor, bindings) {
    const maybe = editor;
    maybe.createBindings?.(bindings);
}
function groupEditorShapes(editor, shapeIds, options) {
    const maybe = editor;
    maybe.groupShapes?.(shapeIds, options);
}
function normalizeMediaStatus(value) {
    if (typeof value !== 'string') {
        return 'failed';
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'queued' ||
        normalized === 'in_progress' ||
        normalized === 'completed' ||
        normalized === 'failed' ||
        normalized === 'nsfw') {
        return normalized;
    }
    return 'failed';
}
function isTerminalMediaStatus(status) {
    return status === 'completed' || status === 'failed' || status === 'nsfw';
}
function parseMediaRequestPayload(payload) {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const record = payload;
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
function tryReplaceNoteWithImageShape(editor, shapeId, requestId, imageUrl) {
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
            },
        ]);
        editor.deleteShapes([shapeId]);
        return true;
    }
    catch {
        return false;
    }
}
function toShapeSnapshot(editor, shape) {
    const typedShape = shape;
    const pageBounds = getEditorShapePageBounds(editor, shape.id);
    const width = pageBounds?.w ?? (typeof typedShape.props?.w === 'number' ? typedShape.props.w : 180);
    const height = pageBounds?.h ?? (typeof typedShape.props?.h === 'number' ? typedShape.props.h : 120);
    const textFromProps = typeof typedShape.props?.text === 'string'
        ? typedShape.props.text
        : typedShape.props?.richText !== undefined
            ? extractRichText(typedShape.props.richText)
            : undefined;
    const kind = typedShape.type === 'text'
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
        clusterId: typeof typedShape.meta?.clusterId === 'string'
            ? typedShape.meta.clusterId
            : undefined,
        memberShapeIds: Array.isArray(typedShape.meta?.memberShapeIds)
            ? typedShape.meta.memberShapeIds
            : undefined,
    };
}
function syncStateLabel(state) {
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
function syncStateColor(state) {
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
async function parseSseResponse(response) {
    const reader = response.body?.getReader();
    if (!reader) {
        return {
            events: [],
            result: null,
        };
    }
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    let result = null;
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
                const payload = JSON.parse(dataLine.replace('data: ', ''));
                if (eventName === 'agent.turn.result') {
                    result = payload;
                    continue;
                }
                events.push(payload);
            }
            catch {
                continue;
            }
        }
    }
    return {
        events,
        result,
    };
}
export function App(root, options = {}) {
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
    const chatOutput = document.createElement('div');
    chatOutput.style.marginTop = '8px';
    chatOutput.style.maxHeight = '120px';
    chatOutput.style.overflowY = 'auto';
    chatOutput.style.padding = '8px';
    chatOutput.style.border = '1px solid #cbd5e1';
    chatOutput.style.borderRadius = '8px';
    chatOutput.style.background = '#f8fafc';
    chatOutput.style.fontSize = '12px';
    chatOutput.style.color = '#0f172a';
    chatOutput.style.whiteSpace = 'pre-wrap';
    chatOutput.style.wordBreak = 'break-word';
    const errorLine = document.createElement('div');
    errorLine.style.marginTop = '6px';
    errorLine.style.fontSize = '12px';
    errorLine.style.color = '#b91c1c';
    const helper = document.createElement('div');
    helper.textContent = 'Tip: include @agent in a text shape or use this panel.';
    helper.style.marginTop = '8px';
    helper.style.fontSize = '11px';
    helper.style.color = '#64748b';
    const updateSyncBadge = (state) => {
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
        window.dispatchEvent(createAgentTriggerEvent({
            roomId,
            sessionId,
            prompt,
        }));
        input.value = '';
    };
    const onInputKeydown = (event) => {
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
    overlay.appendChild(chatOutput);
    overlay.appendChild(errorLine);
    overlay.appendChild(helper);
    root.appendChild(overlay);
    let editor = null;
    let applyingRemoteAction = false;
    let lastTriggerSignature = '';
    let lastTriggerAt = 0;
    let isAgentRequestInFlight = false;
    let inFlightController = null;
    const appliedRemoteActionIds = new Set();
    let isDisposed = false;
    const mediaPollTimers = new Map();
    const mediaPollAttempts = new Map();
    const mediaShapeByRequestId = new Map();
    const setAgentUiState = (busy, status, error = '') => {
        isAgentRequestInFlight = busy;
        statusLine.textContent = status;
        errorLine.textContent = error;
        triggerButton.disabled = busy;
        triggerButton.style.opacity = busy ? '0.65' : '1';
        triggerButton.style.cursor = busy ? 'default' : 'pointer';
        cancelButton.style.display = busy ? 'block' : 'none';
    };
    const resetAgentChatText = () => {
        chatOutput.textContent = '';
    };
    const appendAgentChatText = (delta) => {
        if (delta.length === 0) {
            return;
        }
        chatOutput.textContent = `${chatOutput.textContent ?? ''}${delta}`;
        chatOutput.scrollTop = chatOutput.scrollHeight;
    };
    const clearMediaPoll = (requestId, clearShapeMapping = false) => {
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
    const queueNextMediaPoll = (requestId, delayMs = MEDIA_POLL_INTERVAL_MS) => {
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
    const updateShapeMediaMeta = (activeEditor, shapeId, patch) => {
        const maybeStore = activeEditor.store;
        const existing = maybeStore.get?.(shapeId);
        if (!isShapeRecord(existing)) {
            return;
        }
        const typed = existing;
        const existingAgentMedia = typeof typed.meta?.agentMedia === 'object' && typed.meta.agentMedia !== null
            ? typed.meta.agentMedia
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
    const applyMediaStatusToShape = (statusPayload) => {
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
        const typed = existing;
        const agentMediaMeta = typeof typed.meta?.agentMedia === 'object' && typed.meta.agentMedia !== null
            ? typed.meta.agentMedia
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
        const statusText = statusPayload.status === 'completed'
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
                props: existing.type === 'arrow'
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
    const pollMediaRequest = async (requestId) => {
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
            const body = (await response.json());
            const statusPayload = {
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
        }
        catch {
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
    const registerMediaRequest = (mediaRequest) => {
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
    const registerMediaRequestsFromSnapshot = (activeEditor) => {
        const shapes = collectShapesFromSnapshot(getCurrentShapeSnapshot(activeEditor));
        for (const shape of shapes) {
            const typed = shape;
            const agentMedia = typeof typed.meta?.agentMedia === 'object' && typed.meta.agentMedia !== null
                ? typed.meta.agentMedia
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
    const appRoot = createRoot(mountNode);
    const onStoreChange = (entry) => {
        if (!editor || applyingRemoteAction) {
            return;
        }
        const parsed = entry;
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
                const match = detectAgentTrigger(addedRecord.props.text);
                if (match.hasTrigger) {
                    window.dispatchEvent(createAgentTriggerEvent({
                        roomId,
                        sessionId,
                        prompt: match.cleanedText,
                    }));
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
                const match = detectAgentTrigger(nextShape.props.text);
                if (match.hasTrigger) {
                    window.dispatchEvent(createAgentTriggerEvent({
                        roomId,
                        sessionId,
                        prompt: match.cleanedText,
                    }));
                }
            }
        }
        const removedShapeIds = [];
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
    const applyRemote = (action) => {
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
            setAgentUiState(false, 'Ready', `Blocked oversized mutation batch (${createOperationCount} creates, limit ${maxCreateOperationsPerAgentTurn}).`);
            return;
        }
        applyingRemoteAction = true;
        const mediaRequestsToRegister = [];
        try {
            activeEditor.run(() => {
                for (const operation of plan.operations) {
                    if (operation.kind === 'create') {
                        const shapeInput = operation.payload.shapeInput;
                        if (shapeInput && typeof shapeInput === 'object') {
                            activeEditor.createShapes([shapeInput]);
                            const mediaRequest = parseMediaRequestPayload(operation.payload.mediaRequest);
                            if (mediaRequest) {
                                mediaRequestsToRegister.push(mediaRequest);
                            }
                            const center = typeof operation.payload.center === 'object' && operation.payload.center !== null
                                ? operation.payload.center
                                : null;
                            const centerX = center && typeof center.x === 'number' && Number.isFinite(center.x) ? center.x : undefined;
                            const centerY = center && typeof center.y === 'number' && Number.isFinite(center.y) ? center.y : undefined;
                            if (centerX !== undefined && centerY !== undefined && operation.targetIds.length > 0) {
                                const createRecord = shapeInput;
                                const maybeProps = typeof createRecord.props === 'object' && createRecord.props !== null
                                    ? createRecord.props
                                    : null;
                                const richText = maybeProps?.richText;
                                const estimated = estimateTextBounds(extractRichText(richText));
                                const centerUpdates = [];
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
                                    if (typeof binding !== 'object' || binding === null)
                                        return false;
                                    const record = binding;
                                    const fromId = typeof record.fromId === 'string' ? record.fromId : '';
                                    const toId = typeof record.toId === 'string' ? record.toId : '';
                                    const type = typeof record.type === 'string' ? record.type : '';
                                    return (type.length > 0 &&
                                        fromId.length > 0 &&
                                        toId.length > 0 &&
                                        getEditorShape(activeEditor, fromId) !== undefined &&
                                        getEditorShape(activeEditor, toId) !== undefined);
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
                            activeEditor.createShapes([shapeInput]);
                            continue;
                        }
                        const shapePatch = typeof operation.payload.shapePatch === 'object' && operation.payload.shapePatch !== null
                            ? operation.payload.shapePatch
                            : null;
                        if (shapePatch && operation.targetIds.length > 0) {
                            const updates = [];
                            const textPatch = typeof shapePatch.text === 'string' ? shapePatch.text : undefined;
                            const xPatch = typeof shapePatch.x === 'number' && Number.isFinite(shapePatch.x) ? shapePatch.x : undefined;
                            const yPatch = typeof shapePatch.y === 'number' && Number.isFinite(shapePatch.y) ? shapePatch.y : undefined;
                            for (const shapeId of operation.targetIds) {
                                const existing = getEditorShape(activeEditor, shapeId);
                                if (!existing) {
                                    continue;
                                }
                                const patch = {
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
                            const maybeStore = activeEditor.store;
                            const nextShapes = [];
                            for (const shapeId of operation.targetIds) {
                                const existing = maybeStore.get?.(shapeId);
                                if (!isShapeRecord(existing)) {
                                    continue;
                                }
                                const withMeta = {
                                    ...existing,
                                    meta: {
                                        ...(existing.meta ?? {}),
                                        ...metaPatch,
                                    },
                                };
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
                            ? operation.payload.groupShapeIds
                                .filter((id) => typeof id === 'string')
                                .map((id) => toShapeId(id, 'group-target'))
                            : [];
                        const validGroupShapeIds = [...new Set(groupShapeIds)].filter((id) => getEditorShape(activeEditor, id) !== undefined);
                        if (validGroupShapeIds.length >= 2) {
                            const groupId = typeof operation.payload.groupId === 'string' && operation.payload.groupId.trim().length > 0
                                ? toShapeId(operation.payload.groupId, 'agent-group')
                                : undefined;
                            if (groupId) {
                                groupEditorShapes(activeEditor, validGroupShapeIds, { groupId, select: false });
                            }
                            else {
                                groupEditorShapes(activeEditor, validGroupShapeIds, { select: false });
                            }
                            const label = typeof operation.payload.label === 'string' && operation.payload.label.trim().length > 0
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
                                        },
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
        }
        finally {
            applyingRemoteAction = false;
        }
    };
    const removeStateListener = sync.onStateChange((state) => {
        updateSyncBadge(state);
        window.dispatchEvent(new CustomEvent('ai-canvas.sync-state', { detail: state }));
    });
    const removeActionListener = sync.onAction((action) => {
        applyRemote(action);
    });
    const onAgentTrigger = async (event) => {
        if (!editor) {
            return;
        }
        const custom = event;
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
        const activeEditor = editor;
        if (!activeEditor) {
            return;
        }
        const viewport = getViewport(activeEditor);
        const snapshot = collectShapesFromSnapshot(getCurrentShapeSnapshot(activeEditor));
        const shapeSnapshots = snapshot.map((shape) => toShapeSnapshot(activeEditor, shape));
        const context = buildAgentContext({
            roomId,
            sessionId,
            viewport,
            maxShapes: 120,
        }, shapeSnapshots);
        const requestPayload = {
            roomId,
            sessionId,
            turnId: createId('turn'),
            prompt: normalizedPrompt,
            context,
        };
        const controller = new AbortController();
        inFlightController = controller;
        resetAgentChatText();
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
                setAgentUiState(false, `Fallback applied (${fallbackActions.length} action(s))`, parsed.result.error ?? parsed.result.failure?.message ?? '');
                return;
            }
            if (parsed.result?.status === 'failed') {
                setAgentUiState(false, 'Idle', parsed.result.error ?? parsed.result.failure?.message ?? 'Agent failed to produce actions.');
                return;
            }
            setAgentUiState(false, 'Ready', '');
        }
        catch (error) {
            if (error.name === 'AbortError') {
                setAgentUiState(false, 'Ready', 'Agent request cancelled.');
                return;
            }
            setAgentUiState(false, 'Ready', 'Agent request failed due to a network error.');
        }
        finally {
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
    window.addEventListener(agentTriggerEventName, onAgentTrigger);
    appRoot.render(<Tldraw persistenceKey={`room:${roomId}`} onMount={(mountedEditor) => {
            editor = mountedEditor;
            const snapshot = getCurrentShapeSnapshot(mountedEditor);
            void collectShapesFromSnapshot(snapshot);
            registerMediaRequestsFromSnapshot(mountedEditor);
            mountedEditor.store.listen(onStoreChange, {
                scope: 'document',
                source: 'user',
            });
        }}/>);
    sync.connect();
    return {
        root,
        dispose() {
            isDisposed = true;
            clearAllMediaPolls();
            triggerButton.removeEventListener('click', triggerFromPanel);
            cancelButton.removeEventListener('click', onCancelRequest);
            input.removeEventListener('keydown', onInputKeydown);
            window.removeEventListener(agentTriggerEventName, onAgentTrigger);
            removeStateListener();
            removeActionListener();
            sync.disconnect(1000, 'App disposed');
            appRoot.unmount();
            overlay.remove();
            root.innerHTML = '';
        },
    };
}
//# sourceMappingURL=App.jsx.map