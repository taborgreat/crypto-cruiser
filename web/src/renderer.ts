import type { HeadwayColor } from '../../shared/kinematics.js';
import type { CarFrame, Frame, GhostFrame, HorizonState, Side, ViewMode } from '../../shared/types.js';

export interface AnimTick { t: number; price: number; v: number }

export type HoverKind = 'you' | 'ahead' | 'entry' | 'stop' | 'ghost' | 'ghost-ahead' | 'road' | 'traffic' | 'pole' | 'hill' | 'fog' | 'flag' | 'crash' | 'limit' | 'text' | 'exit';

/** Something under the pointer (Update 5). `id` is the ghost id for ghost kinds, the flag/crash index otherwise. */
export interface HoverHit { kind: HoverKind; id?: string; x: number; y: number; text?: string }

/** Screen position of a labelled object. With `text` the renderer dictates the label (Update 8 top-down). */
export interface LabelAnchor { id: string; kind: HoverKind; x: number; y: number; visible: boolean; text?: string; cls?: string; align?: 'left' | 'right' | 'center' }

/** Where a car in front was: [t, dollars to liquidation], oldest first. */
export type Trail = Array<[number, number]>;

/** The top-down scale (Update 8): shown on the scale bar so zoom is never ambiguous. */
export interface TopInfo { pxPerUsd: number; usdPerCm: number; pctPerCm: number; broken: boolean; spreadUsd: number }

export interface RenderOpts {
  invert: boolean;
  view: ViewMode;
  thresholds: { green: number; yellow: number; orange: number };
  speedScale: number;     // already multiplied by the horizon's k_scroll
  gapScale: number;       // metres per car length (K_gap)
  camera: 'chase' | 'driver';
  topDown: boolean;       // Update 8: bird's-eye
  bothSides: boolean;     // Update 8: LONG lanes left, SHORT lanes right
  color: HeadwayColor;    // headway color of the focus car
  price: number | null;
  focus: CarFrame | null; // the car the road follows (real car, else primary ghost)
  focusSide: Side;        // the side of the focus car (driver seat shows that side's lanes)
  primaryGhostId: string;
  visible: Set<string>;   // Update 14: the lane ids to draw (focused + picked, or all)
  chase: boolean;         // Update 16: CHASE mode: the car in front is drawn as the monster behind you
  poles: boolean;         // Update 19: draw the roadside poles
  crowd: boolean;         // Update 20: the other cars change lanes on real trades; the road gains a lane each side
  traffic: boolean;       // Update 21: draw the other cars at all
  jolt: number;           // 0..1, decays after a fill with slippage
  effects: number;        // 0..1 intensity of FOV / pitch / shake / streaks (Update 3)
  anim: AnimTick | null;  // latest animation tick (CEX trade, offset-corrected), newer than the frame
  horizon: HorizonState | null;
  lookBack: boolean;      // Q held: swing the camera around (Update 7)
  highlight: string | null; // object id to highlight (two-way hover with the chart)
  tickLerp: number;       // seconds for animated positions to re-sync to truth
  trails: Map<string, Trail>; // Update 8
  redMoments: number[];   // Update 10: timestamps when time-to-liq was red → posts behind
  quality: 'high' | 'low';
}

export interface Renderer {
  /** Mouse look-around in the seat (Update 14): nx, ny in −1..1; the 2D renderer ignores it. */
  setLook(nx: number, ny: number): void;
  el: HTMLElement;
  setActive(active: boolean): void;
  resize(w: number, h: number): void;
  render(frame: Frame | null, dt: number, opts: RenderOpts, nowMs: number): void;
  /** What is under screen point (x, y), if anything. */
  pick(x: number, y: number): HoverHit | null;
  /** Screen anchors of the labelled objects as of the last render. */
  anchors(): LabelAnchor[];
  /** The top-down scale as of the last render (null when not top-down). */
  topInfo(): TopInfo | null;
}

/** Deterministic pseudo-random for stable background traffic. */
export function hash01(i: number, salt = 0): number {
  let x = (i * 374761393 + salt * 668265263) | 0;
  x = (x ^ (x >>> 13)) * 1274126177;
  x = x ^ (x >>> 16);
  return ((x >>> 0) % 100000) / 100000;
}

/** Interpolate the hill profile (dist in seconds ahead) at an arbitrary distance. */
export function elevAt(hills: Array<{ dist: number; elev: number }>, distSec: number): number {
  if (!hills.length) return 0;
  if (distSec <= hills[0].dist) return hills[0].elev;
  for (let i = 1; i < hills.length; i++) {
    if (distSec <= hills[i].dist) {
      const a = hills[i - 1], b = hills[i];
      const t = (distSec - a.dist) / Math.max(1e-9, b.dist - a.dist);
      return a.elev + (b.elev - a.elev) * t;
    }
  }
  return hills[hills.length - 1].elev;
}

/**
 * Where on the road ahead (seconds) the projected price path first reaches the elevation a limit entry
 * needs. Returns null when the projection never gets there (draw the line at the horizon).
 */
