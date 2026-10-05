import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { GitBranch, Loader2, Play, Square, Download } from 'lucide-react';
import type { BoardOrientation, EloTargetKey, EngineMove, RepertoireRoot } from '../types/chess';
import { ELO_TARGET_OPTIONS } from '../types/chess';
import { INITIAL_FEN, downloadFile, generateTreePgn } from '../utils/repertoire';
import {
  MAX_AUTO_POSITIONS,
  generateAutoRepertoire,
  type AutoGenConfig,
  type AutoGenStats,
} from '../services/autoRepertoire';
import { analyzeLocalFen, desiredEngineThreads, getLocalEngineThreads, onLocalEngineStatusChange } from '../services/localEngine';
import { explorerCacheReady, lichessCacheMemorySize, lichessPersistHealthy } from '../services/lichess';
import { explorerSqliteStatus, loadExplorerSqliteStats } from '../storage/explorerSqlite';
import { isAbortError } from '../utils/async';

interface AutoRepertoirePanelProps {
  repertoireColor: BoardOrientation;
  targetElo: EloTargetKey;
  startFen?: string;
  /** Fusionne l'arbre généré dans le répertoire actif. */
  onMerge: (root: RepertoireRoot, stats: AutoGenStats) => void | Promise<void>;
  /** Animation live : chaque nœud émis (throttlé) est montré sur l'échiquier ; null = fin/arrêt. */
  onPreviewMove?: (fen: string | null, uci?: string) => void;
  /**
   * Hérité, ignoré : les flèches moteur sont désactivées pendant la
   * génération auto (demande utilisateur — le plateau reste lisible).
   * Conservé en optionnel pour ne pas casser les appelants.
   */
  onEngineArrows?: (arrows: { orig: string; dest: string; brush: string }[] | null) => void;
}

const DEFAULT_STATS: AutoGenStats = {
  sent: 0, cached: 0, api: 0, engineNodes: 0, engineFallbacks: 0,
  engineCached: 0, pruned: 0, transpositions: 0, explored: 0,
  depthPruned: 0, popPruned: 0, bookPenalized: 0, cacheBoostedChildren: 0,
  maxDepthReached: 0, maxEmittedDepth: 0, branchesTotal: 0, emptyPositions: 0,
  positionsInterrogees: 0, apiWaitMs: 0, cacheWaitMs: 0,
  engineWaitMs: 0, failed: 0, failedFens: [], prunedValue: 0, mates: 0,
  quiescenceExtended: 0,
};

/**
 * Champs numériques NON contrôlés : zéro rendu React à la frappe (seule la
 * validation au blur/Entrée touche l'état). Chaque frappe coûtait 200 ms+
 * dans un onglet chargé (extensions écoutant les inputs + rendus) ; ici la
 * frappe ne fait que remplir le DOM, sans aucun travail.
 *
 * Les callbacks sont stables par clé (useCallback + refs) : avant, `attach`
 * recréait une fonction à chaque rendu, forçant React à détacher/rattacher
 * les champs à chaque tick d'horloge pendant un run (churn inutile).
 */
function useUncontrolledNumber(
  setValue: (n: number) => void,
  clamp: (n: number) => number,
): {
  attach: (key: string) => (el: HTMLInputElement | null) => void;
  commit: (key: string, fallback: number) => () => void;
  write: (key: string, v: number) => void;
} {
  const refs = useRef<{ [k: string]: HTMLInputElement | null }>({});
  // Dernier setValue/clamp vus (synchro post-rendu : jamais d'écriture de
  // ref pendant le rendu). Les handlers stables par clé lisent via ce miroir.
  const latest = useRef({ setValue, clamp });
  useEffect(() => {
    latest.current = { setValue, clamp };
  });
  const attachFns = useRef<{ [k: string]: (el: HTMLInputElement | null) => void }>({});
  const commitFns = useRef<{ [k: string]: { fallback: number; fn: () => void } }>({});

  const attach = useCallback(
    (key: string) => {
      if (!attachFns.current[key]) {
        attachFns.current[key] = (el: HTMLInputElement | null): void => {
          refs.current[key] = el;
        };
      }
      return attachFns.current[key];
    },
    [],
  );
  const commit = useCallback(
    (key: string, fallback: number) => {
      const cached = commitFns.current[key];
      // Le fallback change à chaque rendu (c'est la valeur d'état) : on le
      // met à jour sans recréer le handler (identité stable → pas de churn).
      if (!cached) {
        const fn = (): void => {
          const el = refs.current[key];
          if (!el) return;
          const raw = el.value.trim().replace(',', '.');
          const parsed = Number(raw);
          const current = commitFns.current[key]?.fallback ?? 0;
          const next = raw === '' || !Number.isFinite(parsed) ? current : latest.current.clamp(parsed);
          latest.current.setValue(next);
          el.value = String(next);
        };
        commitFns.current[key] = { fallback, fn };
        return fn;
      }
      cached.fallback = fallback;
      return cached.fn;
    },
    [],
  );
  const write = useCallback((key: string, v: number): void => {
    const el = refs.current[key];
    if (el) el.value = String(v);
  }, []);
  return { attach, commit, write };
}

