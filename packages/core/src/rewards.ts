export type RewardMarketEvidence = {
  marketId: string;
  symbol: string;
  indexPrice: number;
  volume24hUsd: number | null;
  openInterestUsd: number;
  openInterestUtilizationPct: number | null;
  fundingRate: number;
  priceChange24hPct: number | null;
  makerFee: number;
  sessionOpen: boolean | null;
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth50BpsUsd: number;
  askDepth50BpsUsd: number;
  error: string | null;
};

export type RewardMarketOpportunity = {
  rank: number;
  marketId: string;
  symbol: string;
  score: number;
  confidence: "high" | "medium" | "low";
  eligible: boolean;
  sessionOpen: boolean | null;
  observedSpreadBps: number | null;
  balancedDepth50BpsUsd: number;
  volume24hUsd: number | null;
  openInterestUsd: number;
  openInterestUtilizationPct: number | null;
  volumeToDepth: number | null;
  fundingRate: number;
  priceChange24hPct: number | null;
  makerRebateBps: number;
  builderFeeBps: number;
  knownCostBps: number;
  suggestedSpreadBps: number;
  suggestedQuoteSizeUsd: number;
  reasons: string[];
  error: string | null;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const round = (value: number, decimals = 2) => Number(value.toFixed(decimals));

function percentile(value: number, values: number[]): number {
  if (values.length <= 1) return 0.5;
  const sorted = [...values].sort((left, right) => left - right);
  const below = sorted.filter((candidate) => candidate < value).length;
  const equal = sorted.filter((candidate) => candidate === value).length;
  return (below + Math.max(0, equal - 1) / 2) / (sorted.length - 1);
}

function observedSpreadBps(
  bestBid: number | null,
  bestAsk: number | null,
): number | null {
  if (
    bestBid === null ||
    bestAsk === null ||
    bestBid <= 0 ||
    bestAsk <= bestBid
  ) {
    return null;
  }
  const midpoint = (bestBid + bestAsk) / 2;
  return ((bestAsk - bestBid) / midpoint) * 10_000;
}

export function rankRewardMarkets(inputs: {
  markets: RewardMarketEvidence[];
  builderFeeBps: number;
}): RewardMarketOpportunity[] {
  const rows = inputs.markets.map((market) => {
    const balancedDepth50BpsUsd = Math.min(
      market.bidDepth50BpsUsd,
      market.askDepth50BpsUsd,
    );
    const spreadBps = observedSpreadBps(market.bestBid, market.bestAsk);
    const volumeToDepth =
      market.volume24hUsd !== null
        ? market.volume24hUsd / Math.max(25, balancedDepth50BpsUsd)
        : null;
    return {
      market,
      balancedDepth50BpsUsd,
      spreadBps,
      volumeToDepth,
    };
  });

  const logValues = (values: Array<number | null>) =>
    values
      .filter((value): value is number => value !== null && value >= 0)
      .map((value) => Math.log1p(value));

  const volumeValues = logValues(rows.map((row) => row.market.volume24hUsd));
  const efficiencyValues = logValues(rows.map((row) => row.volumeToDepth));
  const depthValues = logValues(rows.map((row) => row.balancedDepth50BpsUsd));
  const movementValues = rows
    .map((row) => Math.abs(row.market.priceChange24hPct ?? Number.NaN))
    .filter(Number.isFinite);
  const fundingValues = rows
    .map((row) => Math.abs(row.market.fundingRate))
    .filter(Number.isFinite);

  const opportunities = rows.map(
    ({ market, balancedDepth50BpsUsd, spreadBps, volumeToDepth }) => {
      const volumeScore =
        market.volume24hUsd === null
          ? 0
          : percentile(Math.log1p(market.volume24hUsd), volumeValues) * 100;
      const efficiencyScore =
        volumeToDepth === null
          ? 0
          : percentile(Math.log1p(volumeToDepth), efficiencyValues) * 100;
      const competitionScore =
        100 - percentile(Math.log1p(balancedDepth50BpsUsd), depthValues) * 100;
      const stabilityScore =
        100 -
        percentile(
          Math.abs(market.priceChange24hPct ?? Number.POSITIVE_INFINITY),
          movementValues,
        ) *
          100;
      const fundingScore =
        100 - percentile(Math.abs(market.fundingRate), fundingValues) * 100;
      const capacityScore =
        market.openInterestUtilizationPct === null
          ? 50
          : 100 - clamp(market.openInterestUtilizationPct, 0, 100);
      const bookBalance =
        Math.max(market.bidDepth50BpsUsd, market.askDepth50BpsUsd) > 0
          ? (balancedDepth50BpsUsd /
              Math.max(market.bidDepth50BpsUsd, market.askDepth50BpsUsd)) *
            100
          : 0;
      const spreadOpportunity =
        spreadBps === null
          ? 0
          : spreadBps <= 40
            ? clamp((spreadBps / 40) * 100, 20, 100)
            : clamp(100 - (spreadBps - 40) * 0.75, 20, 100);

      const eligible = Boolean(
        !market.error &&
        market.sessionOpen !== false &&
        spreadBps !== null &&
        (market.volume24hUsd ?? 0) >= 1_000 &&
        market.openInterestUsd > 0 &&
        balancedDepth50BpsUsd >= 10,
      );
      const coverage = [
        market.volume24hUsd !== null,
        market.priceChange24hPct !== null,
        market.openInterestUtilizationPct !== null,
        spreadBps !== null,
        balancedDepth50BpsUsd > 0,
      ].filter(Boolean).length;
      const confidence: RewardMarketOpportunity["confidence"] =
        coverage === 5 &&
        (market.volume24hUsd ?? 0) >= 10_000 &&
        balancedDepth50BpsUsd >= 100
          ? "high"
          : coverage >= 4 && eligible
            ? "medium"
            : "low";

      let score =
        volumeScore * 0.25 +
        efficiencyScore * 0.25 +
        competitionScore * 0.15 +
        stabilityScore * 0.1 +
        fundingScore * 0.08 +
        capacityScore * 0.07 +
        bookBalance * 0.05 +
        spreadOpportunity * 0.05;
      if (!eligible) score *= 0.35;
      if (confidence === "low") score *= 0.8;

      const reasons: string[] = [];
      if (efficiencyScore >= 66) {
        reasons.push("Strong organic flow per dollar near the book");
      }
      if (competitionScore >= 66) {
        reasons.push("Less capital concentrated within 50 bps");
      }
      if (stabilityScore >= 66) {
        reasons.push("Lower 24h movement than most listed markets");
      }
      if (fundingScore < 34) {
        reasons.push("Elevated funding adds inventory carry risk");
      }
      if (market.sessionOpen === false) {
        reasons.push("Market session is closed");
      } else if (!eligible) {
        reasons.push(
          market.error ??
            "Insufficient two-sided depth, open interest, or organic volume",
        );
      }
      if (!reasons.length) {
        reasons.push("Balanced flow, competition, and inventory risk");
      }

      const makerRebateBps = Math.max(0, -market.makerFee * 10_000);
      const knownCostBps = market.makerFee * 10_000 + inputs.builderFeeBps;
      const suggestedSpreadBps = Math.round(
        clamp(Math.max(8, (spreadBps ?? 30) * 0.9), 8, 80),
      );
      const suggestedQuoteSizeUsd = round(
        clamp(Math.sqrt(Math.max(0, balancedDepth50BpsUsd)) * 1.5, 5, 100),
        0,
      );

      return {
        rank: 0,
        marketId: market.marketId,
        symbol: market.symbol,
        score: round(score, 1),
        confidence,
        eligible,
        sessionOpen: market.sessionOpen,
        observedSpreadBps: spreadBps === null ? null : round(spreadBps, 2),
        balancedDepth50BpsUsd: round(balancedDepth50BpsUsd),
        volume24hUsd: market.volume24hUsd,
        openInterestUsd: market.openInterestUsd,
        openInterestUtilizationPct: market.openInterestUtilizationPct,
        volumeToDepth: volumeToDepth === null ? null : round(volumeToDepth, 2),
        fundingRate: market.fundingRate,
        priceChange24hPct: market.priceChange24hPct,
        makerRebateBps: round(makerRebateBps, 2),
        builderFeeBps: round(inputs.builderFeeBps, 2),
        knownCostBps: round(knownCostBps, 2),
        suggestedSpreadBps,
        suggestedQuoteSizeUsd,
        reasons,
        error: market.error,
      };
    },
  );

  return opportunities
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      return right.score - left.score;
    })
    .map((opportunity, index) => ({ ...opportunity, rank: index + 1 }));
}

const EPOCH_ZERO_CUTOFF_MS = Date.UTC(2026, 2, 2, 5, 0, 0);
const EPOCH_LENGTH_MS = 14 * 24 * 60 * 60 * 1_000;

export function rewardEpochWindow(now = new Date()): {
  epoch: number;
  startedAt: string;
  cutoffAt: string;
} {
  const elapsed = now.getTime() - EPOCH_ZERO_CUTOFF_MS;
  const epoch = Math.max(0, Math.floor(elapsed / EPOCH_LENGTH_MS));
  const startedAt = EPOCH_ZERO_CUTOFF_MS + epoch * EPOCH_LENGTH_MS;
  return {
    epoch,
    startedAt: new Date(startedAt).toISOString(),
    cutoffAt: new Date(startedAt + EPOCH_LENGTH_MS).toISOString(),
  };
}
