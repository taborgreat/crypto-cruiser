// Update 4: one knob, H (seconds of market that should feel like ~20 s of driving). Everything that
// decides what counts as "now" and what counts as "the stretch" derives from it. Gap and headway math
// are untouched.

export const HORIZON_CHIPS: Array<{ sec: number; label: string }> = [
  { sec: 60, label: '1m' }, { sec: 300, label: '5m' }, { sec: 900, label: '15m' }, { sec: 3600, label: '1h' },
  { sec: 14_400, label: '4h' }, { sec: 86_400, label: '1d' }, { sec: 604_800, label: '1w' },
];
export const H_MIN = 10;
export const H_MAX = 604_800 * 4;

export interface Derived {
  tauFast: number;     // impulse EMA (H / 30)
  tauSlow: number;     // trend EMA (H)
  tauAccel: number;    // trend-accel EMA (H / 6)
  ghostAges: [number, number, number];   // left 5H, center H, right H/6
  thr: { green: number; yellow: number; orange: number; critical: number };
  kScroll: number;     // render amplification multiplier: 60 / H
  tickLerp: number;    // seconds for animated positions to re-sync to truth
}

export function clampH(h: number): number {
  return Math.min(H_MAX, Math.max(H_MIN, Number.isFinite(h) ? h : 60));
}

export function deriveHorizon(hIn: number): Derived {
  const h = clampH(hIn);
  return {
    tauFast: h / 30,
    tauSlow: h,
    tauAccel: h / 6,
    ghostAges: [h * 5, h, Math.max(1, h / 6)],
    thr: { green: h, yellow: h / 3, orange: h / 12, critical: h / 60 },
    kScroll: 60 / h,
    tickLerp: Math.min(1, Math.max(0.1, h / 300)),
  };
}

/** Auto from room: as the gap grows the horizon widens; as it shrinks it tightens. */
export function autoRoomTarget(hBase: number, gap: number, gapAtEntry: number, exp = 1.5): number {
  if (!(gapAtEntry > 0) || !Number.isFinite(gap)) return hBase;
  const ratio = Math.min(20, Math.max(0.5, gap / gapAtEntry));
  return clampH(hBase * Math.pow(ratio, exp));
}

/** Auto from volatility: quiet tape = longer horizon, violent tape = shorter. */
export function autoVolMultiplier(atrRef: number, atrNow: number | null): number {
  if (atrNow === null || !(atrNow > 0) || !(atrRef > 0)) return 1;
  return Math.min(4, Math.max(0.25, atrRef / atrNow));
}

/** The chart timeframe that follows H: H / 60 rounded to the nearest chip. */
export const CHART_INTERVALS: Array<{ sec: number; label: string }> = [
  { sec: 1, label: '1s' }, { sec: 5, label: '5s' }, { sec: 15, label: '15s' }, { sec: 60, label: '1m' }, { sec: 300, label: '5m' },
  { sec: 900, label: '15m' }, { sec: 3600, label: '1h' }, { sec: 14_400, label: '4h' }, { sec: 86_400, label: '1d' },
];

export function chartIntervalFor(h: number): number {
  const want = h / 60;
  let best = CHART_INTERVALS[0].sec;
  let bestD = Infinity;
  for (const c of CHART_INTERVALS) {
    const d = Math.abs(Math.log(c.sec) - Math.log(Math.max(1e-9, want)));
    if (d < bestD) { bestD = d; best = c.sec; }
  }
  return best;
}
