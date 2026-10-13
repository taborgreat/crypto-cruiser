import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles.js';
import { HORIZONS, evaluate, measureHorizon, type ConditionRow } from '../shared/conditions.js';

/** Synthetic candles from a price path: one bar per `resSec`, with a wick of `noise` around the path. */
function synth(resSec: number, bars: number, path: (i: number) => number, noise: number): Candle[] {
  const out: Candle[] = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < bars; i++) {
    const c = path(i), o = path(Math.max(0, i - 1));
    const w = noise * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.7)));
    out.push({ t: t0 + i * resSec * 1000, o, c, h: Math.max(o, c) + w, l: Math.min(o, c) - w });
  }
  return out;
}

const spec = (key: string) => HORIZONS.find((h) => h.key === key)!;

describe('measureHorizon (Update 11)', () => {
  it('reads a run-up that is flattening as: at highs, rising, stretched up and fading', () => {
    // 1 h of 1 m bars: 10 × window of flat tape, then a sharp run-up over 54 bars that flattens in the last 6
    const bars = 660;
    const path = (i: number) => (i < 600 ? 100 : i < 654 ? 100 + (i - 600) * 0.04 : 102.16 + (i - 654) * 0.001);
    const candles = synth(60, bars, path, 0.003);
    const r = measureHorizon(spec('1h'), candles, candles[bars - 1].c);
    expect(r.ok).toBe(true);
    expect(r.range).toBe('at highs');
    expect(r.trend_label).toBe('rising');
    expect(r.stretch).toBeGreaterThan(2);
    expect(r.accel).toBeLessThan(0);
    expect(r.stretch_label).toBe('stretched up, fading');
    expect(r.activity).toBeGreaterThan(1.6); // the move is far more active than the flat tape before it
  });
  it('reads a dead tape as quiet', () => {
    const candles = synth(1, 660, (i) => 100 + (i < 600 ? Math.sin(i / 5) * 0.05 : 0), 0.001);
    const r = measureHorizon(spec('1m'), candles, 100);
    expect(r.ok).toBe(true);
    expect(r.activity).toBeLessThan(0.3);
    expect(r.activity_label).toBe('dead');
    expect(r.stretch_label).toBe('not stretched');
  });
  it('is not ready with too few bars', () => {
    const r = measureHorizon(spec('1y'), synth(86_400, 10, () => 100, 1), 100);
    expect(r.ok).toBe(false);
  });
});

function row(h: ConditionRow['h'], over: Partial<ConditionRow>): ConditionRow {
  const s = spec(h);
  return {
    h, window_sec: s.windowSec, res_sec: s.resSec, ok: true, bars: 60, low: 99, high: 101, range_pos: 0.5, range: 'mid',
    ema: 100, trend: 0, trend_label: 'flat', atr: 0.1, atr_avg: 0.1, activity: 1, activity_label: 'normal', activity_ok: true,
    stretch: 0, accel: 0, stretch_label: 'not stretched', ...over,
  };
}
const base = (): ConditionRow[] => HORIZONS.map((h) => row(h.key, {}));

describe('the rule stack', () => {
  it('rule 1: a dead local tape says WAIT', () => {
    const rows = base();
    rows[0] = row('1m', { activity: 0.2, activity_label: 'dead', high: 100.02, low: 99.98 });
    rows[1] = row('15m', { activity: 0.5, activity_label: 'quiet' });
    const e = evaluate(rows, 100, -1, 100);
    expect(e.rule).toBe(1);
    expect(e.sentence).toBe('WAIT · MARKET TOO QUIET FOR 100× TRADES');
    expect(e.side).toBe(0);
    expect(e.reason).toContain('1m range $0.04');
  });
  it('rule 2: a local top, stretched and fading, in a larger downtrend says SHORT', () => {
    const rows = base();
    rows[1] = row('15m', { range_pos: 0.93, range: 'at highs' });
    rows[2] = row('1h', { range_pos: 0.85, range: 'at highs', stretch: 2.4, accel: -0.3, stretch_label: 'stretched up, fading', activity: 1.7, activity_label: 'hot', trend: 1.5, trend_label: 'rising' });
    rows[4] = row('1d', { range_pos: 0.45, trend: -1.2, trend_label: 'falling' });
    const e = evaluate(rows, 100, -1, 100);
    expect(e.rule).toBe(2);
    expect(e.sentence).toBe('SHORT · LOCAL TOP IN A LARGER DOWNTREND');
    expect(e.side).toBe(-1);
    expect(e.reason).toContain('15m: at highs (0.93)');
    expect(e.reason).toContain('1h: +2.4 ATR above mean, fading');
    expect(e.reason).toContain('activity 1.7× normal');
    rows[4] = row('1d', { range_pos: 0.81, range: 'at highs' });
    expect(evaluate(rows, 100, -1, 100).sentence).toBe('SHORT · LOCAL AND LONG-TERM TOP · MOVE FADING');
  });
  it('rule 3 mirrors rule 2 for a fading bottom', () => {
    const rows = base();
    rows[1] = row('15m', { range_pos: 0.05, range: 'at lows' });
    rows[2] = row('1h', { range_pos: 0.1, range: 'at lows', stretch: -2.6, accel: -0.4, stretch_label: 'stretched down, fading' });
    rows[4] = row('1d', { trend: 1.1, trend_label: 'rising' });
    const e = evaluate(rows, 50, 1, 100);
    expect(e.rule).toBe(3);
    expect(e.sentence).toBe('LONG · LOCAL BOTTOM IN A LARGER UPTREND');
    expect(e.side).toBe(1);
  });
  it('rule 4: a move still accelerating says WAIT, or go with it when the side matches', () => {
    const rows = base();
    rows[2] = row('1h', { stretch: 2.5, accel: 0.6, stretch_label: 'stretched up, still going', trend: 2, trend_label: 'rising' });
    expect(evaluate(rows, 100, -1, 100).sentence).toBe("WAIT · UP MOVE STILL ACCELERATING · DON'T FADE IT");
    expect(evaluate(rows, 100, 1, 100).sentence).toBe('LONG WITH THE MOVE · TIGHT · IT CAN TURN FAST');
  });
  it('rule 5: agreeing 1h and 4h trends with no stretch is a pullback entry', () => {
    const rows = base();
    rows[2] = row('1h', { trend: -1, trend_label: 'falling', stretch: -0.4 });
    rows[3] = row('4h', { trend: -0.8, trend_label: 'falling' });
    const e = evaluate(rows, 100, -1, 100);
    expect(e.rule).toBe(5);
    expect(e.sentence).toBe('SHORT WITH THE TREND · PULLBACK ENTRY · FALLING ON 1H AND 4H');
  });
  it('rule 7 beats the catch-all when local and long-term disagree', () => {
    const rows = base();
    rows[1] = row('15m', { range_pos: 0.95, range: 'at highs' });
    rows[5] = row('1w', { range_pos: 0.1, range: 'at lows' });
    expect(evaluate(rows, 100, -1, 100).rule).toBe(7);
  });
  it('rule 6 otherwise', () => {
    const e = evaluate(base(), 100, -1, 100);
    expect(e.rule).toBe(6);
    expect(e.sentence).toBe('NO EDGE · MID-RANGE ON EVERY HORIZON · WAIT FOR A SPIKE');
  });
  it('warming up until the local rows can be read', () => {
    const rows = base();
    rows[0] = row('1m', { ok: false, bars: 3 });
    rows[1] = row('15m', { ok: false, bars: 3 });
    expect(evaluate(rows, 100, -1, 100).rule).toBe(0);
  });
});
