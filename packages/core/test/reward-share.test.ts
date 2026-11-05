import { describe, expect, it } from "vitest";
import {
  allocateRewardShareVolume,
  bookWalkSlippageBps,
  estimateExecutionCostUsd,
  incrementalReward,
  scoreRewardShare,
  type RewardShareSnapshot,
} from "../src/index.js";

const snapshot = (): RewardShareSnapshot => ({
  asOf: "2026-11-03T18:00:00.000Z",
  epochEnd: "2026-11-08T05:00:00.000Z",
  poolUsd: 70_000,
  rewardMarketCount: 65,
  markets: [
    {
      marketId: "0x1",
      symbol: "ALPHA",
      totalVolumeUsd: 100_000,
      ownTakerVolumeUsd: 20_000,
      last24h: { externalVolumeUsd: 24_000, observedHours: 24 },
      previous48h: { externalVolumeUsd: 48_000, observedHours: 48 },
      cost: { takerFeeBps: 2, fillSizeUsd: 1_000 },
    },
    {
      marketId: "0x2",
      symbol: "BETA",
      totalVolumeUsd: 200_000,
      ownTakerVolumeUsd: 0,
      last24h: { externalVolumeUsd: 48_000, observedHours: 24 },
      previous48h: { externalVolumeUsd: 96_000, observedHours: 48 },
      cost: { takerFeeBps: 2, fillSizeUsd: 1_000 },
    },
  ],
});

describe("reward-share ranker", () => {
  it("uses the reference incremental-reward formula and diminishes", () => {
    expect(incrementalReward(25, 100, 20, 1_000)).toBeCloseTo(125, 10);
    expect(incrementalReward(45, 120, 20, 1_000)).toBeLessThan(
      incrementalReward(25, 100, 20, 1_000),
    );
  });

  it("keeps the pool divisor and zero-own markets when candidates are filtered", () => {
    const rows = scoreRewardShare(snapshot(), { forecast: "none" });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.symbol === "BETA")?.currentMarketShare).toBe(
      0,
    );
    expect(
      rows.find((row) => row.symbol === "ALPHA")?.modeledAdditionalRewardUsd,
    ).toBeCloseTo(incrementalReward(20_000, 100_000, 32_000, 70_000 / 65), 10);
  });

  it("uses observed forecast windows and scales only volume rewards", () => {
    const limited = snapshot();
    limited.markets[0]!.previous48h.observedHours = 0;
    limited.markets[0]!.previous48h.externalVolumeUsd = 0;
    const recent = scoreRewardShare(limited)[0]!;
    const none = scoreRewardShare(limited, { forecast: "none" })[0]!;
    const half = scoreRewardShare(limited, { volumeRewardFraction: 0.5 })[0]!;
    expect(recent.externalHourlyRateUsd).toBe(1_000);
    expect(recent.modeledAdditionalRewardUsd).toBeCloseTo(
      half.modeledAdditionalRewardUsd * 2,
      10,
    );
    expect(half.estimatedExecutionCostUsd).toBe(
      recent.estimatedExecutionCostUsd,
    );
    expect(none.forecastExternalVolumeUsd).toBe(0);
  });

  it("has equal cross-market marginal reward before market-specific costs", () => {
    const rows = scoreRewardShare(snapshot(), {
      scenario: "cross-market",
      forecast: "none",
    });
    expect(rows[0]!.modeledAdditionalRewardUsd).toBeCloseTo(
      rows[1]!.modeledAdditionalRewardUsd,
      10,
    );
  });

  it("models live costs, depth and delta-neutral funding without making historic cost the default", () => {
    expect(
      estimateExecutionCostUsd(2_000, {
        takerFeeBps: 2,
        builderFeeBps: 1,
        slippageBps: 3,
        fillSizeUsd: 1_000,
        gasUsdPerFill: 0.5,
        fundingUsd: 0,
      }),
    ).toBeCloseTo(2.2, 10);
    expect(
      estimateExecutionCostUsd(1_000, {
        takerFeeBps: 20,
        historicalFourBps: true,
      }),
    ).toBeCloseTo(0.4, 10);
    expect(
      bookWalkSlippageBps({
        mid: 100,
        fillSizeUsd: 1_000,
        asks: [{ price: 101, size: 20 }],
        bids: [{ price: 99, size: 20 }],
      }),
    ).toBeCloseTo(100, 10);
    expect(
      bookWalkSlippageBps({
        mid: 100,
        fillSizeUsd: 3_000,
        asks: [{ price: 101, size: 20 }],
        bids: [{ price: 99, size: 20 }],
      }),
    ).toBeNull();
  });

  it("respects caps, stops below cost, and reports unused budget without mutating the snapshot", () => {
    const source = snapshot();
    const plan = allocateRewardShareVolume(source, 100_000, {
      forecast: "none",
      incrementUsd: 10_000,
      maxAdditionalVolumeByMarket: { "0x1": 5_000 },
    });
    expect(
      plan.allocations.find((row) => row.marketId === "0x1")?.volumeUsd ?? 0,
    ).toBeLessThanOrEqual(5_000);
    expect(plan.allocatedVolumeUsd + plan.unallocatedVolumeUsd).toBeCloseTo(
      100_000,
      10,
    );
    expect(source.markets[0]!.ownTakerVolumeUsd).toBe(20_000);
    const stopped = allocateRewardShareVolume(snapshot(), 100_000, {
      volumeRewardFraction: 0,
    });
    expect(stopped.allocatedVolumeUsd).toBe(0);
    expect(stopped.unallocatedVolumeUsd).toBe(100_000);
  });
});
