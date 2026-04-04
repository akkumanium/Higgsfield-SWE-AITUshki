import type { AgentContextRequest, AgentContextResponse, CanvasShapeSnapshot } from '@ai-canvas/shared';

function overlapsViewport(
  viewport: AgentContextRequest['viewport'],
  shape: CanvasShapeSnapshot,
  margin = 160,
) {
  const left = viewport.x - margin;
  const top = viewport.y - margin;
  const right = viewport.x + viewport.width + margin;
  const bottom = viewport.y + viewport.height + margin;
  const shapeRight = shape.bounds.x + shape.bounds.width;
  const shapeBottom = shape.bounds.y + shape.bounds.height;

  return shape.bounds.x <= right && shapeRight >= left && shape.bounds.y <= bottom && shapeBottom >= top;
}

function viewportOverlapScore(viewport: AgentContextRequest['viewport'], shape: CanvasShapeSnapshot) {
  const viewportCenterX = viewport.x + viewport.width / 2;
  const viewportCenterY = viewport.y + viewport.height / 2;
  const shapeCenterX = shape.bounds.x + shape.bounds.width / 2;
  const shapeCenterY = shape.bounds.y + shape.bounds.height / 2;
  const dx = Math.abs(viewportCenterX - shapeCenterX);
  const dy = Math.abs(viewportCenterY - shapeCenterY);
  return Math.sqrt(dx * dx + dy * dy);
}

function compressClusterShapes(shapes: CanvasShapeSnapshot[]) {
  const clustered = new Map<string, CanvasShapeSnapshot[]>();

  for (const shape of shapes) {
    if (!shape.clusterId) {
      continue;
    }
    const existing = clustered.get(shape.clusterId) ?? [];
    existing.push(shape);
    clustered.set(shape.clusterId, existing);
  }

  const clusterSummaries: CanvasShapeSnapshot[] = [];
  const consumedShapeIds = new Set<string>();

  for (const [clusterId, clusterShapes] of clustered) {
    for (const shape of clusterShapes) {
      consumedShapeIds.add(shape.id);
    }
    const firstShape = clusterShapes[0];
    const lastUpdatedAt = clusterShapes.reduce((latest, shape) => (shape.updatedAt > latest ? shape.updatedAt : latest), firstShape.updatedAt);
    clusterSummaries.push({
      id: `cluster-summary:${clusterId}`,
      kind: 'cluster',
      bounds: firstShape.bounds,
      updatedAt: lastUpdatedAt,
      text: `${clusterShapes.length} shapes clustered`,
      clusterId,
      memberShapeIds: clusterShapes.map((shape) => shape.id),
    });
  }

  return {
    compressed: [...shapes.filter((shape) => !consumedShapeIds.has(shape.id)), ...clusterSummaries],
    compressedCount: clusterSummaries.length,
  };
}

export function buildAgentContext(
  request: AgentContextRequest,
  shapes: CanvasShapeSnapshot[] = [],
): AgentContextResponse {
  const visibleShapes = shapes
    .filter((shape) => overlapsViewport(request.viewport, shape))
    .sort((left, right) => {
      const recencyDelta = right.updatedAt.localeCompare(left.updatedAt);
      if (recencyDelta !== 0) {
        return recencyDelta;
      }
      return viewportOverlapScore(request.viewport, left) - viewportOverlapScore(request.viewport, right);
    })
    .slice(0, request.maxShapes);

  const compressed = compressClusterShapes(visibleShapes);
  const tokenBudget = Math.max(1000, 6000 - compressed.compressed.length * 120);

  return {
    ...request,
    shapes: compressed.compressed.slice(0, request.maxShapes).map((shape) => ({
      ...shape,
      distanceFromViewportCenter: viewportOverlapScore(request.viewport, shape),
      viewportOverlap: overlapsViewport(request.viewport, shape) ? 1 : 0,
    })),
    tokenBudget,
    compressedShapeCount: compressed.compressedCount,
    totalShapeCount: visibleShapes.length,
  };
}
