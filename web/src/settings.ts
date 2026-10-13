// Settings panel: tuning constants (spec section 8, Updates 3-4, 8) plus visual settings (Update 9 §D quality).
import type { Settings } from '../../shared/types.js';
import { api } from './api.js';
import { fmtTime } from './format.js';
import type { Store, UIState } from './state.js';

interface Field { path: string; label: string; hint?: string; min?: number; max?: number; step?: number; type?: 'number' | 'select' | 'checkbox'; options?: string[] }

const SERVER_FIELDS: Field[] = [
  { path: 'horizonSec', label: 'Horizon H_base (s)', hint: 'market seconds that feel like ~20 s of driving; EMAs, lane ages, thresholds derive from it', min: 10, max: 2_419_200, step: 10 },
  { path: 'autoHorizonRoom', label: 'Auto horizon from room', hint: 'H widens as the gap grows, tightens as it shrinks', type: 'checkbox' },
  { path: 'autoHorizonVol', label: 'Auto horizon from volatility', hint: 'quiet tape = longer H', type: 'checkbox' },
  { path: 'horizonExp', label: 'Auto-room exponent', min: 0.25, max: 3, step: 0.05 },
  { path: 'horizonLerpSec', label: 'Horizon lerp (s)', hint: 'how fast H settles', min: 0.5, max: 120, step: 0.5 },
  { path: 'atrRef', label: 'Reference ATR (fraction, 1 m)', hint: 'for auto-from-volatility', min: 0.00001, max: 0.1, step: 0.0001 },
  { path: 'laneLookbacks.0', label: 'Left lane lookback (s at H = 1 m)', hint: 'Update 8: "if Go that long ago"; scaled by H / 60', min: 1, max: 2_419_200, step: 1 },
  { path: 'laneLookbacks.1', label: 'Centre lane lookback (s at H = 1 m)', min: 1, max: 2_419_200, step: 1 },
  { path: 'laneLookbacks.2', label: 'Right lane lookback (s at H = 1 m)', min: 1, max: 2_419_200, step: 1 },
  { path: 'tickMs', label: 'Tick rate (ms)', min: 50, max: 2000, step: 10 },
  { path: 'roadK', label: 'Road speed constant k', hint: 'v_road = max(v_road_min, k · L · ATR_rate)', min: 0, max: 1000, step: 1 },
  { path: 'roadMin', label: 'Minimum road flow', hint: 'the lane dashes always move at least this fast', min: 0, max: 10, step: 0.01 },
  { path: 'slamThreshold', label: 'Slam threshold', hint: 'trend deceleration below −this = the car ahead slams its brakes', min: 0.0001, max: 10, step: 0.005 },
  { path: 'lurchThreshold', label: 'Lurch threshold', hint: '|impulse| above this = your surge / drag jolt', min: 0.0001, max: 10, step: 0.005 },
  { path: 'atrWindow', label: 'ATR window (1m candles)', min: 2, max: 200, step: 1 },
  { path: 'swingLookback', label: 'Swing lookback (candles)', hint: 'hills', min: 10, max: 500, step: 1 },
  { path: 'pedal.gasSizeFrac', label: 'Gas: size added (fraction)', min: 0.01, max: 5, step: 0.01 },
  { path: 'pedal.coastCollateralFrac', label: 'Back off: collateral added (fraction)', min: 0.01, max: 5, step: 0.01 },
  { path: 'pedal.brakeSizeFrac', label: 'Brake: size closed (fraction)', min: 0.01, max: 1, step: 0.01 },
  { path: 'pedal.withdrawFrac', label: 'Withdraw: collateral removed (fraction)', min: 0.01, max: 0.9, step: 0.01 },
  { path: 'pedal.cruiseDistance', label: 'Trailing stop distance', hint: 'in liquidation-distance units (0.5 = half the distance to liq)', min: 0.01, max: 100, step: 0.01 },
  { path: 'paperBankrollUsd', label: 'Practice bankroll (USD)', hint: 'applies when no position is open', min: 10, max: 1e9, step: 10 },
  { path: 'maxSlippageBps', label: 'Max slippage, live orders (bps)', min: 1, max: 5000, step: 1 },
  { path: 'feed', label: 'Price feed', hint: 'auto = Jupiter oracle account (push) + Coinbase trades for animation', type: 'select', options: ['auto', 'doves', 'coinbase', 'hermes', 'jupiter'] },
];

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]] as Record<string, unknown>;
  }
  o[parts[parts.length - 1]] = v;
}

