// geminiClient.ts — AI-First Canvas Planner
// Replace the previous heuristic+template approach with a single planner AI call.
// Geometry is fully deterministic; AI owns content, structure, and layout choice.

import type {
  AgentStreamEvent,
  AgentTurnRequest,
  AgentTurnResponse,
  CanvasActionEnvelope,
  FailureEnvelope,
  ToolName,
} from '../types/contracts.js';
import { executeToolCall } from './toolExecutor.js';
import { createToolEnvelope } from './tools.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const geminiApiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const defaultGeminiModel = 'gemini-2.5-flash';
const defaultTimeoutMs = 20_000;
const defaultMaxToolsPerTurn = 15;
const defaultMaxOutputTokens = 4096;

const VIEWPORT_MARGIN = 60;
const MAX_NODE_TEXT = 300;
const MAX_MESSAGE_TEXT = 2000;
const MAX_NODES_HARD = 32;

// ---------------------------------------------------------------------------
// AIPlan contract
// ---------------------------------------------------------------------------

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
  message?: string;       // plain text reply (conversational mode)
  layout: LayoutKind;
  nodes: AIPlanNode[];
  edges: AIPlanEdge[];
}

// Internal resolved position
interface ResolvedNode extends AIPlanNode {
  x: number;
  y: number;
  shapeId: string;
}

