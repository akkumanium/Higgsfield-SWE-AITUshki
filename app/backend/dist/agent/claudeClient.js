// geminiClient.ts — AI-First Canvas Planner
// Supports: sticky notes, geo shapes, text labels, bound arrows, update, delete
import { executeToolCall } from './toolExecutor.js';
import { createToolEnvelope } from './tools.js';
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const geminiApiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const defaultGeminiModel = 'gemini-2.5-flash';
const defaultTimeoutMs = 45_000;
const defaultMaxToolsPerTurn = 20;
const defaultMaxOutputTokens = 8192;
const plannerDebugFlag = 'AGENT_PLANNER_DEBUG';
const plannerDebugDefaultEnabled = true;
// Default sticky dimensions (note shape)
const STICKY_W = 200;
const STICKY_H = 120;
// Default geo dimensions when AI doesn't specify
const DEFAULT_GEO_W = 160;
const DEFAULT_GEO_H = 80;
const MAX_NODE_TEXT = 300;
const MAX_MESSAGE_TEXT = 2000;
const MAX_NODES_HARD = 32;
const MAX_MEDIA_HARD = 8;
const MAX_VALIDATION_TRACE_ISSUES = 120;
function isPlannerDebugEnabled() {
    const value = getEnv(plannerDebugFlag);
    if (!value)
        return plannerDebugDefaultEnabled;
    const normalized = value.trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(normalized);
}
function safeJson(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return JSON.stringify({ unserializable: true, stringValue: String(value) });
    }
}
function serializeError(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    return {
        message: String(error),
    };
}
function logPlanner(level, event, payload) {
    const shouldLog = isPlannerDebugEnabled() || level === 'warn' || level === 'error';
    if (!shouldLog)
        return;
    const line = safeJson({
        scope: 'planner',
        level,
        event,
        at: new Date().toISOString(),
        ...payload,
    });
    if (level === 'error') {
        console.error(line);
        return;
    }
    if (level === 'warn') {
        console.warn(line);
        return;
    }
    console.log(line);
}
// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------
function getEnv(name) {
    const maybeProcess = globalThis.process;
    return maybeProcess?.env?.[name];
}
function getConfiguredApiKey() {
    return getEnv('GEMINI_API_KEY') ?? getEnv('GOOGLE_API_KEY');
}
function getConfiguredModel() {
    return getEnv('GEMINI_MODEL') ?? getEnv('GOOGLE_MODEL') ?? defaultGeminiModel;
}
function getConfiguredTimeoutMs() {
    const v = Number(getEnv('GEMINI_TIMEOUT_MS') ?? getEnv('GOOGLE_TIMEOUT_MS') ?? defaultTimeoutMs);
    return Number.isFinite(v) && v > 0 ? v : defaultTimeoutMs;
}
function getConfiguredMaxOutputTokens() {
    const v = Number(getEnv('GEMINI_MAX_OUTPUT_TOKENS') ?? getEnv('GOOGLE_MAX_OUTPUT_TOKENS') ?? defaultMaxOutputTokens);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : defaultMaxOutputTokens;
}
function getConfiguredMaxToolsPerTurn() {
    const v = Number(getEnv('AGENT_MAX_TOOLS_PER_TURN') ?? defaultMaxToolsPerTurn);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : defaultMaxToolsPerTurn;
}
// ---------------------------------------------------------------------------
// Canvas context helpers
// ---------------------------------------------------------------------------
function extractRichText(richText) {
    if (typeof richText !== 'object' || richText === null)
        return '';
    const root = richText;
    const doc = root.doc ?? root;
    function walk(node) {
        if (typeof node !== 'object' || node === null)
            return '';
        const r = node;
        if (typeof r.text === 'string')
            return r.text;
        if (Array.isArray(r.content))
            return r.content.map(walk).join('');
        return '';
    }
    return walk(doc).replace(/\s+/g, ' ').trim();
}
function extractTextFromShape(record) {
    const props = typeof record.props === 'object' && record.props !== null
        ? record.props
        : {};
    if (props.richText !== undefined) {
        const rt = extractRichText(props.richText);
        if (rt.length > 0)
            return rt;
    }
    for (const v of [props.text, props.name, props.label, record.text]) {
        if (typeof v === 'string' && v.trim().length > 0)
            return v.trim();
    }
    if (typeof props.url === 'string' && props.url.trim().length > 0)
        return `[url: ${props.url.trim()}]`;
    return '';
}
function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function toPositiveFiniteNumber(value) {
    const n = toFiniteNumber(value);
    return n !== undefined && n > 0 ? n : undefined;
}
function inferFallbackShapeSize(shapeType, props) {
    const lowerType = shapeType.toLowerCase();
    if (lowerType === 'note' || lowerType === 'sticky') {
        return { width: STICKY_W, height: STICKY_H };
    }
    if (lowerType === 'geo') {
        return {
            width: toPositiveFiniteNumber(props.w) ?? DEFAULT_GEO_W,
            height: toPositiveFiniteNumber(props.h) ?? DEFAULT_GEO_H,
        };
    }
    if (lowerType === 'text') {
        return { width: 120, height: 40 };
    }
    return {
        width: toPositiveFiniteNumber(props.w) ?? 160,
        height: toPositiveFiniteNumber(props.h) ?? 100,
    };
}
function parseContextShapeLayout(shape) {
    if (typeof shape !== 'object' || shape === null) {
        return null;
    }
    const record = shape;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) {
        return null;
    }
    const type = typeof record.type === 'string'
        ? record.type
        : typeof record.kind === 'string'
            ? record.kind
            : 'unknown';
    const props = typeof record.props === 'object' && record.props !== null
        ? record.props
        : {};
    const fallbackSize = inferFallbackShapeSize(type, props);
    let width = fallbackSize.width;
    let height = fallbackSize.height;
    let centerX;
    let centerY;
    const bounds = typeof record.bounds === 'object' && record.bounds !== null
        ? record.bounds
        : null;
    const boundsX = toFiniteNumber(bounds?.x);
    const boundsY = toFiniteNumber(bounds?.y);
    const boundsW = toPositiveFiniteNumber(bounds?.width ?? bounds?.w);
    const boundsH = toPositiveFiniteNumber(bounds?.height ?? bounds?.h);
    if (boundsX !== undefined && boundsY !== undefined && boundsW !== undefined && boundsH !== undefined) {
        width = boundsW;
        height = boundsH;
        centerX = boundsX + boundsW / 2;
        centerY = boundsY + boundsH / 2;
    }
    else {
        const rawX = toFiniteNumber(record.x);
        const rawY = toFiniteNumber(record.y);
        width = toPositiveFiniteNumber(record.width ?? record.w ?? props.w) ?? fallbackSize.width;
        height = toPositiveFiniteNumber(record.height ?? record.h ?? props.h) ?? fallbackSize.height;
        if (rawX !== undefined && rawY !== undefined) {
            centerX = rawX + width / 2;
            centerY = rawY + height / 2;
        }
    }
    if (centerX === undefined || centerY === undefined) {
        return null;
    }
    return {
        id,
        type,
        text: extractTextFromShape(record),
        centerX,
        centerY,
        width,
        height,
    };
}
function getContextShapeLayouts(request) {
    const rawContext = request.context;
    const shapes = Array.isArray(rawContext.shapes) ? rawContext.shapes : [];
    return shapes
        .map((shape) => parseContextShapeLayout(shape))
        .filter((shape) => shape !== null);
}
function hasBoxCollision(candidate, occupied, padding) {
    return occupied.some((box) => {
        const minGapX = candidate.hw + box.hw + padding;
        const minGapY = candidate.hh + box.hh + padding;
        return Math.abs(candidate.x - box.x) < minGapX && Math.abs(candidate.y - box.y) < minGapY;
    });
}
function findNonCollidingBoxPosition(candidate, occupied, viewport, padding = 48, maxAttempts = 24) {
    const minX = viewport.x + candidate.hw + padding;
    const maxX = viewport.x + viewport.width - candidate.hw - padding;
    const minY = viewport.y + candidate.hh + padding;
    const maxY = viewport.y + viewport.height - candidate.hh - padding;
    const clamped = {
        ...candidate,
        x: clamp(candidate.x, minX, maxX),
        y: clamp(candidate.y, minY, maxY),
    };
    if (!hasBoxCollision(clamped, occupied, padding)) {
        return { x: clamped.x, y: clamped.y };
    }
    const baseGap = Math.max(candidate.hw * 2, candidate.hh * 2) + padding;
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
        const angle = (attempt * Math.PI) / 4;
        const distance = baseGap * (1 + attempt * 0.35);
        const testX = clamp(Math.round(clamped.x + Math.cos(angle) * distance), minX, maxX);
        const testY = clamp(Math.round(clamped.y + Math.sin(angle) * distance), minY, maxY);
        const test = { ...clamped, x: testX, y: testY };
        if (!hasBoxCollision(test, occupied, padding)) {
            return { x: testX, y: testY };
        }
    }
    const stepX = candidate.hw * 2 + padding;
    const stepY = candidate.hh * 2 + padding;
    for (let gx = minX; gx <= maxX; gx += stepX) {
        for (let gy = minY; gy <= maxY; gy += stepY) {
            const test = { ...clamped, x: gx, y: gy };
            if (!hasBoxCollision(test, occupied, padding)) {
                return { x: gx, y: gy };
            }
        }
    }
    return { x: clamped.x, y: clamped.y };
}
/**
 * Build a richer canvas context that includes shape IDs and positions so the
 * AI can reference existing shapes for updates and deletes.
 */
