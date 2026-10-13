import { describe, expect, it } from 'vitest';
import { CandleBuilder, atrFraction, detectSwings, projectHills, type Candle } from '../shared/candles.js';

describe('CandleBuilder', () => {
  it('aggregates ticks into 1-minute candles', () => {
    const b = new CandleBuilder(60_000);
    const t0 = 1_700_000_000_000; // aligned to minute? make sure
    const base = Math.floor(t0 / 60_000) * 60_000;
    b.push({ t: base + 1000, price: 100, source: 't' });
    b.push({ t: base + 20_000, price: 102, source: 't' });
    b.push({ t: base + 40_000, price: 99, source: 't' });
    b.push({ t: base + 61_000, price: 101, source: 't' });
    expect(b.candles.length).toBe(2);
    expect(b.candles[0]).toMatchObject({ o: 100, h: 102, l: 99, c: 99 });
    expect(b.candles[1]).toMatchObject({ o: 101, h: 101, l: 101, c: 101 });
  });
  it('ignores stale ticks from an older bucket', () => {
    const b = new CandleBuilder(60_000);
    b.push({ t: 120_000, price: 1, source: 't' });
    b.push({ t: 10_000, price: 50, source: 't' });
    expect(b.candles.length).toBe(1);
    expect(b.candles[0].h).toBe(1);
  });
});

function synth(n: number, fn: (i: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = fn(i), p = fn(Math.max(0, i - 1));
    // wick 0.1 around the close so each candle's high/low is unique
    out.push({ t: i * 60_000, o: p, c, h: Math.max(p, c) + 0.1, l: Math.min(p, c) - 0.1 });
  }
  return out;
}

describe('atrFraction', () => {
  it('returns null without enough candles', () => {
    expect(atrFraction(synth(5, () => 100), 14)).toBeNull();
  });
  it('is ~0.2% for candles with 0.1% wicks on a flat price', () => {
    const atr = atrFraction(synth(60, () => 100), 14);
    expect(atr).not.toBeNull();
    expect(atr!).toBeCloseTo(0.002, 3);
  });
});

describe('swings and hills', () => {
  const candles = synth(120, (i) => 100 + 2 * Math.sin((2 * Math.PI * i) / 20));
  it('detects alternating swing highs and lows on a sine', () => {
    const sw = detectSwings(candles, 100, 3);
    expect(sw.length).toBeGreaterThan(4);
    const kinds = sw.map((s) => s.kind);
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
  });
  it('projects hills with uphill = against the position', () => {
    const sw = detectSwings(candles, 100, 3);
    const now = candles[candles.length - 1].t + 60_000;
    const shortHills = projectHills(sw, 100, -1, 100, now, 120, 10);
    const longHills = projectHills(sw, 100, 1, 100, now, 120, 10);
    expect(shortHills.length).toBe(13);
    // same magnitude, opposite sign for the two sides
    for (let i = 0; i < shortHills.length; i++) expect(shortHills[i].elev).toBeCloseTo(-longHills[i].elev, 9);
    // amplitude is leverage-scaled: ~2% swing * 100x = ~2 car lengths peak
    const maxAbs = Math.max(...shortHills.map((h) => Math.abs(h.elev)));
    expect(maxAbs).toBeGreaterThan(1);
    expect(maxAbs).toBeLessThan(3);
  });
});
