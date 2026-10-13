import './styles.css';
import './mobile.css';
import { headwayColor } from '../../shared/kinematics.js';
import { MARKETS, type Frame, type GhostParams, type RewindLane, type ServerMsg, type SignRequest, type ViewMode } from '../../shared/types.js';
import { Sound } from './audio.js';
import { MUSIC_CREDIT, Music } from './music.js';
import { Pages } from './pages.js';
import type { GhostFrame } from '../../shared/types.js';
import { api } from './api.js';
import { BridgeChart } from './chart.js';
import { installControls } from './controls.js';
import { fmtDuration, fmtHeadway, fmtPct, fmtPrice, fmtSignedUsd, fmtTime, fmtUsd, shortSpan } from './format.js';
import { Labels, Tooltip, tooltipLines, type HoverCtx } from './hover.js';
import { Hud } from './hud.js';
import { ExitsPanel } from './exits.js';
import { InspectPanel } from './inspect.js';
import { Render2D } from './render2d.js';
import { Render3D } from './render3d.js';
import { hitLineId, type HoverHit, type RenderOpts, type Renderer } from './renderer.js';
import { RewindPanel } from './rewind.js';
import { SettingsPanel } from './settings.js';
import { GhostPanel } from './start.js';
import { Store, focusCar, type DriveResults, type DriveStats } from './state.js';
import { connectWs } from './ws.js';
import { connectPhantom, hasPhantom, signTransactionB64 } from './wallet.js';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const store = new Store();
const sound = new Sound();
const musicEl = $('#music');
const music = new Music((t) => { musicEl.innerHTML = `♪ <b>${t.title}</b> · ${MUSIC_CREDIT}`; });
let lastSlam = false;
const app = $('#app');
const viewport = $('#viewport');
const r2d = new Render2D();
const r3d = new Render3D();
r3d.setOrbit(store.state.visual.orbit, true);
r3d.setTopZoom(store.state.visual.topZoom, true);
r3d.ensureSeen();
viewport.appendChild(r2d.el);
viewport.appendChild(r3d.el);
if (!r3d.ok && store.state.visual.renderer === '3d') store.setVisual({ renderer: '2d' });

let userAtMenu = false;     // the user chose the menu even though a position / rewind exists
let helpVisible = false;
let jolt = 0;
let disconnectedSince = 0;
let ghostPushTimer: number | null = null;
let pendingFrame: Frame | null = null;   // latest frame from the socket, applied on the next animation frame (Update 9 §D)
let uiDirty = false;
let lastQuality: 'high' | 'low' | null = null;

// ---------------------------------------------------------------- signing (Phantom)
const modal = $('#modal');
function showModal(html: string): void { modal.innerHTML = `<div class="modal-card">${html}</div>`; modal.hidden = false; }
function hideModal(): void { modal.hidden = true; modal.innerHTML = ''; }

async function handleSign(sign: SignRequest): Promise<boolean> {
  const q = (sign.quote ?? {}) as Record<string, string | number | undefined>;
  const v = (k: string) => (q[k] === undefined ? undefined : String(q[k]));
  const rows: Array<[string, string | undefined]> = [
    ['entry', v('entryPriceUsd') ?? v('averagePriceUsd')], ['liq', v('liquidationPriceUsd')], ['leverage', q.leverage ? `${q.leverage}x` : undefined],
    ['size', q.positionSizeUsd ? fmtUsd(Number(q.positionSizeUsd)) : undefined], ['collateral', v('positionCollateralSizeUsd') ?? v('positionCollateralUsd')],
    ['open fee', v('openFeeUsd')], ['close fee', v('closeFeeUsd')], ['total fee', v('totalFeeUsd')], ['impact', q.priceImpactFeeBps ? `${q.priceImpactFeeBps} bp` : undefined],
    ['pnl after fees', v('pnlAfterFeesUsd')], ['receive', v('transferAmountUsd')],
  ].filter((r) => r[1] !== undefined) as Array<[string, string]>;
  showModal(`<h3>SIGN IN PHANTOM</h3><div>${sign.description}</div>
    <div class="quote">${rows.map(([k, val]) => `<span>${k}</span><b>${val}</b>`).join('')}</div>
    <div id="mWait" style="font-size:12px;color:var(--muted)"><span class="spinner"></span>Waiting for your signature… ${sign.requireKeeperSignature ? "Jupiter's keeper will co-sign and execute." : ''}</div>
    <div class="actions"><button id="mCancel">cancel</button></div>`);
  store.update((s) => { s.signing = sign.description; });
  let cancelled = false;
  modal.querySelector('#mCancel')?.addEventListener('click', () => { cancelled = true; hideModal(); });
  try {
    const signed = await signTransactionB64(sign.txB64);
    if (cancelled) { await api.liveCancel(sign.id); return false; }
    const w = modal.querySelector('#mWait');
    if (w) w.innerHTML = '<span class="spinner"></span>Signed. Handing it to Jupiter…';
    const r = await api.liveExecute(sign.id, signed);
    hideModal();
    if (!r.ok) { toast(r.message, 'err'); return false; }
    toast(`${sign.description} · ${r.message}`, 'good', 7000);
    if (sign.action !== 'cancel-limit-order' && sign.action !== 'create-limit-order') store.update((s) => { s.waitingFill = true; });
    panel.tradesDirty();
    return true;
  } catch (e) {
    hideModal();
    await api.liveCancel(sign.id).catch(() => undefined);
    toast(`Not signed: ${(e as Error).message}`, 'err');
    return false;
  } finally {
    store.update((s) => { s.signing = null; });
  }
}

// ---------------------------------------------------------------- UI pieces
function toast(message: string, cls: '' | 'err' | 'warn' | 'good' = '', ms = 6000): void {
  hud.toast({ t: Date.now(), kind: 'ui', message }, cls, ms);
}

