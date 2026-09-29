import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Chess, type Square } from 'chess.js';
import type { 
  RepertoireItem, 
  RepertoireMove, 
  LichessMove, 
  LichessApiResponse,
  EngineMove 
} from '../types/chess';
import { ELO_TARGET_OPTIONS } from '../types/chess';
import { countBranchPositions, normalizeCastleUci, isUciAdopted, weaknessOfPosition, fenAfterUci, type Weakness } from '../utils/repertoire';
import { dangerShortLabel, eloTargetLabel, robustnessPartialError, robustnessSkipReasonLabel, trapButtonLabel, TRAP_DISABLED_BUSY, TRAP_DISABLED_NO_ENGINE, weaknessLabel } from '../i18n';
import { rankRepertoireMoves, eloTierForTarget } from '../services/repertoireScore';
import { analyzeBranchRobustnessReport, stopRobustness, type BranchRobustness, type RobustnessReport } from '../services/branchRobustness';
import { analyzeTrapPotential, type TrapPotentialReport } from '../services/trapPotential';
import { RepertoireAdvisor } from './RepertoireAdvisor';
import { RobustnessView } from './RobustnessView';
import { AutoRepertoirePanel } from './AutoRepertoirePanel';
import { fetchLichessMoves } from '../services/lichess';
import { frenchOpeningName } from '../utils/openingsFr';
import { isAbortError } from '../utils/async';
import { uiPrefs } from '../storage/preferences';
import { analyzeLocalFen, isSuperseded, stopLocalAnalysis, analyzeAdaptiveFen, LOCAL_ENGINE_DEPTHS, DEFAULT_LOCAL_DEPTH } from '../services/localEngine';
import {
  Sparkles,
  Compass,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Flame,
  Loader2,
  Plus,
  RotateCcw,
  Zap,
  Play,
  Layers,
  Cpu,
  Users,
  Scale,
  Shield
} from 'lucide-react';

interface RepertoireBuilderProps {
  repertoire: RepertoireItem;
  currentFen: string;
  isOpponentTurn: boolean;
  registeredMoves: RepertoireMove[];
  onPlayMove: (uci: string) => void;
  onAddAndPlayMove: (m: LichessMove, freqPct?: number) => void;
  onBatchAddOpponentMoves?: (moves: { move: LichessMove; freqPct: number }[]) => void;
  onGoBack: () => void;
  canGoBack: boolean;
  onHoverMove?: (uci: string | null) => void;
  onBackToStart?: () => void;
  onAutoMerge?: (root: import('../types/chess').RepertoireRoot) => void;
  onAutoPreviewMove?: (fen: string | null, uci?: string) => void;
  onAutoEngineArrows?: (arrows: { orig: string; dest: string; brush: string }[] | null) => void;
}

/**
 * Référence vide stable : un `[]` littéral recréerait une identité à chaque
 * rendu et invaliderait `rankInputBase` → `baseAdvised` → l'effet
 * `replyStats`, qui relancerait ses requêtes Lichess à chaque survol
 * (tempête de requêtes avortées + 429) dès que le moteur a répondu.
 */
const NO_OPPONENT_MOVES: LichessMove[] = [];

