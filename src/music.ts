// Adaptive vaporwave/synthwave soundtrack — fully procedural Web Audio, no
// assets (so it's inherently royalty-free). A look-ahead step sequencer plays a
// layered arrangement; layers fade in as "intensity" rises, intensity tracks
// the game speed, and boss waves swap to a darker theme.
//
// Authentic vaporwave sound design (per genre production guides): lush extended
// JAZZ chords (maj7/min9), warm Rhodes electric piano, slow-attack pads, a slow
// "wow/flutter" pitch wobble (warped-cassette feel), long lush reverb + synced
// delay, soft minimal drums, and a warm lo-fi master (gentle saturation + a
// lowpass that opens up with intensity). Shares the SFX AudioContext but keeps
// its own gain + mute so music toggles independently of sound effects.
import { sfx } from './audio';

const MUSIC_VOL = 0.125;       // master music level — sits well under the SFX
const STEPS = 16;              // sixteenth-notes per bar
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const FADE = 0.5;

export type MusicScene = 'menu' | 'build' | 'combat' | 'boss';

/** Base intensity (0..1) per scene; speed adds to this. */
const SCENE_INTENSITY: Record<MusicScene, number> = {
  menu: 0.1, build: 0.34, combat: 0.62, boss: 0.86,
};

const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

// Heavy & aggressive: POWER chords (root + fifth + octave, no third). With no
// third the mood comes from ROOT MOTION — Phrygian b2 and chromatic descent.
// Every level gets its own key + progression (deterministic, so it's endless-safe
// and the music is different on each level).
const POWER = [0, 7, 12];
const BASE_TONIC = 50; // D3

interface Chord { root: number; type: number[]; }

// Per-level key — a semitone transposition spread across ~an octave so each
// level is audibly in a different key (cycling 12).
const LEVEL_TONIC = [0, -5, 4, -7, 2, 7, -3, 5, -2, -9, 3, -6];

// Per-level groove — which 16th-note steps fire bass / kick / hat (cycling 4).
// Different rhythms make each level feel distinct, not just a different key.
interface Groove { bass: number[]; kick: number[]; hat: number[]; }
const GROOVES: Groove[] = [
  { bass: [0, 2, 4, 6, 8, 10, 12, 14], kick: [0, 4, 8, 12], hat: [2, 6, 10, 14] },           // straight 8ths
  { bass: [0, 3, 4, 7, 8, 11, 12, 15], kick: [0, 8], hat: [2, 4, 6, 10, 12, 14] },           // gallop
  { bass: [0, 4, 8, 12], kick: [0, 8], hat: [4, 12] },                                       // half-time heavy
  { bass: [0, 2, 4, 6, 8, 10, 12, 14], kick: [0, 6, 8, 14], hat: [3, 7, 11, 15] },           // syncopated pump
];

// Heavy/dark root patterns (semitone offsets from the level tonic). All are
// MONOTONIC — they only descend or only climb, never bounce up-and-down, so the
// riff never turns into a see-saw.
const NORMAL_PROGS: number[][] = [
  [0, -1, -2, -3], // chromatic descent
  [0, -2, -3, -5], // minor descent
  [0, -2, -5, -7], // step down then drop to the v
  [0, 3, 5, 7],    // climb          (i bIII iv v)
  [0, -3, -5, -8], // descend to bVI
  [0, 2, 3, 5],    // Phrygian climb (i II bIII iv)
];
const BOSS_PROGS: number[][] = [
  [0, -1, -2, -3], // relentless chromatic descent
  [0, -2, -4, -6], // whole-tone descent (eerie)
  [0, -1, -3, -6], // chromatic into a tritone drop
  [0, -3, -6, -9], // diminished descent (stacked minor thirds)
];

/** Build a level's chord set, transposing the WHOLE progression as a block into
 *  the heavy register so the clamp can't reverse the contour (no induced see-saw). */
