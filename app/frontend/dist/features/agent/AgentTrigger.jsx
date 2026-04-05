export const agentTriggerEventName = 'ai-canvas.agent-trigger';
export function normalizeAgentPrompt(text) {
    return text.replace(/@agent\b/gi, '').replace(/\s{2,}/g, ' ').trim();
}
export function detectAgentTrigger(text) {
    const triggerCount = (text.match(/@agent\b/gi) ?? []).length;
    return {
        hasTrigger: triggerCount > 0,
        triggerCount,
        cleanedText: normalizeAgentPrompt(text),
    };
}
export function createAgentTriggerEvent(detail) {
    return new CustomEvent(agentTriggerEventName, {
        detail: {
            roomId: detail.roomId,
            sessionId: detail.sessionId,
            source: detail.source,
            displayName: detail.displayName,
            rawPrompt: detail.rawPrompt,
            mentionDetected: detail.mentionDetected,
            prompt: normalizeAgentPrompt(detail.prompt),
        },
    });
}
//# sourceMappingURL=AgentTrigger.jsx.map