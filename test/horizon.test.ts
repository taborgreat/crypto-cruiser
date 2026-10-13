import { describe, expect, it } from 'vitest';
import { H_MAX, H_MIN, autoRoomTarget, autoVolMultiplier, chartIntervalFor, clampH, deriveHorizon } from '../shared/horizon.js';
import { rate, rateUnit, timeSpan } from '../shared/format.js';

describe('horizon (Update 4): one knob derives everything', () => {
  it('H = 60 s reproduces the Update 3 constants', () => {
    const d = deriveHorizon(60);
    expect(d.tauFast).toBeCloseTo(2);
    expect(d.tauSlow).toBe(60);
    expect(d.tauAccel).toBeCloseTo(10);
    expect(d.ghostAges).toEqual([300, 60, 10]);
    expect(d.thr).toEqual({ green: 60, yellow: 20, orange: 5, critical: 1 });
    expect(d.kScroll).toBe(1);
    expect(d.tickLerp).toBeCloseTo(0.2);
  });
  it('H = 1 h stretches ages and thresholds, slows the scroll and the re-sync', () => {
    const d = deriveHorizon(3600);
    expect(d.ghostAges).toEqual([18_000, 3600, 600]);
    expect(d.thr.orange).toBe(300);
    expect(d.kScroll).toBeCloseTo(1 / 60);
    expect(d.tickLerp).toBe(1);
  });
  it('clamps H to the supported range', () => {
    expect(clampH(1)).toBe(H_MIN);
    expect(clampH(1e9)).toBe(H_MAX);
    expect(clampH(NaN)).toBe(60);
  });
  it('auto from room widens with the gap and clamps the ratio', () => {
    expect(autoRoomTarget(60, 1, 1)).toBe(60);
    expect(autoRoomTarget(60, 2, 1)).toBeCloseTo(60 * Math.pow(2, 1.5));
    expect(autoRoomTarget(60, 0.1, 1)).toBeCloseTo(60 * Math.pow(0.5, 1.5));
    expect(autoRoomTarget(60, 100, 1)).toBeCloseTo(60 * Math.pow(20, 1.5));
    expect(autoRoomTarget(60, 2, 0)).toBe(60);
  });
  it('auto from volatility: quiet tape lengthens, violent tape shortens', () => {
    expect(autoVolMultiplier(0.001, 0.0005)).toBe(2);
    expect(autoVolMultiplier(0.001, 0.004)).toBe(0.25);
    expect(autoVolMultiplier(0.001, null)).toBe(1);
  });
  it('the chart timeframe follows H / 60 to the nearest chip', () => {
    expect(chartIntervalFor(60)).toBe(1);
    expect(chartIntervalFor(300)).toBe(5);
    expect(chartIntervalFor(3600)).toBe(60);
    expect(chartIntervalFor(86_400)).toBe(900);
    expect(chartIntervalFor(604_800)).toBe(14_400);
  });
});

describe('units policy formatters (Update 6)', () => {
  it('rate units follow the horizon', () => {
    expect(rateUnit(10).unit).toBe('/s');
    expect(rateUnit(60).unit).toBe('/min');
    expect(rateUnit(3600).unit).toBe('/h');
    expect(rate(0.01, 60, 'money')).toBe('+$0.60/min');
    expect(rate(-0.0001, 3600, 'pct')).toBe('−0.36%/h');
  });
  it('never prints infinity', () => {
    expect(timeSpan(Infinity)).toBe('not closing');
    expect(timeSpan(null)).toBe('not closing');
    expect(timeSpan(28)).toBe('28 s');
    expect(timeSpan(130)).toBe('2 m 10 s');
    expect(timeSpan(4320)).toBe('1 h 12 m');
  });
});
