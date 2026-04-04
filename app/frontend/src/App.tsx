import type { CanvasActionEnvelope } from '@ai-canvas/shared';
import { createSyncConnection } from './features/sync/syncClient.js';

export const defaultRoomId = 'demo-room';
export const defaultSessionId = 'demo-session';

interface LocalShape {
  id: string;
  x: number;
  y: number;
  text: string;
}

export interface AppOptions {
  roomId?: string;
  sessionId?: string;
  syncUrl?: string;
}

export interface MountedApp {
  root: HTMLElement;
  dispose: () => void;
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseShapeFromAction(action: CanvasActionEnvelope): LocalShape | null {
  if (action.kind !== 'shape.create') {
    return null;
  }
  const payload = action.payload as { shape?: unknown };
  const shape = payload.shape;
  if (!shape || typeof shape !== 'object') {
    return null;
  }

  const candidate = shape as { id?: unknown; x?: unknown; y?: unknown; text?: unknown };
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.x !== 'number' ||
    typeof candidate.y !== 'number' ||
    typeof candidate.text !== 'string'
  ) {
    return null;
  }

  return {
    id: candidate.id,
    x: candidate.x,
    y: candidate.y,
    text: candidate.text,
  };
}

function renderShapes(shapeLayer: HTMLElement, shapes: Map<string, LocalShape>) {
  shapeLayer.innerHTML = '';
  for (const shape of shapes.values()) {
    const sticky = document.createElement('div');
    sticky.className = 'sticky';
    sticky.style.left = `${shape.x}px`;
    sticky.style.top = `${shape.y}px`;
    sticky.textContent = shape.text;
    shapeLayer.appendChild(sticky);
  }
}

function createLocalCreateAction(roomId: string, sessionId: string, shape: LocalShape): CanvasActionEnvelope {
  return {
    id: createId('action'),
    roomId,
    turnId: createId('turn'),
    source: 'local',
    kind: 'shape.create',
    payload: {
      shapeId: shape.id,
      shape,
      sessionId,
    },
    createdAt: new Date().toISOString(),
  };
}

export function App(root: HTMLElement, options: AppOptions = {}): MountedApp {
  const roomId = options.roomId ?? defaultRoomId;
  const sessionId = options.sessionId ?? defaultSessionId;
  const sync = createSyncConnection(roomId, sessionId, {
    url: options.syncUrl,
  });

  const shapes = new Map<string, LocalShape>();

  root.innerHTML = '';

  const style = document.createElement('style');
  style.textContent = `
    .app-shell { font-family: 'Segoe UI', sans-serif; height: 100%; display: grid; grid-template-rows: auto 1fr; background: linear-gradient(145deg, #f9fbff, #eaf3ff); }
    .app-toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid #cedcf5; background: #ffffffd6; backdrop-filter: blur(4px); }
    .status-chip { border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; }
    .status-connected { background: #d7f5e7; color: #0f6e42; }
    .status-connecting { background: #fff4d5; color: #9b6600; }
    .status-offline { background: #ffe2e2; color: #9f1d1d; }
    .canvas-stage { position: relative; overflow: auto; padding: 20px; }
    .canvas-grid { position: relative; width: 2000px; height: 1200px; border-radius: 12px; background-image:
      linear-gradient(to right, #dbe6ff 1px, transparent 1px),
      linear-gradient(to bottom, #dbe6ff 1px, transparent 1px);
      background-size: 24px 24px;
      background-color: #f7fbff;
      border: 1px solid #d2def8;
    }
    .sticky { position: absolute; width: 180px; min-height: 90px; padding: 10px; border-radius: 10px; border: 1px solid #dcc55a; background: #fff3a4; box-shadow: 0 4px 10px #c7b25d40; white-space: pre-wrap; }
    .toolbar-label { color: #27436d; font-size: 13px; }
    .toolbar-button { border: 1px solid #2a5db0; background: #2f6fe0; color: #fff; border-radius: 8px; padding: 7px 12px; cursor: pointer; font-weight: 600; }
  `;

  const shell = document.createElement('div');
  shell.className = 'app-shell';

  const toolbar = document.createElement('div');
  toolbar.className = 'app-toolbar';

  const statusChip = document.createElement('span');
  statusChip.className = 'status-chip status-offline';
  statusChip.textContent = 'Offline';

  const roomLabel = document.createElement('span');
  roomLabel.className = 'toolbar-label';
  roomLabel.textContent = `Room: ${roomId}`;

  const addStickyButton = document.createElement('button');
  addStickyButton.className = 'toolbar-button';
  addStickyButton.textContent = 'Add sticky';

  const stage = document.createElement('div');
  stage.className = 'canvas-stage';

  const grid = document.createElement('div');
  grid.className = 'canvas-grid';

  toolbar.append(statusChip, roomLabel, addStickyButton);
  stage.appendChild(grid);
  shell.append(toolbar, stage);
  root.append(style, shell);

  const updateStatus = () => {
    const status = sync.status;
    statusChip.className = 'status-chip';
    if (status === 'connected') {
      statusChip.classList.add('status-connected');
      statusChip.textContent = 'Connected';
      return;
    }
    if (status === 'connecting') {
      statusChip.classList.add('status-connecting');
      statusChip.textContent = 'Connecting';
      return;
    }
    statusChip.classList.add('status-offline');
    statusChip.textContent = sync.error ? `Error: ${sync.error}` : 'Offline';
  };

  const removeStateListener = sync.onStateChange(() => {
    updateStatus();
  });

  const removeActionListener = sync.onAction((action) => {
    const shape = parseShapeFromAction(action);
    if (!shape) {
      return;
    }
    shapes.set(shape.id, shape);
    renderShapes(grid, shapes);
  });

  addStickyButton.addEventListener('click', () => {
    const shape: LocalShape = {
      id: createId('sticky'),
      x: Math.round(80 + Math.random() * 1200),
      y: Math.round(80 + Math.random() * 700),
      text: `Note ${shapes.size + 1}`,
    };

    const action = createLocalCreateAction(roomId, sessionId, shape);
    shapes.set(shape.id, shape);
    renderShapes(grid, shapes);
    sync.sendAction(action);
  });

  sync.connect();
  updateStatus();

  return {
    root,
    dispose() {
      removeStateListener();
      removeActionListener();
      sync.disconnect(1000, 'App disposed');
      root.innerHTML = '';
    },
  };
}
