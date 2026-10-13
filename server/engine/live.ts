// Live adapter: reads the real position from Jupiter Perps and builds unsigned transactions through
// the Jupiter Perpetuals API (https://perps-api.jup.ag/v1). The browser signs with Phantom. This
// process never holds a key.
//
// Verified against the live API (Oct 2026). The deployed request schema differs from the published
// OpenAPI doc: increase / limit take { walletAddress, marketMint, inputMint, collateralMint,
// collateralTokenDelta, side, leverage | sizeUsdDelta, [triggerPrice], maxSlippageBps }, decrease takes
// { positionPubkey, desiredMint, sizeUsdDelta, collateralUsdDelta, entirePosition, maxSlippageBps }.
// Responses carry requireKeeperSignature / transactionType: 'instant' transactions are signed by the
// wallet and then POSTed to /transaction/execute where Jupiter's keeper co-signs and lands them.
//
// Update 1: the position account is also watched over the shared RPC websocket (accountSubscribe) so
// fills are seen within a slot.
// Update 14: what is open is decided from the chain (chainPositions.ts): the wallet's position accounts
// are read on every poll and decoded here. Jupiter's /positions is read alongside for the liquidation
// price and accrued fees only; its field names changed once (Oct 2026) and hid an open short entirely.
// A submitted transaction's signature is also tracked, so an on-chain failure is reported at once.
// Closes book contributions / returns per position in a small ledger (lifetime P&L).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  MARKETS, SOL_MINT, USDC_MINT,
  type LiveOpenParams, type Market, type OpenParams, type PedalAction, type PedalStep, type PendingOrder,
  type PositionState, type Side, type SignRequest, type TradeRecord,
} from '../../shared/types.js';
import { MAX_LEV_TRADE, MIN_LEV_TRADE, borrowFeeUsd, closeFeeUsd, liquidationPrice, tokenToRaw, usdToRaw } from '../../shared/jupiter.js';
import { MARKET_PRICING } from '../../shared/preview.js';
import { decodePosition } from '../../shared/solana.js';
import { readChainPositions, type ChainPosition } from './chainPositions.js';
import { ENV } from '../config.js';
import { log } from '../log.js';
import { rpcCall, rpcSubscriber } from '../feed/rpcws.js';
import type { Engine, EngineEvent, PedalResult } from './types.js';
import type { TradingWallet } from '../trading.js';

/**
 * A row of GET /positions as deployed in Oct 2026. Formatted decimals carry a '.', raw values are 6-decimal
 * integers; parseUsd reads both. The pre-change names are kept as fallbacks.
 */
interface ApiPosition {
  positionPubkey: string;
  marketMint: string;
  collateralMint: string;
  side: 'long' | 'short';
  size: string;                 // USD
  sizeTokenAmount?: string;
  collateralUsd: string;
  collateral?: string;
  entryPrice: string;
  markPrice?: string;
  liquidationPrice: string;
  leverage: string;
  openFeesUsd?: string;
  closeFeesUsd?: string;
  borrowFeesUsd?: string;
  totalFeesUsd?: string;
  pnlAfterFeesUsd?: string;
  value?: string;
  createdTime: number;
  updatedTime: number;
  // names used before the Oct 2026 change
  asset?: string;
  sizeUsd?: string;
  entryPriceUsd?: string;
  liquidationPriceUsd?: string;
}

/** The API mixes raw 6-decimal integers and formatted decimals. Strings with a '.' are decimals. */
export function parseUsd(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (v.includes('.')) return Number(v);
  return Number(v) / 1e6;
}

function marketOfAsset(asset: string): Market {
  if (asset === 'ETH') return 'ETH-PERP';
  if (asset === 'BTC') return 'BTC-PERP';
  return 'SOL-PERP';
}

function marketOfMint(mint: string | undefined, asset?: string): Market {
  for (const k of Object.keys(MARKETS) as Market[]) if (MARKETS[k].mint === mint) return k;
  return marketOfAsset(asset ?? '');
}

