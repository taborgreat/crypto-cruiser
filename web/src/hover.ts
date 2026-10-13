// Update 5: hover on everything. Tooltip text per road object in plain units, with the timestamp of the
// value, and persistent label tags positioned from the renderer's anchors (Update 8: the top-down view
// dictates its own label texts). Update 11 B4: labels push apart vertically so none sits under a neighbour,
// and tags can be right-aligned (the liq tags in the left margin). Tooltips are never pinned (B5).
import { trendWord } from '../../shared/readout.js';
import { pnlUsd } from '../../shared/jupiter.js';
import type { CarFrame, Frame, StatusMsg } from '../../shared/types.js';
import { clockTime, fmtHeadway, fmtPct, fmtPrice, fmtRate, fmtSignedUsd, fmtSol, fmtTime, fmtUsd, shortSpan } from './format.js';
import type { HoverHit, LabelAnchor } from './renderer.js';
import { focusCar } from './state.js';

export interface HoverCtx {
  frame: Frame;
  status: StatusMsg | null;
  anim: { t: number; price: number } | null;
  primaryGhostId: string;
  priceDp: number;
  redMoments: number[];
}

function carLines(c: CarFrame, f: Frame, dp: number, label: string): string[] {
  const toLiq = Math.abs(f.price - c.liq);
  const net = c.pnl_usd - c.fees_usd;
  return [
    `${label}: ${fmtPrice(c.entry, dp)} · ${c.leverage.toFixed(1)}x · ${fmtUsd(c.size_usd, 0)}`,
    `P&L ${fmtSignedUsd(net)} (${fmtPct(c.collateral_usd > 0 ? (net / c.collateral_usd) * 100 : 0, true)}) after fees`,
    `to liq ${fmtUsd(toLiq)} (${fmtPct(c.gap_pct * 100)}) · time to liq ${fmtHeadway(c.headway_s)}`,
  ];
}

/** P&L after fees as a percent of collateral: the one basis every $ and % share (Update 11 B1). */
export function netPct(c: CarFrame): number {
  const net = c.pnl_usd - c.fees_usd;
  return c.collateral_usd > 0 ? (net / c.collateral_usd) * 100 : 0;
}

