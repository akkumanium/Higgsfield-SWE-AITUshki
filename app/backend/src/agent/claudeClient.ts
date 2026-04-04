import type {
  AgentStreamEvent,
  AgentTurnRequest,
  AgentTurnResponse,
  CanvasActionEnvelope,
  FailureEnvelope,
  ToolName,
} from '../types/contracts.js';
import { executeToolCall } from './toolExecutor.js';
import { createToolEnvelope, getToolSchemas, isKnownToolName, isToolEnabled } from './tools.js';

const anthropicApiUrl = 'https://api.anthropic.com/v1/messages';
const defaultAnthropicModel = 'claude-3-5-sonnet-latest';
const defaultTimeoutMs = 20_000;
const defaultMaxToolsPerTurn = 6;

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
    if (!isToolEnabled('generate_image')) {
      return [
        {
          toolName: 'place_sticky',
          arguments: {
            x: viewport.x + viewport.width / 2,
            y: viewport.y + viewport.height / 2,
            text: `Image generation is disabled. Prompt: ${request.prompt}`,
          },
        },
      ];
    }

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

function getEnv(name: string): string | undefined {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return maybeProcess?.env?.[name];
}

interface AnthropicContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
}

async function inferToolPlanFromAnthropic(
  request: AgentTurnRequest,
): Promise<Array<{ toolName: ToolName; arguments: Record<string, unknown> }>> {
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return inferToolPlan(request);
  }

  const timeoutMs = Number(getEnv('ANTHROPIC_TIMEOUT_MS') ?? defaultTimeoutMs);
  const model = getEnv('ANTHROPIC_MODEL') ?? defaultAnthropicModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeoutMs);

  try {
    const response = await fetch(anthropicApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        tools: getToolSchemas().map((schema) => ({
          name: schema.name,
          description: schema.description,
          input_schema: {
            type: 'object',
            properties: schema.requiredKeys.reduce<Record<string, { type: string }>>((acc, key) => {
              acc[key] = { type: 'string' };
              return acc;
            }, {}),
            required: schema.requiredKeys,
          },
        })),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'You are an AI canvas assistant that MUST call tools instead of freeform drawing.',
                  `Room: ${request.roomId}`,
                  `Prompt: ${request.prompt}`,
                  `Viewport: ${JSON.stringify(request.context.viewport)}`,
                  'Choose the single best tool call for this turn unless multiple are absolutely required.',
                ].join('\n'),
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return inferToolPlan(request);
    }

    const parsed = (await response.json()) as { content?: AnthropicContentBlock[] };
    const contentBlocks = Array.isArray(parsed.content) ? parsed.content : [];
    const toolBlocks = contentBlocks.filter((block) => block.type === 'tool_use');

    const plannedTools = toolBlocks
      .map((block) => {
        const name = typeof block.name === 'string' ? block.name : '';
        if (!isKnownToolName(name)) {
          return null;
        }
        const input = typeof block.input === 'object' && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
        return {
          toolName: name,
          arguments: input,
        };
      })
      .filter((entry): entry is { toolName: ToolName; arguments: Record<string, unknown> } => entry !== null);

    return plannedTools.length > 0 ? plannedTools : inferToolPlan(request);
  } catch {
    return inferToolPlan(request);
  } finally {
    clearTimeout(timer);
  }
}

export async function streamClaudeTurn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
  const events: AgentStreamEvent[] = [
    {
      type: 'agent.stream.started',
      turnId: request.turnId,
      at: new Date().toISOString(),
    },
  ];

  const maxToolsPerTurn = Number(getEnv('AGENT_MAX_TOOLS_PER_TURN') ?? defaultMaxToolsPerTurn);
  const toolPlan = (await inferToolPlanFromAnthropic(request)).filter((entry) => isKnownToolName(entry.toolName));

  if (toolPlan.length > maxToolsPerTurn) {
    const failure: FailureEnvelope = {
      code: 'invalid_request',
      message: `Tool plan exceeded max operations per turn (${maxToolsPerTurn}).`,
      retryable: false,
      details: {
        plannedTools: toolPlan.length,
        maxToolsPerTurn,
      },
    };
    events.push({
      type: 'agent.stream.failed',
      turnId: request.turnId,
      at: new Date().toISOString(),
      failure,
    });
    return {
      turnId: request.turnId,
      accepted: false,
      status: 'failed',
      actions: [],
      events,
      failure,
      error: failure.message,
    };
  }
  const actions: CanvasActionEnvelope[] = [];

  for (const entry of toolPlan) {
    const toolEnvelope = createToolEnvelope(request.turnId, entry.toolName, {});
    const serializedArguments = JSON.stringify(entry.arguments);
    const chunkSize = Math.max(8, Math.floor(serializedArguments.length / 2));

    let argumentBuffer = '';
    for (let index = 0; index < serializedArguments.length; index += chunkSize) {
      const fragment = serializedArguments.slice(index, index + chunkSize);
      argumentBuffer += fragment;
      events.push({
        type: 'agent.stream.tool_call.delta',
        turnId: request.turnId,
        at: new Date().toISOString(),
        toolCall: {
          id: toolEnvelope.id,
          turnId: request.turnId,
          toolName: entry.toolName,
          fragment,
          completed: index + chunkSize >= serializedArguments.length,
        },
      });
    }

    let parsedArguments: Record<string, unknown>;
    try {
      const parsed = JSON.parse(argumentBuffer);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Tool arguments were not an object.');
      }
      parsedArguments = parsed as Record<string, unknown>;
    } catch (error) {
      const failure: FailureEnvelope = {
        code: 'malformed_tool_call',
        message: error instanceof Error ? error.message : 'Failed to parse streamed tool arguments.',
        retryable: true,
      };
      events.push({
        type: 'agent.stream.failed',
        turnId: request.turnId,
        at: new Date().toISOString(),
        failure,
      });
      return {
        turnId: request.turnId,
        accepted: false,
        status: 'failed',
        actions,
        events,
        failure,
        error: failure.message,
      };
    }

    const completedToolEnvelope = {
      ...toolEnvelope,
      arguments: parsedArguments,
    };

    events.push({
      type: 'agent.stream.tool_call.completed',
      turnId: request.turnId,
      at: new Date().toISOString(),
      toolCall: completedToolEnvelope,
    });

    try {
      const action = executeToolCall(request.roomId, completedToolEnvelope);
      actions.push(action);
      events.push({
        type: 'agent.stream.action',
        turnId: request.turnId,
        at: new Date().toISOString(),
        action,
      });
    } catch (error) {
      const failure: FailureEnvelope = {
        code: 'tool_validation_failed',
        message: error instanceof Error ? error.message : 'Tool execution failed.',
        retryable: false,
      };
      events.push({
        type: 'agent.stream.failed',
        turnId: request.turnId,
        at: new Date().toISOString(),
        failure,
      });
      return {
        turnId: request.turnId,
        accepted: false,
        status: 'failed',
        actions,
        suggestedActions: actions,
        events,
        failure,
        error: failure.message,
      };
    }
  }

  events.push({
    type: 'agent.stream.completed',
    turnId: request.turnId,
    at: new Date().toISOString(),
  });

  return {
    turnId: request.turnId,
    accepted: true,
    status: 'completed',
    actions,
    events,
  };
}
