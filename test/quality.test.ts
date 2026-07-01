// The graphics-quality mode persists to localStorage and defaults to 'quality'
// (which must reproduce the game's original render settings).
import { describe, it, expect, beforeEach } from 'vitest';
import { QUALITY, loadQuality, saveQuality } from '../src/quality';

describe('quality mode', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to quality when nothing is stored', () => {
    expect(loadQuality()).toBe('quality');
  });

  it('round-trips a saved performance choice', () => {
    saveQuality('performance');
    expect(loadQuality()).toBe('performance');
  });

  it('falls back to quality on a garbage stored value', () => {
    localStorage.setItem('cd-quality', 'nonsense');
    expect(loadQuality()).toBe('quality');
  });

  it('quality tier reproduces the original render settings', () => {
    expect(QUALITY.quality).toMatchObject({
      maxPixelRatio: 2, antialias: true, bloom: true, shadows: true, grade: true,
      stars: 700, damageCap: 90, extras: true,
    });
  });

  it('performance keeps full resolution but strips the heavy effects', () => {
    // Resolution/AA are unchanged (crisp image); the effects are what drop.
    expect(QUALITY.performance.maxPixelRatio).toBe(2);
    expect(QUALITY.performance.antialias).toBe(true);
    expect(QUALITY.performance.bloom).toBe(false);
    expect(QUALITY.performance.shadows).toBe(false);
    expect(QUALITY.performance.grade).toBe(false);
    expect(QUALITY.performance.stars).toBe(0);
    expect(QUALITY.performance.extras).toBe(false);
  });
});
