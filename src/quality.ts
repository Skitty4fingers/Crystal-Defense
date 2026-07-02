// Graphics-quality mode: a simple two-way Performance/Quality switch the player
// can flip to trade visual richness for frame rate. 'quality' reproduces the
// game's full look exactly; 'performance' drops the expensive passes for weak
// hardware. Persisted to localStorage, mirroring the SFX/music mute pattern in
// audio.ts / music.ts. There is no auto-detection — the default is 'quality',
// and the player toggles from the top-left controls.

export type QualityMode = 'performance' | 'quality';

/**
 * Concrete render settings for a mode. Performance deliberately keeps full
 * resolution + antialias (so the image stays crisp) and instead strips the
 * expensive *effects*: bloom/glow, shadows, the colour-grade pass, the star
 * field, and all the optional polish VFX (`extras`).
 */
export interface QualityConfig {
  /** Clamp for renderer.setPixelRatio (also min'd with window.devicePixelRatio). */
  maxPixelRatio: number;
  /** WebGL context flag (only changes on reload — kept equal across modes). */
  antialias: boolean;
  /** UnrealBloomPass enabled (the glow/bloom on crystals, beams, projectiles). */
  bloom: boolean;
  /** Shadow map rendered. */
  shadows: boolean;
  /** Colour-grade pass (vignette + per-level tint) enabled. */
  grade: boolean;
  /** Star-field point count (0 = no stars). */
  stars: number;
  /** Max simultaneous floating damage numbers. */
  damageCap: number;
  /** Master switch for the polish VFX: muzzle flashes, boss aura, spawn
   *  materialize, frost shatter, flavored death bursts, fireflies. */
  extras: boolean;
  /** Tower head kick-back on firing. */
  recoil: boolean;
  /** Textured, scrolling ocean/water backdrop (else a flat, static sea). */
  background: boolean;
  /** Ambient world animation: portal spin/pulse/orbs + crystal idle spin,
   *  bob, and damage-flash. */
  worldAnim: boolean;
  /** Impact/hit puffs: projectile-splash bursts, enemy-death explosions, and
   *  the crystal-leak flash. (The rare set-pieces — meteor cast and the
   *  crystal-death finale — always play.) */
  impactFx: boolean;
}

export const QUALITY: Record<QualityMode, QualityConfig> = {
  // 'quality' MUST equal the game's current hardcoded values (zero-diff baseline).
  quality: {
    maxPixelRatio: 2,
    antialias: true,
    bloom: true,
    shadows: true,
    grade: true,
    stars: 700,
    damageCap: 90,
    extras: true,
    recoil: true,
    background: true,
    worldAnim: true,
    impactFx: true,
  },
  // Full resolution + AA (crisp), but aggressively strips the heavy visuals:
  // no bloom/shadows/grade/stars/polish-VFX, no tower recoil, a flat static
  // sea, frozen portal/crystal, and no impact puffs.
  performance: {
    maxPixelRatio: 2,
    antialias: true,
    bloom: false,
    shadows: false,
    grade: false,
    stars: 0,
    damageCap: 30,
    extras: false,
    recoil: false,
    background: false,
    worldAnim: false,
    impactFx: false,
  },
};

const KEY = 'cd-quality';

/** Stored preference, defaulting to 'quality' (identical to today's look). */
export function loadQuality(): QualityMode {
  return localStorage.getItem(KEY) === 'performance' ? 'performance' : 'quality';
}

export function saveQuality(mode: QualityMode): void {
  localStorage.setItem(KEY, mode);
}
