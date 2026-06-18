// Central game balance data: towers, upgrades, enemies, abilities, economy.

export interface TowerSpec {
  id: string;
  name: string;
  cost: number;
  range: number;
  damage: number;
  /** Shots per second. */
  fireRate: number;
  /** World units per second. 0 means an instant hitscan beam. */
  projectileSpeed: number;
  color: number;
  /** Area damage radius on impact (cannon, frost). */
  splashRadius?: number;
  /** Multiplier applied to enemy speed while slowed (frost). */
  slowFactor?: number;
  slowDuration?: number;
  /** Lightning: chains between this many enemies at Lv.1 (+1 per level). */
  chain?: number;
  /** Frost: damage multiplier applied to enemies while they are slowed/exposed. */
  exposesMult?: number;
  /** Short tagline shown in the instructions panel. */
  role?: string;
  weakness?: string;
  description: string;
}

export const TOWER_TYPES: TowerSpec[] = [
  {
    id: 'basic', name: 'Basic', cost: 250, range: 6, damage: 140, fireRate: 1.2,
    projectileSpeed: 18, color: 0x4aa3ff,
    role: 'Reliable all-rounder', weakness: 'Master of none',
    description: 'Balanced cost, damage, range and fire rate.',
  },
  {
    id: 'rapid', name: 'Rapid', cost: 400, range: 4.5, damage: 50, fireRate: 5,
    projectileSpeed: 24, color: 0x2dd4bf,
    role: 'Shreds fast, weak targets', weakness: 'Bounces off armor',
    description: 'Very fast fire rate. Weak against armor.',
  },
  {
    id: 'sniper', name: 'Sniper', cost: 650, range: 13, damage: 600, fireRate: 0.45,
    projectileSpeed: 0, color: 0xa78bfa,
    role: 'Long-range armor-piercer', weakness: 'Slow, single-target',
    description: 'Huge range, heavy beam. Punches through armor.',
  },
  {
    id: 'frost', name: 'Frost', cost: 500, range: 5.5, damage: 60, fireRate: 1.4,
    projectileSpeed: 16, color: 0x7dd3fc,
    splashRadius: 2.6, slowFactor: 0.5, slowDuration: 2.5, exposesMult: 1.4,
    role: 'AOE slow + expose support', weakness: 'Low direct damage',
    description: 'AOE: slows a cluster to 50% speed and exposes them (+40% damage taken from all towers).',
  },
  {
    id: 'cannon', name: 'Cannon', cost: 850, range: 5.5, damage: 380, fireRate: 0.65,
    projectileSpeed: 14, color: 0xf59e0b, splashRadius: 2.8,
    role: 'Splash vs crowds', weakness: 'Short range, slow reload',
    description: 'Splash shells. Great against swarms and hordes.',
  },
  {
    id: 'lightning', name: 'Tesla', cost: 1100, range: 7, damage: 500, fireRate: 0.8,
    projectileSpeed: 0, color: 0xffe14d, chain: 3,
    role: 'Chains through packs', weakness: 'Pricey; damage falls off per jump',
    description: 'Chains lightning between 3 enemies (+1 per level).',
  },
];

// ---------------------------------------------------------------- upgrades

export const MAX_LEVEL = 5;

export function upgradeCost(spec: TowerSpec, currentLevel: number): number {
  return Math.round(spec.cost * 1.0 * currentLevel);
}

export function levelDamage(spec: TowerSpec, level: number): number {
  return Math.round(spec.damage * Math.pow(1.32, level - 1));
}

export function levelRange(spec: TowerSpec, level: number): number {
  return spec.range + 0.6 * (level - 1);
}

export function levelFireRate(spec: TowerSpec, level: number): number {
  return spec.fireRate * Math.pow(1.14, level - 1);
}

// ---------------------------------------------------------------- enemies

export interface EnemySpec {
  id: string;
  name: string;
  hp: number;
  speed: number;
  reward: number;
  livesCost: number;
  color: number;
  size: number;
  shape: 'box' | 'cone' | 'sphere' | 'swarm' | 'armored' | 'regen' | 'boss';
  /** Flat damage reduction per hit (min 25% of the hit still lands). */
  armor?: number;
  /** HP regenerated per second. */
  regen?: number;
  /** Instructions-panel copy. */
  trait?: string;
  counter?: string;
}

