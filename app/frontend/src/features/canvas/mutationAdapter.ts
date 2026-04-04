import type { CanvasActionEnvelope } from '@ai-canvas/shared';

type RichTextNode = {
  type: 'text';
  text: string;
};

type RichTextParagraph = {
  type: 'paragraph';
  content?: RichTextNode[];
};

type RichTextDocument = {
  type: 'doc';
  content: RichTextParagraph[];
};

function toRichText(text: string): RichTextDocument {
  const trimmed = text.trim();
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: trimmed.length > 0 ? [{ type: 'text', text }] : undefined,
      },
    ],
  };
}

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

const STICKY_W = 200;
const STICKY_H = 120;

function createOperationId(prefix: string): string {
  return `shape:${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function toShapeId(value: unknown, fallbackPrefix: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    const raw = value.trim();
    if (raw.startsWith('shape:')) {
      return raw;
    }
    return `shape:${raw.replace(/[^a-zA-Z0-9:_-]/g, '-')}`;
  }
  return createOperationId(fallbackPrefix);
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = toNumber(value, fallback);
  return Math.min(max, Math.max(min, numeric));
}

function toStringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function toUniqueShapeIds(value: unknown): string[] {
  const ids = toStringArray(value).map((id) => toShapeId(id, 'shape-ref'));
  return [...new Set(ids)];
}

function buildMediaPlaceholderOperations(
  arguments_: Record<string, unknown>,
  mediaType: 'image' | 'video',
): CanvasMutationOperation[] {
  const id = toShapeId(arguments_.id, `agent-${mediaType}-placeholder`);
  const prompt = toStringValue(arguments_.prompt, `Untitled ${mediaType}`);
  const status = toStringValue(arguments_.status, 'queued');
  const requestId = toStringValue(arguments_.requestId, '');
  const errorMessage = toStringValue(arguments_.errorMessage, '');

  const statusLabel =
    status === 'completed'
      ? 'ready'
      : status === 'failed' || status === 'nsfw'
        ? 'failed'
        : 'pending';

  const terminalLine =
    errorMessage.length > 0
      ? `\nError: ${errorMessage}`
      : status === 'completed'
        ? '\nStatus: completed'
        : status === 'nsfw'
          ? '\nStatus: blocked (nsfw)'
          : '';

  const placeholderText =
    mediaType === 'video'
      ? `Video generation (${statusLabel}): ${prompt}${terminalLine}`
      : `Image generation (${statusLabel}): ${prompt}${terminalLine}`;

  const centerX = clampNumber(arguments_.x, -5000, 5000, 260);
  const centerY = clampNumber(arguments_.y, -5000, 5000, 210);

  return [
    {
      kind: 'create',
      targetIds: [id],
      payload: {
        shapeInput: {
          id,
          type: 'note',
          x: centerX - STICKY_W / 2,
          y: centerY - STICKY_H / 2,
          props: {
            richText: toRichText(placeholderText),
            color: mediaType === 'video' ? 'light-blue' : 'light-green',
          },
          meta: {
            agentText: placeholderText,
            agentMedia: {
              provider: toStringValue(arguments_.provider, 'higgsfield'),
              mediaType,
              prompt,
              requestId,
              status,
              statusUrl: toStringValue(arguments_.statusUrl, ''),
              cancelUrl: toStringValue(arguments_.cancelUrl, ''),
              imageUrl: toStringValue(arguments_.imageUrl, ''),
              videoUrl: toStringValue(arguments_.videoUrl, ''),
              submittedAt: toStringValue(arguments_.submittedAt, new Date().toISOString()),
              errorMessage,
            },
          },
        },
        mediaRequest:
          requestId.length > 0
            ? {
                requestId,
                mediaType,
                shapeId: id,
                status,
              }
            : undefined,
      },
    },
  ];
}

function mapToolPayloadToOperations(action: CanvasActionEnvelope): CanvasMutationOperation[] {
  const toolName = typeof action.payload.toolName === 'string' ? action.payload.toolName : '';
  const arguments_ =
    typeof action.payload.arguments === 'object' && action.payload.arguments !== null
      ? (action.payload.arguments as Record<string, unknown>)
      : {};

  if (toolName === 'place_sticky') {
    const text = toStringValue(arguments_.text, 'New note');
    const id = toShapeId(arguments_.id, 'agent-sticky');
    const centerX = clampNumber(arguments_.x, -5000, 5000, 240);
    const centerY = clampNumber(arguments_.y, -5000, 5000, 180);
    const color = toStringValue(arguments_.color, 'yellow');
    return [
      {
        kind: 'create',
        targetIds: [id],
        payload: {
          shapeInput: {
            id,
            type: 'note',
            x: centerX - STICKY_W / 2,
            y: centerY - STICKY_H / 2,
            props: {
              richText: toRichText(text),
              color,
            },
            meta: {
              agentText: text,
            },
          },
        },
      },
    ];
  }

  if (toolName === 'place_geo') {
    const text = toStringValue(arguments_.text, 'New shape');
    const id = toShapeId(arguments_.id, 'agent-geo');
    const w = clampNumber(arguments_.w, 40, 1200, 160);
    const h = clampNumber(arguments_.h, 30, 1200, 80);
    const centerX = clampNumber(arguments_.x, -5000, 5000, 240);
    const centerY = clampNumber(arguments_.y, -5000, 5000, 180);
    const shape = toStringValue(arguments_.shape, 'rectangle');
    const color = toStringValue(arguments_.color, 'black');

    return [
      {
        kind: 'create',
        targetIds: [id],
        payload: {
          shapeInput: {
            id,
            type: 'geo',
            x: centerX - w / 2,
            y: centerY - h / 2,
            props: {
              geo: shape,
              w,
              h,
              richText: toRichText(text),
              color,
              fill: 'solid',
              dash: 'draw',
              size: 'm',
            },
            meta: {
              agentText: text,
            },
          },
        },
      },
    ];
  }

  if (toolName === 'place_text') {
    const text = toStringValue(arguments_.text, 'Text');
    const id = toShapeId(arguments_.id, 'agent-text');
    const color = toStringValue(arguments_.color, 'black');
    const centerX = clampNumber(arguments_.x, -5000, 5000, 240);
    const centerY = clampNumber(arguments_.y, -5000, 5000, 180);
    return [
      {
        kind: 'create',
        targetIds: [id],
        payload: {
          shapeInput: {
            id,
            type: 'text',
            // For text shapes we receive center coordinates from the planner.
            // Create first, then recenter in App.tsx using measured bounds.
            x: centerX,
            y: centerY,
            props: {
              richText: toRichText(text),
              color,
              size: 'xl',
              font: 'draw',
              autoSize: true,
            },
            meta: {
              agentText: text,
            },
          },
          center: { x: centerX, y: centerY },
        },
      },
    ];
  }

  if (toolName === 'summarize_region') {
    const region =
      typeof arguments_.region === 'object' && arguments_.region !== null
        ? (arguments_.region as Record<string, unknown>)
        : {};
    const regionX = toNumber(region.x, 240);
    const regionY = toNumber(region.y, 180);
    const regionWidth = Math.max(0, toNumber(region.width, 0));
    const regionHeight = Math.max(0, toNumber(region.height, 0));
    const regionCenterX = regionWidth > 0 ? regionX + regionWidth / 2 : regionX;
    const regionCenterY = regionHeight > 0 ? regionY + regionHeight / 2 : regionY;
    const providedSummary = toStringValue(arguments_.summary, '');
    const summaryText =
      providedSummary.length > 0
        ? providedSummary
        : `Summary generated by agent for region ${Math.round(regionX)},${Math.round(regionY)} ${Math.round(regionWidth)}x${Math.round(regionHeight)}`;
    const id = createOperationId('agent-summary');
    return [
      {
        kind: 'create',
        targetIds: [id],
        payload: {
          shapeInput: {
            id,
            type: 'note',
            x: clampNumber(regionCenterX, -5000, 5000, 240),
            y: clampNumber(regionCenterY, -5000, 5000, 180),
            props: {
              richText: toRichText(summaryText),
            },
            meta: {
              agentText: summaryText,
            },
          },
        },
      },
    ];
  }

  if (toolName === 'draw_arrow') {
    const fromShapeId = toShapeId(arguments_.fromShapeId, 'unknown-from');
    const toShapeIdValue = toShapeId(arguments_.toShapeId, 'unknown-to');
    const id = toShapeId(arguments_.arrowId ?? arguments_.id, 'agent-arrow');
    const label = typeof arguments_.label === 'string' ? arguments_.label.trim() : '';
    return [
      {
        kind: 'create',
        targetIds: [id],
        payload: {
          shapeInput: {
            id,
            type: 'arrow',
            x: 0,
            y: 0,
            props: {
              start: { x: 0, y: 0 },
              end: { x: 0, y: 0 },
              arrowheadEnd: 'arrow',
              arrowheadStart: 'none',
              ...(label.length > 0 ? { text: label } : {}),
            },
          },
          bindings: [
            {
              fromId: id,
              toId: fromShapeId,
              type: 'arrow',
              props: {
                terminal: 'start',
                normalizedAnchor: { x: 0.5, y: 0.5 },
                isPrecise: false,
                isExact: false,
                snap: 'none',
              },
            },
            {
              fromId: id,
              toId: toShapeIdValue,
              type: 'arrow',
              props: {
                terminal: 'end',
                normalizedAnchor: { x: 0.5, y: 0.5 },
                isPrecise: false,
                isExact: false,
                snap: 'none',
              },
            },
          ],
        },
      },
    ];
  }

  if (toolName === 'update_shape') {
    const id = toShapeId(arguments_.id, 'update-target');
    const text = typeof arguments_.text === 'string' ? arguments_.text : undefined;
    const x = typeof arguments_.x === 'number' && Number.isFinite(arguments_.x) ? arguments_.x : undefined;
    const y = typeof arguments_.y === 'number' && Number.isFinite(arguments_.y) ? arguments_.y : undefined;

    if (text === undefined && x === undefined && y === undefined) {
      return [];
    }

    return [
      {
        kind: 'update',
        targetIds: [id],
        payload: {
          shapePatch: {
            ...(text !== undefined ? { text } : {}),
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
          },
        },
      },
    ];
  }

  if (toolName === 'delete_shape') {
    const id = toShapeId(arguments_.id, 'delete-target');
    return [
      {
        kind: 'delete',
        targetIds: [id],
        payload: {},
      },
    ];
  }

  if (toolName === 'cluster_shapes') {
    const shapeIds = toUniqueShapeIds(arguments_.shapeIds);
    if (shapeIds.length < 2) {
      return [];
    }
    const clusterLabel = typeof arguments_.label === 'string' ? arguments_.label.trim() : '';
    const groupId =
      typeof arguments_.groupId === 'string' && arguments_.groupId.trim().length > 0
        ? toShapeId(arguments_.groupId, 'agent-group')
        : undefined;

    return [
      {
        kind: 'batch',
        targetIds: shapeIds,
        payload: {
          groupShapeIds: shapeIds,
          ...(groupId ? { groupId } : {}),
          ...(clusterLabel.length > 0 ? { label: clusterLabel } : {}),
        },
      },
    ];
  }

  if (toolName === 'generate_image') {
    return buildMediaPlaceholderOperations(arguments_, 'image');
  }

  if (toolName === 'generate_video') {
    return buildMediaPlaceholderOperations(arguments_, 'video');
  }

  return [];
}

function toOperations(action: CanvasActionEnvelope): CanvasMutationOperation[] {
  if (action.kind === 'shape.batch') {
    if (typeof action.payload.toolName === 'string') {
      return mapToolPayloadToOperations(action);
    }

    const operations = action.payload.operations;
    if (Array.isArray(operations)) {
      return operations.map((operation) => ({
        kind: (operation as { kind?: CanvasMutationOperation['kind'] }).kind ?? 'batch',
        targetIds: Array.isArray((operation as { targetIds?: unknown }).targetIds)
          ? ((operation as { targetIds: string[] }).targetIds)
          : [],
        payload: typeof operation === 'object' && operation !== null ? (operation as Record<string, unknown>) : {},
      }));
    }
  }

  return [
    {
      kind:
        action.kind === 'shape.create'
          ? 'create'
          : action.kind === 'shape.update'
            ? 'update'
            : action.kind === 'shape.delete'
              ? 'delete'
              : 'batch',
      targetIds: Array.isArray(action.payload.shapeIds)
        ? (action.payload.shapeIds as string[])
        : action.payload.shapeId
          ? [String(action.payload.shapeId)]
          : [],
      payload: action.payload,
    },
  ];
}

export function applyCanvasAction(action: CanvasActionEnvelope): CanvasMutationPlan {
  return {
    actionId: action.id,
    roomId: action.roomId,
    turnId: action.turnId,
    source: action.source,
    suppressAgentRetrigger: action.source !== 'local',
    operations: toOperations(action),
  };
}
