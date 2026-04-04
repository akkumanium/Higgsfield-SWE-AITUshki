// $env:GEMINI_API_KEY="your_api_key_here"
import { executeToolCall } from './toolExecutor.js';
import { createToolEnvelope, getToolSchemas, isKnownToolName, isToolEnabled } from './tools.js';
const geminiApiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const defaultGeminiModel = 'gemini-2.5-flash';
const defaultTimeoutMs = 20_000;
const defaultMaxToolsPerTurn = 6;
const defaultMaxOutputTokens = 4096;
function roundViewport(viewport) {
    return {
        x: Math.round(viewport.x),
        y: Math.round(viewport.y),
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
    };
}
function extractRichText(richText) {
    if (typeof richText !== 'object' || richText === null) {
        return '';
    }
    const root = richText;
    const doc = root.doc ?? root;
    function walk(node) {
        if (typeof node !== 'object' || node === null) {
            return '';
        }
        const record = node;
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
function extractTextFromShape(record) {
    const props = typeof record.props === 'object' && record.props !== null
        ? record.props
        : {};
    if (props.richText !== undefined) {
        const richTextContent = extractRichText(props.richText);
        if (richTextContent.length > 0) {
            return richTextContent;
        }
    }
    const candidates = [props.text, props.name, props.label, record.text];
    for (const value of candidates) {
        if (typeof value === 'string') {
            const normalized = value.trim();
            if (normalized.length > 0) {
                return normalized;
            }
        }
    }
    if (typeof props.url === 'string' && props.url.trim().length > 0) {
        return `[url: ${props.url.trim()}]`;
    }
    return '';
}
function getContextShapePreviews(request) {
    const rawContext = request.context;
    const shapes = Array.isArray(rawContext.shapes) ? rawContext.shapes : [];
    return shapes
        .slice(0, 32)
        .map((shape) => {
        if (typeof shape !== 'object' || shape === null) {
            return null;
        }
        const record = shape;
        const id = typeof record.id === 'string' ? record.id : 'unknown-shape';
        const kind = typeof record.type === 'string'
            ? record.type
            : typeof record.kind === 'string'
                ? record.kind
                : 'unknown';
        const text = extractTextFromShape(record).slice(0, 1000);
        const memberShapeIds = Array.isArray(record.memberShapeIds) ? record.memberShapeIds : [];
        return {
            id,
            kind,
            text,
            memberShapeCount: memberShapeIds.length,
        };
    })
        .filter((shape) => shape !== null);
}
function buildShapeContextText(request) {
    const previews = getContextShapePreviews(request);
    if (previews.length === 0) {
        return 'Visible shapes: none';
    }
    const lines = previews.map((shape) => {
        const textPart = shape.text.length > 0 ? ` text="${shape.text}"` : ' text=[no text content]';
        const membersPart = shape.memberShapeCount > 0 ? ` members=${shape.memberShapeCount}` : '';
        return `- ${shape.id} kind=${shape.kind}${membersPart}${textPart}`;
    });
    return ['[CANVAS STATE - Read text content from here]', ...lines].join('\n');
}
function buildFallbackSummaryText(request) {
    const previews = getContextShapePreviews(request);
    if (previews.length === 0) {
        return 'No visible shapes to summarize. Add content to the canvas first.';
    }
    const textual = previews.filter((shape) => shape.text.length > 0).map((shape) => shape.text);
    const kindCounts = previews.reduce((accumulator, shape) => {
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
function extractNoteText(prompt) {
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
function toFunctionDeclaration(schema) {
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
            description: `${schema.description} You MUST provide a detailed summary of the content in the "summary" field.`,
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    summary: { type: 'string', description: 'The human-readable summary of the region.' },
                },
                required: ['x', 'y', 'width', 'height', 'summary'],
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
function inferToolPlanHeuristic(request) {
    const prompt = request.prompt.toLowerCase();
    const viewport = request.context.viewport;
    const roundedViewport = roundViewport(viewport);
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
                    region: roundedViewport,
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
function getEnv(name) {
    const maybeProcess = globalThis.process;
    return maybeProcess?.env?.[name];
}
function getConfiguredApiKey() {
    return getEnv('GEMINI_API_KEY') ?? getEnv('GOOGLE_API_KEY');
}
function getConfiguredModel() {
    return getEnv('GEMINI_MODEL') ?? getEnv('GOOGLE_MODEL') ?? defaultGeminiModel;
}
function getConfiguredTimeoutMs() {
    const configured = Number(getEnv('GEMINI_TIMEOUT_MS') ?? getEnv('GOOGLE_TIMEOUT_MS') ?? defaultTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : defaultTimeoutMs;
}
function getConfiguredMaxOutputTokens() {
    const configured = Number(getEnv('GEMINI_MAX_OUTPUT_TOKENS') ?? getEnv('GOOGLE_MAX_OUTPUT_TOKENS') ?? defaultMaxOutputTokens);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : defaultMaxOutputTokens;
}
function getConfiguredGeminiDebug() {
    const value = (getEnv('GEMINI_DEBUG_TOOL_CALLS') ?? '').trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
function truncateText(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
function summarizeGeminiResponseForDebug(parsed) {
    const firstCandidateParts = parsed.candidates?.[0]?.content?.parts ?? [];
    let firstCandidateRawPreview;
    try {
        const firstCandidate = parsed.candidates?.[0];
        if (firstCandidate !== undefined) {
            firstCandidateRawPreview = truncateText(JSON.stringify(firstCandidate), 1200);
        }
    }
    catch {
        firstCandidateRawPreview = '<unserializable>';
    }
    const textParts = firstCandidateParts
        .map((part) => {
        const maybeText = part.text;
        return typeof maybeText === 'string' ? maybeText : null;
    })
        .filter((value) => value !== null)
        .map((value) => truncateText(value.replace(/\s+/g, ' ').trim(), 240));
    const functionCalls = firstCandidateParts
        .map((part) => {
        const functionCall = part.functionCall;
        if (!functionCall) {
            return null;
        }
        const name = typeof functionCall.name === 'string' ? functionCall.name : null;
        const argsType = Array.isArray(functionCall.args)
            ? 'array'
            : functionCall.args === null
                ? 'null'
                : typeof functionCall.args;
        let argsPreview;
        try {
            if (functionCall.args !== undefined) {
                argsPreview = truncateText(JSON.stringify(functionCall.args), 240);
            }
        }
        catch {
            argsPreview = '<unserializable>';
        }
        return {
            name,
            argsType,
            argsPreview,
        };
    })
        .filter((value) => value !== null);
    return {
        candidateCount: parsed.candidates?.length ?? 0,
        firstCandidatePartCount: firstCandidateParts.length,
        firstCandidateRawPreview,
        firstCandidateTextParts: textParts,
        firstCandidateFunctionCalls: functionCalls,
    };
}
function parseToolArguments(value) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value;
    }
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            return null;
        }
    }
    return null;
}
async function inferToolPlanFromGemini(request) {
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
                                    `Viewport: ${JSON.stringify(roundViewport(request.context.viewport))}`,
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
                const errorPayload = (await response.json());
                if (typeof errorPayload.error?.message === 'string' && errorPayload.error.message.trim().length > 0) {
                    providerMessage = `Gemini request failed (${response.status}): ${errorPayload.error.message}`;
                }
            }
            catch {
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
        const parsed = (await response.json());
        if (parsed.error) {
            const providerMessage = typeof parsed.error.message === 'string' && parsed.error.message.trim().length > 0
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
        const debugSummary = summarizeGeminiResponseForDebug(parsed);
        const droppedDiagnostics = {
            missingFunctionCall: 0,
            missingName: 0,
            unknownToolName: 0,
            invalidArguments: 0,
        };
        const parts = parsed.candidates?.[0]?.content?.parts ?? [];
        const plannedTools = parts.flatMap((part) => {
            const functionCall = part.functionCall;
            if (!functionCall) {
                droppedDiagnostics.missingFunctionCall += 1;
                return [];
            }
            const name = typeof functionCall.name === 'string' ? functionCall.name : '';
            const arguments_ = parseToolArguments(functionCall.args);
            if (!name) {
                droppedDiagnostics.missingName += 1;
                return [];
            }
            if (!isKnownToolName(name)) {
                droppedDiagnostics.unknownToolName += 1;
                return [];
            }
            if (!arguments_) {
                droppedDiagnostics.invalidArguments += 1;
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
        const diagnosticPayload = {
            roomId: request.roomId,
            turnId: request.turnId,
            droppedDiagnostics,
            geminiResponse: debugSummary,
        };
        // Always log — the GEMINI_DEBUG_TOOL_CALLS gate was hiding the root cause.
        // eslint-disable-next-line no-console
        console.warn('[gemini] no tool calls returned', JSON.stringify(diagnosticPayload, null, 2));
        const dropReasons = Object.entries(droppedDiagnostics)
            .filter(([, count]) => count > 0)
            .map(([reason, count]) => `${reason}=${count}`)
            .join(', ');
        const candidateSummary = `candidates=${debugSummary.candidateCount} parts=${debugSummary.firstCandidatePartCount}`;
        const textPreview = debugSummary.firstCandidateTextParts.length > 0
            ? ` textParts=[${debugSummary.firstCandidateTextParts.map((t) => `"${t}"`).join(', ')}]`
            : '';
        const verboseMessage = [
            'Gemini returned no usable tool calls. Applied heuristic fallback instead.',
            `  Response: ${candidateSummary}${textPreview}`,
            dropReasons.length > 0
                ? `  Dropped parts: ${dropReasons}`
                : '  No parts with functionCall were present.',
            '  Raw preview: ' + (debugSummary.firstCandidateRawPreview ?? '(empty)'),
        ].join('\n');
        return {
            plan: inferToolPlanHeuristic(request),
            fallbackFailure: {
                code: 'provider_error',
                message: verboseMessage,
                retryable: true,
                details: diagnosticPayload,
            },
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Gemini request error.';
        return {
            plan: inferToolPlanHeuristic(request),
            fallbackFailure: {
                code: 'provider_error',
                message: `Gemini request failed (${message}). Applied heuristic fallback instead.`,
                retryable: true,
            },
        };
    }
    finally {
        clearTimeout(timer);
    }
}
export async function streamGeminiTurn(request) {
    const events = [
        {
            type: 'agent.stream.started',
            turnId: request.turnId,
            at: new Date().toISOString(),
        },
    ];
    const configuredMaxToolsPerTurn = Number(getEnv('AGENT_MAX_TOOLS_PER_TURN') ?? defaultMaxToolsPerTurn);
    const maxToolsPerTurn = Number.isFinite(configuredMaxToolsPerTurn) && configuredMaxToolsPerTurn > 0
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
        const failure = {
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
    const actions = [];
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
        let parsedArguments;
        try {
            const parsed = JSON.parse(argumentBuffer);
            if (typeof parsed !== 'object' || parsed === null) {
                throw new Error('Tool arguments were not an object.');
            }
            parsedArguments = parsed;
        }
        catch (error) {
            const failure = {
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
        // Re-nest flat summarize_region args that were flattened for Gemini compatibility.
        let envelopeForExecution = validatedToolEnvelope;
        if (validatedToolEnvelope.toolName === 'summarize_region') {
            const args = validatedToolEnvelope.arguments;
            // Heuristic path already provides nested region args; only re-nest flat Gemini args.
            if (typeof args.region !== 'object' || args.region === null) {
                const { x, y, width, height, summary, ...rest } = args;
                envelopeForExecution = {
                    ...validatedToolEnvelope,
                    arguments: {
                        ...rest,
                        region: { x, y, width, height },
                        ...(summary !== undefined ? { summary } : {}),
                    },
                };
            }
        }
        try {
            const action = executeToolCall(request.roomId, envelopeForExecution);
            actions.push(action);
            events.push({
                type: 'agent.stream.action',
                turnId: request.turnId,
                at: new Date().toISOString(),
                action,
            });
        }
        catch (error) {
            const failure = {
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
//# sourceMappingURL=claudeClient.js.map