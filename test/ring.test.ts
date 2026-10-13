import { describe, expect, it } from 'vitest';
import { TickHistory, priceAt, tickAt } from '../shared/ring.js';
import type { Tick } from '../shared/types.js';

const ring: Tick[] = [1000, 2000, 3000, 4000, 5000].map((t, i) => ({ t, price: 100 + i, source: 't' }));

describe('array ring lookup', () => {
  it('returns the last tick at or before t', () => {
    expect(tickAt(ring, 3000)!.price).toBe(102);
    expect(tickAt(ring, 3500)!.price).toBe(102);
    expect(tickAt(ring, 5000)!.price).toBe(104);
    expect(tickAt(ring, 99_999)!.price).toBe(104);
  });
  it('clamps to the oldest tick before the buffer starts and handles empty buffers', () => {
    expect(tickAt(ring, 10)!.price).toBe(100);
    expect(tickAt([], 10)).toBeNull();
    expect(priceAt(ring, 2500)).toBe(101);
    expect(priceAt([], 2500)).toBeNull();
  });
});

describe('TickHistory (ghost ages, rewind)', () => {
  function make(n = 5): TickHistory {
    const h = new TickHistory(4);
    for (let i = 0; i < n; i++) h.push(1000 * (i + 1), 100 + i);
    return h;
  }
  it('grows past its initial capacity and keeps order', () => {
    const h = make(50);
    expect(h.length).toBe(50);
    expect(h.first()!.t).toBe(1000);
    expect(h.last()!.price).toBe(149);
  });
  it('looks up the price at or before a time, clamping before the start', () => {
    const h = make();
    expect(h.priceAt(3000)).toBe(102);
    expect(h.priceAt(3500)).toBe(102);
    expect(h.priceAt(10)).toBe(100);
    expect(h.priceAt(1e9)).toBe(104);
    expect(h.indexAt(10)).toBe(-1);
    expect(h.tickAt(4500)!.t).toBe(4000);
    expect(new TickHistory().priceAt(5)).toBeNull();
  });
  it('ignores out-of-order and non-positive ticks', () => {
    const h = make();
    h.push(2500, 50);
    h.push(6000, 0);
    h.push(6000, NaN);
    expect(h.length).toBe(5);
    expect(h.priceAt(2500)).toBe(101);
  });
  it('trims older ticks', () => {
    const h = make(10);
    h.trim(5000);
    expect(h.first()!.t).toBe(5000);
    expect(h.length).toBe(6);
  });
  it('samples evenly and iterates a window', () => {
    const h = make(100);
    const s = h.sample(10_000, 60_000, 10);
    expect(s.length).toBeGreaterThanOrEqual(10);
    expect(s[0][0]).toBe(10_000);
    expect(s[s.length - 1][0]).toBe(60_000);
    const w = [...h.between(2000, 4000)];
    expect(w.map((x) => x[0])).toEqual([2000, 3000, 4000]);
  });
  it('drops the oldest tenth when it reaches its hard cap', () => {
    const h = new TickHistory(8, 16);
    for (let i = 0; i < 40; i++) h.push(i, 1 + i);
    expect(h.length).toBeLessThanOrEqual(16);
    expect(h.last()!.t).toBe(39);
  });
});
