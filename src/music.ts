// Adaptive synthwave/vaporwave soundtrack — fully procedural Web Audio, no
// assets (so it's inherently royalty-free). A look-ahead step sequencer plays a
// layered arrangement (pads / bass / drums / arp); the layers fade in as the
// "intensity" rises, intensity tracks the game speed, and boss waves swap to a
// darker theme. Shares the one AudioContext with the SFX engine but has its own
// gain + mute so music toggles independently of sound effects.
import { sfx } from './audio';

const MUSIC_VOL = 0.22;        // master music level (sits under the SFX mix)
const BASE_BPM = 100;
const STEPS = 16;              // sixteenth-notes per bar
const LOOKAHEAD_MS = 25;       // scheduler tick
const SCHEDULE_AHEAD = 0.12;   // seconds of notes to queue ahead of the clock
const FADE = 0.4;              // gain ramp time-constant for smooth crossfades

export type MusicScene = 'menu' | 'build' | 'combat' | 'boss';

/** Base intensity (0..1) per scene; speed adds to this. */
const SCENE_INTENSITY: Record<MusicScene, number> = {
  menu: 0.12, build: 0.3, combat: 0.58, boss: 0.82,
};

const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

const MIN = [0, 3, 7];
const MAJ = [0, 4, 7];

interface Chord { root: number; type: number[]; }
interface Theme { chords: Chord[]; }

// Bright, driving minor synthwave vs. a darker, lower boss progression.
const THEMES: Record<'normal' | 'boss', Theme> = {
  normal: { chords: [
    { root: 57, type: MIN }, // Am
    { root: 53, type: MAJ }, // F
    { root: 60, type: MAJ }, // C
    { root: 55, type: MAJ }, // G
  ] },
  boss: { chords: [
    { root: 50, type: MIN }, // Dm
    { root: 55, type: MIN }, // Gm
    { root: 50, type: MIN }, // Dm
    { root: 57, type: MAJ }, // A  (V — harmonic-minor tension)
  ] },
};

interface Layer { gain: GainNode; vol: number; threshold: number; }

export class MusicEngine {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private layers: Record<string, Layer> = {};

  private muted = localStorage.getItem('cd-music-muted') === '1';
  private playing = false;
  private ducked = false;
  private timer = 0;

  private scene: MusicScene = 'menu';
  private speed = 1;
  private themeName: 'normal' | 'boss' = 'normal';

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

  /** Build the audio graph (idempotent) and start the sequencer. */
  start(): void {
    const ctx = sfx.getContext();
    if (!this.musicGain) this.build(ctx);
    this.ctx = ctx;
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.bar = 0;
    this.nextStepTime = ctx.currentTime + 0.1;
    this.applyMasterGain();
    this.timer = window.setInterval(this.schedule, LOOKAHEAD_MS);
  }

