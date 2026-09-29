import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { Cpu, ChevronDown, ChevronRight, Eye, Pin, Scale, Trash2 } from 'lucide-react';
import type { RepertoireItem, RepertoireMove } from '../types/chess';
import { ELO_TARGET_OPTIONS } from '../types/chess';
import { INITIAL_FEN, normalizeCastleUci, materialBalance, normalizeFen } from '../utils/repertoire';
import { frenchOpeningName, frenchOpeningVariant, splitOpeningName } from '../utils/openingsFr';
import { collectOpeningGroups, type OpeningPatch } from '../utils/openingGroups';
import { computeLineValues } from '../utils/lineValue';
import { fetchLichessMoves, hasLichessCache } from '../services/lichess';
import { analyzeLocalFen, isSuperseded, stopLocalAnalysis } from '../services/localEngine';
import { abortableSleep, isAbortError, warn } from '../utils/async';
import { eloTargetLabel } from '../i18n';
import { Chessboard } from './Chessboard';
import { ConfirmDialog } from './ConfirmDialog';

interface RepertoireGraphTreeProps {
  repertoire: RepertoireItem;
  onOpenLine: (rep: RepertoireItem, uciPath: string[]) => void;
  onDeleteMove: (repId: string, uciPath: string[]) => void;
  /** Persiste les noms/ECO complétés via Lichess (backfill onglet Ouverture). */
  onEnrichOpenings: (repId: string, patches: OpeningPatch[]) => void;
}

interface GNode {
  key: string;
  san: string;
  sanPath: string[];
  fen: string;
  fenKey: string;
  playedBy: 'w' | 'b';
  share: number;
  parties: number;
  white: number;
  black: number;
  draws: number;
  freq: number;
  ouverture?: string;
  depth: number;
  path: string[];
  children: GNode[];
  transposition: boolean;
  isMate: boolean;
  lineValue?: number;
  practical?: number;
  reward?: number;
  valueOptimistic?: number;
  valueRealistic?: number;
  x: number;
  y: number;
}

type WhiteMode = 'popular' | 'practical' | 'engine' | 'reward';

/* Layout style projet `répertoire` (tree.js) : cartes rectangulaires,
   profondeur en abscisse, feuilles empilées en ordonnée. */
const NODE_W = 150;
const NODE_H = 48;
const H_GAP = 70;
const V_GAP = 26;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;
/** Positions parentes max interrogées sur Lichess (limite requêtes). */
const MAX_LICHESS_PARENTS = 30;
const LICHESS_GAP_MS = 600;

function buildGraph(
  children: RepertoireMove[],
  depth: number,
  path: string[],
  sanPath: string[],
  maxDepth: number,
  rootWhite: boolean,
  playerColor: 'white' | 'black',
): GNode[] {
  const total = children.reduce((s, c) => s + (c.parties ?? 0), 0) || 1;
  return children.map((ch) => {
    const nodePath = [...path, ch.uci];
    const parties = ch.parties ?? 0;
    const share = parties / total;
    const w = ch.victoires_blancs ?? 0;
    const b = ch.victoires_noirs ?? 0;
    const d = ch.nuls ?? 0;
    const wins = playerColor === 'white' ? w : b;
    const practical = parties > 0 ? ((wins + 0.5 * d) / parties) * 100 : 50;
    let fenKey = '';
    try {
      fenKey = ch.fen ? normalizeFen(ch.fen) : '';
    } catch {
      fenKey = '';
    }
    return {
      key: nodePath.join(' '),
      san: ch.san,
      sanPath: [...sanPath, ch.san],
      fen: ch.fen || '',
      fenKey,
      playedBy: moverOf(ch.fen, depth, rootWhite),
      share,
      parties,
      white: w,
      black: b,
      draws: d,
      freq: share * 100,
      ouverture: ch.ouverture || ch.eco,
      depth,
      path: nodePath,
      children: depth < maxDepth ? buildGraph(ch.children || [], depth + 1, nodePath, [...sanPath, ch.san], maxDepth, rootWhite, playerColor) : [],
      transposition: false,
      isMate: ch.isMate === true,
      practical,
      x: 0,
      y: 0,
    };
  });
}

/**
 * Camp ayant joué le coup : l'inverse du trait dans la position APRÈS le coup.
 * Repli par alternance si le FEN manque (racine non standard).
 */
function moverOf(fen: string | undefined, depth: number, rootWhite: boolean): 'w' | 'b' {
  if (fen) {
    try {
      return new Chess(fen).turn() === 'w' ? 'b' : 'w';
    } catch {
      /* repli ci-dessous */
    }
  }
  const firstWhite = rootWhite;
  return ((depth - 1) % 2 === 0) === firstWhite ? 'w' : 'b';
}

/** Tidy tree vertical : feuilles empilées, parents centrés, x = profondeur. */
function layoutTidy(nodes: GNode[], cursor: { y: number }): void {
  for (const n of nodes) {
    if (n.children.length === 0) {
      n.y = cursor.y;
      cursor.y += NODE_H + V_GAP;
    } else {
      layoutTidy(n.children, cursor);
      n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
    }
    n.x = n.depth * (NODE_W + H_GAP);
  }
}

export interface OpeningSelection {
  /** Nom brut du parent (tel que dans l'onglet Ouverture). */
  parent: string;
  /** Variante brute (null = tout le parent). */
  variant: string | null;
}

/**
 * Élagage du graphe à une ouverture : garde les nœuds correspondants ET
 * leurs ancêtres (l'arbre reste connecté depuis la racine). Le nom effectif
 * hérite comme dans l'onglet Ouverture (coups manuels sans nom).
 */
