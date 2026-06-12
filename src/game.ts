import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  ABILITIES, ENEMY_TYPES, FRENZY_DURATION, FRENZY_MULT, HEAL_AMOUNT,
  LEVEL_COUNTDOWN, LEVEL_HEAL, LEVEL_SALVAGE,
  MANA_MAX, MANA_PER_KILL, MANA_REGEN, METEOR_DAMAGE, METEOR_RADIUS,
  SELL_REFUND, START_GOLD, START_LIVES, START_MANA, TOWER_TYPES,
  WAVES_PER_LEVEL, WAVE_COUNTDOWN,
  levelRewardMult, waveBonus, waveHpMult, waveSpeedMult,
} from './config';
import type { TowerSpec } from './config';
import { GameMap } from './map';
import { Enemy } from './enemy';
import type { EnemyOpts } from './enemy';
import { Tower, buildTowerMesh } from './tower';
import { Projectile } from './projectile';
import type { ShotParams } from './projectile';
import { Beam, DamageNumber, Explosion, Meteor } from './effects';
import type { VFX } from './effects';
import { UI } from './ui';
import { sfx } from './audio';
import { addScore, loadScores, qualifies } from './leaderboard';
import { generateLevel } from './waves';
import type { GeneratedWave } from './waves';
import { makeRng } from './rng';
import type { RNG } from './rng';

type State = 'ready' | 'idle' | 'wave' | 'lost';

interface SpawnOrder {
  at: number;
  type: string;
  opts: EnemyOpts;
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
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
  private mana = START_MANA;
  private score = 0;
  private level = 1;
  private waveNumber = 0;
  private waveDefs: GeneratedWave[] = [];
  private spawnQueue: SpawnOrder[] = [];
  private waveClock = 0;
  /** Seconds until the next wave auto-starts (negative = no countdown running). */
  private countdown = -1;

