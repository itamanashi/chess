/**
 * Line Value — induction arrière avec distinction des nœuds.
 * Port de `static/js/linevalue.js` du projet `répertoire`.
 *
 * Deux types de nœuds :
 * - "vous" : c'est à vous de jouer, vous choisissez le coup (max).
 * - "adversaire" : il joue sa distribution empirique (moyenne pondérée
 *   par la fréquence + masse hors-répertoire × résidu), interpolée
 *   avec le max via λ (optimisme).
 *
 * λ = 0 → réalisme pur, λ = 1 → optimisme pur.
 * Le lissage bayésien au feuillage (prior) évite qu'une ligne à
 * 15 parties pèse autant qu'une à 50 000.
 */
export interface LineValueOpts {
  side?: 'white' | 'black';
  optimism?: number;
  residual?: number;
  prior?: number;
  drawWeight?: number;
  /** Couleur du trait à la racine (défaut blanc, position initiale). */
  rootWhite?: boolean;
}

interface LVNode {
  depth: number;
  white?: number;
  black?: number;
  draws?: number;
  freq?: number;
  children?: LVNode[];
  reward?: number;
  valueOptimistic?: number;
  valueRealistic?: number;
  lineValue?: number;
}

/** Forme minimale requise pour l'induction arrière (exportée pour l'élagage auto). */
export type LineValueNode = LVNode;

/** Qui doit jouer à cette profondeur ? Alterne depuis le trait racine. */
function toMove(depth: number, rootWhite = true): 'white' | 'black' {
  return (depth % 2 === 0) === rootWhite ? 'white' : 'black';
}

function leafWinrate(node: LVNode, side: 'white' | 'black', prior: number, drawWeight: number): number {
  const w = node.white || 0;
  const b = node.black || 0;
  const d = node.draws || 0;
  const n = w + b + d;
  const wins = side === 'black' ? b : w;
  return (wins + drawWeight * d + 0.5 * prior) / (n + prior);
}

/**
 * Calcule `reward / valueOptimistic / valueRealistic / lineValue` en place
 * sur tout l'arbre (racine depth 0, enfants depth+1 déjà posés ou recalculés).
 */
export function computeLineValues<T extends LVNode>(root: T | null | undefined, opts: LineValueOpts = {}): void {
  const { side = 'white', optimism = 0.3, residual = 0.5, prior = 30, drawWeight = 0.5, rootWhite = true } = opts;
  if (!root) return;

  const isOurTurn = (node: LVNode): boolean => toMove(node.depth, rootWhite) === side;

  const visit = (node: LVNode): number => {
    node.reward = leafWinrate(node, side, prior, drawWeight);
    const kids = node.children || [];
    if (kids.length === 0) {
      node.valueOptimistic = node.reward;
      node.valueRealistic = node.reward;
      node.lineValue = node.reward;
      return node.lineValue;
    }
    const childValues = kids.map(visit);
    const vmax = Math.max(...childValues);
    if (isOurTurn(node)) {
      node.valueOptimistic = vmax;
      node.valueRealistic = vmax;
      node.lineValue = vmax;
      return vmax;
    }
    let coverage = 0;
    let weighted = 0;
    for (let i = 0; i < kids.length; i++) {
      const p = Math.max(0, kids[i].freq || 0) / 100;
      coverage += p;
      weighted += p * childValues[i];
    }
    const pOther = Math.max(0, 1 - coverage);
    weighted += pOther * residual;
    const v = optimism * vmax + (1 - optimism) * weighted;
    node.valueOptimistic = vmax;
    node.valueRealistic = weighted;
    node.lineValue = v;
    return v;
  };

  visit(root);
}

export function describeLineValueOpts(opts: Required<Pick<LineValueOpts, 'optimism' | 'residual' | 'side'>>): string {
  return `λ=${opts.optimism} R=${opts.residual} ${opts.side}`;
}
