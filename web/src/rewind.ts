// Update 7: rewind drive panel. Lookback chips, playback duration, two-sided toggle, the timeline bar
// with each lane's P&L path, liquidation marks, flags and the playhead; per-lane readouts at the end.
// Update 10 §3: every line on the bar carries its own label.
import type { Frame, RewindState, Side } from '../../shared/types.js';
import { api } from './api.js';
import { clockTime, fmtPct, fmtPrice, fmtSignedUsd, fmtTime, shortSpan } from './format.js';
import type { Store, UIState } from './state.js';

export interface RewindDeps {
  store: Store;
  getTrade(): { side: Side; leverage: number; collateralUsd: number };
  onStarted(): void;
  toast(msg: string, cls?: '' | 'err' | 'warn' | 'good'): void;
}

const LOOKBACKS = [300, 900, 3600, 14_400, 86_400, 259_200, 604_800];

export class RewindPanel {
  visible = false;
  private lookback = 3600;
  private duration = 45;
  private twoSided = true;
  private $: Record<string, HTMLElement> = {};
  private bar: HTMLElement;
  private canvas: HTMLCanvasElement;
  private lastState: RewindState | null = null;

  constructor(private root: HTMLElement, private d: RewindDeps, stage: HTMLElement) {
    root.innerHTML = `
      <h3>REWIND DRIVE · the past, in the driver's seat <button class="close" id="rwClose">✕</button></h3>
      <div class="muted small" style="margin-bottom:8px">Drive from then to now with the proposed position held, LONG and SHORT side by side. Liquidated lanes respawn at the mark; the crash count is the information. The drive lands on now in the lane.</div>
      <div class="field"><label>LOOKBACK</label><div class="presets" id="rwLook">${LOOKBACKS.map((s) => `<button data-v="${s}" class="${s === 3600 ? 'active' : ''}">${shortSpan(s)}</button>`).join('')}</div></div>
      <div class="row" style="margin:8px 0;gap:12px">
        <label class="small muted">playback <input type="number" id="rwDur" min="5" max="600" step="5" value="45" style="width:70px"> s</label>
        <label class="small muted"><input type="checkbox" id="rwTwo" checked> LONG + SHORT lanes</label>
      </div>
      <div class="muted small" id="rwHint"></div>
      <button class="primary wide" id="rwStart" style="margin-top:8px">REWIND ⏎</button>`;
    for (const id of ['rwClose', 'rwLook', 'rwDur', 'rwTwo', 'rwHint', 'rwStart']) this.$[id] = root.querySelector(`#${id}`) as HTMLElement;
    this.$.rwClose.addEventListener('click', () => this.hide());
    this.$.rwLook.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      this.lookback = Number(b.dataset.v);
      this.$.rwLook.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      this.updateHint();
    }));
    (this.$.rwDur as HTMLInputElement).addEventListener('change', (e) => { this.duration = Math.max(5, Number((e.target as HTMLInputElement).value) || 45); this.updateHint(); });
    (this.$.rwTwo as HTMLInputElement).addEventListener('change', (e) => { this.twoSided = (e.target as HTMLInputElement).checked; });
    this.$.rwStart.addEventListener('click', () => void this.start());

    // the bottom bar while a rewind runs
    this.bar = document.createElement('div');
    this.bar.id = 'rewindBar';
    this.bar.hidden = true;
    this.bar.innerHTML = `
      <div class="rw-controls">
        <button class="tiny" id="rwPause" title="Space">⏸ pause</button>
        <button class="tiny" id="rwSlower">− slower</button><span class="mono small" id="rwSpeed">×1</span><button class="tiny" id="rwFaster">+ faster</button>
        <button class="tiny" id="rwFlag" title="M">⚑ flag</button>
        <button class="tiny" id="rwStop">■ stop</button>
        <span class="mono small" id="rwCursor"></span>
      </div>
      <canvas id="rwCanvas" height="72" title="P&L of each lane over the lookback · click to scrub"></canvas>
      <div class="rw-lanes mono small" id="rwLanes"></div>`;
    stage.appendChild(this.bar);
    this.canvas = this.bar.querySelector('#rwCanvas') as HTMLCanvasElement;
    this.bar.querySelector('#rwPause')!.addEventListener('click', () => void api.rewindControl(this.lastState?.paused ? 'resume' : 'pause'));
    this.bar.querySelector('#rwSlower')!.addEventListener('click', () => void api.rewindControl('speed', 0.5));
    this.bar.querySelector('#rwFaster')!.addEventListener('click', () => void api.rewindControl('speed', 2));
    this.bar.querySelector('#rwFlag')!.addEventListener('click', () => void api.rewindControl('flag', ''));
    this.bar.querySelector('#rwStop')!.addEventListener('click', () => void api.rewindControl('stop'));
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      void api.rewindControl('seek', (e.clientX - r.left) / r.width);
    });
    this.canvas.addEventListener('wheel', (e) => { e.preventDefault(); void api.rewindControl('speed', e.deltaY < 0 ? 1.5 : 1 / 1.5); }, { passive: false });
    this.updateHint();
  }

  private updateHint(): void {
    const st = this.d.store.state.status;
    const from = st?.feed.historyFrom ?? null;
    const avail = from ? (Date.now() - from) / 1000 : 0;
    const speed = this.lookback / this.duration;
    this.$.rwHint.textContent = `${shortSpan(this.lookback)} in ${this.duration} s = ${Math.round(speed)}× · recorded history: ${from ? fmtTime(avail) : 'none yet'}${from && avail < this.lookback ? ' (lookback will be clamped)' : ''}`;
  }

  show(): void { this.visible = true; this.root.hidden = false; this.updateHint(); }
  hide(): void { this.visible = false; this.root.hidden = true; }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }

  async start(): Promise<void> {
    const t = this.d.getTrade();
    try {
      const r = await api.rewindStart({ lookbackSec: this.lookback, durationSec: this.duration, leverage: t.leverage, collateralUsd: t.collateralUsd, twoSided: this.twoSided, side: t.side });
      this.d.toast(r.message, r.ok ? 'good' : 'warn');
      if (r.ok) { this.hide(); this.d.onStarted(); }
    } catch (e) {
      this.d.toast((e as Error).message, 'err');
    }
  }

  /** Keyboard: space pause, arrows scrub ±5%. */
  key(k: 'space' | 'left' | 'right'): void {
    const st = this.lastState;
    if (!st) return;
    if (k === 'space') void api.rewindControl(st.paused ? 'resume' : 'pause');
    else void api.rewindControl('seek', Math.min(1, Math.max(0, st.progress + (k === 'left' ? -0.05 : 0.05))));
  }

  update(s: UIState): void {
    const rw = s.frame?.rewind ?? null;
    this.lastState = rw;
    this.bar.hidden = !rw;
    if (!rw || !s.frame) return;
    (this.bar.querySelector('#rwPause') as HTMLElement).textContent = rw.paused ? '▶ resume' : rw.done ? '✓ landed' : '⏸ pause';
    (this.bar.querySelector('#rwSpeed') as HTMLElement).textContent = `×${rw.speed >= 100 ? Math.round(rw.speed) : rw.speed.toFixed(1)}`;
    (this.bar.querySelector('#rwCursor') as HTMLElement).textContent = `${clockTime(rw.cursor)} · ${fmtPrice(s.frame.price)} · ${Math.round(rw.progress * 100)}% of ${shortSpan(rw.lookback_sec)} · H ${fmtTime(rw.h)}`;
    (this.bar.querySelector('#rwLanes') as HTMLElement).innerHTML = rw.lanes.map((l) => `<div class="${l.side === 1 ? 'long' : 'short'}" title="${l.readout}">${l.readout}</div>`).join('');
    this.draw(rw, s.frame);
  }

  private draw(rw: RewindState, f: Frame): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || 800, h = 72;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, w, h);
    const span = Math.max(1, rw.t1 - rw.t0);
    const x = (t: number) => ((t - rw.t0) / span) * w;
    const path = rw.path;
    ctx.font = '9px monospace';
    if (path.length > 1) {
      let maxAbs = 1;
      for (const p of path) maxAbs = Math.max(maxAbs, Math.abs(p[1]), Math.abs(p[2]));
      const y = (v: number) => h / 2 - (v / maxAbs) * (h / 2 - 6);
      const lanes: Array<[number, string, string]> = [[1, '#5ee0c8', 'LONG'], [2, '#ff3fa4', 'SHORT']];
      for (const [idx, color, name] of lanes) {
        if (rw.lanes.length < idx) continue;
        ctx.beginPath();
        ctx.moveTo(x(path[0][0]), h / 2);
        for (const p of path) ctx.lineTo(x(p[0]), y(p[idx] as number));
        ctx.lineTo(x(path[path.length - 1][0]), h / 2);
        ctx.closePath();
        ctx.fillStyle = color + '33';
        ctx.fill();
        ctx.beginPath();
        for (let i = 0; i < path.length; i++) { const px = x(path[i][0]), py = y(path[i][idx] as number); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        // label on the line, at the playhead
        const i = Math.max(0, Math.min(path.length - 1, Math.round(((rw.cursor - rw.t0) / span) * (path.length - 1))));
        const lane = rw.lanes[idx - 1];
        const label = `${name} ${lane ? fmtSignedUsd(lane.window_pnl_usd) : ''} (${fmtPct(path[i][idx] as number, true)})`;
        ctx.fillStyle = color;
        ctx.textAlign = x(rw.cursor) > w - 120 ? 'right' : 'left';
        ctx.fillText(label, x(rw.cursor) + (ctx.textAlign === 'left' ? 6 : -6), y(path[i][idx] as number) - 3);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.textAlign = 'left';
      ctx.fillText(`+${fmtPct(maxAbs)} P&L on collateral`, 4, 10);
      ctx.fillText(`−${fmtPct(maxAbs)}`, 4, h - 3);
      ctx.fillText('0', 4, h / 2 - 2);
    }
    // liquidations: ticks on the edge, counted in one tag per side
    const nLong = rw.crashes.filter((c) => c[1] === 1).length, nShort = rw.crashes.length - nLong;
    for (const [t, side] of rw.crashes) {
      ctx.fillStyle = side === 1 ? '#5ee0c8' : '#ff3fa4';
      ctx.fillRect(x(t) - 1, side === 1 ? 0 : h - 6, 2, 6);
    }
    ctx.textAlign = 'right';
    if (nLong) { ctx.fillStyle = '#5ee0c8'; ctx.fillText(`▮ LONG liquidated ×${nLong}`, w - 4, 10); }
    if (nShort) { ctx.fillStyle = '#ff3fa4'; ctx.fillText(`▮ SHORT liquidated ×${nShort}`, w - 4, h - 3); }
    for (const fl of rw.flags) {
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(x(fl.t) - 1, 0, 2, h);
      ctx.textAlign = 'left';
      ctx.fillText(`⚑ ${clockTime(fl.t).slice(0, 8)}`, x(fl.t) + 3, 20);
    }
    const px = x(rw.cursor);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - 1, 0, 2, h);
    ctx.textAlign = px > w - 90 ? 'right' : 'left';
    ctx.fillText(`now −${fmtTime((rw.t1 - rw.cursor) / 1000)}`, px + (ctx.textAlign === 'left' ? 4 : -4), h / 2 + 12);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'left';
    ctx.fillText(clockTime(rw.t0).slice(0, 8), 4, h / 2 + 12);
    ctx.textAlign = 'right';
    ctx.fillText('now', w - 4, h / 2 + 12);
    ctx.textAlign = 'left';
    void f;
  }
}
