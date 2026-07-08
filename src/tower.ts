import * as THREE from 'three';
import { levelDamage, levelFireRate, levelRange, MAX_LEVEL, upgradeCost } from './config';
import type { TowerSpec } from './config';
import type { Enemy } from './enemy';

// Whether towers kick back when firing. Disabled in Performance graphics mode
// (the Game toggles it via setTowerRecoil). Module-level so every live tower
// picks up the change on its next update, no per-tower plumbing needed.
let recoilEnabled = true;
export function setTowerRecoil(on: boolean): void {
  recoilEnabled = on;
}

export interface TowerMesh {
  group: THREE.Group;
  head: THREE.Group;
  muzzle: THREE.Object3D;
  pillar: THREE.Mesh;
}

/**
 * Builds the visual for a tower type from primitives.
 * Shared by live towers and the translucent placement ghost.
 */
export function buildTowerMesh(spec: TowerSpec): TowerMesh {
  const group = new THREE.Group();
  const std = (color: number, opts: Record<string, unknown> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...opts });
  const accent = std(spec.color, { emissive: spec.color, emissiveIntensity: 0.7 });
  const dark = std(0x3a4254);
  const steel = std(0x59637a);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.88, 0.5, 16), dark);
  base.position.y = 0.25;
  const trim = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.05, 8, 24), steel);
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.5;
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.46, 0.9, 12), steel);
  pillar.position.y = 0.95;

  const head = new THREE.Group();
  head.position.y = 1.55;
  const muzzle = new THREE.Object3D();

  // Barrel cylinders are baked to point along +Z (the head's lookAt forward).
  const barrelGeo = (radius: number, length: number) => {
    const g = new THREE.CylinderGeometry(radius, radius, length, 10);
    g.rotateX(Math.PI / 2);
    return g;
  };

  switch (spec.id) {
    case 'rapid': {
      const core = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.55), accent);
      const left = new THREE.Mesh(barrelGeo(0.07, 0.75), dark);
      const right = new THREE.Mesh(barrelGeo(0.07, 0.75), dark);
      left.position.set(-0.15, 0, 0.5);
      right.position.set(0.15, 0, 0.5);
      muzzle.position.set(0, 0, 0.9);
      head.add(core, left, right);
      break;
    }
    case 'sniper': {
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10), accent);
      const barrel = new THREE.Mesh(barrelGeo(0.07, 1.5), dark);
      barrel.position.z = 0.8;
      const tip = new THREE.Mesh(barrelGeo(0.1, 0.2), accent);
      tip.position.z = 1.5;
      const scope = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.3), steel);
      scope.position.set(0, 0.22, 0.5);
      muzzle.position.set(0, 0, 1.55);
      head.add(core, barrel, tip, scope);
      break;
    }
    case 'frost': {
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.52), accent);
      crystal.position.y = 0.1;
      const shardMat = std(spec.color, { emissive: spec.color, emissiveIntensity: 1.2 });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), shardMat);
        shard.position.set(Math.cos(a) * 0.55, -0.15, Math.sin(a) * 0.55);
        head.add(shard);
      }
      muzzle.position.set(0, 0.2, 0);
      head.add(crystal);
      break;
    }
    case 'cannon': {
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), dark);
      const barrel = new THREE.Mesh(barrelGeo(0.24, 0.9), accent);
      barrel.position.z = 0.5;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.05, 8, 16), steel);
      ring.position.z = 0.85;
      muzzle.position.set(0, 0, 1.0);
      head.add(core, barrel, ring);
      break;
    }
    case 'lightning': {
      // Tesla coil: stacked rings + a crackling orb on top.
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.7, 10), dark);
      core.position.y = 0.1;
      for (let i = 0; i < 3; i++) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.3 - i * 0.05, 0.05, 8, 18), steel);
        coil.rotation.x = Math.PI / 2;
        coil.position.y = -0.1 + i * 0.22;
        head.add(coil);
      }
      const orbMat = std(spec.color, { emissive: spec.color, emissiveIntensity: 1.8 });
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), orbMat);
      orb.position.y = 0.62;
      muzzle.position.set(0, 0.62, 0);
      head.add(core, orb);
      break;
    }
    default: { // basic
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10), accent);
      const barrel = new THREE.Mesh(barrelGeo(0.1, 0.9), dark);
      barrel.position.z = 0.5;
      muzzle.position.set(0, 0, 0.95);
      head.add(core, barrel);
    }
  }

  head.add(muzzle);
  group.add(base, trim, pillar, head);
  group.traverse((o) => (o.castShadow = true));
  return { group, head, muzzle, pillar };
}

export class Tower {
  readonly spec: TowerSpec;
  readonly col: number;
  readonly row: number;
  readonly group: THREE.Group;
  kills = 0;
  level = 1;
  /** Highest level this tower may currently reach — gated by game level
   * (min(MAX_LEVEL, gameLevel)), set by the Game at placement. */
  levelCap = MAX_LEVEL;
  /** Total gold spent on this tower (purchase + upgrades), used for sell refunds. */
  invested: number;

