// $env:GEMINI_API_KEY="your_api_key_here"

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

const geminiApiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const defaultGeminiModel = 'gemini-2.5-flash';
const defaultTimeoutMs = 20_000;
const defaultMaxToolsPerTurn = 6;
const defaultMaxOutputTokens = 1024;

interface GeminiToolDeclaration {
  name: ToolName;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface ContextShapePreview {
  id: string;
  kind: string;
  text: string;
  memberShapeCount: number;
}

function extractRichText(richText: unknown): string {
  if (typeof richText !== 'object' || richText === null) {
    return '';
  }

  const root = richText as Record<string, unknown>;
  const doc = root.doc ?? root;

  function walk(node: unknown): string {
    if (typeof node !== 'object' || node === null) {
      return '';
    }

    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }

    if (Array.isArray(record.content)) {
      return record.content.map(walk).join('');
    }

    return '';
  }

  return walk(doc).replace(/\s+/g, ' ').trim();
}

function getContextShapePreviews(request: AgentTurnRequest): ContextShapePreview[] {
  const rawContext = request.context as AgentTurnRequest['context'] & { shapes?: unknown };
  if (!Array.isArray(rawContext.shapes)) {
    return [];
  }

  return rawContext.shapes
    .slice(0, 32)
    .map((shape): ContextShapePreview | null => {
      if (typeof shape !== 'object' || shape === null) {
        return null;
      }

      const record = shape as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : 'unknown-shape';
      const kind =
        typeof record.kind === 'string'
          ? record.kind
          : typeof record.type === 'string'
            ? record.type
            : 'unknown';
      const props =
        typeof record.props === 'object' && record.props !== null
          ? (record.props as Record<string, unknown>)
          : {};
      const rawText =
        typeof record.text === 'string'
          ? record.text
          : typeof props.text === 'string'
            ? props.text
            : props.richText !== undefined
              ? extractRichText(props.richText)
              : '';
      const text = rawText.replace(/\s+/g, ' ').trim().slice(0, 1000);
      const memberShapeIds = Array.isArray(record.memberShapeIds) ? record.memberShapeIds : [];

      return {
        id,
        kind,
        text,
        memberShapeCount: memberShapeIds.length,
      };
    })
    .filter((shape): shape is ContextShapePreview => shape !== null);
}

function buildShapeContextText(request: AgentTurnRequest): string {
  const previews = getContextShapePreviews(request);
  if (previews.length === 0) {
    return 'Visible shapes: none';
  }

  const lines = previews.map((shape) => {
    const textPart = shape.text.length > 0 ? ` text="${shape.text}"` : '';
    const membersPart = shape.memberShapeCount > 0 ? ` members=${shape.memberShapeCount}` : '';
    return `- ${shape.id} kind=${shape.kind}${membersPart}${textPart}`;
  });

  // Label clearly so Gemini knows this is the content, not instructions
  return ['[CANVAS SHAPES — this is the content to summarize, not the instructions below]', ...lines].join('\n');
}

function buildFallbackSummaryText(request: AgentTurnRequest): string {
  const previews = getContextShapePreviews(request);
  if (previews.length === 0) {
    return 'No visible shapes to summarize. Add content to the canvas first.';
  }

  const textual = previews.filter((shape) => shape.text.length > 0).map((shape) => shape.text);

  const kindCounts = previews.reduce<Record<string, number>>((accumulator, shape) => {
    accumulator[shape.kind] = (accumulator[shape.kind] ?? 0) + 1;
    return accumulator;
  }, {});

  const kindSummary = Object.entries(kindCounts)
    .map(([kind, count]) => `${count} ${kind}${count > 1 ? 's' : ''}`)
    .join(', ');

  if (textual.length === 0) {
    return `Canvas contains ${kindSummary} with no text labels yet.`;
  }

  return `${previews.length} shapes (${kindSummary}): ${textual.slice(0, 4).join(' | ')}`;
}

