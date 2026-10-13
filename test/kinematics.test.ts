import { describe, expect, it } from 'vitest';
import { IMPULSE_FULL, Kinematics, MarketKinematics, carKinematics, headway, headwayColor, marketImpulse, projectedHeadway } from '../shared/kinematics.js';
import { closeFeeUsd, liquidationPrice, openFeeUsd } from '../shared/jupiter.js';

describe('headway', () => {
  it('is gap / v_close when closing', () => {
    expect(headway(1, 0.1)).toBeCloseTo(10);
  });
  it('is infinite when the gap is opening or flat', () => {
    expect(headway(1, 0)).toBe(Infinity);
    expect(headway(1, -0.5)).toBe(Infinity);
  });
  it('is zero at or past the car ahead', () => {
    expect(headway(0, 0.1)).toBe(0);
    expect(headway(-0.1, 0.1)).toBe(0);
  });
});

describe('projectedHeadway', () => {
  it('equals plain headway with zero acceleration', () => {
    expect(projectedHeadway(1, 0.1, 0)).toBeCloseTo(10);
  });
  it('is shorter than plain headway when closing speed is increasing', () => {
    const plain = headway(1, 0.1);
    const proj = projectedHeadway(1, 0.1, 0.02);
    expect(proj).toBeLessThan(plain);
    expect(0.1 * proj + 0.5 * 0.02 * proj * proj).toBeCloseTo(1, 6);
  });
  it('goes finite before plain headway when not yet closing but accelerating toward the car', () => {
    expect(headway(1, -0.05)).toBe(Infinity);
    const proj = projectedHeadway(1, -0.05, 0.02);
    expect(Number.isFinite(proj)).toBe(true);
    expect(proj).toBeGreaterThan(0);
  });
  it('is infinite when decelerating enough to never arrive', () => {
    expect(projectedHeadway(1, 0.1, -0.02)).toBe(Infinity);
  });
});

describe('headwayColor', () => {
  const thr = { green: 60, yellow: 20, orange: 5 };
  it('maps thresholds', () => {
    expect(headwayColor(Infinity, thr)).toBe('green');
    expect(headwayColor(61, thr)).toBe('green');
    expect(headwayColor(60, thr)).toBe('yellow');
    expect(headwayColor(20, thr)).toBe('orange');
    expect(headwayColor(5, thr)).toBe('red');
    expect(headwayColor(0, thr)).toBe('red');
  });
});

const pricing = { impactScalarUsd: 3.75e9, baseOpenBps: 6, baseCloseBps: 6, maxLeverage: 500 };

describe('Kinematics on a steady adverse drift (short, price rising)', () => {
  it('produces v_close > 0, headway ~ gap / v_close, gap ~0.73 at entry for 100x; the car ahead carries the trend', () => {
    const L = 100;
    const entry = 100;
    const collateral = 50;
    const size = collateral * L;
    const collateralNet = collateral - openFeeUsd(size, pricing);
    const liq = liquidationPrice({ side: -1, entry, sizeUsd: size, collateralUsd: collateralNet, closeFeeUsd: closeFeeUsd(size, pricing), borrowFeeUsd: 0 });
    const kin = new Kinematics({ velocityEmaSec: 30, accelEmaSec: 10, roadK: 30, trendEmaSec: 120 });
    const r = 2e-6; // price rises 0.0002% per second (0.24% over the 20 min run: still short of liq at 0.71%)
    let out = kin.tick({ t: 0, price: entry, side: -1, entry, liq, leverage: size / collateralNet, atrRate: 0.001 / 60 });
    expect(out.gap).toBeGreaterThan(0.65);
    expect(out.gap).toBeLessThan(0.8);
    for (let t = 200; t <= 1_200_000; t += 200) {
      const price = entry * Math.exp(r * (t / 1000));
      out = kin.tick({ t, price, side: -1, entry, liq, leverage: size / collateralNet, atrRate: 0.001 / 60 });
    }
    expect(out.v_price).toBeCloseTo(-r, 7);
    expect(out.v_close).toBeGreaterThan(0);
    expect(out.headway_s).toBeCloseTo(out.gap / out.v_close, 6);
    expect(out.entry_dist).toBeLessThan(0);
    expect(out.fav).toBeLessThan(0);
    // Steady trend: the car ahead is braking (slower than the flow); you ride at the flow (impulse ~0).
    expect(out.v_ahead).toBeLessThan(out.v_road);
    expect(Math.abs(out.v_you - out.v_road)).toBeLessThan(1e-4);
    expect(out.v_ahead - out.v_you).toBeCloseTo(out.v_gap, 6);
    expect(out.brake_ahead).toBeGreaterThan(0); // dim glow while it is steadily slower than you
  });

  it('favorable move opens the gap, makes headway infinite, and the car ahead pulls away', () => {
    const kin = new Kinematics({ velocityEmaSec: 2, accelEmaSec: 10, roadK: 30, trendEmaSec: 60, roadMin: 0.1 });
    let out = kin.tick({ t: 0, price: 100, side: 1, entry: 100, liq: 99.3, leverage: 100, atrRate: null });
    for (let t = 200; t <= 60_000; t += 200) {
      out = kin.tick({ t, price: 100 + t / 100_000, side: 1, entry: 100, liq: 99.3, leverage: 100, atrRate: null });
    }
    expect(out.v_gap).toBeGreaterThan(0);
    expect(out.headway_s).toBe(Infinity);
    expect(out.entry_dist).toBeGreaterThan(0);
    expect(out.v_ahead).toBeGreaterThan(out.v_road);
    expect(out.v_you).toBeLessThanOrEqual(out.v_road + 1e-12); // you ease off on a favorable impulse
  });
});

