export interface AgentTriggerMatch {
    hasTrigger: boolean;
    triggerCount: number;
    cleanedText: string;
}
export interface AgentTriggerDetail {
    roomId: string;
    sessionId: string;
    source: 'chat' | 'canvas' | 'panel';
    displayName?: string;
    rawPrompt: string;
    mentionDetected: boolean;
    prompt: string;
}
export declare const agentTriggerEventName = "ai-canvas.agent-trigger";
export declare function normalizeAgentPrompt(text: string): string;
export declare function detectAgentTrigger(text: string): AgentTriggerMatch;
export declare function createAgentTriggerEvent(detail: AgentTriggerDetail): CustomEvent<AgentTriggerDetail>;
//# sourceMappingURL=AgentTrigger.d.ts.map