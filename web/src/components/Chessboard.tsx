import React, { useEffect, useId, useRef, useState, useCallback, useMemo } from 'react';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Key } from 'chessground/types';
import { Chess, type Square } from 'chess.js';
import type { BoardOrientation } from '../types/chess';
import { soundFx } from '../utils/audio';
import {
  ARROWHEAD,
  ARROW_OPACITY,
  ARROW_WIDTH,
  BRUSH_COLORS,
  brushColor,
  knightArrowPath,
  splitBoardShapes,
} from '../utils/knightArrows';

// Importer les styles officiels de Chessground
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';

interface ChessboardProps {
  fen: string;
  orientation: BoardOrientation;
  onMove: (from: string, to: string, promotion?: string) => boolean;
  lastMove?: [string, string];
  interactive?: boolean;
  shapes?: any[];
}

interface PendingPromotion {
  from: string;
  to: string;
  /** Couleur du pion qui promeut (jamais l'orientation du plateau). */
  color: 'w' | 'b';
}

export const Chessboard: React.FC<ChessboardProps> = ({
  fen,
  orientation,
  onMove,
  lastMove,
  interactive = true,
  shapes = [],
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cgRef = useRef<Api | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const overlayUid = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  // Les bonds de cavalier partent en calque SVG (coudes en L) : Chessground
  // ne trace que du droit. Le reste (droites, cercles) reste chez lui.
  const splitShapes = useMemo(() => splitBoardShapes(shapes ?? []), [shapes]);
  const knightOverlay = useMemo(
    () =>
      splitShapes.knight.map((s) => {
        const brush = s.brush && BRUSH_COLORS[s.brush] ? s.brush : 'fallback';
        return {
          d: knightArrowPath(s.orig as string, s.dest as string, orientation),
          color: brushColor(s.brush),
          marker: `ka-${overlayUid}-${brush}`,
        };
      }),
    [splitShapes, orientation, overlayUid],
  );
  const knightMarkers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const k of knightOverlay) {
      if (!seen.has(k.marker)) seen.set(k.marker, k.color);
    }
    return [...seen.entries()];
  }, [knightOverlay]);

  // Calcule les destinations légales pour chaque case à partir du FEN
  const computeDests = useCallback((currentFen: string): Map<Key, Key[]> => {
    const dests = new Map<Key, Key[]>();
    if (!interactive) return dests;

    try {
      const chess = new Chess(currentFen);
      const moves = chess.moves({ verbose: true });
      for (const m of moves) {
        const from = m.from as Key;
        const to = m.to as Key;
        if (!dests.has(from)) {
          dests.set(from, []);
        }
        dests.get(from)!.push(to);
      }
    } catch {
      // Ignore les FEN invalides temporaires
    }
    return dests;
  }, [interactive]);

  // Initialisation et mise à jour de l'échiquier Chessground
  useEffect(() => {
    if (!containerRef.current) return;

    const chess = new Chess(fen);
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    const check = chess.inCheck();

    const config: Config = {
      fen: fen,
      orientation: orientation,
      turnColor: turn,
      check: check,
      lastMove: lastMove ? [lastMove[0] as Key, lastMove[1] as Key] : undefined,
      coordinates: true,
      autoCastle: true,
      animation: {
        enabled: true,
        duration: 220,
      },
      movable: {
        free: false,
        color: interactive ? turn : undefined,
        dests: computeDests(fen),
        events: {
          after: (orig: Key, dest: Key) => {
            // Vérifier si c'est une promotion de pion
            const piece = chess.get(orig as Square);
            const isPawn = piece && piece.type === 'p';
            const isPromotionRank = (piece?.color === 'w' && dest[1] === '8') || 
                                   (piece?.color === 'b' && dest[1] === '1');

            if (isPawn && isPromotionRank && piece) {
              // Ouvrir le dialogue de promotion (couleur = le pion, pas l'orientation)
              setPendingPromotion({ from: orig, to: dest, color: piece.color });
              return;
            }

            // Coup régulier
            const isCapture = !!chess.get(dest as Square) || 
              (isPawn && orig[0] !== dest[0]);

            const moveSuccess = onMove(orig, dest);
            if (moveSuccess) {
              const testChess = new Chess(fen);
              try {
                testChess.move({ from: orig, to: dest });
                if (testChess.inCheck()) {
                  soundFx.playCheck();
                } else if (isCapture) {
                  soundFx.playCapture();
                } else {
                  soundFx.playMove();
                }
              } catch {
                soundFx.playMove();
              }
            } else {
              // Réinitialiser le plateau si coup invalide
              if (cgRef.current) {
                cgRef.current.set({ fen });
              }
            }
          },
        },
      },
      drawable: {
        enabled: true,
        visible: true,
        shapes: splitShapes.straight,
      },
    };

    if (!cgRef.current) {
      cgRef.current = Chessground(containerRef.current, config);
    } else {
      cgRef.current.set(config);
    }
  }, [fen, orientation, interactive, computeDests, lastMove, splitShapes, onMove]);

  // Écouter le redimensionnement de la fenêtre pour ajuster Chessground
  useEffect(() => {
    const handleResize = () => {
      if (cgRef.current && containerRef.current) {
        cgRef.current.redrawAll();
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Validation d'une sous-promotion choisie dans le modal
  const handleSelectPromotion = (piece: 'q' | 'r' | 'b' | 'n') => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    setPendingPromotion(null);

    const chess = new Chess(fen);
    const isCapture = !!chess.get(to as Square);

    const moveSuccess = onMove(from, to, piece);
    if (moveSuccess) {
      const testChess = new Chess(fen);
      try {
        testChess.move({ from, to, promotion: piece });
        if (testChess.inCheck()) {
          soundFx.playCheck();
        } else if (isCapture) {
          soundFx.playCapture();
        } else {
          soundFx.playMove();
        }
      } catch {
        soundFx.playMove();
      }
    } else if (cgRef.current) {
      cgRef.current.set({ fen });
    }
  };

  const promoColor = pendingPromotion?.color ?? (orientation === 'white' ? 'w' : 'b');

  return (
    <div className="chessboard-wrapper">
      <div className="chessboard-container" ref={containerRef} />
      {/* Coudes en L des cavaliers (Chessground = droit uniquement).
          Calque passif : la souris traverse (drag & drop intact). */}
      {knightOverlay.length > 0 && (
        <svg className="knight-arrows-layer" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
          <defs>
            {knightMarkers.map(([id, color]) => (
              // Tête identique à Chessground (cf. ARROWHEAD) : le bout rond
              // du trait reste caché sous le triangle, même opacité (1).
              <marker
                key={id}
                id={id}
                markerWidth={ARROWHEAD.width}
                markerHeight={ARROWHEAD.height}
                refX={ARROWHEAD.refX}
                refY={ARROWHEAD.refY}
                orient="auto"
                markerUnits="strokeWidth"
                overflow="visible"
              >
                <path d={ARROWHEAD.d} fill={color} />
              </marker>
            ))}
          </defs>
          {knightOverlay.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth={ARROW_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={ARROW_OPACITY}
              markerEnd={`url(#${s.marker})`}
            />
          ))}
        </svg>
      )}

      {/* Modal de promotion de pion */}
      {pendingPromotion && (
        <div
          className="promotion-modal-backdrop"
          onClick={() => {
            setPendingPromotion(null);
            if (cgRef.current) cgRef.current.set({ fen });
          }}
        >
          <div
            className="promotion-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Promotion du pion"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setPendingPromotion(null);
                if (cgRef.current) cgRef.current.set({ fen });
              }
            }}
          >
            <h2 className="confirm-title">Promotion du pion</h2>
            <div className="promotion-pieces">
              <button 
                className="promo-btn" 
                onClick={() => handleSelectPromotion('q')} 
                title="Dame (Recommandé)"
                autoFocus
              >
                <span className="promo-symbol">{promoColor === 'w' ? '♕' : '♛'}</span>
                <span>Dame</span>
              </button>
              <button 
                className="promo-btn" 
                onClick={() => handleSelectPromotion('n')} 
                title="Cavalier"
              >
                <span className="promo-symbol">{promoColor === 'w' ? '♘' : '♞'}</span>
                <span>Cavalier</span>
              </button>
              <button 
                className="promo-btn" 
                onClick={() => handleSelectPromotion('r')} 
                title="Tour"
              >
                <span className="promo-symbol">{promoColor === 'w' ? '♖' : '♜'}</span>
                <span>Tour</span>
              </button>
              <button 
                className="promo-btn" 
                onClick={() => handleSelectPromotion('b')} 
                title="Fou"
              >
                <span className="promo-symbol">{promoColor === 'w' ? '♗' : '♝'}</span>
                <span>Fou</span>
              </button>
            </div>
            <button 
              className="promo-cancel-btn" 
              onClick={() => {
                setPendingPromotion(null);
                if (cgRef.current) cgRef.current.set({ fen });
              }}
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
