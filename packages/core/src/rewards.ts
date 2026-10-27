import type { StrategyObjective } from "./schema.js";

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
  objective: StrategyObjective;
  score: number;
  farmingScore: number;
  profitScore: number;
  bothScore: number;
  confidence: "high" | "medium" | "low";
  eligible: boolean;
  objectiveEligible: boolean;
  thinActive: boolean;
  sessionOpen: boolean | null;
  observedSpreadBps: number | null;
  preRiskEdgeBps: number | null;
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

export const THIN_ACTIVE_MAX_DEPTH_USD = 1_000;

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

function harmonicMean(left: number, right: number): number {
  if (left <= 0 || right <= 0) return 0;
  return (2 * left * right) / (left + right);
}

function objectiveScore(
  objective: StrategyObjective,
  scores: { farming: number; profit: number; both: number },
): number {
  return scores[objective];
}

export function rankRewardMarkets(inputs: {
  markets: RewardMarketEvidence[];
  builderFeeBps: number;
  objective?: StrategyObjective;
}): RewardMarketOpportunity[] {
  const objective = inputs.objective ?? "both";
  const rows = inputs.markets.map((market) => {
    const balancedDepth50BpsUsd = Math.min(
      market.bidDepth50BpsUsd,
      market.askDepth50BpsUsd,
    );
    const spreadBps = observedSpreadBps(market.bestBid, market.bestAsk);
    const knownCostBps = market.makerFee * 10_000 + inputs.builderFeeBps;
    const preRiskEdgeBps =
      spreadBps === null ? null : spreadBps / 2 - knownCostBps;
    const volumeToDepth =
      market.volume24hUsd !== null
        ? market.volume24hUsd / Math.max(25, balancedDepth50BpsUsd)
        : null;
    return {
      market,
      balancedDepth50BpsUsd,
      spreadBps,
      knownCostBps,
      preRiskEdgeBps,
      volumeToDepth,
    };
  });

  const logValues = (values: Array<number | null>) =>
    values
      .filter((value): value is number => value !== null && value >= 0)
      .map((value) => Math.log1p(value));

  const isEligible = (row: (typeof rows)[number]) =>
    Boolean(
      !row.market.error &&
      row.market.sessionOpen !== false &&
      row.spreadBps !== null &&
      (row.market.volume24hUsd ?? 0) >= 10_000 &&
      row.market.openInterestUsd > 0 &&
      row.balancedDepth50BpsUsd >= 100,
    );
  const eligibleRows = rows.filter(isEligible);
  const comparisonRows = eligibleRows.length ? eligibleRows : rows;

  const volumeValues = logValues(
    comparisonRows.map((row) => row.market.volume24hUsd),
  );
  const efficiencyValues = logValues(
    comparisonRows.map((row) => row.volumeToDepth),
  );
  const depthValues = logValues(
    comparisonRows.map((row) => row.balancedDepth50BpsUsd),
  );
  const movementValues = comparisonRows
    .map((row) => Math.abs(row.market.priceChange24hPct ?? Number.NaN))
    .filter(Number.isFinite);
  const fundingValues = comparisonRows
    .map((row) => Math.abs(row.market.fundingRate))
    .filter(Number.isFinite);
  const edgeValues = comparisonRows
    .map((row) => row.preRiskEdgeBps)
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );

  const opportunities = rows.map(
    ({
      market,
      balancedDepth50BpsUsd,
      spreadBps,
      knownCostBps,
      preRiskEdgeBps,
      volumeToDepth,
    }) => {
      const volumeScore =
        market.volume24hUsd === null
          ? 0
          : percentile(Math.log1p(market.volume24hUsd), volumeValues) * 100;
      const turnoverScore =
        volumeToDepth === null
          ? 0
          : percentile(Math.log1p(volumeToDepth), efficiencyValues) * 100;
      const depthScore =
        percentile(Math.log1p(balancedDepth50BpsUsd), depthValues) * 100;
      const competitionScore = 100 - depthScore;
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
      const edgeScore =
        preRiskEdgeBps === null
          ? 0
          : clamp(preRiskEdgeBps / 20, 0, 1) * 60 +
            percentile(preRiskEdgeBps, edgeValues) * 40;

      const eligible = isEligible({
        market,
        balancedDepth50BpsUsd,
        spreadBps,
        knownCostBps,
        preRiskEdgeBps,
        volumeToDepth,
      });
      const profitEligible =
        eligible && preRiskEdgeBps !== null && preRiskEdgeBps > 0;
      const objectiveEligible =
        objective === "farming" ? eligible : profitEligible;
      const thinActive =
        eligible && balancedDepth50BpsUsd <= THIN_ACTIVE_MAX_DEPTH_USD;
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

      let farmingScore =
        volumeScore * 0.24 +
        turnoverScore * 0.3 +
        competitionScore * 0.18 +
        bookBalance * 0.1 +
        stabilityScore * 0.06 +
        fundingScore * 0.04 +
        capacityScore * 0.04 +
        spreadOpportunity * 0.04;
      let profitScore =
        edgeScore * 0.35 +
        stabilityScore * 0.2 +
        depthScore * 0.15 +
        volumeScore * 0.1 +
        fundingScore * 0.1 +
        bookBalance * 0.05 +
        capacityScore * 0.05;

      if (!eligible) {
        farmingScore *= 0.35;
        profitScore *= 0.35;
      }
      if (!profitEligible) profitScore *= 0.35;
      if (confidence === "low") {
        farmingScore *= 0.8;
        profitScore *= 0.8;
      }

      const bothScore = harmonicMean(farmingScore, profitScore);
      const scores = {
        farming: round(farmingScore, 1),
        profit: round(profitScore, 1),
        both: round(bothScore, 1),
      };

      const reasons: string[] = [];
      if (objective === "farming") {
        if (turnoverScore >= 66) {
          reasons.push("High reported flow per dollar near the book");
        }
        if (competitionScore >= 66) {
          reasons.push("Less competing capital within 50 bps");
        }
        if (knownCostBps <= 0) {
          reasons.push("Current maker and builder fees produce a known rebate");
        }
      } else {
        if (preRiskEdgeBps !== null && preRiskEdgeBps > 0) {
          reasons.push("Positive half-spread after known fill costs");
        }
        if (stabilityScore >= 66) {
          reasons.push("Lower 24h movement than most listed markets");
        }
        if (depthScore >= 66) {
          reasons.push("More two-sided exit depth than most listed markets");
        }
      }
      if (objective === "both" && farmingScore >= 50 && profitScore >= 50) {
        reasons.unshift(
          "Balanced reward efficiency and pre-risk fill economics",
        );
      }
      if (fundingScore < 34) {
        reasons.push("Elevated funding adds inventory carry risk");
      }
      if (
        spreadBps !== null &&
        preRiskEdgeBps !== null &&
        preRiskEdgeBps <= 0
      ) {
        reasons.push("Known fill costs consume the quoted half-spread");
      }
      if (market.sessionOpen === false) {
        reasons.push("Market session is closed");
      } else if (!eligible) {
        reasons.push(
          market.error ??
            "Insufficient two-sided depth, open interest, or reported volume",
        );
      }
      if (!reasons.length) {
        reasons.push("Balanced flow, execution quality, and inventory risk");
      }

      const makerRebateBps = Math.max(0, -market.makerFee * 10_000);
      const referenceSpread = spreadBps ?? 30;
      const suggestedSpreadBps = Math.round(
        objective === "farming"
          ? clamp(Math.max(8, referenceSpread * 0.75), 8, 80)
          : objective === "profit"
            ? clamp(
                Math.max(8, referenceSpread * 1.05, knownCostBps * 2 + 8),
                8,
                120,
              )
            : clamp(
                Math.max(8, referenceSpread * 0.9, knownCostBps * 2 + 6),
                8,
                100,
              ),
      );
      const baseQuoteSizeUsd = Math.min(
        Math.sqrt(Math.max(0, balancedDepth50BpsUsd)) * 1.5,
        balancedDepth50BpsUsd * 0.05,
      );
      const sizeMultiplier =
        objective === "farming" ? 1 : objective === "profit" ? 0.6 : 0.75;
      const suggestedQuoteSizeUsd = round(
        clamp(baseQuoteSizeUsd * sizeMultiplier, 1, 100),
        0,
      );

      return {
        rank: 0,
        marketId: market.marketId,
        symbol: market.symbol,
        objective,
        score: objectiveScore(objective, scores),
        farmingScore: scores.farming,
        profitScore: scores.profit,
        bothScore: scores.both,
        confidence,
        eligible,
        objectiveEligible,
        thinActive,
        sessionOpen: market.sessionOpen,
        observedSpreadBps: spreadBps === null ? null : round(spreadBps, 2),
        preRiskEdgeBps:
          preRiskEdgeBps === null ? null : round(preRiskEdgeBps, 2),
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
      if (left.objectiveEligible !== right.objectiveEligible) {
        return left.objectiveEligible ? -1 : 1;
      }
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
