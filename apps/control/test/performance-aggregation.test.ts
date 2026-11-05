import { describe, expect, it } from "vitest";
import { aggregatePerformance } from "../src/server-app.js";
import type { PerformanceSnapshot } from "../src/runtime.js";

const report = (
  marketId: string,
  symbol: string,
  notionalUsd: number,
): PerformanceSnapshot => ({
  asOf: "2026-11-04T00:00:00.000Z",
  period: "1D",
  periodStartedAt: "2026-11-04T00:00:00.000Z",
  historyComplete: true,
  account: null,
  attributed: {
    fills: 1,
    notionalUsd,
    realizedPnlUsd: 1,
    protocolFeesUsd: 0.1,
    estimatedBuilderFeesUsd: 0.01,
    netAfterKnownCostsUsd: 0.89,
    makerVolumeCoveragePct: null,
  },
  hedge: {
    enabled: true,
    accountId: "42",
    executions: 1,
    fills: 1,
    notionalUsd: notionalUsd / 2,
    realizedPnlUsd: 0,
    protocolFeesUsd: 0.02,
    estimatedBuilderFeesUsd: 0,
    netAfterKnownCostsUsd: -0.02,
  },
  combinedNetAfterKnownCostsUsd: 0.87,
  paper: { estimated: true, makerFills: 1, hedgeFills: 1, notionalUsd },
  volumeByMarket: [
    {
      marketId,
      symbol,
      makerNotionalUsd: notionalUsd,
      makerFills: 1,
      takerNotionalUsd: notionalUsd / 2,
      takerFills: 1,
      realizedPnlUsd: 1,
      feesUsd: 0.1,
      marketVolumeUsd: null,
      marketVolumeError: null,
    },
  ],
  marketVolumeLabel: null,
  fills: [
    {
      source: "paper",
      role: "maker",
      marketId,
      symbol,
      side: "bid",
      notionalUsd,
      price: 10,
      occurredAt: "2026-11-04T00:00:00.000Z",
      estimated: true,
    },
  ],
  note: "Paper estimate",
});

describe("all-bundles performance aggregation", () => {
  it("sums a second bundle and preserves its fill label", () => {
    const result = aggregatePerformance([
      { bundleName: "Core", performance: report("0x1", "SUI", 10) },
      { bundleName: "Rewards", performance: report("0x2", "NEAR", 20) },
    ]);

    expect(result).toMatchObject({
      attributed: { fills: 2, notionalUsd: 30 },
      paper: { makerFills: 2, notionalUsd: 30 },
    });
    expect(result?.fills.map((fill) => fill.bundleName)).toEqual([
      "Core",
      "Rewards",
    ]);
    expect(result?.volumeByMarket.map((row) => row.symbol)).toEqual([
      "NEAR",
      "SUI",
    ]);
  });
});
