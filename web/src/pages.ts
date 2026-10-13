// Update 17: full pages that take over the stage: TRADES (every trade of a wallet, with charts and the figures to
// analyse them) and CONDITIONS (the seven horizons in full, with sparklines and the rule stack). Opened from the
// ⋯ menu or the panel; X, the same button again, or Esc closes them. The drive keeps running underneath.
import { ColorType, createChart, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import { HORIZONS, emaSeries, type ConditionRow, type ConditionsState } from '../../shared/conditions.js';
import { MARKETS, type StatusMsg, type TradeRecord } from '../../shared/types.js';
import { api } from './api.js';
import { buildGuide } from './guide.js';
import { clockTime, fmtPct, fmtPrice, fmtSignedUsd, fmtTime, fmtUsd } from './format.js';

export type PageKind = 'trades' | 'conditions';

interface TradeStats {
  closes: number; wins: number; net: number; fees: number; volume: number; liqs: number;
  best: TradeRecord | null; worst: TradeRecord | null;
  bySide: Record<'long' | 'short', { n: number; net: number }>;
  byMarket: Record<string, { n: number; net: number }>;
  byHour: number[]; // net per hour of day
}

const isClose = (r: TradeRecord): boolean => /decrease|close|stop|liquidation/.test(r.action) && r.pnlUsd !== null;

export function tradeStats(rows: TradeRecord[]): TradeStats {
  const s: TradeStats = { closes: 0, wins: 0, net: 0, fees: 0, volume: 0, liqs: 0, best: null, worst: null, bySide: { long: { n: 0, net: 0 }, short: { n: 0, net: 0 } }, byMarket: {}, byHour: new Array<number>(24).fill(0) };
  for (const r of rows) {
    s.fees += r.feeUsd;
    s.volume += r.sizeUsd;
    if (/liquidation/.test(r.action)) s.liqs++;
    if (!isClose(r)) continue;
    const pnl = r.pnlUsd ?? 0;
    s.closes++;
    if (pnl > 0) s.wins++;
    s.net += pnl;
    if (!s.best || pnl > (s.best.pnlUsd ?? 0)) s.best = r;
    if (!s.worst || pnl < (s.worst.pnlUsd ?? 0)) s.worst = r;
    const side = r.side === 1 ? 'long' : 'short';
    s.bySide[side].n++; s.bySide[side].net += pnl;
    const m = (s.byMarket[r.market] ??= { n: 0, net: 0 });
    m.n++; m.net += pnl;
    s.byHour[new Date(r.t).getHours()] += pnl;
  }
  return s;
}

function dateTime(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clockTime(t).slice(0, 8)}`;
}

const CHART_OPTS = {
  layout: { background: { type: ColorType.Solid, color: 'rgba(0,0,0,0)' }, textColor: '#8e8ba3', fontFamily: 'JetBrains Mono, Menlo, monospace', fontSize: 10 },
  grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
  rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
  timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true, secondsVisible: false },
  handleScroll: true,
  handleScale: true,
};

export class Pages {
  private root: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private kind: PageKind | null = null;
  private charts: IChartApi[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: StatusMsg | null = null;
  private leverage = 100;
  private walletChoice = '';
  private onChange: (open: PageKind | null) => void;

  constructor(stage: HTMLElement, onChange: (open: PageKind | null) => void = () => undefined) {
    this.onChange = onChange;
    this.root = document.createElement('div');
    this.root.id = 'pages';
    this.root.hidden = true;
    this.root.innerHTML = `<div class="page-head"><h2 id="pageTitle"></h2><button class="page-x" id="pageClose" title="Esc">✕</button></div><div class="page-body" id="pageBody"></div>`;
    stage.appendChild(this.root);
    this.title = this.root.querySelector('#pageTitle')!;
    this.body = this.root.querySelector('#pageBody')!;
    this.root.querySelector('#pageClose')!.addEventListener('click', () => this.close());
  }

  get open(): PageKind | null { return this.kind; }
  setStatus(st: StatusMsg | null): void { this.status = st; }
  setContext(st: StatusMsg | null, leverage: number): void { this.status = st; if (leverage > 0) this.leverage = leverage; }

  toggle(kind: PageKind): void { if (this.kind === kind) this.close(); else this.show(kind); }

  /** Returns true when a page was open (and is now closed). */
  close(): boolean {
    if (!this.kind) return false;
    this.kind = null;
    this.root.hidden = true;
    this.teardown();
    this.onChange(null);
    return true;
  }

  show(kind: PageKind): void {
    this.teardown();
    this.kind = kind;
    this.root.hidden = false;
    this.onChange(kind);
    if (kind === 'trades') void this.renderTrades();
    else void this.renderConditions();
  }

  private teardown(): void {
    for (const c of this.charts) c.remove();
    this.charts = [];
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.body.innerHTML = '';
  }

  // ---------------------------------------------------------------- TRADES
  private walletOptions(): Array<{ id: string; label: string }> {
    const st = this.status;
    const out: Array<{ id: string; label: string }> = [{ id: 'paper', label: 'practice engine' }];
    const w = st?.wallet.address;
    const tw = st?.tradingWallet.address;
    if (w && w !== tw) out.push({ id: w, label: `${st?.wallet.signer === 'key' ? 'trading wallet' : 'Phantom'} ${w.slice(0, 4)}…${w.slice(-4)}` });
    if (tw) out.push({ id: tw, label: `trading wallet ${tw.slice(0, 4)}…${tw.slice(-4)}` });
    out.push({ id: 'custom', label: 'another address…' });
    return out;
  }

  private async renderTrades(): Promise<void> {
    this.title.textContent = 'TRADES';
    const opts = this.walletOptions();
    if (!this.walletChoice || !opts.some((o) => o.id === this.walletChoice)) {
      const st = this.status;
      this.walletChoice = st?.engine === 'live' && st.wallet.address ? st.wallet.address : 'paper';
    }
    this.body.innerHTML = `
      <div class="page-tools">
        <label>wallet <select id="pgWallet">${opts.map((o) => `<option value="${o.id}"${o.id === this.walletChoice ? ' selected' : ''}>${o.label}</option>`).join('')}</select></label>
        <input id="pgAddr" class="mono" placeholder="wallet address" style="width:300px" hidden>
        <button id="pgLoad" class="tiny">load</button>
        <span class="muted" id="pgNote"></span>
      </div>
      <div class="page-stats" id="pgStats"></div>
      <div class="page-charts">
        <div class="page-chart"><div class="pc-title">CUMULATIVE P&amp;L · after fees</div><div id="pgCum" class="pc-body"></div></div>
        <div class="page-chart"><div class="pc-title">P&amp;L PER CLOSE</div><div id="pgBars" class="pc-body"></div></div>
      </div>
      <div class="page-split" id="pgSplit"></div>
      <div class="page-table" id="pgTable"></div>`;
    const sel = this.body.querySelector<HTMLSelectElement>('#pgWallet')!;
    const addr = this.body.querySelector<HTMLInputElement>('#pgAddr')!;
    const load = () => { this.walletChoice = sel.value === 'custom' ? addr.value.trim() || 'custom' : sel.value; void this.loadTrades(); };
    sel.addEventListener('change', () => { addr.hidden = sel.value !== 'custom'; if (sel.value !== 'custom') load(); });
    addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    this.body.querySelector('#pgLoad')!.addEventListener('click', load);
    await this.loadTrades();
  }

  private async loadTrades(): Promise<void> {
    const note = this.body.querySelector('#pgNote');
    const wallet = this.walletChoice;
    if (!wallet || wallet === 'custom') { if (note) note.textContent = 'enter an address'; return; }
    if (note) note.textContent = 'loading…';
    let rows: TradeRecord[] = [];
    try { rows = await api.tradesFor(wallet, 300); } catch (e) { if (note) note.textContent = (e as Error).message; return; }
    if (this.kind !== 'trades') return;
    if (note) note.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}${wallet === 'paper' ? ' · practice engine' : ' · on Solana (Jupiter Perps)'}`;
    const s = tradeStats(rows);
    const stats = this.body.querySelector('#pgStats')!;
    const cell = (k: string, v: string, sub = '', cls = '') => `<div class="cell"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${sub}</div></div>`;
    stats.innerHTML = [
      cell('NET · AFTER FEES', fmtSignedUsd(s.net), `${s.closes} close${s.closes === 1 ? '' : 's'}`, s.net >= 0 ? 'pos' : 'neg'),
      cell('WIN RATE', s.closes ? `${Math.round((s.wins / s.closes) * 100)}%` : '—', `${s.wins} win${s.wins === 1 ? '' : 's'} · ${s.closes - s.wins} loss${s.closes - s.wins === 1 ? '' : 'es'}`),
      cell('FEES PAID', fmtUsd(s.fees), `on ${fmtUsd(s.volume, 0)} traded`),
      cell('LIQUIDATED', String(s.liqs), s.liqs ? 'times' : 'never', s.liqs ? 'neg' : ''),
      cell('BEST', s.best ? fmtSignedUsd(s.best.pnlUsd ?? 0) : '—', s.best ? dateTime(s.best.t) : '', 'pos'),
      cell('WORST', s.worst ? fmtSignedUsd(s.worst.pnlUsd ?? 0) : '—', s.worst ? dateTime(s.worst.t) : '', 'neg'),
    ].join('');
    const split = this.body.querySelector('#pgSplit')!;
    const markets = Object.entries(s.byMarket).map(([m, v]) => `<span>${m} · ${v.n} · <b class="${v.net >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(v.net)}</b></span>`).join('');
    const bestHour = s.byHour.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
    const worstHour = s.byHour.reduce((bi, v, i, a) => (v < a[bi] ? i : bi), 0);
    split.innerHTML = `
      <span class="long">LONG · ${s.bySide.long.n} · <b class="${s.bySide.long.net >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(s.bySide.long.net)}</b></span>
      <span class="short">SHORT · ${s.bySide.short.n} · <b class="${s.bySide.short.net >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(s.bySide.short.net)}</b></span>
      ${markets}
      ${s.closes ? `<span class="muted">best hour ${String(bestHour).padStart(2, '0')}:00 (${fmtSignedUsd(s.byHour[bestHour])}) · worst hour ${String(worstHour).padStart(2, '0')}:00 (${fmtSignedUsd(s.byHour[worstHour])})</span>` : ''}`;
    this.drawTradeCharts(rows);
    const table = this.body.querySelector('#pgTable')!;
    if (!rows.length) { table.innerHTML = '<div class="muted">no trades</div>'; return; }
    table.innerHTML = `<table class="trades-table"><thead><tr><th>when</th><th>action</th><th>side</th><th>market</th><th class="r">size</th><th class="r">price</th><th class="r">P&amp;L after fees</th><th class="r">fee</th><th>tx</th></tr></thead><tbody>${rows.map((r) => {
      const dp = MARKETS[r.market]?.priceDp ?? 3;
      const pnl = r.pnlUsd === null ? '' : `<b class="${r.pnlUsd >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(r.pnlUsd)}</b>`;
      const tx = r.txid ? `<a href="https://solscan.io/tx/${r.txid}" target="_blank" rel="noopener">${r.txid.slice(0, 6)}…</a>` : '';
      return `<tr class="${/liquidation/.test(r.action) ? 'liq' : ''}"><td class="muted">${dateTime(r.t)}</td><td>${r.action}</td><td class="${r.side === 1 ? 'long' : 'short'}">${r.side === 1 ? 'LONG' : 'SHORT'}</td><td>${r.market}</td><td class="r">${fmtUsd(r.sizeUsd, 0)}</td><td class="r">${fmtPrice(r.price, dp)}</td><td class="r">${pnl}</td><td class="r muted">${fmtUsd(r.feeUsd)}</td><td>${tx}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  private drawTradeCharts(rows: TradeRecord[]): void {
    for (const c of this.charts) c.remove();
    this.charts = [];
    const closes = rows.filter(isClose).slice().sort((a, b) => a.t - b.t);
    const cumEl = this.body.querySelector<HTMLElement>('#pgCum');
    const barEl = this.body.querySelector<HTMLElement>('#pgBars');
    if (!cumEl || !barEl) return;
    if (!closes.length) { cumEl.innerHTML = '<div class="muted small" style="padding:20px">no closes yet</div>'; barEl.innerHTML = ''; return; }
    // lightweight-charts wants strictly increasing times: closes in the same second move on by one
    let lastT = 0;
    const times: UTCTimestamp[] = closes.map((r) => { let t = Math.floor(r.t / 1000); if (t <= lastT) t = lastT + 1; lastT = t; return t as UTCTimestamp; });
    let cum = 0;
    const cumData = closes.map((r, i) => ({ time: times[i], value: (cum += r.pnlUsd ?? 0) }));
    const barData = closes.map((r, i) => ({ time: times[i], value: r.pnlUsd ?? 0, color: (r.pnlUsd ?? 0) >= 0 ? '#35d07f' : '#ff3b3b' }));
    const h = 180;
    const c1 = createChart(cumEl, { ...CHART_OPTS, height: h });
    const line = c1.addAreaSeries({ lineColor: cum >= 0 ? '#35d07f' : '#ff3b3b', topColor: cum >= 0 ? 'rgba(53,208,127,0.35)' : 'rgba(255,59,59,0.35)', bottomColor: 'rgba(0,0,0,0)', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
    line.setData(cumData);
    line.createPriceLine({ price: 0, color: 'rgba(255,255,255,0.35)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    c1.timeScale().fitContent();
    const c2 = createChart(barEl, { ...CHART_OPTS, height: h });
    const bars = c2.addHistogramSeries({ priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
    bars.setData(barData);
    c2.timeScale().fitContent();
    this.charts.push(c1, c2);
  }

  // ---------------------------------------------------------------- CONDITIONS
  private async renderConditions(): Promise<void> {
    this.title.textContent = 'CONDITIONS';
    this.body.innerHTML = `
      <div class="cond-page-sentence none" id="cpSentence">WARMING UP · READING THE TAPE</div>
      <div class="cond-page-reason" id="cpReason"></div>
      <div class="cond-guide" id="cpGuide"></div>
      <div class="cond-cards" id="cpCards"></div>
      <div class="cond-rules">
        <h3>HOW THE SENTENCE IS DECIDED · the first rule that fires wins</h3>
        <ol>
          <li><b>0 · WARMING UP</b> — not enough 1 s and 15 s bars yet.</li>
          <li><b>1 · WAIT · TOO QUIET</b> — the local horizons are dead or quiet for this leverage: the move you need is not there.</li>
          <li><b>2 · SHORT · LOCAL TOP</b> — price at the highs of the 15 m range with the stretch fading; "and long-term top" when the 1 w range agrees, "in a larger downtrend" when 1 d falls, else "take profit quick".</li>
          <li><b>3 · LONG · LOCAL BOTTOM</b> — the mirror of rule 2.</li>
          <li><b>4 · MOVE STILL ACCELERATING</b> — a stretched move whose acceleration is still positive: with the move, tight, or wait; never fade it.</li>
          <li><b>5 · WITH THE TREND · PULLBACK ENTRY</b> — 1 h and 4 h rising (or falling) together and the price pulled back to mid-range.</li>
          <li><b>6 · NO EDGE</b> — mid-range on every horizon: wait for a spike.</li>
          <li><b>7 · MIXED</b> — a local top against a long-term bottom (or the reverse): only with a short horizon.</li>
        </ol>
        <p class="muted">The read is of the tape, not of your side: LONG and SHORT see the same sentence; only the wording of rule 4 follows the side you have dialled. 1 m and 15 m re-read every frame, 1 h every 10 s, 4 h to 1 y every minute.</p>
      </div>`;
    const tick = () => void this.loadConditions();
    await this.loadConditions();
    this.timer = setInterval(tick, 5000);
  }

  private async loadConditions(): Promise<void> {
    let d: { state: ConditionsState | null; series: Array<{ h: string; res_sec: number; t0: number; closes: number[] }>; price: number };
    try { d = await api.conditionsDetail(); } catch { return; }
    if (this.kind !== 'conditions') return;
    const st = d.state;
    const sent = this.body.querySelector<HTMLElement>('#cpSentence');
    const reason = this.body.querySelector<HTMLElement>('#cpReason');
    const cards = this.body.querySelector<HTMLElement>('#cpCards');
    if (!sent || !reason || !cards) return;
    if (st) {
      const cls = st.sentence.startsWith('SHORT') ? 'short' : st.sentence.startsWith('LONG') ? 'long' : st.sentence.startsWith('WAIT') ? 'wait' : st.sentence.startsWith('MIXED') ? 'mixed' : 'none';
      sent.className = `cond-page-sentence ${cls}`;
      sent.textContent = st.sentence;
      reason.textContent = `${st.reason} · rule ${st.rule} · ${clockTime(st.t).slice(0, 8)}`;
    }
    const dp = this.status?.position ? MARKETS[this.status.position.market].priceDp : 3;
    const guide = this.body.querySelector<HTMLElement>('#cpGuide');
    if (guide && st) guide.innerHTML = buildGuide(st, d.price, this.leverage, dp);
    const rowsByKey = new Map<string, ConditionRow>((st?.rows ?? []).map((r) => [r.h, r]));
    if (!cards.childElementCount) {
      cards.innerHTML = HORIZONS.map((h) => `<div class="cond-card" id="cc-${h.key}"><div class="cc-head"><b>${h.key}</b><span class="muted">${fmtTime(h.windowSec)} of ${fmtTime(h.resSec)} bars · ${h.group}</span></div><canvas class="cc-spark" width="320" height="80"></canvas><div class="cc-nums"></div></div>`).join('');
    }
    for (const sp of HORIZONS) {
      const card = cards.querySelector<HTMLElement>(`#cc-${sp.key}`);
      if (!card) continue;
      const r = rowsByKey.get(sp.key);
      const ser = d.series.find((x) => x.h === sp.key);
      const nums = card.querySelector<HTMLElement>('.cc-nums')!;
      card.classList.toggle('na', !r || !r.ok);
      if (!r || !r.ok) {
        nums.innerHTML = `<span class="muted">not enough bars yet (${r?.bars ?? 0})</span>`;
      } else {
        nums.innerHTML = [
          ['range', `${fmtPrice(r.low, dp)} – ${fmtPrice(r.high, dp)} · ${r.range} (${Math.round(r.range_pos * 100)}%)`],
          ['trend', `${r.trend_label} · ${r.trend >= 0 ? '+' : ''}${r.trend.toFixed(2)} ATR / window · EMA ${fmtPrice(r.ema, dp)}`],
          ['activity', `${r.activity_label} · ${r.activity.toFixed(2)}× normal · ATR ${fmtPrice(r.atr, dp)} (${fmtPct((r.atr / Math.max(1e-9, r.ema)) * 100)})${r.activity_ok ? '' : ' · short history'}`],
          ['stretch', `${r.stretch_label} · ${r.stretch >= 0 ? '+' : ''}${r.stretch.toFixed(2)} ATR from the EMA · accel ${r.accel >= 0 ? '+' : ''}${r.accel.toFixed(2)} (${r.accel > 0 ? 'still going' : r.accel < 0 ? 'fading' : 'flat'})`],
        ].map(([k, v]) => `<div><span class="k">${k}</span><span>${v}</span></div>`).join('');
      }
      const canvas = card.querySelector<HTMLCanvasElement>('canvas');
      if (canvas && ser && ser.closes.length > 2) this.spark(canvas, ser.closes, r?.ok ? r.low : null, r?.ok ? r.high : null, sp.resSec);
    }
  }

  private spark(canvas: HTMLCanvasElement, closes: number[], low: number | null, high: number | null, resSec: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const lo = Math.min(...closes, low ?? Infinity), hi = Math.max(...closes, high ?? -Infinity);
    const span = Math.max(1e-9, hi - lo);
    const x = (i: number) => (i / (closes.length - 1)) * (w - 4) + 2;
    const y = (v: number) => h - 4 - ((v - lo) / span) * (h - 8);
    if (low !== null && high !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, y(high), w, Math.max(1, y(low) - y(high)));
    }
    const n = Math.max(2, Math.round(closes.length / 4));
    const ema = emaSeries(closes, n);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(180,140,255,0.8)';
    ctx.beginPath();
    ema.forEach((v, i) => { if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v)); });
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#e6e4f5';
    ctx.beginPath();
    closes.forEach((v, i) => { if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v)); });
    ctx.stroke();
    const last = closes[closes.length - 1];
    ctx.fillStyle = '#2ee6ff';
    ctx.beginPath(); ctx.arc(x(closes.length - 1), y(last), 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '9px JetBrains Mono, Menlo, monospace';
    ctx.fillText(`${closes.length} × ${fmtTime(resSec)}`, 4, 10);
  }
}
