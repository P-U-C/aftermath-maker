import { describe, expect, it } from "vitest";
import missingQuotes from "../fixtures/metric-missing.json";
import recordedQuotes from "../fixtures/metric-quotes.json";
import revertedQuotes from "../fixtures/metric-reverted.json";
import {
  METRIC_QUOTE_SIZES_USD,
  quoteRecordedMetricBasis,
} from "../metric-quoter.js";

describe("recorded Metric basis quoter", () => {
  it("quotes both Metric directions at fixed sizes and reports reverted or missing quotes unavailable", () => {
    const report = quoteRecordedMetricBasis(recordedQuotes, {
      maxAgeMs: 1_000,
    });

    expect(METRIC_QUOTE_SIZES_USD).toEqual([1000, 5000, 25000, 50000]);
    expect(report).toEqual({
      status: "available",
      market: "NVDA",
      observedAtMs: 1735689600000,
      quotes: [
        available(
          "buy-metric-sell-hyperliquid",
          1000,
          1735689599800,
          1735689599700,
          "buy",
          "sell",
          [1, 0.2, 1.5, 0.3, 0.4],
          16,
          12.6,
        ),
        available(
          "buy-metric-sell-hyperliquid",
          5000,
          1735689599800,
          1735689599700,
          "buy",
          "sell",
          [5, 0.2, 7.5, 0.3, 2],
          77,
          62,
        ),
        available(
          "buy-metric-sell-hyperliquid",
          25000,
          1735689599800,
          1735689599700,
          "buy",
          "sell",
          [25, 0.2, 37.5, 0.3, 10],
          395,
          322,
        ),
        available(
          "buy-metric-sell-hyperliquid",
          50000,
          1735689599800,
          1735689599700,
          "buy",
          "sell",
          [50, 0.2, 75, 0.3, 20],
          810,
          664.5,
        ),
        available(
          "buy-hyperliquid-sell-metric",
          1000,
          1735689599750,
          1735689599650,
          "sell",
          "buy",
          [1.1, 0.2, 1.4, 0.3, 0.4],
          18,
          14.6,
        ),
        available(
          "buy-hyperliquid-sell-metric",
          5000,
          1735689599750,
          1735689599650,
          "sell",
          "buy",
          [5.5, 0.2, 7, 0.3, 2],
          83,
          68,
        ),
        available(
          "buy-hyperliquid-sell-metric",
          25000,
          1735689599750,
          1735689599650,
          "sell",
          "buy",
          [27.5, 0.2, 35, 0.3, 10],
          425,
          352,
        ),
        available(
          "buy-hyperliquid-sell-metric",
          50000,
          1735689599750,
          1735689599650,
          "sell",
          "buy",
          [55, 0.2, 70, 0.3, 20],
          870,
          724.5,
        ),
      ],
    });

    const reverted = quoteRecordedMetricBasis(revertedQuotes, {
      maxAgeMs: 1_000,
    });
    expect(reverted).toEqual({
      status: "available",
      market: "NVDA",
      observedAtMs: 1735689600000,
      quotes: expect.arrayContaining([
        {
          status: "unavailable",
          direction: "buy-metric-sell-hyperliquid",
          sizeUsd: 1000,
          reason: "reverted",
        },
      ]),
    });

    const missing = quoteRecordedMetricBasis(missingQuotes, {
      maxAgeMs: 1_000,
    });
    expect(missing).toEqual({
      status: "available",
      market: "NVDA",
      observedAtMs: 1735689600000,
      quotes: expect.arrayContaining([
        {
          status: "unavailable",
          direction: "buy-hyperliquid-sell-metric",
          sizeUsd: 50000,
          reason: "missing-result",
        },
      ]),
    });
  });

  it("fails closed for stale, malformed, non-positive, mismatched, or overflowing evidence", () => {
    const firstQuote = recordedQuotes.quotes[0];
    if (!firstQuote) throw new Error("recorded Metric fixture needs a quote");

    const staleQuote = {
      ...recordedQuotes,
      quotes: [
        {
          ...firstQuote,
          sources: {
            ...firstQuote.sources,
            metric: {
              ...firstQuote.sources.metric,
              timestampMs: 1735689598000,
            },
          },
        },
      ],
    };
    const stale = quoteRecordedMetricBasis(staleQuote, { maxAgeMs: 1_000 });
    expect(stale).toEqual({
      status: "available",
      market: "NVDA",
      observedAtMs: 1735689600000,
      quotes: expect.arrayContaining([
        {
          status: "unavailable",
          direction: "buy-metric-sell-hyperliquid",
          sizeUsd: 1000,
          reason: "stale",
        },
      ]),
    });

    const nonPositiveCost = {
      ...recordedQuotes,
      quotes: [
        {
          ...firstQuote,
          costs: { ...firstQuote.costs, fundingUsd: 0 },
        },
      ],
    };
    expect(
      quoteRecordedMetricBasis(nonPositiveCost, { maxAgeMs: 1_000 }),
    ).toEqual({
      status: "unavailable",
      reason: "malformed-field",
    });

    const mismatchedInput = {
      ...recordedQuotes,
      quotes: [{ ...firstQuote, inputUsd: 900 }],
    };
    expect(
      quoteRecordedMetricBasis(mismatchedInput, { maxAgeMs: 1_000 }),
    ).toEqual({ status: "unavailable", reason: "malformed-field" });

    const overflowingCosts = {
      ...recordedQuotes,
      quotes: [
        {
          ...firstQuote,
          costs: {
            metricFeeUsd: Number.MAX_VALUE,
            metricGasUsd: Number.MAX_VALUE,
            hyperliquidFeeUsd: Number.MAX_VALUE,
            hyperliquidGasUsd: Number.MAX_VALUE,
            fundingUsd: Number.MAX_VALUE,
          },
        },
      ],
    };
    expect(
      quoteRecordedMetricBasis(overflowingCosts, { maxAgeMs: 1_000 }),
    ).toEqual({
      status: "available",
      market: "NVDA",
      observedAtMs: 1735689600000,
      quotes: expect.arrayContaining([
        {
          status: "unavailable",
          direction: "buy-metric-sell-hyperliquid",
          sizeUsd: 1000,
          reason: "malformed-field",
        },
      ]),
    });

    const missingSide = {
      ...recordedQuotes,
      quotes: [
        {
          ...firstQuote,
          sources: { metric: firstQuote.sources.metric },
        },
      ],
    };
    expect(quoteRecordedMetricBasis(missingSide, { maxAgeMs: 1_000 })).toEqual({
      status: "unavailable",
      reason: "missing-field",
    });
  });
});

