// Adaptive synthwave/vaporwave soundtrack — fully procedural Web Audio, no
// assets (so it's inherently royalty-free). A look-ahead step sequencer plays a
// layered arrangement; layers fade in as "intensity" rises, intensity tracks
// the game speed, and boss waves swap to a darker theme.
//
// Sound design for a "produced" retrowave feel: every voice is filtered (no raw
// buzz), pads/lead/arp run through a generated reverb + tempo-synced delay, a
// kick-driven sidechain "pump" gives the groove, and a master compressor glues
// it. Shares the one AudioContext with the SFX engine but has its own gain +
// mute so music toggles independently of sound effects.
import { sfx } from './audio';

const MUSIC_VOL = 0.5;         // master music level (the compressor tames peaks)
const BASE_BPM = 96;
const STEPS = 16;              // sixteenth-notes per bar
const LOOKAHEAD_MS = 25;       // scheduler tick
const SCHEDULE_AHEAD = 0.12;   // seconds of notes to queue ahead of the clock
const FADE = 0.4;              // gain ramp time-constant for smooth crossfades

export type MusicScene = 'menu' | 'build' | 'combat' | 'boss';

/** Base intensity (0..1) per scene; speed adds to this. */
const SCENE_INTENSITY: Record<MusicScene, number> = {
  menu: 0.12, build: 0.32, combat: 0.6, boss: 0.85,
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

// Bright sixteenth-note arpeggio pattern (indices into the chord-tone table).
const ARP_PATTERN = [0, 2, 4, 2, 3, 2, 4, 5];

interface LayerCfg { vol: number; threshold: number; pumped: boolean; reverb: number; delay: number; }
const LAYER_CFG: Record<string, LayerCfg> = {
  pad:   { vol: 0.34, threshold: 0.0,  pumped: true,  reverb: 0.55, delay: 0 },
  bass:  { vol: 0.5,  threshold: 0.12, pumped: true,  reverb: 0,    delay: 0 },
  kick:  { vol: 0.9,  threshold: 0.33, pumped: false, reverb: 0,    delay: 0 },
  hat:   { vol: 0.18, threshold: 0.45, pumped: false, reverb: 0.1,  delay: 0 },
  snare: { vol: 0.42, threshold: 0.55, pumped: false, reverb: 0.25, delay: 0 },
  arp:   { vol: 0.26, threshold: 0.6,  pumped: true,  reverb: 0.35, delay: 0.4 },
  lead:  { vol: 0.3,  threshold: 0.72, pumped: true,  reverb: 0.45, delay: 0.45 },
};

interface Layer { gain: GainNode; vol: number; threshold: number; }

export class MusicEngine {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null; // master volume + mute
  private pump: GainNode | null = null;       // sidechain duck (pad/bass/arp/lead)
  private convolver: ConvolverNode | null = null;
  private delay: DelayNode | null = null;
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
    // Master: musicGain -> compressor -> destination (glue + peak control).
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 24;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.musicGain.connect(comp).connect(ctx.destination);

    // Sidechain bus: pad/bass/arp/lead pass through here; the kick ducks it.
    this.pump = ctx.createGain();
    this.pump.gain.value = 1;
    this.pump.connect(this.musicGain);

    // Reverb send (generated impulse) for synthwave space.
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(ctx, 2.2, 2.4);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.9;
    this.convolver.connect(reverbReturn).connect(this.musicGain);

    // Tempo-synced feedback delay for the arp/lead.
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const delayReturn = ctx.createGain();
    delayReturn.gain.value = 0.5;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(delayReturn).connect(this.musicGain);

    // One white-noise buffer reused for hats/snare.
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
        const s = ctx.createGain();
        s.gain.value = cfg.reverb;
        gain.connect(s).connect(this.convolver!);
      }
      if (cfg.delay > 0) {
        const s = ctx.createGain();
        s.gain.value = cfg.delay;
        gain.connect(s).connect(this.delay!);
      }
      return { gain, vol: cfg.vol, threshold: cfg.threshold };
    };
    this.layers = {};
    for (const name of Object.keys(LAYER_CFG)) this.layers[name] = layer(name);

    // Pads run through a shared lowpass for the warm vaporwave wash.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 1300;
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
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
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
    this.updateDelayTime();
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

  private updateDelayTime(): void {
    if (!this.delay || !this.ctx) return;
    this.delay.delayTime.setTargetAtTime(this.stepDur * 3, this.ctx.currentTime, 0.1); // dotted-8th
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

    // Bass: octave-bouncing eighth-notes (the signature synthwave bassline).
    if (this.active('bass') && step % 2 === 0) {
      const up = step % 4 === 2; // alternate root / octave-up
      this.bassNote(midi(chord.root - 12 + (up ? 12 : 0)), time, sd * 1.7);
    }

    // Drums.
    if (this.active('kick') && (step % 4 === 0)) this.kick(time);
    if (this.active('hat') && step % 2 === 1) this.hat(time, step % 8 === 7);
    if (this.active('snare') && (step === 4 || step === 12)) this.snare(time);

    // Arp: filtered sixteenth-note pluck cycling a musical pattern, an octave up.
    if (this.active('arp')) {
      const tones = [chord.type[0], chord.type[1], chord.type[2], 12, 12 + chord.type[1], 19];
      const note = chord.root + 12 + tones[ARP_PATTERN[step % ARP_PATTERN.length] % tones.length];
      this.pluck(midi(note), time, sd * 1.1);
    }

    // Lead: a soaring held note (top chord tone) changing on the half-bar.
    if (this.active('lead') && (step === 0 || step === 8)) {
      const note = chord.root + 24 + (step === 8 ? chord.type[1] : 0);
      this.lead(midi(note), time, sd * 8 * 0.95);
    }
  }

  // ----------------------------------------------------------------- voices

  private env(g: GainNode, time: number, peak: number, attack: number, dur: number): void {
    // Click-free: short linear attack, exponential release.
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(peak, time + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  }

  private pad(chord: Chord, time: number, barDur: number): void {
    const ctx = this.ctx!;
    const attack = 0.6, rel = 0.7;
    // Triad voiced in the mid octave, each tone a detuned saw pair for width.
    for (const interval of chord.type) {
      const f = midi(chord.root + 12 + interval);
      for (const det of [-8, 8]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = det;
        g.gain.setValueAtTime(0.0001, time);
        g.gain.linearRampToValueAtTime(0.1, time + attack);
        g.gain.setValueAtTime(0.1, time + Math.max(attack, barDur - rel));
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
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    sub.type = 'sine';            // sub-oscillator for weight
    sub.frequency.value = freq / 2;
    lp.type = 'lowpass';
    lp.frequency.value = 720;
    lp.Q.value = 1;
    this.env(g, time, 0.6, 0.01, dur);
    osc.connect(lp);
    sub.connect(lp);
    lp.connect(g).connect(this.layers.bass.gain);
    osc.start(time); osc.stop(time + dur + 0.02);
    sub.start(time); sub.stop(time + dur + 0.02);
  }

  private pluck(freq: number, time: number, dur: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    // Filter envelope: open then close → classic synth pluck.
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(Math.min(6000, freq * 6), time);
    lp.frequency.exponentialRampToValueAtTime(Math.max(500, freq * 1.5), time + dur);
    this.env(g, time, 0.26, 0.005, dur);
    osc.connect(lp).connect(g).connect(this.layers.arp.gain);
    osc.start(time); osc.stop(time + dur + 0.02);
  }

  private lead(freq: number, time: number, dur: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    lp.Q.value = 1;
    lp.connect(g).connect(this.layers.lead.gain);
    for (const det of [-6, 6]) { // detuned saw pair (supersaw-lite)
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = det;
      osc.connect(lp);
      osc.start(time); osc.stop(time + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.3, time + 0.08);
    g.gain.setValueAtTime(0.3, time + Math.max(0.1, dur - 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  }

  private kick(time: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(165, time);
    osc.frequency.exponentialRampToValueAtTime(46, time + 0.09);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(1, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    osc.connect(g).connect(this.layers.kick.gain);
    osc.start(time); osc.stop(time + 0.22);
    // Sidechain pump: duck the musical bus on each kick.
    if (this.pump) {
      const p = this.pump.gain;
      p.cancelScheduledValues(time);
      p.setValueAtTime(0.5, time);
      p.linearRampToValueAtTime(1, time + Math.min(0.22, this.stepDur * 3));
    }
  }

  private hat(time: number, open: boolean): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 8500;
    const g = ctx.createGain();
    const dur = open ? 0.13 : 0.026;
    g.gain.setValueAtTime(0.5, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    src.connect(hp).connect(g).connect(this.layers.hat.gain);
    src.start(time); src.stop(time + dur + 0.02);
  }

  private snare(time: number): void {
    const ctx = this.ctx!;
    // Noise body (bandpassed) for the "ssh", plus two sines for the tonal snap.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2000;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.7, time);
    ng.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    src.connect(bp).connect(ng).connect(this.layers.snare.gain);
    src.start(time); src.stop(time + 0.18);
    for (const f of [185, 290]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.35, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
      osc.connect(g).connect(this.layers.snare.gain);
      osc.start(time); osc.stop(time + 0.1);
    }
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