// Internal tool call
interface ToolCall {
  toolName: ToolName;
  arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function getEnv(name: string): string | undefined {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return maybeProcess?.env?.[name];
}

function getConfiguredApiKey(): string | undefined {
  return getEnv('GEMINI_API_KEY') ?? getEnv('GOOGLE_API_KEY');
}

function getConfiguredModel(): string {
  return getEnv('GEMINI_MODEL') ?? getEnv('GOOGLE_MODEL') ?? defaultGeminiModel;
}

function getConfiguredTimeoutMs(): number {
  const v = Number(getEnv('GEMINI_TIMEOUT_MS') ?? getEnv('GOOGLE_TIMEOUT_MS') ?? defaultTimeoutMs);
  return Number.isFinite(v) && v > 0 ? v : defaultTimeoutMs;
}

function getConfiguredMaxOutputTokens(): number {
  const v = Number(getEnv('GEMINI_MAX_OUTPUT_TOKENS') ?? getEnv('GOOGLE_MAX_OUTPUT_TOKENS') ?? defaultMaxOutputTokens);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : defaultMaxOutputTokens;
}

function getConfiguredMaxToolsPerTurn(): number {
  const v = Number(getEnv('AGENT_MAX_TOOLS_PER_TURN') ?? defaultMaxToolsPerTurn);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : defaultMaxToolsPerTurn;
}

// ---------------------------------------------------------------------------
// Canvas context helpers (reused from original)
// ---------------------------------------------------------------------------

function extractRichText(richText: unknown): string {
  if (typeof richText !== 'object' || richText === null) return '';
  const root = richText as Record<string, unknown>;
  const doc = root.doc ?? root;
  function walk(node: unknown): string {
    if (typeof node !== 'object' || node === null) return '';
    const r = node as Record<string, unknown>;
    if (typeof r.text === 'string') return r.text;
    if (Array.isArray(r.content)) return r.content.map(walk).join('');
    return '';
  }
  return walk(doc).replace(/\s+/g, ' ').trim();
}

function extractTextFromShape(record: Record<string, unknown>): string {
  const props =
    typeof record.props === 'object' && record.props !== null
      ? (record.props as Record<string, unknown>)
      : {};
  if (props.richText !== undefined) {
    const rt = extractRichText(props.richText);
    if (rt.length > 0) return rt;
  }
  for (const v of [props.text, props.name, props.label, record.text]) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  if (typeof props.url === 'string' && props.url.trim().length > 0) return `[url: ${props.url.trim()}]`;
  return '';
}

function buildCanvasContextSummary(request: AgentTurnRequest): string {
  const rawContext = request.context as AgentTurnRequest['context'] & { shapes?: unknown };
  const shapes = Array.isArray(rawContext.shapes) ? rawContext.shapes : [];

  if (shapes.length === 0) return 'Canvas is empty.';

  const previews = shapes
    .slice(0, 32)
    .map((shape) => {
      if (typeof shape !== 'object' || shape === null) return null;
      const r = shape as Record<string, unknown>;
      const kind = typeof r.type === 'string' ? r.type : 'unknown';
      const text = extractTextFromShape(r).slice(0, 120);
      return text ? `${kind}: "${text}"` : null;
    })
    .filter((s): s is string => s !== null);

  return previews.length > 0
    ? `Canvas has ${shapes.length} shape(s). Sample: ${previews.slice(0, 6).join(' | ')}`
    : `Canvas has ${shapes.length} shape(s) with no text.`;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `
You are an AI canvas planner. Given a user prompt, decide what to create on a collaborative canvas.

Return ONLY a valid JSON object. No markdown, no code fences, no explanation — raw JSON only.

Schema:
{
  "message": "<optional plain text — only for conversational replies>",
  "layout": "<hub | linear | grid | free>",
  "nodes": [
    { "key": "<unique_snake_case_id>", "text": "<content>", "role": "<title | point | note | takeaway>" }
  ],
  "edges": [
    { "from": "<key>", "to": "<key>" }
  ]
}

Layout rules:
- hub: Use for mind maps, topic exploration. One "title" node in center, others radiate outward.
- linear: Use for steps, timelines, sequences. Nodes flow top to bottom in order.
- grid: Use for comparisons, lists, pros/cons. Nodes arranged in columns.
- free: Use only when no other layout fits. Nodes spread without specific order.

Node rules:
- Every plan must have at most one "title" role node.
- Use "point" for body items, "takeaway" for conclusions, "note" for asides.
- Keep node text short and specific. No filler phrases.
- Maximum 12 nodes.

Edge rules:
- Only create edges between keys that exist in your nodes list.
- For "hub": connect title → each point.
- For "linear": connect each node to the next in sequence.
- For "grid": no edges unless meaningful.
- Omit edges array if empty.

Conversational mode:
- If the user is chatting, asking a meta question, or not requesting canvas content, set nodes to [] and edges to [] and put your full response in "message".
- Do NOT set message when you are creating canvas content.

Examples:
Prompt: "explain why sleep is important" →
{ "layout": "hub", "nodes": [ {"key":"title","text":"Why Sleep Matters","role":"title"}, {"key":"p1","text":"Consolidates memory","role":"point"}, {"key":"p2","text":"Repairs muscle tissue","role":"point"}, {"key":"p3","text":"Regulates mood","role":"point"}, {"key":"takeaway","text":"7-9 hours is non-negotiable","role":"takeaway"} ], "edges": [{"from":"title","to":"p1"},{"from":"title","to":"p2"},{"from":"title","to":"p3"}] }

Prompt: "steps to launch a startup" →
{ "layout": "linear", "nodes": [ {"key":"s1","text":"Validate the problem","role":"title"}, {"key":"s2","text":"Build an MVP","role":"point"}, {"key":"s3","text":"Get 10 paying users","role":"point"}, {"key":"s4","text":"Iterate on feedback","role":"point"}, {"key":"s5","text":"Scale distribution","role":"takeaway"} ], "edges": [{"from":"s1","to":"s2"},{"from":"s2","to":"s3"},{"from":"s3","to":"s4"},{"from":"s4","to":"s5"}] }

Prompt: "what can you do?" →
{ "layout": "free", "nodes": [], "edges": [], "message": "I can create mind maps, step-by-step flows, comparison grids, or freeform notes. Just describe what you want on the canvas." }
`.trim();

// ---------------------------------------------------------------------------
// AIPlan validation and sanitization
// ---------------------------------------------------------------------------

const ALLOWED_LAYOUTS: Set<string> = new Set(['hub', 'linear', 'grid', 'free']);
const ALLOWED_ROLES: Set<string> = new Set(['title', 'point', 'note', 'takeaway']);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function stripMarkdownFences(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] !== undefined ? match[1].trim() : trimmed;
}

function sanitizeAndValidatePlan(raw: unknown, maxNodes: number): AIPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const obj = raw as Record<string, unknown>;

