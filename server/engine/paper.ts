// Paper engine: a simulated Jupiter Perps position driven by real prices. Uses Jupiter's
// liquidation formula and fee schedule so practice headway matches live headway.
// Also provides preview() for ghost mode (pure, never mutates state), paper limit orders, the
// simulated win fee (Update 2: practice pays nothing but logs what it would have been), and a
// recent-trades list. Messages are in plain units (Update 6).
import {
  MAX_LEV_TRADE, MIN_LEV_TRADE, closeFeeUsd, isLiquidated, liquidationPrice, openFeeUsd, pnlUsd,
} from '../../shared/jupiter.js';
import { MARKET_PRICING, previewPosition } from '../../shared/preview.js';
import { money, pct, price as fmtPrice, smoney, sol } from '../../shared/format.js';
import { MARKETS, type Market, type OpenParams, type PedalAction, type PedalStep, type PendingOrder, type PositionState, type Side, type TradeRecord } from '../../shared/types.js';
import type { Engine, EngineEvent, GhostPreview, PedalResult } from './types.js';

export { MARKET_PRICING, previewPosition };

export const MIN_COLLATERAL_USD = 10;
/** Default hourly borrow rate when pool-info is unavailable: 0.0016%/h (SOL longs, Oct 2026). */
export const DEFAULT_HOURLY_RATE = 0.0016 / 100;

let closeSeq = 0;
function closeId(): string { return `${Date.now()}-${++closeSeq}`; }

export class PaperEngine implements Engine {
  readonly kind = 'paper' as const;
  position: PositionState | null = null;
  pendingOrder: PendingOrder | null = null;
  bankrollUsd: number;
  pricing = MARKET_PRICING;
  /** Sum of simulated win fees this run (shown on the HUD, never deducted). */
  /** Recent paper trades, newest first (in memory only). */
  recentTrades: TradeRecord[] = [];
  private lastTickT: number | null = null;
  private stopArmed = false;

  constructor(bankrollUsd = 1000) {
    this.bankrollUsd = bankrollUsd;
  }

  freeCollateralUsd(): number {
    return this.bankrollUsd;
  }

  reset(): void {
    this.position = null;
    this.pendingOrder = null;
    this.lastTickT = null;
    this.stopArmed = false;
  }

  setBankroll(usd: number): void {
    this.bankrollUsd = Math.max(0, usd);
  }

  preview(market: Market, g: GhostPreview, price: number): PositionState {
    return previewPosition(market, g, price);
  }

  private record(t: TradeRecord): void {
    this.recentTrades.unshift(t);
    if (this.recentTrades.length > 50) this.recentTrades.length = 50;
  }

  private recompute(p: PositionState): void {
    p.closeFeeUsd = closeFeeUsd(p.sizeUsd, this.pricing[p.market]);
    p.leverage = p.collateralUsd > 0 ? p.sizeUsd / p.collateralUsd : Infinity;
    p.liq = liquidationPrice({
      side: p.side, entry: p.entry, sizeUsd: p.sizeUsd, collateralUsd: p.collateralUsd,
      closeFeeUsd: p.closeFeeUsd, borrowFeeUsd: p.borrowFeeUsd,
    });
  }

  private dp(market: Market): number { return MARKETS[market].priceDp; }
  private asset(market: Market): string { return MARKETS[market].asset; }

  private validate(params: OpenParams, price: number): string | null {
    if (this.position) return 'A position is already open. Close it first.';
    if (!(price > 0)) return 'No price yet.';
    if (!(params.leverage >= MIN_LEV_TRADE && params.leverage <= MAX_LEV_TRADE)) return `Leverage must be between ${MIN_LEV_TRADE}x and ${MAX_LEV_TRADE}x.`;
    if (!(params.collateralUsd >= MIN_COLLATERAL_USD)) return `Minimum collateral is ${money(MIN_COLLATERAL_USD)}.`;
    if (params.collateralUsd > this.bankrollUsd + 1e-9) return `Not enough practice bankroll (${money(this.bankrollUsd)}).`;
    return null;
  }

