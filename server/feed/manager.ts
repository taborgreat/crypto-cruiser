// FeedManager (Update 1): one subscription, one truth, any number of viewers.
//  - truth: the Jupiter oracle account (Doves AgPriceFeed) over the shared RPC websocket
//  - secondary / cross-check: Pyth Hermes SSE when PYTH_API_KEY is set, else the Coinbase ticker stream
//    (also a push stream; it additionally supplies bid/ask for the spread layer)
//  - tick history: typed-array ring in memory + append-only JSONL on disk (compacted to TICK_HISTORY_DAYS
//    at startup). It feeds ghost ages, local candles and the rewind drive. It is price history, not an
//    event log.
// Update 3: the Coinbase trade stream is also the *animation* feed, offset-corrected to the oracle
// (offset = EMA(P_truth - P_fast, 30 s)) and emitted as 'anim' ticks at trade rate. If the fast stream
// drops, 'anim' falls back to the truth ticks so nothing ever freezes.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FeedStatus, Market, Settings, Tick } from '../../shared/types.js';
import { TickHistory } from '../../shared/ring.js';
import { CoinbaseSource } from './coinbase.js';
import { DovesSource } from './doves.js';
import { HermesSource } from './hermes.js';
import { JupiterRefSource } from './jupiterRef.js';
import { PriceSource } from './types.js';
import { rpcSubscriber } from './rpcws.js';
import { ENV } from '../config.js';
import { log } from '../log.js';

const PRIMARY_FRESH_MS = 6000; // Doves updates ~1/s with occasional gaps; only fall back on a real stall
const FAST_FRESH_MS = 3000;
const OFFSET_EMA_SEC = 30;

export class FeedManager extends EventEmitter {
  private sources: PriceSource[] = [];
  private pref: Settings['feed'] = 'auto';
  private primaryName = 'doves';
  private secondaryName: string | null = null;
  private fastName = 'coinbase';
  market: Market | null = null;
  lastTick: Tick | null = null;
  lastAnim: Tick | null = null;
  activeSource = 'none';
  private lastBy = new Map<string, Tick>();
  candleCount = 0;
  /** Truth ticks, oldest first. */
  history = new TickHistory();
  private logStream: fs.WriteStream | null = null;
  private offset = 0;          // P_truth - P_fast, EMA
  private offsetReady = false;
  private lastOffsetT = 0;
  private lastTrim = 0;

  static tickLogPath(market: Market): string {
    return path.join(ENV.dataDir, 'ticks', `${market}.jsonl`);
  }

  start(market: Market, pref: Settings['feed']): void {
    this.stop();
    this.market = market;
    this.pref = pref;
    const wanted: PriceSource[] = [];
    const coinbase = new CoinbaseSource();
    const hermes = ENV.pythApiKey || pref === 'hermes' ? new HermesSource() : null;
    switch (pref) {
      case 'coinbase':
        this.primaryName = 'coinbase'; this.secondaryName = hermes ? 'hermes' : 'doves';
        wanted.push(coinbase, hermes ?? new DovesSource());
        break;
      case 'hermes':
        this.primaryName = 'hermes'; this.secondaryName = 'doves';
        wanted.push(hermes!, new DovesSource(), coinbase);
        break;
      case 'jupiter':
        this.primaryName = 'jupiter'; this.secondaryName = 'coinbase';
        wanted.push(new JupiterRefSource(), coinbase);
        break;
      default: // 'auto' | 'doves'
        this.primaryName = 'doves'; this.secondaryName = hermes ? 'hermes' : 'coinbase';
        wanted.push(new DovesSource(), coinbase);
        if (hermes) wanted.push(hermes);
    }
    this.fastName = 'coinbase';
    for (const s of wanted) {
      s.on('tick', (t: Tick) => this.onTick(s, t));
      s.on('error', () => undefined);
      s.start(market);
    }
    this.sources = wanted;
    this.openLog(market);
    log.info('feed', `started ${market}: truth ${this.primaryName}, secondary ${this.secondaryName ?? 'none'}, anim ${this.fastName}`);
  }

  stop(): void {
    for (const s of this.sources) {
      s.removeAllListeners();
      s.stop();
    }
    this.sources = [];
    this.lastBy.clear();
    this.lastTick = null;
    this.lastAnim = null;
    this.activeSource = 'none';
    this.history = new TickHistory();
    this.offset = 0;
    this.offsetReady = false;
    if (this.logStream) this.logStream.end();
    this.logStream = null;
  }

  private openLog(market: Market): void {
    try {
      const p = FeedManager.tickLogPath(market);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      this.logStream = fs.createWriteStream(p, { flags: 'a' });
    } catch (err) {
      log.warn('feed', 'tick log unavailable', (err as Error).message);
    }
  }

