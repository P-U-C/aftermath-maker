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
    expect(report.status).toBe("available");
    if (report.status !== "available") return;

    expect(report.quotes).toHaveLength(8);
    expect(
      report.quotes.map(({ direction, sizeUsd, status }) => ({
        direction,
        sizeUsd,
        status,
      })),
    ).toEqual([
      {
        direction: "buy-metric-sell-hyperliquid",
        sizeUsd: 1000,
        status: "available",
      },
      {
        direction: "buy-metric-sell-hyperliquid",
        sizeUsd: 5000,
        status: "available",
      },
      {
        direction: "buy-metric-sell-hyperliquid",
        sizeUsd: 25000,
        status: "available",
      },
      {
        direction: "buy-metric-sell-hyperliquid",
        sizeUsd: 50000,
        status: "available",
      },
      {
        direction: "buy-hyperliquid-sell-metric",
        sizeUsd: 1000,
        status: "available",
      },
      {
        direction: "buy-hyperliquid-sell-metric",
        sizeUsd: 5000,
        status: "available",
      },
      {
        direction: "buy-hyperliquid-sell-metric",
        sizeUsd: 25000,
        status: "available",
      },
      {
        direction: "buy-hyperliquid-sell-metric",
        sizeUsd: 50000,
        status: "available",
      },
    ]);
    expect(report.quotes[0]).toEqual({
      status: "available",
      direction: "buy-metric-sell-hyperliquid",
      sizeUsd: 1000,
      sources: {
        metric: { timestampMs: 1735689599800, side: "buy" },
        hyperliquid: { timestampMs: 1735689599700, side: "sell" },
      },
      costs: {
        metricFeeUsd: 1,
        metricGasUsd: 0.2,
        hyperliquidFeeUsd: 1.5,
        hyperliquidGasUsd: 0.3,
        fundingUsd: 0.4,
        totalUsd: 3.4,
      },
      grossBasisUsd: 16,
      netBasisUsd: 12.6,
    });
    for (const quote of report.quotes) {
      expect(quote.status).toBe("available");
      if (quote.status !== "available") continue;
      expect(quote.sources.metric.timestampMs).toBeGreaterThan(0);
      expect(quote.sources.hyperliquid.timestampMs).toBeGreaterThan(0);
      expect(quote.costs).toMatchObject({
        metricFeeUsd: expect.any(Number),
        metricGasUsd: expect.any(Number),
        hyperliquidFeeUsd: expect.any(Number),
        hyperliquidGasUsd: expect.any(Number),
        fundingUsd: expect.any(Number),
        totalUsd: expect.any(Number),
      });
    }

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

  it("fails closed for stale, malformed, or non-positive evidence", () => {
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
