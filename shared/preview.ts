// Pure preview of the position that would exist if a proposed trade were opened now. Shared by the
// paper engine, the server's ghost frames and the browser's trade form, so all three agree exactly.
import { DEFAULT_PRICING, closeFeeUsd, liquidationPrice, openFeeUsd, priceImpactFeeBps, type MarketPricing } from './jupiter.js';
import type { Market, PositionState, Side } from './types.js';

/** Per-market pricing read from the custody accounts (tradeImpactFeeScalar in USD), Oct 2026. */
export const MARKET_PRICING: Record<Market, MarketPricing> = {
  'SOL-PERP': { ...DEFAULT_PRICING, impactScalarUsd: 3_750_000_000 },
  'ETH-PERP': { ...DEFAULT_PRICING, impactScalarUsd: 15_000_000_000 },
  'BTC-PERP': { ...DEFAULT_PRICING, impactScalarUsd: 24_000_000_000 },
};

export interface PreviewInput {
  side: Side;
  leverage: number;
  collateralUsd: number;
  entry: number | null;   // null = market
}

export function previewPosition(market: Market, g: PreviewInput, price: number, now = Date.now()): PositionState {
  const entry = g.entry ?? price;
  const sizeUsd = g.collateralUsd * g.leverage;
  const pricing = MARKET_PRICING[market];
  const fee = openFeeUsd(sizeUsd, pricing);
  const collateralUsd = g.collateralUsd - fee;
  const closeFee = closeFeeUsd(sizeUsd, pricing);
  const liq = liquidationPrice({ side: g.side, entry, sizeUsd, collateralUsd, closeFeeUsd: closeFee, borrowFeeUsd: 0 });
  return {
    market, side: g.side, entry, sizeUsd, collateralUsd, openedAt: now,
    borrowFeeUsd: 0, closeFeeUsd: closeFee, liq, leverage: collateralUsd > 0 ? sizeUsd / collateralUsd : Infinity,
    realizedPnlUsd: 0, contributedUsd: g.collateralUsd, returnedUsd: 0, trailingStop: null,
  };
}

export interface TradeSummary {
  sizeUsd: number;
  openFeeUsd: number;
  impactBps: number;
  collateralAfterFees: number;
  liq: number;
  gapAtEntry: number;       // car lengths
  effectiveLeverage: number;
}

/** What the trade form shows: fees, liquidation and gap for a proposed trade at the current price. */
export function tradeSummary(market: Market, g: PreviewInput, price: number): TradeSummary | null {
  if (!(price > 0) || !(g.collateralUsd > 0) || !(g.leverage > 0)) return null;
  const p = previewPosition(market, g, price);
  const pricing = MARKET_PRICING[market];
  const entry = g.entry ?? price;
  return {
    sizeUsd: p.sizeUsd,
    openFeeUsd: openFeeUsd(p.sizeUsd, pricing),
    impactBps: priceImpactFeeBps(p.sizeUsd, pricing.impactScalarUsd),
    collateralAfterFees: p.collateralUsd,
    liq: p.liq,
    gapAtEntry: p.leverage * ((g.side * (entry - p.liq)) / entry),
    effectiveLeverage: p.leverage,
  };
}