export const RepertoireBuilder: React.FC<RepertoireBuilderProps> = ({
  repertoire,
  currentFen,
  isOpponentTurn,
  registeredMoves,
  onPlayMove,
  onAddAndPlayMove,
  onBatchAddOpponentMoves,
  onGoBack,
  canGoBack,
  onHoverMove,
  onBackToStart,
  onAutoMerge,
  onAutoPreviewMove,
  onAutoEngineArrows,
}) => {
  const [loadingOpponent, setLoadingOpponent] = useState(false);
  const [lichessData, setLichessData] = useState<LichessApiResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Coups d'ordinateur (Stockfish LOCAL, dans le navigateur) — source par défaut
  const [engineMoves, setEngineMoves] = useState<EngineMove[]>([]);
  const [loadingEngine, setLoadingEngine] = useState(false);
  const [engineProgressDepth, setEngineProgressDepth] = useState(0);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [localDepth, setLocalDepth] = useState<number | 'auto'>(() => {
    const saved = uiPrefs.getEngineDepth(DEFAULT_LOCAL_DEPTH);
    if (saved === 'auto') return saved;
    return LOCAL_ENGINE_DEPTHS.includes(saved as (typeof LOCAL_ENGINE_DEPTHS)[number])
      ? saved
      : DEFAULT_LOCAL_DEPTH;
  });
  const [engineAutoSummary, setEngineAutoSummary] = useState<{ depth: number; stable: boolean; reason: string } | null>(null);
  const [suggestionSource, setSuggestionSource] = useState<'advice' | 'engine' | 'users'>(
    () => uiPrefs.getSuggestionSource(),
  );

  // Interrupteur de réponse adverse automatique (par défaut activé)
  const [autoPlayOpponent, setAutoPlayOpponent] = useState(() => uiPrefs.getAutoPlayOpponent());

  const [autoPlayCountdown, setAutoPlayCountdown] = useState<number | null>(null);
  const autoPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Innovation : le coup nouveau est enregistré, on attend VOTRE réponse (temps
  // illimité), puis retour au début au lieu de continuer dans la nouvelle ligne.
  const [innovationPendingFen, setInnovationPendingFen] = useState<string | null>(null);
  const [innovationResetSan, setInnovationResetSan] = useState<string | null>(null);
  const innovationFromFenRef = useRef<string | null>(null);
  // Robustesse des branches (analyse à la demande : moteur + stats par réponse).
  const [robustResults, setRobustResults] = useState<BranchRobustness[] | null>(null);
  const [robustReport, setRobustReport] = useState<RobustnessReport | null>(null);
  const [robustProgress, setRobustProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [robustError, setRobustError] = useState<string | null>(null);
  // Potentiel de piège (théorie vs pratique à horizon) par UCI conseillée.
  const [trapByUci, setTrapByUci] = useState<Record<string, TrapPotentialReport>>({});
  const [trapProgress, setTrapProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [trapError, setTrapError] = useState<string | null>(null);
  const trapRunId = useRef(0);
  const trapAbort = useRef<AbortController | null>(null);
  const robustRunId = useRef(0);
  // Enrichissement "erreurs adverses" (audit A5) : réponses Lichess observées
  // après nos coups conseillés, par UCI. Réinitialisé à chaque position.
  const [replyStats, setReplyStats] = useState<{ fen: string; byUci: Record<string, LichessMove[]> }>({
    fen: '',
    byUci: {},
  });
  const replyStatsRunId = useRef(0);

  const eloConfig = ELO_TARGET_OPTIONS.find(o => o.key === repertoire.targetElo) || ELO_TARGET_OPTIONS[0];

  const handleToggleAutoPlay = () => {
    const next = !autoPlayOpponent;
    setAutoPlayOpponent(next);
    uiPrefs.setAutoPlayOpponent(next);
    if (!next && autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      setAutoPlayCountdown(null);
    }
  };

  const handleChangeSource = (src: 'advice' | 'engine' | 'users') => {
    setSuggestionSource(src);
    uiPrefs.setSuggestionSource(src);
  };

  const handleChangeDepth = (d: number | 'auto') => {
    setLocalDepth(d);
    uiPrefs.setEngineDepth(d);
  };

  // Requête des coups les plus joués à cet Elo (tour adverse : popularité) …
  // Annulation double : AbortController (réseau) + drapeau `cancelled`
  // (garde d'état). Une réponse arrivée après changement de position est
  // ignorée au lieu d'écraser les données du nouveau poste.
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    setLoadingOpponent(true);
    setFetchError(null);
    setAutoPlayCountdown(null);
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
    }

    fetchLichessMoves(
      currentFen,
      undefined,
      eloConfig.endpoint,
      eloConfig.ratingsParam,
      undefined,
      { signal: ctrl.signal, since: eloConfig.since },
    )
      .then((data) => {
        if (!cancelled && !ctrl.signal.aborted) {
          setLichessData(data);
          setLoadingOpponent(false);
        }
      })
      .catch((err) => {
        if (cancelled || ctrl.signal.aborted || isAbortError(err)) return;
        setFetchError(err instanceof Error ? err.message : String(err));
        setLoadingOpponent(false);
      });

    return () => {
      cancelled = true;
      ctrl.abort();
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current);
      }
    };
  }, [currentFen, eloConfig]);

  // … et analyse Stockfish LOCALE pour vos propres coups.
  // Mode Auto : D12 puis paliers +4 tant que l'éval du meilleur coup bouge
  // encore (max D28) — rapide sur les positions stables, creuse les critiques.
  //
  // Activation INTENTIONNELLE (coûteux : CPU/batterie) : on n'analyse que si
  // le résultat est consommé — tour du joueur (advisedMoves est vide sinon
  // et la robustesse est bloquée) et source affichant le moteur (advice ou
  // engine ; 'users' n'en a pas besoin). Tout retour au besoin (coup joué,
  // retour de source) change currentFen ou ces drapeaux → relance.
  useEffect(() => {
    let cancelled = false;
    if (isOpponentTurn || suggestionSource === 'users') {
      setLoadingEngine(false);
      setEngineError(null);
      setEngineMoves([]);
      setEngineProgressDepth(0);
      setEngineAutoSummary(null);
      return () => {
        cancelled = true;
      };
    }
    setLoadingEngine(true);
    setEngineError(null);
    setEngineMoves([]);
    setEngineProgressDepth(0);
    setEngineAutoSummary(null);

    const done = (moves: EngineMove[]) => {
      if (cancelled) return;
      setEngineMoves(moves);
      setLoadingEngine(false);
      if (moves.length === 0) {
        setEngineError('Le moteur local n\'a retourné aucun coup pour cette position.');
      }
    };
    const failed = (err: unknown) => {
      if (cancelled) return;
      // Analyse supplantée (survol graphe, autre onglet…) : fin propre,
      // surtout pas d'erreur visible — ce n'est pas une panne moteur.
      if (isSuperseded(err)) {
        setLoadingEngine(false);
        return;
      }
      setEngineMoves([]);
      setLoadingEngine(false);
      setEngineError(
        err instanceof Error
          ? `Moteur local indisponible : ${err.message}`
          : 'Moteur local indisponible.'
      );
    };

    if (localDepth === 'auto') {
      analyzeAdaptiveFen(currentFen, {
        multiPv: 5,
        priority: 'interactive',
        onProgress: (d) => {
          if (!cancelled) setEngineProgressDepth(d);
        },
      })
        .then((res) => {
          if (cancelled) return;
          setEngineAutoSummary({ depth: res.reachedDepth, stable: res.stable, reason: res.stoppedReason });
          done(res.moves);
        })
        .catch(failed);
    } else {
      analyzeLocalFen(currentFen, {
        multiPv: 5,
        depth: localDepth,
        priority: 'interactive',
        onProgress: (d) => {
          if (!cancelled) setEngineProgressDepth(d);
        },
      })
        .then(done)
        .catch(failed);
    }

    return () => {
      cancelled = true;
      stopLocalAnalysis();
    };
  }, [currentFen, localDepth, isOpponentTurn, suggestionSource]);

  const opponentMoves = lichessData?.moves ?? NO_OPPONENT_MOVES;
  const totalOpponentGames = opponentMoves.reduce((acc, m) => acc + m.white + m.draws + m.black, 0) || 1;
  const topOpponentMove = opponentMoves[0];

  // Conseil « meilleur coup de répertoire » : composite moteur + pratique,
  // poids adaptés au niveau Elo et à la taille d'échantillon.
  const rankInputBase = useMemo(
    () => ({
      fen: currentFen,
      playerColor: repertoire.color,
      eloTier: eloTierForTarget(repertoire.targetElo),
      engine: engineMoves,
      stats: opponentMoves,
      // Calibre la confiance à l'échelle de la base (audit A6) : les
      // parties Masters sont ~100x plus rares qu'en base communauté.
      endpoint: eloConfig.endpoint,
    }),
    [currentFen, repertoire.color, repertoire.targetElo, engineMoves, opponentMoves, eloConfig.endpoint],
  );
  const baseAdvised = useMemo(() => {
    if (isOpponentTurn) return [];
    return rankRepertoireMoves(rankInputBase);
  }, [isOpponentTurn, rankInputBase]);
  // Classement enrichi (audit A5) : dès que les réponses adverses après nos
  // coups sont connues, le terme d'erreur adverse rejoint le score.
  const advisedMoves = useMemo(() => {
    if (
      isOpponentTurn ||
      replyStats.fen !== currentFen ||
      Object.keys(replyStats.byUci).length === 0
    ) {
      return baseAdvised;
    }
    return rankRepertoireMoves({ ...rankInputBase, replyStats: replyStats.byUci });
  }, [isOpponentTurn, rankInputBase, baseAdvised, replyStats, currentFen]);

  // Enrichissement : UNE requête explorer par coup du top 3 de base
  // (données déjà en cache global la plupart du temps, ~200 ms sinon).
  // Déclenché sur le top 3 DE BASE uniquement : le classement enrichi ne
  // redéclenche pas (pas de boucle). Échec silencieux par candidat : sans
  // données, le terme reste neutre (pas d'erreur bloquante pour un bonus).
  useEffect(() => {
    const id = ++replyStatsRunId.current;
    if (isOpponentTurn || suggestionSource !== 'advice') return;
    const targets = baseAdvised.slice(0, 3);
    if (targets.length === 0) return;
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      const acc: Record<string, LichessMove[]> = {};
      for (const m of targets) {
        if (cancelled || replyStatsRunId.current !== id) return;
        try {
          const after = fenAfterUci(currentFen, m.uci);
          if (!after) continue;
          const data = await fetchLichessMoves(after, undefined, eloConfig.endpoint, eloConfig.ratingsParam, undefined, {
            signal: ctrl.signal, since: eloConfig.since,
          });
          if (cancelled || replyStatsRunId.current !== id) return;
          acc[m.uci] = data.moves || [];
        } catch {
          /* un candidat sans données garde le terme neutre */
        }
      }
      if (cancelled || replyStatsRunId.current !== id) return;
      setReplyStats({ fen: currentFen, byUci: acc });
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [currentFen, isOpponentTurn, suggestionSource, baseAdvised, eloConfig.endpoint, eloConfig.ratingsParam]);

  // Calcul du taux d'apparition du coup n°1
  const topMovePct = topOpponentMove 
    ? Math.round(((topOpponentMove.white + topOpponentMove.draws + topOpponentMove.black) / totalOpponentGames) * 100) 
    : 0;

  // Fin de partie (mat/pat/nulle) : proposer une sortie au lieu de bloquer.
  // Un mat SUBI = trou du répertoire à corriger.
  const gameOver = useMemo(() => {
    try {
      const c = new Chess(currentFen);
      if (c.isCheckmate()) {
        const weLost = (c.turn() === 'w') === (repertoire.color === 'white');
        return { over: true as const, kind: 'mate' as const, weLost };
      }
      if (c.isStalemate()) return { over: true as const, kind: 'draw' as const, label: 'Pat' };
      if (c.isThreefoldRepetition()) return { over: true as const, kind: 'draw' as const, label: 'Nulle par répétition' };
      if (c.isInsufficientMaterial() || c.isDraw()) return { over: true as const, kind: 'draw' as const, label: 'Nulle' };
    } catch {
      return null;
    }
    return null;
  }, [currentFen, repertoire.color]);

  // Équilibrage des branches + priorité aux lignes NÉGATIVES (trous à corriger) :
  // à chaque tour adverse, score = déficit de couverture + bonus danger
  // (mat subi > échec subi > déficit matériel), bonus réduit si déjà exploré
  // et proportionné à la popularité (une rareté ne détourne pas l'étude).
  const balancedChoice = useMemo(() => {
    if (!isOpponentTurn || gameOver) return null;
    const liveParties = new Map<string, number>();
    for (const m of opponentMoves) {
      liveParties.set(normalizeCastleUci(currentFen, m.uci), m.white + m.draws + m.black);
    }
    interface Cand {
      uci: string; san: string; parties: number; branch: number; inRep: boolean;
      weak: number; weakCode: Weakness['code']; weakDeficit?: number;
    }
    const candidates: Cand[] = [];
    for (const r of registeredMoves) {
      const w = weaknessOfPosition(r.fen, repertoire.color);
      // Clé normalisée (audit B5) : un roque stocké brut (e1h1) ne fourche
      // pas un doublon "nouveau" face à la clé live e1g1 (ligne 396).
      const stdRegisteredUci = normalizeCastleUci(currentFen, r.uci);
      candidates.push({
        uci: stdRegisteredUci,
        san: r.san,
        parties: liveParties.get(stdRegisteredUci) ?? r.parties ?? 0,
        branch: countBranchPositions(r),
        inRep: true,
        weak: w.score,
        weakCode: w.code,
        weakDeficit: w.materialDeficit,
      });
    }
    // Les coups populaires pas encore au répertoire sont candidats avec une
    // branche de taille 0 : s'ils pèsent lourd, ils sont ajoutés en priorité.
    for (const m of opponentMoves.slice(0, 5)) {
      const stdUci = normalizeCastleUci(currentFen, m.uci);
      if (candidates.some((c) => c.uci === stdUci)) continue;
      const f = fenAfterUci(currentFen, m.uci);
      const w: Weakness = f ? weaknessOfPosition(f, repertoire.color) : { score: 0, code: 'none' };
      candidates.push({
        uci: stdUci,
        san: m.san,
        parties: m.white + m.draws + m.black,
        branch: 0,
        inRep: false,
        weak: w.score,
        weakCode: w.code,
        weakDeficit: w.materialDeficit,
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.parties - a.parties);
    const totalBranch = candidates.reduce((s, c) => s + c.branch, 0);
    const denomGames = totalOpponentGames > 0
      ? totalOpponentGames
      : candidates.reduce((s, c) => s + c.parties, 0) || 1;

    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      const expected = c.parties / denomGames;
      const actual = totalBranch > 0 ? c.branch / totalBranch : 0;
      const deficit = expected - actual;
      const boost = 0.5 * c.weak * (c.branch === 0 ? 1 : 0.2) * Math.min(1, 0.15 + 6 * expected);
      if (deficit + boost > bestScore) {
        bestScore = deficit + boost;
        best = c;
      }
    }
    const expectedPct = Math.round((best.parties / denomGames) * 100);
    const actualPct = totalBranch > 0 ? Math.round((best.branch / totalBranch) * 100) : 0;
    const top = candidates[0];
    const topDeficit = (top.parties / denomGames) - (totalBranch > 0 ? top.branch / totalBranch : 0);
    const topBoost = 0.5 * top.weak * (top.branch === 0 ? 1 : 0.2)
      * Math.min(1, 0.15 + 6 * (top.parties / denomGames));
    // Équilibré = on rejoue la ligne principale (ni déficit, ni danger).
    const balanced = best.uci === top.uci && topDeficit <= 0 && topBoost < 0.05;
    return {
      uci: best.uci,
      san: best.san,
      isNew: !best.inRep,
      expectedPct,
      actualPct,
      balanced,
      // Faiblesse structurée (codes) : le libellé est calculé à l'affichage.
      danger: { score: best.weak, code: best.weakCode, materialDeficit: best.weakDeficit } as Weakness,
    };
  }, [isOpponentTurn, gameOver, registeredMoves, opponentMoves, totalOpponentGames, currentFen, repertoire.color]);

  // Dangerosité des réponses adverses affichées (calcul local instantané).
  const opponentDanger = useMemo(() => {
    const map = new Map<string, Weakness>();
    for (const m of opponentMoves.slice(0, 8)) {
      const f = fenAfterUci(currentFen, m.uci);
      map.set(m.uci, f ? weaknessOfPosition(f, repertoire.color) : { score: 0, code: 'none' });
    }
    return map;
  }, [opponentMoves, currentFen, repertoire.color]);

  // Effet d'auto-réponse automatique de l'adversaire (choix équilibré).
  // Si le coup choisi est une innovation (pas encore au répertoire), il est
  // joué pour l'enregistrer, puis on attend votre réponse sans limite de temps.
  // Bloqué tant qu'une innovation attend votre réponse (pas de fuite en avant).
  useEffect(() => {
    if (!isOpponentTurn || !autoPlayOpponent || loadingOpponent || !balancedChoice || innovationPendingFen) {
      return;
    }
    const chosenUci = balancedChoice.uci;
    const chosenSan = balancedChoice.san;
    const chosenIsNew = balancedChoice.isNew;

    // Déclenchement automatique après 450ms
    setAutoPlayCountdown(450);
    autoPlayTimerRef.current = setTimeout(() => {
      setAutoPlayCountdown(null);
      onPlayMove(chosenUci);
      if (chosenIsNew && onBackToStart) {
        try {
          const stdUci = normalizeCastleUci(currentFen, chosenUci);
          const c = new Chess(currentFen);
          const m = c.move({
            from: stdUci.slice(0, 2) as Square,
            to: stdUci.slice(2, 4) as Square,
            promotion: stdUci.length > 4 ? stdUci[4] : undefined,
          });
          if (m) {
            innovationFromFenRef.current = currentFen;
            setInnovationPendingFen(c.fen());
            setInnovationResetSan(chosenSan);
          }
        } catch {
          /* coup inattendu : pas de suivi */
        }
      }
    }, 450);

    return () => {
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current);
      }
    };
  }, [isOpponentTurn, autoPlayOpponent, loadingOpponent, balancedChoice, innovationPendingFen, onPlayMove, onBackToStart, currentFen]);

  // Suivi d'innovation : après votre réponse directe (1 ply), petit délai pour
  // la voir puis retour au début. Navigation manuelle ailleurs = on rend la
  // main sans retour forcé (l'innovation reste enregistrée).
  useEffect(() => {
    if (!innovationPendingFen) return;
    if (currentFen === innovationPendingFen) return; // en attente de votre réponse
    if (currentFen === innovationFromFenRef.current) return; // pas encore atterri
    let isDirectReply = false;
    try {
      const c = new Chess(innovationPendingFen);
      for (const m of c.moves({ verbose: true })) {
        const t = new Chess(innovationPendingFen);
        t.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
        if (t.fen() === currentFen) {
          isDirectReply = true;
          break;
        }
      }
    } catch {
      isDirectReply = false;
    }
    if (!isDirectReply) {
      innovationFromFenRef.current = null;
      setInnovationPendingFen(null);
      setInnovationResetSan(null);
      return;
    }
    const timer = setTimeout(() => {
      innovationFromFenRef.current = null;
      setInnovationPendingFen(null);
      setInnovationResetSan(null);
      onBackToStart?.();
    }, 800);
    return () => clearTimeout(timer);
  }, [currentFen, innovationPendingFen, onBackToStart]);

  // L'analyse de robustesse suit la position : on l'annule et on l'efface
  // dès qu'on quitte la position (résultats obsolètes sinon).
  useEffect(() => {
    robustRunId.current++;
    stopRobustness();
    setRobustResults(null);
    setRobustReport(null);
    setRobustError(null);
    setRobustProgress(null);
    // Changer de position annule aussi l'analyse de piège en vol.
    trapRunId.current++;
    trapAbort.current?.abort();
    trapAbort.current = null;
    setTrapByUci({});
    setTrapError(null);
    setTrapProgress(null);
  }, [currentFen]);

  const handleAnalyzeRobustness = () => {
    if (robustProgress || advisedMoves.length === 0) return;
    const id = ++robustRunId.current;
    const fenSnap = currentFen;
    const cands = advisedMoves.slice(0, 3).map((m) => ({ uci: m.uci, san: m.san }));
    setRobustError(null);
    setRobustResults(null);
    setRobustReport(null);
    setRobustProgress({ done: 0, total: 1, label: 'démarrage…' });
    analyzeBranchRobustnessReport(fenSnap, cands, {
      playerColor: repertoire.color,
      eloTier: eloTierForTarget(repertoire.targetElo),
      endpoint: eloConfig.endpoint,
      ratingsParam: eloConfig.ratingsParam,
      since: eloConfig.since,
      depth: 12,
      onProgress: (done, total, label) => {
        if (robustRunId.current !== id) return;
        setRobustProgress({ done, total, label });
      },
    })
      .then((report) => {
        if (robustRunId.current !== id) return;
        setRobustProgress(null);
        setRobustReport(report);
        if (report.results.length === 0) {
          if (report.cancelled) {
            setRobustError('Analyse de robustesse annulée.');
          } else {
            const detail = report.skipped
              .map((s) => `${s.san} : ${robustnessSkipReasonLabel(s.reason)}`)
              .join('; ');
            setRobustError(
              detail ? robustnessPartialError(detail) : 'Données insuffisantes pour juger la robustesse ici.',
            );
          }
        } else {
          setRobustResults(report.results);
        }
      })
      .catch((err) => {
        if (robustRunId.current !== id) return;
        setRobustProgress(null);
        setRobustError(err instanceof Error ? err.message : 'Échec de l\'analyse de robustesse.');
      });
  };

  const handleCancelRobustness = () => {
    robustRunId.current++;
    stopRobustness();
    setRobustProgress(null);
  };

  // Potentiel de piège : pour chaque coup conseillé du top 3, compare la
  // défense parfaite (safety) à l'espérance pratique (stats Lichess) à
  // horizon 14 plies (≈ 7 coups). Annulable (changement de position, relance).
  const handleAnalyzeTrap = () => {
    if (trapProgress || advisedMoves.length === 0) return;
    const id = ++trapRunId.current;
    trapAbort.current?.abort();
    const ctrl = new AbortController();
    trapAbort.current = ctrl;
    const fenSnap = currentFen;
    const targets = advisedMoves.slice(0, 3);
    setTrapError(null);
    setTrapProgress({ done: 0, total: targets.length, label: 'démarrage…' });
    (async () => {
      try {
        for (let i = 0; i < targets.length; i++) {
          const m = targets[i];
          if (trapRunId.current !== id || ctrl.signal.aborted) return;
          setTrapProgress({ done: i, total: targets.length, label: m.san });
          const rep = await analyzeTrapPotential({
            fen: fenSnap,
            ourColor: repertoire.color,
            ourMoveUci: m.uci,
            ourMoveSan: m.san,
            elo: { endpoint: eloConfig.endpoint, ratingsParam: eloConfig.ratingsParam, since: eloConfig.since },
            config: { horizonPlies: 14 },
            signal: ctrl.signal,
            onProgress: (_done, _total, label) => {
              if (trapRunId.current !== id) return;
              setTrapProgress({ done: i, total: targets.length, label: `${m.san} — ${label}` });
            },
          });
          if (trapRunId.current !== id || ctrl.signal.aborted) return;
          setTrapByUci((prev) => ({ ...prev, [m.uci]: rep }));
        }
      } catch (err) {
        if (trapRunId.current !== id) return;
        // Annulation ou supplantation (nouvelle analyse prioritaire) : fin
        // propre, sans erreur visible — ce n'est pas une panne moteur.
        if (isAbortError(err) || isSuperseded(err)) return;
        setTrapError(err instanceof Error ? err.message : "Échec de l'analyse de piège.");
      } finally {
        if (trapRunId.current === id) setTrapProgress(null);
      }
    })();
  };

  const handleCancelTrap = () => {
    trapRunId.current++;
    trapAbort.current?.abort();
    trapAbort.current = null;
    setTrapProgress(null);
  };

  // Déployer toutes les variantes adverses majeures (> 10% d'apparition)
  const majorMovesCount = opponentMoves.filter((m) => {
    const games = m.white + m.draws + m.black;
    return Math.round((games / totalOpponentGames) * 100) >= 10;
  }).length;
  const handleDeployMajorVariations = () => {
    if (!onBatchAddOpponentMoves || opponentMoves.length === 0) return;
    const majorMoves = opponentMoves
      .map(m => {
        const games = m.white + m.draws + m.black;
        const pct = Math.round((games / totalOpponentGames) * 100);
        return { move: m, freqPct: pct };
      })
      .filter(item => item.freqPct >= 10);

    onBatchAddOpponentMoves(majorMoves);
  };

  return (
    <div className="builder-panel">
      {onAutoMerge && (
        <AutoRepertoirePanel
          repertoireColor={repertoire.color}
          targetElo={repertoire.targetElo}
          startFen={currentFen}
          onMerge={(root) => onAutoMerge(root)}
          onPreviewMove={onAutoPreviewMove}
          onEngineArrows={onAutoEngineArrows}
        />
      )}
      {/* Fin de partie : sortie visible au lieu de rester bloqué */}
      {gameOver && (
        <div
          className={`panel-card gameover-card ${
            gameOver.kind === 'mate'
              ? gameOver.weLost
                ? 'gameover-lost'
                : 'gameover-won'
              : 'gameover-draw'
          }`}
        >
          <div className="turn-content">
            <div>
              <h4 className="gameover-title">
                {gameOver.kind === 'mate' && gameOver.weLost && <AlertTriangle size={16} />}
                {gameOver.kind === 'mate'
                  ? gameOver.weLost
                    ? 'Échec et mat subi — ligne à corriger'
                    : 'Échec et mat — ligne gagnante'
                  : `${gameOver.label} — fin de ligne.`}
              </h4>
              <p>
                {gameOver.kind === 'mate' && gameOver.weLost
                  ? 'L\u2019adversaire mate dans cette ligne : corrigez-la (ou retirez-la via l\u2019arbre), puis repartez du début.'
                  : 'Repartez du début ou reculez d\u2019un coup pour continuer l\u2019étude.'}
              </p>
            </div>
          </div>
          <div className="priority-action-buttons" style={{ marginTop: 10 }}>
            <button className="primary-btn" onClick={() => onBackToStart?.()}>
              <RotateCcw size={15} />
              <span>Retour au début</span>
            </button>
            {canGoBack && (
              <button className="secondary-btn" onClick={onGoBack}>
                <span>Reculer d'un coup</span>
              </button>
            )}
          </div>
        </div>
      )}
      {/* Bannière de Contexte de Répertoire */}
      <div className="panel-card builder-status-card">
        <div className="builder-header-row">
          <div className="builder-tag-group">
            <span className={`rep-color-tag tag-${repertoire.color}`}>
              {repertoire.color === 'white' ? '♔ Vous : Blancs' : '♚ Vous : Noirs'}
            </span>
          </div>

          <div className="header-toggle-actions">
            <button 
              className={`auto-toggle-btn ${autoPlayOpponent ? 'enabled' : 'disabled'}`}
              onClick={handleToggleAutoPlay}
              title={autoPlayOpponent ? "Désactiver la réponse adverse automatique" : "Activer la réponse adverse automatique"}
            >
              <Zap size={13} className={autoPlayOpponent ? 'text-amber' : ''} />
              <span>Auto-réponse : {autoPlayOpponent ? 'Active' : 'Manuelle'}</span>
            </button>

            {canGoBack && (
              <button className="icon-btn" onClick={onGoBack} title="Reculer d'un coup">
                <RotateCcw size={13} />
                <span>Précédent</span>
              </button>
            )}
          </div>
        </div>

        {/* Qui a le trait ? */}
        <div className="turn-indicator-box">
          {isOpponentTurn ? (
            <div className="turn-content opponent-turn">
              <Zap size={18} className="text-amber" />
              <div>
                <h4>
                  Tour de l'adversaire ({repertoire.color === 'white' ? 'Noirs' : 'Blancs'})
                </h4>
                <p>
                  À ce niveau ({eloTargetLabel(repertoire.targetElo)}), l'adversaire répond à <strong>{topMovePct}%</strong> par <strong>{topOpponentMove?.san || '...'}</strong> :
                </p>
              </div>
            </div>
          ) : (
            <div className="turn-content player-turn">
              <Compass size={18} className="text-emerald" />
              <div>
                <h4>À votre tour ({repertoire.color === 'white' ? 'Blancs' : 'Noirs'})</h4>
                <p>Choisissez votre réponse de répertoire pour cette position.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CAS 1 : TOUR DE L'ADVERSAIRE -> Réponse automatique & Coups les plus joués */}
      {isOpponentTurn && (
        <div className="panel-card opponent-analysis-card">
          <div className="card-title-row">
            <h3 className="card-title">
              <Flame size={16} className="text-amber" />
              Fréquence réelle des coups adverses ({eloTargetLabel(repertoire.targetElo)})
            </h3>
            {loadingOpponent && (
              <span className="loading-badge">
                <Loader2 size={13} className="spin" />
                <span>Analyse Elo...</span>
              </span>
            )}
          </div>

          {fetchError && (
            <div className="mini-error-box">
              <span>{fetchError}</span>
            </div>
          )}

          {/* Recommandation prioritaire du coup #1 le plus joué */}
          {topOpponentMove && !loadingOpponent && (
            <div className="priority-opponent-banner">
              <div className="priority-banner-top">
                <div className="priority-badge">
                  <Sparkles size={13} />
                  <span>Réponse majoritaire ({topMovePct}% des parties)</span>
                </div>
                {autoPlayCountdown !== null && (
                  <span className="auto-playing-pill">
                    <Zap size={12} className="spin-fast text-amber" />
                    <span>Réponse automatique en cours...</span>
                  </span>
                )}
                {innovationResetSan && (
                  <span className="auto-playing-pill">
                    <RotateCcw size={12} />
                    <span>Innovation {innovationResetSan} ajoutée — à vous, retour au début après votre réponse…</span>
                  </span>
                )}
              </div>

              <div className="priority-details">
                <span className="priority-san">{topOpponentMove.san}</span>
                <span className="priority-stats">
                  Joué à <strong>{topMovePct}%</strong> par les adversaires ({eloTargetLabel(repertoire.targetElo)})
                </span>
              </div>

              <div className="priority-action-buttons">
                <button
                  className="primary-btn"
                  onClick={() => onPlayMove(topOpponentMove.uci)}
                  onMouseEnter={() => onHoverMove?.(topOpponentMove.uci)}
                  onMouseLeave={() => onHoverMove?.(null)}
                  onFocus={() => onHoverMove?.(topOpponentMove.uci)}
                  onBlur={() => onHoverMove?.(null)}
                >
                  <Play size={15} />
                  <span>Jouer ce coup ({topOpponentMove.san})</span>
                </button>

                {onBatchAddOpponentMoves && (
                  <button 
                    className="secondary-btn"
                    onClick={handleDeployMajorVariations}
                    disabled={majorMovesCount === 0}
                    title={majorMovesCount === 0
                      ? 'Aucune réponse adverse n\u2019atteint 10 % des parties à cet Elo'
                      : 'Ajouter au répertoire tous les coups adverses apparaissant dans plus de 10% des parties'}
                  >
                    <Layers size={14} />
                    <span>Couvrir les variantes &gt; 10%</span>
                  </button>
                )}
              </div>
              {balancedChoice && (
                <span className="auto-vary-note">
                  {balancedChoice.balanced
                    ? `Branches équilibrées — auto-réponse : ${balancedChoice.san} (ligne principale).`
                    : balancedChoice.isNew
                      ? `Équilibrage : ${balancedChoice.san} (${balancedChoice.expectedPct}% des parties) pas encore couvert — l'auto-réponse l'ajoute, puis retour au début après votre réponse.`
                      : `Équilibrage : auto-réponse → ${balancedChoice.san} (branche ${balancedChoice.actualPct}% vs ${balancedChoice.expectedPct}% des parties).`}
                  {weaknessLabel(balancedChoice.danger) ? ` — ${weaknessLabel(balancedChoice.danger)}, exploré en priorité.` : ''}
                </span>
              )}
            </div>
          )}

          {/* Liste de toutes les réponses de l'adversaire ordonnées par fréquence */}
          <div className="opponent-moves-list">
            <span className="sub-section-label">
              Distribution des réponses adverses à cet Elo :
            </span>
            {opponentMoves.slice(0, 8).map((m, idx) => {
              const parties = m.white + m.draws + m.black;
              const pct = Math.round((parties / totalOpponentGames) * 100);
              const isTop = idx === 0;
              const dw = opponentDanger.get(m.uci);
              // Logique sur CODES (jamais sur libellés) + libellé via dictionnaire.
              const dangerShort = dw ? dangerShortLabel(dw.score, dw.code, dw.materialDeficit) : null;
              const dangerTitle = dw ? weaknessLabel(dw) : null;

              return (
                <button
                  key={m.uci}
                  className={`opponent-move-btn ${isTop ? 'is-top' : ''}`}
                  onClick={() => onPlayMove(m.uci)}
                  onMouseEnter={() => onHoverMove?.(m.uci)}
                  onMouseLeave={() => onHoverMove?.(null)}
                  onFocus={() => onHoverMove?.(m.uci)}
                  onBlur={() => onHoverMove?.(null)}
                >
                  <div className="move-btn-left">
                    <span className="rank-badge">{idx + 1}</span>
                    <span className="san-text">{m.san}</span>
                    {isTop && <span className="majority-tag">Majoritaire</span>}
                    {dangerShort && (
                      <span className="danger-tag" title={`${dangerTitle} — ligne négative à travailler en priorité`}>
                        {dangerShort}
                      </span>
                    )}
                    {m.opening?.eco && <span className="eco-pill">{m.opening.eco}</span>}
                  </div>

                  <div className="move-btn-right">
                    {/* Barre proportionnelle */}
                    <div className="frequency-progress-bar">
                      <div className="frequency-progress-fill" style={{ width: `${Math.min(pct * 2, 100)}%` }} />
                    </div>
                    <span className="freq-pct">{pct}%</span>
                    <span className="parties-small">({parties.toLocaleString('fr-FR')})</span>
                    <ArrowRight size={14} className="arrow-icon" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* CAS 2 : TOUR DU JOUEUR -> Choix de sa propre réponse */}
      {!isOpponentTurn && (
        <div className="panel-card player-decision-card">
          <div className="card-title-row">
            <h3 className="card-title">
              <Compass size={16} className="text-emerald" />
              Votre Réponse de Répertoire
            </h3>
          </div>

          {/* Si un coup est déjà enregistré pour cette position */}
          {registeredMoves.length > 0 ? (
            <div className="registered-move-banner">
              <div className="registered-header">
                <CheckCircle2 size={18} className="text-emerald" />
                <h4>Coup mémorisé dans votre répertoire :</h4>
              </div>
              <div className="registered-moves-chips">
                {registeredMoves.map((m) => (
                  <button
                    key={m.uci}
                    className="adopted-chip"
                    onClick={() => onPlayMove(m.uci)}
                    onMouseEnter={() => onHoverMove?.(m.uci)}
                    onMouseLeave={() => onHoverMove?.(null)}
                    onFocus={() => onHoverMove?.(m.uci)}
                    onBlur={() => onHoverMove?.(null)}
                    title="Cliquer pour avancer dans cette variante"
                  >
                    <span className="chip-san">{m.san}</span>
                    {m.isMate && (
                      <span className="mate-tag" title="Mat — fin forcée, toujours prioritaire à la génération">
                        MAT
                      </span>
                    )}
                    <span className="chip-label">Adopté ✓</span>
                  </button>
                ))}
              </div>
              <p className="registered-hint">
                Cliquez pour continuer cette variante, ou jouez un autre coup sur l'échiquier pour ajouter une alternative.
              </p>
            </div>
          ) : (
            <div className="unregistered-prompt">
              <p>
                Aucune réponse n'est encore adoptée pour cette position. 
                Jouez votre coup favori sur l'échiquier ou sélectionnez l'un des coups recommandés ci-dessous :
              </p>
            </div>
          )}

          {/* Suggestions de coups pour le joueur — ORDINATEUR par défaut */}
          <div className="candidate-suggestions-list">
            <div className="suggestion-source-toggle">
              <span className="sub-section-label" style={{ marginBottom: 0 }}>Coups recommandés :</span>
              <div className="source-toggle-group">
                <button
                  className={`source-toggle-btn ${suggestionSource === 'advice' ? 'active' : ''}`}
                  onClick={() => handleChangeSource('advice')}
                  title="Meilleur coup de répertoire : compromis moteur + résultats pratiques adapté à votre Elo"
                >
                  <Scale size={13} />
                  <span>Conseil</span>
                </button>
                <button
                  className={`source-toggle-btn ${suggestionSource === 'engine' ? 'active' : ''}`}
                  onClick={() => handleChangeSource('engine')}
                  title="Suggestions du moteur Stockfish (évaluation objective)"
                >
                  <Cpu size={13} />
                  <span>Ordinateur</span>
                </button>
                <button
                  className={`source-toggle-btn ${suggestionSource === 'users' ? 'active' : ''}`}
                  onClick={() => handleChangeSource('users')}
                  title="Coups les plus joués par les utilisateurs (popularité)"
                >
                  <Users size={13} />
                  <span>Utilisateurs</span>
                </button>
              </div>
            </div>

            {suggestionSource === 'advice' ? (
              <div className="advice-suggestions">
                <span className="sub-section-label">
                  Meilleur coup de répertoire ({eloTargetLabel(repertoire.targetElo)}) — moteur + pratique :
                </span>
                {(loadingEngine || loadingOpponent) && advisedMoves.length === 0 && (
                  <span className="loading-badge">
                    <Loader2 size={13} className="spin" />
                    <span>Calcul du conseil (moteur + stats)...</span>
                  </span>
                )}
                {fetchError && !loadingOpponent && (
                  <div className="mini-error-box">
                    <span>Stats Lichess indisponibles : {fetchError}</span>
                  </div>
                )}
                <RepertoireAdvisor
                  moves={advisedMoves}
                  onAdopt={(m) => onAddAndPlayMove(m)}
                  onHoverMove={onHoverMove}
                  isAdopted={(uci) => isUciAdopted(registeredMoves, currentFen, uci)}
                  trapByUci={trapByUci}
                />
                {/* Robustesse des branches : que se passe-t-il APRÈS les réponses adverses ? */}
                <div className="robust-section">
                  {!robustProgress && !robustResults && !robustError && advisedMoves.length > 0 && (
                    <button
                      className="secondary-btn"
                      onClick={handleAnalyzeRobustness}
                      title="Analyse les réponses adverses du top 3 (moteur local prof. 12 + stats) : moyenne, pire cas, danger"
                    >
                      <Shield size={14} />
                      <span>Analyser la robustesse (top 3)</span>
                    </button>
                  )}
                  {robustProgress && (
                    <div className="robust-progress-row">
                      <span className="loading-badge">
                        <Loader2 size={13} className="spin" />
                        <span>Robustesse {robustProgress.done}/{robustProgress.total} — {robustProgress.label}</span>
                      </span>
                      <button className="icon-btn" onClick={handleCancelRobustness} title="Annuler l'analyse">
                        <span>Annuler</span>
                      </button>
                    </div>
                  )}
                  {robustError && (
                    <div className="mini-error-box">
                      <span>{robustError}</span>
                    </div>
                  )}
                  {robustResults && (
                    <RobustnessView
                      results={robustResults}
                      report={robustReport}
                      components={advisedMoves.map((m) => ({
                        uci: m.uci,
                        theoreticalScore: m.theoreticalScore,
                        practicalScore: m.practicalScore,
                        finalScore: m.finalScore,
                      }))}
                      tier={eloTierForTarget(repertoire.targetElo)}
                      onHoverMove={onHoverMove}
                    />
                  )}
                </div>
                {/* Potentiel de piège : risqué en théorie mais rentable en pratique ? */}
                <div className="trap-section">
                  {!trapProgress && advisedMoves.length > 0 && (
                    <button
                      className="secondary-btn"
                      onClick={handleAnalyzeTrap}
                      disabled={!!engineError || loadingEngine}
                      title={
                        engineError
                          ? TRAP_DISABLED_NO_ENGINE
                          : loadingEngine
                            ? TRAP_DISABLED_BUSY
                            : 'Compare défense parfaite (moteur) et espérance pratique (stats Lichess) à horizon 7 coups, top 3 conseillés'
                      }
                    >
                      <Zap size={14} />
                      <span>{trapButtonLabel(14)}</span>
                    </button>
                  )}
                  {trapProgress && (
                    <div className="robust-progress-row">
                      <span className="loading-badge">
                        <Loader2 size={13} className="spin" />
                        <span>Piège {trapProgress.done}/{trapProgress.total} — {trapProgress.label}</span>
                      </span>
                      <button className="icon-btn" onClick={handleCancelTrap} title="Annuler l'analyse">
                        <span>Annuler</span>
                      </button>
                    </div>
                  )}
                  {trapError && (
                    <div className="mini-error-box">
                      <span>{trapError}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : suggestionSource === 'engine' ? (
              <div className="engine-suggestions">
                <div className="engine-depth-row">
                  <span className="engine-depth-label" title="Profondeur d'analyse du moteur local">
                    <Cpu size={12} /> Stockfish local — profondeur :
                  </span>
                  <div className="engine-depth-options">
                    <button
                      className={`depth-btn ${localDepth === 'auto' ? 'active' : ''}`}
                      onClick={() => handleChangeDepth('auto')}
                      title="Adaptatif : D12 puis paliers +4 tant que l'éval bouge (max D28)"
                    >
                      Auto
                    </button>
                    {LOCAL_ENGINE_DEPTHS.map((d) => (
                      <button
                        key={d}
                        className={`depth-btn ${localDepth === d ? 'active' : ''}`}
                        onClick={() => handleChangeDepth(d)}
                        title={`Analyser à profondeur ${d}`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                {!loadingEngine && localDepth === 'auto' && engineAutoSummary && (
                  <span className="auto-depth-note">
                    Auto : arrêté en prof. {engineAutoSummary.depth} —{' '}
                    {engineAutoSummary.stable
                      ? 'éval stable.'
                      : engineAutoSummary.reason === 'max-depth'
                        ? 'encore instable au max : position critique, à vérifier.'
                        : 'pas de données moteur.'}
                  </span>
                )}
                {loadingEngine && (
                  <span className="loading-badge">
                    <Loader2 size={13} className="spin" />
                    <span>
                      Analyse locale en cours{engineProgressDepth > 0 ? (localDepth === 'auto' ? ` (prof. ${engineProgressDepth}, adaptatif)…` : ` (prof. ${engineProgressDepth}/${localDepth})…`) : ' (démarrage du moteur…)'}…
                    </span>
                  </span>
                )}
                {!loadingEngine && engineError && engineMoves.length === 0 && (
                  <div className="mini-error-box">
                    <span>{engineError} Jouez librement sur l'échiquier ou basculez sur « Utilisateurs ».</span>
                  </div>
                )}
                {engineMoves.slice(0, 5).map((e, i) => {
                  const isAlreadyAdopted = isUciAdopted(registeredMoves, currentFen, e.uci);
                  const knownOpening = opponentMoves.find(o => o.uci === e.uci)?.opening;
                  const lichessMove: LichessMove = {
                    san: e.san,
                    uci: e.uci,
                    white: 0,
                    draws: 0,
                    black: 0,
                    opening: knownOpening,
                  };
                  return (
                    <div
                      key={e.uci}
                      className={`player-candidate-card engine-card ${i === 0 ? 'is-best' : ''}`}
                      onMouseEnter={() => onHoverMove?.(e.uci)}
                      onMouseLeave={() => onHoverMove?.(null)}
                    >
                      <div className="candidate-info">
                        <span className="candidate-rank-small">{i + 1}</span>
                        <span className="candidate-san-bold">{e.san}</span>
                        <span className={`eval-badge ${typeof e.mate === 'number' ? 'eval-mate' : ''}`} title={`Profondeur ${e.depth}`}>
                          {e.scoreFormatted}
                        </span>
                        {i === 0 && <span className="best-move-tag">Meilleur</span>}
                      </div>
                      <div className="engine-pv-line" title="Suite principale du moteur">
                        {e.pvSans.slice(0, 6).join(' ')}
                        <span className="engine-depth"> (prof. {e.depth})</span>
                      </div>
                      {knownOpening?.name && (
                        <div className="candidate-op-name">{knownOpening.name}</div>
                      )}
                      <div className="engine-card-footer">
                        <span className="engine-source-label">
                          <Cpu size={12} /> Stockfish local (prof. {e.depth})
                        </span>
                        <button
                          className={`adopt-btn ${isAlreadyAdopted ? 'already-adopted' : ''}`}
                          onClick={() => onAddAndPlayMove(lichessMove)}
                          disabled={isAlreadyAdopted}
                        >
                          {isAlreadyAdopted ? (
                            <>
                              <CheckCircle2 size={13} />
                              <span>Déjà au répertoire</span>
                            </>
                          ) : (
                            <>
                              <Plus size={13} />
                              <span>Adopter ce coup</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="users-suggestions">
                <span className="sub-section-label">Coups les plus joués par les utilisateurs ({eloTargetLabel(repertoire.targetElo)}) :</span>
                {opponentMoves.slice(0, 6).map((m, i) => {
                  const parties = m.white + m.draws + m.black;
                  const pw = parties > 0 ? Math.round((m.white / parties) * 100) : 0;
                  const pb = parties > 0 ? Math.round((m.black / parties) * 100) : 0;
                  const myWinRate = repertoire.color === 'white' ? pw : pb;
                  const isAlreadyAdopted = isUciAdopted(registeredMoves, currentFen, m.uci);

                  return (
                    <div
                      key={m.uci}
                      className="player-candidate-card"
                      onMouseEnter={() => onHoverMove?.(m.uci)}
                      onMouseLeave={() => onHoverMove?.(null)}
                    >
                      <div className="candidate-info">
                        <span className="candidate-rank-small">{i + 1}</span>
                        <span className="candidate-san-bold">{m.san}</span>
                        {m.opening?.name && (
                          <span className="candidate-op-name">{frenchOpeningName(m.opening.name)}</span>
                        )}
                      </div>

                      <div className="candidate-score">
                        <span className="score-badge text-emerald" title="Taux de victoires pour votre camp">
                          {myWinRate}% victoires
                        </span>
                      </div>

                      <button
                        className={`adopt-btn ${isAlreadyAdopted ? 'already-adopted' : ''}`}
                        onClick={() => onAddAndPlayMove(m)}
                        disabled={isAlreadyAdopted}
                      >
                        {isAlreadyAdopted ? (
                          <>
                            <CheckCircle2 size={13} />
                            <span>Déjà au répertoire</span>
                          </>
                        ) : (
                          <>
                            <Plus size={13} />
                            <span>Adopter ce coup</span>
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
