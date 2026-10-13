// Update 6, units policy: the metaphor is in the picture, never in the numbers. Everything a human reads
// is USD, SOL, price, %, or seconds. One formatter module, used by the server (readouts, toasts) and the
// browser (HUD, tooltips, chart).

/** Money: 2 decimals under $1,000, thousands separators above. */
export function money(v: number | null | undefined, dp?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = dp ?? (a < 1000 ? 2 : a < 100_000 ? 2 : 0);
  const s = a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${v < 0 ? '−' : ''}$${s}`;
}

/** Signed money with an explicit + for gains. */
export function smoney(v: number | null | undefined, dp?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + money(v, dp);
}

/** Percent: 2 dp below 1%, 1 dp above. */
export function pct(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a < 1 ? 2 : 1;
  const s = a.toFixed(d);
  return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}${s}%`;
}

/** Price at the asset's native precision (SOL 3 dp, ETH 2 dp, BTC 1 dp); falls back on magnitude. */
export function price(p: number | null | undefined, dp?: number): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  const d = dp ?? (p >= 10_000 ? 1 : p >= 1000 ? 2 : 3);
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** SOL / token amounts: 2–3 decimals. */
export function sol(v: number | null | undefined, symbol = 'SOL'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 100 ? 2 : 3;
  return `${v < 0 ? '−' : ''}${a.toFixed(d)} ${symbol}`;
}

/** Time spans: `28 s`, `28 m 10 s`, `1 h 12 m`, `2 d 3 h`. Infinity / null = `not closing`. */
export function timeSpan(sec: number | null | undefined, infinityWord = 'not closing'): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return infinityWord;
  if (sec < 0) sec = 0;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`;
  if (sec < 3600) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return `${m} m ${s} s`; }
  if (sec < 86_400) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return `${h} h ${m} m`; }
  const d = Math.floor(sec / 86_400), h = Math.round((sec % 86_400) / 3600);
  return `${d} d ${h} h`;
}

/** Spoken-style spans for lane labels: `10 s`, `1 m`, `1 m 30 s`, `1 h`, `1 h 12 m`, `3 d`. */
export function agoSpan(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return s ? `${m} m ${s} s` : `${m} m`; }
  if (sec < 86_400) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return m ? `${h} h ${m} m` : `${h} h`; }
  const d = Math.floor(sec / 86_400), h = Math.round((sec % 86_400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** Short time spans for chips/labels: `10s`, `5m`, `1h`, `3d`, `1w`. */
export function shortSpan(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${+(sec / 3600).toFixed(sec % 3600 ? 1 : 0)}h`;
  if (sec < 604_800) return `${+(sec / 86_400).toFixed(sec % 86_400 ? 1 : 0)}d`;
  return `${+(sec / 604_800).toFixed(1)}w`;
}

/** Rate unit by horizon: /s under 1 min, /min under 1 h, /h above. */
export function rateUnit(horizonSec: number): { unit: string; mul: number } {
  if (horizonSec < 60) return { unit: '/s', mul: 1 };
  if (horizonSec < 3600) return { unit: '/min', mul: 60 };
  return { unit: '/h', mul: 3600 };
}

/** A per-second rate shown at the horizon's unit: `$0.013/s`, `0.12%/min`. */
export function rate(perSec: number, horizonSec: number, kind: 'money' | 'pct'): string {
  const { unit, mul } = rateUnit(horizonSec);
  const v = perSec * mul;
  if (kind === 'money') return `${smoney(v, Math.abs(v) < 0.1 ? 3 : 2)}${unit}`;
  return `${pct(v, true)}${unit}`;
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function dateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