type PedalArg = Parameters<typeof api.pedal>[0];
const CONFIRM_MS = 4000;
let armed: { action: PedalArg; timer: ReturnType<typeof setTimeout> } | null = null;
function disarmPedal(): void {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed = null;
  hud.arm(null);
}
/** Enter (or the same key again) sends the armed REAL pedal. */
function confirmPedal(): boolean {
  if (!armed) return false;
  const a = armed.action;
  disarmPedal();
  void pedalNow(a);
  return true;
}
/**
 * REAL mode (Update 14): every pedal is a real transaction, so the first press only arms it; the same key
 * again, the button again, or Enter within 4 s sends it. Practice sends at once.
 */
async function pedal(action: PedalArg, viaKey = false): Promise<void> {
  if (viaKey && store.state.visual.chase) {
    // CHASE (Update 23): the keys follow the picture: W pulls away (close part), ⇧W and Space escape (close
    // everything), S lets it gain (add size). HARD (add size, no collateral) is a button only in CHASE.
    const m: Partial<Record<PedalArg, PedalArg>> = { gas_light: 'brake_light', gas_hard: 'brake_full', brake_light: 'gas_light', brake_full: 'brake_full' };
    action = m[action] ?? action;
  }
  const live = store.state.status?.engine === 'live';
  if (action !== 'cruise' && action !== 'cruise_off') { // Update 17: in practice too: a stray key must do nothing
    if (armed && armed.action === action) { confirmPedal(); return; }
    disarmPedal();
    armed = { action, timer: setTimeout(() => { armed = null; hud.arm(null); }, CONFIRM_MS) };
    hud.arm(action);
    hud.flash(action);
    sound.click();
    toast(`${live ? 'REAL' : 'PRACTICE'} · ${hud.pedalName(action)} · push again (or Enter) to confirm`, 'warn', CONFIRM_MS);
    return;
  }
  await pedalNow(action);
}

async function pedalNow(action: PedalArg): Promise<void> {
  hud.flash(action);
  sound.click();
  store.update((s) => { if (s.drive) s.drive.pedals[action] = (s.drive.pedals[action] ?? 0) + 1; });
  try {
    const r = await api.pedal(action);
    if (r.sign) { await handleSign(r.sign); return; }
    if (!r.ok) toast(r.message, 'warn');
    else if (r.pending) toast(r.message, 'good', 7000);
    else if (action !== 'gas_light' && action !== 'brake_light') toast(r.message, action === 'withdraw' ? 'warn' : '');
  } catch (e) {
    toast((e as Error).message, 'err');
  }
}

function goDrive(): void {
  userAtMenu = false;
  hud.hideBanner();
  render();
}

function goMenu(): void {
  userAtMenu = true;
  settings.hide();
  rewindPanel.hide();
  inspect.hide();
  exitsPanel.hide();
  render();
}

function pushGhosts(ghosts: GhostParams[], primaryId: string): void {
  store.update((s) => { s.ghosts = ghosts; s.primaryGhostId = primaryId; });
  if (ghostPushTimer) clearTimeout(ghostPushTimer);
  ghostPushTimer = window.setTimeout(() => {
    const attempt = (left: number) => { void api.ghosts(ghosts, primaryId).catch((e: Error) => { if (left > 0) setTimeout(() => attempt(left - 1), 1500); else toast(`lanes: ${e.message}`, 'warn'); }); };
    attempt(3); // Update 18: a server restart drops the lanes; retry quietly instead of a red toast
  }, 120);
}

/** Update 18: REAL only: a sheet that says exactly what is about to be placed, red for short, green for long. */
function confirmReal(g: GhostFrame, extra: { inputToken?: 'SOL' | 'USDC'; inputAmount?: number }): Promise<boolean> {
  const long = g.side === 1;
  const market = store.state.frame?.market ?? 'SOL-PERP';
  const dp = MARKETS[market].priceDp;
  const price = store.state.price ?? g.entry;
  const liqPct = price > 0 ? (Math.abs(price - g.liq) / price) * 100 : 0;
  showModal(`<h3 class="${long ? 'long' : 'short'}">${long ? '▲ LONG' : '▼ SHORT'} · REAL</h3>
    <div class="quote">
      <span>market</span><b>${market}</b>
      <span>paying</span><b>${extra.inputAmount ?? '—'} ${extra.inputToken ?? ''}</b>
      <span>size</span><b>${fmtUsd(g.size_usd, 0)} at ${g.leverage.toFixed(1)}×</b>
      <span>entry</span><b>${g.is_limit && g.proposed_entry ? 'limit ' + fmtPrice(g.proposed_entry, dp) : 'market ~' + fmtPrice(g.entry, dp)}</b>
      <span>liquidation</span><b>${fmtPrice(g.liq, dp)} (${fmtPct(liqPct)} ${long ? 'below' : 'above'})</b>
      <span>fees</span><b>${fmtUsd(g.fees_usd)} open + close</b>
    </div>
    <p class="muted small">Jupiter fills in seconds. Every pedal after this is a real transaction.</p>
    <div class="actions"><button id="goCancel">cancel</button><button id="goConfirm" class="${long ? 'go-long' : 'go-short'}">${long ? '▲ PLACE LONG' : '▼ PLACE SHORT'}</button></div>`);
  return new Promise((resolve) => {
    modal.querySelector('#goCancel')!.addEventListener('click', () => { hideModal(); resolve(false); });
    modal.querySelector('#goConfirm')!.addEventListener('click', () => { hideModal(); resolve(true); });
  });
}

async function go(): Promise<void> {
  const s = store.state;
  if (s.screen !== 'ghost' || !modal.hidden) return;
  if (s.status?.position) { goDrive(); return; }
  const fc = focusCar(s.frame, s.primaryGhostId);
  store.update((x) => { x.frozenGhost = fc?.ghost ?? null; });
  sound.click();
  if (s.status?.engine === 'live' && fc?.ghost) {
    const ok = await confirmReal(fc.ghost, panel.goExtra());
    if (!ok) { panel.setMessage('Not placed.'); return; }
  }
  try {
    const r = await api.go(s.primaryGhostId, panel.goExtra());
    if (r.sign) {
      const ok = await handleSign(r.sign);
      if (ok) {
        panel.setMessage(r.sign.action === 'create-limit-order' ? 'Limit order on Jupiter. The lane keeps driving until it fills.' : 'Sent. Waiting for the keeper to fill…', true);
        if (r.sign.action !== 'create-limit-order') goDrive();
      } else panel.setMessage('Cancelled.');
      return;
    }
    panel.setMessage(r.message, r.ok);
    if (!r.ok) { toast(r.message, 'warn'); return; }
    if (r.pending) store.update((s) => { s.waitingFill = true; });
    panel.tradesDirty();
    if (/limit placed/i.test(r.message)) toast(r.message, 'good');
    else goDrive();
  } catch (e) {
    panel.setMessage((e as Error).message);
  }
}

