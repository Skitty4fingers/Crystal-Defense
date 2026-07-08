import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import {
  ABILITIES, ABILITY_MAX_LEVEL, ENEMY_TYPES,
  BOSS_MULT_BASE, BOSS_MULT_MAX, BOSS_MULT_STEP,
  LEVEL_COUNTDOWN, LEVEL_HEAL, LEVEL_SALVAGE,
  MANA_MAX, MANA_PER_KILL, MANA_REGEN, MAX_LEVEL,
  SELL_REFUND, START_GOLD, START_LIVES, START_MANA, TOWER_TYPES,
  WAVES_PER_LEVEL, WAVE_COUNTDOWN,
  abilityCooldown, abilityUpgradeCost, frenzyDuration, frenzyMult, healAmount,
  levelRewardMult, meteorDamage, meteorRadius, waveBonus, waveHpMult, waveSpeedMult,
} from './config';
import type { AbilitySpec, TowerSpec } from './config';
import {
  DAILY_CHALLENGES, DRAFT_POOL, computeModifiers, defaultModifiers, localDayNumber,
} from './mutators';
import type { Mutator, RunModifiers } from './mutators';
import { GameMap } from './map';
import { Enemy, setEnemyExtras } from './enemy';
import type { EnemyOpts } from './enemy';
import { Tower, buildTowerMesh, setTowerRecoil } from './tower';
import { Projectile } from './projectile';
import type { ShotParams } from './projectile';
import { Beam, DamageNumber, Explosion, Meteor, MuzzleFlash, Shatter } from './effects';
import type { VFX } from './effects';
import { UI } from './ui';
import type { AbilityState } from './ui';
import { sfx } from './audio';
import { music } from './music';
import { QUALITY, loadQuality, saveQuality } from './quality';
import type { QualityConfig, QualityMode } from './quality';
import { fetchScores, qualifies, submitScore } from './leaderboard';
import type { RunKind, RunStats } from './leaderboard';
import { generateLevel } from './waves';
import type { GeneratedWave } from './waves';
import { makeRng } from './rng';
import type { RNG } from './rng';

type State = 'ready' | 'idle' | 'wave' | 'dying' | 'lost';

interface SpawnOrder {
  at: number;
  type: string;
  opts: EnemyOpts;
}

