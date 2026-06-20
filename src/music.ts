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

const MUSIC_VOL = 0.5;         // master music level (the compressor tames peaks)
const BASE_BPM = 75;           // vaporwave sits slow (60-90 BPM)
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

// Dark voicings (semitone intervals from the root).
const MAJ7 = [0, 4, 7, 11];
const MIN7 = [0, 3, 7, 10];
const MIN9 = [0, 3, 7, 10, 14];
const DOM7B9 = [0, 4, 10, 13]; // "evil" dominant — the b9 (and 3rd-vs-root tritone) bites
const DIM7 = [0, 3, 6, 9];     // fully diminished — stacked minor thirds (horror staple)

interface Chord { root: number; type: number[]; }
interface Theme { chords: Chord[]; }

// Dark harmonic-minor menace vs. an even more evil Phrygian/diminished boss.
const THEMES: Record<'normal' | 'boss', Theme> = {
  normal: { chords: [
    { root: 57, type: MIN7 },   // Am7   (i)
    { root: 53, type: MAJ7 },   // Fmaj7 (bVI)
    { root: 50, type: MIN7 },   // Dm7   (iv)
    { root: 52, type: DOM7B9 }, // E7b9  (V — harmonic-minor menace)
  ] },
  boss: { chords: [
    { root: 50, type: MIN9 },   // Dm9
    { root: 51, type: MAJ7 },   // Ebmaj7 (bII — Phrygian half-step, very dark)
    { root: 56, type: DIM7 },   // G#dim7 (tritone tension)
    { root: 57, type: DOM7B9 }, // A7b9   (evil V back to Dm)
  ] },
};

interface LayerCfg { vol: number; threshold: number; pumped: boolean; reverb: number; delay: number; }
const LAYER_CFG: Record<string, LayerCfg> = {
  drone: { vol: 0.42, threshold: 0.0,  pumped: true,  reverb: 0.45, delay: 0 }, // low tonic pedal
  pad:   { vol: 0.3,  threshold: 0.08, pumped: true,  reverb: 0.6,  delay: 0 },
  bass:  { vol: 0.5,  threshold: 0.12, pumped: true,  reverb: 0.08, delay: 0 },
  keys:  { vol: 0.34, threshold: 0.28, pumped: true,  reverb: 0.4,  delay: 0.45 }, // Rhodes
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

  setPaused(paused: boolean): void {
    this.ducked = paused;
    this.applyMasterGain();
  }

  private get bpm(): number {
    return BASE_BPM * (1 + 0.12 * (this.speed - 1));
  }

  private get stepDur(): number {
    return 60 / this.bpm / 4;
  }

  private get intensity(): number {
    return Math.min(1, SCENE_INTENSITY[this.scene] + (this.speed - 1) * 0.12);
  }

  private updateDelayTime(): void {
    if (!this.delay || !this.ctx) return;
    this.delay.delayTime.setTargetAtTime(this.stepDur * 4, this.ctx.currentTime, 0.1); // quarter-note
  }

  private applyMasterGain(): void {
    if (!this.musicGain || !this.ctx) return;
    const target = !this.playing || this.muted ? 0 : MUSIC_VOL * (this.ducked ? 0.45 : 1);
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
    const theme = THEMES[this.themeName];
    const chord = theme.chords[bar % theme.chords.length];
    const sd = this.stepDur;

    // Drone: a low pedal on the theme's tonic, holding under the moving chords
    // (the clash on non-tonic chords is what makes it feel ominous).
    if (step === 0 && this.active('drone')) this.drone(theme.chords[0].root, time, sd * STEPS);

    if (step === 0 && this.active('pad')) this.pad(chord, time, sd * STEPS);

    // Bass: soft root on the beat, with the 5th on the back half.
    if (this.active('bass') && step % 4 === 0) {
      const note = step === 8 ? chord.root - 12 + 7 : chord.root - 12;
      this.bassNote(midi(note), time, sd * 3.4);
    }

    // Rhodes: gentle eighth-note arpeggio up the jazz chord.
    if (this.active('keys') && step % 2 === 0) {
      const t = chord.type;
      const note = chord.root + 12 + t[(step / 2) % t.length];
      this.rhodes(midi(note), time, sd * 2.2);
    }

    // Drums — minimal & soft.
    if (this.active('kick') && step % 4 === 0) this.kick(time);
    if (this.active('hat') && step % 2 === 1) this.hat(time, step % 8 === 7);
    if (this.active('clap') && (step === 4 || step === 12)) this.clap(time);

    // Lead: a soft held note that stays in the pad's octave (always a chord
    // tone — the octave, then the 3rd) so it sings without ever going shrill.
    if (this.active('lead') && (step === 0 || step === 8)) {
      const note = chord.root + 12 + (step === 0 ? 0 : chord.type[1]);
      this.lead(midi(note), time, sd * 8 * 0.95);
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
  private rhodes(freq: number, time: number, dur: number): void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, time);
    out.gain.linearRampToValueAtTime(0.32, time + 0.008);
    out.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    out.connect(this.layers.keys.gain);
    // Body.
    const body = ctx.createOscillator();
    body.type = 'sine'; body.frequency.value = freq; this.wow(body);
    body.connect(out);
    body.start(time); body.stop(time + dur + 0.02);
    // Tine (bell attack, decays quickly).
    const tine = ctx.createOscillator();
    const tg = ctx.createGain();
    tine.type = 'sine'; tine.frequency.value = freq * 2; this.wow(tine);
    tg.gain.setValueAtTime(0.5, time);
    tg.gain.exponentialRampToValueAtTime(0.001, time + Math.min(0.18, dur));
    tine.connect(tg).connect(out);
    tine.start(time); tine.stop(time + dur + 0.02);
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
    osc.frequency.setValueAtTime(140, time);
    osc.frequency.exponentialRampToValueAtTime(48, time + 0.11);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.85, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
    osc.connect(g).connect(this.layers.kick.gain);
    osc.start(time); osc.stop(time + 0.24);
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
      theme: this.themeName, intensity: +this.intensity.toFixed(3),
      bpm: Math.round(this.bpm), master: this.musicGain ? +this.musicGain.gain.value.toFixed(3) : null,
      cutoff: this.masterLP ? Math.round(this.masterLP.frequency.value) : null, layers: gains,
    };
  }
}

export const music = new MusicEngine();