  // Abilities
  private cooldowns: Record<string, number> = {};
  private frenzyTimer = 0;
  private castingMeteor = false;

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
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
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
    this.composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.4, 0.78,
    ));
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
    this.initRun();
    this.syncStats();
    this.ui.setWaveButton('&#9654; Start Game', true);

    window.addEventListener('resize', this.onResize);
    // Handy for debugging in the console.
    (window as unknown as Record<string, unknown>).__game = this;
    this.animate();
  }

  // ---------------------------------------------------------------- setup

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x33402e, 0.8));
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
  }

  /** Faint stars on a dome far beyond the island; they ignore the scene fog. */
  private buildStars(): void {
    const count = 700;
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
    this.map?.dispose();
    this.map = new GameMap(this.scene, this.rng);
    this.waveDefs = generateLevel(this.rng, this.level);
    this.ui.setNextWaveHint(this.waveDefs[0].hint);
    this.positionCrystalBar();
    this.updateCrystalBar();
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
    const frac = Math.max(0, Math.min(this.lives / START_LIVES, 1));
    this.crystalFill.scale.x = frac;
    // Cyan when healthy, shifting to red as the crystal weakens.
    this.crystalFillMat.color.setHSL(0.52 * frac, 0.85, 0.55);
  }

  private bindUI(): void {
    this.ui.onSelectTower = (id) => this.setPlacing(this.placing?.id === id ? null : id);
    this.ui.onAbility = (id) => this.castAbility(id);
    this.ui.onWaveButton = () => this.startWave();
    this.ui.onUpgradeAll = () => this.upgradeAll();
    this.ui.onPause = () => this.togglePause();
    this.ui.onSpeed = () => this.toggleSpeed();
    this.ui.onRestart = () => this.reset();
    this.ui.onSell = () => this.sellSelected();
    this.ui.onUpgrade = () => this.upgradeSelected();
    this.ui.onMute = () => this.ui.setMuteLabel(sfx.toggle());
    this.ui.setMuteLabel(sfx.isMuted);
    this.ui.onSubmitScore = (initials) => {
      const rank = addScore({
        initials, score: this.score, level: this.level,
        wave: this.waveNumber, date: Date.now(),
      });
      this.ui.renderScores(loadScores(), rank);
    };
  }

  private bindInput(): void {
    // Browsers only allow audio after a user gesture; unlock is idempotent.
    window.addEventListener('pointerdown', () => sfx.unlock());
    window.addEventListener('keydown', () => sfx.unlock());

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
      const towerIdx = parseInt(e.key, 10) - 1;
      if (towerIdx >= 0 && towerIdx < TOWER_TYPES.length) {
        this.setPlacing(TOWER_TYPES[towerIdx].id);
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

  // ---------------------------------------------------------------- waves & levels

  private globalWave(wave: number): number {
    return (this.level - 1) * WAVES_PER_LEVEL + wave;
  }

  private startWave(): void {
    if (this.state !== 'ready' && this.state !== 'idle') return;
    this.countdown = -1;
    this.waveNumber++;
    this.waveClock = 0;
    this.spawnQueue = [];

    const def = this.waveDefs[this.waveNumber - 1];
    const mod = def.modifier;
    const gw = this.globalWave(this.waveNumber);
    const hpMult = waveHpMult(gw) * (mod?.hpMult ?? 1);
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
    const bonus = waveBonus(this.globalWave(this.waveNumber));
    this.gold += bonus;
    if (this.waveNumber >= WAVES_PER_LEVEL) {
      this.completeLevel();
      return;
    }
    this.state = 'idle';
    this.countdown = WAVE_COUNTDOWN;
    this.ui.showBanner(`Wave ${this.waveNumber} cleared! +${bonus} gold`);
    sfx.waveClear();
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
    this.score += 500 * this.level;
    this.lives = Math.min(START_LIVES, this.lives + LEVEL_HEAL);
    this.level++;
    this.waveNumber = 0;
    this.initRun(); // new map, new waves, harder scaling

    this.state = 'idle';
    this.countdown = LEVEL_COUNTDOWN;
    this.ui.showBanner(
      `LEVEL ${this.level - 1} CLEARED! +${salvage}g salvage — new battlefield!`, 'boss',
    );
    sfx.levelUp();
    this.syncStats();
  }

  private lose(): void {
    this.state = 'lost';
    this.countdown = -1;
    const canEnter = qualifies(this.score);
    this.ui.showGameOver(
      'THE CRYSTAL HAS FALLEN',
      `You survived to Level ${this.level}, wave ${this.waveNumber}.<br>Final score: <b>${this.score.toLocaleString()}</b>`,
      canEnter,
    );
    if (!canEnter) this.ui.renderScores(loadScores(), -1);
    sfx.defeat();
  }

  // ---------------------------------------------------------------- combat

  private fire = (tower: Tower, target: Enemy): void => {
    sfx.shoot(tower.spec.id);
    tower.getMuzzleWorld(this.tmpV);
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
        splashRadius: tower.spec.splashRadius,
        slowFactor: tower.spec.slowFactor,
        slowDuration: tower.spec.slowDuration,
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
      sfx.explosion();
      this.addVfx(new Explosion(p.mesh.position.clone(), params.splashRadius));
      for (const e of this.enemies) {
        if (!e.alive) continue;
        if (e.group.position.distanceTo(p.mesh.position) <= params.splashRadius + 0.3) {
          this.hitEnemy(e, params.damage, p.owner);
        }
      }
    } else {
      if (params.slowFactor) p.target.applySlow(params.slowFactor, params.slowDuration ?? 2);
      this.hitEnemy(p.target, params.damage, p.owner);
    }
  }

  private hitEnemy(e: Enemy, dmg: number, killer?: Tower): void {
    if (!e.alive) return;
    const { applied, killed } = e.takeDamage(dmg);
    if (applied > 0 && this.effects.length < 90) {
      const pos = e.group.position.clone();
      pos.y += e.hitY * 2 + 0.4;
      this.addVfx(new DamageNumber(pos, applied, applied >= 500 ? '#ffd166' : '#ffffff'));
    }
    if (killed) {
      sfx.enemyDie();
      if (killer) killer.kills++;
      this.gold += e.reward;
      this.mana = Math.min(MANA_MAX, this.mana + MANA_PER_KILL);
      this.score += e.reward * 10;
      this.addVfx(new Explosion(
        e.group.position.clone().setY(e.hitY), 0.9 + e.spec.size * 0.4, e.spec.color,
      ));
      this.syncStats();
    }
  }

  private addVfx(v: VFX): void {
    this.effects.push(v);
    this.scene.add(v.obj);
  }

  // ---------------------------------------------------------------- abilities

  private castAbility(id: string): void {
    const spec = ABILITIES.find((a) => a.id === id);
    if (!spec) return;
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
      if (this.lives >= START_LIVES) {
        this.ui.showBanner('Crystal already at full health!');
        return;
      }
      this.mana -= spec.manaCost;
      this.cooldowns[id] = spec.cooldown;
      this.lives = Math.min(START_LIVES, this.lives + HEAL_AMOUNT);
      this.updateCrystalBar();
      sfx.heal();
      this.ui.showBanner(`Crystal repaired +${HEAL_AMOUNT}!`);
      this.addVfx(new Explosion(this.map.basePosition.clone().setY(1.5), 2.5, 0x3ecf6e, 0.5));
      this.syncStats();
      return;
    }

    if (id === 'frenzy') {
      this.mana -= spec.manaCost;
      this.cooldowns[id] = spec.cooldown;
      this.frenzyTimer = FRENZY_DURATION;
      sfx.frenzy();
      this.ui.showBanner(`⚡ FRENZY! ×${FRENZY_MULT} fire rate`);
    }
  }

  private castMeteorAt(point: THREE.Vector3): void {
    const spec = ABILITIES.find((a) => a.id === 'meteor')!;
    this.mana -= spec.manaCost;
    this.cooldowns.meteor = spec.cooldown;
    this.castingMeteor = false;
    this.rangeGroup.visible = false;
    this.ui.hideInfo();
    const at = point.clone();
    this.addVfx(new Meteor(at, () => {
      sfx.meteorImpact();
      this.addVfx(new Explosion(at.clone().setY(0.5), METEOR_RADIUS + 0.6, 0xff7a3c, 0.45));
      for (const e of this.enemies) {
        if (!e.alive) continue;
        if (e.group.position.distanceTo(at) <= METEOR_RADIUS) {
          this.hitEnemy(e, METEOR_DAMAGE);
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
      if (hit) this.showRange(hit, METEOR_RADIUS, 0xff7a3c);
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
    this.hoverValid = this.map.canBuild(col, row) && this.gold >= this.placing!.cost;

    const pos = this.map.gridToWorld(col, row);
    this.ghost.position.copy(pos);
    this.ghost.visible = true;
    this.showRange(pos, this.placing!.range, this.hoverValid ? 0x4ade80 : 0xef4444);
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

  private tryPlaceTower(): void {
    if (!this.placing || !this.hoverCell) return;
    if (!this.hoverValid) {
      if (this.gold < this.placing.cost) this.ui.showBanner('Not enough gold!');
      return;
    }
    const { col, row } = this.hoverCell;
    const spec = this.placing;
    this.gold -= spec.cost;
    const tower = new Tower(spec, this.map.gridToWorld(col, row), col, row);
    this.towers.push(tower);
    this.scene.add(tower.group);
    this.map.occupy(col, row);
    sfx.place();
    this.syncStats();
    this.updateHover(); // stay in placement mode for quick multi-build
  }

  private selectTower(tower: Tower): void {
    this.selected = tower;
    this.showRange(tower.position, tower.range, 0x62d6ff);
    this.ui.showTowerInfo(tower);
  }

  private deselect(): void {
    if (this.selected) {
      this.selected = null;
      this.rangeGroup.visible = false;
      this.ui.hideInfo();
    }
  }

  private upgradeSelected(): void {
    const t = this.selected;
    if (!t || t.upgradePrice === null) return;
    if (this.gold < t.upgradePrice) {
      this.ui.showBanner('Not enough gold!');
      return;
    }
    this.gold -= t.upgradePrice;
    t.upgrade();
    sfx.upgrade();
    this.syncStats();
    this.selectTower(t); // refresh panel + range ring
  }

  /** Upgrades towers cheapest-first until gold runs out. */
  private upgradeAll(): void {
    let upgraded = 0;
    for (;;) {
      const candidates = this.towers
        .filter((t) => t.upgradePrice !== null && t.upgradePrice <= this.gold)
        .sort((a, b) => (a.upgradePrice ?? 0) - (b.upgradePrice ?? 0));
      if (candidates.length === 0) break;
      const t = candidates[0];
      this.gold -= t.upgradePrice!;
      t.upgrade();
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
    if (!this.selected) return;
    const t = this.selected;
    this.gold += Math.floor(t.invested * SELL_REFUND);
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

    this.gold = START_GOLD;
    this.lives = START_LIVES;
    this.mana = START_MANA;
    this.score = 0;
    this.level = 1;
    this.waveNumber = 0;
    this.state = 'ready';
    this.paused = false;
    this.speedMult = 1;
    this.countdown = -1;
    this.cooldowns = {};
    this.frenzyTimer = 0;
    this.castingMeteor = false;

    this.rng = makeRng(Date.now());
    this.initRun();
    this.setPlacing(null);
    this.deselect();

    this.ui.hideOverlay();
    this.ui.setPauseLabel(false);
    this.ui.setSpeedLabel(1);
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

    if (!this.paused && this.state !== 'lost') {
      this.step(dt * this.speedMult);
    }
    // Billboards track the camera even while paused.
    for (const e of this.enemies) e.faceCamera(this.camera);
    this.crystalBar.quaternion.copy(this.camera.quaternion);

    // Throttled HUD refresh for mana/cooldowns and the wave countdown.
    this.uiPulse -= dt;
    if (this.uiPulse <= 0) {
      this.uiPulse = 0.2;
      this.ui.updateAbilities(ABILITIES.map((a) => ({
        id: a.id,
        affordable: this.mana >= a.manaCost,
        cooldownLeft: this.cooldowns[a.id] ?? 0,
        usable: this.state === 'wave' && !this.paused,
      })));
      if (this.state === 'idle' && this.countdown > 0) {
        this.ui.setWaveButton(
          `&#9654; Wave ${this.waveNumber + 1} in ${Math.ceil(this.countdown)}s — Start Now`, true,
        );
      }
      const el = document.getElementById('stat-mana');
      if (el) el.textContent = String(Math.floor(this.mana));
    }

    this.composer.render();
  };

  private step(dt: number): void {
    this.map.update(dt);

    // Auto-start countdown between waves / levels.
    if (this.state === 'idle' && this.countdown > 0) {
      this.countdown -= dt;
      if (this.countdown <= 0) this.startWave();
    }

    // Ability timers
    for (const key of Object.keys(this.cooldowns)) {
      this.cooldowns[key] = Math.max(0, this.cooldowns[key] - dt);
    }
    if (this.frenzyTimer > 0) this.frenzyTimer -= dt;
    const rateMult = this.frenzyTimer > 0 ? FRENZY_MULT : 1;

    // Spawning + mana regen during combat
    if (this.state === 'wave') {
      this.mana = Math.min(MANA_MAX, this.mana + MANA_REGEN * dt);
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
      this.addVfx(new Explosion(
        this.map.basePosition.clone().setY(1.6), 1.8, 0xff4040, 0.4,
      ));
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
