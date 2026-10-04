import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearCachedGames,
  fetchAllGames,
  fetchPlayer,
  getCachedGames,
  normalizeUsername,
  patchCachedGame,
  type ChesscomGame,
  type ChesscomProfile,
} from '../services/chesscom';
import type { GameReport } from '../utils/accuracy';
import { isAbortError } from '../utils/async';
import { chesscomAccuracyStore, chesscomStore } from '../storage/preferences';
import { forkCountsFromArrays, forkCountsToArrays, freebieCountsFromArrays, freebieCountsToArrays, hungCountsFromArray, hungCountsToArray, mateCountsFromArrays, mateCountsToArrays, moveQualityFromArrays, moveQualityToArrays, pieceStatsFromArrays, pieceStatsToArrays, pinCountsFromArrays, pinCountsToArrays, type ForkCounts, type FreebieCounts, type GameShape, type HungCounts, type MateCounts, type MoveQualityCounts, type PieceStats, type PinCounts } from '../services/chesscom';

export interface ChesscomSyncProgress {
  done: number;
  total: number;
}

export interface ChesscomAccount {
  username: string;
  setUsername: (v: string) => void;
  linkedUser: string;
  profile: ChesscomProfile | null;
  games: ChesscomGame[];
  failedArchives: number;
  syncing: boolean;
  progress: ChesscomSyncProgress;
  error: string | null;
  startSync: (rawUser: string) => Promise<void>;
  handleUnlink: () => void;
  cancelSync: () => void;
  /**
   * Stocke le résultat d'analyse d'une partie (précisions W/B + précision
   * du compte lié + forme narrative + rapport éventuel). Le rapport complet
   * n'est conservé que pour l'analyse détaillée (visionneuse), pas pour le
   * batch. Précisions + forme sont persistées (localStorage léger).
   */
  updateGameAnalysis: (url: string, patch: {
    accuracy: number | null;
    whiteAccuracy: number | null;
    blackAccuracy: number | null;
    acpl?: number | null;
    shape?: GameShape | null;
    forks?: ForkCounts | null;
    pins?: PinCounts | null;
    mates?: MateCounts | null;
    hangs?: HungCounts | null;
    freebies?: FreebieCounts | null;
    moveQuality?: MoveQualityCounts | null;
    pieces?: PieceStats | null;
    gameReport?: GameReport | null;
  }) => void;
  /** Compat historique (batch simple) : ne touche qu'au badge. */
  updateGameAccuracy: (url: string, accuracy: number) => void;
}

/**
 * État du compte Chess.com partagé entre la sidebar (carte compte :
 * lier, actualiser, dissocier, progression) et le panneau jeux (liste,
 * ouvertures, visionneuse). Instance UNIQUE montée dans App.
 *
 * `onAccountReset` (fermeture de la visionneuse) est appelé quand le
 * périmètre change (nouvelle synchro, dissociation).
 */
