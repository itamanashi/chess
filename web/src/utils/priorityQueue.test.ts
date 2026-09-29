import { describe, expect, it } from 'vitest';
import { PriorityQueue } from './priorityQueue';

describe('PriorityQueue', () => {
  it('extrait les éléments dans l\'ordre de priorité max', () => {
    const pq = new PriorityQueue<number>((a, b) => a > b);
    const nums = [15, 3, 42, 8, 23, 4, 16, 50, 1];
    nums.forEach((n) => pq.push(n));

    expect(pq.length).toBe(nums.length);
    expect(pq.peek()).toBe(50);

    const extracted: number[] = [];
    while (pq.length > 0) {
      extracted.push(pq.pop()!);
    }

    expect(extracted).toEqual([50, 42, 23, 16, 15, 8, 4, 3, 1]);
    expect(pq.pop()).toBeUndefined();
    expect(pq.peek()).toBeUndefined();
  });

  it('gère les priorités complexes avec égalités et ordre d\'insertion', () => {
    interface Item {
      priority: number;
      order: number;
      id: string;
    }
    const pq = new PriorityQueue<Item>((a, b) => {
      if (a.priority !== b.priority) return a.priority > b.priority;
      return a.order < b.order;
    });

    pq.push({ priority: 10, order: 2, id: 'B' });
    pq.push({ priority: 20, order: 1, id: 'A' });
    pq.push({ priority: 10, order: 1, id: 'C' });
    pq.push({ priority: 5, order: 3, id: 'D' });

    expect(pq.pop()?.id).toBe('A'); // 20
    expect(pq.pop()?.id).toBe('C'); // 10, order 1
    expect(pq.pop()?.id).toBe('B'); // 10, order 2
    expect(pq.pop()?.id).toBe('D'); // 5
  });

  it('vide la file avec clear()', () => {
    const pq = new PriorityQueue<number>((a, b) => a > b);
    pq.push(1);
    pq.push(2);
    pq.clear();
    expect(pq.length).toBe(0);
    expect(pq.pop()).toBeUndefined();
  });
});
