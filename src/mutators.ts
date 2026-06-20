// Run mutators: the data behind both the arcade draft (net-neutral buff+nerf
// pairs taken one per level from level 3) and the rotating daily challenges
// (thematic constraints). Every effect is expressed as a delta on the shared
// RunModifiers aggregate so the game reads one object and the balance sim can
// score each mutator's net impact deterministically.

/** Aggregated, game-wide modifiers produced by the active mutator set. */
export interface RunModifiers {
  // Tower combat (multipliers).
  towerDamageMult: number;
  towerRangeMult: number;
  fireRateMult: number;
  splashRadiusMult: number;
  /** Flat enemy armor ignored per hit. */
  armorPierce: number;

  // Economy.
  towerCostMult: number;
  sellRefundMult: number;
  killGoldMult: number;
  startGoldDelta: number;
  startLivesDelta: number;
  manaRegenMult: number;
  manaMaxMult: number;

  // Scoring.
  bossMultGainMult: number;

  // Challenge constraints (daily only).
  /** When set, only these tower ids may be built. */
  allowedTowers: string[] | null;
  /** When set, the most towers that may exist at once. */
  towerCap: number | null;
  /** Special abilities are unavailable. */
  abilitiesDisabled: boolean;
  /** Every wave spawns a boss. */
  bossEveryWave: boolean;
  /** Extra enemy HP multiplier (challenge difficulty). */
  enemyHpMult: number;
}

export function defaultModifiers(): RunModifiers {
  return {
    towerDamageMult: 1,
    towerRangeMult: 1,
    fireRateMult: 1,
    splashRadiusMult: 1,
    armorPierce: 0,
    towerCostMult: 1,
    sellRefundMult: 1,
    killGoldMult: 1,
    startGoldDelta: 0,
    startLivesDelta: 0,
    manaRegenMult: 1,
    manaMaxMult: 1,
    bossMultGainMult: 1,
    allowedTowers: null,
    towerCap: null,
    abilitiesDisabled: false,
    bossEveryWave: false,
    enemyHpMult: 1,
  };
}

export interface Mutator {
  id: string;
  name: string;
  icon: string;
  category: 'draft' | 'challenge';
  /** One-line buff summary (draft) or the challenge rule (challenge). */
  buff: string;
  /** One-line nerf summary; empty for pure-constraint challenges. */
  nerf: string;
  apply(m: RunModifiers): void;
}

// ---------------------------------------------------------------- arcade draft
// Each entry pairs exactly one buff with one nerf so the net power stays flat
// and the global leaderboard stays fair regardless of which path a player took.

export const DRAFT_POOL: Mutator[] = [
  {
    id: 'glass-cannon', name: 'Glass Cannon', icon: '💥', category: 'draft',
    buff: '+100% tower damage', nerf: '−5 max lives',
    apply: (m) => { m.towerDamageMult *= 2.0; m.startLivesDelta -= 5; },
  },
  {
    id: 'overclock', name: 'Overclock', icon: '⚙', category: 'draft',
    buff: '+50% fire rate', nerf: '−20% range',
    apply: (m) => { m.fireRateMult *= 1.5; m.towerRangeMult *= 0.8; },
  },
  {
    id: 'war-economy', name: 'War Economy', icon: '💰', category: 'draft',
    buff: '+40% kill gold', nerf: '−50% sell refund',
    apply: (m) => { m.killGoldMult *= 1.4; m.sellRefundMult *= 0.5; },
  },
  {
    id: 'long-barrels', name: 'Long Barrels', icon: '🎯', category: 'draft',
    buff: '+40% range', nerf: '−20% fire rate',
    apply: (m) => { m.towerRangeMult *= 1.4; m.fireRateMult *= 0.8; },
  },
  {
    id: 'bulwark', name: 'Bulwark', icon: '🛡', category: 'draft',
    buff: '+6 max lives', nerf: '−20% kill gold',
    apply: (m) => { m.startLivesDelta += 6; m.killGoldMult *= 0.8; },
  },
  {
    id: 'frenzied-core', name: 'Frenzied Core', icon: '🔵', category: 'draft',
    buff: '+60% mana regen', nerf: '−30% max mana',
    apply: (m) => { m.manaRegenMult *= 1.6; m.manaMaxMult *= 0.7; },
  },
  {
    id: 'bargain-towers', name: 'Bargain Towers', icon: '🏷', category: 'draft',
    buff: '−30% tower cost', nerf: '−15% tower damage',
    apply: (m) => { m.towerCostMult *= 0.7; m.towerDamageMult *= 0.85; },
  },
  {
    id: 'overcharge', name: 'Overcharge', icon: '🌀', category: 'draft',
    buff: '+60% splash radius', nerf: '−15% fire rate',
    apply: (m) => { m.splashRadiusMult *= 1.6; m.fireRateMult *= 0.85; },
  },
  {
    id: 'adrenaline', name: 'Adrenaline', icon: '🔥', category: 'draft',
    buff: '+100% boss score gain', nerf: '−300 starting gold',
    apply: (m) => { m.bossMultGainMult *= 2.0; m.startGoldDelta -= 300; },
  },
  {
    id: 'hardened-rounds', name: 'Hardened Rounds', icon: '🪓', category: 'draft',
    buff: '+30 armor pierce', nerf: '−15% fire rate',
    apply: (m) => { m.armorPierce += 30; m.fireRateMult *= 0.85; },
  },
  {
    id: 'treasury', name: 'Treasury', icon: '🏦', category: 'draft',
    buff: '+600 starting gold', nerf: '−25% kill gold',
    apply: (m) => { m.startGoldDelta += 600; m.killGoldMult *= 0.75; },
  },
];

