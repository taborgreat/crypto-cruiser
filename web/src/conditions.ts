// Update 11: the CONDITIONS panel. One sentence in caps (side word coloured), a reason line in plain units,
// and the seven-row grid: position in range, trend, activity, stretch. Hover any cell for the numbers and
// the formula. Sits above Go so it is the last thing read before pressing.
import { HORIZONS, type ConditionRow, type ConditionsState } from '../../shared/conditions.js';
import type { Side } from '../../shared/types.js';
import { fmtPct, fmtPrice, fmtTime, fmtUsd } from './format.js';

const ACTIVITY_BARS: Record<string, number> = { dead: 1, quiet: 2, normal: 3, active: 4, hot: 5 };

function sideClass(sentence: string): string {
  if (sentence.startsWith('SHORT')) return 'short';
  if (sentence.startsWith('LONG')) return 'long';
  if (sentence.startsWith('WAIT')) return 'wait';
  if (sentence.startsWith('MIXED')) return 'mixed';
  return 'none';
}

export class ConditionsPanel {
  private sentence: HTMLElement;
  private reason: HTMLElement;
  private rows = new Map<string, { tr: HTMLElement; bar: HTMLElement; dot: HTMLElement; range: HTMLElement; trend: HTMLElement; act: HTMLElement; stretch: HTMLElement }>();
  private lastSentence = '';
  private lastReason = '';
  private lastRowKey = new Map<string, string>();

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="cond-head"><span>CONDITIONS</span><span class="muted" id="condAge" title="1m and 15m re-read every frame, 1h every 10 s, 4h to 1y every minute; the sentence re-evaluates when a row changes class. It reads the tape, not your side: LONG and SHORT get the same read (only the wording of rule 4, a move still accelerating, follows your side).">live · 1h /10 s · 4h+ /1 m · same for both sides</span></div>
      <div class="cond-sentence none" id="condSentence">WARMING UP · READING THE TAPE</div>
      <div class="cond-reason" id="condReason"></div>
      <table class="cond-grid" id="condGrid">
        <thead><tr><th></th><th>position in range</th><th>trend</th><th>activity</th><th>stretch</th></tr></thead>
        <tbody></tbody>
      </table>`;
    this.sentence = root.querySelector('#condSentence')!;
    this.reason = root.querySelector('#condReason')!;
    const tbody = root.querySelector('tbody')!;
    for (const h of HORIZONS) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="ch">${h.key}</td><td class="cr"><span class="bar"><i></i></span><span class="rl">—</span></td><td class="ct">—</td><td class="ca">—</td><td class="cs">—</td>`;
      tbody.appendChild(tr);
      this.rows.set(h.key, {
        tr, bar: tr.querySelector('.bar')!, dot: tr.querySelector('.bar i')!, range: tr.querySelector('.rl')!,
        trend: tr.querySelector('.ct')!, act: tr.querySelector('.ca')!, stretch: tr.querySelector('.cs')!,
      });
    }
  }

  /** Returns the sentence's side so the Go button can agree or disagree with it. */
  update(c: ConditionsState | null, driverSide: Side, dp: number): Side | 0 {
    if (!c) return 0;
    if (c.sentence !== this.lastSentence) {
      this.lastSentence = c.sentence;
      const cls = sideClass(c.sentence);
      const i = c.sentence.indexOf(' · ');
      const head = i > 0 ? c.sentence.slice(0, i) : c.sentence;
      const rest = i > 0 ? c.sentence.slice(i) : '';
      this.sentence.innerHTML = `<b class="${cls}">${head}</b>${rest}`;
      this.sentence.className = `cond-sentence ${cls}`;
      this.sentence.title = `rule ${c.rule} of the stack`;
    }
    if (c.reason !== this.lastReason) { this.lastReason = c.reason; this.reason.textContent = c.reason; }
    for (const r of c.rows) {
      const el = this.rows.get(r.h);
      if (!el) continue;
      const key = `${r.ok}|${r.range_pos.toFixed(2)}|${r.trend_label}|${r.trend.toFixed(1)}|${r.activity_label}|${r.stretch.toFixed(1)}|${r.accel.toFixed(2)}`;
      if (this.lastRowKey.get(r.h) === key) continue;
      this.lastRowKey.set(r.h, key);
      el.tr.classList.toggle('na', !r.ok);
      if (!r.ok) {
        el.range.textContent = `${r.bars} bars`;
        el.trend.textContent = '—'; el.act.textContent = '—'; el.stretch.textContent = '—';
        el.dot.style.left = '50%';
        el.tr.title = `${r.h}: not enough ${fmtTime(r.res_sec)} bars yet (${r.bars})`;
        continue;
      }
      // the bar: low → high, the dot is the price; red = toward the end that hurts the selected side
      el.dot.style.left = `${Math.round(r.range_pos * 100)}%`;
      el.bar.className = `bar ${driverSide === -1 ? 'hurt-right' : 'hurt-left'}`;
      el.range.textContent = r.range;
      el.range.parentElement!.title = `range_pos = (P − low) / (high − low) = ${r.range_pos.toFixed(2)} · low ${fmtPrice(r.low, dp)} · high ${fmtPrice(r.high, dp)} · window ${fmtTime(r.window_sec)} of ${fmtTime(r.res_sec)} bars (${r.bars})`;
      const arrow = r.trend_label === 'rising' ? '↗' : r.trend_label === 'falling' ? '↘' : '→';
      el.trend.textContent = `${arrow} ${r.trend_label}`;
      el.trend.className = `ct ${r.trend_label}`;
      el.trend.title = `trend = (EMA_now − EMA_start) / ATR = ${r.trend >= 0 ? '+' : ''}${r.trend.toFixed(2)} ATR per window · EMA ${fmtPrice(r.ema, dp)} · ATR ${fmtUsd(r.atr)} · |trend| < 0.5 = flat`;
      const n = ACTIVITY_BARS[r.activity_label] ?? 3;
      el.act.textContent = `${'▮'.repeat(n)}${'▯'.repeat(5 - n)}${r.activity_label !== 'normal' ? ' ' + r.activity_label : ''}`;
      el.act.className = `ca ${r.activity_label}`;
      el.act.title = `activity = ATR(window) / ATR(average over 10× window) = ${r.activity.toFixed(2)}${r.activity_ok ? '' : ' (not enough history for the 10× average)'} · ATR ${fmtUsd(r.atr)} vs ${fmtUsd(r.atr_avg)} · < 0.6 quiet · > 1.6 hot`;
      const s = r.stretch;
      el.stretch.textContent = `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(1)}${Math.abs(s) > 2 ? ` ATR ${r.accel < 0 ? 'fading' : 'still going'}` : ''}`;
      el.stretch.className = `cs ${Math.abs(s) > 2 ? (s > 0 ? 'up' : 'down') : ''}`;
      el.stretch.title = `stretch = (P − EMA) / ATR = ${s.toFixed(2)} (${fmtPct((s * r.atr / Math.max(1e-9, r.ema)) * 100, true)} from the mean) · accel ${r.accel >= 0 ? '+' : ''}${r.accel.toFixed(2)} (last 20% of the window vs the prior 80%, in the direction of the stretch; < 0 fading) · |stretch| > 2 = extended`;
    }
    return c.side;
  }
}
