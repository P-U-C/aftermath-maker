export type QuoteSizedMarket = {
  overrides?: { quoteSizeUsd?: number };
};

/** Worst case from all resting market quotes plus the largest inventory. */
export function suggestedGrossExposureLimit(
  markets: readonly QuoteSizedMarket[],
  quoteSizeUsd: number,
  maxInventoryUsd: number,
): number {
  return (
    markets.reduce(
      (total, market) =>
        total + (market.overrides?.quoteSizeUsd ?? quoteSizeUsd),
      0,
    ) + maxInventoryUsd
  );
}

export function quoteExposureUsed(
  markets: readonly QuoteSizedMarket[],
  quoteSizeUsd: number,
): number {
  return markets.reduce(
    (total, market) => total + (market.overrides?.quoteSizeUsd ?? quoteSizeUsd),
    0,
  );
}
