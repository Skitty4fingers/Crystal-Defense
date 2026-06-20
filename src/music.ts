// Procedural "anxious" background score — fully synthesized Web Audio, no assets
// (so it's inherently royalty-free). The harmony is intentionally STATIC (a dark
// pedal chord per level, no moving progression, no pitch wobble) so there's no
// melody to see-saw; the tension comes from rhythm, timbre and a low drone.
//
// Each level picks one of 10 distinct STYLES (driving pulse, heartbeat, ticking
// clock, chase, tremolo dread, industrial, sparse, march, stabs, rising panic).
// Layers fade in with "intensity", which tracks the game speed; the boss scene
// adds a tritone to the chord. Tempo tracks speed only (1x=60, 2x=80, 3x=100).
// Shares the SFX AudioContext but keeps its own gain + mute.
import { sfx } from './audio';

const MUSIC_VOL = 0.125;       // master music level — sits well under the SFX
const STEPS = 16;              // sixteenth-notes per bar
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const FADE = 0.5;

export type MusicScene = 'menu' | 'build' | 'combat' | 'boss';

/** Base intensity (0..1) per scene; speed adds to this. The menu runs a full
 *  loop (its own complex Industrial track), so it sits high. */
const SCENE_INTENSITY: Record<MusicScene, number> = {
  menu: 0.62, build: 0.34, combat: 0.62, boss: 0.86,
};

const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

// ---- harmony: a single static chord per level (no progression = no see-saw) --
const POWER = [0, 7, 12];       // root + fifth + octave (heavy, neutral)
const TRITONE = [0, 6, 12];     // root + tritone + octave (very tense)
const CLUSTER = [0, 1, 7];      // root + b2 + fifth (dissonant horror)
const BOSS_CHORD = [0, 6, 7, 12]; // tritone dissonance for boss scenes
const BASE_TONIC = 50; // D3
// Per-level key (semitone transposition), cycling 12 — keeps levels distinct.
const LEVEL_TONIC = [0, -5, 4, -7, 2, 7, -3, 5, -2, -9, 3, -6];

interface Chord { root: number; type: number[]; }

// ---- styles: each level plays a different rhythmic character ----------------
const E8 = [0, 2, 4, 6, 8, 10, 12, 14];                                    // eighths
const E16 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];        // sixteenths
const FLOOR = [0, 4, 8, 12];
const OFF = [2, 6, 10, 14];
const BACK = [4, 12];

interface Style {
  name: string;
  chord: number[];
  drone: 'static' | 'rising' | 'none';
  pad: 'sustain' | 'tremolo' | 'none';
  bass: number[];
  bassWave: OscillatorType;
  pulse: number[];   // relentless high single-note pulse (keys layer)
  stab: number[];    // chord stab (keys layer)
  kick: number[];
  hat: number[];
  snare: number[];   // backbeat / march (clap voice)
}

const STYLES: Style[] = [
  { name: 'Pulse Drive', chord: POWER,   drone: 'static', pad: 'sustain', bass: E8,  bassWave: 'sawtooth', pulse: [],  stab: [],  kick: FLOOR,             hat: OFF,  snare: BACK },
  { name: 'Heartbeat',   chord: POWER,   drone: 'static', pad: 'sustain', bass: [],  bassWave: 'sine',     pulse: [],  stab: [],  kick: [0, 3, 8, 11],     hat: [],   snare: [] },
  { name: 'Clockwork',   chord: POWER,   drone: 'static', pad: 'none',    bass: [0, 8], bassWave: 'sawtooth', pulse: [], stab: [], kick: [0, 8],            hat: E16,  snare: [] },
  { name: 'Chase',       chord: POWER,   drone: 'static', pad: 'none',    bass: E16, bassWave: 'sawtooth', pulse: E16, stab: [],  kick: FLOOR,             hat: OFF,  snare: [] },
  { name: 'Tremolo Dread', chord: CLUSTER, drone: 'static', pad: 'tremolo', bass: [], bassWave: 'sine',    pulse: [],  stab: [],  kick: [0],               hat: [],   snare: [] },
  { name: 'Industrial',  chord: TRITONE, drone: 'static', pad: 'none',    bass: FLOOR, bassWave: 'square', pulse: [],  stab: [],  kick: [0, 3, 6, 8, 11, 14], hat: [2, 10], snare: BACK },
  { name: 'Sparse Dread', chord: POWER,  drone: 'static', pad: 'sustain', bass: [0], bassWave: 'sine',     pulse: [],  stab: [],  kick: [0],               hat: [],   snare: [] },
  { name: 'March',       chord: POWER,   drone: 'static', pad: 'none',    bass: FLOOR, bassWave: 'sawtooth', pulse: [], stab: [],  kick: [0, 8],            hat: [],   snare: OFF },
  { name: 'Pulsing Stabs', chord: TRITONE, drone: 'static', pad: 'sustain', bass: E8, bassWave: 'sawtooth', pulse: [], stab: OFF, kick: FLOOR,             hat: OFF,  snare: [] },
  { name: 'Rising Panic', chord: POWER,  drone: 'rising', pad: 'none',     bass: E8,  bassWave: 'sawtooth', pulse: [], stab: [],  kick: FLOOR,             hat: E16,  snare: [] },
];

