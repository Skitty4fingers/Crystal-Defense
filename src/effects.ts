import * as THREE from 'three';

/** Short-lived visual effect tracked by the game loop. */
export interface VFX {
  readonly obj: THREE.Object3D;
  done: boolean;
  update(dt: number): void;
  dispose?(): void;
}

/** Instant hitscan flash used by the sniper tower. */
export class Beam implements VFX {
  readonly obj: THREE.Line;
  done = false;
  private life: number;
  private readonly maxLife = 0.15;
  private mat: THREE.LineBasicMaterial;

  constructor(from: THREE.Vector3, to: THREE.Vector3, color: number, jagged = false) {
    this.life = this.maxLife;
    let points: THREE.Vector3[];
    if (jagged) {
      // Lightning look: two random kinks along the segment.
      const jitter = () => new THREE.Vector3(
        (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.9,
      );
      points = [
        from.clone(),
        from.clone().lerp(to, 0.35).add(jitter()),
        from.clone().lerp(to, 0.7).add(jitter()),
        to.clone(),
      ];
    } else {
      points = [from.clone(), to.clone()];
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    this.mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
    this.mat.color.multiplyScalar(2.5); // HDR so the beam blooms
    this.obj = new THREE.Line(geo, this.mat);
  }

  dispose(): void {
    this.obj.geometry.dispose();
    this.mat.dispose();
  }

  update(dt: number): void {
    this.life -= dt;
    this.mat.opacity = Math.max(this.life / this.maxLife, 0);
    if (this.life <= 0) this.done = true;
  }
}

/** Expanding translucent sphere for cannon splashes, deaths and meteors. */
export class Explosion implements VFX {
  readonly obj: THREE.Mesh;
  done = false;
  private t = 0;
  private readonly duration: number;
  private radius: number;
  private mat: THREE.MeshBasicMaterial;

  constructor(at: THREE.Vector3, radius: number, color = 0xffa94d, duration = 0.3) {
    this.radius = radius;
    this.duration = duration;
    this.mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, depthWrite: false,
    });
    this.mat.color.multiplyScalar(1.6);
    this.obj = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), this.mat);
    this.obj.position.copy(at);
    this.obj.scale.setScalar(0.2);
  }

  dispose(): void {
    this.obj.geometry.dispose();
    this.mat.dispose();
  }

  update(dt: number): void {
    this.t += dt / this.duration;
    if (this.t >= 1) {
      this.done = true;
      return;
    }
    const s = 0.2 + (this.radius - 0.2) * this.t;
    this.obj.scale.setScalar(s);
    this.mat.opacity = 0.85 * (1 - this.t);
  }
}

/** Floating damage number that rises and fades (like the reference UI). */
export class DamageNumber implements VFX {
  readonly obj: THREE.Sprite;
  done = false;
  private t = 0;
  private mat: THREE.SpriteMaterial;

  constructor(at: THREE.Vector3, value: number, color = '#ffffff') {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(String(value), 64, 32);
    ctx.fillStyle = color;
    ctx.fillText(String(value), 64, 32);

    this.mat = new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false,
    });
    this.obj = new THREE.Sprite(this.mat);
    this.obj.scale.set(1.5, 0.75, 1);
    this.obj.position.copy(at);
    this.obj.position.x += (Math.random() - 0.5) * 0.5;
    this.obj.position.y += 0.4;
  }

  dispose(): void {
    this.mat.map?.dispose();
    this.mat.dispose();
  }

  update(dt: number): void {
    this.t += dt / 0.8;
    this.obj.position.y += dt * 1.7;
    this.mat.opacity = Math.max(1 - this.t, 0);
    if (this.t >= 1) this.done = true;
  }
}

/** Meteor ability: a fireball falls for ~0.45s, then onImpact fires once. */
export class Meteor implements VFX {
  readonly obj: THREE.Mesh;
  done = false;
  private t = 0;
  private start: THREE.Vector3;
  private end: THREE.Vector3;
  private impacted = false;
  private mat: THREE.MeshBasicMaterial;

