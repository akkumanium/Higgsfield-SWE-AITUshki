import type { AgentTurnRequest, AgentTurnResponse } from '../types/contracts.js';
type LayoutKind = 'hub' | 'linear' | 'grid' | 'free';
type NodeRole = 'title' | 'point' | 'note' | 'takeaway';
export interface AIPlanNode {
    key: string;
    text: string;
    role: NodeRole;
}
export interface AIPlanEdge {
    from: string;
    to: string;
}
export interface AIPlan {
    message?: string;
    layout: LayoutKind;
    nodes: AIPlanNode[];
    edges: AIPlanEdge[];
}
export declare function streamGeminiTurn(request: AgentTurnRequest): Promise<AgentTurnResponse>;
export {};
//# sourceMappingURL=claudeClient.d.ts.map