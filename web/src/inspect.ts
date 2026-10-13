// Update 5 §3: the inspect panel. Every live value with its source, formula and timestamp: the frame
// object from spec §6.3, formatted. For when the tooltip is not enough.
import type { Frame, StatusMsg } from '../../shared/types.js';
import { clockTime } from './format.js';

interface Row { key: string; value: string; formula: string; source: string }

const FORMULAS: Record<string, string> = {
  gap: 'L × s × (P − liq) / P',
  gap_pct: 's × (P − liq) / P',
  gap_anim: 'gap at P_anim',
  v_gap: 'L × s × v_fast',
  v_close: '−v_gap',
  a_gap: 'L × s × a_fast',
  v_gap_trend: 'L × s × v_slow',
  v_gap_impulse: 'v_gap − v_gap_trend',
  v_gap_liq: '−L × s × (dliq/dt) / P',
  v_road: 'max(v_road_min, k × L × ATR_rate)',
  v_ahead: 'v_road + v_gap_trend + v_gap_liq',
  v_you: 'v_road − v_gap_impulse',
  brake_ahead: 'clamp(−a_gap_trend / 0.01) ∨ 0.35·clamp(−v_gap_trend / 0.05)',
  headway_s: 'gap / v_close',
  headway_proj_s: 'gap = v_close·t + ½·a_close·t²',
  entry_dist: 'L × s × (P − entry) / entry',
  pnl_pct: 'L × s × (P − entry) / entry × 100',
  pnl_usd: 's × (P − entry) × size / entry',
  throttle: 'pedal input·e^(−age/1.2s) + max(0, −impulse)/0.05',
  brake: 'pedal input·e^(−age/1.2s) + max(0, impulse)/0.05',
  v_price_raw: 'EMA(d/dt ln P, H/30)',
  v_trend_raw: 'EMA(d/dt ln P, H)',
  a_trend_raw: 'EMA(d/dt v_trend, H/6)',
  v_impulse_raw: 'v_fast − v_slow',
  h: 'H_base × clamp(gap/gap_at_entry, 0.5, 20)^1.5 (auto room), slow-lerped',
  k_scroll: '60 / H',
  tick_lerp: 'clamp(H / 300, 0.1, 1)',
  atr: 'Wilder ATR(14) of 1 m candles / price',
  atr_rate: 'ATR / 60',
  funding: 'Jupiter pool-info hourly borrow rate',
  spread: '(ask − bid) / mid (Coinbase)',
  divergence: '|oracle − feed| / oracle',
  liq: 'Jupiter: entry ∓ |size/500 + closeFee + borrowFee − collateral| × entry / size',
};

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(3) : v.toFixed(Math.abs(v) < 10 ? 5 : 3);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}

function flatten(prefix: string, obj: Record<string, unknown>, source: string, out: Row[], depth = 0): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && depth < 1) {
      flatten(`${prefix}${k}.`, v as Record<string, unknown>, source, out, depth + 1);
      continue;
    }
    out.push({ key: `${prefix}${k}`, value: fmtVal(v), formula: FORMULAS[k] ?? '', source });
  }
}

export class InspectPanel {
  visible = false;
  private lastRender = 0;
  constructor(private root: HTMLElement) {
    root.innerHTML = `<h3>INSPECT · every live value <button class="close" id="insClose">✕</button></h3><div id="insBody" class="mono small"></div>`;
    root.querySelector('#insClose')!.addEventListener('click', () => this.hide());
  }
  show(): void { this.visible = true; this.root.hidden = false; }
  hide(): void { this.visible = false; this.root.hidden = true; }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }

  update(frame: Frame | null, status: StatusMsg | null, nowMs: number): void {
    if (!this.visible || !frame || nowMs - this.lastRender < 250) return;
    this.lastRender = nowMs;
    const rows: Row[] = [];
    const { car, ghosts, layers, horizon, rewind, behind, swings, ...top } = frame;
    flatten('', top as unknown as Record<string, unknown>, `oracle ${clockTime(frame.t_truth)} · anim ${clockTime(frame.t_anim)}`, rows);
    if (car) flatten('car.', car as unknown as Record<string, unknown>, 'kinematics', rows);
    flatten('horizon.', horizon as unknown as Record<string, unknown>, 'Update 4', rows);
    flatten('layers.', { ...layers, hills: `[${layers.hills.length}]` } as unknown as Record<string, unknown>, 'layers', rows);
    ghosts.forEach((g) => flatten(`ghost ${g.label}.`, { entry: g.entry, liq: g.liq, gap: g.gap, headway_s: g.headway_s, pnl_usd: g.pnl_usd, crashed: g.crashed, crash_count: g.crash_count, t_entry: clockTime(g.t_entry) } as Record<string, unknown>, 'ghost', rows));
    if (rewind) flatten('rewind.', { cursor: clockTime(rewind.cursor), speed: rewind.speed, progress: rewind.progress, h: rewind.h, lanes: rewind.lanes.map((l) => l.readout).join(' | ') } as Record<string, unknown>, 'rewind', rows);
    if (behind) rows.push({ key: 'behind', value: `${behind.profile.length} pts · ${behind.crashes.length} crashes · ${behind.flags.length} flags`, formula: '', source: 'history' });
    rows.push({ key: 'swings', value: `${swings.length}`, formula: 'pivot highs/lows, 1 m candles', source: 'layers' });
    if (status) {
      flatten('feed.', status.feed as unknown as Record<string, unknown>, 'feed', rows);
      flatten('settings.', status.settings as unknown as Record<string, unknown>, 'settings', rows);
    }
    const body = this.root.querySelector('#insBody')!;
    body.innerHTML = `<table class="inspect-table"><thead><tr><th>field</th><th>value</th><th>formula</th><th>source</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.key}</td><td>${r.value}</td><td class="muted">${r.formula}</td><td class="muted">${r.source}</td></tr>`).join('')}</tbody></table>`;
  }
}
