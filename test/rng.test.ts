// The seeded RNG underpins reproducible runs (and identical daily challenges
// for every player), so determinism + ranges must hold.
import { describe, it, expect } from 'vitest';
import { makeRng, randInt, randRange, pick, chance } from '../src/rng';

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences', () => {
    const a = Array.from({ length: 10 }, makeRng(1));
    const b = Array.from({ length: 10 }, makeRng(2));
    expect(a).not.toEqual(b);
  });

  it('returns values in [0, 1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('helpers', () => {
  it('randInt stays within [min, max] inclusive', () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = randInt(r, 3, 8);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(8);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('randRange stays within [min, max)', () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = randRange(r, 2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThan(5);
    }
  });

  it('pick always returns an element of the array', () => {
    const r = makeRng(7);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) expect(arr).toContain(pick(r, arr));
  });

  it('chance(0) is never true and chance(1) is always true', () => {
    const r = makeRng(7);
    for (let i = 0; i < 100; i++) {
      expect(chance(r, 0)).toBe(false);
      expect(chance(r, 1)).toBe(true);
    }
  });
});
