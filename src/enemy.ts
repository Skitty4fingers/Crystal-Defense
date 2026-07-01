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
  /** Fractional reduction applied to lightning (Tesla) damage, 0-1. */
  readonly lightningResist: number;
  /** Fractional bonus damage taken from Sniper hits, 0-1. */
  readonly sniperBonus: number;

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
  private exposedMult = 1;
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
    this.lightningResist = spec.lightningResist ?? 0;
    this.sniperBonus = spec.sniperBonus ?? 0;
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
    // Glowing eyes shared by most archetypes (color varies a touch per type).
    const eyeMat = (color: number) => new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 2,
    });
    const addEyes = (color: number, x: number, y: number, z: number, r: number) => {
      const mat = eyeMat(color);
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat);
        eye.position.set(side * x, y, z);
        body.add(eye);
      }
    };

    switch (spec.shape) {
      case 'cone': { // runner: finned dart
        const m = new THREE.Mesh(new THREE.ConeGeometry(s * 0.55, s * 1.6, 24), this.bodyMat);
        bodyY = s * 0.8;
        m.position.y = bodyY;
        body.add(m);
        // Swept-back tail fins.
        for (const [fx, fy] of [[-0.45, 0.45], [0.45, 0.45], [0, 0.95]]) {
          const fin = new THREE.Mesh(new THREE.ConeGeometry(s * 0.14, s * 0.65, 10), darker);
          fin.position.set(s * fx, s * fy, -s * 0.3);
          fin.rotation.x = -0.9;
          body.add(fin);
        }
        addEyes(0xffe08a, s * 0.16, s * 0.85, s * 0.38, s * 0.08);
        break;
      }
      case 'sphere': { // tank: riveted sphere with hatch
        const m = new THREE.Mesh(new THREE.SphereGeometry(s * 0.7, 28, 20), this.bodyMat);
        bodyY = s * 0.7;
        m.position.y = bodyY;
        const band = new THREE.Mesh(new THREE.TorusGeometry(s * 0.68, s * 0.12, 12, 36), darker);
        band.rotation.x = Math.PI / 2;
        band.position.y = bodyY;
        body.add(m, band);
        // Rivets studding the armor band.
        const rivetMat = new THREE.MeshStandardMaterial({
          color: 0xb8c4d8, roughness: 0.35, metalness: 0.7,
        });
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const rivet = new THREE.Mesh(new THREE.SphereGeometry(s * 0.09, 8, 6), rivetMat);
          rivet.position.set(Math.cos(a) * s * 0.8, bodyY, Math.sin(a) * s * 0.8);
          body.add(rivet);
        }
        // Top hatch.
        const hatch = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.22, s * 0.26, s * 0.14, 16), darker);
        hatch.position.y = bodyY + s * 0.66;
        const dome = new THREE.Mesh(new THREE.SphereGeometry(s * 0.16, 12, 8), rivetMat);
        dome.position.y = bodyY + s * 0.76;
        body.add(hatch, dome);
        addEyes(0xff8a5c, s * 0.22, bodyY + s * 0.18, s * 0.6, s * 0.09);
        break;
      }
      case 'swarm': { // swarmer: faceted gem with stub wings
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(s * 0.9, 0), this.bodyMat);
        bodyY = s * 0.7;
        m.position.y = bodyY;
        m.rotation.y = Math.PI / 4;
        body.add(m);
        for (const side of [-1, 1]) {
          const wing = new THREE.Mesh(new THREE.BoxGeometry(s * 0.85, 0.03, s * 0.35), darker);
          wing.position.set(side * s * 0.6, bodyY + s * 0.15, -s * 0.1);
          wing.rotation.z = side * 0.5;
          body.add(wing);
        }
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(s * 0.22, 10, 8), eyeMat(0xfff1a8),
        );
        core.position.y = bodyY;
        body.add(core);
        break;
      }
      case 'armored': { // ironback: plated box with visor and bolts
        const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 1.2, s), this.bodyMat);
        bodyY = s * 0.6;
        m.position.y = bodyY;
        body.add(m);
        const plateMat = new THREE.MeshStandardMaterial({
          color: 0xb8c4d8, roughness: 0.35, metalness: 0.7,
        });
        // Side, front and back plates.
        for (const [px, pz, w, d] of [
          [-0.55, 0, 0.08, s * 1.1], [0.55, 0, 0.08, s * 1.1],
          [0, 0.55, s * 1.1, 0.08], [0, -0.55, s * 1.1, 0.08],
        ]) {
          const plate = new THREE.Mesh(new THREE.BoxGeometry(w as number, s * 1.3, d as number), plateMat);
          plate.position.set(s * (px as number), bodyY, s * (pz as number));
          body.add(plate);
        }
        // Bolts on the side plates.
        for (const sx of [-1, 1]) {
          for (const bz of [-0.3, 0.3]) {
            for (const by of [0.35, 0.85]) {
              const bolt = new THREE.Mesh(new THREE.SphereGeometry(s * 0.07, 8, 6), darker);
              bolt.position.set(sx * s * 0.6, s * by, s * bz);
              body.add(bolt);
            }
          }
        }
        // Helmet ridge + glowing visor slit instead of eyes.
        const ridge = new THREE.Mesh(new THREE.BoxGeometry(s * 0.25, s * 0.18, s * 1.05), plateMat);
        ridge.position.y = s * 1.28;
        const visor = new THREE.Mesh(new THREE.BoxGeometry(s * 0.5, s * 0.1, 0.03), eyeMat(0xff4444));
        visor.position.set(0, s * 1.0, s * 0.56);
        body.add(ridge, visor);
        break;
      }
      case 'regen': { // troll: warty sphere with stub arms and orbiting heal-orbs
        const m = new THREE.Mesh(new THREE.SphereGeometry(s * 0.65, 24, 18), this.bodyMat);
        bodyY = s * 0.65;
        m.position.y = bodyY;
        body.add(m);
        // Warts at fixed spots on the hide.
        for (const [wx, wy, wz, wr] of [
          [0.45, 0.9, 0.25, 0.14], [-0.5, 0.55, 0.3, 0.11], [0.2, 0.35, -0.55, 0.13],
          [-0.3, 1.0, -0.3, 0.1], [0.55, 0.5, -0.2, 0.09],
        ]) {
          const wart = new THREE.Mesh(new THREE.SphereGeometry(s * (wr as number), 10, 8), darker);
          wart.position.set(s * (wx as number), s * (wy as number), s * (wz as number));
          body.add(wart);
        }
        // Stubby arms.
        for (const side of [-1, 1]) {
          const arm = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.12, s * 0.16, s * 0.5, 10), darker);
          arm.position.set(side * s * 0.68, bodyY - s * 0.1, s * 0.1);
          arm.rotation.z = side * 0.6;
          body.add(arm);
        }
        const orbMat = new THREE.MeshStandardMaterial({
          color: 0x6dff9e, emissive: 0x2ecc71, emissiveIntensity: 1.6,
        });
        for (let i = 0; i < 3; i++) {
          const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), orbMat);
          const a = (i / 3) * Math.PI * 2;
          orb.position.set(Math.cos(a) * s * 0.85, bodyY + 0.2, Math.sin(a) * s * 0.85);
          body.add(orb);
        }
        addEyes(0xd2ff6d, s * 0.2, bodyY + s * 0.25, s * 0.55, s * 0.08);
        break;
      }
      case 'boss': { // boss: faceted gem core, double spike crown, glowing ring
        this.bodyMat.flatShading = true; // keep the gem look on the subdivided icosahedron
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), this.bodyMat);
        bodyY = s;
        m.position.y = bodyY;
        body.add(m);
        const spikeMat = new THREE.MeshStandardMaterial({
          color: 0x2b0a10, emissive: 0xaa1830, emissiveIntensity: 0.8,
        });
        // Outer spike crown.
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const spike = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.8, 10), spikeMat);
          spike.position.set(Math.cos(a) * s * 0.9, bodyY + 0.3, Math.sin(a) * s * 0.9);
          spike.rotation.z = -Math.cos(a) * 0.9;
          spike.rotation.x = Math.sin(a) * 0.9;
          body.add(spike);
        }
        // Inner upward spikes.
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + 0.3;
          const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.55, 8), spikeMat);
          spike.position.set(Math.cos(a) * s * 0.45, bodyY + s * 0.8, Math.sin(a) * s * 0.45);
          spike.rotation.z = -Math.cos(a) * 0.35;
          spike.rotation.x = Math.sin(a) * 0.35;
          body.add(spike);
        }
        // Glowing equator ring.
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(s * 0.85, 0.06, 10, 40), eyeMat(0xff3040),
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = bodyY;
        body.add(ring);
        addEyes(0xffd24d, s * 0.25, bodyY + s * 0.3, s * 0.8, s * 0.1);
        break;
      }
      default: { // grunt: box soldier with head, shoulder pads and eyes
        const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 1.2, s), this.bodyMat);
        bodyY = s * 0.6;
        m.position.y = bodyY;
        const head = new THREE.Mesh(new THREE.BoxGeometry(s * 0.55, s * 0.4, s * 0.55), darker);
        head.position.y = s * 1.4;
        body.add(m, head);
        for (const side of [-1, 1]) {
          const pad = new THREE.Mesh(new THREE.SphereGeometry(s * 0.26, 12, 10), darker);
          pad.position.set(side * s * 0.55, s * 1.0, 0);
          body.add(pad);
        }
        addEyes(0xffd24d, s * 0.14, s * 1.42, s * 0.29, s * 0.07);
      }
    }

    body.traverse((o) => (o.castShadow = true));
    return { body, bodyY };
  }

  applySlow(factor: number, duration: number, exposeMult = 1): void {
    this.slowFactor = Math.min(this.slowFactor, factor);
    this.slowTimer = Math.max(this.slowTimer, duration);
    this.exposedMult = Math.max(this.exposedMult, exposeMult);
    this.bodyMat.color.copy(this.baseColor).lerp(new THREE.Color(0x9bd8ff), 0.55);
  }

  /** Applies armor, then damage. Returns the damage actually dealt (0 if already dead). */
  takeDamage(dmg: number, pierce = 0): { applied: number; killed: boolean } {
    if (!this.alive) return { applied: 0, killed: false };
    // Frost expose multiplier amplifies raw damage before armor reduction.
    const ampDmg = Math.round(dmg * this.exposedMult);
    // Armor is flat reduction per hit (pierce shaves it), but at least 25% always lands.
    const armor = Math.max(0, this.armor - pierce);
    const applied = Math.round(Math.max(ampDmg - armor, ampDmg * 0.25));
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
        this.exposedMult = 1;
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
