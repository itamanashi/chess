import {
  acplFor,
  colorOf,
  computeAccuracyStats,
  computeOpeningStats,
  computeSideStats,
  FORK_PIECE_ORDER,
  GAME_SHAPE_ORDER,
  HUNG_PIECE_ORDER,
  MATE_DISTANCE_ORDER,
  MOVE_QUALITY_ORDER,
  outcomeFor,
  type ChesscomGame,
  type GameShape,
} from './chesscom';
import {
  buildEvolution,
  describeRapportBlocks,
  RAPPORT_BLOCK_SIZE,
  rapportBlockLabel,
  splitIntoBlocks,
  type RapportBlockMeta,
  type RapportGameRef,
  type RapportInput,
  type RapportPeriodSlice,
} from './rapport';

export { RAPPORT_BLOCK_SIZE, rapportBlockLabel, splitIntoBlocks, describeRapportBlocks };
export type { RapportBlockMeta };

/** Tranche vide (bloc précédent inexistant : comparaison « insuffisant »). */
function emptySlice(): RapportPeriodSlice {
  return {
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    score: 0,
    analyzedCount: 0,
    overallAcc: null,
    acpl: null,
    acplCount: 0,
    blunderRate: null,
    hangsPerGame: null,
    theoryAvg: null,
    theoryCount: 0,
    matesFound: 0,
    matesMissed: 0,
    forksFound: 0,
    forksMissed: 0,
    freebiesMissed: 0,
    sparkScore: [],
    sparkAcc: [],
  };
}

/**
 * Agrège un paquet de parties en tranche de période (même contrat que
 * `aggregateRapportSlice` dans ChesscomPanel : score, précision, ACPL,
 * bévues, prises, théorie, tactique + sparklines par paquets de 5).
 * Pur.
 */
export function aggregatePeriodSlice(
  slice: ChesscomGame[],
  me: string,
  theoryByUrl: Map<string, number>,
): RapportPeriodSlice {
  let wins = 0;
  let draws = 0;
  let accSum = 0;
  let accN = 0;
  let acplSum = 0;
  let acplN = 0;
  let blunders = 0;
  let moves = 0;
  let hangs = 0;
  let hangsGames = 0;
  let matesFound = 0;
  let matesMissed = 0;
  let forksFound = 0;
  let forksMissed = 0;
  let freebiesMissed = 0;
  let theorySum = 0;
  let theoryN = 0;
  const sparkScore: number[] = [];
  const sparkAcc: number[] = [];
  for (const g of slice) {
    const o = outcomeFor(g, me);
    if (o === 'win') wins++;
    else if (o === 'draw') draws++;
    if (typeof g.accuracy === 'number' && Number.isFinite(g.accuracy)) {
      accSum += g.accuracy;
      accN++;
    }
    const gameAcpl = acplFor(g, me);
    if (gameAcpl !== null) {
      acplSum += gameAcpl;
      acplN++;
    }
    if (g.moveQuality) {
      const t = g.moveQuality.total;
      blunders += t.gaffe ?? 0;
      for (const k of MOVE_QUALITY_ORDER) moves += t[k] ?? 0;
    }
    if (g.hangs) {
      hangsGames++;
      for (const k of HUNG_PIECE_ORDER) hangs += g.hangs[k] ?? 0;
    }
    if (g.mates) {
      for (const k of MATE_DISTANCE_ORDER) {
        matesFound += g.mates.found[k] ?? 0;
        matesMissed += g.mates.missed[k] ?? 0;
      }
    }
    if (g.forks) {
      for (const k of FORK_PIECE_ORDER) {
        forksFound += g.forks.found[k] ?? 0;
        forksMissed += g.forks.missed[k] ?? 0;
      }
    }
    if (g.freebies) {
      for (const k of HUNG_PIECE_ORDER) freebiesMissed += g.freebies.missed[k] ?? 0;
    }
    const dev = theoryByUrl.get(g.url);
    if (typeof dev === 'number') {
      theorySum += dev;
      theoryN++;
    }
  }
  for (let i = 0; i < slice.length; i += 5) {
    const packet = slice.slice(i, i + 5);
    if (packet.length === 0) continue;
    let pw = 0;
    let pd = 0;
    let paSum = 0;
    let paN = 0;
    for (const g of packet) {
      const o = outcomeFor(g, me);
      if (o === 'win') pw++;
      else if (o === 'draw') pd++;
      if (typeof g.accuracy === 'number' && Number.isFinite(g.accuracy)) {
        paSum += g.accuracy;
        paN++;
      }
    }
    sparkScore.push(((pw + pd / 2) / packet.length) * 100);
    if (paN > 0) sparkAcc.push(paSum / paN);
  }
  const total = slice.length;
  return {
    games: total,
    wins,
    draws,
    losses: total - wins - draws,
    score: total > 0 ? ((wins + draws / 2) / total) * 100 : 0,
    analyzedCount: accN,
    overallAcc: accN > 0 ? accSum / accN : null,
    acpl: acplN > 0 ? acplSum / acplN : null,
    acplCount: acplN,
    blunderRate: moves > 0 ? (blunders / moves) * 100 : null,
    hangsPerGame: hangsGames > 0 ? hangs / hangsGames : null,
    theoryAvg: theoryN > 0 ? theorySum / theoryN : null,
    theoryCount: theoryN,
    matesFound,
    matesMissed,
    forksFound,
    forksMissed,
    freebiesMissed,
    sparkScore,
    sparkAcc,
  };
}

