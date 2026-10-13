// Update 14: what is open is read from the chain, not from Jupiter's REST endpoint.
//
// The positions endpoint renamed its fields once already (Oct 2026: sizeUsd -> size, entryPriceUsd ->
// entryPrice, liquidationPriceUsd -> liquidationPrice, asset -> marketMint) and a live short was parsed
// as size 0 and hidden for its whole two-minute life. The position account on chain cannot drift like
// that. A wallet's position accounts are PDAs of (owner, pool, custody, collateralCustody, side): longs
// are collateralised by the asset's own custody, shorts by USDC or USDT, so a wallet can own at most nine
// accounts on the JLP pool and all nine are fetched in one getMultipleAccounts call.
// Derivation verified against a real account (7bwQ… = SOL custody, USDC collateral, side 2).
import { PublicKey } from '@solana/web3.js';
import type { Market } from '../../shared/types.js';
import {
  CUSTODY, PERPS_POOL, PERPS_PROGRAM_ID, STABLE_CUSTODY, decodePosition, marketOfCustody, type PositionAccount,
} from '../../shared/solana.js';
import { rpcCall } from '../feed/rpcws.js';

export interface ChainPosition extends PositionAccount {
  pubkey: string;
  market: Market;
}

// Anchor enum Side { None = 0, Long = 1, Short = 2 }, a single byte in the seeds
const SIDE_LONG = 1;
const SIDE_SHORT = 2;
const pdaCache = new Map<string, string[]>();

/** The nine position accounts a wallet can own: per market one long (asset collateral) and one short per stable. */
export function positionPdas(owner: string): string[] {
  const hit = pdaCache.get(owner);
  if (hit) return hit;
  const program = new PublicKey(PERPS_PROGRAM_ID);
  const pool = new PublicKey(PERPS_POOL).toBuffer();
  const own = new PublicKey(owner).toBuffer();
  const stables = Object.values(STABLE_CUSTODY).map((s) => new PublicKey(s).toBuffer());
  const out: string[] = [];
  for (const custody of Object.values(CUSTODY)) {
    const c = new PublicKey(custody).toBuffer();
    const combos: Array<[Buffer, number]> = [[c, SIDE_LONG], ...stables.map((s): [Buffer, number] => [s, SIDE_SHORT])];
    for (const [collateral, side] of combos) {
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from('position'), own, pool, c, collateral, Buffer.from([side])], program);
      out.push(pda.toBase58());
    }
  }
  pdaCache.set(owner, out);
  return out;
}

interface MultipleAccounts { value?: Array<{ data?: [string, string] } | null> }

/**
 * Reads and decodes the wallet's position accounts in one RPC call. `extra` adds pubkeys learned elsewhere
 * (the account Jupiter named in an increase response, rows of its positions endpoint) so a position with an
 * unexpected collateral is still seen. Accounts with size 0 are closed positions and are returned too; the
 * caller filters.
 */
export async function readChainPositions(owner: string, extra: Iterable<string> = []): Promise<ChainPosition[]> {
  const keys = Array.from(new Set([...positionPdas(owner), ...extra]));
  const r = await rpcCall<MultipleAccounts>('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]);
  const out: ChainPosition[] = [];
  (r?.value ?? []).forEach((acc, i) => {
    const b64 = acc?.data?.[0];
    if (!b64) return;
    const p = decodePosition(Buffer.from(b64, 'base64'));
    if (!p || p.owner !== owner) return;
    const market = marketOfCustody(p.custody);
    if (!market) return;
    out.push({ ...p, pubkey: keys[i], market });
  });
  return out;
}
