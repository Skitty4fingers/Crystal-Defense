// Procedural canvas textures — keeps the project asset-free.
// Textures are generated once and cached; maps regenerate per level but
// reuse these (material.dispose() does not dispose textures).

import * as THREE from 'three';

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function drawGrass(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = '#4e8c3e';
  ctx.fillRect(0, 0, size, size);
  const shades = ['#447a36', '#5a9c48', '#63a851', '#3f7031', '#6fb05a'];
  // Short blade strokes.
  for (let i = 0; i < 380; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.strokeStyle = shades[Math.floor(Math.random() * shades.length)];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() * 2 - 1), y - 2 - Math.random() * 3);
    ctx.stroke();
  }
  // Sparse light speckles.
  ctx.fillStyle = 'rgba(190, 230, 140, 0.5)';
  for (let i = 0; i < 30; i++) {
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
}

function drawDirt(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = '#b39b76';
  ctx.fillRect(0, 0, size, size);
  // Grain speckles.
  const shades = ['#9c845f', '#8a7354', '#c2ab84', '#a68e69'];
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = shades[Math.floor(Math.random() * shades.length)];
    const r = Math.random() < 0.85 ? 1 : 2;
    ctx.fillRect(Math.random() * size, Math.random() * size, r, r);
  }
  // A few embedded pebbles.
  for (let i = 0; i < 9; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 1.5 + Math.random() * 2.5;
    ctx.fillStyle = '#8d8d92';
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.75, Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.ellipse(x - r * 0.25, y - r * 0.25, r * 0.4, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Faint wheel-rut striations.
  ctx.strokeStyle = 'rgba(120, 95, 60, 0.18)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    const y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() * 8 - 4));
    ctx.stroke();
  }
}

function drawWater(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = '#2563a8';
  ctx.fillRect(0, 0, size, size);
  // Horizontal wave streaks (drawn twice with vertical wrap so scrolling tiles seamlessly).
  for (let i = 0; i < 26; i++) {
    const y = Math.random() * size;
    const x = Math.random() * size;
    const len = 12 + Math.random() * 30;
    const light = Math.random() < 0.3;
    ctx.strokeStyle = light ? 'rgba(150, 205, 255, 0.5)' : 'rgba(60, 130, 200, 0.6)';
    ctx.lineWidth = light ? 1 : 2;
    for (const wrap of [0, -size, size]) {
      ctx.beginPath();
      ctx.moveTo(x, y + wrap);
      ctx.quadraticCurveTo(x + len / 2, y + wrap + (Math.random() * 4 - 2), x + len, y + wrap);
      ctx.stroke();
    }
  }
  // Sparkles.
  ctx.fillStyle = 'rgba(200, 235, 255, 0.8)';
  for (let i = 0; i < 14; i++) {
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
}

function drawRock(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = '#3b4254';
  ctx.fillRect(0, 0, size, size);
  // Mottled blotches.
  for (let i = 0; i < 90; i++) {
    const shade = 50 + Math.floor(Math.random() * 40);
    ctx.fillStyle = `rgba(${shade}, ${shade + 6}, ${shade + 18}, 0.5)`;
    const r = 3 + Math.random() * 9;
    ctx.beginPath();
    ctx.ellipse(Math.random() * size, Math.random() * size, r, r * 0.7, Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Cracks.
  ctx.strokeStyle = 'rgba(15, 18, 28, 0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let j = 0; j < 4; j++) {
      x += Math.random() * 14 - 7;
      y += Math.random() * 10;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- cached accessors

let grass: THREE.CanvasTexture[] | null = null;
export function grassTextures(): THREE.CanvasTexture[] {
  if (!grass) grass = [0, 1, 2].map(() => canvasTexture(128, drawGrass));
  return grass;
}

let dirt: THREE.CanvasTexture[] | null = null;
export function dirtTextures(): THREE.CanvasTexture[] {
  if (!dirt) dirt = [0, 1].map(() => canvasTexture(128, drawDirt));
  return dirt;
}

/** Stream tiles: offset is animated for a flowing-water effect. */
let stream: THREE.CanvasTexture | null = null;
export function streamTexture(): THREE.CanvasTexture {
  if (!stream) stream = canvasTexture(128, drawWater);
  return stream;
}

/** Ocean plane: own instance so it can scroll at a different speed. */
let ocean: THREE.CanvasTexture | null = null;
export function oceanTexture(): THREE.CanvasTexture {
  if (!ocean) {
    ocean = canvasTexture(128, drawWater);
    ocean.repeat.set(36, 36);
  }
  return ocean;
}

let rock: THREE.CanvasTexture | null = null;
export function rockTexture(): THREE.CanvasTexture {
  if (!rock) {
    rock = canvasTexture(128, drawRock);
    rock.repeat.set(5, 1);
  }
  return rock;
}
