// Market layers (spec 3.5 / phase 3). Each layer is optional and degrades to null.
//  - candles at every chart interval (1 s .. 1 d) aggregated locally from the tick history (Update 5)
//  - ATR / traffic density and swing hills: from the 1 m candles (and ATR 5 m for the tooltips)
//  - funding / road grade: Jupiter pool-info hourly borrow rate for our side (polled every 60 s; not a price)
//  - spread / fog: best bid/ask from the Coinbase stream; divergence oracle vs secondary feed also fogs
//  - walls / liquidation clusters: not available for an oracle-priced pool; reported empty.
import { CANDLE_INTERVALS, CandleBuilder, ONE_MINUTE, atrFraction, candleIndexAt, detectSwings, projectHills, type Candle, type CandleInterval, type Swing } from '../shared/candles.js';
import { MARKETS, type Layers, type Market, type Settings, type Side, type Tick } from '../shared/types.js';
import type { TickHistory } from '../shared/ring.js';
import { fetchExchangeCandles } from './feed/history.js';
import { ENV } from './config.js';
import { log } from './log.js';

interface PoolInfo {
  longRatePct: number;   // hourly, percent
  shortRatePct: number;
  longUtilPct: number;
  shortUtilPct: number;
  longLiquidity: number;
  shortLiquidity: number;
  maxImpactPct: number;
  t: number;
}

/** Candles kept per interval (seconds -> count). */
const CAPS: Record<CandleInterval, number> = {
  1: 3600, 5: 2880, 15: 2880, 60: 11_520, 300: 2304, 900: 768, 3600: 192, 14_400: 48, 86_400: 10,
};

export class LayerManager {
  builders = new Map<CandleInterval, CandleBuilder>();
  pool: PoolInfo | null = null;
  market: Market | null = null;
  private poolTimer: NodeJS.Timeout | null = null;
  private spread: number | null = null;
  private spreadT = 0;
  divergence: number | null = null;
  seededFrom: 'log' | 'exchange' | 'none' = 'none';

  constructor() {
    this.resetBuilders();
  }

  private resetBuilders(): void {
    this.builders.clear();
    for (const sec of CANDLE_INTERVALS) this.builders.set(sec, new CandleBuilder(sec * 1000, CAPS[sec]));
  }

  get c1m(): CandleBuilder { return this.builders.get(60)!; }

  /** @param history the tick history (Update 1: candles are built locally). */
  async init(market: Market, history: TickHistory, atrWindow: number): Promise<void> {
    this.stop();
    this.market = market;
    const first = history.first(), last = history.last();
    if (first && last) {
      let n = 0;
      for (const [t, p] of history.between(first.t, last.t)) {
        for (const b of this.builders.values()) b.pushRaw(t, p);
        n++;
      }
      this.seededFrom = n ? 'log' : 'none';
      log.info('layers', `rebuilt candles from ${n} ticks (${this.c1m.candles.length} × 1m) for ${market}`);
    }
    if (ENV.seedCandles === 'exchange' && this.c1m.candles.length < atrWindow + 1) {
      try {
        const hist = await fetchExchangeCandles(market);
        if (hist.length) {
          this.c1m.seed(hist);
          this.seededFrom = 'exchange';
          log.info('layers', `seeded ${hist.length} 1m candles from exchange (SEED_CANDLES=exchange)`);
        }
      } catch (err) {
        log.warn('layers', 'exchange seed failed', (err as Error).message);
      }
    }
    void this.pollPool();
    this.poolTimer = setInterval(() => void this.pollPool(), 60_000);
  }

  stop(): void {
    if (this.poolTimer) clearInterval(this.poolTimer);
    this.poolTimer = null;
    this.resetBuilders();
    this.pool = null;
    this.spread = null;
    this.divergence = null;
  }

  onTick(t: Tick): void {
    for (const b of this.builders.values()) b.pushRaw(t.t, t.price);
    this.onQuote(t);
  }

  onQuote(t: Tick): void {
    if (t.bid !== undefined && t.ask !== undefined && t.bid > 0 && t.ask >= t.bid) {
      const mid = (t.bid + t.ask) / 2;
      this.spread = (t.ask - t.bid) / mid;
      this.spreadT = t.t;
    }
  }

  candles(intervalSec: number): Candle[] {
    return this.builders.get(intervalSec as CandleInterval)?.candles ?? this.c1m.candles;
  }

  private async pollPool(): Promise<void> {
    if (!this.market) return;
    try {
      const mint = MARKETS[this.market].mint;
      const res = await fetch(`${ENV.jupApi}/pool-info?mint=${mint}`);
      if (!res.ok) throw new Error(`pool-info ${res.status}`);
      const j = (await res.json()) as Record<string, string>;
      this.pool = {
        longRatePct: Number(j.longBorrowRatePercent),
        shortRatePct: Number(j.shortBorrowRatePercent),
        longUtilPct: Number(j.longUtilizationPercent),
        shortUtilPct: Number(j.shortUtilizationPercent),
        longLiquidity: Number(j.longAvailableLiquidity),
        shortLiquidity: Number(j.shortAvailableLiquidity),
        maxImpactPct: Number(j.maxPriceImpactFeePercent),
        t: Date.now(),
      };
    } catch (err) {
      log.warn('layers', 'pool-info', (err as Error).message);
    }
  }

  /** Hourly borrow rate as a fraction for the given side, or null if unknown. */
  hourlyRate(side: Side): number | null {
    if (!this.pool) return null;
    const pct = side === 1 ? this.pool.longRatePct : this.pool.shortRatePct;
    return Number.isFinite(pct) ? pct / 100 : null;
  }

  utilization(side: Side): number | null {
    if (!this.pool) return null;
    const pct = side === 1 ? this.pool.longUtilPct : this.pool.shortUtilPct;
    return Number.isFinite(pct) ? pct / 100 : null;
  }

  atr(window: number): number | null {
    return atrFraction(this.c1m.candles, window);
  }

  /** 1 m candles as of `t` (for the rewind) or all of them. */
  private oneMinuteAsOf(t: number | null): Candle[] {
    const all = this.c1m.candles;
    if (t === null) return all;
    const i = candleIndexAt(all, t);
    return i < 0 ? [] : all.slice(Math.max(0, i - 600), i + 1);
  }

  swings(settings: Settings, asOf: number | null = null): Swing[] {
    return detectSwings(this.oneMinuteAsOf(asOf), settings.swingLookback, 3);
  }

  compute(price: number, side: Side, leverage: number, t: number, settings: Settings, asOf: number | null = null): Layers {
    const c1 = this.oneMinuteAsOf(asOf);
    const atr = atrFraction(c1, settings.atrWindow);
    const c5all = this.candles(300);
    const c5 = asOf === null ? c5all : c5all.slice(0, candleIndexAt(c5all, asOf) + 1);
    const atr5m = atrFraction(c5, settings.atrWindow);
    const swings = detectSwings(c1, settings.swingLookback, 3);
    const hills = projectHills(swings, price, side, leverage, t);
    const spreadFresh = asOf === null && this.spread !== null && t - this.spreadT < 30_000;
    return {
      atr,
      atr_rate: atr === null ? null : atr / 60,
      atr5m,
      funding: this.hourlyRate(side),
      utilization: this.utilization(side),
      oi: null,
      spread: spreadFresh ? this.spread : null,
      divergence: asOf === null ? this.divergence : null,
      hills,
      walls: [],
      liq_clusters: [],
    };
  }
}
