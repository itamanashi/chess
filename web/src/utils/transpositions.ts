/**
 * Regroupement des transpositions : une même position (même FEN normalisée)
 * atteinte par plusieurs ordres de coups n'est affichée qu'UNE fois.
 *
 * La première occurrence (parcours en profondeur, de gauche à droite) est
 * conservée ; les suivantes sont élaguées et remplacées par un lien
 * « arc » ({@link TranspoLink}) entre leur parent et le nœud conservé.
 * Les enfants des doublons sont greffés sous le nœud conservé (même UCI =
 * même suite, greffe récursive), donc aucune ligne n'est perdue.
 */

export interface TranspoLink<N> {
  /** Parent de l'occurrence élaguée (point de départ de l'arc). */
  from: N;
  /** Nœud unique conservé (point d'arrivée de l'arc). */
  to: N;
}

interface Mergable<N> {
  key: string;
  sanPath: string[];
  path: string[];
  fenKey: string;
  depth: number;
  transposition: boolean;
  children: N[];
}

function lastUci(path: string[]): string {
  return path[path.length - 1] ?? '';
}

function lastSan(sanPath: string[]): string {
  return sanPath[sanPath.length - 1] ?? '';
}

export function mergeTranspositions<N extends Mergable<N>>(roots: N[]): {
  roots: N[];
  links: TranspoLink<N>[];
} {
  const links: TranspoLink<N>[] = [];
  const canonicalByFen = new Map<string, N>();

  const register = (n: N): void => {
    if (n.fenKey && !canonicalByFen.has(n.fenKey)) canonicalByFen.set(n.fenKey, n);
  };

  /** Ré-enracine n (et tout son sous-arbre) sous parent : chemins et profondeurs. */
  const reRoot = (parent: N, n: N): void => {
    const newBase = [...parent.path, lastUci(n.path)];
    const newSanBase = [...parent.sanPath, lastSan(n.sanPath)];
    const oldBaseLen = n.path.length;
    const dDepth = parent.depth + 1 - n.depth;
    const fix = (m: N): void => {
      const rel = m.path.slice(oldBaseLen);
      const relSan = m.sanPath.slice(oldBaseLen);
      m.path = [...newBase, ...rel];
      m.sanPath = [...newSanBase, ...relSan];
      m.key = m.path.join(' ');
      m.depth += dDepth;
      for (const c of m.children) fix(c);
    };
    fix(n);
  };

  /** Greffe le sous-arbre n sous parent (doublons résolus récursivement). */
  const integrate = (parent: N, n: N): void => {
    // Même coup (UCI) déjà présent sous ce parent : même position à coup sûr
    // (les échecs sont déterministes) → suites fusionnées, sans arc.
    const uci = lastUci(n.path);
    const existing = parent.children.find((c) => lastUci(c.path) === uci);
    if (existing) {
      for (const gch of n.children) integrate(existing, gch);
      return;
    }
    // Même position déjà affichée ailleurs (autre route) → arc rouge.
    const canon = n.fenKey ? canonicalByFen.get(n.fenKey) : undefined;
    if (canon) {
      links.push({ from: parent, to: canon });
      canon.transposition = true;
      for (const gch of n.children) integrate(canon, gch);
      return;
    }
    reRoot(parent, n);
    parent.children.push(n);
    register(n);
    const kids = n.children;
    n.children = [];
    for (const k of kids) integrate(n, k);
  };

  const out: N[] = [];
  for (const r of roots) {
    const canon = r.fenKey ? canonicalByFen.get(r.fenKey) : undefined;
    if (canon) {
      // Racine en double (quasi impossible : premiers coups distincts) :
      // pas de parent pour l'arc, on greffe juste les enfants.
      for (const ch of r.children) integrate(canon, ch);
    } else {
      register(r);
      out.push(r);
      const kids = r.children;
      r.children = [];
      for (const k of kids) integrate(r, k);
    }
  }
  return { roots: out, links };
}

/** Recalcule les parts/fréquences de chaque fratrie (les greffes changent les fratries). */
export function renormalizeShares<N extends Mergable<N> & { share: number; freq: number; parties: number }>(
  siblings: N[],
): void {
  const total = siblings.reduce((s, c) => s + (c.parties ?? 0), 0) || 1;
  for (const c of siblings) {
    c.share = (c.parties ?? 0) / total;
    c.freq = c.share * 100;
    renormalizeShares(c.children);
  }
}