export function limitDistSec(hills: Array<{ dist: number; elev: number }>, needed: number): number | null {
  if (hills.length < 2) return null;
  const e0 = hills[0].elev;
  for (let i = 1; i < hills.length; i++) {
    const a = hills[i - 1].elev - e0, b = hills[i].elev - e0;
    if ((needed >= 0 && b >= needed && a < needed) || (needed < 0 && b <= needed && a > needed)) {
      const t = (needed - a) / (b - a || 1e-9);
      return hills[i - 1].dist + (hills[i].dist - hills[i - 1].dist) * Math.min(1, Math.max(0, t));
    }
  }
  return null;
}

/** Traffic density from ATR: 0 in price-only mode, 2..12 cars otherwise (draw-call budget, Update 9). */
export function trafficCount(frame: Frame | null, view: ViewMode): number {
  if (!frame || view === 'price-only') return 0;
  const atr = frame.layers.atr ?? 0.0006;
  return Math.round(Math.min(12, Math.max(2, (atr / 0.0004) * 4)));
}

export const HEADWAY_RGB: Record<HeadwayColor, string> = {
  green: '#35d07f', yellow: '#ffd23f', orange: '#ff8a3d', red: '#ff3b3b',
};

/** Lane tints by lookback (left 5 H, centre H, right H / 6). */
export const LANE_COLORS = ['#b48cff', '#2ee6ff', '#5ee0c8', '#ffffff']; // 5 H · H · H/6 · now (white: this is me)
/** Update 14: lanes per side in PREVIEW; lane 3 is "if Go now". */
export const LANES_PER_SIDE = 4;
export const NOW_LANE = 3;
export const SIDE_COLORS: Record<1 | -1, string> = { 1: '#5ee0c8', [-1]: '#ff3fa4' };

/** Lane assignment in the driver's seat: once the real car exists the ghost lanes fade out (-1 = not drawn). */
export function ghostLane(g: GhostFrame, hasCar: boolean): number {
  return hasCar ? -1 : g.lane;
}

/**
 * Update 8 top-down lane index. Both sides: three LONG lanes on the left (5 H, H, H / 6 from the left),
 * three SHORT lanes mirrored on the right (H / 6, H, 5 H), so the two shortest lookbacks meet at the centre.
 */
export function topLaneIndex(side: Side, lane: number, bothSides: boolean): number {
  if (!bothSides) return lane;
  return side === 1 ? lane : 2 * LANES_PER_SIDE - 1 - lane; // mirrored: the two "now" lanes meet at the divider
}

/**
 * The gap to draw: the frame's animation gap nudged by any newer animation tick (first order in price),
 * so the car ahead keeps moving between frames at trade rate (Update 3).
 */
export function animGap(c: CarFrame, f: Frame, anim: AnimTick | null): number {
  const base = Number.isFinite(c.gap_anim) ? c.gap_anim : c.gap;
  if (!anim || anim.t <= f.t || !(f.price_anim > 0)) return base;
  return base + (c.leverage * c.side * (anim.price - f.price_anim)) / f.price_anim;
}

/** Dollars to liquidation at the animation price (Update 6 units for the top-down view). */
export function animGapUsd(c: CarFrame, f: Frame, anim: AnimTick | null): number {
  const p = anim && anim.t > f.t && f.price_anim > 0 ? anim.price : f.price_anim > 0 ? f.price_anim : f.price;
  return Math.max(0, c.side * (p - c.liq));
}

/** Camera lift with the horizon: 0 at H = 60 s, +1 per decade longer, −1 per decade shorter (clamped). */
export function horizonLift(h: number | null | undefined): number {
  if (!h || !(h > 0)) return 0;
  return Math.min(2, Math.max(-1, Math.log10(h / 60)));
}

export { fitTopScale, packTopLanes } from '../../shared/topscale.js';
export type { TopMap } from '../../shared/topscale.js';

/** The chart price-line id a road object corresponds to (two-way hover, Update 5). */
export function hitLineId(hit: HoverHit | null): string | null {
  if (!hit) return null;
  switch (hit.kind) {
    case 'you': return 'mark';
    case 'ahead': return 'ahead';
    case 'entry': return 'entry';
    case 'stop': return 'stop';
    case 'ghost': case 'ghost-ahead': case 'limit': return hit.id ? `ghost:${hit.id}` : null;
    default: return null;
  }
}

/** Does a highlighted line id refer to this road object? */
export function highlightMatches(hl: string | null, kind: HoverKind, id?: string): boolean {
  if (!hl) return false;
  if (hl === 'mark') return kind === 'you';
  if (hl === 'ahead') return kind === 'ahead';
  if (hl === 'entry') return kind === 'entry';
  if (hl === 'stop') return kind === 'stop';
  if (hl.startsWith('ghost:')) return (kind === 'ghost' || kind === 'ghost-ahead' || kind === 'limit') && hl === `ghost:${id}`;
  return false;
}
