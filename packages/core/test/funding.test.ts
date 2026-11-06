import { describe, expect, it } from "vitest";
import {
  normalizeFundingHourly,
  replayFundingPaper,
  scanFundingOpportunity,
  fundingFeeUsd,
  type BookSnapshot,
  type FundingPairMapping,
} from "../src/index.js";

const mapping: FundingPairMapping = {
  id: "fixture-eth-af-hl",
  status: "REVIEWED",
  reviewedAtMs: 1,
  aftermath: {
    venue: "AFTERMATH",
    instrumentId: "fixture-af-eth",
    underlying: "ETH",
    contractKind: "LINEAR_USDC",
    collateral: "USDC",
    contractMultiplier: "1",
    lotSize: "0.001",
    minOrderNotionalUsd: "10",
  },
  hyperliquid: {
    venue: "HYPERLIQUID",
    instrumentId: "fixture-hl-eth",
    underlying: "ETH",
    contractKind: "LINEAR_USDC",
    collateral: "USDC",
    contractMultiplier: "1",
    lotSize: "0.001",
    minOrderNotionalUsd: "10",
  },
};

const book = (
  venue: BookSnapshot["venue"],
  bids: string[],
  asks: string[],
): BookSnapshot => ({
  venue,
  instrumentId: venue === "AFTERMATH" ? "fixture-af-eth" : "fixture-hl-eth",
  asOfMs: 1_000,
  bids: bids.map((price) => ({ priceUsd: price, base: "1" })),
  asks: asks.map((price) => ({ priceUsd: price, base: "1" })),
});

