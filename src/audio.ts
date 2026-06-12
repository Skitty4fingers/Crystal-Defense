// Synthesized sound effects via the Web Audio API — no audio assets needed.
// The context is created lazily on the first user gesture (browser autoplay
// rules). All play methods are safe no-ops before that or while muted.

const MASTER_VOL = 0.4;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = localStorage.getItem('cd-muted') === '1';
  private lastPlayed = new Map<string, number>();

  get isMuted(): boolean {
    return this.muted;
  }

  /** Returns the new muted state. */
  toggle(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('cd-muted', this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_VOL;
    return this.muted;
  }

  /** Call from any user gesture; idempotent. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_VOL;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  // ------------------------------------------------------------- primitives

  /** Rate-limit identical sounds so rapid towers don't become white noise. */
  private gate(key: string, minIntervalMs: number): boolean {
    if (!this.ctx || this.muted) return false;
    const now = performance.now();
    if (now - (this.lastPlayed.get(key) ?? -1e9) < minIntervalMs) return false;
    this.lastPlayed.set(key, now);
    return true;
  }

  /** Single oscillator with a pitch sweep and exponential fade-out. */
  private tone(
    freq0: number, freq1: number, dur: number,
    type: OscillatorType, vol: number, delay = 0,
  ): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freq1, 1), t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Filtered white-noise burst (impacts, explosions). */
  private noise(dur: number, vol: number, cutoff: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.ceil(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t0);
  }

  /** Short note sequence (jingles). */
  private arp(freqs: number[], step: number, noteDur: number, type: OscillatorType, vol: number): void {
    freqs.forEach((f, i) => this.tone(f, f, noteDur, type, vol, i * step));
  }

  // ------------------------------------------------------------- game sfx

  shoot(towerId: string): void {
    switch (towerId) {
      case 'rapid':
        if (this.gate('rapid', 45)) this.tone(620, 480, 0.04, 'square', 0.04);
        break;
      case 'sniper':
        if (this.gate('sniper', 60)) this.tone(1400, 180, 0.16, 'sawtooth', 0.1);
        break;
      case 'frost':
        if (this.gate('frost', 60)) this.tone(880, 1500, 0.09, 'sine', 0.06);
        break;
      case 'cannon':
        if (this.gate('cannon', 80)) {
          this.tone(140, 55, 0.18, 'sine', 0.22);
          this.noise(0.12, 0.12, 500);
        }
        break;
      case 'lightning':
        if (this.gate('lightning', 70)) {
          this.tone(1600, 90, 0.12, 'sawtooth', 0.09);
          this.noise(0.07, 0.05, 4000);
        }
        break;
      default:
        if (this.gate('basic', 50)) this.tone(450, 230, 0.07, 'square', 0.07);
    }
  }

  explosion(): void {
    if (!this.gate('explosion', 70)) return;
    this.noise(0.25, 0.16, 750);
    this.tone(190, 45, 0.22, 'sine', 0.14);
  }

  enemyDie(): void {
    if (!this.gate('die', 50)) return;
    this.tone(320, 70, 0.12, 'triangle', 0.08);
  }

  crystalHit(): void {
    if (!this.gate('crystal', 200)) return;
    // Dissonant alarm: two detuned saws + thump.
    this.tone(220, 110, 0.4, 'sawtooth', 0.16);
    this.tone(233, 117, 0.4, 'sawtooth', 0.12);
    this.noise(0.2, 0.14, 400);
  }

  place(): void {
    if (!this.gate('place', 60)) return;
    this.tone(190, 120, 0.1, 'sine', 0.16);
    this.noise(0.05, 0.07, 1200);
  }

  upgrade(): void {
    if (!this.gate('upgrade', 80)) return;
    this.arp([420, 560, 750], 0.07, 0.09, 'triangle', 0.1);
  }

  sell(): void {
    if (!this.gate('sell', 80)) return;
    this.arp([500, 330], 0.08, 0.1, 'triangle', 0.1);
  }

  waveStart(): void {
    this.arp([330, 440], 0.12, 0.18, 'square', 0.07);
  }

  bossWarn(): void {
    // Ominous beating drone.
    this.tone(110, 100, 0.8, 'sawtooth', 0.14);
    this.tone(104, 96, 0.8, 'sawtooth', 0.12);
  }

  waveClear(): void {
    this.arp([523, 659, 784], 0.09, 0.14, 'triangle', 0.1);
  }

  levelUp(): void {
    this.arp([392, 523, 659, 1046], 0.11, 0.2, 'triangle', 0.12);
  }

  meteorImpact(): void {
    this.noise(0.45, 0.28, 450);
    this.tone(95, 32, 0.4, 'sine', 0.24);
  }

  heal(): void {
    this.tone(880, 1320, 0.25, 'sine', 0.1);
    this.tone(1100, 1650, 0.25, 'sine', 0.06, 0.08);
  }

  frenzy(): void {
    this.tone(200, 950, 0.3, 'sawtooth', 0.1);
  }

  defeat(): void {
    this.arp([392, 311, 261, 196], 0.22, 0.4, 'triangle', 0.14);
  }
}

export const sfx = new AudioEngine();