function pruneToOpening(ns: GNode[], inherited: string | null, sel: OpeningSelection): GNode[] {
  const out: GNode[] = [];
  for (const n of ns) {
    const effective = n.ouverture || inherited;
    const keptChildren = pruneToOpening(n.children, effective, sel);
    let match = false;
    if (effective) {
      const { parent, variant } = splitOpeningName(effective);
      match = parent === sel.parent && (sel.variant === null || variant === sel.variant);
    }
    if (match || keptChildren.length > 0) out.push({ ...n, children: keptChildren });
  }
  return out;
}

function fmtShare(share: number): string {
  const p = share * 100;
  if (share > 0 && p < 1) return '<1 %';
  return `${Math.round(p)} %`;
}

/** Couleur d'accent par fréquence locale (port de core.js du projet `répertoire`). */
function freqColor(f: number): string {
  if (f >= 50) return 'var(--freq-5)';
  if (f >= 25) return 'var(--freq-4)';
  if (f >= 10) return 'var(--freq-3)';
  if (f >= 4) return 'var(--freq-2)';
  return 'var(--freq-1)';
}

/** FEN obtenu en rejouant un chemin UCI depuis le FEN racine (repli). */
function fenForPath(rootFen: string, path: string[]): string | null {
  try {
    const c = new Chess(rootFen);
    for (const u of path) {
      const std = normalizeCastleUci(c.fen(), u);
      const m = c.move({
        from: std.slice(0, 2) as Square,
        to: std.slice(2, 4) as Square,
        promotion: std.length > 4 ? std[4] : undefined,
      });
      if (!m) return null;
    }
    return c.fen();
  } catch {
    return null;
  }
}

function formatLine(sans: string[], whiteToMove: boolean): string {
  const parts: string[] = [];
  let i = 0;
  let moveNo = 1;
  if (!whiteToMove && sans.length > 0) {
    parts.push(`1… ${sans[0]}`);
    i = 1;
    moveNo = 2;
  }
  for (; i < sans.length; i += 2) {
    const w = sans[i];
    const b = sans[i + 1];
    parts.push(b ? `${moveNo}. ${w} ${b}` : `${moveNo}. ${w}`);
    moveNo++;
  }
  return parts.join(' ');
}

