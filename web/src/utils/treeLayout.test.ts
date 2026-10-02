import { describe, expect, it } from 'vitest';
import { layoutTidyTree, type LayoutNode } from './treeLayout';

const W = 84;
const H = 84;
const HG = 48;
const VG = 96;
const PITCH = W + HG;

interface Spec {
  depth: number;
  children?: Spec[];
}

function build(spec: Spec): LayoutNode {
  return {
    x: -1,
    y: -1,
    depth: spec.depth,
    children: (spec.children ?? []).map(build),
  };
}

function all(node: LayoutNode, out: LayoutNode[] = []): LayoutNode[] {
  out.push(node);
  for (const c of node.children) all(c, out);
  return out;
}

/** Asserts no two nodes on the same row overlap (min gap = hGap). */
function expectNoOverlap(roots: LayoutNode[]): void {
  const byDepth = new Map<number, LayoutNode[]>();
  for (const n of roots.flatMap((r) => all(r))) {
    const list = byDepth.get(n.depth) ?? [];
    list.push(n);
    byDepth.set(n.depth, list);
  }
  for (const [, level] of byDepth) {
    const xs = level.map((n) => n.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(PITCH - 1e-9);
    }
  }
}

/** Every parent must sit exactly centered over its first/last child. */
function expectCentered(roots: LayoutNode[]): void {
  for (const n of roots.flatMap((r) => all(r))) {
    if (n.children.length > 0) {
      const first = n.children[0];
      const last = n.children[n.children.length - 1];
      expect(n.x).toBeCloseTo((first.x + last.x) / 2, 9);
    }
  }
}

function chain(depths: number[]): Spec {
  // Single-file chain starting at depths[0].
  let spec: Spec = { depth: depths[depths.length - 1] };
  for (let i = depths.length - 2; i >= 0; i--) {
    spec = { depth: depths[i], children: [spec] };
  }
  return spec;
}

describe('layoutTidyTree', () => {
  it('packs a single chain into one straight column', () => {
    const root = build(chain([1, 2, 3, 4, 5]));
    layoutTidyTree([root], W, H, HG, VG);
    for (const n of all(root)) expect(n.x).toBe(0);
  });

  it('centers a parent over symmetric children', () => {
    const root = build({ depth: 1, children: [{ depth: 2 }, { depth: 2 }] });
    layoutTidyTree([root], W, H, HG, VG);
    const [l, r] = root.children;
    expect(l.x).toBe(0);
    expect(r.x).toBe(PITCH);
    expect(root.x).toBe(PITCH / 2);
  });

  it('shifts a tall sibling subtree as a block (stays straight, parents centered)', () => {
    // Left: single node at depth 1. Right: chain depths 1..6.
    const roots = [
      build({ depth: 1 }),
      build(chain([1, 2, 3, 4, 5, 6])),
    ];
    layoutTidyTree(roots, W, H, HG, VG);
    const [, tall] = roots;
    // The whole chain moves right as one column: every level shares the same x.
    const byDepth = new Map(all(tall).map((n) => [n.depth, n.x]));
    for (let d = 1; d <= 6; d++) expect(byDepth.get(d)).toBe(PITCH);
    expectCentered(roots);
    expectNoOverlap(roots);
  });

  it('tucks grandchildren under short siblings without a gap (e4 + 5 replies + 6)', () => {
    // e4 (d1) -> 5 replies (d2), the middle one has a reply (d3) with 6 children (d4).
    const leaf = (depth: number): Spec => ({ depth });
    const root = build({
      depth: 1,
      children: [
        leaf(2),
        leaf(2),
        {
          depth: 2,
          children: [
            {
              depth: 3,
              children: [leaf(4), leaf(4), leaf(4), leaf(4), leaf(4), leaf(4)],
            },
          ],
        },
        leaf(2),
        leaf(2),
      ],
    });
    layoutTidyTree([root], W, H, HG, VG);
    const replies = root.children;
    const parent = replies[2];
    const grandchildren = parent.children[0].children;
    // Parent centered over its 6 children.
    expect(parent.x).toBe((grandchildren[0].x + grandchildren[5].x) / 2);
    // No gap: d4 leaves share x positions with d2 leaves (independent row packing).
    const d2 = replies.map((n) => n.x).sort((a, b) => a - b);
    const d4 = grandchildren.map((n) => n.x).sort((a, b) => a - b);
    expect(d4[0]).toBe(0);
    expect(d4[5]).toBeLessThan(d2[4] + PITCH);
    // Tidy width: 6 leaves wide max, not 10 (old shared-cursor width).
    const maxX = Math.max(...all(root).map((n) => n.x));
    expect(maxX).toBeLessThan(10 * PITCH);
    expectCentered([root]);
    expectNoOverlap([root]);
  });

  it('keeps order left-to-right within each depth', () => {
    const root = build({
      depth: 1,
      children: [
        { depth: 2, children: [{ depth: 3 }, { depth: 3 }] },
        { depth: 2 },
        { depth: 2, children: [{ depth: 3 }] },
      ],
    });
    layoutTidyTree([root], W, H, HG, VG);
    // DFS visitation order per depth must match x order (no crossings).
    const visitOrder: LayoutNode[] = [];
    const visit = (n: LayoutNode): void => {
      visitOrder.push(n);
      for (const c of n.children) visit(c);
    };
    visit(root);
    const byDepth = new Map<number, number[]>();
    for (const n of visitOrder) {
      const list = byDepth.get(n.depth) ?? [];
      list.push(n.x);
      byDepth.set(n.depth, list);
    }
    for (const [, xs] of byDepth) {
      const sorted = [...xs].sort((a, b) => a - b);
      expect(xs).toEqual(sorted);
    }
    expectCentered([root]);
    expectNoOverlap([root]);
  });

  it('never overlaps on uneven variable-depth subtrees', () => {
    const root = build({
      depth: 1,
      children: [
        { depth: 2, children: [{ depth: 3, children: [{ depth: 4 }] }] },
        { depth: 2 },
        {
          depth: 2,
          children: [
            { depth: 3 },
            { depth: 3, children: [{ depth: 4 }, { depth: 4 }] },
            { depth: 3 },
          ],
        },
        { depth: 2, children: [{ depth: 3 }] },
      ],
    });
    layoutTidyTree([root], W, H, HG, VG);
    expectCentered([root]);
    expectNoOverlap([root]);
  });

  it('handles empty forests and single nodes', () => {
    expect(() => layoutTidyTree([], W, H, HG, VG)).not.toThrow();
    const single = build({ depth: 1 });
    layoutTidyTree([single], W, H, HG, VG);
    expect(single.x).toBe(0);
    expect(single.y).toBe(1 * (H + VG));
  });
});
