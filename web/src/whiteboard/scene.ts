export type WhiteboardShape = {
  id: string;
  type: string;
  parentId: string;
  text?: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  bindings: Array<{
    type: string;
    fromId: string;
    toId: string;
  }>;
};

function rounded(value: number) {
  return Math.round(value);
}

export function summarizeWhiteboard(shapes: readonly WhiteboardShape[]) {
  if (shapes.length === 0) return "The whiteboard is empty.";

  const typeCounts = shapes.reduce<Record<string, number>>((counts, shape) => {
    counts[shape.type] = (counts[shape.type] ?? 0) + 1;
    return counts;
  }, {});

  const describedShapes = shapes.slice(0, 100).map((shape) => ({
    id: shape.id,
    type: shape.type,
    parentId: shape.parentId,
    ...(shape.text?.trim() ? { text: shape.text.trim().slice(0, 500) } : {}),
    bounds: {
      x: rounded(shape.bounds.x),
      y: rounded(shape.bounds.y),
      width: rounded(shape.bounds.width),
      height: rounded(shape.bounds.height)
    },
    ...(shape.bindings.length > 0 ? { bindings: shape.bindings } : {})
  }));

  return JSON.stringify({
    shapeCount: shapes.length,
    typeCounts,
    shapes: describedShapes,
    truncated: shapes.length > describedShapes.length
  });
}