export interface RapportBlock {
  meta: RapportBlockMeta;
  /** Libellé FR (« Bloc 2 · parties 31–60 »). */
  label: string;
  /** Entrée complète du RapportPanel pour ce bloc. */
  input: RapportInput;
}

/**
 * Construit un rapport complet par bloc de N parties (ordre chrono).
 * Chaque bloc est comparé au précédent via `buildEvolution` (taille de
 * fenêtre = taille du bloc) : le panneau affiche progression/régression
 * sans autre câblage. Pur.
 *
 * @param sortedGames parties triées par date croissante (ne doit pas être muté)
 * @param me pseudo du compte lié
 * @param theoryByUrl coups théoriques par URL (sortie de théorie du compte)
 * @param theoryAvailable vrai si un répertoire est chargé
 * @param size taille d'un bloc (défaut 30)
 */
export function buildRapportBlocks(
  sortedGames: ChesscomGame[],
  me: string,
  theoryByUrl: Map<string, number> = new Map(),
  theoryAvailable = false,
  size: number = RAPPORT_BLOCK_SIZE,
): RapportBlock[] {
  const chunks = splitIntoBlocks(sortedGames, size);
  const metas = describeRapportBlocks(sortedGames.length, size);
  return chunks.map((block, i) => {
    const meta = metas[i] ?? {
      index: i,
      start: i * size + 1,
      end: i * size + block.length,
      games: block.length,
      complete: block.length >= size,
    };
    const prev = i > 0 ? chunks[i - 1] : [];
    const evolution = buildEvolution(
      aggregatePeriodSlice(block, me, theoryByUrl),
      prev.length > 0 ? aggregatePeriodSlice(prev, me, theoryByUrl) : emptySlice(),
      size,
    );
    if (block.length < size) {
      evolution.narrative.unshift(
        `Bloc en cours (${block.length}/${size}) : comparaison indicative — sur si peu de parties, ` +
        `le score varie fortement d'une série à l'autre ; lisez les deltas indicateur par indicateur.`,
      );
    }
    return { meta, label: rapportBlockLabel(meta), input: buildBlockInput(block, me, theoryByUrl, theoryAvailable, evolution) };
  });
}

