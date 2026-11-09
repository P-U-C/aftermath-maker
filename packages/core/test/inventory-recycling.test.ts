import { describe, expect, it } from "vitest";
import {
  classifyCounterparty,
  isDecimalString,
  rankInventoryRecyclingMarkets,
  reconcileInventoryRecycling,
  scoreInventoryRecyclingMarket,
  sourceEventKey,
  summarizeInventoryTradingLedger,
} from "../src/inventory-recycling.js";

const policy = {
  minimumVolume24hUsd: "10000",
  minimumBalancedDepthUsd: "100",
  minimumIndependentFillSample: 5,
};

function market(overrides: Record<string, unknown> = {}) {
  return {
    marketId: "0xalpha",
    symbol: "ALPHA",
    coverage: "complete" as const,
    sessionOpen: true,
    bestBidUsd: "9.99",
    bestAskUsd: "10.01",
    volume24hUsd: "10000",
    openInterestUsd: "1000",
    depthBid50BpsUsd: "100",
    depthAsk50BpsUsd: "100",
    collateralUsd: "100",
    independentFillSample: 8,
    knownSameParentFills: 0,
    unresolvedFills: 2,
    expectedIndependentFillsPerDay: "3",
    expectedCapturedSpreadUsdPerFill: "0.12",
    expectedMakerCreditUsdPerFill: "0.01",
    expectedBuilderFeeUsdPerFill: "0.01",
    expectedAdverseMarkoutUsdPerFill: "0.02",
    expectedCarryAndFundingUsdPerFill: "0.01",
    expectedHedgeAndUnwindUsdPerFill: "0.01",
    expectedQuoteGasUsdPerDay: "0.05",
    tailReserveUsdPerDay: "0.02",
    ...overrides,
  };
}

