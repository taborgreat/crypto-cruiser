// Bird's-eye layout math (Update 8 / 14): pure functions shared by the renderers and the tests. No DOM here.
import type { GhostFrame } from './types.js';

/**
 * Update 8 §2 scale: fit the spread of the gaps so it spans ≥ 25% of the view ahead, zooming in no further
 * than `capPerUsd` (1 px per $0.001). When the farthest car would not fit at that scale the axis breaks:
 * the near region keeps the true scale up to the break, the far region starts at the nearest gap.
 */
export interface TopMap {
  scale: number;        // view units per dollar
  broken: boolean;
  spread: number;       // dollars
  gapMin: number;
  near: number;         // view units: end of the near (true-scale) region
  farStart: number;     // view units: start of the compressed far region
  pad: number;          // dollars below gapMin where the far region begins
  /** Distance ahead (positive view units) for `d` dollars toward liquidation; negative d = behind (true scale). */
  y(dUsd: number): number;
}

export function fitTopScale(gapsUsd: number[], aheadExtent: number, behindExtent: number, capPerUsd: number): TopMap {
  const gaps = gapsUsd.filter((g) => Number.isFinite(g) && g > 0);
  if (!gaps.length) gaps.push(0.01);
  const gMin = Math.min(...gaps), gMax = Math.max(...gaps);
  const spread = gMax - gMin;
  // 1. true scale first: the farthest car in front sits at 70 % of the depth and every distance is in proportion
  //    from my car (Update 14: with one lane drawn this is the whole point; the old rule compressed it)
  let scale = Math.min(capPerUsd, (0.7 * aheadExtent) / gMax);
  let broken = false;
  // 2. only when several lanes are drawn and their differences would be invisible at that scale (under 12 % of the
  //    depth) does the axis break engage: the part of the gap all lanes share is compressed and the spread
  //    between them is stretched to half the depth
  if (gaps.length > 1 && spread > 1e-9 && spread * scale < 0.12 * aheadExtent) {
    scale = Math.min(capPerUsd, (0.5 * aheadExtent) / spread);
    broken = gMax * scale > 0.85 * aheadExtent;
  }
  const near = 0.2 * aheadExtent;
  const farStart = near + 0.06 * aheadExtent;
  const pad = Math.max(spread * 0.2, (0.08 * aheadExtent) / scale);
  const y = (d: number): number => {
    if (d <= 0) return Math.max(-behindExtent, d * scale);
    if (!broken) return Math.min(aheadExtent, d * scale);
    if (d < gMin - pad) return Math.min(near - 0.02 * aheadExtent, d * scale);
    return Math.min(aheadExtent, farStart + (d - (gMin - pad)) * scale);
  };
  return { scale, broken, spread, gapMin: gMin, near, farStart, pad, y };
}

/**
 * Update 14: bird's-eye lanes are packed from the divider outward, LONG on the left and SHORT on the right, so
 * only the drawn lanes take room: with one lane per side the two "now" cars sit side by side at the divider.
 * Returns each ghost's lane index and the number of lanes.
 */
export function packTopLanes(ghosts: GhostFrame[], bothSides: boolean, rewind: boolean): { index: Map<string, number>; lanes: number } {
  const index = new Map<string, number>();
  const longs = ghosts.filter((g) => g.side === 1);
  const shorts = ghosts.filter((g) => g.side === -1);
  if (rewind) {
    const n = Math.max(1, (longs.length ? 1 : 0) + (shorts.length ? 1 : 0));
    for (const g of longs) index.set(g.id, 0);
    for (const g of shorts) index.set(g.id, n - 1);
    return { index, lanes: n };
  }
  if (!bothSides) {
    const list = ghosts.slice().sort((a, b) => a.lane - b.lane); // oldest on the left … now on the right
    list.forEach((g, i) => index.set(g.id, i));
    return { index, lanes: Math.max(1, list.length) };
  }
  const nowFirst = (a: GhostFrame, b: GhostFrame) => b.lane - a.lane; // the now lane sits nearest the divider
  longs.sort(nowFirst);
  shorts.sort(nowFirst);
  const perSide = Math.max(1, longs.length, shorts.length);
  longs.forEach((g, k) => index.set(g.id, perSide - 1 - k));
  shorts.forEach((g, k) => index.set(g.id, perSide + k));
  return { index, lanes: 2 * perSide };
}
