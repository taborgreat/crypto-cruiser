// Section 3 of the spec: pure kinematics. No rendering, no I/O. Unit-tested.
//
// Update 1: the *market* part (price velocity EMAs, shared by the real car and every ghost) and the
// *car* part (gap, headway, v_you for one proposed or real position) are separate.
//
// Update 3: two timescales. v_fast (2 s) is the impulse, what the last few ticks did; v_slow (60 s) is
// the trend, where the tape is going; a_slow is the trend acceleration. The car ahead moves with the
// trend, your car moves with the impulse; v_ahead - v_you = L * v_fast = v_gap, so the gap math is
// unchanged. Headway uses v_fast (responsive alarm), projected headway uses a_slow. The road always
// flows at least v_road_min so the world is never still.
import type { Side } from './types.js';

export interface KinematicsParams {
  velocityEmaSec: number; // fast EMA window: the impulse (default 2 s)
  accelEmaSec: number;    // EMA window for accelerations (default 10 s)
  roadK: number;          // base freeway speed constant k
  trendEmaSec?: number;   // slow EMA window: the trend (default 60 s)
  roadMin?: number;       // minimum road flow, car lengths / s (default 0.10)
  slamThreshold?: number; // a_slow (leverage-scaled) below -this = slam (default 0.02 cl/s^2)
  lurchThreshold?: number;// |impulse| (leverage-scaled) above this = lurch / drag jolt (default 0.05 cl/s)
}

export const DEFAULT_KINEMATICS: Required<KinematicsParams> = {
  velocityEmaSec: 2, accelEmaSec: 10, roadK: 30, trendEmaSec: 60, roadMin: 0.1, slamThreshold: 0.02, lurchThreshold: 0.05,
};

/** Fallback ATR rate when no candles are available yet: 0.05% per minute. */
export const FALLBACK_ATR_RATE = 0.0005 / 60;
/** Trend deceleration (car lengths / s^2) at which the car ahead's brake lights are fully on. */
export const BRAKE_FULL_DECEL = 0.01;
/** Steady closing rate (car lengths / s) at which the dim "it is slower than me" glow is full. */
export const BRAKE_GLOW_CLOSE = 0.05;

export function favorable(side: Side, price: number, entry: number): number {
  return (side * (price - entry)) / entry;
}

export function gapPct(side: Side, price: number, liq: number): number {
  return (side * (price - liq)) / price;
}

/** Seconds until impact at the current closing rate. Infinity if not closing. */
export function headway(gap: number, vClose: number): number {
  if (gap <= 0) return 0;
  if (!(vClose > 0)) return Infinity;
  return gap / vClose;
}

/**
 * Projected headway: smallest positive t with gap = v_close*t + 0.5*a_close*t^2.
 * Goes red before plain headway when closing speed is increasing.
 */
export function projectedHeadway(gap: number, vClose: number, aClose: number): number {
  if (gap <= 0) return 0;
  const EPS = 1e-12;
  if (Math.abs(aClose) < EPS) return headway(gap, vClose);
  const disc = vClose * vClose + 2 * aClose * gap;
  if (disc < 0) return Infinity; // never reaches the car ahead
  const sq = Math.sqrt(disc);
  const t1 = (-vClose + sq) / aClose;
  const t2 = (-vClose - sq) / aClose;
  let best = Infinity;
  if (t1 > 0 && t1 < best) best = t1;
  if (t2 > 0 && t2 < best) best = t2;
  return best;
}

export type HeadwayColor = 'green' | 'yellow' | 'orange' | 'red';

export function headwayColor(
  h: number,
  thr: { green: number; yellow: number; orange: number } = { green: 60, yellow: 20, orange: 5 },
): HeadwayColor {
  if (h > thr.green) return 'green';
  if (h > thr.yellow) return 'yellow';
  if (h > thr.orange) return 'orange';
  return 'red';
}

export interface MarketState {
  v: number;        // fast velocity (impulse timescale), fraction / s (side-less)
  a: number;        // fast acceleration
  vTrend: number;   // slow velocity (trend)
  aTrend: number;   // trend acceleration
  vImpulse: number; // v - vTrend
}

