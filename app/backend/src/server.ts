import { streamGeminiTurn } from './agent/claudeClient.js';
import { getHiggsfieldGenerationStatus } from './agent/higgsfieldClient.js';
import type { AgentTurnRequest, AgentTurnResponse, FailureEnvelope } from './types/contracts.js';

const defaultMinTurnIntervalMs = 5_000;
const defaultMaxActionsPerTurn = 50;

const lastTurnBySession = new Map<string, number>();
const dailyApiBaseUrl = 'https://api.daily.co/v1';

function getEnv(name: string): string | undefined {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return maybeProcess?.env?.[name];
}

function getMinTurnIntervalMs(): number {
  const configured = Number(getEnv('AGENT_MIN_TURN_INTERVAL_MS') ?? defaultMinTurnIntervalMs);
  return Number.isFinite(configured) && configured >= 0 ? configured : defaultMinTurnIntervalMs;
}

function getMaxActionsPerTurn(): number {
  const configured = Number(getEnv('AGENT_MAX_ACTIONS_PER_TURN') ?? defaultMaxActionsPerTurn);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : defaultMaxActionsPerTurn;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidInvocation(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (!isObject(value)) {
    return false;
  }

  if (typeof value.source !== 'string' || !['chat', 'canvas', 'panel'].includes(value.source)) {
    return false;
  }

  if (value.displayName !== undefined && typeof value.displayName !== 'string') {
    return false;
  }

  if (value.rawPrompt !== undefined && typeof value.rawPrompt !== 'string') {
    return false;
  }

  if (value.requireExplicitMention !== undefined && typeof value.requireExplicitMention !== 'boolean') {
    return false;
  }

  if (value.mentionDetected !== undefined && typeof value.mentionDetected !== 'boolean') {
    return false;
  }

  return true;
}

function sanitizeDailyRoomName(roomId: string): string {
  const normalized = roomId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `ai-canvas-${normalized || 'room'}`.slice(0, 60);
}

function normalizeDisplayName(value: unknown, sessionId: string): string {
  if (typeof value !== 'string') {
    return `User-${sessionId.slice(-4)}`;
  }
  const cleaned = value.trim().replace(/\s{2,}/g, ' ');
  if (!cleaned) {
    return `User-${sessionId.slice(-4)}`;
  }
  return cleaned.slice(0, 48);
}

async function ensureDailyRoom(roomName: string, apiKey: string): Promise<string> {
  const createResponse = await fetch(`${dailyApiBaseUrl}/rooms`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      name: roomName,
      privacy: 'private',
      properties: {
        start_video_off: true,
      },
    }),
  });

  if (createResponse.ok) {
    const created = (await createResponse.json()) as { url?: string };
    if (typeof created.url === 'string' && created.url.length > 0) {
      return created.url;
    }
  }

  if (createResponse.status !== 409) {
    const bodyText = await createResponse.text();
    throw new Error(`Daily room creation failed (${createResponse.status}): ${bodyText.slice(0, 220)}`);
  }

  const fetchResponse = await fetch(`${dailyApiBaseUrl}/rooms/${encodeURIComponent(roomName)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!fetchResponse.ok) {
    const bodyText = await fetchResponse.text();
    throw new Error(`Daily room lookup failed (${fetchResponse.status}): ${bodyText.slice(0, 220)}`);
  }

  const existing = (await fetchResponse.json()) as { url?: string };
  if (typeof existing.url !== 'string' || existing.url.length === 0) {
    throw new Error('Daily room lookup did not return a room URL.');
  }
  return existing.url;
}

async function createDailyMeetingToken(
  roomName: string,
  displayName: string,
  apiKey: string,
): Promise<{ token?: string; expiresAt: string }> {
  const expiresAtEpoch = Math.floor(Date.now() / 1000) + 4 * 60 * 60;
  const response = await fetch(`${dailyApiBaseUrl}/meeting-tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        user_name: displayName,
        exp: expiresAtEpoch,
      },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Daily token generation failed (${response.status}): ${bodyText.slice(0, 220)}`);
  }

  const payload = (await response.json()) as { token?: string };
  return {
    token: payload.token,
    expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
  };
}

export function isAgentTurnRequest(value: unknown): value is AgentTurnRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.roomId === 'string' &&
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
    typeof value.context.maxShapes === 'number' &&
    isValidInvocation(value.invocation)
  );
}

export async function handleAgentTurn(request: AgentTurnRequest) {
  return streamGeminiTurn(request);
}

export const backendPort = (() => {
  const configured = Number(getEnv('PORT') ?? getEnv('BACKEND_PORT') ?? 3001);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3001;
})();

export function createBackendHealth() {
  return {
    status: 'ok' as const,
    backendPort,
  };
}

interface StartBackendServerOptions {
  port?: number;
}

interface RuntimeRequest {
  method?: string;
  url?: string;
  on: (event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void) => void;
}

interface RuntimeResponse {
  setHeader: (name: string, value: string) => void;
  writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  write: (chunk: string) => void;
  end: (chunk?: string) => void;
}

interface RuntimeServer {
  listen: (port: number, callback?: () => void) => void;
  close: (callback: (error?: Error) => void) => void;
}

interface RuntimeModules {
  createServer: (
    listener: (request: RuntimeRequest, response: RuntimeResponse) => void,
  ) => RuntimeServer;
  pathToFileHref: (path: string) => string;
  argv: string[];
}

function readRequestBody(request: RuntimeRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += typeof chunk === 'string' ? chunk : String(chunk ?? '');
    });
    request.on('end', () => resolve(body));
    request.on('error', (error) => reject(error));
  });
}

function setCorsHeaders(response: RuntimeResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}

function writeJson(response: RuntimeResponse, statusCode: number, payload: unknown) {
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function writeSseEvent(response: RuntimeResponse, event: string, data: unknown) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseMediaStatusRequestId(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  const path = url.split('?')[0] ?? '';
  const match = path.match(/^\/media\/requests\/([^/]+)\/status$/i);
  if (!match?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function parseJsonBody(text: string): unknown {
  if (text.trim().length === 0) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

async function loadRuntimeModules(): Promise<RuntimeModules> {
  const httpSpecifier = 'node:http';
  const urlSpecifier = 'node:url';

  const httpModule = (await import(httpSpecifier)) as {
    createServer: (
      listener: (request: RuntimeRequest, response: RuntimeResponse) => void,
    ) => RuntimeServer;
  };
  const urlModule = (await import(urlSpecifier)) as {
    pathToFileURL: (path: string) => { href: string };
  };

  const argv =
    typeof globalThis === 'object' &&
    'process' in globalThis &&
    Array.isArray((globalThis as { process?: { argv?: unknown } }).process?.argv)
      ? ((globalThis as unknown as { process: { argv: string[] } }).process.argv)
      : [];

  return {
    createServer: httpModule.createServer,
    pathToFileHref(path: string) {
      return urlModule.pathToFileURL(path).href;
    },
    argv,
  };
}

export async function startBackendServer(options: StartBackendServerOptions = {}) {
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

    if (request.method === 'GET') {
      const requestId = parseMediaStatusRequestId(request.url);
      if (requestId) {
        try {
          const status = await getHiggsfieldGenerationStatus(requestId);
          writeJson(response, 200, {
            ...status,
          });
        } catch (error) {
          writeJson(response, 502, {
            requestId,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Failed to fetch media generation status.',
          });
        }
        return;
      }
    }

    if (request.method === 'POST' && request.url === '/agent/turn') {
      let payload: unknown;
      try {
        const body = await readRequestBody(request);
        payload = parseJsonBody(body);
      } catch {
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

      if (payload.prompt.trim().length === 0) {
        writeJson(response, 400, {
          accepted: false,
          failure: {
            code: 'invalid_request',
            message: 'Prompt cannot be empty.',
            retryable: false,
          },
        });
        return;
      }

      if (!payload.invocation?.mentionDetected) {
        writeJson(response, 400, {
          accepted: false,
          failure: {
            code: 'invalid_request',
            message: 'AI commands require an explicit @agent mention.',
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
        let responsePayload: AgentTurnResponse = result;

        const maxActions = getMaxActionsPerTurn();
        if (result.actions.length > maxActions) {
          const failure: FailureEnvelope = {
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
      } catch (error) {
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

    if (request.method === 'POST' && request.url === '/voice/room') {
      let payload: unknown;
      try {
        const body = await readRequestBody(request);
        payload = parseJsonBody(body);
      } catch {
        writeJson(response, 400, {
          error: 'Request body must be valid JSON.',
        });
        return;
      }

      if (!isObject(payload) || typeof payload.roomId !== 'string' || typeof payload.sessionId !== 'string') {
        writeJson(response, 400, {
          error: 'roomId and sessionId are required.',
        });
        return;
      }

      const apiKey = getEnv('DAILY_API_KEY');
      if (!apiKey) {
        writeJson(response, 501, {
          error: 'Voice provider is not configured. Set DAILY_API_KEY on backend.',
        });
        return;
      }

      const roomName = sanitizeDailyRoomName(payload.roomId);
      const userDisplayName = normalizeDisplayName(payload.displayName, payload.sessionId);
      try {
        const roomUrl = await ensureDailyRoom(roomName, apiKey);
        const tokenPayload = await createDailyMeetingToken(roomName, userDisplayName, apiKey);
        writeJson(response, 200, {
          provider: 'daily',
          roomUrl,
          token: tokenPayload.token,
          expiresAt: tokenPayload.expiresAt,
        });
      } catch (error) {
        writeJson(response, 502, {
          error: error instanceof Error ? error.message : 'Failed to initialize voice room.',
        });
      }
      return;
    }

    writeJson(response, 404, {
      error: 'Not found',
      path: request.url ?? '/',
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });

  return {
    port,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
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
  const isEntrypoint =
    runtime.argv.length > 1 &&
    import.meta.url === runtime.pathToFileHref(runtime.argv[1]);

  if (!isEntrypoint) {
    return;
  }

  const started = await startBackendServer({ port: backendPort });
  // eslint-disable-next-line no-console
  console.log(`backend listening on http://localhost:${started.port}`);
}

void runBackendServerCli();
