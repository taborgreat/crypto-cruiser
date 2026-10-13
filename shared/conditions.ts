// Update 11, Part A: the CONDITIONS panel. Seven horizons, the same four measures on each, one rule stack,
// one sentence in caps plus a reason line in plain units. A conditions read, not a forecast. Pure functions.
import type { Candle } from './candles.js';
import { money, pct, price as fmtPrice } from './format.js';
import type { Side } from './types.js';

export type HorizonKey = '1m' | '15m' | '1h' | '4h' | '1d' | '1w' | '1y';
export type HorizonGroup = 'local' | 'mid' | 'long';
export interface HorizonSpec { key: HorizonKey; windowSec: number; resSec: number; group: HorizonGroup }

/** Each horizon is read from candles of its natural resolution (1 m from 1 s bars … 1 y from 1 d bars). */
export const HORIZONS: HorizonSpec[] = [
  { key: '1m', windowSec: 60, resSec: 1, group: 'local' },
  { key: '15m', windowSec: 900, resSec: 15, group: 'local' },
  { key: '1h', windowSec: 3600, resSec: 60, group: 'local' },
  { key: '4h', windowSec: 14_400, resSec: 300, group: 'mid' },
  { key: '1d', windowSec: 86_400, resSec: 3600, group: 'mid' },
  { key: '1w', windowSec: 604_800, resSec: 21_600, group: 'long' },
  { key: '1y', windowSec: 31_536_000, resSec: 86_400, group: 'long' },
];

export type RangeLabel = 'at lows' | 'low' | 'mid' | 'high' | 'at highs';
export type TrendLabel = 'falling' | 'flat' | 'rising';
export type ActivityLabel = 'dead' | 'quiet' | 'normal' | 'active' | 'hot';

export interface ConditionRow {
  h: HorizonKey;
  window_sec: number;
  res_sec: number;
  ok: boolean;               // enough bars to read
  bars: number;              // bars in the window
  low: number;
  high: number;
  range_pos: number;         // 0 = at the low, 1 = at the high
  range: RangeLabel;
  ema: number;
  trend: number;             // EMA slope over the window, in ATR per window
  trend_label: TrendLabel;
  atr: number;               // ATR of this horizon's bars, in price units
  atr_avg: number;           // ATR averaged over 10× the window
  activity: number;          // atr / atr_avg; 1 = normal
  activity_label: ActivityLabel;
  activity_ok: boolean;      // enough history for the 10× average
  stretch: number;           // (P − EMA) / ATR
  accel: number;             // in the direction of the stretch: > 0 still going, < 0 fading
  stretch_label: string;
}

export interface ConditionsState {
  t: number;
  sentence: string;
  side: Side | 0;            // the sentence's side; 0 = WAIT / NO EDGE / MIXED
  reason: string;
  rule: number;
  rows: ConditionRow[];
}

export function emaSeries(values: number[], n: number): number[] {
  const out = new Array<number>(values.length);
  if (!values.length) return out;
  const k = 2 / (n + 1);
  let e = values[0];
  out[0] = e;
  for (let i = 1; i < values.length; i++) { e += k * (values[i] - e); out[i] = e; }
  return out;
}

/** True ranges in price units; index i is the range of candle i (needs candle i−1). */
export function trueRanges(c: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const k = c[i], p = c[i - 1];
    out.push(Math.max(k.h - k.l, Math.abs(k.h - p.c), Math.abs(k.l - p.c)));
  }
  return out;
}

