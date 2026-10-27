import { describe, expect, it } from "vitest";
import {
  rankRewardMarkets,
  rewardEpochWindow,
  type RewardMarketEvidence,
} from "../src/index.js";

const market = (
  overrides: Partial<RewardMarketEvidence>,
): RewardMarketEvidence => ({
  marketId: "0x1",
  symbol: "SUI",
  indexPrice: 1,
  volume24hUsd: 100_000,
  openInterestUsd: 10_000,
  openInterestUtilizationPct: 10,
  fundingRate: 0.00001,
  priceChange24hPct: 0.01,
  makerFee: -0.00005,
  sessionOpen: null,
  bestBid: 0.999,
  bestAsk: 1.001,
  bidDepth50BpsUsd: 500,
  askDepth50BpsUsd: 500,
  error: null,
  ...overrides,
});

describe("reward opportunity ranking", () => {
  it("prefers organic flow with less competing near-book capital", () => {
    const ranked = rankRewardMarkets({
      builderFeeBps: 1,
      markets: [
        market({
          marketId: "0x1",
          symbol: "FLOW",
          bidDepth50BpsUsd: 100,
          askDepth50BpsUsd: 100,
        }),
        market({
          marketId: "0x2",
          symbol: "CROWDED",
          bidDepth50BpsUsd: 10_000,
          askDepth50BpsUsd: 10_000,
          priceChange24hPct: 0.08,
          fundingRate: 0.001,
        }),
      ],
    });

    expect(ranked[0]?.symbol).toBe("FLOW");
    expect(ranked[0]?.eligible).toBe(true);
    expect(ranked[0]?.knownCostBps).toBe(0.5);
  });

  it("ranks one-sided and inactive markets below eligible markets", () => {
    const ranked = rankRewardMarkets({
      builderFeeBps: 1,
      markets: [
        market({ marketId: "0x1", symbol: "HEALTHY" }),
        market({
          marketId: "0x2",
          symbol: "ONE-SIDED",
          bestAsk: null,
          askDepth50BpsUsd: 0,
        }),
      ],
    });

    expect(ranked[0]?.symbol).toBe("HEALTHY");
    expect(ranked[1]?.eligible).toBe(false);
    expect(ranked[1]?.confidence).toBe("low");
  });

  it("rejects nominal flow when the two-sided exit depth is too thin", () => {
    const ranked = rankRewardMarkets({
      builderFeeBps: 1,
      markets: [
        market({
          marketId: "0x1",
          symbol: "THIN",
          bidDepth50BpsUsd: 20,
          askDepth50BpsUsd: 20,
        }),
        market({
          marketId: "0x2",
          symbol: "TRADEABLE",
          bidDepth50BpsUsd: 100,
          askDepth50BpsUsd: 100,
        }),
      ],
    });

    expect(ranked[0]?.symbol).toBe("TRADEABLE");
    expect(ranked.find((row) => row.symbol === "THIN")?.eligible).toBe(false);
    expect(ranked.find((row) => row.symbol === "THIN")?.thinActive).toBe(false);
    expect(ranked[0]?.thinActive).toBe(true);
    expect(ranked[0]?.suggestedQuoteSizeUsd).toBeLessThanOrEqual(5);
  });

  it("marks only eligible books at or below the thin-active depth ceiling", () => {
    const ranked = rankRewardMarkets({
      builderFeeBps: 1,
      markets: [
        market({
          marketId: "0x1",
          symbol: "EDGE",
          bidDepth50BpsUsd: 1_000,
          askDepth50BpsUsd: 1_000,
        }),
        market({
          marketId: "0x2",
          symbol: "DEEP",
          bidDepth50BpsUsd: 1_001,
          askDepth50BpsUsd: 1_001,
        }),
      ],
    });

    expect(ranked.find((row) => row.symbol === "EDGE")?.thinActive).toBe(true);
    expect(ranked.find((row) => row.symbol === "DEEP")?.thinActive).toBe(false);
  });

  it("excludes closed outliers from eligible-market percentiles", () => {
    const base = [
      market({
        marketId: "0x1",
        symbol: "LOWER-COMPETITION",
        bidDepth50BpsUsd: 100,
        askDepth50BpsUsd: 100,
      }),
      market({
        marketId: "0x2",
        symbol: "HIGHER-COMPETITION",
        bidDepth50BpsUsd: 1_000,
        askDepth50BpsUsd: 1_000,
      }),
    ];
    const withoutOutlier = rankRewardMarkets({
      builderFeeBps: 1,
      markets: base,
    });
    const withOutlier = rankRewardMarkets({
      builderFeeBps: 1,
      markets: [
        ...base,
        market({
          marketId: "0x3",
          symbol: "CLOSED-OUTLIER",
          sessionOpen: false,
          volume24hUsd: 1_000_000_000,
          bidDepth50BpsUsd: 1_000_000,
          askDepth50BpsUsd: 1_000_000,
        }),
      ],
    });

    expect(withOutlier.slice(0, 2).map((row) => row.symbol)).toEqual(
      withoutOutlier.map((row) => row.symbol),
    );
    expect(withOutlier[0]?.score).toBe(withoutOutlier[0]?.score);
  });

  it("does not recommend a closed session with a resting book", () => {
    const ranked = rankRewardMarkets({
      builderFeeBps: 1,
      markets: [
        market({ marketId: "0x1", symbol: "OPEN" }),
        market({
          marketId: "0x2",
          symbol: "CLOSED",
          sessionOpen: false,
          volume24hUsd: 1_000_000,
        }),
      ],
    });

    expect(ranked[0]?.symbol).toBe("OPEN");
    expect(ranked[1]?.eligible).toBe(false);
    expect(ranked[1]?.reasons).toContain("Market session is closed");
  });
});

describe("reward epoch schedule", () => {
  it("uses the documented bi-weekly Monday cutoff", () => {
    expect(rewardEpochWindow(new Date("2026-03-03T00:00:00Z"))).toEqual({
      epoch: 0,
      startedAt: "2026-03-02T05:00:00.000Z",
      cutoffAt: "2026-03-16T05:00:00.000Z",
    });
    expect(rewardEpochWindow(new Date("2026-03-16T05:00:00Z")).epoch).toBe(1);
  });
});
