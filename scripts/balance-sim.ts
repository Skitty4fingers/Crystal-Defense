// Headless balance simulator (dev tool — not part of the build).
//   npm run sim
// Reuses the real config + mutator math so tuning decisions are data-driven and
// each draft mutator's net combat impact can be checked for rough neutrality.

import {
  TOWER_TYPES, levelDamage, levelFireRate, levelRange, upgradeCost,
  waveHpMult, waveBonus, MAX_LEVEL,
} from '../src/config';
import { DRAFT_POOL, computeModifiers } from '../src/mutators';
import type { RunModifiers } from '../src/mutators';

const REF_ENEMY_HP = 600;   // grunt baseline
const CLEAR_WINDOW = 22;    // seconds a wave is roughly on-screen
const REF_TOWERS = 10;      // a representative late-game board
const REF_LEVEL = MAX_LEVEL;

/** Wave HP "throughput" the board must out-damage (mirrors waves.ts budget). */
function waveThroughput(gw: number): number {
  const budget = 7 + gw * 2.5 + gw * gw * 0.22;
  return (budget * REF_ENEMY_HP * waveHpMult(gw)) / CLEAR_WINDOW;
}

/** Single-tower DPS at a level, with the combat modifiers folded in. */
function towerDps(towerId: string, level: number, m: RunModifiers): number {
  const spec = TOWER_TYPES.find((t) => t.id === towerId)!;
  const dmg = levelDamage(spec, level) * m.towerDamageMult;
  const rate = levelFireRate(spec, level) * m.fireRateMult;
  // Range contributes sub-linearly to effective DPS via target uptime/coverage.
  const coverage = 0.5 + 0.5 * m.towerRangeMult;
  const chain = spec.chain ? spec.chain + (level - 1) : 1; // chain hits multiple
  return dmg * rate * coverage * Math.min(chain, 3);
}

/** First global wave where wave HP throughput beats the board's DPS. */
function wallWave(towerId: string, m: RunModifiers): number {
  const dps = REF_TOWERS * towerDps(towerId, REF_LEVEL, m);
  for (let gw = 1; gw <= 400; gw++) {
    if (waveThroughput(gw) > dps) return gw;
  }
  return 400;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

console.log('\n=== TOWER VALUE (Lv.1 / Lv.5, no mutators) ===');
const neutral = computeModifiers([]);
console.log(pad('Tower', 10) + pad('DPS L1', 10) + pad('DPS L5', 10) + pad('Cost', 8) + pad('DPS/gold L5', 12) + 'MaxCost');
for (const t of TOWER_TYPES) {
  const dps1 = towerDps(t.id, 1, neutral);
  const dps5 = towerDps(t.id, 5, neutral);
  let maxCost = t.cost;
  for (let l = 1; l < MAX_LEVEL; l++) maxCost += upgradeCost(t, l);
  console.log(
    pad(t.name, 10) + pad(dps1.toFixed(0), 10) + pad(dps5.toFixed(0), 10) +
    pad(t.cost, 8) + pad((dps5 / maxCost).toFixed(3), 12) + maxCost,
  );
}

console.log(`\n=== WALL WAVE per tower (board of ${REF_TOWERS} @ Lv.${REF_LEVEL}) ===`);
for (const t of TOWER_TYPES) {
  console.log(pad(t.name, 10) + 'wall @ global wave ' + wallWave(t.id, neutral));
}

console.log('\n=== DRAFT MUTATOR NEUTRALITY (wall-wave shift vs baseline) ===');
console.log('Reference: basic-tower board. Combat-axis mutators shift the wall;');
console.log('economy/lives/mana mutators show ~0 shift (their trade is off-combat).\n');
const base = wallWave('basic', neutral);
console.log(pad('Mutator', 18) + pad('wall', 8) + pad('Δwall', 8) + 'buff / nerf');
for (const mut of DRAFT_POOL) {
  const m = computeModifiers([mut]);
  const w = wallWave('basic', m);
  const d = w - base;
  const flag = Math.abs(d) > 6 ? '  ⚠ strong combat swing' : '';
  console.log(
    pad(mut.name, 18) + pad(w, 8) + pad((d >= 0 ? '+' : '') + d, 8) +
    `${mut.buff} / ${mut.nerf}${flag}`,
  );
}
console.log(`\nBaseline wall (basic board): global wave ${base}`);
console.log(`Sample late bonus: waveBonus(50) = ${waveBonus(50)} gold\n`);
