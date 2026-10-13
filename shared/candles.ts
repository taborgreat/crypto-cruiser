// Candles, ATR, swing detection and the "hills" projection. Pure functions.
import type { Side, Tick } from './types.js';

export interface Candle {
  t: number;  // open time, ms (aligned to the interval)
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export const ONE_MINUTE = 60_000;

/** Candle intervals the server builds locally from the tick stream (seconds). */
export const CANDLE_INTERVALS = [1, 5, 15, 60, 300, 900, 3600, 14_400, 86_400] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/** Aggregates ticks into fixed-interval candles. Seed with history, then push live ticks. */
export class CandleBuilder {
  candles: Candle[] = [];
  constructor(public intervalMs: number = ONE_MINUTE, public maxCandles = 600) {}

  seed(history: Candle[]): void {
    const sorted = [...history].sort((a, b) => a.t - b.t);
    this.candles = sorted.slice(-this.maxCandles);
  }

  push(tick: Tick): Candle {
    return this.pushRaw(tick.t, tick.price);
  }

  pushRaw(t: number, price: number): Candle {
    const bucket = Math.floor(t / this.intervalMs) * this.intervalMs;
    const last = this.candles[this.candles.length - 1];
    if (last && last.t === bucket) {
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
      last.c = price;
      return last;
    }
    if (last && bucket < last.t) return last; // stale tick, ignore
    const c: Candle = { t: bucket, o: price, h: price, l: price, c: price };
    this.candles.push(c);
    if (this.candles.length > this.maxCandles) this.candles.splice(0, this.candles.length - this.maxCandles);
    return c;
  }
}

/** Index of the last candle with t <= tMs (so candles.slice(0, i + 1) is "as of tMs"); -1 if none. */
export function candleIndexAt(candles: Candle[], tMs: number): number {
  let lo = 0, hi = candles.length - 1;
  if (!candles.length || tMs < candles[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].t <= tMs) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Wilder ATR as a fraction of price. Returns null until there are enough candles. */
export function atrFraction(candles: Candle[], window = 14): number | null {
  if (candles.length < window + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    trs.push(tr / p.c);
  }
  let atr = 0;
  for (let i = 0; i < window; i++) atr += trs[i];
  atr /= window;
  for (let i = window; i < trs.length; i++) atr = (atr * (window - 1) + trs[i]) / window;
  return atr;
}

export interface Swing { t: number; price: number; kind: 'high' | 'low'; index: number }

/** Pivot highs/lows: a candle is a swing high if its high is the max of the k candles either side. */
export function detectSwings(candles: Candle[], lookback = 60, k = 3): Swing[] {
  const start = Math.max(k, candles.length - lookback);
  const out: Swing[] = [];
  for (let i = start; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      // Ties: the earliest candle of a tied run is the pivot (the next candle opens at the previous close,
      // so equal highs/lows after a peak are common in real data).
      if (j < i ? candles[j].h >= candles[i].h : candles[j].h > candles[i].h) isHigh = false;
      if (j < i ? candles[j].l <= candles[i].l : candles[j].l < candles[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ t: candles[i].t, price: candles[i].h, kind: 'high', index: i });
    if (isLow) out.push({ t: candles[i].t, price: candles[i].l, kind: 'low', index: i });
  }
  return out;
}

/**
 * Hills: project recent swing structure forward as a road elevation profile.
 * Uses the last swings' amplitude and period; phase continues from the last swing.
 * elev is in car lengths, + = uphill = price moving against the position.
 */
export function projectHills(
  swings: Swing[],
  price: number,
  side: Side,
  leverage: number,
  nowMs: number,
  horizonSec = 120,
  stepSec = 3,
): Array<{ dist: number; elev: number }> {
  if (swings.length < 2) return [];
  const last = swings[swings.length - 1];
  const prev = swings[swings.length - 2];
  const highs = swings.filter((s) => s.kind === 'high').slice(-3);
  const lows = swings.filter((s) => s.kind === 'low').slice(-3);
  if (!highs.length || !lows.length) return [];
  const avgHigh = highs.reduce((a, s) => a + s.price, 0) / highs.length;
  const avgLow = lows.reduce((a, s) => a + s.price, 0) / lows.length;
  const mid = (avgHigh + avgLow) / 2;
  const amp = Math.max(1e-9, (avgHigh - avgLow) / 2);
  const halfPeriod = Math.max(60_000, Math.abs(last.t - prev.t)); // ms between opposite swings
  const period = halfPeriod * 2;
  const phase0 = last.kind === 'high' ? Math.PI / 2 : -Math.PI / 2;
  const out: Array<{ dist: number; elev: number }> = [];
  for (let sec = 0; sec <= horizonSec; sec += stepSec) {
    const tAhead = nowMs + sec * 1000 - last.t;
    const proj = mid + amp * Math.sin(phase0 + (2 * Math.PI * tAhead) / period);
    const elev = (-side * (proj - price) * leverage) / price;
    out.push({ dist: sec, elev });
  }
  return out;
}
