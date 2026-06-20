// Wave generation drives the whole game's difficulty + the daily-challenge
// reproducibility, so its structure and determinism are worth guarding.
import { describe, it, expect } from 'vitest';
import { generateLevel } from '../src/waves';
import { WAVES_PER_LEVEL } from '../src/config';
import { makeRng } from '../src/rng';

describe('generateLevel', () => {
  it('produces exactly WAVES_PER_LEVEL waves', () => {
    const waves = generateLevel(makeRng(1), 1);
    expect(waves).toHaveLength(WAVES_PER_LEVEL);
  });

  it('places bosses on waves 5 and 10, and not elsewhere', () => {
    const waves = generateLevel(makeRng(42), 1);
    waves.forEach((w, i) => {
      const waveNum = i + 1;
      expect(w.boss).toBe(waveNum === 5 || waveNum === WAVES_PER_LEVEL);
    });
  });

  it('every wave has at least one spawn group with a positive count', () => {
    const waves = generateLevel(makeRng(3), 2);
    for (const w of waves) {
      expect(w.groups.length).toBeGreaterThan(0);
      for (const g of w.groups) expect(g.count).toBeGreaterThan(0);
    }
  });

  it('is fully deterministic for a given seed (daily challenges depend on this)', () => {
    const a = JSON.stringify(generateLevel(makeRng(2024), 3));
    const b = JSON.stringify(generateLevel(makeRng(2024), 3));
    expect(a).toBe(b);
  });

  it('Boss Rush forces a boss into every wave', () => {
    const waves = generateLevel(makeRng(5), 1, { bossEveryWave: true });
    expect(waves.every((w) => w.boss)).toBe(true);
  });

  it('boss waves include a boss group', () => {
    const waves = generateLevel(makeRng(9), 1);
    const finale = waves[WAVES_PER_LEVEL - 1];
    expect(finale.groups.some((g) => g.type === 'boss')).toBe(true);
  });
});
