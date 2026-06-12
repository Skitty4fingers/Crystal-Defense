import * as THREE from 'three';
import type { Enemy } from './enemy';
import type { Tower } from './tower';

const _aim = new THREE.Vector3();

/** Damage payload captured at fire time (towers level up, so don't read spec live). */
export interface ShotParams {
  damage: number;
  speed: number;
  color: number;
  splashRadius?: number;
  slowFactor?: number;
  slowDuration?: number;
  big: boolean;
}

/** Homing projectile fired by towers with projectileSpeed > 0. */
export class Projectile {
  readonly params: ShotParams;
  readonly target: Enemy;
  readonly owner: Tower;
  readonly mesh: THREE.Mesh;
  done = false;

  constructor(params: ShotParams, start: THREE.Vector3, target: Enemy, owner: Tower) {
    this.params = params;
    this.target = target;
    this.owner = owner;
    const mat = new THREE.MeshBasicMaterial({ color: params.color });
    mat.color.multiplyScalar(2.2); // HDR color so bloom picks it up
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(params.big ? 0.24 : 0.13, 8, 6),
      mat,
    );
    this.mesh.position.copy(start);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  /** Advances the projectile; returns true on the frame it reaches its target. */
  update(dt: number): boolean {
    if (this.target.reachedEnd || (!this.target.alive && !this.params.splashRadius)) {
      this.done = true; // target gone, nothing to hit
      return false;
    }
    _aim.copy(this.target.group.position);
    _aim.y += this.target.hitY;
    _aim.sub(this.mesh.position);
    const dist = _aim.length();
    const step = this.params.speed * dt;
    if (step >= dist) {
      this.done = true;
      return true;
    }
    this.mesh.position.addScaledVector(_aim.normalize(), step);
    return false;
  }
}
