export interface AgentTriggerMatch {
  hasTrigger: boolean;
  triggerCount: number;
  cleanedText: string;
}

export interface AgentTriggerDetail {
  roomId: string;
  sessionId: string;
  prompt: string;
}

export const agentTriggerEventName = 'ai-canvas.agent-trigger';

export function normalizeAgentPrompt(text: string): string {
  return text.replace(/@agent\b/gi, '').replace(/\s{2,}/g, ' ').trim();
}

export function detectAgentTrigger(text: string): AgentTriggerMatch {
  const triggerCount = (text.match(/@agent\b/gi) ?? []).length;
  return {
    hasTrigger: triggerCount > 0,
    triggerCount,
    cleanedText: normalizeAgentPrompt(text),
  };
}

export function createAgentTriggerEvent(detail: AgentTriggerDetail): CustomEvent<AgentTriggerDetail> {
  return new CustomEvent(agentTriggerEventName, {
    detail: {
      roomId: detail.roomId,
      sessionId: detail.sessionId,
      prompt: normalizeAgentPrompt(detail.prompt),
    },
  });
}