export function tooltipLines(hit: HoverHit, ctx: HoverCtx): string[] {
  const f = ctx.frame;
  const dp = ctx.priceDp;
  const H = f.horizon.h;
  const tTruth = `t = ${clockTime(f.t_truth)} (oracle)`;
  const formula = (s: string) => `⌁ ${s}`;
  const hitBase = hit.id ? hit.id.split(':')[0] : null;
  const ghost = hitBase ? f.ghosts.find((g) => g.id === hitBase) : undefined;
  const fc = focusCar(f, ctx.primaryGhostId);
  const car = f.car ?? fc?.car ?? null;
  switch (hit.kind) {
    case 'you': {
      const lines = [`mark ${fmtPrice(f.price, dp)} (oracle) · anim ${fmtPrice(f.price_anim, dp)} (${f.anim_source})`];
      if (f.car) lines.push(`P&L ${fmtSignedUsd(f.car.pnl_usd - f.car.fees_usd)} (${fmtPct(netPct(f.car), true)}) after fees · ${f.car.leverage.toFixed(1)}x · ${fmtUsd(f.car.size_usd, 0)}`);
      lines.push(`price ${fmtRate(f.v_price_raw, H, 'pct')} · trend ${fmtRate(f.v_trend_raw, H, 'pct')}`);
      lines.push(tTruth);
      return lines;
    }
    case 'ahead':
    case 'ghost-ahead': {
      const c = hit.kind === 'ahead' ? f.car ?? car : ghost ?? car;
      if (!c) return ['no car'];
      const liqMoving = Math.abs(c.v_gap_liq) > 1e-5 ? `${fmtRate((c.v_gap_liq / c.leverage) * f.price * -1, H, 'money')}` : 'no';
      return [
        `${ghost && hit.kind === 'ghost-ahead' ? ghost.label + ' · ' : ''}liquidation ${fmtPrice(c.liq, dp)} · ${fmtUsd(Math.abs(f.price - c.liq))} away (${fmtPct(c.gap_pct * 100)})`,
        `time to liq ${fmtHeadway(c.headway_s)} · projected ${fmtHeadway(c.headway_proj_s)}`,
        `trend: ${trendWord(c)} · liq moving: ${liqMoving}`,
        tTruth,
      ];
    }
    case 'entry': {
      const c = f.car;
      if (!c) return ['no entry'];
      const fromEntry = c.side * (f.price - c.entry);
      return [
        `entry ${fmtPrice(c.entry, dp)} · ${fmtSignedUsd(fromEntry)} (${fmtPct((fromEntry / c.entry) * 100, true)}) from breakeven`,
        `you are ${fmtPct(Math.abs(fromEntry / c.entry) * 100)} ${fromEntry >= 0 ? 'past' : 'short of'} breakeven`,
        tTruth,
      ];
    }
    case 'stop': {
      const c = f.car;
      if (!c || c.stop_price === null) return ['no trailing stop'];
      const pnlAtStop = (c.side * (c.stop_price - c.entry) * c.size_usd) / c.entry - c.fees_usd;
      return [
        `trailing stop ${fmtPrice(c.stop_price, dp)} · ${fmtPct(Math.abs((c.stop_price - f.price) / f.price) * 100)} behind`,
        `will fill at ≈ ${fmtSignedUsd(pnlAtStop)} after fees · follows the price`,
        tTruth,
      ];
    }
    case 'ghost':
    case 'text': {
      if (!ghost) return hit.kind === 'text' ? [] : ['lane'];
      return [
        `${ghost.side === 1 ? 'LONG' : 'SHORT'} ${ghost.leverage.toFixed(1)}x · ${ghost.label} at ${fmtPrice(ghost.entry, dp)}`,
        ...carLines(ghost, f, dp, 'if real').slice(1),
        `${ghost.crash_count ? `liquidated ${ghost.crash_count}× in this lane · ` : ''}${ghost.crashed ? 'LIQUIDATED, respawning' : trendWord(ghost)} · click to focus this lane`,
        tTruth,
      ];
    }
    case 'limit': {
      if (!ghost || ghost.proposed_entry === null) return ['limit'];
      return [`limit entry ${fmtPrice(ghost.proposed_entry, dp)} · ${fmtPct(Math.abs((ghost.proposed_entry - f.price) / f.price) * 100)} from the mark`, 'drag on the road or [ ] to move it', tTruth];
    }
    case 'road': {
      const L = f.layers;
      return [
        `road flow ${car ? fmtPct((car.v_road / car.leverage) * 100 * 60) : '—'}/min = ATR(${ctx.status?.settings.atrWindow ?? 14}×1m) ${L.atr === null ? 'warming up' : fmtPct(L.atr * 100)}`,
        `horizon H = ${fmtTime(H)}${f.horizon.auto_room ? ' (auto from room)' : ''} · ${f.horizon.clear ? 'CLEAR' : f.horizon.clear_why}`,
        `funding ${L.funding === null ? 'n/a' : `−${fmtPct(L.funding * 100)}/h` + (car ? ` → paying ${fmtUsd(car.size_usd * L.funding)}/h` : '')}`,
        tTruth,
      ];
    }
    case 'hill': {
      const L = f.layers;
      return [`road grade: funding ${L.funding === null ? 'n/a' : `−${fmtPct(L.funding * 100)}/h`}${car && L.funding !== null ? ` → paying ${fmtUsd(car.size_usd * L.funding)}/h` : ''}`, `hills: swing structure projected forward (${f.swings.length} swings)`, tTruth];
    }
    case 'fog': {
      const L = f.layers;
      return [`spread ${L.spread === null ? 'n/a' : `${(L.spread * 1e4).toFixed(1)} bp`}${car && L.spread !== null ? ` · est. slippage ${fmtUsd(car.size_usd * L.spread)} on close` : ''}`, `oracle vs feed ${L.divergence === null ? 'n/a' : `${(L.divergence * 1e4).toFixed(1)} bp`}`, tTruth];
    }
    case 'traffic': {
      // Update 27: a trade car says the print and nothing else; a plain car says what sets the density
      if (hit.text) return [hit.text];
      const L = f.layers;
      return [`traffic · 1 m ATR ${L.atr === null ? '—' : fmtPct(L.atr * 100)}`];
    }
    case 'pole':
      return [`roadside light · scrolls at your speed`, car ? `you ${fmtRate((car.v_you / car.leverage) * 100, H, 'pct')} of price` : '', tTruth].filter(Boolean);
    case 'crash': {
      const id = hit.id ?? '';
      if (id.startsWith('r')) {
        const t = ctx.redMoments[Number(id.slice(1))];
        return t ? [`time to liquidation was red here`, `t = ${clockTime(t)}`] : ['red post'];
      }
      const c = f.behind?.crashes[Number(id)];
      return c ? [`lane liquidation post · ${['5 H', 'H', 'H / 6', 'now'][c[1]] ?? c[1]} lane`, `t = ${clockTime(c[0])}`] : ['liquidation post'];
    }
    case 'exit': {
      const ex = f.exits.find((e) => e.id === hit.id);
      if (!ex || !f.car) return ['exit'];
      const c = f.car;
      const est = pnlUsd(c.side, c.entry, ex.price, c.size_usd * ex.fraction) - c.fees_usd * ex.fraction;
      return [`${ex.kind === 'tp' ? 'take profit' : 'stop loss'} · close ${Math.round(ex.fraction * 100)}% at ${fmtPrice(ex.price, dp)} (${fmtPct(((ex.price - f.price) / f.price) * 100, true)} from the mark)`, `≈ ${fmtSignedUsd(est)} realized if it fills here · the rest keeps driving`, tTruth];
    }
    case 'flag': {
      const idx = Number(hit.id ?? -1);
      const fl = f.behind?.flags[idx] ?? f.rewind?.flags[idx];
      return fl ? [`flag ${fl.note || ''} · ${fmtPrice(fl.price, dp)}`, `t = ${clockTime(fl.t)}`] : ['flag'];
    }
    default:
      return [];
  }
}

