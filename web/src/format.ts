// Browser-side formatting: the shared units-policy formatter (Update 6) plus a few UI helpers.
export { money as fmtUsd, smoney as fmtSignedUsd, pct as fmtPct, price as fmtPrice, sol as fmtSol, timeSpan as fmtTime, shortSpan, rate as fmtRate, rateUnit, clockTime, dateTime } from '../../shared/format.js';
import { timeSpan } from '../../shared/format.js';

/** Time to liquidation: never ∞, say "not closing". */
export function fmtHeadway(s: number | null | undefined): string {
  return timeSpan(s, 'not closing');
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function fmtDuration(ms: number): string {
  return timeSpan(ms / 1000, '—');
}

export function shortAddr(a: string | null | undefined): string {
  if (!a) return '—';
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
