/**
 * Bounded LRU cache (Map insertion order = recency).
 *
 * `get` refreshes recency; `set` evicts the eldest entry while over capacity.
 * Capacity < 1 disables caching (stores nothing). Not thread-safe by design —
 * JS is single-threaded; concurrent async users share instances safely as
 * long as get/set pairs stay synchronous (they do).
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Lecture SANS rafraîchir la récence (snapshots, persistance). */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  /** Clés de la plus ancienne à la plus récente. */
  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  set(key: K, value: V): void {
    if (this.capacity < 1) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const eldest = this.map.keys().next();
      if (eldest.done) break;
      this.map.delete(eldest.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
