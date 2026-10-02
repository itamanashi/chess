import { describe, expect, it } from 'vitest';
import { mergeTranspositions, renormalizeShares } from './transpositions';

interface T {
  key: string;
  sanPath: string[];
  path: string[];
  fenKey: string;
  depth: number;
  share: number;
  freq: number;
  parties: number;
  transposition: boolean;
  children: T[];
}

let seq = 0;
function node(
  uci: string,
  fenKey: string,
  parties = 10,
  children: T[] = [],
  depth = 0,
  parentPath: string[] = [],
  parentSan: string[] = [],
): T {
  const path = [...parentPath, uci];
  const san = `S${uci}${seq++}`;
  return {
    key: path.join(' '),
    sanPath: [...parentSan, san],
    path,
    fenKey,
    depth,
    share: 0,
    freq: 0,
    parties,
    transposition: false,
    children,
  };
}

function all(n: T, out: T[] = []): T[] {
  out.push(n);
  for (const c of n.children) all(c, out);
  return out;
}

describe('mergeTranspositions', () => {
  it('shows a transposed leaf once with a red-arc link', () => {
    // e4 -> c5 ; Nf3 -> c5 : même position après ...c5 (F).
    const a = node('e2e4', 'F-e4', 60, [], 1);
    a.children = [node('c7c5', 'F', 60, [], 2, a.path, ['e4'])];
    const b = node('g1f3', 'F-Nf3', 40, [], 1);
    b.children = [node('c7c5', 'F', 40, [], 2, b.path, ['Nf3'])];
    const { roots, links } = mergeTranspositions([a, b]);
    // Un seul nœud F affiché, rattaché à la première occurrence (e4).
    const fNodes = roots.flatMap((r) => all(r)).filter((n) => n.fenKey === 'F');
    expect(fNodes).toHaveLength(1);
    expect(fNodes[0].path).toEqual(['e2e4', 'c7c5']);
    // Un arc : depuis le parent de l'occurrence élaguée (Nf3) vers F.
    expect(links).toHaveLength(1);
    expect(links[0].from.path).toEqual(['g1f3']);
    expect(links[0].to).toBe(fNodes[0]);
    expect(fNodes[0].transposition).toBe(true);
  });

  it('grafts the duplicate subtree under the canonical node without losing lines', () => {
    // e4 c5 Nf3 ; Nf3 c5 e4 : même position F, avec une suite sous le doublon.
    const a = node('e2e4', 'F-e4', 60, [], 1);
    a.children = [node('c7c5', 'F', 60, [], 2, a.path, ['e4'])];
    const b = node('g1f3', 'F-Nf3', 40, [], 1);
    const dupF = node('c7c5', 'F', 40, [], 2, b.path, ['Nf3']);
    dupF.children = [node('g1f3', 'F-Nf3-c5', 40, [], 3, dupF.path, ['Nf3', 'c5'])];
    b.children = [dupF];
    const { roots, links } = mergeTranspositions([a, b]);
    const canon = roots.flatMap((r) => all(r)).find((n) => n.fenKey === 'F');
    expect(canon).toBeDefined();
    // La suite du doublon est greffée sous le canonique, chemins réécrits.
    expect(canon!.children).toHaveLength(1);
    const grafted = canon!.children[0];
    expect(grafted.path).toEqual(['e2e4', 'c7c5', 'g1f3']);
    expect(grafted.depth).toBe(3);
    expect(links).toHaveLength(1);
    expect(links[0].from.path).toEqual(['g1f3']);
  });

  it('unifies identical continuations instead of drawing self-links', () => {
    // Même suite d4 jouée sous les deux occurrences de F.
    const a = node('e2e4', 'F-e4', 60, [], 1);
    const fA = node('c7c5', 'F', 60, [], 2, a.path, ['e4']);
    fA.children = [node('d2d4', 'F-d4', 30, [], 3, fA.path, ['e4', 'c5'])];
    a.children = [fA];
    const b = node('g1f3', 'F-Nf3', 40, [], 1);
    const dupF = node('c7c5', 'F', 40, [], 2, b.path, ['Nf3']);
    dupF.children = [node('d2d4', 'F-d4', 20, [], 3, dupF.path, ['Nf3', 'c5'])];
    b.children = [dupF];
    const { roots, links } = mergeTranspositions([a, b]);
    const canon = roots.flatMap((r) => all(r)).find((n) => n.fenKey === 'F');
    expect(canon!.children).toHaveLength(1);
    // Un seul arc (le doublon F), pas d'arc du canonique vers son propre enfant.
    expect(links).toHaveLength(1);
    expect(links[0].to.fenKey).toBe('F');
  });

  it('never merges nodes without fenKey', () => {
    const a = node('e2e4', '', 50, [], 1);
    const b = node('d2d4', '', 50, [], 1);
    const { roots, links } = mergeTranspositions([a, b]);
    expect(roots).toHaveLength(2);
    expect(links).toHaveLength(0);
  });

  it('renormalizes shares after grafting', () => {
    const a = node('e2e4', 'F-e4', 60, [], 1);
    const fA = node('c7c5', 'F', 60, [], 2, a.path, ['e4']);
    fA.children = [node('d2d4', 'F-d4', 30, [], 3, fA.path, ['e4', 'c5'])];
    a.children = [fA];
    const b = node('g1f3', 'F-Nf3', 40, [], 1);
    const dupF = node('c7c5', 'F', 40, [], 2, b.path, ['Nf3']);
    dupF.children = [node('b1c3', 'F-Nc3', 40, [], 3, dupF.path, ['Nf3', 'c5'])];
    b.children = [dupF];
    const { roots } = mergeTranspositions([a, b]);
    renormalizeShares(roots);
    const canon = roots.flatMap((r) => all(r)).find((n) => n.fenKey === 'F');
    const total = canon!.children.reduce((s, c) => s + c.parties, 0);
    for (const c of canon!.children) {
      expect(c.share).toBeCloseTo(c.parties / total, 9);
      expect(c.freq).toBeCloseTo((c.parties / total) * 100, 9);
    }
  });
});