// Per-level style rotation — only the liked styles (Chase & Industrial weighted
// double over Pulse Drive & Rising Panic). Indices into STYLES above.
const STYLE_ORDER = [3, 5, 0, 3, 5, 9]; // Chase, Industrial, Pulse Drive, Chase, Industrial, Rising Panic

// Dedicated menu loop: a more complex Industrial tritone groove, fixed at 80 BPM.
const MENU_TONIC = 50; // D3
const MENU_STYLE: Style = {
  name: 'Industrial (menu)', chord: TRITONE, drone: 'static', pad: 'tremolo',
  bass: [0, 3, 4, 7, 8, 10, 11, 14], bassWave: 'square',  // syncopated machine bass
  pulse: [2, 6, 10, 14],                                   // offbeat metallic pulse
  stab: [3, 11],                                           // syncopated tritone stabs
  kick: [0, 3, 6, 8, 11, 14],                              // irregular industrial kick
  hat: [1, 3, 5, 7, 9, 11, 13, 15],                        // busy 16th hats
  snare: [4, 12],                                          // backbeat
};

interface LayerCfg { vol: number; threshold: number; pumped: boolean; reverb: number; delay: number; }
const LAYER_CFG: Record<string, LayerCfg> = {
  drone: { vol: 0.42, threshold: 0.0,  pumped: true,  reverb: 0.45, delay: 0 },
  pad:   { vol: 0.3,  threshold: 0.06, pumped: true,  reverb: 0.6,  delay: 0 },
  bass:  { vol: 0.5,  threshold: 0.12, pumped: true,  reverb: 0.06, delay: 0 },
  keys:  { vol: 0.32, threshold: 0.44, pumped: true,  reverb: 0.35, delay: 0.4 },
  kick:  { vol: 0.78, threshold: 0.36, pumped: false, reverb: 0.05, delay: 0 },
  hat:   { vol: 0.16, threshold: 0.46, pumped: false, reverb: 0.15, delay: 0 },
  clap:  { vol: 0.34, threshold: 0.52, pumped: false, reverb: 0.35, delay: 0 },
};

interface Layer { gain: GainNode; vol: number; threshold: number; }

export class MusicEngine {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private masterLP: BiquadFilterNode | null = null;
  private pump: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private delay: DelayNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private layers: Record<string, Layer> = {};

  private muted = localStorage.getItem('cd-music-muted') === '1';
  private playing = false;
  private timer = 0;

  private scene: MusicScene = 'menu';
  private speed = 1;
  private themeName: 'normal' | 'boss' = 'normal';
  private level = 1;
  private tonic = BASE_TONIC;
  private style: Style = STYLES[0];

  private step = 0;
  private bar = 0;
  private nextStepTime = 0;

  get isMusicMuted(): boolean { return this.muted; }

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
    this.speed = 1; // always begin at the slowest tempo/intensity (1x)
    this.step = 0;
    this.bar = 0;
    this.nextStepTime = ctx.currentTime + 0.1;
    this.applyIntensity();
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
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.makeSaturation(1.2);
    this.masterLP = ctx.createBiquadFilter();
    this.masterLP.type = 'lowpass';
    this.masterLP.frequency.value = 3000;
    this.masterLP.Q.value = 0.4;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 28; comp.ratio.value = 2.5;
    comp.attack.value = 0.006; comp.release.value = 0.3;
    this.musicGain.connect(shaper).connect(this.masterLP).connect(comp).connect(ctx.destination);

    this.pump = ctx.createGain();
    this.pump.gain.value = 1;
    this.pump.connect(this.musicGain);

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(ctx, 4.5, 3);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.9;
    this.convolver.connect(reverbReturn).connect(this.musicGain);

    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.4;
    const fb = ctx.createGain(); fb.gain.value = 0.4;
    const delayReturn = ctx.createGain(); delayReturn.gain.value = 0.5;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(delayReturn).connect(this.musicGain);

