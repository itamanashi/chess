import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPliesToMoveAccuracy,
  analyzeMasteryGames,
  buildActivityWeeks,
  buildMasteryTheory,
  buildRatingSeries,
  ChesscomError,
  classifyGameShape,
  computeAccuracyStats,
  computeEndingStats,
  computeMasteryOpenings,
  computeMasteryTrend,
  computeOpponentRatingStats,
  computeOpeningPerformances,
  computePeriodStats,
  computePhaseStats,
  computeSideStats,
  computeTerminationStats,
  detectUserForks,
  detectUserFreebies,
  detectUserHangs,
  detectUserMates,
  detectUserPins,
  emptyForkCounts,
  emptyFreebieCounts,
  emptyHungCounts,
  emptyMateCounts,
  emptyPinCounts,
  findAbsolutePinsFen,
  forkCountsFromArrays,
  forkCountsToArrays,
  freebieCountsFromArrays,
  freebieCountsToArrays,
  hungCountsFromArray,
  hungCountsToArray,
  mateCountsFromArrays,
  mateCountsToArrays,
  moveGivesForkFen,
  pinCountsFromArrays,
  pinCountsToArrays,
  colorOf,
  computeGamePieceStats,
  addPieceStatsInto,
  pieceStatsFromArrays,
  pieceStatsToArrays,
  emptyPieceStats,
  classifyMoveQuality,
  computeGameMoveQuality,
  moveQualityFromArrays,
  moveQualityToArrays,
  MOVE_QUALITY_ORDER,
  type QualityPly,
  computeOpeningStats,
  ecoNameFromUrl,
  emptyMoveAccuracy,
  isBotGame,
  isBotUsername,
  fetchAllGames,
  fetchArchives,
  fetchArchiveGames,
  fetchPlayer,
  normalizeUsername,
  outcomeFor,
  parseArchiveGame,
  type ChesscomArchiveGame,
  type ChesscomGame,
} from './chesscom';
import { pieceFromSan } from '../types/chess';

const PGN_E4 = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.03.01"]
[White "Hikaru"]
[Black "Opponent"]
[Result "1-0"]
[ECO "B20"]
[Opening "Sicilian Defense"]

