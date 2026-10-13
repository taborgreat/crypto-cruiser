// Phase 0 console tool.
//   npm run feed                                              print every oracle tick {t, price} (also kept in data/ticks/)
//   npm run console -- --market SOL --side short --lev 100 --collateral 50 [--bankroll 1000] [--feed auto]
// Keys while driving: w gas | W hard gas | s brake | space full brake | c back off | x withdraw | t cruise | q quit
import { Kinematics, headwayColor } from '../shared/kinematics.js';
import { deriveHorizon } from '../shared/horizon.js';
import { DEFAULT_SETTINGS, type Market, type PedalAction, type Side, type Tick } from '../shared/types.js';
import { FeedManager } from './feed/manager.js';
import { LayerManager } from './layers.js';
import { PaperEngine } from './engine/paper.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const marketArg = arg('market', 'SOL').toUpperCase();
const market: Market = marketArg === 'ETH' ? 'ETH-PERP' : marketArg === 'BTC' ? 'BTC-PERP' : 'SOL-PERP';
const side: Side = arg('side', 'short') === 'long' ? 1 : -1;
const leverage = Number(arg('lev', '100'));
const collateralUsd = Number(arg('collateral', '50'));
const bankroll = Number(arg('bankroll', '1000'));
const feedPref = arg('feed', 'auto') as typeof DEFAULT_SETTINGS.feed;
const feedOnly = has('feed-only');

const settings = structuredClone(DEFAULT_SETTINGS);
const d = deriveHorizon(settings.horizonSec);
const feed = new FeedManager();
const layers = new LayerManager();
const engine = new PaperEngine(bankroll);
const kin = new Kinematics({ velocityEmaSec: d.tauFast, accelEmaSec: d.tauAccel, trendEmaSec: d.tauSlow, roadK: settings.roadK, roadMin: settings.roadMin });

const C = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', orange: '\x1b[38;5;208m', red: '\x1b[31;1m', dim: '\x1b[2m' };
const fmtH = (h: number) => (Number.isFinite(h) ? h.toFixed(1).padStart(6) + 's' : '    ∞  ');

let opened = false;
let lastPrint = 0;

feed.on('tick', (t: Tick) => {
  layers.onTick(t);
  if (feedOnly) console.log(JSON.stringify({ t: t.t, price: t.price, source: t.source }));
});
feed.on('quote', (t: Tick) => layers.onQuote(t));
feed.start(market, feedPref);
void FeedManager.loadHistory(market).then((rows) => { feed.seedHistory(rows); return layers.init(market, feed.history, settings.atrWindow); });
console.log(`TRAFFIC console | ${market} | feed ${feedPref} | tick history ${FeedManager.tickLogPath(market)}`);
if (feedOnly) console.log('feed-only: printing every oracle update. Ctrl+C to stop.');
else console.log(`${side === 1 ? 'LONG' : 'SHORT'} ${leverage}x with $${collateralUsd} — waiting for first tick...`);

const timer = setInterval(async () => {
  if (feedOnly) return;
  const lt = feed.lastTick;
  if (!lt) return;
  const t = Date.now();
  if (!opened) {
    const r = await engine.open({ market, side, leverage, collateralUsd }, lt.price);
    console.log(r.message);
    if (!r.ok) { shutdown(); return; }
    opened = true;
    kin.reset();
  }
  const pos = engine.position;
  if (!pos) return;
  const events = engine.tick(t, lt.price, layers.hourlyRate(side));
  for (const ev of events) console.log(`\n${C.red}${ev.kind.toUpperCase()}${C.reset} ${ev.message}`);
  const p = engine.position;
  if (!p) { console.log(`bankroll now $${engine.bankrollUsd.toFixed(2)}`); shutdown(); return; }
  const atr = layers.atr(settings.atrWindow);
  const k = kin.tick({ t, price: lt.price, side, entry: p.entry, liq: p.liq, leverage: p.leverage, atrRate: atr === null ? null : atr / 60 });
  if (t - lastPrint < 500) return;
  lastPrint = t;
  const col = headwayColor(Math.min(k.headway_s, k.headway_proj_s), d.thr);
  const color = C[col];
  const line =
    `${C.dim}${new Date(t).toISOString().slice(11, 19)}${C.reset} ` +
    `${lt.source.padEnd(8)} P ${lt.price.toFixed(4).padStart(10)} liq ${p.liq.toFixed(4).padStart(10)} ` +
    `L ${p.leverage.toFixed(1).padStart(6)}x gap ${k.gap.toFixed(3).padStart(7)} v_close ${k.v_close.toFixed(4).padStart(8)} ` +
    `${color}headway ${fmtH(k.headway_s)} proj ${fmtH(k.headway_proj_s)}${C.reset} ` +
    `pnl ${(k.fav * p.leverage * 100).toFixed(1).padStart(7)}% fees $${(p.borrowFeeUsd + p.closeFeeUsd).toFixed(3)} ` +
    `atr ${atr === null ? '  n/a ' : (atr * 100).toFixed(3) + '%'}`;
  process.stdout.write(line + '\n');
}, settings.tickMs);

function shutdown(): void {
  clearInterval(timer);
  feed.stop();
  layers.stop();
  try { process.stdin.setRawMode(false); } catch { /* not a tty */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (key: string) => {
    const lt = feed.lastTick;
    const map: Record<string, PedalAction> = { w: 'gas_light', W: 'gas_hard', s: 'brake_light', ' ': 'brake_full', c: 'coast', x: 'withdraw', t: 'cruise', T: 'cruise_off' };
    if (key === 'q' || key === '\u0003') { shutdown(); return; }
    const action = map[key];
    if (!action || !lt || feedOnly) return;
    const r = await engine.pedal(action, lt.price, settings.pedal, settings.maxSlippageBps);
    console.log(`\n${r.ok ? '' : C.red}${action}: ${r.message}${C.reset}`);
    for (const ev of r.events ?? []) if (ev.kind === 'closed' || ev.kind === 'liquidated') { console.log(`bankroll now $${engine.bankrollUsd.toFixed(2)}`); shutdown(); }
  });
}
