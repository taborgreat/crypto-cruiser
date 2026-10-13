import { describe, expect, it } from 'vitest';
import { base58, decodeAgPriceFeed, decodePosition } from '../shared/solana.js';

function agFeedBuffer(price: bigint, expo: number, ts: bigint): Uint8Array {
  const buf = Buffer.alloc(8 + 32 * 5 + 8 + 1 + 8 + 16 + 1);
  buf.fill(7, 0, 8);
  let o = 8 + 32 * 5;
  buf.writeBigUInt64LE(price, o); o += 8;
  buf.writeInt8(expo, o); o += 1;
  buf.writeBigInt64LE(ts, o);
  return new Uint8Array(buf);
}

describe('Doves AgPriceFeed decoder', () => {
  it('decodes price * 10^expo and timestamp at the verified offsets', () => {
    const p = decodeAgPriceFeed(agFeedBuffer(10800372099n, -8, 1791824242n));
    expect(p).not.toBeNull();
    expect(p!.price).toBeCloseTo(108.00372099, 8);
    expect(p!.expo).toBe(-8);
    expect(p!.timestamp).toBe(1791824242);
  });
  it('rejects short buffers', () => {
    expect(decodeAgPriceFeed(new Uint8Array(10))).toBeNull();
  });
});

function positionBuffer(side: number): Uint8Array {
  const buf = Buffer.alloc(216);
  buf.fill(0xaa, 0, 8);
  let o = 8;
  buf.fill(0, o, o + 32); o += 32;            // owner = system program (all zeros) -> '1111...'
  buf.fill(1, o, o + 96); o += 96;            // pool, custody, collateralCustody
  buf.writeBigInt64LE(1_700_000_000n, o); o += 8;
  buf.writeBigInt64LE(1_700_000_100n, o); o += 8;
  buf.writeUInt8(side, o); o += 1;
  buf.writeBigUInt64LE(108_200_000n, o); o += 8;      // price 108.20
  buf.writeBigUInt64LE(5_026_490_000n, o); o += 8;    // size 5026.49
  buf.writeBigUInt64LE(50_530_000n, o); o += 8;       // collateral 50.53
  buf.writeBigInt64LE(-1_250_000n, o); o += 8;        // realised -1.25
  buf.writeBigUInt64LE(123n, o); buf.writeBigUInt64LE(0n, o + 8); o += 16;
  buf.writeBigUInt64LE(999n, o);
  return new Uint8Array(buf);
}

describe('Jupiter Position decoder', () => {
  it('decodes the fixed layout', () => {
    const p = decodePosition(positionBuffer(2));
    expect(p).not.toBeNull();
    expect(p!.owner).toBe('11111111111111111111111111111111');
    expect(p!.openTime).toBe(1_700_000_000);
    expect(p!.updateTime).toBe(1_700_000_100);
    expect(p!.side).toBe('short');
    expect(p!.price).toBeCloseTo(108.2);
    expect(p!.sizeUsd).toBeCloseTo(5026.49);
    expect(p!.collateralUsd).toBeCloseTo(50.53);
    expect(p!.realisedPnlUsd).toBeCloseTo(-1.25);
    expect(p!.cumulativeInterestSnapshot).toBe(123n);
    expect(p!.lockedAmount).toBe(999n);
    expect(decodePosition(positionBuffer(1))!.side).toBe('long');
  });
  it('base58 encodes', () => {
    expect(base58(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    expect(base58(new Uint8Array([0, 0, 1]))).toBe('112');
  });
});