/** Short persistent tag text for label-all mode. */
export function labelText(anchor: LabelAnchor, ctx: HoverCtx): string {
  const f = ctx.frame;
  const dp = ctx.priceDp;
  const ghost = f.ghosts.find((g) => g.id === anchor.id);
  const fc = focusCar(f, ctx.primaryGhostId);
  switch (anchor.kind) {
    case 'you': return `you ${fmtPrice(f.price, dp)}`;
    case 'ahead': return f.car ? `liq ${fmtPrice(f.car.liq, dp)} · ${fmtHeadway(f.car.headway_s)}` : fc ? `liq ${fmtPrice(fc.car.liq, dp)}` : 'liq';
    case 'ghost-ahead': return ghost ? `liq ${fmtPrice(ghost.liq, dp)} · ${fmtHeadway(ghost.headway_s)}` : 'liq';
    case 'entry': return f.car ? `entry ${fmtPrice(f.car.entry, dp)} · ${f.car.side * (f.price - f.car.entry) >= 0 ? 'behind you' : 'ahead of you'}` : 'entry';
    case 'stop': return f.car?.stop_price ? `stop ${fmtPrice(f.car.stop_price, dp)}` : 'stop';
    case 'ghost': return ghost ? `${ghost.label}: ${fmtSignedUsd(ghost.pnl_usd - ghost.fees_usd)}` : 'lane';
    case 'limit': return ghost?.proposed_entry ? `limit ${fmtPrice(ghost.proposed_entry, dp)}` : 'limit';
    case 'flag': return 'flag';
    case 'crash': return 'liq';
    default: return '';
  }
}

