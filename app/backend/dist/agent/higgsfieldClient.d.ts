export type HiggsfieldRequestStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw';
export type HiggsfieldMediaType = 'image' | 'video';
export interface HiggsfieldGenerationSubmitInput {
    mediaType: HiggsfieldMediaType;
    prompt: string;
    modelId?: string;
    aspectRatio?: string;
    resolution?: string;
    webhookUrl?: string;
    extra?: Record<string, unknown>;
}
export interface HiggsfieldGenerationResult {
    status: HiggsfieldRequestStatus;
    requestId: string;
    statusUrl?: string;
    cancelUrl?: string;
    imageUrl?: string;
    videoUrl?: string;
    error?: string;
}
export declare function submitHiggsfieldGeneration(input: HiggsfieldGenerationSubmitInput): Promise<HiggsfieldGenerationResult>;
export declare function getHiggsfieldGenerationStatus(requestId: string): Promise<HiggsfieldGenerationResult>;
//# sourceMappingURL=higgsfieldClient.d.ts.map