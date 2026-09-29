import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { normalizeCastleUci } from '../utils/repertoire';

/**
 * Aperçu temporaire au survol d'une proposition : calcule le FEN résultant
 * sans toucher à la timeline. Annulé dès que le vrai FEN change.
 */
export function useHoverPreview(fen: string, lastMove: [string, string] | undefined) {
  const [previewUci, setPreviewUci] = useState<string | null>(null);

  useEffect(() => {
    setPreviewUci(null);
  }, [fen]);

  const handleHoverMove = useCallback((uci: string | null) => {
    setPreviewUci(uci);
  }, []);

  const previewData = useMemo(() => {
    if (!previewUci || previewUci.length < 4) return null;
    try {
      const stdUci = normalizeCastleUci(fen, previewUci);
      const c = new Chess(fen);
      const m = c.move({
        from: stdUci.slice(0, 2) as Square,
        to: stdUci.slice(2, 4) as Square,
        promotion: (stdUci.length > 4 ? stdUci[4] : 'q') as 'q' | 'r' | 'b' | 'n',
      });
      if (!m) return null;
      return {
        fen: c.fen(),
        lastMove: [stdUci.slice(0, 2), stdUci.slice(2, 4)] as [string, string],
        san: m.san,
      };
    } catch {
      return null;
    }
  }, [fen, previewUci]);

  return {
    previewUci,
    previewData,
    displayFen: previewData?.fen ?? fen,
    displayLastMove: previewData?.lastMove ?? lastMove,
    handleHoverMove,
  };
}

export type HoverPreview = ReturnType<typeof useHoverPreview>;
