import { validateToolArguments } from './tools.js';
export function executeToolCall(roomId, toolCall) {
    const validation = validateToolArguments(toolCall.toolName, toolCall.arguments);
    if (!validation.valid) {
        throw new Error(`Invalid arguments for ${toolCall.toolName}: ${validation.missingKeys.join(', ')}`);
    }
    return {
        id: toolCall.id,
        roomId,
        turnId: toolCall.turnId,
        source: 'agent',
        kind: 'shape.batch',
        payload: {
            toolName: toolCall.toolName,
            arguments: toolCall.arguments,
            validation,
        },
        createdAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=toolExecutor.js.map