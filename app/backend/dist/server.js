import { streamGeminiTurn } from './agent/claudeClient.js';
const defaultMinTurnIntervalMs = 5_000;
const defaultMaxActionsPerTurn = 50;
const lastTurnBySession = new Map();
function getEnv(name) {
    const maybeProcess = globalThis.process;
    return maybeProcess?.env?.[name];
}
function getMinTurnIntervalMs() {
    const configured = Number(getEnv('AGENT_MIN_TURN_INTERVAL_MS') ?? defaultMinTurnIntervalMs);
    return Number.isFinite(configured) && configured >= 0 ? configured : defaultMinTurnIntervalMs;
}
function getMaxActionsPerTurn() {
    const configured = Number(getEnv('AGENT_MAX_ACTIONS_PER_TURN') ?? defaultMaxActionsPerTurn);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : defaultMaxActionsPerTurn;
}
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
export function isAgentTurnRequest(value) {
    if (!isObject(value)) {
        return false;
    }
    return (typeof value.roomId === 'string' &&
        typeof value.sessionId === 'string' &&
        typeof value.turnId === 'string' &&
        typeof value.prompt === 'string' &&
        isObject(value.context) &&
        typeof value.context.roomId === 'string' &&
        typeof value.context.sessionId === 'string' &&
        isObject(value.context.viewport) &&
        typeof value.context.viewport.x === 'number' &&
        typeof value.context.viewport.y === 'number' &&
        typeof value.context.viewport.width === 'number' &&
        typeof value.context.viewport.height === 'number' &&
        typeof value.context.maxShapes === 'number');
}
export async function handleAgentTurn(request) {
    return streamGeminiTurn(request);
}
export const backendPort = 3001;
export function createBackendHealth() {
    return {
        status: 'ok',
        backendPort,
    };
}
function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', (chunk) => {
            body += typeof chunk === 'string' ? chunk : String(chunk ?? '');
        });
        request.on('end', () => resolve(body));
        request.on('error', (error) => reject(error));
    });
}
function setCorsHeaders(response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}
function writeJson(response, statusCode, payload) {
    setCorsHeaders(response);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}
function writeSseEvent(response, event, data) {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
}
function parseJsonBody(text) {
    if (text.trim().length === 0) {
        return null;
    }
    return JSON.parse(text);
}
async function loadRuntimeModules() {
    const httpSpecifier = 'node:http';
    const urlSpecifier = 'node:url';
    const httpModule = (await import(httpSpecifier));
    const urlModule = (await import(urlSpecifier));
    const argv = typeof globalThis === 'object' &&
        'process' in globalThis &&
        Array.isArray(globalThis.process?.argv)
        ? (globalThis.process.argv)
        : [];
    return {
        createServer: httpModule.createServer,
        pathToFileHref(path) {
            return urlModule.pathToFileURL(path).href;
        },
        argv,
    };
}
export async function startBackendServer(options = {}) {
    const port = options.port ?? backendPort;
    const runtime = await loadRuntimeModules();
    const server = runtime.createServer(async (request, response) => {
        setCorsHeaders(response);
        if (request.method === 'OPTIONS') {
            response.writeHead(204);
            response.end();
            return;
        }
        if (request.method === 'GET' && request.url === '/health') {
            writeJson(response, 200, createBackendHealth());
            return;
        }
        if (request.method === 'POST' && request.url === '/agent/turn') {
            let payload;
            try {
                const body = await readRequestBody(request);
                payload = parseJsonBody(body);
            }
            catch {
                writeJson(response, 400, {
                    accepted: false,
                    failure: {
                        code: 'invalid_request',
                        message: 'Request body must be valid JSON.',
                        retryable: false,
                    },
                });
                return;
            }
            if (!isAgentTurnRequest(payload)) {
                writeJson(response, 400, {
                    accepted: false,
                    failure: {
                        code: 'invalid_request',
                        message: 'Payload is not a valid AgentTurnRequest.',
                        retryable: false,
                    },
                });
                return;
            }
            const sessionKey = `${payload.roomId}:${payload.sessionId}`;
            const nowMs = Date.now();
            const minTurnIntervalMs = getMinTurnIntervalMs();
            const previousTurnMs = lastTurnBySession.get(sessionKey);
            if (typeof previousTurnMs === 'number' && nowMs - previousTurnMs < minTurnIntervalMs) {
                const retryAfterMs = minTurnIntervalMs - (nowMs - previousTurnMs);
                writeJson(response, 429, {
                    accepted: false,
                    failure: {
                        code: 'invalid_request',
                        message: `Rate limit exceeded for session. Retry in ${retryAfterMs}ms.`,
                        retryable: true,
                        details: {
                            retryAfterMs,
                            minTurnIntervalMs,
                        },
                    },
                });
                return;
            }
            lastTurnBySession.set(sessionKey, nowMs);
            response.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
            });
            try {
                const result = await handleAgentTurn(payload);
                let responsePayload = result;
                const maxActions = getMaxActionsPerTurn();
                if (result.actions.length > maxActions) {
                    const failure = {
                        code: 'invalid_request',
                        message: `Agent action count exceeded max per turn (${maxActions}).`,
                        retryable: false,
                        details: {
                            actions: result.actions.length,
                            maxActions,
                        },
                    };
                    responsePayload = {
                        ...result,
                        accepted: false,
                        status: 'failed',
                        actions: [],
                        failure,
                        error: failure.message,
                    };
                    writeSseEvent(response, 'agent.stream.failed', {
                        type: 'agent.stream.failed',
                        turnId: payload.turnId,
                        at: new Date().toISOString(),
                        failure,
                    });
                }
                for (const event of responsePayload.events ?? []) {
                    writeSseEvent(response, event.type, event);
                }
                writeSseEvent(response, 'agent.turn.result', responsePayload);
            }
            catch (error) {
                writeSseEvent(response, 'agent.stream.failed', {
                    type: 'agent.stream.failed',
                    turnId: payload.turnId,
                    at: new Date().toISOString(),
                    failure: {
                        code: 'internal_error',
                        message: error instanceof Error ? error.message : 'Agent turn failed unexpectedly.',
                        retryable: true,
                    },
                });
            }
            response.end();
            return;
        }
        writeJson(response, 404, {
            error: 'Not found',
            path: request.url ?? '/',
        });
    });
    await new Promise((resolve) => {
        server.listen(port, () => resolve());
    });
    return {
        port,
        close() {
            return new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
    };
}
export async function runBackendServerCli() {
    const runtime = await loadRuntimeModules();
    const isEntrypoint = runtime.argv.length > 1 &&
        import.meta.url === runtime.pathToFileHref(runtime.argv[1]);
    if (!isEntrypoint) {
        return;
    }
    const started = await startBackendServer({ port: backendPort });
    // eslint-disable-next-line no-console
    console.log(`backend listening on http://localhost:${started.port}`);
}
void runBackendServerCli();
//# sourceMappingURL=server.js.map