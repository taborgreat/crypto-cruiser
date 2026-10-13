// Jupiter Perps' own oracle: the Doves aggregated price feed ("AgPriceFeed") accounts, referenced from
// each market's custody account via `dovesAgOracle`. This is the price the liquidation engine sees.
// Read via the shared RPC websocket (accountSubscribe, push). Verified Oct 2026: ~2 updates/second on
// the public mainnet RPC. A JSON-RPC read is used only as a backstop after 5 s of silence.
import type { Market } from '../../shared/types.js';
import { decodeAgPriceFeed } from '../../shared/solana.js';
import { PriceSource } from './types.js';
import { getAccountData, rpcSubscriber } from './rpcws.js';
import { log } from '../log.js';

export const DOVES_AG_FEEDS: Record<Market, string> = {
  'SOL-PERP': 'FYq2BWQ1V5P1WFBqr3qB2Kb5yHVvSv7upzKodgQE5zXh',
  'ETH-PERP': 'AFZnHPzy4mvVCffrVwhewHbFc93uTHvDSFrVH7GtfXF1',
  'BTC-PERP': 'hUqAT1KQ7eW1i6Csp9CXYtpPfSAvi835V7wKi5fRfmC',
};

export { decodeAgPriceFeed };

export class DovesSource extends PriceSource {
  readonly name = 'doves';
  private unsub: (() => void) | null = null;
  private stopped = false;
  private account = DOVES_AG_FEEDS['SOL-PERP'];
  private backstop: NodeJS.Timeout | null = null;
  private lastOracleTs = 0;
  private lastPrice = 0;

  start(market: Market): void {
    this.stopped = false;
    this.market = market;
    this.account = DOVES_AG_FEEDS[market];
    const rpc = rpcSubscriber();
    this.unsub = rpc.subscribe(this.account, (data) => {
      const p = decodeAgPriceFeed(data);
      if (p) this.accept(p.price, p.timestamp);
    });
    rpc.on('status', this.onRpcStatus);
    this.setConnected(rpc.connected);
    log.info('doves', 'subscribed', market, this.account);
    // Backstop: one read if the push stream has been silent for 5 s (RPC hiccup), never a price poll.
    this.backstop = setInterval(() => void this.check(), 2500);
  }

  private onRpcStatus = (s: { connected: boolean }) => {
    if (!s.connected) this.setConnected(false);
  };

  stop(): void {
    this.stopped = true;
    if (this.unsub) this.unsub();
    this.unsub = null;
    rpcSubscriber().off('status', this.onRpcStatus);
    if (this.backstop) clearInterval(this.backstop);
    this.backstop = null;
    this.setConnected(false);
  }

  private accept(price: number, ts: number): void {
    if (ts < this.lastOracleTs) return;
    if (ts === this.lastOracleTs && price === this.lastPrice) return;
    this.lastOracleTs = ts;
    this.lastPrice = price;
    this.setConnected(true);
    this.pushTick({ t: Date.now(), price, source: this.name });
  }

  private async check(): Promise<void> {
    if (this.stopped) return;
    const age = this.ageMs();
    if (age !== null && age < 5000) return;
    try {
      const data = await getAccountData(this.account);
      if (data) {
        const p = decodeAgPriceFeed(data);
        if (p) this.accept(p.price, p.timestamp);
      }
    } catch (err) {
      this.emit('error', err as Error);
    }
  }
}