function buildChords(level: number, pool: number[][]): Chord[] {
  const tonic = BASE_TONIC + LEVEL_TONIC[(level - 1) % LEVEL_TONIC.length];
  const pattern = pool[(level - 1) % pool.length];
  let roots = pattern.map((off) => tonic + off);
  while (Math.min(...roots) < 38) roots = roots.map((r) => r + 12);
  while (Math.max(...roots) > 60) roots = roots.map((r) => r - 12);
  return roots.map((root) => ({ root, type: POWER }));
}

interface LayerCfg { vol: number; threshold: number; pumped: boolean; reverb: number; delay: number; }
const LAYER_CFG: Record<string, LayerCfg> = {
  drone: { vol: 0.42, threshold: 0.0,  pumped: true,  reverb: 0.45, delay: 0 }, // low tonic pedal
  pad:   { vol: 0.3,  threshold: 0.08, pumped: true,  reverb: 0.6,  delay: 0 },
  bass:  { vol: 0.5,  threshold: 0.12, pumped: true,  reverb: 0.08, delay: 0 },
  keys:  { vol: 0.34, threshold: 0.46, pumped: true,  reverb: 0.4,  delay: 0.45 }, // chord stabs
  kick:  { vol: 0.72, threshold: 0.4,  pumped: false, reverb: 0.05, delay: 0 },
  hat:   { vol: 0.14, threshold: 0.5,  pumped: false, reverb: 0.15, delay: 0 },
  clap:  { vol: 0.3,  threshold: 0.58, pumped: false, reverb: 0.4,  delay: 0 },
  lead:  { vol: 0.28, threshold: 0.72, pumped: true,  reverb: 0.5,  delay: 0.5 },
};

interface Layer { gain: GainNode; vol: number; threshold: number; }

export class MusicEngine {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null; // master volume + mute
  private masterLP: BiquadFilterNode | null = null; // intensity-driven brightness
  private pump: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private delay: DelayNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private wowGain: GainNode | null = null;   // wow/flutter LFO depth (cents)
  private layers: Record<string, Layer> = {};

  private muted = localStorage.getItem('cd-music-muted') === '1';
  private playing = false;
  private timer = 0;

  private scene: MusicScene = 'menu';
  private speed = 1;
  private themeName: 'normal' | 'boss' = 'normal';
  private level = 1;
  private normalChords: Chord[] = buildChords(1, NORMAL_PROGS);
  private bossChords: Chord[] = buildChords(1, BOSS_PROGS);

  private step = 0;
  private bar = 0;
  private nextStepTime = 0;

  get isMusicMuted(): boolean {
    return this.muted;
  }

  /** Returns the new muted state. */
  toggle(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('cd-music-muted', this.muted ? '1' : '0');
    this.applyMasterGain();
    return this.muted;
  }

  // ----------------------------------------------------------------- lifecycle