// ---------------------------------------------------------------- daily pool
// Ten thematic challenges. The calendar day picks one (dayIndex % 10) and also
// seeds the run, so everyone faces the same map + waves + rule that day.

export const DAILY_CHALLENGES: Mutator[] = [
  {
    id: 'lightning-only', name: 'Storm Caller', icon: '⚡', category: 'challenge',
    buff: 'Only Tesla towers may be built', nerf: '',
    apply: (m) => { m.allowedTowers = ['lightning']; },
  },
  {
    id: 'tower-cap', name: 'Minimalist', icon: '🔢', category: 'challenge',
    buff: 'Build at most 8 towers', nerf: '',
    apply: (m) => { m.towerCap = 8; },
  },
  {
    id: 'pacifist', name: 'No Heroics', icon: '🚫', category: 'challenge',
    buff: 'Special abilities are disabled', nerf: '',
    apply: (m) => { m.abilitiesDisabled = true; },
  },
  {
    id: 'featherweight', name: 'Featherweight', icon: '🪶', category: 'challenge',
    buff: 'The crystal has a single life', nerf: '',
    apply: (m) => { m.startLivesDelta -= 14; }, // START_LIVES 15 -> 1
  },
  {
    id: 'boss-rush', name: 'Boss Rush', icon: '☠', category: 'challenge',
    buff: 'A boss joins every wave', nerf: '',
    apply: (m) => { m.bossEveryWave = true; },
  },
  {
    id: 'sniper-elite', name: 'Sniper Elite', icon: '🎯', category: 'challenge',
    buff: 'Only Sniper towers may be built', nerf: '',
    apply: (m) => { m.allowedTowers = ['sniper']; },
  },
  {
    id: 'frost-bite', name: 'Frostbite', icon: '❄', category: 'challenge',
    buff: 'Only Frost & Sniper towers', nerf: '',
    apply: (m) => { m.allowedTowers = ['frost', 'sniper']; },
  },
  {
    id: 'poverty', name: 'Poverty Run', icon: '🪙', category: 'challenge',
    buff: 'Half starting gold, −30% kill gold', nerf: '',
    apply: (m) => { m.startGoldDelta -= 600; m.killGoldMult *= 0.7; },
  },
  {
    id: 'glass-world', name: 'Glass World', icon: '💎', category: 'challenge',
    buff: '+150% tower damage, but 3 lives', nerf: '',
    apply: (m) => { m.towerDamageMult *= 2.5; m.startLivesDelta -= 12; }, // 15 -> 3
  },
  {
    id: 'hardcore', name: 'Hardcore', icon: '🔺', category: 'challenge',
    buff: 'Enemies have +30% HP', nerf: '',
    apply: (m) => { m.enemyHpMult *= 1.3; },
  },
];

/** Fold an active mutator list into a single modifiers aggregate. */
export function computeModifiers(active: Mutator[]): RunModifiers {
  const m = defaultModifiers();
  for (const mut of active) mut.apply(m);
  return m;
}