/**
 * Cheap full-screen colour grade: a soft vignette plus an optional per-level
 * tint (driven by applyLevelPalette). One pass, negligible cost; runs in both
 * quality modes. uTintAmount defaults to 0 (no tint) so only the vignette shows
 * until a level palette sets a tint.
 */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTint: { value: new THREE.Color(0xffffff) },
    uTintAmount: { value: 0.0 },
    uVignette: { value: 0.28 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec3 uTint;
    uniform float uTintAmount;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb = mix(c.rgb, c.rgb * uTint, uTintAmount);
      vec2 d = vUv - 0.5;
      float vig = 1.0 - uVignette * smoothstep(0.12, 0.5, dot(d, d));
      c.rgb *= vig;
      gl_FragColor = c;
    }
  `,
};

/**
 * Per-level colour palettes cycled by (level-1) % N. Index 0 reproduces the
 * game's original background/fog/light/exposure exactly (zero-diff at level 1);
 * later levels shift the mood. `tintAmount` feeds the colour-grade pass.
 */
interface LevelPalette {
  bg: number; fog: number; sun: number; hemi: number;
  exposure: number; tint: number; tintAmount: number;
}
const PALETTES: LevelPalette[] = [
  { bg: 0x0c1424, fog: 0x0c1424, sun: 0xfff1d6, hemi: 0xbfd4ff, exposure: 1.05, tint: 0xffffff, tintAmount: 0.0 },
  { bg: 0x0a1830, fog: 0x0a1830, sun: 0xdfeaff, hemi: 0xd6ecff, exposure: 1.05, tint: 0xcfe3ff, tintAmount: 0.12 },
  { bg: 0x1a0f14, fog: 0x271520, sun: 0xffcaa0, hemi: 0xffd9c0, exposure: 1.08, tint: 0xffd7b0, tintAmount: 0.14 },
  { bg: 0x140a20, fog: 0x1a1030, sun: 0xe8d0ff, hemi: 0xd8c8ff, exposure: 1.04, tint: 0xd8c0ff, tintAmount: 0.13 },
  { bg: 0x0a1a14, fog: 0x0e2018, sun: 0xe9ffe0, hemi: 0xd0ffe0, exposure: 1.05, tint: 0xcfeecf, tintAmount: 0.10 },
];

export class Game {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  /** Graphics-quality mode + its resolved settings (Performance vs Quality). */
  private qmode: QualityMode = loadQuality();
  private qcfg: QualityConfig = QUALITY[this.qmode];
  private bloomPass!: UnrealBloomPass;
  private gradePass!: ShaderPass;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private map!: GameMap;
  private ui = new UI();
  private rng: RNG = makeRng(Date.now());

  private enemies: Enemy[] = [];
  private towers: Tower[] = [];
  private projectiles: Projectile[] = [];
  private effects: VFX[] = [];

  private state: State = 'ready';
  private paused = false;
  private speedMult = 1;
  private gold = START_GOLD;
  private lives = START_LIVES;
  private maxLives = START_LIVES;
  private mana = START_MANA;
  private manaMax = MANA_MAX;
  private score = 0;
  private level = 1;
  private waveNumber = 0;

  // Run configuration + mutators (pure-arcade variety; see mutators.ts).
  private runKind: RunKind = 'arcade';
  private runSeed = 1;
  private runDay: number | null = null;
  /** True while the front-door menu is showing (drives the menu music loop). */
  private atMenu = true;
  private activeMutators: Mutator[] = [];
  private mods: RunModifiers = defaultModifiers();
  private draftRng: RNG = makeRng(1);
  private draftOpen = false;
  /** Boss-kill score multiplier; escalates each boss slain. */
  private bossMult = BOSS_MULT_BASE;
  private runStats: RunStats = Game.freshStats();
  private waveDefs: GeneratedWave[] = [];
  private spawnQueue: SpawnOrder[] = [];
  private waveClock = 0;
  /** Seconds until the next wave auto-starts (negative = no countdown running). */
  private countdown = -1;
  /** True while `countdown` is the once-per-level build window (drives the
   * large countdown overlay); false for the shorter between-wave countdown. */
  private countdownIsLevelStart = false;

  // Abilities
  private cooldowns: Record<string, number> = {};
  /** Owned level per ability id; 0 = locked (must be bought to unlock). */
  private abilityLevels: Record<string, number> = {};
  private frenzyTimer = 0;
  private frenzyMultActive = 1;
  private craters: { group: THREE.Group; x: number; z: number; radius: number }[] = [];
  private castingMeteor = false;

  /** Counts down the dramatic crystal-death sequence before the game-over screen. */
  private dyingTimer = 0;

  private stars!: THREE.Points;

  // Crystal health bar (billboard above the base crystal)
  private crystalBar = new THREE.Group();
  private crystalFill!: THREE.Mesh;
  private crystalFillMat!: THREE.MeshBasicMaterial;

  // Placement / selection
  private placing: TowerSpec | null = null;
  private ghost: THREE.Group | null = null;
  private rangeGroup = new THREE.Group();
  private rangeRingMat: THREE.MeshBasicMaterial;
  private rangeFillMat: THREE.MeshBasicMaterial;
  private selected: Tower | null = null;
  private hoverCell: { col: number; row: number } | null = null;
  private hoverValid = false;

  // Input helpers
  private pointer = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private downPos = { x: 0, y: 0 };
  private clock = new THREE.Clock();
  private uiPulse = 0;
  private tmpV = new THREE.Vector3();

  constructor(container: HTMLElement) {
    setEnemyExtras(this.qcfg.extras);
    setTowerRecoil(this.qcfg.recoil);
    this.renderer = new THREE.WebGLRenderer({ antialias: this.qcfg.antialias });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.qcfg.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = this.qcfg.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0c1424);
    this.scene.fog = new THREE.Fog(0x0c1424, 60, 130);

    this.camera = new THREE.PerspectiveCamera(
      50, window.innerWidth / window.innerHeight, 0.1, 300,
    );
    this.camera.position.set(9, 27, 28);

    // Bloom post-processing makes crystals, beams and projectiles glow.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.4, 0.78,
    );
    this.bloomPass.enabled = this.qcfg.bloom;
    this.composer.addPass(this.bloomPass);
    // Cheap colour-grade: vignette + a per-level tint (see applyLevelPalette).
    this.gradePass = new ShaderPass(GRADE_SHADER);
    this.gradePass.enabled = this.qcfg.grade;
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(1.5, 0, 1);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 65;
    this.controls.maxPolarAngle = 1.35;
    this.controls.minPolarAngle = 0.2;
    // Left button is reserved for building/selecting; rotate with right, pan with middle.
    this.controls.mouseButtons = {
      LEFT: undefined as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    // Touch: one finger rotates, two fingers pan/zoom. Tower placement still works
    // because the game's pointerup handler ignores drags (>6px) — only taps land.
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.update();

    this.setupLights();
    this.buildStars();
    this.rangeRingMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.rangeFillMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80, transparent: true, opacity: 0.12, depthWrite: false,
    });
    this.buildRangeIndicator();
    this.buildCrystalBar();
    this.bindInput();
    this.bindUI();
    this.ui.refreshDailyLabel();
    this.initRun();
    this.syncStats();
    this.ui.setWaveButton('&#9654; Start Game', true);

    window.addEventListener('resize', this.onResize);
    // Handy for debugging in the console.
    (window as unknown as Record<string, unknown>).__game = this;
    (window as unknown as Record<string, unknown>).__music = music;
    this.animate();
  }

  // ---------------------------------------------------------------- setup

  private setupLights(): void {
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x33402e, 0.8);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    sun.position.set(22, 32, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -24;
    sun.shadow.camera.right = 24;
    sun.shadow.camera.top = 24;
    sun.shadow.camera.bottom = -24;
    sun.shadow.camera.far = 90;
    this.scene.add(sun);
    this.sun = sun;
  }

  /** Faint stars on a dome far beyond the island; they ignore the scene fog. */
  private buildStars(): void {
    const count = this.qcfg.stars;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Random direction on the upper hemisphere, pushed out past the fog.
      const a = Math.random() * Math.PI * 2;
      const elev = 0.06 + Math.random() * 0.92;
      const horiz = Math.sqrt(1 - elev * elev);
      const r = 170 + Math.random() * 50;
      positions[i * 3] = Math.cos(a) * horiz * r;
      positions[i * 3 + 1] = elev * r;
      positions[i * 3 + 2] = Math.sin(a) * horiz * r;
      // Faint grays with the occasional cool or warm tinge.
      const b = 0.45 + Math.random() * 0.55;
      const tinge = Math.random();
      colors[i * 3] = b * (tinge < 0.12 ? 1.15 : 1);
      colors[i * 3 + 1] = b;
      colors[i * 3 + 2] = b * (tinge > 0.82 ? 1.25 : 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.4, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 0.95, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(geo, mat);
    this.scene.add(this.stars);
  }

  /** New map layout + wave schedule for the current level. */
  private initRun(): void {
    this.clearCraters();
    this.map?.dispose();
    this.map = new GameMap(this.scene, this.rng);
    this.map.setFireflies(this.qcfg.extras);
    this.map.setFish(this.qcfg.extras);
    this.map.setBackgroundRich(this.qcfg.background);
    this.map.setWorldAnim(this.qcfg.worldAnim);
    this.waveDefs = generateLevel(this.rng, this.level, { bossEveryWave: this.mods.bossEveryWave });
    this.ui.setNextWaveHint(this.waveDefs[0].hint);
    this.applyLevelPalette(this.level);
    this.positionCrystalBar();
    this.updateCrystalBar();
  }

  /** Shift the scene's colour mood per level (background/fog/lights/exposure +
   *  the colour-grade tint). Level 1 reproduces the original look exactly. */
  private applyLevelPalette(level: number): void {
    const p = PALETTES[(level - 1) % PALETTES.length];
    (this.scene.background as THREE.Color).setHex(p.bg);
    this.scene.fog?.color.setHex(p.fog);
    this.sun.color.setHex(p.sun);
    this.hemi.color.setHex(p.hemi);
    this.renderer.toneMappingExposure = p.exposure;
    (this.gradePass.uniforms.uTint.value as THREE.Color).setHex(p.tint);
    this.gradePass.uniforms.uTintAmount.value = p.tintAmount;
    this.map?.setSkyColor(p.bg);
  }

  private clearCraters(): void {
    for (const c of this.craters) this.disposeCrater(c.group);
    this.craters = [];
  }

  private disposeCrater(group: THREE.Group): void {
    this.scene.remove(group);
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }

  private addMeteorCrater(at: THREE.Vector3, radius: number): void {
    // Repeated strikes on the same spot would otherwise stack overlapping
    // translucent scorch meshes until the ground/path is fully obscured --
    // clear out any existing crater this new one overlaps before adding it.
    this.craters = this.craters.filter((c) => {
      const overlaps = Math.hypot(c.x - at.x, c.z - at.z) < (radius + c.radius) * 0.6;
      if (overlaps) this.disposeCrater(c.group);
      return !overlaps;
    });

    const Y = 0.112;
    const group = new THREE.Group();

    // Inner burn scar — dark, capped opacity so a single crater never fully
    // hides the ground texture/path/blockers underneath.
    group.add(new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.52, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x0e0400, transparent: true, opacity: 0.55, depthWrite: false }),
    ));

    // Outer scorch ring — charred earth fading outward
    group.add(new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.52, radius * 1.1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x2a0c00, transparent: true, opacity: 0.32, depthWrite: false }),
    ));

    group.position.set(at.x, Y, at.z);
    group.renderOrder = 1;
    this.scene.add(group);
    this.craters.push({ group, x: at.x, z: at.z, radius });
  }

  // ---------------------------------------------------------------- runs & mutators

  static freshStats(): RunStats {
    return {
      towers: {}, goldEarned: 0, goldSpent: 0, abilities: {},
      enemiesKilled: 0, bossesKilled: 0, maxBossMult: 1, mutatorPath: [], challenge: null,
    };
  }

  /** Index of the player's current local day — drives daily-challenge
   * rotation + seeding, so it changes at the player's own midnight. */
  private static today(): number {
    return localDayNumber();
  }

  /** Daily challenge type (0-9) for the active run; null for arcade. */
  private runChallenge(): number | null {
    return this.runKind === 'daily' && this.runDay != null
      ? this.runDay % DAILY_CHALLENGES.length : null;
  }

  /** Start a fresh run of the given kind (arcade, or today's daily challenge). */
  beginRun(kind: RunKind): void {
    this.runKind = kind;
    if (kind === 'daily') {
      const day = Game.today();
      this.runDay = day;
      this.runSeed = day; // identical map + waves for everyone today
      this.activeMutators = [DAILY_CHALLENGES[day % DAILY_CHALLENGES.length]];
    } else {
      this.runDay = null;
      this.runSeed = Date.now() >>> 0;
      this.activeMutators = [];
    }
    this.atMenu = false;
    this.reset();
    // Kick off the soundtrack at the calm build-phase intensity.
    music.start();
    music.setLevel(this.level);
    music.setScene('build');
    music.setSpeed(this.speedMult);
    // Make the daily's rule unmistakable at the start of the run.
    if (kind === 'daily') {
      const c = this.activeMutators[0];
      this.ui.showBanner(`${c.icon} DAILY — ${c.name}: ${c.buff}`, 'boss', 5);
    }
  }

  /** Stop the current run and return to the front-door menu (Restart / Play Again). */
  private returnToMenu(): void {
    for (const e of this.enemies) this.scene.remove(e.group);
    for (const t of this.towers) this.scene.remove(t.group);
    for (const p of this.projectiles) { this.scene.remove(p.mesh); p.dispose(); }
    for (const v of this.effects) { this.scene.remove(v.obj); v.dispose?.(); }
    this.enemies = [];
    this.towers = [];
    this.projectiles = [];
    this.effects = [];
    this.spawnQueue = [];
    this.state = 'ready';
    this.countdown = -1;
    this.draftOpen = false;
    this.castingMeteor = false;
    this.setPlacing(null);
    this.deselect();
    this.ui.hideOverlay();
    this.ui.hideDraft();
    this.ui.showSplash();
    this.atMenu = true;
    this.enterMenuMusic(); // the Industrial menu loop on the front door
  }

  /** Start (or resume) the dedicated menu music loop. */
  private enterMenuMusic(): void {
    music.start();
    music.setScene('menu');
  }

  /** Recompute the aggregate from the active mutator set and re-tune live state. */
  private recomputeMods(): void {
    this.mods = computeModifiers(this.activeMutators);
    this.maxLives = Math.max(1, START_LIVES + this.mods.startLivesDelta);
    this.lives = Math.min(this.lives, this.maxLives);
    this.manaMax = MANA_MAX * this.mods.manaMaxMult;
    this.mana = Math.min(this.mana, this.manaMax);
    for (const t of this.towers) this.tuneTower(t);
    this.ui.setAllowedTowers(this.mods.allowedTowers);
    this.ui.setAbilitiesDisabled(this.mods.abilitiesDisabled);
    this.ui.updatePaletteCosts(this.mods.towerCostMult);
    this.refreshActiveMutators();
  }

  private tuneTower(t: Tower): void {
    t.damageMult = this.mods.towerDamageMult;
    t.rangeMult = this.mods.towerRangeMult;
    t.fireRateMult = this.mods.fireRateMult;
    t.armorPierce = this.mods.armorPierce;
    t.levelCap = this.effectiveMaxLevel(MAX_LEVEL);
  }

  /** Max tower/ability level available right now: gated by game level (1→1,
   * 2→2, ... 5+→5), so early levels ease players into the full kit instead of
   * handing out max-level power immediately. Towers rebuild every level, so
   * gating at placement/tune time (rather than retroactively) is sufficient. */
  private effectiveMaxLevel(absoluteMax: number): number {
    return Math.min(absoluteMax, this.level);
  }

  private refreshActiveMutators(): void {
    this.ui.setRunSummary(
      this.activeMutators.map((m) => ({ icon: m.icon, name: m.name })),
      this.summarizeMods(),
    );
  }

  /** Human-readable net effect of every active mutator, for the top-of-screen strip. */
  private summarizeMods(): string[] {
    const m = this.mods;
    const out: string[] = [];
    const mult = (label: string, v: number): void => { if (Math.abs(v - 1) > 1e-3) out.push(`${label} ×${v.toFixed(2)}`); };
    mult('DMG', m.towerDamageMult);
    mult('Fire', m.fireRateMult);
    mult('Range', m.towerRangeMult);
    mult('Splash', m.splashRadiusMult);
    if (m.armorPierce > 0) out.push(`+${m.armorPierce} pierce`);
    mult('Cost', m.towerCostMult);
    mult('Sell', m.sellRefundMult);
    mult('Gold income', m.killGoldMult);
    if (m.startLivesDelta !== 0) out.push(`${m.startLivesDelta > 0 ? '+' : ''}${m.startLivesDelta} lives`);
    mult('Mana regen', m.manaRegenMult);
    mult('Mana max', m.manaMaxMult);
    mult('Boss gain', m.bossMultGainMult);
    mult('Enemy HP', m.enemyHpMult);
    if (m.allowedTowers) {
      const names = m.allowedTowers.map((id) => TOWER_TYPES.find((t) => t.id === id)?.name ?? id);
      out.push(`Only: ${names.join(', ')}`);
    }
    if (m.towerCap !== null) out.push(`Max ${m.towerCap} towers`);
    if (m.abilitiesDisabled) out.push('Abilities off');
    if (m.bossEveryWave) out.push('Boss every wave');
    return out;
  }

  /** Arcade only: offer a 3-card draft at the start of each level from level 3. */
  private openDraft(): void {
    const taken = new Set(this.activeMutators.map((m) => m.id));
    const shuffle = (arr: Mutator[]): Mutator[] => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(this.draftRng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    // Prefer not-yet-taken mutators; once the pool is exhausted, re-offer taken
    // ones so deep runs keep drafting (their effects stack/compound).
    const fresh = shuffle(DRAFT_POOL.filter((m) => !taken.has(m.id)));
    const used = shuffle(DRAFT_POOL.filter((m) => taken.has(m.id)));
    const options = [...fresh, ...used].slice(0, 3);
    this.draftOpen = true;
    this.ui.showDraft(this.level, options.map((m) => ({
      id: m.id, name: m.name, icon: m.icon, buff: m.buff, nerf: m.nerf,
    })));
  }

  private pickDraft(id: string): void {
    if (!this.draftOpen) return;
    const mut = DRAFT_POOL.find((m) => m.id === id);
    if (mut) {
      const prevGoldMult = this.mods.startGoldMult;
      this.activeMutators.push(mut);
      this.recomputeMods();
      // Start-gold changes apply once as a percentage of base gold, granted (or
      // charged) immediately at draft time.
      const goldDelta = Math.round(START_GOLD * (this.mods.startGoldMult - prevGoldMult));
      if (goldDelta !== 0) this.gold = Math.max(0, this.gold + goldDelta);
      this.runStats.mutatorPath.push({ level: this.level, id: mut.id, name: mut.name });
      this.ui.showBanner(`${mut.icon} ${mut.name} — ${mut.buff} / ${mut.nerf}`);
      sfx.upgrade();
    }
    this.draftOpen = false;
    this.ui.hideDraft();
    this.syncStats();
  }

  /** Unit-radius ring + fill, scaled to a tower's range when shown. */
  private buildRangeIndicator(): void {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.955, 1, 56).rotateX(-Math.PI / 2),
      this.rangeRingMat,
    );
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(0.955, 56).rotateX(-Math.PI / 2),
      this.rangeFillMat,
    );
    this.rangeGroup.add(ring, fill);
    this.rangeGroup.position.y = 0.13;
    this.rangeGroup.visible = false;
    this.scene.add(this.rangeGroup);
  }

  /** Health bar floating above the base crystal (billboarded every frame). */
  private buildCrystalBar(): void {
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 0.3),
      new THREE.MeshBasicMaterial({ color: 0x10141f, depthTest: false, transparent: true }),
    );
    const fillGeo = new THREE.PlaneGeometry(2.5, 0.2);
    fillGeo.translate(1.25, 0, 0.01); // left-anchored so scale.x shrinks rightwards
    this.crystalFillMat = new THREE.MeshBasicMaterial({
      color: 0x55ccff, depthTest: false, transparent: true,
    });
    this.crystalFill = new THREE.Mesh(fillGeo, this.crystalFillMat);
    this.crystalFill.position.x = -1.25;
    this.crystalBar.add(bg, this.crystalFill);
    this.crystalBar.renderOrder = 999;
    this.scene.add(this.crystalBar);
  }

  private positionCrystalBar(): void {
    this.crystalBar.position.copy(this.map.basePosition);
    this.crystalBar.position.y = 4.1;
  }

  private updateCrystalBar(): void {
    const frac = Math.max(0, Math.min(this.lives / this.maxLives, 1));
    this.crystalFill.scale.x = frac;
    // Cyan when healthy, shifting to red as the crystal weakens.
    this.crystalFillMat.color.setHSL(0.52 * frac, 0.85, 0.55);
    // Drive the crystal's idle aura (reddens + pulses faster at low health).
    this.map?.setCrystalHealth(frac);
  }

  private bindUI(): void {
    this.ui.onSelectTower = (id) => this.setPlacing(this.placing?.id === id ? null : id);
    this.ui.onAbility = (id) => this.castAbility(id);
    this.ui.onUnlockAbility = (id) => this.buyAbility(id);
    this.ui.onUpgradeAbility = (id) => this.upgradeAbility(id);
    this.ui.onWaveButton = () => this.startWave();
    this.ui.onUpgradeAll = () => this.upgradeAll();
    // Pause now doubles as the Help button: pausing opens How-to-Play as an
    // overlay, and closing it (Back) resumes — there's no other way to reach
    // #btn-pause while paused, since the overlay covers the whole screen.
    this.ui.onPause = () => {
      this.togglePause();
      this.ui.showInstructionsOverlay(() => this.togglePause());
    };
    this.ui.onSpeed = () => this.toggleSpeed();
    this.ui.onRestart = () => this.returnToMenu();
    this.ui.onSell = () => this.sellSelected();
    this.ui.onUpgrade = () => this.upgradeSelected();
    this.ui.onMute = () => this.ui.setMuteLabel(sfx.toggle());
    this.ui.setMuteLabel(sfx.isMuted);
    this.ui.onMusicToggle = () => this.ui.setMusicLabel(music.toggle());
    this.ui.setMusicLabel(music.isMusicMuted);
    this.ui.onQuality = () => this.toggleQuality();
    this.ui.setQualityLabel(this.qmode);
    this.ui.onSidebarToggle = () => {
      const hidden = document.body.classList.contains('sidebar-hidden');
      this.ui.setSidebarOpen(hidden);
    };
    // Auto-hide the sidebar on narrow screens so the playfield isn't obscured.
    if (window.matchMedia('(max-width: 640px)').matches) {
      this.ui.setSidebarOpen(false);
    }
    this.ui.onStartRun = (kind) => { sfx.unlock(); this.beginRun(kind); };
    this.ui.onDraftPick = (id) => this.pickDraft(id);
    this.ui.dailyChallenge = () => {
      const day = Game.today();
      const c = DAILY_CHALLENGES[day % DAILY_CHALLENGES.length];
      return { name: c.name, icon: c.icon, rule: c.buff };
    };
    this.ui.onShowLeaderboard = async (kind, challenge) => {
      const scores = await fetchScores(kind, challenge);
      this.ui.showSplashLeaderboard(scores, kind, challenge);
    };
    this.ui.onSubmitScore = async (initials) => {
      this.runStats.maxBossMult = this.bossMult;
      const { rank, scores } = await submitScore({
        initials, score: this.score, level: this.level,
        wave: this.waveNumber, date: Date.now(),
        kind: this.runKind, day: this.runDay, challenge: this.runChallenge(), stats: this.runStats,
        version: __APP_VERSION__,
      });
      this.ui.renderScores(scores, rank);
    };
  }

  private bindInput(): void {
    // Browsers only allow audio after a user gesture; unlock is idempotent.
    // The first gesture on the menu also kicks off the menu music loop.
    const firstGesture = (): void => { sfx.unlock(); if (this.atMenu) this.enterMenuMusic(); };
    window.addEventListener('pointerdown', firstGesture);
    window.addEventListener('keydown', firstGesture);

    // A tab left open on the menu past local midnight would otherwise keep
    // yesterday's daily label; refresh it whenever the player returns to the tab.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.atMenu) this.ui.refreshDailyLabel();
    });

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.updateHover();
    });
    el.addEventListener('pointerdown', (e) => {
      this.downPos = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      const moved = Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y);
      if (e.button === 0 && moved < 6) this.handleClick();
    });
    window.addEventListener('keydown', (e) => {
      // Don't hijack keys while the player is typing (leaderboard initials).
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') {
        this.setPlacing(null);
        this.cancelMeteor();
        this.deselect();
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        this.startWave();
        return;
      }
      if (e.key.toLowerCase() === 'm') {
        this.ui.setMuteLabel(sfx.toggle());
        return;
      }
      if (e.key.toLowerCase() === 'n') {
        this.ui.setMusicLabel(music.toggle());
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.toggleSpeed();
        return;
      }
      if (this.paused) return; // no gameplay actions while paused
      const towerIdx = parseInt(e.key, 10) - 1;
      if (towerIdx >= 0 && towerIdx < TOWER_TYPES.length) {
        const id = TOWER_TYPES[towerIdx].id;
        this.setPlacing(this.placing?.id === id ? null : id);
        return;
      }
      const ability = ABILITIES.find((a) => a.key.toLowerCase() === e.key.toLowerCase());
      if (ability) this.castAbility(ability.id);
    });
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  /**
   * Switch graphics-quality mode live — every setting reconfigures without a
   * reload. (Antialias is a context-creation flag, but both modes keep it on,
   * so it never needs to change; Performance keeps full resolution + AA and
   * instead strips bloom, shadows, the colour-grade pass, stars, and the
   * polish VFX.)
   */
  private applyQuality(mode: QualityMode): void {
    saveQuality(mode);
    this.qmode = mode;
    this.qcfg = QUALITY[mode];
    const c = this.qcfg;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, c.maxPixelRatio));
    const shadowsChanged = this.renderer.shadowMap.enabled !== c.shadows;
    this.renderer.shadowMap.enabled = c.shadows;
    if (shadowsChanged) this.refreshShadowMaterials();
    this.bloomPass.enabled = c.bloom;
    this.gradePass.enabled = c.grade;
    setEnemyExtras(c.extras);
    setTowerRecoil(c.recoil);
    this.map?.setBackgroundRich(c.background);
    this.map?.setWorldAnim(c.worldAnim);
    // Rebuild the star field only when its count actually changes.
    if (this.stars.geometry.getAttribute('position').count !== c.stars) {
      this.scene.remove(this.stars);
      this.stars.geometry.dispose();
      (this.stars.material as THREE.Material).dispose();
      this.buildStars();
    }
    this.map?.setFireflies(c.extras);
    this.map?.setFish(c.extras);
    this.onResize();
  }

  /**
   * Force every scene material to recompile after `renderer.shadowMap.enabled`
   * is flipped at runtime. Three.js bakes shadow sampling into the compiled
   * shader at `renderer.shadowMap.enabled` read-time, so without this the old
   * programs keep sampling the last-rendered (now frozen) shadow map and stale
   * shadows linger on the ground after switching to Performance.
   */
  private refreshShadowMaterials(): void {
    this.scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) m.needsUpdate = true;
    });
  }

  /** Cycle Performance ⇄ Quality and refresh the toggle label. */
  private toggleQuality(): void {
    this.applyQuality(this.qmode === 'quality' ? 'performance' : 'quality');
    this.ui.setQualityLabel(this.qmode);
  }

  // ---------------------------------------------------------------- waves & levels

  private globalWave(wave: number): number {
    return (this.level - 1) * WAVES_PER_LEVEL + wave;
  }

  private startWave(): void {
    if (this.paused) return;
    if (this.state !== 'ready' && this.state !== 'idle') return;
    this.countdown = -1;
    this.waveNumber++;
    this.waveClock = 0;
    this.spawnQueue = [];

    const def = this.waveDefs[this.waveNumber - 1];
    const mod = def.modifier;
    const gw = this.globalWave(this.waveNumber);
    const hpMult = waveHpMult(gw) * (mod?.hpMult ?? 1) * this.mods.enemyHpMult;
    const speedMult = waveSpeedMult(gw) * (mod?.speedMult ?? 1);
    const rewardMult = (mod?.rewardMult ?? 1) * levelRewardMult(this.level);

    let t = 0;
    for (const group of def.groups) {
      t += group.delay;
      for (let i = 0; i < group.count; i++) {
        this.spawnQueue.push({
          at: t,
          type: group.type,
          opts: {
            hpMult: hpMult * group.hpScale,
            speedMult,
            armorBonus: mod?.armorBonus ?? 0,
            regenBonus: mod?.regenBonus ?? 0,
            rewardMult,
          },
        });
        t += group.interval;
      }
    }
    this.spawnQueue.sort((a, b) => a.at - b.at);

    this.state = 'wave';
    this.ui.setWaveButton('Wave in progress&hellip;', false);
    music.setScene(def.boss ? 'boss' : 'combat');
    if (def.boss) {
      this.ui.showBanner(
        this.waveNumber === WAVES_PER_LEVEL ? '☠ LEVEL BOSS ☠' : '⚠ BOSS WAVE ⚠', 'boss',
      );
      sfx.bossWarn();
    } else {
      this.ui.showBanner(`Wave ${this.waveNumber}${mod ? ` — ${mod.name}!` : ''}`);
      sfx.waveStart();
    }
    const next = this.waveDefs[this.waveNumber];
    this.ui.setNextWaveHint(next ? next.hint : null);
    this.syncStats();
  }

  private spawnEnemy(order: SpawnOrder): void {
    const enemy = new Enemy(ENEMY_TYPES[order.type], order.opts);
    enemy.update(0, this.map); // snap to path start
    this.enemies.push(enemy);
    this.scene.add(enemy.group);
    this.map.portalBurst();
  }

  private endWave(): void {
    const bonus = Math.round(waveBonus(this.globalWave(this.waveNumber)) * this.mods.killGoldMult);
    this.gold += bonus;
    this.runStats.goldEarned += bonus;
    if (this.waveNumber >= WAVES_PER_LEVEL) {
      this.completeLevel();
      return;
    }
    this.state = 'idle';
    this.countdown = WAVE_COUNTDOWN;
    this.countdownIsLevelStart = false;
    this.ui.showBanner(`Wave ${this.waveNumber} cleared! +${bonus} gold`);
    sfx.waveClear();
    music.setScene('build'); // ease back to the calm build loop between waves
    this.syncStats();
  }

  /**
   * Level cleared: salvage all towers, heal the crystal a little, regenerate
   * a brand-new map and wave schedule at the next difficulty level.
   */
  private completeLevel(): void {
    let salvage = 0;
    for (const t of this.towers) {
      salvage += Math.floor(t.invested * LEVEL_SALVAGE);
      this.scene.remove(t.group);
    }
    this.towers = [];
    for (const p of this.projectiles) {
      this.scene.remove(p.mesh);
      p.dispose();
    }
    this.projectiles = [];
    this.setPlacing(null);
    this.deselect();

    this.gold += salvage;
    this.runStats.goldEarned += salvage;
    this.score += 500 * this.level;
    this.lives = Math.min(this.maxLives, this.lives + LEVEL_HEAL);
    this.level++;
    this.waveNumber = 0;
    this.initRun(); // new map, new waves, harder scaling

    this.state = 'idle';
    this.countdown = LEVEL_COUNTDOWN;
    this.countdownIsLevelStart = true;
    music.setLevel(this.level);   // new level → new key + progression
    music.setScene('build');      // calm down after the level-boss
    this.ui.showBanner(
      `LEVEL ${this.level - 1} CLEARED! +${salvage}g salvage — new battlefield!`, 'boss',
    );
    sfx.levelUp();
    this.syncStats();

    // Arcade variety: draft a net-neutral mutator at the start of every level
    // from level 3 onward. The modal pauses the build timer until a pick is made.
    if (this.runKind === 'arcade' && this.level >= 3) this.openDraft();
  }

  /** Crystal hit 0 lives: kick off the dramatic death sequence, then the game-over screen. */
  private lose(): void {
    if (this.state === 'dying' || this.state === 'lost') return;
    this.state = 'dying';
    this.countdown = -1;
    this.dyingTimer = 1.8;
    music.stop(); // fade the soundtrack so the death sequence lands in silence
    this.setPlacing(null);
    this.deselect();
    this.cancelMeteor();

    // Shatter the crystal, blinding flash, then a staggered burst of explosions.
    this.map.explodeCrystal();
    this.ui.flashScreen();
    sfx.meteorImpact();
    const base = this.map.basePosition;
    this.addVfx(new Explosion(base.clone().setY(1.6), 4.6, 0xfff0c0, 0.5));
    for (let i = 0; i < 6; i++) {
      window.setTimeout(() => {
        if (this.state !== 'dying') return;
        const off = new THREE.Vector3(
          (Math.random() - 0.5) * 4.5, 0.6 + Math.random() * 2.6, (Math.random() - 0.5) * 4.5,
        );
        this.addVfx(new Explosion(
          base.clone().add(off), 1.5 + Math.random() * 1.7,
          Math.random() < 0.5 ? 0xff7a3c : 0x9fe8ff, 0.45,
        ));
        sfx.explosion();
      }, 130 + i * 200);
    }
  }

  /** Crystal-death sequence finished: reveal the game-over screen + shared leaderboard. */
  private async finishLose(): Promise<void> {
    this.state = 'lost';
    sfx.defeat();
    const board = await fetchScores(this.runKind, this.runChallenge());
    const canEnter = qualifies(this.score, board);
    this.ui.showGameOver(
      'THE CRYSTAL HAS FALLEN',
      `You survived to Level ${this.level}, wave ${this.waveNumber}.<br>Final score: <b>${this.score.toLocaleString()}</b>`,
      canEnter,
    );
    if (!canEnter) this.ui.renderScores(board, -1);
  }

  // ---------------------------------------------------------------- combat

  private fire = (tower: Tower, target: Enemy): void => {
    sfx.shoot(tower.spec.id);
    tower.getMuzzleWorld(this.tmpV);
    if (this.qcfg.extras) {
      this.addVfx(new MuzzleFlash(this.tmpV, tower.spec.color, tower.spec.id === 'cannon' ? 0.6 : 0.4));
    }
    if (tower.spec.chain) {
      this.fireChain(tower, target);
    } else if (tower.spec.projectileSpeed === 0) {
      // Hitscan beam: instant damage plus a fading line.
      const to = target.group.position.clone();
      to.y += target.hitY;
      this.addVfx(new Beam(this.tmpV, to, tower.spec.color));
      this.hitEnemy(target, tower.damage, tower);
    } else {
      const params: ShotParams = {
        damage: tower.damage,
        speed: tower.spec.projectileSpeed,
        color: tower.spec.color,
        splashRadius: tower.spec.splashRadius
          ? tower.spec.splashRadius * this.mods.splashRadiusMult
          : undefined,
        slowFactor: tower.spec.slowFactor,
        slowDuration: tower.spec.slowDuration,
        exposesMult: tower.spec.exposesMult,
        big: tower.spec.id === 'cannon',
      };
      const p = new Projectile(params, this.tmpV, target, tower);
      this.projectiles.push(p);
      this.scene.add(p.mesh);
    }
  };

  /** Lightning: jumps from the target to the nearest unhit enemy, with damage falloff. */
  private fireChain(tower: Tower, primary: Enemy): void {
    const falloff = [1, 0.65, 0.5, 0.4, 0.3];
    const hits: Enemy[] = [primary];
    let last = primary;
    while (hits.length < tower.chainTargets) {
      let best: Enemy | null = null;
      let bestD2 = 16; // max jump distance 4 units
      for (const e of this.enemies) {
        if (!e.alive || hits.includes(e)) continue;
        const d2 = e.group.position.distanceToSquared(last.group.position);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = e;
        }
      }
      if (!best) break;
      hits.push(best);
      last = best;
    }

    tower.getMuzzleWorld(this.tmpV);
    let from = this.tmpV.clone();
    hits.forEach((e, i) => {
      const to = e.group.position.clone();
      to.y += e.hitY;
      this.addVfx(new Beam(from, to, tower.spec.color, true));
      this.hitEnemy(e, Math.round(tower.damage * (falloff[i] ?? 0.3)), tower);
      from = to;
    });
  }

  private onProjectileHit(p: Projectile): void {
    const params = p.params;
    if (params.splashRadius) {
      // Frost is a splash tower too: it slows + exposes everyone in the blast.
      const isFrost = !!params.slowFactor;
      sfx.explosion();
      if (this.qcfg.impactFx) {
        this.addVfx(new Explosion(
          p.mesh.position.clone(), params.splashRadius, isFrost ? params.color : undefined,
        ));
      }
      for (const e of this.enemies) {
        if (!e.alive) continue;
        if (e.group.position.distanceTo(p.mesh.position) <= params.splashRadius + 0.3) {
          if (params.slowFactor) {
            e.applySlow(params.slowFactor, params.slowDuration ?? 2, params.exposesMult ?? 1);
          }
          this.hitEnemy(e, params.damage, p.owner);
        }
      }
    } else {
      if (params.slowFactor) p.target.applySlow(params.slowFactor, params.slowDuration ?? 2, params.exposesMult ?? 1);
      this.hitEnemy(p.target, params.damage, p.owner);
    }
  }

  private hitEnemy(e: Enemy, dmg: number, killer?: Tower): void {
    if (!e.alive) return;
    // Some enemies (Troll) shrug off a fraction of lightning/Tesla damage.
    if (killer?.spec.id === 'lightning' && e.lightningResist > 0) {
      dmg = Math.round(dmg * (1 - e.lightningResist));
    }
    // ...but are correspondingly weak to Sniper's armor-piercing beam.
    if (killer?.spec.id === 'sniper' && e.sniperBonus > 0) {
      dmg = Math.round(dmg * (1 + e.sniperBonus));
    }
    // Some enemies (Tank) have no armor/resist at all, but are weak to chain lightning.
    if (killer?.spec.id === 'lightning' && e.lightningBonus > 0) {
      dmg = Math.round(dmg * (1 + e.lightningBonus));
    }
    const wasSlowed = e.slowed;
    const { applied, killed } = e.takeDamage(dmg, killer?.armorPierce ?? 0);
    if (applied > 0) e.flashHit();
    if (applied > 0 && this.effects.length < this.qcfg.damageCap) {
      const pos = e.group.position.clone();
      pos.y += e.hitY * 2 + 0.4;
      this.addVfx(new DamageNumber(pos, applied, applied >= 500 ? '#ffd166' : '#ffffff'));
    }
    if (killed) {
      sfx.enemyDie();
      if (killer) killer.kills++;
      const gold = Math.max(1, Math.round(e.reward * this.mods.killGoldMult));
      this.gold += gold;
      this.runStats.goldEarned += gold;
      this.mana = Math.min(this.manaMax, this.mana + MANA_PER_KILL);
      this.runStats.enemiesKilled++;

      if (e.spec.shape === 'boss') {
        // Bosses are the run's high-score moments: each one escalates the multiplier.
        this.score += Math.round(e.reward * 10 * this.bossMult);
        this.runStats.bossesKilled++;
        this.ui.showBanner(`☠ BOSS DOWN ×${this.bossMult.toFixed(1)}!`, 'boss');
        this.bossMult = Math.min(BOSS_MULT_MAX, this.bossMult + BOSS_MULT_STEP * this.mods.bossMultGainMult);
        this.runStats.maxBossMult = Math.max(this.runStats.maxBossMult, this.bossMult);
        this.ui.setBossMult(this.bossMult);
      } else {
        this.score += e.reward * 10;
      }

      this.spawnDeathVfx(e, wasSlowed);
      this.syncStats();
    }
  }

  /**
   * Death VFX. Performance mode keeps the original single puff; Quality mode
   * (extras) adds frost-shatter for kills-while-slowed and per-archetype bursts.
   */
  private spawnDeathVfx(e: Enemy, wasSlowed: boolean): void {
    const pos = e.group.position.clone().setY(e.hitY);
    const radius = 0.9 + e.spec.size * 0.4;
    if (!this.qcfg.extras) {
      // Performance: a single puff (or nothing at all when impact FX are off).
      if (this.qcfg.impactFx) this.addVfx(new Explosion(pos, radius, e.spec.color));
      return;
    }
    if (wasSlowed) {
      // Frozen enemies shatter into ice shards.
      this.addVfx(new Shatter(pos, {
        count: 12, color: 0x9bd8ff, emissive: 0xaee6ff, size: 0.16, speed: 4, up: 5,
      }));
      this.addVfx(new Explosion(pos, radius * 0.8, 0x9bd8ff, 0.35));
      return;
    }
    switch (e.spec.shape) {
      case 'boss':
        this.addVfx(new Explosion(pos, radius * 1.6, e.spec.color, 0.5));
        this.addVfx(new Explosion(pos, radius * 2.4, 0xffd180, 0.6));
        this.addVfx(new Shatter(pos, {
          count: 22, color: e.spec.color, emissive: 0xff5030, size: 0.28, speed: 7, up: 9, life: 1.1,
        }));
        break;
      case 'armored':
      case 'sphere': // ironback / tank: metal fragments
        this.addVfx(new Explosion(pos, radius, e.spec.color, 0.3));
        this.addVfx(new Shatter(pos, {
          count: 10, color: 0xb8c4d8, emissive: 0x8899aa, size: 0.16, speed: 4, up: 5,
        }));
        break;
      case 'swarm': // tiny puff only
        this.addVfx(new Explosion(pos, radius * 0.8, e.spec.color, 0.25));
        break;
      default: // grunt / runner / troll: puff + a few chunks
        this.addVfx(new Explosion(pos, radius, e.spec.color));
        this.addVfx(new Shatter(pos, {
          count: 7, color: e.spec.color, emissive: e.spec.color, size: 0.15, speed: 3.5, up: 4.5,
        }));
        break;
    }
  }

  private addVfx(v: VFX): void {
    this.effects.push(v);
    this.scene.add(v.obj);
  }

  // ---------------------------------------------------------------- abilities

  /** Abilities start locked; gold unlocks them, then upgrades them up to Lv.5. */
  private buyAbility(id: string): void {
    if (this.paused) return;
    if (this.mods.abilitiesDisabled) { this.ui.showBanner('Abilities are disabled this run.'); return; }
    const spec = ABILITIES.find((a) => a.id === id);
    if (!spec || (this.abilityLevels[id] ?? 0) >= 1) return;
    if (this.gold < spec.unlockCost) {
      this.ui.showBanner('Not enough gold to unlock!');
      return;
    }
    this.gold -= spec.unlockCost;
    this.runStats.goldSpent += spec.unlockCost;
    this.abilityLevels[id] = 1;
    this.runStats.abilities[id] = 1;
    sfx.place();
    this.ui.showBanner(`${spec.name} unlocked!`);
    this.syncStats();
    this.refreshAbilityUI();
  }

  private upgradeAbility(id: string): void {
    if (this.paused) return;
    if (this.mods.abilitiesDisabled) return;
    const spec = ABILITIES.find((a) => a.id === id);
    if (!spec) return;
    const level = this.abilityLevels[id] ?? 0;
    if (level < 1 || level >= this.effectiveMaxLevel(ABILITY_MAX_LEVEL)) return;
    const cost = abilityUpgradeCost(spec, level);
    if (this.gold < cost) {
      this.ui.showBanner('Not enough gold to upgrade!');
      return;
    }
    this.gold -= cost;
    this.runStats.goldSpent += cost;
    this.abilityLevels[id] = level + 1;
    this.runStats.abilities[id] = level + 1;
    sfx.upgrade();
    this.ui.showBanner(`${spec.name} → Lv.${level + 1}!`);
    this.syncStats();
    this.refreshAbilityUI();
  }

  private castAbility(id: string): void {
    if (this.mods.abilitiesDisabled) return;
    const spec = ABILITIES.find((a) => a.id === id);
    if (!spec) return;
    const level = this.abilityLevels[id] ?? 0;
    if (level < 1) {
      this.ui.showBanner(`${spec.name} is locked — buy it first!`);
      return;
    }
    if (this.state !== 'wave' || this.paused) return;
    if ((this.cooldowns[id] ?? 0) > 0) return;
    if (this.mana < spec.manaCost) {
      this.ui.showBanner('Not enough mana!');
      return;
    }

    if (id === 'meteor') {
      this.setPlacing(null);
      this.deselect();
      this.castingMeteor = true;
      this.ui.showMeteorInfo();
      this.updateHover();
      return;
    }

    if (id === 'heal') {
      if (this.lives >= this.maxLives) {
        this.ui.showBanner('Crystal already at full health!');
        return;
      }
      const amt = healAmount(level);
      this.mana -= spec.manaCost;
      this.cooldowns[id] = abilityCooldown(level);
      this.lives = Math.min(this.maxLives, this.lives + amt);
      this.updateCrystalBar();
      sfx.heal();
      this.ui.showBanner(`Crystal repaired +${amt}!`);
      this.addVfx(new Explosion(this.map.basePosition.clone().setY(1.5), 2.5, 0x3ecf6e, 0.5));
      this.syncStats();
      return;
    }

    if (id === 'frenzy') {
      this.mana -= spec.manaCost;
      this.cooldowns[id] = abilityCooldown(level);
      this.frenzyTimer = frenzyDuration(level);
      this.frenzyMultActive = frenzyMult(level);
      sfx.frenzy();
      this.ui.showBanner(`⚡ FRENZY! ×${frenzyMult(level).toFixed(1)} fire rate`);
    }
  }

  /** Current ability HUD state (lock/level/effect/affordability/cooldown) for the sidebar. */
  private abilityStates(): AbilityState[] {
    return ABILITIES.map((a: AbilitySpec) => {
      const level = this.abilityLevels[a.id] ?? 0;
      const cap = this.effectiveMaxLevel(ABILITY_MAX_LEVEL);
      const canUpgrade = level >= 1 && level < cap;
      const gatedAtLevel = level >= 1 && level < ABILITY_MAX_LEVEL && level >= cap ? cap + 1 : null;
      return {
        id: a.id,
        level,
        maxLevel: ABILITY_MAX_LEVEL,
        unlocked: level >= 1,
        unlockCost: a.unlockCost,
        upgradeCost: canUpgrade ? abilityUpgradeCost(a, level) : null,
        gatedAtLevel,
        affordableUnlock: this.gold >= a.unlockCost,
        affordableUpgrade: canUpgrade && this.gold >= abilityUpgradeCost(a, level),
        affordableMana: this.mana >= a.manaCost,
        cooldownLeft: this.cooldowns[a.id] ?? 0,
        usable: this.state === 'wave' && !this.paused,
        effect: this.abilityEffectLabel(a.id, level),
      };
    });
  }

  /** Concrete per-level effect summary; shows Lv.1 preview values while still locked. */
  private abilityEffectLabel(id: string, level: number): string {
    const l = Math.max(level, 1);
    const cd = `${abilityCooldown(l)}s CD`;
    if (id === 'meteor') return `${meteorDamage(l).toLocaleString()} dmg · ${meteorRadius(l).toFixed(1)} radius · ${cd}`;
    if (id === 'heal') return `+${healAmount(l)} crystal HP · ${cd}`;
    if (id === 'frenzy') return `×${frenzyMult(l).toFixed(1)} fire rate · ${frenzyDuration(l)}s · ${cd}`;
    return '';
  }

  private refreshAbilityUI(): void {
    this.ui.updateAbilities(this.abilityStates());
  }

  private castMeteorAt(point: THREE.Vector3): void {
    const spec = ABILITIES.find((a) => a.id === 'meteor')!;
    const level = this.abilityLevels.meteor ?? 1;
    const dmg = meteorDamage(level);
    const radius = meteorRadius(level);
    this.mana -= spec.manaCost;
    this.cooldowns.meteor = abilityCooldown(level);
    this.castingMeteor = false;
    this.rangeGroup.visible = false;
    this.ui.hideInfo();
    const at = point.clone();
    this.addVfx(new Meteor(at, () => {
      sfx.meteorImpact();
      this.addMeteorCrater(at, radius);
      this.addVfx(new Explosion(at.clone().setY(0.5), radius + 0.6, 0xff7a3c, 0.45));
      for (const e of this.enemies) {
        if (!e.alive) continue;
        if (e.group.position.distanceTo(at) <= radius) {
          this.hitEnemy(e, dmg);
        }
      }
    }));
    this.syncStats();
  }

  private cancelMeteor(): void {
    if (this.castingMeteor) {
      this.castingMeteor = false;
      this.rangeGroup.visible = false;
      this.ui.hideInfo();
    }
  }

  // ---------------------------------------------------------------- placement & selection

  private setPlacing(id: string | null): void {
    this.deselect();
    this.cancelMeteor();
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost = null;
    }
    this.placing = id ? TOWER_TYPES.find((t) => t.id === id) ?? null : null;
    this.ui.setSelectedCard(this.placing?.id ?? null);

    if (this.placing) {
      this.ghost = buildTowerMesh(this.placing).group;
      this.ghost.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const m = (o.material as THREE.MeshStandardMaterial).clone();
          m.transparent = true;
          m.opacity = 0.55;
          m.depthWrite = false;
          o.material = m;
          o.castShadow = false;
        }
      });
      this.ghost.visible = false;
      this.scene.add(this.ghost);
      this.ui.showPlacingInfo(this.placing);
    } else {
      this.rangeGroup.visible = false;
      this.ui.hideInfo();
    }
    this.updateHover();
  }

  private updateHover(): void {
    if (!this.placing && !this.castingMeteor) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.tmpV);

    if (this.castingMeteor) {
      if (hit) this.showRange(hit, meteorRadius(this.abilityLevels.meteor ?? 1), 0xff7a3c);
      else this.rangeGroup.visible = false;
      return;
    }

    if (!hit || !this.ghost) {
      if (this.ghost) this.ghost.visible = false;
      this.rangeGroup.visible = false;
      this.hoverCell = null;
      return;
    }
    const { col, row } = this.map.worldToGrid(hit.x, hit.z);
    if (!this.map.inBounds(col, row)) {
      this.ghost.visible = false;
      this.rangeGroup.visible = false;
      this.hoverCell = null;
      return;
    }
    this.hoverCell = { col, row };
    this.hoverValid = this.map.canBuild(col, row)
      && this.gold >= this.towerCost(this.placing!)
      && this.towerAllowed(this.placing!.id)
      && this.underTowerCap();

    const pos = this.map.gridToWorld(col, row);
    this.ghost.position.copy(pos);
    this.ghost.visible = true;
    this.showRange(pos, this.placing!.range * this.mods.towerRangeMult, this.hoverValid ? 0x4ade80 : 0xef4444);
  }

  private showRange(at: THREE.Vector3, range: number, color: number): void {
    this.rangeGroup.position.set(at.x, 0.13, at.z);
    this.rangeGroup.scale.set(range, 1, range);
    this.rangeRingMat.color.setHex(color);
    this.rangeFillMat.color.setHex(color);
    this.rangeGroup.visible = true;
  }

  private handleClick(): void {
    if (this.state === 'lost') return;

    if (this.castingMeteor) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      if (this.raycaster.ray.intersectPlane(this.groundPlane, this.tmpV)) {
        this.castMeteorAt(this.tmpV);
      }
      return;
    }

    if (this.placing) {
      this.tryPlaceTower();
      return;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.tmpV);
    if (hit) {
      const { col, row } = this.map.worldToGrid(hit.x, hit.z);
      const tower = this.towers.find((t) => t.col === col && t.row === row);
      if (tower) {
        this.selectTower(tower);
        return;
      }
    }
    this.deselect();
  }

  /** Purchase cost for a tower spec after the cost mutator. */
  private towerCost(spec: TowerSpec): number {
    return Math.round(spec.cost * this.mods.towerCostMult);
  }

  private towerAllowed(id: string): boolean {
    return !this.mods.allowedTowers || this.mods.allowedTowers.includes(id);
  }

  private underTowerCap(): boolean {
    return this.mods.towerCap === null || this.towers.length < this.mods.towerCap;
  }

  private tryPlaceTower(): void {
    if (this.paused) return;
    if (!this.placing || !this.hoverCell) return;
    if (!this.hoverValid) {
      if (!this.towerAllowed(this.placing.id)) this.ui.showBanner('That tower is locked this challenge.');
      else if (!this.underTowerCap()) this.ui.showBanner(`Tower limit reached (${this.mods.towerCap}).`);
      else if (this.gold < this.towerCost(this.placing)) this.ui.showBanner('Not enough gold!');
      return;
    }
    const { col, row } = this.hoverCell;
    const spec = this.placing;
    const cost = this.towerCost(spec);
    this.gold -= cost;
    this.runStats.goldSpent += cost;
    const tower = new Tower(spec, this.map.gridToWorld(col, row), col, row);
    tower.invested = cost; // reflect the discounted price for refunds
    this.tuneTower(tower);
    this.towers.push(tower);
    this.scene.add(tower.group);
    this.map.occupy(col, row);
    const st = this.runStats.towers[spec.id] ?? { count: 0, maxLevel: 1 };
    st.count++;
    this.runStats.towers[spec.id] = st;
    sfx.place();
    this.syncStats();
    this.updateHover(); // stay in placement mode for quick multi-build
  }

  private selectTower(tower: Tower): void {
    if (this.selected && this.selected !== tower) this.selected.setSelected(false);
    this.selected = tower;
    tower.setSelected(true);
    this.showRange(tower.position, tower.range, 0x62d6ff);
    this.ui.showTowerInfo(tower, this.mods.sellRefundMult);
  }

  private deselect(): void {
    if (this.selected) {
      this.selected.setSelected(false);
      this.selected = null;
      this.rangeGroup.visible = false;
      this.ui.hideInfo();
    }
  }

  private upgradeSelected(): void {
    if (this.paused) return;
    const t = this.selected;
    if (!t || t.upgradePrice === null) return;
    if (this.gold < t.upgradePrice) {
      this.ui.showBanner('Not enough gold!');
      return;
    }
    this.gold -= t.upgradePrice;
    this.runStats.goldSpent += t.upgradePrice;
    t.upgrade();
    this.recordTowerLevel(t);
    sfx.upgrade();
    this.syncStats();
    this.selectTower(t); // refresh panel + range ring
  }

  private recordTowerLevel(t: Tower): void {
    const st = this.runStats.towers[t.spec.id] ?? { count: 1, maxLevel: 1 };
    st.maxLevel = Math.max(st.maxLevel, t.level);
    this.runStats.towers[t.spec.id] = st;
  }

  /** Upgrades towers most-kills-first (your proven performers), breaking ties
   *  by distance to the spawn portal (front-line towers see the most action
   *  and matter most to keep strong), until gold runs out. */
  private upgradeAll(): void {
    if (this.paused) return;
    let upgraded = 0;
    for (;;) {
      const candidates = this.towers
        .filter((t) => t.upgradePrice !== null && t.upgradePrice <= this.gold)
        .sort((a, b) => {
          if (b.kills !== a.kills) return b.kills - a.kills;
          return a.position.distanceTo(this.map.spawnPosition)
            - b.position.distanceTo(this.map.spawnPosition);
        });
      if (candidates.length === 0) break;
      const t = candidates[0];
      this.gold -= t.upgradePrice!;
      this.runStats.goldSpent += t.upgradePrice!;
      t.upgrade();
      this.recordTowerLevel(t);
      upgraded++;
    }
    if (upgraded > 0) {
      this.ui.showBanner(`Upgraded ${upgraded} tower${upgraded > 1 ? 's' : ''}!`);
      sfx.upgrade();
      if (this.selected) this.selectTower(this.selected);
      this.syncStats();
    } else {
      this.ui.showBanner('No affordable upgrades');
    }
  }

  private sellSelected(): void {
    if (this.paused) return;
    if (!this.selected) return;
    const t = this.selected;
    const refund = Math.floor(t.invested * SELL_REFUND * this.mods.sellRefundMult);
    this.gold += refund;
    this.runStats.goldEarned += refund;
    this.map.free(t.col, t.row);
    this.scene.remove(t.group);
    this.towers = this.towers.filter((x) => x !== t);
    sfx.sell();
    this.deselect();
    this.syncStats();
  }

  // ---------------------------------------------------------------- controls

  private togglePause(): void {
    this.paused = !this.paused;
    this.ui.setPauseLabel(this.paused);
  }

  private toggleSpeed(): void {
    this.speedMult = this.speedMult >= 3 ? 1 : this.speedMult + 1; // 1x -> 2x -> 3x -> 1x
    this.ui.setSpeedLabel(this.speedMult);
    music.setSpeed(this.speedMult);
  }

  /** Full restart: back to level 1 on a fresh random map. */
  private reset(): void {
    for (const e of this.enemies) this.scene.remove(e.group);
    for (const t of this.towers) this.scene.remove(t.group);
    for (const p of this.projectiles) {
      this.scene.remove(p.mesh);
      p.dispose();
    }
    for (const v of this.effects) {
      this.scene.remove(v.obj);
      v.dispose?.();
    }
    this.enemies = [];
    this.towers = [];
    this.projectiles = [];
    this.effects = [];
    this.spawnQueue = [];

    // Mutators first: start resources depend on the active set.
    this.runStats = Game.freshStats();
    this.bossMult = BOSS_MULT_BASE;
    this.draftRng = makeRng((this.runSeed ^ 0x9e3779b9) >>> 0);
    this.recomputeMods();
    if (this.runKind === 'daily') {
      const c = this.activeMutators[0];
      this.runStats.challenge = { id: c.id, name: c.name };
    }

    this.gold = Math.max(0, Math.round(START_GOLD * this.mods.startGoldMult));
    this.maxLives = Math.max(1, START_LIVES + this.mods.startLivesDelta);
    this.lives = this.maxLives;
    this.manaMax = MANA_MAX * this.mods.manaMaxMult;
    this.mana = Math.min(START_MANA, this.manaMax);
    this.score = 0;
    this.level = 1;
    this.waveNumber = 0;
    this.state = 'idle';
    this.paused = false;
    this.draftOpen = false;
    this.speedMult = 1;
    this.countdown = LEVEL_COUNTDOWN;
    this.countdownIsLevelStart = true;
    this.cooldowns = {};
    this.abilityLevels = {};
    this.frenzyTimer = 0;
    this.frenzyMultActive = 1;
    this.castingMeteor = false;
    this.dyingTimer = 0;

    this.rng = makeRng(this.runSeed);
    this.initRun();
    this.setPlacing(null);
    this.deselect();

    this.ui.hideOverlay();
    this.ui.setPauseLabel(false);
    this.ui.setSpeedLabel(1);
    this.ui.setBossMult(this.bossMult);
    this.ui.setWaveButton('&#9654; Start Game', true);
    this.syncStats();
  }

  private syncStats(): void {
    this.ui.setStats(this.gold, this.lives, this.mana, this.score, this.waveNumber, this.level);
  }

  // ---------------------------------------------------------------- main loop

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.controls.update();
    this.stars.rotation.y += dt * 0.004; // imperceptibly slow sky drift

    if (!this.paused && !this.draftOpen && this.state !== 'lost') {
      this.step(dt * this.speedMult);
      // Auto-start countdown between waves / levels — deliberately uses the raw
      // (unscaled) dt, so 1x/2x/3x game speed never shortens the build window.
      if (this.state === 'idle' && this.countdown > 0) {
        this.countdown -= dt;
        if (this.countdown <= 0) this.startWave();
      }
    }
    // Billboards track the camera even while paused.
    for (const e of this.enemies) e.faceCamera(this.camera);
    this.crystalBar.quaternion.copy(this.camera.quaternion);

    // Throttled HUD refresh for mana/cooldowns and the wave countdown.
    this.uiPulse -= dt;
    if (this.uiPulse <= 0) {
      this.uiPulse = 0.2;
      this.ui.updateAbilities(this.abilityStates());
      if (this.selected) this.ui.updateTowerKills(this.selected.kills);
      if (this.state === 'idle' && this.countdown > 0) {
        this.ui.setWaveButton(
          `&#9654; Wave ${this.waveNumber + 1} in ${Math.ceil(this.countdown)}s`, true,
        );
      }
      this.ui.setLevelCountdown(
        this.state === 'idle' && this.countdown > 0 && this.countdownIsLevelStart
          ? Math.ceil(this.countdown) : null,
      );
      const el = document.getElementById('stat-mana');
      if (el) el.textContent = String(Math.floor(this.mana));
    }

    this.composer.render();
  };

  private step(dt: number): void {
    this.map.update(dt);

    // Crystal-death finale: let the explosion play, then show the game-over screen.
    if (this.state === 'dying') {
      this.dyingTimer -= dt;
      if (this.dyingTimer <= 0) void this.finishLose();
    }

    // Ability timers
    for (const key of Object.keys(this.cooldowns)) {
      this.cooldowns[key] = Math.max(0, this.cooldowns[key] - dt);
    }
    if (this.frenzyTimer > 0) this.frenzyTimer -= dt;
    const rateMult = this.frenzyTimer > 0 ? this.frenzyMultActive : 1;

    // Spawning + mana regen during combat
    if (this.state === 'wave') {
      this.mana = Math.min(this.manaMax, this.mana + MANA_REGEN * this.mods.manaRegenMult * dt);
      this.waveClock += dt;
      while (this.spawnQueue.length > 0 && this.spawnQueue[0].at <= this.waveClock) {
        this.spawnEnemy(this.spawnQueue.shift()!);
      }
    }

    // Enemies
    let leaked = 0;
    for (const e of this.enemies) {
      e.update(dt, this.map);
      if (e.reachedEnd) leaked += e.spec.livesCost;
    }
    if (leaked > 0) {
      this.lives = Math.max(0, this.lives - leaked);
      this.map.flashCrystal();
      sfx.crystalHit();
      this.updateCrystalBar();
      if (this.qcfg.impactFx) {
        this.addVfx(new Explosion(
          this.map.basePosition.clone().setY(1.6), 1.8, 0xff4040, 0.4,
        ));
      }
      this.syncStats();
      if (this.lives <= 0) {
        this.lose();
        return;
      }
    }
    this.enemies = this.enemies.filter((e) => {
      if (!e.alive) this.scene.remove(e.group);
      return e.alive;
    });

    // Towers
    for (const t of this.towers) t.update(dt, this.enemies, this.fire, rateMult);

    // Projectiles
    for (const p of this.projectiles) {
      if (p.update(dt)) this.onProjectileHit(p);
    }
    this.projectiles = this.projectiles.filter((p) => {
      if (p.done) {
        this.scene.remove(p.mesh);
        p.dispose();
      }
      return !p.done;
    });

    // Effects
    for (const v of this.effects) v.update(dt);
    this.effects = this.effects.filter((v) => {
      if (v.done) {
        this.scene.remove(v.obj);
        v.dispose?.();
      }
      return !v.done;
    });

    // Wave completion
    if (this.state === 'wave' && this.spawnQueue.length === 0 && this.enemies.length === 0) {
      this.endWave();
    }
  }
}
