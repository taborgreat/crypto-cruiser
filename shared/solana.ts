// Minimal, dependency-free decoders for the on-chain accounts TRAFFIC subscribes to.
// Layouts from the Jupiter Perpetuals / Doves Anchor IDLs (verified against live accounts, Oct 2026).
import type { Market } from './types.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}

function u64(dv: DataView, off: number): bigint { return dv.getBigUint64(off, true); }
function i64(dv: DataView, off: number): bigint { return dv.getBigInt64(off, true); }

// ---- Doves aggregated price feed -------------------------------------------------------------
// 8 disc | mint 32 | edgeFeed 32 | clFeed 32 | pythFeed 32 | pythFeedId 32 | price u64 | expo i8 | timestamp i64 | config | bump
const AG_PRICE_OFFSET = 8 + 32 * 5;

export interface OraclePrice { price: number; expo: number; timestamp: number }

export function decodeAgPriceFeed(data: Uint8Array): OraclePrice | null {
  if (data.length < AG_PRICE_OFFSET + 8 + 1 + 8) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const raw = u64(dv, AG_PRICE_OFFSET);
  const expo = dv.getInt8(AG_PRICE_OFFSET + 8);
  const ts = Number(i64(dv, AG_PRICE_OFFSET + 9));
  const price = Number(raw) * Math.pow(10, expo);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, expo, timestamp: ts };
}

// ---- Jupiter Perps Position --------------------------------------------------------------------
// 8 disc | owner 32 | pool 32 | custody 32 | collateralCustody 32 | openTime i64 | updateTime i64 | side u8
// | price u64 | sizeUsd u64 | collateralUsd u64 | realisedPnlUsd i64 | cumulativeInterestSnapshot u128 | lockedAmount u64 | bump u8
export const POSITION_SIZE = 216;

export interface PositionAccount {
  owner: string;
  pool: string;
  custody: string;
  collateralCustody: string;
  openTime: number;
  updateTime: number;
  side: 'long' | 'short';
  price: number;                 // USD
  sizeUsd: number;
  collateralUsd: number;
  realisedPnlUsd: number;
  cumulativeInterestSnapshot: bigint;
  lockedAmount: bigint;
}

export function decodePosition(data: Uint8Array): PositionAccount | null {
  if (data.length < 210) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const pk = () => { const s = base58(data.subarray(o, o + 32)); o += 32; return s; };
  const owner = pk(), pool = pk(), custody = pk(), collateralCustody = pk();
  const openTime = Number(i64(dv, o)); o += 8;
  const updateTime = Number(i64(dv, o)); o += 8;
  const sideByte = dv.getUint8(o); o += 1;
  const price = Number(u64(dv, o)) / 1e6; o += 8;
  const sizeUsd = Number(u64(dv, o)) / 1e6; o += 8;
  const collateralUsd = Number(u64(dv, o)) / 1e6; o += 8;
  const realisedPnlUsd = Number(i64(dv, o)) / 1e6; o += 8;
  const lo = u64(dv, o), hi = u64(dv, o + 8); o += 16;
  const cumulativeInterestSnapshot = (hi << 64n) | lo;
  const lockedAmount = u64(dv, o);
  // Anchor enum Side { None = 0, Long = 1, Short = 2 }
  return {
    owner, pool, custody, collateralCustody, openTime, updateTime,
    side: sideByte === 2 ? 'short' : 'long',
    price, sizeUsd, collateralUsd, realisedPnlUsd, cumulativeInterestSnapshot, lockedAmount,
  };
}

// ---- Jupiter Perps program constants (mainnet, verified Oct 2026) ------------------------------------
export const PERPS_PROGRAM_ID = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';
export const PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';
/** Asset custodies of the JLP pool. A long is collateralised by its own asset custody. */
export const CUSTODY: Record<Market, string> = {
  'SOL-PERP': '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz',
  'ETH-PERP': 'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn',
  'BTC-PERP': '5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bpThU7P',
};
/** Stable custodies: a short is collateralised by one of these. */
export const STABLE_CUSTODY = {
  USDC: 'G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa',
  USDT: '4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk',
} as const;

export function marketOfCustody(custody: string): Market | null {
  for (const k of Object.keys(CUSTODY) as Market[]) if (CUSTODY[k] === custody) return k;
  return null;
}
