import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Chess, type Square } from 'chess.js';
import type {
  RepertoireItem,
  BoardOrientation,
  StudioTab,
  LichessMove,
  RepertoireMove,
} from './types/chess';
import {
  INITIAL_FEN,
  normalizeFen,
  normalizeCastleUci,
  indexRepertoire,
  generatePgn,
  downloadFile,
} from './utils/repertoire';
import { applyOpeningPatches, type OpeningPatch } from './utils/openingGroups';
import {
  ensurePathAndInsert,
  ensurePathAndInsertBatch,
  buildMoveFromLichess,
  makePlaceholderMove,
  buildHistoryFromUciPath,
  buildHistoryFromSans,
  findUciPathsToPositions,
  getTrainerPositionKeys,
  mergeAutoRoot,
  turnOfFen,
} from './utils/repertoireTree';
import { detectTactics, filterReportForMove, tacticsToShapes, type TacticsMotif } from './utils/tactics';
import type { ChesscomGame } from './services/chesscom';
import { soundFx } from './utils/audio';
import { useChessTimeline } from './hooks/useChessTimeline';
import { useChesscomAccount } from './hooks/useChesscomAccount';
import { useRepertoireLibrary } from './hooks/useRepertoireLibrary';
import { useTrainerMode } from './hooks/useTrainerMode';
import { useHoverPreview } from './hooks/useHoverPreview';
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, Eye, Repeat, X } from 'lucide-react';
import { Chessboard } from './components/Chessboard';
import { EvalBar } from './components/EvalBar';
import { Sidebar } from './components/Sidebar';
import { uiPrefs, type PieceSkin } from './storage/preferences';
import { useToast } from './hooks/useToast';
import {
  TOAST_COPY_UNAVAILABLE,
  TOAST_PGN_EMPTY,
  toastBatchAdded,
  toastCopyOk,
  toastImportError,
  toastImportPartial,
  toastImportSuccess,
} from './i18n';
import { RepertoireLibrary } from './components/RepertoireLibrary';
import { RepertoireBuilder } from './components/RepertoireBuilder';
import { ExplorerPanel } from './components/ExplorerPanel';
import { RepertoireGraphTree } from './components/RepertoireGraphTree';
import { TrainerPanel } from './components/TrainerPanel';
  import { LichessLivePanel } from './components/LichessLivePanel';
  import { ChesscomPanel } from './components/ChesscomPanel';
import { AnalysisPanel } from './components/AnalysisPanel';