export function useChesscomAccount(opts: { onAccountReset: () => void }): ChesscomAccount {
  const { onAccountReset } = opts;
  const [username, setUsername] = useState(() => chesscomStore.get());
  const [linkedUser, setLinkedUser] = useState(() => chesscomStore.get());
  // Profil restauré du store (photo incluse) : visible même sans resynchro
  // (jeux restaurés du cache de session). Écrasé par le profil frais sync.
  const [profile, setProfile] = useState<ChesscomProfile | null>(() => {
    const storedUser = chesscomStore.get();
    if (!storedUser) return null;
    const storedAvatar = chesscomStore.getAvatar();
    return { username: storedUser, ...(storedAvatar ? { avatar: storedAvatar } : {}) };
  });
  const [games, setGames] = useState<ChesscomGame[]>(() => {
    const user = chesscomStore.get();
    const cached = getCachedGames(user)?.games ?? [];
    if (cached.length === 0) return cached;
    const acc = chesscomAccuracyStore.get(user);
    if (Object.keys(acc).length === 0) return cached;
    return cached.map((g) => {
      const s = acc[g.url];
            return s ? { ...g, accuracy: s.a, whiteAccuracy: s.w, blackAccuracy: s.b, acpl: s.c ?? null, shape: s.s ?? null, forks: s.ff || s.fm ? forkCountsFromArrays(s.ff, s.fm) : null, pins: s.pf || s.pm ? pinCountsFromArrays(s.pf, s.pm) : null, mates: s.mf || s.mm ? mateCountsFromArrays(s.mf, s.mm) : null, hangs: s.hg ? hungCountsFromArray(s.hg) : null, freebies: s.gf || s.gm ? freebieCountsFromArrays(s.gf, s.gm) : null, moveQuality: s.q || s.qw || s.qb ? moveQualityFromArrays(s.q, s.qw, s.qb) : null, pieces: s.pc ? pieceStatsFromArrays(s.pc, s.pa) : null } : g;
    });
  });
  const [failedArchives, setFailedArchives] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<ChesscomSyncProgress>({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const syncAbort = useRef<AbortController | null>(null);
  const syncSeq = useRef(0);

  const cancelSync = useCallback(() => {
    syncSeq.current++;
    syncAbort.current?.abort();
    syncAbort.current = null;
  }, []);

  useEffect(() => {
    return () => cancelSync();
  }, [cancelSync]);

  const startSync = useCallback(
    async (rawUser: string) => {
      const user = normalizeUsername(rawUser);
      if (!user) return;
      const id = ++syncSeq.current;
      syncAbort.current?.abort();
      const ctrl = new AbortController();
      syncAbort.current = ctrl;
      setSyncing(true);
      setError(null);
      onAccountReset();
      setProgress({ done: 0, total: 0 });
      try {
        // Le profil valide l'existence du compte (404 → message dédié).
        const prof = await fetchPlayer(user, { signal: ctrl.signal });
        if (syncSeq.current !== id || ctrl.signal.aborted) return;
        setProfile(prof);
        setLinkedUser(user);
        chesscomStore.set(user, prof.avatar);
        const res = await fetchAllGames(user, {
          signal: ctrl.signal,
          onProgress: (p) => {
            if (syncSeq.current === id) setProgress({ done: p.doneArchives, total: p.totalArchives });
          },
        });
        if (syncSeq.current !== id || ctrl.signal.aborted) return;
        const acc = chesscomAccuracyStore.get(user);
        const merged = Object.keys(acc).length === 0
          ? res.games
          : res.games.map((g) => {
            const s = acc[g.url];
      return s ? { ...g, accuracy: s.a, whiteAccuracy: s.w, blackAccuracy: s.b, acpl: s.c ?? null, shape: s.s ?? null, forks: s.ff || s.fm ? forkCountsFromArrays(s.ff, s.fm) : null, pins: s.pf || s.pm ? pinCountsFromArrays(s.pf, s.pm) : null, mates: s.mf || s.mm ? mateCountsFromArrays(s.mf, s.mm) : null, hangs: s.hg ? hungCountsFromArray(s.hg) : null, freebies: s.gf || s.gm ? freebieCountsFromArrays(s.gf, s.gm) : null, moveQuality: s.q || s.qw || s.qb ? moveQualityFromArrays(s.q, s.qw, s.qb) : null, pieces: s.pc ? pieceStatsFromArrays(s.pc, s.pa) : null } : g;
          });
        setGames(merged);
        setFailedArchives(res.archivesFailed);
      } catch (err) {
        if (isAbortError(err) || syncSeq.current !== id) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (syncSeq.current === id) {
          setSyncing(false);
          syncAbort.current = null;
        }
      }
    },
    [onAccountReset],
  );

  // Restauration : cache de session d'abord, sinon synchro auto du compte lié.
  useEffect(() => {
    if (!linkedUser || games.length > 0 || syncing) return;
    void startSync(linkedUser);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUnlink = useCallback(() => {
    cancelSync();
    clearCachedGames(linkedUser || undefined);
    chesscomStore.clear();
    setLinkedUser('');
    setUsername('');
    setProfile(null);
    setGames([]);
    setFailedArchives(0);
    setError(null);
    onAccountReset();
  }, [cancelSync, linkedUser, onAccountReset]);

  const updateGameAnalysis = useCallback((url: string, patch: {
    accuracy: number | null;
    whiteAccuracy: number | null;
    blackAccuracy: number | null;
    acpl?: number | null;
    shape?: GameShape | null;
    forks?: ForkCounts | null;
    pins?: PinCounts | null;
    mates?: MateCounts | null;
    hangs?: HungCounts | null;
    freebies?: FreebieCounts | null;
    moveQuality?: MoveQualityCounts | null;
    pieces?: PieceStats | null;
    gameReport?: GameReport | null;
  }) => {
    const user = linkedUser || chesscomStore.get();
    // Persisté : nombres + ACPL + forme + tactique + qualité + pièces (rapport en session).
    const stored = {
      a: patch.accuracy,
      w: patch.whiteAccuracy,
      b: patch.blackAccuracy,
      ...(patch.acpl !== undefined ? { c: patch.acpl } : {}),
      ...(patch.shape !== undefined ? { s: patch.shape } : {}),
      ...(patch.forks ? forkCountsToArrays(patch.forks) : {}),
      ...(patch.pins ? pinCountsToArrays(patch.pins) : {}),
      ...(patch.mates ? mateCountsToArrays(patch.mates) : {}),
      ...(patch.hangs ? { hg: hungCountsToArray(patch.hangs) } : {}),
      ...(patch.freebies ? freebieCountsToArrays(patch.freebies) : {}),
      ...(patch.moveQuality ? moveQualityToArrays(patch.moveQuality) : {}),
      ...(patch.pieces ? pieceStatsToArrays(patch.pieces) : {}),
    };
    chesscomAccuracyStore.setGame(user, url, stored);
    patchCachedGame(user, url, {
      accuracy: patch.accuracy,
      whiteAccuracy: patch.whiteAccuracy,
      blackAccuracy: patch.blackAccuracy,
      ...(patch.acpl !== undefined ? { acpl: patch.acpl } : {}),
      ...(patch.shape !== undefined ? { shape: patch.shape } : {}),
      ...(patch.forks ? { forks: patch.forks } : {}),
      ...(patch.pins ? { pins: patch.pins } : {}),
      ...(patch.mates ? { mates: patch.mates } : {}),
      ...(patch.hangs ? { hangs: patch.hangs } : {}),
      ...(patch.freebies ? { freebies: patch.freebies } : {}),
      ...(patch.moveQuality ? { moveQuality: patch.moveQuality } : {}),
      ...(patch.pieces ? { pieces: patch.pieces } : {}),
      ...(patch.gameReport !== undefined ? { gameReport: patch.gameReport } : {}),
    });
    setGames(prevGames =>
      prevGames.map(game =>
        game.url === url
          ? {
            ...game,
            accuracy: patch.accuracy,
            whiteAccuracy: patch.whiteAccuracy,
            blackAccuracy: patch.blackAccuracy,
            ...(patch.acpl !== undefined ? { acpl: patch.acpl } : {}),
            ...(patch.shape !== undefined ? { shape: patch.shape } : {}),
            ...(patch.forks ? { forks: patch.forks } : {}),
            ...(patch.pins ? { pins: patch.pins } : {}),
            ...(patch.mates ? { mates: patch.mates } : {}),
            ...(patch.hangs ? { hangs: patch.hangs } : {}),
            ...(patch.freebies ? { freebies: patch.freebies } : {}),
            ...(patch.moveQuality ? { moveQuality: patch.moveQuality } : {}),
            ...(patch.pieces ? { pieces: patch.pieces } : {}),
            ...(patch.gameReport !== undefined ? { gameReport: patch.gameReport } : {}),
          }
          : game,
      ),
    );
  }, [linkedUser]);

  const updateGameAccuracy = useCallback((url: string, accuracy: number) => {
    const user = linkedUser || chesscomStore.get();
    const prev = getCachedGames(user)?.games.find((g) => g.url === url);
    chesscomAccuracyStore.setGame(user, url, {
      a: accuracy,
      w: prev?.whiteAccuracy ?? null,
      b: prev?.blackAccuracy ?? null,
    });
    patchCachedGame(user, url, { accuracy });
    setGames(prevGames =>
      prevGames.map(game =>
        game.url === url ? { ...game, accuracy } : game,
      ),
    );
  }, [linkedUser]);

  return {
    username,
    setUsername,
    linkedUser,
    profile,
    games,
    failedArchives,
    syncing,
    progress,
    error,
    startSync,
    handleUnlink,
    cancelSync,
    updateGameAnalysis,
    updateGameAccuracy,
  };
}
