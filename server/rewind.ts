// Update 7: rewind drive. The car drives from now - lookback to now at lookback / duration speed over the
// recorded tick history, with a LONG and a SHORT lane (or one side) opened at the start and held. Ghosts
// that get liquidated respawn immediately at the mark; the crash count is the information. The horizon
// during the rewind is lookback / 20 so the stretch reads as ~20 s of driving.
import { MarketKinematics, carKinematics, type KinematicsParams } from '../shared/kinematics.js';
import { deriveHorizon } from '../shared/horizon.js';
import { pnlUsd } from '../shared/jupiter.js';
import { previewPosition } from '../shared/preview.js';
import { money, pct, smoney, timeSpan } from '../shared/format.js';
import type { TickHistory } from '../shared/ring.js';
import type { CarFrame, Flag, GhostFrame, Layers, Market, PositionState, RewindLane, RewindParams, RewindState, Side } from '../shared/types.js';

interface Lane {
  side: Side;
  lane: 0 | 1 | 2;
  entry: number;
  entryT: number;
  crashes: number;
  pos: PositionState;
  pnlWindowStart: number | null;  // realized+unrealized reference at the start of the last stretch
}

const num = (x: number): number | null => (Number.isFinite(x) ? x : null);

export class Rewind {
  state: RewindState;
  private lanes: Lane[] = [];
  private kin: MarketKinematics;
  private lastPrice = 0;
  private windowSec: number;

  constructor(private history: TickHistory, public params: RewindParams, public market: Market, nowMs: number, baseParams: Pick<KinematicsParams, 'roadK' | 'roadMin' | 'slamThreshold' | 'lurchThreshold'>) {
    const first = history.first();
    const historyFrom = first ? first.t : nowMs;
    const t0 = Math.max(historyFrom, nowMs - params.lookbackSec * 1000);
    const lookback = Math.max(1, (nowMs - t0) / 1000);
    const h = Math.max(10, lookback / 20);
    const d = deriveHorizon(h);
    this.kin = new MarketKinematics({ velocityEmaSec: d.tauFast, accelEmaSec: d.tauAccel, trendEmaSec: d.tauSlow, ...baseParams });
    this.windowSec = Math.max(30, lookback / 12);
    const sides: Side[] = params.twoSided ? [1, -1] : [params.side];
    const entry = history.priceAt(t0) ?? 0;
    this.lanes = sides.map((side, i) => ({
      side, lane: (params.twoSided ? (i === 0 ? 0 : 1) : 1) as 0 | 1 | 2, entry, entryT: t0, crashes: 0,
      pos: previewPosition(market, { side, leverage: params.leverage, collateralUsd: params.collateralUsd, entry }, entry, t0),
      pnlWindowStart: null,
    }));
    this.state = {
      active: true, done: false, paused: false, t0, t1: nowMs, cursor: t0,
      lookback_sec: lookback, duration_sec: Math.max(5, params.durationSec),
      speed: lookback / Math.max(5, params.durationSec), progress: 0, h,
      lanes: [],
      path: [], crashes: [], flags: [], history_from: historyFrom,
    };
    this.state.lanes = this.lanes.map((l) => this.laneSummary(l, entry));
    this.prepass();
  }

  /** The whole lookback in one pass: downsampled P&L path per lane and every liquidation. */
  private prepass(): void {
    const { t0, t1 } = this.state;
    const samples = this.history.sample(t0, t1, 900);
    const sim = this.lanes.map((l) => ({ side: l.side, entry: l.entry, pos: l.pos }));
    const path: Array<[number, number, number]> = [];
    const crashes: Array<[number, Side]> = [];
    for (const [t, p] of this.history.between(t0, t1)) {
      for (const s of sim) {
        const gap = s.pos.leverage * ((s.side * (p - s.pos.liq)) / p);
        if (gap <= 0) {
          crashes.push([t, s.side]);
          s.entry = p;
          s.pos = previewPosition(this.market, { side: s.side, leverage: this.params.leverage, collateralUsd: this.params.collateralUsd, entry: p }, p, t);
        }
      }
      if (samples.length && t >= samples[0][0]) {
        samples.shift();
        const pn = (s: typeof sim[number]) => (pnlUsd(s.side, s.pos.entry, p, s.pos.sizeUsd) / s.pos.collateralUsd) * 100;
        path.push([t, sim[0] ? pn(sim[0]) : 0, sim[1] ? pn(sim[1]) : 0]);
      }
    }
    this.state.path = path;
    this.state.crashes = crashes.length > 2000 ? crashes.filter((_, i) => i % Math.ceil(crashes.length / 2000) === 0) : crashes;
  }

  pause(): void { this.state.paused = true; }
  resume(): void { if (!this.state.done) this.state.paused = false; }
  setSpeed(mul: number): void { this.state.speed = Math.max(1, Math.min(1e7, this.state.speed * mul)); }
  seek(frac: number): void {
    const { t0, t1 } = this.state;
    this.state.cursor = t0 + Math.min(1, Math.max(0, frac)) * (t1 - t0);
    this.state.done = false;
    this.state.progress = frac;
    this.kin.reset();
    // Re-anchor lanes at the seek point so the drive is consistent from here.
    const p = this.history.priceAt(this.state.cursor) ?? this.lastPrice;
    for (const l of this.lanes) this.respawn(l, p, this.state.cursor, false);
  }
  flag(note = ''): Flag {
    const f: Flag = { t: this.state.cursor, price: this.history.priceAt(this.state.cursor) ?? this.lastPrice, note };
    this.state.flags.push(f);
    return f;
  }

