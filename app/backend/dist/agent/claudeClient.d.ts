import type { AgentTurnRequest, AgentTurnResponse } from '../types/contracts.js';
export type NodeType = 'sticky' | 'text' | 'geo';
export type GeoShape = 'rectangle' | 'ellipse' | 'diamond' | 'triangle' | 'parallelogram' | 'cloud' | 'hexagon';
export type ShapeColor = 'black' | 'grey' | 'light-violet' | 'violet' | 'blue' | 'light-blue' | 'yellow' | 'orange' | 'green' | 'light-green' | 'light-red' | 'red';
export interface AIPlanNode {
    key: string;
    type: NodeType;
    text: string;
    x: number;
    y: number;
    shape?: GeoShape;
    w?: number;
    h?: number;
    color?: ShapeColor;
}
export interface AIPlanEdge {
    from: string;
    to: string;
    label?: string;
}
/** Update or move an existing shape already on the canvas. */
export interface AIPlanUpdate {
    id: string;
    text?: string;
    x?: number;
    y?: number;
}
/** Delete an existing shape from the canvas. */
export interface AIPlanDelete {
    id: string;
}
/** Group related shapes so they can be moved together. */
export interface AIPlanCluster {
    shapeIds: string[];
    label?: string;
}
export type AIMediaType = 'image' | 'video';
export interface AIPlanMediaRequest {
    key: string;
    mediaType: AIMediaType;
    prompt: string;
    x: number;
    y: number;
    aspectRatio?: string;
    resolution?: string;
    modelId?: string;
}
export interface AIPlan {
    message?: string;
    nodes: AIPlanNode[];
    edges: AIPlanEdge[];
    updates?: AIPlanUpdate[];
    deletes?: AIPlanDelete[];
    clusters?: AIPlanCluster[];
    media?: AIPlanMediaRequest[];
}
export declare function streamGeminiTurn(request: AgentTurnRequest): Promise<AgentTurnResponse>;
//# sourceMappingURL=claudeClient.d.ts.map