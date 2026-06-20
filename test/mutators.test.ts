// Mutators must stay internally consistent: the draft is "net-neutral" (every
// pick has a buff AND a nerf), and the daily pool has exactly 10 entries since
// the calendar rotation indexes by `day % 10`.
import { describe, it, expect } from 'vitest';
import {
  DRAFT_POOL, DAILY_CHALLENGES, computeModifiers, defaultModifiers, localDayNumber,
} from '../src/mutators';

describe('draft pool', () => {
  it('every draft mutator has both a buff and a nerf (net-neutral)', () => {
    for (const m of DRAFT_POOL) {
      expect(m.category).toBe('draft');
      expect(m.buff.trim().length).toBeGreaterThan(0);
      expect(m.nerf.trim().length).toBeGreaterThan(0);
    }
  });

  it('mutator ids are unique', () => {
    const ids = DRAFT_POOL.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('daily challenges', () => {
  it('has exactly 10 (the rotation indexes day % 10)', () => {
    expect(DAILY_CHALLENGES).toHaveLength(10);
  });

  it('every challenge has a rule and unique id', () => {
    const ids = DAILY_CHALLENGES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of DAILY_CHALLENGES) {
      expect(m.category).toBe('challenge');
      expect(m.buff.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('localDayNumber', () => {
  it('returns the player local calendar day, rolling over at local midnight', () => {
    const d = new Date();
    const expected = Math.floor(
      Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000,
    );
    expect(localDayNumber()).toBe(expected);
  });

  it('matches the local date, which can differ from the UTC-epoch day', () => {
    // The local day is derived from local Y/M/D, so near a day boundary it can
    // legitimately differ from Math.floor(Date.now()/86_400_000) (the old UTC
    // computation). It must always equal the local calendar date's day index.
    const d = new Date();
    const localMidnightUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    expect(localDayNumber()).toBe(localMidnightUtc / 86_400_000);
  });
});

describe('computeModifiers', () => {
  it('with no mutators equals the defaults', () => {
    expect(computeModifiers([])).toEqual(defaultModifiers());
  });

  it('folds a single mutator (Glass Cannon: +100% damage, -5 lives)', () => {
    const glass = DRAFT_POOL.find((m) => m.id === 'glass-cannon')!;
    const m = computeModifiers([glass]);
    expect(m.towerDamageMult).toBeCloseTo(2);
    expect(m.startLivesDelta).toBe(-5);
  });

  it('stacks multiple mutators multiplicatively', () => {
    const a = DRAFT_POOL.find((m) => m.id === 'glass-cannon')!;     // x2 damage
    const b = DRAFT_POOL.find((m) => m.id === 'bargain-towers')!;   // x0.85 damage
    expect(computeModifiers([a, b]).towerDamageMult).toBeCloseTo(2 * 0.85);
  });
});
