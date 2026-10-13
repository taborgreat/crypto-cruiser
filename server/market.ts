// Multi-user (Update 27): the market layer is shared, the driver is not.
//
// One MarketCore per market holds what every viewer of that market reads the same way: the price feed
// (one websocket set, one tick log), the candle/ATR layers and the order-flow classifier. Sessions
// (one per browser login, see session.ts) attach to a core and keep everything personal on their own
// side: engines, trading wallet, ghosts, exits, horizon, rewind, settings.
//
// The hub creates cores on demand and stops them a minute after the last session has left, so a
// market nobody is looking at costs nothing.
import { EventEmitter } from 'node:events';
import type { FlowEvent, Market, Settings, Tick } from '../shared/types.js';
import { FeedManager } from './feed/manager.js';
import { LayerManager } from './layers.js';
import { log } from './log.js';

const IDLE_STOP_MS = 60_000;

export class MarketCore extends EventEmitter {
  feed = new FeedManager();
  layers = new LayerManager();
  ready: Promise<void>;
  users = 0;
  /** Update 20: order flow for the crowd: the last minute's sizes (median), per-minute counts (the hour's rate). */
  private flowSizes: Array<{ t: number; size: number }> = [];
  private flowMinute = new Array<number>(60).fill(0);
  private flowMinuteIdx = -1;
  private stopTimer: NodeJS.Timeout | null = null;

  constructor(readonly market: Market, pref: Settings['feed'], atrWindow: number) {
    super();
    this.setMaxListeners(100);
    this.feed.on('tick', (t: Tick) => {
      this.layers.onTick(t);
      this.layers.divergence = this.feed.divergence();
      this.feed.candleCount = this.layers.c1m.candles.length;
      this.emit('tick', t);
    });
    this.feed.on('quote', (t: Tick) => this.layers.onQuote(t));
    this.feed.on('anim', (a: Tick) => this.emit('anim', a, this.onFlow(a)));
    this.ready = this.boot(pref, atrWindow);
  }

  private async boot(pref: Settings['feed'], atrWindow: number): Promise<void> {
    this.feed.start(this.market, pref);
    const rows = await FeedManager.loadHistory(this.market);
    this.feed.seedHistory(rows);
    await this.layers.init(this.market, this.feed.history, atrWindow);
  }

  restartFeed(pref: Settings['feed']): void {
    this.feed.start(this.market, pref);
  }

  /** One print classified: size against the last minute's median, busyness against the last hour. */
  private onFlow(a: Tick): FlowEvent | null {
    if (!a.side || a.size === undefined || !(a.size > 0)) return null;
    const t = a.t;
    this.flowSizes.push({ t, size: a.size });
    while (this.flowSizes.length && this.flowSizes[0].t < t - 60_000) this.flowSizes.shift();
    const sorted = this.flowSizes.map((x) => x.size).sort((p, q) => p - q);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : a.size;
    const mi = Math.floor(t / 60_000) % 60;
    if (mi !== this.flowMinuteIdx) { this.flowMinute[mi] = 0; this.flowMinuteIdx = mi; }
    this.flowMinute[mi]++;
    const hourRate = this.flowMinute.reduce((s, n) => s + n, 0) / 3600;
    let n10 = 0;
    for (let i = this.flowSizes.length - 1; i >= 0 && this.flowSizes[i].t >= t - 10_000; i--) n10++;
    const busy = hourRate > 0 ? Math.max(0, Math.min(3, n10 / 10 / hourRate)) : 1;
    return { t, side: a.side === 'buy' ? 1 : -1, size: a.size, sizeUsd: a.size * a.price, ratio: median > 0 ? a.size / median : 1, busy };
  }

  attach(): void {
    this.users++;
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
  }

  /** Returns true when the core scheduled its own stop (nobody left). */
  detach(onIdle: () => void): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0 || this.stopTimer) return;
    this.stopTimer = setTimeout(() => { this.stopTimer = null; if (this.users === 0) onIdle(); }, IDLE_STOP_MS);
  }

  stop(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.feed.stop();
    this.layers.stop();
    this.removeAllListeners();
    log.info('market', `stopped ${this.market}`);
  }
}

export class MarketHub {
  private cores = new Map<Market, MarketCore>();

  /** The core for a market, started on first use. The caller must `release` it when done. */
  acquire(market: Market, pref: Settings['feed'], atrWindow: number): MarketCore {
    let c = this.cores.get(market);
    if (!c) {
      c = new MarketCore(market, pref, atrWindow);
      this.cores.set(market, c);
      log.info('market', `started ${market}`);
    }
    c.attach();
    return c;
  }

  release(core: MarketCore): void {
    core.detach(() => {
      if (this.cores.get(core.market) === core) this.cores.delete(core.market);
      core.stop();
    });
  }

  stopAll(): void {
    for (const c of this.cores.values()) c.stop();
    this.cores.clear();
  }
}