function buildBlockInput(
  block: ChesscomGame[],
  me: string,
  theoryByUrl: Map<string, number>,
  theoryAvailable: boolean,
  evolution: ReturnType<typeof buildEvolution>,
): RapportInput {
  let wins = 0;
  let draws = 0;
  for (const g of block) {
    const o = outcomeFor(g, me);
    if (o === 'win') wins++;
    else if (o === 'draw') draws++;
  }
  const totalGames = block.length;
  const losses = totalGames - wins - draws;
  const score = totalGames > 0 ? ((wins + draws / 2) / totalGames) * 100 : 0;

  const sideRows = computeSideStats(block, me);
  const whiteRow = sideRows.find((r) => r.side === 'w');
  const blackRow = sideRows.find((r) => r.side === 'b');
  const accuracyStats = computeAccuracyStats(block, me);

  let brilliant = 0;
  let best = 0;
  let excellent = 0;
  let good = 0;
  let inaccuracy = 0;
  let mistake = 0;
  let blunder = 0;
  let totalMoves = 0;
  let matesFound = 0;
  let matesMissed = 0;
  let forksFound = 0;
  let forksMissed = 0;
  let hangs = 0;
  let freebiesFound = 0;
  let freebiesMissed = 0;
  for (const g of block) {
    if (g.moveQuality) {
      const t = g.moveQuality.total;
      brilliant += t.brillant ?? 0;
      best += (t.genial ?? 0) + (t.meilleur ?? 0);
      excellent += t['tres-bien'] ?? 0;
      good += (t.bon ?? 0) + (t.theorique ?? 0);
      inaccuracy += t.imprecision ?? 0;
      mistake += (t.erreur ?? 0) + (t['gain-manque'] ?? 0);
      blunder += t.gaffe ?? 0;
      for (const k of MOVE_QUALITY_ORDER) totalMoves += t[k] ?? 0;
    }
    if (g.mates) {
      for (const k of MATE_DISTANCE_ORDER) {
        matesFound += g.mates.found[k] ?? 0;
        matesMissed += g.mates.missed[k] ?? 0;
      }
    }
    if (g.forks) {
      for (const k of FORK_PIECE_ORDER) {
        forksFound += g.forks.found[k] ?? 0;
        forksMissed += g.forks.missed[k] ?? 0;
      }
    }
    if (g.hangs) {
      for (const k of HUNG_PIECE_ORDER) hangs += g.hangs[k] ?? 0;
    }
    if (g.freebies) {
      for (const k of HUNG_PIECE_ORDER) {
        freebiesFound += g.freebies.found[k] ?? 0;
        freebiesMissed += g.freebies.missed[k] ?? 0;
      }
    }
  }

  let theorySum = 0;
  let theoryN = 0;
  for (const g of block) {
    const dev = theoryByUrl.get(g.url);
    if (typeof dev === 'number') {
      theorySum += dev;
      theoryN++;
    }
  }

  const shapeCounts = new Map<GameShape, number>();
  for (const s of GAME_SHAPE_ORDER) shapeCounts.set(s, 0);
  let shaped = 0;
  for (const g of block) {
    if (g.shape) {
      shapeCounts.set(g.shape, (shapeCounts.get(g.shape) ?? 0) + 1);
      shaped++;
    }
  }
  const topShape = GAME_SHAPE_ORDER.slice().sort(
    (a, b) => (shapeCounts.get(b) ?? 0) - (shapeCounts.get(a) ?? 0),
  )[0] ?? 'equilibree';

  const openings = computeOpeningStats(block, me, 'all').filter((r) => r.games >= 3);
  const byWin = [...openings].sort((a, b) => b.wins / b.games - a.wins / a.games);
  const byLoss = [...openings].sort((a, b) => a.wins / a.games - b.wins / b.games);
  const bestOpening = byWin[0] ?? null;
  const worstOpening = byLoss[0] ?? null;

  let acplSum = 0;
  let acplN = 0;
  for (const g of block) {
    const v = acplFor(g, me);
    if (v !== null) {
      acplSum += v;
      acplN++;
    }
  }

  let bestGame: RapportGameRef | null = null;
  let worstGame: RapportGameRef | null = null;
  let whiteSum = 0;
  let whiteCount = 0;
  let blackSum = 0;
  let blackCount = 0;
  for (const g of block) {
    if (typeof g.accuracy !== 'number' || !Number.isFinite(g.accuracy)) continue;
    const mine = colorOf(g, me);
    if (mine === 'w') {
      whiteSum += g.accuracy;
      whiteCount++;
    } else {
      blackSum += g.accuracy;
      blackCount++;
    }
    const opp = mine === 'w' ? g.black : g.white;
    const ref: RapportGameRef = {
      url: g.url,
      opponent: opp.username,
      opponentRating: typeof opp.rating === 'number' ? opp.rating : null,
      result: outcomeFor(g, me),
      accuracy: g.accuracy,
      dateLabel: g.end_time
        ? new Date(g.end_time * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
        : '',
    };
    if (!bestGame || ref.accuracy > bestGame.accuracy) bestGame = ref;
    if (!worstGame || ref.accuracy < worstGame.accuracy) worstGame = ref;
  }
  if (bestGame && worstGame && bestGame.url === worstGame.url) worstGame = null;

  return {
    me,
    totalGames,
    wins,
    draws,
    losses,
    score,
    whiteGames: whiteRow?.games ?? 0,
    whiteWins: whiteRow?.wins ?? 0,
    blackGames: blackRow?.games ?? 0,
    blackWins: blackRow?.wins ?? 0,
    botGamesCount: 0,
    overallAcc: accuracyStats.overallAvg,
    analyzedCount: accuracyStats.overallCount,
    accWin: accuracyStats.winAvg,
    accWinCount: accuracyStats.winCount,
    accLoss: accuracyStats.lossAvg,
    accLossCount: accuracyStats.lossCount,
    accDraw: accuracyStats.drawAvg,
    accDrawCount: accuracyStats.drawCount,
    brilliant,
    best,
    excellent,
    good,
    inaccuracy,
    mistake,
    blunder,
    totalMoves,
    matesFound,
    matesMissed,
    forksFound,
    forksMissed,
    hangs,
    freebiesFound,
    freebiesMissed,
    theoryAvg: theoryN > 0 ? theorySum / theoryN : null,
    theoryCount: theoryN,
    theoryAvailable,
    topShape,
    topShapePct: shaped > 0 ? ((shapeCounts.get(topShape) ?? 0) / shaped) * 100 : 0,
    bestOpening: bestOpening
      ? { name: bestOpening.name, eco: bestOpening.eco, wins: bestOpening.wins, games: bestOpening.games }
      : null,
    worstOpening: worstOpening && worstOpening !== bestOpening
      ? { name: worstOpening.name, eco: worstOpening.eco, wins: worstOpening.wins, games: worstOpening.games }
      : null,
    acplOverall: acplN > 0 ? acplSum / acplN : null,
    acplCount: acplN,
    evolution,
    accWhite: whiteCount > 0 ? whiteSum / whiteCount : null,
    accWhiteCount: whiteCount,
    accBlack: blackCount > 0 ? blackSum / blackCount : null,
    accBlackCount: blackCount,
    bestGame,
    worstGame,
  };
}