const clampInt = (min: number, max: number) => (n: number): number =>
  Math.max(min, Math.min(max, Math.round(n)));

const formatWait = (ms: number): string =>
  `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;

/**
 * Génération automatique de répertoire (BFS prioritaire).
 * Port de l'explorateur `répertoire` : couverture, profondeur adaptative,
 * transpositions, pénalités livre/étalement, bonus cache — plus réessais,
 * élagage Line Value final et partiel conservé à l'arrêt.
 */
export const AutoRepertoirePanel: React.FC<AutoRepertoirePanelProps> = ({
  repertoireColor,
  targetElo,
  startFen = INITIAL_FEN,
  onMerge,
  onPreviewMove,
}) => {
  const [depth, setDepth] = useState(12);
  /**
   * Plafond de sécurité réglable (défaut 6, max 12) : la sélection reste
   * pilotée par la Couverture, mais sans plafond une position plate
   * (20 coups à 5 %) exploserait. Monte-le pour élargir l'arbre.
   */
  const [maxBranching, setMaxBranching] = useState(6);
  /**
   * Pas de seuils fixes : la file de priorité explore le plus populaire
   * d'abord, donc petit budget = cœur populaire, grand budget =
   * élargissement/approfondissement. Le budget pilote, pas un seuil.
   * (Fréquence mini et popularité mini à 0 ; la profondeur adaptative
   * reste le garde-fou structurel des lignes rares.)
   */
  const MIN_FREQ = 0;
  const MIN_POPULARITY = 0;
  /**
   * Couverture automatique à 100 : pas de filtre par part cumulée, la largeur
   * est pilotée uniquement par Branches max (les plus jouées d'abord) et le
   * budget global. Le resserrement automatique en profondeur est désactivé
   * avec lui (100 reste 100 à toutes les profondeurs).
   */
  const COVERAGE = 100;
  /**
   * Plancher de la profondeur adaptative (défaut 6) : quand la case
   * « adaptative » est cochée, les lignes rares s'arrêtent à ce niveau même
   * si Profondeur est à 24. Décochée (défaut) : toutes les lignes vont à
   * Profondeur, le budget seul décide — le populaire d'abord (file de
   * priorité), les rares ensuite s'il reste du budget.
   */
  const [minDepth, setMinDepth] = useState(6);
  /** Profondeur adaptative : coché = lignes rares moins creusées (runs ciblés). */
  const [adaptiveDepth, setAdaptiveDepth] = useState(false);
  const [maxPositions, setMaxPositions] = useState(60);
  const [explorationOrder, setExplorationOrder] = useState<NonNullable<AutoGenConfig['explorationOrder']>>('popular');
  /** Seuil Line Value de l'élagage final winrate (opt-in, 0 = désactivé). */
  const [minLV, setMinLV] = useState(0);
  /**
   * Parties mini par coup adverse (défaut 100) : un choix adverse sous ce
   * seuil n'entre pas dans l'arbre. Sans effet sur nos répliques (Stockfish
   * tranche) ni sur les mats (toujours inclus).
   */
  const [minGames, setMinGames] = useState(100);
  /** Threads Stockfish détectés (multicœur si isolation navigateur active, sinon 1). */
  const engineThreads = desiredEngineThreads();
  /** Threads confirmés au handshake (null = moteur pas encore démarré ce run). */
  const [threadsApplied, setThreadsApplied] = useState<number | null>(null);
  useEffect(() => {
    const off = onLocalEngineStatusChange((s) => {
      setThreadsApplied(s === 'ready' ? getLocalEngineThreads() : null);
    });
    return off;
  }, []);
  const [running, setRunning] = useState(false);
  const [merging, setMerging] = useState(false);
  const [progress, setProgress] = useState<AutoGenStats>(DEFAULT_STATS);
  const [done, setDone] = useState<{ nodes: number; stats: AutoGenStats; root: RepertoireRoot; completed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<RepertoireRoot | null>(null);
  /** Dernier rendu de progression (throttle : les gros batchs émettent des milliers de callbacks). */
  const lastProgressAt = useRef(0);
  /** Dernier aperçu plateau émis (~6 images/s : fluide sans tempête de rendus). */
  const lastNodePreviewAt = useRef(0);
  /** Début du run (affichage du temps écoulé). */
  const startedAt = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  // Le compteur de cache se corrige dès que le préchargement durable
  // (IndexedDB) a rempli la mémoire, sans attendre un run.
  const [, bumpCacheCount] = useReducer((n: number) => n + 1, 0);
  const [, bumpSqliteCount] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let alive = true;
    explorerCacheReady()
      .then(() => {
        if (alive) bumpCacheCount();
      })
      .catch(() => {
        /* mémoire seule : le compteur reste tel quel */
      });
    loadExplorerSqliteStats().then(() => {
      if (alive) bumpSqliteCount();
    });
    return () => {
      alive = false;
    };
  }, []);

  // Horloge d'affichage pendant le run (1/s, pas de spam de rendus).
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const depthNum = useUncontrolledNumber(setDepth, clampInt(2, 24));
  const branchNum = useUncontrolledNumber(setMaxBranching, clampInt(1, 12));
  const minDepthNum = useUncontrolledNumber(setMinDepth, clampInt(1, 24));
  const maxPosNum = useUncontrolledNumber(setMaxPositions, (n) => Math.min(MAX_AUTO_POSITIONS, Math.max(5, Math.round(n))));
  const minLVNum = useUncontrolledNumber(setMinLV, (n) => Math.max(0, Math.min(1, n)));
  const minGamesNum = useUncontrolledNumber(setMinGames, (n) => Math.max(0, Math.min(1000000, Math.round(n))));

  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  };

  const handleStart = async (): Promise<void> => {
    if (running) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setError(null);
    setDone(null);
    setProgress(DEFAULT_STATS);
    setElapsed(0);
    startedAt.current = Date.now();
    lastProgressAt.current = 0;
    resultRef.current = null;

    const elo = ELO_TARGET_OPTIONS.find((o) => o.key === targetElo) || ELO_TARGET_OPTIONS[0];
    const cfg: AutoGenConfig = {
      maxDepth: depth,
      maxBranching,
      minFreq: MIN_FREQ,
      minGames,
      minPopularity: MIN_POPULARITY,
      coveragePercent: COVERAGE,
      adaptiveDepth,
      adaptiveMinDepth: minDepth,
      repertoireColor,
      maxPositions,
      explorationOrder,
      endpoint: elo.endpoint,
      ratingsParam: elo.ratingsParam,
      since: elo.since,
      gapMs: 600,
      pruneMinLineValue: minLV,
      engineJudge: {
        judge: (
          fen: string,
          o: {
            multiPv: number; depth: number; timeoutMs: number; signal?: AbortSignal;
            onPartial?: (lines: EngineMove[]) => void;
          },
        ) =>
          analyzeLocalFen(fen, {
            multiPv: o.multiPv,
            depth: o.depth,
            timeoutMs: o.timeoutMs,
            signal: o.signal,
            priority: 'background',
            onPartial: o.onPartial,
          }),
      },
    };
    try {
      const { root, stats, completed } = await generateAutoRepertoire(startFen, cfg, {
        signal: ctrl.signal,
        // Throttle : un batch de 1000 positions émet des milliers de
        // progressions ; au-delà de 4/s l'onglet rame sans rien afficher de plus.
        onProgress: (s) => {
          const now = Date.now();
          if (now - lastProgressAt.current >= 250 || s.positionsInterrogees >= maxPositions) {
            lastProgressAt.current = now;
            setProgress(s);
          }
        },
        // Animation live de l'exploration sur l'échiquier : le dernier coup
        // émis, throttlé (~6/s). Pas d'aperçu onglet caché (rendus perdus).
        onNode: (node) => {
          const now = Date.now();
          if (typeof document !== 'undefined' && document.hidden) return;
          if (now - lastNodePreviewAt.current >= 150) {
            lastNodePreviewAt.current = now;
            onPreviewMove?.(node.fen, node.uci);
          }
        },
        // (Flèches moteur désactivées : pas de onEngineEval/onEnginePartial —
        // demande utilisateur, le plateau reste lisible pendant le run.)
      });
      resultRef.current = root;
      const nodes = countNodes(root);
      setDone({ nodes, stats, root, completed });
      setProgress(stats);
    } catch (err) {
      if (isAbortError(err) || ctrl.signal.aborted) {
        setError('Génération interrompue avant tout résultat.');
      } else {
        setError(err instanceof Error ? err.message : 'Échec de la génération.');
      }
    } finally {
      // Fin/arrêt/erreur : l'échiquier revient sur la timeline.
      onPreviewMove?.(null);
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleStop = (): void => {
    abortRef.current?.abort();
  };

  const handleMerge = async (): Promise<void> => {
    if (!done || merging) return;
    setMerging(true);
    try {
      await onMerge(done.root, done.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de la sauvegarde du répertoire.');
    } finally {
      setMerging(false);
    }
  };

  /** Batch offline : le cache Explorer persistant (IndexedDB, sans expiration) évite de
   * repayer les positions ; l'arbre se télécharge en PGN (import Lichess
   * Étude) ou JSON brut. Aucun moteur/winrate : statistiques de jeu pures. */
  const handleExportPgn = (): void => {
    if (!done) return;
    const isWhite = repertoireColor === 'white';
    const pgn = generateTreePgn(done.root, {
      event: `Répertoire auto BFS (${targetElo})`,
      site: 'Lichess Explorer',
      white: isWhite ? 'Répertoire' : 'Adversaire',
      black: isWhite ? 'Adversaire' : 'Répertoire',
    });
    downloadFile(
      `repertoire_${repertoireColor}_${targetElo}.pgn`,
      pgn || '[Event "Répertoire vide"]\n*',
      'application/x-chess-pgn',
    );
  };

  const handleExportJson = (): void => {
    if (!done) return;
    downloadFile(
      `repertoire_${repertoireColor}_${targetElo}.json`,
      JSON.stringify(done.root, null, 2),
      'application/json',
    );
  };

  /** Presets de budget : Rapide (aperçu), Standard, Batch (gros volume offline). */
  const applyPreset = (d: number, maxPos: number): void => {
    setDepth(d);
    depthNum.write('depth', d);
    setMaxPositions(maxPos);
    maxPosNum.write('maxPos', maxPos);
  };

  return (
    <div className="panel-card auto-gen-card">
      <div className="card-title-row">
        <h3 className="card-title">
          <GitBranch size={16} className="text-accent" />
          Génération automatique (arbre BFS)
        </h3>
        {running && (
          <span className="loading-badge">
            <Loader2 size={13} className="spin" />
            <span>
              {progress.positionsInterrogees}/{maxPositions} pos · {progress.sent} coups
              {` · ${progress.cached} cache / ${progress.api} API`}
              {progress.engineNodes > 0 ? ` · ${progress.engineNodes} moteur` : ''}
              {progress.engineCached > 0 ? ` · ${progress.engineCached} sf-cache` : ''}
              {progress.transpositions > 0 ? ` · ${progress.transpositions} transpo` : ''}
              {progress.quiescenceExtended > 0 ? ` · ${progress.quiescenceExtended} quiescence` : ''}
              {progress.failed > 0 ? ` · ${progress.failed} échec(s)` : ''}
              {` · ${Math.round(elapsed)} s`}
            </span>
          </span>
        )}
        {running && (
          <button type="button" className="secondary-btn" onClick={handleStop} title="Interrompt la génération (le partiel est conservé)">
            <Square size={14} />
            <span>Arrêter</span>
          </button>
        )}
      </div>
      {running && (
        <p className="text-muted" style={{ fontSize: 12 }}>
          Génération en cours : champs verrouillés le temps du run.
          <strong> Arrêter</strong> conserve le partiel (reprenez plus tard, le cache évite de repayer).
        </p>
      )}
      <p className="text-muted" style={{ fontSize: 12 }}>
        Les coups retenus restent fréquentistes (popularité et couverture).
        Par défaut, les positions les plus probables sont explorées en priorité ;
        l'ordre par couverture traite un pli entier avant de creuser le suivant,
        ce qui répartit mieux un petit budget entre les branches.
        Tes répliques sont tranchées par Stockfish local — l'adversaire
        vient toujours de ton pool uniquement. Le budget pilote l'ampleur :
        petit budget = cœur populaire, grand budget = élargissement. Les
        mats (délivrés ou mat-en-1) sont toujours inclus en priorité. Les coups sont ajoutés à votre
        répertoire en un clic, ou téléchargés en PGN/JSON pour un batch
        offline (le cache Explorer persistant évite de repayer les positions).
      </p>

      <div role="group" aria-label="Presets de budget" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          type="button" className="auto-toggle-btn" disabled={running}
          onClick={() => applyPreset(8, 60)}
          title="Aperçu rapide : profondeur 8, 60 positions"
        >
          Rapide
        </button>
        <button
          type="button" className="auto-toggle-btn" disabled={running}
          onClick={() => applyPreset(12, 150)}
          title="Standard : profondeur 12, 150 positions"
        >
          Standard
        </button>
        <button
          type="button" className="auto-toggle-btn" disabled={running}
          onClick={() => applyPreset(16, 1000)}
          title="Batch offline : profondeur 16, 1000 positions (utilise le cache, export PGN/JSON)"
        >
          Batch
        </button>
      </div>

      <p
        className="text-muted"
        style={{ fontSize: 12 }}
        title={`Stockfish local tranche chaque réplique (repli populaire si aveugle).${threadsApplied !== null ? ` Threads appliqués au moteur : ${threadsApplied}.` : ''}`}
      >
        {(threadsApplied ?? engineThreads) > 1
          ? `Répliques moteur : Stockfish local (${(threadsApplied ?? engineThreads)} threads)`
          : threadsApplied === 1 && engineThreads > 1
            ? 'Répliques moteur : Stockfish local (repli mono-thread)'
            : 'Répliques moteur : Stockfish local (lent mais précis)'}
      </p>

      <p
        className="text-muted"
        style={{ fontSize: 12 }}
        title="Mémoire (LRU 2000) et IndexedDB accélèrent l'accès. Le lancement avec python run_web.py ajoute une base SQLite sur disque, indépendante des données du navigateur. Les entrées dépendent de l'endpoint, des cotes, des vitesses, du filtre temporel et de la position."
      >
        Explorer : {lichessCacheMemorySize()} en mémoire ·{' '}
        {explorerSqliteStatus().available
          ? `SQLite locale ${explorerSqliteStatus().entries} position(s), ${explorerSqliteStatus().engineEvaluations} évaluations moteur`
          : 'IndexedDB navigateur'}
      </p>
      {!lichessPersistHealthy() && (
        <p
          className="auto-gen-warn"
          style={{ fontSize: 12 }}
          title="Le cache durable IndexedDB n'est pas entièrement accessible en lecture ou écriture. Le run continue avec la mémoire disponible, mais certaines positions pourront être re-téléchargées. Exportez vos répertoires en JSON par sécurité."
        >
          Cache durable indisponible : certaines positions pourront être re-téléchargées. Exportez vos répertoires (JSON).
        </p>
      )}

      <div className="auto-gen-grid">
        <label className="auto-gen-field">
          <span>Profondeur (plis)</span>
          <input
            type="number" min={2} max={24} defaultValue={depth}
            disabled={running} ref={depthNum.attach('depth')}
            onBlur={depthNum.commit('depth', depth)}
            onKeyDown={blurOnEnter}
          />
        </label>
        <label className="auto-gen-field" title={`Plafonné à ${MAX_AUTO_POSITIONS} : au-delà, l'onglet sature (positions en cache quasi gratuites mais tri + chess.js par position). L'arrêt conserve le partiel, les 429 sont réessayés`}>
          <span>Budget positions (max {MAX_AUTO_POSITIONS})</span>
          <input
            type="number" min={5} max={MAX_AUTO_POSITIONS} defaultValue={maxPositions}
            disabled={running} ref={maxPosNum.attach('maxPos')}
            onBlur={maxPosNum.commit('maxPos', maxPositions)}
            onKeyDown={blurOnEnter}
          />
        </label>
      </div>
      <details className="auto-gen-advanced" style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>
          Paramètres avancés (largeur de l'arbre)
        </summary>
        <p className="text-muted" style={{ fontSize: 12 }}>
          Par défaut l'exploration suit la popularité (les plus jouées d'abord)
          sous le plafond du budget : l'Italienne et l'Espagnole sont explorées
          car jouées, et Stockfish tranche ta réplique. Ne touche
          ci-dessous que pour forcer la largeur.
        </p>
        <div className="auto-gen-grid">
          <label className="auto-gen-field" title="Populaire : priorité aux positions les plus probables (comportement actuel). Couverture : explore les positions d'un même pli avant de passer au pli suivant ; utile pour répartir un budget limité entre les branches.">
            <span>Ordre d'exploration</span>
            <select
              value={explorationOrder}
              disabled={running}
              onChange={(e) => setExplorationOrder(e.target.value === 'coverage' ? 'coverage' : 'popular')}
            >
              <option value="popular">Popularité (actuel)</option>
              <option value="coverage">Couverture par largeur</option>
            </select>
          </label>
          <label className="auto-gen-field" title="Opt-in winrate : retire nos coups sous cette valeur de ligne (0 = désactivé, la génération reste fréquentiste)">
            <span>Qualité mini (LV, opt-in)</span>
            <input
              type="number" min={0} max={1} step={0.05} defaultValue={minLV}
              disabled={running} ref={minLVNum.attach('minLV')}
              onBlur={minLVNum.commit('minLV', minLV)}
              onKeyDown={blurOnEnter}
            />
          </label>
          <label className="auto-gen-field" title="Coups max conservés par position (la couverture décide, ce plafond évite l'explosion sur les positions plates). Monte-le pour élargir l'arbre.">
            <span>Branches max</span>
            <input
              type="number" min={1} max={12} defaultValue={maxBranching}
              disabled={running} ref={branchNum.attach('branches')}
              onBlur={branchNum.commit('branches', maxBranching)}
              onKeyDown={blurOnEnter}
            />
          </label>
          <label className="auto-gen-field" title="Un coup adverse joué moins de fois que ce seuil n'entre pas dans l'arbre (0 = désactivé). Sans effet sur tes répliques (Stockfish tranche) ni sur les mats (toujours inclus).">
            <span>Parties mini (adversaire)</span>
            <input
              type="number" min={0} max={1000000} step={10} defaultValue={minGames}
              disabled={running} ref={minGamesNum.attach('minGames')}
              onBlur={minGamesNum.commit('minGames', minGames)}
              onKeyDown={blurOnEnter}
            />
          </label>
          <label className="auto-gen-field" title="Plancher de la profondeur adaptative (sans effet si la case adaptative est décochée).">
            <span>Profondeur mini (lignes rares)</span>
            <input
              type="number" min={1} max={24} defaultValue={minDepth}
              disabled={running || !adaptiveDepth} ref={minDepthNum.attach('minDepth')}
              onBlur={minDepthNum.commit('minDepth', minDepth)}
              onKeyDown={blurOnEnter}
            />
          </label>
          <label
            style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}
            title="Coché : les lignes rares s'arrêtent à Profondeur mini (runs ciblés, rapides). Décoché : tout va à Profondeur, le budget seul limite — le populaire est exploré d'abord, les rares ensuite."
          >
            <input
              type="checkbox"
              checked={adaptiveDepth}
              disabled={running}
              onChange={(e) => setAdaptiveDepth(e.target.checked)}
            />
            <span>Profondeur adaptative</span>
          </label>
        </div>
      </details>

      {error && (
        <div className="mini-error-box"><span>{error}</span></div>
      )}

      {done && (
        <div className="auto-gen-result">
          <span>
            {!done.completed ? 'Interrompu (partiel) · ' : ''}
            {done.nodes} coups · {done.stats.explored} positions · {done.stats.cached} cache / {done.stats.api} API
            {done.stats.engineNodes > 0 ? ` · ${done.stats.engineNodes} calcul(s) moteur` : ''}
            {done.stats.engineFallbacks > 0 ? ` · ${done.stats.engineFallbacks} repli(s) populaire(s)` : ''}
            {done.stats.engineCached > 0 ? ` · ${done.stats.engineCached} sf-cache` : ''}
            {' · '}{done.stats.transpositions} transposition(s)
            {done.stats.mates > 0 ? ` · ${done.stats.mates} mat(s) prioritaire(s)` : ''}
            {done.stats.prunedValue > 0 ? ` · ${done.stats.prunedValue} élagué(s) LV` : ''}
            {done.stats.emptyPositions > 0 ? ` · ${done.stats.emptyPositions} sans suite en base` : ''}
          </span>
          {(done.stats.apiWaitMs + done.stats.cacheWaitMs + done.stats.engineWaitMs) > 0 && (
            <span
              className="auto-gen-note"
              title="Durées cumulées des attentes pendant ce run. Elles excluent le temps de calcul local et les pauses de cadence entre requêtes."
            >
              Attente mesurée : API {formatWait(done.stats.apiWaitMs)}
              {' · '}cache {formatWait(done.stats.cacheWaitMs)}
              {' · '}moteur {formatWait(done.stats.engineWaitMs)}
            </span>
          )}
          {(done.stats.depthPruned + done.stats.popPruned) > 0 && (
            <span
              className="auto-gen-note"
              title="Le budget est un plafond, pas un objectif : la génération s'arrête quand l'arbre est exhaustif sous les seuils (popularité mini, profondeur adaptative). Pour un arbre plus gros, augmentez la Profondeur, le Budget, les Branches max ou la Profondeur mini."
            >
              Budget non consommé : {(done.stats.depthPruned + done.stats.popPruned).toLocaleString('fr-FR')} branche(s) élaguée(s) par les seuils
              {done.stats.depthPruned > 0 && done.stats.popPruned > 0
                ? ` (profondeur adaptative : ${done.stats.depthPruned.toLocaleString('fr-FR')} · popularité mini : ${done.stats.popPruned.toLocaleString('fr-FR')})`
                : done.stats.depthPruned > 0
                  ? ` (profondeur adaptative : ${done.stats.depthPruned.toLocaleString('fr-FR')})`
                  : ` (popularité mini : ${done.stats.popPruned.toLocaleString('fr-FR')})`}
              {' '}— l'arbre est exhaustif, pas tronqué.
            </span>
          )}
          {done.stats.failed > 0 && (
            <span className="auto-gen-warn">
              {done.stats.failed} position(s) en échec après réessai — relancez pour les compléter.
            </span>
          )}
        </div>
      )}

      <div className="priority-action-buttons" style={{ marginTop: 8 }}>
        {!running ? (
          <button className="primary-btn" onClick={() => void handleStart()}>
            <Play size={15} />
            <span>Générer l'arbre</span>
          </button>
        ) : (
          <button className="secondary-btn" onClick={handleStop}>
            <Square size={14} />
            <span>Arrêter</span>
          </button>
        )}
        {done && !running && (
          <button className="secondary-btn" onClick={() => void handleMerge()} disabled={merging}>
            <Download size={14} />
            <span>{merging ? 'Sauvegarde…' : `Fusionner${!done.completed ? ' le partiel' : ''} dans le répertoire (${done.nodes})`}</span>
          </button>
        )}
        {done && !running && (
          <button className="secondary-btn" onClick={handleExportPgn} title="Télécharge l'arbre en PGN avec variantes (import Lichess Étude)">
            <Download size={14} />
            <span>PGN</span>
          </button>
        )}
        {done && !running && (
          <button className="secondary-btn" onClick={handleExportJson} title="Télécharge l'arbre brut en JSON">
            <Download size={14} />
            <span>JSON</span>
          </button>
        )}
      </div>
    </div>
  );
};

function countNodes(root: RepertoireRoot): number {
  let n = 0;
  const stack = [...(root.children || [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    n++;
    if (cur.children) stack.push(...cur.children);
  }
  return n;
}
