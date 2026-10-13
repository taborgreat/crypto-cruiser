// Coinbase Exchange public ticker feed. No key needed, 1-10 updates/s, includes best bid/ask.
// Used as the fallback feed and as the spread ("fog") source.
import WebSocket from 'ws';
import { MARKETS, type Market } from '../../shared/types.js';
import { PriceSource } from './types.js';
import { log } from '../log.js';

const URL = 'wss://ws-feed.exchange.coinbase.com';

export class CoinbaseSource extends PriceSource {
  readonly name = 'coinbase';
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 1000;
  private product = 'SOL-USD';
  private watchdog: NodeJS.Timeout | null = null;

  start(market: Market): void {
    this.stopped = false;
    this.market = market;
    this.product = MARKETS[market].coinbase;
    this.connect();
    this.watchdog = setInterval(() => {
      // Coinbase sends heartbeats; if nothing for 30 s, reconnect.
      if (this.lastTick && Date.now() - this.lastTick.t > 30_000 && this.ws) {
        log.warn('coinbase', 'stale, reconnecting');
        try { this.ws.terminate(); } catch { /* ignore */ }
      }
    }, 10_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.setConnected(false);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: [this.product], channels: ['ticker', 'heartbeat'] }));
      this.setConnected(true);
      log.info('coinbase', 'connected', this.product);
    });
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'ticker') return;
      const price = Number(msg.price);
      if (!Number.isFinite(price) || price <= 0) return;
      const bid = Number(msg.best_bid);
      const ask = Number(msg.best_ask);
      this.pushTick({
        t: Date.now(),
        price,
        bid: Number.isFinite(bid) ? bid : undefined,
        ask: Number.isFinite(ask) ? ask : undefined,
        source: this.name,
      });
    });
    const retry = () => {
      this.setConnected(false);
      if (this.stopped) return;
      const wait = this.backoff;
      this.backoff = Math.min(30_000, this.backoff * 2);
      setTimeout(() => this.connect(), wait);
    };
    ws.on('close', retry);
    ws.on('error', (err) => {
      log.warn('coinbase', err.message);
      this.emit('error', err);
      try { ws.terminate(); } catch { /* ignore */ }
    });
  }
}
