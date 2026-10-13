import { describe, expect, it } from 'vitest';
import { lifetimeRealized } from '../shared/fees.js';
import { buildReadout, trendWord, volatilityWord } from '../shared/readout.js';
import type { CarFrame, Layers } from '../shared/types.js';

describe('lifetime realized', () => {
  it('is returned minus contributed', () => {
    expect(lifetimeRealized(150, 100)).toBe(50);
    expect(lifetimeRealized(80, 100)).toBe(-20);
  });
});

const layers: Layers = { atr: 0.0008, atr_rate: 0.0008 / 60, atr5m: 0.0015, funding: 0.000016, utilization: 0.12, oi: null, spread: null, divergence: null, hills: [], walls: [], liq_clusters: [] };
const base: CarFrame = {
  side: -1, entry: 100, liq: 100.7, leverage: 100, gap: 0.7, gap_pct: 0.007, v_gap: 0.021, v_close: -0.021, a_gap: 0,
  headway_s: null, headway_proj_s: null, v_road: 0.05, v_you: 0.029, v_ahead: 0.071, v_gap_trend: 0.021, v_gap_impulse: 0, v_gap_liq: 0,
  brake_ahead: 0, slam: false, lurch: 0, gap_anim: 0.7, throttle: 0, brake: 0, impulse: 0, pnl_pct: 0, pnl_usd: 0, fees_usd: 3.5, size_usd: 5000,
  collateral_usd: 46.5, free_collateral: 950, entry_dist: 0, stop_dist: null, stop_price: null, realized_usd: 0,
};
const ctx = { price: 100, horizonSec: 60, priceDp: 3, ageSec: 60 };

describe('one-line readout in plain units (Update 6)', () => {
  it('describes a position moving away from liquidation with no car words in the numbers', () => {
    const r = buildReadout(base, layers, ctx);
    expect(r).toContain('if opened 1m ago at 100.000');
    expect(r).toContain('P&L −$3.50 (−7.5%)');
    expect(r).toContain('to liq $0.70 (0.70%)');
    expect(r).toContain('time to liq not closing');
    expect(r).toContain('moving away from liq $1.26/min (1.3%/min)');
    expect(r).toContain('volatility 0.08%/min (1 m ATR)');
    expect(r).toContain('borrow −$0.08/h');
    expect(r).not.toContain('trend turned against you');
    expect(r).not.toMatch(/car length|headway|gap\b/);
  });
  it('says moving toward liq with a finite time when the price runs against the side', () => {
    const r = buildReadout({ ...base, side: 1, v_gap: -0.034, v_close: 0.034, headway_s: 29, brake_ahead: 0.8, v_gap_trend: -0.01 }, layers, ctx);
    expect(r).toContain('moving toward liq $2.04/min');
    expect(r).toContain('time to liq 29 s');
    expect(r).toContain('trend turned against you: −0.60% in last 1 m 0 s');
  });
  it('treats noise-level velocity as holding and shows long times in days', () => {
    const r = buildReadout({ ...base, side: 1, v_gap: -3e-6, v_close: 3e-6, headway_s: 130_000 }, layers, ctx);
    expect(r).toContain('· holding ·');
    expect(r).toContain('time to liq 1 d 12 h');
  });
  it('reports a crashed ghost as liquidated', () => {
    const r = buildReadout(base, layers, { ...ctx, crashed: true });
    expect(r).toContain('LIQUIDATED');
    expect(r).toContain('1m ago');
  });
  it('uses the horizon for rate units', () => {
    expect(buildReadout(base, layers, { ...ctx, horizonSec: 10 })).toContain('/s');
    expect(buildReadout(base, layers, { ...ctx, horizonSec: 7200 })).toContain('/h');
  });
  it('trend words come from the slow EMA and the brake lights', () => {
    expect(trendWord(base)).toBe('pulling away');
    expect(trendWord({ ...base, v_gap_trend: -0.01 })).toBe('braking');
    expect(trendWord({ ...base, v_gap_trend: 0, brake_ahead: 0.9 })).toBe('braking');
    expect(trendWord({ ...base, v_gap_trend: 1e-5 })).toBe('holding');
    expect(volatilityWord(null)).toBe('volatility warming up');
  });
});