/** Market-level state: EMAs of d/dt ln P at two time scales, and their derivatives. Side-less. */
export class MarketKinematics {
  private lastT: number | null = null;
  private lastLnP = 0;
  v = 0;
  a = 0;
  vTrend = 0;
  aTrend = 0;
  private lastV: number | null = null;
  private lastVTrend: number | null = null;

  constructor(public params: KinematicsParams = { ...DEFAULT_KINEMATICS }) {}

  reset(): void {
    this.lastT = null;
    this.lastLnP = 0;
    this.v = 0;
    this.a = 0;
    this.vTrend = 0;
    this.aTrend = 0;
    this.lastV = null;
    this.lastVTrend = null;
  }

  state(): MarketState {
    return { v: this.v, a: this.a, vTrend: this.vTrend, aTrend: this.aTrend, vImpulse: this.v - this.vTrend };
  }

  /** Feed a price sample. Feeding the same price again lets the EMAs decay (coasting). */
  tick(t: number, price: number): MarketState {
    const lnP = Math.log(price);
    if (this.lastT !== null) {
      const dt = (t - this.lastT) / 1000;
      if (dt > 0) {
        const vInst = (lnP - this.lastLnP) / dt;
        const aF = 1 - Math.exp(-dt / Math.max(0.001, this.params.velocityEmaSec));
        const aS = 1 - Math.exp(-dt / Math.max(0.001, this.params.trendEmaSec ?? DEFAULT_KINEMATICS.trendEmaSec));
        const aA = 1 - Math.exp(-dt / Math.max(0.001, this.params.accelEmaSec));
        this.v += aF * (vInst - this.v);
        this.vTrend += aS * (vInst - this.vTrend);
        if (this.lastV !== null) this.a += aA * ((this.v - this.lastV) / dt - this.a);
        if (this.lastVTrend !== null) this.aTrend += aA * ((this.vTrend - this.lastVTrend) / dt - this.aTrend);
        this.lastV = this.v;
        this.lastVTrend = this.vTrend;
      }
    }
    this.lastT = t;
    this.lastLnP = lnP;
    return this.state();
  }
}

export interface CarInput {
  side: Side;
  leverage: number;
  price: number;           // truth price
  entry: number;
  liq: number;
  vLnP: number;            // fast market velocity (fraction / s, side-less)
  aLnP: number;            // fast market acceleration
  vTrend?: number;         // slow market velocity (default: = vLnP, i.e. no impulse)
  aTrend?: number;         // trend acceleration (default 0)
  liqRate?: number;        // (d liq / dt) / price, fraction / s (default 0)
  roadK: number;
  roadMin?: number;
  slamThreshold?: number;
  lurchThreshold?: number;
  atrRate: number | null;  // ATR fraction of price per second (null = unknown)
}

export interface KinematicsOutput {
  fav: number;            // favorable move fraction, + = in profit
  gap_pct: number;        // raw distance to liquidation as fraction of price
  gap: number;            // leverage-scaled, car lengths
  v_price: number;        // s * d/dt ln P (fast), fraction / s (+ = favorable)
  v_gap: number;          // car lengths / s, + = opening (fast, price only)
  v_close: number;        // + = closing
  a_gap: number;          // car lengths / s^2 (fast)
  a_gap_trend: number;    // car lengths / s^2 (trend)
  v_gap_trend: number;    // the car ahead's part of v_gap
  v_gap_impulse: number;  // your part of v_gap
  v_gap_liq: number;      // the car ahead moving on its own (collateral / borrow fee)
  v_road: number;
  v_ahead: number;        // road + trend + liq
  v_you: number;          // road - impulse
  brake_ahead: number;    // 0..1 brake-light intensity of the car ahead
  slam: boolean;          // sharp reversal against you
  lurch: -1 | 0 | 1;      // +1 surge (tick against you), -1 drag (tick for you)
  headway_s: number;      // Infinity when not closing
  headway_proj_s: number; // includes trend acceleration
  entry_dist: number;     // leverage-scaled distance to entry (+ = entry behind you)
}

function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }

