export interface AgentTriggerProps {
  onTrigger: () => void;
}

export interface AgentTriggerMatch {
  hasTrigger: boolean;
  triggerCount: number;
  cleanedText: string;
}

export function detectAgentTrigger(text: string): AgentTriggerMatch {
  const triggerCount = (text.match(/@agent\b/gi) ?? []).length;
  return {
    hasTrigger: triggerCount > 0,
    triggerCount,
    cleanedText: text.replace(/@agent\b/gi, '').replace(/\s{2,}/g, ' ').trim(),
  };
}

export function AgentTrigger({ onTrigger }: AgentTriggerProps) {
  void onTrigger;
  return null;
}
