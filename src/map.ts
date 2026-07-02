import * as THREE from 'three';
import { chance, pick, randInt, randRange } from './rng';
import type { RNG } from './rng';
import { dirtTextures, grassTextures, oceanTexture, rockTexture, streamTexture } from './textures';

export const COLS = 16;
export const ROWS = 12;
export const CELL = 2;

/**
 * The island map. Procedural per run/level:
 * - the enemy path snakes left-to-right through three random columns
 * - a stream cuts north-south across the island (unbuildable); where the
 *   path crosses it, a plank bridge is drawn
 * - foliage (pines, round trees, bushes, mushrooms, rocks, reeds, flowers)
 *   is scattered randomly; large pieces block building
 */
export class GameMap {
  readonly waypoints: THREE.Vector3[] = [];
  readonly totalLength: number;
  readonly spawnPosition: THREE.Vector3;
  readonly basePosition: THREE.Vector3;

  private root = new THREE.Group();
  private scene: THREE.Scene;
  private waypointsGrid: [number, number][];
  private segLengths: number[] = [];
  private pathCells = new Set<string>();
  private streamCells = new Set<string>();
  private blockedCells = new Set<string>();
  private occupiedCells = new Set<string>();
  private crystal!: THREE.Mesh;
  private crystalMat!: THREE.MeshStandardMaterial;
  private crystalBase = new THREE.Vector3();
  private crystalLight!: THREE.PointLight;
  /** Remaining-lives fraction (1 = full), drives the crystal's idle aura. */
  private healthFrac = 1;
  private crystalColor = new THREE.Color();
  private readonly crystalRed = new THREE.Color(0xff3050);
  private flashTime = 0;
  // Ambient fireflies (Quality mode only).
  private fireflies?: THREE.Points;
  private fireflyBase = new Float32Array(0);
  private fireflyPhase = new Float32Array(0);
  private fireflyClock = 0;
  private crystalDead = false;
  private explodeTime = 0;
  private crystalDebris: {
    mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; mat: THREE.MeshStandardMaterial;
  }[] = [];
  private portal!: THREE.Mesh;
  private portalMat!: THREE.MeshStandardMaterial;
  private portalLight!: THREE.PointLight;
  private portalSwirl!: THREE.Mesh;
  private portalSwirlMat!: THREE.MeshBasicMaterial;
  private portalOrbs: { mesh: THREE.Mesh; angle: number; speed: number; radius: number }[] = [];
  private portalBurstTime = 0;
  private portalClock = 0;
  private oceanMat!: THREE.MeshStandardMaterial;
  private readonly oceanRichColor = new THREE.Color(0x4a5f80);
  /** Flat-mode ocean tint, kept in sync with the current sky/background colour
   *  by the Game (see setSkyColor) so Performance mode's sea blends into the
   *  horizon instead of standing out as a distinct band. */
  private oceanFlatColor = new THREE.Color(0x0c1424);
  /** Graphics-quality gates (Performance mode strips these). Set by the Game. */
  private bgRich = true;   // textured + scrolling water backdrop
  private worldAnim = true; // portal + crystal idle animation
  // A small school of fish swimming along the stream (Quality mode only).
  private streamCol: number | null = null;
  private fishGroup?: THREE.Group;
  private fishBaseX = 0;
  private streamMinZ = 0;
  private streamMaxZ = 0;
  private fish: { group: THREE.Group; z: number; dir: 1 | -1; speed: number; phase: number }[] = [];

  constructor(scene: THREE.Scene, rng: RNG) {
    this.scene = scene;
    scene.add(this.root);

    this.waypointsGrid = this.generatePath(rng);
    for (const [c, r] of this.waypointsGrid) this.waypoints.push(this.gridToWorld(c, r));
    let total = 0;
    for (let i = 0; i < this.waypoints.length - 1; i++) {
      const len = this.waypoints[i].distanceTo(this.waypoints[i + 1]);
      this.segLengths.push(len);
      total += len;
    }
    this.totalLength = total;
    this.spawnPosition = this.waypoints[0].clone();
    this.basePosition = this.waypoints[this.waypoints.length - 1].clone();

    this.computePathCells();
    this.generateStream(rng);
    this.buildGround(rng);
    this.buildWater();
    this.buildPortal();
    this.buildBase();
    this.buildDecorations(rng);
    this.buildFireflies();
    this.buildFish();
  }

