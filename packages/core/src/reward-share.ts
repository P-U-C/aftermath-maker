/**
 * Conservative, read-only reward-share model.  The reward distribution rule
 * has not been verified, so callers must always present the scenario label.
 */
export type RewardShareScenario = "per-market" | "cross-market";
export type RewardShareForecast = "recent" | "none";

export type RewardShareWindow = {
  externalVolumeUsd: number;
  observedHours: number;
};

export type RewardShareCost = {
  takerFeeBps: number;
  builderFeeBps: number;
  slippageBps: number;
  fillSizeUsd: number;
  gasUsdPerFill: number;
  fundingUsd?: number;
  extraCostBps?: number;
  fixedCostUsd?: number;
  historicalFourBps?: boolean;
};

export type RewardShareMarket = {
  marketId: string;
  symbol: string;
  totalVolumeUsd: number;
  ownTakerVolumeUsd: number;
  last24h: RewardShareWindow;
  previous48h: RewardShareWindow;
  existingRotation?: boolean;
  cost?: Partial<RewardShareCost>;
  flags?: string[];
};

export type RewardShareSnapshot = {
  asOf: string;
  epochEnd: string;
  poolUsd: number;
  rewardMarketCount: number;
  markets: RewardShareMarket[];
};

export type RewardShareSettings = {
  scenario?: RewardShareScenario;
  volumeRewardFraction?: number;
  incrementUsd?: number;
  fillSizeUsd?: number;
  forecast?: RewardShareForecast;
  extraCostBps?: number;
  fixedCostUsd?: number;
  historicalFourBps?: boolean;
};

export type RewardShareScore = {
  marketId: string;
  symbol: string;
  currentMarketShare: number;
  proposedAdditionalVolumeUsd: number;
  modeledAdditionalRewardUsd: number;
  estimatedExecutionCostUsd: number;
  modeledBenefitUsd: number;
  benefitPerDollar: number;
  externalHourlyRateUsd: number;
  forecastExternalVolumeUsd: number;
  flags: string[];
};

