// The score-qualification gate decides whether a run makes the leaderboard.
import { describe, it, expect } from 'vitest';
import { qualifies } from '../src/leaderboard';
import type { ScoreEntry } from '../src/leaderboard';

const entry = (score: number): ScoreEntry => ({
  initials: 'AAA', score, level: 1, wave: 1, date: 0, kind: 'arcade', day: null, challenge: null,
  stats: null, version: null,
});

describe('qualifies', () => {
  it('any score qualifies when the board is not full', () => {
    expect(qualifies(1, [])).toBe(true);
    expect(qualifies(1, [entry(9999)])).toBe(true); // < 100 entries
  });

  it('on a full board, only a score above the lowest qualifies', () => {
    // 100 descending entries: 100, 99, ... 1 (lowest last).
    const full = Array.from({ length: 100 }, (_, i) => entry(100 - i));
    expect(qualifies(101, full)).toBe(true);  // beats the top
    expect(qualifies(2, full)).toBe(true);     // beats the lowest (1)
    expect(qualifies(1, full)).toBe(false);    // ties the lowest — does not place
    expect(qualifies(0, full)).toBe(false);    // below the lowest
  });
});