export const App: React.FC = () => {
  // --- VUE GLOBALE ---
  const [appView, setAppView] = useState<'library' | 'studio'>('library');
  const [activeStudioTab, setActiveStudioTab] = useState<StudioTab>('builder');
  const [orientation, setOrientation] = useState<BoardOrientation>('white');
  const [pieceSkin, setPieceSkin] = useState<PieceSkin>(() => uiPrefs.getPieceSkin());
  const [isMainLinePlaying, setIsMainLinePlaying] = useState(false);
  // Surcouche tactique animée (attaques, défenses, clouages, fourchettes).
  const [showTactics, setShowTactics] = useState(false);
  const [tacticFilter, setTacticFilter] = useState<Record<TacticsMotif, boolean>>({
    attack: true,
    defense: true,
    pin: true,
    fork: true,
  });

  // --- STORES MÉTIER ---
  // Timeline = source unique (fen / history / index / lastMove).
  const timeline = useChessTimeline();
  const { fen, history, currentIndex } = timeline;
  // Bibliothèque = CRUD + persistance via le repository versionné.
  const library = useRepertoireLibrary();
  const { activeRepertoire } = library;
  const trainerPositionKeys = useMemo(
    () => activeRepertoire
      ? getTrainerPositionKeys(activeRepertoire.root, activeRepertoire.color)
      : [],
    [activeRepertoire],
  );
  // Trainer = feedback + stats + fin de ligne.
  const trainer = useTrainerMode(activeRepertoire?.id, trainerPositionKeys);
  // Survol = aperçu temporaire sans toucher à la timeline.
  const preview = useHoverPreview(fen, timeline.lastMove);
  // Animation live de la génération auto : pendant un run, l'échiquier suit
  // l'exploration (prioritaire sur le survol) ; null le reste du temps
  // (le panneau renvoie null en fin/arrêt/erreur → retour timeline).
  const [autoGenPreview, setAutoGenPreview] = useState<{ fen: string; uci?: string } | null>(null);
  const handleAutoPreviewMove = useCallback((previewFen: string | null, uci?: string) => {
    setAutoGenPreview(previewFen ? { fen: previewFen, uci } : null);
  }, []);
  // Flèches live de la réflexion moteur pendant la génération (meilleur
  // vert, équivalents bleus). Fusionnées aux formes du plateau, effacées
  // en fin de run (le panneau renvoie null).
  const [autoGenArrows, setAutoGenArrows] = useState<{ orig: string; dest: string; brush: string }[] | null>(null);
  const [analysisArrows, setAnalysisArrows] = useState<{ orig: string; dest: string; brush: string }[]>([]);
  const [analysisPreview, setAnalysisPreview] = useState<{
    rootFen: string;
    fen: string;
    lastMove: [string, string];
  } | null>(null);
  const handleAnalysisArrows = useCallback(
    (arrows: { orig: string; dest: string; brush: string }[] | null) => {
      setAnalysisArrows(arrows ?? []);
    },
    [],
  );
  const handleAnalysisPreview = useCallback(
    (preview: { fen: string; lastMove: [string, string] } | null) => {
      setAnalysisPreview(preview ? { ...preview, rootFen: fen } : null);
    },
    [fen],
  );
  const handleAutoEngineArrows = useCallback(
    (arrows: { orig: string; dest: string; brush: string }[] | null) => {
      setAutoGenArrows(arrows);
    },
    [],
  );
  const boardFen = autoGenPreview?.fen ?? preview.displayFen;
  const boardLastMove = autoGenPreview
    ? (autoGenPreview.uci && autoGenPreview.uci.length >= 4
        ? [autoGenPreview.uci.slice(0, 2), autoGenPreview.uci.slice(2, 4)] as [string, string]
        : undefined)
    : preview.displayLastMove;
  // Service UI uniforme : feedback non bloquant (remplace les alert()).
  const toast = useToast();
  const handlePieceSkinChange = (skin: PieceSkin): void => {
    setPieceSkin(skin);
    uiPrefs.setPieceSkin(skin);
  };

  // --- TIMERS ASYNC SUIVIS (annulation systématique) ---
  // Réponse adverse du trainer (380 ms) : un seul en vol, invalidé par le
  // coup suivant, la navigation ou le changement d'onglet/vue.
  const trainerReplyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trainerReplyToken = useRef(0);
  // Premier coup auto à l'ouverture d'un répertoire noir en mode trainer.
  const blackOpeningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blackOpeningToken = useRef(0);
  // Miroir du FEN courant pour les gardes d'obsolescence dans les timeouts
  // (le closure du setTimeout verrait sinon un FEN périmé).
  const fenRef = useRef(fen);
  fenRef.current = fen;

  const cancelTrainerReply = useCallback(() => {
    trainerReplyToken.current++;
    if (trainerReplyTimer.current) {
      clearTimeout(trainerReplyTimer.current);
      trainerReplyTimer.current = null;
    }
  }, []);

  const cancelBlackOpening = useCallback(() => {
    blackOpeningToken.current++;
    if (blackOpeningTimer.current) {
      clearTimeout(blackOpeningTimer.current);
      blackOpeningTimer.current = null;
    }
  }, []);

  // Enchaînement auto des variantes en entraînement : fin de ligne →
  // nouvelle variante sans écran intermédiaire. Un seul timer en vol,
  // invalidé par toute navigation / changement d'onglet (comme les replies).
  const autoRestartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRestartToken = useRef(0);
  // Garde anti-boucle : un cul-de-sac immédiat au redémarrage (aucune suite
  // jouable) termine sur l'écran de fin au lieu de relancer en boucle.
  const skipAutoRestartOnce = useRef(false);
  const [autoRestartPending, setAutoRestartPending] = useState(false);

  const cancelAutoRestart = useCallback(() => {
    autoRestartToken.current++;
    if (autoRestartTimer.current) {
      clearTimeout(autoRestartTimer.current);
      autoRestartTimer.current = null;
    }
    setAutoRestartPending(false);
  }, []);

  // Démontage : aucun callback fantôme après sortie du composant.
  // (via les helpers stables : pas d'accès direct aux refs dans le cleanup)
  useEffect(() => {
    return () => {
      cancelTrainerReply();
      cancelBlackOpening();
      cancelAutoRestart();
    };
  }, [cancelTrainerReply, cancelBlackOpening, cancelAutoRestart]);

  // Indexation du répertoire actif pour recherche instantanée des variantes
  const repertoireIndex = useMemo(() => {
    return indexRepertoire(activeRepertoire?.root || null);
  }, [activeRepertoire]);

  const currentNormalizedFen = useMemo(() => normalizeFen(fen), [fen]);
  const candidateMoves = useMemo(() => {
    return repertoireIndex.fenToChildren.get(currentNormalizedFen) || [];
  }, [repertoireIndex, currentNormalizedFen]);

  const isInRepertoire =
    candidateMoves.length > 0 ||
    (currentIndex > 0 &&
      repertoireIndex.fenToChildren.has(normalizeFen(history[currentIndex - 1].fen)));

  // Navigation dans l'historique (réinitialise le feedback trainer et
  // annule la réponse adverse en vol — elle partait d'une position quittée).
  const jumpToMove = useCallback(
    (idx: number) => {
      cancelTrainerReply();
      cancelAutoRestart();
      timeline.jumpTo(idx);
      trainer.resetForNavigation();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline.jumpTo, trainer.resetForNavigation, cancelTrainerReply, cancelAutoRestart],
  );

  // Visionneuse « Mes parties » : la partie vit sur la timeline principale
  // et ses contrôles sont rendus SOUS le plateau (colonne sticky : ils
  // suivent le scroll). Éphémère : réinitialisé à chaque navigation
  // bibliothèque/studio (voir handleOpen* / handleBackToLibrary).
  const [gameViewer, setGameViewer] = useState<{ url: string; sans: string[]; ply: number } | null>(null);

  const openGameViewer = useCallback((game: ChesscomGame) => {
    timeline.loadLine(buildHistoryFromSans(game.sans));
    setGameViewer({ url: game.url, sans: game.sans, ply: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToViewerPly = useCallback(
    (n: number) => {
      const total = gameViewer?.sans.length ?? 0;
      const clamped = Math.max(0, Math.min(total, n));
      setGameViewer((v) => (v ? { ...v, ply: clamped } : v));
      jumpToMove(clamped);
    },
    [gameViewer, jumpToMove],
  );

  const closeGameViewer = useCallback(() => {
    setGameViewer(null);
  }, []);

  // Visionneuse Mes parties : grand échiquier + panneau Rejouer seul.
  const isGameViewer = activeStudioTab === 'games' && gameViewer !== null;
  // Compte Chess.com partagé sidebar ↔ panneau jeux (instance unique).
  const chessAccount = useChesscomAccount({ onAccountReset: closeGameViewer });

  const handleBackToStart = useCallback(() => {
    jumpToMove(0);
  }, [jumpToMove]);

  // Réplique adverse pondérée (fréquence réelle des parties) + préparation
  // du coup suivant. Partagée entre les répliques en cours de ligne et le
  // premier coup adverse au redémarrage (répertoire noirs). Avec
  // `allowComplete=false`, un cul-de-sac ou un coup illégal termine sur
  // l'écran de fin (skip-once) au lieu de boucler en redémarrages.
  const applyTrainerOpponentReply = useCallback((
    baseFen: string,
    options: RepertoireMove[],
    allowComplete: boolean,
  ): void => {
    if (options.length === 0) return;
    // Tirage pondéré proportionnel au nombre réel de parties.
    let selected = options[0];
    const totalWeight = options.reduce(
      (acc, m) => acc + (m.parties || 1),
      0,
    );
    let rand = Math.random() * totalWeight;
    for (const m of options) {
      rand -= m.parties || 1;
      if (rand <= 0) {
        selected = m;
        break;
      }
    }
    // Roque Lichess (e1h1) -> standard (e1g1) pour chess.js
    const stdReplyUci = normalizeCastleUci(baseFen, selected.uci);
    try {
      const c = new Chess(baseFen);
      const opponentMove = c.move({
        from: stdReplyUci.slice(0, 2) as Square,
        to: stdReplyUci.slice(2, 4) as Square,
        promotion: (stdReplyUci.length > 4 ? stdReplyUci[4] : 'q') as
          | 'q'
          | 'r'
          | 'b'
          | 'n',
      });
      if (opponentMove) {
        soundFx.playMove();
        timeline.appendOpponentMove(
          opponentMove.san,
          stdReplyUci,
          c.fen(),
        );
        trainer.setLastSuccess(null);
        trainer.setHintRevealed(false);

        const userNextOptions =
          repertoireIndex.fenToChildren.get(normalizeFen(c.fen())) || [];
        if (userNextOptions.length === 0) {
          if (!allowComplete) skipAutoRestartOnce.current = true;
          trainer.completeLine();
        } else {
          trainer.setExpectedMoveSan(userNextOptions[0].san);
          trainer.setExpectedMoveUci(userNextOptions[0].uci);
        }
      } else if (!allowComplete) {
        skipAutoRestartOnce.current = true;
        trainer.completeLine();
      }
    } catch {
      if (!allowComplete) {
        skipAutoRestartOnce.current = true;
        trainer.completeLine();
      }
      /* réplique illégale en cours de ligne : on ignore */
    }
  // Dépendances membres (pas les objets entiers) : les retours de hooks
  // sont mémoïsés, les setters/callbacks sont stables — l'objet entier
  // recréerait le callback à chaque rendu (tempête Chessground/effets).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    repertoireIndex,
    timeline.appendOpponentMove,
    trainer.setLastSuccess,
    trainer.setHintRevealed,
    trainer.setExpectedMoveSan,
    trainer.setExpectedMoveUci,
    trainer.completeLine,
  ]);

  // Exécution d'un coup physique sur l'échiquier
  const executeMove = useCallback(
    (from: string, to: string, promotion?: string): boolean => {
      // Snapshot AVANT le coup : chemin à garantir dans l'arbre.
      const prevHistory = history;
      const prevIndex = currentIndex;
      const prevFen = prevHistory[prevIndex]?.fen ?? INITIAL_FEN;
      const prevNormFen = normalizeFen(prevFen);
      const validExpectedMoves = repertoireIndex.fenToChildren.get(prevNormFen) || [];

      // Pré-validation en mode entraînement : un coup faux est refusé AVANT
      // d'entrer dans la timeline — le plateau reste sur la position à
      // corriger et la flèche verte y pointe le coup attendu.
      if (activeStudioTab === 'trainer' && activeRepertoire && validExpectedMoves.length > 0) {
        const mover = turnOfFen(prevFen);
        const myColor = activeRepertoire.color === 'white' ? 'w' : 'b';
        if (mover === myColor) {
          let previewSan: string | null = null;
          let previewUci: string | null = null;
          try {
            const probe = new Chess(prevFen);
            const pm = probe.move({
              from: from as Square,
              to: to as Square,
              promotion: (promotion || 'q') as 'q' | 'r' | 'b' | 'n',
            });
            if (pm) {
              previewSan = pm.san;
              previewUci = `${from}${to}${pm.promotion || ''}`;
            }
          } catch {
            /* illégal : playPhysicalMove refusera */
          }
          if (previewSan && previewUci) {
            const isTheory = validExpectedMoves.some(
              (m) => m.uci === previewUci || m.san === previewSan,
            );
            if (!isTheory) {
              trainer.feedbackError(
                previewSan,
                validExpectedMoves[0]?.san || 'aucun coup',
                validExpectedMoves[0]?.uci || '',
                prevNormFen,
              );
              soundFx.playError();
              return false;
            }
          }
        }
      }

      const result = timeline.playPhysicalMove(from, to, promotion);
      if (!result) return false;
      const { san: playedSan, uci, newFen } = result;

      // Enregistrement auto en mode builder (tous les coups, en recréant les
      // positions intermédiaires manquantes le long de l'historique).
      if (activeRepertoire && activeStudioTab === 'builder') {
        if (!validExpectedMoves.some((m) => m.uci === uci)) {
          const child = makePlaceholderMove(playedSan, uci, newFen);
          const pathItems = prevHistory.slice(0, prevIndex + 1);
          library.updateActiveRoot(activeRepertoire.id, (root) => {
            ensurePathAndInsert(root, pathItems, prevNormFen, child);
          });
        }
      }

      // --- LOGIQUE DU MODE ENTRAÎNEMENT ---
      if (activeStudioTab === 'trainer' && activeRepertoire) {
        const playedColor = turnOfFen(newFen) === 'w' ? 'b' : 'w';
        const isMyColor =
          (activeRepertoire.color === 'white' && playedColor === 'w') ||
          (activeRepertoire.color === 'black' && playedColor === 'b');

        if (isMyColor) {
          const isTheory = validExpectedMoves.some(
            (m) => m.uci === uci || m.san === playedSan,
          );

          if (isTheory) {
            trainer.feedbackSuccess(prevNormFen, trainer.hintRevealed);
            soundFx.playSuccess();

            const nextNorm = normalizeFen(newFen);
            const opponentOptions = repertoireIndex.fenToChildren.get(nextNorm) || [];

            if (opponentOptions.length > 0) {
              // Un seul reply en vol : le nouveau coup supplante le précédent.
              cancelTrainerReply();
              const replyToken = ++trainerReplyToken.current;
              const replyBaseFen = newFen;
              trainerReplyTimer.current = setTimeout(() => {
                trainerReplyTimer.current = null;
                // Contexte obsolète (navigation, nouvel onglet, autre coup) : on ignore.
                if (replyToken !== trainerReplyToken.current) return;
                if (fenRef.current !== replyBaseFen) return;
                applyTrainerOpponentReply(replyBaseFen, opponentOptions, true);
              }, 380);
            } else {
              trainer.completeLine();
            }
          } else {
            trainer.feedbackError(
              playedSan,
              validExpectedMoves[0]?.san || 'aucun coup',
              validExpectedMoves[0]?.uci || '',
              prevNormFen,
            );
            soundFx.playError();
          }
        }
      }

      return true;
    },
    // Dépendances membres (voir applyTrainerOpponentReply) : l'objet
    // `trainer`/`timeline`/`library` entier recréerait le callback (et
    // l'effet Chessground) à chaque rendu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      history,
      currentIndex,
      repertoireIndex,
      timeline.playPhysicalMove,
      activeRepertoire,
      activeStudioTab,
      library.updateActiveRoot,
      trainer.resetForNavigation,
      trainer.feedbackError,
      trainer.feedbackSuccess,
      trainer.hintRevealed,
      trainer.completeLine,
      cancelTrainerReply,
      applyTrainerOpponentReply,
    ],
  );

  const playUciMove = useCallback(
    (uci: string) => {
      // Roque Lichess (e1h1) -> standard (e1g1) pour chess.js
      const stdUci = normalizeCastleUci(fen, uci);
      const from = stdUci.slice(0, 2);
      const to = stdUci.slice(2, 4);
      const promo = stdUci.length > 4 ? stdUci[4] : undefined;
      executeMove(from, to, promo);
    },
    [executeMove, fen],
  );

  // Démarre la prochaine position échue, sinon la prochaine position neuve
  // de la cohorte de découverte active.
  const restartTrainerLine = useCallback(() => {
    if (!activeRepertoire) return;
    cancelAutoRestart();
    const rootFen = activeRepertoire.root?.fen ?? INITIAL_FEN;
    const candidates = [
      ...trainer.reviewSummary.duePositionKeys,
      ...trainer.reviewSummary.newPositionKeys,
    ];
    const pathsByPosition = findUciPathsToPositions(
      activeRepertoire.root,
      candidates,
    );
    const nextPosition = candidates.find((positionKey) => {
      return pathsByPosition.has(positionKey)
        && (repertoireIndex.fenToChildren.get(positionKey)?.length ?? 0) > 0;
    });
    if (nextPosition) {
      const path = pathsByPosition.get(nextPosition);
      if (path) {
        const reviewHistory = buildHistoryFromUciPath(rootFen, path);
        const reviewFen = reviewHistory[reviewHistory.length - 1]?.fen;
        if (reviewFen && normalizeFen(reviewFen) === nextPosition) {
          cancelTrainerReply();
          trainer.resetForNavigation();
          timeline.loadLine(reviewHistory);
          const expectedMoves = repertoireIndex.fenToChildren.get(nextPosition) ?? [];
          trainer.setExpectedMoveSan(expectedMoves[0]?.san ?? '');
          trainer.setExpectedMoveUci(expectedMoves[0]?.uci ?? '');
          return;
        }
      }
    }
    cancelTrainerReply();
    trainer.resetForNavigation();
    trainer.setExpectedMoveSan('');
    trainer.setExpectedMoveUci('');
    trainer.setIsLineFinished(true);
  // Dépendances membres (voir applyTrainerOpponentReply).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRepertoire, repertoireIndex, cancelAutoRestart,
    cancelTrainerReply, timeline.loadLine, trainer.reviewSummary,
    trainer.resetForNavigation, trainer.setExpectedMoveSan, trainer.setExpectedMoveUci,
    trainer.setIsLineFinished,
  ]);

  useEffect(() => {
    if (activeStudioTab === 'trainer' && activeRepertoire) restartTrainerLine();
  // Start at the next due/new position once on entry, not after each review-state update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStudioTab, activeRepertoire?.id]);

  // Enchaînement auto : fin de ligne → nouvelle variante après un court
  // délai (le temps de percevoir le succès), sans écran intermédiaire.
  // Toute navigation / changement d'onglet annule (cleanup + cancel).
  // Cul-de-sac immédiat (skip-once) : l'écran de fin est conservé.
  useEffect(() => {
    if (activeStudioTab !== 'trainer' || !activeRepertoire || !trainer.isLineFinished) return;
    if (trainer.reviewSummary.due === 0 && trainer.reviewSummary.newPositionKeys.length === 0) return;
    if (skipAutoRestartOnce.current) {
      skipAutoRestartOnce.current = false;
      return;
    }
    const token = ++autoRestartToken.current;
    setAutoRestartPending(true);
    autoRestartTimer.current = setTimeout(() => {
      autoRestartTimer.current = null;
      if (token !== autoRestartToken.current) return;
      setAutoRestartPending(false);
      restartTrainerLine();
    }, 1000);
    return () => {
      if (autoRestartTimer.current) {
        clearTimeout(autoRestartTimer.current);
        autoRestartTimer.current = null;
      }
      setAutoRestartPending(false);
    };
  }, [activeStudioTab, activeRepertoire, trainer.isLineFinished, trainer.reviewSummary, restartTrainerLine]);

  // Ajouter un coup (avec ses vraies stats Lichess/moteur) puis le jouer.
  const handleAddAndPlayMove = useCallback((m: LichessMove) => {
    if (activeRepertoire && activeStudioTab === 'builder') {
      const prevNormFen = normalizeFen(fen);
      const pathItems = history.slice(0, currentIndex + 1);
      const child = buildMoveFromLichess(fen, m);
      if (child) {
        library.updateActiveRoot(activeRepertoire.id, (root) => {
          ensurePathAndInsert(root, pathItems, prevNormFen, child);
        });
      }
    }
    playUciMove(m.uci);
  // Dépendance membre (voir applyTrainerOpponentReply).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRepertoire, activeStudioTab, fen, history, currentIndex,
    library.updateActiveRoot, playUciMove,
  ]);

  // Fusion d'un arbre généré automatiquement (BFS) dans le répertoire actif.
  const handleAutoMerge = useCallback(
    async (autoRoot: import('./types/chess').RepertoireRoot) => {
      if (!activeRepertoire) return;
      const saved = await library.updateActiveRoot(activeRepertoire.id, (root) => {
        mergeAutoRoot(root, autoRoot);
      });
      if (saved) toast.success('Arbre automatique fusionné dans le répertoire.');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRepertoire?.id],
  );

  // Déployer en lot les variantes adverses majeures (> 10% d'apparition)
  const handleBatchAddOpponentMoves = useCallback((
    moves: { move: LichessMove; freqPct: number }[],
  ) => {
    if (!activeRepertoire || moves.length === 0) return;
    const prevNormFen = normalizeFen(fen);
    const pathItems = history.slice(0, currentIndex + 1);
    const children = moves
      .map((item) => buildMoveFromLichess(fen, item.move, item.freqPct))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    if (children.length === 0) return;
    library.updateActiveRoot(activeRepertoire.id, (root) => {
      ensurePathAndInsertBatch(root, pathItems, prevNormFen, children);
    });
    toast.success(toastBatchAdded(children.length));
  // Dépendance membre (voir applyTrainerOpponentReply).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRepertoire, fen, history, currentIndex,
    library.updateActiveRoot, toast,
  ]);

  // Autoplay de la ligne principale
  useEffect(() => {
    if (!isMainLinePlaying) return;
    if (candidateMoves.length === 0 || currentIndex >= 60) {
      setIsMainLinePlaying(false);
      return;
    }

    const timer = setTimeout(() => {
      const topMove = candidateMoves[0];
      playUciMove(topMove.uci);
    }, 450);

    return () => clearTimeout(timer);
  }, [isMainLinePlaying, candidateMoves, currentIndex, playUciMove]);

  // Ouverture d'un répertoire depuis la bibliothèque
  const handleOpenRepertoire = (rep: RepertoireItem, initialTab: StudioTab = 'builder') => {
    cancelTrainerReply();
    cancelBlackOpening();
    cancelAutoRestart();
    setGameViewer(null);
    library.setActiveRepertoireId(rep.id);
    setOrientation(rep.color);
    setActiveStudioTab(initialTab);
    setAppView('studio');

    // Réinitialiser le plateau au début
    timeline.reset();
    trainer.resetForNavigation();

    // Si on ouvre en mode entraînement et que le joueur est Noir, les Blancs jouent le 1er coup
    if (initialTab === 'trainer' && rep.color === 'black') {
      const openToken = ++blackOpeningToken.current;
      blackOpeningTimer.current = setTimeout(() => {
        blackOpeningTimer.current = null;
        // Ouverture supplantée (autre répertoire / navigation entre-temps) : on ignore.
        if (openToken !== blackOpeningToken.current) return;
        // L'utilisateur a déjà joué : on n'écrase pas sa ligne.
        if (fenRef.current !== INITIAL_FEN) return;
        const rootOptions =
          indexRepertoire(rep.root).fenToChildren.get(normalizeFen(INITIAL_FEN)) || [];
        if (rootOptions.length > 0) {
          const topMove = rootOptions[0];
          const stdUci = normalizeCastleUci(INITIAL_FEN, topMove.uci);
          try {
            const c = new Chess(INITIAL_FEN);
            const m = c.move({
              from: stdUci.slice(0, 2) as Square,
              to: stdUci.slice(2, 4) as Square,
              promotion: 'q',
            });
            if (m) {
              soundFx.playMove();
              timeline.loadLine([
                { san: '', uci: '', fen: INITIAL_FEN },
                { san: m.san, uci: stdUci, fen: c.fen() },
              ]);
            }
          } catch {
            /* ignore */
          }
        }
      }, 300);
    }
  };

  // Accès direct aux parties Chess.com et à l'analyse libre sans répertoire.
  const handleOpenGames = useCallback(() => {
    cancelTrainerReply();
    cancelBlackOpening();
    cancelAutoRestart();
    setGameViewer(null);
    library.setActiveRepertoireId(null);
    setActiveStudioTab('games');
    setAppView('studio');
    timeline.reset();
    trainer.resetForNavigation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelTrainerReply, cancelBlackOpening, cancelAutoRestart]);

  const handleOpenAnalysis = useCallback(() => {
    cancelTrainerReply();
    cancelBlackOpening();
    cancelAutoRestart();
    setGameViewer(null);
    library.setActiveRepertoireId(null);
    setActiveStudioTab('analysis');
    setAppView('studio');
    setAnalysisPreview(null);
    timeline.reset();
    trainer.resetForNavigation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelTrainerReply, cancelBlackOpening, cancelAutoRestart]);

  // Ouverture d'un répertoire directement sur une ligne de son arbre
  const handleOpenRepertoireAtLine = (rep: RepertoireItem, uciPath: string[]) => {
    cancelTrainerReply();
    cancelBlackOpening();
    cancelAutoRestart();
    setGameViewer(null);
    library.setActiveRepertoireId(rep.id);
    setOrientation(rep.color);
    setActiveStudioTab('builder');
    setAppView('studio');
    timeline.loadLine(buildHistoryFromUciPath(rep.root?.fen || INITIAL_FEN, uciPath));
    trainer.resetForNavigation();
  };

  // Création d'un nouveau répertoire
  const handleCreateRepertoire = (
    title: string,
    color: BoardOrientation,
    targetElo: Parameters<typeof library.createRepertoire>[2],
  ) => {
    const newRep = library.createRepertoire(title, color, targetElo);
    cancelTrainerReply();
    cancelBlackOpening();
    cancelAutoRestart();
    setOrientation(newRep.color);
    setActiveStudioTab('builder');
    setAppView('studio');
    timeline.reset();
    trainer.resetForNavigation();
  };

  // Backfill des noms/ECO d'ouvertures (onglet Arbre) : ne remplit que
  // les champs manquants, via la mutation persistée du répertoire actif.
  const handleEnrichOpenings = useCallback(
    (repId: string, patches: OpeningPatch[]) => {
      if (patches.length === 0) return;
      library.updateActiveRoot(repId, (root) => {
        applyOpeningPatches(root, patches);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library.updateActiveRoot],
  );

  // Changement d'onglet : quitter le trainer annule sa réponse en vol
  // (elle s'appliquerait sinon dans le builder/explorer). Sans répertoire
  // actif, seuls les jeux et l'analyse libre sont accessibles (défense en
  // profondeur : la Sidebar désactive déjà les autres).
  const handleChangeStudioTab = useCallback(
    (tab: StudioTab) => {
      if (!activeRepertoire && tab !== 'games' && tab !== 'analysis') return;
      if (tab !== 'trainer') cancelTrainerReply();
      cancelAutoRestart();
      setActiveStudioTab(tab);
      setAnalysisPreview(null);
    },
    [cancelTrainerReply, cancelAutoRestart, activeRepertoire],
  );

  const handleBackToLibrary = useCallback(() => {
    cancelTrainerReply();
    cancelBlackOpening();
    cancelAutoRestart();
    setGameViewer(null);
    setAppView('library');
    library.setActiveRepertoireId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelTrainerReply, cancelBlackOpening, cancelAutoRestart]);

  // Importation JSON dans la bibliothèque (validée avant insertion).
  const handleImportRepertoire = (content: string, filename: string) => {
    try {
      const { items, warnings } = library.importRepertoire(content, filename);
      const label =
        items.length === 1 ? `« ${items[0].title} »` : `${items.length} répertoires`;
      toast.success(toastImportSuccess(label));
      warnings.slice(0, 2).forEach((w) => toast.error(toastImportPartial(w)));
    } catch (err) {
      toast.error(toastImportError(err instanceof Error ? err.message : String(err)));
    }
  };

  // Copie presse-papiers avec feedback uniforme (l'API Clipboard peut être
  // indisponible hors contexte sécurisé : on l'explicite au lieu d'échouer nu).
  const copyText = (text: string, what: 'FEN' | 'PGN') => {
    if (!navigator.clipboard?.writeText) {
      toast.error(TOAST_COPY_UNAVAILABLE);
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => toast.success(toastCopyOk(what)),
      () => toast.error(TOAST_COPY_UNAVAILABLE),
    );
  };

  // Copie PGN : garde explicite quand aucun coup n'est joué (au lieu
  // de copier une chaîne vide sans retour).
  const copyPgn = (): void => {
    if (history.length <= 1) {
      toast.error(TOAST_PGN_EMPTY);
      return;
    }
    copyText(generatePgn(history.slice(1)), 'PGN');
  };

  // Export PGN / JSON du répertoire actif
  const handleExportPgn = (): void => {
    const pgn = generatePgn(history.slice(1));
    downloadFile(
      `${activeRepertoire?.title || 'repertoire'}.pgn`,
      pgn || '[Event "Repertoire"]\n*',
    );
  };

  const handleExportJson = () => {
    if (!activeRepertoire) return;
    downloadFile(
      `${activeRepertoire.title.toLowerCase().replace(/\s+/g, '_')}.json`,
      JSON.stringify(activeRepertoire.root, null, 2),
      'application/json',
    );
  };

  // Est-ce le tour de l'adversaire dans le répertoire actif ?
  // (lu depuis le FEN, pas depuis une instance Chess mutable)
  const isOpponentTurn = useMemo(() => {
    if (!activeRepertoire) return false;
    const turn = turnOfFen(fen);
    return (
      (activeRepertoire.color === 'white' && turn === 'b') ||
      (activeRepertoire.color === 'black' && turn === 'w')
    );
  }, [activeRepertoire, fen]);

  // Flèche de correction en mode entraînement : le coup attendu est dessiné
  // sur l'échiquier — immédiatement après une erreur, ou à la demande via
  // le bouton « Indice ». Repli SAN→UCI si l'UCI mémorisé manque.
  const correctionShapes = useMemo(() => {
    if (activeStudioTab !== 'trainer' || !activeRepertoire) return undefined;
    const showOnError = trainer.lastSuccess === false;
    const showOnHint =
      trainer.hintRevealed && trainer.expectedMoveSan && trainer.lastSuccess === null;
    if (!showOnError && !showOnHint) return undefined;
    let uci = trainer.expectedMoveUci;
    if (!uci && trainer.expectedMoveSan) {
      try {
        const probe = new Chess(fen);
        const m = probe.move(trainer.expectedMoveSan);
        if (m) uci = `${m.from}${m.to}${m.promotion || ''}`;
      } catch {
        uci = '';
      }
    }
    if (!uci || uci.length < 4) return undefined;
    return [{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'green' }];
  }, [
    activeStudioTab,
    activeRepertoire,
    trainer.lastSuccess,
    trainer.hintRevealed,
    trainer.expectedMoveSan,
    trainer.expectedMoveUci,
    fen,
  ]);

  // Flèches tactiques du dernier coup : seules les conséquences de la
  // pièce arrivée sont montrées (attaques rouges, défenses vertes,
  // clouages jaunes, fourchettes bleues). Analysées du côté de l'auteur
  // du coup (l'adversaire a le trait après).
  const tacticsFiltered = useMemo(() => {
    // Pendant l'animation de génération, le plateau montre la position
    // explorée, pas la timeline : les flèches tactiques (calculées sur la
    // timeline) seraient hors sujet — seules les flèches moteur restent.
    if (autoGenPreview) return null;
    if (!showTactics) return null;
    const last = preview.displayLastMove;
    if (!last) return null;
    const moved = last[1];
    const mover = turnOfFen(preview.displayFen) === 'w' ? 'b' : 'w';
    return {
      moved,
      report: filterReportForMove(detectTactics(preview.displayFen, mover), moved),
    };
  }, [showTactics, autoGenPreview, preview.displayFen, preview.displayLastMove]);
  const tacticShapes = useMemo(() => {
    if (!tacticsFiltered) return [];
    return tacticsToShapes(tacticsFiltered.report, tacticsFiltered.moved, tacticFilter);
  }, [tacticsFiltered, tacticFilter]);
  const boardShapes = useMemo(
    () => [...(correctionShapes ?? []), ...tacticShapes, ...(autoGenArrows ?? []), ...analysisArrows],
    [correctionShapes, tacticShapes, autoGenArrows, analysisArrows],
  );

  return (
    <div className="app-layout" data-piece-skin={pieceSkin}>
      {/* Barre latérale : navigation toujours visible (fini le bandeau haut) */}
      <Sidebar
        activeView={appView}
        activeRepertoire={activeRepertoire}
        onBackToLibrary={handleBackToLibrary}
        onOpenGames={handleOpenGames}
        onOpenAnalysis={handleOpenAnalysis}
        activeStudioTab={activeStudioTab}
        onChangeStudioTab={handleChangeStudioTab}
        repertoireStats={activeRepertoire ? {
          totalPositions: repertoireIndex.totalPositions,
          maxDepth: repertoireIndex.maxDepth,
          totalLines: repertoireIndex.totalLines,
        } : undefined}
        onExportJson={handleExportJson}
        onExportPgn={handleExportPgn}
        account={chessAccount}
        pieceSkin={pieceSkin}
        onPieceSkinChange={handlePieceSkinChange}
      />

      <div className="app-main">
      {/* VUE 1 : LA BIBLIOTHÈQUE DE RÉPERTOIRES (Interface d'accueil principale) */}
      {appView === 'library' && (
        <RepertoireLibrary
          repertoires={library.repertoires}
          onOpenRepertoire={handleOpenRepertoire}
          onOpenGames={handleOpenGames}
          onCreateRepertoire={handleCreateRepertoire}
          onDeleteRepertoire={library.deleteRepertoire}
          onImportRepertoire={handleImportRepertoire}
        />
      )}

      {/* VUE 2 : LE STUDIO D'ÉTUDE & DE CONSTRUCTION (les onglets jeux et
          analyse vivent aussi sans répertoire actif).
          En jeux sans partie ouverte, pas d'échiquier : le panneau occupe
          toute la largeur. Idem pour l'onglet arbre : le graphe a son propre
          visualiseur, l'échiquier principal est redondant. */}
      {appView === 'studio' && (activeRepertoire || activeStudioTab === 'games' || activeStudioTab === 'analysis') && (
        <main className={`main-content-container ${activeStudioTab === 'games' && !gameViewer ? 'no-board' : ''} ${activeStudioTab === 'tree' ? 'no-board tree-tab' : ''} ${isGameViewer ? 'game-viewer' : ''}`}>
          {/* Colonne gauche : Échiquier Chessground (masquée en jeux tant
              qu'aucune partie n'est ouverte, et dans l'onglet arbre) */}
          {!(activeStudioTab === 'games' && !gameViewer) && activeStudioTab !== 'tree' && (
          <section className="board-column">
            {/* Visionneuse Mes parties : barre Stockfish à gauche de l'échiquier. */}
            {activeStudioTab === 'games' && gameViewer ? (
              <div className="board-with-eval">
                <EvalBar fen={preview.displayFen} />
                <div className="board-with-eval-main">
                  <Chessboard
                    fen={preview.displayFen}
                    orientation={orientation}
                    onMove={executeMove}
                    lastMove={preview.displayLastMove}
                    shapes={tacticShapes}
                  />
                </div>
              </div>
            ) : (
              <Chessboard
                fen={activeStudioTab === 'analysis' ? (analysisPreview?.rootFen === fen ? analysisPreview.fen : fen) : boardFen}
                orientation={orientation}
                onMove={executeMove}
                lastMove={activeStudioTab === 'analysis'
                  ? (analysisPreview?.rootFen === fen ? analysisPreview.lastMove : timeline.lastMove)
                  : boardLastMove}
                interactive={activeStudioTab === 'analysis'
                  ? analysisPreview?.rootFen !== fen
                  : activeStudioTab !== 'trainer' || !isOpponentTurn}
                shapes={boardShapes}
              />
            )}
            {/* Contrôles de la partie visionnée : sous le plateau, ils
                suivent le scroll avec lui (colonne sticky). */}
            {activeStudioTab === 'games' && gameViewer && (
              <div className="game-viewer-bar" role="toolbar" aria-label="Navigation de la partie visionnée">
                <button className="icon-btn" onClick={() => goToViewerPly(0)} disabled={gameViewer.ply === 0} title="Début de la partie">
                  <ChevronsLeft size={15} />
                </button>
                <button className="icon-btn" onClick={() => goToViewerPly(gameViewer.ply - 1)} disabled={gameViewer.ply === 0} title="Coup précédent (←)">
                  <ChevronLeft size={15} />
                </button>
                <span className="chesscom-ply-label" title="Numéro de ply">
                  {gameViewer.ply}/{gameViewer.sans.length}
                </span>
                <button className="icon-btn" onClick={() => goToViewerPly(gameViewer.ply + 1)} disabled={gameViewer.ply === gameViewer.sans.length} title="Coup suivant (→)">
                  <ChevronRight size={15} />
                </button>
                <button className="icon-btn" onClick={() => goToViewerPly(gameViewer.sans.length)} disabled={gameViewer.ply === gameViewer.sans.length} title="Fin de la partie">
                  <ChevronsRight size={15} />
                </button>
                <button className="icon-btn" onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))} title="Retourner l'échiquier">
                  <Repeat size={14} />
                </button>
                <button className="icon-btn" onClick={closeGameViewer} title="Fermer la visionneuse (Échap)">
                  <X size={15} />
                </button>
              </div>
            )}
            {/* Bandeau de statut unifié : visible dans TOUS les onglets
                avec répertoire (masqué en mode jeux-sans-répertoire : le
                « Hors répertoire » serait du bruit).
                (Les mêmes états existaient éparpillés par panneau.) */}
            {activeRepertoire && activeStudioTab !== 'analysis' && (
            <div className="board-status-strip" role="status">
              {candidateMoves.length > 0 ? (
                <span className="badge badge-success">
                  <CheckCircle2 size={14} />
                  Dans le répertoire · {candidateMoves.length} suite(s)
                </span>
              ) : isInRepertoire ? (
                <span className="badge badge-success">
                  <CheckCircle2 size={14} />
                  Fin de ligne théorique
                </span>
              ) : (
                <span className="badge badge-warning">
                  <AlertCircle size={14} />
                  Hors répertoire
                </span>
              )}
              {preview.previewData && (
                <span
                  className="badge badge-preview"
                  title="Aperçu temporaire : survolez ailleurs pour revenir à la position réelle"
                >
                  <Eye size={14} />
                  Aperçu actif : {preview.previewData.san}
                </span>
              )}
            </div>
            )}
            <div className="fen-footer-display">
              <span className="fen-label" title={fen}>Position</span>
              <button className="icon-btn" onClick={() => copyText(fen, 'FEN')} title="Copier le FEN">
                <Copy size={13} />
                <span>FEN</span>
              </button>
              <button className="icon-btn" onClick={copyPgn} title="Copier le PGN">
                <Copy size={13} />
                <span>PGN</span>
              </button>
              <button
                className={`icon-btn ${showTactics ? 'active-toggle' : ''}`}
                onClick={() => setShowTactics((v) => !v)}
                title={showTactics ? 'Masquer les flèches tactiques' : 'Flèches tactiques du dernier coup (attaques, défenses, clouages, fourchettes)'}
                aria-pressed={showTactics}
              >
                <Eye size={13} />
                <span>Motifs</span>
              </button>
            </div>
            {showTactics && (
              tacticsFiltered ? (
              <div className="tac-legend" role="toolbar" aria-label="Filtres des motifs tactiques">
                {(
                  [
                    { key: 'attack', label: 'Attaques', count: tacticsFiltered.report.attacks.length },
                    { key: 'defense', label: 'Défenses', count: tacticsFiltered.report.defenses.length },
                    { key: 'pin', label: 'Clouages', count: tacticsFiltered.report.pins.length },
                    { key: 'fork', label: 'Fourchettes', count: tacticsFiltered.report.forks.length },
                  ] as { key: TacticsMotif; label: string; count: number }[]
                ).map(({ key, label, count }) => (
                  <button
                    key={key}
                    className={`tac-pill tac-pill-${key} ${tacticFilter[key] ? '' : 'off'}`}
                    onClick={() => setTacticFilter((f) => ({ ...f, [key]: !f[key] }))}
                    title={`Afficher/masquer : ${label.toLowerCase()}`}
                    aria-pressed={tacticFilter[key]}
                  >
                    <span className={`tac-dot tac-dot-${key}`} aria-hidden="true" />
                    <span>{label}</span>
                    <span className="tac-count">{count}</span>
                  </button>
                ))}
              </div>
              ) : (
                <div className="tac-legend">
                  <span className="tac-side-note">Jouez un coup pour révéler ses attaques, défenses, clouages et fourchettes.</span>
                </div>
              )
            )}
          </section>
          )}

          {/* Colonne droite : Onglet actif */}
          <section className="panel-column">
            {activeStudioTab === 'builder' && activeRepertoire && (
              <RepertoireBuilder
                repertoire={activeRepertoire}
                currentFen={fen}
                isOpponentTurn={isOpponentTurn}
                registeredMoves={candidateMoves}
                onPlayMove={playUciMove}
                onAddAndPlayMove={handleAddAndPlayMove}
                onBatchAddOpponentMoves={handleBatchAddOpponentMoves}
                onGoBack={() => jumpToMove(currentIndex - 1)}
                canGoBack={currentIndex > 0}
                onHoverMove={preview.handleHoverMove}
                onBackToStart={handleBackToStart}
                onAutoMerge={handleAutoMerge}
                onAutoPreviewMove={handleAutoPreviewMove}
                onAutoEngineArrows={handleAutoEngineArrows}
              />
            )}

            {activeStudioTab === 'explorer' && (
              <ExplorerPanel
                currentFen={fen}
                candidateMoves={candidateMoves}
                history={history}
                currentIndex={currentIndex}
                onSelectCandidateMove={(m) => playUciMove(m.uci)}
                onHoverMove={preview.handleHoverMove}
                onJumpToMove={jumpToMove}
                onGoStart={() => jumpToMove(0)}
                onGoBack={() => jumpToMove(currentIndex - 1)}
                onGoForward={() => jumpToMove(currentIndex + 1)}
                onGoEnd={() => jumpToMove(history.length - 1)}
                onPlayMainLine={() => setIsMainLinePlaying((p) => !p)}
                onFlipBoard={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
                isInRepertoire={isInRepertoire}
                isMainLinePlaying={isMainLinePlaying}
              />
            )}

            {activeStudioTab === 'tree' && activeRepertoire && (
              <RepertoireGraphTree
                repertoire={activeRepertoire}
                onOpenLine={handleOpenRepertoireAtLine}
                onDeleteMove={library.deleteRepertoireMove}
                onEnrichOpenings={handleEnrichOpenings}
              />
            )}

            {activeStudioTab === 'trainer' && activeRepertoire && (              <TrainerPanel
                colorToTrain={activeRepertoire.color}
                isMyTurn={!isOpponentTurn}
                lastTrainedMoveSuccess={trainer.lastSuccess}
                expectedMoveSan={trainer.expectedMoveSan}
                userPlayedSan={trainer.userPlayedSan}
                stats={trainer.stats}
                reviewSummary={trainer.reviewSummary}
                canContinueTraining={
                  trainer.reviewSummary.due > 0
                  || trainer.reviewSummary.newPositionKeys.length > 0
                }
                onResetStats={trainer.resetStats}
                onRestartLine={restartTrainerLine}
                onShowHint={trainer.showHint}
                hintRevealed={trainer.hintRevealed}
                isLineFinished={trainer.isLineFinished}
                autoRestartPending={autoRestartPending}
              />
            )}

            {activeStudioTab === 'live' && (
              <LichessLivePanel
                currentFen={fen}
                candidateUcis={new Set(candidateMoves.map((move) => normalizeCastleUci(fen, move.uci)))}
                onPlayMoveFromLichess={(m) => playUciMove(m.uci)}
                onAddMoveToRepertoire={handleAddAndPlayMove}
                onHoverMove={preview.handleHoverMove}
              />
            )}

            {activeStudioTab === 'games' && (
              <ChesscomPanel
                account={chessAccount}
                viewer={gameViewer}
                onOpenGame={openGameViewer}
                onGoToPly={goToViewerPly}
                onCloseViewer={closeGameViewer}
                onUpdateGameAccuracy={chessAccount.updateGameAccuracy}
                onUpdateGameAnalysis={chessAccount.updateGameAnalysis}
                repertoires={library.repertoires}
              />
            )}

            {activeStudioTab === 'analysis' && (
              <AnalysisPanel
                currentFen={fen}
                history={history}
                currentIndex={currentIndex}
                onJumpToMove={jumpToMove}
                onShapesChange={handleAnalysisArrows}
                onPreviewChange={handleAnalysisPreview}
              />
            )}
          </section>
        </main>
      )}
      </div>
    </div>
  );
};

export default App;
