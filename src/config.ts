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
  /** Area damage radius on impact (cannon). */
  splashRadius?: number;
  /** Multiplier applied to enemy speed while slowed (frost). */
  slowFactor?: number;
  slowDuration?: number;
  /** Lightning: chains between this many enemies at Lv.1 (+1 per level). */
  chain?: number;
  description: string;
}

export const TOWER_TYPES: TowerSpec[] = [
  {
    id: 'basic', name: 'Basic', cost: 250, range: 6, damage: 110, fireRate: 1.2,
    projectileSpeed: 18, color: 0x4aa3ff,
    description: 'Balanced cost, damage, range and fire rate.',
  },
  {
    id: 'rapid', name: 'Rapid', cost: 400, range: 4.5, damage: 50, fireRate: 5,
    projectileSpeed: 24, color: 0x2dd4bf,
    description: 'Very fast fire rate. Weak against armor.',
  },
  {
    id: 'sniper', name: 'Sniper', cost: 650, range: 13, damage: 600, fireRate: 0.45,
    projectileSpeed: 0, color: 0xa78bfa,
    description: 'Huge range, heavy beam. Punches through armor.',
  },
  {
    id: 'frost', name: 'Frost', cost: 500, range: 5, damage: 40, fireRate: 1.4,
    projectileSpeed: 16, color: 0x7dd3fc, slowFactor: 0.5, slowDuration: 2,
    description: 'Low damage but slows enemies to half speed.',
  },
  {
    id: 'cannon', name: 'Cannon', cost: 850, range: 5.5, damage: 300, fireRate: 0.65,
    projectileSpeed: 14, color: 0xf59e0b, splashRadius: 2.2,
    description: 'Splash shells. Great against swarms and hordes.',
  },
  {
    id: 'lightning', name: 'Tesla', cost: 1100, range: 7, damage: 500, fireRate: 0.8,
    projectileSpeed: 0, color: 0xffe14d, chain: 3,
    description: 'Chains lightning between 3 enemies (+1 per level).',
  },
];

// ---------------------------------------------------------------- upgrades

export const MAX_LEVEL = 3;

export function upgradeCost(spec: TowerSpec, currentLevel: number): number {
  return Math.round(spec.cost * 0.9 * currentLevel);
}

export function levelDamage(spec: TowerSpec, level: number): number {
  return Math.round(spec.damage * Math.pow(1.45, level - 1));
}

export function levelRange(spec: TowerSpec, level: number): number {
  return spec.range + 0.6 * (level - 1);
}

export function levelFireRate(spec: TowerSpec, level: number): number {
  return spec.fireRate * Math.pow(1.18, level - 1);
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
}

export const ENEMY_TYPES: Record<string, EnemySpec> = {
  grunt:   { id: 'grunt',   name: 'Grunt',   hp: 600,   speed: 2.2, reward: 30,  livesCost: 1,  color: 0xc0392b, size: 0.8,  shape: 'box' },
  runner:  { id: 'runner',  name: 'Runner',  hp: 340,   speed: 4.2, reward: 30,  livesCost: 1,  color: 0xe67e22, size: 0.7,  shape: 'cone' },
  swarm:   { id: 'swarm',   name: 'Swarmer', hp: 180,   speed: 3.4, reward: 10,  livesCost: 1,  color: 0xf1c40f, size: 0.45, shape: 'swarm' },
  tank:    { id: 'tank',    name: 'Tank',    hp: 3000,  speed: 1.3, reward: 90,  livesCost: 2,  color: 0x6c3483, size: 1.15, shape: 'sphere' },
  armored: { id: 'armored', name: 'Ironback', hp: 1700, speed: 1.8, reward: 80,  livesCost: 1,  color: 0x8492a8, size: 0.9,  shape: 'armored', armor: 50 },
  regen:   { id: 'regen',   name: 'Troll',   hp: 2100,  speed: 1.9, reward: 80,  livesCost: 1,  color: 0x27ae60, size: 0.95, shape: 'regen', regen: 70 },
  boss:    { id: 'boss',    name: 'BOSS',    hp: 14000, speed: 1.05, reward: 900, livesCost: 10, color: 0x7b1020, size: 1.6,  shape: 'boss', armor: 30, regen: 80 },
};

// ---------------------------------------------------------------- abilities

export interface AbilitySpec {
  id: string;
  name: string;
  manaCost: number;
  cooldown: number;
  color: string;
  key: string;
  icon: string;
  description: string;
}

export const ABILITIES: AbilitySpec[] = [
  {
    id: 'meteor', name: 'Meteor Strike', manaCost: 100, cooldown: 14,
    color: '#ff7a3c', key: 'Q', icon: '☄',
    description: 'Click the map: 1600 damage in a large area.',
  },
  {
    id: 'heal', name: 'Heal', manaCost: 70, cooldown: 15,
    color: '#3ecf6e', key: 'W', icon: '✚',
    description: 'Repair the crystal (+3 HP).',
  },
  {
    id: 'frenzy', name: 'Frenzy', manaCost: 110, cooldown: 25,
    color: '#62a0ff', key: 'E', icon: '⚡',
    description: 'All towers fire 80% faster for 8 seconds.',
  },
];

export const METEOR_DAMAGE = 1600;
export const METEOR_RADIUS = 3;
export const HEAL_AMOUNT = 3;
export const FRENZY_MULT = 1.8;
export const FRENZY_DURATION = 8;

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
