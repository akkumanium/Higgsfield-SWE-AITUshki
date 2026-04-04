import { streamGeminiTurn } from './claudeClient.js';
function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}
const env = globalThis.process?.env;
if (!env) {
    throw new Error('Process environment is unavailable in this runtime.');
}
env.AGENT_MAX_TOOLS_PER_TURN = env.AGENT_MAX_TOOLS_PER_TURN ?? '9';
delete env.GEMINI_API_KEY;
delete env.GOOGLE_API_KEY;
const request = {
    roomId: 'room-invariant',
    sessionId: 'session-invariant',
    turnId: 'turn-invariant',
    prompt: 'why are apples healthy',
    context: {
        roomId: 'room-invariant',
        sessionId: 'session-invariant',
        viewport: {
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
        },
        maxShapes: 100,
    },
};
const response = await streamGeminiTurn(request);
const completedToolCalls = (response.events ?? [])
    .filter((event) => event.type === 'agent.stream.tool_call.completed')
    .map((event) => event.toolCall);
const placeStickyCalls = completedToolCalls.filter((call) => call.toolName === 'place_sticky');
const arrowCalls = completedToolCalls.filter((call) => call.toolName === 'draw_arrow');
assert(placeStickyCalls.length > 0, 'plan must contain at least one node (place_sticky call)');
const minX = request.context.viewport.x;
const minY = request.context.viewport.y;
const maxX = request.context.viewport.x + request.context.viewport.width;
const maxY = request.context.viewport.y + request.context.viewport.height;
const nodeById = new Map();
for (const sticky of placeStickyCalls) {
    const id = sticky.arguments.id;
    const text = sticky.arguments.text;
    const x = sticky.arguments.x;
    const y = sticky.arguments.y;
    assert(typeof id === 'string' && id.length > 0, 'node id must be a non-empty string');
    assert(typeof text === 'string' && text.trim().length > 0, 'node text must be a non-empty string');
    assert(typeof x === 'number' && Number.isFinite(x), 'node x must be a finite number');
    assert(typeof y === 'number' && Number.isFinite(y), 'node y must be a finite number');
    assert(x >= minX && x <= maxX, 'node x must be inside viewport bounds');
    assert(y >= minY && y <= maxY, 'node y must be inside viewport bounds');
    const keyMatch = id.match(/^shape-[^-]+-(.+)$/);
    assert(keyMatch !== null && keyMatch[1].length > 0, 'node id must include a stable key suffix');
    const key = keyMatch[1];
    assert(![...nodeById.values()].some((node) => node.key === key), 'node keys must be unique');
    nodeById.set(id, { id, key, text, x, y });
}
for (const arrow of arrowCalls) {
    const fromShapeId = arrow.arguments.fromShapeId;
    const toShapeId = arrow.arguments.toShapeId;
    assert(typeof fromShapeId === 'string' && nodeById.has(fromShapeId), 'edge source must reference an existing node key');
    assert(typeof toShapeId === 'string' && nodeById.has(toShapeId), 'edge target must reference an existing node key');
    assert(fromShapeId !== toShapeId, 'edge must not self-reference');
}
const maxToolsPerTurn = Number(env.AGENT_MAX_TOOLS_PER_TURN ?? '6');
assert(completedToolCalls.length <= maxToolsPerTurn, 'tool calls must respect AGENT_MAX_TOOLS_PER_TURN');
console.log('geminiClient planner invariant test passed');
//# sourceMappingURL=geminiClient.invariant.test.js.map