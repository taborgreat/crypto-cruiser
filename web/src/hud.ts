// HUD in plain units (Update 6), laid out per Update 9 §B: one row of chips, toasts in a column top-left,
// TIME TO LIQUIDATION top-centre with its history strip (Update 10 §1), the mirror top-right (Update 10 §2),
// the leverage dial + tiles row, the pedals row. Text updates at 10 Hz, the needle and the strip at 60 Hz.
import { headwayColor, type HeadwayColor } from '../../shared/kinematics.js';
import { HORIZON_CHIPS } from '../../shared/horizon.js';
import { closeFeeUsd, liquidationPrice, pnlUsd } from '../../shared/jupiter.js';
import { MARKET_PRICING } from '../../shared/preview.js';
import { trendWord } from '../../shared/readout.js';
import { MARKETS, type CarFrame, type Frame, type PedalAction, type Settings } from '../../shared/types.js';
import { KEY_HELP } from './controls.js';
import { clockTime, fmtHeadway, fmtPct, fmtPrice, fmtRate, fmtSignedUsd, fmtSol, fmtTime, fmtUsd, clamp, shortSpan } from './format.js';
import { HEADWAY_RGB, LANE_COLORS, type TopInfo } from './renderer.js';
import { focusCar, type HeadwaySample, type UIState, type UiEvent } from './state.js';

export interface HudHandlers {
  onPedal(a: PedalAction): void;
  onSettings(): void;
  onRewind(): void;
  onRenderer(): void;
  onTags(): void;
  onMute(): void;
  onChase(): void;
  onTopDown(): void;
  onExit(): void;
  onHelp(): void;
  onInspect(): void;
  onChart(): void;
  onLabels(): void;
  onStripClick(t: number, price: number): void;
  onExits(): void;
  onPage(kind: 'trades' | 'conditions'): void;
  /** Update 19: the horizon from the chip; null = back to auto. */
  onHorizon(sec: number | null): void;
  /** Update 21: the mirror canvas was resized by its grip. */
  onMirrorHeight(px: number): void;
}

// Update 21: every pedal says what it does to the position; the exit is unmistakable and red
const PEDALS: Array<{ key: string; label: string; sub: string; action: PedalAction; cls: 'add' | 'close' | 'sellall' | 'danger' | 'cruise' }> = [
  { key: 'W', label: 'GAS', sub: 'add size · closer to it', action: 'gas_light', cls: 'add' },
  { key: '⇧W', label: 'HARD GAS', sub: 'add size, no collateral', action: 'gas_hard', cls: 'danger' },
  { key: 'C', label: 'BACK OFF', sub: 'add collateral · more room', action: 'coast', cls: 'add' },
  { key: 'S', label: 'BRAKE', sub: 'close part · the exit', action: 'brake_light', cls: 'close' },
  { key: '␣', label: 'FULL BRAKE', sub: 'CLOSE EVERYTHING · the exit', action: 'brake_full', cls: 'sellall' },
  { key: 'X', label: 'WITHDRAW', sub: 'pull collateral · closer to it', action: 'withdraw', cls: 'danger' },
  { key: 'T', label: 'CRUISE', sub: 'trailing stop', action: 'cruise', cls: 'cruise' },
];
// Update 25: in CHASE every key does exactly what it does in TRAFFIC; only the words change, to what the action
// does to the one behind you
// Update 26: same keys, same positions, same colours as TRAFFIC; the verbs are the chase's: gaining distance from the cop
const PEDALS_CHASE: typeof PEDALS = [
  { key: 'W', label: 'SLOW DOWN', sub: 'add size · it gains on you', action: 'gas_light', cls: 'add' },
  { key: '⇧W', label: 'STALL', sub: 'add size, no collateral · it gains fast', action: 'gas_hard', cls: 'danger' },
  { key: 'C', label: 'PULL AHEAD', sub: 'add collateral · it falls back', action: 'coast', cls: 'add' },
  { key: 'S', label: 'SPEED UP', sub: 'close part · it falls back · the exit', action: 'brake_light', cls: 'close' },
  { key: '␣', label: 'FLOOR IT', sub: 'CLOSE EVERYTHING · you are gone', action: 'brake_full', cls: 'sellall' },
  { key: 'X', label: 'DRAG', sub: 'pull collateral · it gains on you', action: 'withdraw', cls: 'danger' },
  { key: 'T', label: 'CRUISE', sub: 'trailing stop', action: 'cruise', cls: 'cruise' },
];

const MAX_TOASTS = 3;

function el<T extends Element>(root: ParentNode, sel: string): T {
  const e = root.querySelector(sel);
  if (!e) throw new Error(`HUD element ${sel} missing`);
  return e as T;
}

/** What each pedal would do right now, in dollars (Update 6). */
export function pedalTooltip(action: PedalAction, c: CarFrame, f: Frame, s: Settings): string {
  const p = s.pedal;
  const pricing = MARKET_PRICING[f.market];
  const dp = MARKETS[f.market].priceDp;
  const liqWith = (collateral: number, size: number) => liquidationPrice({ side: c.side, entry: c.entry, sizeUsd: size, collateralUsd: collateral, closeFeeUsd: closeFeeUsd(size, pricing), borrowFeeUsd: 0 });
  switch (action) {
    case 'gas_light': { const dSize = c.size_usd * p.gasSizeFrac; return `W gas: add ${fmtUsd(dSize / c.leverage)} collateral + ${fmtUsd(dSize, 0)} size (same leverage)`; }
    case 'gas_hard': { const dSize = c.size_usd * p.gasSizeFrac; return `⇧W HARD gas: add ${fmtUsd(dSize, 0)} size, no collateral → ${((c.size_usd + dSize) / c.collateral_usd).toFixed(1)}x · liq moves to ${fmtPrice(liqWith(c.collateral_usd, c.size_usd + dSize), dp)}`; }
    case 'coast': { const d = Math.max(1, c.collateral_usd * p.coastCollateralFrac); return `C back off: add ${fmtUsd(d)} collateral → liq moves to ${fmtPrice(liqWith(c.collateral_usd + d, c.size_usd), dp)}`; }
    case 'brake_light': return `S brake: close ${Math.round(p.brakeSizeFrac * 100)}% ≈ ${fmtUsd(c.size_usd * p.brakeSizeFrac, 0)} (${fmtSol((c.size_usd * p.brakeSizeFrac) / f.price, MARKETS[f.market].asset)})`;
    case 'brake_full': return `Space FULL brake: close all ${fmtUsd(c.size_usd, 0)} → realized ≈ ${fmtSignedUsd(c.pnl_usd - c.fees_usd)}`;
    case 'withdraw': { const d = c.collateral_usd * p.withdrawFrac; return `X withdraw ${fmtUsd(d)} collateral → liq moves to ${fmtPrice(liqWith(c.collateral_usd - d, c.size_usd), dp)} (closer)`; }
    case 'cruise': return `T trailing stop ${fmtPct((p.cruiseDistance / c.leverage) * 100)} behind the price (follows it)`;
    default: return '';
  }
}

