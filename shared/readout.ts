// The one-line readout in plain units (Update 6): USD, %, price, seconds. No car words in the numbers.
//   if opened 60 s ago at 107.60: P&L +$3.10 (+6.2%) · to liq $0.71 (0.66%) · time to liq 2 m 10 s
//   · moving toward liq $0.021/s (0.020%/s) · volatility 0.21%/min (1 m ATR) · borrow −$0.44/h (−0.0007%/h)
//   · trend turned against you: −0.31% in last 60 s
import { money, pct, price as fmtPrice, rate, smoney, timeSpan, shortSpan } from './format.js';
import type { CarFrame, Layers } from './types.js';

/** Velocities below this (car lengths / s) are tape noise, not motion. */
export const MOTION_EPS = 2e-4;

export interface ReadoutCtx {
  price: number;        // current mark
  horizonSec: number;   // for rate units
  priceDp?: number;
  ageSec?: number | null;
  crashed?: boolean;
}

export function volatilityWord(atr: number | null): string {
  if (atr === null) return 'volatility warming up';
  return `volatility ${pct(atr * 100)}/min (1 m ATR)`;
}

export function trendWord(c: CarFrame): 'pulling away' | 'braking' | 'holding' {
  if (c.brake_ahead > 0.5 || c.v_gap_trend < -MOTION_EPS) return 'braking';
  if (c.v_gap_trend > MOTION_EPS) return 'pulling away';
  return 'holding';
}

/** Motion toward / away from liquidation in price terms. */
export function motionPhrase(c: CarFrame, ctx: ReadoutCtx): string {
  // v_gap is car lengths / s; one car length = price / L in dollars, = 1/L of price in fraction.
  const usdPerSec = (c.v_gap / c.leverage) * ctx.price;
  const fracPerSec = c.v_gap / c.leverage;
  if (c.v_close > MOTION_EPS) return `moving toward liq ${rate(Math.abs(usdPerSec), ctx.horizonSec, 'money').replace('+', '')} (${rate(Math.abs(fracPerSec) * 100, ctx.horizonSec, 'pct').replace('+', '')})`;
  if (c.v_gap > MOTION_EPS) return `moving away from liq ${rate(usdPerSec, ctx.horizonSec, 'money').replace('+', '')} (${rate(fracPerSec * 100, ctx.horizonSec, 'pct').replace('+', '')})`;
  return 'holding';
}

export function buildReadout(c: CarFrame, layers: Layers, ctx: ReadoutCtx): string {
  const parts: string[] = [];
  const toLiqUsd = Math.abs(ctx.price - c.liq);
  if (ctx.crashed) return `if opened ${ctx.ageSec ? shortSpan(ctx.ageSec) + ' ago' : 'now'}: LIQUIDATED (crashed into the car ahead) · respawning`;
  const head = ctx.ageSec !== null && ctx.ageSec !== undefined ? `if opened ${shortSpan(ctx.ageSec)} ago at ${fmtPrice(c.entry, ctx.priceDp)}` : `at ${fmtPrice(c.entry, ctx.priceDp)}`;
  const net = c.pnl_usd - c.fees_usd;
  parts.push(`${head}: P&L ${smoney(net)} (${pct(c.collateral_usd > 0 ? (net / c.collateral_usd) * 100 : 0, true)})`); // $ and % share one basis: after fees, on collateral
  parts.push(`to liq ${money(toLiqUsd)} (${pct(c.gap_pct * 100)})`);
  parts.push(`time to liq ${timeSpan(c.headway_s)}`);
  parts.push(motionPhrase(c, ctx));
  parts.push(volatilityWord(layers.atr));
  if (layers.funding !== null && layers.funding > 0) parts.push(`borrow −${money(c.size_usd * layers.funding).replace('−', '')}/h (−${pct(layers.funding * 100)}/h)`);
  if (c.brake_ahead > 0.5) {
    const pctH = (-c.v_gap_trend / c.leverage) * 100 * ctx.horizonSec; // trend move over the last H, in %
    parts.push(`trend turned against you: −${pct(Math.abs(pctH))} in last ${timeSpan(ctx.horizonSec)}`);
  }
  return parts.join(' · ');
}