  // Layout
  const layout = typeof obj.layout === 'string' && ALLOWED_LAYOUTS.has(obj.layout)
    ? (obj.layout as LayoutKind)
    : null;
  if (layout === null) return null;

  // Message
  const message = typeof obj.message === 'string' && obj.message.trim().length > 0
    ? truncate(obj.message.trim(), MAX_MESSAGE_TEXT)
    : undefined;

  // Nodes
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const seenKeys = new Set<string>();
  let titleCount = 0;

  const nodes: AIPlanNode[] = rawNodes
    .slice(0, Math.min(MAX_NODES_HARD, maxNodes))
    .map((n): AIPlanNode | null => {
      if (typeof n !== 'object' || n === null) return null;
      const nr = n as Record<string, unknown>;
      const key = typeof nr.key === 'string' ? nr.key.trim() : '';
      const text = typeof nr.text === 'string' ? truncate(nr.text.trim(), MAX_NODE_TEXT) : '';
      const role = typeof nr.role === 'string' && ALLOWED_ROLES.has(nr.role) ? (nr.role as NodeRole) : 'point';

      if (key.length === 0 || text.length === 0) return null;
      if (seenKeys.has(key)) return null;
      if (role === 'title') {
        if (titleCount > 0) return null; // only one title allowed
        titleCount++;
      }

      seenKeys.add(key);
      return { key, text, role };
    })
    .filter((n): n is AIPlanNode => n !== null);

  // Enforce mutual exclusivity: message → no nodes; nodes → no message.
  // A plan with message AND nodes is ambiguous — treat it as canvas-only and drop the message.
  // A plan with message AND no nodes is conversational — pass through.
  // A plan with no message AND no nodes is invalid — neither mode applies.
  const isConversational = message !== undefined && nodes.length === 0;
  const isCanvas = nodes.length > 0;

  if (!isConversational && !isCanvas) {
    // Empty canvas plan with no message — model did nothing meaningful.
    return null;
  }

  // If canvas content is present, message must be absent (drop it silently).
  const finalMessage = isCanvas ? undefined : message;

  // Edges — filter out any with unknown keys
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];
  const edges: AIPlanEdge[] = rawEdges
    .map((e): AIPlanEdge | null => {
      if (typeof e !== 'object' || e === null) return null;
      const er = e as Record<string, unknown>;
      const from = typeof er.from === 'string' ? er.from.trim() : '';
      const to = typeof er.to === 'string' ? er.to.trim() : '';
      if (!seenKeys.has(from) || !seenKeys.has(to) || from === to) return null;
      return { from, to };
    })
    .filter((e): e is AIPlanEdge => e !== null);

  return { message: finalMessage, layout, nodes, edges };
}

// ---------------------------------------------------------------------------
// Edge inference — make hub and linear robust when model omits edges
// ---------------------------------------------------------------------------

function inferEdges(plan: AIPlan): AIPlanEdge[] {
  if (plan.edges.length > 0) return plan.edges; // model provided them, trust it

  const keys = plan.nodes.map((n) => n.key);
  if (keys.length < 2) return [];

  if (plan.layout === 'linear') {
    // Chain: n0 → n1 → n2 → ...
    return keys.slice(0, -1).map((from, i) => ({ from, to: keys[i + 1]! }));
  }

  if (plan.layout === 'hub') {
    // Title (or first node) → all others
    const titleKey = plan.nodes.find((n) => n.role === 'title')?.key ?? keys[0]!;
    return keys.filter((k) => k !== titleKey).map((to) => ({ from: titleKey, to }));
  }

  // grid / free: no edges by default
  return [];
}



function buildFallbackPlan(prompt: string): AIPlan {
  return {
    layout: 'free',
    nodes: [
      {
        key: 'note',
        text: truncate(prompt.trim() || 'Untitled', MAX_NODE_TEXT),
        role: 'note',
      },
    ],
    edges: [],
  };
}

// ---------------------------------------------------------------------------
// Planner AI call
// ---------------------------------------------------------------------------

