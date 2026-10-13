// Soundscape (Update 3/4): engine note pitched to leverage, rising with your speed (lower drone at long
// horizons), tire hiss rising with road flow (volatility), headway alarm as a rising tone (pulsing when
// red), an audible tick per trade event (the 1-second guarantee), plus one-shot cues.
// Starts on the first user gesture (browsers require it).
import type { HeadwayColor } from '../../shared/kinematics.js';

export interface SoundInput {
  active: boolean;        // a car or ghost is on the road
  leverage: number;
  vYou: number;           // car lengths / s
  vRoad: number;
  headway: number;        // seconds (Infinity when not closing)
  color: HeadwayColor;
  impulse: number;        // −1..1 (Update 15): surge bends the note up, drag down
  driving: boolean;       // Update 16: a position is on the road (the tyre hiss only then, at a tenth)
  chase: boolean;         // Update 16: CHASE: the monster's roar rises as it gains
  horizonSec: number;
  thresholds: { green: number; orange: number; critical: number };
}

export class Sound {
  enabled = true;
  volume = 0.6;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engine!: OscillatorNode;
  private engineSub!: OscillatorNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private tireGain!: GainNode;
  private roar!: OscillatorNode;
  private roarGain!: GainNode;
  private tireFilter!: BiquadFilterNode;
  private alarm!: OscillatorNode;
  private alarmGain!: GainNode;
  private built = false;
  private lastTradeTick = 0;

  constructor() {
    const unlock = () => {
      if (!this.ctx) {
        try { this.ctx = new AudioContext(); } catch { this.ctx = null; }
      }
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
      if (this.ctx && !this.built) this.build();
    };
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('pointerdown', unlock, { passive: true });
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    this.engine = ctx.createOscillator();
    this.engine.type = 'sawtooth';
    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'triangle';
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engine.connect(this.engineFilter);
    this.engineSub.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.engine.start();
    this.engineSub.start();

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    this.tireFilter = ctx.createBiquadFilter();
    this.tireFilter.type = 'bandpass';
    this.tireFilter.frequency.value = 1800;
    this.tireFilter.Q.value = 0.6;
    this.tireGain = ctx.createGain();
    this.tireGain.gain.value = 0;
    noise.connect(this.tireFilter).connect(this.tireGain).connect(this.master);
    noise.start();

    // CHASE (Update 16): the monster's roar, a low saw that rises as it gains
    this.roar = ctx.createOscillator();
    this.roar.type = 'sawtooth';
    this.roar.frequency.value = 44;
    const roarFilter = ctx.createBiquadFilter();
    roarFilter.type = 'lowpass';
    roarFilter.frequency.value = 160;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    this.roar.connect(roarFilter).connect(this.roarGain).connect(this.master);
    this.roar.start();

    this.alarm = ctx.createOscillator();
    this.alarm.type = 'sine';
    this.alarm.frequency.value = 300;
    this.alarmGain = ctx.createGain();
    this.alarmGain.gain.value = 0;
    this.alarm.connect(this.alarmGain).connect(this.master);
    this.alarm.start();
    this.built = true;
  }

  /** Called ~20 times a second with the focus car's state. */
  update(i: SoundInput): void {
    if (!this.ctx || !this.built) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const ramp = (p: AudioParam, v: number, tc = 0.08) => p.setTargetAtTime(v, now, tc);
    const on = this.enabled && this.volume > 0 && i.active;
    ramp(this.master.gain, on ? this.volume : 0, 0.15);
    if (!on) return;

    // long horizons = lower drone
    const hMul = Math.pow(Math.min(1.6, Math.max(0.45, 60 / Math.max(10, i.horizonSec))), 0.5);
    const vYouVis = Math.max(0, i.vYou) * 400 * hMul;
    const base = (42 + Math.min(250, Math.max(0, i.leverage)) * 0.32) * hMul;
    const surge = Math.max(0, i.impulse), drag = Math.max(0, -i.impulse);
    const freq = base + vYouVis + surge * 25 - drag * 12;
    ramp(this.engine.frequency, freq, 0.12);
    ramp(this.engineSub.frequency, freq / 2, 0.12);
    ramp(this.engineFilter.frequency, 300 + surge * 900 + vYouVis * 4, 0.1);
    ramp(this.engineGain.gain, 0.05 + surge * 0.04 - drag * 0.02, 0.1);

    // Update 16: the tyre hiss only while driving a position, at a tenth of what it was
    ramp(this.tireGain.gain, i.driving ? Math.min(0.012, (i.vRoad * 1.2 + Math.max(0, i.vYou) * 0.3) * 0.1) : 0, 0.2);
    const gaining = i.chase && i.active && Number.isFinite(i.headway) ? Math.max(0, Math.min(1, (120 - i.headway) / 120)) : 0;
    ramp(this.roarGain.gain, gaining * 0.2, 0.25);
    ramp(this.roar.frequency, 40 + gaining * 36, 0.3);
    ramp(this.tireFilter.frequency, 1200 + Math.max(0, i.vYou) * 12_000, 0.2);

    // alarm: rising tone from the green threshold down to the critical one, pulsing when red
    const h = i.headway;
    const g0 = i.thresholds.green, crit = i.thresholds.critical;
    if (Number.isFinite(h) && h < g0) {
      const x = 1 - Math.min(1, Math.max(0, (h - crit) / Math.max(1e-6, g0 - crit)));
      ramp(this.alarm.frequency, 320 + x * x * 900, 0.05);
      let g = 0.03 + x * 0.12;
      if (i.color === 'red') {
        const rate = h < crit ? 10 : 6;
        const phase = Math.floor(now * rate) % 2;
        g = phase ? g * 1.3 : g * 0.15;
        this.alarmGain.gain.setValueAtTime(g, now);
      } else ramp(this.alarmGain.gain, g, 0.05);
    } else ramp(this.alarmGain.gain, 0, 0.1);
  }

  private blip(freq: number, dur: number, gain: number, type: OscillatorType = 'square'): void {
    if (!this.ctx || !this.enabled) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = gain * this.volume;
    o.connect(g).connect(this.ctx.destination);
    const t = this.ctx.currentTime;
    o.start(t);
    g.gain.setValueAtTime(gain * this.volume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.stop(t + dur + 0.01);
  }

  /** Pedal press. */
  click(): void { this.blip(1200, 0.03, 0.08); }
  /** A trade event landed (the 1-second guarantee): a tiny tick, at most 12 per second. */
  trade(against: boolean): void {
    const now = performance.now();
    if (now - this.lastTradeTick < 80) return;
    this.lastTradeTick = now;
    this.blip(against ? 520 : 780, 0.015, 0.025, 'triangle');
  }
  /** Liquidation. */
  thud(): void { this.blip(70, 0.6, 0.6, 'sine'); this.blip(45, 0.9, 0.5, 'triangle'); }
  /** The car ahead slammed its brakes: a short screech. */
  slam(): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 0.35);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2600;
    f.Q.value = 4;
    const g = ctx.createGain();
    g.gain.value = 0.35 * this.volume;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
    this.blip(900, 0.25, 0.12, 'sawtooth');
  }
}
