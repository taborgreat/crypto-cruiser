import { describe, expect, it } from 'vitest';
import { fitTopScale, packTopLanes } from '../shared/topscale.js';
import type { GhostFrame } from '../shared/types.js';

const AHEAD = 1000; // view units of road ahead of my car
const BEHIND = 250;

describe('bird\'s-eye scale (Update 14)', () => {
  it('one lane: the true distance, the car in front at 70 % of the depth, no axis break', () => {
    const m = fitTopScale([0.7], AHEAD, BEHIND, 100_000);
    expect(m.broken).toBe(false);
    expect(m.y(0.7)).toBeCloseTo(0.7 * AHEAD, 6);
    expect(m.y(0.35)).toBeCloseTo(0.35 * AHEAD, 6); // proportional: half the dollars, half the road
  });
  it('two lanes far apart: still the true scale, both in proportion', () => {
    const m = fitTopScale([0.4, 0.9], AHEAD, BEHIND, 100_000);
    expect(m.broken).toBe(false);
    expect(m.y(0.9)).toBeCloseTo(0.7 * AHEAD, 6);
    expect(m.y(0.4) / m.y(0.9)).toBeCloseTo(0.4 / 0.9, 6);
  });
  it('two lanes almost equal: the axis breaks so the difference is visible', () => {
    const m = fitTopScale([0.70, 0.72], AHEAD, BEHIND, 100_000);
    expect(m.broken).toBe(true);
    const dy = m.y(0.72) - m.y(0.70);
    expect(dy).toBeGreaterThan(0.3 * AHEAD); // the $0.02 spread stretches to half the depth
    expect(m.y(0.72)).toBeLessThanOrEqual(AHEAD);
  });
  it('the cap keeps tiny gaps from exploding', () => {
    const m = fitTopScale([0.001], AHEAD, BEHIND, 1000);
    expect(m.scale).toBe(1000);
    expect(m.y(0.001)).toBeCloseTo(1, 6);
  });
});

function ghost(id: string, side: 1 | -1, lane: 0 | 1 | 2 | 3): GhostFrame {
  return { id, side, lane } as unknown as GhostFrame;
}

describe('lane packing (Update 14)', () => {
  it('both sides: the now lanes meet at the divider, older lanes fan outward', () => {
    const p = packTopLanes([ghost('l3', 1, 3), ghost('l1', 1, 1), ghost('s3', -1, 3), ghost('s0', -1, 0)], true, false);
    expect(p.lanes).toBe(4);
    expect(p.index.get('l3')).toBe(1);
    expect(p.index.get('l1')).toBe(0);
    expect(p.index.get('s3')).toBe(2);
    expect(p.index.get('s0')).toBe(3);
  });
  it('both sides with one lane each: two lanes side by side', () => {
    const p = packTopLanes([ghost('l3', 1, 3), ghost('s3', -1, 3)], true, false);
    expect(p.lanes).toBe(2);
    expect(p.index.get('l3')).toBe(0);
    expect(p.index.get('s3')).toBe(1);
  });
  it('one side: lanes in age order, now on the right', () => {
    const p = packTopLanes([ghost('s3', -1, 3), ghost('s0', -1, 0), ghost('s2', -1, 2)], false, false);
    expect(p.lanes).toBe(3);
    expect(p.index.get('s0')).toBe(0);
    expect(p.index.get('s2')).toBe(1);
    expect(p.index.get('s3')).toBe(2);
  });
  it('rewind: LONG left, SHORT right', () => {
    const p = packTopLanes([ghost('rwL', 1, 0), ghost('rwS', -1, 1)], true, true);
    expect(p.lanes).toBe(2);
    expect(p.index.get('rwL')).toBe(0);
    expect(p.index.get('rwS')).toBe(1);
  });
});