interface PlannerResult {
  plan: AIPlan;
  fallbackFailure?: FailureEnvelope;
}

async function callPlannerAI(request: AgentTurnRequest, maxNodes: number): Promise<PlannerResult> {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    return {
      plan: buildFallbackPlan(request.prompt),
      fallbackFailure: {
        code: 'provider_error',
        message: 'Gemini API key not configured (set GEMINI_API_KEY). Showing fallback.',
        retryable: false,
      },
    };
  }

  const contextSummary = buildCanvasContextSummary(request);
  const userContent = `Canvas context: ${contextSummary}\n\nUser request: ${request.prompt}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getConfiguredTimeoutMs());

  try {
    const response = await fetch(
      `${geminiApiBaseUrl}/models/${encodeURIComponent(getConfiguredModel())}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: getConfiguredMaxOutputTokens(),
          },
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
          contents: [
            { role: 'user', parts: [{ text: userContent }] },
          ],
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      let msg = `Gemini HTTP ${response.status}`;
      try {
        const err = (await response.json()) as { error?: { message?: string } };
        if (typeof err.error?.message === 'string') msg = `Gemini error (${response.status}): ${err.error.message}`;
      } catch { /* ignore */ }
      return {
        plan: buildFallbackPlan(request.prompt),
        fallbackFailure: {
          code: 'provider_error',
          message: `${msg}. Showing fallback.`,
          retryable: response.status === 429 || response.status >= 500,
        },
      };
    }

    const body = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { code?: number; message?: string };
    };

    if (body.error) {
      return {
        plan: buildFallbackPlan(request.prompt),
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownFences(rawText));
    } catch {
      return {
        plan: buildFallbackPlan(request.prompt),
        fallbackFailure: {
          code: 'provider_error',
          message: 'Planner returned non-JSON output. Showing fallback.',
          retryable: true,
        },
      };
    }

    const plan = sanitizeAndValidatePlan(parsed, maxNodes);
    if (!plan) {
      return {
        plan: buildFallbackPlan(request.prompt),
        fallbackFailure: {
          code: 'provider_error',
          message: 'Planner returned invalid plan schema. Showing fallback.',
          retryable: true,
        },
      };
    }

    return { plan };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return {
      plan: buildFallbackPlan(request.prompt),
      fallbackFailure: {
        code: 'provider_error',
        message: `Planner request failed: ${msg}. Showing fallback.`,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Layout resolver — the only place coordinates live
// ---------------------------------------------------------------------------

function clampToViewport(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, value));
}