export class Hud {
  private $: Record<string, HTMLElement> = {};
  private needle!: SVGLineElement;
  private arc!: SVGPathElement;
  private mirrorCanvas!: HTMLCanvasElement;
  private stripCanvas!: HTMLCanvasElement;
  private bannerKind: string | null = null;
  private bannerUntil = 0;
  private lastTooltipT = 0;
  private statusToast: HTMLElement | null = null;
  private lastStripSpan = 60;
  private lastMirror: { f: Frame; c: CarFrame } | null = null;
  private lastPodPrice: number | null = null;

  constructor(private root: HTMLElement, private h: HudHandlers) {
    root.innerHTML = `
      <div class="live-border" id="liveBorder" hidden></div>
      <div class="rear-strip" id="rearStrip" hidden><span>MIRROR · behind you</span></div>
      <div class="hud-top">
        <div class="chips" id="chips">
          <span class="chip mode" id="chipMode">PRACTICE</span>
          <span class="chip ghost" id="chipGhost" hidden>PREVIEW</span>
          <span class="chip rewind" id="chipRewind" hidden>REWIND</span>
          <span class="chip" id="chipMarket">—</span>
          <span class="chip price" id="chipPrice" hidden>—</span>
          <span class="chip" id="chipHorizon" title="click: change the horizon" style="cursor:pointer;pointer-events:auto">H —</span>
          <span class="chip" id="chipFeed">feed —</span>
          <span class="chip" id="chipView">price-only</span>
          <span class="chip" id="chipInvert" hidden>INVERT</span>
          <span class="chip warn" id="chipOrder" hidden>LIMIT PENDING</span>
          <span class="chip more" id="chipMore" hidden style="position:absolute;right:0;top:0">···</span>
        </div>
        <div class="hz-menu" id="hzMenu" hidden></div>
        <div class="hud-buttons">
          <button data-act="topdown" id="btnTop" title="V · top-down / drive">top-down</button>
          <button data-act="chase" id="btnChase" title="K · switch: TRAFFIC (the car in front) ↔ CHASE (the police car behind you)">TRAFFIC</button>
          <button data-act="renderer" id="btnRenderer">3D</button>
          <button data-act="tags" id="btnTags" title="the tags above the cars: on / faded / to the side / off">tags: on</button>
          <button data-act="mute" id="btnMute" title="mute everything">🔊</button>
          <button data-act="chart" title="B">chart</button>
          <button data-act="exits" id="btnExits" title="take profit / stop loss" hidden>exits</button>
          <button data-act="exit" id="btnExit">menu</button>
          <button data-act="more" id="btnMore" title="more">⋯</button>
          <div class="hud-menu" id="hudMenu" hidden>
            <button data-act="rewind" title="R">rewind drive</button>
            <button data-act="labels" title="L">label everything</button>
            <button data-act="inspect" title="I">inspect panel</button>
            <button data-act="help" title="H">keys and help</button>
            <button data-act="page-trades" title="every trade of a wallet, with charts">trades page</button>
            <button data-act="page-conditions" title="the seven horizons in full">conditions page</button>
            <button data-act="settings" title="Esc">settings</button>
          </div>
        </div>
      </div>
      <div class="toasts" id="toasts"></div>
      <div class="pricepod" id="pricePod" title="the live oracle price: your car"><div class="pp-main"><span id="ppPrice">—</span><span class="pp-dir" id="ppDir"></span></div><div class="pp-sub" id="ppSub">live price</div></div>
      <div class="hud-right">
      <div class="headway green" id="headway">
        <div class="hw-label" id="hwLabel">TIME TO LIQUIDATION</div>
        <div class="hw-main" id="hwMain">—</div>
        <div class="hw-sub"><span id="hwDist">—</span> · projected <span id="hwProj">—</span></div>
        <div class="hw-strip-wrap">
          <canvas class="hw-strip" id="hwStrip" width="330" height="16" title="history of time to liquidation"></canvas>
          <div class="hw-ticks"><span id="hwT0">−60 s</span><span id="hwT1">−30 s</span><span>now</span></div>
          <div class="hw-caption" id="hwCaption">history</div>
        </div>
        <div class="clear-tag" id="clearTag" hidden>CLEAR</div>
      </div>
      <div class="mirror" id="mirror">
        <div class="m-title" id="mTitle">MIRROR</div>
        <div class="m-row"><span>entry line</span><span id="mEntry">—</span></div>
        <div class="m-row"><span>trailing stop</span><span id="mStop">none · T to set</span></div>
        <canvas id="mirrorCanvas" width="270" height="112"></canvas>
      </div>
      </div>
      <div class="scalebar" id="scaleBar" hidden><div id="sbMain">—</div><div class="sb-bar"></div><div class="sb-sub" id="sbSub">per screen-cm</div></div>
      <div class="dash-numbers" id="dashNumbers" hidden>
        <div class="m-title">FULL DASH</div>
        <div class="m-row"><span>volatility 1 m</span><span id="dnAtr">—</span></div>
        <div class="m-row"><span>volatility 5 m</span><span id="dnAtr5">—</span></div>
        <div class="m-row"><span>borrow</span><span id="dnFunding">—</span></div>
        <div class="m-row"><span>utilization</span><span id="dnUtil">—</span></div>
        <div class="m-row"><span>spread</span><span id="dnSpread">—</span></div>
        <div class="m-row"><span>oracle vs feed</span><span id="dnBasis">—</span></div>
        <div class="m-row"><span>price</span><span id="dnPrice">—</span></div>
        <div class="m-row"><span>horizon</span><span id="dnH">—</span></div>
        <div class="m-row"><span>candles 1m</span><span id="dnCandles">—</span></div>
      </div>
      <div class="hud-stack" id="hudStack">
      <div class="hud-bottom">
        <div class="gauge speedo">
          <div class="g-label">LEVERAGE</div>
          <svg viewBox="0 0 200 110" id="speedoSvg">
            <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="10" />
            <path id="speedoArc" d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#ffffff" stroke-width="10" stroke-dasharray="251.3" stroke-dashoffset="251.3" />
            <g id="speedoTicks" font-family="monospace" font-size="9" fill="#9a93b8"></g>
            <line id="needle" x1="100" y1="100" x2="100" y2="30" stroke="#fff" stroke-width="3" stroke-linecap="round" />
            <circle cx="100" cy="100" r="5" fill="#fff" />
          </svg>
          <div class="g-value" id="spLev">—</div>
          <div class="g-sub" id="spSub">—</div>
          <div class="pedal-bars">
            <div class="pb"><span>THROTTLE</span><div class="bar"><div id="barThrottle"></div></div></div>
            <div class="pb"><span>BRAKE</span><div class="bar brake"><div id="barBrake"></div></div></div>
          </div>
          <div id="sideNumbers"><div><span>POSITION</span><b id="snSize">—</b></div><div><span>AVAILABLE</span><b id="snFuel">—</b></div></div>
        </div>
        <div class="readouts">
          <div class="readout" id="rGap"><div class="r-label" id="rGapL">TO LIQUIDATION</div><div class="r-value" id="rGapV">—</div><div class="r-sub" id="rGapS">—</div></div>
          <div class="readout" id="rPnl"><div class="r-label">P&amp;L · AFTER FEES</div><div class="r-value" id="rPnlV">—</div><div class="r-sub" id="rPnlS">—</div></div>
          <div class="readout" id="rEntry"><div class="r-label">FROM ENTRY</div><div class="r-value" id="rEntryV">—</div><div class="r-sub" id="rEntryS">—</div></div>
          <div class="readout secondary" id="rSize"><div class="r-label">POSITION</div><div class="r-value" id="rSizeV">—</div><div class="r-sub" id="rSizeS">—</div></div>
          <div class="readout secondary" id="rFuel"><div class="r-label" id="fuelLabel">AVAILABLE</div><div class="r-value" id="fuelV">—</div><div class="bar"><div id="fuelBar" style="width:0%"></div></div><div class="r-sub" id="fuelS">—</div></div>
        </div>
      </div>
      <div class="pedals" id="pedals"></div>
      </div>
      <div class="banner" id="banner" hidden><h2 id="bannerTitle"></h2><p id="bannerText"></p><button id="bannerBtn" hidden>back to menu</button></div>
      <div class="help" id="help" hidden><h3>CONTROLS</h3><table id="helpTable"></table><p style="color:var(--muted);font-size:12px;margin:10px 0 0">Your car never moves on screen. The car ahead is your liquidation price. Time to liquidation is how long until you hit it at the current rate. Before you commit, each lane drives the position as if you had pressed Go that long ago; from above you compare their spacing, from the seat you feel the closing speed. Hover anything for its price and time.</p></div>
    `;
    for (const id of ['liveBorder', 'rearStrip', 'hzMenu', 'chips', 'chipMode', 'chipGhost', 'chipRewind', 'chipMarket', 'chipPrice', 'chipHorizon', 'chipFeed', 'chipView', 'chipInvert', 'chipOrder', 'chipMore', 'hudMenu', 'btnExits', 'btnTop', 'btnRenderer', 'btnTags', 'btnChase', 'btnMute', 'btnExit',
      'toasts', 'pricePod', 'ppPrice', 'ppDir', 'ppSub', 'headway', 'hwLabel', 'hwMain', 'hwDist', 'hwProj', 'hwT0', 'hwT1', 'hwCaption', 'clearTag', 'mirror', 'mTitle', 'mEntry', 'mStop', 'scaleBar', 'sbMain', 'sbSub',
      'dashNumbers', 'dnAtr', 'dnAtr5', 'dnFunding', 'dnUtil', 'dnSpread', 'dnBasis', 'dnPrice', 'dnH', 'dnCandles',
      'speedoTicks', 'spLev', 'spSub', 'barThrottle', 'barBrake', 'snSize', 'snFuel', 'rGap', 'rGapL', 'rGapV', 'rGapS', 'rPnl', 'rPnlV', 'rPnlS', 'rEntry', 'rEntryV', 'rEntryS',
      'hudStack', 'rSize', 'rSizeV', 'rSizeS', 'rFuel', 'fuelLabel', 'fuelV', 'fuelBar', 'fuelS', 'pedals', 'banner', 'bannerTitle', 'bannerText', 'bannerBtn', 'help', 'helpTable']) {
      this.$[id] = el(root, `#${id}`);
    }
    this.needle = el<SVGLineElement>(root, '#needle');
    this.arc = el<SVGPathElement>(root, '#speedoArc');
    this.mirrorCanvas = el<HTMLCanvasElement>(root, '#mirrorCanvas');
    // Update 21: a grip under the mirror; drag to resize
    {
      const grip = document.createElement('div');
      grip.className = 'm-grip';
      grip.title = 'drag to resize the mirror';
      this.mirrorCanvas.insertAdjacentElement('afterend', grip);
      let startY = 0, startH = 0;
      grip.addEventListener('pointerdown', (e) => { startY = e.clientY; startH = this.mirrorH; this.mirrorDragging = true; grip.setPointerCapture(e.pointerId); e.preventDefault(); });
      grip.addEventListener('pointermove', (e) => { if (!this.mirrorDragging) return; this.setMirrorHeight(Math.max(48, Math.min(320, startH + (e.clientY - startY)))); });
      const end = (e: PointerEvent) => { if (!this.mirrorDragging) return; this.mirrorDragging = false; try { grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ } this.h.onMirrorHeight(this.mirrorH); };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    }
    // Update 21: popovers close on a click anywhere else
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!this.$.hzMenu.hidden && !this.$.hzMenu.contains(t) && t !== this.$.chipHorizon) this.$.hzMenu.hidden = true;
      if (!this.$.hudMenu.hidden && !this.$.hudMenu.contains(t) && !t.closest('#btnMore')) this.$.hudMenu.hidden = true;
    });
    this.stripCanvas = el<HTMLCanvasElement>(root, '#hwStrip');

    const ticks = this.$.speedoTicks;
    for (const v of [0, 50, 100, 150, 200, 250]) {
      const a = (-120 + (240 * v) / 250) * (Math.PI / 180);
      const x = 100 + Math.sin(a) * 62, y = 100 - Math.cos(a) * 62;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', String(x)); t.setAttribute('y', String(y + 3)); t.setAttribute('text-anchor', 'middle');
      t.textContent = `${v}x`;
      ticks.appendChild(t);
    }
    this.buildPedals('traffic');
    this.$.helpTable.innerHTML = KEY_HELP.map(([k, d]) => `<tr><td>${k}</td><td>${d}</td></tr>`).join('');
    // Update 19: the horizon from inside the drive
    this.$.hzMenu.innerHTML = `<span class="muted">horizon</span>${HORIZON_CHIPS.map((c) => `<button data-hz="${c.sec}">${c.label}</button>`).join('')}<button data-hz="auto">auto</button>`;
    this.$.chipHorizon.addEventListener('click', () => { this.$.hzMenu.hidden = !this.$.hzMenu.hidden; });
    this.$.hzMenu.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => { this.$.hzMenu.hidden = true; this.h.onHorizon(b.dataset.hz === 'auto' ? null : Number(b.dataset.hz)); }));
    root.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'more') { this.$.hudMenu.hidden = !this.$.hudMenu.hidden; return; }
        this.$.hudMenu.hidden = true;
        if (act === 'settings') this.h.onSettings();
        else if (act === 'rewind') this.h.onRewind();
        else if (act === 'renderer') this.h.onRenderer();
        else if (act === 'tags') this.h.onTags();
        else if (act === 'mute') this.h.onMute();
        else if (act === 'chase') this.h.onChase();
        else if (act === 'topdown') this.h.onTopDown();
        else if (act === 'exit') this.h.onExit();
        else if (act === 'help') this.h.onHelp();
        else if (act === 'inspect') this.h.onInspect();
        else if (act === 'chart') this.h.onChart();
        else if (act === 'labels') this.h.onLabels();
        else if (act === 'exits') this.h.onExits();
        else if (act === 'page-trades') this.h.onPage('trades');
        else if (act === 'page-conditions') this.h.onPage('conditions');
      });
    });
    this.$.bannerBtn.addEventListener('click', () => { this.hideBanner(); this.h.onExit(); });
    this.stripCanvas.addEventListener('click', (e) => {
      const hit = this.stripSampleAt(e);
      if (hit) this.h.onStripClick(hit.t, hit.price);
    });
    // the bottom stack reserves its height: the road ends above it, nothing is drawn over the lane (Update 9 §B)
    const stage = root.parentElement;
    const reserve = () => { if (stage) { stage.style.setProperty('--hud-bottom-h', `${this.$.hudStack.offsetHeight + 12}px`); window.dispatchEvent(new Event('resize')); } };
    new ResizeObserver(reserve).observe(this.$.hudStack);
    reserve();
  }

  get stackEl(): HTMLElement { return this.$.hudStack; }
  get mirrorEl(): HTMLCanvasElement { return this.mirrorCanvas; }
  get stripEl(): HTMLCanvasElement { return this.stripCanvas; }

  private hist: HeadwaySample[] = [];
  private histNow = 0;
  private stripSampleAt(e: MouseEvent): HeadwaySample | null {
    if (!this.hist.length) return null;
    const r = this.stripCanvas.getBoundingClientRect();
    const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
    const t = this.histNow - (1 - frac) * this.lastStripSpan * 1000;
    let best = this.hist[0];
    for (const s of this.hist) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best;
  }

  /** Update 10 §1 hover: `t −23 s · 1 m 40 s to liq · $0.31 away`. */
  stripHover(e: MouseEvent): string[] | null {
    const s = this.stripSampleAt(e);
    if (!s) return null;
    const hw = Math.min(s.h ?? Infinity, s.proj ?? Infinity);
    return [`t −${fmtTime((this.histNow - s.t) / 1000)} · ${fmtHeadway(Number.isFinite(hw) ? hw : null)} to liq${s.toLiq !== null ? ` · ${fmtUsd(s.toLiq)} away` : ''}`, `price ${fmtPrice(s.price)} · click to see it on the chart`, `t = ${clockTime(s.t)}`];
  }

  setHelp(visible: boolean): void { this.$.help.hidden = !visible; }

  /** REAL (Update 14): the pedal waiting for its confirming press. */
  arm(action: string | null): void {
    this.$.pedals.querySelectorAll<HTMLElement>('.pedal.armed').forEach((b) => b.classList.remove('armed'));
    if (!action) return;
    const b = this.$.pedals.querySelector<HTMLElement>(`[data-action="${action}"]`);
    if (b) b.classList.add('armed');
  }
  private pedalMode: 'traffic' | 'chase' = 'traffic';
  /** Update 23: the pedal row for a mode; CHASE relabels and re-keys so the picture and the action agree. */
  private buildPedals(mode: 'traffic' | 'chase'): void {
    this.pedalMode = mode;
    this.$.pedals.innerHTML = '';
    for (const p of mode === 'chase' ? PEDALS_CHASE : PEDALS) {
      const b = document.createElement('div');
      b.className = `pedal ${p.cls}`;
      b.dataset.action = p.action;
      b.innerHTML = `<span class="pk"><kbd>${p.key}</kbd> ${p.label}</span><small>${p.sub}</small>`;
      b.addEventListener('click', () => this.h.onPedal(p.action));
      this.$.pedals.appendChild(b);
    }
  }
  pedalName(action: string): string {
    const p = (this.pedalMode === 'chase' ? PEDALS_CHASE : PEDALS).find((x) => x.action === action);
    return p ? `${p.key} ${p.label}` : action;
  }

  private mirrorH = 96;
  private mirrorDragging = false;
  private setMirrorHeight(px: number): void {
    this.mirrorH = px;
    this.mirrorCanvas.style.height = `${px}px`;
  }

  flash(action: string): void {
    const b = this.$.pedals.querySelector<HTMLElement>(`[data-action="${action}"]`) ?? (action === 'cruise_off' ? this.$.pedals.querySelector<HTMLElement>('[data-action="cruise"]') : null);
    if (!b) return;
    b.classList.add('flash');
    setTimeout(() => b.classList.remove('flash'), 180);
  }

  /** Toasts: one column top-left, newest first, max 3, auto-dismiss 6 s, click to pin (Update 9 A3). */
  toast(ev: UiEvent, cls: '' | 'err' | 'warn' | 'good' = '', ms = 6000): void {
    const d = document.createElement('div');
    d.className = `toast ${cls}`;
    d.textContent = ev.message;
    d.title = clockTime(ev.t);
    d.addEventListener('click', () => d.classList.toggle('pinned'));
    const first = this.$.toasts.querySelector('.toast:not(.status)');
    if (first) this.$.toasts.insertBefore(d, first); else this.$.toasts.appendChild(d);
    const regular = [...this.$.toasts.querySelectorAll<HTMLElement>('.toast:not(.status)')];
    let visible = 0;
    for (const t of regular) {
      visible++;
      if (visible > MAX_TOASTS && !t.classList.contains('pinned')) t.remove();
    }
    setTimeout(() => { if (!d.classList.contains('pinned')) d.remove(); }, ms);
  }

  banner(kind: 'liquidated' | 'closed' | 'info' | 'wait', title: string, text: string, sticky = false): void {
    const b = this.$.banner;
    b.hidden = false;
    b.className = 'banner' + (kind === 'closed' ? ' good' : kind === 'info' || kind === 'wait' ? ' info' : '');
    this.$.bannerTitle.textContent = title;
    this.$.bannerText.innerHTML = kind === 'wait' ? `<span class="spinner"></span>${text}` : text;
    this.$.bannerBtn.hidden = !(kind === 'liquidated' || kind === 'closed');
    this.bannerKind = kind;
    this.bannerUntil = sticky ? Infinity : Date.now() + 6000;
  }

  hideBanner(): void {
    this.$.banner.hidden = true;
    this.bannerKind = null;
  }

  /** Connection / keeper status as a pinned toast at the top of the column. Clears itself when passed null. */
  statusBanner(kind: 'wait' | 'info' | null, title = '', text = ''): void {
    if (!kind) { this.statusToast?.remove(); this.statusToast = null; return; }
    if (!this.statusToast) {
      this.statusToast = document.createElement('div');
      this.statusToast.className = 'toast status';
      this.$.toasts.prepend(this.statusToast);
    }
    this.statusToast.innerHTML = `<b>${title}</b>${kind === 'wait' ? '<span class="spinner"></span>' : ''}${text}`;
  }

  /** Update 8 scale bar: `$0.038 / cm · 0.035%`. */
  scaleBar(info: TopInfo | null): void {
    this.$.scaleBar.hidden = !info;
    if (!info) return;
    this.$.sbMain.textContent = `${fmtUsd(info.usdPerCm, info.usdPerCm < 0.01 ? 4 : info.usdPerCm < 1 ? 3 : 2)} / cm`;
    this.$.sbSub.textContent = `${fmtPct(info.pctPerCm)} per screen-cm${info.broken ? ' · axis broken: near road compressed' : ''}${info.spreadUsd > 0 ? ` · spread ${fmtUsd(info.spreadUsd, info.spreadUsd < 0.01 ? 4 : 3)}` : ''}`;
  }

  /** 60 Hz: the needle, the arc and the strip. */
  fast(s: UIState): void {
    const f = s.frame;
    const fc = focusCar(f, s.primaryGhostId);
    const thr = f?.horizon.thr ?? { green: 60, yellow: 20, orange: 5, critical: 1 };
    const lev = clamp(fc?.car.leverage ?? 0, 0, 250);
    const ang = -120 + (240 * lev) / 250;
    this.needle.setAttribute('transform', `rotate(${ang} 100 100)`);
    this.arc.setAttribute('stroke-dashoffset', String(251.3 * (1 - lev / 250)));
    const color: HeadwayColor = fc ? headwayColor(Math.min(fc.car.headway_s ?? Infinity, fc.car.headway_proj_s ?? Infinity), thr) : 'green';
    this.arc.setAttribute('stroke', color === 'red' ? HEADWAY_RGB.red : '#ffffff');
    this.hist = s.headwayHistory;
    this.histNow = f?.t ?? Date.now();
    // the live price: the most obvious number on screen, flashes green / red on every oracle move
    if (f && f.price !== this.lastPodPrice) {
      const dir = this.lastPodPrice === null ? '' : f.price > this.lastPodPrice ? 'up' : 'down';
      this.lastPodPrice = f.price;
      this.$.ppPrice.textContent = fmtPrice(f.price, MARKETS[f.market].priceDp);
      if (dir) {
        this.$.ppDir.textContent = dir === 'up' ? '▲' : '▼';
        this.$.ppDir.className = `pp-dir ${dir}`;
        this.$.pricePod.classList.remove('up', 'down');
        void this.$.pricePod.offsetWidth;
        this.$.pricePod.classList.add(dir);
      }
    }
    this.drawStrip(s.headwayHistory, thr, Math.max(60, Math.min(3600, f?.horizon.h ?? 60)), this.histNow);
  }

  /** 10 Hz: everything textual. */
  update(s: UIState): HeadwayColor {
    const f = s.frame;
    const st = s.status;
    const live = st?.engine === 'live';
    const rewind = !!f?.rewind;
    const ghostMode = s.screen === 'ghost';
    this.$.liveBorder.hidden = true; // Update 18: no red frame; the REAL chip and the confirm sheet say it
    this.$.chipMode.textContent = live ? 'REAL' : 'PRACTICE';
    this.$.chipMode.classList.toggle('live', live);
    this.$.chipGhost.hidden = !(ghostMode && !rewind);
    this.$.chipRewind.hidden = !rewind;
    this.$.chipOrder.hidden = !st?.pendingOrder;
    if (st?.pendingOrder) this.$.chipOrder.textContent = `LIMIT ${st.pendingOrder.side === 1 ? 'LONG' : 'SHORT'} @ ${fmtPrice(st.pendingOrder.triggerPrice)}`;
    this.$.btnRenderer.textContent = s.visual.renderer === '3d' ? '3D' : '2D';
    this.$.btnTags.textContent = `tags: ${s.visual.tags}`;
    this.$.btnTop.textContent = s.visual.topDown ? 'top-down' : 'drive';
    this.$.btnMute.textContent = s.visual.muted ? '🔇' : '🔊';
    this.$.btnMute.classList.toggle('on', s.visual.muted);
    this.$.btnChase.classList.toggle('on', s.visual.chase);
    this.$.btnChase.textContent = s.visual.chase ? 'CHASE' : 'TRAFFIC'; // Update 18: the button names the mode you are in
    if ((s.visual.chase ? 'chase' : 'traffic') !== this.pedalMode) this.buildPedals(s.visual.chase ? 'chase' : 'traffic');
    if (!this.mirrorDragging && s.visual.mirrorHeight !== this.mirrorH) this.setMirrorHeight(s.visual.mirrorHeight);
    // CHASE (Update 16): same numbers, relabelled; the mirror strip frame shows in the seat view
    this.$.hwLabel.textContent = s.visual.chase ? 'TIME UNTIL CAUGHT' : 'TIME TO LIQUIDATION';
    this.$.rGapL.textContent = s.visual.chase ? 'DISTANCE AHEAD OF IT' : 'TO LIQUIDATION';
    this.$.rearStrip.hidden = !(s.visual.chase && s.visual.renderer === '3d' && !(s.visual.topDown && !s.frame?.car && !s.waitingFill));
    this.$.btnTop.classList.toggle('on', s.visual.topDown);
    this.$.btnExit.hidden = ghostMode;
    this.$.btnExits.hidden = !f?.car || rewind;
    this.$.mirror.hidden = !f?.car;
    // price pod placement: top-centre (sky) in the chase cam; bottom-centre (windshield) in the driver cam, top-down and 2D
    const topNow = s.visual.renderer === '2d' || (s.visual.topDown && !f?.car && !s.waitingFill);
    const firstPerson = !topNow && s.visual.renderer === '3d' && s.visual.camera === 'driver';
    this.root.classList.toggle('pod-bottom', firstPerson);
    this.root.classList.toggle('pod-corner', topNow);
    this.$.chipPrice.hidden = !topNow;
    if (f) {
      const fs = st?.feed;
      if (topNow) this.$.chipPrice.textContent = fmtPrice(f.price, MARKETS[f.market].priceDp);
      const animTxt = f.anim_source && f.anim_source !== 'truth' && f.anim_source !== 'rewind' ? ` · ${f.anim_source} ${fmtPrice(f.price_anim, MARKETS[f.market].priceDp)}` : '';
      this.$.ppSub.textContent = `${MARKETS[f.market].asset} · ${f.rewind ? 'rewind' : 'oracle'}${animTxt}${fs && fs.oracleBasisBps !== null ? ` · ${fs.oracleBasisBps >= 0 ? '+' : ''}${fs.oracleBasisBps.toFixed(1)} bp` : ''}`;
      const hz = f.horizon;
      this.$.chipHorizon.textContent = `H ${fmtTime(hz.h)}${hz.auto_room && Math.abs(hz.h - hz.base) / hz.base > 0.05 ? ` (base ${fmtTime(hz.base)})` : ''}${hz.auto_room ? ' · auto' : ''}`;
      this.$.chipHorizon.title = `horizon: ${fmtTime(hz.h)} of market feels like ~20 s of driving · lanes ${hz.ghost_ages.map((a) => fmtTime(a)).join(' / ')} / now · red under ${fmtTime(hz.thr.orange)}`;
      this.$.clearTag.hidden = !hz.clear;
      this.$.clearTag.title = hz.clear_why;
    }
    if (st) {
      const fs = st.feed;
      this.$.chipFeed.textContent = `${fs.source}${fs.animSource && fs.animSource !== 'truth' ? ` + ${fs.animSource}` : ''}${fs.oracleBasisBps !== null ? ` · ${fs.oracleBasisBps >= 0 ? '+' : ''}${fs.oracleBasisBps.toFixed(1)}bp` : ''}${fs.connected ? '' : ' · OFFLINE'}`;
      this.$.chipFeed.classList.toggle('bad', !fs.connected);
      this.$.chipView.textContent = f?.mode.view ?? st.mode.view;
      this.$.chipInvert.hidden = !(f?.mode.invert ?? st.mode.invert);
    }
    // one row of chips, never wrap: overflow goes into ··· (Update 9 A8)
    const chips = this.$.chips;
    const all = [...chips.querySelectorAll<HTMLElement>('.chip:not(.more)')].filter((c) => !c.hidden);
    const overflow = chips.scrollWidth > chips.clientWidth + 1;
    const limit = overflow ? chips.clientWidth - 36 : Infinity;
    const hiddenTexts: string[] = [];
    for (const c of all) {
      const fits = c.offsetLeft + c.offsetWidth <= limit;
      c.style.visibility = fits ? 'visible' : 'hidden';
      if (!fits) hiddenTexts.push(c.textContent ?? '');
    }
    this.$.chipMore.hidden = !hiddenTexts.length;
    this.$.chipMore.title = hiddenTexts.join(' · ');
    if (this.bannerKind && this.bannerUntil < Date.now() && this.bannerKind !== 'wait') this.hideBanner();

    const fc = focusCar(f, s.primaryGhostId);
    this.$.pedals.hidden = ghostMode || rewind;
    const thr = f?.horizon.thr ?? { green: 60, yellow: 20, orange: 5, critical: 1 };
    const span = Math.max(60, Math.min(3600, f?.horizon.h ?? 60));
    this.$.hwT0.textContent = `−${shortSpan(span)}`;
    this.$.hwT1.textContent = `−${shortSpan(span / 2)}`;
    this.$.hwCaption.innerHTML = `last ${fmtTime(span)} · <i style="background:${HEADWAY_RGB.green}"></i>safe · <i style="background:${HEADWAY_RGB.yellow}"></i>&lt; ${fmtTime(thr.green)} · <i style="background:${HEADWAY_RGB.orange}"></i>&lt; ${fmtTime(thr.yellow)} · <i style="background:${HEADWAY_RGB.red}"></i>&lt; ${fmtTime(thr.orange)}`;
    this.stripCanvas.title = `history of time to liquidation over the last ${fmtTime(span)} · colours = the state at that moment · white line = the value on a log scale (not closing at the top, 0 at the bottom) · click to see it on the chart`;
    if (!f || !fc) {
      this.$.chipMarket.textContent = f ? f.market : '—';
      this.setHeadway('green', null, null, null, ghostMode, 0);
      this.$.dashNumbers.hidden = true;
      this.clearReadouts();
      return 'green';
    }

    const c = fc.car;
    const isGhost = !!fc.ghost;
    const dp = MARKETS[f.market].priceDp;
    const asset = MARKETS[f.market].asset;
    const H = f.horizon.h;
    this.$.chipMarket.textContent = `${f.market} ${c.side === 1 ? 'LONG' : 'SHORT'}`;
    const hw = c.headway_s ?? Infinity;
    const hp = c.headway_proj_s ?? Infinity;
    const color = headwayColor(Math.min(hw, hp), thr);
    this.setHeadway(color, c.headway_s, c.headway_proj_s, Math.abs(f.price - c.liq), isGhost, c.gap_pct * 100);

    // leverage dial text (Update 9 A10)
    // Update 15: effective leverage big, the leverage the position was opened at small, when they differ
    const setLev = !isGhost && s.drive ? s.drive.leverage0 : null;
    const showSet = setLev !== null && Math.abs(setLev - c.leverage) >= 0.05;
    this.$.spLev.innerHTML = `${c.leverage.toFixed(1)}x${showSet ? `<small class="lev-set">effective · ${setLev!.toFixed(setLev! >= 100 ? 0 : 1)}× set</small>` : ''}${isGhost ? '<span class="tag">PREVIEW</span>' : ''}`;
    const liqMoving = Math.abs(c.v_gap_liq) > 1e-5 ? fmtRate((-c.v_gap_liq / c.leverage) * f.price, H, 'money') : 'no';
    // Update 15: the market's push on my car in plain words; never a pedal
    const pushPct = (-c.v_gap_impulse / c.leverage) * 100; // % of price per second, + = against me
    const market = Math.abs(pushPct) < 1e-4 ? 'market: steady' : pushPct > 0 ? `market: pushing you ${fmtRate(pushPct, H, 'pct')}` : `market: easing ${fmtRate(pushPct, H, 'pct')}`;
    this.$.spSub.textContent = `${market} · trend ${fmtRate((c.v_gap_trend / c.leverage) * 100, H, 'pct')} · liq moving: ${liqMoving}`;
    this.$.spSub.title = 'market: the tape\'s push on your car (+ against you, − for you) · trend in the P&L direction (+ away from liquidation)';
    this.$.barThrottle.style.width = `${Math.round(clamp(c.throttle, 0, 1) * 100)}%`;
    this.$.barBrake.style.width = `${Math.round(clamp(c.brake, 0, 1) * 100)}%`;

    // tiles (Update 6 / 9 A1): TO LIQUIDATION · P&L · FROM ENTRY · POSITION · AVAILABLE
    const tw = trendWord(c);
    const aheadWord = c.slam ? 'liq rushing closer' : tw === 'braking' ? 'trend against you' : tw === 'pulling away' ? 'trend in your favor' : 'holding';
    this.$.rGapV.textContent = fmtUsd(Math.abs(f.price - c.liq));
    this.$.rGapS.textContent = `${fmtPct(c.gap_pct * 100)} · liq ${fmtPrice(c.liq, dp)} · ${aheadWord}`;
    this.$.rGap.className = 'readout ' + (c.slam ? 'neg' : '');
    const pnlNet = c.pnl_usd - c.fees_usd;
    this.$.rPnlV.textContent = fmtSignedUsd(pnlNet);
    this.$.rPnlS.textContent = `${fmtPct(c.collateral_usd > 0 ? (pnlNet / c.collateral_usd) * 100 : 0, true)} on collateral · gross ${fmtSignedUsd(c.pnl_usd)}${c.realized_usd ? ` · realized ${fmtSignedUsd(c.realized_usd)}` : ''}`;
    this.$.rPnl.className = 'readout ' + (pnlNet >= 0 ? 'pos' : 'neg');
    const fromEntry = c.side * (f.price - c.entry);
    if (isGhost) {
      this.$.rEntryV.textContent = fc.ghost!.is_limit ? 'limit' : fmtPrice(c.entry, dp);
      this.$.rEntryS.textContent = fc.ghost!.is_limit ? `${fmtPrice(fc.ghost!.proposed_entry, dp)} · ${fmtPct(Math.abs((fc.ghost!.proposed_entry! - f.price) / f.price) * 100)} from the mark` : fc.ghost!.label;
      this.$.rEntry.className = 'readout';
    } else {
      this.$.rEntryV.textContent = fmtSignedUsd(fromEntry);
      this.$.rEntryS.textContent = `${fmtPct((fromEntry / c.entry) * 100, true)} · entry ${fmtPrice(c.entry, dp)} · ${fromEntry >= 0 ? 'past breakeven' : 'short of breakeven'}`;
      this.$.rEntry.className = 'readout ' + (fromEntry >= 0 ? 'pos' : 'neg');
    }
    this.$.rSizeV.textContent = fmtUsd(c.size_usd, 0);
    this.$.rSizeS.textContent = `${fmtSol(c.size_usd / f.price, asset)} · collateral ${fmtUsd(c.collateral_usd)} · ${c.leverage.toFixed(1)}x`;
    const solPrice = st?.wallet.solPrice ?? (f.market === 'SOL-PERP' ? f.price : null);
    const total = c.free_collateral + c.collateral_usd;
    this.$.fuelLabel.textContent = isGhost ? 'AVAILABLE AFTER ENTRY' : 'AVAILABLE';
    this.$.fuelV.textContent = fmtUsd(c.free_collateral);
    this.$.fuelBar.style.width = `${total > 0 ? clamp((c.free_collateral / total) * 100, 0, 100) : 0}%`;
    this.$.fuelS.textContent = solPrice ? `${fmtSol(c.free_collateral / solPrice)}${live ? ' in wallet' : ' · practice bankroll'}` : live ? 'wallet' : 'practice bankroll';
    this.$.snSize.textContent = `${fmtUsd(c.size_usd, 0)} · ${c.leverage.toFixed(1)}x`;
    this.$.snFuel.textContent = fmtUsd(c.free_collateral);

    // pedal tooltips (Update 6)
    if (!isGhost && f.car && st && performance.now() - this.lastTooltipT > 500) {
      this.lastTooltipT = performance.now();
      this.$.pedals.querySelectorAll<HTMLElement>('.pedal').forEach((b) => { b.title = pedalTooltip(b.dataset.action as PedalAction, f.car!, f, st.settings); });
    }

    // the mirror (Update 10 §2)
    if (f.car) {
      this.$.mTitle.textContent = `MIRROR · last ${f.behind ? fmtTime((f.t - f.behind.t_from) / 1000) : '—'}`;
      this.$.mEntry.textContent = `${fmtUsd(Math.abs(f.price - c.entry))} ${fromEntry >= 0 ? 'behind you' : 'ahead of you'} · ${fmtPrice(c.entry, dp)}`;
      this.$.mStop.textContent = c.stop_price === null ? 'none · T to set' : `${fmtPrice(c.stop_price, dp)} · ${fmtPct(Math.abs((c.stop_price - f.price) / f.price) * 100)} behind`;
      this.lastMirror = { f, c };
      this.drawMirror(f, c, s.redMoments);
    }

    // full dash numbers (plain units)
    const showNumbers = f.mode.view === 'full-dash';
    this.$.dashNumbers.hidden = !showNumbers;
    if (showNumbers) {
      const L = f.layers;
      this.$.dnAtr.textContent = L.atr === null ? 'warming up' : `${fmtPct(L.atr * 100)}/min`;
      this.$.dnAtr5.textContent = L.atr5m === null ? '—' : fmtPct(L.atr5m * 100);
      this.$.dnFunding.textContent = L.funding === null ? 'n/a' : `−${fmtUsd(c.size_usd * L.funding)}/h (−${fmtPct(L.funding * 100)}/h)`;
      this.$.dnUtil.textContent = L.utilization === null ? 'n/a' : fmtPct(L.utilization * 100);
      this.$.dnSpread.textContent = L.spread === null ? 'n/a' : `${(L.spread * 1e4).toFixed(1)} bp · slippage ≈ ${fmtUsd(c.size_usd * L.spread)}`;
      this.$.dnBasis.textContent = st?.feed.oracleBasisBps === null || st?.feed.oracleBasisBps === undefined ? 'n/a' : `${st.feed.oracleBasisBps.toFixed(1)} bp`;
      this.$.dnPrice.textContent = `${fmtPrice(f.price, dp)} @ ${clockTime(f.t_truth)}`;
      this.$.dnH.textContent = `${fmtTime(H)} · lanes ${f.horizon.ghost_ages.map((a) => fmtTime(a)).join(' / ')} / now`;
      this.$.dnCandles.textContent = `${st?.feed.candles ?? 0} · ${st?.feed.historyTicks ?? 0} ticks`;
    }
    return color;
  }

  private clearReadouts(): void {
    for (const id of ['spLev', 'rGapV', 'rEntryV', 'rPnlV', 'rSizeV', 'fuelV', 'snSize', 'snFuel']) this.$[id].textContent = '—';
    for (const id of ['rGapS', 'rEntryS', 'rPnlS', 'rSizeS', 'fuelS', 'spSub']) this.$[id].textContent = '';
  }

  private setHeadway(color: HeadwayColor, hw: number | null, hp: number | null, toLiqUsd: number | null, ghost: boolean, pctV: number): void {
    this.$.headway.className = `headway ${color}`;
    void ghost;
    this.$.hwMain.textContent = fmtHeadway(hw);
    this.$.hwProj.textContent = fmtHeadway(hp);
    this.$.hwDist.textContent = toLiqUsd === null ? '—' : `${fmtUsd(toLiqUsd)} (${fmtPct(pctV)}) to liq`;
  }

  private sizeCanvas(c: HTMLCanvasElement, cssH: number): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(60, c.clientWidth || c.width);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(cssH * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(cssH * dpr); }
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h: cssH };
  }

  /** Update 10 §1: the last H seconds of time-to-liquidation, coloured by threshold, with the value as a white log line. */
  private drawStrip(hist: HeadwaySample[], thr: { green: number; yellow: number; orange: number }, spanSec: number, now: number): void {
    this.lastStripSpan = spanSec;
    const sz = this.sizeCanvas(this.stripCanvas, 16);
    if (!sz) return;
    const { ctx, w, h } = sz;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, 0, w, h);
    if (!hist.length) return;
    const span = spanSec * 1000;
    const topV = thr.green * 10;
    const step = Math.max(1, Math.floor(hist.length / (w * 2)));
    let lastX = -1;
    for (let i = 0; i < hist.length; i += step) {
      const p = hist[i];
      const x = w - ((now - p.t) / span) * w;
      if (x < 0) continue;
      const v = Math.min(p.h ?? Infinity, p.proj ?? Infinity);
      ctx.fillStyle = HEADWAY_RGB[headwayColor(v, thr)];
      const x0 = Math.max(0, lastX < 0 ? x - 2 : lastX);
      ctx.fillRect(x0, 0, Math.max(1, x - x0 + 1), h);
      lastX = x;
    }
    // the value, log scale: ∞ at the top, 0 at the bottom
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < hist.length; i += step) {
      const p = hist[i];
      const x = w - ((now - p.t) / span) * w;
      if (x < 0) continue;
      const v = Math.min(p.h ?? Infinity, p.proj ?? Infinity);
      const k = Number.isFinite(v) && v > 0 ? clamp(Math.log10(v) / Math.log10(topV), 0, 1) : 1;
      const y = 1 + (1 - k) * (h - 2);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // tick marks
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    for (const fx of [0, 0.5, 1]) ctx.fillRect(Math.min(w - 1, fx * w), h - 4, 1, 4);
  }

  /** Update 10 §2: a rear-view mirror. Up is toward liquidation; every line labelled on itself. */
  private drawMirror(f: Frame, c: CarFrame, redMoments: number[]): void {
    const sz = this.sizeCanvas(this.mirrorCanvas, this.mirrorH);
    if (!sz) return;
    const { ctx, w, h } = sz;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);
    const b = f.behind;
    if (!b || b.profile.length < 2) { ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '10px monospace'; ctx.fillText('warming up…', 6, 14); return; }
    const dp = MARKETS[f.market].priceDp;
    const padL = 4, padR = 52, padT = 12, padB = 14;
    const t0 = b.t_from, t1 = f.t;
    let lo = Infinity, hi = -Infinity;
    for (const [, p] of b.profile) { if (p < lo) lo = p; if (p > hi) hi = p; }
    for (const p of [c.entry, f.price, c.liq, c.stop_price ?? f.price]) { if (p < lo) lo = p; if (p > hi) hi = p; }
    const padP = (hi - lo) * 0.08 || Math.max(0.001, f.price * 1e-4);
    lo -= padP; hi += padP;
    const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
    const inner = h - padT - padB;
    // orientation: up = toward liquidation for this side (short: higher price up; long: lower price up)
    const y = (p: number) => (c.side === -1 ? padT + ((hi - p) / (hi - lo)) * inner : padT + ((p - lo) / (hi - lo)) * inner);
    const label = (text: string, yy: number, color: string, right = w - padR - 2) => {
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      const tw = ctx.measureText(text).width + 6;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(right - tw, yy - 11, tw, 11);
      ctx.fillStyle = color;
      ctx.fillText(text, right - 3, yy - 2);
    };
    // liquidation (red) and entry (yellow dashed), stop (blue dashed)
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = HEADWAY_RGB.red;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(padL, y(c.liq)); ctx.lineTo(w - padR, y(c.liq)); ctx.stroke();
    label(`liquidation ${fmtPrice(c.liq, dp)}`, y(c.liq), HEADWAY_RGB.red);
    ctx.strokeStyle = '#ffd23f';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(padL, y(c.entry)); ctx.lineTo(w - padR, y(c.entry)); ctx.stroke();
    label(`entry ${fmtPrice(c.entry, dp)}`, y(c.entry) + 12, '#ffd23f');
    if (c.stop_price !== null) {
      ctx.strokeStyle = '#4c9bff';
      ctx.beginPath(); ctx.moveTo(padL, y(c.stop_price)); ctx.lineTo(w - padR, y(c.stop_price)); ctx.stroke();
      label(`stop ${fmtPrice(c.stop_price, dp)}`, y(c.stop_price) + 12, '#4c9bff');
    }
    ctx.setLineDash([]);
    // the price trail, white, ending at a car icon with the live price
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    b.profile.forEach(([t, p], i) => { if (i === 0) ctx.moveTo(x(t), y(p)); else ctx.lineTo(x(t), y(p)); });
    ctx.lineTo(w - padR, y(f.price));
    ctx.stroke();
    const cy = y(f.price);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.roundRect(w - padR - 5, cy - 3.5, 10, 7, 2); ctx.fill();
    ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff';
    ctx.fillText(`you ${fmtPrice(f.price, dp)}`, w - padR + 7, cy + 3);
    // $ scale on the right
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '8px monospace'; ctx.textAlign = 'left';
    for (const p of [hi - padP, (hi + lo) / 2, lo + padP]) { const yy = y(p); if (Math.abs(yy - cy) > 8) ctx.fillText(fmtPrice(p, dp), w - padR + 7, yy + 3); }
    // red posts: moments the time to liquidation was red
    ctx.fillStyle = HEADWAY_RGB.red;
    for (const t of redMoments) if (t >= t0) ctx.fillRect(x(t) - 1, 0, 2, 5);
    // lane liquidation posts
    for (const [t, lane] of b.crashes) { ctx.fillStyle = LANE_COLORS[lane] ?? '#ff8a3d'; ctx.fillRect(x(t) - 1, 0, 2, 8); }
    // flags
    ctx.fillStyle = '#ffd23f';
    for (const fl of b.flags) ctx.fillRect(x(fl.t) - 1, 0, 2, h - padB);
    // time axis
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left'; ctx.fillText(`−${shortSpan((t1 - t0) / 1000)}`, padL, h - 3);
    ctx.textAlign = 'center'; ctx.fillText(`−${shortSpan((t1 - t0) / 2000)}`, (padL + w - padR) / 2, h - 3);
    ctx.textAlign = 'right'; ctx.fillText('now', w - padR, h - 3);
    ctx.textAlign = 'left';
  }

  /** Mirror hover: `−3 m 10 s · 108.27 · $0.33 to liq · P&L then +$0.80`. */
  mirrorHover(px: number): string[] | null {
    const m = this.lastMirror;
    if (!m) return null;
    const { f, c } = m;
    const b = f.behind;
    if (!b || b.profile.length < 2) return null;
    const w = this.mirrorCanvas.clientWidth || 270;
    const padL = 4, padR = 52;
    const t = b.t_from + clamp((px - padL) / (w - padL - padR), 0, 1) * (f.t - b.t_from);
    let best = b.profile[0];
    for (const p of b.profile) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const dp = MARKETS[f.market].priceDp;
    const pnlThen = pnlUsd(c.side, c.entry, best[1], c.size_usd) - c.fees_usd;
    return [`−${fmtTime((f.t - best[0]) / 1000)} · ${fmtPrice(best[1], dp)} · ${fmtUsd(Math.abs(best[1] - c.liq))} to liq · P&L then ${fmtSignedUsd(pnlThen)}`, `t = ${clockTime(best[0])}`];
  }
}
