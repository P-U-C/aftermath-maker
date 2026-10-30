/** Only venue-visible order IDs that this tenant recorded as Maker-owned count
 * as confirmed resting. Historical attribution records alone are not enough. */
export function confirmedRestingMarketIds(
  positions: readonly {
    marketId: string;
    makerOrderIds: readonly (string | bigint)[];
  }[],
  tracked: readonly { marketId: string; orderId: string }[],
): string[] {
  const owned = new Set(
    tracked.map((order) => `${order.marketId}:${order.orderId}`),
  );
  return positions
    .filter((position) =>
      position.makerOrderIds.some((id) =>
        owned.has(`${position.marketId}:${String(id)}`),
      ),
    )
    .map((position) => position.marketId);
}
