import type { CanvasActionEnvelope } from '@ai-canvas/shared';

export interface CanvasMutationOperation {
  kind: 'create' | 'update' | 'delete' | 'batch';
  targetIds: string[];
  payload: Record<string, unknown>;
}

export interface CanvasMutationPlan {
  actionId: string;
  roomId: string;
  turnId: string;
  source: CanvasActionEnvelope['source'];
  suppressAgentRetrigger: boolean;
  operations: CanvasMutationOperation[];
}

function toOperations(action: CanvasActionEnvelope): CanvasMutationOperation[] {
  if (action.kind === 'shape.batch') {
    const operations = action.payload.operations;
    if (Array.isArray(operations)) {
      return operations.map((operation) => ({
        kind: (operation as { kind?: CanvasMutationOperation['kind'] }).kind ?? 'batch',
        targetIds: Array.isArray((operation as { targetIds?: unknown }).targetIds)
          ? ((operation as { targetIds: string[] }).targetIds)
          : [],
        payload: typeof operation === 'object' && operation !== null ? (operation as Record<string, unknown>) : {},
      }));
    }
  }

  return [
    {
      kind:
        action.kind === 'shape.create'
          ? 'create'
          : action.kind === 'shape.update'
            ? 'update'
            : action.kind === 'shape.delete'
              ? 'delete'
              : 'batch',
      targetIds: Array.isArray(action.payload.shapeIds)
        ? (action.payload.shapeIds as string[])
        : action.payload.shapeId
          ? [String(action.payload.shapeId)]
          : [],
      payload: action.payload,
    },
  ];
}

export function applyCanvasAction(action: CanvasActionEnvelope): CanvasMutationPlan {
  return {
    actionId: action.id,
    roomId: action.roomId,
    turnId: action.turnId,
    source: action.source,
    suppressAgentRetrigger: action.source !== 'local',
    operations: toOperations(action),
  };
}