describe("cross-venue funding scanner", () => {
  it("keeps a maker credit and a builder fee as separate, one-time signed costs", () => {
    expect(fundingFeeUsd("100", "-0.5")).toBe("-0.005");
    expect(fundingFeeUsd("100", "1")).toBe("0.01");
    // -0.5bp maker plus +1bp builder is a +0.5bp net charge on this fill.
    expect(fundingFeeUsd("100", "0.5")).toBe("0.005");
  });

  it("normalizes the AF full-period rate and HL hourly rate without floating point", () => {
    expect(
      normalizeFundingHourly({
        venue: "AFTERMATH",
        instrumentId: "fixture-af-eth",
        rate: "0.0008",
        ratePeriodHours: "8",
        measuredAtMs: 1,
        validUntilMs: 2,
        kind: "estimate",
        source: "fixture",
      }),
    ).toBe("0.0001");
    const opportunity = scanFundingOpportunity({
      nowMs: 1_000,
      mapping,
      base: "0.5",
      horizonHours: "24",
      maxBookAgeMs: 10,
      afOracleUsd: "2000",
      hlOracleUsd: "2010",
      afPostOnlyAskUsd: "2004",
      afFunding: {
        venue: "AFTERMATH",
        instrumentId: "fixture-af-eth",
        rate: "0.0008",
        ratePeriodHours: "8",
        measuredAtMs: 1_000,
        validUntilMs: 2_000,
        kind: "estimate",
        source: "fixture",
      },
      hlFunding: {
        venue: "HYPERLIQUID",
        instrumentId: "fixture-hl-eth",
        rate: "0.00002",
        ratePeriodHours: "1",
        measuredAtMs: 1_000,
        validUntilMs: 2_000,
        kind: "estimate",
        source: "fixture",
      },
      afEntryBook: book("AFTERMATH", ["2003"], ["2004"]),
      hlEntryBook: book("HYPERLIQUID", ["2004"], ["2006"]),
      afExitBook: book("AFTERMATH", ["2000"], ["2003"]),
      hlExitBook: book("HYPERLIQUID", ["2002"], ["2005"]),
      fees: {
        afMakerBps: "0",
        afTakerBps: "0",
        afBuilderBps: "0",
        hlTakerBps: "0",
        fixedCostsUsd: "1.5",
      },
    });
    // The supplied golden case: 0.1000 AF short income - 0.0201 HL long cost.
    expect(opportunity.hourlyFundingUsd).toBe("0.0799");
    expect(opportunity.pricePnlUsd).toBe("-1.5");
    expect(opportunity.netUsd).toBe("-1.0824");
    expect(opportunity.eligible).toBe(false);
    expect(opportunity.reasons).toEqual(["NET_EDGE_NONPOSITIVE"]);
  });

  it("fails closed for an unreviewed ETH/BTC mapping or insufficient executable depth", () => {
    const result = scanFundingOpportunity({
      nowMs: 1_000,
      mapping: { ...mapping, status: "RESEARCH", reviewedAtMs: null },
      base: "2",
      horizonHours: "6",
      maxBookAgeMs: 10,
      afOracleUsd: "2000",
      hlOracleUsd: "2000",
      afPostOnlyAskUsd: "2001",
      afFunding: {
        venue: "AFTERMATH",
        instrumentId: "fixture-af-eth",
        rate: "0.001",
        ratePeriodHours: "8",
        measuredAtMs: 1_000,
        validUntilMs: 2_000,
        kind: "estimate",
        source: "fixture",
      },
      hlFunding: {
        venue: "HYPERLIQUID",
        instrumentId: "fixture-hl-eth",
        rate: "0",
        ratePeriodHours: "1",
        measuredAtMs: 1_000,
        validUntilMs: 2_000,
        kind: "estimate",
        source: "fixture",
      },
      afEntryBook: book("AFTERMATH", ["2000"], ["2001"]),
      hlEntryBook: book("HYPERLIQUID", ["2000"], ["2001"]),
      afExitBook: book("AFTERMATH", ["2000"], ["2001"]),
      hlExitBook: book("HYPERLIQUID", ["2000"], ["2001"]),
      fees: {
        afMakerBps: "0",
        afTakerBps: "0",
        afBuilderBps: "0",
        hlTakerBps: "0",
        fixedCostsUsd: "0",
      },
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("PAIR_UNREVIEWED");
    expect(result.reasons).toContain("INSUFFICIENT_ENTRY_DEPTH");
    expect(result.reasons).toContain("INSUFFICIENT_EXIT_DEPTH");
  });

  it("rejects a base amount that cannot be represented on both venue lot grids", () => {
    const badLot = scanFundingOpportunity({
      nowMs: 1_000,
      mapping: {
        ...mapping,
        hyperliquid: { ...mapping.hyperliquid, lotSize: "0.3" },
      },
      base: "0.5",
      horizonHours: "6",
      maxBookAgeMs: 10,
      afOracleUsd: "2000",
      hlOracleUsd: "2000",
      afPostOnlyAskUsd: "2001",
      afFunding: {
        venue: "AFTERMATH",
        instrumentId: "fixture-af-eth",
        rate: "0.001",
        ratePeriodHours: "8",
        measuredAtMs: 1_000,
        validUntilMs: 2_000,
        kind: "estimate",
        source: "fixture",
      },
      hlFunding: {
        venue: "HYPERLIQUID",
        instrumentId: "fixture-hl-eth",
        rate: "0",
        ratePeriodHours: "1",
        measuredAtMs: 1_000,
        validUntilMs: 2_000,
        kind: "estimate",
        source: "fixture",
      },
      afEntryBook: book("AFTERMATH", ["2000"], ["2001"]),
      hlEntryBook: book("HYPERLIQUID", ["2000"], ["2001"]),
      afExitBook: book("AFTERMATH", ["2000"], ["2001"]),
      hlExitBook: book("HYPERLIQUID", ["2000"], ["2001"]),
      fees: {
        afMakerBps: "0",
        afTakerBps: "0",
        afBuilderBps: "0",
        hlTakerBps: "0",
        fixedCostsUsd: "0",
      },
    });
    expect(badLot.reasons).toContain("LOT_MISMATCH");
  });
});

describe("cross-venue Paper replay", () => {
  const quote = {
    side: "sell" as const,
    limitPriceUsd: "100",
    base: "1",
    queueAheadBase: "0.25",
    maxHedgePriceUsd: "101",
  };
  const hedgeBook = book("HYPERLIQUID", ["99"], ["100", "101"]);

  it("does not turn a touch into a fill, then hedges only confirmed queue-consumed base", () => {
    const result = replayFundingPaper({
      mode: "PAPER",
      quote,
      hedgeBook,
      events: [
        {
          type: "trade",
          id: "touch",
          atMs: 1,
          aggressor: "sell",
          priceUsd: "100",
          base: "2",
        },
        {
          type: "trade",
          id: "one",
          atMs: 2,
          aggressor: "buy",
          priceUsd: "100",
          base: "0.75",
        },
        { type: "cancel-confirmed", id: "cancel", atMs: 3 },
      ],
    });
    expect(result.afFilledBase).toBe("0.5");
    expect(result.hlHedgedBase).toBe("0.5");
    expect(result.residualBase).toBe("0");
    expect(result.state).toBe("HEDGED_HOLD");
  });

  it("is restart-safe for duplicate/out-of-order events and exposes partial hedge recovery", () => {
    const first = replayFundingPaper({
      mode: "PAPER",
      quote,
      hedgeBook: {
        ...book("HYPERLIQUID", ["99"], ["100"]),
        asks: [{ priceUsd: "100", base: "0.5" }],
      },
      events: [
        {
          type: "trade",
          id: "fill",
          atMs: 2,
          aggressor: "buy",
          priceUsd: "100",
          base: "1",
        },
      ],
    });
    expect(first.state).toBe("RECOVERY_REQUIRED");
    expect(first.residualBase).toBe("0.25");
    const recovered = replayFundingPaper({
      mode: "PAPER",
      quote,
      hedgeBook: {
        ...book("HYPERLIQUID", ["99"], ["100"]),
        asks: [{ priceUsd: "100", base: "0.5" }],
      },
      checkpoint: first,
      events: [
        {
          type: "trade",
          id: "fill",
          atMs: 2,
          aggressor: "buy",
          priceUsd: "100",
          base: "1",
        },
      ],
    });
    expect(recovered.afFilledBase).toBe("0.75");
    expect(recovered.hlHedgedBase).toBe("0.5");
    expect(recovered.residualBase).toBe("0.25");
    expect(recovered.events).toEqual([]);
  });

  it("sorts independent source events by source time before replay", () => {
    const events = [
      { type: "cancel-confirmed" as const, id: "cancel", atMs: 3 },
      {
        type: "trade" as const,
        id: "fill",
        atMs: 2,
        aggressor: "buy" as const,
        priceUsd: "100",
        base: "0.75",
      },
    ];
    const result = replayFundingPaper({
      mode: "PAPER",
      quote,
      hedgeBook,
      events,
    });
    expect(result.afFilledBase).toBe("0.5");
    expect(result.hlHedgedBase).toBe("0.5");
    expect(result.state).toBe("HEDGED_HOLD");
  });

  it("rejects any runtime attempt to replay a Live funding run", () => {
    expect(() =>
      replayFundingPaper({
        mode: "LIVE" as never,
        quote,
        hedgeBook,
        events: [],
      }),
    ).toThrow("only supports PAPER");
  });
});
