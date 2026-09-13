/**
 * All sound is synthesised at runtime — no files to load, nothing to 404, and
 * the whole kit costs a few hundred bytes.
 *
 * The important one is `erase`: a runner who hears it while standing on a
 * bridge needs to know before they can see it. That cue is gameplay, not polish.
 */

type Wave = OscillatorType;

export class Sfx {
  muted = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  /** Drawing fires dozens of events a second; the pen tick is rate-limited. */
  private lastTick = 0;

  constructor() {
    this.muted = localStorage.getItem("inkfall:muted") === "1";
  }

  /** Browsers only allow audio after a gesture — call this from a click. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
      this.noise = this.makeNoise();
    } catch {
      this.ctx = null; // No audio available; the game is still playable.
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem("inkfall:muted", this.muted ? "1" : "0");
    return this.muted;
  }

  // ---------------------------------------------------------------- the kit
  jump(): void {
    this.blip({ wave: "square", from: 300, to: 520, dur: 0.09, gain: 0.16 });
  }

  land(): void {
    this.blip({ wave: "sine", from: 170, to: 70, dur: 0.08, gain: 0.2 });
  }

  /** Spikes: short, nasty, unmistakably your fault. */
  spike(): void {
    this.blip({ wave: "sawtooth", from: 420, to: 110, dur: 0.16, gain: 0.2 });
    this.burst({ dur: 0.13, gain: 0.18, hz: 1800, type: "bandpass" });
  }

  /** The pit: a longer fall, so it gets a longer sound. */
  pit(): void {
    this.blip({ wave: "sine", from: 460, to: 55, dur: 0.42, gain: 0.18 });
  }

  escape(): void {
    this.blip({ wave: "triangle", from: 523, to: 523, dur: 0.1, gain: 0.16 });
    this.blip({ wave: "triangle", from: 659, to: 659, dur: 0.1, gain: 0.16, delay: 0.08 });
    this.blip({ wave: "triangle", from: 784, to: 784, dur: 0.2, gain: 0.18, delay: 0.16 });
  }

  /** A runner went down and the drawer got paid. */
  drop(): void {
    this.blip({ wave: "square", from: 880, to: 1320, dur: 0.07, gain: 0.1 });
  }

  penTick(): void {
    const now = performance.now();
    if (now - this.lastTick < 55) return;
    this.lastTick = now;
    this.burst({ dur: 0.02, gain: 0.05, hz: 2600, type: "highpass" });
  }

  spikeTick(): void {
    const now = performance.now();
    if (now - this.lastTick < 70) return;
    this.lastTick = now;
    this.blip({ wave: "square", from: 1400, to: 900, dur: 0.03, gain: 0.06 });
  }

  /** The sound a runner needs to hear one beat before the floor goes. */
  erase(): void {
    const now = performance.now();
    if (now - this.lastTick < 90) return;
    this.lastTick = now;
    this.burst({ dur: 0.11, gain: 0.14, hz: 700, type: "lowpass" });
  }

  roundStart(): void {
    this.blip({ wave: "triangle", from: 392, to: 392, dur: 0.12, gain: 0.14 });
    this.blip({ wave: "triangle", from: 523, to: 523, dur: 0.12, gain: 0.14, delay: 0.11 });
    this.blip({ wave: "triangle", from: 784, to: 784, dur: 0.22, gain: 0.16, delay: 0.22 });
  }

  countdown(): void {
    this.blip({ wave: "square", from: 660, to: 660, dur: 0.05, gain: 0.1 });
  }

  roundEnd(wipe: boolean): void {
    if (wipe) {
      this.blip({ wave: "sawtooth", from: 200, to: 90, dur: 0.4, gain: 0.16 });
    } else {
      this.blip({ wave: "triangle", from: 784, to: 784, dur: 0.1, gain: 0.14 });
      this.blip({ wave: "triangle", from: 523, to: 523, dur: 0.24, gain: 0.14, delay: 0.1 });
    }
  }

  outOfInk(): void {
    this.blip({ wave: "square", from: 180, to: 140, dur: 0.14, gain: 0.12 });
  }

  // ---------------------------------------------------------------- plumbing
  private blip(o: {
    wave: Wave; from: number; to: number; dur: number; gain: number; delay?: number;
  }): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;

    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.wave;
    osc.frequency.setValueAtTime(o.from, t);
    if (o.to !== o.from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t + o.dur);

    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(o.gain, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + o.dur + 0.02);
  }

  private burst(o: {
    dur: number; gain: number; hz: number; type: BiquadFilterType; delay?: number;
  }): void {
    const ctx = this.ready();
    if (!ctx || !this.master || !this.noise) return;

    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.frequency.value = o.hz;
    const gain = ctx.createGain();

    gain.gain.setValueAtTime(o.gain, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + o.dur + 0.02);
  }

  private ready(): AudioContext | null {
    if (this.muted || !this.ctx) return null;
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private makeNoise(): AudioBuffer | null {
    if (!this.ctx) return null;
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}
