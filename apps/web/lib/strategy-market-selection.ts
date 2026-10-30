/** A ranked suggestion changes selection only after the user accepts it.
 * Keep the draft's order and per-market exceptions for markets that remain. */
export function selectDraftMarkets<
  T extends { marketId: string; symbol: string },
>(
  ids: readonly string[],
  draft: readonly T[],
  catalog: readonly { id: string; symbol: string }[],
): T[] {
  const current = new Map(draft.map((market) => [market.marketId, market]));
  const available = new Map(catalog.map((market) => [market.id, market]));
  return [...new Set(ids)].flatMap((id) => {
    const existing = current.get(id);
    if (existing) return [existing];
    const market = available.get(id);
    return market ? [{ marketId: id, symbol: market.symbol } as T] : [];
  });
}

/** Never resolve a live ranking when saving an existing strategy. */
export function draftMarketsForSave<T extends { marketId: string }>(
  draft: readonly T[],
): T[] {
  return draft.map((market) => ({ ...market }));
}
