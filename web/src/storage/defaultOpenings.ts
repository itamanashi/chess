import { Chess } from 'chess.js';
import type { RepertoireItem, RepertoireMove } from '../types/chess';
import { INITIAL_FEN } from '../utils/repertoire';
import { LIBRARY_SCHEMA_VERSION } from './schemas';

interface OpeningSeed {
  id: string;
  title: string;
  color: RepertoireItem['color'];
  lines: string[];
}

const OPENINGS: OpeningSeed[] = [
  {
    id: 'italian',
    title: 'Partie italienne',
    color: 'white',
    lines: [
      'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5',
      'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Be2',
      'e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6 O-O d6 c3 a6 Bb3 Ba7',
    ],
  },
  {
    id: 'ruy-lopez',
    title: 'Partie espagnole',
    color: 'white',
    lines: [
      'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O',
      'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6 d4 Bg4',
      'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6',
    ],
  },
  {
    id: 'queens-gambit',
    title: 'Gambit dame',
    color: 'white',
    lines: [
      'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4',
      'd4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5 c6 Qc2 Be7',
      'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O',
    ],
  },
  {
    id: 'london',
    title: 'Système de Londres',
    color: 'white',
    lines: [
      'd4 Nf6 Nf3 d5 Bf4 c5 e3 Nc6 c3 Qb6 Qb3 c4',
      'd4 d5 Nf3 Nf6 Bf4 c5 e3 Nc6 c3 Bg4 Nbd2 e6',
      'd4 Nf6 Bf4 g6 e3 Bg7 Nf3 d6 h3 O-O',
    ],
  },
  {
    id: 'sicilian',
    title: 'Défense sicilienne',
    color: 'black',
    lines: [
      'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5',
      'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6',
      'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6',
    ],
  },
  {
    id: 'french',
    title: 'Défense française',
    color: 'black',
    lines: [
      'e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7',
      'e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7',
      'e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6',
    ],
  },
  {
    id: 'caro-kann',
    title: 'Défense Caro-Kann',
    color: 'black',
    lines: [
      'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6',
      'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Nf3 Ngf6 Nxf6+ Nxf6',
      'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5',
    ],
  },
  {
    id: 'kings-indian',
    title: 'Défense est-indienne',
    color: 'black',
    lines: [
      'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6',
      'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 O-O Be3 e5 d5 Nh5',
      'd4 Nf6 c4 g6 Nf3 Bg7 g3 O-O Bg2 d6 O-O Nbd7',
    ],
  },
];

function buildRoot(lines: string[]): RepertoireItem['root'] {
  const root: RepertoireItem['root'] = { fen: INITIAL_FEN, children: [] };
  for (const line of lines) {
    const chess = new Chess();
    let siblings = root.children;
    for (const san of line.split(' ')) {
      const move = chess.move(san);
      const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
      let node = siblings.find((candidate) => candidate.uci === uci);
      if (!node) {
        const next: RepertoireMove = {
          coup: move.san,
          san: move.san,
          uci,
          parties: 0,
          victoires_blancs: 0,
          nuls: 0,
          victoires_noirs: 0,
          fen: chess.fen(),
          children: [],
        };
        siblings.push(next);
        node = next;
      }
      siblings = node.children ?? (node.children = []);
    }
  }
  return root;
}

export function createDefaultOpenings(): RepertoireItem[] {
  const now = new Date().toISOString();
  return OPENINGS.map(({ id, title, color, lines }) => ({
    id: `rep_seed_${id}`,
    title,
    color,
    targetElo: 'all_700',
    createdAt: now,
    updatedAt: now,
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    root: buildRoot(lines),
  }));
}
