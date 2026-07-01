// Balance invariants — these protect the carefully tuned numbers from
// accidental regression when other code changes.
import { describe, it, expect } from 'vitest';
import {
  ABILITY_MAX_LEVEL, MAX_LEVEL, START_LIVES, TOWER_TYPES,
  abilityCooldown, abilityUpgradeCost, frenzyMult, healAmount,
  levelDamage, levelFireRate, levelRange, meteorDamage,
  upgradeCost, waveBonus, waveHpMult, waveSpeedMult,
} from '../src/config';

const basic = TOWER_TYPES.find((t) => t.id === 'basic')!;

describe('tower scaling', () => {
  it('damage / range / fire rate strictly increase with level', () => {
    for (let lvl = 2; lvl <= MAX_LEVEL; lvl++) {
      expect(levelDamage(basic, lvl)).toBeGreaterThan(levelDamage(basic, lvl - 1));
      expect(levelRange(basic, lvl)).toBeGreaterThan(levelRange(basic, lvl - 1));
      expect(levelFireRate(basic, lvl)).toBeGreaterThan(levelFireRate(basic, lvl - 1));
    }
  });

  it('level 1 damage equals the base spec damage', () => {
    expect(levelDamage(basic, 1)).toBe(basic.damage);
  });

  it('upgrade cost rises with the current level', () => {
    expect(upgradeCost(basic, 2)).toBeGreaterThan(upgradeCost(basic, 1));
  });
});

describe('abilities', () => {
  it('cooldown shrinks from 45s (Lv.1) to 25s (Lv.5)', () => {
    expect(abilityCooldown(1)).toBe(45);
    expect(abilityCooldown(ABILITY_MAX_LEVEL)).toBe(25);
    for (let lvl = 2; lvl <= ABILITY_MAX_LEVEL; lvl++) {
      expect(abilityCooldown(lvl)).toBeLessThan(abilityCooldown(lvl - 1));
    }
  });

  it('upgrade cost is rounded to 100 and reaches ~100,000 for the Lv.5 upgrade', () => {
    const spec = { unlockCost: 100 } as Parameters<typeof abilityUpgradeCost>[0];
    expect(abilityUpgradeCost(spec, ABILITY_MAX_LEVEL - 1)).toBe(100_000);
    for (let lvl = 1; lvl <= ABILITY_MAX_LEVEL - 1; lvl++) {
      expect(abilityUpgradeCost(spec, lvl) % 100).toBe(0);
    }
  });

  it('meteor scales 1,000 -> 10,000,000 (10x per level)', () => {
    expect(meteorDamage(1)).toBe(1_000);
    expect(meteorDamage(ABILITY_MAX_LEVEL)).toBe(10_000_000);
  });

  it('frenzy scales 1.2x -> 2.8x', () => {
    expect(frenzyMult(1)).toBeCloseTo(1.2);
    expect(frenzyMult(ABILITY_MAX_LEVEL)).toBeCloseTo(2.8);
  });

  it('heal scales +2 -> full crystal (START_LIVES) at max level', () => {
    expect(healAmount(1)).toBe(2);
    expect(healAmount(ABILITY_MAX_LEVEL)).toBe(START_LIVES);
  });
});

describe('endless scaling', () => {
  it('HP multiplier starts at 1 and keeps climbing', () => {
    expect(waveHpMult(1)).toBeCloseTo(1);
    for (let gw = 2; gw <= 60; gw++) {
      expect(waveHpMult(gw)).toBeGreaterThan(waveHpMult(gw - 1));
    }
  });

  it('speed multiplier is capped at 1.6x', () => {
    expect(waveSpeedMult(1)).toBeCloseTo(1);
    expect(waveSpeedMult(1000)).toBeLessThanOrEqual(1.6);
    expect(waveSpeedMult(1000)).toBeCloseTo(1.6);
  });

  it('wave bonus is always a whole number (gold never shows decimals)', () => {
    for (let gw = 1; gw <= 50; gw++) expect(Number.isInteger(waveBonus(gw))).toBe(true);
  });
});