export class SettingsPanel {
  visible = false;
  private inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private pending: Record<string, unknown> = {};
  private timer: number | null = null;
  private lastFeed: string | null = null;

  constructor(private root: HTMLElement, private store: Store) {
    const serverRows = SERVER_FIELDS.map((f) => {
      const id = `set_${f.path.replace(/\./g, '_')}`;
      const input = f.type === 'select'
        ? `<select id="${id}">${(f.options ?? []).map((o) => `<option value="${o}">${o}</option>`).join('')}</select>`
        : f.type === 'checkbox' ? `<input id="${id}" type="checkbox">`
          : `<input id="${id}" type="number" min="${f.min ?? ''}" max="${f.max ?? ''}" step="${f.step ?? 'any'}">`;
      return `<label for="${id}">${f.label}${f.hint ? `<small>${f.hint}</small>` : ''}</label>${input}`;
    }).join('');
    root.innerHTML = `
      <h3>SETTINGS <button class="close" id="setClose">✕</button></h3>
      <h4>HORIZON · LANES · KINEMATICS · PEDALS · FEED (server)</h4>
      <div class="settings-grid">${serverRows}</div>
      <h4>VISUAL (this browser)</h4>
      <div class="settings-grid">
        <label for="vis_renderer">Renderer</label><select id="vis_renderer"><option value="3d">3D freeway</option><option value="2d">2D top-down</option></select>
        <label for="vis_topDown">Top-down in preview (V)<small>bird's-eye before Go; the seat after</small></label><input id="vis_topDown" type="checkbox">
        <label for="vis_poles">Roadside poles<small>the T-shaped lights that scroll at your speed</small></label><input id="vis_poles" type="checkbox">
        <label for="vis_traffic">Other cars<small>the traffic around you; off leaves only you and the car in front</small></label><input id="vis_traffic" type="checkbox">
        <label for="vis_hoverAll">Background hovers<small>road flow, hills, fog, poles and plain traffic; off: only the cars, lines and tags</small></label><input id="vis_hoverAll" type="checkbox">
        <label for="vis_crowd">Crowd<small>the other cars change lanes on real trades: buys right, sells left, big prints cut in; the road is wider</small></label><input id="vis_crowd" type="checkbox">
        <label for="vis_bothSides">Both sides in preview<small>four LONG lanes left, four SHORT lanes right: 5 m · 1 m · 10 s · now</small></label><input id="vis_bothSides" type="checkbox">
        <label for="vis_quality">Quality<small>low = no bloom, 30 fps, pixel ratio 1</small></label><select id="vis_quality"><option value="high">high</option><option value="low">low</option></select>
        <label for="vis_speedScale">Visual speed scale (K_scroll base)<small>road m/s per unit = this × gap scale × 60/H</small></label><input id="vis_speedScale" type="number" min="0.1" max="200" step="0.5">
        <label for="vis_gapScale">Gap scale (K_gap, metres)<small>driver-seat distance to the car ahead at the entry gap</small></label><input id="vis_gapScale" type="number" min="2" max="200" step="1">
        <label for="vis_sound">Sound</label><input id="vis_sound" type="checkbox">
        <label for="vis_volume">Volume</label><input id="vis_volume" type="number" min="0" max="1" step="0.05">
        <label for="vis_music">Race music<small>shuffled playlist while driving</small></label><input id="vis_music" type="checkbox">
        <label for="vis_musicVolume">Music volume</label><input id="vis_musicVolume" type="number" min="0" max="1" step="0.05">
        <label for="vis_effects">Effects intensity<small>FOV, speed streaks, camera pitch and shake</small></label><input id="vis_effects" type="number" min="0" max="1" step="0.1">
        <label for="vis_labelAll">Label every object (L)</label><input id="vis_labelAll" type="checkbox">
        <label for="vis_chartOpen">Bridge chart drawer open (B)</label><input id="vis_chartOpen" type="checkbox">
        <label for="vis_chartHeight">Chart drawer height (px)</label><input id="vis_chartHeight" type="number" min="100" max="600" step="10">
      </div>
      <h4>PRACTICE</h4>
      <div class="ctl-row"><button id="setResetPaper">Reset practice bankroll</button><span style="color:var(--muted);font-size:12px">closes nothing; only when no position is open</span></div>
      <h4>FEED STATUS</h4>
      <div id="feedStatus" class="mono" style="font-size:11px;color:var(--muted);line-height:1.6"></div>
      <p style="color:var(--muted);font-size:11px;margin:12px 0 0">Server settings apply immediately and are kept until the server restarts. Changing the feed restarts the price stream.</p>`;
    root.querySelector('#setClose')!.addEventListener('click', () => this.hide());
    for (const f of SERVER_FIELDS) {
      const id = `set_${f.path.replace(/\./g, '_')}`;
      const el = root.querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement;
      this.inputs.set(f.path, el);
      el.addEventListener('change', () => {
        const v = f.type === 'select' ? el.value : f.type === 'checkbox' ? (el as HTMLInputElement).checked : Number((el as HTMLInputElement).value);
        setPath(this.pending, f.path, v);
        this.flush();
      });
    }
    const vis = (id: string) => root.querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement;
    vis('vis_renderer').addEventListener('change', (e) => this.store.setVisual({ renderer: (e.target as HTMLSelectElement).value as '2d' | '3d' }));
    vis('vis_topDown').addEventListener('change', (e) => this.store.setVisual({ topDown: (e.target as HTMLInputElement).checked }));
    vis('vis_poles').addEventListener('change', (e) => this.store.setVisual({ poles: (e.target as HTMLInputElement).checked }));
    vis('vis_crowd').addEventListener('change', (e) => this.store.setVisual({ crowd: (e.target as HTMLInputElement).checked }));
    vis('vis_traffic').addEventListener('change', (e) => this.store.setVisual({ traffic: (e.target as HTMLInputElement).checked }));
    vis('vis_hoverAll').addEventListener('change', (e) => this.store.setVisual({ hoverAll: (e.target as HTMLInputElement).checked }));
    vis('vis_bothSides').addEventListener('change', (e) => this.store.setVisual({ bothSides: (e.target as HTMLInputElement).checked }));
    vis('vis_quality').addEventListener('change', (e) => this.store.setVisual({ quality: (e.target as HTMLSelectElement).value as 'high' | 'low' }));
    vis('vis_speedScale').addEventListener('change', (e) => this.store.setVisual({ speedScale: Number((e.target as HTMLInputElement).value) || 8 }));
    vis('vis_gapScale').addEventListener('change', (e) => this.store.setVisual({ gapScale: Number((e.target as HTMLInputElement).value) || 60 }));
    vis('vis_sound').addEventListener('change', (e) => this.store.setVisual({ sound: (e.target as HTMLInputElement).checked }));
    vis('vis_volume').addEventListener('change', (e) => this.store.setVisual({ volume: Math.min(1, Math.max(0, Number((e.target as HTMLInputElement).value))) }));
    vis('vis_music').addEventListener('change', (e) => this.store.setVisual({ music: (e.target as HTMLInputElement).checked }));
    vis('vis_musicVolume').addEventListener('change', (e) => this.store.setVisual({ musicVolume: Math.min(1, Math.max(0, Number((e.target as HTMLInputElement).value))) }));
    vis('vis_effects').addEventListener('change', (e) => this.store.setVisual({ effects: Math.min(1, Math.max(0, Number((e.target as HTMLInputElement).value))) }));
    vis('vis_labelAll').addEventListener('change', (e) => this.store.setVisual({ labelAll: (e.target as HTMLInputElement).checked }));
    vis('vis_chartOpen').addEventListener('change', (e) => this.store.setVisual({ chartOpen: (e.target as HTMLInputElement).checked }));
    vis('vis_chartHeight').addEventListener('change', (e) => this.store.setVisual({ chartHeight: Math.min(600, Math.max(100, Number((e.target as HTMLInputElement).value) || 160)) }));
    root.querySelector('#setResetPaper')!.addEventListener('click', () => void api.paperReset().catch(() => undefined));
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(async () => {
      const body = this.pending as Partial<Settings> & Record<string, unknown>;
      this.pending = {};
      // the lane lookbacks are one array: merge the edited entries with the current ones
      const lb = body.laneLookbacks as unknown;
      if (lb && typeof lb === 'object' && !Array.isArray(lb)) {
        const cur = this.store.state.status?.settings.laneLookbacks ?? [300, 60, 10];
        const o = lb as Record<string, number>;
        body.laneLookbacks = [o['0'] ?? cur[0], o['1'] ?? cur[1], o['2'] ?? cur[2]];
      }
      try {
        await api.settings(body);
        if (body.feed && body.feed !== this.lastFeed) await api.feedRestart();
      } catch (e) {
        this.store.pushEvent({ t: Date.now(), kind: 'error', message: (e as Error).message });
      }
    }, 300);
  }

