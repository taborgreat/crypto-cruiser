// Update 27: the order flow as a list. Every print the crowd reacts to (the server's FlowEvents on the anim
// stream), newest first, with the last minute's buy / sell totals on top. F toggles it.
import type { FlowEvent } from '../../shared/types.js';

const KEEP = 400;

export class FlowPanel {
  visible = false;
  private rows: FlowEvent[] = [];
  private lastDraw = 0;
  private dirty = false;

  constructor(private root: HTMLElement) {
    root.className = 'panel flow-panel';
    root.hidden = true;
    root.innerHTML = `<h3>ORDER FLOW <span class="muted small" id="flSum"></span><button class="close" id="flClose">✕</button></h3>
      <div class="flow-head"><span>time</span><span>side</span><span>size</span><span>vs median</span><span>busy</span></div>
      <div class="flow-list" id="flList"><div class="muted small">waiting for prints…</div></div>`;
    root.querySelector('#flClose')!.addEventListener('click', () => this.hide());
    setInterval(() => { if (this.visible && this.dirty) this.draw(); }, 300);
  }

  push(events: FlowEvent[]): void {
    for (const e of events) this.rows.push(e);
    if (this.rows.length > KEEP) this.rows.splice(0, this.rows.length - KEEP);
    this.dirty = true;
  }

  show(): void { this.visible = true; this.root.hidden = false; this.draw(); }
  hide(): void { this.visible = false; this.root.hidden = true; }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }

  private draw(): void {
    this.dirty = false;
    this.lastDraw = performance.now();
    const now = Date.now();
    let buy = 0, sell = 0, nBuy = 0, nSell = 0;
    for (const r of this.rows) {
      if (r.t < now - 60_000) continue;
      if (r.side === 1) { buy += r.sizeUsd; nBuy++; } else { sell += r.sizeUsd; nSell++; }
    }
    const net = buy - sell;
    const usd = (v: number) => `$${Math.round(v).toLocaleString()}`;
    (this.root.querySelector('#flSum') as HTMLElement).innerHTML =
      `last 60 s · <b class="long">buy ${usd(buy)}</b> (${nBuy}) · <b class="short">sell ${usd(sell)}</b> (${nSell}) · net <b class="${net >= 0 ? 'long' : 'short'}">${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}</b>`;
    const list = this.root.querySelector('#flList') as HTMLElement;
    if (!this.rows.length) return;
    const shown = this.rows.slice(-150).reverse();
    list.innerHTML = shown.map((r) => {
      const big = r.ratio >= 5 ? ' big' : r.ratio >= 2 ? ' mid' : '';
      return `<div class="flow-row ${r.side === 1 ? 'buy' : 'sell'}${big}"><span>${new Date(r.t).toLocaleTimeString()}</span><span>${r.side === 1 ? 'BUY' : 'SELL'}</span><span>${usd(r.sizeUsd)}</span><span>${r.ratio.toFixed(1)}×</span><span>${r.busy.toFixed(1)}×</span></div>`;
    }).join('');
  }
}