  async open(params: OpenParams, price: number): Promise<PedalResult> {
    const err = this.validate(params, price);
    if (err) return { ok: false, message: err };
    if (params.entry !== undefined && params.entry !== null && Math.abs(params.entry - price) / price > 1e-6) {
      return this.placeLimit(params, price);
    }
    return this.fill(params, price, price, 'opened');
  }

  private fill(params: OpenParams, fillPrice: number, markPrice: number, kind: 'opened' | 'order_filled'): PedalResult {
    const { market, side, leverage, collateralUsd } = params;
    const sizeUsd = collateralUsd * leverage;
    const fee = openFeeUsd(sizeUsd, this.pricing[market]);
    const p: PositionState = {
      market, side, entry: fillPrice, sizeUsd,
      collateralUsd: collateralUsd - fee,
      openedAt: Date.now(),
      borrowFeeUsd: 0, closeFeeUsd: 0, liq: 0, leverage: 0, realizedPnlUsd: 0,
      contributedUsd: collateralUsd, returnedUsd: 0, trailingStop: null,
    };
    this.recompute(p);
    if (isLiquidated(side, markPrice, p.liq)) return { ok: false, message: 'Position would be liquidated immediately at this leverage.' };
    this.bankrollUsd -= collateralUsd;
    this.position = p;
    this.pendingOrder = null;
    this.lastTickT = null;
    this.stopArmed = false;
    const dp = this.dp(market);
    const msg = `${kind === 'order_filled' ? 'Limit filled: ' : 'Opened '}${side === 1 ? 'LONG' : 'SHORT'} ${money(sizeUsd, 0)} (${sol(sizeUsd / fillPrice, this.asset(market))}) at ${fmtPrice(fillPrice, dp)} · liq ${fmtPrice(p.liq, dp)} · ${p.leverage.toFixed(1)}x · open fee ${money(fee)}`;
    this.record({ t: p.openedAt, action: kind === 'order_filled' ? 'limit fill' : 'open', market, side, sizeUsd, price: fillPrice, pnlUsd: null, feeUsd: fee });
    return { ok: true, message: msg, events: [{ kind, message: msg, detail: { ...p, openFeeUsd: fee } }] };
  }

  private placeLimit(params: OpenParams, price: number): PedalResult {
    const trigger = params.entry as number;
    if (params.side === -1 && trigger <= price) return { ok: false, message: 'A short limit must be above the current price.' };
    if (params.side === 1 && trigger >= price) return { ok: false, message: 'A long limit must be below the current price.' };
    this.pendingOrder = {
      id: closeId(), market: params.market, side: params.side, leverage: params.leverage,
      collateralUsd: params.collateralUsd, triggerPrice: trigger, placedAt: Date.now(),
    };
    const dp = this.dp(params.market);
    const msg = `Limit placed: ${params.side === 1 ? 'LONG' : 'SHORT'} ${params.leverage.toFixed(1)}x at ${fmtPrice(trigger, dp)} (now ${fmtPrice(price, dp)})`;
    return { ok: true, message: msg, events: [{ kind: 'order_placed', message: msg, detail: this.pendingOrder }] };
  }

  async cancelOrder(): Promise<PedalResult> {
    if (!this.pendingOrder) return { ok: false, message: 'No pending order.' };
    const o = this.pendingOrder;
    this.pendingOrder = null;
    return { ok: true, message: 'Order cancelled.', events: [{ kind: 'order_cancelled', message: `Cancelled limit at ${fmtPrice(o.triggerPrice, this.dp(o.market))}`, detail: o }] };
  }

