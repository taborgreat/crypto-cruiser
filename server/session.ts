// The session orchestrator: feed -> engine -> kinematics -> frame -> clients.
// Update 1: market-level kinematics are shared; the real car and up to three ghosts derive from them.
// Update 3: ghosts have an age (entry = the mark `age` seconds ago, rolling), crash and respawn; the
// kinematics run on the fast animation price so motion is alive between oracle ticks.
// Update 4: one horizon H (slow-lerped, auto from room / volatility) derives every EMA window, the ghost
// ages, the headway thresholds and the render scale; the CLEAR tag.
// Update 7: the rewind drive and the road behind you (price profile, crash posts, flags).
import { EventEmitter } from 'node:events';
import { MarketKinematics, carKinematics, headwayColor, type MarketState } from '../shared/kinematics.js';
import { pnlUsd } from '../shared/jupiter.js';
import { buildReadout } from '../shared/readout.js';
import { agoSpan } from '../shared/format.js';
import { previewPosition } from '../shared/preview.js';
import { swapUsdcToSol } from './swap.js';
import { autoRoomTarget, autoVolMultiplier, clampH, deriveHorizon } from '../shared/horizon.js';
import {
  MARKETS, type BehindState, type CarFrame, type ExitOrder, type Flag, type Frame, type GhostFrame, type GhostParams, type HorizonState, type Layers,
  type LiveOpenParams, type Market, type ModeState, type OpenParams, type PedalAction, type PositionState, type RewindParams,
  type ServerMsg, type Side, type SignRequest, type StatusMsg, type Tick, type TradeRecord, type ViewMode,
} from '../shared/types.js';
import { MAX_LEV_TRADE, MIN_LEV_TRADE } from '../shared/jupiter.js';
import { SettingsStore, ENV } from './config.js';
import { FeedManager } from './feed/manager.js';
import { LayerManager } from './layers.js';
import { PaperEngine } from './engine/paper.js';
import { LiveEngine } from './engine/live.js';
import type { Engine, EngineEvent, PedalResult } from './engine/types.js';
import { Rewind } from './rewind.js';
import { ConditionsEngine } from './conditions.js';
import { exitHit } from '../shared/exits.js';
import { TradingWallet } from './trading.js';
import { log } from './log.js';

const num = (x: number): number | null => (Number.isFinite(x) ? x : null);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** Car lengths / s of impulse that reads as a full throttle / brake needle. */
const IMPULSE_FULL = 0.05;
const CRASH_RESPAWN_MS = 2000;
const ANIM_BROADCAST_MS = 50;

interface GhostState { crashedAt: number | null; respawnAt: number; count: number }

export class Session extends EventEmitter {
  settingsStore = new SettingsStore();
  feed = new FeedManager();
  layers = new LayerManager();
  conditions = new ConditionsEngine();
  marketKin: MarketKinematics;
  paper: PaperEngine;
  live = new LiveEngine();
  trading = new TradingWallet();
  engine: Engine;
  mode: ModeState = { view: 'price-only', invert: false, live: false };
  market: Market = 'SOL-PERP';
  ghosts: GhostParams[] = [];
  primaryGhostId: string | null = null;
  liquidated = false;
  lastFrame: Frame | null = null;
  flags: Flag[] = [];
  exits: ExitOrder[] = [];
  private exitBusy = false;
  private liveNoticed: string | null = null;
  private ghostState = new Map<string, GhostState>();
  private tickTimer: NodeJS.Timeout | null = null;
  private solPriceTimer: NodeJS.Timeout | null = null;
  private lastStatusBroadcast = 0;
  private lastAnim: Tick | null = null;
  private lastKinT = 0;
  private lastAnimBroadcast = 0;
  private lastTickAt = 0;
  private pedalInput = { throttle: 0, brake: 0, t: 0 };
  private liqTrack: { key: string; liq: number; t: number; rate: number } | null = null;
  // horizon
  private hEff: number;
  private gapAtEntry: { key: string; gap: number } | null = null;
  private clearBuf: Array<{ t: number; pulling: boolean; green: boolean }> = [];
  private crashLog: Array<{ t: number; lane: number }> = [];
  // behind / swings caches
  private behind: BehindState | null = null;
  private lastBehindT = 0;
  private swings: Frame['swings'] = [];
  private lastSwingT = 0;
  // rewind
  private rewind: Rewind | null = null;
  private rewindDoneAt = 0;

  constructor() {
    super();
    const s = this.settingsStore.settings;
    this.hEff = s.horizonSec;
    this.marketKin = new MarketKinematics(this.kinParams());
    this.paper = new PaperEngine(s.paperBankrollUsd);
    this.engine = this.paper;
    this.settingsStore.onChange((ns) => {
      this.marketKin.params = this.kinParams();
      if (!this.paper.position) this.paper.setBankroll(ns.paperBankrollUsd);
      this.startTickLoop();
      this.broadcastStatus(true);
    });
  }

  private kinParams() {
    const s = this.settingsStore.settings;
    const d = deriveHorizon(this.hEff);
    return {
      velocityEmaSec: d.tauFast, accelEmaSec: d.tauAccel, trendEmaSec: d.tauSlow, roadK: s.roadK,
      roadMin: s.roadMin, slamThreshold: s.slamThreshold, lurchThreshold: s.lurchThreshold,
    };
  }

  get settings() {
    return this.settingsStore.settings;
  }

  async start(): Promise<void> {
    this.trading.load();
    this.feed.on('tick', (t: Tick) => {
      this.layers.onTick(t);
      this.conditions.onTick(t.t, t.price);
      this.layers.divergence = this.feed.divergence();
      this.feed.candleCount = this.layers.c1m.candles.length;
      if (this.market === 'SOL-PERP') this.live.solPrice = t.price;
      this.live.markPrice = t.price;
    });
    this.feed.on('quote', (t: Tick) => this.layers.onQuote(t));
    // Update 3: the animation price drives the velocity EMAs at trade rate.
    this.feed.on('anim', (a: Tick) => {
      if (this.rewind) return;
      this.marketKin.tick(a.t, a.price);
      this.lastKinT = a.t;
      this.lastAnim = a;
      const now = Date.now();
      if (now - this.lastAnimBroadcast >= ANIM_BROADCAST_MS) {
        this.lastAnimBroadcast = now;
        this.broadcast({ type: 'anim', t: a.t, price: a.price, v: this.marketKin.v, source: a.source });
      }
    });
    await this.bootMarket(this.market);
    this.startTickLoop();
    this.solPriceTimer = setInterval(() => void this.refreshSolPrice(), 30_000);
    void this.refreshSolPrice();
  }

