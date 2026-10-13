// Cold-start candle seeding. Default ('local'): rebuild candles from the local tick log only; ATR warms
// up from the live stream (~15 minutes). Opt-in SEED_CANDLES=exchange pulls 1-minute candles from
// Coinbase (then Binance.US) once at startup. No external candle API is used while running.
import { MARKETS, type Market } from '../../shared/types.js';
import type { Candle } from '../../shared/candles.js';
import { log } from '../log.js';

const BINANCE_US: Record<Market, string> = { 'SOL-PERP': 'SOLUSDT', 'ETH-PERP': 'ETHUSDT', 'BTC-PERP': 'BTCUSDT' };

async function fromCoinbase(market: Market): Promise<Candle[]> {
  const product = MARKETS[market].coinbase;
  const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`, {
    headers: { 'user-agent': 'traffic-sim/0.1' },
  });
  if (!res.ok) throw new Error(`coinbase candles ${res.status}`);
  const rows = (await res.json()) as number[][];
  // [time, low, high, open, close, volume], newest first
  return rows
    .map((r) => ({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
    .sort((a, b) => a.t - b.t);
}

async function fromBinanceUs(market: Market): Promise<Candle[]> {
  const sym = BINANCE_US[market];
  const res = await fetch(`https://api.binance.us/api/v3/klines?symbol=${sym}&interval=1m&limit=300`);
  if (!res.ok) throw new Error(`binance.us klines ${res.status}`);
  const rows = (await res.json()) as (string | number)[][];
  return rows.map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }));
}

export async function fetchExchangeCandles(market: Market): Promise<Candle[]> {
  try {
    const c = await fromCoinbase(market);
    if (c.length) return c;
  } catch (err) {
    log.warn('history', 'coinbase failed:', (err as Error).message);
  }
  try {
    const c = await fromBinanceUs(market);
    if (c.length) return c;
  } catch (err) {
    log.warn('history', 'binance.us failed:', (err as Error).message);
  }
  return [];
}
