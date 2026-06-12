import * as THREE from 'three';
import type { EnemySpec } from './config';
import type { GameMap } from './map';

const _tmp = new THREE.Vector3();
const _invParent = new THREE.Quaternion();

/** Per-instance stat multipliers from wave scaling + wave modifiers. */
export interface EnemyOpts {
  hpMult: number;
  speedMult: number;
  armorBonus: number;
  regenBonus: number;
  rewardMult: number;
}

function makeBossLabel(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(120, 10, 20, 0.85)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 240, 64, 14);
  ctx.fill();
  ctx.strokeStyle = '#ff5c5c';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = '#ffe1e1';
  ctx.font = 'bold 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BOSS', 128, 42);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false,
  }));
  sprite.scale.set(2.2, 0.7, 1);
  return sprite;
}

export class Enemy {
  readonly spec: EnemySpec;
  readonly group = new THREE.Group();
  /** Height of the body's centre — projectiles aim here. */
  readonly hitY: number;
  /** Gold granted on kill (after modifier scaling). */
  readonly reward: number;
  readonly armor: number;

  hp: number;
  maxHp: number;
  /** Distance travelled along the path; also used for "first" targeting priority. */
  dist = 0;
  alive = true;
  reachedEnd = false;

  private speedMult: number;
  private regenRate: number;
  private slowTimer = 0;
  private slowFactor = 1;
  private bodyMat: THREE.MeshStandardMaterial;
  private baseColor: THREE.Color;
  private hpBar = new THREE.Group();
  private hpFill: THREE.Mesh;
  private hpFillMat: THREE.MeshBasicMaterial;