export const ENEMY_TYPES: Record<string, EnemySpec> = {
  grunt:   { id: 'grunt',   name: 'Grunt',   hp: 600,   speed: 2.2, reward: 30,  livesCost: 1,  color: 0xc0392b, size: 0.8,  shape: 'box',
             trait: 'Standard footsoldier', counter: 'Any tower handles them' },
  runner:  { id: 'runner',  name: 'Runner',  hp: 340,   speed: 4.2, reward: 30,  livesCost: 1,  color: 0xe67e22, size: 0.7,  shape: 'cone',
             trait: 'Very fast, fragile', counter: 'Frost slow + Rapid' },
  swarm:   { id: 'swarm',   name: 'Swarmer', hp: 180,   speed: 3.4, reward: 10,  livesCost: 1,  color: 0xf1c40f, size: 0.45, shape: 'swarm',
             trait: 'Tiny, attacks in numbers', counter: 'Cannon / Tesla splash' },
  tank:    { id: 'tank',    name: 'Tank',    hp: 3000,  speed: 1.3, reward: 90,  livesCost: 2,  color: 0x6c3483, size: 1.15, shape: 'sphere',
             trait: 'Huge HP, slow, costs 2 lives', counter: 'Sniper + sustained DPS' },
  armored: { id: 'armored', name: 'Ironback', hp: 1700, speed: 1.8, reward: 80,  livesCost: 1,  color: 0x8492a8, size: 0.9,  shape: 'armored', armor: 50,
             trait: 'Flat armor blunts small hits', counter: 'Sniper / high per-hit damage' },
  regen:   { id: 'regen',   name: 'Troll',   hp: 2100,  speed: 1.9, reward: 80,  livesCost: 1,  color: 0x27ae60, size: 0.95, shape: 'regen', regen: 70,
             trait: 'Heals itself over time', counter: 'Burst it down before it recovers' },
  boss:    { id: 'boss',    name: 'BOSS',    hp: 14000, speed: 1.05, reward: 900, livesCost: 10, color: 0x7b1020, size: 1.6,  shape: 'boss', armor: 30, regen: 80,
             trait: 'Armor + regen + massive HP, costs 10 lives', counter: 'Frost expose, then focus everything' },
};

// ---------------------------------------------------------------- abilities

export interface AbilitySpec {
  id: string;
  name: string;
  manaCost: number;
  cooldown: number;
  /** Gold cost to unlock the ability (it starts locked). */
  unlockCost: number;
  color: string;
  key: string;
  icon: string;
  description: string;
}

export const ABILITIES: AbilitySpec[] = [
  {
    id: 'meteor', name: 'Meteor Strike', manaCost: 100, cooldown: 14, unlockCost: 600,
    color: '#ff7a3c', key: 'Q', icon: '☄',
    description: 'Click the map to call down a meteor for heavy area damage. Upgrades grow the blast.',
  },
  {
    id: 'heal', name: 'Heal', manaCost: 70, cooldown: 15, unlockCost: 400,
    color: '#3ecf6e', key: 'W', icon: '✚',
    description: 'Repair the crystal. Upgrades restore more HP.',
  },
  {
    id: 'frenzy', name: 'Frenzy', manaCost: 110, cooldown: 25, unlockCost: 700,
    color: '#62a0ff', key: 'E', icon: '⚡',
    description: 'All towers fire much faster for a few seconds. Upgrades boost rate and duration.',
  },
];

export const ABILITY_MAX_LEVEL = 5;

/** Gold to upgrade an ability from `level` to `level+1`. */
export function abilityUpgradeCost(spec: AbilitySpec, level: number): number {
  return Math.round(spec.unlockCost * 0.6 * level);
}

// Level-scaled ability magnitudes (level is 1..5).
export const METEOR_RADIUS = 3; // base radius, kept for callers that need a constant
export function meteorDamage(level: number): number {
  return Math.round(1600 * (1 + 0.4 * (level - 1))); // 1600 -> 4160
}
export function meteorRadius(level: number): number {
  return 3 + 0.35 * (level - 1); // 3 -> 4.4
}
export function healAmount(level: number): number {
  return 3 + (level - 1); // 3 -> 7
}
export function frenzyMult(level: number): number {
  return 1.8 + 0.12 * (level - 1); // 1.8 -> 2.28
}
export function frenzyDuration(level: number): number {
  return 8 + 1.5 * (level - 1); // 8 -> 14
}

// ---------------------------------------------------------------- economy & scaling

export const START_GOLD = 1200;
export const START_LIVES = 15;
export const START_MANA = 60;
export const MANA_MAX = 300;
export const MANA_REGEN = 4;       // per second while a wave is active
export const MANA_PER_KILL = 1;
export const SELL_REFUND = 0.65;

// ---------------------------------------------------------------- endless levels

export const WAVES_PER_LEVEL = 10;
/** Fraction of invested tower gold returned when a level ends and the map regenerates. */
export const LEVEL_SALVAGE = 0.6;
/** Crystal HP restored on level completion. */
export const LEVEL_HEAL = 5;
/** Seconds before the next wave auto-starts. */
export const WAVE_COUNTDOWN = 5;
/** Build-time between levels before wave 1 auto-starts. */
export const LEVEL_COUNTDOWN = 12;

/** All scaling uses the global wave index: (level-1)*10 + wave. */
export function waveHpMult(globalWave: number): number {
  // Gentle early game, steep late game.
  const w = globalWave - 1;
  return 1 + w * 0.22 + w * w * 0.013;
}

export function waveSpeedMult(globalWave: number): number {
  return Math.min(1 + (globalWave - 1) * 0.025, 1.6);
}

export function waveBonus(globalWave: number): number {
  return 150 + globalWave * 40;
}

/** Kill rewards grow with level so rebuilding stays possible (but never keeps pace with HP). */
export function levelRewardMult(level: number): number {
  return 1 + 0.35 * (level - 1);
}
