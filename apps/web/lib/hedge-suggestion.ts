/** A conservative draft suggestion, never a readiness decision or executable action. */
export function hedgeSizingSuggestion(inputs: {
  markets: readonly { quoteSizeUsd: number; minimumOrderUsd: number | null }[];
  bundles: readonly {
    name: string;
    makerAccountId: string | null;
    hedgeAccountId: string | null;
    authorizedMaker: boolean;
    authorizedHedge: boolean;
    hedgeAvailableUsd: number | null;
  }[];
}): { thresholdUsd: number; maxOrderUsd: number } | { blocker: string } {
  if (!inputs.markets.length) return { blocker: "Select markets first." };
  if (!inputs.bundles.length)
    return { blocker: "Attach a bundle before sizing its hedge account." };
  if (
    inputs.markets.some(
      (market) =>
        !Number.isFinite(market.minimumOrderUsd) ||
        !market.minimumOrderUsd ||
        market.minimumOrderUsd <= 0,
    )
  )
    return {
      blocker:
        "A market's venue minimum order size is unknown; verify it before suggesting hedge amounts.",
    };
  const largestQuote = Math.max(
    ...inputs.markets.map((market) => market.quoteSizeUsd),
  );
  const venueMinimum = Math.max(
    ...inputs.markets.map((market) => market.minimumOrderUsd!),
  );
  const thresholdUsd =
    Math.ceil(Math.max(venueMinimum, largestQuote / 2) * 100) / 100;
  const maxOrderUsd =
    Math.ceil(Math.max(thresholdUsd, largestQuote) * 100) / 100;
  if (maxOrderUsd > 10_000)
    return {
      blocker:
        "Suggested hedge order exceeds the existing $10,000 schema ceiling.",
    };
  const missing = inputs.bundles.find(
    (bundle) =>
      !bundle.makerAccountId ||
      !bundle.hedgeAccountId ||
      bundle.makerAccountId === bundle.hedgeAccountId ||
      !bundle.authorizedMaker ||
      !bundle.authorizedHedge,
  );
  if (missing)
    return {
      blocker: `${missing.name} needs distinct authorized Maker and hedge accounts.`,
    };
  const unfunded = inputs.bundles.find(
    (bundle) =>
      bundle.hedgeAvailableUsd === null ||
      bundle.hedgeAvailableUsd < maxOrderUsd,
  );
  if (unfunded)
    return {
      blocker: `${unfunded.name}'s hedge account has unavailable or insufficient collateral for the ${maxOrderUsd.toFixed(2)} USD suggested order at 1x. Check live account state.`,
    };
  return { thresholdUsd, maxOrderUsd };
}
