import type { ToolCallEnvelope, ToolName } from '../types/contracts.js';

export interface ToolSchema {
  name: ToolName;
  description: string;
  requiredKeys: string[];
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'place_sticky',
    description: 'Create a note-like shape in the current room.',
    requiredKeys: ['x', 'y', 'text'],
  },
  {
    name: 'draw_arrow',
    description: 'Connect two shapes with an arrow.',
    requiredKeys: ['fromShapeId', 'toShapeId'],
  },
  {
    name: 'cluster_shapes',
    description: 'Group shapes into a visual cluster.',
    requiredKeys: ['shapeIds', 'label'],
  },
  {
    name: 'summarize_region',
    description: 'Summarize the visible region into a compact note.',
    requiredKeys: ['region'],
  },
  {
    name: 'generate_image',
    description: 'Create a placeholder for an asynchronously generated image.',
    requiredKeys: ['prompt', 'x', 'y'],
  },
];

export function isKnownToolName(name: string): name is ToolName {
  return TOOL_SCHEMAS.some((schema) => schema.name === name);
}

export function validateToolArguments(toolName: ToolName, arguments_: Record<string, unknown>) {
  const schema = TOOL_SCHEMAS.find((tool) => tool.name === toolName);
  if (!schema) {
    return {
      valid: false,
      missingKeys: ['toolName'],
    };
  }

  const missingKeys = schema.requiredKeys.filter((key) => !(key in arguments_));
  return {
    valid: missingKeys.length === 0,
    missingKeys,
  };
}

export function createToolEnvelope(
  turnId: string,
  toolName: ToolName,
  arguments_: Record<string, unknown>,
): ToolCallEnvelope {
  return {
    id: `${turnId}:${toolName}:${Date.now()}`,
    turnId,
    toolName,
    arguments: arguments_,
  };
}
