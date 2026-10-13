// Polls Jupiter's perps API market-stats for the oracle price. Low rate (every 3 s). Used as a
// price source of last resort and as the oracle reference when the primary feed is Coinbase.
import { MARKETS, type Market } from '../../shared/types.js';
import { PriceSource } from './types.js';
import { ENV } from '../config.js';

export class JupiterRefSource extends PriceSource {
  readonly name = 'jupiter';
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  constructor(private intervalMs = 3000) { super(); }

  start(market: Market): void {
    this.stopped = false;
    this.market = market;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setConnected(false);
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.market) return;
    try {
      const mint = MARKETS[this.market].mint;
      const res = await fetch(`${ENV.jupApi}/market-stats?mint=${mint}`);
      if (!res.ok) throw new Error(`market-stats ${res.status}`);
      const json = (await res.json()) as { price?: string };
      const price = Number(json.price);
      if (Number.isFinite(price) && price > 0) {
        this.setConnected(true);
        this.pushTick({ t: Date.now(), price, source: this.name });
      }
    } catch (err) {
      this.setConnected(false);
      this.emit('error', err as Error);
    }
  }
}
