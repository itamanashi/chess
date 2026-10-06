/**
 * Panneau "Répertoire Pièges (Stockfish MultiPV)".
 *
 * Sélectionne NOS coups en maximisant le drop-off d'évaluation adverse
 * (trap score) : on préfère les positions où l'adversaire n'a qu'UN seul
 * bon coup. Couvre toutes les réponses adverses dans la fenêtre configurable.
 *
 * Parallèle exact à AutoRepertoirePanel.tsx mais branche sur
 * generateTrapRepertoire() au lieu de generateAutoRepertoire().
 */

import React, { useEffect, useRef, useState } from 'react';
import { Crosshair, Loader2, Play, Square, Download } from 'lucide-react';
import type {
  BoardOrientation,
  EloTargetKey,
  RepertoireRoot,
} from '../types/chess';
import { ELO_TARGET_OPTIONS } from '../types/chess';
import {
  INITIAL_FEN,
  downloadFile,
  generateTreePgn,
} from '../utils/repertoire';
import {
  generateTrapRepertoire,
  type TrapGenConfig,
  type TrapGenStats,
} from '../services/trapAutoRepertoire';
import {
  analyzeLocalFen,
  desiredEngineThreads,
  getLocalEngineThreads,
  onLocalEngineStatusChange,
} from '../services/localEngine';
import { isAbortError } from '../utils/async';
import { countNodes } from '../utils/repertoireTree';
import {
  blurOnEnter,
  clampInt,
  useUncontrolledNumber,
} from '../hooks/useUncontrolledNumber';

// ─── Props ────────────────────────────────────────────────────────────────────

interface TrapRepertoirePanelProps {
  repertoireColor: BoardOrientation;
  targetElo: EloTargetKey;
  startFen?: string;
  onMerge: (root: RepertoireRoot) => void | Promise<void>;
  onPreviewMove?: (fen: string | null, uci?: string) => void;
}

// ─── Valeurs par défaut UI ────────────────────────────────────────────────────

const DEFAULT_STATS: TrapGenStats = {
  positionsInterrogees: 0,
  sent: 0,
  engineNodes: 0,
  engineCached: 0,
  engineFallbacks: 0,
  engineReused: 0,
  trapExtended: 0,
  mates: 0,
  trapPruned: 0,
  unsoundPruned: 0,
  adversaryCovered: 0,
  adversaryUncovered: 0,
  failed: 0,
  failedFens: [],
  transpositions: 0,
  explored: 0,
  depthPruned: 0,
  quiescenceExtended: 0,
  closingReplies: 0,
  unanswered: 0,
  elapsedMs: 0,
  cached: 0,
  api: 0,
};

// ─── Composant ────────────────────────────────────────────────────────────────