1. e4 c5 2. Nf3 d6 1-0`;

function archiveGame(overrides: Partial<ChesscomArchiveGame> = {}): ChesscomArchiveGame {
  return {
    url: 'https://www.chess.com/game/live/1',
    pgn: PGN_E4,
    time_control: '180+2',
    end_time: 1770000000,
    rated: true,
    time_class: 'blitz',
    white: { username: 'Hikaru', rating: 3000, result: 'win' },
    black: { username: 'Opponent', rating: 2800, result: 'checkmated' },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeUsername', () => {
  it('trims and lowercases (Chess.com is case-insensitive)', () => {
    expect(normalizeUsername('  HiKaRu ')).toBe('hikaru');
    expect(normalizeUsername('')).toBe('');
  });
});

describe('parseArchiveGame', () => {
  it('extracts SANs + ECO + opening from the PGN', () => {
    const g = parseArchiveGame(archiveGame());
    expect(g.sans).toEqual(['e4', 'c5', 'Nf3', 'd6']);
    expect(g.eco).toBe('B20');
    expect(g.opening).toBe('Sicilian Defense');
  });

  it('never throws on exotic PGN: empty moves, ECO unknown, metadata kept', () => {
    const g = parseArchiveGame(archiveGame({ pgn: 'ceci n\u2019est pas un pgn' }));
    expect(g.sans).toEqual([]);
    expect(g.eco).toBe('?');
    expect(g.url).toBe('https://www.chess.com/game/live/1');
  });

  it('derives the name from ECOUrl when no Opening header exists', () => {
    const pgn = PGN_E4.replace('[Opening "Sicilian Defense"]', '[ECOUrl "https://www.chess.com/openings/Sicilian-Defense-Open-Sicilian"]');
    const g = parseArchiveGame(archiveGame({ pgn }));
    expect(g.eco).toBe('B20');
    expect(g.opening).toBe('Sicilian Defense Open Sicilian');
  });

  it('falls back to the ECO table when the PGN carries only a code', () => {
    const pgn = [
      '[Event "Live Chess"]',
      '[Site "Chess.com"]',
      '[Date "2026.01.01"]',
      '[White "Hikaru"]',
      '[Black "Opponent"]',
      '[Result "1-0"]',
      '[ECO "B01"]',
      '',
      '1. e4 d5 1-0',
    ].join('\n');
    const g = parseArchiveGame(archiveGame({ pgn }));
    expect(g.eco).toBe('B01');
    expect(g.opening).toBe('Scandinavian Defense');
  });
});

describe('ecoNameFromUrl', () => {
  it('turns slugs into readable names, tolerates garbage', () => {
    expect(ecoNameFromUrl('https://www.chess.com/openings/Italian-Game-Giuoco-Piano')).toBe(
      'Italian Game Giuoco Piano',
    );
    expect(ecoNameFromUrl(undefined)).toBe('');
    expect(ecoNameFromUrl('')).toBe('');
  });
});

describe('outcomeFor / colorOf', () => {
  it('maps results from the user perspective (case-insensitive)', () => {
    const g = parseArchiveGame(archiveGame());
    expect(outcomeFor(g, 'hikaru')).toBe('win');
    expect(outcomeFor(g, 'OPPONENT')).toBe('loss');
    expect(colorOf(g, 'Hikaru')).toBe('w');
    expect(colorOf(g, 'opponent')).toBe('b');
  });

  it('recognizes every draw shape, defaults the rest to loss', () => {
    const base = archiveGame();
    for (const r of ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']) {
      const g = { ...base, black: { ...base.black, result: r }, white: { ...base.white, result: r } };
      expect(outcomeFor(g, 'opponent')).toBe('draw');
    }
    const resigned = { ...base, white: { ...base.white, result: 'resigned' } };
    expect(outcomeFor(resigned, 'hikaru')).toBe('loss');
  });
});

describe('isBotUsername / isBotGame', () => {
  it('spots coach bots and Mittens, case-insensitively', () => {
    expect(isBotUsername('Coach-Dante')).toBe(true);
    expect(isBotUsername('coach-noa')).toBe(true);
    expect(isBotUsername('MITTENS')).toBe(true);
  });

  it('leaves humans alone (including near-misses)', () => {
    expect(isBotUsername('Hikaru')).toBe(false);
    expect(isBotUsername('coachfan')).toBe(false);
    expect(isBotUsername('Dante')).toBe(false);
  });

  it('tests the OPPONENT, never yourself', () => {
    const vsBot = parseArchiveGame(
      archiveGame({ white: { username: 'Hikaru', rating: 3000, result: 'win' }, black: { username: 'Coach-Dante', rating: 800, result: 'resigned' } }),
    );
    expect(isBotGame(vsBot, 'hikaru')).toBe(true);
    const human = parseArchiveGame(archiveGame());
    expect(isBotGame(human, 'hikaru')).toBe(false);
    // Even playing AS the bot-named side, the human opponent is not a bot.
    expect(isBotGame(vsBot, 'coach-dante')).toBe(false);
  });
});

describe('buildActivityWeeks', () => {
  // Mercredi 16 septembre 2026 (UTC), figé.
  const NOW = Date.UTC(2026, 8, 16);
  const at = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / 1000);

  it('buckets games per UTC day over the last 91 days, Monday-first', () => {
    const games = [
      { end_time: at(2026, 9, 16) },
      { end_time: at(2026, 9, 16) },
      { end_time: at(2026, 9, 14) },
      { end_time: at(2026, 6, 1) }, // trop vieux : hors fenêtre
    ];
    const weeks = buildActivityWeeks(games, 91, NOW);
    const flat = weeks.flat();
    expect(flat.length % 7).toBe(0);
    // Première case = le lundi de la semaine de J-90.
    expect(flat[0].date).toBe('2026-06-15');
    expect(new Date(`${flat[0].date}T00:00:00Z`).getUTCDay()).toBe(1);
    const byDate = new Map(flat.map((d) => [d.date, d]));
    expect(byDate.get('2026-09-16')?.games).toBe(2);
    expect(byDate.get('2026-09-14')?.games).toBe(1);
    expect(byDate.has('2026-06-01')).toBe(false);
  });

  it('pads the current week with transparent future cells', () => {
    // 16/09/2026 = mercredi → jeu..dim futurs.
    const weeks = buildActivityWeeks([], 91, NOW);
    const last = weeks[weeks.length - 1];
    expect(last).toHaveLength(7);
    expect(last.filter((d) => d.future).map((d) => d.date)).toEqual([
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
  });

  it('counts W/D/L per day when a username is given', () => {
    const day = at(2026, 9, 16);
    const games = [
      { end_time: day, white: { username: 'Hikaru', rating: 1500, result: 'win' }, black: { username: 'Opponent', rating: 1400, result: 'checkmated' } },
      { end_time: day, white: { username: 'Opponent', rating: 1400, result: 'win' }, black: { username: 'Hikaru', rating: 1500, result: 'checkmated' } },
      { end_time: day, white: { username: 'Hikaru', rating: 1500, result: 'agreed' }, black: { username: 'Opponent', rating: 1400, result: 'agreed' } },
    ];
    const weeks = buildActivityWeeks(games, 91, NOW, 'hikaru');
    const cell = weeks.flat().find((d) => d.date === '2026-09-16');
    expect(cell).toMatchObject({ games: 3, wins: 1, draws: 1, losses: 1 });
    // Sans pseudo : totaux seuls, pas d'issues.
    const anonymous = buildActivityWeeks(games, 91, NOW).flat().find((d) => d.date === '2026-09-16');
    expect(anonymous).toMatchObject({ games: 3, wins: 0, draws: 0, losses: 0 });
  });
});

describe('buildRatingSeries', () => {
  const NOW = Date.UTC(2026, 8, 16, 12);
  const day = (n: number): number => Math.floor((NOW - n * 86400000) / 1000);

  function rated(url: string, endSec: number, timeClass: string, white: string, whiteRating: number, blackRating: number): ReturnType<typeof parseArchiveGame> {
    return {
      ...parseArchiveGame(archiveGame({ url })),
      end_time: endSec,
      time_class: timeClass,
      white: { username: white, rating: whiteRating, result: 'win' },
      black: { username: white === 'Hikaru' ? 'Opponent' : 'Hikaru', rating: blackRating, result: 'checkmated' },
    };
  }

  it('groups per time class, picks my rating by color, filters the window', () => {
    const games = [
      rated('old', day(200), 'blitz', 'Hikaru', 3000, 2800), // hors fenêtre
      rated('b1', day(10), 'blitz', 'Hikaru', 2950, 2800),
      rated('b2', day(2), 'blitz', 'Opponent', 2800, 2960), // je suis noir
      rated('r1', day(5), 'rapid', 'Hikaru', 2700, 2600),
    ];
    const series = buildRatingSeries(games, 'hikaru', 91, NOW);
    expect(series).toHaveLength(2);
    expect(series[0].timeClass).toBe('blitz');
    expect(series[0].points.map((p) => p.rating)).toEqual([2950, 2960]);
    expect(series[1].timeClass).toBe('rapid');
    expect(series[1].points.map((p) => p.rating)).toEqual([2700]);
  });
});

describe('computeSideStats', () => {
  it('always returns both sides, scored from the user perspective', () => {
    const asWhiteWin = parseArchiveGame(archiveGame({ url: 'w1' }));
    const asBlackDraw = parseArchiveGame(
      archiveGame({
        url: 'b1',
        white: { username: 'Opponent', rating: 2800, result: 'agreed' },
        black: { username: 'Hikaru', rating: 3000, result: 'agreed' },
      }),
    );
    const rows = computeSideStats([asWhiteWin, asBlackDraw], 'hikaru');
    expect(rows).toEqual([
      { side: 'w', games: 1, wins: 1, draws: 0, losses: 0 },
      { side: 'b', games: 1, wins: 0, draws: 1, losses: 0 },
    ]);
    expect(computeSideStats([], 'hikaru')).toEqual([
      { side: 'w', games: 0, wins: 0, draws: 0, losses: 0 },
      { side: 'b', games: 0, wins: 0, draws: 0, losses: 0 },
    ]);
  });
});

describe('computeTerminationStats', () => {
  function game(url: string, white: string, whiteResult: string, blackResult: string): ReturnType<typeof parseArchiveGame> {
    const base = parseArchiveGame(archiveGame({ url }));
    return {
      ...base,
      white: { ...base.white, username: white, result: whiteResult },
      black: { ...base.black, username: white === 'Hikaru' ? 'Opponent' : 'Hikaru', result: blackResult },
    };
  }

  it('reads the ending off the loser (win alone says nothing)', () => {
    const games = [
      game('m1', 'Hikaru', 'win', 'checkmated'), // je mate
      game('m2', 'Opponent', 'resigned', 'win'), // l'adversaire abandonne
      game('m3', 'Hikaru', 'win', 'timeout'), // je gagne au temps
      game('l1', 'Hikaru', 'checkmated', 'win'), // je suis maté
      game('l2', 'Opponent', 'win', 'timeout'), // je perds au temps
      game('d1', 'Hikaru', 'agreed', 'agreed'), // nulle : hors tableau
    ];
    expect(computeTerminationStats(games, 'hikaru')).toEqual({
      wins: { total: 3, mate: 1, resign: 1, clock: 1 },
      losses: { total: 2, mate: 1, resign: 0, clock: 1 },
    });
  });
});

describe('computePeriodStats', () => {
  function game(url: string, endTime: number, whiteResult = 'win', blackResult = 'checkmated'): ReturnType<typeof parseArchiveGame> {
    const base = parseArchiveGame(archiveGame({ url, end_time: endTime }));
    return {
      ...base,
      white: { ...base.white, username: 'Hikaru', result: whiteResult },
      black: { ...base.black, username: 'Opponent', result: blackResult },
    };
  }

  it('buckets by day on a short span, chronological', () => {
    const d1 = Date.UTC(2026, 2, 1, 12) / 1000;
    const d2 = Date.UTC(2026, 2, 3, 12) / 1000;
    const res = computePeriodStats([game('a', d1), game('b', d1), game('c', d2)], 'hikaru');
    expect(res.granularity).toBe('day');
    expect(res.rows.map((r) => r.games)).toEqual([2, 1]);
    expect(res.rows[0].key < res.rows[1].key).toBe(true);
  });

  it('buckets by month on a ~1 year span and by year beyond', () => {
    const m1 = Date.UTC(2025, 0, 15, 12) / 1000;
    const m2 = Date.UTC(2025, 5, 15, 12) / 1000;
    const byMonth = computePeriodStats([game('a', m1), game('b', m2)], 'hikaru');
    expect(byMonth.granularity).toBe('month');
    expect(byMonth.rows).toHaveLength(2);
    const y1 = Date.UTC(2020, 0, 15, 12) / 1000;
    const y2 = Date.UTC(2026, 0, 15, 12) / 1000;
    const byYear = computePeriodStats([game('a', y1), game('b', y2)], 'hikaru');
    expect(byYear.granularity).toBe('year');
    expect(byYear.rows).toHaveLength(2);
  });

  it('returns empty rows without dates', () => {
    expect(computePeriodStats([], 'hikaru').rows).toEqual([]);
  });
});

describe('computeAccuracyStats', () => {
  function game(url: string, endTime: number, accuracy: number | null, whiteResult = 'win', blackResult = 'checkmated'): ReturnType<typeof parseArchiveGame> & { accuracy: number | null } {
    const base = parseArchiveGame(archiveGame({ url, end_time: endTime }));
    return {
      ...base,
      white: { ...base.white, username: 'Hikaru', result: whiteResult },
      black: { ...base.black, username: 'Opponent', result: blackResult },
      accuracy,
    };
  }

  it('ignores unanalyzed games and averages by outcome', () => {
    const d = Date.UTC(2026, 2, 1, 12) / 1000;
    const games = [
      game('a', d, 80),
      game('b', d, 60, 'agreed', 'agreed'),
      game('c', d, null),
    ];
    const res = computeAccuracyStats(games, 'hikaru');
    expect(res.overallCount).toBe(2);
    expect(res.overallAvg).toBeCloseTo(70);
    expect(res.winAvg).toBeCloseTo(80);
    expect(res.drawAvg).toBeCloseTo(60);
    expect(res.lossAvg).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].avg).toBeCloseTo(70);
  });
});

describe('addPliesToMoveAccuracy', () => {
  const plies = [
    { ply: 1, color: 'white', accuracy: 90 },
    { ply: 2, color: 'black', accuracy: 80 },
    { ply: 3, color: 'white', accuracy: 70 },
    { ply: 4, color: 'black', accuracy: 60 },
  ];

  it('buckets plies by move number and splits colors', () => {
    const agg = addPliesToMoveAccuracy(emptyMoveAccuracy(), 'u1', plies);
    expect(agg.games).toEqual(['u1']);
    expect(agg.total['1']).toEqual({ sum: 170, n: 2 });
    expect(agg.total['2']).toEqual({ sum: 130, n: 2 });
    expect(agg.white['1']).toEqual({ sum: 90, n: 1 });
    expect(agg.black['2']).toEqual({ sum: 60, n: 1 });
  });

  it('ignores duplicate urls and non-finite accuracies', () => {
    const once = addPliesToMoveAccuracy(emptyMoveAccuracy(), 'u1', plies);
    const twice = addPliesToMoveAccuracy(once, 'u1', plies);
    expect(twice).toBe(once);
    const bad = addPliesToMoveAccuracy(emptyMoveAccuracy(), 'u2', [
      { ply: 1, color: 'white', accuracy: NaN },
    ]);
    expect(bad.games).toEqual([]);
  });
});

describe('computeOpponentRatingStats', () => {
  function game(url: string, white: string, whiteRating: number, whiteResult: string, blackRating: number, blackResult: string): ReturnType<typeof parseArchiveGame> {
    const base = parseArchiveGame(archiveGame({ url }));
    return {
      ...base,
      white: { username: white, rating: whiteRating, result: whiteResult },
      black: { username: white === 'Hikaru' ? 'Opponent' : 'Hikaru', rating: white === 'Hikaru' ? blackRating : whiteRating, result: blackResult },
    };
  }

  it('buckets the opponent rating by 100, ascending, skips unrated', () => {
    const games = [
      game('a', 'Hikaru', 1500, 'win', 1849, 'checkmated'), // adv 1849 → 1800, win
      game('b', 'Hikaru', 1500, 'agreed', 1820, 'agreed'), // adv 1820 → 1800, draw
      game('c', 'Opponent', 950, 'win', 1500, 'checkmated'), // je suis noir, adv 950 → 900, loss
      game('d', 'Hikaru', 1500, 'win', 0, 'checkmated'), // adv inconnu : ignorée
    ];
    expect(computeOpponentRatingStats(games, 'hikaru')).toEqual([
      { bucket: 900, label: '900–999', games: 1, wins: 0, draws: 0, losses: 1 },
      { bucket: 1800, label: '1800–1899', games: 2, wins: 1, draws: 1, losses: 0 },
    ]);
  });
});

describe('computeEndingStats', () => {
  function game(url: string, white: string, whiteResult: string, blackResult: string): ReturnType<typeof parseArchiveGame> {
    const base = parseArchiveGame(archiveGame({ url }));
    return {
      ...base,
      white: { ...base.white, username: white, result: whiteResult },
      black: { ...base.black, username: white === 'Hikaru' ? 'Opponent' : 'Hikaru', result: blackResult },
    };
  }

  it('splits wins, draw motives and losses', () => {
    const games = [
      game('w1', 'Hikaru', 'win', 'checkmated'),
      game('w2', 'Hikaru', 'win', 'resigned'),
      game('w3', 'Hikaru', 'win', 'timeout'),
      game('d1', 'Hikaru', 'agreed', 'agreed'),
      game('d2', 'Hikaru', 'repetition', 'repetition'),
      game('d3', 'Hikaru', 'stalemate', 'stalemate'),
      game('d4', 'Hikaru', '50move', '50move'),
      game('d5', 'Hikaru', 'insufficient', 'insufficient'),
      game('d6', 'Hikaru', 'timevsinsufficient', 'timevsinsufficient'),
      game('l1', 'Hikaru', 'checkmated', 'win'),
      game('l2', 'Hikaru', 'timeout', 'win'),
    ];
    const res = computeEndingStats(games, 'hikaru');
    expect(res.wins).toMatchObject({ total: 3, mate: 1, resign: 1, clock: 1 });
    expect(res.draws).toMatchObject({
      total: 6, agreed: 1, repetition: 1, stalemate: 1,
      fiftyMove: 1, insufficient: 1, timeVsInsufficient: 1, other: 0,
    });
    expect(res.losses).toMatchObject({ total: 2, mate: 1, resign: 0, clock: 1 });
    expect(res.other).toBe(0);
    expect(res.total).toBe(11);
  });
});

describe('classifyGameShape', () => {
  it('equilibree when nobody takes the lead', () => {
    expect(classifyGameShape([52, 55, 48, 53, 51], false, true)).toBe('equilibree');
  });

  it('mouvementee on repeated lead changes', () => {
    expect(classifyGameShape([80, 40, 75, 30, 70, 45], true, false)).toBe('mouvementee');
  });

  it('tendue when both sides had their chance', () => {
    expect(classifyGameShape([60, 75, 85, 60, 40, 20, 35], true, false)).toBe('tendue');
  });

  it('gachee when the leader fails to win', () => {
    expect(classifyGameShape([60, 70, 80, 85, 70, 60, 52], false, true)).toBe('gachee');
  });

  it('abrupte on a tight game decided by one error', () => {
    expect(classifyGameShape([51, 52, 50, 53, 52, 30, 25], false, false)).toBe('abrupte');
  });

  it('tranquille when the lead is taken and kept', () => {
    expect(classifyGameShape([55, 60, 70, 80, 85, 90], true, false)).toBe('tranquille');
  });

  it('intense on a contested decisive game', () => {
    expect(classifyGameShape([55, 68, 56, 72, 58, 74, 62, 78, 86], true, false)).toBe('intense');
  });
});

describe('computePhaseStats', () => {
  function game(_url: string, plies: number, white: string, whiteResult: string, blackResult: string, accuracy: number | null = null): Pick<import('./chesscom').ChesscomGame, 'sans' | 'white' | 'black' | 'accuracy'> {
    return {
      sans: Array.from({ length: plies }, (_, i) => (i % 2 === 0 ? 'e4' : 'e5')),
      white: { username: white, rating: 1500, result: whiteResult },
      black: { username: white === 'Hikaru' ? 'Opponent' : 'Hikaru', rating: 1400, result: blackResult },
      accuracy,
    };
  }

  it('buckets by end phase with color split and accuracy', () => {
    const games = [
      game('a', 10, 'Hikaru', 'win', 'checkmated', 80), // ouverture, blancs, V
      game('b', 40, 'Opponent', 'win', 'resigned', 60), // milieu, noirs (moi), D
      game('c', 80, 'Hikaru', 'agreed', 'agreed', 70), // finale, blancs, N
      game('d', 0, 'Hikaru', 'win', 'timeout'), // illisible : exclue
    ];
    const rows = computePhaseStats(games, 'hikaru');
    expect(rows.map((r) => r.phase)).toEqual(['opening', 'middlegame', 'endgame']);
    const [op, mid, end] = rows;
    expect(op.total).toMatchObject({ games: 1, wins: 1 });
    expect(op.white.games).toBe(1);
    expect(op.total.accSum).toBe(80);
    expect(mid.total).toMatchObject({ games: 1, losses: 1 });
    expect(mid.black.games).toBe(1);
    expect(end.total).toMatchObject({ games: 1, draws: 1 });
    expect(end.total.accN).toBe(1);
  });
});

describe('computeOpeningPerformances', () => {
  function perfGame(url: string, white: string, sans: string[], eco: string, opening: string, whiteResult = 'win', blackResult = 'checkmated'): ChesscomGame {
    const base = parseArchiveGame(archiveGame({ url }));
    return {
      ...base,
      sans,
      eco,
      opening,
      white: { username: white, rating: 1500, result: whiteResult },
      black: { username: white === 'Hikaru' ? 'Opponent' : 'Hikaru', rating: 1400, result: blackResult },
    };
  }

  it('returns the common moves, totals and W/D/L per color', () => {
    const games = [
      perfGame('a', 'Hikaru', ['e4', 'c5', 'Nf3', 'd6'], 'B20', 'Sicilian Defense'),
      perfGame('b', 'Hikaru', ['e4', 'c5', 'Bc4', 'e6'], 'B20', 'Sicilian Defense', 'agreed', 'agreed'),
      perfGame('c', 'Opponent', ['e4', 'c5', 'Nf3'], 'B20', 'Sicilian Defense'),
    ];
    const white = computeOpeningPerformances(games, 'hikaru', 'w');
    expect(white).toHaveLength(1);
    expect(white[0]).toMatchObject({
      eco: 'B20',
      name: 'Sicilian Defense',
      movesLabel: '1. e4 c5',
      games: 2,
      wins: 1,
      draws: 1,
      losses: 0,
    });
    expect(white[0].sansPrefix).toEqual(['e4', 'c5']);
    const black = computeOpeningPerformances(games, 'hikaru', 'b');
    expect(black).toHaveLength(1);
    expect(black[0].movesLabel).toBe('1. e4 c5 2. Nf3');
  });

  it('truncates long common lines with an ellipsis', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6'];
    const games = [perfGame('a', 'Hikaru', sans, 'C70', 'Ruy Lopez')];
    const [row] = computeOpeningPerformances(games, 'hikaru', 'w');
    expect(row.movesLabel).toBe('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 …');
  });
});

describe('mastery (theory deviations)', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // Clés de théorie = FEN normalisés (4 premiers champs, compteurs ignorés).
  const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
  const AFTER_E4_KEY = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
  const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

  function masteryGame(url: string, sans: string[], white = 'Hikaru', eco = 'B20', opening = 'Sicilian Defense'): Pick<import('./chesscom').ChesscomGame, 'url' | 'sans' | 'white' | 'black' | 'eco' | 'opening' | 'end_time'> {
    return {
      url,
      sans,
      eco,
      opening,
      end_time: 1770000000,
      white: { username: white, rating: 1500, result: 'win' },
      black: { username: white === 'Hikaru' ? 'Opponent' : 'Hikaru', rating: 1400, result: 'checkmated' },
    };
  }

  function theoryRoot(): import('../types/chess').RepertoireRoot {
    const move = (uci: string, san: string, fen: string): import('../types/chess').RepertoireMove => ({
      coup: san,
      uci,
      san,
      parties: 10,
      victoires_blancs: 5,
      nuls: 2,
      victoires_noirs: 3,
      fen,
      children: [],
    });
    return {
      fen: START,
      children: [
        { ...move('e2e4', 'e4', AFTER_E4), children: [move('c7c5', 'c5', 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2')] },
        move('d2d4', 'd4', 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1'),
      ],
    };
  }

  it('buildMasteryTheory merges roots with standard UCIs', () => {
    const theory = buildMasteryTheory([theoryRoot()]);
    expect(theory.get(START_KEY)).toEqual(expect.arrayContaining(['e2e4', 'd2d4']));
    expect(theory.get(AFTER_E4_KEY)).toEqual(['c7c5']);
    expect(buildMasteryTheory([]).size).toBe(0);
  });

  it('analyzeMasteryGames spots who leaves theory first', () => {
    const theory = buildMasteryTheory([theoryRoot()]);
    const games = [
      masteryGame('me', ['e4', 'e5']), // l'adversaire dévie au 2e pli
      masteryGame('opp', ['Nf3']), // je dévie au coup 1 (blancs)
      masteryGame('none', ['e4', 'c5']), // tout en théorie
      masteryGame('black-me', ['e4', 'c5'], 'Opponent'), // moi noirs, tout en théorie
    ];
    const [me, opp, none, blackMe] = analyzeMasteryGames(games, 'hikaru', theory);
    expect(me).toMatchObject({ deviator: 'opponent', myDeviationMove: null });
    expect(opp).toMatchObject({ deviator: 'me', myDeviationMove: 1 });
    expect(none.deviator).toBe('none');
    expect(blackMe).toMatchObject({ deviator: 'none', myColor: 'b' });
  });

  it('analyzeMasteryGames marks out-of-scope without theory or legal moves', () => {
    expect(analyzeMasteryGames([masteryGame('a', ['e4'])], 'hikaru', new Map())[0].deviator).toBe('out-of-scope');
    const theory = buildMasteryTheory([theoryRoot()]);
    expect(analyzeMasteryGames([masteryGame('b', ['e4', 'e4'])], 'hikaru', theory)[0].deviator).toBe('out-of-scope');
  });

  it('computeMasteryTrend averages theory moves per adaptive period', () => {
    const d1 = Date.UTC(2026, 2, 1, 12) / 1000;
    const d2 = Date.UTC(2026, 2, 2, 12) / 1000;
    const trend = computeMasteryTrend([
      { endTime: d1, theoryMoves: 8 },
      { endTime: d1, theoryMoves: 10 },
      { endTime: d2, theoryMoves: 4 },
    ]);
    expect(trend.granularity).toBe('day');
    expect(trend.rows.map((r) => r.avg)).toEqual([9, 4]);
  });

  it('computeMasteryOpenings groups by ECO with shares and mean move', () => {
    const rows = computeMasteryOpenings([
      { url: 'a', endTime: 1, eco: 'B20', name: 'Sicilian Defense', myColor: 'w', deviator: 'me', myDeviationMove: 6 },
      { url: 'b', endTime: 2, eco: 'B20', name: 'Sicilian Defense', myColor: 'w', deviator: 'opponent', myDeviationMove: null },
      { url: 'c', endTime: 3, eco: 'C50', name: 'Italian Game', myColor: 'w', deviator: 'none', myDeviationMove: null },
      { url: 'd', endTime: 4, eco: 'B20', name: 'Sicilian Defense', myColor: 'b', deviator: 'me', myDeviationMove: 3 },
    ], 'w');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ eco: 'B20', total: 2, devFirstShare: 50, avgDevMove: 6 });
    expect(rows[1]).toMatchObject({ eco: 'C50', total: 1, devFirstShare: 0, avgDevMove: null });
  });
});

describe('forks (found and missed)', () => {
  const KNIGHT_FORK_FEN = '6k1/2q1rppp/8/8/5N2/8/5PPP/6K1 w - - 0 1';

  it('moveGivesForkFen spots the forking piece', () => {
    // Nf4-d5 attaque la dame c7 ET la tour e7.
    expect(moveGivesForkFen(KNIGHT_FORK_FEN, 'f4d5')).toBe('n');
    // Ne6 n'attaque que la dame c7 (pion g7 exclu).
    expect(moveGivesForkFen(KNIGHT_FORK_FEN, 'f4e6')).toBeNull();
    expect(moveGivesForkFen(KNIGHT_FORK_FEN, 'a1a1')).toBeNull();
  });

  // Traxler : 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5.
  const TRAXLER = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Nxd5'];
  const NO_BEST: Array<string | undefined> = Array.from({ length: 11 }, () => undefined);

  it('detectUserForks counts a played fork as found', () => {
    const counts = detectUserForks([...TRAXLER, 'Nxf7'], NO_BEST, 'w');
    expect(counts.found.n).toBe(1);
    expect(counts.missed).toEqual(emptyForkCounts().missed);
  });

  it('detectUserForks counts the engine fork as missed when another move is played', () => {
    const best = [...NO_BEST];
    best[10] = 'g5f7';
    const counts = detectUserForks([...TRAXLER, 'd4'], best, 'w');
    expect(counts.found).toEqual(emptyForkCounts().found);
    expect(counts.missed.n).toBe(1);
  });

  it('detectUserForks ignores the opponent moves and stops on garbage', () => {
    const counts = detectUserForks([...TRAXLER, 'Nxf7'], NO_BEST, 'b');
    expect(counts.found.n).toBe(0);
    const partial = detectUserForks(['e4', 'e4', 'Nxf7'], NO_BEST, 'w');
    expect(partial).toEqual(emptyForkCounts());
  });

  it('forkCounts arrays round-trip, corrupted input reads as zeros', () => {
    const counts = emptyForkCounts();
    counts.found.q = 3;
    counts.missed.p = 1;
    const { ff, fm } = forkCountsToArrays(counts);
    expect(forkCountsFromArrays(ff, fm)).toEqual(counts);
    expect(forkCountsFromArrays('nope', null)).toEqual(emptyForkCounts());
  });
});

describe('pins (played and missed)', () => {
  it('findAbsolutePinsFen spots absolute pins to the king', () => {
    // Fb5 cloue le Cb6 au roi e8 (pion d7 absent).
    expect(
      findAbsolutePinsFen('rnbqkbnr/ppp2ppp/2n5/1B6/4P3/8/PPPP1PPP/RNBQK1NR w KQkq - 0 1', 'w'),
    ).toEqual([{ piece: 'b', pinner: 'b5', pinned: 'c6' }]);
    // Te2 cloue le Ce7 au roi e8.
    expect(
      findAbsolutePinsFen('4k3/4n3/8/8/8/8/4R3/4K3 w - - 0 1', 'w'),
    ).toEqual([{ piece: 'r', pinner: 'e2', pinned: 'e7' }]);
    // Position initiale : rien. Relatif (pion d7 devant) : rien.
    expect(
      findAbsolutePinsFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'b'),
    ).toEqual([]);
    expect(
      findAbsolutePinsFen('rnbqkbnr/pppp1ppp/2n5/1B6/4P3/8/PPPP1PPP/RNBQK1NR w KQkq - 0 1', 'w'),
    ).toEqual([]);
  });

  it('detectUserPins counts a played pin as found', () => {
    // 2.Dh5 cloue le pion f7 au roi e8.
    const counts = detectUserPins(['e4', 'e5', 'Qh5'], [undefined, undefined, undefined], 'w');
    expect(counts.found.q).toBe(1);
    expect(counts.missed).toEqual(emptyPinCounts().missed);
  });

  it('detectUserPins counts the engine pin as missed when another move is played', () => {
    // 2.Cf3 ne cloue rien, mais 2.Dh5 clouait le pion f7 au roi e8.
    const counts = detectUserPins(['e4', 'e5', 'Nf3'], [undefined, undefined, 'd1h5'], 'w');
    expect(counts.found).toEqual(emptyPinCounts().found);
    expect(counts.missed.q).toBe(1);
  });

  it('pinCounts arrays round-trip, corrupted input reads as zeros', () => {
    const counts = emptyPinCounts();
    counts.found.q = 2;
    counts.missed.r = 1;
    const { pf, pm } = pinCountsToArrays(counts);
    expect(pinCountsFromArrays(pf, pm)).toEqual(counts);
    expect(pinCountsFromArrays('nope', null)).toEqual(emptyPinCounts());
  });
});

describe('mates (played and missed)', () => {
  it('counts best mating lines played as found, others as missed', () => {
    const plies = [
      { color: 'white', isBest: true, bestMate: 2 },
      { color: 'black', isBest: true, bestMate: 4 }, // pas moi : ignoré
      { color: 'white', isBest: false, bestMate: 3 },
    ];
    expect(detectUserMates(plies, 'w', false)).toEqual({
      found: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0 },
      missed: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
    });
  });

  it('ignores mates against me and caps distance at 5+', () => {
    const plies = [
      { color: 'white', isBest: false, bestMate: -2 },
      { color: 'white', isBest: false, bestMate: 7 },
      { color: 'white', isBest: true },
    ];
    const counts = detectUserMates(plies, 'w', false);
    expect(counts.missed[5]).toBe(1);
    expect(counts.found).toEqual(emptyMateCounts().found);
  });

  it('counts a delivered checkmate as found M1', () => {
    const counts = detectUserMates([{ color: 'white', isBest: false }], 'w', true);
    expect(counts.found[1]).toBe(1);
  });

  it('mateCounts arrays round-trip, corrupted input reads as zeros', () => {
    const counts = emptyMateCounts();
    counts.found[1] = 2;
    counts.missed[5] = 1;
    const { mf, mm } = mateCountsToArrays(counts);
    expect(mateCountsFromArrays(mf, mm)).toEqual(counts);
    expect(mateCountsFromArrays('nope', null)).toEqual(emptyMateCounts());
  });
});

describe('hangs (left en prise)', () => {
  it('counts a piece hung by my own move', () => {
    // 4.Fxc6 donne le fou (repris par deux pions, sans défense).
    const counts = detectUserHangs(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6'], 'w');
    expect(counts).toEqual({ p: 0, n: 0, b: 1, r: 0, q: 0 });
  });

  it('ignores a threat I answer (bishop retreats to safety)', () => {
    const counts = detectUserHangs(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4'], 'w');
    expect(counts).toEqual({ p: 0, n: 0, b: 0, r: 0, q: 0 });
  });

  it('counts an ignored enemy threat on my next move', () => {
    // 3…a6 attaque le Fb5 ; 4.a3 l'ignore → le fou compte en prise.
    const counts = detectUserHangs(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'a3'], 'w');
    expect(counts.b).toBe(1);
  });

  it('hungCounts arrays round-trip, corrupted input reads as zeros', () => {
    const counts = emptyHungCounts();
    counts.r = 2;
    expect(hungCountsFromArray(hungCountsToArray(counts))).toEqual(counts);
    expect(hungCountsFromArray('nope')).toEqual(emptyHungCounts());
  });
});

describe('freebies (opponent hung pieces)', () => {
  it('counts a captured hanging piece as found', () => {
    // 2…Cf6 laisse le pion e5 sans défense ; 3.Dxe5+ prend la pièce gratuite.
    const counts = detectUserFreebies(['e4', 'e5', 'Qh5', 'Nf6', 'Qxe5'], 'w');
    expect(counts.found.p).toBe(1);
    expect(counts.missed).toEqual(emptyFreebieCounts().missed);
  });

  it('counts an ignored hanging piece as missed, once per episode', () => {
    // e5 pendant dès 2.Dh5, ignoré en 3.d4 : un seul manqué.
    const counts = detectUserFreebies(['e4', 'e5', 'Qh5', 'Nf6', 'd4'], 'w');
    expect(counts.found).toEqual(emptyFreebieCounts().found);
    expect(counts.missed.p).toBe(1);
  });

  it('ignores defended captures (not free)', () => {
    // 3.Cxe5 prend un pion DÉFENDU par le Cc6 : ni trouvé ni manqué.
    const counts = detectUserFreebies(['e4', 'e5', 'Nf3', 'Nc6', 'Nxe5'], 'w');
    expect(counts).toEqual(emptyFreebieCounts());
  });

  it('freebieCounts arrays round-trip, corrupted input reads as zeros', () => {
    const counts = emptyFreebieCounts();
    counts.found.n = 2;
    counts.missed.q = 1;
    const { gf, gm } = freebieCountsToArrays(counts);
    expect(freebieCountsFromArrays(gf, gm)).toEqual(counts);
    expect(freebieCountsFromArrays('nope', null)).toEqual(emptyFreebieCounts());
  });
});

describe('computeOpeningStats', () => {  const PGN_D4 = PGN_E4.replace('1. e4 c5 2. Nf3 d6 1-0', '1. d4 d5 2. c4 e6 1/2-1/2')
    .replace('[ECO "B20"]', '[ECO "D06"]')
    .replace('[Opening "Sicilian Defense"]', '[Opening "Queen\'s Gambit Declined"]')
    .replace('[White "Hikaru"]', '[White "Opponent"]')
    .replace('[Black "Opponent"]', '[Black "Hikaru"]')
    .replace('[Result "1-0"]', '[Result "1/2-1/2"]');

  function gameSet(): ReturnType<typeof parseArchiveGame>[] {
    return [
      parseArchiveGame(archiveGame({ url: 'u1' })), // B20 win (white)
      parseArchiveGame(archiveGame({ url: 'u2' })), // B20 win (white)
      parseArchiveGame(
        archiveGame({
          url: 'u3',
          pgn: PGN_D4,
          white: { username: 'Opponent', rating: 2800, result: 'agreed' },
          black: { username: 'Hikaru', rating: 3000, result: 'agreed' },
        }),
      ), // D06 draw (black)
    ];
  }

  it('groups by ECO, scores and orders by volume', () => {
    const rows = computeOpeningStats(gameSet(), 'hikaru');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ eco: 'B20', games: 2, wins: 2, scorePct: 100 });
    expect(rows[1]).toMatchObject({ eco: 'D06', games: 1, draws: 1, scorePct: 50 });
  });

  it('averages game length in full moves (plies / 2)', () => {
    // PGN_E4 games: 4 plies = 2.0 moves ; PGN_D4 game: 4 plies = 2.0 moves.
    const rows = computeOpeningStats(gameSet(), 'hikaru');
    expect(rows[0].avgMoves).toBeCloseTo(2.0, 5);
    expect(rows[1].avgMoves).toBeCloseTo(2.0, 5);
  });

  it('filters on the color played by the user', () => {
    const asWhite = computeOpeningStats(gameSet(), 'hikaru', 'w');
    expect(asWhite.map((r) => r.eco)).toEqual(['B20']);
    const asBlack = computeOpeningStats(gameSet(), 'hikaru', 'b');
    expect(asBlack.map((r) => r.eco)).toEqual(['D06']);
  });

  it('groups by name when the ECO is missing (no "?" bucket)', () => {
    const noEco = {
      ...parseArchiveGame(archiveGame({ url: 'u4' })),
      eco: '?',
      opening: 'London System',
    };
    const rows = computeOpeningStats([noEco], 'hikaru');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eco: '?', name: 'London System', games: 1 });
  });
});

describe('fetchPlayer', () => {
  it('404 → structured unknown-user (French message)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const err = await fetchPlayer('NobodyXYZ123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChesscomError);
    expect((err as ChesscomError).code).toBe('unknown-user');
    // Message built on the normalized identity (what the API saw).
    expect((err as Error).message).toContain('nobodyxyz123');
  });

  it('returns the public profile', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ username: 'Hikaru', name: 'Hikaru N.', avatar: 'https://img/a.png', followers: 42, joined: 1350000000 })),
    );
    const p = await fetchPlayer('HIKARU');
    expect(p).toMatchObject({ username: 'Hikaru', followers: 42, joined: 1350000000000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/player/hikaru');
  });
});

describe('fetchArchives / fetchArchiveGames', () => {
  it('lists monthly archives, rejects malformed payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ archives: ['https://api.chess.com/pub/player/x/games/2026/01', 'https://api.chess.com/pub/player/x/games/2026/02'] })),
    );
    await expect(fetchArchives('x')).resolves.toHaveLength(2);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ nope: true })));
    await expect(fetchArchives('x')).rejects.toMatchObject({ name: 'ChesscomError', code: 'bad-response' });
  });

  it('parses every game of an archive, skips malformed entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ games: [archiveGame(), { bogus: true }, archiveGame({ url: 'u2' })] })),
    );
    const games = await fetchArchiveGames('https://api.chess.com/pub/player/x/games/2026/01');
    expect(games.map((g) => g.url)).toEqual(['https://www.chess.com/game/live/1', 'u2']);
  });
});

describe('fetchAllGames (full history)', () => {
  const ARCH = 'https://api.chess.com/pub/player/hikaru/games/';

  function stubHistory(failFeb: boolean): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/games/archives')) {
        return jsonResponse({ archives: [`${ARCH}2026/01`, `${ARCH}2026/02`] });
      }
      if (u.endsWith('/2026/01')) {
        return jsonResponse({ games: [archiveGame({ url: 'jan', end_time: 1000 })] });
      }
      if (u.endsWith('/2026/02')) {
        if (failFeb) return new Response('boom', { status: 500 });
        return jsonResponse({
          games: [
            archiveGame({ url: 'feb1', end_time: 2000 }),
            archiveGame({ url: 'feb2', end_time: 3000 }),
          ],
        });
      }
      throw new Error(`unexpected url ${u}`);
    });
  }

  it('merges all archives, newest first, with progress', async () => {
    vi.stubGlobal('fetch', stubHistory(false));
    const seen: Array<[number, number]> = [];
    const res = await fetchAllGames('hikaru', {
      concurrency: 2,
      onProgress: (p) => seen.push([p.doneArchives, p.totalArchives]),
    });
    expect(res.games.map((g) => g.url)).toEqual(['feb2', 'feb1', 'jan']);
    expect(res.archivesTotal).toBe(2);
    expect(res.archivesFailed).toBe(0);
    expect(seen[0]).toEqual([0, 2]);
    expect(seen[seen.length - 1]).toEqual([2, 2]);
  });

  it('isolates a failing archive instead of losing everything', async () => {
    vi.stubGlobal('fetch', stubHistory(true));
    const res = await fetchAllGames('hikaru');
    expect(res.games.map((g) => g.url)).toEqual(['jan']);
    expect(res.archivesFailed).toBe(1);
  });

  it('throws when every archive fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/games/archives')) return jsonResponse({ archives: [`${ARCH}2026/01`] });
      return new Response('boom', { status: 500 });
    }));
    await expect(fetchAllGames('hikaru')).rejects.toBeInstanceOf(ChesscomError);
  });

  it('a pre-aborted signal fetches nothing', async () => {
    const mock = vi.fn(async () => jsonResponse({ archives: [] }));
    vi.stubGlobal('fetch', mock);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(fetchAllGames('hikaru', { signal: ctrl.signal })).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError',
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('pièces (coups par pièce + précision)', () => {
  it('pieceFromSan : roque → roi, initiale → pièce, sinon pion', () => {
    expect(pieceFromSan('e4')).toBe('p');
    expect(pieceFromSan('exd5')).toBe('p');
    expect(pieceFromSan('e8=Q')).toBe('p');
    expect(pieceFromSan('exd8=N')).toBe('p');
    expect(pieceFromSan('Nf3')).toBe('n');
    expect(pieceFromSan('Bb5')).toBe('b');
    expect(pieceFromSan('Rfe1')).toBe('r');
    expect(pieceFromSan('Qxd5')).toBe('q');
    expect(pieceFromSan('Ke2')).toBe('k');
    expect(pieceFromSan('O-O')).toBe('k');
    expect(pieceFromSan('O-O-O')).toBe('k');
    expect(pieceFromSan('')).toBe('p');
  });

  it('computeGamePieceStats ventile par pièce et phase', () => {
    const stats = computeGamePieceStats([
      { piece: 'p', accuracy: 80, ply: 1 },
      { piece: 'n', accuracy: 60, ply: 2 },
      { piece: 'p', accuracy: 100, ply: 30 },
      { piece: 'q', accuracy: 50, ply: 61 },
    ]);
    expect(stats.opening.counts.p).toBe(1);
    expect(stats.opening.counts.n).toBe(1);
    expect(stats.middlegame.counts.p).toBe(1);
    expect(stats.endgame.counts.q).toBe(1);
    expect(stats.opening.accSum.p).toBe(80);
    expect(stats.middlegame.accSum.p).toBe(100);
    expect(stats.endgame.accSum.q).toBe(50);
  });

  it('computeGamePieceStats ignore les plis sans précision et tolère les replis', () => {
    const stats = computeGamePieceStats([
      { piece: 'p', ply: 1 },
      { piece: 'p', accuracy: NaN, ply: 3 },
      { san: 'Nf3', accuracy: 70, ply: 5 },
      { piece: 'x', san: 'e4', accuracy: 90, ply: 7 },
      { piece: 'b', accuracy: 60 },
    ]);
    expect(stats.opening.counts.p).toBe(1);
    expect(stats.opening.counts.n).toBe(1);
    expect(stats.opening.counts.b).toBe(1);
    expect(stats.opening.accSum.p).toBe(90);
    expect(stats.opening.accSum.n).toBe(70);
  });

  it('arrays : aller-retour exact (moyennes au dixième)', () => {
    const src = computeGamePieceStats([
      { piece: 'p', accuracy: 80, ply: 1 },
      { piece: 'p', accuracy: 91, ply: 3 },
      { piece: 'k', accuracy: 100, ply: 61 },
    ]);
    const { pc, pa } = pieceStatsToArrays(src);
    expect(pc).toHaveLength(18);
    expect(pa).toHaveLength(18);
    const back = pieceStatsFromArrays(pc, pa);
    expect(back.opening.counts.p).toBe(2);
    expect(back.opening.accSum.p).toBeCloseTo(171, 6);
    expect(back.endgame.counts.k).toBe(1);
    expect(back.endgame.accSum.k).toBe(100);
  });

  it('arrays : corrompu → zéros', () => {
    const stats = pieceStatsFromArrays('boom', [1, -2, NaN, Infinity]);
    const total = (['opening', 'middlegame', 'endgame'] as const).reduce(
      (s, ph) => s + stats[ph].counts.p + stats[ph].accSum.p,
      0,
    );
    expect(total).toBe(0);
    expect(pieceStatsFromArrays(null, null)).toEqual(emptyPieceStats());
  });

  it('addPieceStatsInto cumule deux parties', () => {
    const a = computeGamePieceStats([{ piece: 'p', accuracy: 80, ply: 1 }]);
    const b = computeGamePieceStats([{ piece: 'p', accuracy: 60, ply: 1 }]);
    const agg = addPieceStatsInto(a, b);
    expect(agg.opening.counts.p).toBe(2);
    expect(agg.opening.accSum.p).toBe(140);
  });
});

describe('qualité des coups façon chess.com (Classification V2)', () => {
  it('bandes erreur inchangées (gaffe/erreur/imprécision)', () => {
    expect(classifyMoveQuality({ annotation: '??' })).toBe('gaffe');
    expect(classifyMoveQuality({ annotation: '?' })).toBe('erreur');
    expect(classifyMoveQuality({ annotation: '?!', ply: 30 })).toBe('imprecision');
  });

  it("imprécision d'ouverture : plus avalée par Théorique", () => {
    expect(classifyMoveQuality({ annotation: '?!', ply: 5 })).toBe('imprecision');
    expect(classifyMoveQuality({ annotation: '', ply: 5 })).toBe('theorique');
    expect(classifyMoveQuality({ annotation: '??', ply: 3 })).toBe('gaffe');
  });

  it('gain manqué : occasion ratée sans aggravation (pas une gaffe)', () => {
    // Mat raté en restant égal : Miss, pas Blunder (même avec annotation ??).
    expect(classifyMoveQuality({
      annotation: '??', isBest: false, bestMate: 2,
      beforePovWin: 50, afterPovWin: 50, bestPovWin: 100, color: 'white',
    })).toBe('gain-manque');
    // Tactique gagnante ratée (fourchette) : Miss.
    expect(classifyMoveQuality({
      annotation: '?', isBest: false,
      beforePovWin: 50, afterPovWin: 52, bestPovWin: 88, color: 'white',
    })).toBe('gain-manque');
    // Même occasion mais matériel pendu derrière : gaffe.
    expect(classifyMoveQuality({
      annotation: '??', isBest: false, bestMate: 1,
      beforePovWin: 50, afterPovWin: 12, bestPovWin: 100, color: 'white',
    })).toBe('gaffe');
    // Autre mat à égalité (perte 0.00) : meilleur, pas manqué.
    expect(classifyMoveQuality({
      annotation: '', isBest: false, bestMate: 1,
      beforePovWin: 50, afterPovWin: 100, bestPovWin: 100, color: 'white',
    })).toBe('meilleur');
  });

  it('génial : seul bon coup et retournements (Great « ! »)', () => {
    expect(classifyMoveQuality({ annotation: '!' })).toBe('genial');
    expect(classifyMoveQuality({ isBest: true, isOnlySound: true })).toBe('genial');
    // Perdant → égal.
    expect(classifyMoveQuality({
      isBest: true, beforePovWin: 30, afterPovWin: 55, bestPovWin: 55, color: 'white',
    })).toBe('genial');
    // Égal → gagnant.
    expect(classifyMoveQuality({
      isBest: true, beforePovWin: 60, afterPovWin: 80, bestPovWin: 80, color: 'white',
    })).toBe('genial');
    // Simple meilleur coup sans retournement : meilleur.
    expect(classifyMoveQuality({
      isBest: true, beforePovWin: 50, afterPovWin: 55, bestPovWin: 55, color: 'white', ply: 30,
    })).toBe('meilleur');
  });

  it('brillant : sacrifice meilleur en position compétitive (pas de gap requis)', () => {
    // Sacrifice meilleur sans « seul coup » : brillant quand même (V2).
    expect(classifyMoveQuality({
      isBest: true, isSacrifice: true,
      beforePovWin: 50, afterPovWin: 55, bestPovWin: 55, color: 'white',
    })).toBe('brillant');
    // Déjà complètement gagnant avant : pas brillant.
    expect(classifyMoveQuality({
      annotation: '!!', isBest: true, isSacrifice: true,
      beforePovWin: 95, afterPovWin: 97, bestPovWin: 97, color: 'white', ply: 30,
    })).not.toBe('brillant');
    // Héritage : !! reste brillant en position normale.
    expect(classifyMoveQuality({ annotation: '!!' })).toBe('brillant');
  });

  it('computeGameMoveQuality chaîne les befores (miss détecté sur séquence)', () => {
    const plies: QualityPly[] = [
      { color: 'white', whiteWin: 52, winLoss: 0, isBest: true, ply: 1 },
      { color: 'black', whiteWin: 55, winLoss: 3, isBest: false, ply: 1 },
      { color: 'white', whiteWin: 55, winLoss: 40, isBest: false, annotation: '??', ply: 2 },
    ];
    const counts = computeGameMoveQuality(plies);
    expect(counts.total['theorique']).toBe(2);
    expect(counts.total['gain-manque']).toBe(1);
    expect(counts.white['gain-manque']).toBe(1);
    expect(counts.total['gaffe']).toBe(0);
  });

  it('persistance : 9 entrées legacy mappées par nom, 10 en roundtrip', () => {
    const legacy = [1, 2, 3, 4, 5, 6, 7, 8, 9]; // brillant..gain-manque (ancien ordre)
    const back = moveQualityFromArrays(legacy, legacy, legacy);
    expect(back.total.brillant).toBe(1);
    expect(back.total.genial).toBe(0);
    expect(back.total.meilleur).toBe(2);
    expect(back.total['gain-manque']).toBe(9);
    const full = moveQualityToArrays(back);
    expect(full.q).toHaveLength(MOVE_QUALITY_ORDER.length);
    expect(full.q[MOVE_QUALITY_ORDER.indexOf('genial')]).toBe(0);
    expect(full.q[MOVE_QUALITY_ORDER.indexOf('meilleur')]).toBe(2);
    const rt = moveQualityFromArrays(full.q, full.qw, full.qb);
    expect(rt.total).toEqual(back.total);
  });
});