  private async bootMarket(market: Market): Promise<void> {
    this.feed.start(market, this.settings.feed);
    const rows = await FeedManager.loadHistory(market);
    this.feed.seedHistory(rows);
    this.layers.stop();
    await this.layers.init(market, this.feed.history, this.settings.atrWindow);
    void this.conditions.init(market).catch((err) => log.warn('conditions', 'init', (err as Error).message));
    this.marketKin.reset();
    this.lastAnim = null;
    this.ghostState.clear();
    this.crashLog = [];
    this.clearBuf = [];
    this.behind = null;
    this.swings = [];
  }

  private async refreshSolPrice(): Promise<void> {
    if (this.market === 'SOL-PERP') return;
    try {
      const res = await fetch(`${ENV.jupApi}/market-stats?mint=${MARKETS['SOL-PERP'].mint}`);
      const j = (await res.json()) as { price?: string };
      const p = Number(j.price);
      if (p > 0) this.live.solPrice = p;
    } catch { /* ignore */ }
  }

  private startTickLoop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), this.settings.tickMs);
  }

  broadcast(msg: ServerMsg): void {
    this.emit('msg', msg);
  }

  broadcastStatus(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastStatusBroadcast < 100) return;
    this.lastStatusBroadcast = now;
    this.broadcast({ type: 'status', status: this.status() });
  }

  status(): StatusMsg {
    return {
      engine: this.engine.kind,
      feed: this.feed.status(),
      position: this.engine.position,
      pendingOrder: this.engine.pendingOrder,
      ghosts: this.ghosts,
      mode: { ...this.mode, live: this.engine.kind === 'live' },
      settings: this.settings,
      wallet: { address: this.live.wallet, solBalance: this.live.solBalance, usdcBalance: this.live.usdcBalance, solPrice: this.live.solPrice, signer: this.live.signer, positions: this.live.positions.length },
      tradingWallet: { address: this.trading.address, active: this.live.signer === 'key' && !!this.live.wallet },
      liquidated: this.liquidated,
      bankrollUsd: this.paper.bankrollUsd,
      pendingTx: this.live.pendingTx ? this.live.pendingTx.description : this.live.pendingSign ? `Awaiting signature: ${this.live.pendingSign.description}` : null,
      horizon: { h: this.hEff, base: this.settings.horizonSec },
      rewind: !!this.rewind,
      flags: this.flags,
      exits: this.exits,
    };
  }

  // ---- horizon (Update 4) -----------------------------------------------------------------------

  private updateHorizon(dtSec: number, car: CarFrame | null, atr: number | null): void {
    const s = this.settings;
    let target = s.horizonSec;
    if (this.rewind) target = this.rewind.state.h;
    else {
      if (s.autoHorizonRoom && car && this.gapAtEntry) target = autoRoomTarget(s.horizonSec, car.gap, this.gapAtEntry.gap, s.horizonExp);
      if (s.autoHorizonVol) target = clampH(target * autoVolMultiplier(s.atrRef, atr));
    }
    const a = 1 - Math.exp(-dtSec / Math.max(0.1, s.horizonLerpSec));
    this.hEff += a * (target - this.hEff);
    this.hEff = clampH(this.hEff);
    this.marketKin.params = this.kinParams();
  }

  /** Update 8: lane lookbacks (settings, at H = 60 s) scaled by the effective horizon. */
  private laneAges(): [number, number, number] {
    const lb = this.settings.laneLookbacks;
    const k = this.hEff / 60;
    return [Math.max(1, lb[0] * k), Math.max(1, lb[1] * k), Math.max(1, lb[2] * k)];
  }

  private focusGhost(): GhostParams | undefined {
    return this.ghosts.find((g) => g.id === this.primaryGhostId) ?? this.ghosts.find((g) => g.lane === 3) ?? this.ghosts.find((g) => g.lane === 1) ?? this.ghosts[0];
  }

  private horizonState(clear: boolean, why: string): HorizonState {
    const d = deriveHorizon(this.hEff);
    return {
      h: this.hEff, base: this.settings.horizonSec, auto_room: this.settings.autoHorizonRoom, auto_vol: this.settings.autoHorizonVol,
      thr: d.thr, ghost_ages: this.laneAges(), k_scroll: d.kScroll, tick_lerp: d.tickLerp, clear, clear_why: why,
    };
  }

  /** The 20-second stretch: pulling away for most of the last H/3, all green, no short-ghost crash. */
  private updateClear(t: number, car: CarFrame | null, thr: HorizonState['thr']): { clear: boolean; why: string } {
    const windowMs = (this.hEff / 3) * 1000;
    if (!car) { this.clearBuf = []; return { clear: false, why: 'no position' }; }
    const hw = Math.min(car.headway_s ?? Infinity, car.headway_proj_s ?? Infinity);
    this.clearBuf.push({ t, pulling: car.v_gap_trend > 0, green: headwayColor(hw, thr) === 'green' });
    while (this.clearBuf.length && this.clearBuf[0].t < t - windowMs) this.clearBuf.shift();
    const span = this.clearBuf.length ? t - this.clearBuf[0].t : 0;
    if (span < windowMs * 0.5) return { clear: false, why: 'settling' };
    const pulling = this.clearBuf.filter((x) => x.pulling).length / this.clearBuf.length;
    const allGreen = this.clearBuf.every((x) => x.green);
    const crashed = this.crashLog.some((c) => c.lane === 2 && c.t >= t - windowMs);
    if (crashed) return { clear: false, why: 'short-horizon ghost crashed' };
    if (!allGreen) return { clear: false, why: 'headway dipped' };
    if (pulling < 0.7) return { clear: false, why: 'car ahead not pulling away' };
    return { clear: true, why: 'pulling away, all green, no crashes' };
  }

  // ---- frame building ---------------------------------------------------------------------------

  /** (d liq / dt) / price for the real car, EMA-smoothed over 2 s: the car ahead moving on its own. */
  private liqRate(p: PositionState, price: number, t: number): number {
    const key = `${p.pubkey ?? 'paper'}:${p.openedAt}`;
    const tr = this.liqTrack;
    if (!tr || tr.key !== key) { this.liqTrack = { key, liq: p.liq, t, rate: 0 }; return 0; }
    const dt = (t - tr.t) / 1000;
    if (dt <= 0) return tr.rate;
    const inst = (p.liq - tr.liq) / dt / price;
    const a = 1 - Math.exp(-dt / 2);
    tr.rate += a * (inst - tr.rate);
    tr.liq = p.liq;
    tr.t = t;
    return tr.rate;
  }

  private buildCar(p: PositionState, price: number, pAnim: number, m: MarketState, layers: Layers, t: number, real: boolean): CarFrame {
    const s = this.settings;
    const k = carKinematics({
      side: p.side, leverage: p.leverage, price, entry: p.entry, liq: p.liq,
      vLnP: m.v, aLnP: m.a, vTrend: m.vTrend, aTrend: m.aTrend, liqRate: real ? this.liqRate(p, price, t) : 0,
      roadK: s.roadK, roadMin: s.roadMin, slamThreshold: s.slamThreshold, lurchThreshold: s.lurchThreshold, atrRate: layers.atr_rate,
    });
    const pnl = pnlUsd(p.side, p.entry, price, p.sizeUsd);
    const fees = p.borrowFeeUsd + p.closeFeeUsd;
    const stopDist = p.trailingStop ? (p.side * (price - p.trailingStop.price) / price) * p.leverage : null;
    const decay = real ? Math.exp(-Math.max(0, t - this.pedalInput.t) / 1200) : 0;
    const throttle = clamp01(this.pedalInput.throttle * decay + Math.max(0, -k.v_gap_impulse) / IMPULSE_FULL);
    const brake = clamp01(this.pedalInput.brake * decay + Math.max(0, k.v_gap_impulse) / IMPULSE_FULL);
    const gapAnim = pAnim > 0 ? p.leverage * ((p.side * (pAnim - p.liq)) / pAnim) : k.gap;
    return {
      side: p.side, entry: p.entry, liq: p.liq, leverage: p.leverage,
      gap: k.gap, gap_pct: k.gap_pct, v_gap: k.v_gap, v_close: k.v_close, a_gap: k.a_gap,
      headway_s: num(k.headway_s), headway_proj_s: num(k.headway_proj_s),
      v_road: k.v_road, v_you: k.v_you, v_ahead: k.v_ahead,
      v_gap_trend: k.v_gap_trend, v_gap_impulse: k.v_gap_impulse, v_gap_liq: k.v_gap_liq,
      brake_ahead: k.brake_ahead, slam: k.slam, lurch: k.lurch, gap_anim: gapAnim, throttle, brake,
      pnl_pct: k.fav * p.leverage * 100, pnl_usd: pnl, fees_usd: fees,
      size_usd: p.sizeUsd, collateral_usd: p.collateralUsd,
      free_collateral: this.engine.freeCollateralUsd(),
      entry_dist: k.entry_dist, stop_dist: stopDist, stop_price: p.trailingStop?.price ?? null,
      realized_usd: p.realizedPnlUsd,
    };
  }

  /** Update 3/4: a ghost merged `age` seconds ago at the mark from then; it crashes at gap 0 and respawns. */
  private buildGhost(g: GhostParams, price: number, pAnim: number, m: MarketState, layers: Layers, t: number, ages: [number, number, number]): GhostFrame {
    const st = this.ghostState.get(g.id) ?? { crashedAt: null, respawnAt: 0, count: 0 };
    // lane 3 (Update 14) is "if Go now": entered at the mark, the placement Go would make right now
    const ageSec = g.lane === 3 ? null : g.ageAuto ? ages[g.lane] : g.ageSec;
    let entry: number;
    let tEntry: number;
    if (g.entry !== null) { entry = g.entry; tEntry = t; }
    else if (ageSec === null) { entry = price; tEntry = t; }
    else {
      tEntry = Math.max(t - ageSec * 1000, st.respawnAt);
      entry = this.feed.history.priceAt(tEntry) ?? price;
    }
    const prev = previewPosition(this.market, { side: g.side, leverage: g.leverage, collateralUsd: g.collateralUsd, entry }, price);
    const car = this.buildCar(prev, price, pAnim, m, layers, t, false);
    car.free_collateral = Math.max(0, this.engine.freeCollateralUsd() - g.collateralUsd);
    let crashed = false;
    if (st.crashedAt !== null) {
      if (t >= st.respawnAt) st.crashedAt = null;
      else crashed = true;
    } else if (car.gap <= 0 && g.entry === null && g.lane !== 3) {
      st.crashedAt = t;
      st.respawnAt = t + CRASH_RESPAWN_MS;
      st.count++;
      crashed = true;
      this.crashLog.push({ t, lane: g.lane });
      if (this.crashLog.length > 500) this.crashLog.shift();
    }
    this.ghostState.set(g.id, st);
    if (crashed) {
      car.gap = 0; car.gap_anim = 0; car.headway_s = 0; car.headway_proj_s = 0;
    }
    const label = g.entry !== null ? `limit ${g.entry.toFixed(MARKETS[this.market].priceDp)}` : ageSec === null ? 'if Go now' : `if Go ${agoSpan(ageSec)} ago`;
    return {
      ...car,
      id: g.id, lane: g.lane, label,
      readout: buildReadout(car, layers, { price, horizonSec: this.hEff, priceDp: MARKETS[this.market].priceDp, ageSec, crashed }),
      is_limit: g.entry !== null,
      proposed_entry: g.entry,
      age_sec: ageSec,
      t_entry: tEntry,
      crashed,
      crash_count: st.count,
    };
  }

  private updateBehind(t: number, p: PositionState | null): BehindState | null {
    if (t - this.lastBehindT < 1000 && this.behind) return this.behind;
    this.lastBehindT = t;
    const windowMs = 10 * this.hEff * 1000;
    const from = t - windowMs;
    this.behind = {
      t_from: from,
      profile: this.feed.history.sample(from, t, 160),
      crashes: this.crashLog.filter((c) => c.t >= from).map((c) => [c.t, c.lane]),
      flags: this.flags.filter((f) => f.t >= from),
      entry_t: p?.openedAt ?? null,
    };
    return this.behind;
  }

  private updateSwings(t: number): Frame['swings'] {
    if (t - this.lastSwingT < 2000 && this.swings.length) return this.swings;
    this.lastSwingT = t;
    this.swings = this.layers.swings(this.settings).slice(-24).map((s) => ({ t: s.t, price: s.price, kind: s.kind }));
    return this.swings;
  }

  private tick(): void {
    const lt = this.feed.lastTick;
    if (!lt) return;
    const t = Date.now();
    const dtSec = this.lastTickAt ? Math.min(2, (t - this.lastTickAt) / 1000) : this.settings.tickMs / 1000;
    this.lastTickAt = t;
    const s = this.settings;

    if (this.rewind) { this.tickRewind(t, dtSec); return; }
    // a live position that appeared while in practice (a fill that landed while the page was away, or a trade made on Jupiter's site)
    if (this.engine.kind === 'paper' && !this.paper.position && this.live.wallet && this.live.position && (this.live.position.pubkey ?? null) !== this.liveNoticed) {
      this.liveNoticed = this.live.position.pubkey ?? null;
      this.setEngine('live');
      this.broadcast({ type: 'event', t, kind: 'info', message: `Open position found in the wallet: ${this.live.position.market} ${this.live.position.side === 1 ? 'LONG' : 'SHORT'} ${this.live.position.leverage.toFixed(1)}x · switched to REAL` });
    }

    const price = lt.price;
    if (t - this.lastKinT > 500) {
      this.marketKin.tick(t, this.lastAnim?.price ?? price);
      this.lastKinT = t;
    }
    const m = this.marketKin.state();
    const pAnim = this.lastAnim && t - this.lastAnim.t < 5000 ? this.lastAnim.price : price;

    const pos0 = this.engine.position;
    const events = this.engine.tick(t, price, this.layers.hourlyRate(pos0?.side ?? this.focusGhost()?.side ?? -1));
    for (const ev of events) this.handleEvent(ev);
    const p = this.engine.position;
    this.checkExits(t, price, p);

    const focus = p ?? this.focusGhost();
    const layers = this.layers.compute(price, focus ? focus.side : -1, focus ? focus.leverage : 100, t, s);

    const car = p ? this.buildCar(p, price, pAnim, m, layers, t, true) : null;
    if (p && car) {
      const key = `${p.pubkey ?? 'paper'}:${p.openedAt}`;
      if (!this.gapAtEntry || this.gapAtEntry.key !== key) this.gapAtEntry = { key, gap: Math.max(1e-6, p.leverage * ((p.side * (p.entry - p.liq)) / p.entry)) };
    } else this.gapAtEntry = null;

    this.updateHorizon(dtSec, car, layers.atr);
    const d = deriveHorizon(this.hEff);
    const ghosts = this.ghosts.map((g) => this.buildGhost(g, price, pAnim, m, layers, t, this.laneAges()));
    const clear = this.updateClear(t, car, d.thr);
    const frame: Frame = {
      t, market: this.market, price, price_anim: pAnim, anim_source: this.lastAnim?.source ?? 'truth',
      v_price_raw: m.v, a_price_raw: m.a, v_trend_raw: m.vTrend, v_impulse_raw: m.vImpulse, a_trend_raw: m.aTrend,
      car, ghosts, pending_order: this.engine.pendingOrder, alive: !!car,
      layers, mode: { ...this.mode, live: this.engine.kind === 'live' },
      horizon: this.horizonState(clear.clear, clear.why),
      rewind: null,
      behind: this.updateBehind(t, p),
      swings: this.updateSwings(t),
      t_truth: lt.t,
      t_anim: this.lastAnim?.t ?? lt.t,
      conditions: this.conditions.compute(price, t, focus ? focus.leverage : 100, focus ? focus.side : -1, this.layers, null),
      exits: this.exits.filter((e) => e.state === 'armed'),
    };
    this.lastFrame = frame;
    this.broadcast({ type: 'frame', frame });
  }

  private tickRewind(t: number, dtSec: number): void {
    const rw = this.rewind!;
    const s = this.settings;
    const r = rw.tick(dtSec, (price, side, lev, tt) => this.layers.compute(price, side, lev, tt, s, tt));
    this.updateHorizon(dtSec, null, r.layers.atr);
    const frame: Frame = {
      t, market: this.market, price: r.price, price_anim: r.price, anim_source: 'rewind',
      v_price_raw: 0, a_price_raw: 0, v_trend_raw: 0, v_impulse_raw: 0, a_trend_raw: 0,
      car: null, ghosts: r.ghosts, pending_order: null, alive: false,
      layers: r.layers, mode: { ...this.mode, live: false },
      horizon: this.horizonState(false, 'rewind'),
      rewind: { ...rw.state },
      behind: null,
      swings: this.layers.swings(s, rw.state.cursor).slice(-24).map((x) => ({ t: x.t, price: x.price, kind: x.kind })),
      t_truth: rw.state.cursor,
      t_anim: rw.state.cursor,
      conditions: this.conditions.compute(r.price, t, rw.params.leverage, rw.params.side, this.layers, rw.state.cursor),
      exits: [],
    };
    this.lastFrame = frame;
    this.broadcast({ type: 'frame', frame });
    if (rw.state.done) {
      if (!this.rewindDoneAt) this.rewindDoneAt = t;
      if (t - this.rewindDoneAt > 1500) this.stopRewind('landed');
    }
  }

  private handleEvent(ev: EngineEvent): void {
    const t = Date.now();
    // instant signing: trailing-stop / exit transactions are signed here instead of asking the browser
    if (ev.kind === 'sign_request' && this.live.canAutoSign()) {
      const sign = ev.detail as SignRequest;
      void (async () => {
        try {
          const r = await this.live.execute(sign.id, this.live.signLocally(sign.txB64));
          this.broadcast({ type: 'event', t: Date.now(), kind: r.ok ? 'info' : 'error', message: `${sign.description} · ${r.ok ? 'signed by the trading wallet · ' + r.message : r.message}` });
        } catch (err) {
          this.live.cancelSign(sign.id);
          this.broadcast({ type: 'event', t: Date.now(), kind: 'error', message: `Trading wallet could not sign: ${(err as Error).message}` });
        }
        this.broadcastStatus(true);
      })();
      return;
    }
    this.broadcast({ type: 'event', t, kind: ev.kind, message: ev.message, detail: ev.detail });
    if (ev.kind === 'liquidated') this.liquidated = true;
    if (ev.kind === 'liquidated' || ev.kind === 'closed' || ev.kind === 'stop_hit') this.clearExits('position closed');
    this.broadcastStatus(true);
  }

  // ---- ghosts (Update 1 / 3 / 4) ----------------------------------------------------------------

  /** Update 8: up to eight ghosts, one per (side, lane); both sides at once in the bird's-eye preview. Lane 3 = now (Update 14). */
  setGhosts(list: GhostParams[], primaryId?: string): { ok: boolean; message: string; ghosts: GhostParams[] } {
    const clean: GhostParams[] = [];
    const keys = new Set<string>();
    for (const g of list.slice(0, 8)) {
      const lev = Number(g.leverage), col = Number(g.collateralUsd);
      if (!(lev >= MIN_LEV_TRADE && lev <= MAX_LEV_TRADE) || !(col > 0)) continue;
      const lane = ([0, 1, 2, 3] as const).includes(g.lane) ? g.lane : (3 as const);
      const side: Side = Number(g.side) === 1 ? 1 : -1;
      const key = `${side}:${lane}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const entry = typeof g.entry === 'number' && g.entry > 0 ? g.entry : null;
      const ageSec = typeof g.ageSec === 'number' && g.ageSec > 0 ? Math.min(ENV.tickHistoryDays * 86_400, g.ageSec) : null;
      clean.push({ id: String(g.id || `${side === 1 ? 'l' : 's'}${lane}`), lane, side, leverage: lev, collateralUsd: col, entry, ageSec, ageAuto: g.ageAuto !== false });
    }
    if (primaryId !== undefined) this.primaryGhostId = primaryId;
    const ids = new Set(clean.map((g) => g.id));
    for (const id of [...this.ghostState.keys()]) if (!ids.has(id)) this.ghostState.delete(id);
    this.ghosts = clean;
    this.broadcastStatus(true);
    return { ok: true, message: `${clean.length} ghost(s)`, ghosts: clean };
  }

  /** Go: the ghost becomes the real car, opened at the current mark (or the scrubbed limit). */
  async go(id: string, extra: { inputToken?: 'SOL' | 'USDC'; inputAmount?: number; bankrollUsd?: number }): Promise<PedalResult> {
    const g = this.ghosts.find((x) => x.id === id) ?? this.focusGhost();
    if (!g) return { ok: false, message: 'No ghost to commit. Set side, leverage and size first.' };
    if (this.rewind) this.stopRewind('go');
    if (this.engine.kind === 'live') {
      if (!extra.inputAmount || !extra.inputToken) return { ok: false, message: 'Real mode needs the collateral amount in SOL or USDC.' };
      return this.openLive({ market: this.market, side: g.side, leverage: g.leverage, inputToken: extra.inputToken, inputAmount: extra.inputAmount, entry: g.entry });
    }
    if (typeof extra.bankrollUsd === 'number' && !this.paper.position) this.paper.setBankroll(extra.bankrollUsd);
    return this.openPaper({ market: this.market, side: g.side, leverage: g.leverage, collateralUsd: g.collateralUsd, entry: g.entry });
  }

  // ---- exits: take profit / stop loss, partial (Update 12) ---------------------------------------

  addExit(kind: 'tp' | 'sl', price: number, fraction: number): { ok: boolean; message: string; exit?: ExitOrder } {
    const p = this.engine.position;
    if (!p) return { ok: false, message: 'Open a position first.' };
    if (!(price > 0) || !(fraction > 0 && fraction <= 1)) return { ok: false, message: 'A price and a share of the position (1–100%) are required.' };
    const mark = this.feed.lastTick?.price ?? p.entry;
    const favorable = p.side * (price - mark) > 0;
    const sideWord = p.side === 1 ? 'long' : 'short';
    if (kind === 'tp' && !favorable) return { ok: false, message: `A take profit for a ${sideWord} must be ${p.side === 1 ? 'above' : 'below'} the current price.` };
    if (kind === 'sl' && favorable) return { ok: false, message: `A stop loss for a ${sideWord} must be ${p.side === 1 ? 'below' : 'above'} the current price.` };
    if (this.exits.filter((e) => e.state === 'armed').length >= 8) return { ok: false, message: 'At most 8 armed exits.' };
    const ex: ExitOrder = { id: `x${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, kind, price, fraction, state: 'armed', createdAt: Date.now() };
    this.exits.push(ex);
    this.broadcastStatus(true);
    const dp = MARKETS[this.market].priceDp;
    return { ok: true, message: `${kind === 'tp' ? 'Take profit' : 'Stop loss'} armed: close ${Math.round(fraction * 100)}% at ${price.toFixed(dp)}`, exit: ex };
  }

  cancelExit(id: string): { ok: boolean; message: string } {
    const ex = this.exits.find((e) => e.id === id && e.state === 'armed');
    if (!ex) return { ok: false, message: 'No such armed exit.' };
    ex.state = 'cancelled';
    this.exits = this.exits.filter((e) => e.state === 'armed');
    this.broadcastStatus(true);
    return { ok: true, message: 'Exit cancelled.' };
  }

  clearExits(reason: string): void {
    if (!this.exits.length) return;
    this.exits = [];
    log.info('exits', `cleared: ${reason}`);
    this.broadcastStatus(true);
  }

  private checkExits(t: number, price: number, p: PositionState | null): void {
    if (!p) { if (this.exits.length) this.clearExits('no position'); return; }
    if (this.exitBusy) return;
    const ex = this.exits.find((e) => e.state === 'armed' && exitHit(e.kind, p.side, price, e.price));
    if (!ex) return;
    ex.state = 'hit';
    ex.hitAt = t;
    this.exitBusy = true;
    void this.closeFraction(ex, price).finally(() => { this.exitBusy = false; });
  }

  /** Close the exit's share at the market: paper closes now, live prepares the close for Phantom. */
  private async closeFraction(ex: ExitOrder, price: number): Promise<void> {
    const s = this.settings;
    const dp = MARKETS[this.market].priceDp;
    const label = `${ex.kind === 'tp' ? 'Take profit' : 'Stop loss'} ${Math.round(ex.fraction * 100)}% at ${ex.price.toFixed(dp)}`;
    const t = Date.now();
    try {
      const action: PedalAction = ex.fraction >= 0.999 ? 'brake_full' : 'brake_light';
      const res = await this.engine.pedal(action, price, { ...s.pedal, brakeSizeFrac: ex.fraction }, s.maxSlippageBps);
      this.pedalInput = { throttle: 0, brake: Math.max(0.5, ex.fraction), t };
      this.broadcast({ type: 'event', t, kind: ex.kind === 'tp' ? 'tp_hit' : 'sl_hit', message: `${label} hit at ${price.toFixed(dp)}${res.ok ? '' : ` · ${res.message}`}`, detail: { exit: ex, price } });
      if (res.sign) this.broadcast({ type: 'event', t, kind: 'sign_request', message: `${label}: sign the close in Phantom`, detail: res.sign });
      for (const ev of res.events ?? []) this.handleEvent(ev);
    } catch (err) {
      this.broadcast({ type: 'event', t, kind: 'error', message: `${label}: ${(err as Error).message}` });
    }
    this.exits = this.exits.filter((e) => e.state === 'armed');
    this.broadcastStatus(true);
  }

  // ---- rewind (Update 7) ------------------------------------------------------------------------

  startRewind(params: RewindParams): { ok: boolean; message: string } {
    if (this.engine.position) return { ok: false, message: 'Close the open position before a rewind drive.' };
    const first = this.feed.history.first();
    if (!first || this.feed.history.length < 10) return { ok: false, message: 'No tick history yet. Leave the server running to record it.' };
    const s = this.settings;
    this.rewind = new Rewind(this.feed.history, params, this.market, Date.now(), { roadK: s.roadK, roadMin: s.roadMin, slamThreshold: s.slamThreshold, lurchThreshold: s.lurchThreshold });
    this.rewindDoneAt = 0;
    const st = this.rewind.state;
    const clamped = st.lookback_sec < params.lookbackSec * 0.98;
    this.broadcast({ type: 'event', t: Date.now(), kind: 'rewind_started', message: `Rewind: ${(st.lookback_sec / 3600).toFixed(1)} h in ${st.duration_sec} s (${Math.round(st.speed)}×)${clamped ? ' · lookback clamped to the recorded history' : ''}`, detail: { lookbackSec: st.lookback_sec, clamped } });
    this.broadcastStatus(true);
    return { ok: true, message: clamped ? `History starts ${new Date(st.history_from).toLocaleString()}; rewinding what is recorded.` : 'Rewind started.' };
  }

  rewindControl(action: string, value?: number | string): { ok: boolean; message: string } {
    const rw = this.rewind;
    if (!rw) return { ok: false, message: 'No rewind running.' };
    switch (action) {
      case 'pause': rw.pause(); break;
      case 'resume': rw.resume(); break;
      case 'stop': this.stopRewind('stopped'); break;
      case 'seek': rw.seek(Number(value)); break;
      case 'speed': rw.setSpeed(Number(value) || 1); break;
      case 'flag': {
        const f = rw.flag(typeof value === 'string' ? value : '');
        this.flags.push(f);
        this.broadcast({ type: 'event', t: Date.now(), kind: 'flag', message: `Flag at ${new Date(f.t).toLocaleTimeString()} · ${f.price.toFixed(3)}`, detail: f });
        break;
      }
      default: return { ok: false, message: 'Unknown rewind action' };
    }
    this.broadcastStatus(true);
    return { ok: true, message: action };
  }

  private stopRewind(reason: string): void {
    const rw = this.rewind;
    if (!rw) return;
    this.rewind = null;
    this.rewindDoneAt = 0;
    this.marketKin.reset();
    this.lastKinT = 0;
    this.broadcast({ type: 'event', t: Date.now(), kind: 'rewind_done', message: reason === 'landed' ? 'Rewind landed on now. You are in the lane.' : `Rewind ${reason}.`, detail: { reason, lanes: rw.state.lanes } });
    this.broadcastStatus(true);
  }

  dropFlag(note = ''): Flag {
    const price = this.feed.lastTick?.price ?? 0;
    const f: Flag = { t: Date.now(), price, note };
    this.flags.push(f);
    if (this.flags.length > 200) this.flags.shift();
    this.broadcast({ type: 'event', t: f.t, kind: 'flag', message: `Flag at ${price.toFixed(3)}`, detail: f });
    this.broadcastStatus(true);
    return f;
  }

  async trades(): Promise<TradeRecord[]> {
    if (this.engine.kind === 'live') return this.live.fetchTrades().catch(() => []);
    return this.paper.recentTrades;
  }

  // ---- commands -------------------------------------------------------------------------------

  setEngine(kind: 'paper' | 'live'): { ok: boolean; message: string } {
    if (this.engine.position && this.engine.kind !== kind) return { ok: false, message: 'Close the open position before switching modes.' };
    this.engine = kind === 'live' ? this.live : this.paper;
    this.mode.live = kind === 'live';
    if (kind === 'live' && this.live.position && this.live.position.market !== this.market) {
      void this.setMarket(this.live.position.market, true);
    }
    this.liquidated = false;
    this.broadcastStatus(true);
    return { ok: true, message: `Mode: ${kind === 'live' ? 'REAL' : 'PRACTICE'}` };
  }

  async setMarket(market: Market, force = false): Promise<{ ok: boolean; message: string }> {
    if (!MARKETS[market]) return { ok: false, message: 'Unknown market' };
    if (this.engine.position && !force) return { ok: false, message: 'Close the open position before changing market.' };
    if (market === this.market) return { ok: true, message: market };
    if (this.rewind) this.stopRewind('market changed');
    this.market = market;
    this.live.market = market;
    await this.bootMarket(market);
    void this.refreshSolPrice();
    this.broadcastStatus(true);
    return { ok: true, message: market };
  }

  restartFeed(): void {
    this.feed.start(this.market, this.settings.feed);
  }

  async openPaper(params: OpenParams): Promise<PedalResult> {
    if (this.engine.kind !== 'paper') {
      const r = this.setEngine('paper');
      if (!r.ok) return { ok: false, message: r.message };
    }
    if (params.market !== this.market) {
      const r = await this.setMarket(params.market);
      if (!r.ok) return { ok: false, message: r.message };
    }
    const lt = this.feed.lastTick;
    if (!lt) return { ok: false, message: 'Waiting for the first price tick...' };
    const res = await this.paper.open(params, lt.price);
    if (res.ok) {
      this.liquidated = false;
      for (const ev of res.events ?? []) this.handleEvent(ev);
    }
    this.broadcastStatus(true);
    return res;
  }

  resetPaper(bankrollUsd?: number): void {
    this.paper.reset();
    this.paper.setBankroll(bankrollUsd ?? this.settings.paperBankrollUsd);
    this.liquidated = false;
    this.broadcastStatus(true);
  }

  async openLive(params: LiveOpenParams): Promise<PedalResult> {
    if (this.engine.kind !== 'live') {
      const r = this.setEngine('live');
      if (!r.ok) return { ok: false, message: r.message };
    }
    if (params.market !== this.market) {
      const r = await this.setMarket(params.market);
      if (!r.ok) return { ok: false, message: r.message };
    }
    const lt = this.feed.lastTick;
    this.live.slippageBps = this.settings.maxSlippageBps;
    const res = await this.autoSign(await this.live.open(params, lt?.price ?? 0));
    this.broadcastStatus(true);
    return res;
  }

  async cancelOrder(): Promise<PedalResult> {
    const res = await this.autoSign(await this.engine.cancelOrder());
    for (const ev of res.events ?? []) this.handleEvent(ev);
    this.broadcastStatus(true);
    return res;
  }

  async pedal(action: PedalAction): Promise<PedalResult> {
    if (this.rewind) return { ok: false, message: 'Stop the rewind first.' };
    const lt = this.feed.lastTick;
    if (!lt) return { ok: false, message: 'No price yet.' };
    const res = await this.autoSign(await this.engine.pedal(action, lt.price, this.settings.pedal, this.settings.maxSlippageBps));
    if (res.ok) {
      const inputs: Partial<Record<PedalAction, [number, number]>> = {
        gas_light: [0.6, 0], gas_hard: [1, 0], coast: [0, 0.3], brake_light: [0, 0.7], brake_full: [0, 1], withdraw: [0.4, 0],
      };
      const inp = inputs[action];
      if (inp) this.pedalInput = { throttle: inp[0], brake: inp[1], t: Date.now() };
    }
    for (const ev of res.events ?? []) this.handleEvent(ev);
    this.broadcastStatus(true);
    return res;
  }

  /** Instant signing: when the trading wallet is the signer, sign and hand to Jupiter here instead of asking the browser. */
  private async autoSign(res: PedalResult): Promise<PedalResult> {
    if (!res.sign || !this.live.canAutoSign()) return res;
    const sign = res.sign;
    try {
      const signed = this.live.signLocally(sign.txB64);
      const r = await this.live.execute(sign.id, signed);
      return { ok: r.ok, message: r.ok ? `${sign.description} · signed by the trading wallet · ${r.message}` : r.message, events: res.events, pending: r.ok && !!r.pending };
    } catch (err) {
      this.live.cancelSign(sign.id);
      return { ok: false, message: `Trading wallet could not sign: ${(err as Error).message}` };
    }
  }

  /** Update 13: the trading wallet: create / use (instant signing) / back to Phantom / fund / withdraw. */
  async tradingAction(action: string, opts: { to?: string; from?: string; amountSol?: number }): Promise<{ ok: boolean; message: string; txB64?: string; txid?: string; address?: string }> {
    try {
      switch (action) {
        case 'create': {
          const addr = this.trading.address ?? this.trading.create();
          this.broadcastStatus(true);
          return { ok: true, message: `Trading wallet ${addr.slice(0, 4)}…${addr.slice(-4)} ready. Fund it from Phantom, then press "use instant".`, address: addr };
        }
        case 'use': {
          if (!this.trading.address) return { ok: false, message: 'Create the trading wallet first.' };
          if (this.engine.kind === 'live' && this.engine.position && this.live.signer !== 'key') return { ok: false, message: 'Close the Phantom position first; the trading wallet holds its own positions.' };
          await this.live.useTradingWallet(this.trading);
          if (this.live.position && this.live.position.market !== this.market) await this.setMarket(this.live.position.market, true);
          if (this.engine.kind !== 'live' && !this.paper.position) this.setEngine('live');
          this.broadcastStatus(true);
          return { ok: true, message: 'Instant signing on: the trading wallet signs every action. No approve screens.' };
        }
        case 'phantom': {
          this.live.usePhantom();
          this.live.disconnect();
          if (this.engine.kind === 'live' && !this.live.position) this.setEngine('paper');
          this.broadcastStatus(true);
          return { ok: true, message: 'Back to Phantom: connect it from the panel.' };
        }
        case 'fund-tx': {
          if (!opts.from || !(opts.amountSol !== undefined && opts.amountSol > 0)) return { ok: false, message: 'Amount and source wallet required.' };
          const txB64 = await this.trading.fundTx(opts.from, opts.amountSol);
          return { ok: true, message: 'Sign the transfer in Phantom.', txB64 };
        }
        case 'withdraw': {
          if (!opts.to) return { ok: false, message: 'Destination wallet required.' };
          const r = await this.trading.withdrawAll(opts.to);
          void this.live.refreshBalance();
          return { ok: true, message: `Sent ${r.sol.toFixed(4)} SOL back to Phantom (tx ${r.txid.slice(0, 8)}…)`, txid: r.txid };
        }
        case 'swap-usdc': {
          // Update 14: closed shorts leave USDC in the trading wallet; swap it back to SOL on Jupiter
          if (this.live.signer !== 'key' || !this.trading.keypair) return { ok: false, message: 'Swapping needs the trading wallet (instant signing). With Phantom, swap on jup.ag.' };
          await this.live.refreshBalance();
          const usdc = this.live.usdcBalance ?? 0;
          if (usdc < 0.01) return { ok: false, message: 'No USDC in the trading wallet.' };
          const r = await swapUsdcToSol(this.trading, usdc);
          await this.live.refreshBalance();
          this.broadcastStatus(true);
          return { ok: true, message: `Swapped ${r.inUsdc.toFixed(2)} USDC → ${r.outSol.toFixed(4)} SOL${r.txid ? ` (tx ${r.txid.slice(0, 8)}…)` : ''}`, txid: r.txid };
        }
        case 'balance': {
          const b = await this.trading.balanceSol();
          return { ok: true, message: b === null ? 'no trading wallet' : `${b.toFixed(4)} SOL`, address: this.trading.address ?? undefined };
        }
        default: return { ok: false, message: 'Unknown trading action' };
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** What the chain and Jupiter say about the connected wallet right now: open positions, API entries, the last trades. */
  async walletReport(): Promise<{ ok: boolean; message: string; positions: unknown[]; selected: PositionState | null; trades: TradeRecord[] }> {
    if (!this.live.wallet) return { ok: false, message: 'No wallet connected.', positions: [], selected: null, trades: [] };
    let readError: string | null = null;
    try { await this.live.refreshPositions(); } catch (err) { readError = (err as Error).message; }
    let trades: TradeRecord[] = [];
    let tradesError: string | null = null;
    try { trades = await this.live.fetchTrades(6); } catch (err) { tradesError = (err as Error).message; }
    const w = this.live.wallet;
    const n = this.live.positions.length;
    const dp = MARKETS[this.market].priceDp;
    const src = this.live.source;
    const where = src === 'chain' ? 'on chain' : src === 'api' ? `per Jupiter (chain read failed: ${this.live.lastChainError})` : '';
    const apiNote = this.live.lastPositionsError ? `failed (${this.live.lastPositionsError})` : `${this.live.positionsRaw} entr${this.live.positionsRaw === 1 ? 'y' : 'ies'}`;
    const parts = [`Wallet ${w.slice(0, 4)}…${w.slice(-4)}: ${n} open position${n === 1 ? '' : 's'} ${where}${readError ? ` (read failed: ${readError})` : ''}`, `Jupiter API: ${apiNote}`];
    if (this.live.position) parts.push(`open: ${this.live.position.market} ${this.live.position.side === 1 ? 'LONG' : 'SHORT'} ${this.live.position.leverage.toFixed(1)}x ${this.live.position.sizeUsd.toFixed(0)} · liq ${this.live.position.liq.toFixed(dp)}`);
    parts.push(trades.length ? `last trades: ${trades.slice(0, 4).map((t) => `${t.action} ${t.side === 1 ? 'LONG' : 'SHORT'} ${t.sizeUsd.toFixed(0)} @ ${t.price.toFixed(dp)} (${new Date(t.t).toLocaleTimeString()})`).join(' | ')}` : tradesError ? `trades read failed: ${tradesError}` : 'no trades on record for this wallet');
    if (n && this.engine.kind !== 'live' && !this.paper.position) this.setEngine('live');
    this.broadcastStatus(true);
    return { ok: true, message: parts.join(' · '), positions: this.live.positions, selected: this.live.position, trades };
  }

  async liveConnect(wallet: string): Promise<{ ok: boolean; message: string }> {
    try {
      await this.live.connect(wallet);
      if (this.live.position && this.live.position.market !== this.market) await this.setMarket(this.live.position.market, true);
      // an open position in the wallet means REAL, whatever the toggle said: always check on connect
      if (this.live.position && this.engine.kind !== 'live' && !this.paper.position) {
        this.setEngine('live');
        this.liveNoticed = this.live.position.pubkey ?? null;
        this.broadcast({ type: 'event', t: Date.now(), kind: 'info', message: `Open position found in the wallet: ${this.live.position.market} ${this.live.position.side === 1 ? 'LONG' : 'SHORT'} ${this.live.position.leverage.toFixed(1)}x · switched to REAL` });
      }
      this.broadcastStatus(true);
      return { ok: true, message: `Connected ${wallet.slice(0, 4)}…${wallet.slice(-4)}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  liveDisconnect(): void {
    this.live.disconnect();
    this.broadcastStatus(true);
  }

  async liveExecute(id: string, signedTxB64: string): Promise<{ ok: boolean; message: string; txid?: string }> {
    const r = await this.live.execute(id, signedTxB64);
    this.broadcastStatus(true);
    return r;
  }

  liveCancel(id: string): boolean {
    const r = this.live.cancelSign(id);
    this.broadcastStatus(true);
    return r;
  }

  setMode(partial: { view?: ViewMode; invert?: boolean }): ModeState {
    if (partial.view && ['price-only', 'full-dash', 'combined'].includes(partial.view)) this.mode.view = partial.view;
    if (typeof partial.invert === 'boolean') this.mode.invert = partial.invert;
    this.broadcastStatus(true);
    return this.mode;
  }

  shutdown(): void {
    this.feed.stop();
    this.layers.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.solPriceTimer) clearInterval(this.solPriceTimer);
    this.live.disconnect();
    log.info('session', 'shutdown');
  }
}
