// Jupiter Perps math, verified against docs.jup.ag (liquidation, fees), the official
// IDL example `get-liquidation-price.ts`, and a live quote from perps-api.jup.ag (Oct 2026).
//
//   priceImpactFeeBps = ceil(sizeUsd * 10000 / tradeImpactFeeScalar)
//   closeFeeUsd       = sizeUsd * (baseBps + priceImpactFeeBps) / 10000
//   borrowFeeUsd      = accrued hourly:  sizeUsd * hourlyRate * hours
//   maxLossUsd        = sizeUsd / MAX_LEV_PROTOCOL + closeFeeUsd + borrowFeeUsd
//   maxPriceDiff      = |maxLossUsd - collateralUsd| * entry / sizeUsd
//   long : liq = maxLoss > collateral ? entry + diff : entry - diff
//   short: liq = maxLoss > collateral ? entry - diff : entry + diff
//
// Cross-check against a live quote: short, size $5026.49, collateral $50.53, entry 108.20,
// impact 2 bps -> closeFee 4.02, maxLoss 14.07, diff 0.785 -> liq 108.985 (API said 109.00).
import type { Side } from './types.js';

/** Protocol-level max leverage that defines the maintenance margin (size / 500). */
export const MAX_LEV_PROTOCOL = 500;
/** Maximum leverage a trader can open with on SOL/ETH/wBTC. */
export const MAX_LEV_TRADE = 250;
export const MIN_LEV_TRADE = 1.1;
/** Base open/close fee: 0.06% = 6 bps. */
export const BASE_FEE_BPS = 6;
export const BPS = 10_000;

/**
 * Per-market pricing read from the custody accounts. `impactScalarUsd` is
 * tradeImpactFeeScalar expressed in USD (the on-chain value is 6-decimal USD).
 * Defaults are refreshed from chain at server start when an RPC is reachable.
 */
export interface MarketPricing {
  impactScalarUsd: number;
  baseOpenBps: number;
  baseCloseBps: number;
  maxLeverage: number;
}

export const DEFAULT_PRICING: MarketPricing = {
  impactScalarUsd: 30_000_000, // a $2.5k trade pays 1 bps, a $5k trade 2 bps (matches live quotes)
  baseOpenBps: BASE_FEE_BPS,
  baseCloseBps: BASE_FEE_BPS,
  maxLeverage: MAX_LEV_PROTOCOL,
};

export function priceImpactFeeBps(sizeUsd: number, impactScalarUsd: number): number {
  if (sizeUsd <= 0 || impactScalarUsd <= 0) return 0;
  return Math.ceil((sizeUsd * BPS) / impactScalarUsd);
}

export function openFeeUsd(sizeUsdDelta: number, pricing: MarketPricing = DEFAULT_PRICING): number {
  const bps = pricing.baseOpenBps + priceImpactFeeBps(sizeUsdDelta, pricing.impactScalarUsd);
  return (sizeUsdDelta * bps) / BPS;
}

export function closeFeeUsd(sizeUsd: number, pricing: MarketPricing = DEFAULT_PRICING): number {
  const bps = pricing.baseCloseBps + priceImpactFeeBps(sizeUsd, pricing.impactScalarUsd);
  return (sizeUsd * bps) / BPS;
}

export interface LiqInput {
  side: Side;
  entry: number;
  sizeUsd: number;
  collateralUsd: number;
  closeFeeUsd: number;
  borrowFeeUsd: number;
  maxLevProtocol?: number;
}

export function liquidationPrice(i: LiqInput): number {
  if (i.sizeUsd <= 0) return NaN;
  const maxLev = i.maxLevProtocol ?? MAX_LEV_PROTOCOL;
  const maxLossUsd = i.sizeUsd / maxLev + i.closeFeeUsd + i.borrowFeeUsd;
  const diff = (Math.abs(maxLossUsd - i.collateralUsd) * i.entry) / i.sizeUsd;
  const underwater = maxLossUsd > i.collateralUsd;
  if (i.side === 1) return underwater ? i.entry + diff : i.entry - diff;
  return underwater ? i.entry - diff : i.entry + diff;
}

/** Unrealized P&L before fees. */
export function pnlUsd(side: Side, entry: number, price: number, sizeUsd: number): number {
  return (side * (price - entry) * sizeUsd) / entry;
}

/** Borrow fee accrued over `hours` at an hourly rate (fraction, e.g. 0.00012 = 0.012%/h). */
export function borrowFeeUsd(sizeUsd: number, hourlyRate: number, hours: number): number {
  return sizeUsd * hourlyRate * Math.max(0, hours);
}

/** Jupiter's hourly borrow rate for a custody: (hourlyFundingDbps / 1000)% * utilization. */
export function hourlyBorrowRate(hourlyFundingDbps: number, utilization: number): number {
  // dbps = deci-basis-points: 1 dbps = 0.001%.
  return (hourlyFundingDbps / 1000 / 100) * utilization;
}

export function isLiquidated(side: Side, price: number, liq: number): boolean {
  return side === 1 ? price <= liq : price >= liq;
}

/** USD <-> 6-decimal raw integer strings used by the Jupiter API. */
export function usdToRaw(usd: number): string {
  return Math.round(usd * 1e6).toString();
}
export function rawToUsd(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  return Number(raw) / 1e6;
}
export function tokenToRaw(amount: number, decimals: number): string {
  return BigInt(Math.round(amount * 10 ** decimals)).toString();
}
export function rawToToken(raw: string | number, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}
