import { describe, expect, it } from 'vitest';
import { positionPdas } from '../server/engine/chainPositions.js';
import { CUSTODY, STABLE_CUSTODY, marketOfCustody } from '../shared/solana.js';

describe('position accounts from the chain (Update 14)', () => {
  it('derives the real SOL short account of a known wallet among its nine PDAs', () => {
    // FHPy… opened a SOL short with USDC collateral on 2026-10-12; Jupiter named this account for it.
    const pdas = positionPdas('FHPyvwD8Fu5RqUKpaq5aQyd1UiTmC3iV33PtrpNZpJJk');
    expect(pdas).toHaveLength(9);
    expect(new Set(pdas).size).toBe(9);
    expect(pdas).toContain('7bwQCsp7hsP2FYXNH6N6ct2xAu51mnckFSqtoQMmnMhV');
  });
  it('is cached per owner and differs between owners', () => {
    const a = positionPdas('FHPyvwD8Fu5RqUKpaq5aQyd1UiTmC3iV33PtrpNZpJJk');
    const b = positionPdas('FHPyvwD8Fu5RqUKpaq5aQyd1UiTmC3iV33PtrpNZpJJk');
    const c = positionPdas('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa');
    expect(a).toBe(b);
    expect(c).not.toEqual(a);
  });
  it('maps asset custodies to markets and stables to none', () => {
    expect(marketOfCustody(CUSTODY['SOL-PERP'])).toBe('SOL-PERP');
    expect(marketOfCustody(CUSTODY['ETH-PERP'])).toBe('ETH-PERP');
    expect(marketOfCustody(CUSTODY['BTC-PERP'])).toBe('BTC-PERP');
    expect(marketOfCustody(STABLE_CUSTODY.USDC)).toBeNull();
    expect(marketOfCustody(STABLE_CUSTODY.USDT)).toBeNull();
  });
});
