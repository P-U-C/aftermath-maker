import type { RewardDashboard } from "@puc/aftermath";
import {
  makerConfigSchema,
  resolveMarketConfig,
  type MakerConfig,
  type StrategyObjective,
} from "@puc/core";

export const STRATEGY_TRIAL_OBJECTIVES = [
  "farming",
  "profit",
  "both",
] as const satisfies readonly StrategyObjective[];

/** The user-facing test run is always an isolated Paper dry run. */
export type StrategyTrialMode = "paper";

export type StrategyTrialPlanRound = {
  objective: StrategyObjective;
  profile: MakerConfig["strategyProfile"];
  score: number;
  quoteSizeUsd: number;
  spreadBps: number;
  config: MakerConfig;
};

export type StrategyTrialPlan = {
  marketId: string;
  symbol: string;
  cadenceMs: number;
  rounds: StrategyTrialPlanRound[];
};

type Dashboards = Record<StrategyObjective, RewardDashboard>;

const profiles: Record<
  StrategyObjective,
  {
    profile: MakerConfig["strategyProfile"];
    inventorySkewBps: number;
  }
> = {
  farming: { profile: "active", inventorySkewBps: 30 },
  profit: { profile: "cautious", inventorySkewBps: 35 },
  both: { profile: "balanced", inventorySkewBps: 20 },
};

export function inventoryCapacityFloor(
  quoteSizeUsd: number,
  spreadBps: number,
  inventorySkewBps: number,
): number {
  return (
    Math.ceil(
      quoteSizeUsd *
        (1 +
          Math.max(0, spreadBps) / 20_000 +
          Math.max(0, inventorySkewBps) / 10_000) *
        100,
    ) / 100
  );
}

export function buildStrategyTrialPlan(inputs: {
  originalConfig: MakerConfig;
  dashboards: Dashboards;
  availableCollateralUsd: number;
  mode: StrategyTrialMode;
  cadenceMs: number;
}): StrategyTrialPlan {
  if (!Number.isFinite(inputs.availableCollateralUsd)) {
    throw new Error("Available collateral is unavailable");
  }
  if (inputs.availableCollateralUsd <= 0) {
    throw new Error("The Maker account has no available collateral");
  }
  if (!Number.isInteger(inputs.cadenceMs) || inputs.cadenceMs < 2_000) {
    throw new Error("Strategy trial cadence must be at least two seconds");
  }

  const candidates = inputs.originalConfig.markets
    .map((market) => {
      const opportunities = STRATEGY_TRIAL_OBJECTIVES.map((objective) =>
        inputs.dashboards[objective].marketModel.opportunities.find(
          (opportunity) =>
            opportunity.marketId === market.marketId &&
            opportunity.objectiveEligible,
        ),
      );
      if (opportunities.some((opportunity) => !opportunity)) return null;
      return {
        market,
        opportunities: opportunities.map((opportunity) => opportunity!),
        averageScore:
          opportunities.reduce(
            (total, opportunity) => total + (opportunity?.score ?? 0),
            0,
          ) / STRATEGY_TRIAL_OBJECTIVES.length,
      };
    })
    .filter((candidate) => candidate !== null)
    .sort((left, right) => right.averageScore - left.averageScore);

  const failures: string[] = [];
  for (const candidate of candidates) {
    const effective = resolveMarketConfig(
      inputs.originalConfig,
      candidate.market,
    );
    const quoteCapUsd = Math.min(
      effective.quoteSizeUsd,
      inputs.availableCollateralUsd / 4,
    );
    const rounds: StrategyTrialPlanRound[] = [];
    let valid = true;

    for (const [index, objective] of STRATEGY_TRIAL_OBJECTIVES.entries()) {
      const opportunity = candidate.opportunities[index]!;
      const policy = profiles[objective];
      if (opportunity.minimumQuoteSizeUsd > quoteCapUsd + 1e-9) {
        failures.push(
          `${candidate.market.symbol} needs at least $${opportunity.minimumQuoteSizeUsd.toFixed(2)} per quote for ${objective}`,
        );
        valid = false;
        break;
      }
      const quoteSizeUsd = Math.max(
        opportunity.minimumQuoteSizeUsd,
        Math.min(opportunity.suggestedQuoteSizeUsd, quoteCapUsd),
      );
      const inventoryFloor = inventoryCapacityFloor(
        quoteSizeUsd,
        opportunity.suggestedSpreadBps,
        policy.inventorySkewBps,
      );
      if (inventoryFloor > effective.maxInventoryUsd + 1e-9) {
        failures.push(
          `${candidate.market.symbol} needs a $${inventoryFloor.toFixed(2)} inventory limit for ${objective}`,
        );
        valid = false;
        break;
      }

      const config = makerConfigSchema.parse({
        ...inputs.originalConfig,
        mode: inputs.mode,
        strategyObjective: objective,
        strategyProfile: policy.profile,
        markets: [
          {
            marketId: candidate.market.marketId,
            symbol: candidate.market.symbol,
            overrides: {
              quoteSizeUsd,
              spreadBps: opportunity.suggestedSpreadBps,
              maxInventoryUsd: effective.maxInventoryUsd,
              inventoryTargetUsd: 0,
              inventorySkewBps: policy.inventorySkewBps,
              maxLeverage: 1,
            },
          },
        ],
        quoteSizeUsd,
        spreadBps: opportunity.suggestedSpreadBps,
        refreshMs: inputs.cadenceMs,
        marketDwellMs: Math.max(5_000, inputs.cadenceMs),
        maxRestingMs: Math.max(5_000, inputs.cadenceMs),
        maxQuoteAgeMs: Math.max(35_000, inputs.cadenceMs * 3),
        maxInventoryUsd: effective.maxInventoryUsd,
        inventoryTargetUsd: 0,
        staleBookMs: 3_000,
        inventorySkewBps: policy.inventorySkewBps,
        maxLeverage: 1,
      });
      rounds.push({
        objective,
        profile: policy.profile,
        score: opportunity.score,
        quoteSizeUsd,
        spreadBps: opportunity.suggestedSpreadBps,
        config,
      });
    }

    if (valid) {
      return {
        marketId: candidate.market.marketId,
        symbol: candidate.market.symbol,
        cadenceMs: inputs.cadenceMs,
        rounds,
      };
    }
  }

  if (!candidates.length) {
    throw new Error(
      "No saved market currently passes Farming, Profit, and Both eligibility",
    );
  }
  throw new Error(
    failures[0] ?? "No common eligible market fits the saved capital limits",
  );
}