  /**
   * Load the on-disk tick log (last ENV.tickHistoryDays) and compact the file to that window so it
   * never grows beyond the history the app uses.
   */
  static async loadHistory(market: Market, days = ENV.tickHistoryDays): Promise<Array<[number, number]>> {
    const p = FeedManager.tickLogPath(market);
    let text: string;
    try {
      text = await fsp.readFile(p, 'utf8');
    } catch {
      return [];
    }
    const cutoff = Date.now() - days * 86_400_000;
    const out: Array<[number, number]> = [];
    let dropped = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const ti = line.indexOf('"t":'), pi = line.indexOf('"p":');
      if (ti < 0 || pi < 0) continue;
      const t = Number(line.slice(ti + 4, line.indexOf(',', ti)));
      const pEnd = line.indexOf(',', pi) >= 0 ? line.indexOf(',', pi) : line.indexOf('}', pi);
      const pr = Number(line.slice(pi + 4, pEnd));
      if (!(t >= cutoff) || !(pr > 0)) { dropped++; continue; }
      out.push([t, pr]);
    }
    if (dropped > 0) {
      try {
        await fsp.writeFile(p, out.map(([t, pr]) => `{"t":${t},"p":${pr}}`).join('\n') + (out.length ? '\n' : ''));
        log.info('feed', `compacted tick log ${market}: kept ${out.length}, dropped ${dropped} older than ${days} d`);
      } catch (err) {
        log.warn('feed', 'tick log compaction failed', (err as Error).message);
      }
    }
    return out;
  }

  /** Seed the in-memory history from the log so ghosts and the rewind can reach into the past. */
  seedHistory(rows: Array<[number, number]>): void {
    for (const [t, p] of rows) this.history.push(t, p);
  }

  private onTick(src: PriceSource, t: Tick): void {
    this.lastBy.set(src.name, t);
    const now = Date.now();
    const primaryTick = this.lastBy.get(this.primaryName);
    const primaryFresh = !!primaryTick && now - primaryTick.t < PRIMARY_FRESH_MS;
    const fastIsTruth = this.fastName === this.primaryName;

    // --- animation stream (Update 3)
    if (src.name === this.fastName && !fastIsTruth) {
      const anim: Tick = { t: t.t, price: t.price + (this.offsetReady ? this.offset : 0), source: this.fastName };
      this.lastAnim = anim;
      this.emit('anim', anim);
    }

    // --- truth stream
    let emit: Tick | null = null;
    if (src.name === this.primaryName) emit = t;
    else if (!primaryFresh && (src.name === this.secondaryName || src.name === 'coinbase')) emit = t; // fallback carries the price
    else {
      this.emit('quote', t); // bid/ask only
      return;
    }
    const cb = this.lastBy.get('coinbase');
    if (cb && now - cb.t < 5000 && emit.bid === undefined) emit = { ...emit, bid: cb.bid, ask: cb.ask };
    this.activeSource = emit.source;
    this.lastTick = emit;
    this.history.push(emit.t, emit.price);
    if (now - this.lastTrim > 600_000) {
      this.lastTrim = now;
      this.history.trim(now - ENV.tickHistoryDays * 86_400_000);
    }
    if (this.logStream) this.logStream.write(`{"t":${emit.t},"p":${emit.price}}\n`);

    // Offset correction: keep the fast feed centred on the oracle.
    const fast = this.lastBy.get(this.fastName);
    if (!fastIsTruth && fast && now - fast.t < FAST_FRESH_MS && emit.source === this.primaryName) {
      const inst = emit.price - fast.price;
      if (!this.offsetReady) { this.offset = inst; this.offsetReady = true; this.lastOffsetT = now; }
      else {
        const dt = Math.max(0.001, (now - this.lastOffsetT) / 1000);
        this.offset += (1 - Math.exp(-dt / OFFSET_EMA_SEC)) * (inst - this.offset);
        this.lastOffsetT = now;
      }
    }
    // When the fast stream is quiet, the truth ticks carry the animation so nothing freezes.
    if (fastIsTruth || !fast || now - fast.t > FAST_FRESH_MS) {
      const anim: Tick = { t: emit.t, price: emit.price, source: 'truth' };
      this.lastAnim = anim;
      this.emit('anim', anim);
    }
    this.emit('tick', emit);
  }

  /** Truth minus secondary feed, in bps, when both are recent. */
  oracleBasisBps(): number | null {
    const now = Date.now();
    const sec = this.secondaryName ? this.lastBy.get(this.secondaryName) : undefined;
    const pri = this.lastBy.get(this.primaryName);
    if (!sec || !pri) return null;
    if (now - sec.t > 10_000 || now - pri.t > 10_000) return null;
    return ((pri.price - sec.price) / sec.price) * 1e4;
  }

  /** |basis| as a fraction, for the fog layer. */
  divergence(): number | null {
    const b = this.oracleBasisBps();
    return b === null ? null : Math.abs(b) / 1e4;
  }

  status(): FeedStatus {
    const now = Date.now();
    const connected = this.sources.some((s) => s.connected) && !!this.lastTick && now - this.lastTick.t < 15_000;
    return {
      source: this.activeSource,
      primary: this.primaryName,
      connected,
      lastTickAgeMs: this.lastTick ? now - this.lastTick.t : null,
      oracleBasisBps: this.oracleBasisBps(),
      secondary: this.secondaryName,
      animSource: this.lastAnim ? this.lastAnim.source : null,
      animAgeMs: this.lastAnim ? now - this.lastAnim.t : null,
      offsetBps: this.offsetReady && this.lastTick ? (this.offset / this.lastTick.price) * 1e4 : null,
      candles: this.candleCount,
      historyTicks: this.history.length,
      historyFrom: this.history.first()?.t ?? null,
      subscriptions: rpcSubscriber().count,
    };
  }
}
