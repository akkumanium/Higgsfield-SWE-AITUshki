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
    requiredKeys: ['id', 'x', 'y', 'text'],
  },
  {
    name: 'place_geo',
    description: 'Create a geometric shape with text in the current room.',
    // Added w, h, and color to align with handlePlaceGeo
    requiredKeys: ['id', 'x', 'y', 'text', 'shape', 'w', 'h', 'color'], 
  },
  {
    name: 'place_text',
    description: 'Create a text label in the current room.',
    // Added color to align with handlePlaceText
    requiredKeys: ['id', 'x', 'y', 'text', 'color'], 
  },
  {
    name: 'draw_arrow',
    description: 'Connect two shapes with an arrow.',
    // Explicitly define the required arrow arguments from the patch
    requiredKeys: ['arrowId', 'fromShapeId', 'toShapeId'], 
  },
  {
    name: 'update_shape',
    description: 'Update shape text and/or position by id.',
    requiredKeys: ['id'],
  },
  {
    name: 'delete_shape',
    description: 'Delete a shape by id.',
    requiredKeys: ['id'],
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
  
  if (missingKeys.length > 0) {
    return {
      valid: false,
      missingKeys,
    };
  }

  // update_shape requires at least one property to actually update
  if (toolName === 'update_shape') {
    const hasUpdate = 'text' in arguments_ || 'x' in arguments_ || 'y' in arguments_;
    if (!hasUpdate) {
      return {
        valid: false,
        missingKeys: ['text|x|y'],
      };
    }
  }

  return {
    valid: true,
    missingKeys: [],
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