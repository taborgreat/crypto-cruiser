// The left panel, laid out like Jupiter's trade form: Long/Short, market with live price, "You're paying"
// in SOL or USDC with its USD value, size, leverage, the horizon knob (Update 4), a summary in plain units
// (Update 6), the lanes as a six-row table (Update 11 B8), the CONDITIONS panel (Update 11 A) above Go,
// Go, Rewind, recent trades. REAL is disabled until Phantom is connected (Update 11 B3).
import { H_MAX, H_MIN, HORIZON_CHIPS } from '../../shared/horizon.js';
import { MAX_LEV_TRADE, MIN_LEV_TRADE } from '../../shared/jupiter.js';
import { tradeSummary } from '../../shared/preview.js';
import { agoSpan } from '../../shared/format.js';
import { MARKETS, type GhostFrame, type GhostParams, type Market, type Side, type TradeRecord } from '../../shared/types.js';
import { api } from './api.js';
import { ConditionsPanel } from './conditions.js';
import { clockTime, fmtHeadway, fmtPct, fmtPrice, fmtSignedUsd, fmtSol, fmtTime, fmtUsd, shortAddr, shortSpan } from './format.js';
import { focusCar, type Store, type UIState } from './state.js';
import { SOL_FEE_RESERVE_UI, connectPhantom, disconnectPhantom, hasPhantom, signAndSendB64 } from './wallet.js';

export interface GhostPanelDeps {
  store: Store;
  onGhostsChanged(ghosts: GhostParams[], primaryId: string): void;
  onGo(): Promise<void>;
  onRewind(): void;
  onSettings(): void;
  onResume(): void;
  onCancelOrder(): void;
  /** Update 17: open a full page (trades / conditions). */
  onPage(kind: 'trades' | 'conditions'): void;
}

const LEV_PRESETS = [5, 10, 25, 50, 100, 150, 250];
const LN_MIN = Math.log(H_MIN), LN_MAX = Math.log(H_MAX);
const LANES: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3]; // 5 H · H · H/6 · now (Update 14)

function sliderToH(v: number): number { return Math.round(Math.exp(LN_MIN + (v / 1000) * (LN_MAX - LN_MIN))); }
function hToSlider(h: number): number { return Math.round(((Math.log(Math.min(H_MAX, Math.max(H_MIN, h))) - LN_MIN) / (LN_MAX - LN_MIN)) * 1000); }
export function laneId(side: Side, lane: number): string { return `${side === 1 ? 'l' : 's'}${lane}`; }

export class GhostPanel {
  mode: 'paper' | 'live' = 'paper';
  market: Market = 'SOL-PERP';
  side: Side = -1;
  leverage = 100;
  inputToken: 'SOL' | 'USDC' = 'SOL';
  inputAmount = 0.25;
  bankroll = 1000;
  limit: number | null = null;
  primaryId = 's3'; // the "if Go now" lane: what Go places
  private busy = false;
  private $: Record<string, HTMLElement> = {};
  private hTimer: number | null = null;
  private tradesAt = 0;
  private tradesBusy = false;
  private lastTradesKey = '';
  private visible = false;
  private laneRows = new Map<string, HTMLElement>();
  private lanesKey = '';
  private conditions: ConditionsPanel;
  private walletConnected = false;