describe('trend / impulse decomposition (Update 3)', () => {
  it('a step in price velocity shows up as impulse first, then migrates into the trend', () => {
    const mk = new MarketKinematics({ velocityEmaSec: 30, accelEmaSec: 10, roadK: 30, trendEmaSec: 120 });
    let t = 0;
    for (; t <= 300_000; t += 200) mk.tick(t, 100);           // flat tape
    const r = 2e-5;
    let early = mk.tick(t, 100);
    for (let k = 1; k <= 25; k++) { t += 200; early = mk.tick(t, 100 * Math.exp(r * (k * 0.2))); } // 5 s into the move
    expect(early.v).toBeGreaterThan(0);
    expect(early.vImpulse).toBeGreaterThan(early.vTrend);      // fast EMA leads: it reads as your lurch
    expect(early.aTrend).toBeGreaterThan(0);                    // the trend is starting to turn
    let late = early;
    for (let k = 26; k <= 25 + 6000; k++) { t += 200; late = mk.tick(t, 100 * Math.exp(r * (k * 0.2))); } // 20 min later
    expect(Math.abs(late.vImpulse)).toBeLessThan(Math.abs(late.vTrend) * 0.05); // converged: all trend, no impulse
    expect(late.vTrend).toBeCloseTo(r, 7);
  });

  it('v_ahead - v_you equals the full relative velocity including the car ahead moving on its own', () => {
    const base = { side: -1 as const, leverage: 100, price: 100, entry: 100, liq: 100.7, vLnP: 2e-5, aLnP: 0, vTrend: 1.5e-5, aTrend: 0, roadK: 30, atrRate: 0.001 / 60 };
    const k = carKinematics({ ...base, liqRate: -1e-6 }); // liq moving toward price (borrow fee creep) for a short: liq falls
    expect(k.v_gap_trend).toBeCloseTo(-100 * 1.5e-5, 12);
    expect(k.v_gap_impulse).toBeCloseTo(-100 * 0.5e-5, 12);
    expect(k.v_gap_liq).toBeCloseTo(-100 * 1e-6, 12);        // -L*s*liqRate = -100 * -1 * -1e-6
    expect(k.v_ahead - k.v_you).toBeCloseTo(k.v_gap + k.v_gap_liq, 12);
    expect(k.v_you).toBeGreaterThan(k.v_road);               // adverse impulse = you lurch forward
    expect(k.v_ahead).toBeLessThan(k.v_road);                // car ahead braking + creeping toward you
  });

  it('brake lights come on hard when the trend turns against you', () => {
    const base = { side: 1 as const, leverage: 100, price: 100, entry: 100, liq: 99.3, vLnP: 0, aLnP: 0, vTrend: 0, roadK: 30, atrRate: null };
    expect(carKinematics({ ...base, aTrend: 0 }).brake_ahead).toBe(0);
    expect(carKinematics({ ...base, aTrend: -3e-4 }).slam).toBe(true);     // past slamThreshold 0.02
    expect(carKinematics({ ...base, aTrend: -1e-4 }).slam).toBe(false);
    // road never stops: v_road has a floor
    expect(carKinematics({ ...base, aTrend: 0, atrRate: 0 }).v_road).toBeCloseTo(0.1, 9);
    // lurch: an adverse impulse beyond the threshold reads +1, a favorable one -1
    expect(carKinematics({ ...base, vLnP: -8e-4, vTrend: 0 }).lurch).toBe(1);
    expect(carKinematics({ ...base, vLnP: 8e-4, vTrend: 0 }).lurch).toBe(-1);
    expect(carKinematics({ ...base, vLnP: 1e-4, vTrend: 0 }).lurch).toBe(0);
    expect(carKinematics({ ...base, aTrend: -2e-4 }).brake_ahead).toBe(1);   // -100 * 2e-4 = -0.02 cl/s^2 decel
    expect(carKinematics({ ...base, aTrend: 2e-4 }).brake_ahead).toBe(0);    // accelerating away: no lights
  });
});

describe('market impulse (Update 15)', () => {
  it('a tick against me (gap closing) is a positive surge, a tick for me a negative drag, clamped to ±1', () => {
    expect(marketImpulse(-IMPULSE_FULL / 2)).toBeCloseTo(0.5, 9);
    expect(marketImpulse(IMPULSE_FULL / 4)).toBeCloseTo(-0.25, 9);
    expect(marketImpulse(-10)).toBe(1);
    expect(marketImpulse(10)).toBe(-1);
    expect(marketImpulse(0)).toBe(0);
    expect(marketImpulse(NaN)).toBe(0);
  });
});
