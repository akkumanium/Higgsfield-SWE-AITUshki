import { streamClaudeTurn } from './agent/claudeClient.js';
import type { AgentTurnRequest } from './types/contracts.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isAgentTurnRequest(value: unknown): value is AgentTurnRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.roomId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.prompt === 'string' &&
    isObject(value.context) &&
    typeof value.context.roomId === 'string' &&
    typeof value.context.sessionId === 'string' &&
    isObject(value.context.viewport) &&
    typeof value.context.viewport.x === 'number' &&
    typeof value.context.viewport.y === 'number' &&
    typeof value.context.viewport.width === 'number' &&
    typeof value.context.viewport.height === 'number' &&
    typeof value.context.maxShapes === 'number'
  );
}

export async function handleAgentTurn(request: AgentTurnRequest) {
  return streamClaudeTurn(request);
}

export const backendPort = 3001;

export function createBackendHealth() {
  return {
    status: 'ok' as const,
    backendPort,
  };
}
