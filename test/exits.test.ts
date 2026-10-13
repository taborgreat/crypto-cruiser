import { describe, expect, it } from 'vitest';
import { exitHit, exitPriceFromPct, exitWellPlaced } from '../shared/exits.js';

describe('take profit / stop loss (Update 12)', () => {
  it('a long takes profit above and stops below; a short the other way round', () => {
    expect(exitHit('tp', 1, 101, 100.5)).toBe(true);
    expect(exitHit('tp', 1, 100, 100.5)).toBe(false);
    expect(exitHit('sl', 1, 99, 99.5)).toBe(true);
    expect(exitHit('sl', 1, 100, 99.5)).toBe(false);
    expect(exitHit('tp', -1, 99, 99.5)).toBe(true);
    expect(exitHit('tp', -1, 100, 99.5)).toBe(false);
    expect(exitHit('sl', -1, 101, 100.5)).toBe(true);
    expect(exitHit('sl', -1, 100, 100.5)).toBe(false);
  });
  it('quick prices go the right way for the kind and side', () => {
    expect(exitPriceFromPct('tp', 1, 100, 0.01)).toBeCloseTo(101);
    expect(exitPriceFromPct('sl', 1, 100, 0.01)).toBeCloseTo(99);
    expect(exitPriceFromPct('tp', -1, 100, 0.01)).toBeCloseTo(99);
    expect(exitPriceFromPct('sl', -1, 100, 0.01)).toBeCloseTo(101);
  });
  it('placement check', () => {
    expect(exitWellPlaced('tp', -1, 100, 99)).toBe(true);
    expect(exitWellPlaced('tp', -1, 100, 101)).toBe(false);
    expect(exitWellPlaced('sl', 1, 100, 99)).toBe(true);
    expect(exitWellPlaced('sl', 1, 100, 101)).toBe(false);
  });
});
