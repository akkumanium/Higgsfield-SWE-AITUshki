import type { CanvasActionEnvelope, ToolCallEnvelope } from '../types/contracts.js';
import { submitHiggsfieldGeneration } from './higgsfieldClient.js';
import { validateToolArguments } from './tools.js';

function isMediaTool(toolName: ToolCallEnvelope['toolName']): toolName is 'generate_image' | 'generate_video' {
  return toolName === 'generate_image' || toolName === 'generate_video';
}

function toOptionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function createActionEnvelope(
  roomId: string,
  toolCall: ToolCallEnvelope,
  validation: ReturnType<typeof validateToolArguments>,
  arguments_: Record<string, unknown>,
): CanvasActionEnvelope {
  return {
    id: toolCall.id,
    roomId,
    turnId: toolCall.turnId,
    source: 'agent',
    kind: 'shape.batch',
    payload: {
      toolName: toolCall.toolName,
      arguments: arguments_,
      validation,
    },
    createdAt: new Date().toISOString(),
  };
}

export async function executeToolCall(
  roomId: string,
  toolCall: ToolCallEnvelope,
): Promise<CanvasActionEnvelope> {
  const validation = validateToolArguments(toolCall.toolName, toolCall.arguments);
  if (!validation.valid) {
    throw new Error(`Invalid arguments for ${toolCall.toolName}: ${validation.missingKeys.join(', ')}`);
  }

  if (!isMediaTool(toolCall.toolName)) {
    return createActionEnvelope(roomId, toolCall, validation, toolCall.arguments);
  }

  const mediaType = toolCall.toolName === 'generate_video' ? 'video' : 'image';
  const prompt = typeof toolCall.arguments.prompt === 'string' ? toolCall.arguments.prompt : '';

  try {
    const submitResult = await submitHiggsfieldGeneration({
      mediaType,
      prompt,
      modelId: toOptionalTrimmedString(toolCall.arguments.modelId),
      aspectRatio: toOptionalTrimmedString(toolCall.arguments.aspectRatio),
      resolution: toOptionalTrimmedString(toolCall.arguments.resolution),
      extra:
        typeof toolCall.arguments.options === 'object' && toolCall.arguments.options !== null
          ? (toolCall.arguments.options as Record<string, unknown>)
          : undefined,
    });

    return createActionEnvelope(roomId, toolCall, validation, {
      ...toolCall.arguments,
      provider: 'higgsfield',
      mediaType,
      status: submitResult.status,
      requestId: submitResult.requestId,
      statusUrl: submitResult.statusUrl,
      cancelUrl: submitResult.cancelUrl,
      ...(submitResult.imageUrl ? { imageUrl: submitResult.imageUrl } : {}),
      ...(submitResult.videoUrl ? { videoUrl: submitResult.videoUrl } : {}),
      submittedAt: new Date().toISOString(),
    });
  } catch (error) {
    return createActionEnvelope(roomId, toolCall, validation, {
      ...toolCall.arguments,
      provider: 'higgsfield',
      mediaType,
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Failed to submit media generation request.',
      submittedAt: new Date().toISOString(),
    });
  }
}
