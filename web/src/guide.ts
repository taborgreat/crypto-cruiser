// Update 18: the watcher's guide on the CONDITIONS page. Plain words from the seven rows: what the tape is
// doing on each horizon, the signals that matter with a clear sign, the risk at the leverage you have dialled
// against a normal move on each horizon, and the levels to watch. Readable, not a meme, not a data dump.
import { HORIZONS, type ConditionRow, type ConditionsState, type HorizonKey } from '../../shared/conditions.js';
import { fmtPct, fmtPrice } from './format.js';

type Tone = 'good' | 'bad' | 'warn' | 'neutral';
interface Signal { icon: string; text: string; tone: Tone }

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function sig(icon: string, text: string, tone: Tone): Signal { return { icon, text, tone }; }
function sideWord(t: 'rising' | 'falling' | 'flat'): string { return t === 'rising' ? 'up' : t === 'falling' ? 'down' : 'flat'; }

/** One plain sentence for a horizon row. */
function readRow(r: ConditionRow): string {
  if (!r.ok) return `${r.h}: not enough bars yet (${r.bars})`;
  const where = r.range === 'mid' ? 'mid-range' : r.range === 'at highs' ? 'at the highs' : r.range === 'at lows' ? 'at the lows' : `in the ${r.range} part of the range`;
  const stretch = Math.abs(r.stretch) < 0.5 ? 'sitting on its average' : `stretched ${r.stretch > 0 ? 'above' : 'below'} its average by ${Math.abs(r.stretch).toFixed(1)} ATR and ${r.accel > 0.05 ? 'still going' : r.accel < -0.05 ? 'fading' : 'holding'}`;
  return `${r.h}: ${where}, trend ${sideWord(r.trend_label)}, tape ${r.activity_label}, ${stretch}.`;
}