  tick(t: number, price: number, hourlyRate: number | null): EngineEvent[] {
    const events: EngineEvent[] = [];
    const o = this.pendingOrder;
    if (o && !this.position) {
      const crossed = o.side === -1 ? price >= o.triggerPrice : price <= o.triggerPrice;
      if (crossed) {
        const r = this.fill({ market: o.market, side: o.side, leverage: o.leverage, collateralUsd: o.collateralUsd }, o.triggerPrice, price, 'order_filled');
        if (r.ok) events.push(...(r.events ?? []));
        else { this.pendingOrder = null; events.push({ kind: 'order_cancelled', message: `Limit could not fill: ${r.message}` }); }
      }
    }
    const p = this.position;
    if (!p) { this.lastTickT = t; return events; }
    if (this.lastTickT !== null && t > this.lastTickT) {
      const hours = (t - this.lastTickT) / 3_600_000;
      p.borrowFeeUsd += p.sizeUsd * (hourlyRate ?? DEFAULT_HOURLY_RATE) * hours;
      this.recompute(p);
    }
    this.lastTickT = t;

    if (isLiquidated(p.side, price, p.liq)) {
      const lost = p.collateralUsd;
      const dp = this.dp(p.market);
      this.position = null;
      this.record({ t, action: 'liquidation', market: p.market, side: p.side, sizeUsd: p.sizeUsd, price, pnlUsd: -lost, feeUsd: lost });
      events.push({
        kind: 'liquidated',
        message: `LIQUIDATED at ${fmtPrice(price, dp)} (liq ${fmtPrice(p.liq, dp)}) · ${money(lost)} collateral forfeited`,
        detail: { price, liq: p.liq, lostUsd: lost, realizedUsd: -lost, feesUsd: 0, returnedUsd: 0, lifetimeUsd: -p.contributedUsd + p.returnedUsd },
      });
      return events;
    }

    if (p.trailingStop) {
      const d = p.trailingStop.distance / p.leverage; // car lengths -> price fraction
      if (p.side === -1) {
        const candidate = price * (1 + d);
        if (candidate < p.trailingStop.price) p.trailingStop.price = candidate;
        if (this.stopArmed && price >= p.trailingStop.price) events.push(...this.closeAll(price, 'stop_hit'));
      } else {
        const candidate = price * (1 - d);
        if (candidate > p.trailingStop.price) p.trailingStop.price = candidate;
        if (this.stopArmed && price <= p.trailingStop.price) events.push(...this.closeAll(price, 'stop_hit'));
      }
      this.stopArmed = true;
    }
    return events;
  }

  private closeAll(price: number, kind: 'closed' | 'stop_hit'): EngineEvent[] {
    const p = this.position;
    if (!p) return [];
    const pnl = pnlUsd(p.side, p.entry, price, p.sizeUsd);
    const fees = p.closeFeeUsd + p.borrowFeeUsd;
    const realized = pnl - fees;
    const out = Math.max(0, p.collateralUsd + realized);
    p.returnedUsd += out;
    p.realizedPnlUsd += realized;
    this.bankrollUsd += out;
    this.position = null;
    const lifetime = p.returnedUsd - p.contributedUsd;
    const dp = this.dp(p.market);
    const msg = kind === 'stop_hit'
      ? `Trailing stop filled at ${fmtPrice(price, dp)} · realized ${smoney(realized)} after fees · lifetime ${smoney(lifetime)}`
      : `Closed at ${fmtPrice(price, dp)} · realized ${smoney(realized)} after fees (${pct((realized / p.contributedUsd) * 100, true)} on collateral) · lifetime ${smoney(lifetime)}`;
    this.record({ t: Date.now(), action: kind === 'stop_hit' ? 'stop' : 'close', market: p.market, side: p.side, sizeUsd: p.sizeUsd, price, pnlUsd: realized, feeUsd: fees });
    const events: EngineEvent[] = [{ kind, message: msg, detail: { price, pnlUsd: pnl, feesUsd: fees, realizedUsd: realized, returnedUsd: out, lifetimeUsd: lifetime, position: p } }];
    return events;
  }

