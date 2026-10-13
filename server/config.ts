import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types.js';
import { clampH } from '../shared/horizon.js';

// Update 27: `.env` in the working directory is read here, so the login (AUTH_USERS) and the rest apply however
// the server is started (npm run dev, npm start, systemd). Variables already in the environment win.
try {
  const text = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch { /* no .env: environment only */ }

function wsFromHttp(url: string): string {
  return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

const rpcUrl = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';

export const ENV = {
  port: Number(process.env.PORT ?? 8787),
  // --lan (or HOST=0.0.0.0) listens on every interface so another device on the LAN can open the app
  host: process.env.HOST ?? (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1'),
  rpcUrl,
  rpcWsUrl: process.env.RPC_WS_URL ?? wsFromHttp(rpcUrl),
  jupApi: (process.env.JUP_PERPS_API ?? 'https://perps-api.jup.ag/v1').replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  distDir: path.resolve(process.cwd(), 'web', 'dist'),
  serveDist: process.argv.includes('--serve-dist'),
  /** Update 1: optional Pyth Hermes SSE cross-check (needs an API key since 2026). */
  pythApiKey: process.env.PYTH_API_KEY?.trim() || null,
  pythHermesUrl: (process.env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network').replace(/\/$/, ''),
  /** 'local' (default): candles come from the local tick history only. 'exchange': seed from Coinbase/Binance.US on a cold start. */
  seedCandles: (process.env.SEED_CANDLES ?? 'local') as 'local' | 'exchange',
  /** Days of tick history kept on disk and in memory (ghost ages, candles, rewind lookbacks up to 1 w). */
  tickHistoryDays: Number(process.env.TICK_HISTORY_DAYS ?? 8),
};

type Listener = (s: Settings) => void;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Runtime settings with validation. Tunables from spec section 8 and Updates 3-4 / 8 live here. */
export class SettingsStore {
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private listeners: Listener[] = [];

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  update(partial: Partial<Settings> & Record<string, unknown>): Settings {
    const s = this.settings;
    const num = (v: unknown, cur: number, lo: number, hi: number) =>
      typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : cur;
    const bool = (v: unknown, cur: boolean) => (typeof v === 'boolean' ? v : cur);

    s.tickMs = num(partial.tickMs, s.tickMs, 50, 2000);
    s.roadK = num(partial.roadK, s.roadK, 0, 10_000);
    s.roadMin = num(partial.roadMin, s.roadMin, 0, 10);
    s.slamThreshold = num(partial.slamThreshold, s.slamThreshold, 0.0001, 10);
    s.lurchThreshold = num(partial.lurchThreshold, s.lurchThreshold, 0.0001, 10);
    s.atrWindow = Math.round(num(partial.atrWindow, s.atrWindow, 2, 200));
    s.swingLookback = Math.round(num(partial.swingLookback, s.swingLookback, 10, 500));
    s.paperBankrollUsd = num(partial.paperBankrollUsd, s.paperBankrollUsd, 10, 1e9);
    s.maxSlippageBps = Math.round(num(partial.maxSlippageBps, s.maxSlippageBps, 1, 5000));
    s.horizonSec = typeof partial.horizonSec === 'number' ? clampH(partial.horizonSec) : s.horizonSec;
    s.autoHorizonRoom = bool(partial.autoHorizonRoom, s.autoHorizonRoom);
    s.autoHorizonVol = bool(partial.autoHorizonVol, s.autoHorizonVol);
    s.horizonExp = num(partial.horizonExp, s.horizonExp, 0.25, 3);
    s.horizonLerpSec = num(partial.horizonLerpSec, s.horizonLerpSec, 0.5, 120);
    s.atrRef = num(partial.atrRef, s.atrRef, 1e-5, 0.1);
    if (Array.isArray(partial.laneLookbacks) && partial.laneLookbacks.length === 3) {
      const lb = partial.laneLookbacks as unknown[];
      s.laneLookbacks = [num(lb[0], s.laneLookbacks[0], 1, 2_419_200), num(lb[1], s.laneLookbacks[1], 1, 2_419_200), num(lb[2], s.laneLookbacks[2], 1, 2_419_200)];
    }
    if (partial.feed && ['auto', 'doves', 'coinbase', 'hermes', 'jupiter'].includes(partial.feed as string)) {
      s.feed = partial.feed as Settings['feed'];
    }
    if (partial.pedal && typeof partial.pedal === 'object') {
      const p = partial.pedal as Partial<Settings['pedal']>;
      s.pedal = {
        gasSizeFrac: num(p.gasSizeFrac, s.pedal.gasSizeFrac, 0.01, 5),
        coastCollateralFrac: num(p.coastCollateralFrac, s.pedal.coastCollateralFrac, 0.01, 5),
        brakeSizeFrac: num(p.brakeSizeFrac, s.pedal.brakeSizeFrac, 0.01, 1),
        withdrawFrac: num(p.withdrawFrac, s.pedal.withdrawFrac, 0.01, 0.9),
        cruiseDistance: num(p.cruiseDistance, s.pedal.cruiseDistance, 0.01, 100),
      };
    }
    for (const fn of this.listeners) fn(s);
    return s;
  }
}
