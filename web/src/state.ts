import type { CarFrame, Frame, GhostFrame, GhostParams, StatusMsg } from '../../shared/types.js';
import type { HoverHit, Trail } from './renderer.js';

export interface VisualSettings {
  renderer: '2d' | '3d';
  camera: 'chase' | 'driver';
  topDown: boolean;     // Update 8: bird's-eye in PREVIEW (V toggles)
  bothSides: boolean;   // Update 8: LONG lanes left, SHORT lanes right in the preview
  quality: 'high' | 'low'; // Update 9 §D
  speedScale: number;   // K_scroll base: road m/s per cl/s = speedScale × gapScale (× 60/H)
  gapScale: number;     // K_gap: metres per car length
  sound: boolean;
  showHelp: boolean;
  effects: number;      // 0..1 (Update 3)
  volume: number;       // 0..1
  music: boolean;       // race music while driving (web/music/*.mp3)
  musicVolume: number;  // 0..1
  labelAll: boolean;    // Update 5: every labelled object shows a persistent tag
  chartOpen: boolean;   // Update 5/9: bridge chart drawer open
  chartInterval: number;// seconds; 0 = follow the horizon
  chartHeight: number;  // Update 9: drawer height, px
  laneShowAll: boolean; // Update 14: draw every lane; otherwise the focused lane plus the picked ones
  lanesPicked: string[];
  tags: 'on' | 'faded' | 'side' | 'off'; // Update 14: the tags above the cars
  tagsChosen: boolean;  // Update 18: the user picked a tags mode (else the default, side, applies)
  orbit: { dist: number; yaw: number; pitch: number }; // Update 14: the seat camera (metres, radians)
  topZoom: number;      // Update 16: bird's-eye zoom (1 = fit the drawn lanes)
  muted: boolean;       // Update 16: everything silent
  chase: boolean;       // Update 16: CHASE mode: the car in front becomes the monster behind you
  poles: boolean;       // Update 19: the roadside poles that scroll at your speed (off: they read as noise)
  crowd: boolean;       // Update 20: the other cars change lanes on real trades
  mirrorHeight: number; // Update 21: the mirror panel's canvas, px (drag its grip)
  traffic: boolean;     // Update 21: the other cars at all (off: only you and the car in front)
  hoverAll: boolean;    // Update 23: hovers on the road, hills, fog, poles and plain traffic (off: main objects only)
}

export const DEFAULT_VISUAL: VisualSettings = {
  renderer: '3d',
  camera: 'chase',
  topDown: true,
  bothSides: true,
  quality: 'high',
  speedScale: 8,
  gapScale: 60,
  sound: true,
  showHelp: true,
  effects: 1,
  volume: 0.6,
  music: true,
  musicVolume: 0.5,
  labelAll: false,
  chartOpen: true,
  chartInterval: 0,
  chartHeight: 220,
  laneShowAll: false,
  lanesPicked: [],
  tags: 'side',
  tagsChosen: false,
  orbit: { dist: 7, yaw: 0, pitch: 0.26 },
  topZoom: 1,
  muted: false,
  chase: true,
  poles: false,
  crowd: true,
  mirrorHeight: 96,
  traffic: true,
  hoverAll: false,
};

export interface UiEvent { t: number; kind: string; message: string }

export type Screen = 'ghost' | 'drive';

/** One sample of the time-to-liquidation history (Update 10 strip). */
export interface HeadwaySample { t: number; h: number | null; proj: number | null; toLiq: number | null; price: number }

/** Accumulated over one drive for the results popup. */
export interface DriveStats {
  t0: number;
  market: string;
  side: 1 | -1;
  entry: number;
  leverage0: number;
  sizeUsd0: number;
  collateral0: number;
  bankroll0: number | null;
  minHeadway: number;
  redMs: number;
  maxPnl: number;
  minPnl: number;
  maxGap: number;
  minGap: number;
  slams: number;
  frames: number;
  lastT: number;
  lastPnl: number;
  lastFees: number;
  lastPrice: number;
  lastLeverage: number;
  lastSlam: boolean;
  pedals: Record<string, number>;
}

export interface DriveResults {
  stats: DriveStats;
  kind: 'closed' | 'liquidated' | 'stop_hit' | 'fill';
  message: string;
  detail: Record<string, unknown> | null;
  endedAt: number;
}