  update(s: UIState): void {
    const st = s.status;
    if (st) {
      for (const [path, el] of this.inputs) {
        if (document.activeElement === el) continue;
        const v = get(st.settings, path);
        if (v === undefined) continue;
        if ((el as HTMLInputElement).type === 'checkbox') (el as HTMLInputElement).checked = !!v;
        else el.value = String(v);
      }
      this.lastFeed = st.settings.feed;
      const f = st.feed;
      const fsEl = this.root.querySelector('#feedStatus');
      if (fsEl) fsEl.textContent = `truth ${f.primary} · secondary ${f.secondary ?? 'none'} · anim ${f.animSource ?? '—'} · now ${f.source}${f.connected ? '' : ' (OFFLINE)'}\n` +
        `basis ${f.oracleBasisBps === null ? 'n/a' : f.oracleBasisBps.toFixed(1) + ' bp'} · offset ${f.offsetBps === null ? 'n/a' : f.offsetBps.toFixed(1) + ' bp'} · ${f.subscriptions} account subscription(s) on one RPC websocket\n` +
        `${f.candles} 1m candles · ${f.historyTicks} ticks (${f.historyFrom ? fmtTime((Date.now() - f.historyFrom) / 1000) : '—'} of history) · last tick ${f.lastTickAgeMs === null ? '—' : (f.lastTickAgeMs / 1000).toFixed(1) + ' s ago'}\n` +
        `horizon now ${fmtTime(st.horizon.h)} (base ${fmtTime(st.horizon.base)})`;
    }
    const v = s.visual;
    const q = (id: string) => this.root.querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement;
    const setIfIdle = (id: string, val: string) => { const el = q(id); if (document.activeElement !== el) el.value = val; };
    setIfIdle('vis_renderer', v.renderer);
    setIfIdle('vis_quality', v.quality);
    setIfIdle('vis_speedScale', String(v.speedScale));
    setIfIdle('vis_gapScale', String(v.gapScale));
    setIfIdle('vis_volume', String(v.volume));
    setIfIdle('vis_musicVolume', String(v.musicVolume));
    setIfIdle('vis_effects', String(v.effects));
    setIfIdle('vis_chartHeight', String(v.chartHeight));
    (q('vis_topDown') as HTMLInputElement).checked = v.topDown;
    (q('vis_poles') as HTMLInputElement).checked = v.poles;
    (q('vis_crowd') as HTMLInputElement).checked = v.crowd;
    (q('vis_traffic') as HTMLInputElement).checked = v.traffic;
    (q('vis_hoverAll') as HTMLInputElement).checked = v.hoverAll;
    (q('vis_bothSides') as HTMLInputElement).checked = v.bothSides;
    (q('vis_sound') as HTMLInputElement).checked = v.sound;
    (q('vis_music') as HTMLInputElement).checked = v.music;
    (q('vis_labelAll') as HTMLInputElement).checked = v.labelAll;
    (q('vis_chartOpen') as HTMLInputElement).checked = v.chartOpen;
  }

  show(): void { this.visible = true; this.root.hidden = false; this.update(this.store.state); }
  hide(): void { this.visible = false; this.root.hidden = true; }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }
}
