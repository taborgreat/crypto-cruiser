// Update 12: take profit / stop loss, partial. Pure helpers shared by the server watcher and the panel.
import type { Side } from './types.js';

/** A take profit fills when the price reaches its favourable side; a stop loss when it reaches its adverse side. */
export function exitHit(kind: 'tp' | 'sl', side: Side, price: number, exitPrice: number): boolean {
  if (kind === 'tp') return side === 1 ? price >= exitPrice : price <= exitPrice;
  return side === 1 ? price <= exitPrice : price >= exitPrice;
}

/** The price `pctFrac` (0.01 = 1%) away from the mark in the right direction for the kind and side. */
export function exitPriceFromPct(kind: 'tp' | 'sl', side: Side, mark: number, pctFrac: number): number {
  const dir = kind === 'tp' ? side : -side;
  return mark * (1 + dir * Math.abs(pctFrac));
}

/** Is `price` on the correct side of the mark for this kind of exit? */
export function exitWellPlaced(kind: 'tp' | 'sl', side: Side, mark: number, price: number): boolean {
  const favorable = side * (price - mark) > 0;
  return kind === 'tp' ? favorable : !favorable;
}