function resolvePositions(
  plan: AIPlan,
  viewport: AgentTurnRequest['context']['viewport'],
  turnId: string,
): ResolvedNode[] {
  const { x, y, width, height } = viewport;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const safeWidth = width - VIEWPORT_MARGIN * 2;
  const safeHeight = height - VIEWPORT_MARGIN * 2;
  const minX = x + VIEWPORT_MARGIN;
  const minY = y + VIEWPORT_MARGIN;

  const nodes = plan.nodes;
  const count = nodes.length;

  if (count === 0) return [];

  const positions: Array<{ x: number; y: number }> = [];

  switch (plan.layout) {
    case 'hub': {
      // Title at center, others radially around it
      const titleIndex = nodes.findIndex((n) => n.role === 'title');
      const others = nodes.map((_, i) => i).filter((i) => i !== titleIndex);
      const radius = Math.min(safeWidth, safeHeight) * 0.35;

      nodes.forEach((_, i) => {
        if (i === titleIndex || (titleIndex === -1 && i === 0)) {
          positions[i] = { x: cx, y: cy };
        } else {
          const othersIndex = others.indexOf(i);
          const angle = (2 * Math.PI * othersIndex) / others.length - Math.PI / 2;
          positions[i] = {
            x: clampToViewport(cx + radius * Math.cos(angle), minX, minX + safeWidth),
            y: clampToViewport(cy + radius * Math.sin(angle), minY, minY + safeHeight),
          };
        }
      });
      break;
    }

    case 'linear': {
      // Nodes flow vertically, centered
      const stepY = count > 1 ? Math.min(160, safeHeight / (count - 1)) : 0;
      const totalH = stepY * (count - 1);
      const startY = cy - totalH / 2;

      nodes.forEach((_, i) => {
        positions[i] = {
          x: cx,
          y: clampToViewport(startY + i * stepY, minY, minY + safeHeight),
        };
      });
      break;
    }

    case 'grid': {
      // Auto columns: sqrt(n) rounded, minimum 2
      const cols = Math.max(2, Math.round(Math.sqrt(count)));
      const rows = Math.ceil(count / cols);
      const cellW = Math.min(240, safeWidth / cols);
      const cellH = Math.min(180, safeHeight / rows);
      const gridW = cols * cellW;
      const gridH = rows * cellH;
      const startX = cx - gridW / 2 + cellW / 2;
      const startY = cy - gridH / 2 + cellH / 2;

      nodes.forEach((_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        positions[i] = {
          x: clampToViewport(startX + col * cellW, minX, minX + safeWidth),
          y: clampToViewport(startY + row * cellH, minY, minY + safeHeight),
        };
      });
      break;
    }

    case 'free':
    default: {
      // Deterministic spread: golden angle spiral, no overlap
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      const maxRadius = Math.min(safeWidth, safeHeight) * 0.4;

      nodes.forEach((_, i) => {
        if (i === 0) {
          positions[i] = { x: cx, y: cy };
        } else {
          const r = maxRadius * Math.sqrt(i / count);
          const angle = i * goldenAngle;
          positions[i] = {
            x: clampToViewport(cx + r * Math.cos(angle), minX, minX + safeWidth),
            y: clampToViewport(cy + r * Math.sin(angle), minY, minY + safeHeight),
          };
        }
      });
      break;
    }
  }

  return nodes.map((node, i) => ({
    ...node,
    x: Math.round(positions[i]!.x),
    y: Math.round(positions[i]!.y),
    shapeId: `shape-${turnId}-${node.key}`,
  }));
}

// ---------------------------------------------------------------------------
// Compile plan → tool calls
// ---------------------------------------------------------------------------

