import type { AgentTurnRequest, AgentTurnResponse, CanvasActionEnvelope, ToolName } from '../types/contracts.js';
import { executeToolCall } from './toolExecutor.js';
import { createToolEnvelope, isKnownToolName } from './tools.js';

function inferToolPlan(request: AgentTurnRequest): Array<{ toolName: ToolName; arguments: Record<string, unknown> }> {
  const prompt = request.prompt.toLowerCase();
  const viewport = request.context.viewport;

  if (prompt.includes('arrow')) {
    return [
      {
        toolName: 'draw_arrow',
        arguments: {
          fromShapeId: 'shape-a',
          toShapeId: 'shape-b',
        },
      },
    ];
  }

  if (prompt.includes('cluster')) {
    return [
      {
        toolName: 'cluster_shapes',
        arguments: {
          shapeIds: ['shape-a', 'shape-b'],
          label: 'Related ideas',
        },
      },
    ];
  }

  if (prompt.includes('image')) {
    return [
      {
        toolName: 'generate_image',
        arguments: {
          prompt: request.prompt,
          x: viewport.x + viewport.width / 2,
          y: viewport.y + viewport.height / 2,
        },
      },
    ];
  }

  if (prompt.includes('summarize') || prompt.includes('summary')) {
    return [
      {
        toolName: 'summarize_region',
        arguments: {
          region: viewport,
        },
      },
    ];
  }

  return [
    {
      toolName: 'place_sticky',
      arguments: {
        x: viewport.x + viewport.width / 2,
        y: viewport.y + viewport.height / 2,
        text: request.prompt,
      },
    },
  ];
}

export async function streamClaudeTurn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
  const toolPlan = inferToolPlan(request).filter((entry) => isKnownToolName(entry.toolName));
  const actions: CanvasActionEnvelope[] = toolPlan.map((entry) =>
    executeToolCall(request.roomId, createToolEnvelope(request.turnId, entry.toolName, entry.arguments)),
  );

  return {
    turnId: request.turnId,
    accepted: true,
    actions,
  };
}