  /** Fade out and stop the sequencer (e.g. on game over). */
  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    window.clearInterval(this.timer);
    this.timer = 0;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    }
  }

  private build(ctx: AudioContext): void {
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(ctx.destination);

    // One white-noise buffer reused for hats/snare.
    const len = Math.ceil(ctx.sampleRate * 1);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const layer = (vol: number, threshold: number): Layer => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.musicGain!);
      return { gain, vol, threshold };
    };
    this.layers = {
      pad:   layer(0.5, 0.0),
      bass:  layer(0.55, 0.12),
      kick:  layer(0.9, 0.33),
      hat:   layer(0.28, 0.45),
      snare: layer(0.55, 0.55),
      arp:   layer(0.4, 0.62),
    };
    // Pads run through a shared lowpass for the warm vaporwave wash.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 1400;
    this.padFilter.connect(this.layers.pad.gain);

    this.applyIntensity();
  }

  // ----------------------------------------------------------------- controls

  setScene(scene: MusicScene): void {
    this.scene = scene;
    const wantTheme = scene === 'boss' ? 'boss' : 'normal';
    if (wantTheme !== this.themeName) {
      this.themeName = wantTheme;
      this.bar = 0; // restart the progression so the theme change lands cleanly
    }
    this.applyIntensity();
  }

  setSpeed(mult: number): void {
    this.speed = mult;
    this.applyIntensity();
  }

  /** Lower the volume while the game is paused; restore on resume. */
  setPaused(paused: boolean): void {
    this.ducked = paused;
    this.applyMasterGain();
  }

  private get bpm(): number {
    return BASE_BPM * (1 + 0.12 * (this.speed - 1)); // ~+12%/+24% at 2x/3x
  }

  private get stepDur(): number {
    return 60 / this.bpm / 4; // sixteenth-note length
  }

  private get intensity(): number {
    return Math.min(1, SCENE_INTENSITY[this.scene] + (this.speed - 1) * 0.12);
  }

  private applyMasterGain(): void {
    if (!this.musicGain || !this.ctx) return;
    const target = !this.playing || this.muted ? 0 : MUSIC_VOL * (this.ducked ? 0.45 : 1);
    this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.25);
  }

  /** Map intensity → each layer's mix gain (smooth ramp). */
  private applyIntensity(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const I = this.intensity;
    for (const l of Object.values(this.layers)) {
      const frac = Math.max(0, Math.min(1, (I - l.threshold) / 0.18));
      l.gain.gain.setTargetAtTime(l.vol * frac, now, FADE);
    }
  }

  /** Whether a layer is loud enough to be worth scheduling notes for. */
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
    const theme = THEMES[this.themeName];
    const chord = theme.chords[bar % theme.chords.length];
    const sd = this.stepDur;

    // Pads: sustained chord retriggered at the top of each bar.
    if (step === 0 && this.active('pad')) this.pad(chord, time, sd * STEPS);

    // Bass: driving eighth-notes on the (low) root, with a fifth for lift.
    if (this.active('bass') && step % 2 === 0) {
      const note = step % 8 === 4 ? chord.root - 12 + 7 : chord.root - 12;
      this.voice(this.layers.bass.gain, midi(note), time, sd * 1.6, 'sawtooth', 0.5, 0.005);
    }

    // Drums.
    if (this.active('kick') && step % 4 === 0) this.kick(time);
    if (this.active('hat') && step % 2 === 1) this.hat(time, step % 8 === 7);
    if (this.active('snare') && (step === 4 || step === 12)) this.snare(time);

    // Arp: bright sixteenth-note pluck cycling the chord tones an octave up.
    if (this.active('arp')) {
      const tones = [chord.type[0], chord.type[1], chord.type[2], 12];
      const note = chord.root + 12 + tones[step % tones.length];
      this.voice(this.layers.arp.gain, midi(note), time, sd * 0.9, 'square', 0.32, 0.004);
    }
  }

  // ----------------------------------------------------------------- voices

  private voice(
    dest: AudioNode, freq: number, time: number, dur: number,
    type: OscillatorType, peak: number, attack: number,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), time + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g).connect(dest);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  }

  private pad(chord: Chord, time: number, barDur: number): void {
    const ctx = this.ctx!;
    const attack = 0.5, rel = 0.6;
    for (const interval of chord.type) {
      const f = midi(chord.root + 12 + interval);
      for (const det of [-7, 7]) { // detuned pair for width
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = det;
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

  private kick(time: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    g.gain.setValueAtTime(1, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    osc.connect(g).connect(this.layers.kick.gain);
    osc.start(time);
    osc.stop(time + 0.2);
  }

  private hat(time: number, open: boolean): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    const dur = open ? 0.14 : 0.03;
    g.gain.setValueAtTime(0.6, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    src.connect(hp).connect(g).connect(this.layers.hat.gain);
    src.start(time);
    src.stop(time + dur + 0.02);
  }

  private snare(time: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    src.connect(bp).connect(g).connect(this.layers.snare.gain);
    src.start(time);
    src.stop(time + 0.2);
  }

  // ----------------------------------------------------------------- debug

  /** Inspectable snapshot for verification (gain values, tempo, theme). */
  snapshot(): Record<string, unknown> {
    const gains: Record<string, number> = {};
    for (const [k, l] of Object.entries(this.layers)) gains[k] = +l.gain.gain.value.toFixed(3);
    return {
      playing: this.playing, muted: this.muted, scene: this.scene, speed: this.speed,
      theme: this.themeName, intensity: +this.intensity.toFixed(3),
      bpm: Math.round(this.bpm), master: this.musicGain ? +this.musicGain.gain.value.toFixed(3) : null,
      layers: gains,
    };
  }
}

export const music = new MusicEngine();