  private respawn(l: Lane, price: number, t: number, count: boolean): void {
    if (count) l.crashes++;
    l.entry = price;
    l.entryT = t;
    l.pos = previewPosition(this.market, { side: l.side, leverage: this.params.leverage, collateralUsd: this.params.collateralUsd, entry: price }, price, t);
  }

  /** Advance the drive by dtReal seconds of wall time. Returns the ghost frames for the lanes. */
  tick(dtReal: number, layersAt: (price: number, side: Side, leverage: number, t: number) => Layers): { price: number; ghosts: GhostFrame[]; layers: Layers } {
    const st = this.state;
    if (!st.paused && !st.done) {
      st.cursor += st.speed * dtReal * 1000;
      if (st.cursor >= st.t1) { st.cursor = st.t1; st.done = true; }
    }
    st.progress = (st.cursor - st.t0) / Math.max(1, st.t1 - st.t0);
    const price = this.history.priceAt(st.cursor) ?? this.lastPrice;
    this.lastPrice = price;
    const m = this.kin.tick(st.cursor, price);
    const focus = this.lanes[0];
    const layers = layersAt(price, focus.side, focus.pos.leverage, st.cursor);
    const d = deriveHorizon(st.h);
    const ghosts: GhostFrame[] = [];
    for (const l of this.lanes) {
      const k = carKinematics({
        side: l.side, leverage: l.pos.leverage, price, entry: l.pos.entry, liq: l.pos.liq,
        vLnP: m.v, aLnP: m.a, vTrend: m.vTrend, aTrend: m.aTrend, roadK: this.kin.params.roadK,
        roadMin: this.kin.params.roadMin, slamThreshold: this.kin.params.slamThreshold, lurchThreshold: this.kin.params.lurchThreshold,
        atrRate: layers.atr_rate,
      });
      let crashed = false;
      if (k.gap <= 0) {
        crashed = true;
        st.crashes.push([st.cursor, l.side]);
        this.respawn(l, price, st.cursor, true);
      }
      const pnl = pnlUsd(l.side, l.pos.entry, price, l.pos.sizeUsd);
      const car: CarFrame = {
        side: l.side, entry: l.pos.entry, liq: l.pos.liq, leverage: l.pos.leverage,
        gap: Math.max(0, k.gap), gap_pct: k.gap_pct, v_gap: k.v_gap, v_close: k.v_close, a_gap: k.a_gap,
        headway_s: num(k.headway_s), headway_proj_s: num(k.headway_proj_s),
        v_road: k.v_road, v_you: k.v_you, v_ahead: k.v_ahead, v_gap_trend: k.v_gap_trend, v_gap_impulse: k.v_gap_impulse, v_gap_liq: 0,
        brake_ahead: k.brake_ahead, slam: k.slam, lurch: k.lurch, gap_anim: Math.max(0, k.gap), throttle: 0, brake: 0,
        pnl_pct: k.fav * l.pos.leverage * 100, pnl_usd: pnl, fees_usd: l.pos.closeFeeUsd, size_usd: l.pos.sizeUsd, collateral_usd: l.pos.collateralUsd,
        free_collateral: 0, entry_dist: k.entry_dist, stop_dist: null, stop_price: null, realized_usd: 0,
      };
      const ageSec = (st.cursor - l.entryT) / 1000;
      ghosts.push({
        ...car,
        id: `rw${l.side === 1 ? 'L' : 'S'}`, lane: l.lane,
        label: `${l.pos.leverage.toFixed(0)}x ${l.side === 1 ? 'LONG' : 'SHORT'} · ${l.crashes} liq`,
        readout: this.laneSummary(l, price).readout,
        is_limit: false, proposed_entry: null, age_sec: ageSec, t_entry: l.entryT, crashed, crash_count: l.crashes,
      });
    }
    st.lanes = this.lanes.map((l) => this.laneSummary(l, price));
    st.h = Math.max(10, st.lookback_sec / 20);
    void d;
    return { price, ghosts, layers };
  }

  private laneSummary(l: Lane, price: number): RewindLane {
    const st = this.state;
    const wStart = Math.max(st.t0, st.cursor - this.windowSec * 1000);
    const p0 = this.history.priceAt(wStart) ?? price;
    const pnlWindow = pnlUsd(l.side, p0, price, l.pos.sizeUsd);      // what this side made over the last stretch, before fees
    const hours = Math.max(1e-6, (st.cursor - wStart) / 3_600_000);
    const movePct = ((price - p0) / p0) * 100;
    const trendPerH = (l.side * movePct) / hours;
    const m = this.kin.state();
    const aAgainst = l.side * m.aTrend < 0;
    const word = trendPerH > 0 ? (aAgainst ? 'pulling away, braking now' : 'pulling away') : trendPerH < 0 ? 'braking' : 'holding';
    const readout = `${l.side === 1 ? 'LONG' : 'SHORT'} ${l.pos.leverage.toFixed(1)}x from ${timeSpan(st.lookback_sec)} ago: liquidated ${l.crashes}× · last ${timeSpan(this.windowSec)}: ${smoney(pnlWindow)} · trend: ${word} (${pct(trendPerH, true)}/h) · now ${money(l.pos.sizeUsd, 0)} at ${l.pos.entry.toFixed(3)}`;
    return { side: l.side, leverage: l.pos.leverage, crashes: l.crashes, window_sec: this.windowSec, window_pnl_usd: pnlWindow, trend_pct_per_h: trendPerH, trend_word: word, readout };
  }
}
