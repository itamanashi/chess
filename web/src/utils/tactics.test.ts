import { describe, expect, it } from 'vitest';
import { detectTactics, filterReportForMove, squareToCell, tacticsToShapes } from './tactics';

const ALL_ON = { attack: true, defense: true, pin: true, fork: true };

describe('detectTactics', () => {
  it('détecte une pièce attaquée (Dame h5 × pions e5/f7)', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2';
    const rep = detectTactics(fen, 'w');
    const squares = rep.attacks.map((a) => a.square);
    expect(squares).toContain('e5');
    expect(squares).toContain('f7');
    expect(squares).not.toContain('e8'); // le roi est exclu (échec déjà signalé)
    expect(rep.attacks.find((a) => a.square === 'e5')?.by).toContain('h5');
  });

  it('ne montre une défense que sur pièce attaquée (e4 × d5, tenu par Cc3)', () => {
    const fen = '4k3/8/8/3p4/4P3/2N5/PPPP1PPP/RNBQK2R w - - 0 1';
    const rep = detectTactics(fen, 'w');
    expect(rep.defenses).toEqual([{ square: 'e4', by: ['c3'] }]);
  });

  it('détecte un clouage (Fb5 cloue Cc6 sur Re8)', () => {
    const fen = 'r1bqkbnr/ppp1pppp/2n5/1B1p4/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1';
    const rep = detectTactics(fen, 'b');
    expect(rep.pins).toEqual([{ square: 'c6', pinnedBy: 'b5' }]);
  });

  it('détecte une fourchette (Cc6 × Dd8+Te7)', () => {
    const fen = '3qk3/4r3/2N5/8/8/8/8/4K3 w - - 0 1';
    const rep = detectTactics(fen, 'w');
    expect(rep.forks).toHaveLength(1);
    expect(rep.forks[0].square).toBe('c6');
    expect(rep.forks[0].targets).toContain('d8');
    expect(rep.forks[0].targets).toContain('e7');
  });

  it('position initiale : rien à signaler (les défenses sans menace sont tues)', () => {
    const rep = detectTactics('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(rep).toEqual({ attacks: [], defenses: [], pins: [], forks: [] });
  });

  it('FEN invalide → rapport vide sans exception', () => {
    expect(detectTactics('nimporte quoi')).toEqual({ attacks: [], defenses: [], pins: [], forks: [] });
  });
});

describe('filterReportForMove + tacticsToShapes', () => {
  // Dernier coup : Fb5 (clouage du Cc6, attaque e5 via la diagonale ? non : on teste le clouage).
  const fen = 'r1bqkbnr/ppp1pppp/2n5/1B1p4/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1';

  it('ne garde que les motifs créés par la pièce arrivée', () => {
    const full = detectTactics(fen, 'b');
    const filtered = filterReportForMove(full, 'b5');
    expect(filtered.pins).toEqual([{ square: 'c6', pinnedBy: 'b5' }]);
    // La fourchette éventuelle d'une autre pièce ne passe pas le filtre.
    for (const f of filtered.forks) expect(f.square).toBe('b5');
    for (const a of filtered.attacks) expect(a.by).toContain('b5');
    // Le Cc6 est tenu par le pion b7, mais pas par le Fb5 : défense écartée.
    expect(filtered.defenses).toEqual([]);
  });

  it('convertit en flèches Chessground (jaune = clouage)', () => {
    const full = detectTactics(fen, 'b');
    const shapes = tacticsToShapes(filterReportForMove(full, 'b5'), 'b5', ALL_ON);
    expect(shapes).toContainEqual({ orig: 'b5', dest: 'c6', brush: 'yellow' });
  });

  it('les motifs désactivés ne produisent aucune flèche', () => {
    const full = detectTactics(fen, 'b');
    const shapes = tacticsToShapes(filterReportForMove(full, 'b5'), 'b5', { ...ALL_ON, pin: false });
    expect(shapes.some((s) => s.brush === 'yellow')).toBe(false);
  });

  it('défense en bleu (Cc3 → e4 tenu)', () => {
    const full = detectTactics('4k3/8/8/3p4/4P3/2N5/PPPP1PPP/RNBQK2R w - - 0 1', 'w');
    const shapes = tacticsToShapes(filterReportForMove(full, 'c3'), 'c3', ALL_ON);
    expect(shapes).toContainEqual({ orig: 'c3', dest: 'e4', brush: 'blue' });
    expect(shapes).toContainEqual({ orig: 'c3', dest: 'd5', brush: 'red' });
  });

  it('fourchette en rouge, dédupliquée des attaques', () => {
    const full = detectTactics('3qk3/4r3/2N5/8/8/8/8/4K3 w - - 0 1', 'w');
    const shapes = tacticsToShapes(filterReportForMove(full, 'c6'), 'c6', ALL_ON);
    const red = shapes.filter((s) => s.brush === 'red');
    expect(red).toContainEqual({ orig: 'c6', dest: 'd8', brush: 'red' });
    expect(red).toContainEqual({ orig: 'c6', dest: 'e7', brush: 'red' });
    expect(red).toHaveLength(2);
  });
});

describe('squareToCell', () => {  it('orientation blanche : a1 en bas à gauche', () => {
    expect(squareToCell('a1', 'white')).toEqual({ row: 7, col: 0 });
    expect(squareToCell('h8', 'white')).toEqual({ row: 0, col: 7 });
  });

  it('orientation noire : plateau retourné', () => {
    expect(squareToCell('a1', 'black')).toEqual({ row: 0, col: 7 });
    expect(squareToCell('h8', 'black')).toEqual({ row: 7, col: 0 });
  });
});