export const RepertoireGraphTree: React.FC<RepertoireGraphTreeProps> = ({
  repertoire,
  onOpenLine,
  onDeleteMove,
  onEnrichOpenings,
}) => {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ path: string[]; san: string } | null>(null);
  const [lichessShares, setLichessShares] = useState<Map<string, number>>(new Map());
  const [shareProgress, setShareProgress] = useState<{ done: number; total: number } | null>(null);
  const [shareMissing, setShareMissing] = useState(0);
  // Mode répertoire : un seul coup blanc par position (les autres restent explorés, masqués).
  const [oneWhitePerLine, setOneWhitePerLine] = useState(false);
  const [whiteMode, setWhiteMode] = useState<WhiteMode>('reward');
  const [optimism, setOptimism] = useState(0.3);
  const [residual, setResidual] = useState(0.5);
  // Caméra libre (port de camera.js).
  const [cam, setCam] = useState({ x: 0, y: 0, scale: 1 });
  const autoFitRef = useRef(true);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  // Visualiseur : position survolée/épinglée ou liste des ouvertures.
  const [viewerTab, setViewerTab] = useState<'position' | 'openings'>('position');
  /** Évals par ouverture (batch à la demande, file background du moteur). */
  const [openEvals, setOpenEvals] = useState<Record<string, { score: string; depth: number }>>({});
  const [openEvalRunning, setOpenEvalRunning] = useState(false);
  const [openEvalProgress, setOpenEvalProgress] = useState({ done: 0, total: 0 });
  const openEvalCancel = useRef(false);
  /** Filtre du graphe depuis l'onglet Ouverture (null = tout l'arbre). */
  const [selectedOpening, setSelectedOpening] = useState<OpeningSelection | null>(null);
  /** Groupes repliés (chevron) : n'affecte que la liste, pas le filtre. */
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  /** Backfill des noms d'ouvertures manquants (Lichess Masters, persistant). */
  const [nameLoading, setNameLoading] = useState(false);
  const [nameProgress, setNameProgress] = useState({ done: 0, total: 0 });
  const [nameStatus, setNameStatus] = useState<string | null>(null);
  const nameCancel = useRef(false);
  const nameAbort = useRef<AbortController | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const suppressClickRef = useRef(false);

  const rootChildren = repertoire.root?.children || [];
  const rootFen = repertoire.root?.fen || INITIAL_FEN;
  const eloConfig = ELO_TARGET_OPTIONS.find((o) => o.key === repertoire.targetElo) || ELO_TARGET_OPTIONS[0];

  useEffect(() => {
    setHoverKey(null);
    setPinnedKey(null);
    setSelectedId(null);
    autoFitRef.current = true;
    openEvalCancel.current = true;
    setOpenEvals({});
    setOpenEvalRunning(false);
    setOpenEvalProgress({ done: 0, total: 0 });
    setSelectedOpening(null);
    setCollapsedParents(new Set());
    nameCancel.current = true;
    nameAbort.current?.abort();
    setNameLoading(false);
  }, [rootChildren]);

  useEffect(() => {
    return () => {
      openEvalCancel.current = true;
      nameCancel.current = true;
      nameAbort.current?.abort();
    };
  }, []);

  const rootWhiteToMove = useMemo(() => {
    try {
      return new Chess(rootFen).turn() === 'w';
    } catch {
      return true;
    }
  }, [rootFen]);

  const { nodes, rootPos, width, height } = useMemo(() => {
    const built = buildGraph(rootChildren, 1, [], [], Number.POSITIVE_INFINITY, rootWhiteToMove, repertoire.color);
    const fenCounts = new Map<string, number>();
    const collectFen = (ns: GNode[]): void => {
      for (const n of ns) {
        const fk = n.fenKey || n.fen;
        if (fk) fenCounts.set(fk, (fenCounts.get(fk) || 0) + 1);
        collectFen(n.children);
      }
    };
    collectFen(built);
    const markTranspo = (ns: GNode[]): void => {
      for (const n of ns) {
        const fk = n.fenKey || n.fen;
        n.transposition = !!fk && (fenCounts.get(fk) || 0) > 1;
        markTranspo(n.children);
      }
    };
    markTranspo(built);
    try {
      const pseudoRoot = {
        depth: 0, white: 0, black: 0, draws: 0, freq: 100,
        children: built as unknown as never[],
      };
      computeLineValues(pseudoRoot, {
        side: repertoire.color, optimism, residual, prior: 30, drawWeight: 0.5,
      });
    } catch {
      /* arbre partiel : on garde les valeurs déjà posées */
    }

    const isWhitePly = (depth: number): boolean => {
      try {
        const turnRoot = new Chess(rootFen).turn();
        return ((depth - 1) % 2 === 0) === (turnRoot === 'w');
      } catch {
        return depth % 2 === 1;
      }
    };
    const scoreOf = (n: GNode): number => {
      if (whiteMode === 'practical') return n.practical ?? 0;
      if (whiteMode === 'reward') return (n.lineValue ?? 0) * 1000 + (n.freq || 0);
      return n.parties;
    };
    const filterWhite = (ns: GNode[]): GNode[] => {
      if (!oneWhitePerLine) return ns;
      const whites = ns.filter((n) => isWhitePly(n.depth));
      if (whites.length <= 1) return ns;
      let best = whites[0];
      for (const w of whites) if (scoreOf(w) > scoreOf(best)) best = w;
      return ns.filter((n) => !isWhitePly(n.depth) || n.key === best.key);
    };
    const applyFilter = (ns: GNode[]): GNode[] => {
      const kept = filterWhite(ns);
      for (const n of kept) n.children = applyFilter(n.children);
      return kept;
    };
    const visible = applyFilter(selectedOpening ? pruneToOpening(built, null, selectedOpening) : built);
    layoutTidy(visible, { y: 0 });
    let maxX = 0;
    let maxY = 0;
    let deepest = 1;
    const visit = (ns: GNode[]): void => {
      for (const n of ns) {
        deepest = Math.max(deepest, n.depth);
        maxX = Math.max(maxX, n.x + NODE_W);
        maxY = Math.max(maxY, n.y + NODE_H);
        visit(n.children);
      }
    };
    visit(visible);
    const rootY = visible.length > 0
      ? (visible[0].y + visible[visible.length - 1].y) / 2
      : 0;
    return {
      nodes: visible,
      rootPos: { x: 0, y: rootY },
      width: Math.max(maxX + 100, 320),
      height: Math.max(maxY + 100, 200),
    };
  }, [rootChildren, rootWhiteToMove, repertoire.color, rootFen, oneWhitePerLine, whiteMode, optimism, residual, selectedOpening]);

  const nodeByKey = useMemo(() => {
    const map = new Map<string, GNode>();
    const visit = (ns: GNode[]): void => {
      for (const n of ns) {
        if (!n.fen) n.fen = fenForPath(rootFen, n.path) ?? '';
        if (!n.fenKey && n.fen) {
          try {
            n.fenKey = normalizeFen(n.fen);
          } catch {
            /* garde la clé vide */
          }
        }
        map.set(n.key, n);
        visit(n.children);
      }
    };
    visit(nodes);
    return map;
  }, [nodes, rootFen]);

  /* ---------- Onglet Ouverture : variantes regroupées sous leur parent ---------- */
  const { parents: openingParents, unknownFens } = useMemo(
    () => collectOpeningGroups(rootChildren, rootFen),
    [rootChildren, rootFen],
  );

  /** Évalue la ligne principale de chaque variante (prof. 12, file
   *  background : le survol reste prioritaire). Clé = FEN (stable quand les
   *  noms changent via backfill). Annulable, session uniquement (le cache
   *  moteur par FEN rend les relances gratuites de toute façon). */
  const analyzeOpeningEvals = useCallback(async () => {
    if (openEvalRunning) return;
    openEvalCancel.current = false;
    const leaves = openingParents.flatMap((p) => p.leaves);
    setOpenEvalRunning(true);
    setOpenEvalProgress({ done: 0, total: leaves.length });
    let done = 0;
    for (const leaf of leaves) {
      if (openEvalCancel.current) break;
      try {
        const moves = await analyzeLocalFen(leaf.repFen, { multiPv: 1, depth: 12, timeoutMs: 8000 });
        if (openEvalCancel.current) break;
        const top = moves[0];
        if (top) {
          const key = leaf.repFen;
          const val = { score: top.scoreFormatted, depth: top.depth };
          setOpenEvals((prev) => (prev[key] ? prev : { ...prev, [key]: val }));
        }
      } catch {
        /* position illisible : ligne notée « — », on passe à la suivante */
      }
      done++;
      setOpenEvalProgress({ done, total: leaves.length });
    }
    setOpenEvalRunning(false);
  }, [openingParents, openEvalRunning]);

  /** Nomme les positions sans nom via Lichess Masters et les enregistre
   *  dans le répertoire (champs manquants uniquement). Les FEN déjà en
   *  cache ne coûtent aucune requête. Annulable (le cache Lichess rend la
   *  reprise quasi gratuite). */
  const enrichOpeningNames = useCallback(async () => {
    if (nameLoading || unknownFens.length === 0) return;
    nameCancel.current = false;
    const ctrl = new AbortController();
    nameAbort.current = ctrl;
    setNameLoading(true);
    setNameStatus(null);
    setNameProgress({ done: 0, total: unknownFens.length });
    const pending: OpeningPatch[] = [];
    let done = 0;
    let named = 0;
    for (const fen of unknownFens) {
      if (nameCancel.current || ctrl.signal.aborted) break;
      try {
        if (!hasLichessCache(fen, 'masters')) {
          await abortableSleep(500, ctrl.signal);
        }
        const data = await fetchLichessMoves(fen, undefined, 'masters', undefined, undefined, {
          signal: ctrl.signal,
          timeoutMs: 15000,
          maxRetries: 1,
        });
        if (nameCancel.current || ctrl.signal.aborted) break;
        const name = data.opening?.name?.trim() ?? '';
        const eco = data.opening?.eco?.trim() ?? '';
        if (name || eco) {
          pending.push({ fen, ouverture: name, eco });
          named++;
        }
      } catch (err) {
        if (isAbortError(err)) break;
        /* position en échec isolée : on passe à la suivante */
      }
      done++;
      setNameProgress({ done, total: unknownFens.length });
    }
    if (pending.length > 0) onEnrichOpenings(repertoire.id, pending);
    nameAbort.current = null;
    setNameLoading(false);
    setNameStatus(
      nameCancel.current || ctrl.signal.aborted
        ? `Interrompu : ${named} position(s) nommée(s), enregistrée(s) au répertoire.`
        : named > 0
          ? `${named}/${unknownFens.length} position(s) nommée(s) et enregistrée(s) au répertoire.`
          : 'Aucun nom trouvé sur Lichess pour ces positions.',
    );
  }, [nameLoading, unknownFens, onEnrichOpenings, repertoire.id]);

  const cancelEnrich = useCallback(() => {
    nameCancel.current = true;
    nameAbort.current?.abort();
  }, []);

  /** Clic dans l'onglet Ouverture : ne montre que cette ouverture dans
   *  l'arbre (re-clic = tout l'arbre), avec recentrage automatique. */
  const toggleOpeningFilter = useCallback((parent: string, variant: string | null) => {
    setSelectedOpening((prev) =>
      prev && prev.parent === parent && prev.variant === variant ? null : { parent, variant },
    );
    autoFitRef.current = true;
  }, []);
  const shareRunId = useRef(0);
  useEffect(() => {
    const runId = ++shareRunId.current;
    setLichessShares(new Map());
    setShareMissing(0);
    setShareProgress(null);

    interface ParentReq { path: string[]; fen: string; childUcis: string[] }
    const parents: ParentReq[] = [];
    const walk = (moves: RepertoireMove[], path: string[], parentFen: string): void => {
      if (moves.length === 0 || parents.length >= MAX_LICHESS_PARENTS) return;
      parents.push({ path, fen: parentFen, childUcis: moves.map((m) => m.uci) });
      for (const m of moves) {
        if (parents.length >= MAX_LICHESS_PARENTS) return;
        if (m.children && m.children.length > 0 && m.fen) {
          walk(m.children, [...path, m.uci], m.fen);
        }
      }
    };
    walk(rootChildren, [], rootFen);
    if (parents.length === 0) return;
    const totalSlots = parents.reduce((s, p) => s + p.childUcis.length, 0);

    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      const t0 = Date.now();
      let doneCount = 0;
      const maybeProgress = (): void => {
        if (Date.now() - t0 > 400) setShareProgress({ done: doneCount, total: parents.length });
      };
      let hits = 0;
      for (const p of parents) {
        if (cancelled || shareRunId.current !== runId || ctrl.signal.aborted) return;
        const wasCached = hasLichessCache(p.fen, eloConfig.endpoint, eloConfig.ratingsParam, undefined, eloConfig.since);
        try {
          const data = await fetchLichessMoves(
            p.fen,
            undefined,
            eloConfig.endpoint,
            eloConfig.ratingsParam,
            undefined,
            { signal: ctrl.signal, since: eloConfig.since },
          );
          if (cancelled || shareRunId.current !== runId) return;
          const total = data.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
          if (total > 0) {
            const byUci = new Map<string, number>();
            for (const m of data.moves) {
              const std = normalizeCastleUci(p.fen, m.uci);
              byUci.set(std, (byUci.get(std) ?? 0) + (m.white + m.draws + m.black));
            }
            const entries: [string, number][] = [];
            for (const uci of p.childUcis) {
              const g = byUci.get(uci);
              if (g !== undefined && g > 0) entries.push([[...p.path, uci].join(' '), g / total]);
            }
            hits += entries.length;
            if (entries.length > 0) {
              setLichessShares((prev) => new Map([...prev, ...entries]));
            }
          }
        } catch (err) {
          if (isAbortError(err) || ctrl.signal.aborted) return;
        }
        setShareProgress(null);
        if (!wasCached) {
          try {
            await abortableSleep(LICHESS_GAP_MS, ctrl.signal);
          } catch {
            return;
          }
        }
        doneCount++;
        maybeProgress();
      }
      if (cancelled || shareRunId.current !== runId) return;
      setShareProgress(null);
      setShareMissing(Math.max(0, totalSlots - hits));
    })();

    return () => {
      cancelled = true;
      shareRunId.current++;
      ctrl.abort();
    };
  }, [rootChildren, rootFen, eloConfig]);

  /* ---------- Caméra libre ---------- */
  const fit = (): void => {
    const el = viewportRef.current;
    if (!el) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    if (!vw || !vh || !width || !height) return;
    const pad = 80;
    const s = Math.min((vw - pad * 2) / width, (vh - pad * 2) / height, 1.5);
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s));
    setCam({
      scale,
      x: (vw - width * scale) / 2,
      y: (vh - height * scale) / 2,
    });
  };

  useLayoutEffect(() => {
    if (autoFitRef.current) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      autoFitRef.current = false;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setCam((c) => {
        const ns = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, c.scale * Math.exp(-e.deltaY * 0.0015)));
        const k = ns / c.scale;
        return { scale: ns, x: px - (px - c.x) * k, y: py - (py - c.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const p = panRef.current;
      if (!p) return;
      const dx = e.clientX - p.sx;
      const dy = e.clientY - p.sy;
      if (Math.abs(dx) + Math.abs(dy) > 5) suppressClickRef.current = true;
      setCam((c) => ({ ...c, x: p.cx + dx, y: p.cy + dy }));
    };
    const onUp = (): void => {
      panRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const zoomAtCenter = (factor: number): void => {
    const el = viewportRef.current;
    autoFitRef.current = false;
    if (!el) {
      setCam((c) => ({ ...c, scale: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, c.scale * factor)) }));
      return;
    }
    const px = el.clientWidth / 2;
    const py = el.clientHeight / 2;
    setCam((c) => {
      const ns = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, c.scale * factor));
      const k = ns / c.scale;
      return { scale: ns, x: px - (px - c.x) * k, y: py - (py - c.y) * k };
    });
  };

  /* ---------- Visualiseur ---------- */
  const pinned = pinnedKey ? nodeByKey.get(pinnedKey) : undefined;
  const selectedNode = selectedId ? nodeByKey.get(selectedId) : undefined;
  // Analyse moteur au CLIC (épinglé/sélectionné) uniquement : l'analyse au
  // survol relançait Stockfish à chaque nœud frôlé + re-rendait tout l'arbre
  // (freeze mesuré sur gros répertoires). Le survol garde les stats du tooltip.
  const shown = pinned ?? selectedNode;
  const viewerFen = shown?.fen || rootFen;
  const viewerMaterial = useMemo(() => materialBalance(viewerFen), [viewerFen]);

  const [viewerEval, setViewerEval] = useState<{
    fen: string;
    san: string;
    score: string;
    depth: number;
  } | null>(null);
  const [viewerEvalLoading, setViewerEvalLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setViewerEvalLoading(true);
    const timer = setTimeout(() => {
      analyzeLocalFen(viewerFen, { multiPv: 1, depth: 14, timeoutMs: 12000, priority: 'interactive' })
        .then((moves) => {
          if (cancelled) return;
          const top = moves[0];
          setViewerEval(
            top
              ? { fen: viewerFen, san: top.san, score: top.scoreFormatted, depth: top.depth }
              : null,
          );
          setViewerEvalLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (isSuperseded(err)) {
            setViewerEvalLoading(false);
            return;
          }
          warn('graphtree:viewer-eval', err);
          setViewerEval(null);
          setViewerEvalLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stopLocalAnalysis();
    };
  }, [viewerFen]);

  const evalShown = viewerEval && viewerEval.fen === viewerFen ? viewerEval : null;

  if (rootChildren.length === 0) {
    return (
      <div className="empty-history">
        Répertoire vide pour l'instant — ouvre-le avec « Étudier » et joue des coups pour le remplir.
      </div>
    );
  }

  const displayShare = (n: GNode): { share: number; fromLichess: boolean } => {
    const ls = lichessShares.get(n.key);
    if (ls !== undefined) return { share: ls, fromLichess: true };
    return { share: n.share, fromLichess: false };
  };

  // Coup prometteur par fratrie (étoile) : fréquence locale max.
  // Calculé DANS le bloc mémorisé ci-dessous (ne dépend que de `nodes`).
  const handleNodeClick = (key: string): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setSelectedId(key);
    setPinnedKey((prev) => (prev === key ? null : key));
  };

  const viewerUci = shown?.path[shown.path.length - 1];
  const viewerLastMove: [string, string] | undefined = viewerUci
    ? [viewerUci.slice(0, 2), viewerUci.slice(2, 4)]
    : undefined;

  const renderEdges = (ns: GNode[], px: number, py: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const n of ns) {
      const x1 = px + NODE_W;
      const y1 = py + NODE_H / 2;
      const x2 = n.x;
      const y2 = n.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      out.push(
        <path
          key={`e-${n.key}`}
          d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
          fill="none"
          stroke={n.transposition ? '#f59e0b' : '#475569'}
          strokeWidth={2}
          strokeDasharray={n.transposition ? '5 4' : undefined}
          markerEnd={n.transposition ? 'url(#arrow-transpo)' : 'url(#arrow)'}
        />,
      );
      out.push(...renderEdges(n.children, n.x, n.y));
    }
    return out;
  };

  const renderNodes = (ns: GNode[], promising: Set<string>): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const n of ns) {
      const lv = n.lineValue;
      out.push(
        <div
          key={`n-${n.key}`}
          className={`move-node${selectedId === n.key ? ' selected' : ''}${n.transposition ? ' is-transposition' : ''}${promising.has(n.key) ? ' is-promising' : ''}`}
          style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H, ['--accent' as string]: freqColor(n.freq) }}
          onClick={(e) => {
            e.stopPropagation();
            handleNodeClick(n.key);
          }}
          onMouseEnter={(e) => {
            setHoverKey(n.key);
            setTipPos({ x: e.clientX, y: e.clientY });
          }}
          onMouseMove={(e) => {
            setTipPos({ x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={() => {
            setHoverKey((k) => (k === n.key ? null : k));
            setTipPos(null);
          }}
        >
          <div className="move-label">
            {n.san}
            {n.isMate && (
              <span className="mate-tag" title="Mat — fin forcée, toujours prioritaire à la génération">
                MAT
              </span>
            )}
          </div>
          <div className="move-meta">
            <span className="move-freq">{`${n.freq.toFixed(1)}%`}</span>
            {whiteMode === 'reward' && lv !== undefined && lv > 0 ? (
              <span
                className="move-lv"
                style={{ color: lv >= 0.55 ? 'var(--eval-pos)' : lv >= 0.5 ? 'var(--promising)' : 'var(--eval-neg)' }}
              >
                {`LV ${(lv * 100).toFixed(0)}`}
              </span>
            ) : n.practical !== undefined ? (
              <span
                className="move-practical"
                style={{ color: n.practical >= 55 ? 'var(--eval-pos)' : n.practical >= 50 ? 'var(--promising)' : 'var(--eval-neg)' }}
              >
                {`PS ${n.practical.toFixed(0)}`}
              </span>
            ) : null}
          </div>
        </div>,
      );
      out.push(...renderNodes(n.children, promising));
    }
    return out;
  };

  /**
   * Bloc statique du graphe (nœuds + arêtes) : mémorisé car la caméra est un
   * transform CSS du conteneur. Pan/zoom/survol/tooltip ne re-rendent plus les
   * milliers de nœuds (mesuré : 2 s de blocage à 9000 nœuds avant ce cache).
   */
  const graphStatic = useMemo(() => {
    const promising = new Set<string>();
    const mark = (ns: GNode[]): void => {
      if (ns.length >= 2) {
        let best = ns[0];
        for (const s of ns) if (s.freq > best.freq) best = s;
        promising.add(best.key);
      }
      for (const n of ns) mark(n.children);
    };
    mark(nodes);
    return {
      edges: renderEdges(nodes, rootPos.x, rootPos.y),
      nodeList: renderNodes(nodes, promising),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, rootPos, selectedId, whiteMode]);

  const tipNode = hoverKey ? nodeByKey.get(hoverKey) : undefined;

  return (
    <div className="graph-wrap">
      <div className="graph-controls">
        <span className="graph-zoom-group" title="Mode répertoire : un seul coup blanc par position">
          <label className="graph-mode-toggle">
            <input
              type="checkbox"
              checked={oneWhitePerLine}
              onChange={(e) => setOneWhitePerLine(e.target.checked)}
            />
            <span>1 coup blanc / position</span>
          </label>
          {oneWhitePerLine && (
            <>
              <select
                className="train-select"
                value={whiteMode}
                onChange={(e) => setWhiteMode(e.target.value as WhiteMode)}
                title="Critère de sélection du coup blanc conservé"
              >
                <option value="popular">Populaire</option>
                <option value="reward">Reward (LV)</option>
                <option value="practical">Pratique</option>
                <option value="engine">Moteur</option>
              </select>
              {whiteMode === 'reward' && (
                <span className="graph-reward-opts" title="Optimisme λ et valeur hors-répertoire">
                  <label>
                    λ
                    <input
                      type="range" min={0} max={1} step={0.05} value={optimism}
                      onChange={(e) => setOptimism(Number(e.target.value))}
                    />
                    <span>{optimism.toFixed(2)}</span>
                  </label>
                  <label>
                    R
                    <input
                      type="range" min={0} max={1} step={0.05} value={residual}
                      onChange={(e) => setResidual(Number(e.target.value))}
                    />
                    <span>{residual.toFixed(2)}</span>
                  </label>
                </span>
              )}
            </>
          )}
        </span>
          <span className="tree-hint">Glisser = déplacer • molette = zoom • survol = stats • clic = analyser.</span>
      </div>
      {shareProgress && (
        <div className="graph-note">
          % Lichess ({eloTargetLabel(repertoire.targetElo)}) : {shareProgress.done}/{shareProgress.total} positions…
        </div>
      )}
      {!shareProgress && shareMissing > 0 && (
        <div className="graph-note">
          {shareMissing} coup(s) sans données Lichess : part interne au répertoire affichée.
        </div>
      )}
      <div className="graph-main">
        <div
          className="freecam-viewport"
          ref={viewportRef}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('.move-node, .freecam-ui')) return;
            if (e.button !== 0 && e.button !== 1) return;
            autoFitRef.current = false;
            suppressClickRef.current = false;
            panRef.current = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
            e.preventDefault();
          }}
        >
          <div
            className="freecam-layer"
            style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})` }}
          >
            <svg
              className="tree-edges"
              width={width}
              height={height}
              style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible', pointerEvents: 'none' }}
            >
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
                </marker>
                <marker id="arrow-transpo" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
                </marker>
              </defs>
              {graphStatic.edges}
            </svg>
            <div className="tree-nodes" style={{ position: 'absolute', top: 0, left: 0 }}>
              <div
                className="move-node is-root"
                style={{ left: rootPos.x, top: rootPos.y, width: NODE_W, height: NODE_H, ['--accent' as string]: '#fbbf24' }}
              >
                <div className="move-label">🏁</div>
              </div>
              {graphStatic.nodeList}
            </div>
          </div>

          <div className="freecam-hint">Glisser pour déplacer • Molette pour zoomer</div>
          <div className="freecam-status">{Math.round(cam.scale * 100)}%</div>
          <div className="freecam-ui">
            <button onClick={() => zoomAtCenter(1.25)} title="Zoom +">＋</button>
            <button onClick={() => zoomAtCenter(1 / 1.25)} title="Zoom −">−</button>
            <button onClick={() => { autoFitRef.current = false; fit(); }} title="Ajuster à l'écran">⛶</button>
            <button onClick={() => { autoFitRef.current = true; setCam({ x: 0, y: 0, scale: 1 }); fit(); }} title="Recentrer">⟲</button>
          </div>

          {tipNode && tipPos && (
            <div
              className="freq-tooltip visible"
              style={{ left: Math.min(tipPos.x + 14, window.innerWidth - 220), top: Math.min(tipPos.y + 14, window.innerHeight - 200), position: 'fixed' }}
            >
              <div className="tt-move">{tipNode.san} · prof. {tipNode.depth}</div>
              <div className="tt-row"><span>Fréquence</span><span>{tipNode.freq.toFixed(1)}%</span></div>
              <div className="tt-row"><span>Parties</span><span>{tipNode.parties.toLocaleString('fr-FR')}</span></div>
              <div className="tt-row"><span>Blancs</span><span>{tipNode.white.toLocaleString('fr-FR')}</span></div>
              <div className="tt-row"><span>Noirs</span><span>{tipNode.black.toLocaleString('fr-FR')}</span></div>
              <div className="tt-row"><span>Nulles</span><span>{tipNode.draws.toLocaleString('fr-FR')}</span></div>
              {tipNode.lineValue !== undefined && (
                <div className="tt-row"><span>Line Value</span><span>{(tipNode.lineValue * 100).toFixed(1)}</span></div>
              )}
              {tipNode.transposition && <div className="tt-transpo">🔄 Position déjà vue ailleurs</div>}
            </div>
          )}
        </div>

        <aside className="graph-viewer">
          <div className="graph-viewer-title"><Eye size={14} /> Visualiseur</div>
          <div className="chesscom-filter-group" role="group" aria-label="Contenu du visualiseur">
            <button
              className={`db-toggle-btn ${viewerTab === 'position' ? 'active' : ''}`}
              onClick={() => setViewerTab('position')}
            >
              <span>Position</span>
            </button>
            <button
              className={`db-toggle-btn ${viewerTab === 'openings' ? 'active' : ''}`}
              onClick={() => setViewerTab('openings')}
              title="Une ligne par ouverture du répertoire : nom, coups, éval moteur"
            >
              <span>Ouverture</span>
            </button>
          </div>
          {viewerTab === 'position' ? (
          <>
          <Chessboard
            fen={viewerFen}
            orientation="white"
            onMove={() => false}
            lastMove={viewerLastMove}
            interactive={false}
          />
          <div className="graph-viewer-info">
            {shown ? (
              <>
                <div className="graph-viewer-line">{formatLine(shown.sanPath, rootWhiteToMove)}</div>
                <div className="advice-meta">
                  <span><strong>{shown.san}</strong> ({shown.playedBy === 'w' ? 'Blancs' : 'Noirs'})</span>
                  <span aria-hidden="true">•</span>
                  <span>{fmtShare(displayShare(shown).share)} {displayShare(shown).fromLichess ? 'Lichess' : 'répertoire'}</span>
                  <span aria-hidden="true">•</span>
                  <span>{shown.parties.toLocaleString('fr-FR')} au répertoire</span>
                  {shown.transposition && (
                    <>
                      <span aria-hidden="true">•</span>
                      <span title="Même position atteinte par un autre chemin">⇄ transposition</span>
                    </>
                  )}
                  {shown.lineValue !== undefined && (
                    <>
                      <span aria-hidden="true">•</span>
                      <span title="Line Value (induction arrière)">LV {(shown.lineValue * 100).toFixed(1)}</span>
                    </>
                  )}
                </div>
                {shown.ouverture && <div className="candidate-op-name">{shown.ouverture}</div>}
                <div className="advice-meta" title="Évaluation Stockfish locale de cette position">
                  <span className="viewer-meta-ico">
                    <Cpu size={13} />{' '}
                    {viewerEvalLoading && !evalShown ? (
                      'analyse…'
                    ) : evalShown ? (
                      <>
                        <strong>{evalShown.score}</strong> ({evalShown.san}, prof. {evalShown.depth})
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                </div>
                {viewerMaterial && (
                <div className="advice-meta" title="Différence de matériel (Pion=1, Cavalier=3, Fou=3, Tour=5, Dame=9)">
                  <span className="viewer-meta-ico">
                    <Scale size={13} />{' '}
                      <strong>
                        {viewerMaterial.diffWhite === 0
                          ? 'Égalité (0)'
                          : `${viewerMaterial.diffWhite > 0 ? '+' : ''}${viewerMaterial.diffWhite} ${
                              viewerMaterial.diffWhite > 0 ? 'Blancs' : 'Noirs'
                            }`}
                      </strong>
                    </span>
                  </div>
                )}
                {pinnedKey === shown.key && (
                  <div className="graph-pinned-note"><Pin size={13} /> Épinglé — cliquez le nœud pour retirer.</div>
                )}
                <button
                  className="primary-btn full-width"
                  onClick={() => onOpenLine(repertoire, shown.path)}
                >
                  <span>Ouvrir cette ligne</span>
                </button>
                <button
                  className="secondary-btn full-width btn-danger"
                  onClick={() => setPendingDelete({ path: shown.path, san: shown.san })}
                  title="Supprimer ce coup et toute sa suite du répertoire"
                >
                  <Trash2 size={14} />
                  <span>Supprimer ce coup</span>
                </button>
                {pendingDelete && (
                  <ConfirmDialog
                    title="Supprimer cette suite ?"
                    message={`Supprimer « ${pendingDelete.san} » et toute sa suite du répertoire ?`}
                    onConfirm={() => {
                      onDeleteMove(repertoire.id, pendingDelete.path);
                      setPendingDelete(null);
                    }}
                    onCancel={() => setPendingDelete(null)}
                  />
                )}
              </>
            ) : (
              <div className="empty-history">Survolez un coup pour visualiser, cliquez pour l'épingler ici.</div>
            )}
          </div>
          </>
          ) : (
            <div className="graph-openings">
              <div className="activity-subtitle text-muted">
                {openingParents.length.toLocaleString('fr-FR')} ouverture(s) · cliquez une ligne pour ne montrer qu'elle dans l'arbre (re-clic = tout revoir)
              </div>
              {unknownFens.length > 0 && (
                <>
                  {!nameLoading ? (
                    <button
                      className="action-btn"
                      onClick={enrichOpeningNames}
                      title="Interroge Lichess (base Masters) pour chaque position sans nom et l'enregistre dans le répertoire (champs manquants uniquement). Annulable, positions déjà en cache instantanées."
                    >
                      Compléter les noms ({unknownFens.length.toLocaleString('fr-FR')} position(s) sans nom)
                    </button>
                  ) : (
                    <button
                      className="action-btn"
                      onClick={cancelEnrich}
                      title="Interrompre (les noms déjà trouvés sont enregistrés)"
                    >
                      Annuler ({nameProgress.done}/{nameProgress.total})
                    </button>
                  )}
                  {nameStatus && (
                    <div className="activity-subtitle text-muted" role="status">
                      {nameStatus}
                    </div>
                  )}
                </>
              )}
              {!openEvalRunning ? (
                <button
                  className="action-btn"
                  onClick={analyzeOpeningEvals}
                  title="Évalue chaque variante sur sa ligne la plus jouée (Stockfish local, file background : le survol reste fluide). Annulable, résultats conservés en session."
                >
                  Analyser les évals ({openingParents.flatMap((p) => p.leaves).filter((l) => !openEvals[l.repFen]).length} restante(s))
                </button>
              ) : (
                <button
                  className="action-btn"
                  onClick={() => {
                    openEvalCancel.current = true;
                  }}
                  title="Interrompre (les évals déjà calculées sont conservées)"
                >
                  Annuler ({openEvalProgress.done}/{openEvalProgress.total})
                </button>
              )}
              <div className="table-scroll">
                <table className="chesscom-stats-table">
                  <thead>
                    <tr>
                      <th>Ouverture</th>
                      <th title="Plis au répertoire (variante, ou total du groupe)">Coups</th>
                      <th title="Éval moteur de la ligne la plus jouée (+ = avantage Blancs)">Éval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openingParents.map((p) => {
                      // Éval du parent = celle de sa variante la plus jouée.
                      const mainEv = openEvals[p.leaves[0].repFen];
                      const collapsed = collapsedParents.has(p.key);
                      const groupable = p.leaves.length > 1 || p.leaves[0].variant !== null;
                      const parentActive = selectedOpening !== null
                        && selectedOpening.parent === p.key
                        && selectedOpening.variant === null;
                      const toggleParent = (): void => toggleOpeningFilter(p.key, null);
                      const toggleCollapse = (): void => {
                        setCollapsedParents((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.key)) next.delete(p.key);
                          else next.add(p.key);
                          return next;
                        });
                      };
                      return (
                        <React.Fragment key={p.key}>
                          <tr
                            className={`opening-parent-row${parentActive ? ' is-active' : ''}`}
                            onClick={toggleParent}
                            onKeyDown={(e) => {
                              // Le chevron a son propre clavier : ici, la ligne seule.
                              if (e.target !== e.currentTarget) return;
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleParent();
                              }
                            }}
                            tabIndex={0}
                            title={parentActive
                              ? `${p.games.toLocaleString('fr-FR')} parties — cliquer pour revoir tout l'arbre`
                              : `${p.games.toLocaleString('fr-FR')} parties — cliquer pour ne montrer que cette ouverture dans l'arbre`}
                          >
                            <td>
                              {groupable && (
                                <button
                                  className="icon-btn opening-chevron-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleCollapse();
                                  }}
                                  title={collapsed ? 'Déplier les variantes' : 'Replier les variantes'}
                                  aria-label={collapsed ? 'Déplier les variantes' : 'Replier les variantes'}
                                  aria-expanded={!collapsed}
                                >
                                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                                </button>
                              )}
                              {p.key === '?' ? 'Inconnue' : frenchOpeningName(p.key)}
                            </td>
                            <td>{p.moves.toLocaleString('fr-FR')}</td>
                            <td title={mainEv ? `Variante la plus jouée ${p.leaves[0].repSan} (prof. ${mainEv.depth})` : 'Non analysée'}>
                              {mainEv ? mainEv.score : '—'}
                            </td>
                          </tr>
                          {(!groupable || !collapsed) && p.leaves.map((l) => {
                            const ev = openEvals[l.repFen];
                            const leafActive = selectedOpening !== null
                              && selectedOpening.parent === p.key
                              && selectedOpening.variant === (l.variant ?? null);
                            // Le tronc commun filtre comme tout le parent.
                            const leafVariant = l.variant ?? null;
                            const toggleLeaf = (): void => toggleOpeningFilter(p.key, leafVariant);
                            return (
                              <tr
                                key={l.fullKey}
                                className={`opening-variant-row${leafActive ? ' is-active' : ''}`}
                                onClick={toggleLeaf}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    toggleLeaf();
                                  }
                                }}
                                tabIndex={0}
                                title={leafActive
                                  ? 'Cliquer pour revoir tout l\u2019arbre'
                                  : 'Cliquer pour ne montrer que cette variante dans l\u2019arbre'}
                              >
                                <td title={`${l.games.toLocaleString('fr-FR')} parties · ligne principale : ${l.repSan}`}>
                                  {l.variant ? (frenchOpeningVariant(l.variant) ?? l.variant) : <span className="text-muted">Tronc commun</span>}
                                </td>
                                <td>{l.moves.toLocaleString('fr-FR')}</td>
                                <td title={ev ? `Ligne principale ${l.repSan} (prof. ${ev.depth})` : 'Non analysée'}>
                                  {ev ? ev.score : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="activity-subtitle text-muted">+ = avantage Blancs (moteur local).</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
