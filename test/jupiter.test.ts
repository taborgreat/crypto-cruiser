import { describe, expect, it } from 'vitest';
import {
  hourlyBorrowRate, isLiquidated, liquidationPrice, pnlUsd, priceImpactFeeBps, rawToUsd, usdToRaw, tokenToRaw,
} from '../shared/jupiter.js';

describe('Jupiter liquidation formula vs live API quotes (Oct 2026)', () => {
  it('matches the short quote: size 5026.49, collateral 50.53, entry 108.20, 2 bps impact -> liq 109.00', () => {
    const size = 5026.49;
    const closeFee = (size * (6 + 2)) / 1e4;
    const liq = liquidationPrice({ side: -1, entry: 108.2, sizeUsd: size, collateralUsd: 50.53, closeFeeUsd: closeFee, borrowFeeUsd: 0 });
    expect(Math.abs(liq - 109.0)).toBeLessThan(0.02);
  });
  it('matches the long quote: size 2500, collateral 52.35, entry 108.20, 1 bps impact -> liq 106.23', () => {
    const size = 2500;
    const closeFee = (size * (6 + 1)) / 1e4;
    const liq = liquidationPrice({ side: 1, entry: 108.2, sizeUsd: size, collateralUsd: 52.35, closeFeeUsd: closeFee, borrowFeeUsd: 0 });
    expect(Math.abs(liq - 106.23)).toBeLessThan(0.02);
  });
  it('borrow fees pull the liquidation price toward entry', () => {
    const base = { side: -1 as const, entry: 100, sizeUsd: 5000, collateralUsd: 50, closeFeeUsd: 3.5 };
    const l0 = liquidationPrice({ ...base, borrowFeeUsd: 0 });
    const l1 = liquidationPrice({ ...base, borrowFeeUsd: 5 });
    expect(l1).toBeLessThan(l0);
    expect(l1).toBeGreaterThan(100);
  });
  it('flips to the other side of entry when fees + maintenance exceed collateral (immediately liquidatable)', () => {
    const liq = liquidationPrice({ side: 1, entry: 100, sizeUsd: 5000, collateralUsd: 5, closeFeeUsd: 10, borrowFeeUsd: 0 });
    expect(liq).toBeGreaterThan(100);
    expect(isLiquidated(1, 100, liq)).toBe(true);
  });
});

describe('fees and helpers', () => {
  it('price impact bps uses ceil over the custody scalar', () => {
    expect(priceImpactFeeBps(5026.49, 3.75e9)).toBe(1);
    expect(priceImpactFeeBps(2500, 3.75e9)).toBe(1);
    expect(priceImpactFeeBps(400_000, 3.75e9)).toBe(2);
    expect(priceImpactFeeBps(0, 3.75e9)).toBe(0);
  });
  it('pnl sign follows side', () => {
    expect(pnlUsd(1, 100, 101, 1000)).toBeCloseTo(10);
    expect(pnlUsd(-1, 100, 101, 1000)).toBeCloseTo(-10);
  });
  it('hourly borrow rate from dbps and utilization', () => {
    // 60 dbps = 0.06%/h at full utilization; at 19.8% utilization ~0.0119%/h (docs example)
    expect(hourlyBorrowRate(60, 0.198) * 100).toBeCloseTo(0.01188, 4);
  });
  it('raw conversions', () => {
    expect(usdToRaw(10)).toBe('10000000');
    expect(usdToRaw(0.5)).toBe('500000');
    expect(rawToUsd('1234567800')).toBeCloseTo(1234.5678);
    expect(tokenToRaw(1, 9)).toBe('1000000000');
    expect(tokenToRaw(0.5, 9)).toBe('500000000');
  });
});