export function buildGuide(st: ConditionsState, price: number, leverage: number, dp: number): string {
  const by = (k: HorizonKey): ConditionRow | undefined => st.rows.find((r) => r.h === k && r.ok);
  const r15 = by('15m'), r1h = by('1h'), r4h = by('4h'), r1d = by('1d'), r1w = by('1w');
  const bias = st.side === 1 ? 'LONG' : st.side === -1 ? 'SHORT' : st.sentence.startsWith('WAIT') ? 'WAIT' : st.sentence.startsWith('MIXED') ? 'MIXED' : 'NO EDGE';
  const biasTone: Tone = st.side === 1 ? 'good' : st.side === -1 ? 'bad' : 'warn';

  // ---- the read, by group
  const groups: Array<[string, HorizonKey[]]> = [['LOCAL · the next minutes', ['1m', '15m']], ['MEDIUM · the next hours', ['1h', '4h']], ['LONG · the week and beyond', ['1d', '1w', '1y']]];
  const read = groups.map(([title, keys]) => `<div class="guide-group"><h5>${title}</h5>${keys.map((k) => { const r = st.rows.find((x) => x.h === k); return `<p>${esc(r ? readRow(r) : `${k}: —`)}</p>`; }).join('')}</div>`).join('');

  // ---- signals
  const signals: Signal[] = [];
  if (r1h && r4h) {
    if (r1h.trend_label === r4h.trend_label && r1h.trend_label !== 'flat') signals.push(sig(r1h.trend_label === 'rising' ? '▲' : '▼', `1 h and 4 h agree: the trend is ${sideWord(r1h.trend_label)}. Trades with it have the wind; trades against it are fades.`, r1h.trend_label === 'rising' ? 'good' : 'bad'));
    else signals.push(sig('●', `1 h (${sideWord(r1h.trend_label)}) and 4 h (${sideWord(r4h.trend_label)}) disagree: no trend edge for the next hours.`, 'neutral'));
  }
  if (r15) {
    if (r15.range === 'at highs' || r15.range === 'high') signals.push(sig('▼', `Price is ${r15.range === 'at highs' ? 'at' : 'near'} the highs of the 15 m range (${fmtPrice(r15.low, dp)} – ${fmtPrice(r15.high, dp)}): shorts have the range on their side, longs are chasing.`, 'bad'));
    else if (r15.range === 'at lows' || r15.range === 'low') signals.push(sig('▲', `Price is ${r15.range === 'at lows' ? 'at' : 'near'} the lows of the 15 m range (${fmtPrice(r15.low, dp)} – ${fmtPrice(r15.high, dp)}): longs have the range on their side, shorts are chasing.`, 'good'));
    else signals.push(sig('●', `Mid-range on 15 m (${fmtPrice(r15.low, dp)} – ${fmtPrice(r15.high, dp)}): the range gives no edge here.`, 'neutral'));
    if (Math.abs(r15.stretch) >= 1.5) {
      const dir = r15.stretch > 0 ? 'up' : 'down';
      if (r15.accel < -0.05) signals.push(sig('↩', `The ${dir} move is stretched ${Math.abs(r15.stretch).toFixed(1)} ATR and fading: a snap-back setup for the other side, with a tight stop.`, 'warn'));
      else signals.push(sig('→', `The ${dir} move is stretched ${Math.abs(r15.stretch).toFixed(1)} ATR and still accelerating: do not fade it; with it only, and quick.`, 'warn'));
    }
  }
  if (r1h) {
    if (r1h.activity_label === 'hot' || r1h.activity_label === 'active') signals.push(sig('⚡', `The tape is ${r1h.activity_label}: moves are ${r1h.activity.toFixed(1)}× their normal size. Room runs out faster than usual.`, 'warn'));
    else if (r1h.activity_label === 'dead' || r1h.activity_label === 'quiet') signals.push(sig('…', `The tape is ${r1h.activity_label} (${r1h.activity.toFixed(1)}× normal): the move a high-leverage trade needs may simply not come.`, 'neutral'));
  }
  if (r1d && r1w) signals.push(sig(r1d.trend_label === 'rising' ? '▲' : r1d.trend_label === 'falling' ? '▼' : '●', `Bigger picture: ${sideWord(r1d.trend_label)} on the day, ${r1w.range} of the week's range.`, r1d.trend_label === 'rising' ? 'good' : r1d.trend_label === 'falling' ? 'bad' : 'neutral'));

  // ---- risk at this leverage: the room to liquidation against a normal move on each horizon
  const room = (100 / Math.max(1.1, leverage)) * 0.92; // % of price, roughly: 1/L less the maintenance margin and fees
  const riskRows = (['1m', '15m', '1h', '4h'] as HorizonKey[]).map((k) => {
    const r = by(k);
    if (!r || price <= 0) return `<div class="risk neutral"><span>${k}</span><span>—</span></div>`;
    const atrPct = (r.atr / price) * 100;
    const ratio = atrPct > 0 ? room / atrPct : Infinity;
    const tone: Tone = ratio < 1 ? 'bad' : ratio < 2.5 ? 'warn' : 'good';
    const words = ratio < 1 ? 'one normal move liquidates you' : ratio < 2.5 ? 'a normal move takes most of your room' : 'a normal move leaves room';
    return `<div class="risk ${tone}"><span>${k}</span><span>a normal ${k} move is ${fmtPct(atrPct)}</span><span>${Number.isFinite(ratio) ? ratio.toFixed(1) + '× your room' : '—'}</span><span>${words}</span></div>`;
  }).join('');

  // ---- levels to watch
  const watch: string[] = [];
  if (r15) {
    watch.push(`A 15 m close above <b>${fmtPrice(r15.high, dp)}</b> breaks the local range up; below <b>${fmtPrice(r15.low, dp)}</b> breaks it down.`);
  }
  if (r1h) {
    watch.push(`The 1 h average <b>${fmtPrice(r1h.ema, dp)}</b> is where the trend lives: price ${price > r1h.ema ? 'above' : 'below'} it keeps the ${sideWord(r1h.trend_label)} read.`);
    if (r1h.atr > 0) watch.push(`Two ATR from that average (<b>${fmtPrice(r1h.ema - 2 * r1h.atr, dp)}</b> / <b>${fmtPrice(r1h.ema + 2 * r1h.atr, dp)}</b>) is where stretched moves tend to snap back.`);
  }
  if (r4h) watch.push(`The 4 h range: <b>${fmtPrice(r4h.low, dp)}</b> – <b>${fmtPrice(r4h.high, dp)}</b>; price is ${Math.round(r4h.range_pos * 100)}% of the way up it.`);

  return `
    <div class="guide-card bias"><h4>BIAS</h4><div class="bias-word ${biasTone}">${esc(bias)}</div><p>${esc(st.reason)}</p><p class="muted">rule ${st.rule} of the stack · the read is of the tape, not of your side</p></div>
    <div class="guide-card"><h4>THE READ</h4>${read}</div>
    <div class="guide-card"><h4>SIGNALS</h4>${signals.length ? signals.map((s) => `<div class="sig ${s.tone}"><span class="ic">${s.icon}</span><span>${esc(s.text)}</span></div>`).join('') : '<p class="muted">warming up</p>'}</div>
    <div class="guide-card"><h4>RISK AT ${Math.round(leverage)}×</h4><p>Your liquidation is about <b>${fmtPct(room)}</b> away (${fmtPrice(price * (1 - room / 100), dp)} / ${fmtPrice(price * (1 + room / 100), dp)}).</p>${riskRows}</div>
    <div class="guide-card"><h4>WATCH</h4>${watch.map((w) => `<p>${w}</p>`).join('') || '<p class="muted">warming up</p>'}</div>`;
}

export const GUIDE_HORIZONS = HORIZONS.map((h) => h.key);