function buildCanvasContextSummary(request, contextShapes = getContextShapeLayouts(request)) {
    const rawContext = request.context;
    const totalShapes = Array.isArray(rawContext.shapes) ? rawContext.shapes.length : contextShapes.length;
    if (totalShapes === 0)
        return 'Canvas is empty.';
    const lines = [`Canvas has ${totalShapes} shape(s):`];
    contextShapes.slice(0, 48).forEach((shape) => {
        const text = shape.text.slice(0, 80);
        const label = text ? ` "${text}"` : ' (no text)';
        lines.push(`  id=${shape.id} type=${shape.type}${label} @ (${Math.round(shape.centerX)},${Math.round(shape.centerY)}) size=${Math.round(shape.width)}x${Math.round(shape.height)}`);
    });
    if (contextShapes.length > 48) {
        lines.push(`  ... and ${contextShapes.length - 48} more parsed shapes not shown.`);
    }
    if (totalShapes > contextShapes.length) {
        lines.push(`  ... ${totalShapes - contextShapes.length} shape(s) had incomplete bounds and were omitted from summary.`);
    }
    return lines.join('\n');
}
// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt(viewport) {
    const { x, y, width, height } = viewport;
    const cx = Math.round(x + width / 2);
    const cy = Math.round(y + height / 2);
    const minX = x + STICKY_W / 2 + 20;
    const maxX = x + width - STICKY_W / 2 - 20;
    const minY = y + STICKY_H / 2 + 20;
    const maxY = y + height - STICKY_H / 2 - 20;
    return `
You are a canvas layout AI for a tldraw whiteboard. Given a user request, decide what to create,
update, or delete on the canvas and exactly where.

Return ONLY a valid JSON object. No markdown, no code fences, no explanation — raw JSON only.

═══════════════════════════════════════════
CANVAS INFO
═══════════════════════════════════════════
Visible area: x=${x}, y=${y}, width=${width}, height=${height}
Center: (${cx}, ${cy})
Coordinate origin is the top-left of the page (positive y goes DOWN).
All x/y coordinates you output are the CENTER of the shape.
Valid center range: x ∈ [${minX}, ${maxX}], y ∈ [${minY}, ${maxY}]

═══════════════════════════════════════════
SHAPE TYPES — choose the right one
═══════════════════════════════════════════

1. "sticky" — Colored sticky note (${STICKY_W}×${STICKY_H}px). Best for: brainstorming, ideas, notes.
   Fields: key, type, text, x, y, color(optional)

2. "geo" — Geometric shape with a text label. Best for: flowcharts, diagrams, structured content.
   Fields: key, type, text, x, y, shape, w(optional), h(optional), color(optional)
   shape values: "rectangle" | "ellipse" | "diamond" | "triangle" | "parallelogram" | "cloud" | "hexagon"
   Default size: w=160, h=80. For process boxes use w=160,h=80. For decision diamonds use w=140,h=100.

3. "text" — Plain floating text label. Best for: headings, section titles, annotations.
   Fields: key, type, text, x, y, color(optional)
   Text shapes auto-size; no w/h needed.

Available colors: "black" | "grey" | "blue" | "light-blue" | "violet" | "light-violet"
                  | "red" | "light-red" | "orange" | "yellow" | "green" | "light-green"

═══════════════════════════════════════════
SPACING RULES
═══════════════════════════════════════════
- Shapes must NOT overlap. Leave at least 20px gap between shape edges.
- For stickies: gap between centers ≥ ${STICKY_W + 20}px horizontally, ${STICKY_H + 20}px vertically.
- For geo shapes: gap = shape dimensions + 30px padding.
- Spread across the full canvas — do NOT cluster everything in the center.
- Timelines / sequences: left-to-right OR top-to-bottom with even spacing.
- Mind maps: main topic at center, spokes radiate outward.
- Flowcharts: top-to-bottom, nodes aligned in columns.
- Comparison grids: align in rows and columns.

═══════════════════════════════════════════
ARROWS (edges)
═══════════════════════════════════════════
Arrows bind directly to shapes — you only specify source and target keys.
tldraw calculates the exact entry/exit points automatically.
- Sequences/timelines: connect each step to the next.
- Mind maps: hub → each spoke.
- Flowcharts: connect every decision branch.
- Comparisons: omit arrows unless they add meaning.
- label (optional): short text shown on the arrow (e.g., "yes", "no", "calls").

═══════════════════════════════════════════
UPDATES — editing existing shapes
═══════════════════════════════════════════
Use "updates" to change or move shapes already on the canvas.
Reference the shape's exact id from the canvas context.
You can change text, x, y, or any combination.

═══════════════════════════════════════════
DELETES — removing existing shapes
═══════════════════════════════════════════
Use "deletes" to remove shapes by id. Only delete shapes that appear in the canvas context.

═══════════════════════════════════════════
GROUPING — group related shapes together
═══════════════════════════════════════════
Use "clusters" to group related shapes so they move together.
- shapeIds can reference node keys you create in this plan and/or existing canvas shape ids.
- Prefer grouping only when the user asks to group or keep elements together.
- For grouping existing content, use exact ids from canvas context.

═══════════════════════════════════════════
MEDIA GENERATION — Higgsfield jobs
═══════════════════════════════════════════
Use "media" for generated assets when the user asks to create an image or a video.
- mediaType: "image" or "video"
- key: unique short id for this media request
- prompt: exact generation prompt
- x/y: center position for the placeholder card on canvas
- Optional tuning fields: aspectRatio, resolution, modelId
- Do not also add a sticky that duplicates the same media request.

═══════════════════════════════════════════
OUTPUT SCHEMA
═══════════════════════════════════════════
{
  "message": "<only for conversational replies — omit when placing/editing shapes>",
  "nodes": [
    { "key": "<unique_id>", "type": "sticky|geo|text", "text": "<label>",
      "x": <number>, "y": <number>,
      "shape": "<geo_shape>",   // geo only
      "w": <number>,            // geo only, optional
      "h": <number>,            // geo only, optional
      "color": "<color>"        // optional
    }
  ],
  "edges": [
    { "from": "<key>", "to": "<key>", "label": "<optional>" }
  ],
  "updates": [
    { "id": "<existing_shape_id>", "text": "<new_text>", "x": <number>, "y": <number> }
  ],
  "deletes": [
    { "id": "<existing_shape_id>" }
  ],
  "clusters": [
    { "shapeIds": ["<node_key_or_shape_id>", "<node_key_or_shape_id>"], "label": "<optional>" }
  ],
  "media": [
    {
      "key": "<unique_media_key>",
      "mediaType": "image|video",
      "prompt": "<generation prompt>",
      "x": <number>,
      "y": <number>,
      "aspectRatio": "<optional, e.g. 16:9>",
      "resolution": "<optional, e.g. 720p>",
      "modelId": "<optional model id>"
    }
  ]
}

═══════════════════════════════════════════
RULES
═══════════════════════════════════════════
- Maximum 12 new nodes per turn.
- Maximum 4 media requests per turn.
- Node text: short and specific — no filler words.
- Edges: only reference keys that exist in your nodes list.
- Conversational mode (user is chatting, not asking for canvas content):
  set nodes=[], edges=[], omit updates/deletes/clusters/media, put reply in "message".
- Canvas mode: omit "message" entirely.
- You can mix creates + updates + deletes + clusters + media in one response.
- Do not invent shape IDs for updates/deletes — use exact ids from the canvas context.

═══════════════════════════════════════════
WHEN TO USE EACH SHAPE TYPE
═══════════════════════════════════════════
- Brainstorming / ideas / notes         → sticky
- Flowchart / process / decision tree   → geo (rectangle, diamond)
- Timeline / sequence of events         → sticky (or geo rectangle)
- Mind map hub                          → geo (ellipse or rectangle)
- Mind map spokes                       → sticky
- Section headings / labels             → text
- Database / cylinder entity            → geo (could use rectangle)
- Swim lane titles                      → text

═══════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════

Prompt: "flowchart for user login" →
{
  "nodes": [
    { "key": "start",    "type": "geo", "shape": "ellipse",   "text": "Start",                 "x": ${cx},       "y": ${cy - 280}, "w": 100, "h": 60,  "color": "green" },
    { "key": "enter",    "type": "geo", "shape": "rectangle", "text": "Enter credentials",      "x": ${cx},       "y": ${cy - 160}, "w": 180, "h": 80 },
    { "key": "valid",    "type": "geo", "shape": "diamond",   "text": "Valid?",                 "x": ${cx},       "y": ${cy - 20},  "w": 140, "h": 100 },
    { "key": "home",     "type": "geo", "shape": "rectangle", "text": "Redirect to home",       "x": ${cx + 200}, "y": ${cy + 120}, "w": 180, "h": 80,  "color": "blue" },
    { "key": "error",    "type": "geo", "shape": "rectangle", "text": "Show error message",     "x": ${cx - 200}, "y": ${cy + 120}, "w": 180, "h": 80,  "color": "red" },
    { "key": "end",      "type": "geo", "shape": "ellipse",   "text": "End",                   "x": ${cx + 200}, "y": ${cy + 240}, "w": 100, "h": 60,  "color": "green" }
  ],
  "edges": [
    { "from": "start", "to": "enter" },
    { "from": "enter", "to": "valid" },
    { "from": "valid", "to": "home",  "label": "yes" },
    { "from": "valid", "to": "error", "label": "no" },
    { "from": "home",  "to": "end" }
  ]
}

Prompt: "timeline of WW2" →
{
  "nodes": [
    { "key": "e1", "type": "sticky", "text": "1939 — Germany invades Poland, war begins",    "x": ${cx - 500}, "y": ${cy} },
    { "key": "e2", "type": "sticky", "text": "1940 — Fall of France, Battle of Britain",      "x": ${cx - 300}, "y": ${cy} },
    { "key": "e3", "type": "sticky", "text": "1941 — Pearl Harbor, USA enters war",           "x": ${cx - 100}, "y": ${cy} },
    { "key": "e4", "type": "sticky", "text": "1943 — Stalingrad, turning point",              "x": ${cx + 100}, "y": ${cy} },
    { "key": "e5", "type": "sticky", "text": "1944 — D-Day landings",                         "x": ${cx + 300}, "y": ${cy} },
    { "key": "e6", "type": "sticky", "text": "1945 — Victory in Europe and Pacific",          "x": ${cx + 500}, "y": ${cy} }
  ],
  "edges": [
    {"from":"e1","to":"e2"},{"from":"e2","to":"e3"},{"from":"e3","to":"e4"},{"from":"e4","to":"e5"},{"from":"e5","to":"e6"}
  ]
}

Prompt: "add a title saying Project Roadmap at the top" →
{
  "nodes": [
    { "key": "title", "type": "text", "text": "Project Roadmap", "x": ${cx}, "y": ${y + 40}, "color": "black" }
  ],
  "edges": []
}

Prompt: "change the text of shape:abc123 to 'Done'" →
{
  "nodes": [],
  "edges": [],
  "updates": [{ "id": "shape:abc123", "text": "Done" }]
}

Prompt: "delete shape:xyz789" →
{
  "nodes": [],
  "edges": [],
  "deletes": [{ "id": "shape:xyz789" }]
}

Prompt: "group onboarding notes together" →
{
  "nodes": [
    { "key": "n1", "type": "sticky", "text": "Sign up", "x": ${cx - 260}, "y": ${cy} },
    { "key": "n2", "type": "sticky", "text": "Verify email", "x": ${cx - 20}, "y": ${cy} },
    { "key": "n3", "type": "sticky", "text": "Complete profile", "x": ${cx + 220}, "y": ${cy} }
  ],
  "edges": [
    { "from": "n1", "to": "n2" },
    { "from": "n2", "to": "n3" }
  ],
  "clusters": [
    { "shapeIds": ["n1", "n2", "n3"], "label": "Onboarding" }
  ]
}

Prompt: "generate a cover image for my roadmap" →
{
  "nodes": [],
  "edges": [],
  "media": [
    {
      "key": "roadmap_cover",
      "mediaType": "image",
      "prompt": "cinematic product roadmap cover, clean typography, teal and orange accents",
      "x": ${cx},
      "y": ${cy}
    }
  ]
}

Prompt: "create a short launch teaser video" →
{
  "nodes": [],
  "edges": [],
  "media": [
    {
      "key": "launch_teaser",
      "mediaType": "video",
      "prompt": "fast-paced product launch teaser, dynamic camera movement, modern office aesthetic",
      "x": ${cx},
      "y": ${cy}
    }
  ]
}

Prompt: "what can you do?" →
{ "nodes": [], "edges": [], "message": "I can create timelines, flowcharts, mind maps, comparison grids, and free-form notes. I can add arrows, headings, update/delete existing shapes, and trigger image or video generation jobs on request. What would you like to build?" }
`.trim();
}
// ---------------------------------------------------------------------------
// Sanitize and validate
// ---------------------------------------------------------------------------
function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
function normalizeKey(key) {
    return key
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32) || 'node';
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
/** Half-dimensions for a node (used for collision detection). */
function halfDims(node) {
    if (node.type === 'sticky')
        return { hw: STICKY_W / 2, hh: STICKY_H / 2 };
    if (node.type === 'geo') {
        return {
            hw: (node.w ?? DEFAULT_GEO_W) / 2,
            hh: (node.h ?? DEFAULT_GEO_H) / 2,
        };
    }
    // text: small footprint
    return { hw: 60, hh: 20 };
}
function findNonCollidingPosition(candidate, existing, viewport, padding = 20, maxAttempts = 24, occupiedBoxes = []) {
    const { hw, hh } = halfDims(candidate);
    const candidateBox = {
        id: `node:${candidate.key}`,
        x: candidate.x,
        y: candidate.y,
        hw,
        hh,
    };
    const existingBoxes = [
        ...existing.map((node) => {
            const dims = halfDims(node);
            return {
                id: `node:${node.key}`,
                x: node.x,
                y: node.y,
                hw: dims.hw,
                hh: dims.hh,
            };
        }),
        ...occupiedBoxes,
    ];
    return findNonCollidingBoxPosition(candidateBox, existingBoxes, viewport, padding, maxAttempts);
}
const VALID_NODE_TYPES = new Set(['sticky', 'text', 'geo']);
const VALID_GEO_SHAPES = new Set([
    'rectangle', 'ellipse', 'diamond', 'triangle', 'parallelogram', 'cloud', 'hexagon',
]);
const VALID_COLORS = new Set([
    'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue',
    'yellow', 'orange', 'green', 'light-green', 'light-red', 'red',
]);
function stripMarkdownFences(value) {
    const trimmed = value.trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match?.[1] !== undefined ? match[1].trim() : trimmed;
}
function createPlanValidationTrace(raw) {
    return {
        rawInputType: Array.isArray(raw) ? 'array' : typeof raw,
        inputCounts: {
            nodes: 0,
            edges: 0,
            updates: 0,
            deletes: 0,
            clusters: 0,
            media: 0,
        },
        acceptedCounts: {
            nodes: 0,
            edges: 0,
            updates: 0,
            deletes: 0,
            clusters: 0,
            media: 0,
        },
        droppedNodes: [],
        droppedEdges: [],
        droppedUpdates: [],
        droppedDeletes: [],
        droppedClusters: [],
        droppedMedia: [],
        outcome: 'invalid',
    };
}
function pushTraceIssue(target, message) {
    if (target.length >= MAX_VALIDATION_TRACE_ISSUES)
        return;
    target.push(message);
}
function sanitizeAndValidatePlan(raw, viewport, maxNodes, contextShapes = [], trace) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        if (trace) {
            trace.outcome = 'invalid';
            trace.invalidReason = 'Raw planner payload is not a JSON object.';
        }
        return null;
    }
    const obj = raw;
    const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
    const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];
    const rawUpdates = Array.isArray(obj.updates) ? obj.updates : [];
    const rawDeletes = Array.isArray(obj.deletes) ? obj.deletes : [];
    const rawClusters = Array.isArray(obj.clusters) ? obj.clusters : [];
    const rawMedia = Array.isArray(obj.media) ? obj.media : [];
    if (trace) {
        trace.inputCounts.nodes = rawNodes.length;
        trace.inputCounts.edges = rawEdges.length;
        trace.inputCounts.updates = rawUpdates.length;
        trace.inputCounts.deletes = rawDeletes.length;
        trace.inputCounts.clusters = rawClusters.length;
        trace.inputCounts.media = rawMedia.length;
    }
    const message = typeof obj.message === 'string' && obj.message.trim().length > 0
        ? truncate(obj.message.trim(), MAX_MESSAGE_TEXT)
        : undefined;
    const { x, y, width, height } = viewport;
    const minX = x + STICKY_W / 2 + 20;
    const maxX = x + width - STICKY_W / 2 - 20;
    const minY = y + STICKY_H / 2 + 20;
    const maxY = y + height - STICKY_H / 2 - 20;
    // ── Nodes ──────────────────────────────────────────────────────────────────
    const seenKeys = new Set();
    const placedNodes = [];
    const occupiedContextBoxes = contextShapes.map((shape) => ({
        id: shape.id,
        x: shape.centerX,
        y: shape.centerY,
        hw: Math.max(1, shape.width / 2),
        hh: Math.max(1, shape.height / 2),
    }));
    const maxAcceptedNodes = Math.min(MAX_NODES_HARD, maxNodes);
    rawNodes.slice(0, maxAcceptedNodes).forEach((n, index) => {
        if (typeof n !== 'object' || n === null) {
            if (trace)
                pushTraceIssue(trace.droppedNodes, `nodes[${index}] ignored: not an object.`);
            return;
        }
        const nr = n;
        const rawKey = typeof nr.key === 'string' ? nr.key.trim() : '';
        const key = normalizeKey(rawKey);
        if (key.length === 0) {
            if (trace)
                pushTraceIssue(trace.droppedNodes, `nodes[${index}] ignored: missing/invalid key.`);
            return;
        }
        if (seenKeys.has(key)) {
            if (trace)
                pushTraceIssue(trace.droppedNodes, `nodes[${index}] ignored: duplicate key '${key}'.`);
            return;
        }
        const rawType = typeof nr.type === 'string' ? nr.type.trim().toLowerCase() : 'sticky';
        const type = VALID_NODE_TYPES.has(rawType) ? rawType : 'sticky';
        const text = typeof nr.text === 'string' ? truncate(nr.text.trim(), MAX_NODE_TEXT) : '';
        if (text.length === 0) {
            if (trace)
                pushTraceIssue(trace.droppedNodes, `nodes[${index}] ignored: missing/empty text.`);
            return;
        }
        const rawX = typeof nr.x === 'number' ? nr.x : null;
        const rawY = typeof nr.y === 'number' ? nr.y : null;
        if (rawX === null || rawY === null || !Number.isFinite(rawX) || !Number.isFinite(rawY)) {
            if (trace)
                pushTraceIssue(trace.droppedNodes, `nodes[${index}] ignored: x/y must be finite numbers.`);
            return;
        }
        const color = typeof nr.color === 'string' && VALID_COLORS.has(nr.color) ? nr.color : undefined;
        let node = {
            key,
            type,
            text,
            x: clamp(rawX, minX, maxX),
            y: clamp(rawY, minY, maxY),
            color,
        };
        if (type === 'geo') {
            const rawShape = typeof nr.shape === 'string' ? nr.shape.trim().toLowerCase() : 'rectangle';
            node.shape = VALID_GEO_SHAPES.has(rawShape) ? rawShape : 'rectangle';
            const rawW = typeof nr.w === 'number' && nr.w > 0 ? nr.w : DEFAULT_GEO_W;
            const rawH = typeof nr.h === 'number' && nr.h > 0 ? nr.h : DEFAULT_GEO_H;
            node.w = Math.round(clamp(rawW, 40, 600));
            node.h = Math.round(clamp(rawH, 30, 400));
        }
        const contextBoxesForNode = node.type === 'text' ? [] : occupiedContextBoxes;
        const resolved = findNonCollidingPosition(node, placedNodes, viewport, 20, 24, contextBoxesForNode);
        node = { ...node, x: resolved.x, y: resolved.y };
        seenKeys.add(key);
        placedNodes.push(node);
    });
    if (trace && rawNodes.length > maxAcceptedNodes) {
        pushTraceIssue(trace.droppedNodes, `${rawNodes.length - maxAcceptedNodes} extra node(s) ignored due to max node budget (${maxAcceptedNodes}).`);
    }
    // ── Edges ──────────────────────────────────────────────────────────────────
    const edges = [];
    rawEdges.forEach((e, index) => {
        if (typeof e !== 'object' || e === null) {
            if (trace)
                pushTraceIssue(trace.droppedEdges, `edges[${index}] ignored: not an object.`);
            return;
        }
        const er = e;
        const from = normalizeKey(typeof er.from === 'string' ? er.from : '');
        const to = normalizeKey(typeof er.to === 'string' ? er.to : '');
        if (!from || !to) {
            if (trace)
                pushTraceIssue(trace.droppedEdges, `edges[${index}] ignored: missing from/to.`);
            return;
        }
        if (!seenKeys.has(from) || !seenKeys.has(to)) {
            if (trace)
                pushTraceIssue(trace.droppedEdges, `edges[${index}] ignored: references unknown key(s) '${from}' -> '${to}'.`);
            return;
        }
        if (from === to) {
            if (trace)
                pushTraceIssue(trace.droppedEdges, `edges[${index}] ignored: self-reference '${from}'.`);
            return;
        }
        const label = typeof er.label === 'string' && er.label.trim().length > 0
            ? truncate(er.label.trim(), 60)
            : undefined;
        edges.push({ from, to, label });
    });
    // ── Updates ────────────────────────────────────────────────────────────────
    const contextShapeById = new Map(contextShapes.map((shape) => [shape.id, shape]));
    const occupiedForUpdates = [
        ...occupiedContextBoxes,
        ...placedNodes.map((node) => {
            const dims = halfDims(node);
            return {
                id: `new:${node.key}`,
                x: node.x,
                y: node.y,
                hw: dims.hw,
                hh: dims.hh,
            };
        }),
    ];
    const updates = [];
    rawUpdates.slice(0, 20).forEach((u, index) => {
        if (typeof u !== 'object' || u === null) {
            if (trace)
                pushTraceIssue(trace.droppedUpdates, `updates[${index}] ignored: not an object.`);
            return;
        }
        const ur = u;
        const id = typeof ur.id === 'string' ? ur.id.trim() : '';
        if (!id) {
            if (trace)
                pushTraceIssue(trace.droppedUpdates, `updates[${index}] ignored: missing id.`);
            return;
        }
        const update = { id };
        if (typeof ur.text === 'string')
            update.text = truncate(ur.text.trim(), MAX_NODE_TEXT);
        if (typeof ur.x === 'number' && Number.isFinite(ur.x))
            update.x = ur.x;
        if (typeof ur.y === 'number' && Number.isFinite(ur.y))
            update.y = ur.y;
        const hasPositionPatch = update.x !== undefined || update.y !== undefined;
        if (hasPositionPatch) {
            const target = contextShapeById.get(id);
            if (target) {
                const candidate = {
                    id,
                    x: update.x ?? target.centerX,
                    y: update.y ?? target.centerY,
                    hw: Math.max(1, target.width / 2),
                    hh: Math.max(1, target.height / 2),
                };
                const occupiedWithoutTarget = occupiedForUpdates.filter((box) => box.id !== id);
                const resolved = findNonCollidingBoxPosition(candidate, occupiedWithoutTarget, viewport);
                update.x = resolved.x;
                update.y = resolved.y;
                const existingIndex = occupiedForUpdates.findIndex((box) => box.id === id);
                if (existingIndex >= 0) {
                    occupiedForUpdates[existingIndex] = { ...candidate, x: resolved.x, y: resolved.y };
                }
                else {
                    occupiedForUpdates.push({ ...candidate, x: resolved.x, y: resolved.y });
                }
            }
        }
        if (!update.text && update.x === undefined && update.y === undefined) {
            if (trace)
                pushTraceIssue(trace.droppedUpdates, `updates[${index}] ignored: must include text and/or x/y.`);
            return;
        }
        updates.push(update);
    });
    if (trace && rawUpdates.length > 20) {
        pushTraceIssue(trace.droppedUpdates, `${rawUpdates.length - 20} extra update(s) ignored due to cap of 20.`);
    }
    // ── Deletes ────────────────────────────────────────────────────────────────
    const deletes = [];
    rawDeletes.slice(0, 20).forEach((d, index) => {
        if (typeof d !== 'object' || d === null) {
            if (trace)
                pushTraceIssue(trace.droppedDeletes, `deletes[${index}] ignored: not an object.`);
            return;
        }
        const dr = d;
        const id = typeof dr.id === 'string' ? dr.id.trim() : '';
        if (!id) {
            if (trace)
                pushTraceIssue(trace.droppedDeletes, `deletes[${index}] ignored: missing id.`);
            return;
        }
        deletes.push({ id });
    });
    if (trace && rawDeletes.length > 20) {
        pushTraceIssue(trace.droppedDeletes, `${rawDeletes.length - 20} extra delete(s) ignored due to cap of 20.`);
    }
    // ── Clusters ───────────────────────────────────────────────────────────────
    const clusters = [];
    rawClusters.slice(0, 20).forEach((c, index) => {
        if (typeof c !== 'object' || c === null) {
            if (trace)
                pushTraceIssue(trace.droppedClusters, `clusters[${index}] ignored: not an object.`);
            return;
        }
        const cr = c;
        const shapeIds = Array.isArray(cr.shapeIds)
            ? cr.shapeIds
                .map((id) => (typeof id === 'string' ? id.trim() : ''))
                .filter((id) => id.length > 0)
            : [];
        if (shapeIds.length < 2) {
            if (trace)
                pushTraceIssue(trace.droppedClusters, `clusters[${index}] ignored: requires at least 2 shapeIds.`);
            return;
        }
        const uniqueShapeIds = [...new Set(shapeIds)].slice(0, 20);
        if (uniqueShapeIds.length < 2) {
            if (trace)
                pushTraceIssue(trace.droppedClusters, `clusters[${index}] ignored: not enough unique shapeIds.`);
            return;
        }
        const label = typeof cr.label === 'string' && cr.label.trim().length > 0
            ? truncate(cr.label.trim(), 80)
            : undefined;
        clusters.push({ shapeIds: uniqueShapeIds, label });
    });
    if (trace && rawClusters.length > 20) {
        pushTraceIssue(trace.droppedClusters, `${rawClusters.length - 20} extra cluster(s) ignored due to cap of 20.`);
    }
    // ── Media requests ────────────────────────────────────────────────────────
    const media = [];
    const seenMediaKeys = new Set();
    const maxMediaRequests = Math.min(MAX_MEDIA_HARD, maxNodes);
    rawMedia.slice(0, maxMediaRequests).forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
            if (trace)
                pushTraceIssue(trace.droppedMedia, `media[${index}] ignored: not an object.`);
            return;
        }
        const mediaRecord = entry;
        const key = normalizeKey(typeof mediaRecord.key === 'string' ? mediaRecord.key : '');
        if (!key) {
            if (trace)
                pushTraceIssue(trace.droppedMedia, `media[${index}] ignored: missing key.`);
            return;
        }
        if (seenMediaKeys.has(key)) {
            if (trace)
                pushTraceIssue(trace.droppedMedia, `media[${index}] ignored: duplicate key '${key}'.`);
            return;
        }
        const mediaTypeRaw = typeof mediaRecord.mediaType === 'string'
            ? mediaRecord.mediaType
            : typeof mediaRecord.type === 'string'
                ? mediaRecord.type
                : 'image';
        const mediaType = mediaTypeRaw.trim().toLowerCase() === 'video' ? 'video' : 'image';
        const prompt = typeof mediaRecord.prompt === 'string' ? truncate(mediaRecord.prompt.trim(), MAX_MESSAGE_TEXT) : '';
        if (!prompt) {
            if (trace)
                pushTraceIssue(trace.droppedMedia, `media[${index}] ignored: missing prompt.`);
            return;
        }
        const rawX = typeof mediaRecord.x === 'number' ? mediaRecord.x : null;
        const rawY = typeof mediaRecord.y === 'number' ? mediaRecord.y : null;
        if (rawX === null || rawY === null || !Number.isFinite(rawX) || !Number.isFinite(rawY)) {
            if (trace)
                pushTraceIssue(trace.droppedMedia, `media[${index}] ignored: x/y must be finite numbers.`);
            return;
        }
        seenMediaKeys.add(key);
        media.push({
            key,
            mediaType,
            prompt,
            x: clamp(rawX, minX, maxX),
            y: clamp(rawY, minY, maxY),
            aspectRatio: typeof mediaRecord.aspectRatio === 'string' && mediaRecord.aspectRatio.trim().length > 0
                ? truncate(mediaRecord.aspectRatio.trim(), 24)
                : undefined,
            resolution: typeof mediaRecord.resolution === 'string' && mediaRecord.resolution.trim().length > 0
                ? truncate(mediaRecord.resolution.trim(), 24)
                : undefined,
            modelId: typeof mediaRecord.modelId === 'string' && mediaRecord.modelId.trim().length > 0
                ? truncate(mediaRecord.modelId.trim(), 120)
                : undefined,
        });
    });
    if (trace && rawMedia.length > maxMediaRequests) {
        pushTraceIssue(trace.droppedMedia, `${rawMedia.length - maxMediaRequests} extra media request(s) ignored due to cap of ${maxMediaRequests}.`);
    }
    if (trace) {
        trace.acceptedCounts.nodes = placedNodes.length;
        trace.acceptedCounts.edges = edges.length;
        trace.acceptedCounts.updates = updates.length;
        trace.acceptedCounts.deletes = deletes.length;
        trace.acceptedCounts.clusters = clusters.length;
        trace.acceptedCounts.media = media.length;
    }
    // ── Mode detection ─────────────────────────────────────────────────────────
    const hasCanvasOps = placedNodes.length > 0 ||
        edges.length > 0 ||
        updates.length > 0 ||
        deletes.length > 0 ||
        clusters.length > 0 ||
        media.length > 0;
    const isConversational = message !== undefined && !hasCanvasOps;
    if (!isConversational && !hasCanvasOps) {
        if (trace) {
            trace.outcome = 'invalid';
            trace.invalidReason = message
                ? 'Message was provided together with empty canvas operations.'
                : 'No message and no valid canvas operations remained after sanitization.';
        }
        return null;
    }
    if (trace) {
        trace.outcome = isConversational ? 'conversational' : 'canvas';
    }
    return {
        message: isConversational ? message : undefined,
        nodes: placedNodes,
        edges,
        updates: updates.length > 0 ? updates : undefined,
        deletes: deletes.length > 0 ? deletes : undefined,
        clusters: clusters.length > 0 ? clusters : undefined,
        media: media.length > 0 ? media : undefined,
    };
}
// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------
function buildFallbackPlan(prompt, viewport) {
    return {
        nodes: [
            {
                key: 'note',
                type: 'sticky',
                text: truncate(prompt.trim() || 'Untitled', MAX_NODE_TEXT),
                x: Math.round(viewport.x + viewport.width / 2),
                y: Math.round(viewport.y + viewport.height / 2),
            },
        ],
        edges: [],
    };
}
function summarizePlan(plan) {
    return {
        nodeCount: plan.nodes.length,
        edgeCount: plan.edges.length,
        updateCount: plan.updates?.length ?? 0,
        deleteCount: plan.deletes?.length ?? 0,
        clusterCount: plan.clusters?.length ?? 0,
        mediaCount: plan.media?.length ?? 0,
        conversational: Boolean(plan.message && plan.nodes.length === 0),
        hasMessage: typeof plan.message === 'string' && plan.message.length > 0,
    };
}
function summarizeToolCalls(toolCalls) {
    return toolCalls.reduce((acc, toolCall) => {
        const key = String(toolCall.toolName);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
    }, {});
}
async function callPlannerAI(request, maxNodes) {
    const apiKey = getConfiguredApiKey();
    if (!apiKey) {
        logPlanner('warn', 'planner.api_key.missing', {
            turnId: request.turnId,
            roomId: request.roomId,
            sessionId: request.sessionId,
            prompt: request.prompt,
        });
        return {
            plan: buildFallbackPlan(request.prompt, request.context.viewport),
            fallbackFailure: {
                code: 'provider_error',
                message: 'Gemini API key not configured (set GEMINI_API_KEY). Showing fallback.',
                retryable: false,
            },
        };
    }
    const contextShapes = getContextShapeLayouts(request);
    const contextSummary = buildCanvasContextSummary(request, contextShapes);
    const userContent = `Canvas context:\n${contextSummary}\n\nUser request: ${request.prompt}`;
    const model = getConfiguredModel();
    const timeoutMs = getConfiguredTimeoutMs();
    const maxOutputTokens = getConfiguredMaxOutputTokens();
    const systemPrompt = buildSystemPrompt(request.context.viewport);
    const requestUrl = `${geminiApiBaseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const requestBody = {
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens,
        },
        systemInstruction: {
            parts: [{ text: systemPrompt }],
        },
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
    };
    logPlanner('info', 'planner.request', {
        turnId: request.turnId,
        roomId: request.roomId,
        sessionId: request.sessionId,
        model,
        timeoutMs,
        maxNodes,
        maxOutputTokens,
        viewport: request.context.viewport,
        contextShapeCount: contextShapes.length,
        contextSummary,
        userPrompt: request.prompt,
        systemPrompt,
        userContent,
        requestUrl: requestUrl.replace(/key=[^&]+/, 'key=[REDACTED]'),
        requestBody,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
        const rawResponseText = await response.text();
        logPlanner('info', 'planner.response.raw', {
            turnId: request.turnId,
            status: response.status,
            ok: response.ok,
            statusText: response.statusText,
            rawResponseText,
        });
        let body;
        try {
            body = rawResponseText.trim().length > 0
                ? JSON.parse(rawResponseText)
                : {};
        }
        catch (error) {
            logPlanner('warn', 'planner.response.invalid_json', {
                turnId: request.turnId,
                status: response.status,
                parseError: serializeError(error),
                rawResponseText,
            });
            return {
                plan: buildFallbackPlan(request.prompt, request.context.viewport),
                fallbackFailure: {
                    code: 'provider_error',
                    message: 'Gemini response was not valid JSON. Showing fallback.',
                    retryable: true,
                },
            };
        }
        if (!response.ok) {
            let msg = `Gemini HTTP ${response.status}`;
            if (typeof body.error?.message === 'string') {
                msg = `Gemini error (${response.status}): ${body.error.message}`;
            }
            logPlanner('warn', 'planner.response.http_error', {
                turnId: request.turnId,
                status: response.status,
                message: msg,
                body,
            });
            return {
                plan: buildFallbackPlan(request.prompt, request.context.viewport),
                fallbackFailure: {
                    code: 'provider_error',
                    message: `${msg}. Showing fallback.`,
                    retryable: response.status === 429 || response.status >= 500,
                },
            };
        }
        if (body.error) {
            logPlanner('warn', 'planner.response.provider_error', {
                turnId: request.turnId,
                providerError: body.error,
                body,
            });
            return {
                plan: buildFallbackPlan(request.prompt, request.context.viewport),
                fallbackFailure: {
                    code: 'provider_error',
                    message: `Gemini provider error: ${body.error.message ?? 'unknown'}. Showing fallback.`,
                    retryable: true,
                },
            };
        }
        const rawText = (body.candidates?.[0]?.content?.parts ?? [])
            .map((p) => (typeof p.text === 'string' ? p.text : ''))
            .join('')
            .trim();
        const strippedText = stripMarkdownFences(rawText);
        logPlanner('info', 'planner.response.model_text', {
            turnId: request.turnId,
            rawText,
            strippedText,
            candidateCount: body.candidates?.length ?? 0,
        });
        let parsed;
        try {
            parsed = JSON.parse(strippedText);
        }
        catch (error) {
            logPlanner('warn', 'planner.response.model_text_invalid_json', {
                turnId: request.turnId,
                parseError: serializeError(error),
                rawText,
                strippedText,
            });
            return {
                plan: buildFallbackPlan(request.prompt, request.context.viewport),
                fallbackFailure: {
                    code: 'provider_error',
                    message: 'Planner returned non-JSON output. Showing fallback.',
                    retryable: true,
                },
            };
        }
        const validationTrace = createPlanValidationTrace(parsed);
        const plan = sanitizeAndValidatePlan(parsed, request.context.viewport, maxNodes, contextShapes, validationTrace);
        logPlanner(plan ? 'info' : 'warn', 'planner.response.sanitized_plan', {
            turnId: request.turnId,
            parsedPlan: parsed,
            validationTrace,
            sanitizedPlan: plan,
        });
        if (!plan) {
            return {
                plan: buildFallbackPlan(request.prompt, request.context.viewport),
                fallbackFailure: {
                    code: 'provider_error',
                    message: 'Planner returned invalid plan schema. Showing fallback.',
                    retryable: true,
                },
            };
        }
        return { plan };
    }
    catch (error) {
        const isTimeoutAbort = error instanceof Error && error.name === 'AbortError';
        logPlanner('error', 'planner.request.failed', {
            turnId: request.turnId,
            isTimeoutAbort,
            timeoutMs,
            error: serializeError(error),
        });
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return {
            plan: buildFallbackPlan(request.prompt, request.context.viewport),
            fallbackFailure: {
                code: 'provider_error',
                message: isTimeoutAbort
                    ? `Planner request timed out after ${timeoutMs}ms. Showing fallback.`
                    : `Planner request failed: ${msg}. Showing fallback.`,
                retryable: true,
                details: isTimeoutAbort
                    ? {
                        timeoutMs,
                    }
                    : undefined,
            },
        };
    }
    finally {
        clearTimeout(timer);
    }
}
// ---------------------------------------------------------------------------
// Compile plan → tool calls
// ---------------------------------------------------------------------------
function compilePlanToToolCalls(plan, turnId, maxTools, viewport) {
    // Map node key → deterministic shape ID for edge resolution
    const keyToShapeId = new Map(plan.nodes.map((n) => [n.key, `shape-${turnId}-${normalizeKey(n.key)}`]));
    // ── Create ops ─────────────────────────────────────────────────────────────
    const createOps = plan.nodes.map((node) => {
        const id = keyToShapeId.get(node.key);
        if (node.type === 'geo') {
            return {
                toolName: 'place_geo',
                arguments: {
                    id,
                    x: node.x,
                    y: node.y,
                    text: node.text,
                    shape: node.shape ?? 'rectangle',
                    w: node.w ?? DEFAULT_GEO_W,
                    h: node.h ?? DEFAULT_GEO_H,
                    color: node.color ?? 'black',
                },
            };
        }
        if (node.type === 'text') {
            return {
                toolName: 'place_text',
                arguments: {
                    id,
                    x: node.x,
                    y: node.y,
                    text: node.text,
                    color: node.color ?? 'black',
                },
            };
        }
        // default: sticky
        return {
            toolName: 'place_sticky',
            arguments: {
                id,
                x: node.x,
                y: node.y,
                text: node.text,
                color: node.color,
            },
        };
    });
    // ── Arrow ops ──────────────────────────────────────────────────────────────
    // draw_arrow uses fromShapeId/toShapeId (executor's validated field names).
    // The executor must create the arrow shape THEN call editor.createBindings()
    // for both terminals so tldraw tracks shape movement automatically.
    // arrowId gives the executor a deterministic ID to use for createShapeId().
    const arrowOps = plan.edges
        .map((edge) => {
        const fromShapeId = keyToShapeId.get(edge.from);
        const toShapeId = keyToShapeId.get(edge.to);
        if (!fromShapeId || !toShapeId)
            return null;
        return {
            toolName: 'draw_arrow',
            arguments: {
                arrowId: `shape-${turnId}-arrow-${normalizeKey(edge.from)}-${normalizeKey(edge.to)}`,
                fromShapeId,
                toShapeId,
                ...(edge.label !== undefined && { label: edge.label }),
            },
        };
    })
        .filter((op) => op !== null);
    // ── Group ops ──────────────────────────────────────────────────────────────
    const clusterOps = (plan.clusters ?? [])
        .map((cluster) => {
        const resolvedShapeIds = cluster.shapeIds
            .map((shapeRef) => {
            const normalizedRef = normalizeKey(shapeRef);
            return keyToShapeId.get(shapeRef) ?? keyToShapeId.get(normalizedRef) ?? shapeRef;
        })
            .filter((id) => typeof id === 'string' && id.length > 0);
        const uniqueShapeIds = [...new Set(resolvedShapeIds)];
        if (uniqueShapeIds.length < 2)
            return null;
        return {
            toolName: 'cluster_shapes',
            arguments: {
                shapeIds: uniqueShapeIds,
                label: cluster.label ?? 'Grouped items',
            },
        };
    })
        .filter((op) => op !== null);
    // ── Media ops ──────────────────────────────────────────────────────────────
    const mediaOps = (plan.media ?? []).map((item) => {
        const mediaShapeId = `shape-${turnId}-media-${normalizeKey(item.key)}`;
        return {
            toolName: (item.mediaType === 'video' ? 'generate_video' : 'generate_image'),
            arguments: {
                id: mediaShapeId,
                prompt: item.prompt,
                x: item.x,
                y: item.y,
                ...(item.aspectRatio !== undefined && { aspectRatio: item.aspectRatio }),
                ...(item.resolution !== undefined && { resolution: item.resolution }),
                ...(item.modelId !== undefined && { modelId: item.modelId }),
            },
        };
    });
    // ── Update ops ─────────────────────────────────────────────────────────────
    const updateOps = (plan.updates ?? []).map((u) => ({
        toolName: 'update_shape',
        arguments: {
            id: u.id,
            ...(u.text !== undefined && { text: u.text }),
            ...(u.x !== undefined && { x: u.x }),
            ...(u.y !== undefined && { y: u.y }),
        },
    }));
    // ── Delete ops ─────────────────────────────────────────────────────────────
    const deleteOps = (plan.deletes ?? []).map((d) => ({
        toolName: 'delete_shape',
        arguments: { id: d.id },
    }));
    const allOps = [...createOps, ...arrowOps, ...clusterOps, ...mediaOps, ...updateOps, ...deleteOps];
    if (allOps.length <= maxTools) {
        return { toolCalls: allOps, truncated: false };
    }
    // ── Budget exceeded: truncate gracefully ───────────────────────────────────
    // Priority: updates > deletes > shapes/media > arrows > warning note
    const budgetForContent = maxTools - 1; // reserve 1 for the truncation note
    const prioritized = [...updateOps, ...deleteOps, ...createOps, ...mediaOps];
    const kept = prioritized.slice(0, budgetForContent);
    const keptCreateIds = new Set(kept
        .filter((op) => ['place_sticky', 'place_geo', 'place_text'].includes(op.toolName))
        .map((op) => op.arguments.id));
    const keptArrows = arrowOps.filter((op) => {
        const args = op.arguments;
        return keptCreateIds.has(args.fromShapeId) && keptCreateIds.has(args.toShapeId);
    });
    const keptMediaOps = kept.filter((op) => op.toolName === 'generate_image' || op.toolName === 'generate_video');
    const keptClusters = clusterOps.filter((op) => {
        const args = op.arguments;
        const shapeIds = Array.isArray(args.shapeIds) ? args.shapeIds : [];
        if (shapeIds.length < 2)
            return false;
        const containsCreatedShape = shapeIds.some((id) => keptCreateIds.has(id));
        if (!containsCreatedShape) {
            // Keep clusters that target existing canvas shapes.
            return true;
        }
        return shapeIds.every((id) => !id.startsWith(`shape-${turnId}-`) || keptCreateIds.has(id));
    });
    let finalArrows = [...keptArrows];
    while (kept.length + finalArrows.length >= maxTools && finalArrows.length > 0) {
        finalArrows = finalArrows.slice(0, -1);
    }
    let finalClusters = [...keptClusters];
    while (kept.length + finalArrows.length + finalClusters.length >= maxTools && finalClusters.length > 0) {
        finalClusters = finalClusters.slice(0, -1);
    }
    // Truncation note
    const keptNodes = plan.nodes.filter((n) => keptCreateIds.has(keyToShapeId.get(n.key)));
    const noteCandidateX = viewport.x + viewport.width / 2;
    const noteCandidateY = keptNodes.length > 0
        ? Math.max(...keptNodes.map((n) => n.y)) + STICKY_H + 30
        : viewport.y + viewport.height / 2;
    const { hw: nHw, hh: nHh } = { hw: STICKY_W / 2, hh: STICKY_H / 2 };
    const minX = viewport.x + nHw + 20;
    const maxX = viewport.x + viewport.width - nHw - 20;
    const minY = viewport.y + nHh + 20;
    const maxY = viewport.y + viewport.height - nHh - 20;
    const truncationNote = {
        toolName: 'place_sticky',
        arguments: {
            id: `shape-${turnId}-truncated`,
            x: clamp(noteCandidateX, minX, maxX),
            y: clamp(noteCandidateY, minY, maxY),
            text: `⚠️ Truncated: kept ${kept.length + finalArrows.length + finalClusters.length} of ${allOps.length} operations (${keptMediaOps.length} media).`,
        },
    };
    return { toolCalls: [...kept, ...finalArrows, ...finalClusters, truncationNote], truncated: true };
}
// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function streamGeminiTurn(request) {
    const events = [
        {
            type: 'agent.stream.started',
            turnId: request.turnId,
            at: new Date().toISOString(),
        },
    ];
    logPlanner('info', 'turn.started', {
        turnId: request.turnId,
        roomId: request.roomId,
        sessionId: request.sessionId,
        prompt: request.prompt,
        viewport: request.context.viewport,
        contextMaxShapes: request.context.maxShapes,
    });
    const maxToolsPerTurn = getConfiguredMaxToolsPerTurn();
    const maxNodes = Math.min(MAX_NODES_HARD, Math.max(1, maxToolsPerTurn - 1));
    // --- 1. Get plan from AI ---
    const { plan, fallbackFailure } = await callPlannerAI(request, maxNodes);
    logPlanner('info', 'turn.plan.received', {
        turnId: request.turnId,
        maxToolsPerTurn,
        maxNodes,
        planSummary: summarizePlan(plan),
        plan,
        fallbackFailure,
    });
    if (fallbackFailure) {
        logPlanner('warn', 'turn.plan.fallback', {
            turnId: request.turnId,
            fallbackFailure,
        });
        events.push({
            type: 'agent.stream.delta',
            turnId: request.turnId,
            at: new Date().toISOString(),
            delta: fallbackFailure.message,
        });
    }
    // --- 2. Conversational mode ---
    if (plan.message &&
        plan.nodes.length === 0 &&
        plan.edges.length === 0 &&
        (plan.updates?.length ?? 0) === 0 &&
        (plan.deletes?.length ?? 0) === 0 &&
        (plan.clusters?.length ?? 0) === 0 &&
        (plan.media?.length ?? 0) === 0) {
        logPlanner('info', 'turn.conversational', {
            turnId: request.turnId,
            messageLength: plan.message.length,
            message: plan.message,
        });
        const chunkSize = 40;
        for (let i = 0; i < plan.message.length; i += chunkSize) {
            events.push({
                type: 'agent.stream.delta',
                turnId: request.turnId,
                at: new Date().toISOString(),
                delta: plan.message.slice(i, i + chunkSize),
            });
        }
        events.push({
            type: 'agent.stream.completed',
            turnId: request.turnId,
            at: new Date().toISOString(),
        });
        logPlanner('info', 'turn.completed', {
            turnId: request.turnId,
            status: 'completed',
            actionCount: 0,
            eventCount: events.length,
            mode: 'conversational',
        });
        return {
            turnId: request.turnId,
            accepted: true,
            status: 'completed',
            actions: [],
            events,
        };
    }
    // --- 3. Compile to tool calls ---
    const { toolCalls, truncated } = compilePlanToToolCalls(plan, request.turnId, maxToolsPerTurn, request.context.viewport);
    logPlanner('info', 'turn.tool_calls.compiled', {
        turnId: request.turnId,
        truncated,
        toolCallCount: toolCalls.length,
        toolCallSummary: summarizeToolCalls(toolCalls),
        toolCalls,
    });
    if (toolCalls.length === 0) {
        logPlanner('warn', 'turn.tool_calls.empty', {
            turnId: request.turnId,
            plan,
            truncated,
        });
    }
    if (truncated) {
        events.push({
            type: 'agent.stream.delta',
            turnId: request.turnId,
            at: new Date().toISOString(),
            delta: `Note: plan was truncated to fit the ${maxToolsPerTurn}-operation limit.`,
        });
    }
    // --- 4. Execute tool calls with streaming events ---
    const actions = [];
    for (const entry of toolCalls) {
        logPlanner('info', 'turn.tool_call.begin', {
            turnId: request.turnId,
            toolName: entry.toolName,
            arguments: entry.arguments,
        });
        const completedToolEnvelope = createToolEnvelope(request.turnId, entry.toolName, entry.arguments);
        const serializedArguments = JSON.stringify(entry.arguments);
        const chunkSize = Math.max(8, Math.floor(serializedArguments.length / 2));
        let argumentBuffer = '';
        for (let index = 0; index < serializedArguments.length; index += chunkSize) {
            const fragment = serializedArguments.slice(index, index + chunkSize);
            argumentBuffer += fragment;
            events.push({
                type: 'agent.stream.tool_call.delta',
                turnId: request.turnId,
                at: new Date().toISOString(),
                toolCall: {
                    id: completedToolEnvelope.id,
                    turnId: request.turnId,
                    toolName: entry.toolName,
                    fragment,
                    completed: index + chunkSize >= serializedArguments.length,
                },
            });
        }
        let parsedArguments;
        try {
            const p = JSON.parse(argumentBuffer);
            if (typeof p !== 'object' || p === null)
                throw new Error('Tool arguments were not an object.');
            parsedArguments = p;
        }
        catch (error) {
            logPlanner('error', 'turn.tool_call.parse_failed', {
                turnId: request.turnId,
                toolName: entry.toolName,
                argumentBuffer,
                error: serializeError(error),
            });
            const failure = {
                code: 'malformed_tool_call',
                message: error instanceof Error ? error.message : 'Failed to parse tool arguments.',
                retryable: true,
            };
            events.push({ type: 'agent.stream.failed', turnId: request.turnId, at: new Date().toISOString(), failure });
            return { turnId: request.turnId, accepted: false, status: 'failed', actions, events, failure, error: failure.message };
        }
        const validatedEnvelope = { ...completedToolEnvelope, arguments: parsedArguments };
        events.push({
            type: 'agent.stream.tool_call.completed',
            turnId: request.turnId,
            at: new Date().toISOString(),
            toolCall: validatedEnvelope,
        });
        try {
            const action = await executeToolCall(request.roomId, validatedEnvelope);
            actions.push(action);
            logPlanner('info', 'turn.tool_call.executed', {
                turnId: request.turnId,
                toolName: entry.toolName,
                arguments: parsedArguments,
                action,
            });
            events.push({
                type: 'agent.stream.action',
                turnId: request.turnId,
                at: new Date().toISOString(),
                action,
            });
        }
        catch (error) {
            logPlanner('error', 'turn.tool_call.execution_failed', {
                turnId: request.turnId,
                toolName: entry.toolName,
                arguments: parsedArguments,
                error: serializeError(error),
            });
            const failure = {
                code: 'tool_validation_failed',
                message: error instanceof Error ? error.message : 'Tool execution failed.',
                retryable: false,
            };
            events.push({ type: 'agent.stream.failed', turnId: request.turnId, at: new Date().toISOString(), failure });
            return {
                turnId: request.turnId,
                accepted: false,
                status: 'failed',
                actions,
                suggestedActions: actions,
                events,
                failure,
                error: failure.message,
            };
        }
    }
    events.push({
        type: 'agent.stream.completed',
        turnId: request.turnId,
        at: new Date().toISOString(),
    });
    logPlanner('info', 'turn.completed', {
        turnId: request.turnId,
        status: fallbackFailure ? 'fallback' : 'completed',
        actionCount: actions.length,
        actions,
        eventCount: events.length,
        fallbackFailure,
    });
    return {
        turnId: request.turnId,
        accepted: true,
        status: fallbackFailure ? 'fallback' : 'completed',
        actions,
        suggestedActions: fallbackFailure ? actions : undefined,
        events,
        failure: fallbackFailure,
        error: fallbackFailure?.message,
    };
}
// ═══════════════════════════════════════════════════════════════════════════════
// REQUIRED toolExecutor.ts changes — implement these handlers:
// ═══════════════════════════════════════════════════════════════════════════════
//
// 1. place_sticky (existing — keep as-is)
//    args: { id, x, y, text, color? }
//    → editor.createShape({ id: createShapeId(id), type: 'note',
//        x: x - STICKY_W/2, y: y - STICKY_H/2,
//        props: { richText: toRichText(text), color: color ?? 'yellow' } })
//
// 2. place_geo (NEW)
//    args: { id, x, y, text, shape, w, h, color }
//    → editor.createShape({ id: createShapeId(id), type: 'geo',
//        x: x - w/2, y: y - h/2,
//        props: { geo: shape, w, h, richText: toRichText(text),
//                 color, fill: 'solid', dash: 'draw', size: 'm' } })
//
// 3. place_text (NEW)
//    args: { id, x, y, text, color }
//    → editor.createShape({ id: createShapeId(id), type: 'text',
//        x, y,
//        props: { richText: toRichText(text), color, size: 'xl', font: 'draw',
//                 autoSize: true } })
//
// 4. draw_arrow (UPDATED — use bindings, not free coordinates)
//    args: { id, startShapeId, endShapeId, label? }
//    → const arrowId = createShapeId(id)
//      editor.createShape({ id: arrowId, type: 'arrow',
//        x: 0, y: 0,
//        props: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 },
//                 arrowheadEnd: 'arrow', arrowheadStart: 'none',
//                 ...(label ? { richText: toRichText(label) } : {}) } })
//      editor.createBindings([
//        { fromId: arrowId, toId: startShapeId, type: 'arrow',
//          props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 },
//                   isPrecise: false, isExact: false } },
//        { fromId: arrowId, toId: endShapeId, type: 'arrow',
//          props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 },
//                   isPrecise: false, isExact: false } },
//      ])
//
// 5. update_shape (NEW)
//    args: { id, text?, x?, y? }
//    → const shape = editor.getShape(id as TLShapeId)
//      if (!shape) return
//      const patch: TLShapePartial = { id: shape.id, type: shape.type }
//      if (text) patch.props = { richText: toRichText(text) }
//      if (x !== undefined || y !== undefined) {
//        const bounds = editor.getShapePageBounds(shape.id)
//        patch.x = (x ?? shape.x + (bounds?.w ?? 0) / 2) - (bounds?.w ?? 0) / 2
//        patch.y = (y ?? shape.y + (bounds?.h ?? 0) / 2) - (bounds?.h ?? 0) / 2
//      }
//      editor.updateShapes([patch])
//
// 6. delete_shape (NEW)
//    args: { id }
//    → editor.deleteShapes([id as TLShapeId])
//
// Also add the new ToolName values to contracts.ts:
//   'place_geo' | 'place_text' | 'update_shape' | 'delete_shape'
// ═══════════════════════════════════════════════════════════════════════════════
//# sourceMappingURL=claudeClient.js.map