import type { ToolCallEnvelope, ToolName } from '../types/contracts.js';

export interface ToolSchema {
  name: ToolName;
  description: string;
  requiredKeys: string[];
}

const BASE_TOOL_SCHEMAS: ToolSchema[] = [
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

function getEnv(name: string): string | undefined {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return maybeProcess?.env?.[name];
}

export function isToolEnabled(toolName: ToolName): boolean {
  if (toolName !== 'generate_image') {
    return true;
  }

  const flag = getEnv('ENABLE_STRETCH_FEATURES');
  if (!flag) {
    return false;
  }

  const normalized = flag.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function getToolSchemas(): ToolSchema[] {
  return BASE_TOOL_SCHEMAS.filter((schema) => isToolEnabled(schema.name));
}

export function isKnownToolName(name: string): name is ToolName {
  return getToolSchemas().some((schema) => schema.name === name);
}

export function validateToolArguments(toolName: ToolName, arguments_: Record<string, unknown>) {
  const schema = getToolSchemas().find((tool) => tool.name === toolName);
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
    id: `${turnId}:${toolName}:${crypto.randomUUID()}`,
    turnId,
    toolName,
    arguments: arguments_,
  };
}