describe("Inventory recycling accounting contracts", () => {
  it("does not call an unobserved counterparty independent", () => {
    expect(
      classifyCounterparty({
        ownerParentCapId: "0xowner",
        counterpartyParentCapId: null,
      }),
    ).toBe("unresolved");
    expect(
      classifyCounterparty({
        ownerParentCapId: "0xowner",
        counterpartyParentCapId: "0xowner",
      }),
    ).toBe("known_same_parent");
    expect(
      classifyCounterparty({
        ownerParentCapId: "0xowner",
        counterpartyParentCapId: "0xother",
      }),
    ).toBe("verified_other_parent");
  });

  it("uses the source event index before a normalized-event fingerprint", () => {
    expect(
      sourceEventKey({
        network: "mainnet",
        txDigest: "0xdigest",
        eventIndex: 2,
      }),
    ).toBe("mainnet:0xdigest:2");
    expect(
      sourceEventKey({
        network: "mainnet",
        txDigest: "0xdigest",
        eventIndex: null,
        normalizedEventFingerprint: "f00d",
      }),
    ).toBe("mainnet:0xdigest:hash:f00d");
  });

  it("preserves signed decimal evidence without accepting exponent notation", () => {
    expect(isDecimalString("-0.0001")).toBe(true);
    expect(isDecimalString("3891.58")).toBe(true);
    expect(isDecimalString("1e-4")).toBe(false);
  });

  it("ranks complete independent no-reward economics without including rewards", () => {
    const withoutReward = scoreInventoryRecyclingMarket(market(), policy);
    const withReward = scoreInventoryRecyclingMarket(
      market({ rewardSignal: "999999" }),
      policy,
    );

    expect(withoutReward).toMatchObject({
      eligible: true,
      expectedGrossMakerEdgeUsdPerFill: "0.08",
      expectedNoRewardUsdPerDay: "0.17",
      expectedNoRewardUsdPerCollateralDay: "0.0017",
      rewardSignal: null,
    });
    expect(withReward).toMatchObject({
      eligible: true,
      expectedNoRewardUsdPerDay: "0.17",
      rewardSignal: "999999",
    });
  });

  it("fails closed for known self-matches and incomplete or insufficient evidence", () => {
    expect(
      scoreInventoryRecyclingMarket(
        market({ knownSameParentFills: 1 }),
        policy,
      ),
    ).toMatchObject({
      eligible: false,
      reasons: ["same_parent_detected"],
      expectedNoRewardUsdPerDay: "0.17",
    });
    expect(
      scoreInventoryRecyclingMarket(
        market({ coverage: "partial", independentFillSample: 4 }),
        policy,
      ),
    ).toMatchObject({
      eligible: false,
      reasons: ["stale_or_incomplete_coverage", "insufficient_evidence"],
      expectedNoRewardUsdPerDay: null,
    });
  });

  it("orders only eligible positive markets above uncertain rows", () => {
    const ranked = rankInventoryRecyclingMarkets(
      [
        market({ marketId: "0xunknown", independentFillSample: 0 }),
        market({
          marketId: "0xnegative",
          expectedCapturedSpreadUsdPerFill: "0",
        }),
        market({ marketId: "0xpositive" }),
      ],
      policy,
    );
    expect(ranked.map((row) => row.marketId)).toEqual([
      "0xpositive",
      "0xnegative",
      "0xunknown",
    ]);
  });

  it("fails closed until fills, ownership and positions reconcile", () => {
    expect(
      reconcileInventoryRecycling({
        coverage: "complete",
        expectedFillKeys: ["mainnet:tx:1"],
        observedFillKeys: ["mainnet:tx:1"],
        fills: [{ counterpartyClass: "verified_other_parent" }],
        ownership: [{ accountId: "1", parentCapId: "0xparent" }],
        positions: [
          {
            accountId: "1",
            marketId: "0xmarket",
            expectedBase: "0",
            observedBase: "0",
          },
        ],
        positionToleranceBase: "0.000001",
      }),
    ).toEqual({
      state: "reconciled",
      riskIncreasingAllowed: true,
      reasons: [],
    });

    expect(
      reconcileInventoryRecycling({
        coverage: "partial",
        expectedFillKeys: ["mainnet:tx:1", "mainnet:tx:2"],
        observedFillKeys: ["mainnet:tx:1"],
        fills: [{ counterpartyClass: "unresolved" }],
        ownership: [{ accountId: "1", parentCapId: null }],
        positions: [
          {
            accountId: "1",
            marketId: "0xmarket",
            expectedBase: "1",
            observedBase: null,
          },
        ],
        positionToleranceBase: "0.000001",
      }),
    ).toEqual({
      state: "unresolved",
      riskIncreasingAllowed: false,
      reasons: [
        "source_coverage_incomplete",
        "missing_attributed_fill",
        "unresolved_counterparty",
        "ownership_unresolved",
        "position_unresolved",
      ],
    });
  });

  it("keeps rewards and transfers outside reconciled trading P&L", () => {
    expect(
      summarizeInventoryTradingLedger({
        fills: [
          {
            notionalUsd: "10",
            venueFeeUsd: "-0.01",
            builderFeeUsd: "0.01",
            realizedPnlUsd: "0.1",
            coverage: "complete",
          },
        ],
        effects: [
          {
            sourceEventKey: "mainnet:funding:1",
            runId: "run-1",
            configVersion: 1,
            accountId: "1",
            marketId: "0xmarket",
            timestampMs: 1,
            kind: "funding",
            fundingUsd: "0.02",
            gasUsedMist: null,
            gasUsd: null,
            externalTransferUsd: null,
            source: "fixture",
            network: "mainnet",
            coverage: "complete",
            raw: {},
          },
          {
            sourceEventKey: "mainnet:gas:1",
            runId: "run-1",
            configVersion: 1,
            accountId: "1",
            marketId: null,
            timestampMs: 2,
            kind: "gas",
            fundingUsd: null,
            gasUsedMist: "1",
            gasUsd: "0.03",
            externalTransferUsd: null,
            source: "fixture",
            network: "mainnet",
            coverage: "complete",
            raw: {},
          },
          {
            sourceEventKey: "mainnet:transfer:1",
            runId: "run-1",
            configVersion: 1,
            accountId: "1",
            marketId: null,
            timestampMs: 3,
            kind: "transfer",
            fundingUsd: null,
            gasUsedMist: null,
            gasUsd: null,
            externalTransferUsd: "1000",
            source: "fixture",
            network: "mainnet",
            coverage: "complete",
            raw: {},
          },
        ],
      }),
    ).toMatchObject({
      makerNotionalUsd: "10",
      venueFeesUsd: "-0.01",
      builderFeesUsd: "0.01",
      realizedPnlUsd: "0.1",
      fundingUsd: "0.02",
      gasUsd: "0.03",
      tradingNetUsd: "0.09",
      gaps: [],
    });
  });
});