function dropFlag(): void {
  const f = store.state.frame;
  if (f?.rewind) void api.rewindControl('flag', '').catch((e: Error) => toast(e.message, 'err'));
  else void api.flag().then((r) => toast(`Flag at ${fmtPrice(r.flag.price)}`, 'good', 2500)).catch((e: Error) => toast(e.message, 'err'));
}

const TAG_MODES = ['on', 'faded', 'side', 'off'] as const;
/** Update 14: the tags above the cars cycle on → faded → to the side → off. */
function cycleTags(): void {
  const i = TAG_MODES.indexOf(store.state.visual.tags);
  store.setVisual({ tags: TAG_MODES[(i + 1) % TAG_MODES.length], tagsChosen: true });
}

const hud = new Hud($('#hud'), {
  onPedal: (a) => void pedal(a),
  onSettings: () => settings.toggle(),
  onRewind: () => rewindPanel.toggle(),
  onRenderer: () => store.setVisual({ renderer: store.state.visual.renderer === '3d' ? '2d' : '3d' }),
  onTags: () => cycleTags(),
  onMute: () => store.setVisual({ muted: !store.state.visual.muted }),
  onChase: () => store.setVisual({ chase: !store.state.visual.chase }),
  onTopDown: () => store.setVisual({ topDown: !store.state.visual.topDown }),
  onExit: () => {
    if (store.state.frame?.rewind) void api.rewindControl('stop').catch(() => undefined);
    goMenu();
  },
  onHelp: () => { helpVisible = !helpVisible; hud.setHelp(helpVisible); },
  onInspect: () => inspect.toggle(),
  onChart: () => store.setVisual({ chartOpen: !store.state.visual.chartOpen }),
  onLabels: () => store.setVisual({ labelAll: !store.state.visual.labelAll }),
  onStripClick: (t, price) => { if (!store.state.visual.chartOpen) store.setVisual({ chartOpen: true }); chart.focusTime(t, price); },
  onExits: () => exitsPanel.toggle(),
  onPage: (k) => pages.toggle(k),
  onMirrorHeight: (px) => store.setVisual({ mirrorHeight: px }),
  onHorizon: (sec) => void api.settings(sec === null ? { autoHorizonRoom: true } : { horizonSec: sec, autoHorizonRoom: false }).catch((e: Error) => toast(e.message, 'err')),
});
const exitsEl = document.createElement('div');
exitsEl.className = 'exits-panel';
exitsEl.hidden = true;
$('#hud').appendChild(exitsEl);
const exitsPanel = new ExitsPanel(exitsEl, { getState: () => store.state, toast });
const settings = new SettingsPanel($('#settings'), store);
const inspect = new InspectPanel($('#inspect'));
// Update 17: full pages (trades, conditions) over the stage
const pages = new Pages($('#stage'));
const panel = new GhostPanel($('#start'), {
  store,
  onGhostsChanged: pushGhosts,
  onGo: go,
  onRewind: () => rewindPanel.toggle(),
  onSettings: () => settings.toggle(),
  onResume: goDrive,
  onPage: (k) => pages.toggle(k),
  onCancelOrder: () => void api.cancelOrder().then(async (r) => { if (r.sign) await handleSign(r.sign); else toast(r.message, r.ok ? 'good' : 'warn'); }).catch((e: Error) => toast(e.message, 'err')),
});
const rewindPanel = new RewindPanel($('#rewind'), {
  store,
  getTrade: () => panel.trade(),
  onStarted: () => { userAtMenu = false; render(); },
  toast,
}, hud.stackEl);
const tooltip = new Tooltip($('#tooltip'));
const labels = new Labels($('#labels'));
const chartEl = $('#chart');
const chart = new BridgeChart(chartEl, {
  getState: () => store.state,
  onSetEntry: (price) => panel.setLimit(price),
  onHover: (id) => { store.state.highlight = id; },
  onSeek: (frac) => void api.rewindControl('seek', frac).catch(() => undefined),
  onToggle: (open) => { if (store.state.visual.chartOpen !== open) store.setVisual({ chartOpen: open }); },
  onHeight: (h) => store.setVisual({ chartHeight: h }),
}, store.state.visual.chartHeight, store.state.visual.chartOpen);

function hoverCtx(): HoverCtx | null {
  const s = store.state;
  if (!s.frame) return null;
  return { frame: s.frame, status: s.status, anim: s.anim, primaryGhostId: s.primaryGhostId, priceDp: MARKETS[s.frame.market].priceDp, redMoments: s.redMoments };
}