const EPSILON = 1e-8;

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a finite nonnegative number`);
  return value;
}

/** Exact reference formula: add x to both own and total market volume. */
export function incrementalReward(
  own: number,
  total: number,
  added: number,
  pool: number,
): number {
  [own, total, added, pool].forEach((value, index) =>
    nonnegative(value, ["own", "total", "added", "pool"][index]!),
  );
  if (total <= 0 || own > total + 0.01)
    throw new Error("Invalid volume or reward-pool input");
  return (pool * added * Math.max(0, total - own)) / (total * (total + added));
}

export function externalHourlyRate(window24: RewardShareWindow, window48: RewardShareWindow): number {
  nonnegative(window24.externalVolumeUsd, "last24h external volume");
  nonnegative(window48.externalVolumeUsd, "previous48h external volume");
  nonnegative(window24.observedHours, "last24h observed hours");
  nonnegative(window48.observedHours, "previous48h observed hours");
  if (window24.observedHours && window48.observedHours) {
    return (0.7 * window24.externalVolumeUsd) / window24.observedHours +
      (0.3 * window48.externalVolumeUsd) / window48.observedHours;
  }
  if (window24.observedHours) return window24.externalVolumeUsd / window24.observedHours;
  if (window48.observedHours) return window48.externalVolumeUsd / window48.observedHours;
  return 0;
}

export function estimateExecutionCostUsd(
  volumeUsd: number,
  cost: Partial<RewardShareCost> = {},
): number {
  nonnegative(volumeUsd, "volumeUsd");
  const fillSizeUsd = cost.fillSizeUsd ?? volumeUsd;
  if (!Number.isFinite(fillSizeUsd) || fillSizeUsd <= 0)
    throw new Error("fillSizeUsd must be positive");
  const bps = cost.historicalFourBps
    ? 4
    : (cost.takerFeeBps ?? 0) +
      (cost.builderFeeBps ?? 0) +
      (cost.slippageBps ?? 0) +
      (cost.extraCostBps ?? 0);
  nonnegative(bps, "cost bps");
  const fundingUsd = cost.fundingUsd ?? 0;
  return volumeUsd * bps / 10_000 +
    (volumeUsd / fillSizeUsd) * (cost.gasUsdPerFill ?? 0) +
    fundingUsd + (cost.fixedCostUsd ?? 0);
}

export type BookLevel = { price: number; size: number };

/** Average buy/sell impact against the supplied mid, in bps. */
export function bookWalkSlippageBps(inputs: {
  mid: number;
  fillSizeUsd: number;
  bids: BookLevel[];
  asks: BookLevel[];
}): number | null {
  const walk = (levels: BookLevel[], buy: boolean) => {
    let remaining = inputs.fillSizeUsd;
    let notional = 0;
    let base = 0;
    for (const level of levels) {
      if (level.price <= 0 || level.size <= 0) continue;
      const available = level.price * level.size;
      const used = Math.min(remaining, available);
      notional += used;
      base += used / level.price;
      remaining -= used;
      if (remaining <= EPSILON) break;
    }
    if (remaining > EPSILON || base <= 0) return null;
    const average = notional / base;
    return buy
      ? ((average - inputs.mid) / inputs.mid) * 10_000
      : ((inputs.mid - average) / inputs.mid) * 10_000;
  };
  if (!Number.isFinite(inputs.mid) || inputs.mid <= 0 || inputs.fillSizeUsd <= 0)
    return null;
  const buy = walk(inputs.asks, true);
  const sell = walk(inputs.bids, false);
  return buy === null || sell === null ? null : (buy + sell) / 2;
}

function configuration(snapshot: RewardShareSnapshot, settings: RewardShareSettings) {
  if (!snapshot.markets.length) throw new Error("No reward markets supplied");
  nonnegative(snapshot.poolUsd, "poolUsd");
  if (!Number.isInteger(snapshot.rewardMarketCount) || snapshot.rewardMarketCount <= 0)
    throw new Error("rewardMarketCount must be positive");
  const asOf = Date.parse(snapshot.asOf);
  const end = Date.parse(snapshot.epochEnd);
  if (!Number.isFinite(asOf) || !Number.isFinite(end) || asOf >= end)
    throw new Error("Snapshot must fall inside an unfinished epoch");
  const value = {
    scenario: settings.scenario ?? "per-market",
    volumeRewardFraction: settings.volumeRewardFraction ?? 1,
    incrementUsd: settings.incrementUsd ?? 32_000,
    fillSizeUsd: settings.fillSizeUsd,
    forecast: settings.forecast ?? "recent",
    extraCostBps: settings.extraCostBps ?? 0,
    fixedCostUsd: settings.fixedCostUsd ?? 0,
    historicalFourBps: settings.historicalFourBps ?? false,
  } as const;
  if (value.volumeRewardFraction < 0 || value.volumeRewardFraction > 1)
    throw new Error("volumeRewardFraction must be between 0 and 1");
  if (value.incrementUsd <= 0) throw new Error("incrementUsd must be positive");
  return { ...value, remainingHours: (end - asOf) / 3_600_000 };
}

function preparedMarket(market: RewardShareMarket, remainingHours: number, forecast: RewardShareForecast) {
  nonnegative(market.totalVolumeUsd, `${market.symbol} totalVolumeUsd`);
  nonnegative(market.ownTakerVolumeUsd, `${market.symbol} ownTakerVolumeUsd`);
  if (market.ownTakerVolumeUsd > market.totalVolumeUsd + 0.01)
    throw new Error(`${market.symbol}: own volume exceeds total volume`);
  const externalHourlyRateUsd = forecast === "recent"
    ? externalHourlyRate(market.last24h, market.previous48h)
    : 0;
  return {
    ...market,
    externalHourlyRateUsd,
    projectedTotalUsd: market.totalVolumeUsd + externalHourlyRateUsd * remainingHours,
  };
}

export function scoreRewardShare(
  snapshot: RewardShareSnapshot,
  settings: RewardShareSettings = {},
): RewardShareScore[] {
  const config = configuration(snapshot, settings);
  const prepared = snapshot.markets.map((market) => preparedMarket(market, config.remainingHours, config.forecast));
  const poolPerMarket = snapshot.poolUsd / snapshot.rewardMarketCount;
  const crossOwn = prepared.reduce((sum, market) => sum + market.ownTakerVolumeUsd, 0);
  const crossTotal = prepared.reduce((sum, market) => sum + market.projectedTotalUsd, 0);
  return prepared
    .filter((market) => market.projectedTotalUsd > 0)
    .map((market) => {
      const baseReward = config.scenario === "per-market"
        ? incrementalReward(market.ownTakerVolumeUsd, market.projectedTotalUsd, config.incrementUsd, poolPerMarket)
        : incrementalReward(crossOwn, crossTotal, config.incrementUsd, snapshot.poolUsd);
      const estimatedExecutionCostUsd = estimateExecutionCostUsd(config.incrementUsd, {
        ...market.cost,
        ...(config.fillSizeUsd === undefined
          ? {}
          : { fillSizeUsd: config.fillSizeUsd }),
        extraCostBps: (market.cost?.extraCostBps ?? 0) + config.extraCostBps,
        fixedCostUsd: (market.cost?.fixedCostUsd ?? 0) + config.fixedCostUsd,
        historicalFourBps: config.historicalFourBps,
      });
      const modeledAdditionalRewardUsd = baseReward * config.volumeRewardFraction;
      const modeledBenefitUsd = modeledAdditionalRewardUsd - estimatedExecutionCostUsd;
      return {
        marketId: market.marketId,
        symbol: market.symbol,
        currentMarketShare: market.ownTakerVolumeUsd / market.totalVolumeUsd,
        proposedAdditionalVolumeUsd: config.incrementUsd,
        modeledAdditionalRewardUsd,
        estimatedExecutionCostUsd,
        modeledBenefitUsd,
        benefitPerDollar: modeledBenefitUsd / config.incrementUsd,
        externalHourlyRateUsd: market.externalHourlyRateUsd,
        forecastExternalVolumeUsd: market.externalHourlyRateUsd * config.remainingHours,
        flags: market.flags ?? [],
      };
    })
    .sort((left, right) => right.benefitPerDollar - left.benefitPerDollar || left.symbol.localeCompare(right.symbol));
}

export function allocateRewardShareVolume(
  snapshot: RewardShareSnapshot,
  budgetUsd: number,
  settings: RewardShareSettings & { maxAdditionalVolumeByMarket?: Record<string, number> } = {},
) {
  nonnegative(budgetUsd, "budgetUsd");
  const increment = settings.incrementUsd ?? 32_000;
  const working: RewardShareSnapshot = {
    ...snapshot,
    markets: snapshot.markets.map((market) => ({ ...market })),
  };
  const allocations = new Map<string, number>();
  let unallocatedUsd = budgetUsd;
  const steps: RewardShareScore[] = [];
  while (unallocatedUsd > EPSILON) {
    const rankings = scoreRewardShare(working, { ...settings, incrementUsd: Math.min(increment, unallocatedUsd) })
      .filter((row) => (settings.maxAdditionalVolumeByMarket?.[row.marketId] ?? Infinity) - (allocations.get(row.marketId) ?? 0) > EPSILON);
    const best = rankings[0];
    if (!best || best.modeledBenefitUsd <= 0) break;
    const capacity = (settings.maxAdditionalVolumeByMarket?.[best.marketId] ?? Infinity) - (allocations.get(best.marketId) ?? 0);
    const assigned = Math.min(best.proposedAdditionalVolumeUsd, capacity);
    if (assigned <= EPSILON) break;
    allocations.set(best.marketId, (allocations.get(best.marketId) ?? 0) + assigned);
    const market = working.markets.find((candidate) => candidate.marketId === best.marketId)!;
    market.ownTakerVolumeUsd += assigned;
    market.totalVolumeUsd += assigned;
    unallocatedUsd -= assigned;
    steps.push({ ...best, proposedAdditionalVolumeUsd: assigned });
  }
  const allocation = [...allocations].map(([marketId, volumeUsd]) => ({ marketId, volumeUsd }));
  return { requestedVolumeBudgetUsd: budgetUsd, allocatedVolumeUsd: budgetUsd - unallocatedUsd, unallocatedVolumeUsd: unallocatedUsd, allocations: allocation, steps };
}
