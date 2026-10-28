export type MarketQuickPick =
  "rewards" | "balanced" | "quiet" | "steady" | "clear";

export type QuickPickOpportunity = {
  marketId: string;
  eligible: boolean;
  objectiveEligible: boolean;
  thinActive: boolean;
  farmingScore: number;
  bothScore: number;
  priceChange24hPct: number | null;
};

const byDescending =
  (key: "farmingScore" | "bothScore") =>
  (left: QuickPickOpportunity, right: QuickPickOpportunity) =>
    right[key] - left[key] || left.marketId.localeCompare(right.marketId);

export function quickPickMarketIds(
  opportunities: readonly QuickPickOpportunity[],
  pick: MarketQuickPick,
  maxSelectedMarkets: number,
): string[] {
  const max = Math.max(0, maxSelectedMarkets);
  if (pick === "clear") return [];

  const sorted = [...opportunities];
  if (pick === "rewards") {
    return sorted
      .filter((item) => item.eligible)
      .sort(byDescending("farmingScore"))
      .slice(0, Math.min(3, max))
      .map((item) => item.marketId);
  }
  if (pick === "balanced") {
    return sorted
      .filter((item) => item.objectiveEligible)
      .sort(byDescending("bothScore"))
      .slice(0, Math.min(5, max))
      .map((item) => item.marketId);
  }
  if (pick === "quiet") {
    return sorted
      .filter((item) => item.thinActive)
      .sort(byDescending("farmingScore"))
      .slice(0, Math.min(5, max))
      .map((item) => item.marketId);
  }

  return sorted
    .filter((item) => item.eligible && item.priceChange24hPct !== null)
    .sort(
      (left, right) =>
        Math.abs(left.priceChange24hPct ?? Infinity) -
          Math.abs(right.priceChange24hPct ?? Infinity) ||
        left.marketId.localeCompare(right.marketId),
    )
    .slice(0, Math.min(5, max))
    .map((item) => item.marketId);
}
