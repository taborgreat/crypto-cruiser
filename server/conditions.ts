// Update 11: the conditions engine. Reads the seven horizons from the local candles (1 m / 15 m / 1 h) and
// from a one-time startup backfill of exchange candles for the long horizons (4 h / 1 d / 1 w / 1 y),
// cached to disk and then maintained from the live stream. Recompute cadence: 1m / 15m every tick,
// 1h every 10 s, 4h–1y every minute; the sentence is re-evaluated when any row changes class. In a rewind
// every horizon is read as of the cursor, so the panel says what it would have said then.
import fs from 'node:fs';
import path from 'node:path';
import { CandleBuilder, candleIndexAt, type Candle } from '../shared/candles.js';
import { HORIZONS, evaluate, measureHorizon, rowClass, type ConditionRow, type ConditionsState, type HorizonKey } from '../shared/conditions.js';
import { MARKETS, type Market, type Side } from '../shared/types.js';
import type { LayerManager } from './layers.js';
import { ENV } from './config.js';
import { log } from './log.js';

const COINBASE = 'https://api.exchange.coinbase.com';
/** One backfill per resolution at startup: 1 request each (daily needs two pages for a year). */
const BACKFILL: Array<{ res: number; bars: number }> = [
  { res: 60, bars: 300 }, { res: 300, bars: 300 }, { res: 3600, bars: 300 }, { res: 21_600, bars: 300 }, { res: 86_400, bars: 600 },
];
const RECOMPUTE_MS: Record<HorizonKey, number> = { '1m': 0, '15m': 0, '1h': 10_000, '4h': 60_000, '1d': 60_000, '1w': 60_000, '1y': 60_000 };

function dedupeSort(c: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const x of c) if (x.t > 0 && x.l > 0 && x.h >= x.l) m.set(x.t, x);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** Exchange candles for one resolution, newest `bars`, cached in data/candles; refetched only when stale. */
export async function loadBackfill(market: Market, res: number, bars: number): Promise<Candle[]> {
  const dir = path.join(ENV.dataDir, 'candles');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${market}-${res}.json`);
  let cached: Candle[] = [];
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')) as Candle[]; } catch { /* none */ }
  const now = Date.now();
  const lastT = cached.length ? cached[cached.length - 1].t : 0;
  if (cached.length >= bars * 0.8 && now - lastT < 2 * res * 1000) return cached;
  const product = MARKETS[market].coinbase;
  const out: Candle[] = [];
  let end = now;
  while (out.length < bars) {
    const n = Math.min(300, bars - out.length);
    const start = end - n * res * 1000;
    const url = `${COINBASE}/products/${product}/candles?granularity=${res}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const r = await fetch(url, { headers: { 'user-agent': 'traffic-sim/0.1' } });
    if (!r.ok) throw new Error(`coinbase ${res}s ${r.status}`);
    const rows = (await r.json()) as number[][];
    if (!rows.length) break;
    for (const x of rows) out.push({ t: x[0] * 1000, l: x[1], h: x[2], o: x[3], c: x[4], v: x[5] });
    end = start;
    if (rows.length < n * 0.5) break;
  }
  const merged = dedupeSort([...cached, ...out]).slice(-Math.max(bars, 600));
  try { fs.writeFileSync(file, JSON.stringify(merged)); } catch (err) { log.warn('conditions', 'cache write', (err as Error).message); }
  return merged;
}

export class ConditionsEngine {
  private market: Market | null = null;
  private backfill = new Map<number, Candle[]>();
  private six = new CandleBuilder(21_600_000, 400);
  private rows = new Map<HorizonKey, ConditionRow>();
  private lastAt = new Map<HorizonKey, number>();
  private lastState: ConditionsState | null = null;
  private lastKey = '';
  ready = false;

  async init(market: Market): Promise<void> {
    this.market = market;
    this.backfill.clear();
    this.six = new CandleBuilder(21_600_000, 400);
    this.rows.clear();
    this.lastAt.clear();
    this.lastState = null;
    this.ready = false;
    await Promise.all(BACKFILL.map(async (b) => {
      try {
        const c = await loadBackfill(market, b.res, b.bars);
        if (c.length) this.backfill.set(b.res, c);
      } catch (err) {
        log.warn('conditions', `backfill ${b.res}s`, (err as Error).message);
      }
    }));
    const sixHist = this.backfill.get(21_600);
    if (sixHist) this.six.seed(sixHist);
    this.ready = true;
    log.info('conditions', `backfill ${[...this.backfill].map(([r, c]) => `${r}s×${c.length}`).join(' ') || 'none'} for ${market}`);
  }

  onTick(t: number, price: number): void {
    this.six.pushRaw(t, price);
  }

  /** Candles for a resolution: the exchange backfill (older) followed by the locally built bars. */
  private series(res: number, layers: LayerManager): Candle[] {
    const local = res === 21_600 ? this.six.candles : res === 1 || res === 15 ? layers.candles(res) : layers.candles(res);
    const back = this.backfill.get(res);
    if (!back || !back.length) return local;
    if (!local.length) return back;
    const firstLocal = local[0].t;
    const older = back.filter((c) => c.t < firstLocal);
    return older.length ? older.concat(local) : local;
  }

  compute(price: number, t: number, leverage: number, driverSide: Side, layers: LayerManager, asOf: number | null): ConditionsState {
    const now = asOf ?? t;
    const force = asOf !== null;
    let changed = false;
    for (const spec of HORIZONS) {
      const last = this.lastAt.get(spec.key);
      const due = force || last === undefined || now - last >= RECOMPUTE_MS[spec.key] || now < last;
      if (!due) continue;
      let candles = this.series(spec.resSec, layers);
      if (asOf !== null) {
        const i = candleIndexAt(candles, asOf);
        candles = i < 0 ? [] : candles.slice(0, i + 1);
      }
      const row = measureHorizon(spec, candles, price);
      const prev = this.rows.get(spec.key);
      if (!prev || rowClass(prev) !== rowClass(row)) changed = true;
      this.rows.set(spec.key, row);
      this.lastAt.set(spec.key, now);
    }
    const rows = HORIZONS.map((h) => this.rows.get(h.key)!);
    const key = `${Math.round(leverage)}|${driverSide}`;
    if (changed || !this.lastState || key !== this.lastKey) {
      const ev = evaluate(rows, leverage, driverSide, price, this.market ? MARKETS[this.market].priceDp : 3);
      this.lastState = { t: now, ...ev, rows };
      this.lastKey = key;
    } else {
      this.lastState = { ...this.lastState, t: now, rows };
    }
    return this.lastState;
  }
}