function extractNoteText(prompt: string): string {
  const patterns = [
    /make a note (?:saying|that|:)\s+["']?(.+?)["']?$/i,
    /add a (?:sticky )?note (?:saying|that|:)\s+["']?(.+?)["']?$/i,
    /(?:write|put|place)(?: a note)?(?:\s+saying|:)?\s+["']?(.+?)["']?$/i,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return prompt;
}

function toFunctionDeclaration(schema: ReturnType<typeof getToolSchemas>[number]): GeminiToolDeclaration {
  if (schema.name === 'place_sticky') {
    return {
      name: schema.name,
      description: schema.description,
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['x', 'y', 'text'],
      },
    };
  }

  if (schema.name === 'draw_arrow') {
    return {
      name: schema.name,
      description: schema.description,
      parameters: {
        type: 'object',
        properties: {
          fromShapeId: { type: 'string' },
          toShapeId: { type: 'string' },
        },
        required: ['fromShapeId', 'toShapeId'],
      },
    };
  }

  if (schema.name === 'cluster_shapes') {
    return {
      name: schema.name,
      description: schema.description,
      parameters: {
        type: 'object',
        properties: {
          shapeIds: {
            type: 'array',
            items: { type: 'string' },
          },
          label: { type: 'string' },
        },
        required: ['shapeIds', 'label'],
      },
    };
  }

  if (schema.name === 'summarize_region') {
    return {
      name: schema.name,
      description: `${schema.description} Include a human-readable summary string in "summary".`,
      parameters: {
        type: 'object',
        properties: {
          region: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          summary: { type: 'string' },
        },
        required: ['region'],
      },
    };
  }

  return {
    name: schema.name,
    description: schema.description,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['prompt', 'x', 'y'],
    },
  };
}

function inferToolPlanHeuristic(request: AgentTurnRequest): Array<{ toolName: ToolName; arguments: Record<string, unknown> }> {
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
          summary: buildFallbackSummaryText(request),
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
        text: extractNoteText(request.prompt),
      },
    },
  ];
}

function getEnv(name: string): string | undefined {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return maybeProcess?.env?.[name];
}

function getConfiguredApiKey(): string | undefined {
  return getEnv('GEMINI_API_KEY') ?? getEnv('GOOGLE_API_KEY');
}

function getConfiguredModel(): string {
  return getEnv('GEMINI_MODEL') ?? getEnv('GOOGLE_MODEL') ?? defaultGeminiModel;
}

function getConfiguredTimeoutMs(): number {
  const configured = Number(getEnv('GEMINI_TIMEOUT_MS') ?? getEnv('GOOGLE_TIMEOUT_MS') ?? defaultTimeoutMs);
  return Number.isFinite(configured) && configured > 0 ? configured : defaultTimeoutMs;
}

function getConfiguredMaxOutputTokens(): number {
  const configured = Number(getEnv('GEMINI_MAX_OUTPUT_TOKENS') ?? getEnv('GOOGLE_MAX_OUTPUT_TOKENS') ?? defaultMaxOutputTokens);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : defaultMaxOutputTokens;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        functionCall?: {
          name?: string;
          args?: unknown;
        };
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
  };
}

interface ToolPlanInferenceResult {
  plan: Array<{ toolName: ToolName; arguments: Record<string, unknown> }>;
  fallbackFailure?: FailureEnvelope;
}

function parseToolArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

