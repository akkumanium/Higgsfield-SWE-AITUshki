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
const clusterCalls = completedToolCalls.filter((call) => call.toolName === 'cluster_shapes');
assert(placeStickyCalls.length === 5, 'must emit exactly 5 place_sticky calls');
assert(arrowCalls.length >= 2, 'must emit at least 2 draw_arrow calls');
assert(clusterCalls.length === 1, 'must emit exactly 1 cluster_shapes call');
const stickyIds = new Set(placeStickyCalls
    .map((call) => call.arguments.id)
    .filter((value) => typeof value === 'string' && value.length > 0));
for (const arrow of arrowCalls) {
    const fromShapeId = arrow.arguments.fromShapeId;
    const toShapeId = arrow.arguments.toShapeId;
    assert(typeof fromShapeId === 'string' && stickyIds.has(fromShapeId), 'arrow source must reference a sticky ID');
    assert(typeof toShapeId === 'string' && stickyIds.has(toShapeId), 'arrow target must reference a sticky ID');
}
const clusterShapeIds = clusterCalls[0]?.arguments.shapeIds;
assert(Array.isArray(clusterShapeIds), 'cluster shapeIds must be an array');
for (const shapeId of clusterShapeIds) {
    assert(typeof shapeId === 'string' && stickyIds.has(shapeId), 'cluster member must reference a sticky ID');
}
const maxToolsPerTurn = Number(env.AGENT_MAX_TOOLS_PER_TURN ?? '6');
assert(completedToolCalls.length <= maxToolsPerTurn, 'tool calls must respect AGENT_MAX_TOOLS_PER_TURN');
console.log('geminiClient planner invariant test passed');
//# sourceMappingURL=geminiClient.invariant.test.js.map