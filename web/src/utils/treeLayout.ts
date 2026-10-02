/** Minimal structural shape needed for tree layout (GNode satisfies it). */
export interface LayoutNode {
  x: number;
  y: number;
  depth: number;
  children: LayoutNode[];
}

/**
 * Tidy tree layout: parents stay centered over their children, and every row
 * packs independently (nodes on different depths may share x positions, so a
 * deep narrow subtree tucks under short siblings instead of leaving a gap).
 *
 * When a node collides with an already-placed node on its row, the WHOLE
 * subtree shifts right as a block (never the node alone): internal centering
 * is preserved, single-child chains stay perfectly vertical, and sibling
 * order is kept. Overlap within a row is impossible by construction.
 */
export function layoutTidyTree(
  roots: LayoutNode[],
  nodeW: number,
  nodeH: number,
  hGap: number,
  vGap: number,
): void {
  const rowH = nodeH + vGap;
  // depth -> max right edge (x + nodeW) already placed on that row.
  const rightEdge = new Map<number, number>();

  /** Shifts a node and all its descendants right, extending row extents. */
  const shiftSubtree = (n: LayoutNode, dx: number): void => {
    n.x += dx;
    const edge = n.x + nodeW;
    if ((rightEdge.get(n.depth) ?? -Infinity) < edge) {
      rightEdge.set(n.depth, edge);
    }
    for (const c of n.children) shiftSubtree(c, dx);
  };

  const record = (n: LayoutNode): void => {
    const edge = n.x + nodeW;
    if ((rightEdge.get(n.depth) ?? -Infinity) < edge) {
      rightEdge.set(n.depth, edge);
    }
  };

  const place = (n: LayoutNode): void => {
    for (const c of n.children) place(c);
    if (n.children.length > 0) {
      const first = n.children[0];
      const last = n.children[n.children.length - 1];
      n.x = (first.x + last.x) / 2;
    } else {
      n.x = 0;
    }
    n.y = n.depth * rowH;
    const occupied = rightEdge.get(n.depth);
    const clearX = occupied === undefined ? 0 : occupied + hGap;
    if (n.x < clearX) {
      // Move the whole subtree, not just this node: centering is preserved
      // and descendants (placed left of everything to come) stay collision-free.
      shiftSubtree(n, clearX - n.x);
    } else {
      record(n);
    }
  };
  for (const r of roots) place(r);
}