  async pedal(action: PedalAction, price: number, steps: PedalStep, _maxSlippageBps?: number): Promise<PedalResult> {
    const p = this.position;
    if (!p) return { ok: false, message: 'No open position.' };
    if (!(price > 0)) return { ok: false, message: 'No price yet.' };
    const pricing = this.pricing[p.market];
    const side: Side = p.side;
    const dp = this.dp(p.market);
    const asset = this.asset(p.market);

    switch (action) {
      case 'gas_light': {
        const delta = p.sizeUsd * steps.gasSizeFrac;
        const collateralDelta = delta / p.leverage;
        if (collateralDelta > this.bankrollUsd) return { ok: false, message: `Not enough available: ${money(collateralDelta)} needed, ${money(this.bankrollUsd)} free.` };
        const fee = openFeeUsd(delta, pricing);
        const liq0 = p.liq;
        p.entry = (p.sizeUsd * p.entry + delta * price) / (p.sizeUsd + delta);
        p.sizeUsd += delta;
        p.collateralUsd += collateralDelta - fee;
        p.contributedUsd += collateralDelta;
        this.bankrollUsd -= collateralDelta;
        this.recompute(p);
        this.record({ t: Date.now(), action: 'increase', market: p.market, side, sizeUsd: delta, price, pnlUsd: null, feeUsd: fee });
        return this.adjusted(`Added ${money(delta, 0)} size (${sol(delta / price, asset)}) + ${money(collateralDelta)} collateral · liq ${fmtPrice(liq0, dp)} → ${fmtPrice(p.liq, dp)} · fee ${money(fee)}`, { delta, collateralDelta, fee });
      }
      case 'gas_hard': {
        const delta = p.sizeUsd * steps.gasSizeFrac;
        const fee = openFeeUsd(delta, pricing);
        const newLev = (p.sizeUsd + delta) / (p.collateralUsd - fee);
        if (newLev > MAX_LEV_TRADE) return { ok: false, message: `Would exceed ${MAX_LEV_TRADE}x.` };
        const trial: PositionState = { ...p, sizeUsd: p.sizeUsd + delta, collateralUsd: p.collateralUsd - fee,
          entry: (p.sizeUsd * p.entry + delta * price) / (p.sizeUsd + delta) };
        this.recompute(trial);
        if (isLiquidated(side, price, trial.liq)) return { ok: false, message: 'That would liquidate you immediately.' };
        const lev0 = p.leverage, liq0 = p.liq;
        Object.assign(p, trial);
        this.record({ t: Date.now(), action: 'increase', market: p.market, side, sizeUsd: delta, price, pnlUsd: null, feeUsd: fee });
        return this.adjusted(`Added ${money(delta, 0)} size, no collateral · leverage ${lev0.toFixed(1)}x → ${p.leverage.toFixed(1)}x · liq ${fmtPrice(liq0, dp)} → ${fmtPrice(p.liq, dp)} (closer)`, { delta, fee });
      }
      case 'coast': {
        const delta = Math.max(1, p.collateralUsd * steps.coastCollateralFrac);
        if (delta > this.bankrollUsd) return { ok: false, message: `Not enough available: ${money(delta)} needed, ${money(this.bankrollUsd)} free.` };
        const liq0 = p.liq, lev0 = p.leverage;
        p.collateralUsd += delta - p.borrowFeeUsd;
        p.borrowFeeUsd = 0;
        p.contributedUsd += delta;
        this.bankrollUsd -= delta;
        this.recompute(p);
        this.record({ t: Date.now(), action: 'add collateral', market: p.market, side, sizeUsd: 0, price, pnlUsd: null, feeUsd: 0 });
        return this.adjusted(`Added ${money(delta)} collateral · leverage ${lev0.toFixed(1)}x → ${p.leverage.toFixed(1)}x · liq ${fmtPrice(liq0, dp)} → ${fmtPrice(p.liq, dp)} (farther)`, { delta });
      }
      case 'brake_light': {
        const closeSize = Math.min(p.sizeUsd, p.sizeUsd * steps.brakeSizeFrac);
        const frac = closeSize / p.sizeUsd;
        if (frac >= 0.999 || p.sizeUsd - closeSize < 1) return { ok: true, message: 'Closing all.', events: this.closeAll(price, 'closed') };
        const pnlPart = pnlUsd(side, p.entry, price, closeSize);
        const feePart = closeFeeUsd(closeSize, pricing) + p.borrowFeeUsd;
        const collateralOut = p.collateralUsd * frac;
        let transfer = collateralOut + pnlPart - feePart;
        p.collateralUsd -= collateralOut;
        if (transfer < 0) { p.collateralUsd += transfer; transfer = 0; }
        p.sizeUsd -= closeSize;
        p.borrowFeeUsd = 0;
        const realized = pnlPart - feePart;
        p.realizedPnlUsd += realized;
        p.returnedUsd += transfer;
        this.bankrollUsd += transfer;
        this.recompute(p);
        this.record({ t: Date.now(), action: 'decrease', market: p.market, side, sizeUsd: closeSize, price, pnlUsd: realized, feeUsd: feePart });
        const r = this.adjusted(`Closed ${Math.round(frac * 100)}% (${money(closeSize)}, ${sol(closeSize / price, asset)}) · realized ${smoney(realized)} · remaining ${money(p.sizeUsd, 0)}`, { closeSize, pnlPart, feePart, transfer });
        return r;
      }
      case 'brake_full':
        return { ok: true, message: 'Closing all.', events: this.closeAll(price, 'closed') };
      case 'withdraw': {
        const delta = p.collateralUsd * steps.withdrawFrac;
        const trial: PositionState = { ...p, collateralUsd: p.collateralUsd - delta };
        this.recompute(trial);
        if (trial.leverage > MAX_LEV_TRADE) return { ok: false, message: `Would exceed ${MAX_LEV_TRADE}x.` };
        if (isLiquidated(side, price, trial.liq)) return { ok: false, message: 'That would liquidate you immediately.' };
        const liq0 = p.liq;
        Object.assign(p, trial);
        p.returnedUsd += delta;
        this.bankrollUsd += delta;
        this.record({ t: Date.now(), action: 'withdraw collateral', market: p.market, side, sizeUsd: 0, price, pnlUsd: null, feeUsd: 0 });
        return {
          ok: true,
          message: `Withdrew ${money(delta)} collateral · liq ${fmtPrice(liq0, dp)} → ${fmtPrice(p.liq, dp)} (closer) · ${p.leverage.toFixed(1)}x`,
          events: [{ kind: 'warn', message: `Withdrew ${money(delta)} · liq now ${fmtPrice(p.liq, dp)}`, detail: { delta } }],
        };
      }
      case 'cruise': {
        const d = steps.cruiseDistance / p.leverage;
        const stopPrice = side === -1 ? price * (1 + d) : price * (1 - d);
        p.trailingStop = { distance: steps.cruiseDistance, price: stopPrice };
        this.stopArmed = false;
        return {
          ok: true,
          message: `Trailing stop set at ${fmtPrice(stopPrice, dp)} (${pct(d * 100)} behind the price, follows it)`,
          events: [{ kind: 'stop_set', message: `Trailing stop at ${fmtPrice(stopPrice, dp)}`, detail: p.trailingStop }],
        };
      }
      case 'cruise_off':
        p.trailingStop = null;
        return { ok: true, message: 'Trailing stop removed.', events: [{ kind: 'info', message: 'Trailing stop removed' }] };
      default:
        return { ok: false, message: `Unknown pedal ${String(action)}` };
    }
  }

  private adjusted(message: string, detail: unknown): PedalResult {
    return { ok: true, message, events: [{ kind: 'adjusted', message, detail }] };
  }
}