async function inferToolPlanFromGemini(
  request: AgentTurnRequest,
): Promise<ToolPlanInferenceResult> {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    return {
      plan: inferToolPlanHeuristic(request),
      fallbackFailure: {
        code: 'provider_error',
        message: 'Gemini API key is not configured (set GEMINI_API_KEY or GOOGLE_API_KEY). Applied heuristic fallback instead.',
        retryable: false,
      },
    };
  }

  const timeoutMs = getConfiguredTimeoutMs();
  const model = getConfiguredModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const toolSchemas = getToolSchemas();
    const functionDeclarations = toolSchemas.map((schema) => toFunctionDeclaration(schema));
    const allowedFunctionNames = toolSchemas.map((schema) => schema.name);

    const response = await fetch(`${geminiApiBaseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0,
          maxOutputTokens: getConfiguredMaxOutputTokens(),
        },
        toolConfig: {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames,
          },
        },
        tools: [
          {
            functionDeclarations,
          },
        ],
        systemInstruction: {
          parts: [
            {
              text: [
                'You are an AI canvas assistant that calls tools to manipulate a canvas.',
                'When asked to summarize, call summarize_region EXACTLY ONCE.',
                'Your "summary" field must summarize the actual text content and meaning of the shapes listed in the CANVAS STATE section. Do not just describe their existence or layout — read the text.',
                "For place_sticky, 'text' must contain ONLY the note content, never the user's instruction text.",
                'Do not return placeholder text.',
                'If the request implies multiple distinct operations, emit one tool call per operation, up to 6 per turn.',
              ].join('\n'),
            },
          ],
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  '=== CANVAS STATE ===',
                  `Room: ${request.roomId}`,
                  `Viewport: ${JSON.stringify(request.context.viewport)}`,
                  buildShapeContextText(request),
                  '=== USER REQUEST ===',
                  request.prompt,
                ].join('\n'),
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let providerMessage = `Gemini request failed with HTTP ${response.status}.`;
      try {
        const errorPayload = (await response.json()) as GeminiResponse;
        if (typeof errorPayload.error?.message === 'string' && errorPayload.error.message.trim().length > 0) {
          providerMessage = `Gemini request failed (${response.status}): ${errorPayload.error.message}`;
        }
      } catch {
        // Keep the generic provider message when error payload parsing fails.
      }

      return {
        plan: inferToolPlanHeuristic(request),
        fallbackFailure: {
          code: 'provider_error',
          message: `${providerMessage} Applied heuristic fallback instead.`,
          retryable: response.status === 429 || response.status >= 500,
          details: {
            httpStatus: response.status,
          },
        },
      };
    }

    const parsed = (await response.json()) as GeminiResponse;
    if (parsed.error) {
      const providerMessage =
        typeof parsed.error.message === 'string' && parsed.error.message.trim().length > 0
          ? parsed.error.message
          : 'Gemini returned an error payload.';
      return {
        plan: inferToolPlanHeuristic(request),
        fallbackFailure: {
          code: 'provider_error',
          message: `Gemini provider error: ${providerMessage} Applied heuristic fallback instead.`,
          retryable: true,
          details: {
            providerCode: parsed.error.code,
          },
        },
      };
    }

    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    const plannedTools = parts.flatMap((part) => {
      const functionCall = part.functionCall;
      if (!functionCall) {
        return [];
      }

      const name = typeof functionCall.name === 'string' ? functionCall.name : '';
      const arguments_ = parseToolArguments(functionCall.args);
      if (!name || !arguments_ || !isKnownToolName(name)) {
        return [];
      }

      return [
        {
          toolName: name,
          arguments: arguments_,
        },
      ];
    });

    if (plannedTools.length > 0) {
      return {
        plan: plannedTools,
      };
    }

    return {
      plan: inferToolPlanHeuristic(request),
      fallbackFailure: {
        code: 'provider_error',
        message: 'Gemini returned no tool calls. Applied heuristic fallback instead.',
        retryable: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Gemini request error.';
    return {
      plan: inferToolPlanHeuristic(request),
      fallbackFailure: {
        code: 'provider_error',
        message: `Gemini request failed (${message}). Applied heuristic fallback instead.`,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function streamGeminiTurn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
  const events: AgentStreamEvent[] = [
    {
      type: 'agent.stream.started',
      turnId: request.turnId,
      at: new Date().toISOString(),
    },
  ];

  const configuredMaxToolsPerTurn = Number(getEnv('AGENT_MAX_TOOLS_PER_TURN') ?? defaultMaxToolsPerTurn);
  const maxToolsPerTurn =
    Number.isFinite(configuredMaxToolsPerTurn) && configuredMaxToolsPerTurn > 0
      ? Math.floor(configuredMaxToolsPerTurn)
      : defaultMaxToolsPerTurn;
  const inferred = await inferToolPlanFromGemini(request);
  const toolPlan = inferred.plan.filter((entry) => isKnownToolName(entry.toolName));

  if (inferred.fallbackFailure) {
    events.push({
      type: 'agent.stream.delta',
      turnId: request.turnId,
      at: new Date().toISOString(),
      delta: inferred.fallbackFailure.message,
    });
  }

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
    const completedToolEnvelope = createToolEnvelope(request.turnId, entry.toolName, entry.arguments);
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
          id: completedToolEnvelope.id,
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

    const validatedToolEnvelope = {
      ...completedToolEnvelope,
      arguments: parsedArguments,
    };

    events.push({
      type: 'agent.stream.tool_call.completed',
      turnId: request.turnId,
      at: new Date().toISOString(),
      toolCall: validatedToolEnvelope,
    });

    try {
      const action = executeToolCall(request.roomId, validatedToolEnvelope);
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
    status: inferred.fallbackFailure ? 'fallback' : 'completed',
    actions,
    suggestedActions: inferred.fallbackFailure ? actions : undefined,
    events,
    failure: inferred.fallbackFailure,
    error: inferred.fallbackFailure?.message,
  };
}