function available(
  direction: "buy-metric-sell-hyperliquid" | "buy-hyperliquid-sell-metric",
  sizeUsd: 1000 | 5000 | 25000 | 50000,
  metricTimestampMs: number,
  hyperliquidTimestampMs: number,
  metricSide: "buy" | "sell",
  hyperliquidSide: "buy" | "sell",
  [
    metricFeeUsd,
    metricGasUsd,
    hyperliquidFeeUsd,
    hyperliquidGasUsd,
    fundingUsd,
  ]: [number, number, number, number, number],
  grossBasisUsd: number,
  netBasisUsd: number,
) {
  return {
    status: "available" as const,
    direction,
    sizeUsd,
    sources: {
      metric: { timestampMs: metricTimestampMs, side: metricSide },
      hyperliquid: {
        timestampMs: hyperliquidTimestampMs,
        side: hyperliquidSide,
      },
    },
    costs: {
      metricFeeUsd,
      metricGasUsd,
      hyperliquidFeeUsd,
      hyperliquidGasUsd,
      fundingUsd,
      totalUsd:
        metricFeeUsd +
        metricGasUsd +
        hyperliquidFeeUsd +
        hyperliquidGasUsd +
        fundingUsd,
    },
    grossBasisUsd,
    netBasisUsd,
  };
}
