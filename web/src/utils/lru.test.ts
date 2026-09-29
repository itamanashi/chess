import { describe, expect, it } from 'vitest';
import { LruCache } from './lru';

describe('LruCache', () => {
  it('stores and retrieves', () => {
    const c = new LruCache<string, number>(3);
    expect(c.get('a')).toBeUndefined();
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.has('a')).toBe(true);
    expect(c.size).toBe(1);
  });

  it('evicts the eldest entry past capacity', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.has('a')).toBe(false);
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.size).toBe(2);
  });

  it('refreshes recency on get', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // 'a' is now most recent
    c.set('c', 3); // evicts 'b', not 'a'
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
  });

  it('overwriting refreshes without growing', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 10);
    expect(c.size).toBe(2);
    expect(c.get('a')).toBe(10);
  });

  it('capacity < 1 disables caching', () => {
    const c = new LruCache<string, number>(0);
    c.set('a', 1);
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('supports delete + clear', () => {
    const c = new LruCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.delete('a')).toBe(true);
    expect(c.has('a')).toBe(false);
    c.clear();
    expect(c.size).toBe(0);
  });
});
