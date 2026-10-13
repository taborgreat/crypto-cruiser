// The 2D renderer: a flat top-down canvas. Same frame, same HUD.
// PREVIEW (Update 8): six lanes (LONG left, SHORT right, mirrored), my car in each lane at the bottom, the
// car in front at its true dollar distance on the auto-fit scale (axis break when the far cars would not
// fit), the distance printed between the two cars, the entry line, a trail of where the car in front was.
// LIVE: one lane, the car ahead at the gap in car lengths × gapScale, entry and stop, traffic, posts, flags.
import type { CarFrame, Frame, GhostFrame } from '../../shared/types.js';
import { money, pct, smoney } from '../../shared/format.js';
import {
  HEADWAY_RGB, LANE_COLORS, SIDE_COLORS, animGap, animGapUsd, elevAt, fitTopScale, ghostLane, hash01, highlightMatches, limitDistSec, packTopLanes, trafficCount,
  type HoverHit, type HoverKind, type LabelAnchor, type RenderOpts, type Renderer, type TopInfo, type TopMap,
} from './renderer.js';
import { clamp, fmtHeadway, fmtNum, fmtPrice, lerp } from './format.js';

interface Car { lane: number; y: number; speed: number; color: string }
interface Hit { kind: HoverKind; id?: string; x: number; y: number; w: number; h: number }

const BEHIND_FRAC = 0.9;
const PX_PER_CM = 37.8;

export class Render2D implements Renderer {
  el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 1; private h = 1; private dpr = 1;
  private scroll = 0;
  private aheadY = new Map<string, number>();
  private traffic: Car[] = [];
  private active = false;
  private hits: Hit[] = [];
  private lookT = 0;
  private fitUnit = 0; // Update 27: the drive's auto-fit scale (px per gap unit), 0 = off
  private info: TopInfo | null = null;

  constructor() {
    this.el = document.createElement('canvas');
    this.ctx = this.el.getContext('2d')!;
  }

  setActive(a: boolean): void { this.active = a; this.el.hidden = !a; }

  setLook(): void { /* 2D: fixed camera */ }
  resize(w: number, h: number): void {
    this.w = w; this.h = h;
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.el.width = Math.floor(w * this.dpr);
    this.el.height = Math.floor(h * this.dpr);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
  }

  /** Pixels per car length, used by the scrub interaction. */
  unitPx(gapScale: number): number {
    return gapScale * (this.h / 140);
  }