  constructor(spec: EnemySpec, opts: EnemyOpts) {
    this.spec = spec;
    this.maxHp = Math.round(spec.hp * opts.hpMult);
    this.hp = this.maxHp;
    this.speedMult = opts.speedMult;
    this.armor = (spec.armor ?? 0) + opts.armorBonus;
    this.regenRate = (spec.regen ?? 0) + opts.regenBonus;
    this.reward = Math.max(1, Math.round(spec.reward * opts.rewardMult));

    this.baseColor = new THREE.Color(spec.color);
    this.bodyMat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.7 });
    const { body, bodyY } = this.buildBody(spec);
    this.hitY = bodyY;
    this.group.add(body);

    // Billboarded health bar: black backing + left-anchored fill.
    const barW = Math.max(1.3, spec.size * 1.5);
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(barW, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x10141f }),
    );
    const fillGeo = new THREE.PlaneGeometry(barW - 0.06, 0.11);
    fillGeo.translate((barW - 0.06) / 2, 0, 0.01); // origin at left edge so scale.x shrinks rightwards
    this.hpFillMat = new THREE.MeshBasicMaterial({ color: 0x44dd55 });
    this.hpFill = new THREE.Mesh(fillGeo, this.hpFillMat);
    this.hpFill.position.x = -(barW - 0.06) / 2;
    this.hpBar.add(bg, this.hpFill);
    this.hpBar.position.y = bodyY * 2 + 0.7;
    this.group.add(this.hpBar);

    if (spec.shape === 'boss') {
      const label = makeBossLabel();
      label.position.y = bodyY * 2 + 1.5;
      this.group.add(label);
    }
  }

  /** Distinct silhouette per enemy archetype, all from primitives. */
  private buildBody(spec: EnemySpec): { body: THREE.Group; bodyY: number } {
    const s = spec.size;
    const body = new THREE.Group();
    let bodyY: number;
    const darker = new THREE.MeshStandardMaterial({
      color: this.baseColor.clone().multiplyScalar(0.55), roughness: 0.8,
    });

    switch (spec.shape) {
      case 'cone': {
        const m = new THREE.Mesh(new THREE.ConeGeometry(s * 0.55, s * 1.6, 8), this.bodyMat);
        bodyY = s * 0.8;
        m.position.y = bodyY;
        body.add(m);
        break;
      }
      case 'sphere': { // tank: sphere with an armored band
        const m = new THREE.Mesh(new THREE.SphereGeometry(s * 0.7, 16, 12), this.bodyMat);
        bodyY = s * 0.7;
        m.position.y = bodyY;
        const band = new THREE.Mesh(new THREE.TorusGeometry(s * 0.68, s * 0.12, 8, 20), darker);
        band.rotation.x = Math.PI / 2;
        band.position.y = bodyY;
        body.add(m, band);
        break;
      }
      case 'swarm': {
        const m = new THREE.Mesh(new THREE.TetrahedronGeometry(s), this.bodyMat);
        bodyY = s * 0.7;
        m.position.y = bodyY;
        m.rotation.x = -0.6;
        body.add(m);
        break;
      }
      case 'armored': { // box wrapped in steel plates
        const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 1.2, s), this.bodyMat);
        bodyY = s * 0.6;
        m.position.y = bodyY;
        const plateMat = new THREE.MeshStandardMaterial({
          color: 0xb8c4d8, roughness: 0.35, metalness: 0.7,
        });
        const plateL = new THREE.Mesh(new THREE.BoxGeometry(0.08, s * 1.3, s * 1.1), plateMat);
        plateL.position.set(-s * 0.55, bodyY, 0);
        const plateR = plateL.clone();
        plateR.position.x = s * 0.55;
        body.add(m, plateL, plateR);
        break;
      }
      case 'regen': { // sphere with orbiting heal-orbs
        const m = new THREE.Mesh(new THREE.SphereGeometry(s * 0.65, 14, 10), this.bodyMat);
        bodyY = s * 0.65;
        m.position.y = bodyY;
        body.add(m);
        const orbMat = new THREE.MeshStandardMaterial({
          color: 0x6dff9e, emissive: 0x2ecc71, emissiveIntensity: 1.6,
        });
        for (let i = 0; i < 3; i++) {
          const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 5), orbMat);
          const a = (i / 3) * Math.PI * 2;
          orb.position.set(Math.cos(a) * s * 0.85, bodyY + 0.2, Math.sin(a) * s * 0.85);
          body.add(orb);
        }
        break;
      }
      case 'boss': { // spiked icosahedron
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), this.bodyMat);
        bodyY = s;
        m.position.y = bodyY;
        body.add(m);
        const spikeMat = new THREE.MeshStandardMaterial({
          color: 0x2b0a10, emissive: 0xaa1830, emissiveIntensity: 0.8,
        });
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const spike = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.8, 6), spikeMat);
          spike.position.set(Math.cos(a) * s * 0.9, bodyY + 0.3, Math.sin(a) * s * 0.9);
          spike.rotation.z = -Math.cos(a) * 0.9;
          spike.rotation.x = Math.sin(a) * 0.9;
          body.add(spike);
        }
        break;
      }
      default: { // grunt: box with a dark "head"
        const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 1.2, s), this.bodyMat);
        bodyY = s * 0.6;
        m.position.y = bodyY;
        const head = new THREE.Mesh(new THREE.BoxGeometry(s * 0.55, s * 0.4, s * 0.55), darker);
        head.position.y = s * 1.4;
        body.add(m, head);
      }
    }

    body.traverse((o) => (o.castShadow = true));
    return { body, bodyY };
  }

  applySlow(factor: number, duration: number): void {
    this.slowFactor = Math.min(this.slowFactor, factor);
    this.slowTimer = Math.max(this.slowTimer, duration);
    this.bodyMat.color.copy(this.baseColor).lerp(new THREE.Color(0x9bd8ff), 0.55);
  }

  /** Applies armor, then damage. Returns the damage actually dealt (0 if already dead). */
  takeDamage(dmg: number): { applied: number; killed: boolean } {
    if (!this.alive) return { applied: 0, killed: false };
    // Armor is flat reduction per hit, but at least 25% always lands.
    const applied = Math.round(Math.max(dmg - this.armor, dmg * 0.25));
    this.hp -= applied;
    this.refreshHpBar();
    if (this.hp <= 0) {
      this.alive = false;
      return { applied, killed: true };
    }
    return { applied, killed: false };
  }

  private refreshHpBar(): void {
    const frac = Math.max(Math.min(this.hp / this.maxHp, 1), 0);
    this.hpFill.scale.x = frac;
    this.hpFillMat.color.setHSL(frac * 0.33, 0.9, 0.5); // green -> yellow -> red
  }

  update(dt: number, map: GameMap): void {
    if (!this.alive) return;

    if (this.regenRate > 0 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + this.regenRate * dt);
      this.refreshHpBar();
    }

    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      if (this.slowTimer <= 0) {
        this.slowFactor = 1;
        this.bodyMat.color.copy(this.baseColor);
      }
    }

    this.dist += this.spec.speed * this.speedMult * this.slowFactor * dt;
    if (this.dist >= map.totalLength) {
      this.reachedEnd = true;
      this.alive = false;
      return;
    }

    map.pointAt(this.dist, this.group.position);
    // Face direction of travel.
    map.pointAt(Math.min(this.dist + 0.5, map.totalLength), _tmp);
    _tmp.sub(this.group.position);
    if (_tmp.lengthSq() > 1e-6) this.group.rotation.y = Math.atan2(_tmp.x, _tmp.z);
  }

  /** Keep the health bar facing the camera (called every rendered frame). */
  faceCamera(camera: THREE.Camera): void {
    _invParent.copy(this.group.quaternion).invert();
    this.hpBar.quaternion.copy(_invParent).multiply(camera.quaternion);
  }
}
