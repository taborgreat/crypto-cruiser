// Tick history (Update 3 / 7): the price `age` seconds ago anchors a ghost's entry; the rewind drive
// replays days of it. Stored as typed arrays (16 bytes per tick) so a week at ~2 ticks/s fits in memory.
import type { Tick } from './types.js';

export class TickHistory {
  private ts: Float64Array;
  private ps: Float64Array;
  length = 0;

  constructor(initialCapacity = 1 << 16, public maxTicks = 1 << 22 /* ~4.2M: 3+ weeks at 2/s */) {
    this.ts = new Float64Array(initialCapacity);
    this.ps = new Float64Array(initialCapacity);
  }

  private grow(): void {
    const cap = Math.min(this.maxTicks, this.ts.length * 2);
    const ts = new Float64Array(cap), ps = new Float64Array(cap);
    ts.set(this.ts.subarray(0, this.length));
    ps.set(this.ps.subarray(0, this.length));
    this.ts = ts;
    this.ps = ps;
  }

  push(t: number, p: number): void {
    if (!(p > 0) || !Number.isFinite(t)) return;
    if (this.length && t < this.ts[this.length - 1]) return; // out of order: ignore
    if (this.length >= this.ts.length) {
      if (this.ts.length >= this.maxTicks) this.dropOldest(Math.floor(this.length / 10));
      else this.grow();
    }
    this.ts[this.length] = t;
    this.ps[this.length] = p;
    this.length++;
  }

  private dropOldest(n: number): void {
    if (n <= 0) return;
    this.ts.copyWithin(0, n, this.length);
    this.ps.copyWithin(0, n, this.length);
    this.length -= n;
  }

  /** Drop everything older than `cutoffT`. */
  trim(cutoffT: number): void {
    const i = this.indexAt(cutoffT);
    if (i > 0) this.dropOldest(i);
  }

  /** Index of the last tick at or before t; -1 if t precedes the history. */
  indexAt(t: number): number {
    if (!this.length || t < this.ts[0]) return -1;
    let lo = 0, hi = this.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.ts[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Price at or before t. Before the history starts: the oldest price. Empty: null. */
  priceAt(t: number): number | null {
    if (!this.length) return null;
    const i = this.indexAt(t);
    return this.ps[i < 0 ? 0 : i];
  }

  tickAt(t: number): Tick | null {
    if (!this.length) return null;
    const i = Math.max(0, this.indexAt(t));
    return { t: this.ts[i], price: this.ps[i], source: 'history' };
  }

  first(): Tick | null { return this.length ? { t: this.ts[0], price: this.ps[0], source: 'history' } : null; }
  last(): Tick | null { return this.length ? { t: this.ts[this.length - 1], price: this.ps[this.length - 1], source: 'history' } : null; }

  /** Up to `n` [t, price] points between t0 and t1, evenly spaced by index (oldest first). */
  sample(t0: number, t1: number, n: number): Array<[number, number]> {
    if (!this.length) return [];
    const i0 = Math.max(0, this.indexAt(t0));
    const i1 = Math.max(i0, this.indexAt(t1));
    const count = i1 - i0 + 1;
    const step = Math.max(1, Math.ceil(count / Math.max(2, n)));
    const out: Array<[number, number]> = [];
    for (let i = i0; i <= i1; i += step) out.push([this.ts[i], this.ps[i]]);
    if (out.length && out[out.length - 1][0] !== this.ts[i1]) out.push([this.ts[i1], this.ps[i1]]);
    return out;
  }

  /** Iterate every tick between t0 and t1 (inclusive). */
  *between(t0: number, t1: number): Generator<[number, number]> {
    if (!this.length) return;
    const i0 = Math.max(0, this.indexAt(t0));
    const i1 = Math.max(i0, this.indexAt(t1));
    for (let i = i0; i <= i1; i++) yield [this.ts[i], this.ps[i]];
  }
}

/** Array-based helpers (small buffers, tests). */
export function tickAt(ring: Tick[], t: number): Tick | null {
  if (!ring.length) return null;
  if (t <= ring[0].t) return ring[0];
  let lo = 0, hi = ring.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ring[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return ring[lo];
}

export function priceAt(ring: Tick[], t: number): number | null {
  return tickAt(ring, t)?.price ?? null;
}