  /** A few dozen drifting additive motes over the island (one draw call). Built
   *  always; the Game shows/hides them per graphics-quality mode. */
  private buildFireflies(): void {
    const n = 10; // capped per level
    const pos = new Float32Array(n * 3);
    this.fireflyBase = new Float32Array(n * 3);
    this.fireflyPhase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * 30;
      const y = 0.4 + Math.random() * 2.8;
      const z = (Math.random() - 0.5) * 22;
      this.fireflyBase[i * 3] = x; this.fireflyBase[i * 3 + 1] = y; this.fireflyBase[i * 3 + 2] = z;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      this.fireflyPhase[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffe9a8, size: 0.14, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    mat.color.multiplyScalar(2.0); // HDR so they bloom
    this.fireflies = new THREE.Points(geo, mat);
    this.fireflies.visible = false; // Game enables in Quality mode
    this.root.add(this.fireflies);
  }

  /** Show/hide the ambient fireflies (Quality mode only). */
  setFireflies(visible: boolean): void {
    if (this.fireflies) this.fireflies.visible = visible;
  }

  /** A small school of fish swimming back and forth along the stream (Quality
   *  mode only). Built always; the Game shows/hides them per graphics-quality
   *  mode, like fireflies. Skipped if the map rolled no stream at all (rare). */
  private buildFish(): void {
    if (this.streamCol === null) return;
    this.fishBaseX = this.gridToWorld(this.streamCol, 0).x;
    this.streamMinZ = this.gridToWorld(this.streamCol, 0).z;
    this.streamMaxZ = this.gridToWorld(this.streamCol, ROWS - 1).z;
    const colors = [0xff8a3d, 0xffcf5c, 0xc9d6e3];
    this.fishGroup = new THREE.Group();
    const count = 5;
    for (let i = 0; i < count; i++) {
      const color = colors[i % colors.length];
      const mat = new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.35, roughness: 0.5,
      });
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.045, 0.13, 4, 8).rotateX(Math.PI / 2), mat,
      );
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(0.05, 0.09, 4).rotateX(Math.PI / 2), mat,
      );
      tail.position.z = -0.1;
      group.add(body, tail);
      const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const z = this.streamMinZ + Math.random() * (this.streamMaxZ - this.streamMinZ);
      group.position.set(this.fishBaseX, -0.02, z);
      group.rotation.y = dir > 0 ? 0 : Math.PI;
      this.fishGroup.add(group);
      this.fish.push({ group, z, dir, speed: 0.5 + Math.random() * 0.5, phase: Math.random() * Math.PI * 2 });
    }
    this.fishGroup.visible = false; // Game enables in Quality mode
    this.root.add(this.fishGroup);
  }

  /** Show/hide the fish school (Quality mode only). */
  setFish(visible: boolean): void {
    if (this.fishGroup) this.fishGroup.visible = visible;
  }

  /** Feed remaining-lives fraction so the idle crystal aura reddens + pulses as
   *  the crystal weakens. 1 = full health (identical to the original look). */
  setCrystalHealth(frac: number): void {
    this.healthFrac = Math.max(0, Math.min(1, frac));
  }

  /** Random snake: spawn left, exit right, zig-zagging at three random columns. */
  private generatePath(rng: RNG): [number, number][] {
    const c1 = randInt(rng, 2, 4);
    const c2 = randInt(rng, 6, 8);
    const c3 = randInt(rng, 10, 13);
    const top = () => randInt(rng, 1, 4);
    const bottom = () => randInt(rng, 7, 10);
    const flip = chance(rng, 0.5); // start high or low
    const r0 = flip ? bottom() : top();
    const r1 = flip ? top() : bottom();
    const r2 = flip ? bottom() : top();
    const r3 = flip ? top() : bottom();
    return [
      [-1, r0], [c1, r0], [c1, r1], [c2, r1], [c2, r2], [c3, r2], [c3, r3], [COLS, r3],
    ];
  }

  /**
   * A straight north-south stream at a column at least 2 away from every
   * vertical path segment, so every path crossing is perpendicular (= bridge).
   */
  private generateStream(rng: RNG): void {
    const verticals = [this.waypointsGrid[1][0], this.waypointsGrid[3][0], this.waypointsGrid[5][0]];
    const candidates: number[] = [];
    for (let c = 1; c <= COLS - 2; c++) {
      if (verticals.every((v) => Math.abs(v - c) >= 2)) candidates.push(c);
    }
    if (candidates.length === 0) return; // extremely unlikely; just skip the stream
    const col = pick(rng, candidates);
    this.streamCol = col;
    for (let r = 0; r < ROWS; r++) this.streamCells.add(`${col},${r}`);
  }

  /** Remove every map object from the scene (used on restart/level-up for a new layout). */
  dispose(): void {
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
  }

  gridToWorld(col: number, row: number): THREE.Vector3 {
    return new THREE.Vector3((col - (COLS - 1) / 2) * CELL, 0, (row - (ROWS - 1) / 2) * CELL);
  }

  worldToGrid(x: number, z: number): { col: number; row: number } {
    return {
      col: Math.round(x / CELL + (COLS - 1) / 2),
      row: Math.round(z / CELL + (ROWS - 1) / 2),
    };
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && col < COLS && row >= 0 && row < ROWS;
  }

  isPath(col: number, row: number): boolean {
    return this.pathCells.has(`${col},${row}`);
  }

  canBuild(col: number, row: number): boolean {
    const key = `${col},${row}`;
    return (
      this.inBounds(col, row) &&
      !this.pathCells.has(key) &&
      !this.streamCells.has(key) &&
      !this.blockedCells.has(key) &&
      !this.occupiedCells.has(key)
    );
  }

  occupy(col: number, row: number): void {
    this.occupiedCells.add(`${col},${row}`);
  }

  free(col: number, row: number): void {
    this.occupiedCells.delete(`${col},${row}`);
  }

  /** Position along the path at the given travelled distance. */
  pointAt(dist: number, out: THREE.Vector3): THREE.Vector3 {
    let d = Math.max(0, Math.min(dist, this.totalLength));
    for (let i = 0; i < this.segLengths.length; i++) {
      if (d <= this.segLengths[i] || i === this.segLengths.length - 1) {
        const t = this.segLengths[i] === 0 ? 0 : Math.min(d / this.segLengths[i], 1);
        return out.copy(this.waypoints[i]).lerp(this.waypoints[i + 1], t);
      }
      d -= this.segLengths[i];
    }
    return out.copy(this.waypoints[this.waypoints.length - 1]);
  }

  /** Trigger the crystal's "taking damage" animation (red flash + shake).
   *  No-op in Performance mode (crystal animation is frozen), so flashTime
   *  can't linger and replay a phantom flash when Quality is re-enabled. */
  flashCrystal(): void {
    if (this.worldAnim) this.flashTime = 0.5;
  }

  /** Dramatic finale when the crystal dies: shatter into glowing debris + a blinding flash. */
  explodeCrystal(): void {
    if (this.crystalDead) return;
    this.crystalDead = true;
    this.explodeTime = 1.2;
    this.crystal.visible = false;
    for (let i = 0; i < 18; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x9fe8ff, emissive: 0x55ccff, emissiveIntensity: 2.8,
        roughness: 0.2, metalness: 0.3,
      });
      const shard = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.16 + Math.random() * 0.3), mat,
      );
      shard.position.copy(this.crystalBase);
      this.root.add(shard);
      const a = Math.random() * Math.PI * 2;
      const out = 3 + Math.random() * 5;
      this.crystalDebris.push({
        mesh: shard,
        vel: new THREE.Vector3(Math.cos(a) * out, 4 + Math.random() * 8, Math.sin(a) * out),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9,
        ),
        mat,
      });
    }
  }

  /** Idle animation for the portal and crystal, plus the damage flash. */
  update(dt: number): void {
    if (this.crystalDead) {
      // Light flash decays from a blinding peak; debris flies out under gravity and fades.
      this.explodeTime = Math.max(0, this.explodeTime - dt);
      this.crystalLight.color.setHex(0xfff0c0);
      this.crystalLight.intensity = 28 + this.explodeTime * 260;
      for (const d of this.crystalDebris) {
        d.vel.y -= 16 * dt;
        d.mesh.position.addScaledVector(d.vel, dt);
        d.mesh.rotation.x += d.spin.x * dt;
        d.mesh.rotation.y += d.spin.y * dt;
        d.mesh.rotation.z += d.spin.z * dt;
        d.mat.emissiveIntensity = Math.max(0, d.mat.emissiveIntensity - dt * 1.4);
        if (d.mesh.position.y < 0.2) {
          d.mesh.position.y = 0.2;
          d.vel.y = Math.abs(d.vel.y) * 0.35;
          d.vel.x *= 0.6;
          d.vel.z *= 0.6;
        }
      }
    } else if (this.worldAnim) {
      this.crystal.rotation.y += dt * 1.2;
      this.crystal.position.y = this.crystalBase.y + Math.sin(performance.now() * 0.002) * 0.18;
    }

    // Flowing water: scroll the shared textures (stream fast, ocean lazy).
    // Frozen in Performance mode (flat, static backdrop).
    if (this.bgRich) {
      streamTexture().offset.y -= dt * 0.06;
      oceanTexture().offset.x += dt * 0.006;
      oceanTexture().offset.y += dt * 0.004;
    }

    // Portal: slow ring spin, breathing glow, orbiting orbs, spawn burst flash.
    // Quality mode only — Performance leaves it at the static snap pose.
    if (this.worldAnim) {
      this.portalClock += dt;
      this.portal.rotation.z += dt * 0.8;
      this.portalBurstTime = Math.max(0, this.portalBurstTime - dt);
      const pulse = 0.5 + 0.5 * Math.sin(this.portalClock * 2.6);
      const burst = this.portalBurstTime / 0.4;
      this.portalMat.emissiveIntensity = 1.8 + pulse * 0.9 + burst * 2.5;
      this.portalLight.intensity = 26 + pulse * 14 + burst * 70;
      this.portalSwirlMat.opacity = 0.2 + pulse * 0.18 + burst * 0.5;
      const swirlScale = 0.85 + pulse * 0.15 + burst * 0.35;
      this.portalSwirl.scale.setScalar(swirlScale);
      for (const orb of this.portalOrbs) {
        orb.angle += orb.speed * dt;
        // Orbit in the ring's plane (the ring faces +X) with a little lateral wobble.
        orb.mesh.position.set(
          this.portal.position.x + Math.sin(this.portalClock * 3 + orb.angle) * 0.15,
          this.portal.position.y + Math.cos(orb.angle) * orb.radius,
          this.portal.position.z + Math.sin(orb.angle) * orb.radius,
        );
      }
    }

    if (!this.crystalDead && this.worldAnim) {
      if (this.flashTime > 0) {
        this.flashTime = Math.max(0, this.flashTime - dt);
        const k = this.flashTime / 0.5;
        this.crystalMat.emissive.setHex(0x2299ee).lerp(new THREE.Color(0xff2030), k);
        this.crystalMat.emissiveIntensity = 2.4 + k * 1.5;
        this.crystal.position.x = this.crystalBase.x + (Math.random() - 0.5) * 0.35 * k;
        this.crystal.position.z = this.crystalBase.z + (Math.random() - 0.5) * 0.35 * k;
      } else {
        // Idle aura, health-tied: calm blue at full health (identical to the
        // original), reddening with a faster nervous pulse as lives run out.
        const danger = 1 - this.healthFrac;
        if (danger < 0.001) {
          this.crystalMat.emissive.setHex(0x2299ee);
          this.crystalMat.emissiveIntensity = 2.4;
          this.crystalLight.color.setHex(0x55ccff);
          this.crystalLight.intensity = 40;
        } else {
          const pulse = 1 + Math.sin(performance.now() * (0.003 + danger * 0.012)) * (0.2 + danger * 0.5);
          this.crystalColor.setHex(0x2299ee).lerp(this.crystalRed, danger * 0.85);
          this.crystalMat.emissive.copy(this.crystalColor);
          this.crystalMat.emissiveIntensity = (2.4 + danger * 0.8) * pulse;
          this.crystalLight.color.copy(this.crystalColor);
          this.crystalLight.intensity = 40 * (0.6 + 0.4 * pulse);
        }
        this.crystal.position.x = this.crystalBase.x;
        this.crystal.position.z = this.crystalBase.z;
      }
    }

    // Ambient fireflies drift + twinkle (Quality mode only).
    if (this.fireflies && this.fireflies.visible) {
      this.fireflyClock += dt;
      const attr = this.fireflies.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < this.fireflyPhase.length; i++) {
        const ph = this.fireflyPhase[i];
        arr[i * 3] = this.fireflyBase[i * 3] + Math.sin(this.fireflyClock * 0.6 + ph) * 0.5;
        arr[i * 3 + 1] = this.fireflyBase[i * 3 + 1] + Math.sin(this.fireflyClock * 0.9 + ph * 1.3) * 0.35;
        arr[i * 3 + 2] = this.fireflyBase[i * 3 + 2] + Math.cos(this.fireflyClock * 0.5 + ph) * 0.5;
      }
      attr.needsUpdate = true;
      (this.fireflies.material as THREE.PointsMaterial).opacity = 0.7 + 0.3 * Math.sin(this.fireflyClock * 2);
    }

    // Fish swim the length of the stream, turning at each bank, with a small
    // side-to-side wiggle (Quality mode only).
    if (this.fishGroup && this.fishGroup.visible) {
      for (const f of this.fish) {
        f.z += f.dir * f.speed * dt;
        if (f.z > this.streamMaxZ) { f.z = this.streamMaxZ; f.dir = -1; f.group.rotation.y = Math.PI; }
        else if (f.z < this.streamMinZ) { f.z = this.streamMinZ; f.dir = 1; f.group.rotation.y = 0; }
        f.phase += dt * 4;
        f.group.position.z = f.z;
        f.group.position.x = this.fishBaseX + Math.sin(f.phase) * 0.06;
      }
    }
  }

  private computePathCells(): void {
    for (let i = 0; i < this.waypointsGrid.length - 1; i++) {
      const [c0, r0] = this.waypointsGrid[i];
      const [c1, r1] = this.waypointsGrid[i + 1];
      const steps = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0));
      for (let s = 0; s <= steps; s++) {
        const c = c0 + Math.sign(c1 - c0) * s;
        const r = r0 + Math.sign(r1 - r0) * s;
        if (this.inBounds(c, r)) this.pathCells.add(`${c},${r}`);
      }
    }
  }

  private buildGround(rng: RNG): void {
    const tileGeo = new THREE.BoxGeometry(CELL * 0.97, 0.2, CELL * 0.97);
    const streamGeo = new THREE.BoxGeometry(CELL, 0.18, CELL); // full width: no seams
    const grass = grassTextures();
    const dirt = dirtTextures();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const key = `${c},${r}`;
        const isPath = this.pathCells.has(key);
        const isStream = this.streamCells.has(key);

        if (isStream && !isPath) {
          // Stream water: slightly sunken glossy tile; the shared texture's
          // offset is animated in update() so the whole stream flows.
          const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff, map: streamTexture(), roughness: 0.3, metalness: 0.25,
            emissive: 0x123a66, emissiveIntensity: 0.5,
          });
          mat.color.offsetHSL(0, 0, (rng() - 0.5) * 0.04);
          const tile = new THREE.Mesh(streamGeo, mat);
          tile.position.copy(this.gridToWorld(c, r));
          tile.position.y = -0.13; // top sits below the grass
          this.root.add(tile);
          continue;
        }

        // Texture carries the pigment; the material color is a near-white
        // tint that keeps the checkerboard and per-tile variation.
        const tint = isPath ? 0xffffff : (c + r) % 2 === 0 ? 0xe3eedd : 0xffffff;
        const mat = new THREE.MeshStandardMaterial({
          color: tint, map: pick(rng, isPath ? dirt : grass), roughness: 1,
        });
        mat.color.offsetHSL(0, 0, (rng() - 0.5) * 0.05);
        const tile = new THREE.Mesh(tileGeo, mat);
        tile.position.copy(this.gridToWorld(c, r));
        tile.position.y = -0.1;
        tile.receiveShadow = true;
        this.root.add(tile);

        // Path crossing the stream: lay a plank bridge over the path tile.
        if (isStream && isPath) this.buildBridge(c, r);
      }
    }

    // Rocky cliff under the island.
    const cliff = new THREE.Mesh(
      new THREE.BoxGeometry(COLS * CELL + 2, 1.6, ROWS * CELL + 2),
      new THREE.MeshStandardMaterial({ color: 0xc8ccd8, map: rockTexture(), roughness: 1 }),
    );
    cliff.position.y = -1.0;
    cliff.receiveShadow = true;
    this.root.add(cliff);
  }

  /** Plank bridge: deck boards across the walking direction + side rails. */
  private buildBridge(col: number, row: number): void {
    const pos = this.gridToWorld(col, row);
    const plankMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x5e3f24, roughness: 0.9 });
    const group = new THREE.Group();

    // Path runs along X here (stream is never parallel to the path).
    const plankGeo = new THREE.BoxGeometry(0.42, 0.1, CELL * 0.96);
    for (let i = 0; i < 4; i++) {
      const plank = new THREE.Mesh(plankGeo, plankMat);
      plank.position.set(-0.72 + i * 0.48, 0.07, 0);
      group.add(plank);
    }
    const railGeo = new THREE.BoxGeometry(CELL * 0.98, 0.4, 0.1);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(0, 0.3, side * 0.85);
      group.add(rail);
    }

    group.position.copy(pos);
    group.traverse((o) => (o.castShadow = true));
    this.root.add(group);
  }

  private buildWater(): void {
    this.oceanMat = new THREE.MeshStandardMaterial({
      // Darker tint over the shared water texture for deep ocean.
      color: 0x4a5f80, map: oceanTexture(), roughness: 0.5, metalness: 0.15,
      emissive: 0x0a2038, emissiveIntensity: 0.5,
    });
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(320, 320).rotateX(-Math.PI / 2), this.oceanMat,
    );
    water.position.y = -1.4;
    this.root.add(water);
  }

  /** Quality mode: textured, scrolling sea. Performance mode: a flat static
   *  backdrop (drop the texture map, freeze the water motion, and tint it to
   *  match the current sky so it blends into the horizon). */
  setBackgroundRich(rich: boolean): void {
    this.bgRich = rich;
    if (this.oceanMat) {
      this.oceanMat.map = rich ? oceanTexture() : null;
      this.oceanMat.color.copy(rich ? this.oceanRichColor : this.oceanFlatColor);
      this.oceanMat.needsUpdate = true;
    }
  }

  /** Sync the flat-mode ocean tint to the current sky/background colour
   *  (called by the Game whenever the level palette changes). No-op in
   *  Quality mode, which always keeps the rich blue-grey tint. */
  setSkyColor(hex: number): void {
    this.oceanFlatColor.setHex(hex);
    if (!this.bgRich && this.oceanMat) this.oceanMat.color.copy(this.oceanFlatColor);
  }

  /** Quality mode: portal + crystal idle animation. Performance mode: freeze
   *  them to a static resting pose (and hide the orbiting portal orbs). */
  setWorldAnim(on: boolean): void {
    this.worldAnim = on;
    for (const orb of this.portalOrbs) orb.mesh.visible = on;
    if (!on && !this.crystalDead) this.snapStatic();
  }

  /** Snap the portal and crystal to a calm, non-animated resting appearance
   *  (used when world animation is disabled in Performance mode). */
  private snapStatic(): void {
    // Clear any in-flight animation timers so a flash/burst interrupted by the
    // switch to Performance can't resume when Quality is toggled back on.
    this.flashTime = 0;
    this.portalBurstTime = 0;
    this.portalMat.emissiveIntensity = 2.2;
    this.portalLight.intensity = 30;
    this.portalSwirlMat.opacity = 0.3;
    this.portalSwirl.scale.setScalar(0.92);
    this.crystal.position.copy(this.crystalBase);
    this.crystalMat.emissive.setHex(0x2299ee);
    this.crystalMat.emissiveIntensity = 2.4;
    this.crystalLight.color.setHex(0x55ccff);
    this.crystalLight.intensity = 40;
  }

  private buildPortal(): void {
    this.portalMat = new THREE.MeshStandardMaterial({
      color: 0x8b5cf6, emissive: 0x7c3aed, emissiveIntensity: 2.2,
    });
    this.portal = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.18, 16, 48), this.portalMat);
    this.portal.rotation.y = Math.PI / 2; // path always leaves the spawn along +X
    this.portal.position.copy(this.spawnPosition);
    this.portal.position.y = 1.3;
    this.root.add(this.portal);

    // Additive "energy film" filling the ring; breathes with the pulse.
    this.portalSwirlMat = new THREE.MeshBasicMaterial({
      color: 0xb98cff, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.portalSwirl = new THREE.Mesh(new THREE.CircleGeometry(0.92, 40), this.portalSwirlMat);
    this.portalSwirl.rotation.y = Math.PI / 2;
    this.portalSwirl.position.copy(this.portal.position);
    this.root.add(this.portalSwirl);

    // Energy orbs orbiting in the ring's plane.
    const orbMat = new THREE.MeshBasicMaterial({ color: 0xa97fff });
    orbMat.color.multiplyScalar(2.2); // HDR so the orbs bloom
    for (let i = 0; i < 5; i++) {
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), orbMat);
      const angle = (i / 5) * Math.PI * 2;
      const radius = 1.05 - (i % 2) * 0.25;
      // Seat each orb at its resting orbit spot (the update() formula at clock 0)
      // so a shown-but-not-yet-animated orb never renders stranded at the world
      // origin — e.g. after toggling to Quality while the game is paused.
      orb.position.set(
        this.portal.position.x + Math.sin(angle) * 0.15,
        this.portal.position.y + Math.cos(angle) * radius,
        this.portal.position.z + Math.sin(angle) * radius,
      );
      this.root.add(orb);
      this.portalOrbs.push({ mesh: orb, angle, speed: 1.4 + i * 0.35, radius });
    }

    this.portalLight = new THREE.PointLight(0x9d6bff, 30, 11);
    this.portalLight.position.copy(this.portal.position);
    this.root.add(this.portalLight);
  }

  /** Flash the portal when something comes through it. No-op in Performance
   *  mode (the portal is frozen), so the burst timer can't go stale. */
  portalBurst(): void {
    if (this.worldAnim) this.portalBurstTime = 0.4;
  }

  private buildBase(): void {
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 2.0, 0.7, 8),
      new THREE.MeshStandardMaterial({ color: 0x44506b, roughness: 0.8 }),
    );
    platform.position.copy(this.basePosition);
    platform.position.y = 0.35;
    platform.castShadow = true;
    this.root.add(platform);

    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const pylon = new THREE.Mesh(
        new THREE.ConeGeometry(0.18, 1.1, 6),
        new THREE.MeshStandardMaterial({
          color: 0x55ccff, emissive: 0x2299ee, emissiveIntensity: 1.4,
        }),
      );
      pylon.position.set(
        this.basePosition.x + Math.cos(a) * 1.45, 1.0,
        this.basePosition.z + Math.sin(a) * 1.45,
      );
      this.root.add(pylon);
    }

    this.crystalMat = new THREE.MeshStandardMaterial({
      color: 0x55ccff, emissive: 0x2299ee, emissiveIntensity: 2.4,
      roughness: 0.2, metalness: 0.3,
    });
    this.crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.9), this.crystalMat);
    this.crystalBase.copy(this.basePosition).setY(2.0);
    this.crystal.position.copy(this.crystalBase);
    this.crystal.castShadow = true;
    this.root.add(this.crystal);

    this.crystalLight = new THREE.PointLight(0x55ccff, 40, 12);
    this.crystalLight.position.copy(this.crystalBase);
    this.crystalLight.position.y += 1;
    this.root.add(this.crystalLight);
  }

  // ------------------------------------------------------------ decorations

  /** Large foliage/rocks (block their cell) + small non-blocking dressing. */
  private buildDecorations(rng: RNG): void {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 });
    const birchMat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 1 });
    const pineMatA = new THREE.MeshStandardMaterial({ color: 0x2e6b35, roughness: 1 });
    const pineMatB = new THREE.MeshStandardMaterial({ color: 0x3d7a2e, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x4d9442, roughness: 1 });
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x37703a, roughness: 1 });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x7d8799, roughness: 1 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xd0413b, roughness: 0.8 });
    const stemMat = new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.9 });

    let placed = 0;
    let guard = 0;
    while (placed < 16 && guard++ < 400) {
      const c = Math.floor(rng() * COLS);
      const r = Math.floor(rng() * ROWS);
      if (!this.canBuild(c, r)) continue;
      if (this.gridToWorld(c, r).distanceTo(this.basePosition) < 3.5) continue;

      this.blockedCells.add(`${c},${r}`);
      const group = new THREE.Group();
      const kind = rng();

      if (kind < 0.3) {
        // Pine: stacked cones.
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.7, 8), trunkMat);
        trunk.position.y = 0.35;
        const lower = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.7, 8), chance(rng, 0.5) ? pineMatA : pineMatB);
        lower.position.y = 1.5;
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.0, 8), pineMatA);
        tip.position.y = 2.2;
        group.add(trunk, lower, tip);
      } else if (kind < 0.5) {
        // Round tree: birch trunk + blobby canopy.
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, 1.0, 8), birchMat);
        trunk.position.y = 0.5;
        const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.75, 10, 8), leafMat);
        canopy.position.y = 1.5;
        const blob = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), bushMat);
        blob.position.set(0.45, 1.15, 0.25);
        group.add(trunk, canopy, blob);
      } else if (kind < 0.65) {
        // Bush cluster.
        for (let i = 0; i < 3; i++) {
          const s = randRange(rng, 0.3, 0.55);
          const blob = new THREE.Mesh(new THREE.SphereGeometry(s, 8, 6), chance(rng, 0.5) ? bushMat : leafMat);
          blob.position.set((rng() - 0.5) * 0.9, s * 0.8, (rng() - 0.5) * 0.9);
          group.add(blob);
        }
      } else if (kind < 0.8) {
        // Mushrooms.
        for (let i = 0; i < 2; i++) {
          const h = randRange(rng, 0.25, 0.45);
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h, 6), stemMat);
          stem.position.set((rng() - 0.5) * 0.8, h / 2, (rng() - 0.5) * 0.8);
          const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.2, 8), capMat);
          cap.position.set(stem.position.x, h + 0.08, stem.position.z);
          group.add(stem, cap);
        }
      } else {
        // Rock cluster.
        const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), rockMat);
        rock.position.y = 0.32;
        rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        const pebble = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), rockMat);
        pebble.position.set(0.55, 0.14, 0.3);
        group.add(rock, pebble);
      }

      group.position.copy(this.gridToWorld(c, r));
      group.traverse((o) => (o.castShadow = true));
      this.root.add(group);
      placed++;
    }

    // Non-blocking flowers sprinkled on grass for color.
    const flowerStemMat = new THREE.MeshStandardMaterial({ color: 0x3f7a35 });
    const petalColors = [0xff6b9d, 0xffd166, 0xc77dff, 0xff9770];
    for (let i = 0; i < 24; i++) {
      const c = Math.floor(rng() * COLS);
      const r = Math.floor(rng() * ROWS);
      const key = `${c},${r}`;
      if (this.pathCells.has(key) || this.streamCells.has(key) || this.blockedCells.has(key)) continue;
      const pos = this.gridToWorld(c, r);
      pos.x += (rng() - 0.5) * 1.3;
      pos.z += (rng() - 0.5) * 1.3;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 4), flowerStemMat);
      stem.position.set(pos.x, 0.15, pos.z);
      const petal = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 6, 5),
        new THREE.MeshStandardMaterial({
          color: petalColors[Math.floor(rng() * petalColors.length)], roughness: 0.7,
        }),
      );
      petal.position.set(pos.x, 0.33, pos.z);
      this.root.add(stem, petal);
    }

    // Reeds along the stream banks.
    const reedMat = new THREE.MeshStandardMaterial({ color: 0x4a7c3f, roughness: 1 });
    const catkinMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 });
    for (const key of this.streamCells) {
      if (!chance(rng, 0.4)) continue;
      const [c, r] = key.split(',').map(Number);
      const side = chance(rng, 0.5) ? -1 : 1;
      const bankKey = `${c + side},${r}`;
      if (this.pathCells.has(bankKey) || this.streamCells.has(bankKey)) continue;
      const pos = this.gridToWorld(c, r);
      pos.x += side * CELL * 0.55;
      for (let i = 0; i < randInt(rng, 2, 4); i++) {
        const h = randRange(rng, 0.5, 0.9);
        const reed = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, h, 5), reedMat);
        reed.position.set(pos.x + (rng() - 0.5) * 0.5, h / 2, pos.z + (rng() - 0.5) * 1.2);
        this.root.add(reed);
        if (chance(rng, 0.5)) {
          const catkin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 5), catkinMat);
          catkin.position.set(reed.position.x, h + 0.08, reed.position.z);
          this.root.add(catkin);
        }
      }
    }
  }
}
