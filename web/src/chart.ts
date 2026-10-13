// Update 5 §2 / Update 9 A4+A9: the bridge chart as a full-width bottom drawer. Candles from the local tick
// history; every road object as a price line in its road colour (entry yellow, liquidation red, stop blue,
// lane entries in lane colours, mark white); swing markers; flags. Labels are drawn in our own column so
// neighbours within 14 px merge into one stacked tag with leader lines and `mark` always wins. Collapsed it
// is a 24 px strip showing just the price lines. Drag the grip to resize; B toggles. The road is never
// occluded: the viewport ends where the drawer begins.
import { CrosshairMode, LineStyle, createChart, type AutoscaleInfo, type CandlestickData, type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type SeriesMarker, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../../shared/candles.js';
import { CHART_INTERVALS, chartIntervalFor } from '../../shared/horizon.js';
import { pnlUsd } from '../../shared/jupiter.js';
import { MARKETS, type Frame, type StatusMsg } from '../../shared/types.js';
import { api } from './api.js';
import { clockTime, fmtHeadway, fmtPct, fmtPrice, fmtSignedUsd, fmtUsd, shortSpan } from './format.js';
import { LANE_COLORS } from './renderer.js';
import { focusCar, type UIState } from './state.js';

export interface ChartDeps {
  getState(): UIState;
  onSetEntry(price: number): void;
  onHover(id: string | null): void;
  onSeek(frac: number): void;
  onToggle(open: boolean): void;
  onHeight(h: number): void;
}

interface LineRec { line: IPriceLine; price: number; color: string; title: string }

const LINE_COLORS: Record<string, string> = { entry: '#ffd23f', ahead: '#ff3b3b', stop: '#4c9bff', mark: '#ffffff' };
const COLLAPSED_H = 24;
const CLUSTER_PX = 14;

export class BridgeChart {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private lines = new Map<string, LineRec>();
  private interval = 60;
  private manualInterval = 0;
  private bars: CandlestickData<UTCTimestamp>[] = [];
  private lastFetch = 0;
  private fetching = false;
  private body: HTMLElement;
  private chips: HTMLElement;
  private info: HTMLElement;
  private labelsEl: HTMLElement;
  private mini: HTMLCanvasElement;
  private collapsed = false;
  private height = 160;
  private hoverId: string | null = null;
  private lastMarkersKey = '';
  private rewindRangeKey = '';
  private lastLabelsT = 0;

  constructor(private root: HTMLElement, private d: ChartDeps, height: number, open: boolean) {
    this.height = Math.max(100, height);
    this.collapsed = !open;
    root.innerHTML = `
      <div class="chart-grip" id="chGrip" title="drag to resize"></div>
      <div class="chart-head">
        <button class="tiny" id="chCollapse" title="B">▾</button>
        <span class="chart-title">BRIDGE CHART</span>
        <div class="chips-row" id="chChips"></div>
        <span class="muted small" id="chFollow"></span>
        <span class="chart-info mono small" id="chInfo">hover for price · time · to liq · P&L if closed here · click sets the limit entry (preview)</span>
        <div class="mini" id="chMini"><canvas height="24"></canvas></div>
      </div>
      <div class="chart-body" id="chBody"><div class="chart-labels" id="chLabels"></div></div>`;
    this.body = root.querySelector('#chBody')!;
    this.chips = root.querySelector('#chChips')!;
    this.info = root.querySelector('#chInfo')!;
    this.labelsEl = root.querySelector('#chLabels')!;
    this.mini = root.querySelector('#chMini canvas')!;
    root.querySelector('#chCollapse')!.addEventListener('click', () => this.setCollapsed(!this.collapsed, true));
    this.chips.innerHTML = `<button data-sec="0" class="tiny active">H</button>` + CHART_INTERVALS.map((c) => `<button data-sec="${c.sec}" class="tiny">${c.label}</button>`).join('');
    this.chips.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      this.manualInterval = Number(b.dataset.sec);
      this.chips.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    }));
    // drag to resize
    const grip = root.querySelector<HTMLElement>('#chGrip')!;
    let startY = 0, startH = 0, dragging = false;
    grip.addEventListener('pointerdown', (e) => { dragging = true; startY = e.clientY; startH = this.height; grip.setPointerCapture(e.pointerId); });
    grip.addEventListener('pointermove', (e) => { if (!dragging) return; this.height = Math.max(100, Math.min(window.innerHeight * 0.6, startH + (startY - e.clientY))); this.applyHeight(); });
    const end = () => { if (dragging) { dragging = false; this.d.onHeight(this.height); } };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    this.build();
    this.applyCollapsed();
    new ResizeObserver(() => this.resize()).observe(this.body);
  }

  private build(): void {
    this.chart = createChart(this.body, {
      autoSize: true,
      layout: { background: { color: '#07050f' }, textColor: '#9a93b8', fontFamily: 'JetBrains Mono, Consolas, monospace', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(138,92,255,0.08)' }, horzLines: { color: 'rgba(138,92,255,0.08)' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: 'rgba(46,230,255,0.5)' }, horzLine: { color: 'rgba(46,230,255,0.5)' } },
      rightPriceScale: { borderColor: 'rgba(138,92,255,0.3)', scaleMargins: { top: 0.12, bottom: 0.14 } },
      timeScale: { borderColor: 'rgba(138,92,255,0.3)', timeVisible: true, secondsVisible: true, barSpacing: 8, rightOffset: 4, minBarSpacing: 2 },
    });
    this.series = this.chart.addCandlestickSeries({ upColor: '#35d07f', downColor: '#ff3b3b', borderVisible: false, wickUpColor: '#35d07f', wickDownColor: '#ff3b3b', lastValueVisible: false, priceLineVisible: false, autoscaleInfoProvider: (orig: () => AutoscaleInfo | null) => this.autoscale(orig) });
    this.chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
    this.chart.subscribeClick((p) => this.onClick(p));
  }

  /** The price range: the visible bars plus the road objects within 3% of the mark, nothing else (the library's own
   *  autoscale was opening the range to $100–110 and flattening the candles). */
  private autoscale(orig: () => AutoscaleInfo | null): AutoscaleInfo | null {
    if (!this.chart || !this.bars.length) return orig();
    const lr = this.chart.timeScale().getVisibleLogicalRange();
    let from = 0, to = this.bars.length - 1;
    if (lr) { from = Math.max(0, Math.floor(lr.from)); to = Math.min(this.bars.length - 1, Math.ceil(lr.to)); }
    if (to < from) return orig();
    let min = Infinity, max = -Infinity;
    for (let i = from; i <= to; i++) { const b = this.bars[i]; if (b.low < min) min = b.low; if (b.high > max) max = b.high; }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return orig();
    const mark = this.lines.get('mark')?.price ?? this.bars[this.bars.length - 1].close;
    // Update 17: a tight window by default: ±0.4 % of the mark (about a dollar on SOL), widened only to keep the
    // liquidation and entry lines and the last twenty bars in view, never wider than ±1.5 %
    let half = mark * 0.004;
    for (const id of ['ahead', 'entry']) { const l = this.lines.get(id); if (l) half = Math.max(half, Math.abs(l.price - mark) * 1.15); }
    half = Math.min(half, mark * 0.015);
    let lo = mark - half, hi = mark + half;
    for (let i = Math.max(from, to - 20); i <= to; i++) { const b = this.bars[i]; if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
    void min; void max;
    return { priceRange: { minValue: lo, maxValue: hi } };
  }

  get open(): boolean { return !this.collapsed; }

  setCollapsed(c: boolean, byUser = false): void {
    if (this.collapsed === c) return;
    this.collapsed = c;
    if (byUser) {
      try {
        const n = Number(localStorage.getItem('traffic.chartClosed') ?? 0);
        localStorage.setItem('traffic.chartClosed', String(c ? n + 1 : 0));
      } catch { /* ignore */ }
    }
    this.applyCollapsed();
    this.d.onToggle(!c);
  }

  private applyCollapsed(): void {
    this.root.classList.toggle('collapsed', this.collapsed);
    (this.root.querySelector('#chCollapse') as HTMLElement).textContent = this.collapsed ? '▴' : '▾';
    this.applyHeight();
    if (!this.collapsed) setTimeout(() => this.resize(), 50);
  }

  /** The drawer never takes more than 30 % of the window, and leaves the road at least ~300 px above the HUD stack. */
  applyHeight(): void {
    const stage = this.root.parentElement;
    if (!stage) return;
    const hudBottom = parseFloat(stage.style.getPropertyValue('--hud-bottom-h')) || 0;
    const cap = Math.max(COLLAPSED_H, Math.min(window.innerHeight * 0.3, window.innerHeight - hudBottom - 300));
    stage.style.setProperty('--drawer-h', `${this.collapsed ? COLLAPSED_H : Math.min(this.height, cap)}px`);
  }

  resize(): void {
    if (this.collapsed) return;
    this.chart?.applyOptions({ width: this.body.clientWidth, height: Math.max(60, this.body.clientHeight) });
  }

  private toBar(c: Candle): CandlestickData<UTCTimestamp> {
    return { time: Math.floor(c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c };
  }

  private async refetch(): Promise<void> {
    if (this.fetching || !this.series) return;
    this.fetching = true;
    try {
      const r = await api.candles(this.interval, 1500);
      this.bars = r.candles.map((c) => this.toBar(c));
      this.series.setData(this.bars);
      this.lastMarkersKey = '';
    } catch { /* keep what we have */ } finally {
      this.fetching = false;
      this.lastFetch = performance.now();
    }
  }

  private liveBar(tMs: number, price: number): void {
    if (!this.series || !this.bars.length) return;
    const bucket = (Math.floor(tMs / 1000 / this.interval) * this.interval) as UTCTimestamp;
    const last = this.bars[this.bars.length - 1];
    if (bucket === last.time) {
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      last.close = price;
      this.series.update(last);
    } else if (bucket > last.time) {
      const bar: CandlestickData<UTCTimestamp> = { time: bucket, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price };
      this.bars.push(bar);
      this.series.update(bar);
    }
  }

  private setLine(id: string, price: number | null, color: string, title: string, width: 1 | 2 | 3 = 1, style = LineStyle.Dashed): void {
    if (!this.series) return;
    const existing = this.lines.get(id);
    if (price === null || !Number.isFinite(price)) {
      if (existing) { this.series.removePriceLine(existing.line); this.lines.delete(id); }
      return;
    }
    const strong = this.hoverId === id;
    const w = (strong ? Math.min(3, width + 1) : width) as 1 | 2 | 3;
    if (existing) {
      if (Math.abs(existing.price - price) > 1e-9) existing.line.applyOptions({ price, lineWidth: w });
      existing.price = price;
      existing.title = title;
    } else {
      const line = this.series.createPriceLine({ price, color, lineWidth: w, lineStyle: style, axisLabelVisible: false, title: '' });
      this.lines.set(id, { line, price, color, title });
    }
  }

  /** Called at ~10 Hz. */
  /** Update 14: the lanes being drawn; null = all. */
  visibleLanes: Set<string> | null = null;

  update(frame: Frame | null, status: StatusMsg | null, anim: { t: number; price: number } | null, nowMs: number): void {
    if (!frame || !this.series || !this.chart) return;
    const H = frame.horizon.h;
    const want = this.manualInterval || chartIntervalFor(frame.rewind ? frame.rewind.h : H);
    (this.root.querySelector('#chFollow') as HTMLElement).textContent = this.manualInterval ? '' : `follows H (${shortSpan(want)})`;
    if (want !== this.interval || (!this.bars.length && nowMs - this.lastFetch > 2000)) {
      this.interval = want;
      this.chart.applyOptions({ timeScale: { secondsVisible: want < 60 } });
      void this.refetch();
    } else if (nowMs - this.lastFetch > 10_000) void this.refetch();

    if (!frame.rewind) {
      this.liveBar(frame.t_truth, frame.price);
      if (anim && anim.t > frame.t) this.liveBar(anim.t, anim.price);
    }

    // price lines = road objects
    const fc = focusCar(frame, this.d.getState().primaryGhostId);
    const car = frame.car;
    this.setLine('mark', frame.price, LINE_COLORS.mark, 'mark', 1, LineStyle.Dotted);
    this.setLine('entry', car ? car.entry : null, LINE_COLORS.entry, 'entry', 2, LineStyle.Solid);
    this.setLine('ahead', car ? car.liq : fc?.car.liq ?? null, LINE_COLORS.ahead, car ? 'liquidation' : 'liq (focused lane)', 2, LineStyle.Solid);
    this.setLine('stop', car?.stop_price ?? null, LINE_COLORS.stop, 'trailing stop', 1, LineStyle.Dashed);
    const ghostIds = new Set<string>();
    for (const g of frame.ghosts) {
      if (car && !frame.rewind) continue;
      if (this.visibleLanes && !frame.rewind && !this.visibleLanes.has(g.id)) continue;
      const id = `ghost:${g.id}`;
      ghostIds.add(id);
      this.setLine(id, g.entry, LANE_COLORS[g.lane] + 'aa', `${g.side === 1 ? 'L' : 'S'} ${g.label}`, 1, LineStyle.LargeDashed);
    }
    for (const id of [...this.lines.keys()]) if (id.startsWith('ghost:') && !ghostIds.has(id)) this.setLine(id, null, '', '');
    const exitIds = new Set<string>();
    for (const ex of frame.exits) {
      const id = `exit:${ex.id}`;
      exitIds.add(id);
      this.setLine(id, ex.price, ex.kind === 'tp' ? '#35d07f' : '#ff8a3d', `${ex.kind.toUpperCase()} ${Math.round(ex.fraction * 100)}%`, 1, LineStyle.Dashed);
    }
    for (const id of [...this.lines.keys()]) if (id.startsWith('exit:') && !exitIds.has(id)) this.setLine(id, null, '', '');

    if (this.collapsed) { this.drawMini(frame); return; }

    // markers: flags and rewind liquidations (the swing high / low arrows went in Update 26: noise)
    const flags = frame.rewind ? frame.rewind.flags : status?.flags ?? [];
    const crashes = frame.rewind ? frame.rewind.crashes : [];
    const key = `${flags.length}|${crashes.length}`;
    if (key !== this.lastMarkersKey) {
      this.lastMarkersKey = key;
      const marks: SeriesMarker<UTCTimestamp>[] = [];
      for (const fl of flags) marks.push({ time: Math.floor(fl.t / 1000) as UTCTimestamp, position: 'aboveBar', color: '#ffd23f', shape: 'circle', text: '⚑ flag' });
      const step = Math.max(1, Math.ceil(crashes.length / 120));
      crashes.forEach((c, i) => { if (i % step === 0) marks.push({ time: Math.floor(c[0] / 1000) as UTCTimestamp, position: 'belowBar', color: c[1] === 1 ? '#5ee0c8' : '#ff3fa4', shape: 'circle', text: `${c[1] === 1 ? 'LONG' : 'SHORT'} liq` }); });
      marks.sort((a, b) => (a.time as number) - (b.time as number));
      this.series.setMarkers(marks);
    }

    // rewind: the visible range is the lookback, the crosshair is the playhead
    if (frame.rewind) {
      const rk = `${frame.rewind.t0}-${frame.rewind.t1}`;
      if (rk !== this.rewindRangeKey) {
        this.rewindRangeKey = rk;
        this.chart.timeScale().setVisibleRange({ from: Math.floor(frame.rewind.t0 / 1000) as UTCTimestamp, to: Math.floor(frame.rewind.t1 / 1000) as UTCTimestamp });
      }
      try { this.chart.setCrosshairPosition(frame.price, Math.floor(frame.rewind.cursor / 1000) as UTCTimestamp, this.series); } catch { /* time may be off-grid */ }
    } else if (this.rewindRangeKey) {
      this.rewindRangeKey = '';
      this.chart.clearCrosshairPosition();
      this.chart.timeScale().scrollToRealTime();
    }

    if (nowMs - this.lastLabelsT > 100) { this.lastLabelsT = nowMs; this.layoutLabels(frame); }
  }

  /** Update 9 A9: our own label column; neighbours within 14 px merge into one stacked tag; `mark` wins. */
  private layoutLabels(frame: Frame): void {
    if (!this.series) return;
    const dp = MARKETS[frame.market].priceDp;
    const items: Array<{ id: string; y: number; color: string; text: string }> = [];
    for (const [id, l] of this.lines) {
      const y = this.series.priceToCoordinate(l.price);
      if (y === null || !Number.isFinite(y)) continue;
      items.push({ id, y, color: l.color.length === 9 ? l.color.slice(0, 7) : l.color, text: `${l.title} ${fmtPrice(l.price, dp)}` });
    }
    items.sort((a, b) => a.y - b.y);
    const clusters: Array<typeof items> = [];
    for (const it of items) {
      const last = clusters[clusters.length - 1];
      if (last && it.y - last[last.length - 1].y < CLUSTER_PX) last.push(it); else clusters.push([it]);
    }
    const parts: string[] = [];
    const height = this.body.clientHeight;
    for (const cl of clusters) {
      const mark = cl.find((x) => x.id === 'mark');
      const anchor = mark ? mark.y : cl.reduce((s, x) => s + x.y, 0) / cl.length;
      const rowH = 13;
      const tagH = cl.length * rowH + 2;
      const top = Math.max(tagH / 2, Math.min(height - tagH / 2, anchor));
      const rows = [...(mark ? [mark] : []), ...cl.filter((x) => x !== mark)].map((x) => `<div style="color:${x.color}${x.id === 'mark' ? ';font-weight:700' : ''}">${x.text}</div>`).join('');
      parts.push(`<div class="ctag" style="top:${top}px">${rows}</div>`);
      for (const x of cl) if (Math.abs(x.y - top) > 2) parts.push(`<div class="leader" style="top:${x.y}px;width:${Math.min(60, 20 + Math.abs(x.y - top) * 0.3)}px;background:${x.color}"></div>`);
    }
    this.labelsEl.innerHTML = parts.join('');
  }

  /** Collapsed: a 24 px strip with just the price lines around the mark. */
  private drawMini(frame: Frame): void {
    const c = this.mini;
    const w = c.clientWidth || 600;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(COLLAPSED_H * dpr); }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, COLLAPSED_H);
    const dp = MARKETS[frame.market].priceDp;
    const mark = frame.price;
    let span = mark * 0.0005;
    for (const l of this.lines.values()) span = Math.max(span, Math.abs(l.price - mark) * 1.15);
    const cx = w / 2;
    const x = (p: number) => cx + ((p - mark) / span) * (w / 2 - 70);
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    let i = 0;
    const sorted = [...this.lines.entries()].sort((a, b) => a[1].price - b[1].price);
    for (const [id, l] of sorted) {
      const px = x(l.price);
      ctx.fillStyle = l.color.length === 9 ? l.color.slice(0, 7) : l.color;
      ctx.fillRect(px - 1, 4, 2, 16);
      const yy = i % 2 === 0 ? 10 : 20;
      ctx.fillText(`${id === 'mark' ? 'mark' : l.title} ${fmtPrice(l.price, dp)}`, px, yy);
      i++;
    }
  }

  highlight(id: string | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    for (const [lid, l] of this.lines) l.line.applyOptions({ lineWidth: (lid === id ? 3 : lid === 'entry' || lid === 'ahead' ? 2 : 1) as 1 | 2 | 3 });
  }

  /** Jump the crosshair to a moment (strip click, Update 10 §1). */
  focusTime(tMs: number, price: number): void {
    if (!this.chart || !this.series) return;
    if (this.collapsed) this.setCollapsed(false, false);
    const sec = Math.floor(tMs / 1000);
    const range = this.chart.timeScale().getVisibleRange();
    const half = range ? Math.max(30, ((range.to as number) - (range.from as number)) / 2) : 300;
    this.chart.timeScale().setVisibleRange({ from: (sec - half) as UTCTimestamp, to: (sec + half) as UTCTimestamp });
    try { this.chart.setCrosshairPosition(price, sec as UTCTimestamp, this.series); } catch { /* off-grid */ }
    this.info.textContent = `${fmtPrice(price)} · ${clockTime(tMs)} · from the time-to-liquidation strip`;
  }

  private onCrosshair(p: MouseEventParams): void {
    if (!this.series || !this.chart) return;
    const st = this.d.getState();
    const f = st.frame;
    if (!p.point || !f) { this.info.textContent = 'hover for price · time · to liq · P&L if closed here'; this.d.onHover(null); return; }
    const price = this.series.coordinateToPrice(p.point.y);
    if (price === null) return;
    const t = typeof p.time === 'number' ? (p.time as number) * 1000 : null;
    const fc = focusCar(f, st.primaryGhostId);
    const c = f.car ?? fc?.car ?? null;
    const dp = MARKETS[f.market].priceDp;
    const parts = [`${fmtPrice(price as number, dp)}`, t ? clockTime(t) : ''];
    if (c) {
      const toLiq = Math.abs((price as number) - c.liq);
      parts.push(`to liq ${fmtUsd(toLiq)} (${fmtPct((toLiq / (price as number)) * 100)})`);
      const pnl = pnlUsd(c.side, c.entry, price as number, c.size_usd) - c.fees_usd;
      parts.push(`P&L if closed here ${fmtSignedUsd(pnl)}`);
      parts.push(`time to liq now ${fmtHeadway(c.headway_s)}`);
    }
    this.info.textContent = parts.filter(Boolean).join(' · ');
    let best: string | null = null, bestD = Infinity;
    const tol = Math.abs((this.series.coordinateToPrice(p.point.y + 6) ?? 0) - (price as number)) * 1.5 + 1e-9;
    for (const [id, l] of this.lines) {
      const dd = Math.abs(l.price - (price as number));
      if (dd < tol && dd < bestD) { bestD = dd; best = id; }
    }
    this.d.onHover(best);
  }

  private onClick(p: MouseEventParams): void {
    if (!this.series || !p.point) return;
    const st = this.d.getState();
    const f = st.frame;
    if (!f) return;
    if (f.rewind && typeof p.time === 'number') {
      const frac = ((p.time as number) * 1000 - f.rewind.t0) / Math.max(1, f.rewind.t1 - f.rewind.t0);
      this.d.onSeek(Math.min(1, Math.max(0, frac)));
      return;
    }
    if (!f.car && st.screen === 'ghost') {
      const price = this.series.coordinateToPrice(p.point.y);
      if (price !== null) this.d.onSetEntry(price as number);
    }
  }
}