  start(): void {
    const ctx = sfx.getContext();
    if (!this.musicGain) this.build(ctx);
    this.ctx = ctx;
    if (this.playing) return;
    this.playing = true;
    this.speed = 1;        // always begin at the slowest tempo/intensity (1x)
    this.step = 0;
    this.bar = 0;
    this.nextStepTime = ctx.currentTime + 0.1;
    this.applyIntensity();
    this.applyMasterGain();
    this.updateDelayTime();
    this.timer = window.setInterval(this.schedule, LOOKAHEAD_MS);
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    window.clearInterval(this.timer);
    this.timer = 0;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    }
  }

  private build(ctx: AudioContext): void {
    // Master chain: musicGain -> tape saturation -> lowpass -> compressor -> out.
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.makeSaturation(1.2); // gentle warmth only
    this.masterLP = ctx.createBiquadFilter();
    this.masterLP.type = 'lowpass';
    this.masterLP.frequency.value = 3000;
    this.masterLP.Q.value = 0.4;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 28;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.3;
    this.musicGain.connect(shaper).connect(this.masterLP).connect(comp).connect(ctx.destination);

    // Sidechain bus (gentle — vaporwave drums are soft).
    this.pump = ctx.createGain();
    this.pump.gain.value = 1;
    this.pump.connect(this.musicGain);

    // Long lush reverb (hall, ~5s decay).
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(ctx, 5, 3);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 1;
    this.convolver.connect(reverbReturn).connect(this.musicGain);

    // Tempo-synced feedback delay.
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.4;
    const fb = ctx.createGain();
    fb.gain.value = 0.45;
    const delayReturn = ctx.createGain();
    delayReturn.gain.value = 0.55;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(delayReturn).connect(this.musicGain);

    // Wow/flutter: a slow LFO that detunes the tonal voices (warped-tape feel).
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.6;
    this.wowGain = ctx.createGain();
    this.wowGain.gain.value = 7; // ±7 cents
    lfo.connect(this.wowGain);
    lfo.start();

    const len = Math.ceil(ctx.sampleRate * 1);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const layer = (name: string): Layer => {
      const cfg = LAYER_CFG[name];
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(cfg.pumped ? this.pump! : this.musicGain!);
      if (cfg.reverb > 0) {
        const s = ctx.createGain(); s.gain.value = cfg.reverb;
        gain.connect(s).connect(this.convolver!);
      }
      if (cfg.delay > 0) {
        const s = ctx.createGain(); s.gain.value = cfg.delay;
        gain.connect(s).connect(this.delay!);
      }
      return { gain, vol: cfg.vol, threshold: cfg.threshold };
    };
    this.layers = {};
    for (const name of Object.keys(LAYER_CFG)) this.layers[name] = layer(name);

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 2000;
    this.padFilter.Q.value = 0.5;
    this.padFilter.connect(this.layers.pad.gain);

    this.applyIntensity();
    this.updateDelayTime();
  }

  private makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.ceil(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  private makeSaturation(amount: number) {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = Math.tanh(amount);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / k;
    }
    return curve;
  }

  // ----------------------------------------------------------------- controls

  setScene(scene: MusicScene): void {
    this.scene = scene;
    const wantTheme = scene === 'boss' ? 'boss' : 'normal';
    if (wantTheme !== this.themeName) {
      this.themeName = wantTheme;
      this.bar = 0;
    }
    this.applyIntensity();
  }

  setSpeed(mult: number): void {
    this.speed = mult;
    this.applyIntensity();
    this.updateDelayTime();
  }

  /** Each level plays in its own key + progression. */
  setLevel(level: number): void {
    this.level = Math.max(1, Math.floor(level));
    this.normalChords = buildChords(this.level, NORMAL_PROGS);
    this.bossChords = buildChords(this.level, BOSS_PROGS);
    this.bar = 0; // start the new progression cleanly
  }

  private get activeChords(): Chord[] {
    return this.themeName === 'boss' ? this.bossChords : this.normalChords;
  }

  private get bpm(): number {
    return 40 + 20 * this.speed; // tempo tracks speed: 1x=60, 2x=80, 3x=100
  }

  private get stepDur(): number {
    return 60 / this.bpm / 4;
  }

  private get intensity(): number {
    return Math.min(1, SCENE_INTENSITY[this.scene] + (this.speed - 1) * 0.22);
  }

  private updateDelayTime(): void {
    if (!this.delay || !this.ctx) return;
    this.delay.delayTime.setTargetAtTime(this.stepDur * 4, this.ctx.currentTime, 0.1); // quarter-note
  }

  private applyMasterGain(): void {
    if (!this.musicGain || !this.ctx) return;
    const target = !this.playing || this.muted ? 0 : MUSIC_VOL;
    this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.3);
  }

  /** Intensity drives both the layer mix and the master brightness (lo-fi → open). */
  private applyIntensity(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const I = this.intensity;
    for (const l of Object.values(this.layers)) {
      const frac = Math.max(0, Math.min(1, (I - l.threshold) / 0.18));
      l.gain.gain.setTargetAtTime(l.vol * frac, now, FADE);
    }
    if (this.masterLP) {
      // Dark and warm: ~900 (murky) → ~5k (open) — never bright enough to screech.
      const cutoff = 900 * Math.pow(2, I * 2.5);
      this.masterLP.frequency.setTargetAtTime(cutoff, now, FADE);
    }
  }

  private active(name: string): boolean {
    const l = this.layers[name];
    return !!l && this.intensity >= l.threshold - 0.02;
  }

  // ----------------------------------------------------------------- sequencer

  private schedule = (): void => {
    const ctx = this.ctx;
    if (!ctx || !this.playing) return;
    while (this.nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
      if (!this.muted) this.scheduleStep(this.step, this.bar, this.nextStepTime);
      this.nextStepTime += this.stepDur;
      this.step++;
      if (this.step >= STEPS) { this.step = 0; this.bar++; }
    }
  };

  private scheduleStep(step: number, bar: number, time: number): void {
    const chords = this.activeChords;
    const chord = chords[bar % chords.length];
    const sd = this.stepDur;

    const groove = GROOVES[(this.level - 1) % GROOVES.length];

    // Drone: a low octave doubling the current chord root for heavy weight.
    if (step === 0 && this.active('drone')) this.drone(chord.root, time, sd * STEPS);
    if (step === 0 && this.active('pad')) this.pad(chord, time, sd * STEPS);

    // Bass: per-level groove on the low root.
    if (this.active('bass') && groove.bass.includes(step)) {
      this.bassNote(midi(chord.root - 12), time, sd * 1.7);
    }

    // Keys: rhythmic power-chord STABS on the offbeats — drive, not a melody.
    if (this.active('keys') && (step === 2 || step === 6 || step === 10 || step === 14)) {
      this.stab(chord, time, sd * 1.4);
    }

    // Drums — per-level groove.
    if (this.active('kick') && groove.kick.includes(step)) this.kick(time);
    if (this.active('hat') && groove.hat.includes(step)) this.hat(time, step === 15);
    if (this.active('clap') && (step === 4 || step === 12)) this.clap(time);

    // Lead: ONE sustained power note held across the bar (no see-saw melody).
    if (this.active('lead') && step === 0) {
      this.lead(midi(chord.root + 12), time, sd * STEPS * 0.95);
    }
  }

  // ----------------------------------------------------------------- voices

  private wow(osc: OscillatorNode): void {
    if (this.wowGain) this.wowGain.connect(osc.detune);
  }

  /** Low tonic pedal — a dark filtered-saw growl plus a deep sine sub. */
  private drone(rootMidi: number, time: number, dur: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.5, time + 1.2);
    g.gain.setValueAtTime(0.5, time + Math.max(1.2, dur - 1));
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    lp.connect(g).connect(this.layers.drone.gain);
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth'; saw.frequency.value = midi(rootMidi - 12); this.wow(saw);
    saw.connect(lp);
    saw.start(time); saw.stop(time + dur + 0.05);
    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = midi(rootMidi - 24);
    sub.connect(g);
    sub.start(time); sub.stop(time + dur + 0.05);
  }

  private pad(chord: Chord, time: number, barDur: number): void {
    const ctx = this.ctx!;
    const attack = 1.5, rel = 1.2; // slow vaporwave swell
    // Soft triangle chord in a warm mid register (no buzzy sawtooths).
    for (const interval of chord.type) {
      const f = midi(chord.root + interval);
      for (const det of [-8, 8]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = f;
        osc.detune.value = det;
        this.wow(osc);
        g.gain.setValueAtTime(0.0001, time);
        g.gain.linearRampToValueAtTime(0.13, time + attack);
        g.gain.setValueAtTime(0.13, time + Math.max(attack, barDur - rel));
        g.gain.exponentialRampToValueAtTime(0.0001, time + barDur);
        osc.connect(g).connect(this.padFilter!);
        osc.start(time);
        osc.stop(time + barDur + 0.05);
      }
    }
  }

  private bassNote(freq: number, time: number, dur: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = freq; // low + filtered = dark growl
    sub.type = 'sine'; sub.frequency.value = freq / 2;
    lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.9;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.6, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(lp); sub.connect(lp);
    lp.connect(g).connect(this.layers.bass.gain);
    osc.start(time); osc.stop(time + dur + 0.02);
    sub.start(time); sub.stop(time + dur + 0.02);
  }

  /** Rhodes-ish electric piano: a body sine + a fast-decaying "tine" overtone. */
  /** A short rhythmic power-chord stab (root + fifth + octave) — drive, no melody. */
  private stab(chord: Chord, time: number, dur: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1500; lp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.3, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    lp.connect(g).connect(this.layers.keys.gain);
    for (const interval of chord.type) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midi(chord.root + interval);
      osc.detune.value = 6;
      this.wow(osc);
      osc.connect(lp);
      osc.start(time); osc.stop(time + dur + 0.02);
    }
  }

  private lead(freq: number, time: number, dur: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 1800; lp.Q.value = 0.7;
    lp.connect(g).connect(this.layers.lead.gain);
    // Two detuned triangles — soft and flute-like, never buzzy.
    for (const det of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = freq; osc.detune.value = det;
      this.wow(osc);
      osc.connect(lp);
      osc.start(time); osc.stop(time + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.34, time + 0.14);
    g.gain.setValueAtTime(0.34, time + Math.max(0.18, dur - 0.6));
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  }

  private kick(time: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(170, time);
    osc.frequency.exponentialRampToValueAtTime(44, time + 0.085); // faster, punchier drop
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.98, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    osc.connect(g).connect(this.layers.kick.gain);
    osc.start(time); osc.stop(time + 0.22);
    if (this.pump) {
      const p = this.pump.gain;
      p.cancelScheduledValues(time);
      p.setValueAtTime(0.7, time);
      p.linearRampToValueAtTime(1, time + Math.min(0.28, this.stepDur * 4));
    }
  }

  private hat(time: number, open: boolean): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 9000;
    const g = ctx.createGain();
    const dur = open ? 0.12 : 0.022;
    g.gain.setValueAtTime(0.4, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    src.connect(hp).connect(g).connect(this.layers.hat.gain);
    src.start(time); src.stop(time + dur + 0.02);
  }

  /** Soft processed clap: a couple of quick filtered noise bursts. */
  private clap(time: number): void {
    const ctx = this.ctx!;
    for (const off of [0, 0.012, 0.024]) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.1;
      const g = ctx.createGain();
      const t = time + off;
      g.gain.setValueAtTime(off === 0 ? 0.5 : 0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      src.connect(bp).connect(g).connect(this.layers.clap.gain);
      src.start(t); src.stop(t + 0.1);
    }
  }

  // ----------------------------------------------------------------- debug

  snapshot(): Record<string, unknown> {
    const gains: Record<string, number> = {};
    for (const [k, l] of Object.entries(this.layers)) gains[k] = +l.gain.gain.value.toFixed(3);
    return {
      playing: this.playing, muted: this.muted, scene: this.scene, speed: this.speed,
      level: this.level, theme: this.themeName,
      roots: this.activeChords.map((c) => c.root),
      intensity: +this.intensity.toFixed(3),
      bpm: Math.round(this.bpm), master: this.musicGain ? +this.musicGain.gain.value.toFixed(3) : null,
      cutoff: this.masterLP ? Math.round(this.masterLP.frequency.value) : null, layers: gains,
    };
  }
}

export const music = new MusicEngine();
