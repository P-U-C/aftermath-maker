import { describe, expect, it } from "vitest";
import type { RewardDashboard } from "@puc/aftermath";
import { makerConfigSchema, type StrategyObjective } from "@puc/core";
import {
  buildStrategyTrialPlan,
  STRATEGY_TRIAL_OBJECTIVES,
} from "../src/trial.js";

const MARKET_ID = "0xa4cd";

function dashboard(
  objective: StrategyObjective,
  overrides: {
    eligible?: boolean;
    minimumQuoteSizeUsd?: number;
    score?: number;
  } = {},
): RewardDashboard {
  return {
    asOf: "2026-10-27T12:00:00.000Z",
    epoch: {
      number: 1,
      startedAt: "2026-10-27T00:00:00.000Z",
      cutoffAt: "2026-10-28T00:00:00.000Z",
    },
    account: {
      trackedAccountIds: ["1745", "1746"],
      error: null,
      makerRewardsSui: 0,
      qScoreShare: 0,
      uptime: 0,
      makerVolumeUsd: 0,
      makerVolumeShare: 0,
      directRebatesUsd: 0,
      baseMakerFeesUsd: 0,
      accounts: [],
    },
    marketModel: {
      label: "heuristic",
      methodology: "test",
      depthBandBps: 50,
      opportunities: [
        {
          rank: 1,
          marketId: MARKET_ID,
          symbol: "MON",
          minOrderUsdValue: 1,
          minimumQuoteSizeUsd: overrides.minimumQuoteSizeUsd ?? 1.04,
          objective,
          score: overrides.score ?? 70,
          farmingScore: 80,
          profitScore: 60,
          bothScore: 68,
          confidence: "high",
          eligible: true,
          objectiveEligible: overrides.eligible ?? true,
          thinActive: true,
          sessionOpen: true,
          observedSpreadBps: 12,
          preRiskEdgeBps: 5,
          balancedDepth50BpsUsd: 600,
          volume24hUsd: 100_000,
          openInterestUsd: 2_000,
          openInterestUtilizationPct: 10,
          volumeToDepth: 166,
          fundingRate: 0,
          priceChange24hPct: 1,
          makerRebateBps: 0.5,
          builderFeeBps: 1,
          knownCostBps: 0.5,
          suggestedSpreadBps:
            objective === "farming" ? 10 : objective === "profit" ? 16 : 12,
          suggestedQuoteSizeUsd: 20,
          reasons: ["test"],
          error: null,
        },
      ],
    },
  };
}

const originalConfig = makerConfigSchema.parse({
  markets: [
    {
      marketId: MARKET_ID,
      symbol: "MON",
      overrides: {
        quoteSizeUsd: 1.04,
        spreadBps: 16,
        maxInventoryUsd: 1.05,
        inventoryTargetUsd: 0,
        inventorySkewBps: 35,
        maxLeverage: 1,
      },
    },
  ],
  mode: "paper",
  makerAccountId: "1745",
  hedge: {
    enabled: true,
    accountId: "1746",
    thresholdUsd: 1,
    maxOrderUsd: 5,
    maxSlippageBps: 500,
  },
  quoteSizeUsd: 1,
  spreadBps: 50,
  maxInventoryUsd: 1.05,
  maxGrossExposureUsd: 3,
});

describe("strategy trial planning", () => {
  it("builds three short policies without raising saved capital limits", () => {
    const dashboards = Object.fromEntries(
      STRATEGY_TRIAL_OBJECTIVES.map((objective, index) => [
        objective,
        dashboard(objective, { score: 80 - index * 10 }),
      ]),
    ) as Record<StrategyObjective, RewardDashboard>;

    const plan = buildStrategyTrialPlan({
      originalConfig,
      dashboards,
      availableCollateralUsd: 7.48,
      mode: "live",
      cadenceMs: 2_000,
    });

    expect(plan).toMatchObject({
      marketId: MARKET_ID,
      symbol: "MON",
      cadenceMs: 2_000,
    });
    expect(plan.rounds.map((round) => round.objective)).toEqual([
      "farming",
      "profit",
      "both",
    ]);
    expect(plan.rounds.map((round) => round.profile)).toEqual([
      "active",
      "cautious",
      "balanced",
    ]);
    expect(plan.rounds.map((round) => round.spreadBps)).toEqual([10, 16, 12]);
    for (const round of plan.rounds) {
      expect(round.quoteSizeUsd).toBe(1.04);
      expect(round.config.mode).toBe("live");
      expect(round.config.refreshMs).toBe(2_000);
      expect(round.config.maxQuoteAgeMs).toBe(10_000);
      expect(round.config.staleBookMs).toBe(3_000);
      expect(round.config.maxInventoryUsd).toBe(1.05);
      expect(round.config.maxGrossExposureUsd).toBe(3);
      expect(round.config.markets).toHaveLength(1);
    }
  });

  it("requires one saved market to qualify for all three objectives", () => {
    expect(() =>
      buildStrategyTrialPlan({
        originalConfig,
        dashboards: {
          farming: dashboard("farming"),
          profit: dashboard("profit", { eligible: false }),
          both: dashboard("both"),
        },
        availableCollateralUsd: 7.48,
        mode: "paper",
        cadenceMs: 2_000,
      }),
    ).toThrow("No saved market currently passes");
  });

  it("refuses to raise the saved quote or inventory limits", () => {
    expect(() =>
      buildStrategyTrialPlan({
        originalConfig,
        dashboards: {
          farming: dashboard("farming", { minimumQuoteSizeUsd: 1.1 }),
          profit: dashboard("profit"),
          both: dashboard("both"),
        },
        availableCollateralUsd: 7.48,
        mode: "live",
        cadenceMs: 2_000,
      }),
    ).toThrow("needs at least $1.10 per quote");
  });
});
