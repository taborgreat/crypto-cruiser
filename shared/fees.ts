// Position accounting helpers. (The 5% win fee / savings wallet was removed: personal use, no operator.)
/** Lifetime realized P&L of a position: everything returned minus everything contributed. */
export function lifetimeRealized(collateralReturnedUsd: number, collateralContributedUsd: number): number {
  return collateralReturnedUsd - collateralContributedUsd;
}
