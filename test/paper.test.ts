import { describe, expect, it } from 'vitest';
import { PaperEngine } from '../server/engine/paper.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

const steps = DEFAULT_SETTINGS.pedal;

async function openShort(lev = 100, collateral = 50, price = 100) {
  const e = new PaperEngine(1000);
  const r = await e.open({ market: 'SOL-PERP', side: -1, leverage: lev, collateralUsd: collateral }, price);
  expect(r.ok).toBe(true);
  return e;
}

describe('PaperEngine', () => {
  it('opens with Jupiter fees deducted and liq above entry for a short', async () => {
    const e = await openShort();
    const p = e.position!;
    expect(e.bankrollUsd).toBeCloseTo(950);
    expect(p.sizeUsd).toBeCloseTo(5000);
    expect(p.collateralUsd).toBeLessThan(50);
    expect(p.liq).toBeGreaterThan(100);
    expect(p.liq).toBeLessThan(101);
    expect(p.leverage).toBeGreaterThan(100);
  });

  it('rejects when collateral exceeds bankroll or leverage is out of range', async () => {
    const e = new PaperEngine(20);
    expect((await e.open({ market: 'SOL-PERP', side: 1, leverage: 10, collateralUsd: 50 }, 100)).ok).toBe(false);
    expect((await e.open({ market: 'SOL-PERP', side: 1, leverage: 300, collateralUsd: 10 }, 100)).ok).toBe(false);
    expect((await e.open({ market: 'SOL-PERP', side: 1, leverage: 1, collateralUsd: 10 }, 100)).ok).toBe(false);
  });

  it('liquidates when price crosses liq and forfeits collateral', async () => {
    const e = await openShort();
    const liq = e.position!.liq;
    expect(e.tick(1000, 100.2, 0)).toEqual([]);
    const ev = e.tick(2000, liq + 0.001, 0);
    expect(ev.some((x) => x.kind === 'liquidated')).toBe(true);
    expect(e.position).toBeNull();
    expect(e.bankrollUsd).toBeCloseTo(950);
  });

  it('accrues borrow fees which move liq toward price', async () => {
    const e = await openShort();
    const liq0 = e.position!.liq;
    e.tick(0, 100, 0.0001);
    e.tick(3_600_000, 100, 0.0001); // one hour at 0.01%/h
    expect(e.position!.borrowFeeUsd).toBeCloseTo(0.5, 3);
    expect(e.position!.liq).toBeLessThan(liq0);
  });

  it('brake_full realizes pnl after fees back to the bankroll', async () => {
    const e = await openShort();
    const r = await e.pedal('brake_full', 99, steps, 100);
    expect(r.ok).toBe(true);
    expect(e.position).toBeNull();
    // short from 100 to 99 on $5000 = +$50, minus close fee ~$3.5
    expect(e.bankrollUsd).toBeGreaterThan(1000 + 40);
    expect(e.bankrollUsd).toBeLessThan(1000 + 50);
  });

  it('gas_light keeps leverage roughly constant, gas_hard raises it, coast lowers it, withdraw raises it', async () => {
    const e = await openShort();
    const L0 = e.position!.leverage;
    await e.pedal('gas_light', 100, steps, 100);
    expect(Math.abs(e.position!.leverage - L0) / L0).toBeLessThan(0.02);
    expect(e.position!.sizeUsd).toBeCloseTo(5500);
    const L1 = e.position!.leverage;
    await e.pedal('gas_hard', 100, steps, 100);
    expect(e.position!.leverage).toBeGreaterThan(L1);
    const L2 = e.position!.leverage;
    const liqBefore = e.position!.liq;
    await e.pedal('coast', 100, steps, 100);
    expect(e.position!.leverage).toBeLessThan(L2);
    expect(e.position!.liq).toBeGreaterThan(liqBefore); // car ahead recedes for a short
    const L3 = e.position!.leverage;
    const r = await e.pedal('withdraw', 100, steps, 100);
    expect(r.ok).toBe(true);
    expect(e.position!.leverage).toBeGreaterThan(L3);
  });

  it('brake_light closes a fraction and keeps leverage', async () => {
    const e = await openShort();
    const L0 = e.position!.leverage;
    const r = await e.pedal('brake_light', 99.5, steps, 100);
    expect(r.ok).toBe(true);
    expect(e.position!.sizeUsd).toBeCloseTo(3750);
    expect(Math.abs(e.position!.leverage - L0) / L0).toBeLessThan(0.05);
    expect(e.position!.realizedPnlUsd).toBeGreaterThan(0);
  });

  it('preview() is pure and matches what open() would create', async () => {
    const e = new PaperEngine(1000);
    const prev = e.preview('SOL-PERP', { side: -1, leverage: 100, collateralUsd: 50, entry: null }, 100);
    expect(e.position).toBeNull();
    expect(e.bankrollUsd).toBe(1000);
    const r = await e.open({ market: 'SOL-PERP', side: -1, leverage: 100, collateralUsd: 50 }, 100);
    expect(r.ok).toBe(true);
    expect(e.position!.liq).toBeCloseTo(prev.liq, 9);
    expect(e.position!.leverage).toBeCloseTo(prev.leverage, 9);
    // a limit preview uses the proposed entry
    const lim = e.preview('SOL-PERP', { side: -1, leverage: 100, collateralUsd: 50, entry: 101 }, 100);
    expect(lim.entry).toBe(101);
    expect(lim.liq).toBeGreaterThan(101);
  });

  it('places a paper limit and fills it when the price crosses the trigger', async () => {
    const e = new PaperEngine(1000);
    const r = await e.open({ market: 'SOL-PERP', side: -1, leverage: 100, collateralUsd: 50, entry: 101 }, 100);
    expect(r.ok).toBe(true);
    expect(e.position).toBeNull();
    expect(e.pendingOrder?.triggerPrice).toBe(101);
    expect(e.tick(1000, 100.5, 0)).toEqual([]);
    const ev = e.tick(2000, 101.02, 0);
    expect(ev.some((x) => x.kind === 'order_filled')).toBe(true);
    expect(e.position!.entry).toBe(101);
    expect(e.pendingOrder).toBeNull();
    // wrong side of the market is rejected
    const bad = await new PaperEngine(1000).open({ market: 'SOL-PERP', side: -1, leverage: 100, collateralUsd: 50, entry: 99 }, 100);
    expect(bad.ok).toBe(false);
  });

  it('cruise control trails the price and rear-ends you on a snap back', async () => {
    const e = await openShort();
    const r = await e.pedal('cruise', 100, steps, 100);
    expect(r.ok).toBe(true);
    const stop0 = e.position!.trailingStop!.price;
    expect(stop0).toBeGreaterThan(100);
    e.tick(1000, 100, 0);
    e.tick(2000, 99, 0); // favorable: stop follows down
    const stop1 = e.position!.trailingStop!.price;
    expect(stop1).toBeLessThan(stop0);
    // 0.5 car lengths at ~100x is ~0.5% of price: stop sits near 99.49
    expect(stop1).toBeGreaterThan(99.4);
    expect(stop1).toBeLessThan(99.6);
    e.tick(3000, 99.3, 0); // not yet
    expect(e.position).not.toBeNull();
    const ev = e.tick(4000, stop1 + 0.01, 0);
    expect(ev.some((x) => x.kind === 'stop_hit')).toBe(true);
    expect(e.position).toBeNull();
    expect(e.bankrollUsd).toBeGreaterThan(950);
  });
});