  constructor(target: THREE.Vector3, private onImpact: () => void) {
    this.end = target.clone();
    this.start = target.clone().add(new THREE.Vector3(5, 16, 3));
    this.mat = new THREE.MeshBasicMaterial({ color: 0xff7a3c });
    this.mat.color.multiplyScalar(2.4);
    this.obj = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), this.mat);
    this.obj.position.copy(this.start);
  }

  dispose(): void {
    this.obj.geometry.dispose();
    this.mat.dispose();
  }

  update(dt: number): void {
    this.t += dt / 0.45;
    if (this.t >= 1) {
      if (!this.impacted) {
        this.impacted = true;
        this.onImpact();
      }
      this.done = true;
      return;
    }
    this.obj.position.lerpVectors(this.start, this.end, this.t * this.t); // accelerate downwards
  }
}

// Shared geometry for the (per-shot, very frequent) muzzle flash so firing never
// allocates geometry — only a small short-lived material per flash.
const FLASH_GEO = new THREE.SphereGeometry(1, 8, 6);

/** A brief additive puff at a tower's muzzle when it fires. */
export class MuzzleFlash implements VFX {
  readonly obj: THREE.Mesh;
  done = false;
  private t = 0;
  private readonly life = 0.09;
  private readonly size: number;
  private mat: THREE.MeshBasicMaterial;

  constructor(at: THREE.Vector3, color: number, size = 0.4) {
    this.size = size;
    this.mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mat.color.multiplyScalar(2.4); // HDR so it blooms
    this.obj = new THREE.Mesh(FLASH_GEO, this.mat);
    this.obj.position.copy(at);
    this.obj.scale.setScalar(size * 0.5);
  }

  dispose(): void {
    this.mat.dispose(); // FLASH_GEO is shared — never disposed
  }

  update(dt: number): void {
    this.t += dt / this.life;
    if (this.t >= 1) {
      this.done = true;
      return;
    }
    this.obj.scale.setScalar(this.size * (0.5 + this.t * 0.9));
    this.mat.opacity = 0.9 * (1 - this.t);
  }
}

export interface ShatterOpts {
  count?: number;
  color?: number;
  emissive?: number;
  size?: number;
  speed?: number;
  up?: number;
  life?: number;
  /** Height fragments bounce off (world Y of the ground under the burst). */
  groundY?: number;
}

/**
 * A burst of glowing tetrahedral shards with gravity + a little ground bounce —
 * the same physics as the crystal-death debris (map.ts explodeCrystal),
 * generalised for frost-shatter kills and per-archetype death bursts.
 */
export class Shatter implements VFX {
  readonly obj: THREE.Group;
  done = false;
  private t = 0;
  private readonly life: number;
  private readonly groundY: number;
  private frags: {
    mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; mat: THREE.MeshStandardMaterial;
  }[] = [];

  constructor(at: THREE.Vector3, opts: ShatterOpts = {}) {
    const count = opts.count ?? 10;
    const color = opts.color ?? 0x9fe8ff;
    const emissive = opts.emissive ?? color;
    const size = opts.size ?? 0.18;
    const speed = opts.speed ?? 4;
    const up = opts.up ?? 5;
    this.life = opts.life ?? 0.9;
    this.groundY = opts.groundY ?? 0.15;
    this.obj = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color, emissive, emissiveIntensity: 2.4, roughness: 0.3, metalness: 0.2,
      });
      const mesh = new THREE.Mesh(
        new THREE.TetrahedronGeometry(size * (0.6 + Math.random() * 0.8)), mat,
      );
      mesh.position.copy(at);
      this.obj.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const out = speed * (0.5 + Math.random());
      this.frags.push({
        mesh, mat,
        vel: new THREE.Vector3(Math.cos(a) * out, up * (0.5 + Math.random()), Math.sin(a) * out),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10,
        ),
      });
    }
  }

  dispose(): void {
    for (const f of this.frags) {
      f.mesh.geometry.dispose();
      f.mat.dispose();
    }
  }

  update(dt: number): void {
    this.t += dt / this.life;
    if (this.t >= 1) {
      this.done = true;
      return;
    }
    for (const f of this.frags) {
      f.vel.y -= 16 * dt;
      f.mesh.position.addScaledVector(f.vel, dt);
      f.mesh.rotation.x += f.spin.x * dt;
      f.mesh.rotation.y += f.spin.y * dt;
      f.mesh.rotation.z += f.spin.z * dt;
      f.mat.emissiveIntensity = Math.max(0, 2.4 * (1 - this.t));
      if (f.mesh.position.y < this.groundY) {
        f.mesh.position.y = this.groundY;
        f.vel.y = Math.abs(f.vel.y) * 0.35;
        f.vel.x *= 0.6;
        f.vel.z *= 0.6;
      }
    }
  }
}