  // Run-mutator stat multipliers (1 = unmodified). The Game keeps these in sync
  // with the active mutator set on every tower.
  damageMult = 1;
  rangeMult = 1;
  fireRateMult = 1;
  /** Flat enemy armor this tower ignores per hit. */
  armorPierce = 0;

  private head: THREE.Group;
  private muzzle: THREE.Object3D;
  private cooldown = 0;
  /** Recoil kick amount (1 on fire → 0), offsets the head backward along its aim. */
  private recoil = 0;
  private headBase = new THREE.Vector3();
  /** Static outline shown while this tower is the selected one (see setSelected). */
  private selectionRing: THREE.Mesh;

  constructor(spec: TowerSpec, position: THREE.Vector3, col: number, row: number) {
    this.spec = spec;
    this.col = col;
    this.row = row;
    this.invested = spec.cost;
    const mesh = buildTowerMesh(spec);
    this.group = mesh.group;
    this.head = mesh.head;
    this.muzzle = mesh.muzzle;
    this.headBase.copy(this.head.position);
    this.group.position.copy(position);

    // Clears the tower's own base (max radius ~0.88) with a visible gap.
    // depthTest is off so the far side of the ring isn't occluded by the
    // tower's own body from an angled camera -- it always reads as a full
    // circle, the way a selection outline should. Thin and low-opacity so
    // it reads as a subtle marker rather than a flashy highlight.
    this.selectionRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.05, 0.035, 8, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffd166, transparent: true, opacity: 0.7, depthWrite: false, depthTest: false,
      }),
    );
    this.selectionRing.rotation.x = Math.PI / 2;
    // Match the height crater/range-ring ground decals use (0.11-0.13) --
    // any lower and it clips into the ground tile mesh and barely renders.
    this.selectionRing.position.y = 0.14;
    this.selectionRing.renderOrder = 2;
    this.selectionRing.visible = false;
    this.group.add(this.selectionRing);
  }

  /** Toggles the outline ring that marks this tower as selected. */
  setSelected(on: boolean): void {
    this.selectionRing.visible = on;
  }

  // Leveled stats (with active run-mutator multipliers folded in).
  get damage(): number { return Math.round(levelDamage(this.spec, this.level) * this.damageMult); }
  get range(): number { return levelRange(this.spec, this.level) * this.rangeMult; }
  get fireRate(): number { return levelFireRate(this.spec, this.level) * this.fireRateMult; }
  get upgradePrice(): number | null {
    return this.level >= this.levelCap ? null : upgradeCost(this.spec, this.level);
  }
  /** Game level required before the next upgrade unlocks; null once at MAX_LEVEL
   * (truly maxed) or not currently level-gated. */
  get gatedAtLevel(): number | null {
    return this.level < MAX_LEVEL && this.level >= this.levelCap ? this.levelCap + 1 : null;
  }
  /** Lightning only: number of enemies a single shot can chain through. */
  get chainTargets(): number {
    return this.spec.chain ? this.spec.chain + (this.level - 1) : 0;
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Applies the next level: stats via getters, visuals via a glowing ring. */
  upgrade(): void {
    if (this.level >= this.levelCap) return;
    this.invested += this.upgradePrice ?? 0;
    this.level++;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.06, 8, 24),
      new THREE.MeshStandardMaterial({
        color: this.spec.color, emissive: this.spec.color, emissiveIntensity: 1.44, // -20% glow
      }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.62 + 0.28 * (this.level - 2);
    this.group.add(ring);
    this.group.scale.setScalar(1 + 0.07 * (this.level - 1));
  }

  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  update(
    dt: number,
    enemies: Enemy[],
    fire: (tower: Tower, target: Enemy) => void,
    rateMult: number,
  ): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 6);
    const target = this.findTarget(enemies);

    // Reset the head to its rest position each frame, then aim (if we have a
    // target) and apply the recoil kick backward along the aim.
    this.head.position.copy(this.headBase);
    if (target) {
      const p = target.group.position;
      this.head.lookAt(p.x, this.group.position.y + this.head.position.y, p.z);
      if (this.cooldown === 0) {
        fire(this, target);
        if (recoilEnabled) this.recoil = 1;
        this.cooldown = 1 / (this.fireRate * rateMult);
      }
    }
    if (this.recoil > 0) this.head.translateZ(-this.recoil * 0.4);
  }

  /** "First" targeting: the in-range enemy furthest along the path. */
  private findTarget(enemies: Enemy[]): Enemy | null {
    let best: Enemy | null = null;
    const r2 = this.range * this.range;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.group.position.x - this.group.position.x;
      const dz = e.group.position.z - this.group.position.z;
      if (dx * dx + dz * dz > r2) continue;
      if (!best || e.dist > best.dist) best = e;
    }
    return best;
  }
}
