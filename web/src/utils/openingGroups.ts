import { Chess } from 'chess.js';
import { normalizeCastleUci, normalizeFen } from './repertoire';
import { splitOpeningName } from './openingsFr';
import type { RepertoireMove, RepertoireRoot } from '../types/chess';

/**
 * Regroupement des ouvertures du répertoire pour l'onglet Ouverture :
 * - nom propre (`ouverture` sinon `eco`) ou, à défaut, nom hérité de
 *   l'ancêtre nommé le plus proche (les coups joués à la main n'ont pas
 *   de nom : ils appartiennent à la variante du parent) ;
 * - variantes regroupées sous leur parent (« Tête : suite ») ;
 * - FEN sans aucun nom (ni propre ni hérité) collectées pour backfill API.
 */

export interface OpeningLeafData {
  /** Clé stable (noms bruts parent + variante). */
  fullKey: string;
  /** Variante courte brute (null = tronc commun sans variante nommée). */
  variant: string | null;
  /** Coups (plis) au répertoire. */
  moves: number;
  /** Parties cumulées (tri). */
  games: number;
  /** Position représentative : la plus jouée. */
  repFen: string;
  repSan: string;
}

export interface OpeningParentData {
  /** Nom brut du parent (ou '?' / code ECO). */
  key: string;
  moves: number;
  games: number;
  leaves: OpeningLeafData[];
}

export interface OpeningInventory {
  parents: OpeningParentData[];
  /** FEN distinctes sans nom (ni propre ni hérité) → backfill Lichess. */
  unknownFens: string[];
}

function ownName(m: RepertoireMove): string | null {
  return m.ouverture || m.eco || null;
}

function fenAfterPath(rootFen: string, uciPath: string[]): string | null {
  try {
    const c = new Chess(rootFen);
    for (const u of uciPath) {
      const std = normalizeCastleUci(c.fen(), u);
      const m = c.move({
        from: std.slice(0, 2),
        to: std.slice(2, 4),
        promotion: std.length > 4 ? std[4] : undefined,
      });
      if (!m) return null;
    }
    return c.fen();
  } catch {
    return null;
  }
}

interface LeafAcc {
  moves: number;
  games: number;
  rep: { fen: string; san: string; parties: number } | null;
}

export function collectOpeningGroups(
  children: RepertoireMove[],
  rootFen: string,
): OpeningInventory {
  const byParent = new Map<string, Map<string, LeafAcc>>();
  const unknownFens = new Set<string>();
  const walk = (
    moves: RepertoireMove[],
    uciPath: string[],
    parentFen: string,
    inherited: string | null,
  ): void => {
    for (const m of moves) {
      const stdUci = normalizeCastleUci(parentFen, m.uci);
      const path = [...uciPath, stdUci];
      const fen = m.fen || fenAfterPath(rootFen, path) || '';
      const effective = ownName(m) ?? inherited;
      if (effective) {
        const { parent, variant } = splitOpeningName(effective);
        let leaves = byParent.get(parent);
        if (!leaves) {
          leaves = new Map();
          byParent.set(parent, leaves);
        }
        const leafKey = variant ?? '';
        let leaf = leaves.get(leafKey);
        if (!leaf) {
          leaf = { moves: 0, games: 0, rep: null };
          leaves.set(leafKey, leaf);
        }
        leaf.moves++;
        leaf.games += m.parties ?? 0;
        if (fen && (!leaf.rep || (m.parties ?? 0) > leaf.rep.parties)) {
          leaf.rep = { fen, san: m.san, parties: m.parties ?? 0 };
        }
      } else if (fen) {
        unknownFens.add(fen);
      }
      walk(m.children || [], path, fen || parentFen, effective);
    }
  };
  walk(children, [], rootFen, null);

  const parents: OpeningParentData[] = [...byParent.entries()]
    .map(([parent, leaves]) => {
      const built: OpeningLeafData[] = [...leaves.entries()]
        .filter(([, l]) => l.rep !== null)
        .map(([variant, l]) => ({
          fullKey: `${parent}\n${variant}`,
          variant: variant === '' ? null : variant,
          moves: l.moves,
          games: l.games,
          repFen: (l.rep as NonNullable<LeafAcc['rep']>).fen,
          repSan: (l.rep as NonNullable<LeafAcc['rep']>).san,
        }))
        .sort((a, b) => b.games - a.games);
      return {
        key: parent,
        moves: built.reduce((s, l) => s + l.moves, 0),
        games: built.reduce((s, l) => s + l.games, 0),
        leaves: built,
      };
    })
    .filter((p) => p.leaves.length > 0)
    .sort((a, b) => b.games - a.games);
  return { parents, unknownFens: [...unknownFens] };
}

export interface OpeningPatch {
  /** FEN de la position (comparée normalisée : compteurs ignorés). */
  fen: string;
  ouverture: string;
  eco: string;
}

/**
 * Applique des noms/ECO Lichess aux positions (ne remplit que les champs
 * manquants, ne touche jamais aux données existantes). Retourne le nombre
 * de coups complétés. Mutation pure (à passer dans `updateActiveRoot`).
 */
export function applyOpeningPatches(root: RepertoireRoot, patches: OpeningPatch[]): number {
  const wanted = new Map<string, OpeningPatch>();
  for (const p of patches) {
    if (!p.fen) continue;
    try {
      const key = normalizeFen(p.fen);
      if (!wanted.has(key)) wanted.set(key, p);
    } catch {
      /* FEN illisible : patch ignoré */
    }
  }
  if (wanted.size === 0) return 0;
  let applied = 0;
  const visit = (moves: RepertoireMove[]): void => {
    for (const m of moves) {
      if ((!m.ouverture || !m.eco) && m.fen) {
        let key: string | null = null;
        try {
          key = normalizeFen(m.fen);
        } catch {
          key = null;
        }
        const p = key ? wanted.get(key) : undefined;
        if (p) {
          let touched = false;
          if (!m.ouverture && p.ouverture) {
            m.ouverture = p.ouverture;
            touched = true;
          }
          if (!m.eco && p.eco) {
            m.eco = p.eco;
            touched = true;
          }
          if (touched) applied++;
        }
      }
      if (m.children) visit(m.children);
    }
  };
  visit(root.children);
  return applied;
}