  pick(x: number, y: number): HoverHit | null {
    const r = this.el.getBoundingClientRect();
    const px = x - r.left, py = y - r.top;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) return { kind: h.kind, id: h.id, x, y };
    }
    return null;
  }

  anchors(): LabelAnchor[] {
    const out: LabelAnchor[] = [];
    for (const h of this.hits) {
      if (h.kind === 'road' || h.kind === 'traffic' || h.kind === 'pole' || h.kind === 'hill' || h.kind === 'fog' || h.kind === 'text') continue;
      out.push({ id: h.id ?? h.kind, kind: h.kind, x: h.x + h.w / 2, y: h.y - 4, visible: h.y > -20 && h.y < this.h + 20 });
    }
    return out;
  }

  topInfo(): TopInfo | null { return this.info; }

  private hit(kind: HoverKind, x: number, y: number, w: number, h: number, id?: string): void {
    this.hits.push({ kind, id, x, y, w, h });
  }

  private ring(x: number, y: number, w: number, h: number, nowMs: number): void {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 160);
    ctx.strokeStyle = `rgba(255,255,255,${0.5 + 0.4 * pulse})`;
    ctx.lineWidth = 2 + pulse;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.roundRect(x - 6, y - 6, w + 12, h + 12, 10);
    ctx.stroke();
  }

  private text(s: string, x: number, y: number, color: string, size = 11, align: CanvasTextAlign = 'center', bold = false): void {
    const ctx = this.ctx;
    ctx.font = `${bold ? 'bold ' : ''}${size}px monospace`;
    ctx.textAlign = align;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    const w = ctx.measureText(s).width + 8;
    const x0 = align === 'center' ? x - w / 2 : align === 'left' ? x - 4 : x - w + 4;
    ctx.fillRect(x0, y - size, w, size + 4);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  render(f: Frame | null, dt: number, o: RenderOpts, nowMs: number): void {
    if (!this.active) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { w, h } = this;
    this.hits = [];
    this.info = null;
    const pxPerM = h / 140;                   // 140 m of road fits the screen height (driver seat)
    let unit = o.gapScale * pxPerM;           // px per car length (gap unit)
    const top = o.topDown && !f?.car;
    // Update 27: V while driving: the scale fits the gap, so the car ahead sits near the top whatever the distance and
    // every inch of closing shows (smoothed so it does not jitter with the tape)
    if (o.topDown && f?.car) {
      const want = clamp((h * 0.72 - 90) / Math.max(0.02, animGap(f.car, f, o.anim)), unit, unit * 60);
      this.fitUnit = this.fitUnit > 0 ? lerp(this.fitUnit, want, clamp(dt / 1.5, 0, 1)) : want;
      unit = this.fitUnit;
    } else this.fitUnit = 0;
    // Update 14: only the drawn lanes take room in the bird's-eye view, packed from the divider outward
    const shown = f ? f.ghosts.filter((g) => f.rewind !== null || o.visible.has(g.id)) : [];
    const pack = packTopLanes(shown, o.bothSides, !!f?.rewind);
    const nLanes = top ? Math.max(2, pack.lanes) : 3;
    let roadW = Math.min(w * (top ? 0.78 : 0.46), top ? 1400 : 520);
    if (top && roadW / nLanes > 170) roadW = 170 * nLanes; // few lanes: keep the lane width sane
    const cx = w / 2 + (o.jolt > 0 ? Math.sin(nowMs / 18) * 6 * o.jolt : 0);
    this.lookT = lerp(this.lookT, o.lookBack && !top ? 1 : 0, clamp(dt * 6, 0, 1));
    const youY = h * lerp(top ? 0.8 : 0.72, 0.3, this.lookT);
    const laneW = roadW / nLanes;
    const laneX = (lane: number) => cx - roadW / 2 + laneW * (lane + 0.5);
    const focus = o.focus;

    ctx.fillStyle = '#06040f';
    ctx.fillRect(0, 0, w, h);

    const hills = f && o.view !== 'price-only' && !top ? f.layers.hills : [];
    const sign = o.invert ? -1 : 1;
    const vRoadVis = focus ? Math.max(1e-6, focus.v_road) * o.gapScale * o.speedScale : 1; // visual m/s
    const secToY = (sec: number) => youY - sec * vRoadVis * pxPerM;

    // road
    ctx.fillStyle = '#141020';
    ctx.fillRect(cx - roadW / 2, 0, roadW, h);
    this.hit('road', cx - roadW / 2, 0, roadW, h);
    if (hills.length && focus) {
      const e0 = elevAt(hills, 0);
      for (let y = 0; y < youY; y += 6) {
        const metres = (youY - y) / pxPerM;
        const sec = metres / vRoadVis;
        const e = sign * (elevAt(hills, sec) - e0);
        const a = clamp(Math.abs(e) / 2, 0, 0.35);
        ctx.fillStyle = e > 0 ? `rgba(255,120,60,${a})` : `rgba(60,180,255,${a})`;
        ctx.fillRect(cx - roadW / 2, y, roadW, 6);
        if (a > 0.1) this.hit('hill', cx - roadW / 2, y, roadW, 6);
      }
    }
    ctx.fillStyle = '#2ee6ff';
    ctx.fillRect(cx - roadW / 2, 0, 3, h);
    ctx.fillRect(cx + roadW / 2 - 3, 0, 3, h);

    // scroll: at YOUR speed in the driver seat, at the flow speed from above
    const vYou = focus ? focus.v_you : 0.1;
    const vYouPx = (top ? Math.max(0.05, focus ? focus.v_road : 0.05) : vYou) * o.gapScale * o.speedScale * pxPerM;
    this.scroll += vYouPx * dt;
    const speedAlpha = top ? 0 : clamp((vYouPx - 40) / 400, 0, 0.5) * o.effects;
    if (speedAlpha > 0.01) {
      ctx.fillStyle = `rgba(191,212,255,${speedAlpha})`;
      const len = clamp(vYouPx * 0.08, 6, 90);
      for (let i = 0; i < 14; i++) {
        const yy = ((this.scroll * 1.3 + i * 97) % (h + 100)) - 50;
        ctx.fillRect(cx - roadW / 2 - 14 - (i % 3) * 9, yy, 2, len);
        ctx.fillRect(cx + roadW / 2 + 12 + (i % 3) * 9, yy, 2, len);
      }
    }
    const dashLen = 34, period = 68;
    const off = ((this.scroll % period) + period) % period;
    for (let lane = 1; lane < nLanes; lane++) {
      const x = cx - roadW / 2 + lane * laneW;
      if (top && o.bothSides && lane === nLanes / 2) {
        ctx.fillStyle = 'rgba(46,230,255,0.9)';
        ctx.fillRect(x - 2, 0, 4, h);
        continue;
      }
      ctx.fillStyle = 'rgba(255,214,240,0.7)';
      for (let y = -period + off; y < h; y += period) ctx.fillRect(x - 2, y, 4, dashLen);
    }
    if (!top) {
      const poleGap = 90;
      const poff = ((this.scroll % poleGap) + poleGap) % poleGap;
      for (let y = -poleGap + poff; y < h; y += poleGap) {
        ctx.fillStyle = 'rgba(46,230,255,0.8)';
        ctx.fillRect(cx - roadW / 2 - 10, y, 4, 4);
        ctx.fillRect(cx + roadW / 2 + 6, y, 4, 4);
        this.hit('pole', cx - roadW / 2 - 12, y - 2, 8, 8);
        this.hit('pole', cx + roadW / 2 + 4, y - 2, 8, 8);
      }
    }

    if (!f || !focus) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(o.price !== null ? `cruising · ${fmtNum(o.price, 3)} · set a lane to start` : 'waiting for price…', cx, h * 0.5);
      this.drawCar(cx, youY, laneW, '#2ee6ff', 0, 0.35);
      this.traffic = [];
      return;
    }

    const flash = o.color === 'red' ? (Math.floor(nowMs / 120) % 2 === 0 ? 1 : 0.25) : 1;
    const dp = f.market === 'BTC-PERP' ? 1 : f.market === 'ETH-PERP' ? 2 : 3;
    const hasCar = !!f.car;

    // ---- PREVIEW: six lanes on the auto-fit dollar scale (Update 8) ----
    if (top) {
      const gaps = shown.filter((g) => !g.crashed).map((g) => animGapUsd(g, f, o.anim));
      const aheadPx = youY - 60, behindPx = (h - youY) * BEHIND_FRAC;
      const map: TopMap = fitTopScale(gaps, aheadPx, behindPx, 1000);
      const usdPerCm = PX_PER_CM / map.scale;
      this.info = { pxPerUsd: map.scale, usdPerCm, pctPerCm: f.price > 0 ? (usdPerCm / f.price) * 100 : 0, broken: map.broken, spreadUsd: map.spread };
      if (map.broken) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 1;
        for (const yy of [youY - map.near, youY - map.farStart]) { ctx.beginPath(); ctx.moveTo(cx - roadW / 2, yy); ctx.lineTo(cx + roadW / 2, yy); ctx.stroke(); }
        ctx.setLineDash([]);
        this.text(`⋯ ${money(map.gapMin - map.pad)} compressed ⋯`, cx, youY - (map.near + map.farStart) / 2 + 4, 'rgba(255,255,255,0.6)', 10);
      }
      const liqYs: number[] = [];
      for (const g of shown) {
        const li = pack.index.get(g.id) ?? 0;
        const x = laneX(li);
        const laneCol = LANE_COLORS[g.lane];
        const sideCol = SIDE_COLORS[g.side];
        const isPrimary = g.id === o.primaryGhostId;
        const gapUsd = g.crashed ? 0 : animGapUsd(g, f, o.anim);
        const aheadTarget = youY - map.y(Math.max(0.0005, gapUsd));
        const prev = this.aheadY.get(g.id);
        const ay = prev === undefined ? aheadTarget : lerp(prev, aheadTarget, clamp(dt / Math.max(0.05, o.tickLerp), 0, 1));
        this.aheadY.set(g.id, ay);
        // trail of where the car in front was over the last H
        const trail = o.trails.get(g.id);
        if (trail && trail.length > 1) {
          ctx.lineWidth = 2;
          for (let i = 1; i < trail.length; i++) {
            const k = i / (trail.length - 1);
            ctx.strokeStyle = `${laneCol}${Math.round(40 + 180 * k).toString(16).padStart(2, '0')}`;
            ctx.beginPath();
            ctx.moveTo(x + laneW * 0.32, youY - map.y(trail[i - 1][1]));
            ctx.lineTo(x + laneW * 0.32, youY - map.y(trail[i][1]));
            ctx.stroke();
          }
        }
        // the car in front with brake glow by trend-against-you
        const brake = clamp(g.brake_ahead + (g.slam ? 1 : 0), 0, 1);
        this.drawCar(x, ay, laneW, '#c23b3b', brake * flash, g.crashed ? 0.5 : 0.95);
        this.hit('ghost-ahead', x - laneW * 0.23, ay - laneW * 0.45, laneW * 0.46, laneW * 0.9, g.id);
        // B4: liq tags in the left margin, one per lane, pushed apart so none sits under a neighbour
        let ly = ay + 4;
        while (liqYs.some((v) => Math.abs(v - ly) < 13)) ly += 13;
        liqYs.push(ly);
        if (nLanes <= 4) this.text(`liq ${fmtPrice(g.liq, dp)} · ${fmtHeadway(g.headway_s)}`, g.side === 1 ? x - laneW * 0.5 - 4 : x + laneW * 0.5 + 4, ay + 4, sideCol, 10, g.side === 1 ? 'right' : 'left');
        else this.text(`liq ${fmtPrice(g.liq, dp)} · ${fmtHeadway(g.headway_s)}`, cx - roadW / 2 - 10, ly, sideCol, 10, 'right');
        if (!g.crashed) this.text(money(gapUsd), x, (ay + youY) / 2, '#e6e4f5', 11);
        // my car with its P&L
        if (g.crashed) {
          const r = 14 + 10 * Math.abs(Math.sin(nowMs / 90));
          ctx.fillStyle = 'rgba(255,140,60,0.55)';
          ctx.beginPath(); ctx.arc(x, ay + laneW * 0.4, r, 0, Math.PI * 2); ctx.fill();
          this.drawCar(x, ay + laneW * 0.55, laneW, sideCol, 0, 0.5, true);
          this.text('LIQUIDATED · respawning', x, youY + laneW * 0.62, '#ff8a3d', 10, 'center', true);
          this.hit('ghost', x - laneW * 0.23, ay + laneW * 0.1, laneW * 0.46, laneW * 0.9, g.id);
        } else {
          this.drawCar(x, youY, laneW, sideCol, 0, 0.95, isPrimary);
          const pnl = g.pnl_usd - g.fees_usd;
          this.text(smoney(pnl), x, youY + laneW * 0.62, pnl >= 0 ? '#35d07f' : '#ff3b3b', 11, 'center', true);
          if (isPrimary) this.text(fmtPrice(f.price, dp), x, youY - laneW * 0.52, '#ffffff', 14, 'center', true);
          this.hit('ghost', x - laneW * 0.23, youY - laneW * 0.45, laneW * 0.46, laneW * 0.9, g.id);
          if (highlightMatches(o.highlight, 'ghost', g.id)) this.ring(x - laneW * 0.23, youY - laneW * 0.45, laneW * 0.46, laneW * 0.9, nowMs);
        }
        // entry line at its true position (behind when in profit), drawn over the car so it never hides behind it
        const dBehind = g.side * (f.price - g.entry);
        const ey = dBehind >= 0 ? youY + Math.min(behindPx - 10, dBehind * map.scale) : youY - map.y(-dBehind);
        ctx.fillStyle = 'rgba(255,210,63,0.95)';
        ctx.fillRect(x - laneW / 2 + 6, ey - 1.5, laneW - 12, 3);
        this.text(`entry ${fmtPrice(g.entry, dp)}`, x + laneW * 0.1, ey - 5, '#ffd23f', 9, 'left');
        if (g.is_limit && g.proposed_entry !== null) {
          const dB = g.side * (f.price - g.proposed_entry);
          const ly = dB >= 0 ? youY + Math.min(behindPx - 10, dB * map.scale) : youY - map.y(-dB);
          ctx.strokeStyle = laneCol;
          ctx.setLineDash([8, 6]);
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x - laneW / 2 + 4, ly); ctx.lineTo(x + laneW / 2 - 4, ly); ctx.stroke();
          ctx.setLineDash([]);
          this.text(`limit ${fmtPrice(g.proposed_entry, dp)}`, x, ly - 6, laneCol, 10);
          this.hit('limit', x - laneW / 2 + 4, ly - 8, laneW - 8, 16, g.id);
        }
        this.hit('text', x - laneW / 2, ay - laneW * 0.5 - 18, laneW, 14, g.id);
      }
      if (o.bothSides && !f.rewind) {
        this.text('LONG', cx - roadW / 4, 16, SIDE_COLORS[1], 11, 'center', true);
        this.text('SHORT', cx + roadW / 4, 16, SIDE_COLORS[-1], 11, 'center', true);
      }
      return;
    }

    // ---- LIVE / driver seat ----
    const want = o.traffic ? trafficCount(f, o.view) : 0;
    while (this.traffic.length < want) {
      const i = this.traffic.length;
      this.traffic.push({ lane: i % 2 === 0 ? 0 : 2, y: hash01(i, 7) * h, speed: 0.8 + hash01(i, 9) * 0.4, color: ['#5e4c85', '#2c6a7a', '#6c3f86', '#7a6a2c'][i % 4] });
    }
    if (this.traffic.length > want) this.traffic.length = want;
    const relPx = (focus.v_road - focus.v_you) * o.gapScale * o.speedScale * pxPerM * dt;
    for (const c of this.traffic) {
      c.y -= relPx * c.speed;
      if (c.y < -60) c.y = h + 40;
      if (c.y > h + 60) c.y = -40;
      this.drawCar(laneX(c.lane), c.y, laneW * 0.8, c.color, 0, 0.6);
      this.hit('traffic', laneX(c.lane) - laneW * 0.2, c.y - laneW * 0.36, laneW * 0.4, laneW * 0.72);
    }

    // the road behind: crash posts, red posts and flags over the last 10 H (Update 7 / 10)
    const b = f.behind;
    if (b) {
      const span = Math.max(1, f.t - b.t_from);
      const yBehind = (t: number) => youY + laneW * 0.6 + clamp((f.t - t) / span, 0, 1) * (h - youY - laneW * 0.6) * BEHIND_FRAC;
      b.crashes.forEach(([t, lane], i) => {
        const y = yBehind(t);
        ctx.fillStyle = LANE_COLORS[lane] ?? '#ff8a3d';
        ctx.fillRect(cx + roadW / 2 + 8, y - 6, 4, 12);
        this.hit('crash', cx + roadW / 2 + 4, y - 9, 12, 16, String(i));
      });
      o.redMoments.forEach((t, i) => {
        if (t < b.t_from) return;
        const y = yBehind(t);
        ctx.fillStyle = '#ff3b3b';
        ctx.fillRect(cx + roadW / 2 + 14, y - 3, 3, 6);
        this.hit('crash', cx + roadW / 2 + 12, y - 5, 8, 10, `r${i}`);
      });
      b.flags.forEach((fl, i) => {
        const y = yBehind(fl.t);
        ctx.fillStyle = '#ffd23f';
        ctx.fillRect(cx - roadW / 2 - 14, y - 10, 2, 20);
        ctx.beginPath(); ctx.moveTo(cx - roadW / 2 - 12, y - 10); ctx.lineTo(cx - roadW / 2 - 2, y - 6); ctx.lineTo(cx - roadW / 2 - 12, y - 2); ctx.closePath(); ctx.fill();
        this.hit('flag', cx - roadW / 2 - 16, y - 12, 16, 24, String(i));
      });
    }

    // ghosts in the driver seat: the focus side's three lanes, no labels (Update 9 A2)
    for (const g of f.ghosts) {
      const lane = ghostLane(g, hasCar);
      if (lane < 0) continue;
      if (f.rewind === null && !o.visible.has(g.id)) continue;
      if (o.bothSides && !f.rewind && g.side !== o.focusSide) continue;
      const x = laneX(lane);
      const col = LANE_COLORS[lane];
      const isPrimary = g.id === o.primaryGhostId && !hasCar;
      const gapVal = g.crashed ? 0 : animGap(g, f, o.anim);
      const aheadY = this.drawCarAhead(g.id, x, youY, laneW, unit, g, gapVal, isPrimary ? o.color : 'green', flash, 0.45, dt, o.tickLerp, 'ghost-ahead', g.id);
      if (g.is_limit && g.proposed_entry !== null) {
        const needed = (-g.side * (g.proposed_entry - f.price) * g.leverage) / f.price;
        const sec = hills.length ? limitDistSec(hills, sign * needed) : null;
        const y = sec !== null ? secToY(sec) : (needed > 0 ? 24 : youY - 10);
        ctx.strokeStyle = col;
        ctx.setLineDash([8, 6]);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - laneW / 2 + 4, y); ctx.lineTo(x + laneW / 2 - 4, y); ctx.stroke();
        ctx.setLineDash([]);
        this.text(`limit ${fmtPrice(g.proposed_entry, dp)}`, x, y - 6, col, 10);
        this.hit('limit', x - laneW / 2 + 4, y - 8, laneW - 8, 16, g.id);
      }
      if (g.crashed) {
        const r = 14 + 10 * Math.abs(Math.sin(nowMs / 90));
        ctx.fillStyle = 'rgba(255,140,60,0.55)';
        ctx.beginPath(); ctx.arc(x, aheadY + laneW * 0.4, r, 0, Math.PI * 2); ctx.fill();
        this.drawCar(x, aheadY + laneW * 0.55, laneW, col, 0, 0.5, true);
        this.hit('ghost', x - laneW * 0.23, aheadY + laneW * 0.1, laneW * 0.46, laneW * 0.9, g.id);
      } else {
        this.drawCar(x, youY, laneW, col, 0, 0.35, true);
        this.hit('ghost', x - laneW * 0.23, youY - laneW * 0.45, laneW * 0.46, laneW * 0.9, g.id);
        if (highlightMatches(o.highlight, 'ghost', g.id)) this.ring(x - laneW * 0.23, youY - laneW * 0.45, laneW * 0.46, laneW * 0.9, nowMs);
      }
    }

    // the real car
    const car = f.car;
    if (car) {
      const entryY = youY + car.entry_dist * unit;
      if (entryY > -20 && entryY < h + 20) {
        ctx.fillStyle = '#ffd23f';
        ctx.fillRect(cx - roadW / 2, entryY - 2, roadW, 4);
        this.text(`entry ${fmtPrice(car.entry, dp)}`, cx + roadW / 2 + 8, entryY + 4, '#ffd23f', 11, 'left');
        this.hit('entry', cx - roadW / 2, entryY - 6, roadW, 12);
        if (highlightMatches(o.highlight, 'entry')) this.ring(cx - roadW / 2, entryY - 4, roadW, 8, nowMs);
      }
      if (car.stop_dist !== null) {
        const sy = youY + car.stop_dist * unit;
        if (sy < h + 40) {
          this.drawCar(cx, sy, laneW, '#4c9bff', 0);
          this.text(`stop ${fmtPrice(car.stop_price ?? 0, dp)}`, cx + laneW * 0.5, sy, '#4c9bff', 10, 'left');
          this.hit('stop', cx - laneW * 0.23, sy - laneW * 0.45, laneW * 0.46, laneW * 0.9);
          if (highlightMatches(o.highlight, 'stop')) this.ring(cx - laneW * 0.23, sy - laneW * 0.45, laneW * 0.46, laneW * 0.9, nowMs);
        }
      }
      // take profit / stop loss lines (Update 12)
      for (const ex of f.exits) {
        const yy = youY + ((car.leverage * car.side * (f.price - ex.price)) / f.price) * unit;
        if (yy < -20 || yy > h + 20) continue;
        const col = ex.kind === 'tp' ? '#35d07f' : '#ff8a3d';
        ctx.strokeStyle = col; ctx.setLineDash([10, 6]); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - roadW / 2 + 4, yy); ctx.lineTo(cx + roadW / 2 - 4, yy); ctx.stroke();
        ctx.setLineDash([]);
        this.text(`${ex.kind.toUpperCase()} ${Math.round(ex.fraction * 100)}% · ${fmtPrice(ex.price, dp)}`, cx + roadW / 2 + 8, yy + 4, col, 11, 'left');
        this.hit('exit', cx - roadW / 2, yy - 6, roadW, 12, ex.id);
      }
      const ay = this.drawCarAhead('car', cx, youY, laneW, unit, car, animGap(car, f, o.anim), o.color, flash, 1, dt, o.tickLerp, 'ahead');
      if (highlightMatches(o.highlight, 'ahead')) this.ring(cx - laneW * 0.23, ay - laneW * 0.45, laneW * 0.46, laneW * 0.9, nowMs);
      this.drawCar(cx, youY, laneW, '#2ee6ff', 0);
      this.text(fmtPrice(f.price, dp), cx, youY - laneW * 0.52, '#ffffff', 14, 'center', true);
      this.hit('you', cx - laneW * 0.23, youY - laneW * 0.45, laneW * 0.46, laneW * 0.9);
      if (highlightMatches(o.highlight, 'you')) this.ring(cx - laneW * 0.23, youY - laneW * 0.45, laneW * 0.46, laneW * 0.9, nowMs);
    }

    // fog overlay from spread + divergence
    if (o.view !== 'price-only') {
      const fogSrc = (f.layers.spread ?? 0) + (f.layers.divergence ?? 0);
      const a = clamp(fogSrc * 1500, 0, 0.55);
      if (a > 0.02) {
        const g = ctx.createLinearGradient(0, 0, 0, youY);
        g.addColorStop(0, `rgba(160,170,190,${a})`);
        g.addColorStop(1, 'rgba(160,170,190,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, youY);
        this.hit('fog', 0, 0, w, youY * 0.25);
      }
    }

    if (f.horizon.clear) {
      ctx.fillStyle = 'rgba(53,208,127,0.05)';
      ctx.fillRect(cx - roadW / 2, 0, roadW, h);
    }

    if (hills.length) {
      const sx = cx + roadW / 2 + 40, sw = 60, sh = youY - 40;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.strokeRect(sx, 20, sw, sh);
      ctx.beginPath();
      const e0 = elevAt(hills, 0);
      for (let i = 0; i < hills.length; i++) {
        const hpt = hills[i];
        const y = 20 + sh - (hpt.dist / hills[hills.length - 1].dist) * sh;
        const x = sx + sw / 2 - clamp(sign * (hpt.elev - e0), -2, 2) * (sw / 4);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#ff8a3d';
      ctx.stroke();
      this.text('HILLS AHEAD', sx + sw / 2, 20 + sh + 14, 'rgba(255,255,255,0.5)', 10);
      this.hit('hill', sx, 20, sw, sh);
    }
  }

  /** Draws the car ahead for one car at the given (animated) gap; returns its screen y. */
  private drawCarAhead(key: string, x: number, youY: number, laneW: number, unit: number, c: CarFrame | GhostFrame, gapVal: number, color: RenderOpts['color'], flash: number, alpha: number, dt: number, tickLerp: number, kind: HoverKind, id?: string): number {
    const ctx = this.ctx;
    const targetY = youY - Math.max(0, gapVal) * unit;
    const prev = this.aheadY.get(key);
    const y = prev === undefined ? targetY : lerp(prev, targetY, clamp(dt / Math.max(0.05, tickLerp), 0, 1));
    this.aheadY.set(key, y);
    const brake = clamp(c.brake_ahead + (c.slam ? 1 : 0), 0, 1);
    if (y < 30) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = HEADWAY_RGB[color];
      ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x - 10, 26); ctx.lineTo(x + 10, 26); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      this.text(`liq ${fmtPrice(c.liq)} · ${fmtNum(c.gap_pct * 100, 2)}% away`, x, 42, '#e6e4f5', 11);
      this.hit(kind, x - 40, 4, 80, 40, id);
    } else {
      this.drawCar(x, y, laneW, '#c23b3b', brake * flash, alpha);
      this.hit(kind, x - laneW * 0.23, y - laneW * 0.45, laneW * 0.46, laneW * 0.9, id);
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = HEADWAY_RGB[color];
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(x + laneW * 0.3, youY - laneW * 0.5); ctx.lineTo(x + laneW * 0.3, Math.max(30, y + laneW * 0.5)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    return y;
  }

  private drawCar(x: number, y: number, laneW: number, color: string, brake: number, alpha = 1, outline = false): void {
    const ctx = this.ctx;
    const cw = Math.min(laneW * 0.46, 44), ch = Math.min(laneW * 0.9, 86);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - cw / 2, y - ch / 2, cw, ch, 6);
    if (outline) {
      ctx.globalAlpha = alpha * 0.5;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x - cw * 0.38, y - ch * 0.2, cw * 0.76, ch * 0.26);
    if (brake > 0) {
      ctx.fillStyle = `rgba(255,40,40,${0.3 + 0.7 * brake})`;
      ctx.shadowColor = 'rgba(255,40,40,0.9)';
      ctx.shadowBlur = 18 * brake;
      ctx.fillRect(x - cw * 0.45, y + ch / 2 - 5, cw * 0.3, 5);
      ctx.fillRect(x + cw * 0.15, y + ch / 2 - 5, cw * 0.3, 5);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }
}