installControls({
  confirmPedal: () => confirmPedal(),
  notice: (t) => toast(t, 'warn', 2500),
  pedal: (a) => void pedal(a, true),
  go: () => void go(),
  nudgeLimit: (dir) => panel.nudgeLimit(dir),
  toggleInvert: () => { const inv = !(store.state.status?.mode.invert ?? false); void api.mode({ invert: inv }); },
  cycleView: () => {
    const order: ViewMode[] = ['price-only', 'full-dash', 'combined'];
    const cur = store.state.status?.mode.view ?? 'price-only';
    void api.mode({ view: order[(order.indexOf(cur) + 1) % order.length] });
  },
  toggleTopDown: () => store.setVisual({ topDown: !store.state.visual.topDown }),
  setRenderer: (r) => store.setVisual({ renderer: r }),
  toggleChase: () => store.setVisual({ chase: !store.state.visual.chase }),
  toggleSettings: () => settings.toggle(),
  toggleRewind: () => rewindPanel.toggle(),
  toggleHelp: () => { helpVisible = !helpVisible; hud.setHelp(helpVisible); },
  toggleInspect: () => inspect.toggle(),
  toggleLabels: () => store.setVisual({ labelAll: !store.state.visual.labelAll }),
  toggleChart: () => store.setVisual({ chartOpen: !store.state.visual.chartOpen }),
  lookBack: (down) => { if (store.state.lookBack !== down) store.update((s) => { s.lookBack = down; }); },
  flag: dropFlag,
  rewindKey: (k) => rewindPanel.key(k),
  escape: () => { disarmPedal(); if (pages.close()) return;
    if (!modal.hidden) return;
    if (store.state.results) { closeResults(); return; }
    if (helpVisible) { helpVisible = false; hud.setHelp(false); return; }
    if (settings.visible || rewindPanel.visible || inspect.visible || exitsPanel.visible) { settings.hide(); rewindPanel.hide(); inspect.hide(); exitsPanel.hide(); return; }
    if (store.state.hoverPinned) { store.update((s) => { s.hoverPinned = false; s.hover = null; }); tooltip.hide(); return; }
    settings.toggle();
  },
}, () => store.state.screen === 'drive' && !store.state.frame?.rewind, () => store.state.screen === 'ghost' && !store.state.results, () => !!store.state.frame?.rewind);

