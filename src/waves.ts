// Procedural wave generation for endless mode: every level is 10 waves,
// scaled by the global wave index so difficulty keeps climbing across levels.

import { ENEMY_TYPES, WAVES_PER_LEVEL } from './config';
import { chance, pick, randInt, randRange } from './rng';
import type { RNG } from './rng';

export interface SpawnGroup {
  type: string;
  count: number;
  interval: number;
  delay: number;
  /** Extra HP multiplier for this group (boss tuning + capped-count overflow). */
  hpScale: number;
}

export interface WaveModifier {
  id: string;
  name: string;
  hpMult: number;
  speedMult: number;
  countMult: number;
  armorBonus: number;
  regenBonus: number;
  rewardMult: number;
  minWave: number; // global wave index
}

export interface GeneratedWave {
  groups: SpawnGroup[];
  modifier: WaveModifier | null;
  /** Short human-readable preview, e.g. "IRONCLAD Tanks + BOSS". */
  hint: string;
  boss: boolean;
}

const MODIFIERS: WaveModifier[] = [
  { id: 'fast',    name: 'LIGHTNING', hpMult: 0.85, speedMult: 1.4,  countMult: 1,   armorBonus: 0, regenBonus: 0, rewardMult: 1.1,  minWave: 3 },
  { id: 'horde',   name: 'HORDE',     hpMult: 0.75, speedMult: 1,    countMult: 1.7, armorBonus: 0, regenBonus: 0, rewardMult: 0.8,  minWave: 3 },
  { id: 'armored', name: 'IRONCLAD',  hpMult: 1,    speedMult: 0.95, countMult: 1,   armorBonus: 40, regenBonus: 0,  rewardMult: 1.25, minWave: 5 },
  { id: 'regen',   name: 'UNDYING',   hpMult: 1,    speedMult: 1,    countMult: 1,   armorBonus: 0,  regenBonus: 50, rewardMult: 1.25, minWave: 7 },
  { id: 'elite',   name: 'ELITE',     hpMult: 1.5,  speedMult: 1.05, countMult: 0.8, armorBonus: 10, regenBonus: 0,  rewardMult: 1.5,  minWave: 5 },
];

/** Budget cost, spawn pacing and availability (by global wave) per enemy type. */
const TYPE_INFO: Record<string, { cost: number; interval: number; minWave: number; weight: (gw: number) => number }> = {
  grunt:   { cost: 1,    interval: 0.9,  minWave: 1, weight: (gw) => Math.max(0.6, 3 - gw * 0.15) },
  runner:  { cost: 1.1,  interval: 0.55, minWave: 2, weight: (gw) => 1 + gw * 0.05 },
  swarm:   { cost: 0.45, interval: 0.3,  minWave: 3, weight: (gw) => 0.8 + gw * 0.05 },
  tank:    { cost: 3,    interval: 1.6,  minWave: 4, weight: (gw) => gw * 0.14 },
  armored: { cost: 2.6,  interval: 1.3,  minWave: 6, weight: (gw) => gw * 0.14 },
  regen:   { cost: 2.4,  interval: 1.4,  minWave: 8, weight: (gw) => gw * 0.12 },
};

/** Hard cap on enemies per group; excess budget converts into extra HP instead. */
const MAX_GROUP_COUNT = 60;

function pickType(rng: RNG, gw: number): string {
  const w = Math.min(gw, 25); // stop skewing weights past this point
  const candidates = Object.entries(TYPE_INFO).filter(([, info]) => gw >= info.minWave);
  let total = 0;
  for (const [, info] of candidates) total += info.weight(w);
  let roll = rng() * total;
  for (const [type, info] of candidates) {
    roll -= info.weight(w);
    if (roll <= 0) return type;
  }
  return candidates[candidates.length - 1][0];
}

function buildHint(groups: SpawnGroup[], modifier: WaveModifier | null, boss: boolean): string {
  let bestType = 'grunt';
  let bestThreat = -1;
  for (const g of groups) {
    if (g.type === 'boss') continue;
    const threat = g.count * (TYPE_INFO[g.type]?.cost ?? 1);
    if (threat > bestThreat) {
      bestThreat = threat;
      bestType = g.type;
    }
  }
  const name = `${ENEMY_TYPES[bestType].name}s`;
  return `${modifier ? modifier.name + ' ' : ''}${name}${boss ? ' + BOSS' : ''}`;
}

export interface WaveGenOpts {
  /** Force a boss into every wave (Boss Rush challenge). */
  bossEveryWave?: boolean;
}

function generateWave(rng: RNG, wave: number, gw: number, level: number, opts: WaveGenOpts): GeneratedWave {
  const boss = wave === 5 || wave === WAVES_PER_LEVEL || !!opts.bossEveryWave;
  const modChance = Math.min(0.45 + (level - 1) * 0.08, 0.7);
  const modifier = !boss && gw >= 3 && chance(rng, modChance)
    ? pick(rng, MODIFIERS.filter((m) => gw >= m.minWave))
    : null;

  const pace = Math.max(0.5, 1 - gw * 0.015);
  let budget = (7 + gw * 2.5 + gw * gw * 0.22) * (modifier?.countMult ?? 1);
  if (boss) budget *= 0.55; // escorts share the wave with the boss

  const groups: SpawnGroup[] = [];
  const groupCount = randInt(rng, 2, Math.min(4, 1 + Math.ceil(gw / 3)));
  for (let i = 0; i < groupCount && budget > 0; i++) {
    const share = i === groupCount - 1 ? budget : budget * randRange(rng, 0.3, 0.6);
    budget -= share;
    const type = pickType(rng, gw);
    const info = TYPE_INFO[type];
    const ideal = Math.max(1, Math.round(share / info.cost));
    const count = Math.min(ideal, MAX_GROUP_COUNT);
    groups.push({
      type,
      count,
      interval: info.interval * randRange(rng, 0.95, 1.25) * pace,
      delay: i === 0 ? 0.5 : randRange(rng, 1, 3),
      hpScale: ideal / count, // capped counts come back as beefier enemies
    });
  }

  if (boss) {
    const finale = wave === WAVES_PER_LEVEL;
    const scheduled = wave === 5 || wave === WAVES_PER_LEVEL;
    groups.push({
      type: 'boss',
      // Boss Rush's extra (unscheduled) bosses stay solo so off-waves aren't brutal.
      count: !scheduled ? 1 : finale ? Math.min(level, 3) : 1,
      interval: 2.5,
      delay: 3,
      hpScale: finale ? 0.85 : 0.6, // bosses scale on their own gentler curve
    });
  }

  return { groups, modifier, hint: buildHint(groups, modifier, boss), boss };
}

/** Generates the 10 waves for one level of the endless run. */
export function generateLevel(rng: RNG, level: number, opts: WaveGenOpts = {}): GeneratedWave[] {
  const waves: GeneratedWave[] = [];
  for (let w = 1; w <= WAVES_PER_LEVEL; w++) {
    const gw = (level - 1) * WAVES_PER_LEVEL + w;
    waves.push(generateWave(rng, w, gw, level, opts));
  }
  return waves;
}
