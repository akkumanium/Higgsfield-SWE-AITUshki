// $env:GEMINI_API_KEY="your_api_key_here"
import { executeToolCall } from './toolExecutor.js';
import { createToolEnvelope } from './tools.js';
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
function classifyPromptIntent(prompt) {
    const normalized = prompt.toLowerCase();
    if (/\b(summarize|summarise)\b/.test(normalized)) {
        return 'summary';
    }
    if (/\b(why|how|what|explain|compare|benefits?|steps?|causes?|list)\b/.test(normalized)) {
        return 'creative';
    }
    return 'note';
}
function createLocalShapeId(turnId, key) {
    return `shape-${turnId}-${key}`;
}
function stripMarkdownFences(value) {
    const trimmed = value.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced?.[1] !== undefined ? fenced[1].trim() : trimmed;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function truncateText(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
function parseCreativePlan(value) {
    try {
        const parsed = JSON.parse(value);
        if (!isNonEmptyString(parsed.title) ||
            !isNonEmptyString(parsed.support1) ||
            !isNonEmptyString(parsed.support2) ||
            !isNonEmptyString(parsed.support3) ||
            !isNonEmptyString(parsed.takeaway)) {
            return null;
        }
        return {
            title: parsed.title.trim(),
            support1: parsed.support1.trim(),
            support2: parsed.support2.trim(),
            support3: parsed.support3.trim(),
            takeaway: parsed.takeaway.trim(),
        };
    }
    catch {
        return null;
    }
}
function extractGeminiText(parsed) {
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    return parts
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim();
}
function buildCreativeFallbackPlan(prompt) {
    const title = truncateText(prompt.replace(/\s+/g, ' ').trim() || 'Untitled topic', 60);
    return {
        title,
        support1: '💡 First key idea — edit this',
        support2: '💡 Second key idea — edit this',
        support3: '💡 Third key idea — edit this',
        takeaway: '✅ Bottom line — edit this',
    };
}
function buildSummaryPlan(request) {
    return {
        region: roundViewport(request.context.viewport),
        summary: buildFallbackSummaryText(request),
    };
}
function buildSimpleNotePlan(prompt) {
    return {
        text: extractNoteText(prompt),
    };
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
function getConfiguredMaxToolsPerTurn() {
    const configured = Number(getEnv('AGENT_MAX_TOOLS_PER_TURN') ?? defaultMaxToolsPerTurn);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : defaultMaxToolsPerTurn;
}
async function inferCreativePlanFromGemini(request) {
    const apiKey = getConfiguredApiKey();
    if (!apiKey) {
        return {
            plan: buildCreativeFallbackPlan(request.prompt),
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
                systemInstruction: {
                    parts: [
                        {
                            text: [
                                'You are a content planner. Return only a JSON object with these exact fields: title, support1, support2, support3, takeaway.',
                                'Each value is a short, specific, factual phrase - no padding, no repetition, no markdown.',
                                'Do not include anything outside the JSON object.',
                            ].join(' '),
                        },
                    ],
                },
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                text: request.prompt,
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
                plan: buildCreativeFallbackPlan(request.prompt),
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
                plan: buildCreativeFallbackPlan(request.prompt),
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
        const rawText = extractGeminiText(parsed);
        const parsedPlan = parseCreativePlan(rawText) ?? parseCreativePlan(stripMarkdownFences(rawText));
        if (parsedPlan) {
            return {
                plan: parsedPlan,
            };
        }
        return {
            plan: buildCreativeFallbackPlan(request.prompt),
            fallbackFailure: {
                code: 'provider_error',
                message: 'Gemini returned malformed creative JSON. Applied heuristic fallback instead.',
                retryable: true,
                details: {
                    rawPreview: truncateText(rawText, 400),
                },
            },
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Gemini request error.';
        return {
            plan: buildCreativeFallbackPlan(request.prompt),
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
function compilePlan(plan, turnId, viewport) {
    const { x, y, width, height } = viewport;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const titleId = createLocalShapeId(turnId, 'title');
    const support1Id = createLocalShapeId(turnId, 's1');
    const support2Id = createLocalShapeId(turnId, 's2');
    const support3Id = createLocalShapeId(turnId, 's3');
    const takeawayId = createLocalShapeId(turnId, 'takeaway');
    const toolCalls = [
        {
            toolName: 'place_sticky',
            arguments: {
                id: titleId,
                x: cx,
                y: cy - 180,
                text: plan.title,
            },
        },
        {
            toolName: 'place_sticky',
            arguments: {
                id: support1Id,
                x: cx - 260,
                y: cy,
                text: plan.support1,
            },
        },
        {
            toolName: 'place_sticky',
            arguments: {
                id: support2Id,
                x: cx,
                y: cy,
                text: plan.support2,
            },
        },
        {
            toolName: 'place_sticky',
            arguments: {
                id: support3Id,
                x: cx + 260,
                y: cy,
                text: plan.support3,
            },
        },
        {
            toolName: 'place_sticky',
            arguments: {
                id: takeawayId,
                x: cx,
                y: cy + 180,
                text: plan.takeaway,
            },
        },
        {
            toolName: 'draw_arrow',
            arguments: {
                fromShapeId: titleId,
                toShapeId: support1Id,
            },
        },
        {
            toolName: 'draw_arrow',
            arguments: {
                fromShapeId: titleId,
                toShapeId: support2Id,
            },
        },
        {
            toolName: 'draw_arrow',
            arguments: {
                fromShapeId: titleId,
                toShapeId: support3Id,
            },
        },
        {
            toolName: 'cluster_shapes',
            arguments: {
                shapeIds: [support1Id, support2Id, support3Id],
                label: 'Key Points',
            },
        },
    ];
    const maxToolsPerTurn = getConfiguredMaxToolsPerTurn();
    const coreCalls = toolCalls.slice(0, 5);
    const arrowCalls = toolCalls.slice(5, 8);
    const clusterCall = toolCalls[8];
    if (maxToolsPerTurn <= coreCalls.length) {
        return coreCalls.slice(0, maxToolsPerTurn);
    }
    const budget = maxToolsPerTurn - coreCalls.length;
    const allowedArrows = arrowCalls.slice(0, Math.min(arrowCalls.length, budget));
    const remainingBudget = budget - allowedArrows.length;
    const extras = remainingBudget > 0 ? [...allowedArrows, clusterCall] : allowedArrows;
    return [...coreCalls, ...extras];
}
function compileSimpleNote(plan, turnId, viewport) {
    const { x, y, width, height } = viewport;
    return [
        {
            toolName: 'place_sticky',
            arguments: {
                id: createLocalShapeId(turnId, 'note'),
                x: x + width / 2,
                y: y + height / 2,
                text: plan.text,
            },
        },
    ];
}
function compileSummary(plan, _turnId) {
    return [
        {
            toolName: 'summarize_region',
            arguments: {
                region: plan.region,
                summary: plan.summary,
            },
        },
    ];
}
async function inferToolPlan(request) {
    const intent = classifyPromptIntent(request.prompt);
    if (intent === 'summary') {
        return {
            toolPlan: compileSummary(buildSummaryPlan(request), request.turnId),
        };
    }
    if (intent === 'note') {
        return {
            toolPlan: compileSimpleNote(buildSimpleNotePlan(request.prompt), request.turnId, request.context.viewport),
        };
    }
    const creative = await inferCreativePlanFromGemini(request);
    return {
        toolPlan: compilePlan(creative.plan, request.turnId, request.context.viewport),
        fallbackFailure: creative.fallbackFailure,
    };
}
export async function streamGeminiTurn(request) {
    const events = [
        {
            type: 'agent.stream.started',
            turnId: request.turnId,
            at: new Date().toISOString(),
        },
    ];
    const maxToolsPerTurn = getConfiguredMaxToolsPerTurn();
    const inferred = await inferToolPlan(request);
    const toolPlan = inferred.toolPlan;
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
        try {
            const action = executeToolCall(request.roomId, validatedToolEnvelope);
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