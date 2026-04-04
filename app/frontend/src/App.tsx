import type { AgentTurnRequest } from '@ai-canvas/shared';
import { buildAgentContext } from './features/agent/contextBuilder.js';
import { createSyncConnection } from './features/sync/syncClient.js';

export const defaultRoomId = 'demo-room';
export const defaultSessionId = 'demo-session';

export const appPreviewRequest: AgentTurnRequest = {
  roomId: defaultRoomId,
  sessionId: defaultSessionId,
  turnId: 'turn-1',
  prompt: 'Summarize the current canvas.',
  context: {
    roomId: defaultRoomId,
    sessionId: defaultSessionId,
    viewport: {
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    },
    maxShapes: 250,
  },
};

export const appPreviewConnection = createSyncConnection(defaultRoomId, defaultSessionId);
export const appPreviewContext = buildAgentContext(appPreviewRequest.context);

export function App() {
  return {
    roomId: defaultRoomId,
    sessionId: defaultSessionId,
    sync: appPreviewConnection,
    context: appPreviewContext,
    prompt: appPreviewRequest.prompt,
  };
}
