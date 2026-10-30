export type MarketQuickPick =
  "rewards" | "balanced" | "quiet" | "steady" | "clear";
export type MarketSuggestionPreset =
  "rewards" | "balanced" | "steady" | "ranked";

export type QuickPickOpportunity = {
  marketId: string;
  eligible: boolean;
  objectiveEligible: boolean;
  thinActive: boolean;
  farmingScore: number;
  bothScore: number;
  priceChange24hPct: number | null;
  rank?: number;
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
      .filter((item) => item.eligible && item.objectiveEligible)
      .sort(byDescending("farmingScore"))
      .slice(0, Math.min(3, max))
      .map((item) => item.marketId);
  }
  if (pick === "balanced") {
    return sorted
      .filter((item) => item.eligible && item.objectiveEligible)
      .sort(byDescending("bothScore"))
      .slice(0, Math.min(5, max))
      .map((item) => item.marketId);
  }
  if (pick === "quiet") {
    return sorted
      .filter(
        (item) => item.eligible && item.thinActive && item.objectiveEligible,
      )
      .sort(byDescending("farmingScore"))
      .slice(0, Math.min(5, max))
      .map((item) => item.marketId);
  }

  return sorted
    .filter(
      (item) =>
        item.eligible &&
        item.objectiveEligible &&
        item.priceChange24hPct !== null,
    )
    .sort(
      (left, right) =>
        Math.abs(left.priceChange24hPct ?? Infinity) -
          Math.abs(right.priceChange24hPct ?? Infinity) ||
        left.marketId.localeCompare(right.marketId),
    )
    .slice(0, Math.min(5, max))
    .map((item) => item.marketId);
}

/** Ranked suggestion, never a save source: the UI freezes accepted IDs separately.
 * Presets select ranking; Up to N is an explicit user-adjustable maximum. */
export function suggestMarketIds(
  opportunities: readonly QuickPickOpportunity[],
  preset: MarketSuggestionPreset,
  focus: "all" | "thin",
  count: number,
): string[] {
  const eligible = opportunities.filter(
    (item) =>
      item.eligible &&
      item.objectiveEligible &&
      (focus === "all" || item.thinActive),
  );
  if (preset === "rewards") eligible.sort(byDescending("farmingScore"));
  if (preset === "balanced") eligible.sort(byDescending("bothScore"));
  if (preset === "steady") {
    eligible.splice(
      0,
      eligible.length,
      ...eligible
        .filter((item) => item.priceChange24hPct !== null)
        .sort(
          (left, right) =>
            Math.abs(left.priceChange24hPct ?? Infinity) -
              Math.abs(right.priceChange24hPct ?? Infinity) ||
            left.marketId.localeCompare(right.marketId),
        ),
    );
  }
  if (preset === "ranked")
    eligible.sort((left, right) =>
      left.rank === undefined && right.rank === undefined
        ? 0
        : (left.rank ?? Infinity) - (right.rank ?? Infinity),
    );
  // All other presets keep their score formula; rank uses service-provided rank.
  return eligible
    .slice(0, Math.min(64, Math.max(0, Math.trunc(count))))
    .map((item) => item.marketId);
}
