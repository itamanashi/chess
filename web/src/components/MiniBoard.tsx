import React, { useMemo } from 'react';
import { Chess } from 'chess.js';
import { INITIAL_FEN } from '../utils/repertoire';

const PIECE_CLASSES: Record<'k' | 'q' | 'r' | 'b' | 'n' | 'p', string> = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

/**
 * Joue une variante SAN depuis la position initiale (retourne `null` si un
 * coup est illégal). Sert aux prévisualisations (survol des ouvertures).
 */
export function fenAfterSans(sans: string[]): string | null {
  if (sans.length === 0) return null;
  try {
    const c = new Chess(INITIAL_FEN);
    for (const san of sans) c.move(san);
    return c.fen();
  } catch {
    return null;
  }
}

interface MiniBoardProps {
  fen: string;
  orientation?: 'w' | 'b';
}

/**
 * Mini-échiquier statique avec pièces Chessground, sans instance Chessground.
 */
export const MiniBoard: React.FC<MiniBoardProps> = ({ fen, orientation = 'w' }) => {
  const rows = useMemo(() => {
    try {
      const board = new Chess(fen).board(); // board[0] = rangée 8
      const grid: Array<{ pieceClass: string; light: boolean }> = [];
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const rankIdx = orientation === 'w' ? 7 - r : r;
          const fileIdx = orientation === 'w' ? f : 7 - f;
          const sq = board[7 - rankIdx][fileIdx];
          grid.push({
            pieceClass: sq ? `${sq.color === 'w' ? 'white' : 'black'} ${PIECE_CLASSES[sq.type]}` : '',
            light: (rankIdx + fileIdx) % 2 === 1,
          });
        }
      }
      return grid;
    } catch {
      return null;
    }
  }, [fen, orientation]);

  if (!rows) return null;
  return (
    <div className="miniboard cg-wrap" role="img" aria-label={`Position : ${fen}`}>
      {rows.map((sq, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i} className={`miniboard-sq ${sq.light ? 'is-light' : 'is-dark'}`}>
          {sq.pieceClass && React.createElement('piece', { className: sq.pieceClass, 'aria-hidden': true })}
        </span>
      ))}
    </div>
  );
};
