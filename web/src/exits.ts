// Update 12: the EXITS drawer on the driving page. Arm partial take-profit / stop-loss orders ("50% at x",
// "100% at y"); the server watches the price and closes that fraction when it is reached (REAL: it prepares
// the close for Phantom). Armed exits are drawn on the road and on the chart.
import { exitPriceFromPct, exitWellPlaced } from '../../shared/exits.js';
import { pnlUsd } from '../../shared/jupiter.js';
import { MARKETS, type ExitOrder } from '../../shared/types.js';
import { api } from './api.js';
import { fmtPct, fmtPrice, fmtSignedUsd } from './format.js';
import type { UIState } from './state.js';

export interface ExitsDeps {
  getState(): UIState;
  toast(msg: string, cls?: '' | 'err' | 'warn' | 'good'): void;
}

const FRACTIONS = [0.25, 0.5, 0.75, 1];
const QUICK = [0.0025, 0.005, 0.01, 0.02];

export class ExitsPanel {
  visible = false;
  private kind: 'tp' | 'sl' = 'tp';
  private fraction = 0.5;
  private price: number | null = null;
  private $: Record<string, HTMLElement> = {};
  private lastListKey = '';

  constructor(private root: HTMLElement, private d: ExitsDeps) {
    root.innerHTML = `
      <div class="ex-head"><span>EXITS · take profit / stop loss</span><button class="tiny" id="exClose">✕</button></div>
      <div class="ex-row"><div class="seg" id="exKind"><button data-v="tp" class="active">TAKE PROFIT</button><button data-v="sl">STOP LOSS</button></div></div>
      <div class="ex-row"><span class="muted">close</span><div class="seg" id="exFrac">${FRACTIONS.map((f) => `<button data-v="${f}" class="${f === 0.5 ? 'active' : ''}">${Math.round(f * 100)}%</button>`).join('')}</div></div>
      <div class="ex-row"><span class="muted">at</span><input type="number" id="exPrice" step="0.001" placeholder="price"><div class="seg" id="exQuick">${QUICK.map((q) => `<button data-v="${q}">${q * 100}%</button>`).join('')}</div></div>
      <div class="ex-est mono small" id="exEst">open a position to arm exits</div>
      <div class="ex-row"><button class="primary wide" id="exArm">ARM</button><button class="tiny" id="exClear" title="cancel every armed exit">clear</button></div>
      <div class="ex-list mono small" id="exList"></div>`;
    for (const id of ['exClose', 'exKind', 'exFrac', 'exPrice', 'exQuick', 'exEst', 'exArm', 'exClear', 'exList']) this.$[id] = root.querySelector(`#${id}`) as HTMLElement;
    this.$.exClose.addEventListener('click', () => this.hide());
    this.seg('exKind', (v) => { this.kind = v as 'tp' | 'sl'; this.price = null; (this.$.exPrice as HTMLInputElement).value = ''; this.refresh(); });
    this.seg('exFrac', (v) => { this.fraction = Number(v); this.refresh(); });
    this.$.exQuick.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      const s = this.d.getState();
      const f = s.frame;
      if (!f?.car) return;
      this.price = exitPriceFromPct(this.kind, f.car.side, f.price, Number(b.dataset.v));
      (this.$.exPrice as HTMLInputElement).value = this.price.toFixed(MARKETS[f.market].priceDp);
      this.refresh();
    }));
    (this.$.exPrice as HTMLInputElement).addEventListener('input', (e) => { const v = Number((e.target as HTMLInputElement).value); this.price = v > 0 ? v : null; this.refresh(); });
    this.$.exArm.addEventListener('click', () => void this.arm());
    this.$.exClear.addEventListener('click', () => void api.exits({ action: 'clear' }).then((r) => this.d.toast(r.message, r.ok ? 'good' : 'warn')).catch((e: Error) => this.d.toast(e.message, 'err')));
  }

  private seg(id: string, on: (v: string) => void): void {
    const box = this.$[id];
    box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      box.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      on(b.dataset.v!);
    }));
  }

  show(): void { this.visible = true; this.root.hidden = false; this.refresh(); }
  hide(): void { this.visible = false; this.root.hidden = true; }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }

  private async arm(): Promise<void> {
    if (this.price === null) { this.d.toast('Set a price first (type it or pick a % from the mark).', 'warn'); return; }
    try {
      const r = await api.exits({ action: 'add', kind: this.kind, price: this.price, fraction: this.fraction });
      this.d.toast(r.message, r.ok ? 'good' : 'warn');
      if (r.ok) { this.price = null; (this.$.exPrice as HTMLInputElement).value = ''; this.refresh(); }
    } catch (e) {
      this.d.toast((e as Error).message, 'err');
    }
  }

  /** The estimate line for the exit being composed. */
  private refresh(): void {
    const s = this.d.getState();
    const f = s.frame;
    const c = f?.car;
    if (!f || !c) { this.$.exEst.textContent = 'open a position to arm exits'; return; }
    const dp = MARKETS[f.market].priceDp;
    if (this.price === null) {
      this.$.exEst.textContent = `${this.kind === 'tp' ? 'take profit' : 'stop loss'} ${Math.round(this.fraction * 100)}% · pick a price: ${this.kind === 'tp' ? (c.side === 1 ? 'above' : 'below') : (c.side === 1 ? 'below' : 'above')} the mark ${fmtPrice(f.price, dp)}`;
      return;
    }
    const ok = exitWellPlaced(this.kind, c.side, f.price, this.price);
    const est = pnlUsd(c.side, c.entry, this.price, c.size_usd * this.fraction) - c.fees_usd * this.fraction;
    this.$.exEst.textContent = ok
      ? `${this.kind === 'tp' ? 'take profit' : 'stop loss'}: close ${Math.round(this.fraction * 100)}% at ${fmtPrice(this.price, dp)} (${fmtPct(((this.price - f.price) / f.price) * 100, true)} from the mark) ≈ ${fmtSignedUsd(est)} realized`
      : `a ${this.kind === 'tp' ? 'take profit' : 'stop loss'} for a ${c.side === 1 ? 'long' : 'short'} must be ${(this.kind === 'tp') === (c.side === 1) ? 'above' : 'below'} the mark`;
    this.$.exEst.className = `ex-est mono small${ok ? '' : ' bad'}`;
  }

  update(s: UIState): void {
    if (!this.visible) return;
    const f = s.frame;
    const exits: ExitOrder[] = s.status?.exits ?? [];
    const key = exits.map((e) => `${e.id}:${e.state}`).join('|') + `|${f?.price.toFixed(3) ?? ''}`;
    if (key === this.lastListKey) return;
    this.lastListKey = key;
    this.refresh();
    if (!f?.car) { this.$.exList.innerHTML = ''; return; }
    const c = f.car;
    const dp = MARKETS[f.market].priceDp;
    const armed = exits.filter((e) => e.state === 'armed');
    this.$.exList.innerHTML = armed.length
      ? armed.map((e) => {
        const est = pnlUsd(c.side, c.entry, e.price, c.size_usd * e.fraction) - c.fees_usd * e.fraction;
        return `<div class="ex-item ${e.kind}"><b>${e.kind.toUpperCase()} ${Math.round(e.fraction * 100)}%</b> at ${fmtPrice(e.price, dp)} · ${fmtPct(((e.price - f.price) / f.price) * 100, true)} · ≈ ${fmtSignedUsd(est)} <button class="tiny" data-id="${e.id}">✕</button></div>`;
      }).join('')
      : '<div class="muted">nothing armed · a filled exit closes that share at the market and leaves the rest driving</div>';
    this.$.exList.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) => b.addEventListener('click', () => {
      void api.exits({ action: 'cancel', id: b.dataset.id! }).then((r) => this.d.toast(r.message, r.ok ? 'good' : 'warn')).catch((e: Error) => this.d.toast(e.message, 'err'));
    }));
  }
}