export class Tooltip {
  /** Update 27: called when the ✕ of a pinned tooltip is clicked. */
  onClose: (() => void) | null = null;
  constructor(private el: HTMLElement) {
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('tt-close')) { e.stopPropagation(); this.onClose?.(); }
    });
  }
  show(x: number, y: number, lines: string[], pinned = false): void {
    if (!lines.length) { this.hide(); return; }
    this.el.innerHTML = (pinned ? '<button class="tt-close" title="close (Esc)">✕</button>' : '')
      + lines.map((l, i) => `<div class="${i === lines.length - 1 && l.startsWith('t = ') ? 'tt-time' : l.startsWith('⌁') ? 'tt-formula' : ''}">${l}</div>`).join('');
    this.el.classList.toggle('pinned', pinned);
    this.el.hidden = false;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const px = Math.min(window.innerWidth - w - 12, x + 16);
    const py = y + 18 + h > window.innerHeight ? y - h - 12 : y + 18;
    this.el.style.left = `${Math.max(8, px)}px`;
    this.el.style.top = `${Math.max(8, py)}px`;
  }
  hide(): void { this.el.hidden = true; }
}

const LABEL_H = 17;   // px between stacked labels
const LABEL_BAND = 90; // px: labels this close in x are considered the same column

/**
 * Persistent labels. Anchors with their own `text` (top-down lane data) are always shown; the rest only in
 * label-all mode. Labels in the same column are pushed apart vertically so none sits under a neighbour.
 */
export class Labels {
  private tags = new Map<string, { el: HTMLElement; text: string; cls: string }>();
  constructor(private root: HTMLElement) {}
  update(anchors: LabelAnchor[], ctx: HoverCtx | null, labelAll: boolean, mode: 'on' | 'faded' | 'side' | 'off' = 'on', width = 0, height = 0): void {
    // Update 14: 'faded' dims every tag, 'side' parks them in a column at the right edge, 'off' draws none
    this.root.classList.toggle('faded', mode === 'faded');
    if (!ctx || mode === 'off') { if (this.tags.size) { this.root.innerHTML = ''; this.tags.clear(); } return; }
    const side = mode === 'side';
    void width;
    this.root.classList.toggle('side', side);
    const seen = new Set<string>();
    const placed: Array<{ key: string; x: number; y: number; align: string; text: string; cls: string }> = [];
    for (const a of anchors) {
      if (!a.visible) continue;
      if (a.text === undefined && !labelAll) continue;
      const key = `${a.kind}:${a.id}`;
      seen.add(key);
      placed.push({ key, x: side ? 12 : a.x, y: a.y, align: side ? 'left' : (a.align ?? 'left'), text: a.text ?? labelText(a, ctx), cls: `label ${a.kind}${a.cls ? ' ' + a.cls : ''}` }); // side: a column on the left (Update 17: the right is the panels')
    }
    // collision avoidance: within a column, sort by y and push each tag below the previous one
    placed.sort((p, q) => p.y - q.y);
    for (let i = 0; i < placed.length; i++) {
      for (let j = 0; j < i; j++) {
        const p = placed[i], q = placed[j];
        if (p.align !== q.align || Math.abs(p.x - q.x) > LABEL_BAND) continue;
        if (Math.abs(p.y - q.y) < LABEL_H) p.y = q.y + LABEL_H;
      }
    }
    if (height > 0) for (const p of placed) p.y = Math.max(6, Math.min(height - 22, p.y)); // Update 19: never pushed off the bottom
    for (const p of placed) {
      let tag = this.tags.get(p.key);
      if (!tag) {
        const el = document.createElement('div');
        this.root.appendChild(el);
        tag = { el, text: '', cls: '' };
        this.tags.set(p.key, tag);
      }
      if (tag.text !== p.text) { tag.el.textContent = p.text; tag.text = p.text; }
      if (tag.cls !== p.cls) { tag.el.className = p.cls; tag.cls = p.cls; }
      const shift = p.align === 'right' ? ' translate(-100%, 0)' : p.align === 'center' ? ' translate(-50%, 0)' : '';
      tag.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)${shift}`;
    }
    for (const [key, tag] of this.tags) if (!seen.has(key)) { tag.el.remove(); this.tags.delete(key); }
  }
}

export { fmtSol };
