import { describe, expect, it } from 'vitest';
import {
  ARROWHEAD,
  ARROW_OPACITY,
  brushColor,
  isKnightJump,
  knightArrowPath,
  knightElbow,
  splitBoardShapes,
  squareCenter,
} from './knightArrows';

describe('isKnightJump', () => {
  it('reconnaît les 8 bonds depuis e4', () => {
    for (const dest of ['d6', 'f6', 'c5', 'g5', 'c3', 'g3', 'd2', 'f2']) {
      expect(isKnightJump('e4', dest)).toBe(true);
    }
  });

  it('rejette les autres pièces et les cases invalides', () => {
    expect(isKnightJump('e2', 'e4')).toBe(false); // pion
    expect(isKnightJump('c1', 'h6')).toBe(false); // fou
    expect(isKnightJump('a1', 'a8')).toBe(false); // tour
    expect(isKnightJump('e1', 'e2')).toBe(false); // roi
    expect(isKnightJump('', 'e4')).toBe(false);
  });
});

describe('squareCenter', () => {
  it('blancs : a1 en bas à gauche, h8 en haut à droite', () => {
    expect(squareCenter('a1', 'white')).toEqual({ x: 0.5, y: 7.5 });
    expect(squareCenter('h8', 'white')).toEqual({ x: 7.5, y: 0.5 });
    expect(squareCenter('g1', 'white')).toEqual({ x: 6.5, y: 7.5 });
  });

  it('noirs : miroir complet', () => {
    expect(squareCenter('a1', 'black')).toEqual({ x: 7.5, y: 0.5 });
    expect(squareCenter('h8', 'black')).toEqual({ x: 0.5, y: 7.5 });
  });
});

describe('knightElbow', () => {
  it('part par la grande branche : Cf3-g5 via f5, Cb1-c3 via b3', () => {
    expect(knightElbow('f3', 'g5')).toEqual({ file: 5, rank: 5 }); // f5
    expect(knightElbow('b1', 'c3')).toEqual({ file: 1, rank: 3 }); // b3 (2 cases : b1-b3)
    expect(knightElbow('g1', 'e2')).toEqual({ file: 4, rank: 1 }); // e1 (grande branche horizontale : g1-e1)
  });
});

describe('knightArrowPath', () => {
  it('trace M→coude→pointe raccourcie (blancs, Cf3-g5)', () => {
    // f3 (5.5,5.5) → coude f5 (5.5,3.5) → pointe avant g5 (6.5,3.5),
    // dernier segment horizontal (même rangée 5).
    const d = knightArrowPath('f3', 'g5', 'white');
    expect(d.startsWith('M ')).toBe(true);
    expect(d).toContain('L 5.5 3.5');
    const end = d.split('L ')[2].split(' ').map(Number);
    expect(end[0]).toBeGreaterThan(5.5);
    expect(end[0]).toBeLessThan(6.5);
    expect(end[1]).toBeCloseTo(3.5, 2);
    // La pointe s'arrête à ~0.34 du centre d'arrivée (place pour la tête).
    expect(Math.hypot(6.5 - end[0], 3.5 - end[1])).toBeCloseTo(0.34, 1);
  });

  it('noirs : le même coup est miroir', () => {
    const w = knightArrowPath('f3', 'g5', 'white');
    const b = knightArrowPath('f3', 'g5', 'black');
    // Miroir central (x → 8−x, y → 8−y), arrondi identique.
    const nums = (s: string): number[] => s.split(/[ML ]+/).filter(Boolean).map(Number);
    const nw = nums(w);
    const nb = nums(b);
    expect(nb).toHaveLength(nw.length);
    for (let i = 0; i < nw.length; i += 2) {
      expect(nb[i]).toBeCloseTo(8 - nw[i], 1);
      expect(nb[i + 1]).toBeCloseTo(8 - nw[i + 1], 1);
    }
  });
});

describe('parité visuelle avec Chessground', () => {
  it('opacité 0.6 comme le calque .cg-shapes de Chessground (chessground.base.css)', () => {
    expect(ARROW_OPACITY).toBe(0.6);
  });

  it('la tête couvre le bout rond du trait (aucun rond ne dépasse de la pointe)', () => {
    // Triangle M0,0 V4 L3,2 Z : demi-hauteur à refX ≥ rayon du linecap rond (0.5).
    const halfHeightAtRef = 2 * (1 - ARROWHEAD.refX / 3);
    expect(halfHeightAtRef).toBeGreaterThan(0.5);
  });
});

describe('brushColor', () => {  it('palette Chessground + repli gris', () => {
    expect(brushColor('green')).toBe('#15781B');
    expect(brushColor('blue')).toBe('#003088');
    expect(brushColor('yellow')).toBe('#e68f00');
    expect(brushColor('inconnu')).toBe('#4a4a4a');
  });
});

describe('splitBoardShapes', () => {
  it('sépare cavaliers et droites, garde les cercles côté Chessground', () => {
    const shapes = [
      { orig: 'e2', dest: 'e4', brush: 'green' },
      { orig: 'g1', dest: 'f3', brush: 'blue' },
      { orig: 'e4', brush: 'red' },
    ];
    const { straight, knight } = splitBoardShapes(shapes);
    expect(straight).toHaveLength(2);
    expect(knight).toHaveLength(1);
    expect(knight[0].dest).toBe('f3');
  });
});