function compilePlanToToolCalls(
  plan: AIPlan,
  resolvedNodes: ResolvedNode[],
  maxTools: number,
): { toolCalls: ToolCall[]; truncated: boolean } {
  const keyToShape = new Map<string, ResolvedNode>(resolvedNodes.map((n) => [n.key, n]));

  // Stickies first, then arrows — stable order
  const stickyOps: ToolCall[] = resolvedNodes.map((node) => ({
    toolName: 'place_sticky' as ToolName,
    arguments: {
      id: node.shapeId,
      x: node.x,
      y: node.y,
      text: node.text,
    },
  }));

  const arrowOps: ToolCall[] = plan.edges
    .map((edge): ToolCall | null => {
      const fromShape = keyToShape.get(edge.from);
      const toShape = keyToShape.get(edge.to);
      if (!fromShape || !toShape) return null;
      return {
        toolName: 'draw_arrow' as ToolName,
        arguments: {
          fromShapeId: fromShape.shapeId,
          toShapeId: toShape.shapeId,
        },
      };
    })
    .filter((op): op is ToolCall => op !== null);

  const allOps = [...stickyOps, ...arrowOps];

  // Budget: reserve 1 slot for truncation note if needed
  const budgetForContent = maxTools - 1;
  if (allOps.length <= maxTools) {
    return { toolCalls: allOps, truncated: false };
  }

  // Truncate: keep as many stickies as fit, skip overflow arrows
  const truncatedStickies = stickyOps.slice(0, Math.min(stickyOps.length, budgetForContent));
  const validKeys = new Set(truncatedStickies.map((_, i) => resolvedNodes[i]!.key));
  const truncatedArrows = arrowOps.filter((op) => {
    const args = op.arguments as { fromShapeId: string; toShapeId: string };
    const fromKey = [...keyToShape.entries()].find(([, n]) => n.shapeId === args.fromShapeId)?.[0];
    const toKey = [...keyToShape.entries()].find(([, n]) => n.shapeId === args.toShapeId)?.[0];
    return fromKey && toKey && validKeys.has(fromKey) && validKeys.has(toKey);
  });

  // Find a free position for the truncation note (below last sticky).
  // ID is turn-specific to avoid collisions across turns.
  const lastNode = resolvedNodes[truncatedStickies.length - 1];
  const turnIdSegment = resolvedNodes[0]?.shapeId.split('-')[1] ?? 'unknown';
  const truncationNote: ToolCall = {
    toolName: 'place_sticky' as ToolName,
    arguments: {
      id: `shape-${turnIdSegment}-truncated`,
      x: lastNode ? lastNode.x : 0,
      y: lastNode ? lastNode.y + 120 : 0,
      text: `⚠️ Truncated: showing ${truncatedStickies.length} of ${stickyOps.length} items (tool limit reached).`,
    },
  };

  // Always guarantee the truncation note appears.
  // Drop trailing arrows until there is room for it.
  let arrows = [...truncatedArrows];
  while (truncatedStickies.length + arrows.length >= maxTools && arrows.length > 0) {
    arrows = arrows.slice(0, -1);
  }

  return {
    toolCalls: [...truncatedStickies, ...arrows, truncationNote],
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function streamGeminiTurn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
  const events: AgentStreamEvent[] = [
    {
      type: 'agent.stream.started',
      turnId: request.turnId,
      at: new Date().toISOString(),
    },
  ];

  const maxToolsPerTurn = getConfiguredMaxToolsPerTurn();

  // Give AI the full node budget; truncation in compilePlanToToolCalls handles overflow.
  // Reserve 1 slot minimum for at least one arrow or the truncation note itself.
  const maxNodes = Math.min(MAX_NODES_HARD, Math.max(1, maxToolsPerTurn - 1));

  // --- 1. Get plan from AI ---
  const { plan, fallbackFailure } = await callPlannerAI(request, maxNodes);

  if (fallbackFailure) {
    events.push({
      type: 'agent.stream.delta',
      turnId: request.turnId,
      at: new Date().toISOString(),
      delta: fallbackFailure.message,
    });
  }

  // --- 2. Conversational mode: message only, no canvas mutations ---
  if (plan.message && plan.nodes.length === 0) {
    // Stream message as delta
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

    return {
      turnId: request.turnId,
      accepted: true,
      status: 'completed',
      actions: [],
      events,
    };
  }

  // --- 3. Infer missing edges for hub/linear, then resolve positions ---
  const enrichedPlan: AIPlan = { ...plan, edges: inferEdges(plan) };
  const resolvedNodes = resolvePositions(enrichedPlan, request.context.viewport, request.turnId);

  // --- 4. Compile to tool calls ---
  const { toolCalls, truncated } = compilePlanToToolCalls(enrichedPlan, resolvedNodes, maxToolsPerTurn);

  if (truncated) {
    events.push({
      type: 'agent.stream.delta',
      turnId: request.turnId,
      at: new Date().toISOString(),
      delta: `Note: plan was truncated to fit the ${maxToolsPerTurn}-operation limit.`,
    });
  }

  // --- 5. Execute tool calls with streaming events ---
  const actions: CanvasActionEnvelope[] = [];

  for (const entry of toolCalls) {
    const completedToolEnvelope = createToolEnvelope(request.turnId, entry.toolName, entry.arguments);
    const serializedArguments = JSON.stringify(entry.arguments);
    const chunkSize = Math.max(8, Math.floor(serializedArguments.length / 2));

    // Stream argument deltas
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

    // Parse accumulated buffer
    let parsedArguments: Record<string, unknown>;
    try {
      const p = JSON.parse(argumentBuffer);
      if (typeof p !== 'object' || p === null) throw new Error('Tool arguments were not an object.');
      parsedArguments = p as Record<string, unknown>;
    } catch (error) {
      const failure: FailureEnvelope = {
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

    // Execute
    try {
      const action = executeToolCall(request.roomId, validatedEnvelope);
      actions.push(action);
      events.push({
        type: 'agent.stream.action',
        turnId: request.turnId,
        at: new Date().toISOString(),
        action,
      });
    } catch (error) {
      const failure: FailureEnvelope = {
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