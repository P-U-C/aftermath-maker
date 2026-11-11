import { describe, expect, it } from "vitest";
import {
  gasCostUsd,
  summarizeLiveResultEvidence,
  summarizeStrategyResult,
  type StrategyResultFill,
} from "../src/index.js";

const fill = (
  overrides: Partial<StrategyResultFill> &
    Pick<StrategyResultFill, "side" | "price">,
): StrategyResultFill => ({
  occurredAt: "2026-11-04T10:00:00.000Z",
  marketId: "0xnear",
  account: "maker",
  sizeUsd: 10,
  executionFeeUsd: 0,
  builderFeeUsd: 0,
  ...overrides,
});

const known = { fundingUsd: 0, gasUsd: 0 };

describe("strategy result", () => {
  it("realizes a round trip at average cost and subtracts fees", () => {
    const result = summarizeStrategyResult({
      fills: [
        fill({ side: "bid", price: 2, executionFeeUsd: 0.01 }),
        fill({
          side: "ask",
          price: 2.2,
          sizeUsd: 11,
          executionFeeUsd: 0.01,
          occurredAt: "2026-11-04T11:00:00.000Z",
        }),
      ],
      marks: new Map(),
      requiredCollateralUsd: 100,
      ...known,
    });
    // Bought 5 at 2, sold 5 at 2.2: +1.00 before fees.
    expect(result.realizedPricePnlUsd).toBeCloseTo(1, 9);
    expect(result.unrealizedPricePnlUsd).toBeCloseTo(0, 9);
    expect(result.tradingNetUsd).toBeCloseTo(0.98, 9);
    expect(result.returnPct).toBeCloseTo(0.98, 9);
    expect(result.volumeUsd).toBe(21);
    expect(result.since).toBe("2026-11-04T10:00:00.000Z");
    expect(result.gaps).toEqual([]);
  });

  it("credits a negative execution fee once and charges builder fees and gas", () => {
    // Spec fixture negative-fee-is-one-credit: price 1 + funding 0.2
    // - fee (-0.5) - builder 0.1 - gas 0.1 = 1.5.
    const result = summarizeStrategyResult({
      fills: [
        fill({ side: "bid", price: 2, executionFeeUsd: -0.25 }),
        fill({
          side: "ask",
          price: 2.2,
          sizeUsd: 11,
          executionFeeUsd: -0.25,
          builderFeeUsd: 0.1,
          occurredAt: "2026-11-04T11:00:00.000Z",
        }),
      ],
      marks: new Map(),
      requiredCollateralUsd: 0,
      fundingUsd: 0.2,
      gasUsd: 0.1,
    });
    expect(result.executionFeesUsd).toBeCloseTo(-0.5, 9);
    expect(result.builderFeesUsd).toBeCloseTo(0.1, 9);
    expect(result.tradingNetUsd).toBeCloseTo(1.5, 9);
  });

  it("leaves an unmeasured part out and names it, never as zero", () => {
    const result = summarizeStrategyResult({
      fills: [fill({ side: "bid", price: 2 })],
      marks: new Map([["0xnear", 2.2]]),
      requiredCollateralUsd: 50,
      fundingUsd: null,
      gasUsd: Number.NaN,
      gaps: [
        "Funding isn't simulated in Paper yet.",
        "Funding isn't simulated in Paper yet.",
      ],
    });
    expect(result.fundingUsd).toBeNull();
    expect(result.gasUsd).toBeNull();
    expect(result.tradingNetUsd).toBeCloseTo(1, 9);
    expect(result.gaps).toEqual(["Funding isn't simulated in Paper yet."]);
  });

  it("marks an open position even when the account name has a colon", () => {
    const result = summarizeStrategyResult({
      fills: [fill({ side: "bid", price: 2, account: "bundle-1:maker" })],
      marks: new Map([["0xnear", 2.2]]),
      requiredCollateralUsd: 50,
      ...known,
    });
    // Long 5 from 2, mark 2.2.
    expect(result.unrealizedPricePnlUsd).toBeCloseTo(1, 9);
  });

  it("marks an open position at the current price", () => {
    const result = summarizeStrategyResult({
      fills: [fill({ side: "ask", price: 2 })],
      marks: new Map([["0xnear", 1.8]]),
      requiredCollateralUsd: 50,
      ...known,
    });
    // Short 5 from 2, mark 1.8: +1.00 unrealized.
    expect(result.unrealizedPricePnlUsd).toBeCloseTo(1, 9);
    expect(result.tradingNetUsd).toBeCloseTo(1, 9);
  });

  it("keeps a hedge account separate from the maker account", () => {
    const result = summarizeStrategyResult({
      fills: [
        fill({ side: "bid", price: 2 }),
        fill({ side: "ask", price: 2, account: "hedge" }),
      ],
      marks: new Map([["0xnear", 2.5]]),
      requiredCollateralUsd: 50,
      ...known,
    });
    // Long 5 and short 5 on different accounts: +2.50 and -2.50, nothing realized.
    expect(result.realizedPricePnlUsd).toBe(0);
    expect(result.unrealizedPricePnlUsd).toBeCloseTo(0, 9);
  });

  it("handles a fill that flips the position", () => {
    const result = summarizeStrategyResult({
      fills: [
        fill({ side: "bid", price: 2, sizeUsd: 10 }),
        fill({
          side: "ask",
          price: 2.5,
          sizeUsd: 25,
          occurredAt: "2026-11-04T12:00:00.000Z",
        }),
      ],
      marks: new Map([["0xnear", 2.5]]),
      requiredCollateralUsd: 0,
      ...known,
    });
    // Closed 5 for +2.50, then short 5 at 2.5 marked at 2.5.
    expect(result.realizedPricePnlUsd).toBeCloseTo(2.5, 9);
    expect(result.unrealizedPricePnlUsd).toBeCloseTo(0, 9);
    expect(result.returnPct).toBeNull();
  });

  it("uses the venue's realized PnL for Live and adds live unrealized", () => {
    const result = summarizeStrategyResult({
      fills: [
        fill({
          side: "bid",
          price: 2,
          realizedPnlUsd: 0,
          executionFeeUsd: 0.02,
        }),
        fill({
          side: "ask",
          price: 2.1,
          realizedPnlUsd: 0.25,
          executionFeeUsd: 0.02,
        }),
      ],
      marks: new Map(),
      requiredCollateralUsd: 100,
      reportedRealized: true,
      unrealizedPnlUsd: -0.1,
      ...known,
    });
    expect(result.realizedPricePnlUsd).toBeCloseTo(0.25, 9);
    expect(result.tradingNetUsd).toBeCloseTo(0.25 - 0.1 - 0.04, 9);
  });

  it("reports nothing, and no gaps, for a strategy with no fills", () => {
    const result = summarizeStrategyResult({
      fills: [],
      marks: new Map(),
      requiredCollateralUsd: 100,
      fundingUsd: null,
      gasUsd: null,
      gaps: ["Funding isn't simulated in Paper yet."],
    });
    expect(result).toMatchObject({
      fills: 0,
      tradingNetUsd: 0,
      returnPct: null,
      since: null,
      gaps: [],
    });
  });

  it("prices gas when it was spent and counts unpriced transactions", () => {
    expect(
      gasCostUsd([
        { gasUsedMist: 2_000_000, suiUsd: 3 },
        { gasUsedMist: 1_000_000, suiUsd: 2 },
        { gasUsedMist: 5_000_000, suiUsd: null },
        { gasUsedMist: null, suiUsd: 3 },
      ]),
    ).toEqual({ usd: 0.006 + 0.002, priced: 2, unpriced: 1 });
  });

  it("summarizes a Live fill with fixed-horizon markouts, gas, and funding without treating unknown data as zero", () => {
    const result = summarizeLiveResultEvidence({
      fills: [
        {
          fillId: "live-fill-1",
          occurredAtMs: 1_000_000,
          side: "bid",
          priceUsd: 100,
          sizeUsd: 250,
          references: [
            {
              horizonMs: 60_000,
              observedAtMs: 1_060_000,
              priceUsd: 101,
            },
            {
              horizonMs: 300_000,
              observedAtMs: null,
              priceUsd: null,
            },
            {
              horizonMs: 1_800_000,
              observedAtMs: 2_799_999,
              priceUsd: 103,
            },
          ],
        },
      ],
      fundingUsd: 1.25,
      gasUsd: null,
    });

    expect(result.fills).toEqual([
      {
        fillId: "live-fill-1",
        markouts: [
          {
            horizonMs: 60_000,
            expectedAtMs: 1_060_000,
            observedAtMs: 1_060_000,
            markoutUsd: 2.5,
            coverage: "complete",
            reason: null,
          },
          {
            horizonMs: 300_000,
            expectedAtMs: 1_300_000,
            observedAtMs: null,
            markoutUsd: null,
            coverage: "unavailable",
            reason: "reference price is missing",
          },
          {
            horizonMs: 1_800_000,
            expectedAtMs: 2_800_000,
            observedAtMs: 2_799_999,
            markoutUsd: null,
            coverage: "unavailable",
            reason: "reference arrived before the requested horizon",
          },
          {
            horizonMs: 3_600_000,
            expectedAtMs: 4_600_000,
            observedAtMs: null,
            markoutUsd: null,
            coverage: "unavailable",
            reason: "reference is missing",
          },
        ],
      },
    ]);
    expect(result.fundingUsd).toBe(1.25);
    expect(result.gasUsd).toBeNull();
    expect(result.netFundingAfterGasUsd).toBeNull();
    expect(result.gaps).toEqual([
      "Live markout for fill live-fill-1 at 300000ms is unavailable: reference price is missing.",
      "Live markout for fill live-fill-1 at 1800000ms is unavailable: reference arrived before the requested horizon.",
      "Live markout for fill live-fill-1 at 3600000ms is unavailable: reference is missing.",
      "Run gas is unavailable.",
    ]);

    const missingFunding = summarizeLiveResultEvidence({
      fills: [],
      fundingUsd: Number.NaN,
      gasUsd: 0.25,
    });
    expect(missingFunding.fundingUsd).toBeNull();
    expect(missingFunding.gasUsd).toBe(0.25);
    expect(missingFunding.netFundingAfterGasUsd).toBeNull();
    expect(missingFunding.gaps).toEqual(["Run funding is unavailable."]);

    const completeRun = summarizeLiveResultEvidence({
      fills: [],
      fundingUsd: 1.25,
      gasUsd: 0.25,
    });
    expect(completeRun.netFundingAfterGasUsd).toBe(1);
    expect(completeRun.gaps).toEqual([]);
  });
});
