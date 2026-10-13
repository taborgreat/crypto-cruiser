// Optional secondary feed: Pyth Hermes SSE stream (one connection, pushes every ~400 ms).
// Hermes requires an API key since 2026; set PYTH_API_KEY (and PYTH_HERMES_URL for a provider mirror).
// Used as a cross-check (divergence -> fog) and to keep the car moving if the oracle subscription drops.
import { MARKETS, type Market } from '../../shared/types.js';
import { PriceSource } from './types.js';
import { ENV } from '../config.js';
import { log } from '../log.js';

export class HermesSource extends PriceSource {
  readonly name = 'hermes';
  private stopped = false;
  private abort: AbortController | null = null;
  private backoff = 1000;

  start(market: Market): void {
    this.stopped = false;
    this.market = market;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    this.setConnected(false);
  }

  private async run(): Promise<void> {
    if (this.stopped || !this.market) return;
    const id = MARKETS[this.market].pythId;
    const url = `${ENV.pythHermesUrl}/v2/updates/price/stream?ids[]=${id}&parsed=true&allow_unordered=true`;
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (ENV.pythApiKey) headers.authorization = `Bearer ${ENV.pythApiKey}`;
    this.abort = new AbortController();
    try {
      const res = await fetch(url, { headers, signal: this.abort.signal });
      if (!res.ok || !res.body) throw new Error(`hermes ${res.status}${res.status === 401 ? ' (API key required: set PYTH_API_KEY)' : ''}`);
      this.setConnected(true);
      this.backoff = 1000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const j = JSON.parse(line.slice(5).trim()) as { parsed?: Array<{ price?: { price: string; expo: number; publish_time: number } }> };
              const p = j.parsed?.[0]?.price;
              if (!p) continue;
              const price = Number(p.price) * Math.pow(10, p.expo);
              if (price > 0) this.pushTick({ t: Date.now(), price, source: this.name });
            } catch { /* skip */ }
          }
        }
      }
      throw new Error('stream ended');
    } catch (err) {
      if (this.stopped) return;
      this.setConnected(false);
      const msg = (err as Error).message;
      if (!/aborted/i.test(msg)) {
        log.warn('hermes', msg);
        this.emit('error', err as Error);
      }
      const wait = this.backoff;
      this.backoff = Math.min(60_000, this.backoff * 2);
      setTimeout(() => void this.run(), wait);
    }
  }
}
