// Shared types for TRAFFIC. Used by the server (Node), the browser, and tests.
import type { ConditionsState } from './conditions.js';

export type Market = 'SOL-PERP' | 'ETH-PERP' | 'BTC-PERP';
export type Asset = 'SOL' | 'ETH' | 'BTC';
/** +1 long, -1 short. */
export type Side = 1 | -1;
export type ViewMode = 'price-only' | 'full-dash' | 'combined';
export type EngineKind = 'paper' | 'live';

export const MARKETS: Record<Market, { asset: Asset; mint: string; decimals: number; coinbase: string; pythId: string; priceDp: number }> = {
  'SOL-PERP': { asset: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9, coinbase: 'SOL-USD', pythId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', priceDp: 3 },
  'ETH-PERP': { asset: 'ETH', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', decimals: 8, coinbase: 'ETH-USD', pythId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', priceDp: 2 },
  'BTC-PERP': { asset: 'BTC', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', decimals: 8, coinbase: 'BTC-USD', pythId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', priceDp: 1 },
};
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** A single price observation from a feed. */
export interface Tick {
  t: number;        // ms
  price: number;    // USD
  bid?: number;
  ask?: number;
  source: string;   // 'doves' | 'coinbase' | 'hermes' | 'jupiter' | ...
}

/** Position state as the engines (paper/live) expose it. All USD unless noted. */
export interface PositionState {
  market: Market;
  side: Side;
  entry: number;             // average entry price
  sizeUsd: number;
  collateralUsd: number;     // collateral currently backing the position (after open fees)
  openedAt: number;          // ms
  borrowFeeUsd: number;      // accrued, unpaid borrow fee
  closeFeeUsd: number;       // estimated close fee (base + price impact)
  liq: number;               // liquidation price
  leverage: number;          // sizeUsd / collateralUsd
  realizedPnlUsd: number;    // from partial closes, after fees
  contributedUsd: number;    // collateral contributed over the life of the position
  returnedUsd: number;       // collateral + profit returned so far
  trailingStop: { distance: number; price: number } | null; // distance in car lengths
  pubkey?: string;           // live positions only
}

/** A pending entry order (limit) placed from ghost mode. */
export interface PendingOrder {
  id: string;
  market: Market;
  side: Side;
  leverage: number;
  collateralUsd: number;
  triggerPrice: number;
  placedAt: number;
  live?: { pubkey?: string };
}

export interface Layers {
  atr: number | null;        // ATR(14, 1m) as a fraction of price
  atr_rate: number | null;   // ATR fraction per second
  atr5m: number | null;      // ATR(14, 5m) fraction
  funding: number | null;    // hourly borrow rate (fraction) for our side, e.g. 0.000016
  utilization: number | null;// pool utilization for our side (fraction)
  oi: number | null;         // open interest proxy (USD) if known
  spread: number | null;     // (ask - bid) / mid
  divergence: number | null; // |oracle - secondary feed| / oracle (fog)
  /** Road elevation ahead. dist in seconds of road ahead; elev in car lengths, + = uphill (against you). */
  hills: Array<{ dist: number; elev: number }>;
  walls: Array<{ price: number; size: number }>;
  liq_clusters: Array<{ price: number; weight: number }>;
}

export interface ModeState {
  view: ViewMode;
  invert: boolean;
  live: boolean;
}

/** Update 4: everything derived from one horizon H (seconds that should feel like ~20 s of driving). */
export interface HorizonState {
  h: number;                 // effective horizon, seconds (slow-lerped)
  base: number;              // the manual H_base
  auto_room: boolean;
  auto_vol: boolean;
  thr: { green: number; yellow: number; orange: number; critical: number }; // headway thresholds, seconds
  ghost_ages: [number, number, number];   // left, center, right lanes
  k_scroll: number;          // render amplification multiplier (60 / H)
  tick_lerp: number;         // seconds: how fast animated positions re-sync to truth
  clear: boolean;            // the 20-second stretch: pulling away, all green, no crashes
  clear_why: string;
}

/** Per-car kinematics (section 3). Shared by the real car and every ghost. */
export interface CarFrame {
  side: Side;
  entry: number;
  liq: number;
  leverage: number;
  gap: number;               // leverage-scaled distance to liquidation, "car lengths". ~1 at entry, 0 = liquidated
  gap_pct: number;           // raw fraction of price
  v_gap: number;             // car lengths / s, + = opening (fast)
  v_close: number;           // = -v_gap, + = closing on the car ahead
  a_gap: number;             // car lengths / s^2 (fast)
  headway_s: number | null;  // null = infinity
  headway_proj_s: number | null;
  v_road: number;            // max(roadMin, k * L * ATR_rate)
  v_you: number;             // v_road - v_gap_impulse (your car carries the impulse)
  v_ahead: number;           // v_road + v_gap_trend + v_gap_liq (the car ahead carries the trend)
  v_gap_trend: number;       // car lengths / s
  v_gap_impulse: number;
  v_gap_liq: number;         // the car ahead moving on its own (collateral / borrow fee)
  brake_ahead: number;       // 0..1 brake-light intensity of the car ahead
  slam: boolean;             // sharp reversal against you
  lurch: -1 | 0 | 1;         // +1 surge (tick against you), -1 drag (tick for you), 0 settled
  gap_anim: number;          // gap at the animation price (CEX trades, offset-corrected); renderers use this
  throttle: number;          // 0..1 your throttle position (pedal inputs + adverse impulse), decays
  brake: number;             // 0..1 your brake position (pedal inputs + favorable impulse), decays
  pnl_pct: number;           // leverage-scaled unrealized P&L on collateral, percent (before fees)
  pnl_usd: number;           // unrealized P&L before fees
  fees_usd: number;          // accrued borrow + estimated close fee
  size_usd: number;
  collateral_usd: number;
  free_collateral: number;   // USD available to add (paper bankroll or wallet balance), post-entry for ghosts
  entry_dist: number;        // leverage-scaled distance to entry, + = entry behind you (in profit)
  stop_dist: number | null;  // trailing stop distance behind you in car lengths, if set
  stop_price: number | null;
  realized_usd: number;      // realized so far on this position (after Jupiter fees)
}

/** What the driver is about to do: a ghost car driving the proposed position. */
export interface GhostParams {
  id: string;
  lane: 0 | 1 | 2 | 3;       // 0..2 = lookback lanes (5 H, H, H/6); 3 = "if Go now": entry at the mark, the placement Go makes
  side: Side;
  leverage: number;
  collateralUsd: number;
  entry: number | null;      // a number = limit entry (scrubbed on the road); null = anchored by age
  /** Update 3: the ghost merged this many seconds ago; its entry is the mark from then. null = now. */
  ageSec: number | null;
  /** Update 4: when true the age follows the horizon (lane 0 = 5H, 1 = H, 2 = H/6). */
  ageAuto: boolean;
}

export interface GhostFrame extends CarFrame {
  id: string;
  lane: 0 | 1 | 2 | 3;       // 0..2 = lookback lanes (5 H, H, H/6); 3 = "if Go now" (Update 14)
  label: string;             // "if Go 5 m ago" (plain words, Update 8)
  readout: string;           // the one-line readout, plain units
  is_limit: boolean;
  proposed_entry: number | null;
  age_sec: number | null;    // effective age
  t_entry: number;           // ms: when this ghost merged (rolls with the clock, or the respawn time)
  crashed: boolean;          // gap hit 0: shown hitting the car ahead, respawns after 2 s
  crash_count: number;
}

export interface Flag { t: number; price: number; note: string }

/** Update 12: a take-profit / stop-loss order on part of the position, watched by the server. */
export interface ExitOrder {
  id: string;
  kind: 'tp' | 'sl';
  price: number;
  fraction: number;          // share of the position to close (0–1]
  state: 'armed' | 'hit' | 'cancelled';
  createdAt: number;
  hitAt?: number;
}

/** Update 7: rewind drive state carried on every frame while active. */
export interface RewindLane {
  side: Side;
  leverage: number;
  crashes: number;
  window_sec: number;        // the "last stretch" (lookback / 12)
  window_pnl_usd: number;
  trend_pct_per_h: number;
  trend_word: string;        // 'pulling away' | 'braking' | 'holding'
  readout: string;
}

export interface RewindState {
  active: boolean;
  done: boolean;
  paused: boolean;
  t0: number;
  t1: number;
  cursor: number;
  lookback_sec: number;
  duration_sec: number;
  speed: number;             // time multiplier
  progress: number;          // 0..1
  h: number;                 // horizon used during the rewind
  lanes: RewindLane[];
  /** Downsampled P&L path over the lookback: [t, pnl% lane0, pnl% lane1]. */
  path: Array<[number, number, number]>;
  /** Liquidation (crash) events: [t, side]. */
  crashes: Array<[number, Side]>;
  flags: Flag[];
  history_from: number;      // earliest tick available (lookback may be clamped to it)
}

/** Update 7: the road behind you. */
export interface BehindState {
  t_from: number;
  profile: Array<[number, number]>;      // [t, price], downsampled, oldest first
  crashes: Array<[number, number]>;      // [t, lane] crash posts over the stretch
  flags: Flag[];
  entry_t: number | null;
}

/** The frame object: server -> client, every tick. */
export interface Frame {
  t: number;
  market: Market;
  price: number;             // truth (oracle)
  price_anim: number;        // animation price: CEX trades offset-corrected to the oracle (Update 3)
  anim_source: string;       // 'coinbase' | 'truth'
  v_price_raw: number;       // fast EMA d/dt ln P (side-less), fraction / s
  a_price_raw: number;       // EMA d2/dt2 ln P
  v_trend_raw: number;       // slow EMA of d/dt ln P (Update 3)
  v_impulse_raw: number;     // v_price_raw - v_trend_raw
  a_trend_raw: number;
  car: CarFrame | null;      // the real position, if any
  ghosts: GhostFrame[];      // up to 8 proposed positions, four lanes per side (or the rewind lanes)
  pending_order: PendingOrder | null;
  alive: boolean;
  layers: Layers;
  mode: ModeState;
  horizon: HorizonState;
  rewind: RewindState | null;
  behind: BehindState | null;
  swings: Array<{ t: number; price: number; kind: 'high' | 'low' }>;
  t_truth: number;           // ms of the last oracle tick
  t_anim: number;            // ms of the last animation tick
  conditions: ConditionsState | null; // Update 11: the sentence and the seven-horizon grid, as of this frame
  exits: ExitOrder[];        // Update 12: armed take-profit / stop-loss orders (drawn on the road and the chart)
}

/** Pedals. See spec section 4. */
export type PedalAction =
  | 'gas_light'    // increase size AND add proportional collateral (same leverage)
  | 'gas_hard'     // increase size only (leverage rises)
  | 'coast'        // add collateral only (leverage falls)
  | 'brake_light'  // partial close
  | 'brake_full'   // close all
  | 'withdraw'     // remove collateral while in profit (danger)
  | 'cruise'       // set / move trailing stop
  | 'cruise_off';

export const PEDAL_ACTIONS: PedalAction[] = [
  'gas_light', 'gas_hard', 'coast', 'brake_light', 'brake_full', 'withdraw', 'cruise', 'cruise_off',
];

export interface OpenParams {
  market: Market;
  side: Side;
  leverage: number;
  collateralUsd: number;
  entry?: number | null;     // limit entry (paper) when set
}

/** Parameters for opening a real position through Jupiter. Collateral is given in the input token. */
export interface LiveOpenParams {
  market: Market;
  side: Side;
  leverage: number;
  inputToken: 'SOL' | 'USDC';
  inputAmount: number;       // in token units (e.g. 0.5 SOL)
  entry?: number | null;     // limit trigger price (Jupiter limit order) when set
}

export interface PedalStep {
  gasSizeFrac: number;        // fraction of current size added per gas press (0.10)
  coastCollateralFrac: number;// fraction of current collateral added per coast press (0.10)
  brakeSizeFrac: number;      // fraction of size closed per light brake (0.25)
  withdrawFrac: number;       // fraction of collateral removed per withdraw press (0.10)
  cruiseDistance: number;     // trailing stop distance in car lengths (0.5)
}

export interface Settings {
  tickMs: number;              // 200
  roadK: number;               // k
  roadMin: number;             // minimum road flow, car lengths / s
  slamThreshold: number;       // car lengths / s^2
  lurchThreshold: number;      // car lengths / s
  atrWindow: number;           // 14 candles
  swingLookback: number;       // 60 candles
  pedal: PedalStep;
  paperBankrollUsd: number;    // practice free collateral
  feed: 'auto' | 'doves' | 'coinbase' | 'hermes' | 'jupiter';
  maxSlippageBps: number;      // live orders
  // Update 4: horizon
  horizonSec: number;          // H_base (60)
  autoHorizonRoom: boolean;    // H widens with room (on)
  autoHorizonVol: boolean;     // H from volatility (off)
  horizonExp: number;          // 1.5
  horizonLerpSec: number;      // 5
  atrRef: number;              // reference ATR fraction (1 m) for auto-from-volatility
  // Update 8: lane lookbacks at H = 60 s (left, center, right), scaled by H / 60
  laneLookbacks: [number, number, number];
}

export const DEFAULT_SETTINGS: Settings = {
  tickMs: 200,
  roadK: 30,
  roadMin: 0.1,
  slamThreshold: 0.02,
  lurchThreshold: 0.05,
  atrWindow: 14,
  swingLookback: 60,
  pedal: { gasSizeFrac: 0.10, coastCollateralFrac: 0.10, brakeSizeFrac: 0.25, withdrawFrac: 0.10, cruiseDistance: 0.5 },
  paperBankrollUsd: 1000,
  feed: 'auto',
  maxSlippageBps: 100,
  horizonSec: 60,
  autoHorizonRoom: true,
  autoHorizonVol: false,
  horizonExp: 1.5,
  horizonLerpSec: 5,
  atrRef: 0.001,
  laneLookbacks: [300, 60, 10],
};

/** A trade that happened (on Solana for live, in the paper engine for practice). */
export interface TradeRecord {
  t: number;                 // ms
  action: string;            // 'open' | 'increase' | 'decrease' | 'close' | 'liquidation' | ...
  market: Market;
  side: Side;
  sizeUsd: number;
  price: number;
  pnlUsd: number | null;     // realized, after fees, when known
  feeUsd: number;
  txid?: string;
}

export interface FeedStatus {
  source: string;            // source of the last emitted truth tick
  primary: string;           // configured primary
  connected: boolean;
  lastTickAgeMs: number | null;
  oracleBasisBps: number | null;
  secondary: string | null;
  animSource: string | null;
  animAgeMs: number | null;
  offsetBps: number | null;
  candles: number;           // 1m candles available
  historyTicks: number;      // ticks in memory
  historyFrom: number | null;// ms of the oldest tick in memory
  subscriptions: number;     // live accountSubscribe count on the RPC websocket
}

export interface StatusMsg {
  engine: EngineKind;
  feed: FeedStatus;
  position: PositionState | null;
  pendingOrder: PendingOrder | null;
  ghosts: GhostParams[];
  mode: ModeState;
  settings: Settings;
  wallet: { address: string | null; solBalance: number | null; usdcBalance: number | null; solPrice: number | null; signer: 'phantom' | 'key'; positions: number };
  /** Update 13: the on-machine trading wallet for instant signing. */
  tradingWallet: { address: string | null; active: boolean };
  liquidated: boolean;
  bankrollUsd: number;      // paper
  pendingTx: string | null; // live: description of an in-flight transaction
  horizon: { h: number; base: number };
  rewind: boolean;
  flags: Flag[];
  exits: ExitOrder[];
}

/** Messages server -> client over the websocket. */
export type ServerMsg =
  | { type: 'frame'; frame: Frame }
  | { type: 'anim'; t: number; price: number; v: number; source: string }
  | { type: 'status'; status: StatusMsg }
  | { type: 'event'; t: number; kind: string; message: string; detail?: unknown }
  | { type: 'hello'; serverTime: number };

/** A transaction the browser must sign with Phantom. */
export interface SignRequest {
  id: string;
  txB64: string;
  action: string;               // Jupiter 'action' for /transaction/execute
  requireKeeperSignature: boolean;
  transactionType: 'instant' | 'legacy';
  blockhash?: string;
  lastValidBlockHeight?: string;
  description: string;
  quote?: unknown;
}

export interface RewindParams {
  lookbackSec: number;
  durationSec: number;
  leverage: number;
  collateralUsd: number;
  twoSided: boolean;
  side: Side;                // used when not two-sided
}