export const TrapRepertoirePanel: React.FC<TrapRepertoirePanelProps> = ({
  repertoireColor,
  targetElo,
  startFen = INITIAL_FEN,
  onMerge,
  onPreviewMove,
}) => {
  // ── Paramètres UI ──────────────────────────────────────────────────────────
  const [depth, setDepth] = useState(16);
  const [treeDepth, setTreeDepth] = useState(12);
  const [maxPositions, setMaxPositions] = useState(80);
  const [trapAdversaryWindow, setTrapAdversaryWindow] = useState(50);
  const [minTrapScore, setMinTrapScore] = useState(0);
  const [soundnessWindow, setSoundnessWindow] = useState(60);
  const [useLichess, setUseLichess] = useState(false);

  // ── État run ───────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<TrapGenStats>(DEFAULT_STATS);
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState<{
    nodes: number;
    stats: TrapGenStats;
    root: RepertoireRoot;
    completed: boolean;
  } | null>(null);
  const [merging, setMerging] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const startedAt = useRef(0);
  const lastProgressAt = useRef(0);
  const lastNodePreviewAt = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Threads moteur ─────────────────────────────────────────────────────────
  const engineThreads = desiredEngineThreads();
  const [threadsApplied, setThreadsApplied] = useState<number | null>(null);
  useEffect(() => {
    const off = onLocalEngineStatusChange((s) => {
      setThreadsApplied(s === 'ready' ? getLocalEngineThreads() : null);
    });
    return off;
  }, []);

  // ── Chrono ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (running) {
      timerRef.current = setInterval(() => {
        setElapsed((Date.now() - startedAt.current) / 1000);
      }, 500);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [running]);

  // ── Champs non-contrôlés ───────────────────────────────────────────────────
  const depthNum = useUncontrolledNumber(setDepth, clampInt(8, 24));
  const treeNum = useUncontrolledNumber(setTreeDepth, clampInt(2, 32));
  const maxPosNum = useUncontrolledNumber(setMaxPositions, (n) =>
    Math.max(10, Math.round(n)),
  );
  const windowNum = useUncontrolledNumber(
    setTrapAdversaryWindow,
    clampInt(0, 500),
  );
  const minTrapNum = useUncontrolledNumber(setMinTrapScore, clampInt(0, 500));
  const soundNum = useUncontrolledNumber(setSoundnessWindow, clampInt(0, 500));

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleStart = async (): Promise<void> => {
    if (running) return;
    // Commit synchrone des champs (frappe + clic direct sans blur préalable).
    const depthNow = depthNum.read('depth', depth);
    const treeNow = treeNum.read('tree', treeDepth);
    const maxPosNow = maxPosNum.read('maxPos', maxPositions);
    const windowNow = windowNum.read('window', trapAdversaryWindow);
    const minTrapNow = minTrapNum.read('minTrap', minTrapScore);
    const soundNow = soundNum.read('sound', soundnessWindow);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setError(null);
    setDone(null);
    setProgress(DEFAULT_STATS);
    setElapsed(0);
    startedAt.current = Date.now();
    lastProgressAt.current = 0;

    const elo =
      ELO_TARGET_OPTIONS.find((o) => o.key === targetElo) ??
      ELO_TARGET_OPTIONS[0];
    const cfg: TrapGenConfig = {
      depth: depthNow,
      maxPositions: maxPosNow,
      // Profondeur de l'arbre en demi-coups : réglage indépendant de la
      // profondeur Stockfish (qui règle la qualité d'évaluation, pas la taille).
      maxDepth: treeNow,
      trapAdversaryWindow: windowNow,
      minTrapScore: minTrapNow,
      soundnessWindow: soundNow,
      useLichessForOpponent: useLichess,
      endpoint: elo.endpoint,
      ratingsParam: elo.ratingsParam,
      since: elo.since,
      repertoireColor,
      gapMs: 600,
      judge: (fen, opts) =>
        analyzeLocalFen(fen, {
          multiPv: opts.multiPv,
          depth: opts.depth,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
          priority: 'background',
          onPartial: opts.onPartial,
        }),
    };

    try {
      const { root, stats, completed } = await generateTrapRepertoire(
        startFen,
        cfg,
        {
          signal: ctrl.signal,
          onProgress: (s) => {
            const now = Date.now();
            if (
              now - lastProgressAt.current >= 250 ||
              s.positionsInterrogees + s.engineCached >= maxPosNow
            ) {
              lastProgressAt.current = now;
              setProgress(s);
            }
          },
          onNode: (node) => {
            const now = Date.now();
            if (typeof document !== 'undefined' && document.hidden) return;
            if (now - lastNodePreviewAt.current >= 150) {
              lastNodePreviewAt.current = now;
              onPreviewMove?.(node.fen, node.uci);
            }
          },
        },
      );
      const nodes = countNodes(root);
      setDone({ nodes, stats, root, completed });
      setProgress(stats);
    } catch (err) {
      if (isAbortError(err) || ctrl.signal.aborted) {
        setError('Génération interrompue avant tout résultat.');
      } else {
        setError(
          err instanceof Error ? err.message : 'Échec de la génération pièges.',
        );
      }
    } finally {
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
      await onMerge(done.root);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de la sauvegarde.');
    } finally {
      setMerging(false);
    }
  };

  const handleExportPgn = (): void => {
    if (!done) return;
    const isWhite = repertoireColor === 'white';
    const pgn = generateTreePgn(done.root, {
      event: `Répertoire Pièges (${targetElo})`,
      site: 'Stockfish MultiPV',
      white: isWhite ? 'Répertoire' : 'Adversaire',
      black: isWhite ? 'Adversaire' : 'Répertoire',
    });
    downloadFile(
      `repertoire_pieges_${repertoireColor}_${targetElo}.pgn`,
      pgn || '[Event "Répertoire vide"]\n*',
      'application/x-chess-pgn',
    );
  };

  const handleExportJson = (): void => {
    if (!done) return;
    downloadFile(
      `repertoire_pieges_${repertoireColor}_${targetElo}.json`,
      JSON.stringify(done.root, null, 2),
      'application/json',
    );
  };

  const applyPreset = (
    d: number,
    tree: number,
    pos: number,
    window: number,
  ): void => {
    setDepth(d);
    depthNum.write('depth', d);
    setTreeDepth(tree);
    treeNum.write('tree', tree);
    setMaxPositions(pos);
    maxPosNum.write('maxPos', pos);
    setTrapAdversaryWindow(window);
    windowNum.write('window', window);
    // minTrapScore non touché : l'utilisateur le règle lui-même (0 = désactivé par défaut).
  };

  // ── Rendu ──────────────────────────────────────────────────────────────────
  return (
    <div className="panel-card auto-gen-card">
      <div className="card-title-row">
        <h3 className="card-title">
          <Crosshair size={16} className="text-accent" />
          Répertoire Pièges (Stockfish MultiPV)
        </h3>
        {running && (
          <span className="loading-badge">
            <Loader2 size={13} className="spin" />
            <span>
              {progress.positionsInterrogees + progress.engineCached}/
              {maxPositions} appels
              {' · '}
              {progress.sent} coups
              {progress.engineNodes > 0
                ? ` · ${progress.engineNodes} moteur`
                : ''}
              {progress.engineCached > 0
                ? ` · ${progress.engineCached} sf-cache`
                : ''}
              {progress.trapPruned > 0
                ? ` · ${progress.trapPruned} élagués`
                : ''}
              {progress.adversaryUncovered > 0
                ? ` · ${progress.adversaryUncovered} pièges`
                : ''}
              {` · ${Math.round(elapsed)} s`}
            </span>
          </span>
        )}
        {running && (
          <button
            type="button"
            className="secondary-btn"
            onClick={handleStop}
            title="Interrompt la génération (le partiel est conservé)"
          >
            <Square size={14} />
            <span>Arrêter</span>
          </button>
        )}
      </div>

      {running && (
        <p className="text-muted" style={{ fontSize: 12 }}>
          Génération en cours — chaque position évalue nos coups puis les
          réponses adverses. Plus long que le BFS classique (double appel
          Stockfish par nœud). <strong>Arrêter</strong> conserve le partiel.
        </p>
      )}

      {!running && (
        <p className="text-muted" style={{ fontSize: 12 }}>
          Explore <strong>tous les candidats</strong> pendant la génération,
          puis post-traite pour ne garder qu'une <strong>seule réponse</strong>{' '}
          à notre tour selon le drop-off d'évaluation adverse (trap score) : on
          préfère les positions où l'adversaire n'a qu'un seul bon coup. Couvre
          toutes les réponses adverses dans la fenêtre configurable. Optimisé :
          MultiPV adaptatif selon la complexité, même profondeur moteur pour
          tous les coups.
        </p>
      )}

      {/* Presets */}
      <div
        role="group"
        aria-label="Presets pièges"
        style={{ display: 'flex', gap: 6, marginBottom: 8 }}
      >
        <button
          type="button"
          className="auto-toggle-btn"
          disabled={running}
          onClick={() => applyPreset(14, 8, 60, 50)}
          title="Aperçu rapide : Stockfish D14, arbre 8 demi-coups, 60 appels moteur (cache en sus), fenêtre 50cp"
        >
          Rapide
        </button>
        <button
          type="button"
          className="auto-toggle-btn"
          disabled={running}
          onClick={() => applyPreset(16, 12, 120, 50)}
          title="Standard : Stockfish D16, arbre 12 demi-coups, 120 appels moteur (cache en sus), fenêtre 50cp"
        >
          Standard
        </button>
        <button
          type="button"
          className="auto-toggle-btn"
          disabled={running}
          onClick={() => applyPreset(18, 16, 300, 40)}
          title="Profond : Stockfish D18, arbre 16 demi-coups, 300 appels moteur (cache en sus), fenêtre 40cp (très lent)"
        >
          Profond
        </button>
      </div>

      {/* Paramètres */}
      <div
        className="param-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px 12px',
          marginBottom: 8,
        }}
      >
        {/* Profondeur Stockfish */}
        <label className="param-label" style={{ fontSize: 12 }}>
          Profondeur Stockfish
          <input
            ref={depthNum.attach('depth')}
            type="number"
            min={8}
            max={24}
            step={1}
            defaultValue={depth}
            disabled={running}
            className="param-input"
            style={{ width: '100%', marginTop: 2 }}
            onBlur={depthNum.commit('depth', depth)}
            onKeyDown={blurOnEnter}
          />
        </label>

        {/* Budget moteur */}
        <label
          className="param-label"
          style={{ fontSize: 12 }}
          title="Nombre d'appels Stockfish, cache inclus (1 unité par appel, calculé ou relu). Chaque position à notre tour ≈ 1 appel + 1 par candidat sain. Sans plafond."
        >
          Budget moteur (appels, cache inclus)
          <input
            ref={maxPosNum.attach('maxPos')}
            type="number"
            min={10}
            step={10}
            defaultValue={maxPositions}
            disabled={running}
            className="param-input"
            style={{ width: '100%', marginTop: 2 }}
            onBlur={maxPosNum.commit('maxPos', maxPositions)}
            onKeyDown={blurOnEnter}
          />
        </label>

        {/* Profondeur de l'arbre */}
        <label
          className="param-label"
          style={{ fontSize: 12 }}
          title="Taille de l'arbre en demi-coups. Indépendant de la profondeur Stockfish (qualité d'évaluation)."
        >
          Profondeur arbre (demi-coups)
          <input
            ref={treeNum.attach('tree')}
            type="number"
            min={2}
            max={32}
            step={1}
            defaultValue={treeDepth}
            disabled={running}
            className="param-input"
            style={{ width: '100%', marginTop: 2 }}
            onBlur={treeNum.commit('tree', treeDepth)}
            onKeyDown={blurOnEnter}
          />
        </label>

        {/* Fenêtre bonne réponse adverse */}
        <label
          className="param-label"
          style={{ fontSize: 12 }}
          title="Réponses adverses dans [meilleur, meilleur + N cp] : toutes couvertes. Au-delà = réponse sous-optimale non couverte."
        >
          Fenêtre adverse (cp)
          <input
            ref={windowNum.attach('window')}
            type="number"
            min={0}
            max={500}
            step={5}
            defaultValue={trapAdversaryWindow}
            disabled={running}
            className="param-input"
            style={{ width: '100%', marginTop: 2 }}
            onBlur={windowNum.commit('window', trapAdversaryWindow)}
            onKeyDown={blurOnEnter}
          />
        </label>

        {/* Seuil trap score */}
        <label
          className="param-label"
          style={{ fontSize: 12 }}
          title="Drop-off minimum (cp) entre la meilleure et la 2e réponse adverse. Ligne élagée en dessous. 0 = désactivé."
        >
          Seuil piège (cp)
          <input
            ref={minTrapNum.attach('minTrap')}
            type="number"
            min={0}
            max={500}
            step={5}
            defaultValue={0}
            disabled={running}
            className="param-input"
            style={{ width: '100%', marginTop: 2 }}
            onBlur={minTrapNum.commit('minTrap', minTrapScore)}
            onKeyDown={blurOnEnter}
          />
        </label>

        {/* Fenêtre solidité */}
        <label
          className="param-label"
          style={{ fontSize: 12 }}
          title="On n'accepte que nos coups à moins de N cp sous le meilleur objectif. 0 = tout coup, même perdant."
        >
          Solidité (cp)
          <input
            ref={soundNum.attach('sound')}
            type="number"
            min={0}
            max={500}
            step={5}
            defaultValue={soundnessWindow}
            disabled={running}
            className="param-input"
            style={{ width: '100%', marginTop: 2 }}
            onBlur={soundNum.commit('sound', soundnessWindow)}
            onKeyDown={blurOnEnter}
          />
        </label>

        {/* Enrichir avec Lichess */}
        <label
          className="param-label"
          style={{ fontSize: 12 }}
          title="Croiser les bonnes réponses Stockfish avec les coups réellement joués à l'Elo cible. Évite de couvrir des théories jamais jouées en pratique."
        >
          <span style={{ display: 'block', marginBottom: 4 }}>
            Enrichir Lichess
          </span>
          <input
            type="checkbox"
            checked={useLichess}
            disabled={running}
            onChange={(e) => setUseLichess(e.target.checked)}
            style={{ width: 'auto', marginTop: 2 }}
          />
        </label>
      </div>

      {/* Infos moteur */}
      <p className="text-muted" style={{ fontSize: 12 }}>
        {(threadsApplied ?? engineThreads) > 1
          ? `Stockfish local (${threadsApplied ?? engineThreads} threads) — D${depth}`
          : `Stockfish local (mono-thread) — D${depth}`}
      </p>

      {/* Bouton lancer */}
      {!running && (
        <button
          type="button"
          className="primary-btn"
          onClick={() => void handleStart()}
          style={{ width: '100%', marginBottom: 6 }}
        >
          <Play size={14} />
          <span>Générer les pièges</span>
        </button>
      )}

      {/* Erreur */}
      {error && !running && (
        <p
          className="text-muted"
          style={{
            fontSize: 12,
            color: 'var(--danger, #c0392b)',
            marginBottom: 6,
          }}
        >
          {error}
        </p>
      )}

      {/* Résultats */}
      {done && !running && (
        <div
          style={{
            fontSize: 12,
            marginBottom: 6,
            padding: '6px 8px',
            background: 'var(--surface-2, rgba(0,0,0,.05))',
            borderRadius: 6,
          }}
        >
          <strong>
            {done.nodes} coups générés{!done.completed ? ' (partiel)' : ''}
          </strong>
          {' — '}
          {done.stats.adversaryUncovered} position
          {done.stats.adversaryUncovered !== 1 ? 's' : ''} piège
          {done.stats.adversaryUncovered !== 1 ? 's' : ''}
          {done.stats.trapPruned > 0 &&
            ` · ${done.stats.trapPruned} lignes élagées (trap score insuffisant)`}
          {done.stats.unsoundPruned > 0 &&
            ` · ${done.stats.unsoundPruned} coups non-solides rejetés`}
          {done.stats.engineNodes > 0 &&
            ` · ${done.stats.engineNodes} évals Stockfish`}
          {done.stats.engineCached > 0 &&
            ` · ${done.stats.engineCached} depuis cache`}
          {done.stats.engineReused > 0 &&
            ` · ${done.stats.engineReused} lignes réutilisées (0 appel)`}
          {done.stats.trapExtended > 0 &&
            ` · ${done.stats.trapExtended} nœuds creusés (filon piégeux)`}
        </div>
      )}

      {/* Actions post-génération */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {done && !running && (
          <button
            className="secondary-btn"
            onClick={() => void handleMerge()}
            disabled={merging}
            style={{ flex: 1 }}
          >
            <Download size={14} />
            <span>
              {merging
                ? 'Sauvegarde…'
                : `Intégrer${!done.completed ? ' le partiel' : ''} (${done.nodes})`}
            </span>
          </button>
        )}
        {done && !running && (
          <button
            className="secondary-btn"
            onClick={handleExportPgn}
            title="Télécharge les lignes pièges en PGN"
          >
            <Download size={14} />
            <span>PGN</span>
          </button>
        )}
        {done && !running && (
          <button
            className="secondary-btn"
            onClick={handleExportJson}
            title="Télécharge l'arbre brut en JSON"
          >
            <Download size={14} />
            <span>JSON</span>
          </button>
        )}
      </div>
    </div>
  );
};