// ---------------------------------------------------------------- pointer: hover tooltips (Update 5), lane focus (Update 8), drag to scrub the entry
{
  let dragStartY: number | null = null;
  let moved = false;
  let lastPick = 0;
  let dragMode: 'orbit' | 'limit' = 'orbit';
  let dragX = 0;
  let dragY = 0;
  let orbitSave: ReturnType<typeof setTimeout> | null = null;
  const saveOrbit = () => { if (orbitSave) clearTimeout(orbitSave); orbitSave = setTimeout(() => store.setVisual({ orbit: r3d.getOrbit() }), 400); };
  let topSave: ReturnType<typeof setTimeout> | null = null;
  const saveTop = () => { if (topSave) clearTimeout(topSave); topSave = setTimeout(() => store.setVisual({ topZoom: r3d.getTopZoom() }), 400); };
  const setHover = (hit: HoverHit | null) => {
    const s = store.state;
    if (s.hoverPinned) return;
    // Update 23: the road, hills, fog, poles and plain traffic only hover when the setting is on; crowd cars that moved on a real trade always do
    if (hit && !s.visual.hoverAll && (hit.kind === 'road' || hit.kind === 'hill' || hit.kind === 'fog' || hit.kind === 'pole' || (hit.kind === 'traffic' && !hit.text))) hit = null;
    s.hover = hit;
    const ctx = hoverCtx();
    if (hit && hit.kind !== 'text' && ctx) tooltip.show(hit.x, hit.y, tooltipLines(hit, ctx)); else tooltip.hide();
    chart.highlight(hitLineId(hit));
  };
  viewport.addEventListener('pointerdown', (e) => {
    tooltip.hide();
    if (e.button !== 0) return;
    dragStartY = e.clientY; dragX = e.clientX; dragY = e.clientY; moved = false;
    // a plain drag orbits the camera (Update 14); shift-drag scrubs the limit entry in PREVIEW
    dragMode = e.shiftKey && store.state.screen === 'ghost' && !store.state.frame?.rewind ? 'limit' : 'orbit';
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener('pointermove', (e) => {
    const now = performance.now();
    {
      const r = viewport.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) r3d.setLook(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
    }
    if (dragStartY !== null && dragMode === 'orbit') {
      const dx = e.clientX - dragX, dy = e.clientY - dragY;
      if (Math.abs(dx) + Math.abs(dy) >= 3 || moved) {
        moved = true;
        if (store.state.visual.renderer === '3d') { r3d.dragBy(dx, dy); saveOrbit(); }
        dragX = e.clientX; dragY = e.clientY;
        return;
      }
    }
    if (dragStartY !== null && dragMode === 'limit' && store.state.screen === 'ghost' && !store.state.frame?.rewind) {
      const dy = dragStartY - e.clientY;
      if (Math.abs(dy) >= 4 || moved) {
        moved = true;
        const unit = store.state.visual.renderer === '2d' ? r2d.unitPx(store.state.visual.gapScale) : 48;
        panel.scrubTo(dy / unit);
        return;
      }
    }
    if (now - lastPick < 40) return;
    lastPick = now;
    setHover(activeRenderer.pick(e.clientX, e.clientY));
  });
  const end = (e: PointerEvent) => {
    if (dragStartY !== null) { try { viewport.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }
    if (dragStartY !== null && !moved) {
      const hit = activeRenderer.pick(e.clientX, e.clientY);
      const s = store.state;
      // a click on a lane focuses it (Update 8); tooltips are never pinned (Update 11 B5): the inspect drawer is the pinned view
      if (hit && (hit.kind === 'ghost' || hit.kind === 'ghost-ahead' || hit.kind === 'limit' || hit.kind === 'text') && hit.id && s.screen === 'ghost' && !s.frame?.rewind) {
        panel.focusLane(hit.id.split(':')[0]);
      }
    }
    dragStartY = null;
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
  // the wheel zooms the seat camera: out to a high chase, in to first person (Update 14); double-click resets it
  viewport.addEventListener('wheel', (e) => {
    const s = store.state;
    if (s.visual.renderer !== '3d') return;
    const factor = Math.exp(e.deltaY * 0.0012);
    if (s.visual.topDown && !s.frame?.car && !s.waitingFill) { r3d.zoomTopBy(factor); saveTop(); } // Update 16: the bird's-eye zooms too
    else { r3d.zoomBy(factor); saveOrbit(); }
    e.preventDefault();
  }, { passive: false });
  viewport.addEventListener('dblclick', () => { r3d.resetOrbit(); saveOrbit(); });
  viewport.addEventListener('pointerleave', () => { r3d.setLook(0, 0); if (!store.state.hoverPinned) { store.state.hover = null; tooltip.hide(); chart.highlight(null); } });
  // the mirror and the strip: price and time under the pointer (Update 10)
  const mirror = hud.mirrorEl;
  mirror.addEventListener('pointermove', (e) => {
    const r = mirror.getBoundingClientRect();
    const lines = hud.mirrorHover(e.clientX - r.left);
    if (lines) tooltip.show(e.clientX, e.clientY, lines);
  });
  mirror.addEventListener('pointerleave', () => { if (!store.state.hoverPinned) tooltip.hide(); });
  const strip = hud.stripEl;
  strip.addEventListener('pointermove', (e) => { const lines = hud.stripHover(e); if (lines) tooltip.show(e.clientX, e.clientY, lines); });
  strip.addEventListener('pointerleave', () => { if (!store.state.hoverPinned) tooltip.hide(); });
}

// ---------------------------------------------------------------- drive stats + results popup (end of drive)
const resultsEl = document.createElement('div');
resultsEl.id = 'results';
resultsEl.hidden = true;
app.appendChild(resultsEl);

function trackDrive(f: Frame): void {
  const c = f.car;
  const s = store.state;
  if (!c) return;
  const thr = f.horizon.thr;
  let d = s.drive;
  if (!d) {
    d = {
      t0: f.t, market: f.market, side: c.side, entry: c.entry, leverage0: c.leverage, sizeUsd0: c.size_usd, collateral0: c.collateral_usd,
      bankroll0: s.status?.bankrollUsd ?? null, minHeadway: Infinity, redMs: 0, maxPnl: -Infinity, minPnl: Infinity, maxGap: -Infinity, minGap: Infinity,
      slams: 0, frames: 0, lastT: f.t, lastPnl: 0, lastFees: 0, lastPrice: f.price, lastLeverage: c.leverage, lastSlam: false, pedals: {},
    };
    s.drive = d;
  }
  const hw = Math.min(c.headway_s ?? Infinity, c.headway_proj_s ?? Infinity);
  if (hw <= thr.orange) d.redMs += Math.max(0, f.t - d.lastT);
  d.minHeadway = Math.min(d.minHeadway, hw);
  const net = c.pnl_usd - c.fees_usd;
  d.maxPnl = Math.max(d.maxPnl, net);
  d.minPnl = Math.min(d.minPnl, net);
  d.maxGap = Math.max(d.maxGap, c.gap_pct);
  d.minGap = Math.min(d.minGap, c.gap_pct);
  if (c.slam && !d.lastSlam) d.slams++;
  d.lastSlam = c.slam;
  d.frames++;
  d.lastT = f.t;
  d.lastPnl = c.pnl_usd;
  d.lastFees = c.fees_usd;
  d.lastPrice = f.price;
  d.lastLeverage = c.leverage;
}

let liveCloseTimer: ReturnType<typeof setTimeout> | null = null;
function finishDrive(kind: DriveResults['kind'], message: string, detail: unknown): void {
  if (liveCloseTimer) { clearTimeout(liveCloseTimer); liveCloseTimer = null; }
  const s = store.state;
  const d = s.drive;
  if (!d) return;
  const r: DriveResults = { stats: d, kind, message, detail: (detail && typeof detail === 'object' ? detail : null) as Record<string, unknown> | null, endedAt: Date.now() };
  store.update((x) => { x.results = r; x.drive = null; });
  panel.tradesDirty();
  renderResults();
}

function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function renderResults(): void {
  const r = store.state.results;
  if (!r) { resultsEl.hidden = true; return; }
  const d = r.stats;
  const st = store.state.status;
  const det = r.detail ?? {};
  const realized = num(det.realizedUsd) ?? (d.lastPnl - d.lastFees);
  const exit = num(det.price) ?? d.lastPrice;
  const fees = num(det.feesUsd) ?? d.lastFees;
  const returned = num(det.returnedUsd);
  const lifetime = num(det.lifetimeUsd);
  const lost = num(det.lostUsd);
  const pct = d.collateral0 > 0 ? (realized / d.collateral0) * 100 : 0;
  const title = r.kind === 'liquidated' ? 'LIQUIDATED' : r.kind === 'stop_hit' ? 'TRAILING STOP HIT' : realized >= 0 ? 'CLOSED · PROFIT' : 'CLOSED · LOSS';
  const cls = r.kind === 'liquidated' ? 'bad' : realized >= 0 ? 'good' : 'warn';
  const dur = fmtDuration(Math.max(0, d.lastT - d.t0));
  const redPct = d.lastT > d.t0 ? (d.redMs / (d.lastT - d.t0)) * 100 : 0;
  const pedals = Object.entries(d.pedals).map(([k, n]) => `${k.replace('_', ' ')} ×${n}`).join(' · ') || 'none';
  const liveMode = st?.engine === 'live';
  const dp = MARKETS[d.market as keyof typeof MARKETS]?.priceDp ?? 3;
  resultsEl.innerHTML = `<div class="results-card">
    <h2 class="${cls}">${title}</h2>
    <div class="sub">${d.market} ${d.side === 1 ? 'LONG' : 'SHORT'} ${d.leverage0.toFixed(1)}x · ${dur} · entry ${fmtPrice(d.entry, dp)} → exit ${fmtPrice(exit, dp)} · size ${fmtUsd(d.sizeUsd0, 0)}</div>
    <div class="big ${realized >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(realized)}<small>${fmtPct(pct, true)} on collateral · after Jupiter fees</small></div>
    <div class="results-grid">
      <div class="cell"><div class="k">BEST · WORST</div><div class="v">${fmtSignedUsd(Number.isFinite(d.maxPnl) ? d.maxPnl : 0)} / ${fmtSignedUsd(Number.isFinite(d.minPnl) ? d.minPnl : 0)}</div><div class="s">unrealized, after fees</div></div>
      <div class="cell"><div class="k">CLOSEST TO LIQUIDATION</div><div class="v">${fmtHeadway(d.minHeadway)}</div><div class="s">${Number.isFinite(d.minGap) ? fmtPct(d.minGap * 100) : '—'} of price at the closest</div></div>
      <div class="cell"><div class="k">TIME IN RED</div><div class="v">${fmtDuration(d.redMs)}</div><div class="s">${redPct.toFixed(0)}% of the drive · ${d.slams} slam${d.slams === 1 ? '' : 's'}</div></div>
      <div class="cell"><div class="k">JUPITER FEES</div><div class="v">${fmtUsd(fees)}</div><div class="s">close + borrow${lost !== null ? ` · ${fmtUsd(lost)} forfeited` : ''}</div></div>
      <div class="cell"><div class="k">PEDALS</div><div class="v" style="font-size:12px">${pedals}</div><div class="s">${fmtDuration(Math.max(0, d.lastT - d.t0))} on the road</div></div>
    </div>
    <div class="rows">
      ${returned !== null ? `<span>returned to bankroll</span><b>${fmtUsd(returned)}</b>` : ''}
      ${lifetime !== null ? `<span>lifetime on this position</span><b>${fmtSignedUsd(lifetime)}</b>` : ''}
      <span>${liveMode ? 'wallet' : 'bankroll'} now</span><b>${liveMode ? `${st?.wallet.solBalance?.toFixed(4) ?? '—'} SOL` : fmtUsd(st?.bankrollUsd ?? 0)}</b>
      <span>final leverage</span><b>${d.lastLeverage.toFixed(1)}x</b>
      <span>widest margin</span><b>${Number.isFinite(d.maxGap) ? fmtPct(d.maxGap * 100) : '—'} of price</b>
      <span>what happened</span><b>${r.message}</b>
    </div>
    <div class="actions">
      <button id="resRewind">rewind this stretch</button>
      <button id="resBack" class="primary">back to the lane ⏎</button>
    </div>
  </div>`;
  resultsEl.hidden = false;
  resultsEl.querySelector('#resBack')?.addEventListener('click', closeResults);
  resultsEl.querySelector('#resRewind')?.addEventListener('click', () => { closeResults(); rewindPanel.show(); });
}

function renderRewindResults(lanes: RewindLane[], lookbackSec: number): void {
  resultsEl.innerHTML = `<div class="results-card">
    <h2 class="good">REWIND LANDED</h2>
    <div class="sub">the last ${shortSpan(lookbackSec)} with your proposed position held · you are in the lane now</div>
    <div class="rw-results">${lanes.map((l) => `<div class="${l.side === 1 ? 'long' : 'short'}"><b>${l.side === 1 ? 'LONG' : 'SHORT'} ${l.leverage.toFixed(1)}x</b> · liquidated ${l.crashes}× · last ${fmtTime(l.window_sec)}: ${fmtSignedUsd(l.window_pnl_usd)} · trend ${l.trend_word} (${fmtPct(l.trend_pct_per_h, true)}/h)<div class="muted small">${l.readout}</div></div>`).join('')}</div>
    <div class="actions">
      <button id="resAgain">rewind again</button>
      <button id="resBack" class="primary">to the lane ⏎</button>
    </div>
  </div>`;
  resultsEl.hidden = false;
  resultsEl.querySelector('#resBack')?.addEventListener('click', closeResults);
  resultsEl.querySelector('#resAgain')?.addEventListener('click', () => { closeResults(); rewindPanel.show(); });
}

function closeResults(): void {
  store.update((s) => { s.results = null; });
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
  goMenu();
}

// ---------------------------------------------------------------- frames: applied once per animation frame
function applyFrame(f: Frame): void {
  const s = store.state;
  s.frame = f; s.frameAt = performance.now(); s.price = f.price;
  const fc = focusCar(f, s.primaryGhostId);
  // time-to-liquidation history for the strip (last max(H, 60 s), capped at 1 h)
  const spanMs = Math.max(60, Math.min(3600, f.horizon.h)) * 1000 + 2000;
  s.headwayHistory.push({ t: f.t, h: fc?.car.headway_s ?? null, proj: fc?.car.headway_proj_s ?? null, toLiq: fc ? Math.abs(f.price - fc.car.liq) : null, price: f.price });
  while (s.headwayHistory.length && s.headwayHistory[0].t < f.t - spanMs) s.headwayHistory.shift();
  // trails: where each car in front was, in dollars to liquidation, over the last H (Update 8)
  const trailSpan = Math.max(20, f.horizon.h) * 1000;
  const live = new Set<string>();
  const pushTrail = (id: string, liq: number) => {
    live.add(id);
    let tr = s.trails.get(id);
    if (!tr) { tr = []; s.trails.set(id, tr); }
    if (!tr.length || f.t - tr[tr.length - 1][0] >= 400) tr.push([f.t, Math.abs(f.price - liq)]);
    while (tr.length && tr[0][0] < f.t - trailSpan) tr.shift();
    if (tr.length > 300) tr.splice(0, tr.length - 300);
  };
  for (const g of f.ghosts) if (!g.crashed) pushTrail(g.id, g.liq);
  if (f.car) pushTrail('car', f.car.liq);
  for (const id of [...s.trails.keys()]) if (!live.has(id)) s.trails.delete(id);
  if (f.car && s.waitingFill) s.waitingFill = false;
  if (f.car && s.frozenGhost) {
    const g = s.frozenGhost;
    const slipBps = ((f.car.entry - g.entry) / g.entry) * 1e4 * -f.car.side;
    const dp = MARKETS[f.market].priceDp;
    if (Math.abs(slipBps) > 0.5) {
      jolt = 1;
      toast(`Filled at ${fmtPrice(f.car.entry, dp)} · slipped ${fmtUsd(Math.abs(f.car.entry - g.entry))} (${(Math.abs(slipBps) / 100).toFixed(2)}%) ${slipBps > 0 ? 'against you' : 'in your favor'}`, slipBps > 0 ? 'warn' : 'good');
    } else toast(`Filled at ${fmtPrice(f.car.entry, dp)}`, 'good');
    s.frozenGhost = null;
  }
  if (f.car) trackDrive(f);
  else if (s.drive && !s.results && !f.rewind) {
    if (s.status?.engine === 'live') {
      // REAL (Update 14): the server reports the close with Jupiter's own figures a moment later; the frame
      // stats are only the fallback if nothing arrives
      if (!liveCloseTimer) liveCloseTimer = setTimeout(() => {
        liveCloseTimer = null;
        const x = store.state;
        if (x.drive && !x.results) finishDrive('fill', 'Position closed', null);
      }, 15_000);
    } else {
      const d = s.drive;
      s.results = { stats: d, kind: 'fill', message: 'Position closed', detail: null, endedAt: Date.now() };
      s.drive = null;
      setTimeout(renderResults, 0);
    }
  }
}

// ---------------------------------------------------------------- websocket
let lastEventT = 0;
connectWs((m: ServerMsg) => {
  switch (m.type) {
    case 'anim': {
      const prev = store.state.anim;
      store.state.anim = { t: m.t, price: m.price, v: m.v };
      if (m.flow && m.flow.length) r3d.pushFlow(m.flow); // Update 20: the crowd
      // the 1-second guarantee (Update 4): every trade event is an audible tick
      const fc = focusCar(store.state.frame, store.state.primaryGhostId);
      if (fc && prev && m.price !== prev.price && !store.state.results) sound.trade(fc.car.side * (m.price - prev.price) < 0);
      break;
    }
    case 'frame':
      pendingFrame = m.frame;
      break;
    case 'status':
      store.update((s) => {
        s.status = m.status;
        if (m.status.position && s.waitingFill) s.waitingFill = false;
      });
      if (store.state.results) renderResults();
      break;
    case 'event':
      if (m.t <= lastEventT && m.kind !== 'action') break;
      lastEventT = m.t;
      store.pushEvent({ t: m.t, kind: m.kind, message: m.message });
      onEvent(m.kind, m.message, m.detail);
      break;
    default:
      break;
  }
}, (connected) => {
  const was = store.state.connected;
  store.update((s) => { s.connected = connected; });
  if (connected && !was) pushGhosts(panel.params(), panel.primaryId); // Update 18: the server forgot the lanes while it was away
});

function onEvent(kind: string, message: string, detail: unknown): void {
  switch (kind) {
    case 'liquidated':
      sound.thud();
      finishDrive('liquidated', message, detail);
      break;
    case 'closed':
    case 'stop_hit':
      finishDrive(kind, message, detail);
      break;
    case 'sign_request':
      void handleSign(detail as SignRequest);
      break;
    case 'fill':
      toast(message, 'good');
      store.update((s) => { s.waitingFill = false; });
      panel.tradesDirty();
      break;
    case 'order_filled':
      toast(message, 'good');
      panel.tradesDirty();
      goDrive();
      break;
    case 'error':
      toast(message, 'err');
      break;
    case 'warn':
      toast(message, 'warn', 9000);
      if (/No fill seen/.test(message)) store.update((s) => { s.waitingFill = false; });
      break;
    case 'rewind_started':
      toast(message, 'good');
      userAtMenu = false;
      render();
      break;
    case 'rewind_done': {
      const d = detail as { reason?: string; lanes?: RewindLane[] } | null;
      if (d?.reason === 'landed' && d.lanes?.length) renderRewindResults(d.lanes, store.state.frame?.rewind?.lookback_sec ?? 3600);
      else toast(message);
      break;
    }
    case 'flag':
      toast(message, 'good', 2500);
      break;
    case 'tp_hit':
      toast(message, 'good', 8000);
      panel.tradesDirty();
      break;
    case 'sl_hit':
      toast(message, 'warn', 8000);
      panel.tradesDirty();
      break;
    case 'opened':
      toast(message, 'good');
      panel.tradesDirty();
      break;
    case 'tx':
    case 'stop_set':
    case 'order_placed':
    case 'order_cancelled':
    case 'info':
      toast(message, 'good');
      break;
    case 'adjusted':
      toast(message);
      panel.tradesDirty();
      break;
    case 'action':
      toast(message, '', 1500);
      break;
    default:
      toast(message);
  }
}

// ---------------------------------------------------------------- render loop
let activeRenderer: Renderer = store.state.visual.renderer === '3d' && r3d.ok ? r3d : r2d;
function resize(): void {
  chart.applyHeight();
  const w = viewport.clientWidth || window.innerWidth;
  const h = viewport.clientHeight || window.innerHeight;
  r2d.resize(w, h);
  r3d.resize(w, h);
}
new ResizeObserver(resize).observe(viewport);
window.addEventListener('resize', resize);
resize();

let lastT = performance.now();
let lastText = 0;
let lastRender = 0;
let rafId = 0;
/** Update 14: which lanes are drawn: every lane, or the focused one plus the ones ticked in the lane table. */
function laneVisibility(s: typeof store.state): Set<string> {
  const ids = new Set<string>();
  if (s.visual.laneShowAll) { for (const g of s.frame?.ghosts ?? []) ids.add(g.id); return ids; }
  ids.add(s.primaryGhostId);
  for (const id of s.visual.lanesPicked) ids.add(id);
  return ids;
}

function render(): void {
  const s = store.state;
  const st = s.status;
  const hasPosition = !!st?.position;
  const inRewind = !!s.frame?.rewind;
  const shouldDrive = (hasPosition || inRewind || s.waitingFill) && !userAtMenu;
  const screen = shouldDrive ? 'drive' : 'ghost';
  if (screen !== s.screen) store.update((x) => { x.screen = screen; });
  const showPanel = screen === 'ghost' && !s.results && resultsEl.hidden;
  if (showPanel) panel.show(); else panel.hide();
  app.classList.toggle('ghost', showPanel);
  $('#hud').classList.toggle('ghost', screen === 'ghost');
  $('#hud').classList.toggle('rewind', inRewind);
  if (chart.open !== s.visual.chartOpen) chart.setCollapsed(!s.visual.chartOpen);
  const want: Renderer = s.visual.renderer === '3d' && r3d.ok ? r3d : r2d;
  if (want !== activeRenderer) { activeRenderer.setActive(false); activeRenderer = want; }
  activeRenderer.setActive(true);
  if (s.visual.quality !== lastQuality) { lastQuality = s.visual.quality; r3d.setQuality(s.visual.quality); }
}

function loop(now: number): void {
  const s = store.state;
  if (s.visual.quality === 'low' && now - lastRender < 31) { rafId = requestAnimationFrame(loop); return; }
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  lastRender = now;
  if (pendingFrame) { applyFrame(pendingFrame); pendingFrame = null; uiDirty = true; }
  const f = s.frame;
  const thr = f?.horizon.thr ?? { green: 60, yellow: 20, orange: 5, critical: 1 };
  const fc = focusCar(f, s.primaryGhostId);
  const color = fc ? headwayColor(Math.min(fc.car.headway_s ?? Infinity, fc.car.headway_proj_s ?? Infinity), thr) : 'green';
  if (jolt > 0) jolt = Math.max(0, jolt - dt * 1.6);
  const topDown = s.visual.topDown && !f?.car && !s.waitingFill;
  $('#hud').classList.toggle('caught', s.visual.chase && color === 'red' && !!f?.car); // CHASE: it is on you
  $('#hud').classList.toggle('tags-faded', s.visual.tags === 'faded'); // Update 17: the ticker fades with the tags
  const visible = laneVisibility(s);
  chart.visibleLanes = visible;
  const opts: RenderOpts = {
    invert: f?.mode.invert ?? s.status?.mode.invert ?? false,
    view: f?.mode.view ?? s.status?.mode.view ?? 'price-only',
    thresholds: thr,
    speedScale: s.visual.speedScale * (f?.horizon.k_scroll ?? 1),
    gapScale: s.visual.gapScale,
    camera: s.visual.camera,
    topDown,
    bothSides: s.visual.bothSides,
    color,
    price: s.price,
    focus: fc?.car ?? null,
    focusSide: fc?.car.side ?? panel.side,
    primaryGhostId: s.primaryGhostId,
    visible,
    chase: s.visual.chase,
    poles: s.visual.poles,
    crowd: s.visual.crowd,
    traffic: s.visual.traffic,
    jolt,
    effects: s.visual.effects,
    anim: s.anim,
    horizon: f?.horizon ?? null,
    lookBack: s.lookBack,
    highlight: s.highlight,
    tickLerp: f?.horizon.tick_lerp ?? 0.2,
    trails: s.trails,
    redMoments: s.redMoments,
    quality: s.visual.quality,
  };
  const slamNow = !!fc?.car.slam && s.screen === 'drive';
  if (slamNow && !lastSlam) sound.slam();
  lastSlam = slamNow;
  activeRenderer.render(f, dt, opts, now);
  hud.fast(s);
  const ctx = hoverCtx();
  labels.update(activeRenderer.anchors(), ctx, s.visual.labelAll && !topDown, s.visual.tags, viewport.clientWidth, viewport.clientHeight);
  if (now - lastText > 100) {
    lastText = now;
    if (uiDirty) { uiDirty = false; panel.update(s); settings.update(s); render(); }
    // moments the strip was red → posts on the road behind and in the mirror (Update 10)
    const red: number[] = [];
    let lastRed = -Infinity;
    for (const p of s.headwayHistory) {
      const v = Math.min(p.h ?? Infinity, p.proj ?? Infinity);
      if (headwayColor(v, thr) === 'red' && p.t - lastRed > 2000) { red.push(p.t); lastRed = p.t; }
    }
    s.redMoments = red.slice(-64);
    hud.update(s);
    hud.scaleBar(topDown ? activeRenderer.topInfo() : null);
    rewindPanel.update(s);
    exitsPanel.update(s);
    inspect.update(f, s.status, now);
    pages.setContext(s.status, s.ghosts[0]?.leverage ?? s.status?.position?.leverage ?? 100);
    chart.update(f, s.status, s.anim, now);
    sound.enabled = s.visual.sound && !s.visual.muted;
    sound.volume = s.visual.volume;
    // race music only while actually driving (never on the menu, never over the results card); its own widget, never a toast
    const racing = s.screen === 'drive' && !!f?.car && !s.results && !f?.rewind;
    music.update(racing, s.visual.music && !s.visual.muted ? s.visual.musicVolume : 0);
    musicEl.hidden = !(racing && s.visual.music && !s.visual.muted && s.visual.musicVolume > 0);
    const c = fc?.car;
    sound.update({
      active: !!c && !s.results && !(f?.rewind?.paused),
      leverage: c?.leverage ?? 0,
      vYou: c?.v_you ?? 0,
      vRoad: c?.v_road ?? 0,
      headway: c ? Math.min(c.headway_s ?? Infinity, c.headway_proj_s ?? Infinity) : Infinity,
      color,
      impulse: c?.impulse ?? 0,
      driving: !!f?.car,
      chase: s.visual.chase,
      horizonSec: f?.horizon.h ?? 60,
      thresholds: { green: thr.green, orange: thr.orange, critical: thr.critical },
    });
    if (s.waitingFill && !f?.car) hud.statusBanner('wait', 'WAITING FOR KEEPER', 'Jupiter is filling your request…');
    else if (!s.connected) {
      if (!disconnectedSince) disconnectedSince = now;
      if (now - disconnectedSince > 2500) hud.statusBanner('info', 'RECONNECTING', 'Lost the server. Is `npm run dev` running?');
    } else { disconnectedSince = 0; hud.statusBanner(null); }
  }
  rafId = requestAnimationFrame(loop);
}

// hidden tab: pause the render loop and the chart, keep the websocket, resume with a snap (Update 9 §D)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelAnimationFrame(rafId);
  else { lastT = performance.now(); uiDirty = true; rafId = requestAnimationFrame(loop); }
});

store.subscribe((s) => {
  panel.update(s);
  settings.update(s);
  render();
});
rafId = requestAnimationFrame(loop);

void api.status().then(async (st) => {
  store.update((s) => { s.status = st; });
  // always check the wallet on load: a trusted Phantom reconnects silently, and an open position opens the drive
  if (!st.wallet.address && hasPhantom()) {
    try {
      const pk = await connectPhantom(true);
      const r = await api.liveConnect(pk);
      if (r.ok) toast(`Phantom reconnected · ${r.message}`, 'good');
    } catch { /* not trusted yet: the Connect button is in the panel */ }
  }
}).catch(() => undefined);
document.title = 'TRAFFIC';