const JUP_TIMEOUT_MS = 15_000;
/** Jupiter REST with a hard timeout: a silent endpoint must never wedge a poll or a click. */
async function jup<T>(path: string, init?: RequestInit, timeoutMs = JUP_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${ENV.jupApi}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new Error(`Jupiter ${path}: ${(err as Error).name === 'AbortError' ? `no answer after ${Math.round(timeoutMs / 1000)} s` : (err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const msg = (json as { message?: string; error?: string } | null)?.message
      ?? (json as { error?: string } | null)?.error ?? text.slice(0, 200);
    throw new Error(`Jupiter ${path} ${res.status}: ${msg}`);
  }
  return json as T;
}

interface Quote {
  collateralUsdDelta?: string;
  positionCollateralSizeUsd?: string;
  positionCollateralSizeUsdBeforeFees?: string;
  positionCollateralUsd?: string;
  transferAmountUsd?: string;
  pnlAfterFeesUsd?: string;
  entryPriceUsd?: string;
  liquidationPriceUsd?: string;
  leverage?: string;
}

interface TxResponse {
  positionPubkey?: string | null;
  positionRequestPubkey?: string | null;
  serializedTxBase64?: string | null;
  requireKeeperSignature?: boolean;
  transactionType?: 'instant' | 'legacy';
  quote?: Quote;
  txMetadata?: { blockhash?: string; lastValidBlockHeight?: string } | null;
}

type TxKind = 'increase' | 'decrease' | 'limit' | 'cancel-limit';

interface PendingTx {
  kind: TxKind;
  txid: string;
  description: string;
  since: number;
  prevSize: number;
  prevCollateral: number;
  quote?: Quote;
  entire?: boolean;
  closeId?: string;
  feeUsd?: number;
  realizedUsd?: number;
  feeToken?: string;
}

interface LedgerRow { contributedUsd: number; returnedUsd: number; realizedCreditedUsd: number; updatedAt: number }

export const SOL_FEE_RESERVE = 0.03; // keep for tx fees + request account rent

export class LiveEngine extends EventEmitter implements Engine {
  readonly kind = 'live' as const;
  position: PositionState | null = null;
  pendingOrder: PendingOrder | null = null;
  wallet: string | null = null;
  solBalance: number | null = null;
  usdcBalance: number | null = null;
  /** Update 13: who signs. 'key' = the on-machine trading wallet signs here, instantly. */
  signer: 'phantom' | 'key' = 'phantom';
  trading: TradingWallet | null = null;
  /** Current SOL/USD, supplied by the session (feed when on SOL-PERP, Jupiter market-stats otherwise). */
  solPrice: number | null = null;
  /** Current mark price of the session market (for fee conversion on ETH/BTC longs). */
  markPrice: number | null = null;
  market: Market = 'SOL-PERP';
  positions: PositionState[] = [];
  /** Entries Jupiter's /positions returned on the last read (diagnostics; the chain decides what is open). */
  positionsRaw = 0;
  lastPositionsError: string | null = null;
  lastChainError: string | null = null;
  /** Where the current position list came from. */
  source: 'chain' | 'api' | 'none' = 'none';
  private apiRows = new Map<string, ApiPosition>();
  private lastPosLog = '';
  /** Hourly borrow rate (fraction) from the session, for the fee estimate when the API has none. */
  borrowRate: number | null = null;
  selectedPubkey: string | null = null;
  pendingSign: SignRequest | null = null;
  pendingTx: PendingTx | null = null;
  slippageBps = 100;
  private pollTimer: NodeJS.Timeout | null = null;
  private fastUntil = 0;
  private lastPollAt = 0;
  private polling = false;
  private pollingSince = 0;
  private queued: EngineEvent[] = [];
  private stopArmed = false;
  private stopRequested = false;
  private seq = 0;
  private ledger: Record<string, LedgerRow> = {};
  private unsubPosition: (() => void) | null = null;
  private watchedPubkey: string | null = null;
  private refreshDebounce: NodeJS.Timeout | null = null;
  private signKinds = new Map<string, { kind: TxKind; entire?: boolean; closeId?: string; feeUsd?: number; realizedUsd?: number; feeToken?: string; positionRequestPubkey?: string | null }>();

  constructor() {
    super();
    this.loadLedger();
  }

  // ---- ledger (Update 2 accounting per position) ------------------------------------------------
  private ledgerPath(): string { return path.join(ENV.dataDir, 'live-positions.json'); }
  private loadLedger(): void {
    try { this.ledger = JSON.parse(fs.readFileSync(this.ledgerPath(), 'utf8')) as Record<string, LedgerRow>; } catch { this.ledger = {}; }
  }
  private saveLedger(): void {
    try {
      fs.mkdirSync(ENV.dataDir, { recursive: true });
      fs.writeFileSync(this.ledgerPath(), JSON.stringify(this.ledger, null, 1));
    } catch (err) { log.warn('live', 'ledger save', (err as Error).message); }
  }
  private row(pubkey: string): LedgerRow {
    return (this.ledger[pubkey] ??= { contributedUsd: 0, returnedUsd: 0, realizedCreditedUsd: 0, updatedAt: Date.now() });
  }

  freeCollateralUsd(): number {
    if (this.solBalance === null || this.solPrice === null) return 0;
    return Math.max(0, (this.solBalance - SOL_FEE_RESERVE) * this.solPrice);
  }

  reset(): void {
    this.pendingSign = null;
    this.pendingTx = null;
    this.stopArmed = false;
    this.stopRequested = false;
  }

  async connect(wallet: string): Promise<void> {
    this.wallet = wallet;
    this.reset();
    // the poller starts no matter what: a failed first read must never leave the wallet unwatched
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.pollLoop(), 500);
    const results = await Promise.allSettled([this.refreshBalance(), this.refreshPositions()]);
    for (const r of results) if (r.status === 'rejected') log.warn('live', 'connect read', (r.reason as Error).message);
    log.info('live', 'connected', wallet, 'positions', this.positions.length, this.position ? `selected ${this.position.market} ${this.position.side === 1 ? 'long' : 'short'}` : 'none');
  }

  /** Instant signing: positions belong to the trading wallet and every transaction is signed here. */
  async useTradingWallet(tw: TradingWallet): Promise<void> {
    if (!tw.address) throw new Error('No trading wallet');
    this.signer = 'key';
    this.trading = tw;
    await this.connect(tw.address);
  }

  usePhantom(): void { this.signer = 'phantom'; this.trading = null; }
  canAutoSign(): boolean { return this.signer === 'key' && !!this.trading?.keypair && !!this.wallet; }
  signLocally(txB64: string): string {
    if (!this.trading) throw new Error('No trading wallet');
    return this.trading.signB64(txB64);
  }

  disconnect(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.watch(null);
    this.wallet = null;
    this.signer = 'phantom';
    this.trading = null;
    this.solBalance = null;
    this.usdcBalance = null;
    this.position = null;
    this.positions = [];
    this.apiRows.clear();
    this.source = 'none';
    this.lastPosLog = '';
    this.selectedPubkey = null;
    this.pendingOrder = null;
    this.reset();
  }

  private async pollLoop(): Promise<void> {
    if (!this.wallet) return;
    if (this.polling) {
      // watchdog: a hung request once hid a real fill; a poll may never wedge the loop
      if (Date.now() - this.pollingSince > 30_000) { log.warn('live', 'poll watchdog: resetting a stuck poll'); this.polling = false; } else return;
    }
    const now = Date.now();
    const interval = now < this.fastUntil ? 1000 : 2500;
    if (now - this.lastPollAt < interval) return;
    this.polling = true;
    this.pollingSince = now;
    this.lastPollAt = now;
    try {
      await this.refreshPositions();
      if (now % 10_000 < 600) await this.refreshBalance();
    } catch (err) {
      log.warn('live', 'poll', (err as Error).message);
    } finally {
      this.polling = false;
    }
  }

  async refreshBalance(): Promise<void> {
    if (!this.wallet) return;
    try {
      const r = await rpcCall<{ value?: number }>('getBalance', [this.wallet]);
      if (typeof r?.value === 'number') this.solBalance = r.value / 1e9;
      // Update 12: the USDC balance too, so the pay slider can use it
      const u = await rpcCall<{ value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } }> }>('getTokenAccountsByOwner', [this.wallet, { mint: USDC_MINT }, { encoding: 'jsonParsed' }]);
      if (Array.isArray(u?.value)) this.usdcBalance = u.value.reduce((sum, a) => sum + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
    } catch (err) {
      log.warn('live', 'balance', (err as Error).message);
    }
  }

  /** Update 1: accountSubscribe on the (expected) position account for slot-latency fill detection. */
  private watch(pubkey: string | null): void {
    if (pubkey === this.watchedPubkey) return;
    if (this.unsubPosition) this.unsubPosition();
    this.unsubPosition = null;
    this.watchedPubkey = pubkey;
    if (!pubkey) return;
    this.unsubPosition = rpcSubscriber().subscribe(pubkey, (data) => {
      const acc = decodePosition(data);
      // a closed account (size 0) is left to the refresh, which drops the position in one step: no frame ever
      // shows a zero-size car (one did, and its "P&L 0 − fees" became the results card)
      if (acc && acc.sizeUsd > 0 && this.position && this.position.pubkey === pubkey) {
        // Fast local update; liq / fees follow from the API refresh.
        this.position.sizeUsd = acc.sizeUsd;
        this.position.collateralUsd = acc.collateralUsd;
        this.position.entry = acc.price;
        this.position.leverage = acc.collateralUsd > 0 ? acc.sizeUsd / acc.collateralUsd : this.position.leverage;
      }
      if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
      this.refreshDebounce = setTimeout(() => void this.refreshPositions().catch(() => undefined), 400);
    });
  }

  /**
   * Update 14: the chain decides what is open. The wallet's possible position accounts are read in one RPC
   * call and decoded here; Jupiter's /positions is read alongside and, when it answers, supplies the
   * liquidation price and the accrued fees. If the RPC read fails the API rows are used alone.
   */
  async refreshPositions(): Promise<void> {
    const wallet = this.wallet;
    if (!wallet) return;
    const extra = [this.selectedPubkey, this.watchedPubkey, ...this.apiRows.keys()].filter((k): k is string => !!k);
    const [chainRes, apiRes] = await Promise.allSettled([
      readChainPositions(wallet, extra),
      jup<{ dataList?: ApiPosition[] }>(`/positions?walletAddress=${wallet}`),
    ]);
    if (this.wallet !== wallet) return; // disconnected or switched wallets while reading
    const api = apiRes.status === 'fulfilled' ? (apiRes.value.dataList ?? []) : [];
    if (apiRes.status === 'fulfilled') {
      this.lastPositionsError = null;
      this.apiRows = new Map(api.filter((p) => !!p.positionPubkey).map((p) => [p.positionPubkey, p]));
    } else {
      this.lastPositionsError = (apiRes.reason as Error).message;
    }
    this.positionsRaw = api.length;
    let open: PositionState[];
    if (chainRes.status === 'fulfilled') {
      this.lastChainError = null;
      this.source = 'chain';
      open = chainRes.value.filter((c) => c.sizeUsd > 0).map((c) => this.fromChain(c, this.apiRows.get(c.pubkey)));
    } else {
      this.lastChainError = (chainRes.reason as Error).message;
      if (apiRes.status === 'rejected') throw new Error(`positions: chain ${this.lastChainError}; Jupiter ${this.lastPositionsError}`);
      this.source = 'api';
      open = api.filter((p) => parseUsd(p.size ?? p.sizeUsd) > 0).map((p) => this.fromApi(p));
    }
    const sig = `${this.source} ${open.map((p) => `${p.pubkey}:${p.sizeUsd.toFixed(2)}:${p.collateralUsd.toFixed(2)}`).join(',')} api:${api.length}${this.lastPositionsError ? '!' : ''}`;
    if (sig !== this.lastPosLog) {
      this.lastPosLog = sig;
      log.info('live', `positions for ${wallet.slice(0, 4)}…: ${open.length} open (${this.source})${open.length ? ' · ' + open.map((p) => `${p.market} ${p.side === 1 ? 'long' : 'short'} $${p.sizeUsd.toFixed(0)} liq ${p.liq.toFixed(2)}`).join(', ') : ''} · Jupiter API ${this.lastPositionsError ? `failed: ${this.lastPositionsError}` : `${api.length} entr${api.length === 1 ? 'y' : 'ies'}`}`);
    }
    this.positions = open;
    let chosen: PositionState | undefined;
    if (this.selectedPubkey) chosen = open.find((p) => p.pubkey === this.selectedPubkey);
    if (!chosen) chosen = open.find((p) => p.market === this.market);
    if (!chosen) chosen = open[0];
    const prev = this.position;
    this.position = chosen ?? null;
    if (chosen?.pubkey) this.selectedPubkey = chosen.pubkey;
    this.watch(this.selectedPubkey);

    if (this.pendingOrder && this.position && !prev) {
      const o = this.pendingOrder;
      this.pendingOrder = null;
      this.queued.push({ kind: 'order_filled', message: `Limit filled on Jupiter at ~${this.position.entry.toFixed(4)} (trigger ${o.triggerPrice.toFixed(4)})`, detail: { order: o, position: this.position } });
    }

    // Detect fills for an in-flight transaction.
    const tx = this.pendingTx;
    if (tx) {
      const sizeNow = this.position?.sizeUsd ?? 0;
      const colNow = this.position?.collateralUsd ?? 0;
      const changed = Math.abs(sizeNow - tx.prevSize) > 0.01 || (!!prev !== !!this.position) || Math.abs(colNow - tx.prevCollateral) > 0.01;
      if (changed) {
        this.pendingTx = null;
        this.stopRequested = false;
        this.queued.push({ kind: 'fill', message: `Keeper filled: ${tx.description}`, detail: { position: this.position } });
        this.settleLedger(tx, prev);
        void this.refreshBalance();
      } else if (Date.now() - tx.since > 120_000) {
        this.pendingTx = null;
        this.stopRequested = false;
        this.queued.push({ kind: 'warn', message: `No fill seen after 120 s for: ${tx.description}. Check Jupiter.`, detail: null });
      }
    }
    if (!prev && this.position) this.stopArmed = false;
    if (prev && !this.position && !tx) {
      // the position ended without a transaction of ours: liquidated, or closed from another app
      const pk = prev.pubkey ?? this.selectedPubkey ?? '';
      void this.reconcileClose({ kind: 'decrease', txid: '', description: 'position ended', since: Date.now() - 60_000, prevSize: prev.sizeUsd, prevCollateral: prev.collateralUsd, entire: true }, pk, prev, 0);
    }
  }

  /**
   * Update 14: after a decrease fill, read the trade row Jupiter wrote for it (pnl before fees, fee) and
   * report the realized amount from that, correcting the ledger. Emits `closed` or `liquidated` with the
   * figures the results card shows when the position is gone, else an info line for the partial close.
   */
  private async reconcileClose(tx: PendingTx, pubkey: string, prev: PositionState | null, estimate: number): Promise<void> {
    const sinceSec = Math.floor(tx.since / 1000) - 120;
    let found: TradeRecord | null = null;
    for (let i = 0; i < 6 && !found; i++) {
      try {
        const rows = await this.fetchTrades(8);
        found = rows.find((r) => r.t / 1000 >= sinceSec && /decrease/.test(r.action) && r.pnlUsd !== null) ?? null;
      } catch (err) {
        log.warn('live', 'trade row', (err as Error).message);
      }
      if (!found) await new Promise((r) => setTimeout(r, 1500));
    }
    const row = pubkey ? this.row(pubkey) : null;
    let realized = estimate;
    let fees = 0;
    let price = this.markPrice ?? prev?.entry ?? 0;
    if (found) {
      fees = found.feeUsd;
      realized = (found.pnlUsd ?? 0) - found.feeUsd; // Jupiter's pnl is before fees (verified on a liquidation row)
      if (found.price > 0) price = found.price;
      if (row) {
        row.realizedCreditedUsd += realized - estimate;
        row.updatedAt = Date.now();
        this.saveLedger();
        if (this.position && this.position.pubkey === pubkey) this.applyLedger(this.position);
      }
    }
    const gone = !this.position || this.position.pubkey !== pubkey;
    const dp = MARKETS[prev?.market ?? this.market].priceDp;
    const lifetime = row ? row.returnedUsd - row.contributedUsd : realized;
    const signed = `${realized >= 0 ? '+' : ''}${realized.toFixed(2)}`;
    const basis = found ? '' : ' (estimate: Jupiter has no trade row yet)';
    const detail = { price, pnlUsd: found?.pnlUsd ?? realized + fees, feesUsd: fees, realizedUsd: realized, returnedUsd: row?.returnedUsd ?? 0, lifetimeUsd: lifetime, position: prev, source: found ? 'jupiter' : 'quote', txid: found?.txid };
    if (found && /liquidation/.test(found.action)) {
      this.queued.push({ kind: 'liquidated', message: `Liquidated on Jupiter at ${price.toFixed(dp)} · ${signed} after fees`, detail });
    } else if (tx.entire || gone) {
      this.queued.push({ kind: 'closed', message: `Closed on Jupiter at ${price.toFixed(dp)} · realized ${signed} after fees${basis}`, detail });
    } else {
      this.queued.push({ kind: 'info', message: `Partial close realized ${signed} after fees${basis}`, detail: { realized_pnl: realized } });
    }
  }

  /** Book contributions / returns per position (lifetime P&L). */
  private settleLedger(tx: PendingTx, prev: PositionState | null): void {
    const pubkey = this.selectedPubkey ?? prev?.pubkey;
    if (!pubkey) return;
    const row = this.row(pubkey);
    const q = tx.quote ?? {};
    if (tx.kind === 'increase') {
      const delta = parseUsd(q.collateralUsdDelta ?? q.positionCollateralSizeUsdBeforeFees ?? q.positionCollateralSizeUsd ?? q.positionCollateralUsd);
      row.contributedUsd += Math.max(0, delta);
    } else if (tx.kind === 'decrease') {
      const transfer = parseUsd(q.transferAmountUsd);
      const colDelta = parseUsd(q.collateralUsdDelta);
      row.returnedUsd += Math.max(0, transfer);
      let realized = transfer - colDelta;
      if (!Number.isFinite(realized) || (transfer === 0 && colDelta === 0)) realized = parseUsd(q.pnlAfterFeesUsd);
      if (tx.entire) {
        // True-up on the final close: lifetime realized minus what was already credited on partials.
        const lifetime = row.returnedUsd - row.contributedUsd;
        if (row.contributedUsd > 0) realized = lifetime - row.realizedCreditedUsd;
      }
      row.realizedCreditedUsd += realized;
      // the quote is an estimate; Jupiter's trade row has what was actually paid (Update 14)
      void this.reconcileClose(tx, pubkey, prev, realized);
    }
    row.updatedAt = Date.now();
    this.saveLedger();
    if (this.position && this.position.pubkey === pubkey) this.applyLedger(this.position);
  }

  private applyLedger(p: PositionState): void {
    const row = p.pubkey ? this.ledger[p.pubkey] : undefined;
    if (!row) return;
    p.contributedUsd = row.contributedUsd || p.contributedUsd;
    p.returnedUsd = row.returnedUsd;
    p.realizedPnlUsd = row.realizedCreditedUsd;
  }

  /** A decoded position account, with Jupiter's row (when it answered) supplying liq price and fees. */
  private fromChain(c: ChainPosition, api?: ApiPosition): PositionState {
    const side: Side = c.side === 'long' ? 1 : -1;
    const existing = this.position && this.position.pubkey === c.pubkey ? this.position : null;
    const apiClose = api ? parseUsd(api.closeFeesUsd) : 0;
    const apiLiq = api ? parseUsd(api.liquidationPrice ?? api.liquidationPriceUsd) : 0;
    // without the API: close fee from the fee schedule, borrow fee accrued at the current hourly rate since the last settlement
    const closeFee = apiClose > 0 ? apiClose : closeFeeUsd(c.sizeUsd, MARKET_PRICING[c.market]);
    const borrowFee = api ? parseUsd(api.borrowFeesUsd) : borrowFeeUsd(c.sizeUsd, this.borrowRate ?? 0, (Date.now() / 1000 - c.updateTime) / 3600);
    const liq = apiLiq > 0 ? apiLiq : liquidationPrice({ side, entry: c.price, sizeUsd: c.sizeUsd, collateralUsd: c.collateralUsd, closeFeeUsd: closeFee, borrowFeeUsd: borrowFee });
    const openedSec = c.openTime > 0 ? c.openTime : api?.createdTime || Math.floor(Date.now() / 1000);
    const st: PositionState = {
      market: c.market,
      side,
      entry: c.price,
      sizeUsd: c.sizeUsd,
      collateralUsd: c.collateralUsd,
      openedAt: openedSec * 1000,
      borrowFeeUsd: borrowFee,
      closeFeeUsd: closeFee,
      liq,
      leverage: c.collateralUsd > 0 ? c.sizeUsd / c.collateralUsd : Number(api?.leverage) || 0,
      realizedPnlUsd: 0,
      contributedUsd: c.collateralUsd,
      returnedUsd: 0,
      trailingStop: existing?.trailingStop ?? null,
      pubkey: c.pubkey,
    };
    this.applyLedger(st);
    return st;
  }

  /** Fallback when the chain cannot be read: Jupiter's row alone. */
  private fromApi(p: ApiPosition): PositionState {
    const side: Side = p.side === 'long' ? 1 : -1;
    const market = marketOfMint(p.marketMint, p.asset);
    const sizeUsd = parseUsd(p.size ?? p.sizeUsd);
    const collateralUsd = parseUsd(p.collateralUsd);
    const existing = this.position && this.position.pubkey === p.positionPubkey ? this.position : null;
    const st: PositionState = {
      market,
      side,
      entry: parseUsd(p.entryPrice ?? p.entryPriceUsd),
      sizeUsd,
      collateralUsd,
      openedAt: (p.createdTime || Math.floor(Date.now() / 1000)) * 1000,
      borrowFeeUsd: parseUsd(p.borrowFeesUsd),
      closeFeeUsd: parseUsd(p.closeFeesUsd) || closeFeeUsd(sizeUsd, MARKET_PRICING[market]),
      liq: parseUsd(p.liquidationPrice ?? p.liquidationPriceUsd),
      leverage: Number(p.leverage) || (collateralUsd > 0 ? sizeUsd / collateralUsd : 0),
      realizedPnlUsd: 0,
      contributedUsd: collateralUsd,
      returnedUsd: 0,
      trailingStop: existing?.trailingStop ?? null,
      pubkey: p.positionPubkey,
    };
    this.applyLedger(st);
    return st;
  }

  private newSign(res: TxResponse, action: string, description: string, meta: { kind: TxKind; entire?: boolean; positionRequestPubkey?: string | null }): SignRequest {
    if (!res.serializedTxBase64) throw new Error('Jupiter returned no transaction');
    const req: SignRequest = {
      id: `${Date.now()}-${++this.seq}`,
      txB64: res.serializedTxBase64,
      action,
      requireKeeperSignature: res.requireKeeperSignature ?? res.transactionType === 'instant',
      transactionType: res.transactionType ?? 'instant',
      blockhash: res.txMetadata?.blockhash,
      lastValidBlockHeight: res.txMetadata?.lastValidBlockHeight,
      description,
      quote: res.quote,
    };
    this.pendingSign = req;
    this.signKinds.set(req.id, { ...meta, closeId: meta.kind === 'decrease' ? `${Date.now()}-${this.seq}` : undefined });
    return req;
  }

  private busy(): string | null {
    if (!this.wallet) return 'Connect a wallet first.';
    if (this.pendingSign) return 'A transaction is waiting for your signature.';
    if (this.pendingTx) return 'Waiting for the keeper to fill the previous transaction.';
    return null;
  }

  async open(params: OpenParams | LiveOpenParams, price: number): Promise<PedalResult> {
    const p = params as LiveOpenParams;
    const b = this.busy();
    if (b) return { ok: false, message: b };
    if (this.position) return { ok: false, message: 'You already have an open position on Jupiter. Resume it or close it first.' };
    if (this.pendingOrder) return { ok: false, message: 'A limit order is already pending. Cancel it first.' };
    if (!(p.leverage >= MIN_LEV_TRADE && p.leverage <= MAX_LEV_TRADE)) {
      return { ok: false, message: `Leverage must be between ${MIN_LEV_TRADE}x and ${MAX_LEV_TRADE}x.` };
    }
    if (!(p.inputAmount > 0)) return { ok: false, message: 'Collateral amount must be positive.' };
    const m = MARKETS[p.market];
    const inputMint = p.inputToken === 'USDC' ? USDC_MINT : SOL_MINT;
    const inputDecimals = p.inputToken === 'USDC' ? 6 : 9;
    if (p.inputToken === 'SOL' && this.solBalance !== null && p.inputAmount > this.solBalance - SOL_FEE_RESERVE) {
      return { ok: false, message: `Not enough SOL: balance ${this.solBalance.toFixed(4)}, keep ${SOL_FEE_RESERVE} for fees.` };
    }
    const collateralMint = p.side === 1 ? m.mint : USDC_MINT;
    const isLimit = p.entry !== undefined && p.entry !== null && price > 0 && Math.abs(p.entry - price) / price > 1e-6;
    const body: Record<string, string> = {
      walletAddress: this.wallet!,
      marketMint: m.mint,
      inputMint,
      collateralMint,
      collateralTokenDelta: tokenToRaw(p.inputAmount, inputDecimals),
      side: p.side === 1 ? 'long' : 'short',
      leverage: p.leverage.toFixed(1),
      maxSlippageBps: String(Math.round(Math.max(1, this.slippageBps))),
    };
    this.market = p.market;
    try {
      if (isLimit) {
        const trigger = p.entry as number;
        if (p.side === -1 && trigger <= price) return { ok: false, message: 'A short limit must be above the current price.' };
        if (p.side === 1 && trigger >= price) return { ok: false, message: 'A long limit must be below the current price.' };
        body.triggerPrice = usdToRaw(trigger);
        const res = await jup<TxResponse>('/orders/limit', { method: 'POST', body: JSON.stringify(body) });
        if (res.positionPubkey) { this.selectedPubkey = res.positionPubkey; this.watch(res.positionPubkey); }
        const sign = this.newSign(res, 'create-limit-order', `Limit ${body.side} ${p.market} ${p.leverage.toFixed(1)}x at ${trigger.toFixed(4)} with ${p.inputAmount} ${p.inputToken}`, { kind: 'limit', positionRequestPubkey: res.positionRequestPubkey });
        this.pendingOrder = {
          id: sign.id, market: p.market, side: p.side, leverage: p.leverage, collateralUsd: parseUsd(res.quote?.positionCollateralSizeUsdBeforeFees ?? res.quote?.positionCollateralSizeUsd),
          triggerPrice: trigger, placedAt: Date.now(), live: { pubkey: res.positionRequestPubkey ?? undefined },
        };
        return { ok: true, message: 'Sign the limit order in Phantom.', sign };
      }
      const res = await jup<TxResponse>('/positions/increase', { method: 'POST', body: JSON.stringify(body) });
      if (res.positionPubkey) { this.selectedPubkey = res.positionPubkey; this.watch(res.positionPubkey); }
      const sign = this.newSign(res, 'increase-position',
        `Open ${body.side} ${p.market} ${p.leverage.toFixed(1)}x with ${p.inputAmount} ${p.inputToken}`, { kind: 'increase' });
      return { ok: true, message: 'Sign the transaction in Phantom.', sign };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async cancelOrder(): Promise<PedalResult> {
    const o = this.pendingOrder;
    if (!o) return { ok: false, message: 'No pending order.' };
    if (!o.live?.pubkey) {
      // The order request never landed (signature declined): just forget it.
      this.pendingOrder = null;
      return { ok: true, message: 'Order dropped.', events: [{ kind: 'order_cancelled', message: 'Limit order dropped', detail: o }] };
    }
    const b = this.busy();
    if (b) return { ok: false, message: b };
    try {
      const res = await jup<TxResponse>('/orders/limit', { method: 'DELETE', body: JSON.stringify({ positionRequestPubkey: o.live.pubkey, walletAddress: this.wallet }) });
      const sign = this.newSign(res, 'cancel-limit-order', `Cancel limit at ${o.triggerPrice.toFixed(4)}`, { kind: 'cancel-limit' });
      return { ok: true, message: 'Sign the cancellation in Phantom.', sign };
    } catch (err) {
      return { ok: false, message: `Cancel on Jupiter failed (${(err as Error).message}). You can cancel the order on jup.ag.` };
    }
  }

  async pedal(action: PedalAction, price: number, steps: PedalStep, maxSlippageBps: number): Promise<PedalResult> {
    this.slippageBps = maxSlippageBps;
    const pos = this.position;
    if (action === 'cruise' || action === 'cruise_off') return this.cruise(action, price, steps);
    const b = this.busy();
    if (b) return { ok: false, message: b };
    if (!pos || !pos.pubkey) return { ok: false, message: 'No open Jupiter position.' };
    if (!(price > 0)) return { ok: false, message: 'No price yet.' };
    const m = MARKETS[pos.market];
    const collateralMint = pos.side === 1 ? m.mint : USDC_MINT;
    const sideStr = pos.side === 1 ? 'long' : 'short';
    const slip = String(Math.round(Math.max(1, maxSlippageBps)));
    const solPrice = this.solPrice ?? (pos.market === 'SOL-PERP' ? price : null);

    try {
      switch (action) {
        case 'gas_light': {
          const sizeDelta = pos.sizeUsd * steps.gasSizeFrac;
          const collateralDeltaUsd = sizeDelta / pos.leverage;
          if (!solPrice) return { ok: false, message: 'SOL price unknown; cannot size collateral.' };
          const sol = collateralDeltaUsd / solPrice;
          const body = {
            walletAddress: this.wallet, marketMint: m.mint, inputMint: SOL_MINT, collateralMint,
            collateralTokenDelta: tokenToRaw(sol, 9), side: sideStr, sizeUsdDelta: usdToRaw(sizeDelta), maxSlippageBps: slip,
          };
          const res = await jup<TxResponse>('/positions/increase', { method: 'POST', body: JSON.stringify(body) });
          return { ok: true, message: 'Sign in Phantom.', sign: this.newSign(res, 'increase-position', `Gas: +$${sizeDelta.toFixed(2)} size, +${sol.toFixed(4)} SOL collateral`, { kind: 'increase' }) };
        }
        case 'gas_hard': {
          const sizeDelta = pos.sizeUsd * steps.gasSizeFrac;
          if ((pos.sizeUsd + sizeDelta) / pos.collateralUsd > MAX_LEV_TRADE) return { ok: false, message: `Would exceed ${MAX_LEV_TRADE}x.` };
          const body = {
            walletAddress: this.wallet, marketMint: m.mint, inputMint: collateralMint, collateralMint,
            collateralTokenDelta: '0', side: sideStr, sizeUsdDelta: usdToRaw(sizeDelta), maxSlippageBps: slip,
          };
          const res = await jup<TxResponse>('/positions/increase', { method: 'POST', body: JSON.stringify(body) });
          return { ok: true, message: 'Sign in Phantom.', sign: this.newSign(res, 'increase-position', `HARD gas: +$${sizeDelta.toFixed(2)} size, no collateral`, { kind: 'increase' }) };
        }
        case 'coast': {
          const collateralDeltaUsd = Math.max(1, pos.collateralUsd * steps.coastCollateralFrac);
          if (!solPrice) return { ok: false, message: 'SOL price unknown; cannot size collateral.' };
          const sol = collateralDeltaUsd / solPrice;
          const body = {
            walletAddress: this.wallet, marketMint: m.mint, inputMint: SOL_MINT, collateralMint,
            collateralTokenDelta: tokenToRaw(sol, 9), side: sideStr, sizeUsdDelta: '0', maxSlippageBps: slip,
          };
          const res = await jup<TxResponse>('/positions/increase', { method: 'POST', body: JSON.stringify(body) });
          return { ok: true, message: 'Sign in Phantom.', sign: this.newSign(res, 'increase-position', `Back off: +${sol.toFixed(4)} SOL collateral`, { kind: 'increase' }) };
        }
        case 'brake_light': {
          const closeSize = pos.sizeUsd * steps.brakeSizeFrac;
          const collateralOut = pos.collateralUsd * steps.brakeSizeFrac;
          const body = {
            positionPubkey: pos.pubkey, desiredMint: collateralMint, sizeUsdDelta: usdToRaw(closeSize),
            collateralUsdDelta: usdToRaw(collateralOut), entirePosition: false, maxSlippageBps: slip,
          };
          const res = await jup<TxResponse>('/positions/decrease', { method: 'POST', body: JSON.stringify(body) });
          return { ok: true, message: 'Sign in Phantom.', sign: this.newSign(res, 'decrease-position', `Brake: close $${closeSize.toFixed(2)} (${(steps.brakeSizeFrac * 100).toFixed(0)}%)`, { kind: 'decrease', entire: false }) };
        }
        case 'brake_full':
          return { ok: true, message: 'Sign in Phantom.', sign: await this.buildCloseAll(pos, collateralMint, slip) };
        case 'withdraw': {
          const delta = pos.collateralUsd * steps.withdrawFrac;
          const body = {
            positionPubkey: pos.pubkey, desiredMint: collateralMint, sizeUsdDelta: '0',
            collateralUsdDelta: usdToRaw(delta), entirePosition: false, maxSlippageBps: slip,
          };
          const res = await jup<TxResponse>('/positions/decrease', { method: 'POST', body: JSON.stringify(body) });
          return { ok: true, message: 'DANGER: this pulls the car ahead closer. Sign in Phantom to confirm.', sign: this.newSign(res, 'decrease-position', `Withdraw $${delta.toFixed(2)} collateral`, { kind: 'decrease', entire: false }) };
        }
        default:
          return { ok: false, message: `Unknown pedal ${String(action)}` };
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async buildCloseAll(pos: PositionState, desiredMint: string, slip: string): Promise<SignRequest> {
    const body = {
      positionPubkey: pos.pubkey, desiredMint, sizeUsdDelta: usdToRaw(pos.sizeUsd),
      collateralUsdDelta: usdToRaw(pos.collateralUsd), entirePosition: true, maxSlippageBps: slip,
    };
    const res = await jup<TxResponse>('/positions/decrease', { method: 'POST', body: JSON.stringify(body) });
    return this.newSign(res, 'decrease-position', `Close entire ${pos.market} position`, { kind: 'decrease', entire: true });
  }

  private cruise(action: 'cruise' | 'cruise_off', price: number, steps: PedalStep): PedalResult {
    const pos = this.position;
    if (!pos) return { ok: false, message: 'No open Jupiter position.' };
    if (action === 'cruise_off') {
      pos.trailingStop = null;
      this.stopRequested = false;
      return { ok: true, message: 'Cruise control off.', events: [{ kind: 'info', message: 'Trailing stop removed' }] };
    }
    const d = steps.cruiseDistance / pos.leverage;
    const stopPrice = pos.side === -1 ? price * (1 + d) : price * (1 - d);
    pos.trailingStop = { distance: steps.cruiseDistance, price: stopPrice };
    this.stopArmed = false;
    return {
      ok: true,
      message: `Cruise control (client-side watcher): when hit, a close transaction is prepared for you to sign. Stop at ${stopPrice.toFixed(4)}.`,
      events: [{ kind: 'stop_set', message: `Trailing stop at ${stopPrice.toFixed(4)} (requires signature when hit)`, detail: pos.trailingStop }],
    };
  }

  /**
   * Called by the session after the wallet signed. Position-changing transactions are handed to Jupiter in
   * the background and this answers at once: the fill is detected from the position itself (polling plus
   * the account subscription), so a slow or silent /transaction/execute can neither freeze the app nor
   * hide a fill. Win-fee and limit transactions wait for Jupiter's answer, with a timeout.
   */
  async execute(id: string, signedTxB64: string): Promise<{ ok: boolean; message: string; txid?: string; pending?: boolean }> {
    const req = this.pendingSign;
    if (!req || req.id !== id) return { ok: false, message: 'No matching transaction awaiting signature.' };
    const meta = this.signKinds.get(id) ?? { kind: 'increase' as TxKind };
    const prevSize = this.position?.sizeUsd ?? 0;
    const prevCollateral = this.position?.collateralUsd ?? 0;
    const send = async (): Promise<string> => {
      if (req.requireKeeperSignature || req.transactionType === 'instant') {
        const res = await jup<{ txid?: string; signature?: string }>('/transaction/execute', {
          method: 'POST', body: JSON.stringify({ action: req.action, serializedTxBase64: signedTxB64 }),
        }, 60_000);
        return res.txid ?? res.signature ?? '';
      }
      return rpcCall<string>('sendTransaction', [signedTxB64, { encoding: 'base64', skipPreflight: false, maxRetries: 3 }]);
    };
    if (meta.kind === 'increase' || meta.kind === 'decrease') {
      this.pendingSign = null;
      this.signKinds.delete(id);
      this.pendingTx = {
        kind: meta.kind, txid: '', description: req.description, since: Date.now(), prevSize, prevCollateral,
        quote: req.quote as Quote | undefined, entire: meta.entire, closeId: meta.closeId,
      };
      this.fastUntil = Date.now() + 120_000;
      void send().then((txid) => {
        if (this.pendingTx && this.pendingTx.description === req.description) this.pendingTx.txid = txid;
        this.queued.push({ kind: 'tx', message: `Sent: ${req.description}`, detail: { txid, action: req.action } });
        log.info('live', 'submitted', req.description, txid);
        void this.refreshPositions().catch(() => undefined);
        if (txid) void this.trackSignature(txid, req.description);
      }).catch((err: Error) => {
        log.warn('live', 'execute', err.message);
        if (/\b4\d\d\b/.test(err.message)) {
          // Jupiter rejected it outright: nothing to wait for
          this.pendingTx = null;
          this.stopRequested = false;
          this.queued.push({ kind: 'error', message: `Transaction failed: ${err.message}` });
        } else {
          // no answer: it may still have landed. The position watch reports the fill, or the 120 s watchdog reports nothing did.
          this.queued.push({ kind: 'warn', message: `Jupiter did not answer (${err.message}). Still watching the position for the fill.` });
        }
      });
      return { ok: true, message: 'Submitted to Jupiter. Watching the position for the fill.', pending: true };
    }
    try {
      const txid = await send();
      this.pendingSign = null;
      this.signKinds.delete(id);
      if (meta.kind === 'limit') {
        if (this.pendingOrder) this.pendingOrder.live = { pubkey: meta.positionRequestPubkey ?? this.pendingOrder.live?.pubkey };
        this.queued.push({ kind: 'order_placed', message: `Limit order placed on Jupiter: ${req.description}`, detail: { txid, order: this.pendingOrder } });
        return { ok: true, message: 'Limit order placed. It fills when the keeper sees the trigger price.', txid };
      }
      if (meta.kind === 'cancel-limit') {
        const o = this.pendingOrder;
        this.pendingOrder = null;
        this.queued.push({ kind: 'order_cancelled', message: 'Limit order cancelled on Jupiter', detail: { txid, order: o } });
        return { ok: true, message: 'Limit order cancelled.', txid };
      }
      return { ok: true, message: 'Sent.', txid };
    } catch (err) {
      this.pendingSign = null;
      this.signKinds.delete(id);
      this.stopRequested = false;
      if (meta.kind === 'limit') this.pendingOrder = null;
      const message = (err as Error).message;
      this.queued.push({ kind: 'error', message: `Transaction failed: ${message}` });
      return { ok: false, message };
    }
  }

  /**
   * Follows a submitted signature so an on-chain failure is reported at once instead of after the 120 s
   * watchdog, and so a confirmation triggers an immediate position read.
   */
  private async trackSignature(txid: string, description: string): Promise<void> {
    const until = Date.now() + 90_000;
    while (Date.now() < until && this.pendingTx && this.pendingTx.txid === txid) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const r = await rpcCall<{ value?: Array<{ err?: unknown; confirmationStatus?: string } | null> }>('getSignatureStatuses', [[txid], { searchTransactionHistory: true }]);
        const s = r?.value?.[0];
        if (!s) continue;
        if (s.err) {
          if (this.pendingTx && this.pendingTx.txid === txid) {
            this.pendingTx = null;
            this.stopRequested = false;
            this.queued.push({ kind: 'error', message: `Transaction failed on chain: ${description} (${JSON.stringify(s.err).slice(0, 120)})`, detail: { txid } });
          }
          return;
        }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          log.info('live', 'confirmed', description, txid);
          void this.refreshPositions().catch(() => undefined);
          return;
        }
      } catch (err) {
        log.warn('live', 'signature status', (err as Error).message);
      }
    }
  }

  /**
   * Recent trades for the connected wallet, from Jupiter's trade history. Rows (Oct 2026): mint, positionName,
   * side, action 'Increase'|'Decrease', orderType 'Market'|'Liquidation'|…, size, price, fee, pnl, txHash,
   * createdTime (s); all money fields formatted decimals. Older names are kept as fallbacks.
   */
  async fetchTrades(limit = 25): Promise<TradeRecord[]> {
    if (!this.wallet) return [];
    const json = await jup<{ dataList?: Array<Record<string, unknown>> }>(`/trades?walletAddress=${this.wallet}&start=0&end=${limit}`);
    const rows = json.dataList ?? [];
    const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
    const usd = (v: unknown) => { const s = str(v); return s === undefined ? null : parseUsd(s); };
    return rows.map((r) => {
      const market = marketOfMint(str(r.mint), str(r.positionName)?.split('-')[0]);
      const sideStr = (str(r.side) ?? str(r.positionSide) ?? '').toLowerCase();
      const orderType = (str(r.orderType) ?? '').toLowerCase();
      const liquidated = orderType === 'liquidation' || (Number(r.liquidationFee) || 0) > 0;
      return {
        t: (Number(r.createdTime) || 0) * 1000,
        action: `${str(r.action) ?? 'trade'}${liquidated ? ' (liquidation)' : ''}`.toLowerCase(),
        market,
        side: sideStr === 'long' ? 1 : -1,
        sizeUsd: Math.abs(usd(r.size ?? r.sizeUsdDelta ?? r.sizeUsd) ?? 0),
        price: usd(r.price ?? r.priceUsd ?? r.markPriceUsd) ?? 0,
        pnlUsd: usd(r.pnl ?? r.pnlUsd ?? r.realisedPnlUsd ?? r.pnlAfterFeesUsd),
        feeUsd: usd(r.fee) ?? 0,
        txid: str(r.txHash ?? r.txSignature ?? r.signature ?? r.txId),
      } satisfies TradeRecord;
    });
  }

  cancelSign(id: string): boolean {
    if (this.pendingSign && this.pendingSign.id === id) {
      const meta = this.signKinds.get(id);
      this.pendingSign = null;
      this.signKinds.delete(id);
      this.stopRequested = false;
      if (meta?.kind === 'limit') this.pendingOrder = null;
      return true;
    }
    return false;
  }

  tick(_t: number, price: number, rate: number | null): EngineEvent[] {
    this.borrowRate = rate;
    const events = this.queued.splice(0);
    const pos = this.position;
    if (!pos) return events;
    if (pos.trailingStop) {
      const d = pos.trailingStop.distance / pos.leverage;
      let hit = false;
      if (pos.side === -1) {
        const candidate = price * (1 + d);
        if (candidate < pos.trailingStop.price) pos.trailingStop.price = candidate;
        hit = this.stopArmed && price >= pos.trailingStop.price;
      } else {
        const candidate = price * (1 - d);
        if (candidate > pos.trailingStop.price) pos.trailingStop.price = candidate;
        hit = this.stopArmed && price <= pos.trailingStop.price;
      }
      this.stopArmed = true;
      if (hit && !this.stopRequested && !this.pendingSign && !this.pendingTx && pos.pubkey) {
        this.stopRequested = true;
        const m = MARKETS[pos.market];
        const desiredMint = pos.side === 1 ? m.mint : USDC_MINT;
        void this.buildCloseAll(pos, desiredMint, String(this.slippageBps))
          .then((sign) => {
            this.queued.push({ kind: 'sign_request', message: 'Trailing stop hit: sign the close in Phantom', detail: sign });
          })
          .catch((err: Error) => {
            this.stopRequested = false;
            this.queued.push({ kind: 'error', message: `Trailing stop: ${err.message}` });
          });
        events.push({ kind: 'stop_hit', message: `Trailing stop hit at ${price.toFixed(4)}; preparing close transaction`, detail: { price } });
      }
    }
    return events;
  }
}
