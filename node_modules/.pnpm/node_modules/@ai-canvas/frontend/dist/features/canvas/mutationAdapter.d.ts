import type { CanvasActionEnvelope } from '@ai-canvas/shared';
export interface CanvasMutationOperation {
    kind: 'create' | 'update' | 'delete' | 'batch';
    targetIds: string[];
    payload: Record<string, unknown>;
}
export interface CanvasMutationPlan {
    actionId: string;
    roomId: string;
    turnId: string;
    source: CanvasActionEnvelope['source'];
    suppressAgentRetrigger: boolean;
    operations: CanvasMutationOperation[];
}
export declare function applyCanvasAction(action: CanvasActionEnvelope): CanvasMutationPlan;
//# sourceMappingURL=mutationAdapter.d.ts.map