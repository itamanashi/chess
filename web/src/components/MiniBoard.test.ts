import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { fenAfterSans } from './MiniBoard';

describe('fenAfterSans', () => {
  it('plays SANs from the start position', () => {
    const fen = fenAfterSans(['e4', 'c5']);
    expect(fen).not.toBeNull();
    const board = new Chess(fen as string);
    expect(board.turn()).toBe('w');
    expect(board.get('e4')).toMatchObject({ type: 'p', color: 'w' });
    expect(board.get('c5')).toMatchObject({ type: 'p', color: 'b' });
  });

  it('returns null on empty or illegal lines', () => {
    expect(fenAfterSans([])).toBeNull();
    expect(fenAfterSans(['e4', 'e4'])).toBeNull();
  });
});
