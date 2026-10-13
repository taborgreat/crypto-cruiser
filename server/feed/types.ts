import { EventEmitter } from 'node:events';
import type { Market, Tick } from '../../shared/types.js';

/**
 * A price source emits:
 *   'tick'   (tick: Tick)
 *   'status' ({ connected: boolean })
 *   'error'  (err: Error)
 */
export abstract class PriceSource extends EventEmitter {
  abstract readonly name: string;
  connected = false;
  lastTick: Tick | null = null;
  protected market: Market | null = null;

  abstract start(market: Market): void;
  abstract stop(): void;

  protected setConnected(v: boolean): void {
    if (this.connected !== v) {
      this.connected = v;
      this.emit('status', { connected: v });
    }
  }

  protected pushTick(t: Tick): void {
    this.lastTick = t;
    this.emit('tick', t);
  }

  ageMs(now = Date.now()): number | null {
    return this.lastTick ? now - this.lastTick.t : null;
  }
}