  constructor(private root: HTMLElement, private d: GhostPanelDeps) {
    root.innerHTML = `
      <div class="ghost-panel">
        <div class="gp-top">
          <h1>TRAFFIC</h1>
          <div class="mode-toggle">
            <button data-mode="paper" class="active">PRACTICE</button>
            <button data-mode="live" id="btnLive" disabled title="connect Phantom">REAL</button>
          </div>
        </div>
        <div class="wallet-box" id="walletBox">
          <button id="btnConnect" class="tiny">Connect Phantom</button>
          <span id="walletInfo">not connected</span>
          <button id="btnDisconnect" class="tiny" hidden>disconnect</button>
          <button id="btnCheckPos" class="tiny" hidden title="ask Jupiter for this wallet's open positions">check positions</button>
          <div id="walletRows" class="wallet-rows"></div>
        </div>
        <details class="trading-box" id="tradingBox">
          <summary>Instant signing · trading wallet <span class="muted" id="twState">off</span></summary>
          <div class="muted small">A small wallet whose key lives on this machine (<code>data/trading-wallet.json</code>) signs every action instantly: no Phantom approve screen. Positions then belong to it. Keep it small, fund it from Phantom, withdraw when done. Anyone with that file controls its funds.</div>
          <div class="row wrap" id="twRow">
            <span class="mono small" id="twInfo">no trading wallet yet</span>
            <button id="twCreate" class="tiny">create</button>
            <button id="twUse" class="tiny" hidden>use instant</button>
            <button id="twPhantom" class="tiny" hidden>back to Phantom</button>
          </div>
          <div class="row wrap" id="twFundRow" hidden>
            <label class="small muted">fund <input type="number" id="twAmount" min="0.01" step="0.01" value="0.1" style="width:70px"> SOL</label>
            <button id="twFund" class="tiny">fund from Phantom</button>
            <button id="twWithdraw" class="tiny">withdraw all to Phantom</button>
            <button id="twSwap" class="tiny" hidden title="closed shorts leave USDC behind; swap it back to SOL on Jupiter">swap USDC → SOL</button>
          </div>
        </details>
        <div id="resumeRow" hidden><button class="primary wide" id="btnResume">RESUME</button></div>
        <section class="ticket short" id="ticket">
          <div class="ticket-head"><span>PLACE A POSITION</span><span id="ticketSide" class="short">SHORT ▼</span></div>
        <div class="side-tabs" id="segSide">
          <button data-v="1" class="long">Long</button>
          <button data-v="-1" class="short active">Short</button>
        </div>
        <div class="market-row">
          <div class="seg" id="segMarket">
            <button data-v="SOL-PERP" class="active">SOL</button><button data-v="ETH-PERP">ETH</button><button data-v="BTC-PERP">BTC</button>
          </div>
          <div class="mkt-price"><b id="sPrice">—</b><small id="sFeed"></small></div>
        </div>

        <div class="gp-box">
          <div class="box-head"><span>You're paying</span><span class="muted" id="balance"></span><button class="tiny" id="btnMax">MAX</button></div>
          <div class="box-row">
            <input type="number" id="amount" min="0" step="0.01" value="0.25">
            <div class="seg tok" id="segToken"><button data-v="SOL" class="active">SOL</button><button data-v="USDC">USDC</button></div>
          </div>
          <div class="box-sub"><span id="amountUsd">≈ $—</span><span class="muted" id="bankrollEdit" hidden>practice bankroll <input type="number" id="bankroll" min="10" step="10" value="1000"> USD</span></div>
          <div class="pay-slider"><input type="range" id="payPct" min="0" max="100" step="1" value="0" title="share of what is available"><div class="seg tok" id="payChips"><button data-v="25">25%</button><button data-v="50">50%</button><button data-v="75">75%</button><button data-v="100">MAX</button></div><span class="muted small" id="payMax"></span></div>
        </div>

        <div class="gp-box">
          <div class="box-head"><span>Size of position</span><span class="muted" id="sizeTok"></span></div>
          <div class="box-row"><input type="number" id="sizeUsd" min="0" step="1"><span class="unit">USD</span></div>
        </div>

        <div class="gp-box">
          <div class="box-head"><span>Leverage</span><span class="mono" id="levLabel"></span></div>
          <div class="box-row"><input type="range" id="levRange" min="1.1" max="250" step="0.1" value="100"><input type="number" id="levNum" class="lev" min="1.1" max="250" step="0.1" value="100"></div>
          <div class="presets" id="levPresets">${LEV_PRESETS.map((v) => `<button data-v="${v}">${v}x</button>`).join('')}</div>
        </div>

        <div class="entry-row">
          <span class="muted">Entry</span>
          <button id="btnMarketEntry" class="tiny active">market</button>
          <input type="number" id="limitPrice" step="0.01" placeholder="limit price">
          <button id="btnNudgeBack" class="tiny" title="back [">◂</button><button id="btnNudgeFwd" class="tiny" title="forward ]">▸</button>
        </div>
        <div id="limitHint" class="muted mono small"></div>

        <div class="summary">
          <div class="s-row"><span>Entry price</span><span id="sumEntry" class="mono"></span></div>
          <div class="s-row"><span>Liquidation price</span><span id="sumLiq" class="mono"></span></div>
          <div class="s-row"><span>To liquidation at entry</span><span id="sumGap" class="mono"></span></div>
          <div class="s-row"><span>Open fee</span><span id="sumFee" class="mono"></span></div>
          <div class="s-row"><span>Borrow fee</span><span id="sumBorrow" class="mono"></span></div>
          <div class="s-row"><span>Collateral after fees</span><span id="sumCol" class="mono"></span></div>
        </div>

        </section>

        <div class="gp-box horizon-box">
          <div class="box-head"><span>Horizon <span class="muted">· how much market feels like 20 s of driving</span></span><span class="mono" id="hLabel">H 1 m</span></div>
          <div class="presets" id="hChips">${HORIZON_CHIPS.map((c) => `<button data-v="${c.sec}" title="${fmtTime(c.sec)}">${c.label}</button>`).join('')}</div>
          <div class="box-row"><input type="range" id="hSlider" min="0" max="1000" step="1" value="${hToSlider(60)}"></div>
          <div class="box-sub wrap">
            <label><input type="checkbox" id="hAutoRoom" checked> auto from room</label>
            <label><input type="checkbox" id="hAutoVol"> auto from volatility</label>
            <span id="hEff" class="mono"></span>
          </div>
        </div>

        <div class="msg" id="msg"></div>
        <div class="go-row"><button class="go primary" id="btnGo">GO ⏎</button><span class="go-hint" id="goHint"></span></div>
        <div class="row" id="orderRow" hidden><span class="mono small" id="orderText" style="flex:1;color:var(--yellow)"></span><button id="btnCancelOrder" class="tiny">cancel</button></div>
        <div class="lanes" id="lanesBox">
          <div class="lanes-head"><span>LANES · if Go now · if I had pressed Go…</span><label title="three LONG lanes left, three SHORT lanes right"><input type="checkbox" id="bothSides"> both sides</label><label title="draw every lane; otherwise only the focused lane and the ticked ones"><input type="checkbox" id="showAll"> all lanes</label><button class="tiny" id="onlyMine" title="draw only the focused lane: your car">only mine</button></div>
          <div class="lane-row head"><span>side</span><span>when</span><span>entry</span><span>P&amp;L after fees</span><span>to liq</span><span>liq'd</span><span>time</span></div>
          <div id="lanes"></div>
        </div>

        <div class="readout-line" id="readout">set side, leverage and size — the lanes drive it live</div>

        <div class="page-buttons">
          <button id="pgCond" title="the seven horizons in full, with the watcher's guide">CONDITIONS<small>the read · signals · risk at your leverage</small></button>
          <button id="pgTrades" title="every trade of a wallet, with charts">TRADES<small>every trade · charts · win rate</small></button>
        </div>

        <div class="conditions" id="conditions"></div>
        <button class="wide rewind-btn" id="btnRewind" title="R">REWIND · drive the past with this position</button>

        <details class="trades-box">
          <summary>Recent trades <span class="muted" id="tradesWhere"></span></summary>
          <div id="trades" class="trades-list mono small">—</div>
        </details>

        <div class="warn-box" id="liveWarn" hidden>
          <b>REAL MODE.</b> Go opens a position on Jupiter Perps with real SOL: Phantom signs, Jupiter's keeper fills (usually seconds). Every pedal after
          that is a real transaction to sign. Start small. Shorts use USDC collateral: Jupiter swaps SOL on the way in.
        </div>
        <div class="foot"><span>V top-down / drive · K chase · H help · B chart · I inspect</span><span><button id="btnSettings" class="tiny">settings</button></span></div>
      </div>`;
    for (const id of ['btnLive', 'ticket', 'ticketSide', 'walletBox', 'btnConnect', 'walletInfo', 'btnDisconnect', 'btnCheckPos', 'walletRows', 'tradingBox', 'twState', 'twInfo', 'twCreate', 'twUse', 'twPhantom', 'twFundRow', 'twAmount', 'twFund', 'twWithdraw', 'twSwap', 'pgTrades', 'pgCond', 'onlyMine', 'resumeRow', 'btnResume', 'segSide', 'segMarket', 'sPrice', 'sFeed', 'balance', 'btnMax', 'payPct', 'payChips', 'payMax', 'amount', 'segToken', 'amountUsd', 'bankrollEdit', 'bankroll', 'sizeTok', 'sizeUsd',
      'levLabel', 'levRange', 'levNum', 'levPresets', 'hLabel', 'hChips', 'hSlider', 'hAutoRoom', 'hAutoVol', 'hEff',
      'sumEntry', 'sumLiq', 'sumGap', 'sumFee', 'sumBorrow', 'sumCol', 'btnMarketEntry', 'limitPrice', 'btnNudgeBack', 'btnNudgeFwd', 'limitHint', 'bothSides', 'showAll', 'lanes', 'readout', 'conditions', 'msg', 'btnGo', 'goHint',
      'orderRow', 'orderText', 'btnCancelOrder', 'btnRewind', 'tradesWhere', 'trades', 'liveWarn', 'btnSettings']) {
      this.$[id] = root.querySelector(`#${id}`) as HTMLElement;
    }
    this.conditions = new ConditionsPanel(this.$.conditions);
    root.querySelectorAll<HTMLButtonElement>('.mode-toggle button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode as 'paper' | 'live')));
    this.seg('segSide', (v) => this.setSide(Number(v) as Side));
    this.seg('segMarket', (v) => { this.market = v as Market; this.limit = null; (this.$.limitPrice as HTMLInputElement).value = ''; void api.market(this.market).then((r) => { if (!r.ok) this.msg(r.message); }).catch(() => undefined); });
    this.seg('segToken', (v) => { this.inputToken = v as 'SOL' | 'USDC'; this.inputAmount = v === 'SOL' ? 0.25 : 25; (this.$.amount as HTMLInputElement).value = String(this.inputAmount); });
    (this.$.amount as HTMLInputElement).addEventListener('input', (e) => { this.inputAmount = Math.max(0, Number((e.target as HTMLInputElement).value) || 0); this.changed(); });
    (this.$.sizeUsd as HTMLInputElement).addEventListener('input', (e) => {
      const size = Number((e.target as HTMLInputElement).value) || 0;
      const col = this.collateralUsd();
      if (col > 0) this.setLeverage(size / col, false);
    });
    const lr = this.$.levRange as HTMLInputElement, ln = this.$.levNum as HTMLInputElement;
    lr.addEventListener('input', () => this.setLeverage(Number(lr.value)));
    ln.addEventListener('input', () => this.setLeverage(Number(ln.value) || MIN_LEV_TRADE));
    this.$.levPresets.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => this.setLeverage(Number(b.dataset.v))));
    (this.$.bankroll as HTMLInputElement).addEventListener('input', (e) => { this.bankroll = Number((e.target as HTMLInputElement).value) || 0; this.changed(); });
    this.$.btnMax.addEventListener('click', () => this.max());
    (this.$.payPct as HTMLInputElement).addEventListener('input', (e) => this.setPayPct(Number((e.target as HTMLInputElement).value)));
    this.$.payChips.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => this.setPayPct(Number(b.dataset.v))));
    this.$.btnMarketEntry.addEventListener('click', () => this.setLimit(null));
    (this.$.limitPrice as HTMLInputElement).addEventListener('change', (e) => { const v = Number((e.target as HTMLInputElement).value); this.setLimit(v > 0 ? v : null); });
    this.$.btnNudgeBack.addEventListener('click', () => this.nudgeLimit(-1));
    this.$.btnNudgeFwd.addEventListener('click', () => this.nudgeLimit(1));
    this.$.btnConnect.addEventListener('click', () => void this.connect());
    this.$.btnDisconnect.addEventListener('click', () => void this.disconnect());
    this.$.btnCheckPos.addEventListener('click', () => void this.checkPositions());
    this.$.twCreate.addEventListener('click', () => void this.trading('create'));
    this.$.twUse.addEventListener('click', () => void this.trading('use'));
    this.$.twPhantom.addEventListener('click', () => void this.trading('phantom'));
    this.$.twFund.addEventListener('click', () => void this.fundTrading());
    this.$.twWithdraw.addEventListener('click', () => void this.withdrawTrading());
    this.$.twSwap.addEventListener('click', () => void this.swapUsdc());
    this.$.pgTrades.addEventListener('click', () => this.d.onPage('trades'));
    this.$.pgCond.addEventListener('click', () => this.d.onPage('conditions'));
    this.$.btnGo.addEventListener('click', () => void this.go());
    this.$.btnResume.addEventListener('click', () => this.d.onResume());
    this.$.btnCancelOrder.addEventListener('click', () => this.d.onCancelOrder());
    this.$.btnRewind.addEventListener('click', () => this.d.onRewind());
    this.$.btnSettings.addEventListener('click', () => this.d.onSettings());
    (this.$.bothSides as HTMLInputElement).checked = this.d.store.state.visual.bothSides;
    (this.$.showAll as HTMLInputElement).checked = this.d.store.state.visual.laneShowAll;
    (this.$.showAll as HTMLInputElement).addEventListener('change', (e) => this.d.store.setVisual({ laneShowAll: (e.target as HTMLInputElement).checked }));
    this.$.onlyMine.addEventListener('click', () => { this.d.store.setVisual({ laneShowAll: false, lanesPicked: [] }); (this.$.showAll as HTMLInputElement).checked = false; });
    (this.$.bothSides as HTMLInputElement).addEventListener('change', (e) => { this.d.store.setVisual({ bothSides: (e.target as HTMLInputElement).checked }); this.renderLanes(); this.changed(); });
    // horizon (Update 4)
    this.$.hChips.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => this.setHorizon(Number(b.dataset.v), true)));
    (this.$.hSlider as HTMLInputElement).addEventListener('input', (e) => this.setHorizon(sliderToH(Number((e.target as HTMLInputElement).value)), false));
    (this.$.hSlider as HTMLInputElement).addEventListener('change', (e) => this.setHorizon(sliderToH(Number((e.target as HTMLInputElement).value)), true));
    (this.$.hAutoRoom as HTMLInputElement).addEventListener('change', (e) => void api.settings({ autoHorizonRoom: (e.target as HTMLInputElement).checked }).catch(() => undefined));
    (this.$.hAutoVol as HTMLInputElement).addEventListener('change', (e) => void api.settings({ autoHorizonVol: (e.target as HTMLInputElement).checked }).catch(() => undefined));
    this.refresh();
    this.renderLanes();
    this.changed();
  }

  private seg(id: string, on: (v: string) => void): void {
    const box = this.$[id];
    box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      box.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      on(b.dataset.v!);
      this.refresh();
      this.changed();
    }));
  }

  show(): void { this.visible = true; this.root.hidden = false; }
  hide(): void { this.visible = false; this.root.hidden = true; }

  private bothSides(): boolean { return this.d.store.state.visual.bothSides; }

  private setSide(side: Side): void {
    if (side !== this.side) { this.limit = null; (this.$.limitPrice as HTMLInputElement).value = ''; }
    this.side = side;
    const n = Number(this.primaryId.slice(1));
    const lane = Number.isFinite(n) ? n : 3;
    this.primaryId = laneId(side, lane);
    this.$.segSide.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.v) === side));
    this.$.ticketSide.textContent = side === 1 ? 'LONG ▲' : 'SHORT ▼';
    this.$.ticketSide.className = side === 1 ? 'long' : 'short';
    this.$.ticket.classList.toggle('long', side === 1);
    this.$.ticket.classList.toggle('short', side === -1);
    this.renderLanes();
  }

  /** Update 8: clicking a lane focuses it (and its side); Go opens that side / leverage. */
  focusLane(id: string): void {
    const side: Side = id.startsWith('l') ? 1 : -1;
    const lane = Number(id.slice(1));
    if (!Number.isFinite(lane) || lane < 0 || lane > 3) return;
    if (side !== this.side) this.setSide(side);
    this.primaryId = id;
    for (const [rid, row] of this.laneRows) row.classList.toggle('focused', rid === id);
    this.refresh();
    this.changed();
  }

  private price(): number | null {
    const s = this.d.store.state;
    return s.frame?.price ?? s.price;
  }

  private solPrice(): number | null {
    const st = this.d.store.state.status;
    if (this.market === 'SOL-PERP') return this.price();
    return st?.wallet.solPrice ?? null;
  }

  /** What you pay, in USD: SOL at market or USDC as-is. */
  collateralUsd(): number {
    if (this.inputToken === 'USDC') return this.inputAmount;
    const sp = this.solPrice();
    return sp ? this.inputAmount * sp : 0;
  }

  /** The proposed trade, for the rewind drive. */
  trade(): { side: Side; leverage: number; collateralUsd: number } {
    return { side: this.side, leverage: this.leverage, collateralUsd: this.collateralUsd() || 50 };
  }

  params(): GhostParams[] {
    const col = this.collateralUsd();
    const sides: Side[] = this.bothSides() ? [1, -1] : [this.side];
    const out: GhostParams[] = [];
    for (const side of sides) {
      for (const lane of LANES) {
        const id = laneId(side, lane);
        out.push({ id, lane, side, leverage: this.leverage, collateralUsd: col, entry: id === this.primaryId ? this.limit : null, ageSec: null, ageAuto: true });
      }
    }
    return out;
  }

  goExtra(): { inputToken?: 'SOL' | 'USDC'; inputAmount?: number; bankrollUsd?: number } {
    return this.mode === 'live' ? { inputToken: this.inputToken, inputAmount: this.inputAmount } : { bankrollUsd: this.bankroll };
  }

  private setLeverage(lev: number, syncSize = true): void {
    this.leverage = Math.round(Math.min(MAX_LEV_TRADE, Math.max(MIN_LEV_TRADE, lev)) * 10) / 10;
    (this.$.levRange as HTMLInputElement).value = String(this.leverage);
    if (document.activeElement !== this.$.levNum) (this.$.levNum as HTMLInputElement).value = String(this.leverage);
    this.$.levPresets.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.v) === this.leverage));
    if (syncSize) this.syncSizeField();
    this.changed();
  }

  private syncSizeField(): void {
    if (document.activeElement === this.$.sizeUsd) return;
    const size = this.collateralUsd() * this.leverage;
    (this.$.sizeUsd as HTMLInputElement).value = size > 0 ? size.toFixed(0) : '';
  }

  private setHorizon(h: number, commit: boolean): void {
    this.$.hLabel.textContent = `H ${fmtTime(h)}`;
    if (document.activeElement !== this.$.hSlider) (this.$.hSlider as HTMLInputElement).value = String(hToSlider(h));
    this.$.hChips.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.v) === h));
    if (this.hTimer) clearTimeout(this.hTimer);
    this.hTimer = window.setTimeout(() => { this.hTimer = null; void api.settings({ horizonSec: h }).catch((e: Error) => this.msg(e.message)); }, commit ? 0 : 250);
  }

  /** What can be paid at most: live SOL balance minus the fee reserve, live USDC balance, or the practice bankroll. */
  private maxAmount(): number | null {
    const w = this.d.store.state.status?.wallet;
    if (this.mode === 'live') {
      if (this.inputToken === 'SOL') return w?.solBalance === null || w?.solBalance === undefined ? null : Math.max(0, Math.floor((w.solBalance - SOL_FEE_RESERVE_UI) * 1000) / 1000);
      return w?.usdcBalance === null || w?.usdcBalance === undefined ? null : Math.floor(w.usdcBalance * 100) / 100;
    }
    const sp = this.solPrice();
    return this.inputToken === 'USDC' ? this.bankroll : sp ? Math.floor((this.bankroll / sp) * 1000) / 1000 : null;
  }

  /** The pay slider / chips: a share of what is available (Update 12). */
  private setPayPct(p: number): void {
    const mx = this.maxAmount();
    if (mx === null) { this.msg(this.mode === 'live' ? 'Connect Phantom to read the balance.' : 'Waiting for the price…'); return; }
    const dp = this.inputToken === 'SOL' ? 3 : 2;
    this.inputAmount = Math.max(0, Math.floor(mx * (p / 100) * 10 ** dp) / 10 ** dp);
    (this.$.amount as HTMLInputElement).value = String(this.inputAmount);
    (this.$.payPct as HTMLInputElement).value = String(Math.round(p));
    this.changed();
  }

  private max(): void { this.setPayPct(100); }

  private changed(): void {
    this.$.levLabel.textContent = `${this.leverage.toFixed(1)}x`;
    this.syncSizeField();
    this.refreshSummary();
    this.d.onGhostsChanged(this.params(), this.primaryId);
  }

  /** Update 11 B8: one line per lane (four per side since Update 14); LONG rows then SHORT rows; click focuses. */
  private renderLanes(): void {
    const sides: Side[] = this.bothSides() ? [1, -1] : [this.side];
    const key = sides.join(',');
    const box = this.$.lanes;
    if (key === this.lanesKey && this.laneRows.size) {
      for (const [rid, row] of this.laneRows) row.classList.toggle('focused', rid === this.primaryId);
      return;
    }
    this.lanesKey = key;
    box.innerHTML = '';
    this.laneRows.clear();
    for (const side of sides) {
      for (const lane of LANES) {
        const id = laneId(side, lane);
        const row = document.createElement('div');
        row.className = 'lane-row' + (id === this.primaryId ? ' focused' : '');
        row.dataset.id = id;
        row.innerHTML = `<span class="lr-side ${side === 1 ? 'long' : 'short'}"><input type="checkbox" class="lr-show" title="draw this lane"> ${side === 1 ? 'LONG' : 'SHORT'}</span><span class="lr-when">if Go …</span><span class="lr-entry">—</span><span class="lr-pnl">—</span><span class="lr-liq">—</span><span class="lr-crash">—</span><span class="lr-hw">—</span>`;
        row.addEventListener('click', () => this.focusLane(id));
        const cb = row.querySelector<HTMLInputElement>('.lr-show')!;
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => this.pickLane(id, cb.checked));
        box.appendChild(row);
        this.laneRows.set(id, row);
      }
    }
  }

  /** Update 14: tick a lane to draw it alongside the focused one. */
  private pickLane(id: string, on: boolean): void {
    const cur = this.d.store.state.visual.lanesPicked;
    const next = on ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id);
    this.d.store.setVisual({ lanesPicked: next });
  }

  /** Live numbers in the lane rows without rebuilding them. */
  private renderLanesLight(ghosts: GhostFrame[], price: number, dp: number, ages: [number, number, number], thrOrange: number): void {
    for (const [id, row] of this.laneRows) {
      const g = ghosts.find((x) => x.id === id);
      const lane = Number(id.slice(1));
      const when = row.querySelector('.lr-when')!;
      const entry = row.querySelector('.lr-entry')!;
      const pnl = row.querySelector('.lr-pnl')!;
      const liq = row.querySelector('.lr-liq')!;
      const crash = row.querySelector('.lr-crash')!;
      const hw = row.querySelector('.lr-hw')!;
      const cb = row.querySelector<HTMLInputElement>('.lr-show');
      if (cb) {
        const v = this.d.store.state.visual;
        const focused = id === this.primaryId;
        cb.checked = v.laneShowAll || focused || v.lanesPicked.includes(id);
        cb.disabled = v.laneShowAll || focused;
      }
      if (!g) {
        when.textContent = lane === 3 ? 'if Go now' : `if Go ${agoSpan(ages[lane] ?? 60)} ago`;
        entry.textContent = '—'; pnl.textContent = '—'; liq.textContent = '—'; crash.textContent = '—'; hw.textContent = '—';
        continue;
      }
      when.textContent = g.label;
      row.classList.toggle('crashed', g.crashed);
      row.title = g.readout;
      entry.textContent = fmtPrice(g.entry, dp);
      crash.textContent = g.crash_count ? `${g.crash_count}×` : '0×';
      if (g.crashed) {
        pnl.textContent = 'LIQUIDATED';
        pnl.className = 'lr-pnl';
        liq.textContent = 'respawning';
        hw.textContent = '';
        continue;
      }
      const net = g.pnl_usd - g.fees_usd;
      const netPct = g.collateral_usd > 0 ? (net / g.collateral_usd) * 100 : 0;
      pnl.textContent = `${fmtSignedUsd(net)} (${fmtPct(netPct, true)})`;
      pnl.className = 'lr-pnl';
      liq.textContent = fmtUsd(Math.abs(price - g.liq));
      hw.textContent = fmtHeadway(g.headway_s);
      const h = Math.min(g.headway_s ?? Infinity, g.headway_proj_s ?? Infinity);
      hw.className = `lr-hw${h <= thrOrange ? ' danger' : ''}`;
    }
  }

  setLimit(price: number | null): void {
    const p = this.price();
    if (price !== null && p) {
      if (this.side === -1 && price <= p) price = p * 1.0005;
      if (this.side === 1 && price >= p) price = p * 0.9995;
    }
    this.limit = price;
    (this.$.limitPrice as HTMLInputElement).value = price === null ? '' : price.toFixed(4);
    this.$.btnMarketEntry.classList.toggle('active', price === null);
    this.changed();
  }

  /** Move the limit a tenth of the liquidation distance back (-1) or forward (+1) along the road. */
  nudgeLimit(dir: 1 | -1, carLengths = 0.1): void {
    const p = this.price();
    if (!p) return;
    const base = this.limit ?? p;
    const adverse = this.side === -1 ? 1 : -1;
    const next = base * (1 + (adverse * dir * carLengths) / this.leverage);
    const onMarketSide = this.side === -1 ? next <= p : next >= p;
    this.setLimit(onMarketSide ? null : next);
  }

  /** Drag scrub: `carLengths` forward from the current price. */
  scrubTo(carLengths: number): void {
    const p = this.price();
    if (!p) return;
    if (carLengths <= 0.02) { this.setLimit(null); return; }
    const adverse = this.side === -1 ? 1 : -1;
    this.setLimit(p * (1 + (adverse * carLengths) / this.leverage));
  }

  private setMode(m: 'paper' | 'live'): void {
    if (m === 'live' && !this.walletConnected) { this.msg('Connect Phantom first; REAL needs a wallet.'); return; }
    this.mode = m;
    this.root.querySelectorAll<HTMLButtonElement>('.mode-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    void api.engine(m).then((r) => { if (!r.ok) this.msg(r.message); }).catch((e: Error) => this.msg(e.message));
    this.refresh();
    this.changed();
    this.tradesAt = 0;
  }

  /** Update 22: one row per connected wallet: its position, and RESUME / use. */
  private lastWalletsKey = '';
  private renderWallets(ws: UIState['status'] extends infer S ? (S extends { wallets: infer W } ? W : never) : never): void {
    const key = JSON.stringify(ws.map((w) => [w.address, w.active, w.driving, w.position?.sizeUsd ?? 0, w.position?.liq ?? 0]));
    if (key === this.lastWalletsKey) return;
    this.lastWalletsKey = key;
    const box = this.$.walletRows;
    box.hidden = ws.length === 0;
    box.innerHTML = ws.map((w) => {
      const who = `${w.signer === 'key' ? 'trading wallet' : 'Phantom'} ${shortAddr(w.address)}`;
      const dp = w.position ? MARKETS[w.position.market].priceDp : 3;
      const pos = w.position ? `<b class="${w.position.side === 1 ? 'long' : 'short'}">${w.position.market} ${w.position.side === 1 ? 'LONG' : 'SHORT'} ${w.position.leverage.toFixed(1)}x</b> ${fmtUsd(w.position.sizeUsd, 0)} · liq ${fmtPrice(w.position.liq, dp)}` : '<span class="muted">no position · Go opens here</span>';
      const btn = w.driving ? '<span class="tag driving">DRIVING</span>' : w.position ? `<button class="tiny primary" data-w="${w.address}">RESUME</button>` : w.active ? '<span class="tag">selected</span>' : `<button class="tiny" data-w="${w.address}">use</button>`;
      return `<div class="wrow${w.active ? ' active' : ''}${w.driving ? ' driving' : ''}"><span class="who">${who}</span><span class="pos">${pos}</span>${btn}</div>`;
    }).join('');
    box.querySelectorAll<HTMLButtonElement>('button[data-w]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await api.liveTrading({ action: 'activate', to: b.dataset.w });
        this.msg(r.message, r.ok);
        if (r.ok && /^Driving/.test(r.message)) this.d.onResume();
      } catch (e) { this.msg((e as Error).message); }
    }));
  }

  private msg(text: string, good = false): void {
    this.$.msg.textContent = text;
    this.$.msg.style.color = good ? 'var(--green)' : 'var(--yellow)';
  }

  private refreshSummary(): void {
    const p = this.price();
    const col = this.collateralUsd();
    const asset = MARKETS[this.market].asset;
    const dp = MARKETS[this.market].priceDp;
    this.$.amountUsd.textContent = col > 0 ? `≈ ${fmtUsd(col)}${this.inputToken === 'SOL' && this.solPrice() ? ` at ${fmtPrice(this.solPrice())} / SOL` : ''}` : this.inputToken === 'SOL' ? 'waiting for SOL price…' : '≈ $0';
    const sum = p ? tradeSummary(this.market, { side: this.side, leverage: this.leverage, collateralUsd: col, entry: this.limit }, p) : null;
    const f = this.d.store.state.frame;
    const funding = f?.layers.funding ?? null;
    if (!sum || !p) {
      for (const id of ['sumEntry', 'sumLiq', 'sumGap', 'sumFee', 'sumBorrow', 'sumCol']) this.$[id].textContent = '—';
      this.$.sizeTok.textContent = '';
      return;
    }
    const entry = this.limit ?? p;
    const toLiq = Math.abs(entry - sum.liq);
    this.$.sizeTok.textContent = `= ${fmtSol(sum.sizeUsd / p, asset)}`;
    this.$.sumEntry.textContent = `${fmtPrice(entry, dp)}${this.limit ? ' (limit)' : ' (market)'}`;
    this.$.sumLiq.textContent = fmtPrice(sum.liq, dp);
    this.$.sumGap.textContent = `${fmtUsd(toLiq)} (${fmtPct((toLiq / entry) * 100)})`;
    this.$.sumGap.style.color = sum.gapAtEntry <= 0 ? 'var(--red)' : sum.gapAtEntry < 0.4 ? 'var(--orange)' : '';
    this.$.sumFee.textContent = `${fmtUsd(sum.openFeeUsd)} (6 bps + ${sum.impactBps} bp impact)`;
    this.$.sumBorrow.textContent = funding === null ? 'loading…' : `${fmtUsd(sum.sizeUsd * funding, 3)}/h (${(funding * 100).toFixed(4)}%/h)`;
    this.$.sumCol.textContent = `${fmtUsd(sum.collateralAfterFees)} · effective ${sum.effectiveLeverage.toFixed(1)}× after fees`;
  }

  private async refreshTrades(st: UIState['status']): Promise<void> {
    if (this.tradesBusy) return;
    this.tradesBusy = true;
    try {
      const rows = await api.trades();
      const live = st?.engine === 'live';
      this.$.tradesWhere.textContent = live ? '· on Solana (Jupiter Perps)' : '· practice engine';
      const key = rows.map((r) => `${r.t}:${r.action}:${r.sizeUsd}`).join('|');
      if (key === this.lastTradesKey) return;
      this.lastTradesKey = key;
      if (!rows.length) { this.$.trades.innerHTML = `<div class="muted">${live ? (st?.wallet.address ? 'no trades for this wallet yet' : 'connect Phantom to list trades') : 'no practice trades yet'}</div>`; return; }
      this.$.trades.innerHTML = rows.slice(0, 25).map((r: TradeRecord) => {
        const dp = MARKETS[r.market]?.priceDp ?? 3;
        const pnl = r.pnlUsd === null ? '' : `<b class="${r.pnlUsd >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(r.pnlUsd)}</b>`;
        const tx = r.txid ? `<a href="https://solscan.io/tx/${r.txid}" target="_blank" rel="noopener">tx</a>` : '';
        return `<div class="trade-row"><span class="muted">${clockTime(r.t).slice(0, 8)}</span><span>${r.action}</span><span class="${r.side === 1 ? 'long' : 'short'}">${r.side === 1 ? 'LONG' : 'SHORT'}</span><span>${fmtUsd(r.sizeUsd, 0)}</span><span>@ ${fmtPrice(r.price, dp)}</span>${pnl}<span class="muted">fee ${fmtUsd(r.feeUsd)}</span>${tx}</div>`;
      }).join('');
    } catch {
      /* keep the old list */
    } finally {
      this.tradesBusy = false;
    }
  }

  tradesDirty(): void { this.tradesAt = 0; }

  private pushedLanes = false;

  update(s: UIState): void {
    // the server starts with no lanes: push ours as soon as the first status arrives, not on the first click
    if (!this.pushedLanes && s.status) {
      const p = this.params();
      if (p.length && p[0].collateralUsd > 0) { this.pushedLanes = true; this.d.onGhostsChanged(p, this.primaryId); }
    }
    const st = s.status;
    const dp = MARKETS[this.market].priceDp;
    this.$.sPrice.textContent = fmtPrice(this.price(), dp);
    this.$.sFeed.textContent = st ? `${st.feed.source}${st.feed.animSource && st.feed.animSource !== 'truth' ? ` · anim ${st.feed.animSource}` : ''}${st.feed.connected ? '' : ' (offline)'}` : '';
    if ((this.$.bothSides as HTMLInputElement).checked !== s.visual.bothSides) { (this.$.bothSides as HTMLInputElement).checked = s.visual.bothSides; this.renderLanes(); }
    if (st) {
      const hs = st.settings;
      if (document.activeElement !== this.$.hSlider && !this.hTimer) {
        this.$.hLabel.textContent = `H ${fmtTime(hs.horizonSec)}`;
        (this.$.hSlider as HTMLInputElement).value = String(hToSlider(hs.horizonSec));
        this.$.hChips.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.v) === hs.horizonSec));
      }
      (this.$.hAutoRoom as HTMLInputElement).checked = hs.autoHorizonRoom;
      (this.$.hAutoVol as HTMLInputElement).checked = hs.autoHorizonVol;
      const hz = s.frame?.horizon;
      this.$.hEff.textContent = hz ? `now ${fmtTime(hz.h)} · lanes ${hz.ghost_ages.map((a) => shortSpan(a)).join(' / ')} / now · red under ${fmtTime(hz.thr.orange)}${hz.clear ? ' · CLEAR' : ''}` : '';
      // Update 22: the PRACTICE / REAL tabs follow the server's engine, so a resumed real position never looks like practice
      if (st.engine !== this.mode) {
        this.mode = st.engine;
        this.root.querySelectorAll<HTMLButtonElement>('.mode-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === st.engine));
      }
      this.renderWallets(st.wallets ?? []);
      // Phantom (Update 11 B3): REAL stays disabled until a wallet is connected
      const w = st.wallet;
      this.walletConnected = !!w.address;
      (this.$.btnLive as HTMLButtonElement).disabled = !this.walletConnected;
      this.$.btnLive.title = this.walletConnected ? 'real SOL on Jupiter Perps' : 'connect Phantom';
      if (w.address) {
        this.$.walletInfo.textContent = `${w.signer === 'key' ? 'trading wallet ' : ''}${shortAddr(w.address)} · ${w.positions} open position${w.positions === 1 ? '' : 's'} · ${w.solBalance === null ? '…' : fmtSol(w.solBalance)}${w.solBalance !== null && w.solPrice ? ` (${fmtUsd(w.solBalance * w.solPrice)})` : ''}${w.usdcBalance !== null && w.usdcBalance !== undefined ? ` · ${fmtUsd(w.usdcBalance)} USDC` : ''}`;
        this.$.twSwap.hidden = !(w.signer === 'key' && (w.usdcBalance ?? 0) >= 0.5);
        this.$.twSwap.textContent = `swap ${w.usdcBalance !== null && w.usdcBalance !== undefined ? fmtUsd(w.usdcBalance) + ' ' : ''}USDC → SOL`;
        this.$.btnConnect.hidden = true;
        this.$.btnDisconnect.hidden = false;
      } else {
        this.$.walletInfo.textContent = hasPhantom() ? 'Phantom not connected · needed for REAL' : 'Phantom not detected · needed for REAL';
        this.$.btnConnect.hidden = false;
        this.$.btnDisconnect.hidden = true;
      }
      this.$.btnCheckPos.hidden = !w.address;
      const tw = st.tradingWallet;
      this.$.twState.textContent = tw.active ? 'ON' : tw.address ? 'ready' : 'off';
      this.$.twInfo.textContent = tw.address ? `${shortAddr(tw.address)}${tw.active && w.solBalance !== null ? ` · ${fmtSol(w.solBalance)}` : ''}${tw.active ? ' · signing every action' : ' · not in use'}` : 'no trading wallet yet';
      this.$.twCreate.hidden = !!tw.address;
      this.$.twUse.hidden = !tw.address || tw.active;
      this.$.twPhantom.hidden = !tw.active;
      this.$.twFundRow.hidden = !tw.address;
      if (this.mode === 'live') {
        this.$.balance.textContent = w.solBalance === null ? 'balance —' : `balance ${fmtSol(w.solBalance)}`;
      } else {
        const sp = this.solPrice();
        this.$.balance.textContent = `bankroll ${fmtUsd(this.bankroll, 0)}${sp ? ` ≈ ${fmtSol(this.bankroll / sp)}` : ''}`;
      }
      const pos = st.position;
      const showResume = !!pos && !st.rewind;
      this.$.resumeRow.hidden = !showResume;
      this.$.btnGo.hidden = showResume;
      this.$.btnRewind.hidden = showResume;
      if (showResume && pos) this.$.btnResume.textContent = `RESUME ${pos.market} ${pos.side === 1 ? 'LONG' : 'SHORT'} ${pos.leverage.toFixed(1)}x · liq ${fmtPrice(pos.liq, dp)}`;
      const o = st.pendingOrder;
      this.$.orderRow.hidden = !o;
      if (o) this.$.orderText.textContent = `limit ${o.side === 1 ? 'LONG' : 'SHORT'} ${o.leverage.toFixed(1)}x @ ${fmtPrice(o.triggerPrice, dp)} pending${st.engine === 'live' ? ' on Jupiter' : ''}`;
      if (!st.position && st.engine === 'paper' && document.activeElement !== this.$.bankroll && Math.abs(st.bankrollUsd - this.bankroll) > 0.5) {
        this.bankroll = st.bankrollUsd;
        (this.$.bankroll as HTMLInputElement).value = String(Math.round(st.bankrollUsd));
      }
      if (st.engine !== this.mode && !this.busy) {
        this.mode = st.engine;
        this.root.querySelectorAll<HTMLButtonElement>('.mode-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === this.mode));
        this.refresh();
      }
      const now = performance.now();
      if (this.visible && now - this.tradesAt > 15_000) { this.tradesAt = now; void this.refreshTrades(st); }
    }
    this.refreshSummary();
    this.syncSizeField();
    const mx = this.maxAmount();
    this.$.payMax.textContent = mx === null ? (this.mode === 'live' ? 'balance unknown' : '') : `of ${mx.toFixed(this.inputToken === 'SOL' ? 3 : 2)} ${this.inputToken}`;
    if (document.activeElement !== this.$.payPct) (this.$.payPct as HTMLInputElement).value = String(mx ? Math.max(0, Math.min(100, Math.round((this.inputAmount / mx) * 100))) : 0);
    const fc = focusCar(s.frame, this.primaryId);
    this.updateReadout(fc?.ghost ?? null);
    const ages = s.frame?.horizon.ghost_ages ?? (st ? [st.settings.laneLookbacks[0], st.settings.laneLookbacks[1], st.settings.laneLookbacks[2]] as [number, number, number] : [300, 60, 10]);
    if (s.frame) this.renderLanesLight(s.frame.ghosts, s.frame.price, dp, ages, s.frame.horizon.thr.orange);
    // the conditions sentence (Update 11): the Go button agrees or disagrees with it
    const side = this.conditions.update(s.frame?.conditions ?? null, this.side, dp);
    this.$.btnGo.classList.toggle('agree', side !== 0 && side === this.side);
    this.$.goHint.textContent = side !== 0 && side !== this.side ? `conditions say ${side === 1 ? 'LONG' : 'SHORT'}` : '';
    this.$.goHint.className = `go-hint ${side === 1 ? 'long' : side === -1 ? 'short' : ''}`;
  }

  private updateReadout(g: GhostFrame | null): void {
    const el = this.$.readout;
    if (!g) { el.textContent = 'set side, leverage and size — the lanes drive it live'; el.className = 'readout-line'; return; }
    el.textContent = g.readout;
    el.className = 'readout-line' + (g.crashed ? ' crashed' : g.v_close > 2e-4 ? ' closing' : '');
    const p = this.price();
    const dp = MARKETS[this.market].priceDp;
    if (this.limit !== null && p) {
      this.$.limitHint.textContent = `limit ${fmtPrice(this.limit, dp)} · ${fmtPct((Math.abs(this.limit - p) / p) * 100)} from the mark (${fmtUsd(Math.abs(this.limit - p))}) · shift-drag the road, click the chart, or [ ]`;
    } else this.$.limitHint.textContent = 'market order at the current price · shift-drag the road, click the chart, or [ ] to set a limit';
  }

  private refresh(): void {
    const live = this.mode === 'live';
    this.$.liveWarn.hidden = !live;
    this.$.bankrollEdit.hidden = live;
    const asset = MARKETS[this.market].asset;
    const verb = this.side === 1 ? 'LONG' : 'SHORT';
    this.$.btnGo.textContent = live ? `${verb} ${asset} · OPEN REAL POSITION ⏎` : `${verb} ${asset} · GO ⏎`;
    this.$.btnGo.className = 'go ' + (live ? 'danger' : this.side === 1 ? 'primary long-btn' : 'primary short-btn');
    this.$.levLabel.textContent = `${this.leverage.toFixed(1)}x`;
  }

  private async connect(): Promise<void> {
    try {
      this.msg('Connecting Phantom…');
      const pk = await connectPhantom();
      const r = await api.liveConnect(pk);
      this.msg(r.message, r.ok);
      this.tradesAt = 0;
    } catch (e) {
      this.msg((e as Error).message);
    }
  }

  /** Ask Jupiter for the wallet's open positions and say what it reports (the server switches to REAL when it finds one). */
  private async checkPositions(): Promise<void> {
    try {
      this.msg('Asking Jupiter…');
      const r = await api.livePositions();
      this.msg(r.message, r.positions.length > 0);
      this.tradesAt = 0;
    } catch (e) {
      this.msg((e as Error).message);
    }
  }

  private async trading(action: 'create' | 'use' | 'phantom'): Promise<void> {
    try {
      const r = await api.liveTrading({ action });
      this.msg(r.message, r.ok);
    } catch (e) {
      this.msg((e as Error).message);
    }
  }

  private async phantomPk(): Promise<string> {
    try { return await connectPhantom(true); } catch { return connectPhantom(false); }
  }

  private async fundTrading(): Promise<void> {
    try {
      const amount = Number((this.$.twAmount as HTMLInputElement).value) || 0;
      const from = await this.phantomPk();
      const r = await api.liveTrading({ action: 'fund-tx', from, amountSol: amount });
      if (!r.ok || !r.txB64) { this.msg(r.message); return; }
      this.msg('Sign the transfer in Phantom…');
      const sig = await signAndSendB64(r.txB64);
      this.msg(`Sent ${amount} SOL to the trading wallet (tx ${sig.slice(0, 8)}…). The balance shows after confirmation.`, true);
    } catch (e) {
      this.msg((e as Error).message);
    }
  }

  /** Update 14: the trading wallet's USDC back to SOL through Jupiter (instant signing only). */
  private async swapUsdc(): Promise<void> {
    try {
      this.msg('Swapping USDC → SOL on Jupiter…');
      const r = await api.liveTrading({ action: 'swap-usdc' });
      this.msg(r.message, r.ok);
    } catch (e) {
      this.msg((e as Error).message);
    }
  }

  private async withdrawTrading(): Promise<void> {
    try {
      const to = await this.phantomPk();
      const r = await api.liveTrading({ action: 'withdraw', to });
      this.msg(r.message, r.ok);
    } catch (e) {
      this.msg((e as Error).message);
    }
  }

  private async disconnect(): Promise<void> {
    await disconnectPhantom();
    await api.liveDisconnect().catch(() => undefined);
    if (this.mode === 'live') this.setMode('paper');
    this.msg('Disconnected.');
  }

  async go(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.$.btnGo.setAttribute('disabled', '');
    try {
      if (this.mode === 'live' && !this.d.store.state.status?.wallet.address) { this.msg('Connect Phantom first.'); return; }
      if (!(this.collateralUsd() > 0)) { this.msg('Enter what you are paying.'); return; }
      this.msg(this.mode === 'live' ? 'Requesting a quote from Jupiter…' : '');
      await this.d.onGo();
    } catch (e) {
      this.msg((e as Error).message);
    } finally {
      this.busy = false;
      this.$.btnGo.removeAttribute('disabled');
    }
  }

  setMessage(text: string, good = false): void { this.msg(text, good); }
}
