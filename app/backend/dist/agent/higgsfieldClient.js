const defaultApiBaseUrl = 'https://platform.higgsfield.ai';
const defaultImageModel = 'higgsfield-ai/soul/standard';
const defaultVideoModel = 'higgsfield-ai/soul/standard';
const defaultAspectRatio = '16:9';
const defaultResolution = '720p';
const defaultTimeoutMs = 45_000;
function getEnv(name) {
    const maybeProcess = globalThis.process;
    return maybeProcess?.env?.[name];
}
function getConfiguredApiBaseUrl() {
    return getEnv('HIGGSFIELD_API_BASE_URL') ?? defaultApiBaseUrl;
}
function getConfiguredAuth() {
    const key = getEnv('HIGGSFIELD_API_KEY')?.trim() ?? '';
    const secret = getEnv('HIGGSFIELD_API_SECRET')?.trim() ?? '';
    if (!key || !secret) {
        throw new Error('Higgsfield credentials missing. Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.');
    }
    return { key, secret };
}
function getConfiguredTimeoutMs() {
    const value = Number(getEnv('HIGGSFIELD_TIMEOUT_MS') ?? defaultTimeoutMs);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultTimeoutMs;
}
function getDefaultModel(mediaType) {
    if (mediaType === 'video') {
        return getEnv('HIGGSFIELD_VIDEO_MODEL') ?? defaultVideoModel;
    }
    return getEnv('HIGGSFIELD_IMAGE_MODEL') ?? defaultImageModel;
}
function normalizeStatus(value) {
    if (typeof value !== 'string') {
        return 'failed';
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'queued' ||
        normalized === 'in_progress' ||
        normalized === 'completed' ||
        normalized === 'failed' ||
        normalized === 'nsfw') {
        return normalized;
    }
    return 'failed';
}
function normalizeQueueResponse(body) {
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    if (!requestId) {
        throw new Error('Higgsfield response missing request_id.');
    }
    const imageUrl = Array.isArray(body.images) && body.images.length > 0 && typeof body.images[0]?.url === 'string'
        ? body.images[0].url
        : undefined;
    const videoUrl = typeof body.video?.url === 'string' ? body.video.url : undefined;
    return {
        status: normalizeStatus(body.status),
        requestId,
        statusUrl: typeof body.status_url === 'string' ? body.status_url : undefined,
        cancelUrl: typeof body.cancel_url === 'string' ? body.cancel_url : undefined,
        imageUrl,
        videoUrl,
        error: typeof body.error === 'string' ? body.error : undefined,
    };
}
function toModelPath(modelId) {
    return modelId
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
}
async function readJsonResponse(response) {
    const rawText = await response.text();
    if (rawText.trim().length === 0) {
        return {};
    }
    try {
        return JSON.parse(rawText);
    }
    catch {
        throw new Error(`Higgsfield returned non-JSON payload (status ${response.status}).`);
    }
}
export async function submitHiggsfieldGeneration(input) {
    const { key, secret } = getConfiguredAuth();
    const apiBaseUrl = getConfiguredApiBaseUrl().replace(/\/$/, '');
    const timeoutMs = getConfiguredTimeoutMs();
    const modelId = (input.modelId ?? getDefaultModel(input.mediaType)).trim();
    if (!modelId) {
        throw new Error(`Missing Higgsfield model id for media type '${input.mediaType}'.`);
    }
    const prompt = input.prompt.trim();
    if (!prompt) {
        throw new Error('Higgsfield prompt must be non-empty.');
    }
    const aspectRatio = (input.aspectRatio ?? getEnv('HIGGSFIELD_DEFAULT_ASPECT_RATIO') ?? defaultAspectRatio).trim();
    const resolution = (input.resolution ?? getEnv('HIGGSFIELD_DEFAULT_RESOLUTION') ?? defaultResolution).trim();
    const webhookParam = (input.webhookUrl ?? getEnv('HIGGSFIELD_WEBHOOK_URL') ?? '').trim();
    const requestUrl = webhookParam.length > 0
        ? `${apiBaseUrl}/${toModelPath(modelId)}?hf_webhook=${encodeURIComponent(webhookParam)}`
        : `${apiBaseUrl}/${toModelPath(modelId)}`;
    const body = {
        prompt,
        aspect_ratio: aspectRatio,
        resolution,
        ...(input.extra ?? {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: {
                Authorization: `Key ${key}:${secret}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const parsed = await readJsonResponse(response);
        if (!response.ok) {
            const error = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
            throw new Error(`Higgsfield submit failed: ${error}`);
        }
        return normalizeQueueResponse(parsed);
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Higgsfield submit timed out after ${timeoutMs}ms.`);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
export async function getHiggsfieldGenerationStatus(requestId) {
    const { key, secret } = getConfiguredAuth();
    const apiBaseUrl = getConfiguredApiBaseUrl().replace(/\/$/, '');
    const timeoutMs = getConfiguredTimeoutMs();
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
        throw new Error('requestId is required.');
    }
    const requestUrl = `${apiBaseUrl}/requests/${encodeURIComponent(normalizedRequestId)}/status`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(requestUrl, {
            method: 'GET',
            headers: {
                Authorization: `Key ${key}:${secret}`,
                Accept: 'application/json',
            },
            signal: controller.signal,
        });
        const parsed = await readJsonResponse(response);
        if (!response.ok) {
            const error = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
            throw new Error(`Higgsfield status failed: ${error}`);
        }
        return normalizeQueueResponse(parsed);
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Higgsfield status timed out after ${timeoutMs}ms.`);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=higgsfieldClient.js.map