    const len = Math.ceil(ctx.sampleRate * 1);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const layer = (name: string): Layer => {
      const cfg = LAYER_CFG[name];
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(cfg.pumped ? this.pump! : this.musicGain!);
      if (cfg.reverb > 0) { const s = ctx.createGain(); s.gain.value = cfg.reverb; gain.connect(s).connect(this.convolver!); }
      if (cfg.delay > 0) { const s = ctx.createGain(); s.gain.value = cfg.delay; gain.connect(s).connect(this.delay!); }
      return { gain, vol: cfg.vol, threshold: cfg.threshold };
    };
    this.layers = {};
    for (const name of Object.keys(LAYER_CFG)) this.layers[name] = layer(name);

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 2000;
    this.padFilter.Q.value = 0.5;
    this.padFilter.connect(this.layers.pad.gain);

    this.setLevel(this.level);
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
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * amount) / k; }
    return curve;
  }

  // ----------------------------------------------------------------- controls

  setScene(scene: MusicScene): void {
    this.scene = scene;
    const wantTheme = scene === 'boss' ? 'boss' : 'normal';
    if (wantTheme !== this.themeName) { this.themeName = wantTheme; this.bar = 0; }
    this.applyIntensity();
  }

  setSpeed(mult: number): void {
    this.speed = mult;
    this.applyIntensity();
    this.updateDelayTime();
  }

  /** Each level picks its own style + key. */
  setLevel(level: number): void {
    this.level = Math.max(1, Math.floor(level));
    this.style = STYLES[STYLE_ORDER[(this.level - 1) % STYLE_ORDER.length]];
    let t = BASE_TONIC + LEVEL_TONIC[(this.level - 1) % LEVEL_TONIC.length];
    while (t > 55) t -= 12;
    while (t < 40) t += 12;
    this.tonic = t;
    this.bar = 0;
  }

  private get bpm(): number {
    if (this.scene === 'menu') return 80; // menu loop is fixed at 80 BPM
    return 40 + 20 * this.speed;          // 1x=60, 2x=80, 3x=100
  }

  private get stepDur(): number { return 60 / this.bpm / 4; }

  private get intensity(): number {
    return Math.min(1, SCENE_INTENSITY[this.scene] + (this.speed - 1) * 0.22);
  }

  private updateDelayTime(): void {
    if (!this.delay || !this.ctx) return;
    this.delay.delayTime.setTargetAtTime(this.stepDur * 4, this.ctx.currentTime, 0.1);
  }

  private applyMasterGain(): void {
    if (!this.musicGain || !this.ctx) return;
    const target = !this.playing || this.muted ? 0 : MUSIC_VOL;
    this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.3);
  }

  private applyIntensity(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const I = this.intensity;
    for (const l of Object.values(this.layers)) {
      const frac = Math.max(0, Math.min(1, (I - l.threshold) / 0.18));
      l.gain.gain.setTargetAtTime(l.vol * frac, now, FADE);
    }
    if (this.masterLP) {
      const cutoff = 900 * Math.pow(2, I * 2.5); // murky → warm-open (never harsh)
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
      if (!this.muted) this.scheduleStep(this.step, this.nextStepTime);
      this.nextStepTime += this.stepDur;
      this.step++;
      if (this.step >= STEPS) { this.step = 0; this.bar++; }
    }
  };

  private scheduleStep(step: number, time: number): void {
    const menu = this.scene === 'menu';
    const st = menu ? MENU_STYLE : this.style;
    const root = menu ? MENU_TONIC : this.tonic;
    const sd = this.stepDur;
    const type = menu ? MENU_STYLE.chord : (this.themeName === 'boss' ? BOSS_CHORD : st.chord);
    const chord: Chord = { root, type };

    if (step === 0) {
      if (this.active('drone') && st.drone !== 'none') this.drone(root, time, sd * STEPS, st.drone === 'rising');
      if (this.active('pad') && st.pad === 'sustain') this.pad(chord, time, sd * STEPS);
      if (this.active('pad') && st.pad === 'tremolo') this.tremolo(chord, time, sd * STEPS);
    }

    if (this.active('bass') && st.bass.includes(step)) this.bassNote(midi(root - 12), time, sd * 1.7, st.bassWave);
    if (this.active('keys') && st.pulse.includes(step)) this.pulse(midi(root + 12), time, sd * 0.9);
    if (this.active('keys') && st.stab.includes(step)) this.stab(chord, time, sd * 1.4);
    if (this.active('kick') && st.kick.includes(step)) this.kick(time);
    if (this.active('hat') && st.hat.includes(step)) this.hat(time, step === 15);
    if (this.active('clap') && st.snare.includes(step)) this.clap(time);
  }

  // ----------------------------------------------------------------- voices

  private drone(rootMidi: number, time: number, dur: number, rising: boolean): void {
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
    saw.type = 'sawtooth';
    const f0 = midi(rootMidi - 12);
    if (rising) {
      saw.frequency.setValueAtTime(f0, time);
      saw.frequency.linearRampToValueAtTime(f0 * Math.pow(2, 7 / 12), time + dur); // climb a 5th = panic
    } else { saw.frequency.value = f0; }
    saw.connect(lp);
    saw.start(time); saw.stop(time + dur + 0.05);
    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = midi(rootMidi - 24);
    sub.connect(g);
    sub.start(time); sub.stop(time + dur + 0.05);
  }

  private pad(chord: Chord, time: number, barDur: number): void {
    const ctx = this.ctx!;
    const attack = 1.4, rel = 1.1;
    for (const interval of chord.type) {
      const f = midi(chord.root + interval);
      for (const det of [-8, 8]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle'; osc.frequency.value = f; osc.detune.value = det;
        g.gain.setValueAtTime(0.0001, time);
        g.gain.linearRampToValueAtTime(0.12, time + attack);
        g.gain.setValueAtTime(0.12, time + Math.max(attack, barDur - rel));
        g.gain.exponentialRampToValueAtTime(0.0001, time + barDur);
        osc.connect(g).connect(this.padFilter!);
        osc.start(time); osc.stop(time + barDur + 0.05);
      }
    }
  }

  /** Tremolo strings: the chord with a fast amplitude pulse (suspense/horror). */
  private tremolo(chord: Chord, time: number, dur: number): void {
    const ctx = this.ctx!;
    const trem = ctx.createGain(); trem.gain.value = 0.5;
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 9;
    const depth = ctx.createGain(); depth.gain.value = 0.5;
    lfo.connect(depth).connect(trem.gain);
    lfo.start(time); lfo.stop(time + dur + 0.05);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(0.14, time + 0.3);
    env.gain.setValueAtTime(0.14, time + Math.max(0.3, dur - 0.5));
    env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    trem.connect(env).connect(this.padFilter!);
    for (const interval of chord.type) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = midi(chord.root + interval);
      osc.connect(trem);
      osc.start(time); osc.stop(time + dur + 0.05);
    }
  }

  private bassNote(freq: number, time: number, dur: number, wave: OscillatorType): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = wave; osc.frequency.value = freq;
    sub.type = 'sine'; sub.frequency.value = freq / 2;
    lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 0.8;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.6, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(lp); sub.connect(lp);
    lp.connect(g).connect(this.layers.bass.gain);
    osc.start(time); osc.stop(time + dur + 0.02);
    sub.start(time); sub.stop(time + dur + 0.02);
  }

  /** Relentless single-note pulse (the "chase" tension) — one pitch, no melody. */
  private pulse(freq: number, time: number, dur: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.22, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = freq;
    osc.connect(lp).connect(g).connect(this.layers.keys.gain);
    osc.start(time); osc.stop(time + dur + 0.02);
  }

  /** Short rhythmic power/tritone chord stab — drive, no melody. */
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
      osc.type = 'sawtooth'; osc.frequency.value = midi(chord.root + interval); osc.detune.value = 6;
      osc.connect(lp);
      osc.start(time); osc.stop(time + dur + 0.02);
    }
  }

  private kick(time: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(170, time);
    osc.frequency.exponentialRampToValueAtTime(44, time + 0.085);
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

  private clap(time: number): void {
    const ctx = this.ctx!;
    for (const off of [0, 0.012, 0.024]) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 1.1;
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
    const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return {
      playing: this.playing, muted: this.muted, scene: this.scene, speed: this.speed,
      level: this.level, style: this.scene === 'menu' ? MENU_STYLE.name : this.style.name,
      key: `${NOTE[(this.scene === 'menu' ? MENU_TONIC : this.tonic) % 12]}${Math.floor((this.scene === 'menu' ? MENU_TONIC : this.tonic) / 12) - 1}`,
      theme: this.themeName, intensity: +this.intensity.toFixed(3),
      bpm: Math.round(this.bpm), master: this.musicGain ? +this.musicGain.gain.value.toFixed(3) : null,
      cutoff: this.masterLP ? Math.round(this.masterLP.frequency.value) : null, layers: gains,
    };
  }
}

export const music = new MusicEngine();
