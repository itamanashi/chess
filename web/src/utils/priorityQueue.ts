/**
 * File de priorité basée sur un tas binaire (Binary Heap).
 *
 * Contrairement à un tableau que l'on trie via `array.sort()` en O(N log N)
 * suivi de `array.shift()` en O(N) à chaque itération, le tas binaire garantit :
 * - Insertion (push) : O(log N)
 * - Extraction du maximum (pop) : O(log N)
 * - Consultation (peek) : O(1)
 *
 * Sans allocation intermédiaire ni réindexation globale du tableau.
 */
export class PriorityQueue<T> {
  private readonly data: T[] = [];
  private readonly isHigherPriority: (a: T, b: T) => boolean;

  constructor(isHigherPriority: (a: T, b: T) => boolean) {
    this.isHigherPriority = isHigherPriority;
  }

  get length(): number {
    return this.data.length;
  }

  push(item: T): void {
    this.data.push(item);
    this.siftUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const bottom = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = bottom;
      this.siftDown(0);
    }
    return top;
  }

  peek(): T | undefined {
    return this.data[0];
  }

  clear(): void {
    this.data.length = 0;
  }

  private siftUp(index: number): void {
    let i = index;
    const item = this.data[i];
    while (i > 0) {
      const parentIdx = (i - 1) >> 1;
      const parent = this.data[parentIdx];
      if (this.isHigherPriority(item, parent)) {
        this.data[i] = parent;
        i = parentIdx;
      } else {
        break;
      }
    }
    this.data[i] = item;
  }

  private siftDown(index: number): void {
    let i = index;
    const item = this.data[i];
    const half = this.data.length >> 1;
    while (i < half) {
      const left = (i << 1) + 1;
      const right = left + 1;
      let bestIdx = left;
      let bestItem = this.data[left];
      if (right < this.data.length && this.isHigherPriority(this.data[right], bestItem)) {
        bestIdx = right;
        bestItem = this.data[right];
      }
      if (this.isHigherPriority(bestItem, item)) {
        this.data[i] = bestItem;
        i = bestIdx;
      } else {
        break;
      }
    }
    this.data[i] = item;
  }
}
