// Small seedable RNG (mulberry32) so each run can be a fresh random layout
// while staying reproducible within the run.

export type RNG = () => number;

export function makeRng(seed: number): RNG {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max] inclusive. */
export function randInt(rng: RNG, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Random float in [min, max). */
export function randRange(rng: RNG, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function pick<T>(rng: RNG, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function chance(rng: RNG, p: number): boolean {
  return rng() < p;
}
