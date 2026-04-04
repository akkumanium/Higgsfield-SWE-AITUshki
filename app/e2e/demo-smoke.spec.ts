import type {
  AgentStreamEvent,
  AgentTurnRequest,
  AgentTurnResponse,
  CanvasActionEnvelope,
  SyncClientActionMessage,
  SyncClientJoinMessage,
  SyncServerActionAckMessage,
  SyncServerActionMessage,
  SyncServerMessage,
  SyncServerSnapshotMessage,
} from '@ai-canvas/shared';
import { startBackendServer } from '../backend/src/server.js';
import { startSyncServer } from '../sync-server/src/index.js';

const backendPort = 3101;
const syncPort = 3102;
const roomId = 'smoke-room';

interface SmokeStepResult {
  name: string;
  passed: boolean;
  details?: string;
}

export interface DemoSmokeReport {
  name: string;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  steps: SmokeStepResult[];
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected: ${String(expected)}, actual: ${String(actual)})`);
  }
}

function createJoin(room: string, sessionId: string): SyncClientJoinMessage {
  return {
    type: 'join',
    messageId: createId('join'),
    roomId: room,
    sessionId,
  };
}

function createActionMessage(
  sessionId: string,
  action: CanvasActionEnvelope,
): SyncClientActionMessage {
  return {
    type: 'action',
    messageId: createId('msg'),
    roomId: action.roomId,
    sessionId,
    metadata: {
      requestId: createId('request'),
      idempotencyKey: `idemp:${action.id}`,
      attempt: 1,
      maxAttempts: 3,
      sentAt: new Date().toISOString(),
    },
    action,
  };
}

function waitForOpen(socket: WebSocket, timeoutMs = 5_000): Promise<void> {
  if (socket.readyState === socket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error('WebSocket open failed.'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket did not open in time.'));
    }, timeoutMs);

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

function waitForMessage<T extends SyncServerMessage>(
  socket: WebSocket,
  predicate: (message: SyncServerMessage) => message is T,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const text = typeof event.data === 'string' ? event.data : String(event.data);
        const parsed = JSON.parse(text) as SyncServerMessage;
        if (!predicate(parsed)) {
          return;
        }
        cleanup();
        resolve(parsed);
      } catch {
        // Ignore invalid payloads.
      }
    };

    const onError = () => {
      cleanup();
      reject(new Error('WebSocket encountered an error while waiting for a message.'));
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for expected sync message.'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

function parseSseBody(text: string): { events: AgentStreamEvent[]; result: AgentTurnResponse | null } {
  const chunks = text.split('\n\n').map((frame) => frame.trim()).filter((frame) => frame.length > 0);
  const events: AgentStreamEvent[] = [];
  let result: AgentTurnResponse | null = null;

  for (const chunk of chunks) {
    const eventLine = chunk.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine) {
      continue;
    }

    const eventName = eventLine.replace('event: ', '').trim();
    const payload = JSON.parse(dataLine.replace('data: ', '')) as unknown;
    if (eventName === 'agent.turn.result') {
      result = payload as AgentTurnResponse;
    } else {
      events.push(payload as AgentStreamEvent);
    }
  }

  return {
    events,
    result,
  };
}

async function requestAgentTurn(): Promise<AgentTurnResponse> {
  const payload: AgentTurnRequest = {
    roomId,
    sessionId: 'session-a',
    turnId: createId('turn'),
    prompt: 'cluster these notes',
    context: {
      roomId,
      sessionId: 'session-a',
      viewport: {
        x: 0,
        y: 0,
        width: 1200,
        height: 800,
      },
      maxShapes: 120,
    },
  };

  const response = await fetch(`http://localhost:${backendPort}/agent/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
  });

  assertEqual(response.status, 200, 'Agent endpoint should return 200.');
  const body = await response.text();
  const parsed = parseSseBody(body);
  assertCondition(parsed.result, 'SSE should include a final turn result.');

  return parsed.result as AgentTurnResponse;
}

export async function runDemoSmokeSpec(): Promise<DemoSmokeReport> {
  const startedAt = new Date().toISOString();
  const steps: SmokeStepResult[] = [];
  const backend = await startBackendServer({ port: backendPort });
  const sync = await startSyncServer(syncPort);

  const socketA = new WebSocket(`ws://localhost:${syncPort}`);
  const socketB = new WebSocket(`ws://localhost:${syncPort}`);

  try {
    await Promise.all([waitForOpen(socketA), waitForOpen(socketB)]);
    socketA.send(JSON.stringify(createJoin(roomId, 'session-a')));
    socketB.send(JSON.stringify(createJoin(roomId, 'session-b')));

    const [snapshotA, snapshotB] = await Promise.all([
      waitForMessage(socketA, (message): message is SyncServerSnapshotMessage => message.type === 'room.snapshot'),
      waitForMessage(socketB, (message): message is SyncServerSnapshotMessage => message.type === 'room.snapshot'),
    ]);

    assertEqual(snapshotA.roomId, roomId, 'Socket A snapshot should match room id.');
    assertEqual(snapshotB.roomId, roomId, 'Socket B snapshot should match room id.');
    steps.push({ name: 'room join and snapshot', passed: true });

    const result = await requestAgentTurn();
    assertEqual(result.accepted, true, 'Agent turn should be accepted.');
    assertCondition(result.actions.length > 0, 'Agent turn should emit at least one action.');
    const action = result.actions[0];
    steps.push({ name: 'backend agent turn', passed: true, details: `planned ${result.actions.length} action(s)` });

    const ackPromise = waitForMessage(
      socketA,
      (message): message is SyncServerActionAckMessage => message.type === 'room.ack' && message.actionId === action.id,
    );
    const actionBroadcastPromise = waitForMessage(
      socketB,
      (message): message is SyncServerActionMessage => message.type === 'room.action' && message.action.id === action.id,
    );

    socketA.send(JSON.stringify(createActionMessage('session-a', action)));
    const [ack, broadcast] = await Promise.all([ackPromise, actionBroadcastPromise]);
    assertEqual(ack.accepted, true, 'Sync server should accept first action.');
    assertEqual(ack.duplicate, false, 'First action should not be marked duplicate.');
    assertEqual(broadcast.action.id, action.id, 'Second client should receive broadcast action.');
    steps.push({ name: 'sync action propagation', passed: true });

    socketA.send(JSON.stringify(createActionMessage('session-a', action)));
    const duplicateAck = await waitForMessage(
      socketA,
      (message): message is SyncServerActionAckMessage => message.type === 'room.ack' && message.actionId === action.id,
    );
    assertEqual(duplicateAck.duplicate, true, 'Repeated action id should be treated as duplicate.');
    steps.push({ name: 'idempotency duplicate ack', passed: true });

    return {
      name: 'demo smoke',
      status: 'passed',
      startedAt,
      finishedAt: new Date().toISOString(),
      steps,
    };
  } catch (error) {
    steps.push({
      name: 'smoke run',
      passed: false,
      details: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      name: 'demo smoke',
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      steps,
    };
  } finally {
    if (socketA.readyState === socketA.OPEN || socketA.readyState === socketA.CONNECTING) {
      socketA.close();
    }
    if (socketB.readyState === socketB.OPEN || socketB.readyState === socketB.CONNECTING) {
      socketB.close();
    }
    await Promise.all([backend.close(), sync.close()]);
  }
}

export const demoSmokeSpec = {
  name: 'demo smoke',
  run: runDemoSmokeSpec,
};
