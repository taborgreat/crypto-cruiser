// The 3D freeway, cyberpunk night.
// Driver's seat (LIVE): camera fixed behind-and-above (chase) or in the seat; your car never moves. The road,
// the car ahead, the traffic, the light poles and the skyline move (Update 3). The camera lifts and the FOV
// widens with the horizon; CLEAR brightens the scene (Update 4). Every object is pickable with a screen
// anchor (Update 5). Crash posts, red posts and flags stand on the road behind; Q looks back (Update 7 / 10).
// Bird's-eye (PREVIEW, Update 8): camera straight down, six lanes (LONG left, SHORT right, mirrored), my car
// in each lane at the bottom, the car in front at its true dollar distance on an auto-fit scale (axis break
// when the far cars would not fit), entry lines, trails of where each car in front was over the last H,
// brake glow by trend-against-you. Go swoops the camera into the driver's seat.
// Update 9 §C/§D: bloom only on the cars in front, no pole flares; skyline, poles, posts, flags and streaks
// are instanced or merged; cars are one merged geometry each; pixel ratio capped at 1.5; low quality preset.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MARKETS, type CarFrame, type Frame, type GhostFrame, type Side } from '../../shared/types.js';
import { money, pct, price as fmtPriceRaw, smoney, timeSpan } from '../../shared/format.js';
import {
  HEADWAY_RGB, LANE_COLORS, SIDE_COLORS, animGap, animGapUsd, elevAt, fitTopScale, ghostLane, hash01, highlightMatches, horizonLift,
  limitDistSec, packTopLanes, trafficCount, type HoverHit, type HoverKind, type LabelAnchor, type RenderOpts, type Renderer, type TopInfo, type TopMap,
} from './renderer.js';
import { clamp, lerp } from './format.js';
import type { FlowEvent } from '../../shared/types.js';

const ROAD_W = 11;
const ROAD_LEN = 520;
const ROAD_AHEAD = 440;  // metres ahead of you
const ROAD_SEGS = 260;
const LANE_W = ROAD_W / 3;
const LANE_X3 = [-LANE_W, 0, LANE_W];                            // LIVE: three lanes, my car in the middle
const SEAT_LANES = 4;                                             // PREVIEW (Update 14): 5 H · H · H/6 · now
// orbit camera (Update 14): distance from the point above my car, in metres
const ORBIT_MIN = 0.4;
const ORBIT_MAX = 80;
const ORBIT_FP = 1.6;  // closer than this is first person: my own car is not drawn
const ORBIT_HOME = { dist: 7, yaw: 0, pitch: 0.26 }; // just behind the car
// CHASE (Update 16): the mirror strip, as fractions of the viewport height from the top
const REAR_TOP = 0.14;
// Update 27: height and width are settings (visual.rearH / rearW); the strip stays centred
const DASH_PERIOD = 12;
const ELEV_SCALE = 7;    // metres of road height per car length of "hill"
const STREAKS = 56;
const POLE_GAP = 14;
const POLES = 36;
const CITY = 70;
const CITY_RANGE = 560;
const BEHIND_LEN = 70;   // metres of road behind you carrying the last 10 H (driver seat)
const MAX_POSTS = 64;
const MAX_FLAGS = 16;
const MAX_EXITS = 8;
const TRAIL_PTS = 64;
// top-down: six wide lanes spread across ~70% of the view; the visible depth follows the aspect ratio
const TOP_LANE_W = 5;
const TOP_W = TOP_LANE_W * 2 * SEAT_LANES + 0.8;
const TOP_FOV = 50;
interface TopDims { depth: number; behind: number; ahead: number; camH: number; camZ: number }
const SWOOP_SEC = 1.3;
const PX_PER_CM = 37.8;

const NEON_CYAN = 0x2ee6ff;
const NEON_PINK = 0xff3fa4;
const NEON_PURPLE = 0x8a5cff;

interface TrafficCar {
  model: CarModel; lane: number; z: number; speed: number;
  // Update 20: a lane change in progress (signal, then a slide), cooldowns, a cut-in's road target, the big-print size
  from: number; to: number; changeStart: number; changeDur: number; signalUntil: number; nextAllowed: number; bigUntil: number; leaveAt: number; zTo: number | null; edge: number;
  base: number; // Update 25: the car's own cruising speed (× the flow); `speed` returns to it after a trade moved it
  wallUntil: number; // Update 27: while set, the car is a wall: it holds a few lengths ahead of me and never passes
}
interface CarModel { g: THREE.Group; bodyMat: THREE.MeshStandardMaterial; edgeMat: THREE.LineBasicMaterial; headMat: THREE.MeshBasicMaterial; brakes: THREE.MeshStandardMaterial; bloom: THREE.Sprite[]; glow: THREE.PointLight | null }
interface GhostModel { car: CarModel; ahead: CarModel; monster?: CarModel; line: THREE.Mesh; entry: THREE.Mesh; trail: THREE.Line; trailGeo: THREE.BufferGeometry; aheadZ: number; carZ: number; impact: THREE.Sprite; side: Side; lane: number }

const glowTexCache = new Map<string, THREE.CanvasTexture>();
function glowTexture(color = '255,60,40'): THREE.CanvasTexture {
  const cached = glowTexCache.get(color);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, `rgba(${color},1)`);
  g.addColorStop(0.35, `rgba(${color},0.55)`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  glowTexCache.set(color, t);
  return t;
}

function sunTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#ffd166');
  g.addColorStop(0.45, '#ff5fa2');
  g.addColorStop(1, '#8a2be2');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(128, 128, 124, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  for (let y = 150; y < 256; y += 14 + (y - 150) * 0.12) ctx.fillRect(0, y, 256, 3 + (y - 150) * 0.05);
  return new THREE.CanvasTexture(c);
}

function horizonTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(255,63,164,0)');
  g.addColorStop(0.55, 'rgba(255,63,164,0.25)');
  g.addColorStop(0.85, 'rgba(138,92,255,0.45)');
  g.addColorStop(1, 'rgba(46,230,255,0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  return new THREE.CanvasTexture(c);
}

function windowsTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#07050f';
  ctx.fillRect(0, 0, 64, 64);
  const palette = ['#2ee6ff', '#ff3fa4', '#ffd166', '#8a5cff', '#ffffff'];
  for (let y = 4; y < 60; y += 8) {
    for (let x = 4; x < 60; x += 8) {
      if (Math.random() < 0.42) {
        ctx.fillStyle = palette[Math.floor(Math.random() * palette.length)];
        ctx.globalAlpha = 0.35 + Math.random() * 0.65;
        ctx.fillRect(x, y, 4, 5);
      }
    }
  }
  ctx.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function laneTexture(lanes: number, centerDivider: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#141020';
  ctx.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 1600; i++) {
    const v = 18 + Math.floor(Math.random() * 26);
    ctx.fillStyle = `rgb(${v},${v - 2},${v + 14})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 256, 2, 2);
  }
  ctx.fillStyle = '#2ee6ff';
  ctx.fillRect(4, 0, 6, 256);
  ctx.fillRect(502, 0, 6, 256);
  for (let i = 1; i < lanes; i++) {
    const x = (512 * i) / lanes;
    if (centerDivider && i === lanes / 2) {
      ctx.fillStyle = 'rgba(46,230,255,0.9)';
      ctx.fillRect(x - 3, 0, 6, 256);
    } else {
      ctx.fillStyle = 'rgba(255,214,240,0.85)';
      ctx.fillRect(x - 3, 20, 6, 110);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function colored(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const c = new THREE.Color(color);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

const bodyGeoCache = new Map<number, THREE.BufferGeometry>();
let edgesGeo: THREE.BufferGeometry | null = null;
let headGeo: THREE.BufferGeometry | null = null;
let brakeGeo: THREE.BufferGeometry | null = null;

/** One merged body (body + cabin + wheels, vertex-coloured) per body colour; edges / headlights / brakes shared. */
function carGeometries(color: number): { body: THREE.BufferGeometry; edges: THREE.BufferGeometry; head: THREE.BufferGeometry; brake: THREE.BufferGeometry } {
  let body = bodyGeoCache.get(color);
  if (!body) {
    const parts: THREE.BufferGeometry[] = [];
    parts.push(colored(new THREE.BoxGeometry(1.9, 0.55, 4.4).translate(0, 0.55, 0), color));
    parts.push(colored(new THREE.BoxGeometry(1.6, 0.5, 2.1).translate(0, 1.05, -0.1), 0x0b0818));
    for (const [x, z] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]]) {
      parts.push(colored(new THREE.CylinderGeometry(0.34, 0.34, 0.3, 12).rotateZ(Math.PI / 2).translate(x, 0.34, z), 0x0a0a0f));
    }
    body = mergeGeometries(parts, false)!;
    bodyGeoCache.set(color, body);
  }
  if (!edgesGeo) {
    edgesGeo = mergeGeometries([
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.9, 0.55, 4.4)).translate(0, 0.55, 0),
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.6, 0.5, 2.1)).translate(0, 1.05, -0.1),
    ], false)!;
    headGeo = mergeGeometries([new THREE.BoxGeometry(0.4, 0.14, 0.06).translate(-0.6, 0.6, -2.22), new THREE.BoxGeometry(0.4, 0.14, 0.06).translate(0.6, 0.6, -2.22)], false)!;
    brakeGeo = mergeGeometries([new THREE.BoxGeometry(0.45, 0.18, 0.06).translate(-0.65, 0.62, 2.22), new THREE.BoxGeometry(0.45, 0.18, 0.06).translate(0.65, 0.62, 2.22)], false)!;
  }
  return { body, edges: edgesGeo, head: headGeo!, brake: brakeGeo! };
}

/** A car: 4 draw calls (+2 bloom sprites on the cars in front). */
function makeCar(color: number, opacity: number, edge: number, bloom: boolean, light: boolean): CarModel {
  const geo = carGeometries(color);
  const g = new THREE.Group();
  const transparent = opacity < 1;
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.4, transparent, opacity });
  g.add(new THREE.Mesh(geo.body, bodyMat));
  const edgeMat = new THREE.LineBasicMaterial({ color: edge, transparent: true, opacity: transparent ? 0.9 : 0.85 });
  g.add(new THREE.LineSegments(geo.edges, edgeMat));
  const headMat = new THREE.MeshBasicMaterial({ color: 0xdffbff, transparent, opacity });
  g.add(new THREE.Mesh(geo.head, headMat));
  const brakes = new THREE.MeshStandardMaterial({ color: 0x3a0a0a, emissive: 0xff2020, emissiveIntensity: 0, transparent, opacity });
  g.add(new THREE.Mesh(geo.brake, brakes));
  const sprites: THREE.Sprite[] = [];
  if (bloom) {
    for (const x of [-0.65, 0.65]) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.position.set(x, 0.62, 2.3);
      s.scale.set(0.8, 0.8, 1);
      g.add(s);
      sprites.push(s);
    }
  }
  let glow: THREE.PointLight | null = null;
  if (light) {
    glow = new THREE.PointLight(0xff2020, 0, 16);
    glow.position.set(0, 0.8, 2.6);
    g.add(glow);
  }
  return { g, bodyMat, edgeMat, headMat, brakes, bloom: sprites, glow };
}

/**
 * CHASE (Update 17): the chaser is a police car: white body, a red and blue light bar on the roof (the red half is
 * the "brakes" material, so the trend against you lights it), its own headlights facing you.
 */
function makeMonster(): CarModel {
  const m = makeCar(0xe9ecf5, 1, 0x4c9bff, false, true);
  const red = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.5), m.brakes);
  red.position.set(-0.4, 1.5, 0.1);
  const blueMat = new THREE.MeshStandardMaterial({ color: 0x0a0a3a, emissive: 0x3366ff, emissiveIntensity: 0 });
  const blue = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.5), blueMat);
  blue.position.set(0.4, 1.5, 0.1);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.6), new THREE.MeshStandardMaterial({ color: 0x111118, metalness: 0.6, roughness: 0.4 }));
  bar.position.set(0, 1.37, 0.1);
  m.g.add(bar, red, blue);
  m.g.userData.blueMat = blueMat;
  return m;
}

/** The old monster, kept for reference (not used). */
function makeMonsterSilhouette(): CarModel {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0b0611, metalness: 0.2, roughness: 0.9, emissive: 0x2a0410, emissiveIntensity: 0.6, transparent: true, opacity: 1 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.6, 3.6), bodyMat);
  body.position.set(0, 1.5, 0);
  g.add(body);
  const hump = new THREE.Mesh(new THREE.SphereGeometry(1.7, 10, 8), bodyMat);
  hump.position.set(0, 2.9, 0.4);
  g.add(hump);
  for (const x of [-1.9, 1.9]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.6, 1.2), bodyMat);
    arm.position.set(x, 1.1, -0.6);
    g.add(arm);
  }
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.55 });
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(3.2, 2.6, 3.6)).translate(0, 1.5, 0), edgeMat));
  const headMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 1 });
  const brakes = new THREE.MeshStandardMaterial({ color: 0x3a0a0a, emissive: 0xff2020, emissiveIntensity: 0, transparent: true, opacity: 1 });
  for (const x of [-0.7, 0.7]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), brakes);
    eye.position.set(x, 2.1, -1.85);
    g.add(eye);
  }
  const sprites: THREE.Sprite[] = [];
  for (const x of [-0.7, 0.7]) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.position.set(x, 2.1, -2.0);
    s.scale.set(0.9, 0.9, 1);
    g.add(s);
    sprites.push(s);
  }
  const glow = new THREE.PointLight(0xff2020, 0, 18);
  glow.position.set(0, 2.2, -2.2);
  g.add(glow);
  return { g, bodyMat, edgeMat, headMat, brakes, bloom: sprites, glow };
}

function setOpacity(m: CarModel, o: number): void {
  m.bodyMat.opacity = o; m.headMat.opacity = o; m.brakes.opacity = o;
  m.edgeMat.opacity = Math.min(1, o + 0.4);
}

/** Smooth pseudo-noise in [-1, 1]. */
function noise(t: number, k: number): number {
  return Math.sin(t * 1.7 * k + k) * 0.5 + Math.sin(t * 3.1 * k + 2 * k) * 0.3 + Math.sin(t * 7.3 * k) * 0.2;
}

function tag(obj: THREE.Object3D, kind: HoverKind, id?: string): void {
  obj.userData.kind = kind;
  if (id !== undefined) obj.userData.id = id;
}

const dummy = new THREE.Object3D();
function setInstance(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void {
  dummy.position.set(x, y, z);
  dummy.scale.set(sx, sy, sz);
  dummy.rotation.set(0, 0, 0);
  dummy.updateMatrix();
  mesh.setMatrixAt(i, dummy.matrix);
}

function smoothstep(x: number): number { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); }

export class Render3D implements Renderer {
  el: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
  private hemi!: THREE.HemisphereLight;
  private road!: THREE.Mesh;
  private roadGeo!: THREE.PlaneGeometry;
  private roadBaseY!: Float32Array;
  private laneTex!: THREE.CanvasTexture;
  /** Seat camera x: behind the focused lane in PREVIEW, the centre in LIVE. */
  private camX = 0;
  private previewLin = 0;
  /** Orbit camera (Update 14): smoothed and target. yaw/pitch in radians; pitch is the elevation. */
  private orbit = { ...ORBIT_HOME };
  private orbitTarget = { ...ORBIT_HOME };
  /** Bird's-eye zoom (Update 16): 1 = the drawn lanes fit; smoothed and target. */
  private topZoom = 1;
  private topZoomTarget = 1;
  /** Update 18: the seat draws the drawn lanes, packed like the bird's-eye; the road is that many lanes wide. */
  private seatLanes = 4;
  private laneTexN = new Map<number, THREE.CanvasTexture>();
  /** Update 20: real trades waiting to move a car, and the field's change budget. */
  private flowQueue: FlowEvent[] = [];
  private nextChangeAt = 0;
  private topRoad!: THREE.Mesh;
  private topTex!: THREE.CanvasTexture;
  private breakA!: THREE.Mesh;
  private breakB!: THREE.Mesh;
  private you!: CarModel;
  private ahead!: CarModel;
  private entryLine!: THREE.Mesh;
  private stopCar!: CarModel;
  /** CHASE (Update 16): the monster behind you, the rear camera for the mirror strip, the wall that is the stop. */
  private monster!: CarModel;
  private rearCam = new THREE.PerspectiveCamera(48, 1, 0.3, 2000);
  private wall!: THREE.Mesh;
  private ring!: THREE.Mesh;
  private exitMarks: THREE.Mesh[] = [];
  private traffic: TrafficCar[] = [];
  private ghosts = new Map<string, GhostModel>();
  private streaks!: THREE.InstancedMesh;
  private streakZ = new Float32Array(STREAKS);
  private streakMat!: THREE.MeshBasicMaterial;
  private poles!: THREE.InstancedMesh;
  private cityA!: THREE.Mesh;
  private cityB!: THREE.Mesh;
  private posts!: THREE.InstancedMesh;
  private flags!: THREE.InstancedMesh;
  private grid!: THREE.GridHelper;
  private fog = new THREE.FogExp2(0x07050f, 0.0028);
  private raycaster = new THREE.Raycaster();
  private pickables: THREE.Object3D[] = [];
  private anchorList: LabelAnchor[] = [];
  private topInfoCur: TopInfo | null = null;
  private width = 1;
  private height = 1;
  private rearH = 0.32;
  private rearW = 0.4;
  private rearShown = false; // Update 27: the mirror strip was drawn this frame, so it can be hovered
  private scroll = 0;
  private topScroll = 0;
  private poleScroll = 0;
  private aheadZ = -30;
  private active = false;
  private failed = false;
  private fov = 60;
  private pitch = 0;
  private prevVYou: number | null = null;
  private accel = 0;
  private slamUntil = 0;
  private lastLurch = 0;
  private kick = 0;
  /** Mouse look-around (Update 14): target and smoothed, −1..1. */
  private lookTx = 0;
  private lookTy = 0;
  private lookX = 0;
  private lookY = 0;
  private lookT = 0;
  private clearT = 0;
  private topLin = 1;
  private lowQ = false;

  constructor() {
    this.el = document.createElement('div');
    try {
      // Update 27: phones (Phantom's in-app browser among them) refuse the high-performance context now and then;
      // try the plain one before giving up and falling back to 2D
      try { this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); }
      catch { this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'default' }); }
      this.renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
      this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;
      this.el.appendChild(this.renderer.domElement);
    } catch {
      this.failed = true;
      this.el.innerHTML = '<div style="padding:20px;color:#f88">WebGL unavailable; use the 2D renderer (key 2).</div>';
      return;
    }
    this.build();
  }

  get ok(): boolean { return !this.failed; }

  setQuality(q: 'high' | 'low'): void {
    this.lowQ = q === 'low';
    this.renderer?.setPixelRatio(this.lowQ ? 1 : Math.min(1.5, window.devicePixelRatio || 1));
  }

  /** Draw calls of the last frame (Update 9 budget: < 300). */
  get drawCalls(): number { return this.renderer?.info.render.calls ?? 0; }

  private build(): void {
    const s = this.scene;
    s.background = new THREE.Color(0x06040f);
    s.fog = this.fog;
    this.hemi = new THREE.HemisphereLight(0x5a3cff, 0x0a0616, 0.85);
    s.add(this.hemi);
    const rim = new THREE.DirectionalLight(0xff4fd8, 0.7);
    rim.position.set(-40, 30, 60);
    s.add(rim);
    const key = new THREE.DirectionalLight(0x2ee6ff, 0.55);
    key.position.set(50, 40, -80);
    s.add(key);

    // sky: stars, horizon glow, synthwave sun
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(700 * 3);
    for (let i = 0; i < 700; i++) {
      const a = (hash01(i, 21) - 0.5) * Math.PI * 1.6;
      const e = 0.06 + hash01(i, 23) * 0.8;
      const r = 1000;
      starPos[i * 3] = Math.sin(a) * Math.cos(e) * r;
      starPos[i * 3 + 1] = Math.sin(e) * r;
      starPos[i * 3 + 2] = -Math.cos(a) * Math.cos(e) * r;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    s.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.8, fog: false })));
    const horizon = new THREE.Mesh(new THREE.PlaneGeometry(2400, 320), new THREE.MeshBasicMaterial({ map: horizonTexture(), transparent: true, depthWrite: false, fog: false }));
    horizon.position.set(0, 150, -980);
    s.add(horizon);
    const sun = new THREE.Mesh(new THREE.CircleGeometry(1, 56), new THREE.MeshBasicMaterial({ map: sunTexture(), transparent: true, depthWrite: false, fog: false }));
    sun.position.set(0, 96, -960);
    sun.scale.set(150, 150, 1);
    s.add(sun);

    // ground + synthwave grid
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ color: 0x07050f, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    s.add(ground);
    this.grid = new THREE.GridHelper(1600, 100, NEON_PINK, 0x3a1860);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.32;
    this.grid.position.y = -0.03;
    s.add(this.grid);

    // skyline: all buildings merged into one geometry (windows = one repeating texture), two copies for the wrap
    const winTex = windowsTexture();
    const blocks: THREE.BufferGeometry[] = [];
    for (let i = 0; i < CITY; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const w = 6 + hash01(i, 31) * 14, h = 8 + hash01(i, 33) * 46, d = 8 + hash01(i, 35) * 14;
      const geo = new THREE.BoxGeometry(w, h, d);
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * (w / 5), uv.getY(k) * (h / 5));
      geo.translate(side * (26 + hash01(i, 37) * 110), h / 2 - 0.1, -hash01(i, 39) * CITY_RANGE);
      blocks.push(geo);
    }
    const cityGeo = mergeGeometries(blocks, false)!;
    const cityMat = new THREE.MeshStandardMaterial({ color: 0x0c0918, roughness: 0.9, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: 0.9 });
    this.cityA = new THREE.Mesh(cityGeo, cityMat);
    this.cityB = new THREE.Mesh(cityGeo, cityMat);
    s.add(this.cityA, this.cityB);

    // light poles: one instanced mesh, no flares (Update 9 §C)
    this.poles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 2.6, 0.12).translate(0, 1.3, 0), new THREE.MeshBasicMaterial({ color: 0x1b5f6a }), POLES * 2);
    tag(this.poles, 'pole');
    s.add(this.poles);
    this.pickables.push(this.poles);

    // road (driver seat)
    this.laneTex = laneTexture(3, false);
    this.laneTex.repeat.set(1, ROAD_LEN / DASH_PERIOD);
    this.roadGeo = new THREE.PlaneGeometry(ROAD_W, ROAD_LEN, 1, ROAD_SEGS);
    this.roadGeo.rotateX(-Math.PI / 2);
    this.roadGeo.translate(0, 0, -(ROAD_AHEAD - ROAD_LEN / 2));
    this.roadBaseY = new Float32Array(this.roadGeo.attributes.position.array as Float32Array);
    this.road = new THREE.Mesh(this.roadGeo, new THREE.MeshStandardMaterial({ map: this.laneTex, roughness: 0.55, metalness: 0.25 }));
    tag(this.road, 'road');
    s.add(this.road);
    this.pickables.push(this.road);

    // road (top-down): six lanes, LONG left of the centre divider, SHORT right
    this.topTex = laneTexture(2 * SEAT_LANES, true);
    const topLen = 240;
    this.topTex.repeat.set(1, topLen / DASH_PERIOD);
    const topGeo = new THREE.PlaneGeometry(TOP_W, topLen);
    topGeo.rotateX(-Math.PI / 2);
    topGeo.translate(0, 0.01, -(topLen / 2 - 24));
    this.topRoad = new THREE.Mesh(topGeo, new THREE.MeshStandardMaterial({ map: this.topTex, roughness: 0.9, metalness: 0, emissive: 0xffffff, emissiveMap: this.topTex, emissiveIntensity: 0.55 }));
    tag(this.topRoad, 'road');
    this.topRoad.visible = false;
    s.add(this.topRoad);
    this.pickables.push(this.topRoad);
    const breakMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 });
    this.breakA = new THREE.Mesh(new THREE.PlaneGeometry(TOP_W, 0.25), breakMat);
    this.breakA.rotation.x = -Math.PI / 2;
    this.breakB = new THREE.Mesh(new THREE.PlaneGeometry(TOP_W, 0.25), breakMat);
    this.breakB.rotation.x = -Math.PI / 2;
    this.breakA.visible = this.breakB.visible = false;
    s.add(this.breakA, this.breakB);

    this.you = makeCar(0x1b2a44, 1, NEON_CYAN, false, false);
    tag(this.you.g, 'you');
    s.add(this.you.g);
    this.pickables.push(this.you.g);
    this.ahead = makeCar(0x3a0d16, 1, 0xff3b3b, true, true);
    tag(this.ahead.g, 'ahead');
    s.add(this.ahead.g);
    this.pickables.push(this.ahead.g);
    this.monster = makeMonster();
    tag(this.monster.g, 'ahead');
    this.monster.g.visible = false;
    s.add(this.monster.g);
    this.pickables.push(this.monster.g);
    this.wall = new THREE.Mesh(new THREE.BoxGeometry(ROAD_W + 2, 2.4, 0.5), new THREE.MeshStandardMaterial({ color: 0x1d2a40, emissive: 0x4c9bff, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }));
    this.wall.position.y = 1.2;
    tag(this.wall, 'stop');
    this.wall.visible = false;
    s.add(this.wall);

    this.entryLine = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, 0.6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })); // Update 19: a white line on the road, under the car
    this.entryLine.renderOrder = 5;
    this.entryLine.rotation.x = -Math.PI / 2;
    this.entryLine.position.y = 0.02;
    tag(this.entryLine, 'entry');
    s.add(this.entryLine);
    this.pickables.push(this.entryLine);

    this.stopCar = makeCar(0x1d2a40, 1, 0x4c9bff, false, false);
    tag(this.stopCar.g, 'stop');
    s.add(this.stopCar.g);
    this.pickables.push(this.stopCar.g);

    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.4, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    s.add(this.ring);
    // take profit / stop loss markers (Update 12)
    for (let i = 0; i < MAX_EXITS; i++) {
      const mk = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W * 0.8, 0.5), new THREE.MeshBasicMaterial({ color: 0x35d07f, transparent: true, opacity: 0.9, depthTest: false }));
      mk.rotation.x = -Math.PI / 2;
      mk.renderOrder = 5;
      mk.visible = false;
      tag(mk, 'exit');
      s.add(mk);
      this.exitMarks.push(mk);
      this.pickables.push(mk);
    }

    // posts (crashes in lane colour, red moments in red) and flags on the road behind: instanced
    const postGeo = mergeGeometries([new THREE.BoxGeometry(0.22, 1.3, 0.22).translate(0, 0.65, 0), new THREE.BoxGeometry(0.5, 0.2, 0.5).translate(0, 1.4, 0)], false)!;
    this.posts = new THREE.InstancedMesh(postGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_POSTS);
    this.posts.count = 0;
    tag(this.posts, 'crash');
    s.add(this.posts);
    this.pickables.push(this.posts);
    const flagGeo = mergeGeometries([new THREE.BoxGeometry(0.1, 2.4, 0.1).translate(0, 1.2, 0), new THREE.PlaneGeometry(1.2, 0.7).translate(0.65, 2.0, 0)], false)!;
    this.flags = new THREE.InstancedMesh(flagGeo, new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide }), MAX_FLAGS);
    this.flags.count = 0;
    tag(this.flags, 'flag');
    s.add(this.flags);
    this.pickables.push(this.flags);

    // speed streaks: instanced
    this.streakMat = new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.streaks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.05, 1), this.streakMat, STREAKS);
    for (let i = 0; i < STREAKS; i++) this.streakZ[i] = -hash01(i, 17) * 140;
    s.add(this.streaks);
  }

  setActive(a: boolean): void {
    this.active = a;
    this.el.hidden = !a;
  }

  getOrbit(): { dist: number; yaw: number; pitch: number } { return { ...this.orbitTarget }; }
  setOrbit(o: Partial<{ dist: number; yaw: number; pitch: number }>, snap = false): void {
    Object.assign(this.orbitTarget, o);
    this.orbitTarget.dist = clamp(this.orbitTarget.dist, ORBIT_MIN, ORBIT_MAX);
    this.orbitTarget.pitch = clamp(this.orbitTarget.pitch, 0.03, 1.45);
    if (snap) Object.assign(this.orbit, this.orbitTarget);
  }
  /** Wheel: factor > 1 zooms out (a higher, farther chase), < 1 zooms in, down to first person. */
  zoomBy(factor: number): void { this.setOrbit({ dist: this.orbitTarget.dist * factor }); }
  /** Drag: right moves the camera round to the right, up raises it. */
  dragBy(dxPx: number, dyPx: number): void { this.setOrbit({ yaw: this.orbitTarget.yaw + dxPx * 0.006, pitch: this.orbitTarget.pitch - dyPx * 0.006 }); }
  firstPerson(): boolean { return this.orbitTarget.dist < ORBIT_FP; }
  toggleFirstPerson(): void { this.setOrbit(this.firstPerson() ? { dist: ORBIT_HOME.dist, pitch: ORBIT_HOME.pitch } : { dist: ORBIT_MIN }); }
  /** Update 21: a sanity floor: a saved orbit never loads us inside the car. */
  ensureSeen(): void { if (this.orbitTarget.dist < 2) this.setOrbit({ ...ORBIT_HOME }, true); }
  resetOrbit(): void { this.setOrbit({ ...ORBIT_HOME }); }
  getTopZoom(): number { return this.topZoomTarget; }
  setTopZoom(z: number, snap = false): void { this.topZoomTarget = clamp(z, 0.3, 4); if (snap) this.topZoom = this.topZoomTarget; }
  /** Wheel in the bird's-eye view: factor > 1 zooms out. */
  zoomTopBy(factor: number): void { this.setTopZoom(this.topZoomTarget * factor); }

  private seatTex(n: number): THREE.CanvasTexture {
    let t = this.laneTexN.get(n);
    if (!t) { t = laneTexture(n, false); t.repeat.set(1, ROAD_LEN / DASH_PERIOD); this.laneTexN.set(n, t); }
    return t;
  }
  private seatX(li: number, n: number): number { return (li - (n - 1) / 2) * LANE_W; }

  /** Update 20: real trades from the fast feed; each may move one background car. */
  pushFlow(events: FlowEvent[]): void {
    this.flowQueue.push(...events);
    if (this.flowQueue.length > 24) this.flowQueue.splice(0, this.flowQueue.length - 24);
  }

  setLook(nx: number, ny: number): void {
    this.lookTx = clamp(nx, -1, 1);
    this.lookTy = clamp(ny, -1, 1);
  }

  resize(w: number, h: number): void {
    if (!this.renderer) return;
    this.width = Math.max(1, w); this.height = Math.max(1, h);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  pick(x: number, y: number): HoverHit | null {
    if (!this.renderer || !this.active) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const px = (x - rect.left) / rect.width, py = (y - rect.top) / rect.height;
    // Update 27: inside the mirror strip the pointer looks through the rear camera, so the cars behind you hover too
    const rx0 = (1 - this.rearW) / 2, ry0 = REAR_TOP;
    const inRear = this.rearShown && px >= rx0 && px <= rx0 + this.rearW && py >= ry0 && py <= ry0 + this.rearH;
    const ndc = inRear
      ? new THREE.Vector2(((px - rx0) / this.rearW) * 2 - 1, -((py - ry0) / this.rearH) * 2 + 1)
      : new THREE.Vector2(px * 2 - 1, -py * 2 + 1);
    this.raycaster.setFromCamera(ndc, inRear ? this.rearCam : this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      let kind: HoverKind | undefined;
      let id: string | undefined;
      let text: string | undefined;
      let visible = true;
      while (o) {
        if (!o.visible) visible = false;
        if (!kind && o.userData.kind) { kind = o.userData.kind as HoverKind; id = o.userData.id as string | undefined; text = o.userData.text as string | undefined; }
        o = o.parent;
      }
      if (!visible || !kind) continue;
      if (h.instanceId !== undefined && (kind === 'crash' || kind === 'flag')) {
        const ids = (h.object.userData.ids as string[] | undefined) ?? [];
        id = ids[h.instanceId] ?? String(h.instanceId);
      }
      if (kind === 'road' && Math.abs(h.point.y) > 0.6) kind = 'hill';
      return { kind, id, x, y, text };
    }
    return null;
  }

  anchors(): LabelAnchor[] { return this.anchorList; }
  topInfo(): TopInfo | null { return this.topInfoCur; }

  private project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const p = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height, visible: p.z < 1 && p.x > -1.1 && p.x < 1.1 && p.y > -1.1 && p.y < 1.1 };
  }

  /** CHASE (Update 17): the police lights: red and blue alternate; brighter the more it is gaining. */
  private policeLights(m: CarModel, nowMs: number, level: number): void {
    const phase = Math.floor(nowMs / 140) % 2 === 0;
    m.brakes.emissiveIntensity = (phase ? 2.5 : 0.2) * level;
    const blue = m.g.userData.blueMat as THREE.MeshStandardMaterial | undefined;
    if (blue) blue.emissiveIntensity = (phase ? 0.2 : 2.5) * level;
    if (m.glow) { m.glow.color.set(phase ? 0xff2020 : 0x3366ff); m.glow.intensity = 6 * level; }
  }

  /** CHASE (Update 16): a label for something seen in the mirror strip, projected through the rear camera. */
  private anchorRear(id: string, kind: HoverKind, x: number, y: number, z: number, text?: string, cls?: string, align?: 'left' | 'right' | 'center'): void {
    const p = new THREE.Vector3(x, y, z).project(this.rearCam);
    const sx = this.width * (1 - this.rearW) / 2 + ((p.x + 1) / 2) * this.width * this.rearW;
    const sy = this.height * REAR_TOP + ((1 - p.y) / 2) * this.height * this.rearH;
    this.anchorList.push({ id, kind, x: sx, y: sy, visible: p.z < 1 && p.x > -1.05 && p.x < 1.05 && p.y > -1.05 && p.y < 1.05, text, cls, align });
  }

  private anchor(id: string, kind: HoverKind, x: number, y: number, z: number, text?: string, cls?: string, align?: 'left' | 'right' | 'center'): void {
    const p = this.project(x, y, z);
    this.anchorList.push({ id, kind, x: p.x, y: p.y, visible: p.visible, text, cls, align });
  }

  private applyHills(f: Frame | null, o: RenderOpts, top: boolean): (z: number) => number {
    const pos = this.roadGeo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const hills = f && o.view !== 'price-only' && !top ? f.layers.hills : [];
    const focus = o.focus;
    if (!hills.length || !focus) {
      for (let i = 0; i < arr.length; i += 3) arr[i + 1] = this.roadBaseY[i + 1];
      pos.needsUpdate = true;
      return () => 0;
    }
    const sign = o.invert ? -1 : 1;
    const vRoad = Math.max(1e-6, focus.v_road) * o.gapScale * o.speedScale; // visual m/s
    const e0 = elevAt(hills, 0);
    const yAt = (z: number) => {
      if (z >= 0) return 0;
      const sec = -z / vRoad;
      return clamp(sign * (elevAt(hills, sec) - e0) * ELEV_SCALE, -40, 40) * clamp(-z / 25, 0, 1);
    };
    for (let i = 0; i < arr.length; i += 3) arr[i + 1] = this.roadBaseY[i + 1] + yAt(arr[i + 2]);
    pos.needsUpdate = true;
    this.roadGeo.computeVertexNormals();
    return yAt;
  }

  private ghostModel(g: GhostFrame): GhostModel {
    let m = this.ghosts.get(g.id);
    if (m) return m;
    const laneHex = parseInt(LANE_COLORS[g.lane].slice(1), 16);
    const sideHex = parseInt(SIDE_COLORS[g.side].slice(1), 16);
    const car = makeCar(sideHex, 0.6, laneHex, false, false);
    tag(car.g, 'ghost', g.id);
    const ahead = makeCar(0x3a0d16, 0.6, 0xff3b3b, true, false);
    tag(ahead.g, 'ghost-ahead', g.id);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(TOP_LANE_W - 0.4, 0.4), new THREE.MeshBasicMaterial({ color: laneHex, transparent: true, opacity: 0.8 }));
    line.rotation.x = -Math.PI / 2;
    tag(line, 'limit', g.id);
    const entry = new THREE.Mesh(new THREE.PlaneGeometry(TOP_LANE_W - 0.5, 0.4), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    entry.renderOrder = 5;
    entry.rotation.x = -Math.PI / 2;
    entry.position.y = 0.02;
    entry.visible = false;
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_PTS * 3), 3));
    trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_PTS * 3), 3));
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    trail.frustumCulled = false;
    trail.visible = false;
    const impact = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('255,140,60'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    impact.scale.set(6, 6, 1);
    this.scene.add(car.g, ahead.g, line, entry, trail, impact);
    this.pickables.push(car.g, ahead.g, line);
    m = { car, ahead, line, entry, trail, trailGeo, aheadZ: -30, carZ: 0, impact, side: g.side, lane: g.lane };
    this.ghosts.set(g.id, m);
    return m;
  }

  private setBrakes(model: CarModel, intensity: number, flash: number): void {
    const v = clamp(intensity, 0, 1.6) * flash;
    model.brakes.emissiveIntensity = v * 2.5;
    if (model.glow) model.glow.intensity = v * 8;
    const bloomOn = !this.lowQ;
    for (const s of model.bloom) {
      s.visible = bloomOn;
      (s.material as THREE.SpriteMaterial).opacity = clamp(v, 0, 1);
      const sc = 0.7 + v * 2.6;
      s.scale.set(sc, sc, 1);
    }
  }

  private placeAhead(model: CarModel, c: CarFrame, targetZ: number, prevZ: number, dt: number, o: RenderOpts, yAt: (z: number) => number, x: number, nowMs: number, primary: boolean): number {
    let z = lerp(prevZ, targetZ, clamp(dt / Math.max(0.05, o.tickLerp), 0, 1));
    model.g.visible = true;
    model.g.position.set(x, yAt(z), z);
    let intensity = c.brake_ahead * o.effects;
    if (primary && c.slam && nowMs > this.slamUntil) this.slamUntil = nowMs + 400;
    const slamming = primary && nowMs < this.slamUntil;
    if (slamming) {
      intensity = Math.max(intensity, 1.5);
      z += 1.4 * ((this.slamUntil - nowMs) / 400); // the small back-step toward you on slam
    }
    const blink = primary && o.color === 'red' ? (Math.floor(nowMs / 120) % 2 === 0 ? 1 : 0.2) : 1;
    this.setBrakes(model, intensity, slamming ? (Math.floor(nowMs / 60) % 2 === 0 ? 1 : 0.5) : blink);
    model.g.rotation.x = -clamp(intensity, 0, 1) * 0.03;
    return z;
  }

  /** Top-down view: the lanes span ~70% of the width, so the depth (and camera height) follow the aspect ratio. */
  private topDims(lanesShown: number): TopDims {
    const aspect = this.width / Math.max(1, this.height);
    const lanes = Math.max(2, lanesShown);
    const depth = clamp((lanes * TOP_LANE_W * 1.18 * this.topZoom) / aspect, 10, 240); // the drawn lanes span ~85 % of the width at zoom 1
    const behind = depth * 0.2;
    return { depth, behind, ahead: depth - behind, camH: depth / 2 / Math.tan((TOP_FOV / 2) * (Math.PI / 180)), camZ: -(depth / 2 - behind) };
  }

  /** Top-down lane x for a packed lane index. */
  private topX(li: number, n: number): number {
    return (li - (n - 1) / 2) * TOP_LANE_W;
  }

  private updateTrail(m: GhostModel, trail: Array<[number, number]> | undefined, x: number, map: TopMap, color: THREE.Color): void {
    if (!trail || trail.length < 2) { m.trail.visible = false; return; }
    const pos = m.trailGeo.attributes.position as THREE.BufferAttribute;
    const col = m.trailGeo.attributes.color as THREE.BufferAttribute;
    const n = Math.min(TRAIL_PTS, trail.length);
    const start = trail.length - n;
    for (let i = 0; i < n; i++) {
      const [, gap] = trail[start + i];
      pos.setXYZ(i, x + 1.6, 0.14, -map.y(gap));
      const k = 0.15 + 0.85 * (i / Math.max(1, n - 1));
      col.setXYZ(i, color.r * k, color.g * k, color.b * k);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    m.trailGeo.setDrawRange(0, n);
    m.trail.visible = true;
  }

  render(f: Frame | null, dt: number, o: RenderOpts, nowMs: number): void {
    if (!this.active || !this.renderer) return;
    this.anchorList = [];
    this.topInfoCur = null;
    const fx = o.effects;
    const lift = horizonLift(o.horizon?.h);
    const hasCar = !!f?.car;
    // PREVIEW: four lanes of the LIVE lane width, so the road widens by 4/3 and the dashes follow (Update 14)
    const laneN = hasCar ? (o.crowd ? 5 : 3) : this.seatLanes; // Update 20: with the crowd on, the LIVE road is five lanes wide
    this.road.scale.x = lerp(this.road.scale.x, laneN / 3, clamp(dt * 4, 0, 1));
    const halfW = (ROAD_W / 2) * this.road.scale.x;
    const roadMat = this.road.material as THREE.MeshStandardMaterial;
    const wantTex = this.seatTex(laneN);
    if (roadMat.map !== wantTex) { roadMat.map = wantTex; roadMat.needsUpdate = true; }
    // PREVIEW: the chase camera rises and looks further so four lanes of cars in front are visible down the road
    this.previewLin = clamp(this.previewLin + (!hasCar && f ? 1 : -1) * (dt / 0.8), 0, 1);
    const pk = smoothstep(this.previewLin);

    // top-down ↔ driver seat: the swoop (Update 8)
    this.topLin = clamp(this.topLin + (o.topDown ? 1 : -1) * (dt / SWOOP_SEC), 0, 1);
    const topT = smoothstep(this.topLin);
    const top = topT > 0.5;
    const firstPerson = this.orbit.dist < ORBIT_FP && !top;
    // Update 14: only the drawn lanes take room in the bird's-eye view
    const shown = f ? f.ghosts.filter((g) => f.rewind !== null || o.visible.has(g.id)) : [];
    const pack = packTopLanes(shown, o.bothSides, !!f?.rewind);
    this.seatLanes = Math.max(1, pack.lanes) + (o.crowd ? 2 : 0); // Update 20: a shoulder lane each side for the crowd
    this.topZoom = Math.exp(lerp(Math.log(this.topZoom), Math.log(this.topZoomTarget), clamp(dt * 8, 0, 1)));
    const td = this.topDims(pack.lanes);
    const yAt = this.applyHills(f, o, top);
    const focus = o.focus;

    // your visual speed (m/s) and smoothed acceleration
    const vYou = focus ? focus.v_you : 0.02;
    const vYouVis = vYou * o.gapScale * o.speedScale;
    if (this.prevVYou !== null && dt > 0) {
      const aInst = (vYouVis - this.prevVYou) / dt;
      this.accel += (1 - Math.exp(-dt / 0.35)) * (aInst - this.accel);
    }
    this.prevVYou = vYouVis;

    // everything fixed to the ground scrolls at YOUR speed in the driver seat; the top road at the flow speed
    const vScroll = Math.max(0, vYouVis); // the road never runs backwards on a favourable tick
    this.scroll += vScroll * dt;
    // the road plane is rotated −90° about X, so texture v grows away from the camera: a growing offset brings
    // the dashes toward you (the old minus sign sent them away, which read as driving backwards)
    this.laneTex.offset.y = this.scroll / DASH_PERIOD;
    for (const tx of this.laneTexN.values()) tx.offset.y = this.laneTex.offset.y;
    const vFlow = Math.max(1, (focus ? focus.v_road : 0.05) * 30);
    this.topScroll += vFlow * dt;
    this.topTex.offset.y = this.topScroll / DASH_PERIOD;
    this.grid.position.z = (((top ? this.topScroll : this.scroll) % 16) + 16) % 16;
    this.poleScroll = (this.poleScroll + vScroll * dt) % (POLE_GAP * POLES);
    for (let i = 0; i < POLES; i++) {
      let z = 20 - i * POLE_GAP + this.poleScroll;
      if (z > 20) z -= POLE_GAP * POLES;
      setInstance(this.poles, i * 2, -(halfW + 1.4), yAt(z), z);
      setInstance(this.poles, i * 2 + 1, halfW + 1.4, yAt(z), z);
    }
    this.poles.instanceMatrix.needsUpdate = true;
    this.poles.visible = !top && o.poles; // Update 19: optional
    const cityZ = ((this.scroll % CITY_RANGE) + CITY_RANGE) % CITY_RANGE;
    this.cityA.position.z = cityZ + 40;
    this.cityB.position.z = cityZ + 40 - CITY_RANGE;
    this.cityA.visible = this.cityB.visible = topT < 0.6; // from above the skyline is clutter

    // lurch: a surge (tick against you) or drag (tick for you) kicks the camera once, then decays
    const lurch = focus ? focus.lurch : 0;
    if (lurch !== this.lastLurch && lurch !== 0) this.kick = lurch * 0.6 * fx;
    this.lastLurch = lurch;
    this.kick *= Math.exp(-dt / 0.25);

    // FOV with speed and horizon; pitch with acceleration + reactive dip
    // Update 15: the market's push drives every motion cue; the driver's pedals are never read here
    const push = focus ? focus.impulse : 0;
    const throttle = Math.max(0, push);  // surge: a tick against me
    const brake = Math.max(0, -push);    // drag: a tick for me
    const hw = focus ? Math.min(focus.headway_s ?? Infinity, focus.headway_proj_s ?? Infinity) : Infinity;
    const driveFov = 58 + lift * 5 + fx * (16 * clamp(vYouVis / 45, 0, 1.4) + throttle * 3 - brake * 3);
    const targetFov = lerp(driveFov, TOP_FOV, topT);
    this.fov = lerp(this.fov, targetFov, clamp(dt * 3, 0, 1));
    if (Math.abs(this.camera.fov - this.fov) > 0.05) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
    const thr = o.thresholds;
    const reactive = focus && (focus.v_close > 0) && hw < thr.yellow ? -0.015 * (1 - clamp(hw / thr.yellow, 0, 1)) : 0;
    const targetPitch = fx * (clamp(this.accel * 0.004, -0.05, 0.05) + throttle * 0.012 - brake * 0.03 + reactive) + this.kick * 0.03;
    this.pitch = lerp(this.pitch, targetPitch, clamp(dt * 4, 0, 1));

    // shake under the orange / critical thresholds (driver seat only)
    const crit = (o.horizon?.thr.critical ?? thr.orange / 5);
    const shakeAmp = (1 - topT) * (fx * (hw < crit ? 0.14 : hw < thr.orange ? 0.045 : 0) + o.jolt * 0.3);
    const ts = nowMs / 1000;
    const sx = noise(ts, 1.3) * shakeAmp, sy = noise(ts, 2.1) * shakeAmp * 0.6;

    // camera: driver seat (chase / driver, lifts with the horizon, swings around on Q) blended with top-down
    this.lookT = lerp(this.lookT, o.lookBack && !top ? 1 : 0, clamp(dt * 6, 0, 1));
    // mouse look-around (Update 14): a gentle tilt with the pointer; the wheel and a drag are the real controls
    this.lookX = lerp(this.lookX, this.lookTx, clamp(dt * 5, 0, 1));
    this.lookY = lerp(this.lookY, this.lookTy, clamp(dt * 5, 0, 1));
    const lookUp = Math.max(0, this.lookY) * (1 - topT);
    // orbit camera (Update 14): anchored above my car. The wheel zooms from a high chase down to first person, a
    // drag orbits (yaw and elevation); the PREVIEW rise and the pointer tilt add to the elevation.
    const ok = clamp(dt * 8, 0, 1);
    this.orbit.dist = Math.exp(lerp(Math.log(this.orbit.dist), Math.log(this.orbitTarget.dist), ok));
    this.orbit.yaw = lerp(this.orbit.yaw, this.orbitTarget.yaw, ok);
    this.orbit.pitch = lerp(this.orbit.pitch, this.orbitTarget.pitch, ok);
    const d = this.orbit.dist;
    const anchorY = 1.5 + lift * 1.2;
    const el = clamp(this.orbit.pitch + 0.22 * pk + 0.25 * lookUp, 0.02, 1.5);
    const yaw = this.orbit.yaw + this.lookX * 0.12 * (1 - topT);
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    pos.set(
      Math.sin(yaw) * Math.cos(el) * d + sx,
      anchorY + Math.sin(el) * d + sy - brake * 0.12 * fx + this.kick * 0.1,
      Math.cos(yaw) * Math.cos(el) * d + throttle * 0.3 * fx - this.kick * 0.4,
    );
    const reach = Math.max(12, 2.5 * d) + lift * 12 + 18 * pk + 16 * lookUp;
    look.set(0, Math.max(0.6, anchorY - 0.7 - 0.05 * d), -reach);
    if (this.lookT > 0.001) {
      pos.lerp(new THREE.Vector3(0, 3.8 + lift * 2, -8 - lift * 3), this.lookT);
      look.lerp(new THREE.Vector3(0, 0.8, 50), this.lookT);
    }
    // PREVIEW: the seat sits behind the focused lane ("if Go now" by default); LIVE: behind my car in the centre
    let laneShift = 0;
    if (!hasCar && f && f.ghosts.length) {
      const prim = f.ghosts.find((g) => g.id === o.primaryGhostId);
      if (prim && pack.index.has(prim.id)) laneShift = this.seatX(pack.index.get(prim.id)! + (o.crowd ? 1 : 0), this.seatLanes);
    }
    this.camX = lerp(this.camX, laneShift, clamp(dt * 3, 0, 1));
    pos.x += this.camX;
    look.x += this.camX;
    if (topT > 0.001) {
      pos.lerp(new THREE.Vector3(0, td.camH, td.camZ), topT);
      look.lerp(new THREE.Vector3(0, 0, td.camZ), topT);
    }
    this.camera.up.set(0, 1, 0).lerp(new THREE.Vector3(0, 0, -1), topT).normalize();
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    this.camera.rotateX(this.pitch * (1 - this.lookT) * (1 - topT));
    // CHASE (Update 16): the rear camera for the mirror strip: above my car, looking back down the road
    this.rearCam.position.set(this.camX, 4.2, -1.5);
    this.rearCam.lookAt(this.camX, 1.0, 60);
    this.rearH = o.rearH; this.rearW = o.rearW;
    this.rearCam.aspect = (this.width * this.rearW) / Math.max(1, this.height * this.rearH);
    this.rearCam.updateProjectionMatrix();

    // CLEAR (Update 4): the 20-second stretch brightens the scene
    this.clearT = lerp(this.clearT, o.horizon?.clear ? 1 : 0, clamp(dt * 1.5, 0, 1));
    this.renderer.toneMappingExposure = 1.15 + 0.3 * this.clearT;
    this.hemi.intensity = 0.85 + 0.4 * this.clearT;

    // your car: squat on throttle, nose-dive on brake (no bloom on your own car)
    this.you.g.rotation.x = fx * (-throttle * 0.03 + brake * 0.045);
    this.you.brakes.emissiveIntensity = brake * 2;

    // speed streaks (motion-blur stand-in) scaled to your speed, instanced
    const streakAlpha = top ? 0 : fx * clamp((vYouVis - 6) / 40, 0, 0.55);
    this.streakMat.opacity = streakAlpha;
    this.streaks.visible = streakAlpha > 0.01;
    if (this.streaks.visible) {
      const len = clamp(vYouVis * 0.22, 0.4, 14);
      for (let i = 0; i < STREAKS; i++) {
        this.streakZ[i] += vYouVis * dt * 1.15;
        if (this.streakZ[i] > 12) this.streakZ[i] = -140 - hash01(Math.floor(nowMs) % 997, 19) * 40;
        const side = i % 2 === 0 ? -1 : 1;
        setInstance(this.streaks, i, side * (halfW + 0.8 + hash01(i, 11) * 3.5), 0.3 + hash01(i, 13) * 2.2, this.streakZ[i], 1, 1, len);
      }
      this.streaks.instanceMatrix.needsUpdate = true;
    }

    // fog from spread + divergence (not in price-only, not top-down)
    const fogSrc = f && o.view !== 'price-only' && !top ? (f.layers.spread ?? 0) + (f.layers.divergence ?? 0) : 0;
    this.fog.density = (0.0028 + clamp(fogSrc * 60, 0, 0.03)) * (1 - 0.4 * this.clearT) * (top ? 0.3 : 1);

    this.road.visible = topT < 0.999;
    this.topRoad.visible = topT > 0.001;

    // ---- top-down scale (Update 8 §2): fit the spread of the dollar gaps of the cars in front ----
    let map: TopMap | null = null;
    const price = f?.price ?? 0;
    if (f && top) {
      const gaps: number[] = [];
      if (f.car) gaps.push(animGapUsd(f.car, f, o.anim));
      else for (const g of shown) if (!g.crashed) gaps.push(animGapUsd(g, f, o.anim));
      const mPerPx = td.depth / this.height;
      const capM = 1000 * mPerPx;              // 1 px per $0.001 at most
      // Update 17: the dollar scale is fixed at zoom 1, so zooming out adds road around the cars instead of re-spacing them
      map = fitTopScale(gaps, td.ahead / this.topZoom, td.behind / this.topZoom, capM);
      const pxPerUsd = map.scale / mPerPx;
      const usdPerCm = PX_PER_CM / pxPerUsd;
      this.topInfoCur = { pxPerUsd, usdPerCm, pctPerCm: price > 0 ? (usdPerCm / price) * 100 : 0, broken: map.broken, spreadUsd: map.spread };
      this.breakA.visible = this.breakB.visible = map.broken;
      if (map.broken) {
        this.breakA.position.set(0, 0.03, -map.near);
        this.breakB.position.set(0, 0.03, -map.farStart);
        this.anchor('break', 'text', 0, 0.3, -(map.near + map.farStart) / 2, `⋯ ${money(map.gapMin - map.pad)} compressed ⋯`, 'break');
      }
    } else {
      this.breakA.visible = this.breakB.visible = false;
    }
    /** z of a dollar distance: positive dUsd = toward liquidation (ahead), negative = behind (favourable side). */
    const zOfUsd = (dUsd: number): number => (map ? -map.y(dUsd) : -dUsd);

    let ringTarget: THREE.Vector3 | null = null;

    // ---- ghosts ----
    const seen = new Set<string>();
    if (f) {
      const laneColor = new THREE.Color();
      for (const g of f.ghosts) {
        const drawn = f.rewind !== null || o.visible.has(g.id);
        const show = drawn && (top ? !hasCar : ghostLane(g, hasCar) >= 0); // Update 18: the seat draws the same lanes as the bird's-eye, both sides side by side
        if (!show) continue;
        seen.add(g.id);
        const m = this.ghostModel(g);
        const isPrimary = g.id === o.primaryGhostId && !hasCar;
        const x = top ? this.topX(pack.index.get(g.id) ?? 0, pack.lanes) : this.seatX((pack.index.get(g.id) ?? 0) + (o.crowd ? 1 : 0), this.seatLanes);
        m.car.g.visible = !(firstPerson && isPrimary && !g.crashed); // first person: the car I sit in is not drawn
        // Update 19: the focused lane is my car: solid and cyan-edged; the other lanes are ghosted in their colour
        setOpacity(m.car, isPrimary ? 1 : top ? 0.5 : 0.4);
        m.car.edgeMat.color.set(isPrimary ? NEON_CYAN : parseInt(LANE_COLORS[g.lane].slice(1), 16));
        setOpacity(m.ahead, top ? 0.95 : 0.9);
        // the car in front: dollar distance on the top-down scale, car lengths × gapScale in the driver seat
        const gapCl = g.crashed ? 0 : animGap(g, f, o.anim);
        const gapUsd = g.crashed ? 0 : animGapUsd(g, f, o.anim);
        const chaseG = o.chase; // CHASE: the same number, drawn as the police car (behind me in the seat, ahead from above)
        const behindG = chaseG && !top;
        const targetZ = top ? zOfUsd(Math.max(0.0005, gapUsd)) : (behindG ? 1 : -1) * Math.max(0.02, gapCl) * o.gapScale;
        if (chaseG && !m.monster) { m.monster = makeMonster(); tag(m.monster.g, 'ghost-ahead', g.id); this.scene.add(m.monster.g); this.pickables.push(m.monster.g); }
        const aheadModel = chaseG && m.monster ? m.monster : m.ahead;
        m.aheadZ = this.placeAhead(aheadModel, g, targetZ, m.aheadZ, dt, o, yAt, x, nowMs, isPrimary);
        if (chaseG && m.monster) {
          m.ahead.g.visible = false;
          m.monster.g.scale.setScalar(0.8 + clamp(1 - gapCl / 3, 0, 1) * 0.4);
          this.policeLights(m.monster, nowMs, clamp(0.3 + g.brake_ahead + (Number.isFinite(g.headway_s ?? Infinity) ? clamp((120 - (g.headway_s ?? 120)) / 120, 0, 1) : 0), 0, 1.6));
          if (isPrimary && behindG) this.anchorRear(`${g.id}:liq`, 'text', x, 3.6, m.aheadZ, `it ${fmtPriceRaw(g.liq, MARKETS[f.market].priceDp)} · ${timeSpan(g.headway_s)}`, 'liqtag it', 'center');
        } else if (m.monster) m.monster.g.visible = false;
        if (g.crashed) {
          m.carZ = lerp(m.carZ, m.aheadZ + 4.6, clamp(dt * 8, 0, 1));
          m.car.g.position.set(x, yAt(m.carZ), m.carZ);
          setOpacity(m.car, 0.15 + 0.2 * Math.abs(Math.sin(nowMs / 90)));
          m.impact.visible = true;
          m.impact.position.set(x, 0.9, m.aheadZ + 2.4);
          (m.impact.material as THREE.SpriteMaterial).opacity = 0.5 + 0.5 * Math.abs(Math.sin(nowMs / 70));
          const sc = 4 + 3 * Math.abs(Math.sin(nowMs / 110));
          m.impact.scale.set(sc, sc, 1);
        } else {
          m.carZ = lerp(m.carZ, 0, clamp(dt * 6, 0, 1));
          m.car.g.position.set(x, 0, m.carZ);
          m.impact.visible = false;
        }
        // entry line per lane (top-down) at its true position: behind when in profit, ahead when in loss
        if (top) {
          const dBehind = g.side * (f.price - g.entry);
          const ze = dBehind >= 0 ? Math.min(td.behind - 1, dBehind * (map?.scale ?? 1)) : zOfUsd(-dBehind);
          m.entry.visible = true;
          m.entry.position.set(x, 1.5, ze); // above the roof: never hidden by my car
          laneColor.set(LANE_COLORS[g.lane]);
          this.updateTrail(m, o.trails.get(g.id), x, map!, laneColor);
          // labels the view dictates (Update 8 §2 / 9 A2): lane name over the car in front, P&L by my car, distance between
          const pnl = g.pnl_usd - g.fees_usd;
          this.anchor(`${g.id}:pnl`, 'text', x, 0.4, 3.4, smoney(pnl), `pnl ${pnl >= 0 ? 'pos' : 'neg'}`); // the percent is on hover and in the lane table
          if (isPrimary) this.anchor(`${g.id}:price`, 'text', x, 2.4, m.carZ, `YOU · ${fmtPriceRaw(f.price, MARKETS[f.market].priceDp)}`, 'price');
          if (!g.crashed) this.anchor(`${g.id}:dist`, 'text', x, 0.4, m.aheadZ / 2, money(gapUsd), 'dist');
          // few lanes: the liq tag sits beside its car in front (LONG to the left, SHORT to the right); many: the left margin
          const few = pack.lanes <= 4;
          const tagX = !few ? -TOP_W / 2 - 1.5 : g.side === 1 ? x - TOP_LANE_W / 2 - 0.3 : x + TOP_LANE_W / 2 + 0.3;
          this.anchor(`${g.id}:liq`, 'text', tagX, 1.2, m.aheadZ, `liq ${fmtPriceRaw(g.liq, MARKETS[f.market].priceDp)} · ${timeSpan(g.headway_s)}`, `liqtag ${g.side === 1 ? 'long' : 'short'}`, few && g.side === -1 ? 'left' : 'right');
        } else {
          m.entry.visible = false;
          m.trail.visible = false;
          if (isPrimary) this.anchor(`${g.id}:price`, 'text', x, 2.4, m.carZ, `YOU · ${fmtPriceRaw(f.price, MARKETS[f.market].priceDp)}`, 'price');
        }
        // limit entry line
        if (g.is_limit && g.proposed_entry !== null && focus) {
          let z: number;
          if (top) {
            const dBehind = g.side * (f.price - g.proposed_entry);
            z = dBehind >= 0 ? Math.min(td.behind - 1, dBehind * (map?.scale ?? 1)) : zOfUsd(-dBehind);
          } else {
            const sign = o.invert ? -1 : 1;
            const needed = (-g.side * (g.proposed_entry - f.price) * g.leverage) / f.price;
            const hills = o.view !== 'price-only' ? f.layers.hills : [];
            const sec = hills.length ? limitDistSec(hills, sign * needed) : null;
            const vRoad = Math.max(1e-6, focus.v_road) * o.gapScale * o.speedScale;
            z = sec !== null ? -sec * vRoad : (needed > 0 ? -ROAD_AHEAD * 0.9 : -6);
          }
          m.line.visible = true;
          m.line.position.set(x, 0.03 + yAt(z), z);
          this.anchor(g.id, 'limit', x, 0.4, z);
          if (highlightMatches(o.highlight, 'limit', g.id)) ringTarget = m.line.position.clone();
        } else m.line.visible = false;
        this.anchor(g.id, 'ghost', x, 1.7, m.carZ);
        this.anchor(g.id, 'ghost-ahead', x, 1.7 + yAt(m.aheadZ), m.aheadZ);
        if (highlightMatches(o.highlight, 'ghost', g.id) && !ringTarget) ringTarget = m.car.g.position.clone();
      }
    }
    for (const [id, m] of this.ghosts) {
      if (!seen.has(id)) {
        m.car.g.visible = false; m.ahead.g.visible = false; m.line.visible = false; m.entry.visible = false; m.trail.visible = false; m.impact.visible = false;
        if (m.monster) m.monster.g.visible = false;
      }
    }

    // ---- the real car ----
    const car = f?.car ?? null;
    const showYou = (hasCar || !f || f.ghosts.length === 0) && !firstPerson; // first person: my own car is not drawn
    this.you.g.visible = showYou;
    this.you.bodyMat.transparent = !hasCar; this.you.headMat.transparent = !hasCar; this.you.brakes.transparent = !hasCar;
    setOpacity(this.you, hasCar ? 1 : 0.35);
    if (car && f) {
      const chase = o.chase; // CHASE (Update 16): the car in front is the police car; behind you in the seat, ahead from above (Update 19)
      const behind = chase && !top;
      const targetZ = top ? zOfUsd(Math.max(0.0005, animGapUsd(car, f, o.anim))) : (behind ? 1 : -1) * Math.max(0.02, animGap(car, f, o.anim)) * o.gapScale;
      this.aheadZ = this.placeAhead(chase ? this.monster : this.ahead, car, targetZ, this.aheadZ, dt, o, yAt, 0, nowMs, true);
      (chase ? this.ahead : this.monster).g.visible = false;
      if (chase) {
        this.monster.g.scale.setScalar(1 + clamp(1 - animGap(car, f, o.anim) / 3, 0, 1) * 0.5); // looms as it gains
        const gaining = Number.isFinite(car.headway_s ?? Infinity) ? clamp((120 - (car.headway_s ?? 120)) / 120, 0, 1) : 0;
        this.policeLights(this.monster, nowMs, clamp(0.35 + car.brake_ahead + gaining, 0, 1.6));
        if (behind) this.anchorRear('ahead', 'ahead', 0, 3.8, this.aheadZ, `it ${fmtPriceRaw(car.liq, MARKETS[f.market].priceDp)} · ${timeSpan(car.headway_s)}`, 'liqtag it', 'center');
      }
      let ez: number;
      if (top) {
        const dBehind = car.side * (f.price - car.entry);
        ez = dBehind >= 0 ? Math.min(td.behind - 1, dBehind * (map?.scale ?? 1)) : zOfUsd(-dBehind);
      } else ez = car.entry_dist * o.gapScale;
      this.entryLine.visible = ez > -ROAD_AHEAD && ez < 60;
      this.entryLine.position.set(0, (top ? 1.5 : 0.02) + yAt(ez), ez);
      this.entryLine.scale.x = top ? TOP_LANE_W / ROAD_W : 1;
      if (car.stop_dist !== null && car.stop_price !== null) {
        const sz = top ? Math.min(td.behind - 1, car.side * (f.price - car.stop_price) * (map?.scale ?? 1)) : car.stop_dist * o.gapScale;
        const chaseS = o.chase && !top; // CHASE: the stop is a wall ahead that you choose to hit
        const zs = chaseS ? -sz : sz;
        this.stopCar.g.visible = !chaseS;
        this.wall.visible = chaseS;
        this.stopCar.g.position.set(0, 0, zs);
        this.wall.position.set(0, 1.2 + yAt(zs), zs);
        this.anchor('stop', 'stop', 0, 1.7, zs);
        if (highlightMatches(o.highlight, 'stop')) ringTarget = this.stopCar.g.position.clone();
      } else { this.stopCar.g.visible = false; this.wall.visible = false; }
      // take profit / stop loss markers: TP on the favourable side (behind you), SL on the adverse side (ahead)
      const dpx = MARKETS[f.market].priceDp;
      f.exits.slice(0, MAX_EXITS).forEach((ex, i) => {
        const mk = this.exitMarks[i];
        const dBehind = car.side * (f.price - ex.price);
        let z: number;
        if (top) z = dBehind >= 0 ? Math.min(td.behind - 1, dBehind * (map?.scale ?? 1)) : zOfUsd(-dBehind);
        else z = clamp(((car.leverage * dBehind) / f.price) * o.gapScale, -ROAD_AHEAD * 0.95, 60);
        mk.visible = true;
        (mk.material as THREE.MeshBasicMaterial).color.set(ex.kind === 'tp' ? 0x35d07f : 0xff8a3d);
        mk.position.set(0, (top ? 1.5 : 0.04) + yAt(z), z);
        mk.userData.id = ex.id;
        this.anchor(ex.id, 'exit', 0, 0.6 + yAt(z), z, `${ex.kind.toUpperCase()} ${Math.round(ex.fraction * 100)}% · ${fmtPriceRaw(ex.price, dpx)}`, `exittag ${ex.kind}`);
      });
      for (let i = f.exits.length; i < MAX_EXITS; i++) this.exitMarks[i].visible = false;
      this.anchor('you', 'you', 0, 1.7, 0);
      this.anchor('you:price', 'text', 0, 2.4, 0, fmtPriceRaw(f.price, MARKETS[f.market].priceDp), 'price');
      this.anchor('ahead', 'ahead', 0, 1.7 + yAt(this.aheadZ), this.aheadZ);
      if (this.entryLine.visible) {
        // the line is where you merged: behind you once the trade is in profit, ahead of you while it is in loss
        const dEntry = car.side * (f.price - car.entry);
        const words = dEntry >= 0 ? `${money(Math.abs(dEntry))} behind you` : `${money(Math.abs(dEntry))} ahead of you`;
        this.anchor('entry', 'entry', 0, 0.4 + yAt(ez), ez, top ? undefined : `entry ${fmtPriceRaw(car.entry, MARKETS[f.market].priceDp)} · ${words}`, 'entry');
      }
      if (top) {
        const gapUsd = animGapUsd(car, f, o.anim);
        this.anchor('car:dist', 'text', 0, 0.4, this.aheadZ / 2, `${money(gapUsd)} · ${pct(car.gap_pct * 100)}`, 'dist');
        const pnl = car.pnl_usd - car.fees_usd;
        this.anchor('car:pnl', 'text', 0, 0.4, 3.4, `${smoney(pnl)} (${pct(car.collateral_usd > 0 ? (pnl / car.collateral_usd) * 100 : 0, true)})`, `pnl ${pnl >= 0 ? 'pos' : 'neg'}`);
      }
      if (highlightMatches(o.highlight, 'you')) ringTarget = new THREE.Vector3(0, 0, 0);
      else if (highlightMatches(o.highlight, 'ahead')) ringTarget = this.ahead.g.position.clone();
      else if (highlightMatches(o.highlight, 'entry') && this.entryLine.visible) ringTarget = this.entryLine.position.clone();
    } else {
      this.ahead.g.visible = false;
      this.entryLine.visible = false;
      this.stopCar.g.visible = false;
      for (const mk of this.exitMarks) mk.visible = false;
      if (showYou) this.anchor('you', 'you', 0, 1.7, 0);
    }

    // ---- the road behind: crash posts (lane colour), red posts (Update 10), flags; instanced ----
    const b = f?.behind ?? null;
    const behindLen = top ? td.behind - 2 : BEHIND_LEN;
    const span = b && f ? Math.max(1, f.t - b.t_from) : 1;
    const zBehind = (t: number) => clamp((f!.t - t) / span, 0, 1) * behindLen + 3;
    const postIds: string[] = [];
    let np = 0;
    if (b && f) {
      const col = new THREE.Color();
      for (let i = 0; i < b.crashes.length && np < MAX_POSTS; i++) {
        const [t, lane] = b.crashes[i];
        setInstance(this.posts, np, halfW + 1.0, 0, zBehind(t));
        this.posts.setColorAt(np, col.set(LANE_COLORS[lane] ?? '#ff8a3d'));
        postIds.push(String(i));
        this.anchor(String(i), 'crash', halfW + 1.0, 1.6, zBehind(t));
        np++;
      }
      for (let i = 0; i < o.redMoments.length && np < MAX_POSTS; i++) {
        const t = o.redMoments[i];
        if (t < b.t_from) continue;
        setInstance(this.posts, np, halfW + 1.6, 0, zBehind(t), 0.7, 0.7, 0.7);
        this.posts.setColorAt(np, col.set(0xff3b3b));
        postIds.push(`r${i}`);
        np++;
      }
      let nf = 0;
      for (let i = 0; i < b.flags.length && nf < MAX_FLAGS; i++) {
        const z = zBehind(b.flags[i].t);
        setInstance(this.flags, nf, -(halfW + 1.0), 0, z);
        this.anchor(String(i), 'flag', -(halfW + 1.0), 2.6, z);
        nf++;
      }
      this.flags.count = nf;
      this.flags.userData.ids = b.flags.slice(0, nf).map((_, i) => String(i));
      if (nf) this.flags.instanceMatrix.needsUpdate = true;
    } else this.flags.count = 0;
    this.posts.count = np;
    this.posts.userData.ids = postIds;
    if (np) { this.posts.instanceMatrix.needsUpdate = true; if (this.posts.instanceColor) this.posts.instanceColor.needsUpdate = true; }

    // highlight ring
    if (ringTarget) {
      this.ring.visible = true;
      const sc = 1 + 0.12 * Math.sin(nowMs / 160);
      this.ring.position.set(ringTarget.x, ringTarget.y + 0.06, ringTarget.z);
      this.ring.scale.set(sc, sc, 1);
    } else this.ring.visible = false;

    // ---- traffic (driver seat only): rides the road flow, drifts at v_road - v_you ----
    const want = f && !top && o.traffic ? trafficCount(f, o.view) + (o.crowd ? 2 : 0) : 0;
    const laneN2 = hasCar ? (o.crowd ? 5 : 3) : this.seatLanes;
    const center = (laneN2 - 1) / 2;
    // my lane: the middle in LIVE; the focused lane in PREVIEW
    let myLane = center;
    if (!hasCar && f) { const prim = f.ghosts.find((g) => g.id === o.primaryGhostId); if (prim && pack.index.has(prim.id)) myLane = pack.index.get(prim.id)! + (o.crowd ? 1 : 0); }
    const shoulders = laneN2 >= 3 ? [0, laneN2 - 1] : [0];
    while (this.traffic.length < want) {
      const i = this.traffic.length;
      const edge = [NEON_PURPLE, 0x1fb6c9, NEON_PINK, 0xffd166][i % 4];
      const model = makeCar([0x1f1b3a, 0x12303a, 0x2a1a44, 0x33261a][i % 4], 1, edge, false, false);
      tag(model.g, 'traffic');
      this.scene.add(model.g);
      this.pickables.push(model.g);
      const lane = shoulders[i % shoulders.length];
      const base = 0.95 + hash01(i, 5) * 0.1;
      this.traffic.push({ model, lane, z: -hash01(i, 3) * ROAD_AHEAD * 0.8 + 10, speed: base, base, from: lane, to: lane, changeStart: 0, changeDur: 0, signalUntil: 0, nextAllowed: 0, bigUntil: 0, leaveAt: 0, zTo: null, edge, wallUntil: 0 });
    }
    // Update 20: the crowd is made of real trades. Each print on the fast feed may move one car: buys drift right,
    // sells left (invert flips it); the odds grow with size against the last minute's median (a median print ~3 %,
    // a 5× print always); a big print (8× and more) cuts in close ahead when it is against your side, behind you
    // when it is with you, and that car leaves your lane a few seconds later. Signal for half a second, then a
    // smooth slide; two seconds between moves per car; the whole field at most one change per two cars a second.
    const mySide = focus ? focus.side : 0;
    const dirSign = o.invert ? -1 : 1;
    // Update 25 / 27: the crowd carries the flow in its motion relative to me. The car ahead is my liquidation, so a
    // trade AGAINST my side (price toward liq) is traffic ahead slowing down and coming back at me: a wall; a huge one
    // stops dead and cuts into my lane. A trade WITH my side (price away from liq) is a car from behind that rushes
    // past: the road is flowing my way. Size sets how much: a median print barely, a 20× print all the way.
    // Buys still drift right and sells left as the quieter second cue.
    if (o.crowd && !top && want > 0) {
      for (const ev of this.flowQueue.splice(0)) {
        const k = clamp(Math.log2(Math.max(1, ev.ratio)) / Math.log2(20), 0, 1);
        if (Math.random() > clamp(0.05 + k, 0.05, 1)) continue;
        const cars = this.traffic.filter((c, i) => i < want);
        if (!cars.length) continue;
        const withMe = mySide !== 0 && ev.side === mySide;
        const against = mySide !== 0 && ev.side !== mySide;
        const text = `${ev.side === 1 ? 'BUY' : 'SELL'} $${Math.round(ev.sizeUsd).toLocaleString()} · ${ev.ratio.toFixed(1)}× the minute's median · ${new Date(ev.t).toLocaleTimeString()}`;
        if (against) {
          // the wall: a car ahead brakes and drifts back toward me; a huge print stops it dead and pulls it into my lane
          const ahead = cars.filter((c) => c.z < -8 && c.changeStart === 0);
          const car = ahead.length ? ahead[Math.floor(Math.random() * ahead.length)] : cars[Math.floor(Math.random() * cars.length)];
          if (car.z > -8) car.z = -(30 + Math.random() * 10);
          car.speed = Math.max(0, 1 - k);
          car.wallUntil = nowMs + 2500 + 5500 * k;
          car.model.g.userData.text = `${text} · against you · toward your liquidation`;
          if (k > 0.6) {
            car.bigUntil = nowMs + 20_000;
            if (nowMs >= car.nextAllowed && nowMs >= this.nextChangeAt && Math.round(car.lane) !== myLane) {
              car.from = Math.round(car.lane); car.to = myLane; car.signalUntil = nowMs + 500; car.changeStart = nowMs + 500; car.changeDur = 1200; car.zTo = -(9 + Math.random() * 4); car.leaveAt = nowMs + 4000; car.nextAllowed = nowMs + 3200;
              this.nextChangeAt = nowMs + 2000 / Math.max(1, want);
            }
          }
        } else if (withMe) {
          // the flow is mine: a car from behind overtakes; a huge print flies past
          let car = cars.find((c) => c.z > 4 && c.changeStart === 0 && nowMs >= c.wallUntil);
          if (!car) { car = cars[Math.floor(Math.random() * cars.length)]; car.z = 30 + Math.random() * 8; }
          car.wallUntil = 0;
          car.speed = 1 + 2.2 * k;
          car.model.g.userData.text = `${text} · with you · away from your liquidation`;
          if (k > 0.6) car.bigUntil = nowMs + 20_000;
        }
        if (Math.random() < 0.35 && nowMs >= this.nextChangeAt) {
          const dir = ev.side * dirSign;
          const movable = cars.filter((c) => { if (nowMs < c.nextAllowed || c.changeStart !== 0) return false; const t = Math.round(c.lane) + dir; return t >= 0 && t < laneN2 && t !== myLane; });
          if (movable.length) {
            const car = movable[Math.floor(Math.random() * movable.length)];
            const dur = 1000 + Math.random() * 500;
            car.from = Math.round(car.lane); car.to = Math.round(car.lane) + dir; car.signalUntil = nowMs + 500; car.changeStart = nowMs + 500; car.changeDur = dur; car.zTo = null; car.nextAllowed = nowMs + 2000 + dur;
            this.nextChangeAt = nowMs + 2000 / Math.max(1, want);
          }
        }
      }
    } else this.flowQueue.length = 0;
    const vRoadVis = Math.max(0.5, (focus ? focus.v_road : 0.05) * o.gapScale * o.speedScale); // the road's flow, visual m/s
    for (let i = 0; i < this.traffic.length; i++) {
      const c = this.traffic[i];
      c.model.g.visible = i < want;
      if (!c.model.g.visible) continue;
      if (c.changeStart > 0) {
        // a change in progress: the signal, then a smooth slide across; a cut-in also moves along the road
        const k = clamp((nowMs - c.changeStart) / c.changeDur, 0, 1);
        if (nowMs >= c.changeStart) {
          c.lane = lerp(c.from, c.to, smoothstep(k));
          if (c.zTo !== null) c.z = lerp(c.z, c.zTo, clamp(dt * 3, 0, 1));
        }
        if (k >= 1) { c.lane = c.to; c.changeStart = 0; c.zTo = null; }
      } else if (c.leaveAt > 0 && nowMs >= c.leaveAt) {
        // after a cut-in, drift back out of my lane
        const dir = Math.round(c.lane) + 1 < laneN2 ? 1 : -1;
        c.from = Math.round(c.lane); c.to = Math.round(c.lane) + dir; c.signalUntil = nowMs + 400; c.changeStart = nowMs + 400; c.changeDur = 1200; c.leaveAt = 0; c.nextAllowed = nowMs + 4000;
      } else {
        // cars ride the road at `speed` × the flow and I ride at my speed: slower cars come back to me, faster ones rush past
        c.speed += (c.base - c.speed) * (1 - Math.exp(-dt / 12));
        c.z += (vYouVis - c.speed * vRoadVis) * dt;
        // Update 27: a wall car (a print against me) holds a few lengths ahead, then pulls away again; nothing drives
        // through me: a car drifting back in my lane peels out of it before it reaches me
        const inMyLane = Math.round(c.lane) === myLane && c.changeStart === 0;
        const hold = inMyLane ? -10 : -7;
        if (nowMs < c.wallUntil) {
          if (c.z > hold) { c.z = hold; c.speed = 1; }
        } else if (c.wallUntil > 0) { c.wallUntil = 0; c.speed = Math.max(c.base, 1.15); }
        if (inMyLane && c.speed < 1 && c.z > -6 && c.z < 2 && nowMs >= c.nextAllowed) {
          const dir = Math.round(c.lane) + 1 < laneN2 ? 1 : -1;
          c.from = Math.round(c.lane); c.to = Math.round(c.lane) + dir; c.signalUntil = nowMs + 200; c.changeStart = nowMs + 200; c.changeDur = 700; c.zTo = null; c.nextAllowed = nowMs + 3000;
          c.speed = Math.max(c.speed, 0.9);
        }
        if (c.z < -ROAD_AHEAD * 0.9) { c.z = 30; c.speed = c.base; c.wallUntil = 0; }
        if (c.z > 40) { c.z = -ROAD_AHEAD * 0.85; c.speed = c.base; c.wallUntil = 0; }
      }
      c.lane = clamp(c.lane, 0, laneN2 - 1);
      const signaling = nowMs < c.signalUntil;
      c.model.edgeMat.color.set(signaling && Math.floor(nowMs / 120) % 2 === 0 ? 0xffb020 : c.edge);
      // Update 27: brake lights on a car that is slowing or holding as a wall, so the print against me reads as braking
      c.model.brakes.emissiveIntensity = nowMs < c.wallUntil || c.speed < c.base - 0.05 ? 2 : 0;
      const bigK = nowMs < c.bigUntil ? 1.35 : 1;
      c.model.g.scale.setScalar(lerp(c.model.g.scale.x, bigK, clamp(dt * 3, 0, 1)));
      c.model.g.position.set(this.seatX(c.lane, laneN2), yAt(c.z), c.z);
    }

    // headway tint on the sky
    const col = new THREE.Color(HEADWAY_RGB[o.color]);
    const flashBg = Math.floor(nowMs / 120) % 2 === 0 ? 1 : 0.15;
    (this.scene.background as THREE.Color).set(0x06040f).lerp(col, o.color === 'red' ? 0.18 * flashBg : o.color === 'orange' ? 0.08 : this.clearT * 0.03);
    this.fog.color.copy(this.scene.background as THREE.Color);

    this.renderer.render(this.scene, this.camera);
    this.rearShown = o.chase && !top && this.height > 4;
    if (this.rearShown) {
      // CHASE (Update 16): the mirror strip: the scene again through the rear camera, into a band near the top
      const r = this.renderer;
      const sh = Math.max(2, Math.round(this.height * this.rearH));
      const y = Math.round(this.height * (1 - REAR_TOP)) - sh; // GL viewports count from the bottom
      r.autoClear = false;
      r.setScissorTest(true);
      const x0 = Math.round(this.width * (1 - this.rearW) / 2), sw = Math.max(2, Math.round(this.width * this.rearW));
      r.setScissor(x0, y, sw, sh);
      r.setViewport(x0, y, sw, sh);
      r.clear(true, true, false);
      r.render(this.scene, this.rearCam);
      r.setScissorTest(false);
      r.setViewport(0, 0, this.width, this.height);
      r.autoClear = true;
    }
  }
}