function mean(a: number[]): number { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

export function rangeLabel(x: number): RangeLabel {
  return x < 0.2 ? 'at lows' : x < 0.4 ? 'low' : x <= 0.6 ? 'mid' : x <= 0.8 ? 'high' : 'at highs';
}
export function trendLabel(t: number): TrendLabel { return t < -0.5 ? 'falling' : t > 0.5 ? 'rising' : 'flat'; }
export function activityLabel(a: number): ActivityLabel {
  return a < 0.3 ? 'dead' : a < 0.6 ? 'quiet' : a <= 1.2 ? 'normal' : a <= 1.6 ? 'active' : 'hot';
}
export function stretchLabel(stretch: number, accel: number): string {
  if (Math.abs(stretch) <= 2) return 'not stretched';
  return `stretched ${stretch > 0 ? 'up' : 'down'}, ${accel < 0 ? 'fading' : 'still going'}`;
}

const notReady = (spec: HorizonSpec, bars: number, price: number): ConditionRow => ({
  h: spec.key, window_sec: spec.windowSec, res_sec: spec.resSec, ok: false, bars,
  low: price, high: price, range_pos: 0.5, range: 'mid', ema: price, trend: 0, trend_label: 'flat',
  atr: 0, atr_avg: 0, activity: 1, activity_label: 'normal', activity_ok: false, stretch: 0, accel: 0, stretch_label: 'not stretched',
});

/**
 * The four measures (plus accel) for one horizon.
 *  range_pos = (P − low) / (high − low) over the window
 *  trend     = (EMA_now − EMA_window_start) / ATR          [ATR per window; |trend| < 0.5 = flat]
 *  activity  = ATR(window) / ATR(average over 10× window)   [1 = normal]
 *  stretch   = (P − EMA_now) / ATR                           [|stretch| > 2 = extended]
 *  accel     = slope over the last 20% of the window minus the slope over the prior 80%, signed in the
 *              direction of the stretch: < 0 the move is fading, > 0 it is still going
 * `candles` are ascending and already cut at the moment being read.
 */
export function measureHorizon(spec: HorizonSpec, candles: Candle[], price: number): ConditionRow {
  const N = Math.max(4, Math.round(spec.windowSec / spec.resSec));
  const series = candles.slice(-(11 * N));
  const bars = series.length;
  const needed = Math.max(6, Math.ceil(N / 3));
  if (bars < needed || !(price > 0)) return notReady(spec, bars, price);
  const wN = Math.min(N, bars);
  const window = series.slice(-wN);
  let low = Infinity, high = -Infinity;
  for (const c of window) { if (c.l < low) low = c.l; if (c.h > high) high = c.h; }
  low = Math.min(low, price); high = Math.max(high, price);
  const rangePos = high > low ? (price - low) / (high - low) : 0.5;

  const closes = series.map((c) => c.c);
  const nEma = Math.max(3, Math.round(N / 4));
  const ema = emaSeries(closes, nEma);
  const iNow = bars - 1;
  const iStart = bars - wN;
  const iK = Math.max(iStart, iNow - Math.max(1, Math.round(0.2 * wN)));
  const emaNow = ema[iNow], emaStart = ema[iStart], emaK = ema[iK];

  const trs = trueRanges(series);
  const trWindow = trs.slice(-Math.max(1, wN - 1));
  const atr = Math.max(mean(trWindow), price * 1e-6);
  const longSpan = trs.slice(-Math.max(1, 10 * wN));
  const activityOk = longSpan.length >= 2 * wN;
  const atrAvg = activityOk ? Math.max(mean(longSpan), price * 1e-6) : atr;
  const activity = activityOk ? atr / atrAvg : 1;

  const trend = (emaNow - emaStart) / atr;
  // accel on a fast smoother (about one bar of lag): the slow EMA keeps rising for bars after a move flattens
  const fast = emaSeries(closes, Math.max(2, Math.round(N / 20)));
  const fracLast = Math.max(0.05, (iNow - iK) / Math.max(1, wN));
  const fracPrior = Math.max(0.05, (iK - iStart) / Math.max(1, wN));
  const rateLast = (fast[iNow] - fast[iK]) / atr / fracLast;
  const ratePrior = (fast[iK] - fast[iStart]) / atr / fracPrior;
  void emaK;
  const stretch = (price - emaNow) / atr;
  const dir = stretch !== 0 ? Math.sign(stretch) : (trend !== 0 ? Math.sign(trend) : 1);
  const accel = dir * (rateLast - ratePrior);

  return {
    h: spec.key, window_sec: spec.windowSec, res_sec: spec.resSec, ok: true, bars: wN,
    low, high, range_pos: rangePos, range: rangeLabel(rangePos),
    ema: emaNow, trend, trend_label: trendLabel(trend),
    atr, atr_avg: atrAvg, activity, activity_label: activityLabel(activity), activity_ok: activityOk,
    stretch, accel, stretch_label: stretchLabel(stretch, accel),
  };
}

/** The class string of a row: the sentence is re-evaluated only when one of these changes. */
export function rowClass(r: ConditionRow): string {
  return `${r.ok ? 1 : 0}|${r.range}|${r.trend_label}|${r.activity_label}|${r.stretch_label}`;
}

const isHigh = (r: ConditionRow) => r.ok && (r.range === 'high' || r.range === 'at highs');
const isLow = (r: ConditionRow) => r.ok && (r.range === 'low' || r.range === 'at lows');
const atHighs = (r: ConditionRow) => r.ok && r.range === 'at highs';
const atLows = (r: ConditionRow) => r.ok && r.range === 'at lows';
const quiet = (r: ConditionRow) => r.ok && (r.activity_label === 'dead' || r.activity_label === 'quiet');
const activeEnough = (r: ConditionRow) => r.ok && r.activity_label !== 'dead' && r.activity_label !== 'quiet';

function describeRange(r: ConditionRow): string { return `${r.h}: ${r.range} (${r.range_pos.toFixed(2)})`; }
function describeStretch(r: ConditionRow): string {
  const s = r.stretch;
  return `${r.h}: ${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(1)} ATR ${s >= 0 ? 'above' : 'below'} mean${Math.abs(s) > 2 ? (r.accel < 0 ? ', fading' : ', still going') : ''}`;
}
function describeTrend(r: ConditionRow): string { return `${r.h}: ${r.trend_label} (${r.trend >= 0 ? '+' : '−'}${Math.abs(r.trend).toFixed(1)} ATR/window)`; }
function describeActivity(r: ConditionRow): string { return `activity ${r.activity.toFixed(1)}× normal (${r.h})`; }

/** The rule stack: evaluated top to bottom, first match wins. */
export function evaluate(rows: ConditionRow[], leverage: number, driverSide: Side, price: number, priceDp = 3): { sentence: string; side: Side | 0; reason: string; rule: number } {
  const by = (k: HorizonKey) => rows.find((r) => r.h === k) ?? notReady(HORIZONS.find((h) => h.key === k)!, 0, price);
  const r1 = by('1m'), r15 = by('15m'), r1h = by('1h'), r4h = by('4h'), r1d = by('1d'), r1w = by('1w');
  const N = `${Math.round(leverage)}×`;

  if (!r1.ok && !r15.ok) {
    return { sentence: 'WARMING UP · READING THE TAPE', side: 0, reason: `${r1.bars} bars of 1 s · ${r15.bars} bars of 15 s so far`, rule: 0 };
  }

  // 1. activity gate
  if (quiet(r1) && quiet(r15)) {
    const range = r1.high - r1.low;
    return {
      sentence: `WAIT · MARKET TOO QUIET FOR ${N} TRADES`, side: 0, rule: 1,
      reason: `1m range ${money(range)} (${pct((range / price) * 100)}) · 0.12% round-trip fees eat moves this size · ${describeActivity(r15)}`,
    };
  }

  // 2. stretched top, fading (short setup)
  if ((atHighs(r15) || atHighs(r1h)) && r1h.ok && r1h.stretch > 2 && r1h.accel < 0 && activeEnough(r1h)) {
    const localRow = atHighs(r15) ? r15 : r1h;
    const longRow = isHigh(r1d) ? r1d : isHigh(r1w) ? r1w : null;
    const reason = `${describeRange(localRow)} · ${describeStretch(r1h)} · ${longRow ? describeRange(longRow) : r1d.ok ? describeTrend(r1d) : '1d: no data'} · ${describeActivity(r1h)}`;
    if (longRow) return { sentence: 'SHORT · LOCAL AND LONG-TERM TOP · MOVE FADING', side: -1, reason, rule: 2 };
    if (r1d.ok && r1d.trend_label === 'falling') return { sentence: 'SHORT · LOCAL TOP IN A LARGER DOWNTREND', side: -1, reason, rule: 2 };
    return { sentence: 'SHORT · LOCAL TOP · LARGER TREND STILL UP · TAKE PROFIT QUICK', side: -1, reason, rule: 2 };
  }

  // 3. stretched bottom, fading (long setup)
  if ((atLows(r15) || atLows(r1h)) && r1h.ok && r1h.stretch < -2 && r1h.accel < 0 && activeEnough(r1h)) {
    const localRow = atLows(r15) ? r15 : r1h;
    const longRow = isLow(r1d) ? r1d : isLow(r1w) ? r1w : null;
    const reason = `${describeRange(localRow)} · ${describeStretch(r1h)} · ${longRow ? describeRange(longRow) : r1d.ok ? describeTrend(r1d) : '1d: no data'} · ${describeActivity(r1h)}`;
    if (longRow) return { sentence: 'LONG · LOCAL AND LONG-TERM BOTTOM · MOVE FADING', side: 1, reason, rule: 3 };
    if (r1d.ok && r1d.trend_label === 'rising') return { sentence: 'LONG · LOCAL BOTTOM IN A LARGER UPTREND', side: 1, reason, rule: 3 };
    return { sentence: 'LONG · LOCAL BOTTOM · LARGER TREND STILL DOWN · TAKE PROFIT QUICK', side: 1, reason, rule: 3 };
  }

  // 4. strong momentum, not fading
  if (r1h.ok && Math.abs(r1h.stretch) > 2 && r1h.accel > 0) {
    const up = r1h.stretch > 0;
    const moveSide: Side = up ? 1 : -1;
    const reason = `${describeStretch(r1h)} · ${describeTrend(r1h)} · ${describeActivity(r1h)}`;
    if (driverSide === moveSide) return { sentence: `${up ? 'LONG' : 'SHORT'} WITH THE MOVE · TIGHT · IT CAN TURN FAST`, side: moveSide, reason, rule: 4 };
    return { sentence: `WAIT · ${up ? 'UP' : 'DOWN'} MOVE STILL ACCELERATING · DON'T FADE IT`, side: 0, reason, rule: 4 };
  }

  // 5. trend, not stretched
  if (r1h.ok && r4h.ok && r1h.trend_label !== 'flat' && r1h.trend_label === r4h.trend_label && Math.abs(r1h.stretch) < 1) {
    const rising = r1h.trend_label === 'rising';
    return {
      sentence: `${rising ? 'LONG' : 'SHORT'} WITH THE TREND · PULLBACK ENTRY · ${rising ? 'RISING' : 'FALLING'} ON 1H AND 4H`, side: rising ? 1 : -1, rule: 5,
      reason: `${describeTrend(r1h)} · ${describeTrend(r4h)} · ${describeStretch(r1h)} · ${describeActivity(r1h)}`,
    };
  }

  // 7. conflict: local and long-term disagree strongly (checked before the catch-all)
  if (atHighs(r15) && atLows(r1w)) {
    return { sentence: 'MIXED · LOCAL TOP, LONG-TERM BOTTOM · SHORT ONLY WITH A SHORT HORIZON', side: 0, rule: 7, reason: `${describeRange(r15)} · ${describeRange(r1w)} · ${describeStretch(r1h)}` };
  }
  if (atLows(r15) && atHighs(r1w)) {
    return { sentence: 'MIXED · LOCAL BOTTOM, LONG-TERM TOP · LONG ONLY WITH A SHORT HORIZON', side: 0, rule: 7, reason: `${describeRange(r15)} · ${describeRange(r1w)} · ${describeStretch(r1h)}` };
  }

  // 6. mid-range, normal activity
  const spots = [r15, r1h, r4h, r1d].filter((r) => r.ok).map(describeRange).join(' · ');
  return {
    sentence: 'NO EDGE · MID-RANGE ON EVERY HORIZON · WAIT FOR A SPIKE', side: 0, rule: 6,
    reason: `${spots || 'no horizon readable yet'} · ${r1h.ok ? describeActivity(r1h) : describeActivity(r15)} · price ${fmtPrice(price, priceDp)}`,
  };
}