export interface UIState {
  connected: boolean;
  frame: Frame | null;
  frameAt: number;          // performance.now() when the frame arrived
  price: number | null;
  status: StatusMsg | null;
  screen: Screen;
  visual: VisualSettings;
  events: UiEvent[];
  signing: string | null;   // description of the tx being signed
  waitingFill: boolean;
  /** Ghost params as the panel holds them (pushed to the server). */
  ghosts: GhostParams[];
  primaryGhostId: string;
  /** Time-to-liquidation history of the focus car (real car, else primary ghost), last max(H, 60 s). */
  headwayHistory: HeadwaySample[];
  /** The last ghost frame before Go, used to show the fill jolt. */
  frozenGhost: GhostFrame | null;
  /** Latest animation tick (CEX trade, offset-corrected), Update 3. */
  anim: { t: number; price: number; v: number } | null;
  drive: DriveStats | null;
  results: DriveResults | null;
  // Update 5
  hover: HoverHit | null;
  hoverPinned: boolean;
  highlight: string | null;   // object id highlighted from the chart (two-way hover)
  inspectOpen: boolean;
  // Update 7
  lookBack: boolean;          // Q held: camera swung around
  rewindOpen: boolean;
  // Update 8: where each car in front was over the last H, in dollars to liquidation ('car' = the real car)
  trails: Map<string, Trail>;
  // Update 10: moments the time-to-liquidation was red (posts on the road behind)
  redMoments: number[];
}

type Listener = (s: UIState) => void;

export class Store {
  state: UIState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = {
      connected: false, frame: null, frameAt: 0, price: null, status: null, screen: 'ghost',
      visual: loadVisual(), events: [], signing: null, waitingFill: false,
      ghosts: [], primaryGhostId: 's3', headwayHistory: [], frozenGhost: null, anim: null, drive: null, results: null,
      hover: null, hoverPinned: false, highlight: null, inspectOpen: false, lookBack: false, rewindOpen: false,
      trails: new Map(), redMoments: [],
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(mut: (s: UIState) => void): void {
    mut(this.state);
    for (const fn of this.listeners) fn(this.state);
  }

  setVisual(partial: Partial<VisualSettings>): void {
    this.update((s) => { s.visual = { ...s.visual, ...partial }; });
    try { localStorage.setItem('traffic.visual', JSON.stringify(this.state.visual)); } catch { /* ignore */ }
  }

  pushEvent(ev: UiEvent): void {
    this.update((s) => {
      s.events.push(ev);
      if (s.events.length > 60) s.events.splice(0, s.events.length - 60);
    });
  }
}

function loadVisual(): VisualSettings {
  try {
    const raw = localStorage.getItem('traffic.visual');
    if (raw) {
      const v = { ...DEFAULT_VISUAL, ...(JSON.parse(raw) as Partial<VisualSettings>) };
      if (v.gapScale === 40 && v.speedScale === 12) { v.gapScale = 60; v.speedScale = 8; }
      if (!(v.chartHeight >= 100) || v.chartHeight === 160) v.chartHeight = 220;
      if (!Array.isArray(v.lanesPicked)) v.lanesPicked = [];
      if (!v.orbit || !(v.orbit.dist > 0)) v.orbit = { ...DEFAULT_VISUAL.orbit };
      if (!['on', 'faded', 'side', 'off'].includes(v.tags)) v.tags = 'side';
      if (!v.tagsChosen) v.tags = 'side';
      if (!(v.topZoom > 0)) v.topZoom = 1;
      if (!(v.mirrorHeight >= 48)) v.mirrorHeight = 96;
      // Update 21: every load starts in 3D, in CHASE, with the camera just behind the car
      v.renderer = '3d';
      v.chase = true;
      v.orbit = { ...DEFAULT_VISUAL.orbit };
      return v;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_VISUAL };
}

/** The car the HUD and the alarm follow: the real car, else the primary ghost, else the first ghost. */
export function focusCar(frame: Frame | null, primaryId: string): { car: CarFrame; ghost: GhostFrame | null } | null {
  if (!frame) return null;
  if (frame.car) return { car: frame.car, ghost: null };
  const g = frame.ghosts.find((x) => x.id === primaryId) ?? frame.ghosts.find((x) => x.lane === 3) ?? frame.ghosts.find((x) => x.lane === 1) ?? frame.ghosts[0];
  return g ? { car: g, ghost: g } : null;
}