/** Per-car quantities for one position (real or ghost) given the shared market state. */
export function carKinematics(i: CarInput): KinematicsOutput {
  const { side: s, leverage: L, price, entry, liq } = i;
  const fav = favorable(s, price, entry);
  const gp = gapPct(s, price, liq);
  const gap = L * gp;
  const v_price = s * i.vLnP;
  const v_gap = L * v_price;
  const v_close = -v_gap;
  const a_gap = L * s * i.aLnP;
  const vTrend = i.vTrend ?? i.vLnP;
  const v_gap_trend = L * s * vTrend;
  const v_gap_impulse = v_gap - v_gap_trend;
  const v_gap_liq = -L * s * (i.liqRate ?? 0);
  const a_gap_trend = L * s * (i.aTrend ?? 0);
  const v_road = Math.max(i.roadMin ?? DEFAULT_KINEMATICS.roadMin, i.roadK * L * (i.atrRate ?? FALLBACK_ATR_RATE));
  const v_ahead = v_road + v_gap_trend + v_gap_liq;
  const v_you = v_road - v_gap_impulse;
  const slamThr = i.slamThreshold ?? DEFAULT_KINEMATICS.slamThreshold;
  const lurchThr = i.lurchThreshold ?? DEFAULT_KINEMATICS.lurchThreshold;
  // Brake lights: trend turning against you (deceleration of the car ahead), plus a dim glow while it is
  // steadily slower than you.
  const brake_ahead = Math.max(clamp01(-a_gap_trend / BRAKE_FULL_DECEL), 0.35 * clamp01(-(v_gap_trend + v_gap_liq) / BRAKE_GLOW_CLOSE));
  const slam = a_gap_trend < -slamThr || v_gap_impulse < -lurchThr * 2;
  const lurch: -1 | 0 | 1 = v_gap_impulse < -lurchThr ? 1 : v_gap_impulse > lurchThr ? -1 : 0;
  return {
    fav,
    gap_pct: gp,
    gap,
    v_price,
    v_gap,
    v_close,
    a_gap,
    a_gap_trend,
    v_gap_trend,
    v_gap_impulse,
    v_gap_liq,
    v_road,
    v_ahead,
    v_you,
    brake_ahead,
    slam,
    lurch,
    headway_s: headway(gap, v_close),
    headway_proj_s: projectedHeadway(gap, v_close, -a_gap_trend),
    entry_dist: L * fav,
  };
}

export interface KinematicsInput {
  t: number;
  price: number;
  side: Side;
  entry: number;
  liq: number;
  leverage: number;
  atrRate: number | null;
}

/** Convenience: one market state plus one car, in a single object (console tool, tests). */
export class Kinematics {
  market: MarketKinematics;
  constructor(public params: KinematicsParams = { ...DEFAULT_KINEMATICS }) {
    this.market = new MarketKinematics(params);
  }
  reset(): void { this.market.reset(); }
  tick(inp: KinematicsInput): KinematicsOutput {
    this.market.params = this.params;
    const m = this.market.tick(inp.t, inp.price);
    return carKinematics({
      side: inp.side, leverage: inp.leverage, price: inp.price, entry: inp.entry, liq: inp.liq,
      vLnP: m.v, aLnP: m.a, vTrend: m.vTrend, aTrend: m.aTrend, roadK: this.params.roadK, roadMin: this.params.roadMin,
      slamThreshold: this.params.slamThreshold, lurchThreshold: this.params.lurchThreshold, atrRate: inp.atrRate,
    });
  }
}

/** Car lengths / s of market impulse that reads as a full surge / drag (Update 15: never a pedal). */
export const IMPULSE_FULL = 0.05;

/**
 * Update 15: the market's push on my car as a signed −1..1 figure. `v_gap_impulse` is + when the gap opens (for
 * me), so a tick against me (gap closing) is a positive push: a surge. The pedals never carry this.
 */
export function marketImpulse(vGapImpulse: number, full: number = IMPULSE_FULL): number {
  if (!(full > 0) || !Number.isFinite(vGapImpulse)) return 0;
  return Math.max(-1, Math.min(1, -vGapImpulse / full)) || 0; // || 0: never −0
}
